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

// Script-injection pseudo-schemes: an agent must never navigate a user tab to
// one, and the debugger cannot attach there anyway.
const SCRIPT_SCHEMES = ['javascript:', 'blob:', 'data:', 'vbscript:'];

/**
 * Peel ONE leading scheme layer ("https://x" → "x"). A restricted scheme can
 * hide behind a laundered prefix — normalizeUrl used to turn
 * "chrome://settings" into "https://chrome://settings" — so the gate must look
 * at the shape underneath as well.
 */
export function stripLeadingScheme(url) {
  const m = /^([a-z][a-z0-9+.-]*:)(\/\/?)?/i.exec(url || '');
  if (!m) return url;
  return url.slice(m[0].length);
}

const CONSOLE_MAX = 1000;
const NET_MAX = 500;

class TabSession {
  constructor(tabId) {
    this.tabId = tabId;
    this.gen = 1;
    this.frameId = null;
    this.frames = new Map(); // CDP frameId (main-session view) → {url, parentId, name}
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
    // Per-tab command queues live OUTSIDE TabSession: the first command must be
    // serialized too, and that command is the one that creates the session.
    this.queues = new Map();
    this._idleTimer = null;
    this._inFlight = 0; // commands awaiting a renderer reply
    this.onEvent = null; // (source, method, params) => void, wired by background.js
    this.onDetach = null; // (tabId) => void, wired by background.js
  }

  isRestrictedUrl(url) {
    if (!url) return false;
    if (url === 'about:blank') return false;
    if (RESTRICTED.some((p) => url.startsWith(p))) return true;
    if (SCRIPT_SCHEMES.some((p) => url.toLowerCase().startsWith(p))) return true;
    // laundered shapes: https://chrome://settings must not read as a normal
    // https page (the normalizeUrl scheme-prepend bug, closed at both ends)
    const peeled = stripLeadingScheme(url);
    if (peeled !== url) {
      if (RESTRICTED.some((p) => peeled.startsWith(p))) return true;
      if (SCRIPT_SCHEMES.some((p) => peeled.toLowerCase().startsWith(p))) return true;
    }
    return false;
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
      // Edge hides privileged-page URLs everywhere (chrome.tabs, CDP frame URL
      // and navigation history all read '') — an empty frame URL therefore
      // means an internal browser page we must not (and cannot) automate.
      // A navigation still committing also reads empty for a moment, so poll
      // briefly before declaring the page restricted.
      let frameUrl = tree?.frameTree?.frame?.url || '';
      if (!frameUrl) {
        const deadline = Date.now() + 2500;
        while (!frameUrl && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 350));
          const t2 = await this._send(tabId, 'Page.getFrameTree').catch(() => null);
          if (t2?.frameTree?.frame) {
            tree.frameTree = t2.frameTree;
            frameUrl = t2.frameTree.frame.url || '';
          }
        }
      }
      s.frameId = tree?.frameTree?.frame?.id || null;
      for (const f of flattenFrameTree(tree)) {
        if (f.frameId !== s.frameId) s.frames.set(f.frameId, f);
      }
      if (!frameUrl || this.isRestrictedUrl(frameUrl)) {
        await this.detach(tabId).catch(() => {});
        throw err('URL_BLOCKED', `restricted or non-automatable page (its URL is hidden — likely an internal browser page)`);
      }
      // F3 audit: do not mark domFetched=true when the command itself failed —
      // the flag gates actions.js' "Document needs to be requested first"
      // prefix, and a swallowed error here made every later DOM.resolveNode
      // die with a misleading error instead of simply retrying getDocument.
      const doc = await this._send(tabId, 'DOM.getDocument', {}).catch(() => null);
      s.domFetched = !!doc;
    } catch (e) {
      await this.detach(tabId).catch(() => {});
      if (e && e.code) throw e; // URL_BLOCKED / TAB_NOT_FOUND keep their code
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
    let q = this.queues.get(tabId);
    if (!q) {
      q = { tail: Promise.resolve() };
      this.queues.set(tabId, q);
    }
    const run = async () => {
      await this.ensure(tabId);
      return this._send(tabId, method, params);
    };
    const next = q.tail.then(run, run);
    q.tail = next.catch(() => {});
    return next;
  }

  /** Forget a closed tab's queue; safe only after chrome.tabs.onRemoved. */
  forget(tabId) {
    this.sessions.delete(tabId);
    this.queues.delete(tabId);
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
          s.frames.clear();
          s.net = [];
          s.dialogs = [];
          s.domFetched = false;
          if (this.onNavigation) this.onNavigation(source.tabId);
        } else {
          // subframe document swap: frame refs go stale through their doc
          // epoch; keep the CDP-view registry current
          s.frames.set(params.frame.id, {
            frameId: params.frame.id,
            parentId: params.frame.parentId,
            url: params.frame.url || '',
            name: params.frame.name || '',
          });
        }
        break;
      }
      case 'Page.frameAttached': {
        s.frames.set(params.frameId, {
          frameId: params.frameId,
          parentId: params.parentFrameId,
          url: '',
          name: '',
        });
        break;
      }
      case 'Page.frameDetached': {
        s.frames.delete(params.frameId);
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
          // alerts are auto-accepted so they never wedge tools — but the
          // console line may only claim "auto-accepted" once the ack really
          // landed, and a failed ack leaves the dialog in s.dialogs where
          // dialog.status/dialog.handle can see it (F3 audit: the old code
          // swallowed the rejection and told console.list the alert was gone)
          const ack = chrome.debugger.sendCommand({ tabId: source.tabId }, 'Page.handleJavaScriptDialog', { accept: true });
          Promise.resolve(ack).then(
            () => s.console.push({ t: Date.now(), type: 'dialog', text: `[alert auto-accepted] ${params.message}` }),
            (e) => {
              s.dialogs.push({ t: Date.now(), type: 'alert', message: params.message });
              s.console.push({
                t: Date.now(),
                type: 'dialog',
                text: `[alert STILL OPEN — auto-accept failed: ${String(e?.message || e).slice(0, 120)}; answer it with dialog.handle] ${params.message}`,
              });
            },
          );
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

/** Depth-first list of every frame node in a Page.getFrameTree response. */
export function flattenFrameTree(getFrameTreeResult) {
  const out = [];
  (function walk(node, parentId) {
    const f = node?.frame;
    if (!f) return;
    out.push({ frameId: f.id, parentId: f.parentId || parentId || null, url: f.url || '', name: f.name || '' });
    for (const child of node.childFrames || []) walk(child, f.id);
  })(getFrameTreeResult?.frameTree, null);
  return out;
}

/** Reject if the renderer never answers; the underlying chrome.debugger
 *  promise may settle later and is swallowed (outer promise already settled). */function cdpDeadline(promise, method) {
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
