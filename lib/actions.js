// Shared action helpers for tool modules (lib/tools.js and lib/tools-*.js).
// Wave 0 extraction from lib/tools.js — behaviour is unchanged; new modules
// import from here instead of copying a private version.

import { cdp } from './cdp.js';
import { refs } from './refs.js';
import { takeSnapshot, resolveRef, rebuildNodeIndex } from './snapshot.js';
import { sessions } from './tabs.js';
import { shield, withPass, withHiddenShield, sleep, pendingHelp, assertInputGate } from './shield-ctl.js';
import { bridge } from './bridge-ctl.js';
import { audit } from './audit.js';
import { requestDaemon } from './ws-client.js';
import { redact, redactUrl, truncate } from './redact.js';
import { err } from './config.js';

export const DANGEROUS_LABEL =
  /(删除|移除|注销|支付|付款|购买|转账|结算|delete|remove|uninstall|pay\b|purchase|checkout|transfer\b|unsubscribe)/i;

export const SENSITIVE_FIELD =
  /(password|passwd|密码|otp|one[-\s]?time|验证码|cvv|cvc|card.?number|卡号|secret|私钥)/i;

// Two disjoint classes, because only ONE of them may ever be auto-filled and
// only through a daemon-resolved secret (_scratch/AGENT-CONTRACT.md §5).
export const PASSWORD_FIELD = /(password|passwd|密码)/i;
// no flag, no caller and no placeholder can unlock these (§4.5)
export const SENSITIVE_FIELD_NEVER =
  /(otp|one[-\s]?time|验证码|cvv|cvc|card.?number|卡号|secret|私钥)/i;

// mirror of originMatches()/normalizeOriginHost usage in daemon/cli/secret.mjs —
// lib/* cannot import the Node module (contract §1); test-security pins that all
// copies judge alike, the same anti-drift move as tools-secrets.js's private one.
export function originMatches(host, boundHost) {
  const h = String(host || '').toLowerCase();
  const b = String(boundHost || '').toLowerCase();
  return !!h && !!b && (h === b || h.endsWith('.' + b));
}

function tabHost(url) {
  try {
    return new URL(String(url || '')).hostname.toLowerCase();
  } catch {
    return '';
  }
}

const VAULT_NAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;

/**
 * The placeholder path's origin gate (wave5a, log-wave2secrets "off/strict
 * 暴露面"): the daemon resolved {{secret:NAME}} without knowing the tab
 * (it cannot), and stamped only the NAMES into __ubb_secret_names. Here —
 * extension side, where the tab URL lives — the binding is checked against
 * the real origin. strict: unbound / mismatched / vanished secret → refuse
 * BEFORE any typing, and this call path never asks the daemon for the value
 * (it already sits unsubstituted in params only because the daemon resolved
 * it; on refusal the value is simply dropped). off: allow, but audit
 * {names, host} so harvesting attempts stay visible.
 * Throws SECRET_ORIGIN_DENIED / DAEMON_NOT_CONNECTED; resolves once allowed.
 */
export async function enforceVaultOrigins(tabId, names, opts = {}) {
  const list = [...new Set((Array.isArray(names) ? names : []).filter((n) => typeof n === 'string' && VAULT_NAME_RE.test(n)))];
  if (!list.length) return; // no daemon-stamped ledger = flag-only legacy path, unchanged
  const gate = opts.vaultGate && typeof opts.vaultGate === 'object' && Array.isArray(opts.vaultGate.bindings) ? opts.vaultGate : null;
  let mode;
  let bindings;
  if (gate) {
    // authoritative snapshot stamped by the daemon next to the names
    // (same trust model as secret.fill's __ubb_secret_binding — marker keys are
    // stripped from agent params, so only the daemon can put them here)
    mode = gate.mode === 'strict' ? 'strict' : 'off';
    bindings = gate.bindings;
  } else {
    let r;
    try {
      r = await requestDaemon('secret.bindings', { names: list });
    } catch (e) {
      if (e && e.code) throw e; // SECRET_UNKNOWN / SECRET_FETCH_TIMEOUT keep their guidance
      throw err('DAEMON_NOT_CONNECTED', `could not verify secret origin bindings with the local daemon (${list.join(',')}): ${String(e?.message || e)} — the placeholder fill is refused until the daemon link works`);
    }
    if (!r || typeof r !== 'object' || !Array.isArray(r.bindings)) {
      throw err('DAEMON_ERROR', 'the daemon answered secret.bindings without a binding list — refusing to type any vault value; update the daemon (`ubb daemon stop` then retry)');
    }
    mode = r.mode === 'strict' ? 'strict' : 'off';
    bindings = r.bindings;
  }
  const host = tabHost((await chrome.tabs.get(tabId)).url);
  const byName = new Map(bindings.map((b) => [b && b.name, b]));
  const fieldRole = opts.field_role || 'unknown';
  if (mode === 'strict') {
    for (const name of list) {
      const b = byName.get(name);
      const origins = Array.isArray(b?.origins) ? b.origins : [];
      let reason = null;
      if (!b || b.exists !== true) reason = 'secret_gone'; // deleted between substitution and fill
      else if (!origins.length) reason = 'unbound';
      else if (!origins.some((o) => originMatches(host, o))) reason = 'origin_mismatch';
      if (reason) {
        audit.log({ action: 'secret.fill', via: 'placeholder', tab_id: tabId, vault_entry: name, origin: host || null, field_role: fieldRole, mode, decision: 'denied', reason });
        throw err(
          'SECRET_ORIGIN_DENIED',
          `secret "${name}" ${reason === 'unbound' ? 'has no origin binding and mode is strict' : reason === 'secret_gone' ? 'vanished from the vault between substitution and fill' : `is bound to ${origins.join(', ')} but this tab is host ${JSON.stringify(host || '(unknown)')}`} — the {{secret:…}} placeholder value was NOT typed; open the bound site, or let a human run \`ubb secret bind ${name} <host>\` / \`ubb secret mode off\``,
        );
      }
    }
  }
  audit.log({ action: 'secret.fill', via: 'placeholder', tab_id: tabId, vault_entry: list.join(','), origin: host || null, field_role: fieldRole, mode, decision: 'filled' });
}

// ---------------------------------------------------------------- helpers

export function targetTab(params) {
  const s = sessions.active();
  if (!s) throw err('NO_SESSION', 'no active session; call session.start first');
  const tabId = params.tab_id ?? s.lastTabId;
  if (tabId == null) throw err('NO_TAB', 'no tab yet; call tab.create first');
  if (!sessions.owns(tabId)) {
    throw err('TAB_NOT_OWNED', `tab ${tabId} is not owned by this session; use tab.claim to take it`);
  }
  if (s.paused) {
    throw err('SESSION_PAUSED', 'the user took over this session (停止代理) — no tool may drive it until they resume control; report this instead of retrying');
  }
  s.lastTabId = tabId;
  sessions.touch(); // fire-and-forget persist
  return tabId;
}

export async function attrsOf(tabId, nodeId) {
  const r = await cdp.send(tabId, 'DOM.getAttributes', { nodeId }).catch(() => null);
  const flat = r?.attributes || [];
  const out = {};
  for (let i = 0; i + 1 < flat.length; i += 2) out[flat[i].toLowerCase()] = flat[i + 1];
  return out;
}

/** CDP nodeId of document.activeElement, or null when focus is not an element. */
export async function focusedNodeId(tabId) {
  const r = await cdp.send(tabId, 'Runtime.evaluate', {
    expression: 'document.activeElement',
    objectGroup: 'ubb-focus',
  }).catch(() => null);
  const objectId = r?.result?.objectId;
  if (!objectId) return null;
  try {
    const n = await cdp.send(tabId, 'DOM.requestNode', { objectId }).catch(() => null);
    return n?.nodeId ?? null;
  } finally {
    cdp.send(tabId, 'Runtime.releaseObject', { objectId }).catch(() => {});
  }
}

/**
 * Block auto-filling sensitive inputs.
 * `opts.allowPassword` is set ONLY by lib/tools-secrets.js (secret.fill), whose
 * value comes from the daemon over the authenticated loopback link at the
 * moment of typing — the 3-argument call sites (fill / fill_form, and the
 * placeholder path) keep refusing password fields until they pass
 * `{ allowPassword: p.__ubb_secret_fill === true }`.
 * `opts.vaultNames` (the daemon-stamped __ubb_secret_names ledger / a replay
 * step's vault_entries) additionally routes the password release through the
 * origin gate below — under strict an unbound or mismatched secret never
 * reaches the field.
 * OTP / one-time-code / CVV / card numbers / 私钥 are refused whatever the
 * source: there is deliberately no flag that lets them through.
 */
export async function guardSensitiveField(tabId, nodeId, meta, opts = {}) {
  const a = await attrsOf(tabId, nodeId);
  const hay = [a.type, a.autocomplete, a.name, a.id, a.placeholder, a['aria-label'], meta?.name].join(' ');
  const ac = String(a.autocomplete || '').toLowerCase();
  if (ac.includes('one-time-code') || SENSITIVE_FIELD_NEVER.test(hay)) {
    throw err(
      'SENSITIVE_FIELD',
      'this is a one-time-code / payment / secret-key field — UBB never auto-fills these, whatever the source; ask the user to type it',
    );
  }
  const isPassword = a.type === 'password' || ac === 'current-password' || ac === 'new-password' || PASSWORD_FIELD.test(hay);
  if (isPassword && !opts.allowPassword) {
    throw err(
      'SENSITIVE_FIELD',
      'password field: plaintext values are refused here — call secret.fill {"ref":"@eN","secret":"<name>"} (or put a {{secret:<name>}} placeholder in fill) instead of typing the value',
    );
  }
  if (isPassword && opts.allowPassword && Array.isArray(opts.vaultNames)) {
    await enforceVaultOrigins(tabId, opts.vaultNames, { field_role: 'password', vaultGate: opts.vaultGate });
  }
}

const STALE_NODE_MSG = /no node with given id|not found|cannot find context|object has been revoked|doesn't exist/i;

function rethrowNodeError(e) {
  const msg = String(e?.message || e);
  if (STALE_NODE_MSG.test(msg)) {
    throw err('REF_STALE', 'that element is gone from the document (or its frame was destroyed); take a fresh snapshot');
  }
  throw err('EVAL_ERROR', truncate(msg, 300));
}

/**
 * backendNodeId → a live Runtime objectId. This Edge build rejects
 * pushNodesByBackendIdsToFrontend/resolveNode until a DOM.getDocument has run
 * for the current document generation (cdp.ensure does one at attach and
 * Page.frameNavigated clears domFetched again), so refresh that first.
 * nodeId comes from the generation-cached flattened index snapshot.js builds
 * when a ref resolved this generation, else the classic push, else a
 * pierce:true flattened scan (same fallback order as resolveRef — subframe
 * documents do NOT appear in that scan on this build; frame refs act through
 * the bridge/coordinate path instead of ever reaching here).
 */
async function resolveObjectId(tabId, backendNodeId) {
  const st = cdp.buffers(tabId);
  if (!st || !st.domFetched || st.nodeDocGen !== st.gen) {
    await cdp.send(tabId, 'DOM.getDocument', { depth: 1 }).catch(() => null);
    if (st) st.nodeDocGen = st.gen;
  }
  let nodeId = null;
  const raw = st?.nodeIndex?.get?.(backendNodeId);
  if (raw != null) nodeId = typeof raw === 'object' ? raw.nodeId : raw;
  const fromIndex = nodeId != null;
  if (nodeId == null) {
    const pushed = await cdp
      .send(tabId, 'DOM.pushNodesByBackendIdsToFrontend', { backendNodeIds: [backendNodeId] })
      .catch((e) => rethrowNodeError(e));
    nodeId = pushed?.nodeIds?.[0];
  }
  if (nodeId == null) {
    const flat = await cdp.send(tabId, 'DOM.getFlattenedDocument', { depth: -1, pierce: true }).catch(() => null);
    for (const n of flat?.nodes || []) {
      if (n.backendNodeId === backendNodeId && n.nodeId != null) {
        nodeId = n.nodeId;
        break;
      }
    }
  }
  if (nodeId == null) {
    throw err('REF_STALE', 'that element is gone from the document (or its frame was destroyed); take a fresh snapshot');
  }
  let r;
  try {
    r = await cdp.send(tabId, 'DOM.resolveNode', { nodeId });
  } catch (e) {
    // F2 (LIVE-RESULTS-2 §5g): the generation-cached nodeId was reclaimed by
    // the DOM agent mid-generation while the element itself is still there.
    // Rebuild the index ONCE and retry once — not per action, not on success.
    if (!fromIndex || !STALE_NODE_MSG.test(String(e?.message || e))) rethrowNodeError(e);
    const m = await rebuildNodeIndex(tabId);
    const raw2 = m?.get?.(backendNodeId);
    const nid2 = raw2 == null ? null : typeof raw2 === 'object' ? raw2.nodeId : raw2;
    if (nid2 == null) {
      throw err('REF_STALE', 'that element is gone from the document (or its frame was destroyed); take a fresh snapshot');
    }
    try {
      r = await cdp.send(tabId, 'DOM.resolveNode', { nodeId: nid2 });
    } catch (e2) {
      if (STALE_NODE_MSG.test(String(e2?.message || e2))) {
        throw err(
          'REF_STALE',
          'the element is likely still in the document, but its cached DOM node handle was reclaimed and the fresh handle died again immediately (agent churn); repeat this action once — the node index was just rebuilt — or take a fresh snapshot',
        );
      }
      rethrowNodeError(e2);
    }
  }
  const objectId = r?.object?.objectId;
  if (!objectId) {
    throw err(
      'REF_STALE',
      'the node resolved but this Edge build gave no runtime handle for it (frame-scoped or vanished object); take a fresh snapshot — in-frame targets act through the bridge/coordinate path',
    );
  }
  return objectId;
}

/**
 * Run a page function with `this` bound to the element a ref points at.
 * The addressing chain is backendNodeId → nodeId → objectId (see
 * resolveObjectId): Runtime.callFunctionOn has NO backendNodeId parameter,
 * and CDP drops unknown keys — sending one leaves every identifier empty and
 * the call fails live with -32602 (offline stubs that skip validation let the
 * whole ref path pass 1000+ assertions while broken; fixed 2026-10 live pass).
 * DOM.setAttributeValue + document.querySelector (the old pattern in
 * lib/tools.js) cannot reach shadow DOM — querySelector never crosses a
 * shadow boundary — and stamps a dirty attribute into the user's page on the way.
 */
export async function callOnNode(tabId, backendNodeId, functionDeclaration, args = []) {
  if (backendNodeId == null) {
    throw err('REF_STALE', 'that ref carries no CDP-addressable DOM node (frame refs act through the bridge/coordinate path); take a fresh snapshot');
  }
  const objectId = await resolveObjectId(tabId, backendNodeId);
  let r;
  try {
    try {
      r = await cdp.send(tabId, 'Runtime.callFunctionOn', {
        objectId,
        functionDeclaration,
        arguments: args.map((value) => ({ value })),
        returnByValue: true,
        awaitPromise: true,
      });
      if (r?.exceptionDetails) {
        throw err(
          'EVAL_ERROR',
          truncate(r.exceptionDetails.exception?.description || r.exceptionDetails.text || 'page function threw', 300),
        );
      }
      return r.result?.value;
    } catch (e) {
      if (e && e.code) throw e;
      rethrowNodeError(e);
    }
  } finally {
    cdp.send(tabId, 'Runtime.releaseObject', { objectId }).catch(() => {});
  }
}

export async function mouse(tabId, type, x, y, opts = {}) {
  // Per-dispatch point confirmation (fix7-shield's exported hook): the gate can
  // re-close between a caller's confirmation and this command, which is exactly
  // the LIVE-RESULTS-2B 7g lie — confirmed ok, three events queued, veil back
  // on auto, page received nothing. assertInputGate re-proves the open pass
  // right here; a failed proof throws SHIELD_PASS_FAILED and this send NEVER
  // reaches the wire. No open pass = nothing to confirm (read-only callers and
  // un-armed tabs never pay), same semantics as lib/tools.js's gate.check().
  await assertInputGate(tabId);
  await cdp.send(tabId, `Input.dispatchMouseEvent`, {
    type,
    x,
    y,
    button: opts.button || 'left',
    buttons: opts.buttons ?? (type === 'mouseReleased' ? 1 : type === 'mousePressed' ? 1 : 0),
    clickCount: opts.clickCount || 1,
    modifiers: opts.modifiers || 0,
  });
}

export const KEY_MAP = {
  enter: '\r', tab: '\t', escape: '\x1b', backspace: '\x08', delete: '\x7f',
  arrowup: '\u2191', arrowdown: '\u2193', arrowleft: '\u2190', arrowright: '\u2192',
  home: '\u219b', end: '\u219f', pageup: '\u21de', pagedown: '\u21df',
};

export async function key(tabId, type, keyName, { modifiers = 0, code, text } = {}) {
  // same proof-per-dispatch as mouse(): key events are eaten by the capture
  // listeners of whichever world is alive in the document, so the transaction's
  // keys rule is re-checked before every Input.dispatchKeyEvent and a refused
  // confirmation throws before this send exists on the wire.
  await assertInputGate(tabId);
  const k = keyName.toLowerCase();
  const needsText = !/^(control|shift|alt|meta|enter|tab|escape|backspace|delete|arrowup|arrowdown|arrowleft|arrowright|home|end|pageup|pagedown)/.test(k);
  await cdp.send(tabId, 'Input.dispatchKeyEvent', {
    type,
    modifiers,
    key: keyName,
    code: code || (k.length === 1 ? 'Key' + keyName.toUpperCase() : keyName),
    windowsVirtualKeyCode: keyCodeOf(k),
    ...(type === 'keyDown' && needsText && !text ? { text: keyName } : {}),
    ...(text ? { text } : {}),
  });
}

export function keyCodeOf(k) {
  const map = { enter: 13, tab: 9, escape: 27, backspace: 8, delete: 46, arrowup: 38, arrowdown: 40, arrowleft: 37, arrowright: 39, home: 36, end: 35, pageup: 33, pagedown: 34, control: 17, shift: 16, alt: 18 };
  if (map[k] != null) return map[k];
  if (k.length === 1) return k.toUpperCase().charCodeAt(0);
  return 0;
}

export const MOD_BITS = { ctrl: 2, alt: 1, shift: 8, meta: 4, control: 2 };

export function modifierBits(list = []) {
  return (Array.isArray(list) ? list : [list]).reduce((acc, m) => acc + (MOD_BITS[String(m).toLowerCase()] || 0), 0);
}

export async function evalJs(tabId, expression, { world = 'main', awaitPromise = true, returnByValue = true } = {}) {
  if (world !== 'main' && world !== 'isolated') {
    throw err('BAD_PARAMS', `world must be "main" or "isolated" (got ${JSON.stringify(String(world))})`);
  }
  await cdp.ensure(tabId);
  const s = cdp.buffers(tabId);
  // Never answer a page dialog on behalf of the user: a read that silently
  // accepts "delete this?" is a destructive action disguised as sensing.
  if (s && s.dialogs.length) {
    throw err('DIALOG_OPEN', `a JS ${s.dialogs[0].type} dialog is blocking this tab — answer it explicitly with dialog.handle`, {
      dialogs: s.dialogs.map((d) => ({ type: d.type, message: String(d.message || '').slice(0, 200) })),
    });
  }
  let contextId;
  if (world === 'isolated') {
    if (!s?.frameId) {
      throw err('NO_FRAME_CONTEXT', 'isolated world needs a live main-frame context — the page is mid-navigation; retry after it settles');
    }
    const w = await cdp.send(tabId, 'Page.createIsolatedWorld', { frameId: s.frameId });
    contextId = w.executionContextId;
    if (contextId == null) {
      // Never fall back to MAIN: that silently upgrades a sandboxed read into
      // page-privileged execution.
      throw err('NO_FRAME_CONTEXT', 'the browser refused to create an isolated world — nothing was executed');
    }
  }
  const r = await cdp.send(tabId, 'Runtime.evaluate', {
    expression,
    awaitPromise,
    returnByValue,
    ...(contextId ? { contextId } : {}),
  });
  if (r.exceptionDetails) {
    throw err('EVAL_ERROR', r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  }
  return r.result?.value;
}

export async function armTab(tabId) {
  await shield.set(tabId, { mode: 'armed', label: 'UBB agent control' });
  // arm the foreign-extension iframe monitor (attach-conflict prophylaxis)
  chrome.tabs.sendMessage(tabId, { type: 'UBB_MONITOR', on: true }).catch(() => {});
}

// ---------------------------------------------------------------- misc

export function pack(shot, format, extra) {
  const bytes = Math.round((shot.data.length * 3) / 4);
  return { format, bytes, data_base64: shot.data, ...extra };
}

export function visibleExpr(selector) {
  return `(function(){try{var e=document.querySelector(${JSON.stringify(selector)});if(!e)return false;var r=e.getBoundingClientRect();var s=getComputedStyle(e);return r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none'}catch(_){return false}})()`;
}

export async function waitForLoad(tabId, timeoutMs) {
  const t0 = Date.now();
  // the OLD document still reads 'complete' while the new navigation is
  // pending — wait out the pre-commit window (pendingUrl) first, otherwise a
  // navigate to a slow page reports loaded:true against the stale document
  while (Date.now() - t0 < timeoutMs) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) return false;
    if (!tab.pendingUrl) break;
    await sleep(100);
  }
  while (Date.now() - t0 < timeoutMs) {
    const st = await evalJs(tabId, 'document.readyState').catch(() => null);
    if (st === 'complete') return true;
    await sleep(250);
  }
  return false;
}

// ---- CSV ----------------------------------------------------------------------

export function csvCell(v, safe) {
  if (v == null) return '';
  let s = String(v);
  // untrusted spreadsheet imports: neutralize formula-like leading chars
  if (safe && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
  if (/[",\n\r]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}

export function toCsv(extraction, safe) {
  const line = (cells) => cells.map((v) => csvCell(v, safe)).join(',');
  const lines = [];
  if (extraction.mode === 'list') {
    const cols = extraction.fields || [];
    lines.push(line(cols));
    for (const it of extraction.items || []) lines.push(line(cols.map((k) => it[k])));
  } else {
    for (const t of extraction.tables || []) {
      if (t.headers) lines.push(line(t.headers));
      for (const row of t.rows || []) lines.push(line(row));
      lines.push('');
    }
  }
  return lines.join('\r\n').replace(/[\r\n]+$/, '');
}

// ---- human-in-the-loop assistance --------------------------------------------

export async function checkConds(tabId, conds) {
  const detail = [];
  let all = conds.length > 0;
  for (const c of conds) {
    let ok = false;
    try {
      if (c.kind === 'url_contains') ok = ((await chrome.tabs.get(tabId)).url || '').includes(c.value);
      else if (c.kind === 'url_matches') ok = new RegExp(c.value).test((await chrome.tabs.get(tabId)).url || '');
      else if (c.kind === 'text_present') ok = !!(await evalJs(tabId, `document.body && document.body.innerText.includes(${JSON.stringify(c.value)})`).catch(() => false));
      else if (c.kind === 'element_visible') ok = !!(await evalJs(tabId, visibleExpr(c.value)).catch(() => false));
    } catch { ok = false; }
    detail.push({ kind: c.kind, value: c.value, satisfied: ok });
    if (!ok) all = false;
  }
  return { all, detail };
}

export async function runHelp(tabId, prompt, conds, timeoutMs, ctx, bringToFront) {
  const reqId = Math.random().toString(36).slice(2);
  const user = { done: false, ok: false };
  const settled = new Promise((resolve) => pendingHelp.set(reqId, { resolve: (ok) => { user.done = true; user.ok = !!ok; resolve(); } }));
  if (bringToFront !== false) {
    // a request for human attention that the user cannot see is useless
    try {
      await chrome.tabs.update(tabId, { active: true });
      const t = await chrome.tabs.get(tabId);
      if (t.windowId) await chrome.windows.update(t.windowId, { focused: true });
    } catch {}
  }
  await shield.help(tabId, { reqId, title: prompt, timeoutMs });
  const t0 = Date.now();
  try {
    while (Date.now() - t0 < timeoutMs) {
      if (ctx?.signal?.aborted) {
        await shield.helpClose(tabId, reqId).catch(() => {});
        return { outcome: 'aborted' };
      }
      if (user.done) {
        await shield.helpClose(tabId, reqId).catch(() => {});
        return user.ok
          ? { outcome: 'completed', note: 'user clicked 完成' }
          : { outcome: 'cancelled' };
      }
      if (conds.length) {
        const s = await checkConds(tabId, conds);
        if (s.all) {
          await shield.helpClose(tabId, reqId).catch(() => {});
          return { outcome: 'completed', conditions: s.detail };
        }
      }
      await Promise.race([settled, sleep(600)]);
    }
    await shield.helpClose(tabId, reqId).catch(() => {});
    const s = conds.length ? await checkConds(tabId, conds) : null;
    return { outcome: 'timed_out', ...(s ? { conditions: s.detail } : {}) };
  } finally {
    pendingHelp.delete(reqId);
  }
}

// Passthroughs: tool modules take the whole shared surface from one place so
// nobody re-declares a private copy of a security-relevant helper.
export {
  cdp,
  refs,
  takeSnapshot,
  resolveRef,
  sessions,
  shield,
  withPass,
  withHiddenShield,
  sleep,
  pendingHelp,
  bridge,
  audit,
  redact,
  redactUrl,
  truncate,
  err,
};
