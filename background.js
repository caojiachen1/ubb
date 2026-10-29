// UBB service worker entry: wires agent link ⇄ dispatcher ⇄ tools,
// content-script messages (interrupt/confirm), alarms keepalive.

import { AgentLink } from './lib/ws-client.js';
import { Dispatcher } from './lib/protocol.js';
import { registerTools } from './lib/tools.js';
import { registerExtras } from './lib/tools-extra.js';
import { cdp } from './lib/cdp.js';
import { refs } from './lib/refs.js';
import { dropCapture } from './lib/snapshot.js';
import { sessions } from './lib/tabs.js';
import { audit } from './lib/audit.js';
import { downloadLedger } from './lib/tools-downloads.js';
import { pendingConfirms, shield, rearmFrame, dropPasses } from './lib/shield-ctl.js';
import { clearBridgeWedge } from './lib/bridge-ctl.js';
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
registerExtras(dispatcher);

// audit.seq must be re-hydrated from chrome.storage.session BEFORE the daemon
// link opens: a tool dispatched against the pre-hydrate zero would hand the
// tailer a fresh-from-0 seq and the CLI would read it as a ring wraparound.
// (hydrateSeq is idempotent — safe to await from every link.start entry point.)
function startLinkHydrated() {
  audit.hydrateSeq().catch(() => {}).then(() => link.start());
}

dispatcher.onFinish = (name, params, ok, ms, errorCode) => {
  audit.log({ action: name, ok, ms, error: errorCode, tab_id: params?.tab_id });
  // a refusal caused BY the pause must not repaint the group as "running"
  if (!ok && sessions.active() && !sessions.isPaused()) sessions.setStatus('error').then(() => sessions.setStatus('running'));
};

// inbound from daemon → dispatch → reply
// The restore barrier is part of request admission: a call that arrives while
// chrome.storage.session is still being read must not race a half-restored
// session that is replaced microseconds later.
link.handler = async (msg) => {
  await sessions.ready();
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

chrome.runtime.onStartup.addListener(startLinkHydrated);
chrome.alarms.create('ubb-keepalive', { periodInMinutes: 0.5 });

// ── native auto-pairing (channel-bound trust) ────────────
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

startLinkHydrated();
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

// mid-command detach reported by the CDP hub (no chrome.debugger event may
// have fired, e.g. a stale "not attached" reply) — refs are stale either way
cdp.onDetach = (tabId) => {
  refs.invalidate(tabId);
  dropCapture(tabId);
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
  clearBridgeWedge(tabId, 0); // fresh document → the bridge gets a fresh chance
  const s = sessions.active();
  if (s && sessions.owns(tabId) && s.paused !== true) {
    await shield.set(tabId, { mode: 'armed', label: 'UBB agent control' });
  }
});

// Late-loaded iframe closure (log-D §5): an SPA-inserted subframe commits
// without any top-frame navigation, so the arm broadcast above never reaches
// its frameblock listener — the shield stays lit while the user could type
// into the new frame. Address exactly that frameId with the QUERIED mode
// (rearmFrame never invents an arm: a paused tab stays paused).
chrome.webNavigation.onCommitted.addListener(({ tabId, frameId }) => {
  if (frameId === 0) return; // main-frame arming stays on the onCompleted path
  // a committed document is a fresh content script: lift any bridge cooldown
  clearBridgeWedge(tabId, frameId);
  const s = sessions.active();
  if (!s || !sessions.owns(tabId)) return;
  // fix5 §F3-⑥: this used to end in `.catch(() => {})`, which threw away the one
  // thing rearmFrame exists to produce — whether that frame is actually armed.
  // The outcome (sent / reason / mode / error) goes to the audit ring, so
  // `ubb audit tail` shows an un-armed frame instead of a silent nothing-happened.
  Promise.resolve()
    .then(() => rearmFrame(tabId, frameId))
    .then((r) => audit.log({ action: 'shield.rearm_frame', tab_id: tabId, frame_id: frameId, sent: !!(r && r.sent), reason: r && r.sent ? 'armed' : String((r && r.reason) || 'no_result'), mode: (r && r.mode) || null, error: (r && r.error) || undefined }))
    .catch((e) => audit.log({ action: 'shield.rearm_frame', tab_id: tabId, frame_id: frameId, sent: false, reason: 'rearm_threw', error: String(e?.message || e).slice(0, 160) }));
});

chrome.tabs.onRemoved.addListener((tabId) => {
  cdp.forget(tabId);
  refs.invalidate(tabId);
  clearBridgeWedge(tabId);
  // a tab that no longer exists cannot be told to re-block: forget its open pass
  // transactions instead of leaving timers that will address a dead tab
  dropPasses(tabId);
  const s = sessions.active();
  if (s) {
    s.created.delete(tabId);
    s.claimed.delete(tabId);
    if (s.lastTabId === tabId) s.lastTabId = [...s.created][s.created.size - 1] ?? [...s.claimed][0] ?? null;
  }
});

// ---------------------------------------------------------------- download watch
// The agent's own `download` tool only sees explicit url/href downloads. Chrome's
// downloads API also fires for blob:/server-generated ones the agent never asked
// for, so keep a ring the download.* tools can read and push lifecycle events.
// The callback argument is a DownloadItem, and that type HAS NO tabId (only
// DownloadDelta does, and this build never filled it either — LIVE-RESULTS-3B §3b),
// so nothing here may expect a tab from the browser: attribution comes from the
// download tool's claim, from a delta that really carries one, or from the
// heuristic. Which signals this browser actually supplies is counted in the ledger
// and shown by download.list as `browser_signals`, not guessed in a description.
downloadLedger.setEmitter((event, params) => link.emit(event, params));
chrome.downloads.onCreated.addListener((item) => downloadLedger.created(item));
chrome.downloads.onChanged.addListener((delta) => {
  downloadLedger.changed(delta).catch(() => {});
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
    await sessions.ready();
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
        // user revoked control: the session stays paused (targetTab refuses)
        // until a human re-arms; a navigation completing must not resume it
        await sessions.pause();
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
      case 'UBB_RESUME': {
        const tabId = sender.tab?.id;
        const resumed = await sessions.resume();
        if (tabId != null) await shield.set(tabId, { mode: 'armed', label: 'UBB agent control' });
        link.emit('session.resumed', { tab_id: tabId });
        sendResponse({ ok: true, resumed });
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
      case 'UBB_HELP_RESULT': {
        shield.helpResult(msg.reqId, msg.ok);
        sendResponse({ ok: true });
        break;
      }
      case 'UBB_REC_SAVE': {
        // content-script recorder handoff: survives cross-origin navigations
        (async () => {
          try {
            if (!msg.rec) await chrome.storage.session.remove('ubb_rec_last');
            else if (JSON.stringify(msg.rec).length <= 2 * 1024 * 1024) {
              await chrome.storage.session.set({ ubb_rec_last: msg.rec });
            }
            sendResponse({ ok: true });
          } catch { sendResponse({ ok: false }); }
        })();
        return true;
      }
      case 'UBB_REC_LOAD': {
        (async () => {
          try {
            const st = await chrome.storage.session.get('ubb_rec_last');
            const rec = st.ubb_rec_last || null;
            if (rec) await chrome.storage.session.remove('ubb_rec_last');
            sendResponse({ ok: true, rec });
          } catch { sendResponse({ ok: false }); }
        })();
        return true;
      }

      // --- from popup ---
      case 'UBB_POPUP_STATE': {
        const cfg = await loadConfig();
        await sessions.ready();
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
