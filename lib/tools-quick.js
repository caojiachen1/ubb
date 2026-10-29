// Wave 1-A ("quick"): dropdown_options, print_pdf, search, batch.
// Shared helpers come from ./actions.js — nothing here re-declares them.

import {
  cdp,
  refs,
  sessions,
  targetTab,
  evalJs,
  waitForLoad,
  armTab,
  withHiddenShield,
  audit,
  redact,
  redactUrl,
  truncate,
  pack,
  err,
  callOnNode,
} from './actions.js';
import { normalizeUrl } from './tabs.js';

const OPTION_LIMIT = 500;
const PDF_INLINE_MAX = 3 * 1024 * 1024;
const PRINT_PDF_TIMEOUT_MS = 90_000;
const BATCH_STEP_LIMIT = 12;
const BATCH_TIMEOUT_MS = 180_000;
// terminal / global-switch tools: a blind-fired one cannot be undone by the
// stop_on_error path, so they stay out of batch entirely
const BATCH_FORBIDDEN = new Set(['session.stop', 'tab.close', 'human.set']);

let bus = null; // the dispatcher batch re-enters; set by register()

// Injected into the page: `this` is the control. Everything it uses must be
// inside this function — module-scope constants do not exist once .toString()
// is shipped to the renderer. Never throws: a control we cannot read comes back
// as an empty list plus a note telling the model what to do next.
function readDropdown(limit) {
  const clean = (n) => String(n == null ? '' : n).replace(/\s+/g, ' ').trim();
  const mapOpt = (o, i) => {
    const text = clean(o.textContent);
    let v = o.value;
    if (v == null && o.getAttribute) v = o.getAttribute('data-value') ?? o.getAttribute('value');
    return {
      index: i,
      value: v == null ? text : String(v),
      text,
      selected: o.selected === true || (typeof o.getAttribute === 'function' && o.getAttribute('aria-selected') === 'true'),
    };
  };
  const tag = clean(this.tagName).toLowerCase();
  const role = clean(this.getAttribute && this.getAttribute('role')).toLowerCase();

  if (tag === 'select') {
    const all = Array.from(this.options || []);
    return {
      tag,
      role: role || 'combobox',
      options: all.slice(0, limit).map(mapOpt),
      total: all.length,
      truncated: all.length > limit,
      multiple: !!this.multiple,
      disabled: !!this.disabled,
    };
  }

  if (tag === 'input' && this.getAttribute('list')) {
    const dl = this.ownerDocument && this.ownerDocument.getElementById(this.getAttribute('list'));
    if (dl && dl.options) {
      const all = Array.from(dl.options);
      return {
        tag: 'input+datalist',
        role: role || 'combobox',
        options: all.slice(0, limit).map(mapOpt),
        total: all.length,
        truncated: all.length > limit,
      };
    }
  }

  if (role === 'combobox' || role === 'listbox' || this.getAttribute('aria-haspopup')) {
    const kids = Array.from(this.querySelectorAll('[role="option"], [role="menuitem"]'));
    if (kids.length) {
      return {
        tag,
        role: role || 'listbox',
        options: kids.slice(0, limit).map(mapOpt),
        total: kids.length,
        truncated: kids.length > limit,
        note: 'these are the options currently rendered — a closed custom widget may hold more',
      };
    }
    return { tag, role, options: [], total: 0, truncated: false, note: "custom listbox: expand it first with ax.action {action:'expand'} then re-snapshot" };
  }

  return { tag, role, options: [], total: 0, truncated: false, note: 'not a dropdown: point this at a <select>, an ARIA combobox/listbox, or an input with list=' };
}

const ENGINES = {
  ddg: { base: 'https://duckduckgo.com/', param: 'q', count: null },
  google: { base: 'https://www.google.com/search', param: 'q', count: 'num' },
  bing: { base: 'https://www.bing.com/search', param: 'q', count: 'count' },
  baidu: { base: 'https://www.baidu.com/s', param: 'wd', count: 'rn' },
  sogou: { base: 'https://www.sogou.com/web', param: 'query', count: null },
};

function looksLikeUrl(q) {
  return /:\/\//.test(q) || /^www\.[^\s/]*\.[a-z]{2,}/i.test(q);
}

/** Constant table + encodeURIComponent — a raw query is never concatenated. */
export function searchUrl(engine, query, maxResults) {
  const name = String(engine || 'ddg').toLowerCase();
  const e = ENGINES[name];
  if (!e) throw err('BAD_PARAMS', `unknown search engine "${name}"; use one of: ${Object.keys(ENGINES).join('|')}`);
  if (typeof query !== 'string' || !query.trim()) throw err('BAD_PARAMS', 'query must be a non-empty string');
  const parts = [`${e.param}=${encodeURIComponent(query)}`];
  let count_applied = false;
  if (maxResults != null) {
    const n = Math.min(Math.max(Math.round(Number(maxResults)) || 0, 1), 100);
    if (e.count) {
      parts.push(`${e.count}=${n}`);
      count_applied = true;
    }
  }
  return { url: `${e.base}?${parts.join('&')}`, engine: name, count_applied };
}

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

function suggestPdfName(tab) {
  const raw = String(tab?.title || '')
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
    .replace(/[. ]+$/, '');
  return `${raw || hostOf(tab?.url) || 'page'}.pdf`;
}

function positiveNumber(name, v, max, unit) {
  const n = Number(v);
  if (!(n > 0 && n <= max)) throw err('BAD_PARAMS', `${name} must be a number of ${unit}s greater than 0 and at most ${max}`);
  return n;
}

export function register(dispatcher) {
  bus = dispatcher;
  const R = (name, meta, fn) => dispatcher.register(name, meta, fn);

  R('dropdown_options', {
    category: 'sensing',
    description: 'List the selectable options of a dropdown — the one thing a snapshot cannot show (a closed <select> is not in the AX tree). {ref:"@eN"} preferred (works inside shadow DOM and frames), or {selector:"css"} (light DOM only). Returns {tag, role, options:[{index,value,text,selected}], total, truncated}. For a custom ARIA combobox/listbox the options are not in the closed DOM: you get a note telling you to ax.action {action:"expand"} first. Pair with form.set {action:"select_option"}.',
  }, async (p = {}) => {
    if (!p.ref && !p.selector) throw err('BAD_PARAMS', 'pass ref:"@eN" (from snapshot; reaches shadow DOM) or selector:"css"');
    const tabId = targetTab(p);
    let r;
    if (p.ref) {
      const entry = refs.get(tabId, p.ref);
      r = await callOnNode(tabId, entry.backendNodeId, readDropdown.toString(), [OPTION_LIMIT]);
    } else {
      const sel = JSON.stringify(String(p.selector));
      r = await evalJs(tabId, `(function(){var e=document.querySelector(${sel});if(!e)return null;return (${readDropdown.toString()}).call(e,${OPTION_LIMIT})})()`);
      if (r === null || r === undefined) {
        throw err('SELECTOR_FAILED', 'no light-DOM element matches that selector — shadow-DOM/custom-element controls need ref:"@eN" from snapshot');
      }
    }
    audit.log({ action: 'dropdown_options', tabId, total: r?.total, target: p.ref || p.selector });
    return redact(r);
  });

  R('print_pdf', {
    category: 'capture',
    timeoutMs: PRINT_PDF_TIMEOUT_MS,
    description: 'Render the target tab to PDF via CDP Page.printToPDF and return it. CDP units: paper_width/paper_height in INCHES (defaults to the browser default, letter 8.5x11), margins in CM (number = all sides, or {top,bottom,left,right}), scale 0.1-2, page_ranges e.g. "1-3,5", print_background defaults true. tag_selection:true sends CDP displayTags, an object is forwarded verbatim as CDP tagSelection (+displayTags) — both are accepted without error by Chromium, and that is NOT a promise that visible marks render: read the returned PDF back before claiming anything about tagged output (any other shape is BAD_PARAMS, never silently dropped). The UBB shield is hidden for the render. Over 3MB the base64 is dropped and you get {too_big:true, bytes, note} instead — saving via `ubb print_pdf --out <path>` keeps it out of the conversation.',
  }, async (p = {}) => {
    const args = { printBackground: p.print_background !== false };
    if (p.landscape) args.landscape = true;
    if (p.scale != null) {
      const n = Number(p.scale);
      if (!(n >= 0.1 && n <= 2)) throw err('BAD_PARAMS', 'scale must be between 0.1 and 2');
      args.scale = n;
    }
    if (p.paper_width != null) args.paperWidth = positiveNumber('paper_width', p.paper_width, 100, 'inch');
    if (p.paper_height != null) args.paperHeight = positiveNumber('paper_height', p.paper_height, 100, 'inch');
    if (p.page_ranges != null) args.pageRanges = String(p.page_ranges).slice(0, 200);
    if (p.margins != null) {
      const m = p.margins;
      const sides = typeof m === 'number' ? { top: m, bottom: m, left: m, right: m } : m || {};
      for (const side of ['top', 'bottom', 'left', 'right']) {
        if (sides[side] != null) args[`margin${side[0].toUpperCase()}${side.slice(1)}`] = positiveNumber(`margins.${side}`, sides[side], 50, 'cm');
      }
    }
    // tag_selection: the boolean shape is what an agent writes when it only wants
    // "print with visible tags", the object shape is a CDP tagSelection spec. The
    // old `typeof === 'object'` test dropped `true` on the floor and returned ok
    // (LIVE-RESULTS-2B 6e) — any other shape is a refusal, never a silent ignore.
    let tagApplied = null;
    if (p.tag_selection !== undefined && p.tag_selection !== null) {
      const ts = p.tag_selection;
      if (ts === true) {
        args.displayTags = true;
        tagApplied = 'displayTags:true sent (no tag list — pass an object, e.g. {strategy:"include",tags:[…]}, to select tags). CDP accepted the param; that is NOT proof the marks render — read the PDF back.';
      } else if (ts === false) {
        tagApplied = 'tag_selection:false — neither displayTags nor tagSelection was sent';
      } else if (typeof ts === 'object' && !Array.isArray(ts)) {
        args.tagSelection = ts;
        args.displayTags = true;
        tagApplied = 'tagSelection + displayTags:true sent verbatim; CDP drops/mangles params silently, so verify the produced PDF rather than trusting this answer';
      } else {
        throw err(
          'BAD_PARAMS',
          `tag_selection must be true, false, or an object like {strategy:"include",tags:[…]} — got type ${typeof ts}; it is never ignored, so fix the shape instead of reading a PDF that has no marks`,
        );
      }
    }
    const tabId = targetTab(p);
    await cdp.ensure(tabId);
    const shot = await withHiddenShield(tabId, () => cdp.send(tabId, 'Page.printToPDF', args));
    if (typeof shot?.data !== 'string' || !shot.data) {
      throw err('PRINT_TO_PDF_FAILED', 'Page.printToPDF returned no document — is the tab still on a printable page?');
    }
    const bytes = Math.round((shot.data.length * 3) / 4);
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    const extra = {
      filename_suggested: suggestPdfName(tab),
      url: redactUrl(tab?.url || ''),
      title: truncate(String(tab?.title || ''), 200),
      ...(tagApplied ? { tag_selection_applied: tagApplied } : {}),
    };
    audit.log({ action: 'print_pdf', tabId, bytes });
    if (bytes > PDF_INLINE_MAX && p.include_base64 !== true) {
      return redact({
        format: 'pdf',
        bytes,
        too_big: true,
        filename_suggested: extra.filename_suggested,
        ...(tagApplied ? { tag_selection_applied: tagApplied } : {}),
        note: `over ${PDF_INLINE_MAX / 1024 / 1024}MB so no base64 is returned — save it with: ubb print_pdf --out <path>.pdf (the CLI fetches the bytes and writes the file; keep the base64 out of the conversation)`,
      });
    }
    return redact(pack(shot, 'pdf', extra));
  });

  R('search', {
    category: 'navigation',
    description: 'Open a search-engine results page for a query (ddg default; google|bing|baidu|sogou) in a new session tab (new_tab:false navigates the target tab instead). Query is percent-encoded against a constant URL table; a query that looks like a URL is opened as a page instead. Returns {tab_id,url,title,engine,loaded} — SERP markup is deliberately NOT parsed here (too brittle); snapshot/read_page the result page.',
  }, async (p = {}) => {
    if (typeof p.query !== 'string' || !p.query.trim()) {
      throw err('BAD_PARAMS', 'query required: the search string (or a full URL to open)');
    }
    if (p.query.length > 1000) throw err('BAD_PARAMS', 'query is too long (max 1000 chars) — shorten it');
    const q = p.query.trim();
    let target;
    let engine;
    let note;
    if (looksLikeUrl(q)) {
      target = normalizeUrl(q);
      engine = 'url';
      note = 'the query looks like a URL, so it was opened directly instead of searched';
    } else {
      const built = searchUrl(p.engine, q, p.max_results);
      target = built.url;
      engine = built.engine;
      if (p.max_results != null && !built.count_applied) {
        note = `${engine} has no result-count URL parameter — read what the page returns`;
      }
    }
    // normalizeUrl prepends https:// to anything without a known scheme, so the
    // raw query has to be checked too (chrome://settings → https://chrome://…)
    if (cdp.isRestrictedUrl(q) || cdp.isRestrictedUrl(target)) {
      throw err('URL_BLOCKED', `restricted browser page, cannot be automated: ${redactUrl(target)}`);
    }

    const timeoutMs = Math.min(Math.max(Number(p.timeout_ms) || 20000, 1000), 60000);
    const tabId = p.new_tab === false ? targetTab(p) : null;
    if (tabId != null) {
      await chrome.tabs.update(tabId, { url: target });
      const loaded = await waitForLoad(tabId, timeoutMs).catch(() => false);
      return searchResult(tabId, engine, loaded, note);
    }
    if (!sessions.active()) await sessions.start();
    const created = await sessions.createTab(target, { active: p.active === true });
    await armTab(created.tab_id);
    const loaded = await waitForLoad(created.tab_id, timeoutMs).catch(() => false);
    return searchResult(created.tab_id, engine, loaded, note);
  });

  R('batch', {
    category: 'orchestration',
    timeoutMs: BATCH_TIMEOUT_MS,
    description: 'Run up to 12 tools through one request: {actions:[{tool,params}]}. Each step goes back through the dispatcher, so per-tool timeouts, the confirm gate, audit and redaction all still apply — nothing is bypassed. stop_on_error defaults true (stops at the first failure, failed_at tells you which step). inherit_tab defaults true: the tab resolved for the batch is stamped onto every step that has no tab_id, which is how you keep a batch on ONE tab instead of whatever the session touched last. batch, session.stop, tab.close and human.set are refused.',
  }, async (p = {}, ctx) => {
    if (!bus) throw err('NOT_WIRED', 'batch needs the dispatcher it was registered on');
    const steps = Array.isArray(p.actions) ? p.actions : null;
    if (!steps || !steps.length) throw err('BAD_PARAMS', 'actions:[{tool,params}] required — 1 to 12 steps');
    if (steps.length > BATCH_STEP_LIMIT) {
      throw err('BAD_PARAMS', `at most ${BATCH_STEP_LIMIT} actions per batch call — split it into two batches`);
    }
    for (const [i, s] of steps.entries()) {
      const name = s && s.tool;
      if (typeof name !== 'string' || !name) throw err('BAD_PARAMS', `action ${i} is missing its "tool" name`);
      if (name === 'batch') throw err('BAD_PARAMS', `action ${i}: batch cannot nest inside batch`);
      if (BATCH_FORBIDDEN.has(name)) {
        throw err('BAD_PARAMS', `action ${i}: "${name}" ends the session / closes a tab / flips a global switch — call it on its own so the user can see it`);
      }
    }
    const inherit = p.inherit_tab !== false;
    const stopOnError = p.stop_on_error !== false;
    let pinned = typeof p.tab_id === 'number' ? p.tab_id : null;
    if (pinned == null && inherit) {
      try {
        pinned = targetTab(p); // pins now, so later steps can't drift to another agent's tab
      } catch {
        pinned = null; // no tab yet — a later step (tab.create) can supply it
      }
    }

    const results = [];
    for (const [i, s] of steps.entries()) {
      const base = s.params && typeof s.params === 'object' ? s.params : {};
      const params = inherit && pinned != null && base.tab_id == null ? { ...base, tab_id: pinned } : base;
      const reply = await bus.handle({
        id: `${ctx?.requestId ?? 'batch'}:${i}:${Date.now()}`,
        method: `tool.${s.tool}`,
        params,
      });
      if (reply && reply.error == null) {
        results.push({ tool: s.tool, ok: true, result: reply.result === undefined ? { ok: true } : reply.result });
      } else {
        results.push({ tool: s.tool, ok: false, error: reply?.error ?? err('NO_REPLY', `${s.tool} produced no reply`) });
      }
      if (reply?.error != null && stopOnError) {
        return redact({ results, executed: results.length, failed_at: i });
      }
      if (inherit && pinned == null) {
        const r = reply?.result;
        pinned = typeof r?.tab_id === 'number' ? r.tab_id : sessions.active()?.lastTabId ?? null;
      }
    }
    return redact({ results, executed: results.length });
  });
}

async function searchResult(tabId, engine, loaded, note) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  return redact({
    tab_id: tabId,
    url: redactUrl(String(tab?.url || '')),
    title: truncate(String(tab?.title || ''), 200),
    engine,
    loaded,
    hint: 'take a snapshot to get @eN refs',
    ...(note ? { note } : {}),
  });
}
