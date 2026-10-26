// chrome.debugger (CDP) hub: lazy attach, per-tab serial command queue, event
// routing into console/network/dialog buffers, idle auto-detach
// (lazy attach, idle auto-detach, per-tab serialization).

import { err, IDLE_DETACH_MS, CDP_CMD_TIMEOUT_MS } from './config.js';

const RESTRICTED = [
  'chrome://',
  'edge://',
  'devtools://',
  'chrome-search://',
  'view-source:',
  'chrome-extension://',
  'https://chrome.google.com/webstore',
  'https://microsoftedge.microsoft.com/addons',
];

const CONSOLE_MAX = 1000;
const NET_MAX = 500;

class TabSession {
  constructor(tabId) {
    this.tabId = tabId;
    this.queue = Promise.resolve();
    this.gen = 1;
    this.frameId = null;
    this.console = [];
    this.net = [];
    this.dialogs = [];
    this.enabledDomains = new Set();
    this.domFetched = false;
  }
}

class CdpHub {
  constructor() {
    this.sessions = new Map();
    this._idleTimer = null;
    this._inFlight = 0; // commands awaiting a renderer reply
    this.onEvent = null; // (source, method, params) => void, wired by background.js
    this.onDetach = null; // (tabId) => void, wired by background.js
  }

  isRestrictedUrl(url) {
    if (!url) return false;
    if (url === 'about:blank') return false;
    return RESTRICTED.some((p) => url.startsWith(p));
  }

  has(tabId) {
    return this.sessions.has(tabId);
  }

  async ensure(tabId) {
    if (this.sessions.has(tabId)) return this.sessions.get(tabId);
    // concurrent first commands must share one attach (double-attach throws)
    this._ensuring ||= new Map();
    if (this._ensuring.has(tabId)) return this._ensuring.get(tabId);
    const p = this._ensureNow(tabId).finally(() => this._ensuring.delete(tabId));
    this._ensuring.set(tabId, p);
    return p;
  }

  async _ensureNow(tabId) {
    if (this.sessions.has(tabId)) return this.sessions.get(tabId);
    let tab;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch {
      throw err('TAB_NOT_FOUND', `tab ${tabId} does not exist`);
    }
    if (this.isRestrictedUrl(tab.url)) {
      throw err('URL_BLOCKED', `cannot attach debugger to restricted URL: ${tab.url}`);
    }
    try {
      await chrome.debugger.attach({ tabId }, '1.3');
    } catch (e) {
      const msg = String(e?.message || e);
      if (/another debugger|attached/i.test(msg)) {
        throw err('DEBUGGER_CONFLICT', 'another debugger/DevTools is attached to this tab');
      }
      if (/chrome-extension/i.test(msg)) {
        throw err('DEBUGGER_CONFLICT', 'an extension iframe blocks the debugger on this tab');
      }
      throw err('ATTACH_FAILED', msg);
    }
    const s = new TabSession(tabId);
    this.sessions.set(tabId, s);
    try {
      await this._send(tabId, 'Page.enable');
      await this._send(tabId, 'Runtime.enable');
      await this._send(tabId, 'Network.enable');
      await this._send(tabId, 'DOM.enable');
      s.enabledDomains.add('Page');
      s.enabledDomains.add('Runtime');
      s.enabledDomains.add('Network');
      s.enabledDomains.add('DOM');
      const tree = await this._send(tabId, 'Page.getFrameTree');
      s.frameId = tree?.frameTree?.frame?.id || null;
      await this._send(tabId, 'DOM.getDocument', {}).catch(() => {});
      s.domFetched = true;
    } catch (e) {
      await this.detach(tabId).catch(() => {});
      throw err('ATTACH_FAILED', String(e?.message || e));
    }
    this.touchIdle();
    return s;
  }

  async detach(tabId) {
    if (!this.sessions.has(tabId)) return;
    this.sessions.delete(tabId);
    try {
      await chrome.debugger.detach({ tabId });
    } catch {
      /* already gone */
    }
  }

  async detachAll() {
    for (const tabId of [...this.sessions.keys()]) await this.detach(tabId);
  }

  /** Serialized per-tab command execution (cross-tab concurrency allowed). */
  send(tabId, method, params) {
    const run = async () => {
      await this.ensure(tabId);
      return this._send(tabId, method, params);
    };
    const s = this.sessions.get(tabId);
    if (s) {
      const next = s.queue.then(run, run);
      s.queue = next.catch(() => {});
      return next;
    }
    return run();
  }

  async _send(tabId, method, params) {
    this._beginWork();
    try {
      const result = await cdpDeadline(
        chrome.debugger.sendCommand({ tabId }, method, params || {}),
        method,
      );
      return result;
    } catch (e) {
      const msg = String(e?.message || e);
      if (/detached|not attached/i.test(msg)) {
        // The session died mid-command (idle detach, SW restart, user cancel).
        // Drop the stale entry so the next command re-attaches instead of
        // failing forever, and let refs know they are stale.
        this.sessions.delete(tabId);
        if (this.onDetach) this.onDetach(tabId);
        throw err('CDP_DETACHED', `${method}: debugger detached mid-command (${msg})`);
      }
      throw e;
    } finally {
      this._endWork();
    }
  }

  _beginWork() {
    this._inFlight += 1;
    if (this._idleTimer) { clearTimeout(this._idleTimer); this._idleTimer = null; }
  }

  _endWork() {
    this._inFlight = Math.max(0, this._inFlight - 1);
    this.touchIdle();
  }

  /** Route a chrome.debugger.onEvent into buffers; returns nothing. */
  handleEvent(source, method, params) {
    const s = this.sessions.get(source.tabId);
    if (!s) return;
    // generic event ring for cdp.events (screencast frames excluded: huge)
    if (method !== 'Page.screencastFrame') {
      const ring = (s.eventRing ||= []);
      let p2;
      try { p2 = JSON.stringify(params); } catch { p2 = '{}'; }
      ring.push({
        seq: (s.eventSeq = (s.eventSeq || 0) + 1),
        t: Date.now(),
        method,
        params: p2.length > 1500 ? p2.slice(0, 1500) + '…' : JSON.parse(p2),
      });
      if (ring.length > 1000) ring.splice(0, ring.length - 1000);
    }
    switch (method) {
      case 'Runtime.consoleAPICalled': {
        s.console.push({
          t: Date.now(),
          type: params.type,
          text: (params.args || [])
            .map((a) => (a.value !== undefined ? String(a.value) : a.description || a.type))
            .join(' '),
        });
        if (s.console.length > CONSOLE_MAX) s.console.splice(0, s.console.length - CONSOLE_MAX);
        break;
      }
      case 'Network.requestWillBeSent': {
        s.net.push({
          requestId: params.requestId,
          t: Date.now(),
          method: params.request?.method,
          url: params.request?.url,
          type: params.type,
        });
        if (s.net.length > NET_MAX) s.net.splice(0, s.net.length - NET_MAX);
        break;
      }
      case 'Network.responseReceived': {
        const r = s.net.find((x) => x.requestId === params.requestId);
        if (r) {
          r.status = params.response?.status;
          r.mime = params.response?.mimeType;
        }
        break;
      }
      case 'Network.loadingFailed': {
        const r = s.net.find((x) => x.requestId === params.requestId);
        if (r) r.error = params.errorText;
        break;
      }
      case 'Network.loadingFinished': {
        const r = s.net.find((x) => x.requestId === params.requestId);
        if (r) r.finished = true;
        break;
      }
      case 'Page.frameNavigated': {
        if (!params.frame?.parentId) {
          // main frame navigation: new document generation
          s.gen += 1;
          s.frameId = params.frame.id;
          s.net = [];
          s.dialogs = [];
          s.domFetched = false;
          if (this.onNavigation) this.onNavigation(source.tabId);
        }
        break;
      }
      case 'Page.javascriptDialogOpening': {
        const dlg = {
          t: Date.now(),
          type: params.type,
          message: params.message,
          defaultPrompt: params.defaultPrompt,
        };
        if (params.type === 'alert') {
          // alerts are auto-accepted so they never wedge tools
          chrome.debugger
            .sendCommand({ tabId: source.tabId }, 'Page.handleJavaScriptDialog', { accept: true })
            .catch(() => {});
          s.console.push({ t: Date.now(), type: 'dialog', text: `[alert auto-accepted] ${params.message}` });
        } else {
          s.dialogs.push(dlg);
        }
        break;
      }
      case 'Page.javascriptDialogClosed': {
        s.dialogs = [];
        break;
      }
      default:
        break;
    }
    if (this.onEvent) this.onEvent(source, method, params);
  }

  buffers(tabId) {
    return this.sessions.get(tabId);
  }

  touchIdle() {
    if (this._idleTimer) clearTimeout(this._idleTimer);
    if (this._inFlight > 0) return; // a live command is work, not idleness
    this._idleTimer = setTimeout(() => {
      this._idleTimer = null;
      this.detachAll().catch(() => {});
    }, IDLE_DETACH_MS);
  }
}

/** Reject if the renderer never answers; the underlying chrome.debugger
 *  promise may settle later and is swallowed (outer promise already settled). */
function cdpDeadline(promise, method) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(
      () => reject(err('CDP_TIMEOUT', `${method} got no reply in ${CDP_CMD_TIMEOUT_MS / 1000}s (renderer hung or blocked)`)),
      CDP_CMD_TIMEOUT_MS,
    );
    promise.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

export const cdp = new CdpHub();
