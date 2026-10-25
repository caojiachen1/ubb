// Outbound agent link: the extension dials the local daemon over WebSocket
// with a token-bearing subprotocol (BrowserSkill direction + Qoder token auth).
// The extension never listens on a port.

import { PROTOCOL, HEARTBEAT_MS, HEARTBEAT_TIMEOUT_MS, randomHex } from './config.js';

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
  }

  async start() {
    this._stopped = false;
    this._connect();
  }

  stop() {
    this._stopped = true;
    this._connecting = false;
    this._clearHeartbeat();
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

  _connect() {
    if (this._stopped) return;
    // single-flight: never two concurrent connection attempts (the keepalive
    // alarm used to race loadConfig() here and spawn duplicate sockets)
    if (this._connecting) return;
    this._connecting = true;
    this.status = 'connecting';
    this.loadConfig().then(({ port, token, enabled }) => {
      if (this._stopped) {
        this._connecting = false;
        return;
      }
      if (!enabled) {
        this.status = 'off';
        this._connecting = false;
        return;
      }
      const url = `ws://127.0.0.1:${port}/`;
      let ws;
      try {
        ws = new WebSocket(url, [`ubb-auth.${token}`]);
      } catch {
        this._connecting = false;
        this._retry();
        return;
      }
      this.ws = ws;

      ws.addEventListener('open', () => {
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
            instance_id: this.instanceId,
            browser: detectBrowser(),
          },
        });
        this._startHeartbeat();
      });

      ws.addEventListener('message', (ev) => {
        this._lastInbound = Date.now();
        let msg;
        try {
          msg = JSON.parse(ev.data);
        } catch {
          return;
        }
        if (msg.id === 'hello' && msg.result) {
          this._connecting = false;
          this.status = 'connected';
        }
        if (msg.method === 'ping') {
          this.send({ method: 'pong' });
          return;
        }
        if (msg.method === 'pong') return;
        if (this.handler) this.handler(msg);
      });

      ws.addEventListener('close', (ev) => {
        this._clearHeartbeat();
        // only the CURRENT socket owns link state; a stale duplicate closing
        // must not clobber a live connection
        if (this.ws !== ws) return;
        this.ws = null;
        this.status = 'off';
        this._connecting = false;
        // 1008 = policy violation → daemon rejected our token; retry slowly.
        this._retry(ev.code === 1008 ? 5000 : 0);
      });

      ws.addEventListener('error', () => {
        /* close event follows */
      });

      // safety net: if the socket never opens (dead port), release single-flight
      setTimeout(() => {
        if (this.ws === ws && ws.readyState !== 1) {
          /* close event will fire; nothing to do here */
        }
      }, 0);
    });
  }

  _retry(extraDelay = 0) {
    if (this._stopped) return;
    this._attempt = Math.min(this._attempt + 1, 4);
    const backoff = 1000 * Math.pow(2, this._attempt - 1) + extraDelay;
    setTimeout(() => this._connect(), Math.min(backoff, 15000));
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
