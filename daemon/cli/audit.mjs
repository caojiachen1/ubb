// `ubb audit …` — drain the extension's in-memory audit ring to disk and print
// per-tool timing/error stats. Also exports the small WS agent client that
// daemon/cli/liveview.mjs reuses (both files belong to the same agent, see
// _scratch/AGENT-CONTRACT.md §3).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CONFIG_PATH = path.join(os.homedir(), '.ubb', 'config.json');
export const AUDIT_DIR = path.join(os.homedir(), '.ubb', 'audit');

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return {};
  }
}

// daemon/ubb.mjs splices --token/--port/--out out of argv before calling run(),
// so flag values are read from the untouched process.argv instead.
export function rawFlag(name) {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1] !== undefined && !process.argv[i + 1].startsWith('--')) return process.argv[i + 1];
  return undefined;
}

export function resolveCreds({ usePortFlag = true, defaultPort = 8765 } = {}) {
  const cfg = readConfig();
  const token = rawFlag('token') || process.env.UBB_TOKEN || cfg.token;
  const port = Number(
    rawFlag('daemon-port') || (usePortFlag ? rawFlag('port') : undefined) || process.env.UBB_PORT || cfg.port || defaultPort,
  );
  if (!token) throw new Error('ubb: no token — run `ubb config token <token>` (copy it from the extension popup)');
  return { token, port };
}

export class AgentClient {
  constructor({ token, port }) {
    this.token = token;
    this.port = port;
    this.ws = null;
    this._id = 0;
    this._pending = new Map();
    this.events = []; // last 200 broadcast events (event.* frames from the daemon)
    this.onEvent = null;
  }

  connect(timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
      const url = `ws://127.0.0.1:${this.port}/`;
      let ws;
      try {
        ws = new WebSocket(url, [`ubb-agent.${this.token}`]);
      } catch (e) {
        reject(e);
        return;
      }
      this.ws = ws;
      let settled = false;
      const fail = (msg) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error(msg));
      };
      const timer = setTimeout(() => fail(`connect timeout to ${url} — start the daemon: ubb daemon start`), timeoutMs);
      ws.addEventListener('open', () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(this);
        }
      });
      ws.addEventListener('error', () => fail(`cannot reach ${url} — start the daemon: ubb daemon start`));
      ws.addEventListener('close', (ev) => {
        if (ev.code === 1008) fail('daemon rejected the token (check ~/.ubb/config.json / ubb config token)');
        else fail(`connection closed (${ev.code})`);
      });
      ws.addEventListener('message', (ev) => this._onFrame(ev));
    });
  }

  _onFrame(ev) {
    let m;
    try {
      m = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8'));
    } catch {
      return;
    }
    if (m && m.id != null && this._pending.has(m.id)) {
      const p = this._pending.get(m.id);
      this._pending.delete(m.id);
      clearTimeout(p.timer);
      p.resolve(m);
      return;
    }
    if (typeof m?.method === 'string' && m.method.startsWith('event.')) {
      const e = { method: m.method, params: m.params || {}, at: new Date().toISOString() };
      this.events.push(e);
      if (this.events.length > 200) this.events.splice(0, this.events.length - 200);
      if (this.onEvent) this.onEvent(e);
    }
  }

  call(method, params = {}, timeoutMs = 60_000) {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== 1) {
        reject(new Error('agent socket is not open'));
        return;
      }
      const id = ++this._id;
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this._pending.set(id, { resolve, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /** Call an extension tool; throws with .code/.data on a tool error. */
  async tool(name, params = {}, timeoutMs = 60_000) {
    const m = await this.call(`tool.${name}`, params, timeoutMs);
    if (m.error) {
      const e = new Error(m.error.message || JSON.stringify(m.error));
      e.code = m.error.code;
      e.data = m.error.data;
      throw e;
    }
    return m.result;
  }

  close() {
    try {
      this.ws?.close();
    } catch {}
    this.ws = null;
  }
}

// ------------------------------------------------------------------ audit tail

function appendEntries(entries, outFile) {
  const files = new Map();
  for (const e of entries) {
    const day = String(e.t || new Date().toISOString()).slice(0, 10);
    const target = outFile || path.join(AUDIT_DIR, `${day}.jsonl`);
    if (!files.has(target)) files.set(target, []);
    files.get(target).push(JSON.stringify(e));
  }
  for (const [target, lines] of files) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.appendFileSync(target, lines.join('\n') + '\n');
  }
  return files.size;
}

async function runTail(argv) {
  const opts = resolveCreds();
  const since = Number(rawFlag('since') ?? 0) || 0;
  const follow = argv.includes('--follow');
  const outFile = rawFlag('out') || null;
  const client = new AgentClient(opts);
  await client.connect();

  let cursor = since;
  let total = 0;
  let warnedGap = false;
  const stop = (code = 0) => {
    client.close();
    console.error(`\nubb audit: ${total} entr${total === 1 ? 'y' : 'ies'} appended${outFile ? ` to ${outFile}` : ` under ${AUDIT_DIR}`}`);
    process.exit(code);
  };
  process.on('SIGINT', () => stop(0));

  for (;;) {
    let r;
    try {
      r = await client.tool('audit.tail', { since_seq: cursor, limit: 500 }, 30_000);
    } catch (e) {
      console.error(`ubb audit: ${e.code || ''} ${e.message}`);
      if (!follow) stop(1);
      await new Promise((res) => setTimeout(res, 5000));
      continue;
    }
    // service-worker restart resets seq — resume from the fresh ring instead of
    // waiting forever for seq numbers that will never come back
    if (Number(r.ring_seq) < cursor) {
      console.error(`ubb audit: extension restarted (seq reset to ${r.ring_seq}), resuming from 0`);
      cursor = 0;
    }
    if (!warnedGap && Number(r.dropped_before_cursor) > 0) {
      warnedGap = true;
      console.error(`ubb audit: ${r.dropped_before_cursor} entries had already left the 500-ring before the first pull — rerun with --follow to catch them live`);
    }
    const entries = r.entries || [];
    if (entries.length) {
      appendEntries(entries, outFile);
      total += entries.length;
      cursor = r.last_seq;
    }
    if (!follow) break;
    await new Promise((res) => setTimeout(res, 2000));
  }
  stop(0);
}

// ----------------------------------------------------------------- audit stats

async function runStats(argv) {
  const opts = resolveCreds();
  const winRaw = rawFlag('window') || (argv.includes('all') ? 'all' : undefined);
  const client = new AgentClient(opts);
  await client.connect();
  let r;
  try {
    r = await client.tool('audit.stats', winRaw ? { window: winRaw === 'all' ? 'all' : Number(winRaw) } : {}, 30_000);
  } finally {
    client.close();
  }
  if (!r.tools?.length) {
    console.log(`no audited calls in the extension's ring (window ${r.window_days})`);
    return;
  }
  const head = ['tool', 'calls', 'errors', 'avg_ms', 'max_ms'];
  const rows = r.tools.map((t) => [t.tool, String(t.calls), String(t.errors), String(t.avg_ms), String(t.max_ms)]);
  const w = head.map((h, i) => Math.max(h.length, ...rows.map((row) => row[i].length)));
  const line = (cells) => cells.map((c, i) => String(c).padEnd(w[i])).join('  ').trimEnd();
  console.log(line(head));
  for (const row of rows.sort((a, b) => Number(b[1]) - Number(a[1]))) console.log(line(row));
  console.log(`\nwindow: ${r.window_days} day(s)${Array.isArray(r.days) && r.days.length ? ` (${r.days[0]} … ${r.days[r.days.length - 1]})` : ''}`);
  console.log(`totals: ${r.totals.calls} calls, ${r.totals.errors} errors; ring ${r.ring_size}/500 entries, seq ${r.seq}`);
}

export const AUDIT_COMMANDS = [
  {
    name: 'audit',
    describe: 'audit tail [--since N] [--follow] [--out file.jsonl] | audit stats [--window 7|all] — drain the extension audit ring to ~/.ubb/audit/',
    async run(argv) {
      const sub = argv[0];
      if (sub === 'tail') await runTail(argv);
      else if (sub === 'stats') await runStats(argv);
      else {
        console.error('usage: ubb audit tail [--since N] [--follow] [--out file.jsonl]\n       ubb audit stats [--window 7|all]');
        process.exit(2);
      }
    },
  },
];
