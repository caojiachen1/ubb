// Wave 3-F ("sites"): site rules are DATA, not code. This module is the
// service-worker half of the pipeline: it assembles the effective rule list
// (packaged content/site-rules.json + chrome.storage.local user overrides,
// user wins by id and by order), installs itself as lib/bridge-ctl's provider so
// every read_site carries that list into the content script, and exposes the
// tools a model uses to inspect / validate / reload / add / REMOVE rules.
// Adding to the user layer without a way back would leave state on the user's
// machine forever (LIVE-RESULTS-3B §F4), so remove + clear are part of this
// module's contract, not somebody else's cleanup tool.
//
// Why the SW assembles it: a content script cannot fetch its own packaged
// resource without web_accessible_resources (manifest.json, contract §3 — not
// this wave's file), the extension page can. The content bridge keeps its own
// DEFAULT_SITE_RULES constant as the degradation path, so a failed fetch here
// can never take read_site down.

import { audit, bridge, err, redact, targetTab, truncate } from './actions.js';
import { getSiteRulesCache, invalidateSiteRules, setSiteRulesCache, setSiteRulesProvider } from './bridge-ctl.js';

const PACKAGED_URL = 'content/site-rules.json';
const USER_STORE_KEY = 'ubbSiteRules';
const MAX_USER_RULES = 64;
const MAX_RULE_BYTES = 96 * 1024;
const NAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;

// ------------------------------------------------------------------ selector grammar
// Static syntax probe only — the SW has no DOM, so this parser checks that a
// selector COULD parse; site.rules.validate additionally asks a live frame
// (bridge op siteRulesCheck) to parse it for real when a session tab exists.
const COMBINATORS = { '>': 'child', '+': 'next', '~': 'subsequent' };

/** Parse a selector list into [[{compound, combinator}, ...], ...]; throws SyntaxError. */
export function parseSelectorList(raw) {
  const src = String(raw == null ? '' : raw);
  if (!src.trim()) throw new SyntaxError('empty selector');
  let pos = 0;
  const space = () => { while (pos < src.length && /\s/.test(src[pos])) pos++; };
  const ident = () => { let n = ''; while (pos < src.length && /[\w-]/.test(src[pos])) n += src[pos++]; return n; };

  const compound = () => {
    const parts = [];
    for (;;) {
      const c = src[pos];
      if (c === undefined || /[,\s>+~]/.test(c)) break;
      if (c === '*') { pos++; parts.push({ type: 'tag', name: '*' }); continue; }
      if (/[A-Za-z]/.test(c)) { parts.push({ type: 'tag', name: ident().toLowerCase() }); continue; }
      if (c === '#' || c === '.') {
        pos++;
        const name = ident();
        if (!name) throw new SyntaxError(`${c} needs an identifier at index ${pos - 1}`);
        parts.push({ type: c === '#' ? 'id' : 'class', name });
        continue;
      }
      if (c === '[') {
        pos++;
        space();
        const name = ident().toLowerCase();
        if (!name) throw new SyntaxError('attribute selector needs a name');
        space();
        let op = null;
        let value = null;
        const two = src.slice(pos, pos + 2);
        if (/^(=~|\^=|\$=|\*=|\|=)$/.test(two)) { op = two; pos += 2; } else if (src[pos] === '=') { op = '='; pos++; }
        if (op) {
          space();
          const q = src[pos];
          if (q === '"' || q === "'") {
            pos++;
            let v = '';
            while (pos < src.length && src[pos] !== q) v += src[pos++];
            if (src[pos] !== q) throw new SyntaxError('unterminated quoted attribute value');
            pos++;
            value = v;
          } else {
            value = ident();
            if (!value) throw new SyntaxError('attribute selector needs a value');
          }
          space();
        }
        if (src[pos] !== ']') throw new SyntaxError('unterminated [attribute] selector');
        pos++;
        parts.push({ type: 'attr', name, op, value });
        continue;
      }
      if (c === ':') {
        pos++;
        if (src[pos] === ':') pos++;
        const name = (() => { let n = ''; while (pos < src.length && /[A-Za-z-]/.test(src[pos])) n += src[pos++]; return n; })();
        if (!name) throw new SyntaxError('empty pseudo-class at index ' + (pos - 1));
        if (src[pos] === '(') {
          let depth = 1;
          pos++;
          while (pos < src.length && depth) {
            if (src[pos] === '(') depth++;
            else if (src[pos] === ')') depth--;
            pos++;
          }
          if (depth) throw new SyntaxError('unbalanced pseudo-class arguments');
        }
        parts.push({ type: 'pseudo', name: name.toLowerCase() });
        continue;
      }
      throw new SyntaxError(`unexpected character ${JSON.stringify(c)} at index ${pos}`);
    }
    if (!parts.length) throw new SyntaxError(`expected a selector at index ${pos}`);
    return parts;
  };

  const complex = () => {
    const steps = [{ compound: compound(), combinator: 'self' }];
    for (;;) {
      const start = pos;
      const sawSpace = /\s/.test(src[pos] || '');
      space();
      const c = src[pos];
      if (COMBINATORS[c]) {
        pos++;
        space();
        steps.push({ compound: compound(), combinator: COMBINATORS[c] });
      } else if (sawSpace && pos < src.length && src[pos] !== ',') {
        steps.push({ compound: compound(), combinator: 'descendant' });
      } else {
        pos = start;
        break;
      }
    }
    return steps;
  };

  const out = [];
  for (;;) {
    space();
    out.push(complex());
    space();
    if (pos >= src.length) break;
    if (src[pos] === ',') { pos++; continue; }
    throw new SyntaxError(`unexpected character ${JSON.stringify(src[pos])} at index ${pos}`);
  }
  return out;
}

const SELECTOR_KEYS = /^(select|within|test_selector|selector_found|selector_absent)$/;
// mirrors collectRuleSelectors() in content/bridge.js — keep the two in step
const PSEUDO_WARN = /^(hover|focus|active|visited|has|not|is|where|matches)$/;

// ------------------------------------------------------------------ schema tables
const RULE_KEYS = new Set(['id', 'match', 'extract', 'join', 'referer', 'normalize', 'reject']);
const MATCH_KEYS = new Set(['host_pattern', 'path_pattern', 'test_selector']);
const ATTEMPT_KEYS = new Set(['select', 'pick', 'min_chars']);
const WHEN_KEYS = new Set(['selector_found', 'selector_absent', 'parts_below']);
const HEAD_KEYS = new Set(['select', 'prefix', 'suffix', 'split_on', 'split_index']);
const CLOSEST_KEYS = new Set(['within', 'select']);
const NORMALIZE_KEYS = new Set(['collapse_blank_lines']);
const REJECT_KEYS = new Set(['text_below', 'text_matches']);
// exactly the ops the block interpreter in content/bridge.js dispatches on
const BLOCK_KEYS = {
  text: new Set(['op', 'select', 'attempts', 'within', 'item', 'from_closest', 'attr', 'prefix', 'suffix', 'lead_part', 'head', 'when', 'min_chars', 'pick']),
  join_texts: new Set(['op', 'select', 'attempts', 'within', 'item', 'prefix', 'separator', 'drop_empty', 'dedup', 'filter_prefix', 'emit_on', 'when']),
  images: new Set(['op', 'select', 'attempts', 'within', 'item', 'src_attrs', 'exclude', 'skip_data_uri', 'dedup', 'min_width', 'width_default', 'when']),
  videos: new Set(['op', 'select', 'within', 'item', 'count_part', 'when']),
  group: new Set(['op', 'when', 'then']),
  repeat: new Set(['op', 'select', 'within', 'item', 'max', 'min_chars', 'then', 'when']),
  reset: new Set(['op', 'when']),
};
// rules are data; anything that could be read as code is refused before it is
// stored (the interpreter never looks at these keys, so a hostile rule stays inert —
// rejecting it here closes the "someone edits the JSON later" door too)
const EXECUTABLE_KEY = /^(eval|exec|execute|script|scripts|srcdoc|function|fn|code|callback|handler|expression|javascript|js|html|innerhtml|outerhtml|template|import|require|fetch|worker|url|href|action|on[a-z]+|[a-z]*url|[a-z]*script)$/i;

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

export function usableRule(r) {
  return isObj(r) && typeof r.id === 'string' && NAME_RE.test(r.id) && isObj(r.match) && Array.isArray(r.extract);
}

/** Deep scan: every key anywhere in the rule that could be read as code. */
function executableKeys(node, path, out) {
  if (Array.isArray(node)) {
    node.forEach((v, i) => executableKeys(v, `${path}[${i}]`, out));
    return out;
  }
  if (!isObj(node)) return out;
  for (const [k, v] of Object.entries(node)) {
    if (EXECUTABLE_KEY.test(k)) out.push({ path: `${path}.${k}`, key: k });
    executableKeys(v, `${path}.${k}`, out);
  }
  return out;
}

/**
 * The single schema gate, shared by site.rules.validate and site.rules.add.
 * @returns {{ok:boolean, rules:number, issues:{rule:string,path:string,kind:string,message:string}[],warnings:[]}}
 */
export function validateRules(rules) {
  const issues = [];
  const warnings = [];
  const add = (rule, path, kind, message) => issues.push({ rule, path, kind, message: truncate(String(message), 300) });
  const execMsg = (key) => `"${key}" would make a site rule executable — rules are selectors and literal text only; site.rules.add refuses it too`;

  const seenSelector = (ruleId, path, sel) => {
    if (typeof sel !== 'string') {
      add(ruleId, path, 'selector_type', `selector must be a string, got ${sel === null ? 'null' : typeof sel}`);
      return;
    }
    try {
      for (const step of parseSelectorList(sel).flat()) {
        for (const part of step.compound) {
          if (part.type === 'pseudo' && !PSEUDO_WARN.test(part.name)) {
            warnings.push({ rule: ruleId, path, kind: 'unknown_pseudo', message: `:${part.name} is not a standard pseudo-class here` });
          }
        }
      }
    } catch (e) {
      add(ruleId, path, 'selector_syntax', `selector does not parse: ${e.message}`);
    }
  };

  const walkWhen = (ruleId, path, when) => {
    if (when === undefined) return;
    if (!isObj(when)) return add(ruleId, `${path}.when`, 'shape', 'when must be an object');
    for (const k of Object.keys(when)) if (!WHEN_KEYS.has(k)) add(ruleId, `${path}.when.${k}`, 'unknown_key', `"${k}" is not a key the rule interpreter reads`);
    if (when.selector_found !== undefined) seenSelector(ruleId, `${path}.when.selector_found`, when.selector_found);
    if (when.selector_absent !== undefined) seenSelector(ruleId, `${path}.when.selector_absent`, when.selector_absent);
    if (when.parts_below !== undefined && !(Number.isInteger(when.parts_below) && when.parts_below >= 0)) {
      add(ruleId, `${path}.when.parts_below`, 'type', 'parts_below must be a non-negative integer');
    }
  };

  const walkAttempts = (ruleId, path, attempts) => {
    if (!Array.isArray(attempts) || !attempts.length) return add(ruleId, `${path}.attempts`, 'shape', 'attempts must be a non-empty array');
    attempts.forEach((a, i) => {
      if (!isObj(a)) return add(ruleId, `${path}.attempts[${i}]`, 'shape', 'attempt must be an object');
      for (const k of Object.keys(a)) if (!ATTEMPT_KEYS.has(k)) add(ruleId, `${path}.attempts[${i}].${k}`, 'unknown_key', `"${k}" is not a key the rule interpreter reads`);
      seenSelector(ruleId, `${path}.attempts[${i}].select`, a.select);
      if (a.pick !== undefined && a.pick !== 'first' && a.pick !== 'longest') add(ruleId, `${path}.attempts[${i}].pick`, 'enum', 'pick must be "first" or "longest"');
      if (a.min_chars !== undefined && !(Number.isInteger(a.min_chars) && a.min_chars >= 0)) add(ruleId, `${path}.attempts[${i}].min_chars`, 'type', 'min_chars must be a non-negative integer');
    });
  };

  const walkBlock = (ruleId, path, block, depth) => {
    if (!isObj(block)) return add(ruleId, path, 'shape', 'block must be an object');
    const op = block.op;
    if (typeof op !== 'string' || !BLOCK_KEYS[op]) {
      return add(ruleId, `${path}.op`, 'unknown_op', `op must be one of ${Object.keys(BLOCK_KEYS).join(', ')} — got ${JSON.stringify(truncate(String(op), 40))}`);
    }
    for (const k of Object.keys(block)) if (!BLOCK_KEYS[op].has(k) && !EXECUTABLE_KEY.test(k)) add(ruleId, `${path}.${k}`, 'unknown_key', `"${k}" is not a key "${op}" reads`);
    if (depth > 6) add(ruleId, path, 'nesting', 'blocks nest more than 6 deep — the interpreter would recurse too far');
    if (block.select !== undefined) seenSelector(ruleId, `${path}.select`, block.select);
    if (block.within !== undefined) seenSelector(ruleId, `${path}.within`, block.within);
    if (block.attempts !== undefined) walkAttempts(ruleId, path, block.attempts);
    walkWhen(ruleId, path, block.when);
    if (block.from_closest !== undefined) {
      if (!isObj(block.from_closest)) add(ruleId, `${path}.from_closest`, 'shape', 'from_closest must be an object');
      else {
        for (const k of Object.keys(block.from_closest)) if (!CLOSEST_KEYS.has(k)) add(ruleId, `${path}.from_closest.${k}`, 'unknown_key', `"${k}" is not a key from_closest reads`);
        seenSelector(ruleId, `${path}.from_closest.within`, block.from_closest.within);
        seenSelector(ruleId, `${path}.from_closest.select`, block.from_closest.select);
      }
    }
    if (block.head !== undefined) {
      if (!isObj(block.head)) add(ruleId, `${path}.head`, 'shape', 'head must be an object');
      else {
        for (const k of Object.keys(block.head)) if (!HEAD_KEYS.has(k)) add(ruleId, `${path}.head.${k}`, 'unknown_key', `"${k}" is not a key head reads`);
        seenSelector(ruleId, `${path}.head.select`, block.head.select);
      }
    }
    if (op === 'text' && block.min_chars !== undefined && !(Number.isInteger(block.min_chars) && block.min_chars >= 0)) {
      add(ruleId, `${path}.min_chars`, 'type', 'min_chars must be a non-negative integer');
    }
    if (block.emit_on !== undefined && block.emit_on !== 'matched' && block.emit_on !== 'values') {
      add(ruleId, `${path}.emit_on`, 'enum', 'emit_on must be "matched" or "values"');
    }
    if (block.src_attrs !== undefined) {
      if (!Array.isArray(block.src_attrs) || !block.src_attrs.length || block.src_attrs.some((s) => typeof s !== 'string' || !/^[A-Za-z][\w-]*$/.test(s))) {
        add(ruleId, `${path}.src_attrs`, 'type', 'src_attrs must be a non-empty array of attribute names');
      }
    }
    if (block.exclude !== undefined) {
      if (typeof block.exclude !== 'string') add(ruleId, `${path}.exclude`, 'type', 'exclude must be a regex string');
      else {
        try { new RegExp(block.exclude); } catch (e) { add(ruleId, `${path}.exclude`, 'regex', `exclude does not compile: ${e.message}`); }
      }
    }
    if (block.max !== undefined && !(Number.isInteger(block.max) && block.max >= 0)) add(ruleId, `${path}.max`, 'type', 'max must be a non-negative integer');
    if (op === 'repeat' && !Array.isArray(block.then)) add(ruleId, `${path}.then`, 'shape', 'repeat needs a then[] block list');
    if (op === 'group' && !Array.isArray(block.then)) add(ruleId, `${path}.then`, 'shape', 'group needs a then[] block list');
    if (Array.isArray(block.then)) block.then.forEach((sub, i) => walkBlock(ruleId, `${path}.then[${i}]`, sub, depth + 1));
  };

  const list = Array.isArray(rules) ? rules : [];
  const ids = new Map();
  for (let i = 0; i < list.length; i++) {
    const rule = list[i];
    const ruleId = isObj(rule) && typeof rule.id === 'string' ? rule.id : `#${i}`;
    if (!isObj(rule)) {
      add(ruleId, `rules[${i}]`, 'shape', 'a rule must be an object');
      continue;
    }
    for (const hit of executableKeys(rule, `rules[${i}]`, [])) {
      add(ruleId, hit.path, 'executable_field', execMsg(hit.key));
    }
    for (const k of Object.keys(rule)) if (!RULE_KEYS.has(k) && !EXECUTABLE_KEY.test(k)) add(ruleId, k, 'unknown_key', `"${k}" is not a rule-level key (allowed: ${[...RULE_KEYS].join(', ')})`);
    if (typeof rule.id !== 'string' || !NAME_RE.test(rule.id)) {
      add(ruleId, 'id', 'id', 'id must match [A-Za-z0-9_.-]{1,64}');
    } else if (ids.has(rule.id)) {
      add(rule.id, 'id', 'id_conflict', `id "${rule.id}" already used by rules[${ids.get(rule.id)}] — one id must appear once (a user rule shadows a builtin only through site.rules.add, never inside one list)`);
    } else {
      ids.set(rule.id, i);
    }
    if (!isObj(rule.match)) add(ruleId, 'match', 'shape', 'match must be an object');
    else {
      for (const k of Object.keys(rule.match)) if (!MATCH_KEYS.has(k)) add(ruleId, `match.${k}`, 'unknown_key', `"${k}" is not a key match reads`);
      const hp = rule.match.host_pattern;
      const hosts = Array.isArray(hp) ? hp : [hp];
      if (!hosts.length || hosts.some((h) => typeof h !== 'string' || !h.trim())) {
        add(ruleId, 'match.host_pattern', 'type', 'host_pattern must be a non-empty string or a non-empty array of host strings');
      }
      if (rule.match.path_pattern !== undefined) {
        try { new RegExp(rule.match.path_pattern); } catch (e) { add(ruleId, 'match.path_pattern', 'regex', `path_pattern does not compile: ${e.message}`); }
      }
      if (rule.match.test_selector !== undefined) seenSelector(ruleId, 'match.test_selector', rule.match.test_selector);
    }
    if (!Array.isArray(rule.extract) || !rule.extract.length) add(ruleId, 'extract', 'shape', 'extract must be a non-empty block array');
    else rule.extract.forEach((b, j) => walkBlock(ruleId, `extract[${j}]`, b, 0));
    if (rule.join !== undefined && typeof rule.join !== 'string') add(ruleId, 'join', 'type', 'join must be a string');
    if (rule.referer !== undefined) {
      if (typeof rule.referer !== 'string' || !/^https?:\/\//i.test(rule.referer)) {
        add(ruleId, 'referer', 'type', 'referer must be an http(s) URL string');
      }
    }
    if (rule.normalize !== undefined) {
      if (!isObj(rule.normalize)) add(ruleId, 'normalize', 'shape', 'normalize must be an object');
      else {
        for (const k of Object.keys(rule.normalize)) if (!NORMALIZE_KEYS.has(k)) add(ruleId, `normalize.${k}`, 'unknown_key', `"${k}" is not a key normalize reads`);
      }
    }
    if (rule.reject !== undefined) {
      if (!isObj(rule.reject)) add(ruleId, 'reject', 'shape', 'reject must be an object');
      else {
        for (const k of Object.keys(rule.reject)) if (!REJECT_KEYS.has(k)) add(ruleId, `reject.${k}`, 'unknown_key', `"${k}" is not a key reject reads`);
        if (rule.reject.text_matches !== undefined) {
          try { new RegExp(rule.reject.text_matches); } catch (e) { add(ruleId, 'reject.text_matches', 'regex', `text_matches does not compile: ${e.message}`); }
        }
      }
    }
  }
  return { ok: issues.length === 0, rules: list.length, issues, warnings: warnings.slice(0, 40) };
}

// ------------------------------------------------------------------ rule assembly
/**
 * The user layer EXACTLY as chrome.storage.local holds it. Hand-written entries
 * (LIVE-RESULTS-3B §F4: the SW console was the only way in, and the only way
 * out) can be misshapen, and readUserRules() filters those out of every answer —
 * so a write built from the filtered list would silently drop them, and a count
 * built from it would under-report what actually left storage.
 * A failed read THROWS instead of answering []: add/remove/clear that rewrite the
 * layer after a failed read would delete a layer they never got to see — add
 * included, because writing [newRule] over an unseen layer IS the wipe.
 */
async function readRawLayer() {
  let data = null;
  try {
    data = await chrome.storage.local.get(USER_STORE_KEY);
  } catch (e) {
    throw err('SITE_RULE_STORAGE_UNREADABLE', `chrome.storage.local could not be read (${truncate(String(e?.message || e), 120)}) — site.rules.add/remove/clear refuse to rewrite a user layer they cannot see, so NOTHING was touched; retry once storage answers`);
  }
  return Array.isArray(data?.[USER_STORE_KEY]) ? data[USER_STORE_KEY] : [];
}

async function readUserRules() {
  try {
    return (await readRawLayer()).filter(usableRule);
  } catch {
    return [];
  }
}

async function readBuiltinRules() {
  const res = await fetch(chrome.runtime.getURL(PACKAGED_URL));
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data.rules)) throw new Error('site-rules.json has no rules[] array');
  return data.rules.filter(usableRule);
}

/** user overrides first, then builtins whose id no user rule shadows (bridge's order). */
export function mergeRules(user, builtin) {
  const ids = new Set(user.map((r) => r.id));
  return [...user, ...builtin.filter((r) => !ids.has(r.id))];
}

export async function loadRuleSets() {
  const user = await readUserRules();
  let builtin = [];
  let builtinError = null;
  try {
    builtin = await readBuiltinRules();
  } catch (e) {
    builtinError = truncate(String(e?.message || e), 200);
  }
  return { user, builtin, builtinError };
}

/**
 * The provider lib/bridge-ctl calls once per cache fill. Throws when it has
 * nothing to offer so the cache stays empty and content/bridge.js answers from
 * its own DEFAULT_SITE_RULES (a broken packaged file must not blank read_site).
 */
export async function effectiveSiteRules() {
  const { user, builtin, builtinError } = await loadRuleSets();
  if (builtinError && !user.length) throw new Error(builtinError);
  return mergeRules(user, builtin);
}

setSiteRulesProvider(effectiveSiteRules);

// ------------------------------------------------------------------ tools
export function register(dispatcher) {
  const R = (name, meta, fn) => dispatcher.register(name, meta, fn);

  R('site.rules.list', {
    category: 'sensing',
    description: 'Every site rule read_site can pick, in match order: {id, source: builtin|user, removable: bool, match, blocks}. User overrides come first and shadow the builtin with the same id; ONLY user rules are removable (the packaged set is read-only from here). Reads packaged content/site-rules.json + chrome.storage.local — no tab, no page access. Undo an override with site.rules.remove {"id":…, "confirm":true}, the whole layer with site.rules.clear {"confirm":true}.',
  }, async (p = {}) => {
    const { user, builtin, builtinError } = await loadRuleSets();
    const merged = mergeRules(user, builtin);
    const userIds = new Set(user.map((r) => r.id));
    const rules = merged.map((r) => ({
      id: r.id,
      source: userIds.has(r.id) ? 'user' : 'builtin',
      removable: userIds.has(r.id),
      match: r.match,
      blocks: (r.extract || []).length,
      referer: r.referer ? truncate(String(r.referer), 200) : undefined,
    }));
    audit.log({ action: 'site.rules.list', builtin: builtin.length, user: user.length });
    return redact({
      rules,
      counts: { total: rules.length, builtin: builtin.length, user: user.length },
      user_rule_ids: user.map((r) => r.id),
      undo: user.length
        ? `revoke one with site.rules.remove {"id":${JSON.stringify(user[0].id)},"confirm":true}, all ${user.length} with site.rules.clear {"confirm":true}`
        : 'no user overrides right now — site.rules.list is the packaged set alone',
      builtin_source: builtinError ? 'unavailable' : 'packaged-json',
      builtin_error: builtinError || undefined,
      sw_cache: getSiteRulesCache() ? 'warm' : 'cold',
      note: builtinError
        ? 'packaged site-rules.json unreadable — read_site still works: content/bridge.js falls back to its built-in DEFAULT_SITE_RULES (user overrides above apply). Fix the file, then site.rules.reload.'
        : `add an override with site.rules.add (confirm:true), check a draft with site.rules.validate first, and revoke one with site.rules.remove / the whole layer with site.rules.clear; nothing here runs page code`,
    });
  });

  R('site.rules.validate', {
    category: 'sensing',
    description: 'Check candidate site rules against the rule grammar WITHOUT storing them: per-op key whitelist, selector syntax, regex fields, duplicate ids, and a hard refusal of any executable field (eval/script/function/on*/html/url…). Pass {rules:[…]} — returns {ok, issues:[{rule,path,kind,message}], warnings}. Nothing is persisted; store one rule with site.rules.add.',
  }, async (p = {}) => {
    const rules = p.rules;
    if (!Array.isArray(rules) || !rules.length) {
      throw err('SITE_RULES_MISSING', 'site.rules.validate takes {rules:[{id,match,extract}]} — send the candidate list (this tool never stores anything; site.rules.add does)');
    }
    const report = validateRules(rules);
    const out = { ...report };
    // the SW has no DOM, so selector PARSING against a real document is delegated
    // to the live frame when the caller has a session tab; absence is not an error
    if (p.tab_id != null) {
      try {
        const tabId = targetTab(p);
        const probe = await bridge(tabId, 'siteRulesCheck', { rules });
        out.dom_probe = { tab_id: tabId, results: probe?.results };
      } catch (e) {
        out.dom_probe = { skipped: e?.code || truncate(String(e?.message || e), 160) };
      }
    } else {
      out.dom_probe = { skipped: 'no tab_id — selector syntax checked statically only' };
    }
    audit.log({ action: 'site.rules.validate', rules: report.rules, ok: report.ok, issues: report.issues.length });
    return redact(out);
  });

  R('site.rules.reload', {
    category: 'sensing',
    description: 'Drop the SW site-rule cache and re-assemble it from content/site-rules.json + chrome.storage.local, so a user override or a fixed packaged file lands on the next read_site without reloading the extension. No tab, no page access.',
  }, async () => {
    invalidateSiteRules();
    let counts = null;
    let error = null;
    try {
      const rules = await effectiveSiteRules();
      setSiteRulesCache(rules);
      counts = { total: rules.length, ids: rules.map((r) => r.id) };
    } catch (e) {
      error = truncate(String(e?.message || e), 200);
    }
    audit.log({ action: 'site.rules.reload', ok: !error, total: counts?.total });
    return redact({
      reloaded: !error,
      cache: getSiteRulesCache() ? 'warm' : 'cold',
      ...(counts || {}),
      error: error || undefined,
      note: error
        ? 'nothing loadable — read_site falls back to content/bridge.js DEFAULT_SITE_RULES'
        : 'the next read_site carries this set into the page; site.rules.validate first if you just added a rule',
    });
  });

  R('site.rules.add', {
    category: 'sensing',
    sensitive: true,
    description: 'Persist ONE user site rule in chrome.storage.local; it takes match precedence over a builtin with the same id (a different id is appended as a new site). Refused unless confirm:true, and refused if site.rules.validate would refuse it — executable fields never reach storage. Undo it with site.rules.remove {"id":…,"confirm":true} (or the whole layer with site.rules.clear); adding a corrected rule with the same id replaces it in place.',
  }, async (p = {}) => {
    if (p.confirm !== true) {
      throw err('NEEDS_CONFIRM', 'site.rules.add changes what read_site extracts from your pages — validate the rule with site.rules.validate, show it to the user, then retry with confirm:true');
    }
    const rule = p.rule;
    if (!isObj(rule)) {
      throw err('SITE_RULE_INVALID', 'site.rules.add takes {rule:{id,match,extract},confirm:true} — one rule object, not a list');
    }
    const report = validateRules([rule]);
    if (!report.ok) {
      throw err(
        'SITE_RULE_INVALID',
        `rule ${JSON.stringify(rule.id || '(missing id)')} rejected, nothing stored: ${report.issues.slice(0, 6).map((i) => `${i.path} (${i.kind}): ${i.message}`).join(' | ')}${report.issues.length > 6 ? ` | +${report.issues.length - 6} more` : ''} — fix it and re-run site.rules.validate`,
      );
    }
    const bytes = JSON.stringify(rule).length;
    if (bytes > MAX_RULE_BYTES) {
      throw err('SITE_RULE_TOO_LARGE', `rule is ${bytes} bytes, limit is ${MAX_RULE_BYTES} — split it into fewer selectors/blocks`);
    }
    // the same gate remove/clear use (fix13): a FAILED read is not an empty layer.
    // Going through readUserRules() here swallowed the failure into [], and the set
    // below then wrote [rule] over a layer nobody got to see = every existing user
    // override gone, silently. readRawLayer() throws first and NOTHING is written.
    const stored = (await readRawLayer()).filter(usableRule);
    const replacing = stored.some((r) => r.id === rule.id);
    if (!replacing && stored.length >= MAX_USER_RULES) {
      throw err('SITE_RULE_LIMIT', `${stored.length} user rules already stored (limit ${MAX_USER_RULES}) — replace an existing id instead of adding a new one`);
    }
    const next = [rule, ...stored.filter((r) => r.id !== rule.id)];
    await chrome.storage.local.set({ [USER_STORE_KEY]: next });
    invalidateSiteRules();
    audit.log({ action: 'site.rules.add', rule_id: rule.id, replaced: replacing, user_rules: next.length });
    const { builtin } = await loadRuleSets();
    return redact({
      stored: rule.id,
      source: 'user',
      replaced: replacing,
      shadows_builtin: builtin.some((b) => b.id === rule.id),
      user_rule_ids: next.map((r) => r.id),
      cache: 'cold',
      note: `read_site now matches ${rule.id} first; run site.rules.reload to warm the cache, site.rules.list to confirm order, and site.rules.remove {"id":${JSON.stringify(rule.id)},"confirm":true} to undo this (it is the only way — the layer lives in chrome.storage.local, nothing else deletes it)`,
    });
  });

  // fix6 made "same id ⇒ the user rule wins" reversible by add; it was never
  // reversible at all (LIVE-RESULTS-3B §F4: the only way out was the SW console).
  // These two are the undo half of that contract, and they touch the USER layer
  // only — content/site-rules.json is packaged and read-only from here.
  R('site.rules.remove', {
    category: 'sensing',
    sensitive: true,
    description: 'Delete ONE user site rule by id from chrome.storage.local (the undo half of site.rules.add). If that id was shadowing a builtin, the packaged rule becomes effective again straight away: this call invalidates the SW rule cache itself, so the next read_site re-assembles without any extension reload (site.rules.reload only warms/prints the set for you). confirm:true required; an id that is not in the user layer is refused (a builtin is NOT deletable and nothing is silently "removed"); removed_layer_entries says how many storage entries really left.',
  }, async (p = {}) => {
    if (p.confirm !== true) {
      throw err('NEEDS_CONFIRM', 'site.rules.remove changes what read_site extracts from your pages — name the rule to the user, then retry with confirm:true (site.rules.list shows which ids are user rules and therefore removable)');
    }
    const id = typeof p.id === 'string' ? p.id : '';
    if (!NAME_RE.test(id)) {
      throw err('BAD_PARAMS', `site.rules.remove takes {id:"<rule id>",confirm:true} — got ${JSON.stringify(truncate(String(p.id ?? ''), 80))}; ids match [A-Za-z0-9_.-]{1,64} (site.rules.list has the exact ids)`);
    }
    const raw = await readRawLayer();
    const stored = raw.filter(usableRule);
    if (!raw.some((r) => r && r.id === id)) {
      const { builtin, builtinError } = await loadRuleSets();
      const isBuiltin = builtin.some((b) => b.id === id);
      throw err(
        'SITE_RULE_NOT_FOUND',
        isBuiltin
          ? `"${id}" is a PACKAGED builtin rule, not a user override — there is nothing to remove and nothing was touched. A builtin is overridden by site.rules.add with the same id, and that override is what site.rules.remove deletes (pass the override's id). User layer: ${stored.map((r) => r.id).join(', ') || '(empty)'}`
          : `no user rule "${id}" is stored — nothing was removed. User layer now: ${stored.map((r) => r.id).join(', ') || '(empty)'}${builtinError ? ' (packaged file unreadable)' : ''}; run site.rules.list for the exact ids`,
      );
    }
    const next = raw.filter((r) => !(r && r.id === id));
    await chrome.storage.local.set({ [USER_STORE_KEY]: next });
    invalidateSiteRules();
    audit.log({ action: 'site.rules.remove', rule_id: id, user_rules: next.filter(usableRule).length });
    const { builtin } = await loadRuleSets();
    const restored = builtin.find((b) => b.id === id);
    const malformed = raw.length - next.length - (stored.some((r) => r.id === id) ? 1 : 0);
    return redact({
      removed: id,
      source: 'user',
      removed_layer_entries: raw.length - next.length,
      malformed_entries_dropped: malformed > 0 ? malformed : undefined,
      was_shadowing_builtin: !!restored || undefined,
      builtin_now_effective: restored ? restored.id : undefined,
      user_rule_ids: next.filter(usableRule).map((r) => r.id),
      cache: 'cold',
      note: restored
        ? `${id} is gone from the user layer and the packaged rule with the same id matches again — the SW cache was invalidated by this call, so the next read_site already sees source:"builtin" (site.rules.list is the proof, no extension reload)`
        : `${id} is gone from the user layer and read_site no longer matches it — the SW cache was invalidated by this call, so the next read_site is already down to ${next.filter(usableRule).length} user rule(s) + the packaged set (site.rules.list is the proof, no extension reload)`,
    });
  });

  R('site.rules.clear', {
    category: 'sensing',
    sensitive: true,
    description: 'Delete the ENTIRE user site-rule layer (key "ubbSiteRules" in chrome.storage.local) so site.rules.list falls back to the packaged builtins alone. This is the "I added rules during a test run and want the machine back" tool: confirm:true required, it never touches content/site-rules.json, cleared counts the storage entries that really left (removed_ids only names the readable ones), an already-empty layer is reported as such instead of pretending to delete, and it invalidates the SW rule cache so the next read_site is back to the packaged set without an extension reload.',
  }, async (p = {}) => {
    if (p.confirm !== true) {
      throw err('NEEDS_CONFIRM', 'site.rules.clear throws away every user site rule at once — show the user site.rules.list first (user_rule_ids names exactly what goes away), then retry with confirm:true');
    }
    const raw = await readRawLayer();
    const removed_ids = raw.filter(usableRule).map((r) => r.id);
    const malformed = raw.length - removed_ids.length;
    await chrome.storage.local.set({ [USER_STORE_KEY]: [] });
    invalidateSiteRules();
    audit.log({ action: 'site.rules.clear', removed: raw.length, rule_ids: removed_ids.join(',') });
    const { user, builtin, builtinError } = await loadRuleSets();
    return redact({
      cleared: raw.length,
      removed_ids,
      malformed_entries_dropped: malformed > 0 ? malformed : undefined,
      user_rule_ids: user.map((r) => r.id),
      effective_rules: builtin.length,
      builtin_source: builtinError ? 'unavailable' : 'packaged-json',
      cache: 'cold',
      note: raw.length
        ? `the user layer is empty now (${raw.length} storage entry/entries gone, ${builtin.length} packaged rule(s) are all read_site can match) — the SW cache was invalidated by this call, so the next read_site is already back to the packaged set, no extension reload needed${user.length ? ' (something re-added a rule while this was finishing: ' + user.map((r) => r.id).join(', ') + ')' : ''}`
        : 'the user layer was already empty — nothing was deleted',
    });
  });
}
