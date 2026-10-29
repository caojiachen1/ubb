#!/usr/bin/env node
// ubb MCP stdio adapter — backup interface for MCP-capable IDE agents
// (Qoder, TRAE, ...). The primary interface stays the `ubb` CLI + agent
// skill; this adapter only translates Model Context Protocol to the same
// daemon the CLI talks to, so both share one session state and one daemon.
//
//   node daemon/mcp.mjs
//
// Zero dependencies (Node >= 22, global WebSocket). Newline-delimited
// JSON-RPC 2.0 on stdio; logs go to stderr only. Curated ubb_* tools cover
// the high-frequency workflow; `ubb_call` reaches every catalog tool.
// The tool definitions themselves live in daemon/mcp-tools/ (index.mjs
// aggregates them) so feature agents never edit this protocol shell.

import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOOLS } from './mcp-tools/index.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE = path.join(HERE, 'ubb-bridge.mjs');
const CONFIG_PATH = path.join(os.homedir(), '.ubb', 'config.json');

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return {};
  }
}

const TOKEN = process.env.UBB_TOKEN || readConfig().token;
const PORT = Number(process.env.UBB_PORT || readConfig().port || 8765);
const log = (...a) => console.error('[ubb-mcp]', ...a);

if (!TOKEN) {
  log('no token — run `ubb config token <token>` (or set UBB_TOKEN) first');
  process.exit(1);
}
if (typeof WebSocket !== 'function') {
  log('Node >= 22 required (needs the global WebSocket client)');
  process.exit(1);
}

// ---------------------------------------------------------------- daemon link

const CALL_TIMEOUT_MS = 180000; // cover record_start (10 min cap excluded) & slow pages
const MCP_VERSIONS = new Set(['2024-11-05', '2025-03-26', '2025-06-18']);

function health(ms = 800) {
  return fetch(`http://127.0.0.1:${PORT}/health`, { signal: AbortSignal.timeout(ms) })
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);
}

async function ensureDaemon() {
  if (await health()) return true;
  log(`daemon not running on :${PORT}; starting…`);
  let stdio = 'ignore';
  try {
    const fd = fs.openSync(path.join(path.dirname(CONFIG_PATH), 'daemon.log'), 'w');
    stdio = ['ignore', fd, fd];
  } catch { /* fall back to ignore */ }
  spawn(process.execPath, [BRIDGE, '--port', String(PORT), '--token', TOKEN], {
    detached: true,
    stdio,
    windowsHide: true,
  }).unref();
  for (let i = 0; i < 25; i++) {
    await delay(200);
    if (await health(400)) return true;
  }
  return false;
}

let ws = null;
let connecting = null;
const pending = new Map(); // daemon id -> { resolve, reject, timer }
let daemonSeq = 0;
const inflightMcp = new Map(); // mcp tools/call id -> daemon id (for cancellation)
const cancelledMcp = new Set(); // cancel arrived before the daemon id existed

function connect() {
  if (ws && ws.readyState === 1) return Promise.resolve(ws);
  if (connecting) return connecting;
  connecting = (async () => {
    if (!(await ensureDaemon())) throw new Error(`daemon failed to start on :${PORT}`);
    return await new Promise((resolve, reject) => {
      const s = new WebSocket(`ws://127.0.0.1:${PORT}/`, [`ubb-agent.${TOKEN}`]);
      s.addEventListener('open', () => resolve(s), { once: true });
      s.addEventListener('error', () => reject(new Error('daemon connect failed (token mismatch? run: ubb status)')), { once: true });
      s.addEventListener('message', (ev) => {
        let m;
        try { m = JSON.parse(ev.data); } catch { return; }
        if (m.id != null && (m.result !== undefined || m.error !== undefined)) {
          const p = pending.get(m.id);
          if (!p) return;
          pending.delete(m.id);
          clearTimeout(p.timer);
          if (m.error) {
            const e = new Error(`UBB ${m.error.code}: ${m.error.message}`);
            e.ubbCode = m.error.code;
            p.reject(e);
          } else {
            p.resolve(m.result);
          }
        }
        // events (session.interrupted etc.) are ignored; the CLI surfaces them
      });
      s.addEventListener('close', (e) => {
        ws = null;
        for (const [, p] of pending) {
          clearTimeout(p.timer);
          p.reject(new Error(`daemon connection closed (${e.code})`));
        }
        pending.clear();
      });
      ws = s;
    });
  })();
  const p = connecting;
  // The adapter must survive a daemon that is not up yet: an unhandled
  // rejection here used to kill the whole MCP process on the first call.
  p.catch(() => {}).finally(() => {
    if (connecting === p) connecting = null;
  });
  return p;
}

function callDaemon(method, params, timeoutMs = CALL_TIMEOUT_MS, mcpReqId = null) {
  let daemonId = null;
  const promise = new Promise((resolve, reject) => {
    connect().then((socket) => {
      const id = ++daemonSeq;
      daemonId = id;
      if (mcpReqId != null && cancelledMcp.has(mcpReqId)) {
        // cancellation raced the connection; honour it now that it can travel
        socket.send(JSON.stringify({ method: 'cancel', params: { id } }));
      }
      const timer = setTimeout(() => {
        if (!pending.has(id)) return;
        pending.delete(id);
        reject(new Error(`UBB call timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params }));
    }, reject);
  });
  promise.daemonId = () => daemonId;
  return promise;
}

async function catalogNames() {
  if (!catalogNames.cache) {
    const r = await callDaemon('tool.list', {}, 20000);
    catalogNames.cache = new Set((r?.tools || []).map((t) => t.name));
  }
  return catalogNames.cache;
}

// ---------------------------------------------------------------- result → MCP

function metaOf(r) {
  // keep pagination/coverage signals alive when the payload is a plain text body
  const keys = ['next_cursor', 'ref_count', 'capture_id', 'url', 'title', 'coverage', 'warnings', 'saved_to'];
  const meta = {};
  for (const k of keys) if (r && r[k] !== undefined) meta[k] = r[k];
  return Object.keys(meta).length ? meta : null;
}

function stringifyResult(r) {
  if (r === undefined || r === null) return '(no output)';
  if (typeof r.text === 'string') {
    const meta = metaOf(r);
    return meta ? `${r.text}\n\n${JSON.stringify(meta)}` : r.text;
  }
  return JSON.stringify(r, null, 2);
}

// Extension comes from the tool's real format (png/jpeg/jpg/pdf/webp/…), not
// a png fallback: a PDF stamped .png is a corrupt-file generator. Unknown or
// missing formats keep the old png default; the format string is filtered
// because it is a system-boundary value (model-supplied args).
function extForFormat(format) {
  const f = String(format || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  if (!f) return 'png';
  return f === 'jpeg' ? 'jpg' : f;
}

function autoSaveDir() {
  return path.join(path.dirname(CONFIG_PATH), 'shots');
}

function writeScreenshot(dir, p) {
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(dir, `${stamp}.${extForFormat(p.format)}`);
}

async function callTool(reqId, { name, arguments: args }) {
  args = args && typeof args === 'object' ? { ...args } : {};
  try {
    let toolName;
    let def = null;
    let autoPath = false; // file name can only be picked once the result says its format
    let params;
    if (name === 'ubb_call') {
      const raw = String(args.tool || '').replace(/^tool\./, '');
      if (!raw) throw new Error('ubb_call: tool name required');
      if (raw === 'list') {
        // tool.list is a daemon method, not a tool: `tool.${name}` would call
        // the nonexistent tool.tool.list and the documented catalog escape
        // hatch would fail.
        const catalog = await callDaemon('tool.list', {}, 20_000, reqId);
        return { content: [{ type: 'text', text: JSON.stringify(catalog, null, 2) }] };
      }
      const names = await catalogNames();
      toolName = names.has(raw) ? raw : raw.replace(/_/g, '.');
      if (!names.has(toolName)) {
        throw new Error(`unknown UBB tool "${raw}" — see the catalog via ubb_call {"tool":"tool.list"} or use a dedicated ubb_* tool`);
      }
      params = args.params && typeof args.params === 'object' ? args.params : {};
    } else {
      def = TOOLS.find((t) => t.name === name);
      if (!def) throw new Error(`unknown tool: ${name}`);
      toolName = def.ubb;
      // screenshot-specific knobs are adapter-side, never forwarded
      const { save_to, inline, ...rest } = args;
      params = rest;
      if (def.binary && inline !== true) {
        if (typeof save_to === 'string' && save_to) params.save_to = save_to;
        else autoPath = true;
      }
    }

    const p = callDaemon(`tool.${toolName}`, params, CALL_TIMEOUT_MS, reqId);
    if (reqId != null) inflightMcp.set(reqId, p);
    let r;
    try {
      r = await p;
    } finally {
      if (reqId != null) {
        inflightMcp.delete(reqId);
        cancelledMcp.delete(reqId);
      }
    }

    // binary result: file already requested via save_to → strip base64;
    // otherwise inline it as an image block
    if (r && typeof r.data_base64 === 'string') {
      const { data_base64, ...meta } = r;
      const dest = params.save_to || (autoPath ? writeScreenshot(autoSaveDir(), { format: r.format }) : null);
      if (dest) {
        fs.mkdirSync(path.dirname(path.resolve(dest)), { recursive: true });
        fs.writeFileSync(dest, Buffer.from(data_base64, 'base64'));
        return { content: [{ type: 'text', text: JSON.stringify({ ...meta, saved_to: path.resolve(dest) }, null, 2) }] };
      }
      if (args.inline === true || (name === 'ubb_call' && /image|png|jpe?g/i.test(`${r.format || ''} ${r.mime_type || ''}`))) {
        const mime = r.mime_type || `image/${r.format === 'jpeg' ? 'jpeg' : 'png'}`;
        const { data_base64: _b64, ...textMeta } = r;
        return {
          content: [
            { type: 'image', data: data_base64, mimeType: mime },
            { type: 'text', text: JSON.stringify(textMeta) },
          ],
        };
      }
      return { content: [{ type: 'text', text: JSON.stringify({ ...meta, note: `${Math.round(data_base64.length * 0.75 / 1024)}KB binary; pass save_to (or inline:true for screenshots) to receive it` }, null, 2) }] };
    }

    // too_big contract (print_pdf): over 3MB the extension withholds the
    // base64 — no data_base64 above, so nothing is ever written here.
    // Point at the CLI --out path (it refetches with include_base64).
    if (r && r.too_big === true && autoPath) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ ...r, mcp_note: `${r.note || 'over the inline cap'} — nothing was auto-saved; run: ubb ${toolName} --out <path>.${extForFormat(r.format)}` }, null, 2),
        }],
      };
    }

    return { content: [{ type: 'text', text: stringifyResult(r) }] };
  } catch (e) {
    const hint = e.ubbCode === 'NO_SESSION'
      ? ' — call ubb_session_start (or ubb_tab_create, which auto-starts one) first'
      : e.ubbCode === 'REF_UNKNOWN'
        ? ' — refs were invalidated by navigation; take a fresh ubb_snapshot'
        : e.ubbCode === 'NEEDS_CONFIRM'
          ? ' — retry with confirm:true after asking the user'
          : e.ubbCode === 'TAB_NOT_OWNED'
            ? ' — claim the tab with ubb_tab_claim first, or create your own with ubb_tab_create'
            : '';
    return { content: [{ type: 'text', text: `UBB error: ${e.message}${hint}` }], isError: true };
  }
}

// ---------------------------------------------------------------- MCP protocol

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

const INSTRUCTIONS =
  'UBB drives the user\'s real, logged-in browser (Edge/Chrome). Core loop: ' +
  'ubb_session_start → ubb_tab_create {url} → ubb_snapshot → act on @eN refs → ' +
  'verify with ubb_wait_for / ubb_screenshot → ubb_session_stop. ' +
  'Refs come ONLY from ubb_snapshot and die on navigation. Password/OTP/payment fields are never auto-filled; ' +
  'destructive or paid actions need confirm:true after asking the user. ' +
  'If the user presses 停止代理 you will see a session.interrupted error: stop and report.';

async function handle(msg) {
  const { id, method, params } = msg || {};
  if (typeof method === 'string' && method.startsWith('notifications/')) {
    if (method === 'notifications/cancelled' && params?.requestId != null) {
      const entry = inflightMcp.get(params.requestId);
      const daemonId = entry?.daemonId?.();
      if (daemonId != null && ws && ws.readyState === 1) {
        ws.send(JSON.stringify({ method: 'cancel', params: { id: daemonId } }));
      } else if (entry) {
        cancelledMcp.add(params.requestId);
      }
    }
    return;
  }
  if (id == null) return;
  try {
    switch (method) {
      case 'initialize':
        return send({
          jsonrpc: '2.0',
          id,
          result: {
            // answer with a version this adapter actually implements; echoing
            // an arbitrary client string claims capabilities we do not have
            protocolVersion: MCP_VERSIONS.has(params?.protocolVersion) ? params.protocolVersion : MCP_VERSIONS.values().next().value,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: 'ubb', version: '1.0.0' },
            instructions: INSTRUCTIONS,
          },
        });
      case 'ping':
        return send({ jsonrpc: '2.0', id, result: {} });
      case 'tools/list':
        return send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
      case 'tools/call':
        return send({ jsonrpc: '2.0', id, result: await callTool(id, params || {}) });
      default:
        return send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not supported: ${method}` } });
    }
  } catch (e) {
    return send({ jsonrpc: '2.0', id, error: { code: -32603, message: e.message } });
  }
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error: one JSON-RPC message per line' } });
      continue;
    }
    handle(msg);
  }
});
process.stdin.on('end', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));

log(`ready — daemon :${PORT}, ${TOOLS.length} tools; primary interface stays the ubb CLI`);
