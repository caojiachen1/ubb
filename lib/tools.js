// UBB tool implementations.
// Security rules: password/OTP fields are never auto-filled,
// dangerous labels require params.confirm, results pass through redaction.

import { cdp } from './cdp.js';
import { refs } from './refs.js';
import { downloadLedger } from './tools-downloads.js';
import { takeSnapshot, resolveRef, frameElementBox, listExtFrames, frameIsOutOfProcess } from './snapshot.js';
import { sessions, normalizeUrl } from './tabs.js';
import { shield, withPass, withHiddenShield, sleep, dropPasses } from './shield-ctl.js';
import { bridge } from './bridge-ctl.js';
import { audit } from './audit.js';
import { redact, redactUrl, truncate } from './redact.js';
import * as human from './human.js';
import {
  err,
  BUILD,
  DEFAULT_TOOL_TIMEOUT_MS,
  SCREENSHOT_TOOL_TIMEOUT_MS,
  TRACE_TOOL_TIMEOUT_MS,
} from './config.js';
import {
  DANGEROUS_LABEL,
  PASSWORD_FIELD,
  SENSITIVE_FIELD_NEVER,
  targetTab,
  attrsOf,
  guardSensitiveField,
  focusedNodeId,
  mouse,
  key,
  modifierBits,
  evalJs,
  armTab,
  pack,
  visibleExpr,
  waitForLoad,
  toCsv,
  runHelp,
  callOnNode,
  enforceVaultOrigins,
  originMatches,
} from './actions.js';
import { requestDaemon } from './ws-client.js';

// Page functions handed to callOnNode as .toString(). Every body must be
// self-contained: module-scope identifiers do not exist once it runs in the
// renderer, and `this` is the ref's element (shadow DOM included).

function selectExistingText() {
  this.focus();
  try { this.setSelectionRange(0, (this.value || '').length); } catch (e) {}
}

function selectOptionFn(want) {
  var opt = Array.from(this.options).find(function (o) { return o.value === want || o.textContent.trim() === want; });
  if (!opt) throw new Error('option not found: ' + want);
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(this, opt.value);
  this.dispatchEvent(new Event('change', { bubbles: true }));
  return { selected: opt.textContent.trim() };
}

function axActionFn(action, value) {
  if (action === 'focus') { this.focus(); return { active: document.activeElement === this }; }
  if (action === 'click') { this.click(); return { clicked: true }; }
  if (action === 'setValue') { this.value = value; this.dispatchEvent(new Event('input', { bubbles: true })); this.dispatchEvent(new Event('change', { bubbles: true })); return { value: this.value }; }
  if (action === 'expand') { this.setAttribute('aria-expanded', 'true'); this.click(); return { expanded: true }; }
}

// ---------------------------------------------------------------- frames (2-D)

/** @dN refs stay inside ONE bridge instance. Frame-routed searches return
 *  "@d<frameId>.<n>"; bare "@dN" keeps meaning the main frame (Wave 1 shape). */
function parseDomRef(ref) {
  const m = /^@d(\d+)\.(\d+)$/.exec(ref);
  if (m) return { frameId: Number(m[1]), domRef: '@d' + m[2] };
  return { frameId: 0, domRef: ref };
}

/** Validate the frame_* params at the tool boundary (frame_id = extension
 *  frameId from snapshot's frame[N] headers / frames.list, never a CDP id). */
function frameParams(p) {
  const frameId = p.frame_id == null ? 0 : Number(p.frame_id);
  if (!Number.isInteger(frameId) || frameId < 0) {
    throw err('BAD_PARAMS', 'frame_id must be an integer ≥ 0 (the frame[N] number shown by snapshot, or frames.list output)');
  }
  let framePath;
  if (p.frame_path !== undefined && p.frame_path !== null) {
    if (!Array.isArray(p.frame_path) || p.frame_path.some((i) => !Number.isInteger(i) || i < 0)) {
      throw err('BAD_PARAMS', 'frame_path must be an array of non-negative child-frame indices (same-origin hops from the routed frame)');
    }
    framePath = p.frame_path;
  }
  return { frameId, framePath };
}

/** Extension-frameId → its document URL from webNavigation (null when the
 *  frame is gone or the API is unavailable — offline harnesses). */
async function frameUrlOf(tabId, frameId) {
  const all = await listExtFrames(tabId).catch(() => null);
  return all?.find((f) => f.frameId === frameId)?.url || null;
}

/**
 * F1 (LIVE-RESULTS-2 §6b): refuse BEFORE dispatching any Input.* whose target
 * lives in an out-of-process frame. The page-level debugger session cannot
 * route mouse/key events there — the gate opens, the coordinates are right,
 * the frame receives zero events, and a returned {clicked:...} is the silent
 * lie this project exists to kill. Sensing keeps working (read_page/find/
 * element.info go through that frame's own bridge), and the @d-ref action
 * path (clickDom/fillDom/selectDom in-frame) reaches OOPIFs too — it is only
 * the TRUSTED-INPUT coordinate dispatch that cannot, so the refusal names the
 * exits that actually exist on this build.
 */
async function guardFrameInputReachable(tabId, ref, meta) {
  if (!(meta?.frameId > 0)) return;
  if (await frameIsOutOfProcess(tabId, meta.frameId)) {
    throw err(
      'FRAME_UNSUPPORTED',
      `${ref || 'this ref'} targets OUT-OF-PROCESS iframe ${meta.frameId} (cross-site document): this build gives it no CDP input channel, so a page-level Input.dispatchMouseEvent at its box would be reported ok and land nowhere — nothing is dispatched. Real exits: read_page/find {"frame_id":${meta.frameId}} then act through the frame's own bridge with an @d${meta.frameId}.<n> ref (click/fill/select — in-page synthetic events), let the user click, or tab.create the frame URL as a top-level tab. Same-process child frames (cross-origin, same site) are unaffected on this coordinate path.`,
    );
  }
}

const VAULT_NAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;

/**
 * The frame-tightened origin gate (wave7a, log-wave5a hand-off): a vault value
 * typed into an iframe lands in THAT document, so under strict/off the
 * binding comparison runs against the ref's own frame URL (meta.frameUrl),
 * not the top tab's host — the old shape let a github.com tab leak a vault
 * fill into an embedded evil.test frame. Fail-closed split: when the frame
 * URL is unobtainable (srcdoc/about:blank/stub) this delegates to the
 * top-host enforceVaultOrigins — the fill is still gated, never waved
 * through. Same marker trust model as actions.js (gate stamped by the
 * daemon; absent gate → the same secret.bindings RPC fallback).
 */
async function enforceVaultOriginsFrame(tabId, frameUrl, names, opts = {}) {
  let host = '';
  try {
    host = new URL(String(frameUrl || '')).hostname.toLowerCase();
  } catch {}
  if (!host) return enforceVaultOrigins(tabId, names, opts);
  const list = [...new Set((Array.isArray(names) ? names : []).filter((n) => typeof n === 'string' && VAULT_NAME_RE.test(n)))];
  if (!list.length) return;
  let mode;
  let bindings;
  const gate = opts.vaultGate && typeof opts.vaultGate === 'object' && Array.isArray(opts.vaultGate.bindings) ? opts.vaultGate : null;
  if (gate) {
    mode = gate.mode === 'strict' ? 'strict' : 'off';
    bindings = gate.bindings;
  } else {
    let r;
    try {
      r = await requestDaemon('secret.bindings', { names: list });
    } catch (e) {
      if (e && e.code) throw e;
      throw err('DAEMON_NOT_CONNECTED', `could not verify secret origin bindings with the local daemon (${list.join(',')}): ${String(e?.message || e)} — the placeholder fill is refused until the daemon link works`);
    }
    if (!r || typeof r !== 'object' || !Array.isArray(r.bindings)) {
      throw err('DAEMON_ERROR', 'the daemon answered secret.bindings without a binding list — refusing to type any vault value; update the daemon (`ubb daemon stop` then retry)');
    }
    mode = r.mode === 'strict' ? 'strict' : 'off';
    bindings = r.bindings;
  }
  const byName = new Map(bindings.map((b) => [b && b.name, b]));
  const fieldRole = opts.field_role || 'unknown';
  if (mode === 'strict') {
    for (const name of list) {
      const b = byName.get(name);
      const origins = Array.isArray(b?.origins) ? b.origins : [];
      let reason = null;
      if (!b || b.exists !== true) reason = 'secret_gone';
      else if (!origins.length) reason = 'unbound';
      else if (!origins.some((o) => originMatches(host, o))) reason = 'origin_mismatch';
      if (reason) {
        audit.log({ action: 'secret.fill', via: 'placeholder', tab_id: tabId, vault_entry: name, origin: host, field_role: fieldRole, mode, decision: 'denied', reason, frame: true });
        throw err(
          'SECRET_ORIGIN_DENIED',
          `secret "${name}" ${reason === 'unbound' ? 'has no origin binding and mode is strict' : reason === 'secret_gone' ? 'vanished from the vault between substitution and fill' : `is bound to ${origins.join(', ')} but the FRAME this field lives in is host ${JSON.stringify(host)} (top tab host is not consulted — the value would land in the frame document)`} — the {{secret:…}} placeholder value was NOT typed; fill it on the bound site itself, or let a human run \`ubb secret bind ${name} <host>\` / \`ubb secret mode off\``,
        );
      }
    }
  }
  audit.log({ action: 'secret.fill', via: 'placeholder', tab_id: tabId, vault_entry: list.join(','), origin: host, field_role: fieldRole, mode, decision: 'filled', frame: true });
}

/** §4 invariants re-checked INSIDE the frame from describeRef data — the same
 *  two classes as guardSensitiveField, same messages, same no-bypass split.
 *  The vault origin gate judges the FRAME's own origin (enforceVaultOriginsFrame). */
async function guardFrameField(tabId, ref, meta, desc, allowPassword, vaultNames, vaultGate) {
  const s = desc?.sensitive || {};
  const hay = [meta?.name, desc?.name, desc?.attributes?.name, desc?.attributes?.id, desc?.attributes?.placeholder, desc?.attributes?.['aria-label']].join(' ');
  if (s.never || SENSITIVE_FIELD_NEVER.test(hay)) {
    throw err(
      'SENSITIVE_FIELD',
      'this is a one-time-code / payment / secret-key field — UBB never auto-fills these, whatever the source; ask the user to type it',
    );
  }
  const isPassword = s.password || (desc?.attributes?.type === 'password' || PASSWORD_FIELD.test(hay));
  if (isPassword && !allowPassword) {
    throw err(
      'SENSITIVE_FIELD',
      'password field in an iframe: plaintext values are refused here — call secret.fill {"ref":"@eN","secret":"<name>"} (or put a {{secret:<name>}} placeholder in fill) instead of typing the value',
    );
  }
  if (isPassword && allowPassword && Array.isArray(vaultNames)) {
    await enforceVaultOriginsFrame(tabId, meta?.frameUrl, vaultNames, { field_role: 'password', vaultGate });
  }
}

/**
 * fix17 DELIVERY EXPECTATION for a press+release pair. An input tool's promise is
 * "the page received this", and only the document can answer that — CDP acks the
 * QUEUEING of an event, and on a hidden/occluded tab the event lands ~5s later,
 * after the gate used to close, on this extension's own veil. So a pointer action
 * names the records it needs to SEE in the document's ring before the gate may
 * report success. Both spellings are accepted (DOM event name / CDP type name).
 * `at` is only honoured for a top-document target: subframe events report client
 * coordinates relative to their own viewport (lib/shield-ctl.js drops the filter
 * there rather than refuse a delivery that did land).
 */
function pointerProof(at, to) {
  return [
    { types: ['mousedown', 'mousePressed'], at: at || null },
    { types: ['mouseup', 'mouseReleased', 'click'], at: to || at || null },
  ];
}

/** The three honest answers a proven action can return. `true` = the document
 *  recorded the event on a page element; `false` = INPUT_NOT_DELIVERED was thrown
 *  (a successful return never carries it); `null` = that document has no delivery
 *  ring to read (a content-script world older than fix17, or a frame whose
 *  recorder could not be installed) — labelled, not smoothed over. */
function deliveredField(dl) {
  if (!dl || dl.verdict === 'unprovable' || dl.verdict === 'not_requested') return null;
  return dl.delivered === true;
}

/**
 * Real-input fill for frame refs: a physical click focuses the control in its
 * own document (coordinate input crosses frame boundaries in the browser's
 * input router — for SAME-PROCESS frames only; OOPIF targets are refused
 * upstream by guardFrameInputReachable), Ctrl+A selects, Input.insertText
 * replaces. Everything here is trusted CDP input — NOT a synthetic DOM event,
 * so pages see a real burst.
 */
async function frameFillInput(tabId, box, value, pressEnter, frameId) {
  const dl = {};
  await withPass(
    tabId,
    async (gate) => {
      // mouse()/key() prove this point themselves before every Input.* (they call
      // assertInputGate before the send); the one dispatch here that bypasses
      // both is the raw insertText below, and that one keeps its own check. The
      // human branch is proved inside human.js, not twice over here.
      await mouse(tabId, 'mouseMoved', box.cx, box.cy);
      await mouse(tabId, 'mousePressed', box.cx, box.cy);
      await mouse(tabId, 'mouseReleased', box.cx, box.cy);
      await sleep(60); // let the frame land focus before insertText
      await key(tabId, 'keyDown', 'a', { modifiers: 2 });
      await key(tabId, 'keyUp', 'a', { modifiers: 2 });
      if (await human.isEnabled()) {
        await human.humanType(tabId, value);
      } else {
        await gate.check(); // raw insertText bypasses mouse()/key() — it proves itself
        await cdp.send(tabId, 'Input.insertText', { text: String(value ?? '') });
      }
      if (pressEnter) {
        await key(tabId, 'keyDown', 'Enter');
        await key(tabId, 'keyUp', 'Enter');
      }
    },
    {
      frameId: frameId || 0,
      at: [box.cx, box.cy],
      keys: true,
      // fix17: this is the COORDINATE path — a physical click that focuses the
      // control — so the press+release pair must be seen by the receiving
      // document before the door closes. Keyboard/insertText delivery inside a
      // subframe stays unprovable (frameblock.js keeps no ring); see the report.
      delivery: dl,
      expect: pointerProof([box.cx, box.cy]),
    },
  );
  return dl;
}

// ───────────────────────── fix19 HIDDEN-TAB FAST-FAIL (visibility before dispatch)
// LIVE-RESULTS-7 turned the lie into an honest red — and priced it: on a tab whose
// document is NOT visible (an Edge window sitting behind another window; `tab.select`
// activates the tab and still leaves visibilityState "hidden") the pointer queue
// never drains into the document at all. 20/20 real clicks paid ≈12.09s each
// (≈5.07s for the Input.* ack alone + the full 7s delivery-proof budget) and the
// page received ZERO events (records_seen:0, gate open the whole time). Refusing
// after 7 seconds of waiting for evidence that cannot exist is honest but useless,
// so the hidden case is now decided BEFORE dispatch, from the target document's own
// visibilityState:
//   visible  → unchanged: dispatch, then the fix17/18 delivery proof (full budget).
//   non-visible → INPUT_NOT_DELIVERED immediately, nothing put on the wire (so no
//                 double-fire risk either), with the exits that actually work.
//   unreadable → CONSERVATIVE: never treated as "visible". The action goes the old
//                 route (dispatch + the existing proof), because guessing "hidden"
//                 would refuse work that lands, and guessing "visible" would re-open
//                 the lie. This is the branch every offline harness without
//                 chrome.scripting walks, which is why the existing suites stay green.
// Budgets are constants, not literals at the call points (VISIBLE… = the proof
// ceiling the visible path keeps, HIDDEN… = the one DOM round trip this judgement
// is allowed to cost before it calls the state unreadable).
export const VISIBLE_WAIT_BUDGET_MS = 7000; // lib/shield-ctl.js PASS_DELIVERY_BUDGET_MS, unchanged for a visible tab
export const HIDDEN_BUDGET_MS = 400; // ceiling of the visibility read itself — a fast-fail must not become a new 7s
export const VISIBILITY_CACHE_TTL_MS = 5000; // perf guardrail: one read per (tab,frame) per TTL
const UNKNOWN_VISIBILITY = 'unknown';
const VISIBILITY_STATES = new Set(['visible', 'hidden', 'prerender', 'unloaded']);

// `${tabId}:${frameId}` → {state, at}. Keyed per DOCUMENT (a same-process iframe
// inherits the top document's visibility, but the key is the document the action
// names, so no cross-frame entry can be reused for another). Cleared on every
// event that can replace the document or move the window: navigation, reload,
// history jumps, tab.select (may make it visible — and MUST be re-read, not
// trusted either way), tab close/release/claim, window min/restore, session stop;
// plus the TTL, which bounds the damage a page-side self-navigation can do.
const visibilityCache = new Map();

export function invalidateVisibilityCache(tabId) {
  if (tabId == null) {
    visibilityCache.clear();
    return 0;
  }
  let n = 0;
  for (const key of [...visibilityCache.keys()]) {
    if (key.startsWith(`${tabId}:`)) {
      visibilityCache.delete(key);
      n++;
    }
  }
  return n;
}

export function visibilityCacheEntries() {
  return [...visibilityCache.entries()].map(([key, v]) => ({ key, ...v }));
}

/** Runs INSIDE the target document (chrome.scripting serialises it): it may not
 *  close over anything, and it reports the document's own answer — the same
 *  property the live rounds sampled as `vis`. */
function __ubbFrameVisibilityRead() {
  try {
    return String(document.visibilityState || '');
  } catch (e) {
    return '';
  }
}

function settleWithin(promise, ms) {
  return new Promise((resolve) => {
    let done = false;
    const t = setTimeout(() => {
      if (done) return;
      done = true;
      resolve({ status: 'timeout' });
    }, ms);
    Promise.resolve(promise).then(
      (value) => {
        if (done) return;
        done = true;
        clearTimeout(t);
        resolve({ status: 'ok', value });
      },
      (e) => {
        if (done) return;
        done = true;
        clearTimeout(t);
        resolve({ status: 'error', error: e });
      },
    );
  });
}

/** One bounded round trip. Returns a state from VISIBILITY_STATES, or null when
 *  the document could not be asked / did not answer / answered nonsense. */
async function readVisibilityState(tabId, frameId) {
  const ex = chrome.scripting && chrome.scripting.executeScript;
  if (typeof ex !== 'function') return null;
  const r = await settleWithin(
    ex.call(chrome.scripting, {
      target: { tabId, frameIds: [frameId] },
      func: __ubbFrameVisibilityRead,
    }),
    HIDDEN_BUDGET_MS,
  );
  if (r.status !== 'ok') return null;
  const rows = Array.isArray(r.value) ? r.value : [];
  for (const row of rows) {
    const s = row && typeof row.result === 'string' ? row.result : '';
    if (VISIBILITY_STATES.has(s)) return s;
  }
  return null;
}

/** Cached-by-default visibility of one document. `noCache` is for the callers
 *  that JUST changed the answer (tab.select, window.restore): occlusion is
 *  recomputed asynchronously, so a value read 0ms after the focus call can still
 *  be the old one — report it, but do not let it veto the next action. */
async function tabVisibility(tabId, frameId = 0, { noCache = false } = {}) {
  const key = `${tabId}:${frameId}`;
  const hit = visibilityCache.get(key);
  if (!noCache && hit && Date.now() - hit.at < VISIBILITY_CACHE_TTL_MS) return { state: hit.state, cached: true, reads: 0 };
  const read = await readVisibilityState(tabId, frameId);
  const state = read === null ? UNKNOWN_VISIBILITY : read;
  if (noCache) visibilityCache.delete(key);
  else visibilityCache.set(key, { state, at: Date.now() });
  return { state, cached: false, reads: 1 };
}

function hiddenInputMessage(state, frameId, ref) {
  const where = frameId > 0 ? `帧 ${frameId}` : '主文档';
  return (
    `${ref || '这一步'} 的指针/键盘输入被派发前的可见性判据拦下：目标${where}自己的 document.visibilityState = ${JSON.stringify(state)}（不是 "visible"）。` +
    `隐藏文档不会把受信输入排进页面——真机第七轮在这个形状上是 20/20：门全程开着、CDP 立刻 ack，可 ${VISIBLE_WAIT_BUDGET_MS}ms 的投递取证里页面一条事件都没有（records_seen:0），每次动作还要白等约 12 秒。` +
    `所以这里没有等那 ${VISIBLE_WAIT_BUDGET_MS}ms 预算，也一条 Input.* 都没有发出（0 事件上线 ⇒ 不存在"重试就双发"的风险）。下一步（三选一，别原样重试）：` +
    `① 由用户把承载这个标签的 Edge/Chrome 窗口真正置于前台（或最小化挡住它的窗口）——本扩展没有"把窗口提到最前"的能力，window.restore 只做聚焦/还原，窗口仍被遮挡时 visibilityState 照旧是 hidden；` +
    `② tab.create {"url":"…","active":true} 把目标开成一个前台活动标签（新建的 active 标签通常落在可见窗口里），或对本地标签 tab.select —— 说清楚：tab.select 只激活标签、只聚焦它的窗口，窗口被别的窗口挡住时它仍然是 hidden，别把 select 当成"已经可见"；` +
    `③ 若这个页面有桥通路可用（同进程文档），先 snapshot/find 拿 @d 选择器，再 click/fill 走桥内的合成事件（clickDom/fillDom）——它不进这条投递队列，隐藏标签也能落地，但那是 isTrusted:false 的合成事件，语义与真实输入不等价（页面能分辨，CSS :hover、文件选择、真实焦点序列、反作弊判定都不等效），要真的受信输入只有 ①/②；拿不准就 request_help 交回用户。`
  );
}

/**
 * fix19 gate: refuse a TRUSTED pointer/key dispatch before it is made, when the
 * document that would receive it is not visible. Callers name the document they
 * are about to hit (meta.frameId for a frame ref, 0 for the top document / a
 * focus-targeted key burst). `visible` and `unknown` both fall through — the
 * first to the existing delivery proof, the second to exactly the pre-fix19
 * behaviour (no new allow, no new refuse, on a judgement that could not be read).
 */
async function guardInputVisibility(tabId, opts = {}) {
  const frameId = Number.isInteger(opts.frameId) && opts.frameId > 0 ? opts.frameId : 0;
  const { state } = await tabVisibility(tabId, frameId);
  if (state === 'visible' || state === UNKNOWN_VISIBILITY) return { state };
  audit.log({
    action: 'visibility.refuse',
    tab_id: tabId,
    frame_id: frameId,
    tool: opts.action || 'input',
    target: opts.ref || null,
    visibility_state: state,
    dispatched: false,
  });
  throw err('INPUT_NOT_DELIVERED', hiddenInputMessage(state, frameId, opts.ref), {
    tab_id: tabId,
    frame_id: frameId,
    stage: 'pre-dispatch',
    visibility_state: state,
    dispatched: false,
    events_on_wire: 0,
    waited_ms: 0,
    hidden_budget_ms: HIDDEN_BUDGET_MS,
    visible_wait_budget_ms: VISIBLE_WAIT_BUDGET_MS,
    cache_ttl_ms: VISIBILITY_CACHE_TTL_MS,
    reason: 'document is not visible: the trusted-input queue of a hidden document does not drain into the page',
  });
}

// ---------------------------------------------------------------- registration

export function registerTools(dispatcher) {
  const R = (name, meta, fn) => dispatcher.register(name, meta, fn);

  // ---- session & tabs ------------------------------------------------------
  R('session.start', { category: 'session', description: 'Start an agent session. Default: agent tabs are auto-grouped into the UBB tab group in the current window (no new window). own_window:true creates a DEDICATED UNFOCUSED agent window instead — the user is never disturbed, and visibility-dependent work (CSS hover menus, screencast) raises it with tab.select without touching the user\'s tabs. Caveat: tab.claim moves a claimed user tab into the agent window.' }, async (p = {}) => {
    const r = await sessions.start({ own_window: p.own_window === true });
    return redact(r);
  });

  R('session.stop', { category: 'session', description: 'End the session; group is marked ✅, created tabs closed (or kept with close_created=false), claimed tabs returned.' }, async (p) => {
    const r = await sessions.stop({ close_created: p.close_created !== false });
    invalidateVisibilityCache(null); // fix19: every tab of the session is gone or handed back
    return redact(r);
  });

  R('session.status', { category: 'session', description: 'Active session info.' }, async () => {
    const s = sessions.active();
    if (!s) return { active: false, build: BUILD };
    return {
      active: true,
      build: BUILD,
      session_id: s.id,
      group_id: s.groupId,
      created_tabs: [...s.created],
      claimed_tabs: [...s.claimed],
      last_tab_id: s.lastTabId,
      started_at: s.startedAt,
    };
  });

  R('tab.list', { category: 'tabs', description: 'List tabs (scope "session" or "user"); session tabs marked.' }, async (p = {}) => {
    const scope = p.scope || 'all';
    const tabs = await chrome.tabs.query({});
    const groups = await chrome.tabGroups.query({}).catch(() => []);
    const gmap = new Map(groups.map((g) => [g.id, g.title]));
    const s = sessions.active();
    const out = tabs
      .filter((t) => !cdp.isRestrictedUrl(t.url) || t.id === s?.lastTabId)
      .filter((t) => scope === 'all' || (scope === 'session' ? sessions.owns(t.id) : !sessions.owns(t.id)))
      .map((t) => ({
        tab_id: t.id,
        title: truncate(t.title, 120),
        url: redactUrl(t.url),
        active: t.active,
        group: t.groupId ? gmap.get(t.groupId) || `(group ${t.groupId})` : null,
        session_owned: !!s && sessions.owns(t.id),
        mark: s?.marks?.get(t.id) || undefined,
      }));
    return { tabs: out };
  });

  R('tab.create', { category: 'tabs', description: 'Create a tab inside the UBB group (auto-starts session if needed). Opens SILENTLY in the background — the user stays on their current tab — and waits for the page to finish loading (loaded flag; cap with timeout_ms). Pass active:true only for pages that must be visible (CSS hover menus, video playback).' }, async (p = {}) => {
    if (sessions.isPaused()) throw err('SESSION_PAUSED', 'the user took over this session — no new agent tabs until they resume control');
    if (!sessions.active()) await sessions.start();
    const r = await sessions.createTab(p.url || 'about:blank', { active: p.active === true });
    await armTab(r.tab_id);
    const loaded = !p.url || normalizeUrl(p.url) === 'about:blank'
      ? true
      : await waitForLoad(r.tab_id, p.timeout_ms || 20000).catch(() => false);
    return { ...r, loaded };
  });

  R('tab.close', { category: 'tabs', description: 'Close a session-owned tab.' }, async (p) => {
    const tabId = p.tab_id ?? targetTab(p);
    if (sessions.isPaused()) throw err('SESSION_PAUSED', 'the user took over this session — no tab may be closed until they resume control');
    if (!sessions.owns(tabId)) throw err('TAB_NOT_OWNED', 'only session tabs can be closed');
    // F3 audit: the old .catch(() => {}) reported {closed:tabId} even when
    // chrome.tabs.remove refused — only call it closed if the tab is really gone
    try {
      await chrome.tabs.remove(tabId);
    } catch (e) {
      const alive = await chrome.tabs.get(tabId).catch(() => null);
      if (alive) throw err('TAB_CLOSE_FAILED', `chrome.tabs.remove refused for tab ${tabId} and the tab is still open (${String(e?.message || e).slice(0, 140)}) — not reporting it closed`);
    }
    invalidateVisibilityCache(tabId); // fix19: that document is gone; a recycled id must not inherit the answer
    sessions.active()?.created.delete(tabId);
    await sessions.touch();
    return { closed: tabId };
  });

  R('tab.select', { category: 'tabs', description: 'Bring a session tab to front (activates the tab and focuses its window). Only needed for visibility-dependent work — CSS hover menus, live screencast of animations, lazy-load-dependent extraction; everything else runs on background tabs. HONEST LIMIT (fix19, measured LIVE-RESULTS-7): activating the tab and focusing its window does NOT make an OCCLUDED window visible — if another window covers the Edge/Chrome window, document.visibilityState stays "hidden" after tab.select and trusted pointer/key input is still refused with INPUT_NOT_DELIVERED. The return says which case you are in (visibility_state / visible). Only the user bringing the window to the front changes it.' }, async (p) => {
    const tabId = p.tab_id ?? targetTab(p);
    if (!sessions.owns(tabId)) throw err('TAB_NOT_OWNED', 'claim the tab first');
    invalidateVisibilityCache(tabId); // fix19: select may have changed the answer — re-read, never reuse
    await chrome.tabs.update(tabId, { active: true });
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab.windowId) await chrome.windows.update(tab.windowId, { focused: true });
    } catch {}
    const { state } = await tabVisibility(tabId, 0, { noCache: true });
    return {
      selected: tabId,
      visibility_state: state,
      visible: state === 'visible',
      ...(state === 'visible'
        ? {}
        : {
            note:
              state === UNKNOWN_VISIBILITY
                ? 'visibilityState 读不到（DOM 通路没答案）：不判可见也不判隐藏，指针/键盘输入仍照常走原有派发 + 投递取证'
                : `窗口里的这个标签现在仍然是 ${JSON.stringify(state)} — tab.select 只激活标签/聚焦窗口，窗口被别的窗口挡住时 visibilityState 不会变 visible。指针/真键盘输入在这状态下会被快速拒绝（INPUT_NOT_DELIVERED），出路只有：让用户把该窗口点到前台、或 tab.create {"url":…,"active":true} 开前台标签；截图/抽取/网络与控制台不受影响。`,
          }),
    };
  });

  R('tab.claim', { category: 'tabs', description: 'Take over an existing user tab (shows an Allow/Deny banner on the page, default deny) and move it into the UBB group.' }, async (p) => {
    if (sessions.isPaused()) throw err('SESSION_PAUSED', 'the user took over this session — resume control (shield button) before claiming another tab');
    if (!sessions.active()) await sessions.start();
    const tabId = p.tab_id;
    if (typeof tabId !== 'number') throw err('BAD_PARAMS', 'tab_id required');
    const ok = await shield.confirm(tabId, 'UBB agent 请求接管此标签页（并入 UBB 分组并受控）', 60000);
    if (!ok) throw err('CLAIM_DENIED', 'user denied the takeover (or tab unreachable)');
    const r = await sessions.attachClaimed(tabId);
    invalidateVisibilityCache(tabId); // fix19: the takeover moved the tab between groups/windows
    await armTab(tabId);
    return r;
  });

  R('tab.release', { category: 'tabs', description: 'Return a claimed tab to the user (removed from the group).' }, async (p) => {
    const tabId = p.tab_id;
    if (typeof tabId !== 'number') throw err('BAD_PARAMS', 'tab_id required');
    const r = await sessions.release(tabId);
    invalidateVisibilityCache(tabId); // fix19: a released tab is nobody's cached document any more
    await shield.disarm(tabId);
    dropPasses(tabId); // a released tab must not keep a pass transaction alive
    return r;
  });

  // ---- navigation -----------------------------------------------------------
  R('navigate', { category: 'navigation', description: 'Navigate the target tab. Auto-prepends https:// when no scheme. The new document is a new visibility answer, so this also drops the pre-dispatch visibility cache entry for the tab (fix19).' }, async (p) => {
    const tabId = targetTab(p);
    const url = normalizeUrl(p.url);
    if (cdp.isRestrictedUrl(url)) throw err('URL_BLOCKED', `blocked URL: ${url}`);
    invalidateVisibilityCache(tabId); // fix19: a navigation replaces every document of the tab
    await chrome.tabs.update(tabId, { url });
    const done = await waitForLoad(tabId, p.timeout_ms || 20000);
    const t = await chrome.tabs.get(tabId);
    return { navigated: true, loaded: done, url: redactUrl(t.url), title: truncate(t.title, 200) };
  });

  async function historyJump(tabId, delta) {
    invalidateVisibilityCache(tabId); // fix19: same-document rule — a history jump commits a new document
    await cdp.ensure(tabId);
    const h = await cdp.send(tabId, 'Page.getNavigationHistory');
    const target = h.currentIndex + delta;
    if (target >= 0 && target < (h.entries?.length || 0)) {
      // chrome.tabs.goBack is a no-op while a debugger is attached on Edge —
      // navigate the history entry directly
      await cdp.send(tabId, 'Page.navigateToHistoryEntry', { entryId: h.entries[target].id });
      await waitForLoad(tabId, 10000);
    }
    return { url: redactUrl((await chrome.tabs.get(tabId)).url) };
  }

  R('go_back', { category: 'navigation', description: 'Step one entry back in the history of the target tab (CDP Page.navigateToHistoryEntry — chrome.tabs.goBack is a no-op while the debugger is attached on Edge). Already at the oldest entry: nothing loads and only the current url comes back. The page changed, so every @eN ref is dead — take a fresh snapshot.' }, async (p) => historyJump(targetTab(p), -1));

  R('go_forward', { category: 'navigation', description: 'Step one entry forward in the history of the target tab (same CDP path as go_back; at the newest entry nothing loads). Returns {url} after the load settles — re-snapshot, the previous @eN refs do not survive the navigation.' }, async (p) => historyJump(targetTab(p), +1));

  R('reload', { category: 'navigation', description: 'Reload the target tab (chrome.tabs.reload) and wait up to 20s for the load event; returns {reloaded:true}. Refs and frame identities from before the reload are invalid — snapshot again. Use it when a page wedged, before navigate when you just want fresh state.' }, async (p) => {
    const tabId = targetTab(p);
    invalidateVisibilityCache(tabId); // fix19: a reload is a new document too
    await chrome.tabs.reload(tabId);
    await waitForLoad(tabId, 20000);
    return { reloaded: true };
  });

  // ---- interaction ------------------------------------------------------------
  R('click', { category: 'interaction', description: `Click an element by @eN ref (or coordinates). Dangerous labels need confirm:true. Returns delivered:true + delivery_ms once the page document itself has recorded the press+release landing on a page element; if the document never admits receiving them the tool fails with INPUT_NOT_DELIVERED instead of pretending success. Visibility rule (fix19): a target document whose visibilityState is NOT "visible" (window minimized or covered by another window — tab.select cannot fix that) is refused BEFORE dispatch with INPUT_NOT_DELIVERED and zero events sent, naming the three real exits (user raises the window / tab.create active:true / @d bridge synthetic click, isTrusted:false). A visible tab pays the delivery-proof wait only (up to ${VISIBLE_WAIT_BUDGET_MS}ms, normally milliseconds).` }, async (p) => {
    const tabId = targetTab(p);
    if (p.selector) {
      const d = await bridge(tabId, 'describeRef', { selector: p.selector }).catch(() => null);
      if (d && DANGEROUS_LABEL.test(d.name || '') && p.confirm !== true) {
        throw err('NEEDS_CONFIRM', `"${d.name}" looks like a destructive/paid action — retry with confirm:true after asking the user`);
      }
      await bridge(tabId, 'clickDom', { selector: p.selector });
      audit.log({ action: 'click', tabId, target: p.selector, via: 'selector' });
      return { clicked: p.selector, via: 'selector' };
    }
    if (typeof p.x === 'number' && typeof p.y === 'number') {
      const clicks = p.double ? 2 : 1;
      const dl = {};
      // fix19: which document receives a bare [x,y] event is unknowable, so the
      // top document's visibility decides (an occluded window hides them all).
      await guardInputVisibility(tabId, { action: 'click', ref: `click@(${p.x},${p.y})` });
      await withPass(tabId, async () => {
        if (await human.isEnabled()) {
          // human.js proves each dispatch it sends itself, and withPass's own
          // opening confirm already covers the walk's first samples — a check
          // here would be a second round trip for the same instant.
          await human.humanClick(tabId, { x: p.x - 6, y: p.y - 6, width: 12, height: 12, cx: p.x, cy: p.y }, { clickCount: clicks, button: p.button || 'left' });
          return;
        }
        // one point confirmation per event: mouse() itself calls
        // assertInputGate before every Input.dispatchMouseEvent, so THIS
        // coordinate is provably clear right now at each send — nothing can
        // re-close the veil between the readback and the event and leave a
        // {clicked:…} for an event the page never received (LIVE-RESULTS #1,
        // and its 2B recurrence).
        await mouse(tabId, 'mouseMoved', p.x, p.y);
        await mouse(tabId, 'mousePressed', p.x, p.y, { clickCount: clicks, button: p.button || 'left' });
        await sleep(30);
        await mouse(tabId, 'mouseReleased', p.x, p.y, { clickCount: clicks, button: p.button || 'left' });
      }, { at: [p.x, p.y], delivery: dl, expect: pointerProof([Math.round(p.x), Math.round(p.y)]) });
      audit.log({ action: 'click', tabId, at: [p.x, p.y], via: 'coords', delivered: dl.delivered === true });
      return {
        clicked: [p.x, p.y],
        via: 'coords',
        delivered: deliveredField(dl),
        delivery_ms: typeof dl.ms === 'number' ? dl.ms : null,
      };
    }
    if (typeof p.ref === 'string' && p.ref.startsWith('@d')) {
      // DOM-fallback ref (from find / dom-fallback snapshot) → real .click()
      const { frameId, domRef } = parseDomRef(p.ref);
      const d = await bridge(tabId, 'describeRef', { ref: domRef }, frameId).catch(() => null);
      if (d && DANGEROUS_LABEL.test(d.name || '') && p.confirm !== true) {
        throw err('NEEDS_CONFIRM', `"${d.name}" looks like a destructive/paid action — retry with confirm:true after asking the user`);
      }
      await bridge(tabId, 'clickDom', { ref: domRef }, frameId);
      audit.log({ action: 'click', tabId, target: p.ref, via: 'dom', frame: frameId || undefined });
      return { clicked: p.ref, via: 'dom' };
    }
    const { nodeId, box, meta } = await resolveRef(tabId, p.ref);
    if (DANGEROUS_LABEL.test(meta?.name || '') && p.confirm !== true) {
      throw err('NEEDS_CONFIRM', `"${meta.name}" looks like a destructive/paid action — retry with confirm:true after asking the user`);
    }
    await guardFrameInputReachable(tabId, p.ref, meta);
    // fix19: the document that would receive this click is the ref's own frame
    // document (0 = top) — ask IT, and refuse before anything goes out.
    await guardInputVisibility(tabId, { action: 'click', ref: p.ref, frameId: meta?.frameId ?? 0 });
    const clicks = p.double ? 2 : 1;
    const humanOn = await human.isEnabled();
    const dl = {};
    const input = withPass(tabId, async () => {
      if (humanOn) {
        // same shape as the coordinate path: human.js confirms every dispatch it
        // sends itself, and withPass's opening confirm already covers the walk
        await human.humanClick(tabId, box, { clickCount: clicks, button: p.button || 'left' });
        return;
      }
      await mouse(tabId, 'mouseMoved', box.cx, box.cy);
      await mouse(tabId, 'mousePressed', box.cx, box.cy, { clickCount: clicks, button: p.button || 'left' });
      await sleep(30);
      await mouse(tabId, 'mouseReleased', box.cx, box.cy, { clickCount: clicks, button: p.button || 'left' });
    }, {
      frameId: meta?.frameId ?? 0,
      at: [box.cx, box.cy],
      delivery: dl,
      expect: pointerProof([Math.round(box.cx), Math.round(box.cy)]),
    });
    // if the click opens a BLOCKING dialog, the input command's ack never
    // returns — race it and report the dialog instead of hanging. A REJECTED
    // input must reject the tool too: the old `input.catch(() => {})` fed a
    // failed SHIELD_PASS_FAILED/CDP error into {clicked:...} (F3-class lie).
    // fix17: that race is also why a delivery wait of a few seconds cannot turn
    // into a hang here — a stalled input with a dialog is reported as the dialog,
    // a stalled input without one is awaited (rejections surface as they always did).
    const raced = await Promise.race([
      input.then(() => 'ok', (e) => ({ e })),
      sleep(3000).then(() => 'stalled'),
    ]);
    if (raced && raced.e) throw raced.e;
    const openDialogs = cdp.buffers(tabId)?.dialogs || [];
    if (raced === 'stalled' && openDialogs.length) {
      audit.log({ action: 'click', tabId, target: meta?.name, dialog: true });
      input.catch(() => {}); // dialog-open is the evidence the click landed; let the straggler settle silently
      return {
        clicked: p.ref,
        target: meta?.name,
        dialog_opened: openDialogs,
        note: 'a JS dialog is blocking the page — answer it with dialog.handle',
      };
    }
    if (raced === 'stalled') await input; // no dialog: wait out the real result (rejections surface)
    audit.log({ action: 'click', tabId, target: meta?.name, delivered: dl.delivered === true });
    return {
      clicked: p.ref,
      at: [Math.round(box.cx), Math.round(box.cy)],
      target: meta?.name,
      delivered: deliveredField(dl),
      delivery_ms: typeof dl.ms === 'number' ? dl.ms : null,
    };
  });

  R('hover', { category: 'interaction', description: 'Move the pointer to the centre of an @eN ref (real CDP mouseMoved; the shield lets the user interrupt during it). Nothing is clicked. JS-driven menus reveal on a background tab; CSS :hover menus need the window visible and focused, and to capture a hover-revealed submenu use snapshot {probe_hover:"@eN"} instead of hover + screenshot. Visibility rule (fix19): the move is a real pointer event, so a target document whose visibilityState is not "visible" is refused BEFORE dispatch (INPUT_NOT_DELIVERED, nothing sent).' }, async (p) => {
    const tabId = targetTab(p);
    const { box, meta } = await resolveRef(tabId, p.ref);
    await guardFrameInputReachable(tabId, p.ref, meta);
    // fix19: a CSS :hover reveal needs a painting document anyway — on a hidden
    // one the mouseMoved never arrives, so say it before the dispatch, not after.
    await guardInputVisibility(tabId, { action: 'hover', ref: p.ref, frameId: meta?.frameId ?? 0 });
    await withPass(tabId, async () => {
      // mouse() re-proves [box.cx, box.cy] before the send (assertInputGate)
      return mouse(tabId, 'mouseMoved', box.cx, box.cy);
    }, {
      frameId: meta?.frameId ?? 0,
      at: [box.cx, box.cy],
    });
    return { hovered: meta?.name || p.ref };
  });

  R('fill', { category: 'interaction', description: `Set the value of a form field (React/Vue-safe native setter). Password/OTP fields are refused. The coordinate path (iframe refs — a real click focuses the control) proves that click with the page-side delivery record and returns delivered:true + delivery_ms; a delivery it cannot see fails with INPUT_NOT_DELIVERED rather than reporting a filled field nobody received. The main-document setter path stays ack-only (Input.insertText is not hit-tested, so the veil cannot eat it) and keeps working on a background tab. Visibility rule (fix19): the COORDINATE path is a real pointer+keyboard burst, so a non-visible target document is refused BEFORE dispatch (INPUT_NOT_DELIVERED, nothing sent); visible documents pay at most the ${VISIBLE_WAIT_BUDGET_MS}ms proof budget, normally milliseconds.` }, async (p) => {
    const tabId = targetTab(p);
    const vaultNames = Array.isArray(p.__ubb_secret_names) ? p.__ubb_secret_names : null; // daemon-stamped ledger (strict origin gate)
    const vaultGate = p.__ubb_secret_gate;
    if (typeof p.ref === 'string' && p.ref.startsWith('@d')) {
      const { frameId, domRef } = parseDomRef(p.ref);
      // field type unknowable here → gate whatever it is; a frame-routed @d ref
      // is gated against that frame's document URL (fall back to top host when unknown)
      if (vaultNames && frameId > 0) {
        await enforceVaultOriginsFrame(tabId, await frameUrlOf(tabId, frameId), vaultNames, { vaultGate });
      } else if (vaultNames) {
        await enforceVaultOrigins(tabId, vaultNames, { vaultGate });
      }
      await bridge(tabId, 'fillDom', { ref: domRef, value: p.value, allowPassword: p.__ubb_secret_fill === true }, frameId);
      audit.log({ action: 'fill', tabId, target: p.ref, via: 'dom', frame: frameId || undefined });
      return { filled: p.ref, via: 'dom' };
    }
    if (p.ref) {
      const { nodeId, meta, box, frame } = await resolveRef(tabId, p.ref);
      if (nodeId == null && meta?.frameId) {
        // frame ref → the coordinate path (reaches same-process frames only;
        // OOPIF targets refuse inside guardFrameInputReachable — no silent ok)
        await guardFrameInputReachable(tabId, p.ref, meta);
        await guardFrameField(tabId, p.ref, meta, frame?.desc, p.__ubb_secret_fill === true, vaultNames, vaultGate);
        // fix19: the coordinate path starts with a REAL click in that frame's
        // document — same rule as click, asked of the same document.
        await guardInputVisibility(tabId, { action: 'fill', ref: p.ref, frameId: meta.frameId });
        const dl = await frameFillInput(tabId, box, p.value, p.press_enter, meta.frameId);
        audit.log({ action: 'fill', tabId, target: meta?.name, frame: meta.frameId, delivered: dl.delivered === true });
        return {
          filled: p.ref,
          via: 'frame-coords',
          at: [Math.round(box.cx), Math.round(box.cy)],
          target: meta?.name,
          // fix17: the coordinate path focuses the control with a REAL click, so
          // that click pair is what has to be seen by the receiving document
          delivered: deliveredField(dl),
          delivery_ms: typeof dl.ms === 'number' ? dl.ms : null,
        };
      }
      await guardSensitiveField(tabId, nodeId, meta, { allowPassword: p.__ubb_secret_fill === true, vaultNames, vaultGate });
      await withPass(tabId, async (gate) => {
        // deterministic REPLACE: synthetic ctrl+A is unreliable on some
        // inputs — select the existing text from page JS instead
        await callOnNode(tabId, refs.get(tabId, p.ref).backendNodeId, selectExistingText.toString());
        if (await human.isEnabled()) {
          await human.humanType(tabId, p.value);
        } else {
          await gate.check(); // raw insertText bypasses mouse()/key() — it proves itself
          await cdp.send(tabId, 'Input.insertText', { text: String(p.value ?? '') });
        }
        if (p.press_enter) {
          await key(tabId, 'keyDown', 'Enter');
          await key(tabId, 'keyUp', 'Enter');
        }
      }, { frameId: meta?.frameId ?? 0, at: [box.cx, box.cy], keys: true });
      audit.log({ action: 'fill', tabId, target: meta?.name });
      return { filled: p.ref, target: meta?.name };
    }
    // DOM-fallback path
    if (vaultNames) await enforceVaultOrigins(tabId, vaultNames, { vaultGate }); // selector → field type unknowable
    const r = await bridge(tabId, 'fillDom', { selector: p.selector, value: p.value, allowPassword: p.__ubb_secret_fill === true });
    return { filled: p.selector || 'selector' };
  });

  R('fill_form', { category: 'interaction', description: 'Batch fill {ref: value}. Sensitive fields are refused individually; iframe refs fill through the coordinate path (real input) and are refused BEFORE dispatch when that frame document is not visible (fix19 INPUT_NOT_DELIVERED, nothing sent) — the main-document setter rows stay ack-only and work on a background tab.' }, async (p) => {
    const tabId = targetTab(p);
    const vaultNames = Array.isArray(p.__ubb_secret_names) ? p.__ubb_secret_names : null;
    const vaultGate = p.__ubb_secret_gate;
    const pairs = Object.entries(p.values || {});
    const done = [];
    for (const [ref, value] of pairs) {
      const { nodeId, meta, box, frame } = await resolveRef(tabId, ref);
      if (nodeId == null && meta?.frameId) {
        await guardFrameInputReachable(tabId, ref, meta);
        await guardFrameField(tabId, ref, meta, frame?.desc, p.__ubb_secret_fill === true, vaultNames, vaultGate);
        // fix19: same coordinate path as fill → same pre-dispatch rule.
        await guardInputVisibility(tabId, { action: 'fill_form', ref, frameId: meta.frameId });
        await frameFillInput(tabId, box, value, false, meta.frameId);
        done.push(ref);
        continue;
      }
      await guardSensitiveField(tabId, nodeId, meta, { allowPassword: p.__ubb_secret_fill === true, vaultNames, vaultGate });
      await withPass(tabId, async (gate) => {
        await gate.check();
        // Replace, not append: fill_form used to focus + insertText, so a
        // prefilled field ended up "old" + "new". Selecting through the
        // node's own object also works inside shadow roots.
        if (meta?.backendNodeId != null) {
          await callOnNode(tabId, meta.backendNodeId, selectExistingText.toString());
        } else {
          await cdp.send(tabId, 'DOM.focus', { nodeId });
        }
        await gate.check();
        await cdp.send(tabId, 'Input.insertText', { text: String(value) });
      }, { frameId: meta?.frameId ?? 0, at: [box.cx, box.cy], keys: true });
      done.push(ref);
    }
    return { filled: done };
  });

  R('type', { category: 'interaction', description: 'Type text into the currently focused element (optionally press Enter). Password/OTP-focused fields are refused — use secret.fill or fill. Visibility rule (fix19): this is a real keyboard burst, so a focused document whose visibilityState is not "visible" is refused BEFORE dispatch (INPUT_NOT_DELIVERED, nothing sent).' }, async (p) => {
    const tabId = targetTab(p);
    // `type` had no target semantics, so a password/OTP box that happened to
    // hold focus received plaintext. The focused element is knowable through
    // CDP; refuse it exactly like fill does.
    const focused = await focusedNodeId(tabId).catch(() => null);
    if (focused != null) await guardSensitiveField(tabId, focused, {}, {});
    // the focused element is unknowable here — a vault value may have landed
    // on a password field, so the origin gate runs for `type` whatever it hits
    if (Array.isArray(p.__ubb_secret_names)) await enforceVaultOrigins(tabId, p.__ubb_secret_names, { vaultGate: p.__ubb_secret_gate });
    // which frame holds focus is unknowable here, so this pass transaction
    // covers every frame of the tab (an action that DOES name its frame opens
    // only that one — see passFramesFor)
    // fix19: focus lives in ONE document and a hidden document does not drain its
    // keyboard queue — the tab's top document decides (frameId 0).
    await guardInputVisibility(tabId, { action: 'type', ref: p.ref || null });
    await withPass(tabId, async (gate) => {
      if (await human.isEnabled()) {
        await human.humanType(tabId, p.text);
      } else {
        await gate.check(); // raw insertText is its own dispatch: prove it before sending
        await cdp.send(tabId, 'Input.insertText', { text: String(p.text ?? '') });
      }
      if (p.press_enter) {
        await key(tabId, 'keyDown', 'Enter');
        await key(tabId, 'keyUp', 'Enter');
      }
    }, { keys: true });
    return { typed: true };
  });

  R('press_key', { category: 'interaction', description: 'Press a key with optional modifiers, e.g. key:"s" modifiers:["ctrl"]. Visibility rule (fix19): a key event for a document whose visibilityState is not "visible" is refused BEFORE dispatch (INPUT_NOT_DELIVERED, nothing sent) — the hidden keyboard queue never drains into the page.' }, async (p) => {
    const tabId = targetTab(p);
    if (!p.key) throw err('BAD_PARAMS', 'key required');
    const mods = modifierBits(p.modifiers);
    // fix19: same rule as type — a real key event for a hidden document is never
    // delivered, and waiting the proof budget out does not create a delivery.
    await guardInputVisibility(tabId, { action: 'press_key', ref: p.ref || null });
    await withPass(tabId, async () => {
      // key() re-proves the transaction's point before both sends (assertInputGate)
      await key(tabId, 'keyDown', p.key, { modifiers: mods });
      await key(tabId, 'keyUp', p.key, { modifiers: mods });
    }, { keys: true });
    return { pressed: p.key, modifiers: p.modifiers || [] };
  });

  R('scroll', { category: 'interaction', description: 'Scroll page or element. direction up|down, amount in px (default 600). Provide ref to scroll an element into view instead. The page-JS scrollBy path works on a background tab; the CDP wheel FALLBACK (only used when scrollY did not move) is a real pointer event, so it is refused BEFORE dispatch when the document is not visible (fix19 INPUT_NOT_DELIVERED, nothing sent).' }, async (p) => {
    const tabId = targetTab(p);
    if (p.ref) {
      await resolveRef(tabId, p.ref); // includes scrollIntoViewIfNeeded
      return { scrolled_to: p.ref };
    }
    const dir = p.direction === 'up' ? -1 : 1;
    const amount = p.amount || 600;
    // primary: page-JS scrollBy (deterministic, no debugger quirks)
    const before = await evalJs(tabId, 'window.scrollY').catch(() => 0);
    await evalJs(tabId, `window.scrollBy(0, ${dir * amount})`).catch(() => {});
    await sleep(120);
    let after = await evalJs(tabId, 'window.scrollY').catch(() => before);
    if (after === before) {
      // fallback: CDP wheel (some pages need native wheel to reveal overlays)
      // fix19: the wheel is a real pointer event, so the pre-dispatch visibility
      // rule applies — and it OUTSIDE the try{} below, because a refusal here
      // must reach the agent instead of being swallowed into a silent {scrolled:0}.
      await guardInputVisibility(tabId, { action: 'scroll', ref: 'scroll 的 wheel 兜底（页内 scrollBy 没有让页面移动）' });
      try {
        if (await human.isEnabled()) {
          await withPass(tabId, async () => {
            // humanScrollChunks proves every wheel chunk it sends (assertInputGate)
            return human.humanScrollChunks(tabId, dir, dir * amount);
          }, { at: [400, 400] });
        } else {
        await withPass(
          tabId,
          async (gate) => {
            await gate.check();
            return cdp.send(tabId, 'Input.dispatchMouseEvent', {
              type: 'mouseWheel',
              x: 400,
              y: 400,
              deltaX: 0,
              deltaY: dir * amount,
            });
          },
          { at: [400, 400] },
        );
        }
        await sleep(120);
        after = await evalJs(tabId, 'window.scrollY').catch(() => after);
      } catch {}
    }
    return { scrolled: after - before, scrolled_to: after };
  });

  R('drag', { category: 'interaction', description: `Drag from ref/coords \`from\` to ref/coords \`to\` in 10 interpolated steps. Returns delivered:true + delivery_ms once the document has recorded the press at the start point and the release at the end point (intermediate moves are not required — a browser coalesces them); no such record → INPUT_NOT_DELIVERED, never a silent {dragged:true}. Visibility rule (fix19): every document this drag would touch is asked for its visibilityState first, and a non-visible one is refused BEFORE dispatch (zero events sent, three real exits named) instead of burning ${VISIBLE_WAIT_BUDGET_MS}ms of proof on a queue that never drains; a visible tab pays milliseconds.` }, async (p) => {
    const tabId = targetTab(p);
    const pt = async (t) => {
      if (t.ref) {
        const r = await resolveRef(tabId, t.ref);
        await guardFrameInputReachable(tabId, t.ref, r.meta);
        return { ...r.box, frameId: r.meta?.frameId ?? 0 };
      }
      if (typeof t.x === 'number' && typeof t.y === 'number') {
        return { cx: t.x, cy: t.y, frameId: 0 };
      }
      throw err('BAD_PARAMS', 'from/to need ref or x/y');
    };
    const a = await pt(p.from || {});
    const b = await pt(p.to || {});
    const dl = {};
    // fix19: a drag presses in ONE document and releases in another when the
    // endpoints live in different frames — every document it would touch has to
    // be able to receive, so each is asked (cached, so 5 actions ≠ 5 round trips).
    for (const fid of [...new Set([a.frameId, b.frameId])]) {
      await guardInputVisibility(tabId, { action: 'drag', ref: `${JSON.stringify(p.from || {})} → ${JSON.stringify(p.to || {})}`, frameId: fid });
    }
    await withPass(tabId, async (gate) => {
      // A travelling action confirms the coordinate it is ABOUT to use: mouse()
      // calls assertInputGate itself and the gate re-reads txn.at on every
      // check, and gate.at aliases that very array (shield-ctl makeGate) — so
      // re-anchoring it here keeps one confirmation per dispatch instead of
      // the old check-then-send double round-trip.
      gate.at[0] = a.cx;
      gate.at[1] = a.cy;
      await mouse(tabId, 'mousePressed', a.cx, a.cy);
      const hum = await human.isEnabled();
      const steps = hum ? 14 : 10;
      for (let i = 1; i <= steps; i++) {
        const x = a.cx + ((b.cx - a.cx) * i) / steps + (hum ? (Math.random() - 0.5) * 4 : 0);
        const y = a.cy + ((b.cy - a.cy) * i) / steps + (hum ? (Math.random() - 0.5) * 4 : 0);
        gate.at[0] = x;
        gate.at[1] = y;
        await mouse(tabId, 'mouseMoved', x, y, { buttons: 1 });
        await sleep(hum ? 14 + Math.round(Math.random() * 18) : 16);
      }
      await sleep(hum ? 40 : 0);
      gate.at[0] = b.cx;
      gate.at[1] = b.cy;
      await mouse(tabId, 'mouseReleased', b.cx, b.cy);
    }, {
      at: [a.cx, a.cy],
      delivery: dl,
      // fix17: a drag is proven by the press at the START point and the release
      // at the END point both being recorded by the document; the intermediate
      // moves are deliberately NOT required (a browser coalesces/suppresses
      // mouseMoved, and a dropped sample is not a failed drag).
      expect: pointerProof([Math.round(a.cx), Math.round(a.cy)], [Math.round(b.cx), Math.round(b.cy)]),
    });
    return { dragged: true, delivered: deliveredField(dl), delivery_ms: typeof dl.ms === 'number' ? dl.ms : null };
  });

  R('upload_file', { category: 'interaction', description: 'Set local files on a file input by @eN ref. Main-frame (or CDP-reachable) nodes only — an OOPIF file input cannot be set from MV3: use the coordinate path to click it and let the user pick the file.' }, async (p) => {
    const tabId = targetTab(p);
    const files = (Array.isArray(p.files) ? p.files : [p.file]).filter(Boolean);
    if (!files.length) throw err('BAD_PARAMS', 'files required');
    const { nodeId, meta } = await resolveRef(tabId, p.ref);
    if (nodeId == null && meta?.frameId) {
      throw err(
        'FRAME_UNSUPPORTED',
        `${p.ref} is a file input inside an iframe — DOM.setFileInputFiles needs a CDP node the page session does not have for that frame; click() it and let the user choose, or run on a same-origin top-level page`,
      );
    }
    await cdp.send(tabId, 'DOM.setFileInputFiles', { nodeId, files });
    audit.log({ action: 'upload_file', tabId, files: files.map((f) => String(f).split(/[\\/]/).pop()) });
    return { uploaded: files.length };
  });

  R('download', { category: 'interaction', description: 'Download a URL (or the href behind an @eN ref) via chrome.downloads. The record this writes into download.list is attributed to the tab you targeted (tab_id_source:"explicit") — the one attribution that is guaranteed, unlike a page-click download the browser reports with no tab at all.' }, async (p) => {
    const tabId = targetTab(p);
    let url = p.url;
    if (!url && p.ref) {
      const { nodeId, meta, frame } = await resolveRef(tabId, p.ref);
      if (nodeId == null && meta?.frameId) url = frame?.desc?.attributes?.href || frame?.desc?.attributes?.src;
      else {
        const a = await attrsOf(tabId, nodeId);
        url = a.href || a.src;
      }
    }
    if (!url) throw err('BAD_PARAMS', 'url (or a ref with href/src) required');
    const id = await chrome.downloads.download({ url, saveAs: false });
    // chrome.downloads.download() answers with an id only, and the onCreated
    // DownloadItem that follows carries no tabId — so hand the tab we already
    // know to the ledger here, or download.list can never attribute this one.
    downloadLedger.claim(id, tabId);
    return { download_id: id, url: redactUrl(url), tab_id: tabId, tab_id_source: 'explicit' };
  });

  // ---- sensing ---------------------------------------------------------------
  R('snapshot', { category: 'sensing', description: 'Accessibility-tree snapshot with @eN refs (filter: interactive|all, max_chars). Pagination: pass next_cursor from a previous result to read more of the SAME capture. probe_hover: "@eN" of a collapsed submenu trigger — hovers it first, then captures the revealed menu. Note: the browser window must be visible/focused for CSS :hover menus to reveal (Chromium skips hover updates for occluded windows); JS-driven menus reveal regardless. Child iframes are appended as indented "# frame[N] url · cross-origin/same-origin" sections with their own @eN refs (bridge-quality labels, coordinate-path actions) — suppress with frames:false.' }, async (p = {}) => {
    const tabId = targetTab(p);
    if (p.probe_hover) {
      const { box, meta } = await resolveRef(tabId, p.probe_hover);
      await guardFrameInputReachable(tabId, p.probe_hover, meta);
      await withPass(tabId, async (gate) => {
        // two-step move: guarantees enter/leave fire even when the pointer
        // already sits over the target from an earlier action. mouse() confirms
        // the point it is about to dispatch at (gate.at aliases txn.at), so the
        // two-step needs no separate gate.check per leg.
        gate.at[0] = 1;
        gate.at[1] = 1;
        await mouse(tabId, 'mouseMoved', 1, 1);
        await sleep(60);
        gate.at[0] = box.cx;
        gate.at[1] = box.cy;
        await mouse(tabId, 'mouseMoved', box.cx, box.cy);
      }, { frameId: meta?.frameId ?? 0, at: [box.cx, box.cy] });
      await sleep(250);
      audit.log({ action: 'snapshot.probe_hover', tabId, target: meta?.name || p.probe_hover });
    }
    const r = await takeSnapshot(tabId, {
      filter: p.filter || 'interactive',
      max_chars: p.max_chars || 60000,
      cursor: p.cursor,
      frames: p.frames !== false,
    });
    audit.log({ action: 'snapshot', tabId, refs: r.ref_count, page: p.cursor ? 'continuation' : 'fresh' });
    return r;
  });

  R('read_page', { category: 'sensing', description: 'Main-content plain text extraction (article/main heuristics). frame_id: the extension frame id shown by snapshot frame[N] headers (cross-origin reachable); frame_path: same-origin child indices from the routed frame (reaches srcdoc/about:blank frames the bridge cannot live in).' }, async (p = {}) => {
    const tabId = targetTab(p);
    const { frameId, framePath } = frameParams(p);
    const r = await bridge(tabId, 'getPageText', { max_chars: p.max_chars || 50000, framePath }, frameId);
    return { text: truncate(r.text, p.max_chars || 50000), url: redactUrl(r.url), title: truncate(r.title, 200), frame_id: frameId };
  });

  R('extract', { category: 'sensing', description: 'Extract a loaded table/list as structured JSON (format:"csv" adds a csv string; csv_safe prefixes formula-like cells for untrusted spreadsheet imports). Table mode: {selector?} over <table> elements. List mode: {item_selector, fields:[{key, selector, read: text|href|attribute, attribute?}], ":scope" reads the item itself}. Bounds: 500 rows / 100 columns / 1 MiB. Reads loaded DOM only — check coverage.truncated and warnings; completeness is never assumed. Pass frame_id (the frame[N] id from snapshot) or frame_path (same-origin child indices) to read tables inside an iframe instead of the top document.' }, async (p = {}) => {
    const tabId = targetTab(p);
    const { frameId, framePath } = frameParams(p);
    const r = await bridge(tabId, 'extractData', {
      selector: p.selector,
      item_selector: p.item_selector,
      fields: p.fields,
      max_rows: Math.min(Math.max(p.max_rows || 500, 1), 5000),
      max_columns: Math.min(Math.max(p.max_columns || 100, 1), 500),
      max_bytes: Math.min(Math.max(p.max_bytes || 1048576, 1024), 8 * 1048576),
      framePath,
    }, frameId);
    audit.log({ action: 'extract', tabId, mode: r.mode, frame: frameId || undefined });
    if (p.format === 'csv') return { ...r, csv: toCsv(r, p.csv_safe === true) };
    return r;
  });

  R('read_site', { category: 'sensing', description: 'Site-aware page extraction: github / zhihu / juejin / mp.weixin.qq.com / xiaohongshu / x.com get structured text with images referenced inline as {{IMG_N}} markers plus an images[] list (and videos[] where the site has them); every other site falls back to generic content extraction.' }, async (p = {}) => {
    const tabId = targetTab(p);
    const r = await bridge(tabId, 'extractSite', { max_chars: p.max_chars || 50000 });
    audit.log({ action: 'read_site', tabId, site: r.site });
    return { ...r, url: redactUrl(r.url), text: truncate(r.text, p.max_chars || 50000) };
  });

  R('record_start', { category: 'capture', description: 'Start recording USER actions on the target tab (click / input / select / keypress / scroll / drag / navigation) into a semantic trace for replay or documentation. Password fields are masked as ***. The trace survives same-tab navigation; hard cap 10 minutes; stop with record_stop. Never record banking, SSO or password-manager pages.' }, async (p = {}) => {
    const tabId = targetTab(p);
    const r = await bridge(tabId, 'recordStart', { description: p.description });
    audit.log({ action: 'record_start', tabId, id: r.id });
    return r;
  });

  R('record_status', { category: 'capture', description: 'Recording state on the tab (active, event count, elapsed).' }, async (p = {}) => {
    const tabId = targetTab(p);
    return bridge(tabId, 'recordStatus', {});
  });

  R('record_stop', { category: 'capture', description: 'Stop the recording and return the semantic trace: {events, snapshots, duration_ms, urls}. The trace is data, not authorization; replay uses semantic targets in order.' }, async (p = {}) => {
    const tabId = targetTab(p);
    const r = await bridge(tabId, 'recordStop', {});
    audit.log({ action: 'record_stop', tabId, id: r.id, events: r.event_count });
    return r;
  });

  R('request_help', { category: 'session', sensitive: false, description: 'Ask the human to complete an in-page step (login / CAPTCHA / OTP / consent / payment). Shows a non-blocking banner and brings the tab to front (opt out with bring_to_front:false); the page stays fully usable by the user. Completes when ALL conditions hold (max 8: url_contains | url_matches | text_present | element_visible) or the user clicks 完成. Outcomes: completed | cancelled | timed_out | aborted. After cancelled/timed_out, do not repeat the same request.' }, async (p, ctx) => {
    const tabId = targetTab(p);
    const prompt = String(p.prompt || '').trim();
    if (!prompt) throw err('BAD_PARAMS', 'prompt required');
    if (prompt.length > 300) throw err('BAD_PARAMS', 'prompt too long (max 300 chars)');
    const conds = (Array.isArray(p.conditions) ? p.conditions : []).map((c, i) => {
      const kind = c && (c.url_contains != null ? 'url_contains'
        : c.url_matches != null ? 'url_matches'
        : c.text_present != null ? 'text_present'
        : c.element_visible != null ? 'element_visible' : null);
      if (!kind) throw err('BAD_PARAMS', `condition ${i}: need exactly one of url_contains/url_matches/text_present/element_visible`);
      const value = String(c[kind]);
      if (!value) throw err('BAD_PARAMS', `condition ${i}: empty value`);
      if (value.length > 256) throw err('BAD_PARAMS', `condition ${i}: value too long (max 256 chars)`);
      if (kind === 'url_matches') {
        if (value.length > 128) throw err('BAD_PARAMS', `condition ${i}: regex too long (max 128 chars)`);
        try { new RegExp(value); } catch (e) { throw err('BAD_PARAMS', `condition ${i}: invalid regex (${e?.message || e})`); }
      }
      return { kind, value };
    });
    if (conds.length > 8) throw err('BAD_PARAMS', 'at most 8 conditions');
    const timeoutMs = Math.min(Math.max(p.timeout_ms || 120000, 5000), 300000);
    const res = await runHelp(tabId, prompt, conds, timeoutMs, ctx, p.bring_to_front !== false);
    audit.log({ action: 'request_help', tabId, outcome: res.outcome });
    return res;
  });

  R('get_html', { category: 'sensing', description: 'Raw document.documentElement.outerHTML of the TOP frame, truncated to max_chars (default 100000). Whole-document dump — no selector, no iframe content, and it is heavy on tokens; prefer read_page/extract for data and snapshot for anything you will act on. Runs through evalJs, so a JS dialog waiting on the page gets accepted on the way in.' }, async (p = {}) => {
    const tabId = targetTab(p);
    await cdp.ensure(tabId);
    const html = await evalJs(tabId, 'document.documentElement.outerHTML');
    return { html: truncate(html, p.max_chars || 100000) };
  });

  R('find', { category: 'sensing', description: 'Keyword search over visible elements; returns matches with @eN refs where possible. frame_id/frame_path search inside iframes — refs then look like @d<frameId>.<n> and stay routed to that frame.' }, async (p = {}) => {
    const tabId = targetTab(p);
    const { frameId, framePath } = frameParams(p);
    const r = await bridge(tabId, 'search', { query: p.query, limit: p.limit || 10, framePath }, frameId).catch(() => null);
    if (!r) {
      const snap = await takeSnapshot(tabId, { filter: 'all', max_chars: 200000 });
      const lines = snap.text.split('\n').filter((l) => l.toLowerCase().includes(String(p.query || '').toLowerCase()));
      return { matches: lines.slice(0, p.limit || 10).map((l) => ({ line: l.trim() })), source: 'snapshot' };
    }
    const matches = (r.matches || []).map((m) => ({
      ...m,
      ref: m.ref && frameId ? `@d${frameId}.${m.ref.slice(2)}` : m.ref,
    }));
    return { matches, source: 'dom' };
  });

  R('evaluate', { category: 'sensing', sensitive: true, description: 'Run JS in the page. world: main|isolated. Last expression value returned (redacted, truncated). MAIN-world runs require confirm:true.' }, async (p) => {
    const tabId = targetTab(p);
    if (!p.expression) throw err('BAD_PARAMS', 'expression required');
    if ((p.world || 'main') === 'main' && p.confirm !== true) {
      throw err('NEEDS_CONFIRM', 'MAIN-world evaluation is powerful; retry with confirm:true once you have decided this is necessary');
    }
    await cdp.ensure(tabId);
    const v = await evalJs(tabId, p.expression, { world: p.world || 'main' });
    audit.log({ action: 'evaluate', tabId, world: p.world || 'main' });
    let out;
    if (typeof v === 'string') out = truncate(v, 60000);
    else out = redact(v);
    return { value: out };
  });

  R('wait_for', { category: 'sensing', description: 'Wait for a condition: text_present|text_gone|element_visible|element_hidden|url_contains|url_matches|navigation|network_idle|timeout (ms). Honors agent cancel. A page read that FAILED is never treated as a satisfied condition — WAIT_TIMEOUT then names the last read error.' }, async (p, ctx) => {
    const tabId = targetTab(p);
    const kind = p.condition || 'timeout';
    const timeout = p.timeout_ms || 15000;
    const t0 = Date.now();
    let lastReadError = '';
    // fix5 §F3 sweep: `catch(() => false)` fed into a `!` was a false POSITIVE —
    // element_hidden answered {ok:true} for a document that could not be read at
    // all. null = "no answer", and no answer satisfies anything.
    const read = async (fn) => {
      try {
        return await fn();
      } catch (e) {
        lastReadError = String(e?.message || e).slice(0, 160);
        return null;
      }
    };
    // `navigation` means "the document changes from NOW" — the old check only
    // looked at readyState, so an already-loaded page answered instantly and a
    // caller waiting to observe a click-through never actually waited.
    let navBase = null;
    if (kind === 'navigation') {
      await cdp.ensure(tabId).catch(() => {});
      navBase = {
        gen: cdp.buffers(tabId)?.gen ?? 0,
        url: await chrome.tabs.get(tabId).then((t) => t.url || '').catch(() => ''),
      };
    }
    const check = async () => {
      switch (kind) {
        case 'timeout': return true;
        case 'text_present': return (await read(() => evalJs(tabId, `document.body.innerText.includes(${JSON.stringify(p.text||'')})`))) === true;
        case 'text_gone': return (await read(() => evalJs(tabId, `document.body.innerText.includes(${JSON.stringify(p.text||'')})`))) === false;
        case 'element_visible': return (await read(() => evalJs(tabId, visibleExpr(p.selector)))) === true;
        case 'element_hidden': return (await read(() => evalJs(tabId, visibleExpr(p.selector)))) === false;
        case 'url_contains': return (await chrome.tabs.get(tabId)).url.includes(p.value || '');
        case 'url_matches': return new RegExp(p.value || '').test((await chrome.tabs.get(tabId)).url);
        case 'navigation': {
          const b = cdp.buffers(tabId);
          const url = await chrome.tabs.get(tabId).then((t) => t.url || '').catch(() => '');
          const changed = (b?.gen ?? 0) !== navBase.gen || url !== navBase.url;
          if (!changed) return false;
          const st = await read(() => evalJs(tabId, 'document.readyState + " " + location.protocol'));
          return st === 'complete http:' || st === 'complete https:';
        }
        case 'network_idle': {
          const b = cdp.buffers(tabId);
          if (!b) return false;
          const now = Date.now();
          // WebSocket/EventSource never "finish"; they are not idleness debt.
          // Everything else must both be quiet recently AND have no request
          // still in flight — five recent timestamps missed a slow request.
          const persistent = (r) => r.type === 'WebSocket' || r.type === 'EventSource';
          const recent = b.net.some((r) => !persistent(r) && now - r.t < 800);
          const pending = b.net.some((r) => !persistent(r) && !r.finished && !r.error && now - r.t < 60000);
          return !recent && !pending;
        }
        default: throw err('BAD_PARAMS', `unknown condition "${kind}"`);
      }
    };
    if (kind === 'timeout') {
      // a bare sleep here used to ignore agent cancel — poll like every other condition
      const until = t0 + Math.min(p.timeout_ms || 1000, 60000);
      while (Date.now() < until) {
        if (ctx?.signal?.aborted) throw err('CANCELLED', 'cancelled by agent');
        await sleep(Math.min(250, Math.max(1, until - Date.now())));
      }
      return { ok: true, waited_ms: p.timeout_ms || 1000 };
    }
    while (Date.now() - t0 < timeout) {
      if (ctx?.signal?.aborted) throw err('CANCELLED', 'cancelled by agent');
      if (await check()) return { ok: true, condition: kind, waited_ms: Date.now() - t0 };
      await sleep(300);
    }
    throw err('WAIT_TIMEOUT', `condition "${kind}" not met within ${timeout}ms${lastReadError ? ` — every page read failed, so nothing was ever observed (last error: ${lastReadError})` : ''}`);
  });

  // ---- console & network -------------------------------------------------------
  R('console.list', { category: 'diagnostics', description: 'Console messages the extension buffered for this tab since the debugger attached (it is NOT browser history — nothing from before you attached). Filters: only_errors, pattern (case-insensitive regex over the text), limit (default 50, newest kept), clear:true empties the buffer. Each line is {type, text} truncated to 2000 chars.' }, async (p = {}) => {
    const tabId = targetTab(p);
    await cdp.ensure(tabId);
    const b = cdp.buffers(tabId);
    let list = b ? b.console : [];
    if (p.only_errors) list = list.filter((c) => c.type === 'error');
    if (p.pattern) list = list.filter((c) => new RegExp(p.pattern, 'i').test(c.text));
    if (p.clear && b) b.console = [];
    return { messages: list.slice(-(p.limit || 50)).map((c) => ({ type: c.type, text: truncate(c.text, 2000) })) };
  });

  R('network.list', { category: 'diagnostics', description: 'Network requests buffered for this tab since attach, newest first: {request_id, method, url (redacted), status, mime, error}. url_pattern is a case-insensitive regex; limit default 50; clear:true empties the buffer. Bodies are not here — take a request_id to network.get (only responses that finished in the current navigation have one).' }, async (p = {}) => {
    const tabId = targetTab(p);
    await cdp.ensure(tabId);
    const b = cdp.buffers(tabId);
    let list = b ? [...b.net] : [];
    if (p.url_pattern) list = list.filter((r) => new RegExp(p.url_pattern, 'i').test(r.url || ''));
    if (p.clear && b) b.net = [];
    return {
      requests: list.slice(-(p.limit || 50)).reverse().map((r) => ({
        request_id: r.requestId,
        method: r.method,
        url: redactUrl(r.url),
        status: r.status,
        mime: r.mime,
        error: r.error,
      })),
    };
  });

  R('network.get', { category: 'diagnostics', description: 'Get response body for a captured request_id (from network.list).' }, async (p) => {
    const tabId = targetTab(p);
    if (!p.request_id) throw err('BAD_PARAMS', 'request_id required');
    const r = await cdp.send(tabId, 'Network.getResponseBody', { requestId: p.request_id }).catch(() => null);
    if (!r) throw err('BODY_UNAVAILABLE', 'no body captured for this request (only finished responses, same navigation)');
    const text = r.base64Encoded ? `[${Math.round(r.body.length * 0.75 / 1024)}KB base64]` : truncate(r.body, 50000);
    return { body: redact(text), base64: !!r.base64Encoded };
  });

  // ---- screenshots ----------------------------------------------------------------
  R('screenshot', { category: 'capture', timeoutMs: SCREENSHOT_TOOL_TIMEOUT_MS, description: 'Screenshot: viewport (default), element by ref, or full_page. format png|jpeg, quality 1-100. Shield is hidden during capture.' }, async (p = {}) => {
    const tabId = targetTab(p);
    await cdp.ensure(tabId);
    const format = p.format === 'jpeg' ? 'jpeg' : 'png';
    const quality = Math.min(Math.max(p.quality || 70, 1), 100);
    return withHiddenShield(tabId, async () => {
      let clip;
      if (p.ref) {
        const { box } = await resolveRef(tabId, p.ref);
        clip = { x: box.x, y: box.y, width: box.width, height: box.height, scale: 1 };
      }
      if (p.full_page) {
        const m = await cdp.send(tabId, 'Page.getLayoutMetrics');
        const cs = m.cssContentSize || m.contentSize;
        const prev = cdp.buffers(tabId)?.emulation || null;
        await cdp.send(tabId, 'Emulation.setDeviceMetricsOverride', {
          width: Math.ceil(cs.width), height: Math.ceil(cs.height), deviceScaleFactor: 1, mobile: false,
        });
        await sleep(120);
        try {
          const shot = await cdp.send(tabId, 'Page.captureScreenshot', { format, quality, captureBeyondViewport: true });
          return pack(shot, format, { full_page: true, width: Math.ceil(cs.width), height: Math.ceil(cs.height) });
        } finally {
          // clear would silently discard a caller's mobile/width emulation and
          // reflow the page after the screenshot
          if (prev) await cdp.send(tabId, 'Emulation.setDeviceMetricsOverride', prev).catch(() => {});
          else await cdp.send(tabId, 'Emulation.clearDeviceMetricsOverride').catch(() => {});
        }
      }
      const shot = await cdp.send(tabId, 'Page.captureScreenshot', { format, quality, ...(clip ? { clip } : {}) });
      return pack(shot, format, clip ? { ref: p.ref } : { viewport: true });
    });
  });

  // ---- dialogs --------------------------------------------------------------------
  R('dialog.status', { category: 'diagnostics', description: 'The JS dialogs (alert/confirm/prompt/beforeunload) waiting on the target tab right now, as {open:[…]}. A non-empty list means the renderer is wedged: no other page command will answer until dialog.handle replies. Only dialog.handle answers confirm/prompt/beforeunload; page-JS reads return DIALOG_OPEN and leave the dialog open. Plain alerts are auto-accepted by the event pump (they carry no decision).' }, async (p) => {
    const tabId = targetTab(p);
    const b = cdp.buffers(tabId);
    return { open: b ? b.dialogs : [] };
  });

  R('dialog.handle', { category: 'diagnostics', description: 'Answer the oldest dialog reported by dialog.status: accept defaults to true (a prompt gets prompt_text back), accept:false dismisses. Returns {handled:{type,text}} or {handled:false, note:\"no open dialog\"} when nothing is waiting. Sent straight to CDP, bypassing the per-tab queue, because a modal dialog stops queued commands from ever running.' }, async (p) => {
    const tabId = targetTab(p);
    const b = cdp.buffers(tabId);
    if (!b || !b.dialogs.length) return { handled: false, note: 'no open dialog' };
    const dlg = b.dialogs.shift();
    // DIRECT send, bypassing the per-tab queue: a modal dialog wedges the
    // renderer mid-command, so queued CDP calls (including this one) would
    // never run. The alert auto-accept path proved direct sends work.
    await chrome.debugger.sendCommand(
      { tabId },
      'Page.handleJavaScriptDialog',
      { accept: p.accept !== false, promptText: p.prompt_text },
    );
    return { handled: dlg };
  });

  R('resize_window', { category: 'tabs', description: 'Resize the window of the target tab (400x300 .. 7680x4320).' }, async (p) => {
    const tabId = targetTab(p);
    const w = Math.min(Math.max(p.width || 1280, 400), 7680);
    const h = Math.min(Math.max(p.height || 800, 300), 4320);
    const tab = await chrome.tabs.get(tabId);
    await chrome.windows.update(tab.windowId, { width: w, height: h });
    return { resized: [w, h] };
  });

  R('window.minimize', { category: 'tabs', description: 'Minimize the OS window that holds the target tab (screenshots, extraction, console/network and the bridge paths keep working; trusted POINTER/KEYBOARD input does not — a minimized or occluded window is visibilityState:"hidden" and those actions are refused with INPUT_NOT_DELIVERED before anything is dispatched). Cost: a minimized window stops repainting, so live screencast frames go still and CSS :hover state stops updating — window.restore before any visual check.' }, async (p) => {
    const tabId = targetTab(p);
    const tab = await chrome.tabs.get(tabId);
    await chrome.windows.update(tab.windowId, { state: 'minimized' });
    invalidateVisibilityCache(tabId); // fix19: the window state IS the visibility answer
    return { minimized: true };
  });

  R('window.restore', { category: 'tabs', description: 'Put the window of the target tab back to normal state and focus it (the counterpart of window.minimize; a maximized window comes back as normal). Do this before hover menus, live screencast or lazy-load-heavy extraction — those need a painting window. Honest limit (fix19): restoring does NOT guarantee visibilityState becomes "visible" — if another window still covers this one the tab stays hidden and trusted input is still refused; only the user bringing it to the front fixes that. Check with tab.select, whose answer says which case you are in.' }, async (p) => {
    const tabId = targetTab(p);
    const tab = await chrome.tabs.get(tabId);
    await chrome.windows.update(tab.windowId, { state: 'normal', focused: true });
    invalidateVisibilityCache(tabId); // fix19: never act on the pre-minimize answer
    return { restored: true };
  });

  R('session.name', { category: 'session', description: 'Name the current session (shown in the tab-group title).' }, async (p) => {
    const s = sessions.active();
    if (!s) throw err('NO_SESSION', 'no active session');
    s.name = String(p.name || '').slice(0, 40);
    await sessions.setStatus('running');
    await sessions.persist();
    return { named: s.name };
  });

  R('history.list', { category: 'diagnostics', description: 'Browser history search (URLs redacted). Empty query lists recent pages (falls back to matching any http URL — Edge returns nothing for empty text).' }, async (p = {}) => {
    const items = await chrome.history.search({
      text: p.query || 'http',
      maxResults: Math.min(p.limit || 20, 100),
      ...(p.since_hours ? { startTime: Date.now() - p.since_hours * 3600e3 } : {}),
    });
    return { items: items.map((i) => ({ title: truncate(i.title, 100), url: redactUrl(i.url), last_visit: new Date(i.lastVisitTime).toISOString() })) };
  });

  // ---- emulation -------------------------------------------------------------------
  R('emulate', { category: 'emulation', description: 'Emulate viewport {width,height}, user_agent, media (print|screen|dark), geolocation {lat,lng}, network preset (offline|slow3g|fast3g|none — none CLEARS the override), cpu_throttle (multiplier). An unknown preset name is refused, and a rejected CDP override throws: {emulated:[…]} only ever lists what the browser actually accepted.' }, async (p) => {
    const tabId = targetTab(p);
    await cdp.ensure(tabId);
    if (p.viewport) {
      const override = { width: p.viewport.width || 1280, height: p.viewport.height || 800, deviceScaleFactor: 1, mobile: !!p.viewport.mobile };
      await cdp.send(tabId, 'Emulation.setDeviceMetricsOverride', override);
      const b = cdp.buffers(tabId);
      if (b) b.emulation = override;
    }
    if (p.user_agent) await cdp.send(tabId, 'Emulation.setUserAgentOverride', { userAgent: p.user_agent });
    if (p.media) await cdp.send(tabId, 'Emulation.setEmulatedMedia', { media: p.media });
    if (p.geolocation) await cdp.send(tabId, 'Emulation.setGeolocationOverride', { latitude: p.geolocation.lat, longitude: p.geolocation.lng, accuracy: 100 });
    if (p.network) {
      const presets = {
        offline: { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 },
        slow3g: { latency: 400, downloadThroughput: 50 * 1024, uploadThroughput: 20 * 1024 },
        fast3g: { latency: 150, downloadThroughput: 180 * 1024, uploadThroughput: 84 * 1024 },
      };
      if (p.network === 'none') {
        // fix5 §F3-⑥: this cleared the override under .catch(() => {}) and still
        // answered {emulated:['network']}. A caller that believes the tab is back
        // online runs the next step against a throttled/offline page.
        try {
          await cdp.send(tabId, 'Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
        } catch (e) {
          throw err('EMULATE_FAILED', `Network.emulateNetworkConditions (the "none"/clear variant) was refused for tab ${tabId} (${String(e?.message || e).slice(0, 160)}) — whatever emulation was set BEFORE this call is still in force, nothing was cleared. Next: emulate.reset, or reload the tab.`);
        }
      } else if (presets[p.network]) {
        try {
          await cdp.send(tabId, 'Network.emulateNetworkConditions', presets[p.network]);
        } catch (e) {
          throw err('EMULATE_FAILED', `Network.emulateNetworkConditions ("${p.network}") was refused for tab ${tabId} (${String(e?.message || e).slice(0, 160)}) — the page is running on its real network, the emulation did NOT apply. Next: emulate.reset to clear, or check the param shape.`);
        }
      } else {
        throw err('BAD_PARAMS', `unknown network preset "${p.network}" — valid: offline | slow3g | fast3g | none (none clears the override). Nothing was emulated; a typo used to fall through to "clear" while still reporting {emulated:["network"]}.`);
      }
    }
    if (p.cpu_throttle) await cdp.send(tabId, 'Emulation.setCPUThrottlingRate', { rate: p.cpu_throttle });
    return { emulated: Object.keys(p).filter((k) => k !== 'tab_id') };
  });

  R('emulate.reset', { category: 'emulation', description: 'Clear every emulate override on the tab in one call: viewport/device metrics, geolocation, emulated media (print/dark), CPU throttling back to 1x, network conditions back to online. Each step is attempted independently, so it is safe (and recommended) to call even if you never set anything — a leftover viewport override skews screenshots. The answer is honest: {reset:true} only when every step the browser could not refuse did land, otherwise {reset:false, failed:[{step,error}]} (a refused step leaves THAT override in place).' }, async (p) => {
    const tabId = targetTab(p);
    await cdp.ensure(tabId);
    const steps = [
      ['viewport', async () => {
        await cdp.send(tabId, 'Emulation.clearDeviceMetricsOverride');
        const b = cdp.buffers(tabId);
        if (b) b.emulation = null;
      }],
      ['geolocation', () => cdp.send(tabId, 'Emulation.clearGeolocationOverride')],
      ['media', () => cdp.send(tabId, 'Emulation.setEmulatedMedia', { media: '' })],
      ['cpu_throttle', () => cdp.send(tabId, 'Emulation.setCPUThrottlingRate', { rate: 1 })],
      ['network', () => cdp.send(tabId, 'Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 })],
    ];
    const failed = [];
    for (const [step, run] of steps) {
      try {
        await run();
      } catch (e) {
        failed.push({ step, error: String(e?.message || e).slice(0, 160) });
      }
    }
    if (failed.length) {
      return { reset: false, cleared: steps.length - failed.length, failed, note: 'every step still attempted; the listed overrides are STILL in force on this tab' };
    }
    return { reset: true, cleared: steps.length };
  });

  // ---- performance trace (Tracing domain on the debuggee) ------------------------
  const traces = new Map(); // tabId → {events, bytes, resolve, timer}
  cdp.onEvent = (source, method, params) => {
    screencastHandler(source, method, params);
    const t = traces.get(source.tabId);
    if (!t) return;
    if (method === 'Tracing.dataCollected') {
      const chunk = JSON.stringify(params.value || []).length;
      t.events += (params.value || []).length;
      t.bytes += chunk;
    } else if (method === 'Tracing.tracingComplete') {
      clearTimeout(t.timer);
      traces.delete(source.tabId);
      t.resolve({ events: t.events, approx_kb: Math.round(t.bytes / 1024) });
    }
  };

  R('perf.start', { category: 'diagnostics', description: 'Start a DevTools timeline trace on the tab.' }, async (p) => {
    const tabId = targetTab(p);
    await cdp.ensure(tabId);
    await cdp.send(tabId, 'Tracing.start', {
      categories: 'devtools.timeline,devtools,blink.console',
      transferMode: 'ReportEvents',
      ...(p.auto_stop_seconds ? { tracingStopOnComplete: true } : {}),
    });
    return { tracing: true, note: 'call perf.stop to collect' };
  });

  R('perf.stop', { category: 'diagnostics', timeoutMs: TRACE_TOOL_TIMEOUT_MS, description: 'End the perf.start timeline trace on this tab and report what it captured: {events, approx_kb} (the trace payload itself is never returned — it is megabytes). Waits up to 15s for Tracing.tracingComplete and, if the renderer never finishes flushing, returns the partial count with timeout:true. With no perf.start running you get {events:0, approx_kb:0, timeout:true} after the full 15s wait.' }, async (p) => {
    const tabId = targetTab(p);
    const promise = new Promise((resolve) => {
      traces.set(tabId, { events: 0, bytes: 0, resolve, timer: null });
    });
    const t = traces.get(tabId);
    t.timer = setTimeout(() => {
      if (traces.has(tabId)) {
        traces.delete(tabId);
        t.resolve({ events: t.events, approx_kb: Math.round(t.bytes / 1024), timeout: true });
      }
    }, 15000);
    // A refused Tracing.end used to be swallowed and the call still came back as
    // {events:0, timeout:true} — "the renderer never finished flushing", when in
    // fact the flush was never even asked for.
    const endError = await cdp.send(tabId, 'Tracing.end').then(() => null, (e) => String(e?.message || e).slice(0, 160));
    if (endError) {
      clearTimeout(t.timer);
      traces.delete(tabId);
      return { events: 0, approx_kb: 0, stopped: false, end_error: endError, note: 'Tracing.end was refused by this tab, so no trace data could arrive — this is not a flush timeout.' };
    }
    return promise;
  });

  R('form.set', { category: 'interaction', description: `Set form controls: action check|uncheck|toggle (checkbox/radio, physical CDP click), select_option for <select> (by value or text, native React-safe setter). A physical check/uncheck is proven by the page-side delivery record (delivered:true + delivery_ms) and fails with INPUT_NOT_DELIVERED when the document never saw the click; select_option is a DOM setter and stays ack-only (works on a background tab). Visibility rule (fix19): the PHYSICAL click is refused BEFORE dispatch when the target document's visibilityState is not "visible" — nothing is sent, and the error names the real exits; a visible document pays at most ${VISIBLE_WAIT_BUDGET_MS}ms of proof, normally milliseconds.` }, async (p) => {
    const tabId = targetTab(p);
    const action = String(p.action || 'toggle');
    const value = String(p.value ?? '');

    if (action === 'select_option') {
      const { nodeId, meta, frame } = await resolveRef(tabId, p.ref);
      if (nodeId == null && meta?.frameId) {
        // no CDP node for a frame ref — run the same React-safe native-setter
        // script INSIDE the frame through its bridge. Honest label: the change
        // event is synthetic DOM input, a page cannot tell it apart from the
        // main-frame callOnNode path (which is equally synthetic).
        const v = await bridge(tabId, 'selectDom', { ref: meta.domRef, value }, meta.frameId);
        audit.log({ action: 'form.set', tabId, target: meta?.name, op: 'select_option', frame: meta.frameId });
        return { set: p.ref, result: v, via: 'frame-bridge' };
      }
      // backendNodeId straight into Runtime.callFunctionOn — `this` is the
      // <select> itself, shadow-root nodes included (querySelector could not)
      const v = await callOnNode(tabId, refs.get(tabId, p.ref).backendNodeId, selectOptionFn.toString(), [value]);
      audit.log({ action: 'form.set', tabId, target: meta?.name, op: 'select_option' });
      return { set: p.ref, result: v };
    }

    // check / uncheck / toggle → read state from the AX domain, click physically if needed
    const entry = refs.get(tabId, p.ref);
    const { nodeId, box, meta, frame: fr } = await resolveRef(tabId, p.ref);
    let checked = null;
    if (nodeId == null && meta?.frameId) {
      // frame refs have no AX access — the bridge read el.checked directly
      checked = fr?.desc?.checked === true ? true : fr?.desc?.checked === false ? false : null;
    } else {
      try {
        const ax = await cdp.send(tabId, 'Accessibility.getPartialAXTree', { backendNodeId: entry.backendNodeId });
        const props = ax?.nodes?.[0]?.properties || [];
        const c = props.find((x) => x.name === 'checked');
        // AX property values arrive typed; "false" as a string is truthy —
        // interpret strictly
        const raw = c?.value?.value;
        checked = raw === true || raw === 'true' ? true : raw === 'mixed' ? null : raw === undefined ? null : false;
      } catch {}
    }
    const want = action === 'toggle' ? (checked === null ? null : !checked) : action === 'check';
    let dl = {};
    if (checked === null || checked !== want) {
      await guardFrameInputReachable(tabId, p.ref, meta);
      // fix19: this branch is a physical click (select_option above is a DOM
      // setter and stays untouched) — refuse it before dispatch when the
      // document that would receive it is not visible.
      await guardInputVisibility(tabId, { action: 'form.set', ref: `${p.ref} (${action})`, frameId: meta?.frameId ?? 0 });
      await withPass(tabId, async () => {
        // one confirmation per dispatch: mouse() re-proves [box.cx, box.cy]
        // itself before each Input.dispatchMouseEvent
        await mouse(tabId, 'mouseMoved', box.cx, box.cy);
        await mouse(tabId, 'mousePressed', box.cx, box.cy);
        await sleep(30);
        await mouse(tabId, 'mouseReleased', box.cx, box.cy);
      }, {
        frameId: meta?.frameId ?? 0,
        at: [box.cx, box.cy],
        delivery: dl,
        expect: pointerProof([Math.round(box.cx), Math.round(box.cy)]),
      });
    }
    audit.log({ action: 'form.set', tabId, target: meta?.name, op: action, delivered: dl.delivered === true });
    return {
      set: p.ref,
      was_checked: checked,
      clicked: checked === null || checked !== want,
      // fix17: no click was needed → no delivery to prove (null, not false)
      delivered: checked === null || checked !== want ? deliveredField(dl) : null,
      delivery_ms: typeof dl.ms === 'number' ? dl.ms : null,
    };
  });

  // ---- guarded raw CDP (read set open, write set needs confirm) ------------------
  const CDP_READ = new Set([
    'Page.getFrameTree', 'Page.getLayoutMetrics', 'Page.getNavigationHistory', 'Page.captureScreenshot',
    'Performance.getMetrics', 'DOM.getDocument', 'DOM.querySelector', 'DOM.querySelectorAll',
    'DOM.describeNode', 'DOM.getBoxModel', 'Accessibility.getFullAXTree',
  ]);
  const CDP_WRITE = new Set([
    'Input.dispatchMouseEvent', 'Input.dispatchKeyEvent', 'Input.insertText',
    'Page.navigate', 'Page.reload', 'Page.stopLoading', 'DOM.focus',
    'Emulation.setDeviceMetricsOverride', 'Emulation.clearDeviceMetricsOverride',
  ]);
  R('cdp.call', { category: 'diagnostics', sensitive: true, description: 'Whitelisted raw CDP command on the target tab. Read set is open; write set (Input/Page/Emulation) needs confirm:true. Raw Input.* is NOT shield-gate-confirmed: the result says gate_bypassed:true because our own overlay can still eat the event — use click/type/fill/press_key when the input must land.' }, async (p) => {
    const tabId = targetTab(p);
    if (!p.method) throw err('BAD_PARAMS', 'method required');
    const isRead = CDP_READ.has(p.method);
    const isWrite = CDP_WRITE.has(p.method);
    if (!isRead && !isWrite) throw err('CDP_METHOD_BLOCKED', `method not whitelisted; read: ${[...CDP_READ].slice(0, 4).join(', ')}…; write: ${[...CDP_WRITE].slice(0, 4).join(', ')}…`);
    if (isWrite && p.confirm !== true) throw err('NEEDS_CONFIRM', 'write-class CDP methods need confirm:true');
    // cdp.call is the controlled raw escape hatch: adding a pass gate here would
    // take a capability away (IME / touch / whatever-CDP-the-tools-do-not-cover),
    // so it stays bare — but the one thing it must never be is SILENT about it.
    // Every raw Input.* says out loud that no point confirmation proved the veil
    // out of the way, which is exactly the case where the page receives nothing
    // and the tool still reports success (LIVE-RESULTS #1 shape).
    const rawInput = String(p.method).startsWith('Input.');
    await cdp.ensure(tabId);
    const result = await cdp.send(tabId, p.method, p.params || {});
    audit.log({ action: 'cdp.call', tabId, method: p.method, write: isWrite, gate_bypassed: rawInput });
    const out = { method: p.method, result: redact(result) };
    if (rawInput) {
      out.gate_bypassed = true;
      out.note = 'raw CDP Input.* goes out without a shield pass confirmation: if this tab\'s own control overlay is covering the page the event is eaten and the page sees nothing, while this call still returns. Prefer click / type / fill / press_key (they refuse with SHIELD_PASS_FAILED instead of lying).';
    }
    return out;
  });

  // ---- pull-mode screencast -------------------------------------------------
  // ONE cast per tab, and it is a shared slot: liveview and agent callers used
  // to silently replace each other's stream, and whoever exited first stopped
  // the other's frames. start/stop therefore carry a caller-visible {owner}.
  // The owner alone is not enough (LIVE-RESULTS-3B §6e②): `taskkill /F` on
  // `ubb liveview` left the slot named "liveview" forever and every later caller
  // ate SCREENCAST_BUSY. A slot is therefore held against a LEASE — proof of
  // life, not a name — and an expired lease is reclaimed by whoever shows up next.
  const screencasts = new Map(); // tabId → { frames, running, visible, owner, started_at, lease_ms, renewed_at }
  const LEASE_DEFAULT_MS = 30_000;
  const LEASE_MIN_MS = 5_000;
  const LEASE_MAX_MS = 300_000;
  const leaseMs = (v) => Math.min(Math.max(Number(v) || LEASE_DEFAULT_MS, LEASE_MIN_MS), LEASE_MAX_MS);
  const leaseLeft = (sc, now = Date.now()) => sc.expires_at - now;
  const leaseDead = (sc, now = Date.now()) => sc.expires_at <= now;
  function touchLease(sc) {
    sc.renewed_at = Date.now();
    sc.expires_at = sc.renewed_at + sc.lease_ms;
    return sc;
  }
  function screencastHandler(source, method, params) {
    const sc = screencasts.get(source.tabId);
    if (!sc) return;
    if (method === 'Page.screencastFrame') {
      sc.frames.push({
        sessionId: params.sessionId,
        ts: params.metadata?.timestamp,
        w: params.metadata?.deviceWidth,
        h: params.metadata?.deviceHeight,
        data: params.data,
      });
      if (sc.frames.length > 5) sc.frames.shift(); // bounded backlog
    } else if (method === 'Page.screencastVisibilityChanged') {
      sc.visible = params.visible;
    }
  }

  R('screencast.start', { category: 'capture', timeoutMs: 20000, description: 'Start a JPEG screencast on the tab; pull frames with screencast.next (backpressure: a frame is acked only when you pull it). One cast per tab, held by {owner} against a LEASE — proof of life, not a name (default 30s, lease_ms clamped to 5-300s): every screencast.next renews it, {"renew":true} renews it without touching the stream, and a client that dies (taskkill /F, a crash, a lost socket) just stops renewing, so the slot is reclaimed by whoever shows up next and the reclaim answer names the owner it evicted. While the lease is ALIVE a different owner still gets SCREENCAST_BUSY: this is not first-come-first-served, force:true remains the only way to take a live cast. Release with screencast.stop {"owner":…}.' }, async (p = {}) => {
    const tabId = targetTab(p);
    const owner = String(p.owner || 'agent').slice(0, 64);
    const held = screencasts.get(tabId);
    const left = held ? leaseLeft(held) : 0;
    if (held && held.running) {
      if (p.renew === true && held.owner === owner && p.force !== true && left > 0) {
        // an explicit heartbeat: renew the lease without re-arming the browser
        // stream and without throwing BUSY at your own still-alive cast
        held.lease_ms = leaseMs(p.lease_ms);
        touchLease(held);
        return redact({
          started: true,
          renewed: true,
          owner,
          lease_ms: held.lease_ms,
          since: held.started_at,
          note: 'this call renewed YOUR lease on that cast without restarting the stream (screencast.next renews it too) — force:true is how you really restart it with new settings',
        });
      }
      if (left > 0 && p.force !== true) {
        throw err(
          'SCREENCAST_BUSY',
          held.owner === owner
            ? `tab ${tabId} already has a screencast held by YOU as "${owner}" (since ${held.started_at}, lease alive for another ${left}ms) — start does not re-arm it: pull frames with screencast.next, or renew the lease with screencast.start {"owner":"${owner}","renew":true}, or force:true to restart the stream`
            : `tab ${tabId} already has a screencast held by "${held.owner}" (since ${held.started_at}, lease alive for another ${left}ms — every screencast.next renews it) — that client should stop it (screencast.stop {"owner":"${held.owner}"}), or take over deliberately with force:true (its frames then feed YOUR cast; its stop calls become no-ops). If its process is gone, wait the remaining ${left}ms: the lease lapses and the slot is reclaimed on its own`,
        );
      }
    }
    // whoever lands here is taking the slot: an expired lease reclaims itself and
    // force:true takes a live one — either way the answer names the owner evicted
    let reclaimed = null;
    if (held && held.running) {
      reclaimed = { owner: held.owner, since: held.started_at, left_ms: left, by: p.force === true ? 'force:true' : 'lease-expiry' };
      screencasts.delete(tabId);
    }
    await cdp.ensure(tabId);
    await cdp.send(tabId, 'Page.startScreencast', {
      format: 'jpeg',
      quality: Math.min(Math.max(p.quality ?? 60, 10), 90),
      maxWidth: p.max_width ?? 960,
      maxHeight: p.max_height ?? 640,
      everyNthFrame: 1,
    });
    const sc = touchLease({ frames: [], running: true, visible: true, owner, started_at: new Date().toISOString(), lease_ms: leaseMs(p.lease_ms) });
    screencasts.set(tabId, sc);
    return redact({
      started: true,
      owner,
      lease_ms: sc.lease_ms,
      ...(reclaimed
        ? {
            reclaimed_from: reclaimed.owner,
            reclaimed_from_held_since: reclaimed.since,
            reclaimed_by: reclaimed.by,
            note:
              reclaimed.by === 'lease-expiry'
                ? `the slot was still marked as held by "${reclaimed.owner}" (since ${reclaimed.since}), but that client had not renewed its lease for ${-reclaimed.left_ms}ms — a name is not proof of life, so this cast reclaimed the slot it left behind. Stopping a LIVE lease still needs its owner or force:true.`
                : `you took this slot from "${reclaimed.owner}" (since ${reclaimed.since}) with force:true while its lease still had ${reclaimed.left_ms}ms to run — its screencast.stop calls are now no-ops and its frames feed this cast.`,
          }
        : { note: 'call screencast.next to pull frames (each pull renews this lease); screencast.stop {"owner":"' + owner + '"} when done' }),
    });
  });

  R('screencast.next', { category: 'capture', timeoutMs: 15000, description: 'Pull the next screencast frame (waits up to wait_ms). Acks it to the browser. Passing the same {owner} that started the cast also renews its lease — do that from the client that holds it, it is what lets a dead owner be reclaimed instead of blocking forever.' }, async (p = {}) => {
    const tabId = targetTab(p);
    const sc = screencasts.get(tabId);
    if (!sc || !sc.running) throw err('NO_SCREENCAST', sc ? `the cast on tab ${tabId} was held by "${sc.owner}" and its slot is gone — call screencast.start again` : 'call screencast.start first');
    // pulling a frame IS the proof of life: this renews the lease, and a client
    // that no longer exists can therefore never keep the slot alive
    if (p.owner == null || String(p.owner) === sc.owner) touchLease(sc);
    const deadline = Date.now() + Math.min(p.wait_ms ?? 2000, 10000);
    let frame = sc.frames.shift();
    while (!frame && Date.now() < deadline) {
      await sleep(200);
      frame = sc.frames.shift();
    }
    if (!frame) return { waiting: true, visible: sc.visible, lease_left_ms: leaseLeft(sc), ...(leaseDead(sc) ? { lease_expired: true, note: `this lease has been un-renewed for ${-leaseLeft(sc)}ms — another caller may take the slot (screencast.start), so re-claim it with screencast.start {"owner":"${sc.owner}"} now if you still watch it` } : {}) };
    await cdp.send(tabId, 'Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => {});
    const bytes = Math.round((frame.data.length * 3) / 4);
    return { frame: { jpeg_base64: frame.data, w: frame.w, h: frame.h, ts: frame.ts, bytes } };
  });

  R('screencast.stop', { category: 'capture', description: 'Stop the tab screencast. If the cast was started with an owner, pass that same owner: a non-owner stop is refused (stopped:false + held_by) and leaves the running cast untouched, so an exited client cannot kill the holder\'s frames. That refusal has an escape hatch: once the holder\'s LEASE has lapsed (no screencast.next for lease_ms) any caller may stop it, and the answer names the dead owner it released — an abandoned slot is never permanent. stopped:false with reason:"cdp_stop_failed" means the browser refused Page.stopScreencast — our slot is released but the tab may still be capturing; it is NOT reported as stopped.', timeoutMs: 20000 }, async (p) => {
    const tabId = targetTab(p);
    const sc = screencasts.get(tabId);
    if (!sc) return { stopped: false };
    if (p.owner != null && String(p.owner) !== sc.owner) {
      if (!leaseDead(sc)) {
        return { stopped: false, held_by: sc.owner, lease_left_ms: leaseLeft(sc), note: `"${sc.owner}" holds this cast and it keeps running — stop it from that client, or take over with screencast.start {force:true} (the lease has ${leaseLeft(sc)}ms left; after that the slot is reclaimable on its own)` };
      }
      const released = { released_owner: sc.owner, held_since: sc.started_at, expired_ms: -leaseLeft(sc) };
      screencasts.delete(tabId);
      try {
        await cdp.send(tabId, 'Page.stopScreencast');
        return redact({ stopped: true, ...released, note: `"${released.released_owner}" never pulled a frame for ${released.expired_ms}ms, so its lease had lapsed; this stop released the slot it left behind and told the browser to stop capturing.` });
      } catch (e) {
        return redact({ stopped: false, reason: 'cdp_stop_failed', local_slot_released: true, ...released, error: String(e?.message || e).slice(0, 200), note: `the abandoned slot (${released.released_owner}) is released, but Page.stopScreencast was refused — the browser may still be capturing that tab.` });
      }
    }
    sc.running = false;
    screencasts.delete(tabId);
    // fix5 §F3-⑥: the old .catch(() => {}) answered {stopped:true} even when the
    // browser refused the stop. The slot on OUR side really is released (frames
    // are dropped by screencastHandler the moment the map entry is gone), but the
    // capture on the RENDERER side may still be running — say which of the two
    // happened instead of claiming a stop the wire never got.
    try {
      await cdp.send(tabId, 'Page.stopScreencast');
    } catch (e) {
      return {
        stopped: false,
        reason: 'cdp_stop_failed',
        local_slot_released: true,
        error: String(e?.message || e).slice(0, 200),
        note: `the ${tabId} cast slot is free again and no frames are being delivered, but Page.stopScreencast was refused — the browser may still be capturing that tab. Do not retry this call (the slot is already gone); ubb reload the tab, or leave it: a later screencast.start re-arms the stream.`,
      };
    }
    return { stopped: true };
  });

  // ---- audit --------------------------------------------------------------------------------
  // ---- clipboard / batch content / exporters / events ----------------------

  async function clipboardOp(op, text) {
    if (!(await chrome.offscreen.hasDocument())) {
      await chrome.offscreen.createDocument({
        url: 'offscreen/offscreen.html',
        reasons: ['CLIPBOARD'],
        justification: 'clipboard read/write for ubb agent tools',
      });
    }
    return chrome.runtime.sendMessage({ type: 'UBB_CLIPBOARD', op, text });
  }

  R('clipboard.read', { category: 'clipboard', sensitive: true, description: 'Read the OS clipboard text. Sensitive: requires confirm:true.' }, async (p) => {
    if (p.confirm !== true) throw err('NEEDS_CONFIRM', 'clipboard reading is sensitive — retry with confirm:true once you have asked the user');
    const r = await clipboardOp('read');
    if (!r?.ok) throw err('CLIPBOARD_FAILED', r?.error || 'read failed');
    audit.log({ action: 'clipboard.read', chars: r.text?.length || 0 });
    return { text: truncate(r.text || '', 100000) };
  });

  R('clipboard.write', { category: 'clipboard', description: 'Write text to the OS clipboard.' }, async (p) => {
    const r = await clipboardOp('write', String(p.text ?? ''));
    if (!r?.ok) throw err('CLIPBOARD_FAILED', r?.error || 'write failed');
    audit.log({ action: 'clipboard.write', chars: r.chars });
    return { written: r.chars };
  });

  async function withTempTab(url, { settleMs = 700, timeoutMs = 20000 } = {}) {
    const tab = await chrome.tabs.create({ url, active: false });
    for (let i = 0; i < Math.ceil(timeoutMs / 250); i++) {
      const t = await chrome.tabs.get(tab.id).catch(() => null);
      if (!t || t.status === 'complete') break;
      await sleep(250);
    }
    await sleep(settleMs);
    return tab.id;
  }

  R('tabs.content', { category: 'sensing', description: 'Batch: open up to 10 URLs in background tabs, extract main text from each, close them. No debugger needed.' }, async (p = {}) => {
    const urls = (p.urls || []).slice(0, 10).map(normalizeUrl).filter((u) => /^https?:/i.test(u));
    const pages = [];
    for (const url of urls) {
      const id = await withTempTab(url);
      let entry = { url: redactUrl(url), text: '' };
      try {
        const r = await bridge(id, 'getPageText', { max_chars: p.max_chars_each || 8000 });
        entry = { url: redactUrl(url), title: truncate(r.title, 120), text: truncate(r.text || '', p.max_chars_each || 8000) };
      } catch (e) {
        entry.error = String(e?.message || e);
      }
      await chrome.tabs.remove(id).catch(() => {});
      pages.push(entry);
    }
    return { pages };
  });

  R('export.gsuite', { category: 'sensing', description: 'Open a Google Docs/Sheets/Slides URL in a background tab and extract its rendered text (requires the user to be logged in).' }, async (p = {}) => {
    const url = normalizeUrl(p.url);
    if (!/docs\.google\.com/.test(url)) throw err('BAD_PARAMS', 'expected a docs.google.com URL');
    const id = await withTempTab(url, { settleMs: 2500, timeoutMs: 30000 });
    let out;
    try {
      const kind = /\/spreadsheets/.test(url) ? 'sheets' : /\/presentation/.test(url) ? 'slides' : 'docs';
      out = await evalJs(id, `(function(){
        var el = document.querySelector('.kix-app-page-editor') || document.querySelector('[role=grid]') || document.body;
        return { kind: ${JSON.stringify(kind)}, title: document.title, text: el.innerText };
      })()`);
    } catch (e) {
      out = { error: String(e?.message || e) };
    }
    await chrome.tabs.remove(id).catch(() => {});
    return { url: redactUrl(url), kind: out?.kind, title: out?.title, text: truncate(out?.text || '', p.max_chars || 50000), error: out?.error };
  });

  R('export.youtube', { category: 'sensing', description: 'Open a YouTube watch URL in a background tab and pull the caption track transcript (json3), no UI interaction needed.' }, async (p = {}) => {
    const url = normalizeUrl(p.url);
    if (!/youtube\.com\/watch/.test(url)) throw err('BAD_PARAMS', 'expected a youtube.com/watch URL');
    const id = await withTempTab(url, { settleMs: 3500, timeoutMs: 30000 });
    let out;
    try {
      out = await evalJs(id, `(async function(){
        var pr = window.ytInitialPlayerResponse;
        var tr = pr && pr.captions && pr.captions.playerCaptionsTracklistRenderer && pr.captions.playerCaptionsTracklistRenderer.captionTracks;
        if (!tr || !tr.length) return { error: 'no captions on this video' };
        var track = tr.find(function(t){ return !t.kind; }) || tr[0];
        // try json3 first, fall back to the legacy XML timedtext endpoint
        var lines = null;
        try {
          var r1 = await fetch(track.baseUrl + '&fmt=json3');
          var t1 = await r1.text();
          if (t1) {
            var j = JSON.parse(t1);
            lines = (j.events || []).map(function(e){ return (e.segs||[]).map(function(s){return s.utf8||'';}).join(''); }).filter(Boolean);
          }
        } catch (e) {}
        if (!lines) {
          var r2 = await fetch(track.baseUrl);
          var xml = await r2.text();
          if (xml) {
            var doc = new DOMParser().parseFromString(xml, 'text/xml');
            lines = Array.from(doc.querySelectorAll('text')).map(function(n){ return n.textContent.trim(); }).filter(Boolean);
          }
        }
        if (!lines || !lines.length) {
          // third path: open the transcript panel in the player UI
          var sleep2 = function(ms){ return new Promise(function(r){ setTimeout(r, ms); }); };
          var more = document.querySelector('tp-yt-paper-button#expand') || document.querySelector('#expand') || document.querySelector('ytd-text-inline-expander #expand');
          if (more) { more.click(); await sleep2(700); }
          var btns = Array.from(document.querySelectorAll('button, ytd-button-renderer button, yt-button-shape button'));
          var tb = btns.find(function(b){ return /show transcript|显示转录稿|转录/i.test((b.innerText || b.textContent || '')); });
          if (tb) {
            tb.click();
            await sleep2(1800);
            var segs = document.querySelectorAll('ytd-transcript-segment-renderer .segment-text, [class*="transcript-segment"]');
            if (segs && segs.length) {
              lines = Array.from(segs).map(function(n){ return n.textContent.trim(); }).filter(Boolean);
              return { lang: track.languageCode || '', lines: lines, via: 'transcript-panel' };
            }
          }
          return { error: 'caption track blocked (PO token) and transcript panel unavailable — try a logged-in profile or another video' };
        }
        return { lang: track.languageCode || '', lines: lines, via: 'timedtext' };
      })()`);
    } catch (e) {
      out = { error: String(e?.message || e) };
    }
    await chrome.tabs.remove(id).catch(() => {});
    if (out && Array.isArray(out.lines)) {
      return { url: redactUrl(url), lang: out.lang, via: out.via, line_count: out.lines.length, text: truncate(out.lines.join('\n'), 50000) };
    }
    return { url: redactUrl(url), error: out?.error || 'extraction failed' };
  });

  R('cdp.events', { category: 'diagnostics', description: 'Read the recorded CDP event stream for the tab (ring of 1000). Pass since_seq for incremental pulls, method_pattern to filter.' }, async (p = {}) => {
    const tabId = targetTab(p);
    await cdp.ensure(tabId);
    const s = cdp.buffers(tabId);
    const ring = s?.eventRing || [];
    const since = p.since_seq || 0;
    const pat = p.method_pattern ? new RegExp(p.method_pattern) : null;
    const events = ring.filter((e) => e.seq > since && (!pat || pat.test(e.method))).slice(-(p.limit || 100));
    return { events, next_seq: s?.eventSeq || 0 };
  });

  R('assets.list', { category: 'diagnostics', description: 'List image/css/js/font assets captured from the network buffer.' }, async (p = {}) => {
    const tabId = targetTab(p);
    await cdp.ensure(tabId);
    const b = cdp.buffers(tabId);
    const mime = /^(image\/|text\/css|font\/|application\/javascript|text\/javascript)/;
    const assets = (b?.net || []).filter((r) => r.mime && mime.test(r.mime)).map((r) => ({ url: redactUrl(r.url), mime: r.mime, status: r.status }));
    return { assets: assets.slice(-100), note: 'navigate (or reload) first to capture assets' };
  });

  R('assets.bundle', { category: 'diagnostics', description: 'Fetch up to 10 page assets in-page and return base64 data URLs (same-origin/CORS-permitting, 6MB cap).' }, async (p = {}) => {
    const tabId = targetTab(p);
    await cdp.ensure(tabId);
    const b = cdp.buffers(tabId);
    const mimeRe = /^(image\/|text\/css|font\/|application\/javascript)/;
    const urls = (b?.net || []).filter((r) => r.mime && mimeRe.test(r.mime)).slice(-(p.count || 5)).map((r) => r.url);
    if (!urls.length) throw err('NO_ASSETS', 'no captured assets; navigate first');
    const out = await evalJs(tabId, `(async function(){
      var urls = ${JSON.stringify(urls)};
      var results = [];
      var total = 0;
      for (var u of urls) {
        try {
          var r = await fetch(u);
          var buf = await r.arrayBuffer();
          var bytes = buf.byteLength;
          if (total + bytes > 6291456) { results.push({ url: u, skipped: 'cap' }); continue; }
          total += bytes;
          var bin = '';
          var arr = new Uint8Array(buf);
          for (var i = 0; i < arr.length; i += 0x8000) bin += String.fromCharCode.apply(null, arr.subarray(i, i + 0x8000));
          results.push({ url: u, mime: (r.headers.get('content-type')||'').split(';')[0], bytes: bytes, data_url: 'data:' + (r.headers.get('content-type')||'application/octet-stream').split(';')[0] + ';base64,' + btoa(bin) });
        } catch (e) { results.push({ url: u, error: String(e) }); }
      }
      return results;
    })()`);
    return { assets: out };
  });

  R('bot.report', { category: 'diagnostics', description: 'Report a bot-detection event (captcha_failed | access_denied | challenge_loop | unexpected_bot_error) into the audit trail.' }, async (p = {}) => {
    const kinds = new Set(['captcha_failed', 'access_denied', 'challenge_loop', 'unexpected_bot_error']);
    if (!kinds.has(p.kind)) throw err('BAD_PARAMS', 'kind must be one of ' + [...kinds].join('|'));
    audit.log({ action: 'bot.report', kind: p.kind, note: truncate(String(p.note || ''), 200), tab_id: p.tab_id });
    return { recorded: p.kind };
  });

  R('webmcp.list', { category: 'sensing', description: 'List WebMCP tools declared by the page (window.__webMcpTools / webMCP.tools / navigator.modelContext.tools). tools:null means the page declared none — and when the note says the read itself failed, "declared none" is NOT established.' }, async (p) => {
    const tabId = targetTab(p);
    // fix5 §F3 sweep: the old .catch(() => null) printed "page declares no WebMCP
    // tools" for a page this extension could not read at all.
    const probe = await evalJs(tabId, `(function(){var t=window.__webMcpTools||(window.webMCP&&window.webMCP.tools)||(navigator.modelContext&&navigator.modelContext.tools);return t?JSON.parse(JSON.stringify(t)):null})()`).then((v) => ({ v }), (e) => ({ e }));
    const t = probe.v == null ? null : probe.v;
    return { tools: t, note: t ? undefined : probe.e ? `the page could not be read (${String(probe.e?.message || probe.e).slice(0, 120)}) — absence of tools is NOT established here` : 'page declares no WebMCP tools' };
  });

  R('webmcp.invoke', { category: 'interaction', sensitive: true, description: 'Invoke a page-declared WebMCP tool. Runs page code: requires confirm:true.' }, async (p) => {
    if (p.confirm !== true) throw err('NEEDS_CONFIRM', 'invoking page-declared code needs confirm:true');
    const tabId = targetTab(p);
    const r = await evalJs(tabId, `(async function(){
      var t = window.__webMcpTools || (window.webMCP && window.webMCP.tools) || (navigator.modelContext && navigator.modelContext.tools);
      var arr = Array.isArray(t) ? t : (t ? Object.values(t) : []);
      var tool = arr.find(function(x){ return x && (x.name === ${JSON.stringify(String(p.name || ''))}); });
      if (!tool) return { error: 'tool not found' };
      var fn = tool.invoke || tool.callback || tool.handler;
      if (typeof fn !== 'function') return { error: 'tool has no invoke function' };
      return { result: await fn(${JSON.stringify(p.args || {})}) };
    })()`);
    audit.log({ action: 'webmcp.invoke', name: p.name });
    return redact(r);
  });

  // ---- sibling-extension RPC (externally_connectable bridge) ----------------
  R('ext.call', { category: 'interaction', sensitive: true, timeoutMs: 180000, description: 'Drive a sibling extension via externally_connectable RPC: chrome.runtime.sendMessage(extensionId, {action, ...payload}). Sensitive — requires confirm:true. Discover actions with ext.list or ext.call {action:"__schema__"}.' }, async (p) => {
    if (p.confirm !== true) throw err('NEEDS_CONFIRM', 'ext.call runs code inside another extension — retry with confirm:true once the user has approved');
    const extensionId = String(p.extensionId || '');
    if (!/^[a-p]{32}$/.test(extensionId)) throw err('BAD_PARAMS', 'extensionId must be a 32-letter (a-p) extension id');
    const action = String(p.action || '');
    if (!/^[\w.]+$/.test(action)) throw err('BAD_PARAMS', 'action required (word characters only)');
    const payload = p.payload && typeof p.payload === 'object' && !Array.isArray(p.payload) ? p.payload : {};
    const message = { action, ...payload };
    const timeoutMs = Math.max(1000, Math.min(180000, Number(p.timeoutMs) || 45000));
    audit.log({ action: 'ext.call', extensionId, call: action });
    let timer = 0;
    try {
      const res = await Promise.race([
        chrome.runtime.sendMessage(extensionId, message),
        new Promise((_r, rej) => { timer = setTimeout(() => rej(err('TOOL_TIMEOUT', `ext.call ${action} timed out after ${timeoutMs}ms`)), timeoutMs); }),
      ]);
      return res ?? { ok: false, error: 'target extension returned no response (missing, disabled, or no onMessageExternal listener)' };
    } finally {
      if (timer) clearTimeout(timer);
    }
  });

  R('ext.list', { category: 'sensing', timeoutMs: 20000, description: 'List installed extensions (chrome.management) and probe each with a __schema__ handshake to find UBB-controllable bridge extensions. probe:false skips the handshake. Drive bridges with ext.call (confirm:true).' }, async (p) => {
    const all = await chrome.management.getAll();
    const extensions = all
      .filter((i) => i.type === 'extension' && i.id !== chrome.runtime.id)
      .map((i) => ({ id: i.id, name: i.name, version: i.version, enabled: i.enabled, installType: i.installType }));
    if (p.probe === false) return { count: extensions.length, extensions };
    const probed = await Promise.all(extensions.map(async (e) => {
      if (!e.enabled) return e;
      try {
        const s = await Promise.race([
          chrome.runtime.sendMessage(e.id, { action: '__schema__' }),
          new Promise((r) => setTimeout(() => r(null), 800)),
        ]);
        if (s && s.ok && (s.actions || s.extension)) {
          return { ...e, bridge: true, bridgeName: s.extension || '', bridgeActions: s.actions ? Object.keys(s.actions) : [] };
        }
      } catch { /* extension does not accept our messages — expected for most */ }
      return e;
    }));
    const bridges = probed.filter((e) => e.bridge);
    return {
      count: probed.length,
      bridges: bridges.length,
      extensions: probed,
      hint: bridges.length ? 'bridge extensions accept ext.call {extensionId, action, payload} with confirm:true' : 'no bridge extensions found — target must declare externally_connectable with our id and handle onMessageExternal',
    };
  });

  R('tab.mark', { category: 'tabs', description: 'Annotate a session tab (shown in tab.list output).' }, async (p) => {
    const tabId = p.tab_id ?? targetTab(p);
    if (!sessions.owns(tabId)) throw err('TAB_NOT_OWNED', 'only session tabs can be marked');
    const s = sessions.active();
    s.marks.set(tabId, truncate(String(p.status || 'marked'), 20));
    await sessions.persist();
    return { marked: tabId, status: s.marks.get(tabId) };
  });

  R('ax.action', { category: 'interaction', description: 'Perform an accessibility-style action on a ref: focus | click | setValue (value) | expand. Frame refs support focus/click via the coordinate path; setValue/expand need a CDP node the frame session does not have — use fill or a bridge op.' }, async (p) => {
    const tabId = targetTab(p);
    const action = String(p.action || 'focus');
    if (!['focus', 'click', 'setValue', 'expand'].includes(action)) throw err('BAD_PARAMS', 'action: focus|click|setValue|expand');
    const { nodeId, box, meta } = await resolveRef(tabId, p.ref);
    if (action === 'click' && DANGEROUS_LABEL.test(meta?.name || '') && p.confirm !== true) {
      throw err('NEEDS_CONFIRM', `"${meta.name}" looks like a destructive/paid action — retry with confirm:true after asking the user`);
    }
    if (action === 'setValue') {
      await guardSensitiveField(tabId, nodeId, meta, {});
    }
    if (nodeId == null && meta?.frameId) {
      if (action === 'setValue' || action === 'expand') {
        throw err('FRAME_UNSUPPORTED', `${p.ref} is inside an iframe — ${action} runs page JS on a CDP node this session does not have for that frame; use fill (real input) or snapshot+click`);
      }
      // focus/click: physical input at the composed position reaches the frame
      await guardFrameInputReachable(tabId, p.ref, meta);
      await withPass(tabId, async () => {
        // mouse() confirms [box.cx, box.cy] before each send (assertInputGate)
        await mouse(tabId, 'mouseMoved', box.cx, box.cy);
        await mouse(tabId, 'mousePressed', box.cx, box.cy);
        await mouse(tabId, 'mouseReleased', box.cx, box.cy);
      }, { frameId: meta.frameId, at: [box.cx, box.cy] });
      audit.log({ action: 'ax.action', tabId, op: action, frame: meta.frameId });
      return { via: 'frame-coords', at: [Math.round(box.cx), Math.round(box.cy)], target: meta?.name };
    }
    const v = await callOnNode(tabId, refs.get(tabId, p.ref).backendNodeId, axActionFn.toString(), [action, String(p.value ?? '')]);
    audit.log({ action: 'ax.action', tabId, op: action });
    return v;
  });

  // download.status / download.path are registered by lib/tools-downloads.js
  // (supersets: the old status fields state/bytes_received/total/paused/url are
  // all kept verbatim there) — the old copies here were removed by wave7a.

  R('window.state', { category: 'tabs', description: 'Query the window state (normal|minimized|maximized, focused) of the target tab.' }, async (p) => {
    const tabId = targetTab(p);
    const tab = await chrome.tabs.get(tabId);
    const w = await chrome.windows.get(tab.windowId);
    return { state: w.state, focused: w.focused };
  });

  // ---- selector-first one-liners (Playwright parity) ----
  async function selEval(tabId, expr) {
    return evalJs(tabId, expr).catch((e) => { throw err('SELECTOR_FAILED', String(e?.message || e)); });
  }
  R('locator.count', { category: 'sensing', description: 'document.querySelectorAll(selector).length' }, async (p) => {
    const tabId = targetTab(p);
    return { count: await selEval(tabId, 'document.querySelectorAll(' + JSON.stringify(String(p.selector || '')) + ').length') };
  });
  R('element.visible', { category: 'sensing', description: 'Is the first match of selector visible?' }, async (p) => {
    const tabId = targetTab(p);
    return { visible: await selEval(tabId, `(function(){var e=document.querySelector(${JSON.stringify(String(p.selector||''))});if(!e)return false;var r=e.getBoundingClientRect();var s=getComputedStyle(e);return r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none'})()`) };
  });
  R('element.enabled', { category: 'sensing', description: 'Enabled check for the FIRST element matching {selector}: true only if it exists and has no disabled attribute. CSS selectors are querySelector — light DOM and top frame only (no shadow root, no iframe); for an @eN ref use element.info instead.' }, async (p) => {
    const tabId = targetTab(p);
    return { enabled: await selEval(tabId, `(function(){var e=document.querySelector(${JSON.stringify(String(p.selector||''))});return !!e&&!e.disabled})()`) };
  });
  R('element.text', { category: 'sensing', description: 'innerText of the first match.' }, async (p) => {
    const tabId = targetTab(p);
    return { text: truncate(String(await selEval(tabId, `(function(){var e=document.querySelector(${JSON.stringify(String(p.selector||''))});return e?e.innerText:''})()`) || ''), 20000) };
  });
  R('element.texts', { category: 'sensing', description: 'innerText of ALL matches.' }, async (p) => {
    const tabId = targetTab(p);
    const list = (await selEval(tabId, `Array.from(document.querySelectorAll(${JSON.stringify(String(p.selector||''))})).map(function(e){return e.innerText})`)) || [];
    return { texts: list.slice(0, 200).map((t) => truncate(String(t), 500)) };
  });
  R('element.attribute', { category: 'sensing', description: 'getAttribute({name}) of the FIRST element matching {selector}, or null when either is missing. The value passes through redact(), so a token/cookie/password-looking attribute (href with a secret query, data-token…) comes back as [redacted] — that is the audit rule, not a bug. Light DOM, top frame only.' }, async (p) => {
    const tabId = targetTab(p);
    return { value: redact(await selEval(tabId, `(function(){var e=document.querySelector(${JSON.stringify(String(p.selector||''))});return e?e.getAttribute(${JSON.stringify(String(p.name||''))}):null})()`)) };
  });

  R('human.status', { category: 'session', description: 'Experimental: query whether human-behaviour mode (bezier mouse paths, per-key typing cadence, chunked scrolling) is enabled.' }, async () => ({ enabled: await human.isEnabled(), note: 'toggle in the UBB popup, or human.set with confirm:true' }));

  R('human.set', { category: 'session', sensitive: true, description: 'Experimental: enable/disable human-behaviour mode. Requires confirm:true (ask the user first).' }, async (p) => {
    if (p.confirm !== true) throw err('NEEDS_CONFIRM', 'changing human mode should be the user\'s call — retry with confirm:true after asking');
    const v = await human.setEnabled(p.enabled === true);
    audit.log({ action: 'human.set', enabled: v });
    return { enabled: v };
  });

  R('audit.list', { category: 'diagnostics', description: 'Recent tool invocations recorded in the in-memory audit ring (password/OTP fills never appear: they are refused).' }, async (p = {}) => redact({ entries: audit.list(p.limit || 50) }));

  // helper for download tool's ref→href (registered via executeScript tag)
  R('element.info', { category: 'sensing', description: 'Inspect an @eN ref: tag, role, name, attributes, box. Works for frame refs too (box is the top-viewport position; attributes come from the frame bridge).' }, async (p) => {
    const tabId = targetTab(p);
    const { nodeId, box, meta, frame } = await resolveRef(tabId, p.ref);
    if (nodeId == null && meta?.frameId) {
      const d = frame?.desc || {};
      return {
        ref: p.ref,
        role: meta.role,
        name: meta.name,
        tag: d.tag,
        attributes: redact(d.attributes || {}),
        visible: d.visible,
        box: { x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.width), h: Math.round(box.height) },
        frame: { ext_frame_id: meta.frameId, cross_origin: !!meta.crossOrigin, url: redactUrl(meta.frameUrl || '') },
      };
    }
    const doc = await cdp.send(tabId, 'DOM.describeNode', { nodeId });
    const a = await attrsOf(tabId, nodeId);
    return {
      ref: p.ref,
      role: meta.role,
      name: meta.name,
      tag: doc?.node?.localName,
      attributes: redact(a),
      box: { x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.width), h: Math.round(box.height) },
    };
  });
}
