// `ubb liveview` — a human-watching mirror of the agent's screencast.
// Frames come from the existing screencast.* tools (no CDP event hook, which is
// single-slot and owned by lib/tools.js), are written to ~/.ubb/liveview/latest.jpg
// and served over a loopback-only HTTP page. Every request must carry the UBB
// token (query param once, then the cookie) or it is refused with 403.
// Ports (Wave 4a, one global meaning): --port / UBB_PORT / config.port is always
// the DAEMON port; the preview listener takes --view-port (default 8790).

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { AgentClient, resolveCreds, rawFlag } from './audit.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Invariant: the liveview server must never bind a non-loopback interface. */
export const LIVEVIEW_BIND = '127.0.0.1';
export const LIVEVIEW_DIR = path.join(os.homedir(), '.ubb', 'liveview');
export const FRAME_FILE = path.join(LIVEVIEW_DIR, 'latest.jpg');
/** Preview port default. `--port` is NEVER the preview port (Wave 4a): use --view-port. */
export const DEFAULT_VIEW_PORT = 8790;
const CONSOLE_DIR = path.join(HERE, '..', '..', 'console');
const COOKIE = 'ubb_liveview';
/** Screencast slot owner (lib/tools.js checks it: SCREENCAST_BUSY, owner-gated stop). */
export const LIVEVIEW_OWNER = 'liveview';
/**
 * How long this client may be silent before the extension hands the slot to the
 * next caller. The frame loop pulls every ~300ms, so 20s means "the pump died",
 * and it is what releases the slot when this process is killed with
 * taskkill /F (no exit hook of ours ever runs in that case).
 */
export const LIVEVIEW_LEASE_MS = 20_000;

const num = (v) => (v == null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));

/**
 * One global meaning for --port: the DAEMON port, everywhere.
 * The preview listener gets its own flag (--view-port / UBB_LIVEVIEW_PORT);
 * --daemon-port stays accepted as the pre-Wave-4 alias for the same thing.
 * Pure: the caller hands in whatever it resolved from its own config lookup.
 */
export function resolveLiveviewPorts(argv = process.argv, { env = process.env, fallbackDaemonPort = null } = {}) {
  const at = (name) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const portFlag = num(at('port'));
  const daemonFlag = num(at('daemon-port'));
  const viewRaw = at('view-port');
  const viewFlag = num(viewRaw);
  if (viewRaw !== undefined && viewFlag === null) throw new Error(`ubb liveview: --view-port must be a number (got ${viewRaw})`);
  if (daemonFlag !== null && portFlag !== null && daemonFlag !== portFlag) {
    console.error(`ubb liveview: ignoring --daemon-port ${daemonFlag} — --port ${portFlag} is the daemon port now`);
  }
  const daemon = portFlag ?? daemonFlag ?? num(env.UBB_PORT) ?? fallbackDaemonPort;
  if (daemon === null) throw new Error('ubb liveview: cannot resolve the daemon port — pass --port, set UBB_PORT, or run `ubb config port <n>`');
  const view = viewFlag ?? num(env.UBB_LIVEVIEW_PORT) ?? DEFAULT_VIEW_PORT;
  if (view === daemon) {
    throw new Error(`ubb liveview: the preview port must differ from the daemon port (${daemon}) — --port is the daemon port; choose the preview with --view-port <other>`);
  }
  return { daemon, view, legacy: portFlag !== null && viewFlag === null && env.UBB_LIVEVIEW_PORT == null };
}

function sameToken(a, b) {
  const x = Buffer.from(String(a || ''), 'utf8');
  const y = Buffer.from(String(b || ''), 'utf8');
  if (x.length !== y.length) return false;
  return crypto.timingSafeEqual(x, y);
}

export function authorized(req, token) {
  if (!token) return false;
  let url;
  try {
    url = new URL(req.url, `http://${LIVEVIEW_BIND}`);
  } catch {
    return false;
  }
  if (sameToken(url.searchParams.get('token'), token)) return true;
  const raw = req.headers?.cookie || '';
  for (const part of raw.split(/;\s*/)) {
    if (!part.startsWith(`${COOKIE}=`)) continue;
    let value;
    try {
      value = decodeURIComponent(part.slice(COOKIE.length + 1));
    } catch {
      return false; // malformed %-encoding must be a 403, not a crash
    }
    return sameToken(value, token);
  }
  return false;
}

/**
 * The request handler, exported so tests can drive it without a socket.
 * state: { frame: Buffer|null, events: [], w, h, ts, frames, startedAt }
 */
export function makeHandler({ token, state, consoleDir = CONSOLE_DIR }) {
  const send = (res, status, headers, body) => {
    res.writeHead(status, { 'Cache-Control': 'no-store', ...headers });
    res.end(body);
  };
  return function handle(req, res) {
    if (!authorized(req, token)) {
      send(res, 403, { 'Content-Type': 'text/plain; charset=utf-8' }, '403 — 缺少或错误的 token（在 URL 后加 ?token=<UBB token>）\n');
      return;
    }
    const url = new URL(req.url, `http://${LIVEVIEW_BIND}`);
    const page = (file, type, setCookie) => {
      let body;
      try {
        body = fs.readFileSync(path.join(consoleDir, file));
      } catch {
        send(res, 500, { 'Content-Type': 'text/plain; charset=utf-8' }, `missing ${file} (looked in ${consoleDir})\n`);
        return;
      }
      const headers = { 'Content-Type': `${type}; charset=utf-8` };
      // the token arrives once in the query; hand it to the page as a cookie so the
      // script/img subrequests are authorized without inlining it into the markup
      // HttpOnly: page script never needs to read the view credential
      if (setCookie) headers['Set-Cookie'] = `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict`;
      send(res, 200, headers, body);
    };
    if (url.pathname === '/' || url.pathname === '/index.html') {
      page('liveview.html', 'text/html', url.searchParams.get('token') != null);
      return;
    }
    if (url.pathname === '/liveview.js') {
      page('liveview.js', 'application/javascript');
      return;
    }
    if (url.pathname === '/frame.jpg') {
      if (!state.frame) {
        send(res, 404, { 'Content-Type': 'text/plain; charset=utf-8' }, 'no frame yet\n');
        return;
      }
      send(res, 200, { 'Content-Type': 'image/jpeg', 'Content-Length': String(state.frame.length) }, state.frame);
      return;
    }
    if (url.pathname === '/events') {
      const events = (state.events || []).slice(-60).reverse().map((e) => ({
        at: e.at,
        name: String(e.method || '').replace(/^event\./, ''),
        params: e.params || {},
      }));
      send(res, 200, { 'Content-Type': 'application/json; charset=utf-8' }, JSON.stringify({
        events,
        frames: state.frames || 0,
        size: state.frame ? state.frame.length : 0,
        started_at: state.startedAt || null,
      }));
      return;
    }
    send(res, 404, { 'Content-Type': 'text/plain; charset=utf-8' }, 'not found\n');
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function run() {
  const base = resolveCreds(); // token + the global daemon port (--port > UBB_PORT > config)
  const ports = resolveLiveviewPorts(process.argv, { fallbackDaemonPort: base.port });
  const creds = { token: base.token, port: ports.daemon };
  const httpPort = ports.view;
  if (ports.legacy) {
    console.error(
      `ubb liveview: --port is the DAEMON port (${ports.daemon}) — the preview listens on ${httpPort}; move it with --view-port (scripts written before Wave 4 used --port for the preview)`,
    );
  }
  const fps = Math.min(Math.max(Number(rawFlag('fps')) || 2, 0.2), 10);
  const tabRaw = rawFlag('tab');
  const tabId = tabRaw != null && tabRaw !== '' ? Number(tabRaw) : undefined;
  if (tabRaw != null && Number.isNaN(tabId)) throw new Error('ubb liveview: --tab must be a number');
  const target = tabId != null ? { tab_id: tabId } : {};

  const client = new AgentClient(creds);
  try {
    await client.connect();
  } catch (e) {
    const hint = ports.legacy ? ` — if you meant --port as the preview port, write: ubb liveview --view-port ${httpPort}` : '';
    throw new Error(`${e.message}${hint}`);
  }
  try {
    await client.tool('screencast.start', { ...target, owner: LIVEVIEW_OWNER, lease_ms: LIVEVIEW_LEASE_MS });
  } catch (e) {
    client.close();
    if (e.code === 'SCREENCAST_BUSY') {
      // the slot is held by another client — never take it over silently
      throw new Error(
        `ubb liveview: the tab screencast is already held (${e.message}) — let that client release it, wait for its lease to lapse (the slot frees itself once nobody pulls frames), or start liveview with --tab <other tab>; liveview does not steal casts`,
      );
    }
    throw new Error(
      `ubb liveview: screencast.start failed (${e.code || 'ERR'}: ${e.message}) — ` +
        (e.code === 'NO_SESSION' || e.code === 'NO_TAB' ? 'start a session first: ubb session.start / ubb tab.create' : 'check ubb status'),
    );
  }

  const state = { frame: null, events: client.events, frames: 0, startedAt: new Date().toISOString(), fps };
  // The preview is READ-ONLY and must not be able to drive the browser. It
  // therefore gets its own short-lived credential instead of the daemon token,
  // which would also be shared with every same-host port via cookie scope.
  const viewToken = crypto.randomBytes(32).toString('hex');
  const handler = makeHandler({ token: viewToken, state });
  const server = http.createServer((req, res) => {
    handler(req, res);
  });
  server.on('error', (e) => {
    console.error(`ubb liveview: cannot listen on ${LIVEVIEW_BIND}:${httpPort} — ${e.message} (pick another --view-port; --port is the daemon port)`);
    process.exit(1);
  });

  let stopped = false;
  const shutdown = async (reason) => {
    if (stopped) return;
    stopped = true;
    try {
      server.close();
    } catch {}
    try {
      await client.tool('screencast.stop', { ...target, owner: LIVEVIEW_OWNER }, 5000);
    } catch (e) {
      console.error(`ubb liveview: screencast.stop did not confirm (${e.code || e.message}) — the tab may still be casting; the extension releases this owner's slot when the lease lapses (${LIVEVIEW_LEASE_MS}ms without a frame pull)`);
    }
    client.close();
    console.log(`\nubb liveview: ${reason} — stopped (screencast released)`);
    process.exit(0);
  };
  // every path that can end this process goes through shutdown(): the two
  // signals a human actually uses, plus the crash paths, because an uncaught
  // error used to leave the slot held by "liveview" with nothing left running
  // (LIVE-RESULTS-3B §6e② — taskkill /F has NO hook and is covered by the lease).
  process.on('SIGINT', () => shutdown('Ctrl+C'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGBREAK', () => shutdown('Ctrl+Break'));
  process.on('uncaughtException', (e) => {
    console.error(`ubb liveview: uncaught ${e?.stack || e} — stopping and releasing the screencast`);
    shutdown('uncaught error').catch(() => process.exit(1));
  });
  process.on('unhandledRejection', (e) => {
    console.error(`ubb liveview: unhandled rejection ${e?.stack || e} — stopping and releasing the screencast`);
    shutdown('unhandled rejection').catch(() => process.exit(1));
  });

  server.listen(httpPort, LIVEVIEW_BIND, () => {
    console.log(`live view: http://${LIVEVIEW_BIND}:${httpPort}/?token=${viewToken}  (daemon ${LIVEVIEW_BIND}:${ports.daemon})`);
    console.log('  token: 本次进程生成的只读预览凭据（不是 daemon token；退出即失效）');
    console.log(`  frames → ${FRAME_FILE} (${fps}/s)，Ctrl+C 结束并停止 screencast（被 taskkill /F 强杀时没有退出钩子，扩展侧的 ${LIVEVIEW_LEASE_MS}ms 租约会自行收回槽位）`);
    console.log(`  提示: 动画/悬停需要页面可见 — 先 ubb tab.select '${tabId != null ? `{"tab_id":${tabId}}` : '(session 最近标签)'}'；不带 --tab 时跟随会话的最近标签`);
  });

  const every = Math.round(1000 / fps);
  let lastWrite = 0;
  let errors = 0;
  // these mean the cast/session is gone: no point spinning, release and exit
  const FATAL = new Set(['NO_SCREENCAST', 'NO_SESSION', 'NO_TAB', 'TAB_NOT_OWNED', 'EXTENSION_DISCONNECTED', 'EXTENSION_NOT_CONNECTED']);
  while (!stopped) {
    let r = null;
    try {
      r = await client.tool('screencast.next', { ...target, wait_ms: 300, owner: LIVEVIEW_OWNER }, 12_000);
      errors = 0;
    } catch (e) {
      if (stopped) break;
      console.error(`ubb liveview: ${e.code || ''} ${e.message}`);
      if (FATAL.has(e.code) || ++errors >= 5) {
        await shutdown(`screencast went away (${e.code || 'repeated errors'})`);
        break;
      }
      await sleep(1000);
      continue;
    }
    const frame = r?.frame;
    if (!frame) {
      await sleep(60);
      continue;
    }
    // drain continuously (backpressure lives in the extension), store at fps
    if (Date.now() - lastWrite >= every) {
      lastWrite = Date.now();
      const buf = Buffer.from(frame.jpeg_base64, 'base64');
      state.frame = buf;
      state.frames += 1;
      state.size = buf.length;
      try {
        fs.mkdirSync(LIVEVIEW_DIR, { recursive: true });
        fs.writeFileSync(FRAME_FILE, buf);
      } catch (e) {
        console.error(`ubb liveview: cannot write ${FRAME_FILE} — ${e.message}`);
      }
    }
  }
}

export const LIVEVIEW_COMMANDS = [
  {
    name: 'liveview',
    describe: `liveview [--view-port ${DEFAULT_VIEW_PORT}] [--tab <id>] [--fps 2] [--port <daemon port>] — loopback-only JPEG preview of the agent's screencast for humans to watch (--port is always the daemon port; --view-port moves the preview)`,
    run: () => run(),
  },
];
