// UBB service worker entry: wires agent link ⇄ dispatcher ⇄ tools,
// content-script messages (interrupt/confirm), alarms keepalive.

import { AgentLink } from './lib/ws-client.js';
import { Dispatcher } from './lib/protocol.js';
import { registerTools } from './lib/tools.js';
import { cdp } from './lib/cdp.js';
import { refs } from './lib/refs.js';
import { sessions } from './lib/tabs.js';
import { audit } from './lib/audit.js';
import { pendingConfirms, shield } from './lib/shield-ctl.js';
import { STORAGE_KEYS, DEFAULTS, err, randomHex } from './lib/config.js';

async function loadConfig() {
  const st = await chrome.storage.local.get([STORAGE_KEYS.token, STORAGE_KEYS.port, STORAGE_KEYS.enabled]);
  return {
    token: st[STORAGE_KEYS.token],
    port: st[STORAGE_KEYS.port] || DEFAULTS.port,
    enabled: st[STORAGE_KEYS.enabled] !== false && !!st[STORAGE_KEYS.token],
  };
}

const link = new AgentLink(loadConfig);
const dispatcher = new Dispatcher();
registerTools(dispatcher);

dispatcher.onFinish = (name, params, ok, ms, errorCode) => {
  audit.log({ action: name, ok, ms, error: errorCode, tab_id: params?.tab_id });
  if (!ok && sessions.active()) sessions.setStatus('error').then(() => sessions.setStatus('running'));
};

// inbound from daemon → dispatch → reply
link.handler = async (msg) => {
  const reply = await dispatcher.handle(msg);
  if (reply) link.send(reply);
};

// ---------------------------------------------------------------- lifecycle

chrome.runtime.onInstalled.addListener(async () => {
  const st = await chrome.storage.local.get([STORAGE_KEYS.token]);
  if (!st[STORAGE_KEYS.token]) {
    await chrome.storage.local.set({ [STORAGE_KEYS.token]: randomHex(32) });
  }
});

chrome.runtime.onStartup.addListener(() => link.start());
chrome.alarms.create('ubb-keepalive', { periodInMinutes: 0.5 });

// ── native auto-pairing (channel-bound trust, Trae/Qoder style) ────────────
// `ubb install` registers a native messaging host whose manifest pins THIS
// extension's id — the browser refuses any other origin, so nothing on the
// machine can impersonate us. At every service-worker start we ask the host
// for the current token/port (it also ensures the daemon runs). The host is
// the source of truth; when the host isn't installed the manual token flow
// from the popup keeps working unchanged.
let nativePairInFlight = false;
async function nativePair() {
  if (nativePairInFlight) return;
  nativePairInFlight = true;
  try {
    await nativePairInner();
  } finally {
    nativePairInFlight = false;
  }
}

async function nativePairInner() {
  if (typeof chrome.runtime.connectNative !== 'function') return; // no nativeMessaging permission
  const port = chrome.runtime.connectNative('com.ubb.bridge');
  try {
    const reply = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('pair timeout')), 5000);
      port.onMessage.addListener((m) => { clearTimeout(timer); resolve(m); });
      port.onDisconnect.addListener(() => { clearTimeout(timer); reject(new Error(chrome.runtime.lastError?.message || 'host gone')); });
      port.postMessage({ op: 'pair' });
    });
    if (reply?.ok && typeof reply.token === 'string' && reply.token.length >= 32) {
      const st = await chrome.storage.local.get([STORAGE_KEYS.token, STORAGE_KEYS.port]);
      if (st[STORAGE_KEYS.token] !== reply.token || st[STORAGE_KEYS.port] !== (reply.port || 8765)) {
        await chrome.storage.local.set({
          [STORAGE_KEYS.token]: reply.token,
          [STORAGE_KEYS.port]: reply.port || 8765,
        });
        audit.log({ action: 'native.pair', note: 'token/port synced from native host' });
        link.restart(); // reconnect with the paired credentials
      }
    }
  } catch (e) {
    audit.log({ action: 'native.pair', note: String(e?.message || e).slice(0, 80) });
  } finally {
    try { port.disconnect(); } catch {}
  }
}
nativePair();

link.start();
sessions.restore(); // survive SW restarts

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'ubb-keepalive') {
    loadConfig().then((c) => {
      if (c.enabled && link.status === 'off') link.restart();
    });
    nativePair(); // self-heal ≤30s after a token rotation — a failing-auth WS
    // never idles the SW out, so a start-time-only pair would never re-run
  }
});

// ---------------------------------------------------------------- debugger events

chrome.debugger.onEvent.addListener((source, method, params) => {
  cdp.handleEvent(source, method, params);
});

cdp.onNavigation = (tabId) => {
  refs.bump(tabId);
  link.emit('tab.navigated', { tab_id: tabId });
};

chrome.debugger.onDetach.addListener(async (source) => {
  cdp.sessions.delete(source.tabId);
  refs.invalidate(source.tabId);
});

// Re-arm the shield after every completed navigation of a session tab:
// content scripts reset on navigation, and tab.create arms too early (the
// script is not loaded yet) — onCompleted is the reliable point.
chrome.webNavigation.onCompleted.addListener(async ({ tabId, frameId }) => {
  if (frameId !== 0) return;
  const s = sessions.active();
  if (s && sessions.owns(tabId)) {
    await shield.set(tabId, { mode: 'armed', label: 'UBB agent control' });
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  cdp.sessions.delete(tabId);
  refs.invalidate(tabId);
  const s = sessions.active();
  if (s) {
    s.created.delete(tabId);
    s.claimed.delete(tabId);
    if (s.lastTabId === tabId) s.lastTabId = [...s.created][s.created.size - 1] ?? [...s.claimed][0] ?? null;
  }
});

// ---------------------------------------------------------------- extension messages

// Web-page channel: manifest externally_connectable admits http://localhost/* and
// http://127.0.0.1/* pages only, and every message must carry the same token the
// daemon uses — so a page served from any local port can drive UBB without the CLI.
chrome.runtime.onMessageExternal.addListener((msg, sender, sendResponse) => {
  (async () => {
    const origin = sender.origin || sender.url || '';
    if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
      return { ok: false, error: 'origin not allowed: ' + origin };
    }
    if (!msg || msg.type !== 'UBB_WEB_RPC') {
      return { ok: false, error: 'unknown message type' };
    }
    const st = await chrome.storage.local.get([STORAGE_KEYS.token, STORAGE_KEYS.enabled]);
    if (st[STORAGE_KEYS.enabled] === false) return { ok: false, error: 'UBB disabled' };
    if (!st[STORAGE_KEYS.token] || msg.token !== st[STORAGE_KEYS.token]) {
      return { ok: false, error: 'UNAUTHORIZED: token mismatch' };
    }
    const method = msg.method || (msg.tool ? 'tool.' + msg.tool : null);
    if (!method) return { ok: false, error: 'method/tool required' };
    audit.log({ action: 'web.rpc', origin, tool: method.replace(/^tool\./, '') });
    const reply = await dispatcher.handle({ id: 'web-' + Date.now() + '-' + randomHex(4), method, params: msg.params || {} });
    if (reply && reply.error) return { ok: false, error: reply.error.message || String(reply.error) };
    return { ok: true, result: reply && reply.result };
  })().then((r) => sendResponse(r)).catch((e) => sendResponse({ ok: false, error: String(e && e.message || e) }));
  return true; // async sendResponse
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg?.type) {
      // --- from content/shield.js ---
      case 'UBB_INTERRUPT': {
        const n = dispatcher.cancelAll();
        const tabId = sender.tab?.id;
        if (tabId != null) {
          // user took over: pause blocking on that tab until the next arm
          // (shield is statically imported at the top of this file; dynamic
          // import() is not allowed on ServiceWorkerGlobalScope)
          await shield.set(tabId, { mode: 'paused', label: '已由用户中断' });
        }
        link.emit('session.interrupted', { tab_id: tabId, cancelled: n });
        sendResponse({ ok: true, cancelled: n });
        break;
      }
      case 'UBB_CONFIRM_RESULT': {
        const p = pendingConfirms.get(msg.reqId);
        if (p) {
          pendingConfirms.delete(msg.reqId);
          p.resolve(!!msg.ok);
        }
        sendResponse({ ok: true });
        break;
      }

      // --- from popup ---
      case 'UBB_POPUP_STATE': {
        const cfg = await loadConfig();
        sendResponse({
          connected: link.status === 'connected',
          status: link.status,
          instance_id: link.instanceId,
          session: sessions.active()
            ? { id: sessions.active().id, created: sessions.active().created.size, claimed: sessions.active().claimed.size }
            : null,
          port: cfg.port,
          enabled: cfg.enabled,
          has_token: !!cfg.token,
          token: cfg.token || '(not generated)',
          shield_mode: (await chrome.storage.local.get(STORAGE_KEYS.shieldMode))[STORAGE_KEYS.shieldMode] || 'block',
          human_mode: (await chrome.storage.local.get('ubb_human_mode')).ubb_human_mode === true,
          audit_tail: audit.list(5),
        });
        break;
      }
      case 'UBB_POPUP_CONFIG': {
        const patch = {};
        if (msg.port) patch[STORAGE_KEYS.port] = Number(msg.port) || DEFAULTS.port;
        if (typeof msg.enabled === 'boolean') patch[STORAGE_KEYS.enabled] = msg.enabled;
        if (typeof msg.human === 'boolean') patch.ubb_human_mode = msg.human;
        if (msg.shield_mode) patch[STORAGE_KEYS.shieldMode] = msg.shield_mode;
        if (typeof msg.token === 'string' && /^[0-9a-f]{16,128}$/i.test(msg.token)) {
          patch[STORAGE_KEYS.token] = msg.token.toLowerCase();
        }
        await chrome.storage.local.set(patch);
        await link.restart();
        sendResponse({ ok: true });
        break;
      }
      case 'UBB_POPUP_REGEN_TOKEN': {
        await chrome.storage.local.set({ [STORAGE_KEYS.token]: randomHex(32) });
        await link.restart();
        sendResponse({ ok: true });
        break;
      }
      default:
        sendResponse({ ok: false, error: 'unknown message' });
    }
  })();
  return true; // async response
});

// expose for debugging on the SW console
self.__ubb = { link, dispatcher, cdp, sessions, err };
