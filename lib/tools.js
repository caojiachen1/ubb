// UBB tool implementations — the union of the four products' best tools.
// Security rules (Qoder): password/OTP fields are never auto-filled,
// dangerous labels require params.confirm, results pass through redaction.

import { cdp } from './cdp.js';
import { refs } from './refs.js';
import { takeSnapshot, resolveRef } from './snapshot.js';
import { sessions, normalizeUrl } from './tabs.js';
import { shield, withPass, withHiddenShield, sleep } from './shield-ctl.js';
import { bridge } from './bridge-ctl.js';
import { audit } from './audit.js';
import { redact, redactUrl, truncate } from './redact.js';
import * as human from './human.js';
import {
  err,
  DEFAULT_TOOL_TIMEOUT_MS,
  SCREENSHOT_TOOL_TIMEOUT_MS,
  TRACE_TOOL_TIMEOUT_MS,
} from './config.js';

const DANGEROUS_LABEL =
  /(删除|移除|注销|支付|付款|购买|转账|结算|delete|remove|uninstall|pay\b|purchase|checkout|transfer\b|unsubscribe)/i;

const SENSITIVE_FIELD =
  /(password|passwd|密码|otp|one[-\s]?time|验证码|cvv|cvc|card.?number|卡号|secret|私钥)/i;

// ---------------------------------------------------------------- helpers

function targetTab(params) {
  const s = sessions.active();
  if (!s) throw err('NO_SESSION', 'no active session; call session.start first');
  const tabId = params.tab_id ?? s.lastTabId;
  if (tabId == null) throw err('NO_TAB', 'no tab yet; call tab.create first');
  if (!sessions.owns(tabId)) {
    throw err('TAB_NOT_OWNED', `tab ${tabId} is not owned by this session; use tab.claim to take it`);
  }
  s.lastTabId = tabId;
  sessions.touch(); // fire-and-forget persist
  return tabId;
}

async function attrsOf(tabId, nodeId) {
  const r = await cdp.send(tabId, 'DOM.getAttributes', { nodeId }).catch(() => null);
  const flat = r?.attributes || [];
  const out = {};
  for (let i = 0; i + 1 < flat.length; i += 2) out[flat[i].toLowerCase()] = flat[i + 1];
  return out;
}

async function guardSensitiveField(tabId, nodeId, meta) {
  const a = await attrsOf(tabId, nodeId);
  const hay = [a.type, a.autocomplete, a.name, a.id, a.placeholder, a['aria-label'], meta?.name].join(' ');
  if (a.type === 'password' || a.autocomplete?.includes('one-time-code') || SENSITIVE_FIELD.test(hay)) {
    throw err(
      'SENSITIVE_FIELD',
      'this looks like a password / OTP / payment field — UBB never auto-fills it; ask the user to type it',
    );
  }
}

async function mouse(tabId, type, x, y, opts = {}) {
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

const KEY_MAP = {
  enter: '\r', tab: '\t', escape: '\x1b', backspace: '\x08', delete: '\x7f',
  arrowup: '\u2191', arrowdown: '\u2193', arrowleft: '\u2190', arrowright: '\u2192',
  home: '\u219b', end: '\u219f', pageup: '\u21de', pagedown: '\u21df',
};

async function key(tabId, type, keyName, { modifiers = 0, code, text } = {}) {
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

function keyCodeOf(k) {
  const map = { enter: 13, tab: 9, escape: 27, backspace: 8, delete: 46, arrowup: 38, arrowdown: 40, arrowleft: 37, arrowright: 39, home: 36, end: 35, pageup: 33, pagedown: 34, control: 17, shift: 16, alt: 18 };
  if (map[k] != null) return map[k];
  if (k.length === 1) return k.toUpperCase().charCodeAt(0);
  return 0;
}

const MOD_BITS = { ctrl: 2, alt: 1, shift: 8, meta: 4, control: 2 };

function modifierBits(list = []) {
  return (Array.isArray(list) ? list : [list]).reduce((acc, m) => acc + (MOD_BITS[String(m).toLowerCase()] || 0), 0);
}

async function evalJs(tabId, expression, { world = 'main', awaitPromise = true, returnByValue = true } = {}) {
  const s = cdp.buffers(tabId);
  // A blocking dialog wedges evaluate — clear oldest non-alert first.
  if (s && s.dialogs.length) {
    await cdp.send(tabId, 'Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
    s.dialogs.shift();
  }
  let contextId;
  if (world === 'isolated' && s?.frameId) {
    const w = await cdp.send(tabId, 'Page.createIsolatedWorld', { frameId: s.frameId });
    contextId = w.executionContextId;
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

async function armTab(tabId) {
  await shield.set(tabId, { mode: 'armed', label: 'UBB agent control' });
  // arm the foreign-extension iframe monitor (attach-conflict prophylaxis)
  chrome.tabs.sendMessage(tabId, { type: 'UBB_MONITOR', on: true }).catch(() => {});
}

// ---------------------------------------------------------------- registration

export function registerTools(dispatcher) {
  const R = (name, meta, fn) => dispatcher.register(name, meta, fn);

  // ---- session & tabs ------------------------------------------------------
  R('session.start', { category: 'session', description: 'Start an agent session. Agent tabs are auto-grouped into the UBB tab group (no new window).' }, async () => {
    const r = await sessions.start();
    return redact(r);
  });

  R('session.stop', { category: 'session', description: 'End the session; group is marked ✅, created tabs closed (or kept with close_created=false), claimed tabs returned.' }, async (p) => {
    const r = await sessions.stop({ close_created: p.close_created !== false });
    return redact(r);
  });

  R('session.status', { category: 'session', description: 'Active session info.' }, async () => {
    const s = sessions.active();
    if (!s) return { active: false };
    return {
      active: true,
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

  R('tab.create', { category: 'tabs', description: 'Create a tab inside the UBB group (auto-starts session if needed).' }, async (p = {}) => {
    if (!sessions.active()) await sessions.start();
    const r = await sessions.createTab(p.url || 'about:blank', { active: p.active !== false });
    await armTab(r.tab_id);
    return r;
  });

  R('tab.close', { category: 'tabs', description: 'Close a session-owned tab.' }, async (p) => {
    const tabId = p.tab_id ?? targetTab(p);
    if (!sessions.owns(tabId)) throw err('TAB_NOT_OWNED', 'only session tabs can be closed');
    await chrome.tabs.remove(tabId).catch(() => {});
    sessions.active()?.created.delete(tabId);
    await sessions.touch();
    return { closed: tabId };
  });

  R('tab.select', { category: 'tabs', description: 'Bring a session tab to front.' }, async (p) => {
    const tabId = p.tab_id ?? targetTab(p);
    if (!sessions.owns(tabId)) throw err('TAB_NOT_OWNED', 'claim the tab first');
    await chrome.tabs.update(tabId, { active: true });
    return { selected: tabId };
  });

  R('tab.claim', { category: 'tabs', description: 'Take over an existing user tab (shows an Allow/Deny banner on the page, default deny) and move it into the UBB group.' }, async (p) => {
    if (!sessions.active()) await sessions.start();
    const tabId = p.tab_id;
    if (typeof tabId !== 'number') throw err('BAD_PARAMS', 'tab_id required');
    const ok = await shield.confirm(tabId, 'UBB agent 请求接管此标签页（并入 UBB 分组并受控）', 60000);
    if (!ok) throw err('CLAIM_DENIED', 'user denied the takeover (or tab unreachable)');
    const r = await sessions.attachClaimed(tabId);
    await armTab(tabId);
    return r;
  });

  R('tab.release', { category: 'tabs', description: 'Return a claimed tab to the user (removed from the group).' }, async (p) => {
    const tabId = p.tab_id;
    if (typeof tabId !== 'number') throw err('BAD_PARAMS', 'tab_id required');
    const r = await sessions.release(tabId);
    await shield.disarm(tabId);
    return r;
  });

  // ---- navigation -----------------------------------------------------------
  R('navigate', { category: 'navigation', description: 'Navigate the target tab. Auto-prepends https:// when no scheme.' }, async (p) => {
    const tabId = targetTab(p);
    const url = normalizeUrl(p.url);
    if (cdp.isRestrictedUrl(url)) throw err('URL_BLOCKED', `blocked URL: ${url}`);
    await chrome.tabs.update(tabId, { url });
    const done = await waitForLoad(tabId, p.timeout_ms || 20000);
    const t = await chrome.tabs.get(tabId);
    return { navigated: true, loaded: done, url: redactUrl(t.url), title: truncate(t.title, 200) };
  });

  async function historyJump(tabId, delta) {
    await cdp.ensure(tabId);
    const h = await cdp.send(tabId, 'Page.getNavigationHistory');
    const target = h.currentIndex + delta;
    if (target >= 0 && target < (h.entries?.length || 0)) {
      // chrome.tabs.goBack is a no-op while a debugger is attached on Edge —
      // navigate the history entry directly (TraeWork's approach)
      await cdp.send(tabId, 'Page.navigateToHistoryEntry', { entryId: h.entries[target].id });
      await waitForLoad(tabId, 10000);
    }
    return { url: redactUrl((await chrome.tabs.get(tabId)).url) };
  }

  R('go_back', { category: 'navigation' }, async (p) => historyJump(targetTab(p), -1));

  R('go_forward', { category: 'navigation' }, async (p) => historyJump(targetTab(p), +1));

  R('reload', { category: 'navigation' }, async (p) => {
    const tabId = targetTab(p);
    await chrome.tabs.reload(tabId);
    await waitForLoad(tabId, 20000);
    return { reloaded: true };
  });

  // ---- interaction ------------------------------------------------------------
  R('click', { category: 'interaction', description: 'Click an element by @eN ref (or coordinates). Dangerous labels need confirm:true.' }, async (p) => {
    const tabId = targetTab(p);
    if (p.selector) {
      await bridge(tabId, 'clickDom', { selector: p.selector });
      audit.log({ action: 'click', tabId, target: p.selector, via: 'selector' });
      return { clicked: p.selector, via: 'selector' };
    }
    if (typeof p.x === 'number' && typeof p.y === 'number') {
      const clicks = p.double ? 2 : 1;
      await withPass(tabId, async () => {
        if (await human.isEnabled()) {
          await human.humanClick(tabId, { x: p.x - 6, y: p.y - 6, width: 12, height: 12, cx: p.x, cy: p.y }, { clickCount: clicks, button: p.button || 'left' });
          return;
        }
        await mouse(tabId, 'mouseMoved', p.x, p.y);
        await mouse(tabId, 'mousePressed', p.x, p.y, { clickCount: clicks, button: p.button || 'left' });
        await sleep(30);
        await mouse(tabId, 'mouseReleased', p.x, p.y, { clickCount: clicks, button: p.button || 'left' });
      });
      audit.log({ action: 'click', tabId, at: [p.x, p.y], via: 'coords' });
      return { clicked: [p.x, p.y], via: 'coords' };
    }
    if (typeof p.ref === 'string' && p.ref.startsWith('@d')) {
      // DOM-fallback ref (from find / dom-fallback snapshot) → real .click()
      await bridge(tabId, 'clickDom', { ref: p.ref });
      audit.log({ action: 'click', tabId, target: p.ref, via: 'dom' });
      return { clicked: p.ref, via: 'dom' };
    }
    const { nodeId, box, meta } = await resolveRef(tabId, p.ref);
    if (DANGEROUS_LABEL.test(meta?.name || '') && p.confirm !== true) {
      throw err('NEEDS_CONFIRM', `"${meta.name}" looks like a destructive/paid action — retry with confirm:true after asking the user`);
    }
    const clicks = p.double ? 2 : 1;
    const humanOn = await human.isEnabled();
    const input = withPass(tabId, async () => {
      if (humanOn) {
        await human.humanClick(tabId, box, { clickCount: clicks, button: p.button || 'left' });
        return;
      }
      await mouse(tabId, 'mouseMoved', box.cx, box.cy);
      await mouse(tabId, 'mousePressed', box.cx, box.cy, { clickCount: clicks, button: p.button || 'left' });
      await sleep(30);
      await mouse(tabId, 'mouseReleased', box.cx, box.cy, { clickCount: clicks, button: p.button || 'left' });
    });
    // if the click opens a BLOCKING dialog, the input command's ack never
    // returns — race it and report the dialog instead of hanging
    const stalled = await Promise.race([input.then(() => null), sleep(3000).then(() => true)]);
    const openDialogs = cdp.buffers(tabId)?.dialogs || [];
    if (stalled && openDialogs.length) {
      audit.log({ action: 'click', tabId, target: meta?.name, dialog: true });
      return {
        clicked: p.ref,
        target: meta?.name,
        dialog_opened: openDialogs,
        note: 'a JS dialog is blocking the page — answer it with dialog.handle',
      };
    }
    await input.catch(() => {});
    audit.log({ action: 'click', tabId, target: meta?.name });
    return { clicked: p.ref, at: [Math.round(box.cx), Math.round(box.cy)], target: meta?.name };
  });

  R('hover', { category: 'interaction' }, async (p) => {
    const tabId = targetTab(p);
    const { box, meta } = await resolveRef(tabId, p.ref);
    await withPass(tabId, () => mouse(tabId, 'mouseMoved', box.cx, box.cy));
    return { hovered: meta?.name || p.ref };
  });

  R('fill', { category: 'interaction', description: 'Set the value of a form field (React/Vue-safe native setter). Password/OTP fields are refused.' }, async (p) => {
    const tabId = targetTab(p);
    if (typeof p.ref === 'string' && p.ref.startsWith('@d')) {
      await bridge(tabId, 'fillDom', { ref: p.ref, value: p.value });
      audit.log({ action: 'fill', tabId, target: p.ref, via: 'dom' });
      return { filled: p.ref, via: 'dom' };
    }
    if (p.ref) {
      const { nodeId, meta } = await resolveRef(tabId, p.ref);
      await guardSensitiveField(tabId, nodeId, meta);
      await withPass(tabId, async () => {
        // deterministic REPLACE: synthetic ctrl+A is unreliable on some
        // inputs — select the existing text from page JS instead
        await cdp.send(tabId, 'DOM.setAttributeValue', { nodeId, name: 'data-ubb-tmp', value: '1' });
        await evalJs(tabId, `(function(){var el=document.querySelector('[data-ubb-tmp]');el.removeAttribute('data-ubb-tmp');el.focus();try{el.setSelectionRange(0,(el.value||'').length)}catch(e){}})()`);
        if (await human.isEnabled()) {
          await human.humanType(tabId, p.value);
        } else {
          await cdp.send(tabId, 'Input.insertText', { text: String(p.value ?? '') });
        }
        if (p.press_enter) {
          await key(tabId, 'keyDown', 'Enter');
          await key(tabId, 'keyUp', 'Enter');
        }
      });
      audit.log({ action: 'fill', tabId, target: meta?.name });
      return { filled: p.ref, target: meta?.name };
    }
    // DOM-fallback path
    const r = await bridge(tabId, 'fillDom', { selector: p.selector, value: p.value, sensitive: false });
    return { filled: p.selector || 'selector' };
  });

  R('fill_form', { category: 'interaction', description: 'Batch fill {ref: value}. Sensitive fields are refused individually.' }, async (p) => {
    const tabId = targetTab(p);
    const pairs = Object.entries(p.values || {});
    const done = [];
    for (const [ref, value] of pairs) {
      const { nodeId, meta } = await resolveRef(tabId, ref);
      await guardSensitiveField(tabId, nodeId, meta);
      await withPass(tabId, async () => {
        await cdp.send(tabId, 'DOM.focus', { nodeId });
        await cdp.send(tabId, 'Input.insertText', { text: String(value) });
      });
      done.push(ref);
    }
    return { filled: done };
  });

  R('type', { category: 'interaction', description: 'Type text into the currently focused element (optionally press Enter).' }, async (p) => {
    const tabId = targetTab(p);
    await withPass(tabId, async () => {
      if (await human.isEnabled()) {
        await human.humanType(tabId, p.text);
      } else {
        await cdp.send(tabId, 'Input.insertText', { text: String(p.text ?? '') });
      }
      if (p.press_enter) {
        await key(tabId, 'keyDown', 'Enter');
        await key(tabId, 'keyUp', 'Enter');
      }
    });
    return { typed: true };
  });

  R('press_key', { category: 'interaction', description: 'Press a key with optional modifiers, e.g. key:"s" modifiers:["ctrl"].' }, async (p) => {
    const tabId = targetTab(p);
    if (!p.key) throw err('BAD_PARAMS', 'key required');
    const mods = modifierBits(p.modifiers);
    await withPass(tabId, async () => {
      await key(tabId, 'keyDown', p.key, { modifiers: mods });
      await key(tabId, 'keyUp', p.key, { modifiers: mods });
    });
    return { pressed: p.key, modifiers: p.modifiers || [] };
  });

  R('scroll', { category: 'interaction', description: 'Scroll page or element. direction up|down, amount in px (default 600). Provide ref to scroll an element into view instead.' }, async (p) => {
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
      try {
        if (await human.isEnabled()) {
          await withPass(tabId, () => human.humanScrollChunks(tabId, dir, dir * amount));
        } else {
        await withPass(tabId, () =>
          cdp.send(tabId, 'Input.dispatchMouseEvent', {
            type: 'mouseWheel',
            x: 400, y: 400,
            deltaX: 0, deltaY: dir * amount,
          }),
        );
        }
        await sleep(120);
        after = await evalJs(tabId, 'window.scrollY').catch(() => after);
      } catch {}
    }
    return { scrolled: after - before, scrolled_to: after };
  });

  R('drag', { category: 'interaction', description: 'Drag from ref/coords `from` to ref/coords `to` in 10 interpolated steps.' }, async (p) => {
    const tabId = targetTab(p);
    const pt = async (t) => {
      if (t.ref) return (await resolveRef(tabId, t.ref)).box;
      if (typeof t.x === 'number' && typeof t.y === 'number') {
        return { cx: t.x, cy: t.y };
      }
      throw err('BAD_PARAMS', 'from/to need ref or x/y');
    };
    const a = await pt(p.from || {});
    const b = await pt(p.to || {});
    await withPass(tabId, async () => {
      await mouse(tabId, 'mousePressed', a.cx, a.cy);
      const hum = await human.isEnabled();
      const steps = hum ? 14 : 10;
      for (let i = 1; i <= steps; i++) {
        const x = a.cx + ((b.cx - a.cx) * i) / steps + (hum ? (Math.random() - 0.5) * 4 : 0);
        const y = a.cy + ((b.cy - a.cy) * i) / steps + (hum ? (Math.random() - 0.5) * 4 : 0);
        await mouse(tabId, 'mouseMoved', x, y, { buttons: 1 });
        await sleep(hum ? 14 + Math.round(Math.random() * 18) : 16);
      }
      await sleep(hum ? 40 : 0);
      await mouse(tabId, 'mouseReleased', b.cx, b.cy);
    });
    return { dragged: true };
  });

  R('upload_file', { category: 'interaction', description: 'Set local files on a file input by @eN ref.' }, async (p) => {
    const tabId = targetTab(p);
    const files = (Array.isArray(p.files) ? p.files : [p.file]).filter(Boolean);
    if (!files.length) throw err('BAD_PARAMS', 'files required');
    const { nodeId } = await resolveRef(tabId, p.ref);
    await cdp.send(tabId, 'DOM.setFileInputFiles', { nodeId, files });
    audit.log({ action: 'upload_file', tabId, files: files.map((f) => String(f).split(/[\\/]/).pop()) });
    return { uploaded: files.length };
  });

  R('download', { category: 'interaction', description: 'Download a URL (or the href behind an @eN ref) via chrome.downloads.' }, async (p) => {
    const tabId = targetTab(p);
    let url = p.url;
    if (!url && p.ref) {
      const { nodeId } = await resolveRef(tabId, p.ref);
      const a = await attrsOf(tabId, nodeId);
      url = a.href || a.src;
    }
    if (!url) throw err('BAD_PARAMS', 'url (or a ref with href/src) required');
    const id = await chrome.downloads.download({ url, saveAs: false });
    return { download_id: id, url: redactUrl(url) };
  });

  // ---- sensing ---------------------------------------------------------------
  R('snapshot', { category: 'sensing', description: 'Accessibility-tree snapshot with @eN refs (filter: interactive|all, max_chars). Fallback to DOM tree when AX is empty.' }, async (p = {}) => {
    const tabId = targetTab(p);
    await cdp.ensure(tabId);
    const r = await takeSnapshot(tabId, { filter: p.filter || 'interactive', max_chars: p.max_chars || 60000 });
    audit.log({ action: 'snapshot', tabId, refs: r.ref_count });
    return r;
  });

  R('read_page', { category: 'sensing', description: 'Main-content plain text extraction (article/main heuristics).' }, async (p = {}) => {
    const tabId = targetTab(p);
    const r = await bridge(tabId, 'getPageText', { max_chars: p.max_chars || 50000 });
    return { text: truncate(r.text, p.max_chars || 50000), url: redactUrl(r.url), title: truncate(r.title, 200) };
  });

  R('get_html', { category: 'sensing' }, async (p = {}) => {
    const tabId = targetTab(p);
    await cdp.ensure(tabId);
    const html = await evalJs(tabId, 'document.documentElement.outerHTML');
    return { html: truncate(html, p.max_chars || 100000) };
  });

  R('find', { category: 'sensing', description: 'Keyword search over visible elements; returns matches with @eN refs where possible.' }, async (p = {}) => {
    const tabId = targetTab(p);
    const r = await bridge(tabId, 'search', { query: p.query, limit: p.limit || 10 }).catch(() => null);
    if (!r) {
      const snap = await takeSnapshot(tabId, { filter: 'all', max_chars: 200000 });
      const lines = snap.text.split('\n').filter((l) => l.toLowerCase().includes(String(p.query || '').toLowerCase()));
      return { matches: lines.slice(0, p.limit || 10).map((l) => ({ line: l.trim() })), source: 'snapshot' };
    }
    return { matches: r.matches, source: 'dom' };
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

  R('wait_for', { category: 'sensing', description: 'Wait for a condition: text_present|text_gone|element_visible|element_hidden|url_contains|url_matches|navigation|network_idle|timeout (ms).' }, async (p) => {
    const tabId = targetTab(p);
    const kind = p.condition || 'timeout';
    const timeout = p.timeout_ms || 15000;
    const t0 = Date.now();
    const check = async () => {
      switch (kind) {
        case 'timeout': return true;
        case 'text_present': return !!(await evalJs(tabId, `document.body.innerText.includes(${JSON.stringify(p.text||'')})`).catch(() => false));
        case 'text_gone': return !(await evalJs(tabId, `document.body.innerText.includes(${JSON.stringify(p.text||'')})`).catch(() => true));
        case 'element_visible': return !!(await evalJs(tabId, visibleExpr(p.selector)).catch(() => false));
        case 'element_hidden': return !(await evalJs(tabId, visibleExpr(p.selector)).catch(() => false));
        case 'url_contains': return (await chrome.tabs.get(tabId)).url.includes(p.value || '');
        case 'url_matches': return new RegExp(p.value || '').test((await chrome.tabs.get(tabId)).url);
        case 'navigation':
          // a freshly created tab is 'complete' while still about:blank —
          // require a real http(s) document that finished loading
          return (
            (await evalJs(tabId, 'document.readyState + " " + location.protocol').catch(() => '')) ===
            'complete http:'
          ) || (
            (await evalJs(tabId, 'document.readyState + " " + location.protocol').catch(() => '')) ===
            'complete https:'
          );
        case 'network_idle': {
          const b = cdp.buffers(tabId);
          if (!b) return false;
          const now = Date.now();
          return !b.net.slice(-5).some((r) => now - r.t < 800);
        }
        default: throw err('BAD_PARAMS', `unknown condition "${kind}"`);
      }
    };
    if (kind === 'timeout') { await sleep(Math.min(p.timeout_ms || 1000, 60000)); return { ok: true, waited_ms: p.timeout_ms || 1000 }; }
    while (Date.now() - t0 < timeout) {
      if (await check()) return { ok: true, condition: kind, waited_ms: Date.now() - t0 };
      await sleep(300);
    }
    throw err('WAIT_TIMEOUT', `condition "${kind}" not met within ${timeout}ms`);
  });

  // ---- console & network -------------------------------------------------------
  R('console.list', { category: 'diagnostics' }, async (p = {}) => {
    const tabId = targetTab(p);
    await cdp.ensure(tabId);
    const b = cdp.buffers(tabId);
    let list = b ? b.console : [];
    if (p.only_errors) list = list.filter((c) => c.type === 'error');
    if (p.pattern) list = list.filter((c) => new RegExp(p.pattern, 'i').test(c.text));
    if (p.clear && b) b.console = [];
    return { messages: list.slice(-(p.limit || 50)).map((c) => ({ type: c.type, text: truncate(c.text, 2000) })) };
  });

  R('network.list', { category: 'diagnostics' }, async (p = {}) => {
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
        await cdp.send(tabId, 'Emulation.setDeviceMetricsOverride', {
          width: Math.ceil(cs.width), height: Math.ceil(cs.height), deviceScaleFactor: 1, mobile: false,
        });
        await sleep(120);
        try {
          const shot = await cdp.send(tabId, 'Page.captureScreenshot', { format, quality, captureBeyondViewport: true });
          return pack(shot, format, { full_page: true, width: Math.ceil(cs.width), height: Math.ceil(cs.height) });
        } finally {
          await cdp.send(tabId, 'Emulation.clearDeviceMetricsOverride').catch(() => {});
        }
      }
      const shot = await cdp.send(tabId, 'Page.captureScreenshot', { format, quality, ...(clip ? { clip } : {}) });
      return pack(shot, format, clip ? { ref: p.ref } : { viewport: true });
    });
  });

  // ---- dialogs --------------------------------------------------------------------
  R('dialog.status', { category: 'diagnostics' }, async (p) => {
    const tabId = targetTab(p);
    const b = cdp.buffers(tabId);
    return { open: b ? b.dialogs : [] };
  });

  R('dialog.handle', { category: 'diagnostics' }, async (p) => {
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

  R('window.minimize', { category: 'tabs' }, async (p) => {
    const tabId = targetTab(p);
    const tab = await chrome.tabs.get(tabId);
    await chrome.windows.update(tab.windowId, { state: 'minimized' });
    return { minimized: true };
  });

  R('window.restore', { category: 'tabs' }, async (p) => {
    const tabId = targetTab(p);
    const tab = await chrome.tabs.get(tabId);
    await chrome.windows.update(tab.windowId, { state: 'normal', focused: true });
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

  R('history.list', { category: 'diagnostics', description: 'Browser history search (URLs redacted).' }, async (p = {}) => {
    const items = await chrome.history.search({
      text: p.query || '',
      maxResults: Math.min(p.limit || 20, 100),
      ...(p.since_hours ? { startTime: Date.now() - p.since_hours * 3600e3 } : {}),
    });
    return { items: items.map((i) => ({ title: truncate(i.title, 100), url: redactUrl(i.url), last_visit: new Date(i.lastVisitTime).toISOString() })) };
  });

  // ---- emulation -------------------------------------------------------------------
  R('emulate', { category: 'emulation', description: 'Emulate viewport {width,height}, user_agent, media (print|screen|dark), geolocation {lat,lng}, network preset (offline|slow3g|fast3g|none), cpu_throttle (multiplier).' }, async (p) => {
    const tabId = targetTab(p);
    await cdp.ensure(tabId);
    if (p.viewport) {
      await cdp.send(tabId, 'Emulation.setDeviceMetricsOverride', { width: p.viewport.width || 1280, height: p.viewport.height || 800, deviceScaleFactor: 1, mobile: !!p.viewport.mobile });
    }
    if (p.user_agent) await cdp.send(tabId, 'Emulation.setUserAgentOverride', { userAgent: p.user_agent });
    if (p.media) await cdp.send(tabId, 'Emulation.setEmulatedMedia', { media: p.media });
    if (p.geolocation) await cdp.send(tabId, 'Emulation.setGeolocationOverride', { latitude: p.geolocation.lat, longitude: p.geolocation.lng, accuracy: 100 });
    if (p.network && p.network !== 'none') {
      const presets = {
        offline: { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 },
        slow3g: { latency: 400, downloadThroughput: 50 * 1024, uploadThroughput: 20 * 1024 },
        fast3g: { latency: 150, downloadThroughput: 180 * 1024, uploadThroughput: 84 * 1024 },
      };
      await cdp.send(tabId, 'Network.emulateNetworkConditions', presets[p.network] || presets.none || { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    } else if (p.network === 'none') {
      await cdp.send(tabId, 'Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }).catch(() => {});
    }
    if (p.cpu_throttle) await cdp.send(tabId, 'Emulation.setCPUThrottlingRate', { rate: p.cpu_throttle });
    return { emulated: Object.keys(p).filter((k) => k !== 'tab_id') };
  });

  R('emulate.reset', { category: 'emulation' }, async (p) => {
    const tabId = targetTab(p);
    await cdp.ensure(tabId);
    await cdp.send(tabId, 'Emulation.clearDeviceMetricsOverride').catch(() => {});
    await cdp.send(tabId, 'Emulation.clearGeolocationOverride').catch(() => {});
    await cdp.send(tabId, 'Emulation.setEmulatedMedia', { media: '' }).catch(() => {});
    await cdp.send(tabId, 'Emulation.setCPUThrottlingRate', { rate: 1 }).catch(() => {});
    await cdp.send(tabId, 'Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }).catch(() => {});
    return { reset: true };
  });

  // ---- performance trace (TraeWork-style, via Tracing domain on the debuggee) ------
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

  R('perf.stop', { category: 'diagnostics', timeoutMs: TRACE_TOOL_TIMEOUT_MS }, async (p) => {
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
    await cdp.send(tabId, 'Tracing.end').catch(() => {});
    return promise;
  });

  R('form.set', { category: 'interaction', description: 'Set form controls: action check|uncheck|toggle (checkbox/radio, physical CDP click), select_option for <select> (by value or text, native React-safe setter).' }, async (p) => {
    const tabId = targetTab(p);
    const action = String(p.action || 'toggle');
    const value = String(p.value ?? '');

    if (action === 'select_option') {
      const { nodeId, meta } = await resolveRef(tabId, p.ref);
      // tag the node from the DOM domain (works reliably), then drive it from
      // page JS — sidesteps DOM.resolveNode entirely on this Edge build
      await cdp.send(tabId, 'DOM.setAttributeValue', { nodeId, name: 'data-ubb-tmp', value: '1' });
      const v = await evalJs(tabId, `(function(){
        var el = document.querySelector('[data-ubb-tmp]');
        el.removeAttribute('data-ubb-tmp');
        var want = ${JSON.stringify(value)};
        var opt = Array.from(el.options).find(function(o){ return o.value === want || o.textContent.trim() === want; });
        if (!opt) throw new Error('option not found: ' + want);
        Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(el, opt.value);
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { selected: opt.textContent.trim() };
      })()`);
      audit.log({ action: 'form.set', tabId, target: meta?.name, op: 'select_option' });
      return { set: p.ref, result: v };
    }

    // check / uncheck / toggle → read state from the AX domain, click physically if needed
    const entry = refs.get(tabId, p.ref);
    const { box, meta } = await resolveRef(tabId, p.ref);
    let checked = null;
    try {
      const ax = await cdp.send(tabId, 'Accessibility.getPartialAXTree', { backendNodeId: entry.backendNodeId });
      const props = ax?.nodes?.[0]?.properties || [];
      const c = props.find((x) => x.name === 'checked');
      // AX property values arrive typed; "false" as a string is truthy —
      // interpret strictly
      const raw = c?.value?.value;
      checked = raw === true || raw === 'true' ? true : raw === 'mixed' ? null : raw === undefined ? null : false;
    } catch {}
    const want = action === 'toggle' ? (checked === null ? null : !checked) : action === 'check';
    if (checked === null || checked !== want) {
      await withPass(tabId, async () => {
        await mouse(tabId, 'mouseMoved', box.cx, box.cy);
        await mouse(tabId, 'mousePressed', box.cx, box.cy);
        await sleep(30);
        await mouse(tabId, 'mouseReleased', box.cx, box.cy);
      });
    }
    audit.log({ action: 'form.set', tabId, target: meta?.name, op: action });
    return { set: p.ref, was_checked: checked, clicked: checked === null || checked !== want };
  });

  // ---- guarded raw CDP (Qoder tab_cdp_call parity: read set open, write set needs confirm) ----
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
  R('cdp.call', { category: 'diagnostics', sensitive: true, description: 'Whitelisted raw CDP command on the target tab. Read set is open; write set (Input/Page/Emulation) needs confirm:true.' }, async (p) => {
    const tabId = targetTab(p);
    if (!p.method) throw err('BAD_PARAMS', 'method required');
    const isRead = CDP_READ.has(p.method);
    const isWrite = CDP_WRITE.has(p.method);
    if (!isRead && !isWrite) throw err('CDP_METHOD_BLOCKED', `method not whitelisted; read: ${[...CDP_READ].slice(0, 4).join(', ')}…; write: ${[...CDP_WRITE].slice(0, 4).join(', ')}…`);
    if (isWrite && p.confirm !== true) throw err('NEEDS_CONFIRM', 'write-class CDP methods need confirm:true');
    await cdp.ensure(tabId);
    const result = await cdp.send(tabId, p.method, p.params || {});
    audit.log({ action: 'cdp.call', tabId, method: p.method, write: isWrite });
    return { method: p.method, result: redact(result) };
  });

  // ---- pull-mode screencast (TraeWork preview.*/Qoder screencast parity) ----
  const screencasts = new Map(); // tabId → { frames: [{sessionId, seq, data, w, h}], running }
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

  R('screencast.start', { category: 'capture', description: 'Start a JPEG screencast on the tab; pull frames with screencast.next (backpressure: a frame is acked only when you pull it).' }, async (p = {}) => {
    const tabId = targetTab(p);
    await cdp.ensure(tabId);
    await cdp.send(tabId, 'Page.startScreencast', {
      format: 'jpeg',
      quality: Math.min(Math.max(p.quality ?? 60, 10), 90),
      maxWidth: p.max_width ?? 960,
      maxHeight: p.max_height ?? 640,
      everyNthFrame: 1,
    });
    screencasts.set(tabId, { frames: [], running: true, visible: true });
    return { started: true, note: 'call screencast.next to pull frames; screencast.stop when done' };
  });

  R('screencast.next', { category: 'capture', timeoutMs: 15000, description: 'Pull the next screencast frame (waits up to wait_ms). Acks it to the browser.' }, async (p = {}) => {
    const tabId = targetTab(p);
    const sc = screencasts.get(tabId);
    if (!sc || !sc.running) throw err('NO_SCREENCAST', 'call screencast.start first');
    const deadline = Date.now() + Math.min(p.wait_ms ?? 2000, 10000);
    let frame = sc.frames.shift();
    while (!frame && Date.now() < deadline) {
      await sleep(200);
      frame = sc.frames.shift();
    }
    if (!frame) return { waiting: true, visible: sc.visible };
    await cdp.send(tabId, 'Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => {});
    const bytes = Math.round((frame.data.length * 3) / 4);
    return { frame: { jpeg_base64: frame.data, w: frame.w, h: frame.h, ts: frame.ts, bytes } };
  });

  R('screencast.stop', { category: 'capture' }, async (p) => {
    const tabId = targetTab(p);
    const sc = screencasts.get(tabId);
    if (!sc) return { stopped: false };
    sc.running = false;
    screencasts.delete(tabId);
    await cdp.send(tabId, 'Page.stopScreencast').catch(() => {});
    return { stopped: true };
  });

  // ---- audit --------------------------------------------------------------------------------
  // ---- Qoder parity batch: clipboard / batch content / exporters / events ---

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

  R('webmcp.list', { category: 'sensing', description: 'List WebMCP tools declared by the page (window.__webMcpTools / webMCP.tools / navigator.modelContext.tools).' }, async (p) => {
    const tabId = targetTab(p);
    const t = await evalJs(tabId, `(function(){var t=window.__webMcpTools||(window.webMCP&&window.webMCP.tools)||(navigator.modelContext&&navigator.modelContext.tools);return t?JSON.parse(JSON.stringify(t)):null})()`).catch(() => null);
    return { tools: t, note: t ? undefined : 'page declares no WebMCP tools' };
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

  R('ax.action', { category: 'interaction', description: 'Perform an accessibility-style action on a ref: focus | click | setValue (value) | expand.' }, async (p) => {
    const tabId = targetTab(p);
    const { nodeId } = await resolveRef(tabId, p.ref);
    const action = String(p.action || 'focus');
    if (!['focus', 'click', 'setValue', 'expand'].includes(action)) throw err('BAD_PARAMS', 'action: focus|click|setValue|expand');
    await cdp.send(tabId, 'DOM.setAttributeValue', { nodeId, name: 'data-ubb-tmp', value: '1' });
    const v = await evalJs(tabId, `(function(){
      var el = document.querySelector('[data-ubb-tmp]');
      el.removeAttribute('data-ubb-tmp');
      var action = ${JSON.stringify(action)};
      if (action === 'focus') { el.focus(); return { active: document.activeElement === el }; }
      if (action === 'click') { el.click(); return { clicked: true }; }
      if (action === 'setValue') { el.value = ${JSON.stringify(String(p.value ?? ''))}; el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); return { value: el.value }; }
      if (action === 'expand') { el.setAttribute('aria-expanded','true'); el.click(); return { expanded: true }; }
    })()`);
    audit.log({ action: 'ax.action', tabId, op: action });
    return v;
  });

  R('download.status', { category: 'diagnostics', description: 'Query a chrome.downloads item (state/bytes).' }, async (p) => {
    if (p.download_id == null) throw err('BAD_PARAMS', 'download_id required');
    const [d] = await chrome.downloads.search({ id: p.download_id });
    if (!d) throw err('NOT_FOUND', 'no download ' + p.download_id);
    return { state: d.state, bytes_received: d.bytesReceived, total: d.totalBytes, paused: d.paused, url: redactUrl(d.finalUrl || d.url) };
  });

  R('download.path', { category: 'diagnostics', description: 'Get the final filesystem path of a completed download.' }, async (p) => {
    if (p.download_id == null) throw err('BAD_PARAMS', 'download_id required');
    const [d] = await chrome.downloads.search({ id: p.download_id });
    if (!d) throw err('NOT_FOUND', 'no download ' + p.download_id);
    if (d.state !== 'complete') return { ready: false, state: d.state };
    return { ready: true, path: d.filename };
  });

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
  R('element.enabled', { category: 'sensing' }, async (p) => {
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
  R('element.attribute', { category: 'sensing' }, async (p) => {
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
  R('element.info', { category: 'sensing', description: 'Inspect an @eN ref: tag, role, name, attributes, box.' }, async (p) => {
    const tabId = targetTab(p);
    const { nodeId, box, meta } = await resolveRef(tabId, p.ref);
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

// ---------------------------------------------------------------- misc

function pack(shot, format, extra) {
  const bytes = Math.round((shot.data.length * 3) / 4);
  return { format, bytes, data_base64: shot.data, ...extra };
}

function visibleExpr(selector) {
  return `(function(){try{var e=document.querySelector(${JSON.stringify(selector)});if(!e)return false;var r=e.getBoundingClientRect();var s=getComputedStyle(e);return r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none'}catch(_){return false}})()`;
}

async function waitForLoad(tabId, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const st = await evalJs(tabId, 'document.readyState').catch(() => null);
    if (st === 'complete') return true;
    await sleep(250);
  }
  return false;
}
