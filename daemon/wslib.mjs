// Minimal RFC 6455 WebSocket server (text frames, masking, fragmentation,
// ping/pong, close) — zero dependencies, loopback-only usage intended.

import { createHash } from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_MESSAGE = 16 * 1024 * 1024;

export class WsSocket {
  constructor(socket) {
    this.socket = socket;
    this.buf = Buffer.alloc(0);
    this.fragments = null;
    this.fragOpcode = 0;
    this.closed = false;
    this.onmessage = null;
    this.onclose = null;
    socket.on('data', (d) => this._feed(d));
    socket.on('error', () => this._teardown());
    socket.on('close', () => this._teardown());
  }

  get open() {
    return !this.closed && !!this.socket && !this.socket.destroyed;
  }

  /** Liveness probe: send an app-level ping; resolve true on any frame. */
  probe(ms = 1500) {
    return new Promise((resolve) => {
      if (!this.open) return resolve(false);
      const prevMsg = this.onmessage;
      let done = false;
      const finish = (ok) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        clearInterval(poll);
        this.onmessage = prevMsg;
        resolve(ok);
      };
      const timer = setTimeout(() => finish(this.open && false), ms);
      const poll = setInterval(() => { if (!this.open) finish(false); }, 100);
      this.onmessage = (t) => {
        finish(true);
        if (prevMsg) prevMsg(t);
      };
      try {
        this.send('{"method":"ping"}');
      } catch {
        finish(false);
      }
    });
  }

  _teardown() {
    if (this.closed) return;
    this.closed = true;
    if (this.onclose) this.onclose();
  }

  _feed(data) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, data]) : data;
    while (true) {
      const frame = this._parseFrame();
      if (!frame) break;
      this._handleFrame(frame);
      if (this.closed) break;
    }
  }

  _parseFrame() {
    const b = this.buf;
    if (b.length < 2) return null;
    const fin = (b[0] & 0x80) !== 0;
    const rsv = b[0] & 0x70;
    const opcode = b[0] & 0x0f;
    const masked = (b[1] & 0x80) !== 0;
    let len = b[1] & 0x7f;
    let off = 2;
    if (len === 126) {
      if (b.length < off + 2) return null;
      len = b.readUInt16BE(off);
      off += 2;
    } else if (len === 127) {
      if (b.length < off + 8) return null;
      const big = b.readBigUInt64BE(off);
      if (big > BigInt(MAX_MESSAGE)) {
        this.close(1009, 'too big');
        return null;
      }
      len = Number(big);
      off += 8;
    }
    if (rsv !== 0) {
      this.close(1002, 'protocol error');
      return null;
    }
    if (!masked) {
      this.close(1002, 'client frames must be masked');
      return null;
    }
    if (b.length < off + 4 + len) return null;
    const mask = b.subarray(off, off + 4);
    off += 4;
    const payload = Buffer.from(b.subarray(off, off + len));
    for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
    this.buf = b.subarray(off + len);
    return { fin, opcode, payload };
  }

  _handleFrame({ fin, opcode, payload }) {
    switch (opcode) {
      case 0x0: // continuation
        if (this.fragments) {
          this.fragments.push(payload);
          if (fin) {
            const full = Buffer.concat(this.fragments);
            const op = this.fragOpcode;
            this.fragments = null;
            if (op === 0x1 && this.onmessage) this.onmessage(full.toString('utf8'));
          }
        }
        break;
      case 0x1: // text
      case 0x2: // binary
        if (opcode === 0x2) {
          this.close(1003, 'binary not supported');
          return;
        }
        if (fin) {
          if (this.onmessage) this.onmessage(payload.toString('utf8'));
        } else {
          this.fragments = [payload];
          this.fragOpcode = opcode;
        }
        break;
      case 0x8: // close
        this._sendFrame(0x8, payload.subarray(0, 2));
        this.socket.end();
        this._teardown();
        break;
      case 0x9: // ping → pong
        this._sendFrame(0xa, payload);
        break;
      case 0xa: // pong
        break;
      default:
        this.close(1002, 'bad opcode');
    }
  }

  _sendFrame(opcode, payload = Buffer.alloc(0)) {
    if (this.closed || this.socket.destroyed) return;
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.from([0x80 | opcode, len]);
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    this.socket.write(Buffer.concat([header, payload]));
  }

  send(text) {
    this._sendFrame(0x1, Buffer.from(String(text), 'utf8'));
  }

  close(code = 1000, reason = '') {
    if (this.closed) return;
    const body = Buffer.alloc(2 + Buffer.byteLength(reason));
    body.writeUInt16BE(code, 0);
    body.write(reason, 2);
    this._sendFrame(0x8, body);
    this.socket.end();
    this._teardown();
  }
}

/**
 * Attach a WebSocket endpoint to an HTTP server.
 * onConnection(socket, request, selectedProtocol)
 */
export function attachWs(server, { onConnection }) {
  server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    const protocols = (req.headers['sec-websocket-protocol'] || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (!key || req.headers.upgrade?.toLowerCase() !== 'websocket') {
      socket.destroy();
      return;
    }
    const offered = (req.headers['sec-websocket-protocol'] || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const accept = createHash('sha1').update(key + GUID).digest('base64');
    const chosen = offered[0] || null;
    const lines = [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
    ];
    if (chosen) lines.push(`Sec-WebSocket-Protocol: ${chosen}`);
    socket.write(lines.join('\r\n') + '\r\n\r\n');
    const ws = new WsSocket(socket);
    onConnection(ws, req, chosen, { offeredAny: offered.length > 0 });
  });
}
