// Trace replay: drive a record_stop trace again on a live tab.
// Recorded refs/DOM nodes are long dead, so every step is re-matched by
// semantics (role + name, selector/tag as tie-breaker) against a fresh
// snapshot before any action runs.

import {
  DANGEROUS_LABEL,
  SENSITIVE_FIELD,
  targetTab,
  guardSensitiveField,
  visibleExpr,
  mouse,
  key,
  evalJs,
  cdp,
  callOnNode,
  resolveRef,
  takeSnapshot,
  bridge,
  waitForLoad,
  sleep,
  withPass,
  audit,
  redact,
  redactUrl,
  truncate,
  err,
} from './actions.js';

const MAX_STEPS = 500;
const MIN_SCORE = 5; // exact name (4) alone is not enough: a same-text link/button misclick is the classic replay failure
const DEFAULT_WAIT_MS = 250;
const SCRIPT_PREFIX = 'ubb_replay:';
const MAX_SCRIPT_BYTES = 1_048_576;
const SCRIPT_NAME = /^[A-Za-z0-9_.-]{1,64}$/;
// *** is what content/bridge.js writes in place of a password field's value
const MASKED_VALUE = /^\*{2,}$/;
// contract §4.5: these stay refused no matter where the value comes from
const NEVER_AUTO_FILL = /(otp|one[-\s]?time|验证码|cvv|cvc|card.?number|卡号|私钥)/i;
const VAR_TOKEN = /\{\{\s*(?:var|secret)[.:]([A-Za-z0-9_.-]+)\s*\}\}/g;
const LEFTOVER_SECRET = /\{\{\s*secret[.:]/;

const TAG_TO_ROLE = {
  a: 'link', button: 'button', input: 'textbox', select: 'combobox',
  textarea: 'textbox', option: 'option', li: 'listitem', img: 'image',
};
const ROLE_FAMILIES = [
  ['textbox', 'searchbox', 'spinbutton'],
  ['combobox', 'listbox'],
  ['checkbox', 'switch'],
];

// ------------------------------------------------------------------ trace input

/** Accepts the record_stop object, its events array, or JSON text of either. */
export function normalizeTrace(input) {
  let v = input;
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v);
    } catch {
      throw err('TRACE_FORMAT', 'a string trace must be JSON: paste the record_stop result or its events array');
    }
  }
  const events = Array.isArray(v) ? v : Array.isArray(v?.events) ? v.events : null;
  if (!events) {
    throw err('TRACE_FORMAT', 'replay needs the record_stop trace object or an events array (names with replay.list)');
  }
  const out = events.filter((e) => e && typeof e === 'object' && typeof e.type === 'string');
  if (!out.length) throw err('TRACE_EMPTY', 'the trace has no usable events — each needs a string "type"');
  return out;
}

function normRole(role) {
  const r = String(role || '').toLowerCase();
  return TAG_TO_ROLE[r] || r;
}

function normText(s) {
  return String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function truncText(s) {
  return truncate(String(s || ''), 60);
}

function selectorTag(selector) {
  const m = /^([a-z][a-z0-9]*)/i.exec(String(selector || ''));
  return m ? m[1].toLowerCase() : null;
}

function selectorId(selector) {
  const m = /#([\w-]+)/.exec(String(selector || ''));
  return m ? m[1].toLowerCase() : null;
}

const NAV_TYPES = new Set(['navigation', 'navigate']);

/** Map one recorded event onto the semantic intent we try to satisfy now. */
export function intentFor(ev) {
  const type = String(ev.type || '').toLowerCase();
  const t = ev.target && typeof ev.target === 'object' ? ev.target : {};
  const intent = {
    kind: 'skip',
    role: normRole(t.role) || null,
    role_recorded: t.role || null,
    name: normText(t.label || t.text),
    selector: typeof t.selector === 'string' && t.selector !== 'document' ? t.selector : null,
    tag: selectorTag(t.selector),
    id: selectorId(t.selector),
    value: null,
    key: null,
    url: null,
    to: null,
    needsTarget: false,
    note: null,
  };
  if (type === 'click') {
    intent.kind = 'click';
    intent.needsTarget = true;
  } else if (type === 'input') {
    intent.kind = 'fill';
    intent.needsTarget = true;
    intent.value = String(ev.value ?? '');
  } else if (type === 'select' || type === 'select_option' || type === 'change') {
    intent.kind = 'select_option';
    intent.needsTarget = true;
    intent.value = String(ev.value ?? '');
  } else if (type === 'keypress' || type === 'keydown') {
    intent.kind = 'keypress';
    intent.key = String(ev.key || '');
    if (!intent.key) intent.note = 'keypress event without a "key" field';
  } else if (type === 'scroll') {
    intent.kind = 'scroll';
    const d = ev.delta || ev.position || {};
    intent.to = { x: Number(d.x), y: Number(d.y) };
  } else if (NAV_TYPES.has(type)) {
    intent.kind = 'navigate';
    intent.url = typeof ev.url === 'string' ? ev.url : null;
  } else if (type === 'drag') {
    intent.kind = 'skip';
    intent.note = 'drag events are not replayed (HTML5 drag-and-drop has no reliable semantic replay)';
  } else {
    intent.note = `event type "${type}" is not replayable`;
  }
  return intent;
}

// -------------------------------------------------------------------- matching

export function roleScore(cand, intent) {
  const role = normRole(cand.role);
  if (!intent.role || !role) return 0;
  if (role === intent.role) return 3;
  if (ROLE_FAMILIES.some((f) => f.includes(role) && f.includes(intent.role))) return 2;
  return 0;
}

export function nameScore(cand, intent) {
  const a = normText(cand.name);
  if (!a || !intent.name) return 0;
  if (a === intent.name) return 4;
  if (a.includes(intent.name) || intent.name.includes(a)) return 3;
  const want = intent.name.split(' ').filter(Boolean);
  const have = a.split(' ').filter(Boolean);
  const hit = want.filter((w) => have.includes(w)).length;
  return want.length && hit ? (hit / want.length) * 2 : 0;
}

export function scoreCandidate(cand, intent) {
  let s = roleScore(cand, intent) + nameScore(cand, intent);
  if (cand.tag && intent.tag && cand.tag === intent.tag) s += 1;
  // @eN refs drive a physical CDP click; @dN refs fall back to element.click()
  if (typeof cand.ref === 'string' && cand.ref.startsWith('@e')) s += 0.5;
  if (intent.id && normText(cand.name).includes(intent.id)) s += 1;
  return Math.round(s * 10) / 10;
}

export function matchIntent(cands, intent) {
  const scored = [];
  for (const c of cands || []) {
    if (!c.ref) continue; // a match we cannot address is not a match
    const s = scoreCandidate(c, intent);
    if (s > 0) scored.push({ c, s });
  }
  scored.sort((a, b) => b.s - a.s);
  const best = scored[0];
  const close = scored.slice(0, 3).map(({ c, s }) => ({ ref: c.ref || null, role: c.role || null, name: truncText(c.name) || null, score: s }));
  // a role-only match is how you end up clicking the wrong "button"; require
  // the name to have contributed unless the trace itself carried no name
  const grounded = best && best.s >= MIN_SCORE && (intent.name ? nameScore(best.c, intent) > 0 : roleScore(best.c, intent) >= 3);
  if (!grounded) return { ok: false, candidates: close, score: best ? best.s : 0 };
  return {
    ok: true,
    ref: best.c.ref,
    role: best.c.role || null,
    name: truncText(best.c.name) || null,
    score: best.s,
    candidates: close,
  };
}

/** @eN / @dN lines of a snapshot or dom-fallback dump → candidate objects. */
export function parseSnapshotText(text) {
  const out = [];
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const tok = line.split(' ');
    let i = 0;
    let ref = null;
    if (/^@[ed]\d+/.test(tok[0])) {
      ref = tok[0];
      i = 1;
    }
    if (!ref) continue;
    const role = tok[i] || '';
    const quoted = /"((?:[^"\\]|\\.)*)"/.exec(line.slice(ref.length + role.length + 1));
    let name = '';
    if (quoted) {
      try { name = JSON.parse(quoted[0]); } catch { name = quoted[1]; }
    }
    out.push({ ref, role, name });
  }
  return out;
}

// ------------------------------------------------------------------------ vars

export function varNames(text) {
  return [...new Set([...String(text || '').matchAll(VAR_TOKEN)].map((m) => m[1]))];
}

/** Replace {{var.NAME}} from the vars table; report names, never values. */
export function applyVars(text, vars) {
  const names = varNames(text);
  const missing = names.filter((n) => !Object.prototype.hasOwnProperty.call(vars || {}, n));
  const out = String(text).replace(VAR_TOKEN, (full, name) =>
    Object.prototype.hasOwnProperty.call(vars || {}, name) ? String(vars[name]) : full);
  return { text: out, names, missing };
}

// ------------------------------------------------------------------ replay core

function describeIntent(intent) {
  return `role=${intent.role || intent.role_recorded || '-'} name=${JSON.stringify(truncText(intent.name))}`;
}

export async function replayTrace(events, opt = {}) {
  const vars = opt.vars && typeof opt.vars === 'object' ? opt.vars : {};
  const dryRun = opt.dryRun === true;
  const stopOnError = opt.stopOnError !== false;
  const confirm = opt.confirm === true;
  const probe = opt.probe || { candidates: async () => [], selectorVisible: async () => false };
  const perform = opt.perform;
  const startAt = Math.max(0, Math.trunc(Number(opt.startAt) || 0));
  const requested = Math.trunc(Number(opt.maxSteps) || 0);
  if (requested > MAX_STEPS) {
    throw err('TOO_MANY_STEPS', `max_steps overflows the ${MAX_STEPS}-step cap per replay call; run the rest with start_at`);
  }
  const remaining = events.length - startAt;
  if (!requested && remaining > MAX_STEPS) {
    throw err('TOO_MANY_STEPS', `${remaining} steps from start_at ${startAt} exceed the ${MAX_STEPS}-step cap per replay call; chunk with start_at + max_steps`);
  }
  const slice = events.slice(startAt, startAt + (requested > 0 ? requested : MAX_STEPS));
  const waitMs = Number.isFinite(Number(opt.waitBetweenMs)) ? Math.max(0, Math.min(30000, Number(opt.waitBetweenMs))) : DEFAULT_WAIT_MS;

  const steps = [];
  const varsSeen = new Set();
  let executed = 0;
  let skipped = 0;
  let blocked = 0;
  let aborted = false;

  for (let i = 0; i < slice.length; i++) {
    if (opt.signal?.aborted) { aborted = true; break; }
    const ev = slice[i];
    const n = startAt + i;
    const intent = intentFor(ev);
    const step = {
      step: n,
      event_type: ev.type,
      intent: { kind: intent.kind, role: intent.role || intent.role_recorded || null, name: truncText(intent.name) || null },
      action: intent.kind === 'skip' ? 'skip' : intent.kind,
      via: null,
      matched_ref: null,
      matched_selector: null,
      matched_name: null,
      score: 0,
      status: 'planned',
    };
    steps.push(step);

    const block = (code, message) => {
      step.status = 'blocked';
      step.error = code;
      step.detail = message;
      blocked++;
      if (!dryRun && stopOnError) throw err(code, message);
    };

    if (intent.kind === 'skip') {
      step.status = 'skipped';
      step.detail = intent.note;
      skipped++;
      continue;
    }

    if (intent.kind === 'navigate') {
      if (cdp.isRestrictedUrl(intent.url)) {
        block('URL_BLOCKED', `step ${n} navigates to a restricted page (${JSON.stringify(truncText(intent.url))}); UBB never automates it — drop the step and let the user go there`);
        continue;
      }
      if (!intent.url || !/^https?:|^about:blank$/i.test(intent.url)) {
        block('BAD_URL', `step ${n} has no replayable url (recorded: ${JSON.stringify(truncText(intent.url || ''))}); pass the url in vars or drop the step`);
        continue;
      }
      step.url = redactUrl(intent.url);
    }

    if (intent.kind === 'scroll') {
      if (!Number.isFinite(intent.to?.x) && !Number.isFinite(intent.to?.y)) {
        step.status = 'skipped';
        step.detail = 'scroll event has no numeric delta position';
        skipped++;
        continue;
      }
    }

    if (intent.kind === 'keypress' && !intent.key) {
      block('BAD_EVENT', `step ${n}: keypress without a "key" field`);
      continue;
    }

    if (intent.value !== null) {
      if (MASKED_VALUE.test(intent.value.trim())) {
        block('SENSITIVE_FIELD', `step ${n}: the recorded value is masked ("***"), UBB never replays a mask — rewrite this event's value as {{var.NAME}} and pass vars, or have the user type it`);
        continue;
      }
      if (NEVER_AUTO_FILL.test(`${intent.name} ${intent.id || ''}`)) {
        block('SENSITIVE_FIELD', `step ${n}: OTP / card / private-key fields are never auto-filled by UBB, from any source — the user must type this one`);
        continue;
      }
      const hasTemplate = varNames(intent.value).length > 0;
      if (SENSITIVE_FIELD.test(intent.name) && !hasTemplate) {
        block('SENSITIVE_FIELD', `step ${n}: "${truncText(intent.name)}" is a password-like field and the value came in as a plain parameter — plaintext secrets are refused; pass it through vars as {{var.NAME}} (back it with {{secret:NAME}} so it never enters this conversation)`);
        continue;
      }
      for (const name of varNames(intent.value)) varsSeen.add(name);
      const r = applyVars(intent.value, vars);
      if (r.missing.length) {
        // names only — a vars value must never reach an error message
        block('VAR_UNKNOWN', `step ${n} references {{var.${r.missing.join(', ')}}} which is not in vars — add those keys and retry`);
        continue;
      }
      if (LEFTOVER_SECRET.test(r.text)) {
        block('SECRET_UNRESOLVED', `step ${n}: the value still carries an unresolved {{secret:...}} placeholder — the daemon resolves placeholders only inside vars values ({"vars":{"PW":"{{secret:name}}"}}), and an unknown name is refused vault-side; nothing was typed`);
        continue;
      }
      // vault-backed provenance is stamped by the daemon (agent copies stripped
      // at the forward boundary): only these steps may ever type a password field
      // vault-backed provenance is stamped by the daemon (agent copies stripped at
      // the forward boundary): only these steps may ever type a password field.
      // "value_from_vault" not "…secret…": redact() blanks any key holding that
      // substring, which would hide the flag from the model reading a plan.
      const secretMap = opt.secretVars && typeof opt.secretVars === 'object' ? opt.secretVars : null;
      const backed = secretMap ? r.names.filter((k) => Array.isArray(secretMap[k]) && secretMap[k].length) : [];
      if (backed.length) {
        step.value_from_vault = true;
        step.vault_entries = [...new Set(backed.flatMap((k) => secretMap[k]))];
      }
      step.value_template = intent.value;
      step.value_chars = r.text.length;
      step.resolved_value = r.text;
    }

    if (intent.needsTarget) {
      const cands = await probe.candidates(intent);
      const m = matchIntent(cands, intent);
      step.score = m.score || 0;
      if (m.ok) {
        step.matched_ref = m.ref;
        step.matched_name = m.name;
        step.via = m.ref.startsWith('@d') ? 'dom-search' : 'accessibility';
      } else if (intent.selector && (await probe.selectorVisible(intent.selector))) {
        step.matched_selector = intent.selector;
        step.via = 'selector';
        step.score = 0;
      } else {
        const tried = (m.candidates || []).map((c) => `${c.role || '?'} ${JSON.stringify(c.name || '')}${c.ref ? ` (${c.ref})` : ''}`).join(' | ');
        block('MATCH_NOT_FOUND', `step ${n}: nothing on the live page matches ${describeIntent(intent)} (selector ${JSON.stringify(intent.selector || '')} not visible either); closest candidates: ${tried || 'none'} — take a fresh snapshot, fix the trace target, or use start_at to resume after this step`);
        continue;
      }
      const risky = `${intent.name} ${step.matched_name || ''}`;
      if (DANGEROUS_LABEL.test(risky)) {
        step.needs_confirm = true;
        if (!confirm) {
          block('NEEDS_CONFIRM', `step ${n} hits a destructive/paid label ("${truncText(step.matched_name || intent.name)}") — ask the user, then re-run replay with confirm:true`);
          continue;
        }
      }
    }

    if (dryRun) continue;

    await perform(step, intent);
    executed++;
    step.status = 'done';
    if (i < slice.length - 1 && waitMs) await sleep(waitMs);
  }

  const failed = steps.filter((s) => s.status === 'blocked');
  return {
    ok: !failed.length && !aborted,
    dry_run: dryRun,
    steps_total: steps.length,
    executed,
    skipped,
    blocked: failed.length,
    aborted,
    vars: [...varsSeen],
    failed_steps: failed.map((s) => ({ step: s.step, code: s.error })),
    steps: steps.map(toPublicStep),
  };
}

// resolved_value is the (possibly secret-substituted) text to type: it must
// never leave this module, not even inside redact()'s "[redacted]" marker.
function toPublicStep({ resolved_value, ...rest }) {
  return rest;
}

// ------------------------------------------------------------- page-side plumbing

async function backendNodeOfSelector(tabId, selector) {
  const doc = await cdp.send(tabId, 'DOM.getDocument', { depth: 1 }).catch(() => null);
  const q = await cdp.send(tabId, 'DOM.querySelector', { nodeId: doc?.root?.nodeId, selector }).catch(() => null);
  if (!q?.nodeId) throw err('MATCH_NOT_FOUND', `selector ${JSON.stringify(truncate(selector, 80))} no longer matches a node — take a fresh snapshot and fix the trace target`);
  const d = await cdp.send(tabId, 'DOM.describeNode', { nodeId: q.nodeId }).catch(() => null);
  if (d?.node?.backendNodeId == null) throw err('MATCH_NOT_FOUND', `selector ${JSON.stringify(truncate(selector, 80))} resolves to a node CDP cannot address`);
  return d.node.backendNodeId;
}

const FILL_FN = `function (value) {
  var el = this;
  el.focus();
  if (el.isContentEditable) {
    document.execCommand('selectAll');
    document.execCommand('insertText', false, String(value));
    return (el.textContent || '').length;
  }
  if (!(el instanceof HTMLInputElement) && !(el instanceof HTMLTextAreaElement)) throw new Error('matched element is not a text field');
  var proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  var d = Object.getOwnPropertyDescriptor(proto, 'value');
  if (d && d.set) d.set.call(el, String(value)); else el.value = String(value);
  el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: String(value) }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  try { el.setSelectionRange(el.value.length, el.value.length); } catch (e) {}
  return el.value.length;
}`;

const SELECT_FN = `function (want) {
  var el = this;
  var opt = Array.from(el.options || []).find(function (o) { return o.value === want || (o.textContent || '').trim() === want; });
  if (!opt) throw new Error('no such option in this select');
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(el, opt.value);
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return (opt.textContent || '').trim();
}`;

function makeProbe(tabId) {
  return {
    async candidates(intent) {
      const out = [];
      // every targeting step re-reads the page: a replay is only as good as
      // its freshest accessibility tree
      const shot = await takeSnapshot(tabId, { filter: 'interactive', max_chars: 200000 });
      out.push(...parseSnapshotText(shot.text));
      if (intent.name) {
        const s = await bridge(tabId, 'search', { query: intent.name.slice(0, 60), limit: 8 }).catch(() => null);
        for (const m of s?.matches || []) {
          if (m.ref) out.push({ ref: m.ref, role: m.role, name: m.name, tag: m.tag });
        }
      }
      return out;
    },
    async selectorVisible(selector) {
      return !!(await evalJs(tabId, visibleExpr(selector)).catch(() => false));
    },
  };
}

function makeActor(tabId, p) {
  return async function perform(step, intent) {
    const ref = step.matched_ref;
    const sel = step.matched_selector;
    switch (step.action) {
      case 'click': {
        if (typeof ref === 'string' && ref.startsWith('@d')) {
          await bridge(tabId, 'clickDom', { ref });
        } else if (!ref) {
          await bridge(tabId, 'clickDom', { selector: sel });
        } else {
          const { box, meta } = await resolveRef(tabId, ref);
          if (DANGEROUS_LABEL.test(meta?.name || '') && p.confirm !== true) {
            throw err('NEEDS_CONFIRM', `"${truncText(meta.name)}" looks like a destructive or paid action — ask the user, then re-run with confirm:true`);
          }
          // A replay runs dozens of steps back to back, so THIS step's own point
          // is what each dispatch confirms (at=… drives the elementFromPoint
          // hit-test; without it a mid-run veil bounce would idle the script).
          await withPass(tabId, async () => {
            await mouse(tabId, 'mouseMoved', box.cx, box.cy);
            await mouse(tabId, 'mousePressed', box.cx, box.cy);
            await sleep(30);
            await mouse(tabId, 'mouseReleased', box.cx, box.cy);
          }, { at: [box.cx, box.cy], frameId: meta?.frameId ?? 0 });
        }
        audit.log({ action: 'replay.click', tabId, target: step.matched_name || step.matched_selector || null });
        return;
      }
      case 'fill': {
        const value = step.resolved_value;
        if (typeof ref === 'string' && ref.startsWith('@d')) {
          await bridge(tabId, 'fillDom', { ref, value });
        } else if (!ref) {
          await bridge(tabId, 'fillDom', { selector: sel, value });
        } else {
          const { nodeId, meta } = await resolveRef(tabId, ref);
          // password fields open ONLY for a step whose value came from a
          // daemon-resolved vault placeholder; OTP-class fields stay refused
          // inside the guard whatever the flag says. vaultNames feeds the
          // extension-side origin gate (strict refuses a mismatched host).
          await guardSensitiveField(tabId, nodeId, meta, step.value_from_vault ? { allowPassword: true, vaultNames: step.vault_entries, vaultGate: p.__ubb_secret_gate } : {});
          await withPass(tabId, () => callOnNode(tabId, meta?.backendNodeId, FILL_FN, [value]));
        }
        audit.log({
          action: step.value_from_vault ? 'replay.secret_fill' : 'replay.fill',
          tabId,
          target: step.matched_name || step.matched_selector || null,
          chars: String(value ?? '').length,
          ...(step.value_from_vault ? { vault_entries: step.vault_entries } : {}),
        });
        return;
      }
      case 'select_option': {
        const value = step.resolved_value;
        let backend = null;
        if (typeof ref === 'string' && ref.startsWith('@e')) {
          backend = (await resolveRef(tabId, ref)).meta?.backendNodeId;
        } else {
          // a @dN (DOM-fallback) select is not addressable by CDP: the trace
          // selector is what bridges the gap
          const selector = typeof ref === 'string' ? intent.selector : sel;
          if (!selector) {
            throw err('BAD_SELECTOR', `the matched <select> (${JSON.stringify(ref || sel)}) came from the DOM fallback and the trace carries no selector for it — take a fresh snapshot so it gets an @eN ref, then re-run`);
          }
          backend = await backendNodeOfSelector(tabId, selector);
        }
        await withPass(tabId, () => callOnNode(tabId, backend, SELECT_FN, [value]));
        audit.log({ action: 'replay.select', tabId, target: step.matched_name || step.matched_selector || null });
        return;
      }
      case 'keypress': {
        // keys:true is what makes the confirmation check the document's live
        // capture listeners: without it an orphaned world reports an open door
        // and every replayed keystroke is silently eaten (fix7-shield's keys rule)
        await withPass(tabId, async () => {
          await key(tabId, 'keyDown', intent.key);
          await key(tabId, 'keyUp', intent.key);
        }, { keys: true });
        audit.log({ action: 'replay.key', tabId, key: intent.key });
        return;
      }
      case 'scroll': {
        const x = Number.isFinite(intent.to?.x) ? Math.round(intent.to.x) : 0;
        const y = Number.isFinite(intent.to?.y) ? Math.round(intent.to.y) : 0;
        await evalJs(tabId, `window.scrollTo(${x}, ${y})`);
        return;
      }
      case 'navigate': {
        await chrome.tabs.update(tabId, { url: intent.url });
        const loaded = await waitForLoad(tabId, Number(p.timeout_ms) || 20000);
        audit.log({ action: 'replay.navigate', tabId, loaded });
        return;
      }
      default:
        throw err('BAD_PARAMS', `replay has no executor for action "${step.action}"`);
    }
  };
}

// --------------------------------------------------------------- saved scripts

function scriptName(name) {
  const n = String(name || '').trim();
  if (!SCRIPT_NAME.test(n)) throw err('BAD_PARAMS', 'name must match [A-Za-z0-9_.-]{1,64}');
  return n;
}

function traceSourceMeta(trace) {
  if (!trace || Array.isArray(trace)) return null;
  return {
    id: trace.id || null,
    description: truncate(String(trace.description || ''), 200),
    start_url: trace.start_url ? redactUrl(trace.start_url) : null,
    final_url: trace.final_url ? redactUrl(trace.final_url) : null,
    duration_ms: typeof trace.duration_ms === 'number' ? trace.duration_ms : null,
  };
}

function traceUrls(events, trace) {
  const urls = new Set();
  for (const ev of events) {
    if (typeof ev.url === 'string' && ev.url) urls.add(redactUrl(ev.url));
  }
  for (const u of [trace?.start_url, trace?.final_url]) if (u) urls.add(redactUrl(u));
  return [...urls].slice(0, 12);
}

function scriptSummary(script) {
  return {
    name: script.name,
    saved_at: script.saved_at,
    steps: script.steps,
    urls: script.urls,
    source: script.source,
    bytes: script.bytes,
  };
}

async function scriptKey(name) {
  const all = await chrome.storage.session.get(null);
  const key = SCRIPT_PREFIX + name;
  const script = all[key];
  if (!script || !Array.isArray(script.events)) {
    throw err('SCRIPT_NOT_FOUND', `no saved replay script "${name}" — see replay.list, or re-save it with replay.save`);
  }
  return script;
}

async function runOnTab(events, tabId, p, ctx) {
  const result = await replayTrace(events, {
    vars: p.vars,
    secretVars: p.__ubb_secret_vars, // daemon-stamped {varsKey: [secretNames]}
    dryRun: p.dry_run === true,
    stopOnError: p.stop_on_error !== false,
    confirm: p.confirm === true,
    startAt: p.start_at,
    maxSteps: p.max_steps,
    waitBetweenMs: p.wait_between_ms ?? DEFAULT_WAIT_MS,
    probe: makeProbe(tabId),
    perform: makeActor(tabId, p),
    signal: ctx?.signal,
  });
  audit.log({ action: 'replay', tabId, dry_run: result.dry_run, executed: result.executed, skipped: result.skipped, blocked: result.blocked });
  return redact({ ...result, tab_id: tabId });
}

export function register(dispatcher) {
  const R = (name, meta, fn) => dispatcher.register(name, meta, fn);

  R('replay', {
    category: 'interaction',
    timeoutMs: 180000,
    description:
      'Replay a recorded trace on the target tab with no LLM in the loop: each event is re-matched against a FRESH accessibility snapshot by role + name (selector/tag as tie-breaker), then driven with CDP mouse/key. ' +
      'trace accepts the record_stop result object, its events array, or an edited array using {{var.NAME}} placeholders; vars fills those (values are never echoed back — only vars names and value lengths appear in the result). ' +
      'Passwords: put {"varKey":"{{secret:NAME}}"} in vars — the daemon substitutes ONLY inside vars values (never inside trace/events, so no plaintext can land in a saved script), and only steps whose value came from that vault placeholder may type a password field; a plaintext password parameter or an unresolved {{secret:…}} is refused (SENSITIVE_FIELD / SECRET_UNRESOLVED). OTP / CVV / card / fields named *secret* are refused whatever the source. ' +
      'dry_run:true only returns the match plan and performs NOTHING — run it first. stop_on_error defaults to true; MATCH_NOT_FOUND reports the 3 closest candidates so you can fix the trace or resume with start_at. ' +
      'Masked "***" values are refused (no bypass). A step hitting a destructive/paid label (删除/支付/delete/transfer…) refuses the whole run until confirm:true. drag events are reported as skipped, navigation steps wait for load. Cap 500 steps per call: chunk long traces with start_at/max_steps (every targeting step re-snapshots the page, so long traces are slow).',
  }, async (p = {}, ctx) => {
    const tabId = targetTab(p);
    const events = normalizeTrace(p.trace ?? p.events);
    return runOnTab(events, tabId, p, ctx);
  });

  R('replay.save', {
    category: 'interaction',
    description:
      'Save a trace as a named script in chrome.storage.session under key ubb_replay:<name> so replay.run can reuse it without the model holding the whole trace. Events only (record_stop snapshots are dropped) and ≤1MB. ' +
      'Scripts stay credential-free: keep {{var.NAME}} templates in the events and pass vars (with {{secret:NAME}} inside them) at run time — the daemon additionally restores any vault plaintext that slips into the saved trace back to its {{secret:NAME}} placeholder, so a resolved password never persists into session storage. ' +
      'session storage lives only until the browser restarts — exporting to disk is a CLI/integration concern and is not done here.',
  }, async (p = {}) => {
    const name = scriptName(p.name);
    const trace = p.trace ?? p.events;
    const events = normalizeTrace(trace);
    const script = {
      name,
      saved_at: new Date().toISOString(),
      source: traceSourceMeta(trace),
      steps: events.length,
      urls: traceUrls(events, trace),
      events,
    };
    const bytes = JSON.stringify(script).length;
    if (bytes > MAX_SCRIPT_BYTES) {
      throw err('TRACE_TOO_LARGE', `${name} is ${bytes} bytes, over the 1MB script cap — drop scroll/navigation events or replay the trace directly`);
    }
    try {
      await chrome.storage.session.set({ [SCRIPT_PREFIX + name]: { ...script, bytes } });
    } catch (e) {
      throw err('STORAGE_FAILED', `could not save "${name}": ${String(e?.message || e)}`);
    }
    audit.log({ action: 'replay.save', name, steps: events.length });
    return redact(scriptSummary({ ...script, bytes }));
  });

  R('replay.list', {
    category: 'interaction',
    description: 'Saved replay scripts: name, saved_at, step count, urls only (never the event values). Feed a name to replay.run.',
  }, async () => {
    const all = await chrome.storage.session.get(null).catch(() => ({}));
    const scripts = [];
    for (const [key, script] of Object.entries(all || {})) {
      if (!key.startsWith(SCRIPT_PREFIX) || !script || !Array.isArray(script.events)) continue;
      scripts.push(scriptSummary({ ...script, name: key.slice(SCRIPT_PREFIX.length) }));
    }
    scripts.sort((a, b) => String(a.saved_at).localeCompare(String(b.saved_at)));
    return redact({ scripts, note: 'session storage only: gone when the browser restarts' });
  });

  R('replay.delete', {
    category: 'interaction',
    description: 'Delete one saved replay script by name (ubb_replay:<name> in chrome.storage.session). replay.list shows what is there.',
  }, async (p = {}) => {
    const name = scriptName(p.name);
    await chrome.storage.session.remove(SCRIPT_PREFIX + name);
    audit.log({ action: 'replay.delete', name });
    return { deleted: name };
  });

  R('replay.run', {
    category: 'interaction',
    timeoutMs: 180000,
    description:
      'Run a script saved by replay.save against tab_id — same semantics and options as replay (vars, dry_run, stop_on_error, start_at, max_steps, wait_between_ms, confirm) minus trace/events. Run replay with dry_run:true first on an unknown page.',
  }, async (p = {}, ctx) => {
    const tabId = targetTab(p);
    const name = scriptName(p.name);
    const script = await scriptKey(name);
    const r = await runOnTab(normalizeTrace(script.events), tabId, p, ctx);
    return { ...r, name, saved_at: script.saved_at };
  });
}
