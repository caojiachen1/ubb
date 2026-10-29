// Outbound agent link: the extension dials the local daemon over WebSocket
// with a token-bearing subprotocol. The extension never listens on a port.

import { PROTOCOL, HEARTBEAT_MS, HEARTBEAT_TIMEOUT_MS, BUILD, randomHex, err } from './config.js';

// Exactly one AgentLink exists in the service worker (background.js), so tool
// modules can reach the reverse-RPC channel without background.js wiring it.
let activeLink = null;
const SECRET_FETCH_TIMEOUT_MS = 10_000;

/** Ask the local daemon something over the already-authenticated extension socket. */
export function requestDaemon(method, params = {}, timeoutMs = SECRET_FETCH_TIMEOUT_MS) {
  if (!activeLink) throw err('DAEMON_NOT_CONNECTED', 'the extension has no daemon link yet — check the token in the UBB popup / `ubb daemon status`');
  return activeLink.requestDaemon(method, params, timeoutMs);
}

export class AgentLink {
  constructor(loadConfig) {
    this.loadConfig = loadConfig;
    this.ws = null;
    this.status = 'off'; // off | connecting | waiting_auth | connected
    this.handler = null; // (msg) => void  for inbound requests/notifications
    this._attempt = 0;
    this._hbTimer = null;
    this._lastInbound = 0;
    this._stopped = false;
    this.instanceId = randomHex(4);
    this._rid = 0;
    this._pending = new Map(); // `s<n>` → {resolve, reject, timer}
    activeLink = this;
  }

  async start() {
    this._stopped = false;
    this._epoch = (this._epoch || 0) + 1;
    this._connect(this._epoch);
  }

  stop() {
    this._stopped = true;
    this._epoch = (this._epoch || 0) + 1; // invalidates every in-flight callback
    this._connectEpoch = null;
    this._clearRetry();
    this._clearHeartbeat();
    this._rejectAllPending(err('DAEMON_NOT_CONNECTED', 'the daemon link was stopped while a secret request was in flight'));
    if (this.ws) {
      try {
        this.ws.close();
      } catch {}
      this.ws = null;
    }
    this.status = 'off';
  }

  async restart() {
    this.stop();
    this.start();
  }

  _connect(epoch) {
    if (this._stopped || epoch !== this._epoch) return;
    // single-flight per epoch: a config read that resolves after restart must
    // not open a second socket, and the newer attempt must not be blocked by
    // the older one's bookkeeping
    if (this._connectEpoch === epoch) return;
    this._connectEpoch = epoch;
    this.status = 'connecting';
    this.loadConfig().then(({ port, token, enabled }) => {
      if (this._stopped || epoch !== this._epoch) return; // newer start/stop owns state
      if (!enabled) {
        this.status = 'off';
        if (this._connectEpoch === epoch) this._connectEpoch = null;
        return;
      }
      const url = `ws://127.0.0.1:${port}/`;
      let ws;
      try {
        ws = new WebSocket(url, [`ubb-auth.${token}`]);
      } catch {
        if (this._connectEpoch === epoch) this._connectEpoch = null;
        this._retry(0, epoch);
        return;
      }
      this.ws = ws;
      const current = () => !this._stopped && epoch === this._epoch && this.ws === ws;

      ws.addEventListener('open', () => {
        if (!current()) {
          try { ws.close(); } catch {}
          return;
        }
        this._attempt = 0;
        this._lastInbound = Date.now();
        this.status = 'waiting_auth';
        this.send({
          id: 'hello',
          method: 'hello',
          params: {
            protocol_version: PROTOCOL.version,
            min_compatible: PROTOCOL.minCompatible,
            client: PROTOCOL.client,
            version: chrome.runtime.getManifest().version,
            build: BUILD,
            instance_id: this.instanceId,
            browser: detectBrowser(),
          },
        });
        this._startHeartbeat();
      });

      ws.addEventListener('message', (ev) => {
        if (!current()) return;
        this._lastInbound = Date.now();
        let msg;
        try {
          msg = JSON.parse(ev.data);
        } catch {
          return;
        }
        if (msg.id === 'hello' && msg.result) {
          if (this._connectEpoch === epoch) this._connectEpoch = null;
          this.status = 'connected';
        }
        if (msg.method === 'ping') {
          this.send({ method: 'pong' });
          return;
        }
        if (msg.method === 'pong') return;
        if (this.consumePendingResponse(msg)) return; // reverse-RPC reply, not a tool request
        if (this.handler) this.handler(msg);
      });

      ws.addEventListener('close', (ev) => {
        // only the CURRENT socket owns link state — a stale socket closing
        // late must not clear the live socket's heartbeat or status
        if (!current()) return;
        this._clearHeartbeat();
        this.ws = null;
        this.status = 'off';
        if (this._connectEpoch === epoch) this._connectEpoch = null;
        this._rejectAllPending(err('DAEMON_NOT_CONNECTED', 'the daemon link closed while a secret request was in flight'));
        // 1008 = policy violation → daemon rejected our token; retry slowly.
        this._retry(ev.code === 1008 ? 5000 : 0, epoch);
      });

      ws.addEventListener('error', () => {
        /* close event follows */
      });
    }).catch(() => {
      if (this._stopped || epoch !== this._epoch) return;
      if (this._connectEpoch === epoch) this._connectEpoch = null;
      this.status = 'off';
      this._retry(0, epoch);
    });
  }

  _retry(extraDelay = 0, epoch = this._epoch) {
    if (this._stopped || epoch !== this._epoch) return;
    this._attempt = Math.min(this._attempt + 1, 4);
    const backoff = 1000 * Math.pow(2, this._attempt - 1) + extraDelay;
    this._clearRetry();
    this._retryTimer = setTimeout(() => {
      this._retryTimer = null;
      this._connect(epoch);
    }, Math.min(backoff, 15000));
  }

  _clearRetry() {
    if (this._retryTimer) clearTimeout(this._retryTimer);
    this._retryTimer = null;
  }

  _startHeartbeat() {
    this._clearHeartbeat();
    this._hbTimer = setInterval(() => {
      if (!this.ws || this.ws.readyState !== 1) return;
      this.send({ method: 'ping' });
      if (Date.now() - this._lastInbound > HEARTBEAT_MS + HEARTBEAT_TIMEOUT_MS) {
        try {
          this.ws.close();
        } catch {}
      }
    }, HEARTBEAT_MS);
  }

  _clearHeartbeat() {
    if (this._hbTimer) clearInterval(this._hbTimer);
    this._hbTimer = null;
  }

  send(obj) {
    if (this.ws && this.ws.readyState === 1) {
      this.ws.send(JSON.stringify(obj));
      return true;
    }
    return false;
  }

  /**
   * Reverse RPC on the existing authenticated socket: extension asks, daemon
   * answers with the same `s<seq>` id. Used by secret.* tools so a plaintext
   * value never has to appear in an agent-supplied tool argument.
   */
  requestDaemon(method, params = {}, timeoutMs = SECRET_FETCH_TIMEOUT_MS) {
    if (!this.ws || this.ws.readyState !== 1) {
      throw err('DAEMON_NOT_CONNECTED', 'the extension is not connected to the local daemon — check the UBB popup status / `ubb daemon status`');
    }
    const id = `s${++this._rid}`;
    return new Promise((resolve, reject) => {
      const settle = (fn) => {
        const p = this._pending.get(id);
        if (!p) return;
        clearTimeout(p.timer);
        this._pending.delete(id);
        fn();
      };
      const timer = setTimeout(
        () => settle(() => reject(err('SECRET_FETCH_TIMEOUT', `the local UBB daemon did not answer "${method}" in ${Math.round(timeoutMs / 1000)}s; run \`ubb daemon status\` and make sure the vault file is readable`))),
        timeoutMs,
      );
      this._pending.set(id, { resolve: (v) => settle(() => resolve(v)), reject: (e) => settle(() => reject(e)), timer });
      if (!this.send({ id, method, params })) {
        settle(() => reject(err('DAEMON_NOT_CONNECTED', 'the daemon socket closed while asking for a secret')));
      }
    });
  }

  /**
   * True when this frame is the reply to a pending reverse request (and the
   * caller must not hand it to the tool dispatcher). Reply ids are `s<seq>`,
   * request ids the daemon sends us are `x<seq>` or method-only, so a real tool
   * request can never be swallowed here.
   */
  consumePendingResponse(msg) {
    if (!this._pending.size || msg?.id == null) return false;
    const p = this._pending.get(String(msg.id));
    if (!p) return false;
    if (msg.error) p.reject({ code: msg.error.code || 'DAEMON_ERROR', message: msg.error.message || String(msg.error) });
    else p.resolve(msg.result);
    return true;
  }

  _rejectAllPending(error) {
    // settle() inside each wrapper drops the map entry — do not delete here, or
    // the wrapper would consider the request already settled and swallow it
    for (const p of [...this._pending.values()]) p.reject(error);
  }

  emit(event, params) {
    this.send({ method: `event.${event}`, params });
  }
}

function detectBrowser() {
  const ua = navigator.userAgent;
  if (/Edg\//.test(ua)) return 'edge';
  if (/Chrome\//.test(ua)) return 'chrome';
  return 'chromium-like';
}
