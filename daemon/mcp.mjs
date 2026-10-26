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

import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
  connecting.finally(() => { connecting = null; });
  return connecting;
}

function callDaemon(method, params, timeoutMs = CALL_TIMEOUT_MS) {
  let daemonId = null;
  const promise = new Promise((resolve, reject) => {
    connect().then((socket) => {
      const id = ++daemonSeq;
      daemonId = id;
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

// ---------------------------------------------------------------- tool catalog

const s = (t, desc) => ({ type: t, description: desc });
const TAB_ID = ['tab_id', s('number', 'Session tab id (from ubb_tab_list / ubb_tab_create). Omit to use the most recent session tab.')];

const TOOLS = [
  {
    name: 'ubb_session_start',
    description: 'Start an agent session. Default: agent tabs are auto-grouped into the "⏳ UBB" tab group in the user\'s window, opening silently in the background. own_window:true creates a DEDICATED UNFOCUSED agent window instead (user is never disturbed); raise it with ubb_tab_select only when the page must be visible.',
    inputSchema: {
      type: 'object',
      properties: {
        own_window: s('boolean', 'Run all agent tabs in a dedicated unfocused window.'),
        name: s('string', 'Session label shown in the tab group.'),
      },
      additionalProperties: true,
    },
    ubb: 'session.start',
  },
  {
    name: 'ubb_session_stop',
    description: 'End the session: group turns ✅, agent-created tabs close, claimed tabs return to the user. Call this when the task is done.',
    inputSchema: {
      type: 'object',
      properties: { close_created: s('boolean', 'false keeps agent-created tabs open.') },
      additionalProperties: true,
    },
    ubb: 'session.stop',
  },
  {
    name: 'ubb_session_status',
    description: 'Active session info (also confirms the daemon/extension link).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: true },
    ubb: 'session.status',
  },
  {
    name: 'ubb_tab_list',
    description: 'List tabs. scope "user" lists the user\'s own tabs (take one over with ubb_tab_claim); scope "session" lists session tabs.',
    inputSchema: {
      type: 'object',
      properties: { scope: s('string', '"session" (default) or "user".') },
      additionalProperties: true,
    },
    ubb: 'tab.list',
  },
  {
    name: 'ubb_tab_create',
    description: 'Create a tab inside the UBB group (auto-starts a session if needed). Opens SILENTLY in the background; pass active:true only for pages that must be visible (CSS hover menus, video).',
    inputSchema: {
      type: 'object',
      properties: {
        url: s('string', 'URL; scheme optional ("example.com" is fine).'),
        active: s('boolean', 'Bring the new tab to front.'),
      },
      required: ['url'],
      additionalProperties: true,
    },
    ubb: 'tab.create',
  },
  {
    name: 'ubb_tab_close',
    description: 'Close a session-owned tab.',
    inputSchema: { type: 'object', properties: { tab_id: s('number', 'Tab to close.') }, required: ['tab_id'], additionalProperties: true },
    ubb: 'tab.close',
  },
  {
    name: 'ubb_tab_select',
    description: 'Bring a session tab (+ its window) to front. Only needed for visibility-dependent work: CSS :hover menus, live screencast of animated pages, lazy-load-dependent extraction.',
    inputSchema: { type: 'object', properties: { tab_id: s('number', 'Tab to raise.') }, required: ['tab_id'], additionalProperties: true },
    ubb: 'tab.select',
  },
  {
    name: 'ubb_tab_claim',
    description: 'Take over a tab the user opened (from ubb_tab_list scope:"user"). An on-page banner appears and the USER must click 允许 within 60s (default deny). Never work around a denied claim.',
    inputSchema: { type: 'object', properties: { tab_id: s('number', 'User tab to claim.') }, required: ['tab_id'], additionalProperties: true },
    ubb: 'tab.claim',
  },
  {
    name: 'ubb_tab_release',
    description: 'Release a claimed tab back to the user.',
    inputSchema: { type: 'object', properties: { tab_id: s('number', 'Claimed tab to release.') }, additionalProperties: true },
    ubb: 'tab.release',
  },
  {
    name: 'ubb_navigate',
    description: 'Navigate the target tab. Auto-prepends https://. chrome://, edge:// and extension-store pages are blocked.',
    inputSchema: {
      type: 'object',
      properties: { url: s('string', 'Destination URL.'), ...Object.fromEntries([TAB_ID]) },
      required: ['url'],
      additionalProperties: true,
    },
    ubb: 'navigate',
  },
  {
    name: 'ubb_reload',
    description: 'Reload the target tab.',
    inputSchema: { type: 'object', properties: { ...Object.fromEntries([TAB_ID]) }, additionalProperties: true },
    ubb: 'reload',
  },
  {
    name: 'ubb_snapshot',
    description: 'Accessibility-tree snapshot with @eN refs — the ONLY source of refs for ubb_click/fill/hover/upload_file. Refs survive across snapshots of one capture; navigation invalidates them (REF_UNKNOWN → take a fresh snapshot). Large pages return next_cursor: pass it back to read more of the SAME capture (refs stay valid within one capture). probe_hover reveals a collapsed hover menu: hover the trigger, then use the revealed items\' refs (CSS :hover needs a visible window).',
    inputSchema: {
      type: 'object',
      properties: {
        tab_id: s('number', 'Session tab.'),
        filter: s('string', '"interactive" (default) or "all".'),
        max_chars: s('number', 'Truncation budget (default 60000).'),
        cursor: s('string', 'next_cursor from a previous snapshot of the same capture.'),
        probe_hover: s('string', '"@eN" of a collapsed submenu trigger to reveal.'),
      },
      additionalProperties: true,
    },
    ubb: 'snapshot',
  },
  {
    name: 'ubb_read_page',
    description: 'Main-content plain text of the page (article/main heuristics).',
    inputSchema: {
      type: 'object',
      properties: { max_chars: s('number', 'Text budget (default 50000).'), ...Object.fromEntries([TAB_ID]) },
      additionalProperties: true,
    },
    ubb: 'read_page',
  },
  {
    name: 'ubb_find',
    description: 'Keyword search over visible elements; returns matches with @eN refs where possible. Handy when the snapshot is unclear.',
    inputSchema: {
      type: 'object',
      properties: { query: s('string', 'Text to find.'), limit: s('number', 'Max matches (default 10).'), ...Object.fromEntries([TAB_ID]) },
      required: ['query'],
      additionalProperties: true,
    },
    ubb: 'find',
  },
  {
    name: 'ubb_click',
    description: 'Click an element by @eN ref (preferred), a CSS selector, or x/y coordinates. Destructive/paid labels (删除/支付/purchase/delete…) require confirm:true AFTER asking the user.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: s('string', '"@eN" from ubb_snapshot.'),
        selector: s('string', 'CSS selector alternative.'),
        x: s('number', 'Viewport x (with y, for coordinate clicks).'),
        y: s('number', 'Viewport y.'),
        double: s('boolean', 'Double click.'),
        confirm: s('boolean', 'Required for destructive/paid labels, after asking the user.'),
        ...Object.fromEntries([TAB_ID]),
      },
      additionalProperties: true,
    },
    ubb: 'click',
  },
  {
    name: 'ubb_fill',
    description: 'Set a form field value by @eN ref (React/Vue-safe; REPLACES existing text). Password/OTP/payment fields are ALWAYS refused — ask the user to type those. press_enter:true submits, but pressing the page\'s submit button via ubb_click is more reliable on custom UIs.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: s('string', '"@eN" from ubb_snapshot.'),
        value: s('string', 'Value to set.'),
        selector: s('string', 'CSS selector alternative.'),
        press_enter: s('boolean', 'Press Enter after filling.'),
        ...Object.fromEntries([TAB_ID]),
      },
      required: ['value'],
      additionalProperties: true,
    },
    ubb: 'fill',
  },
  {
    name: 'ubb_fill_form',
    description: 'Batch fill several fields: values = { "@e2": "Alice", "@e5": "hi@x.com" }. Sensitive fields are refused individually.',
    inputSchema: {
      type: 'object',
      properties: { values: s('object', 'Map of ref → value.'), ...Object.fromEntries([TAB_ID]) },
      required: ['values'],
      additionalProperties: true,
    },
    ubb: 'fill_form',
  },
  {
    name: 'ubb_type',
    description: 'Type text into the currently focused element (after a click), optionally pressing Enter.',
    inputSchema: {
      type: 'object',
      properties: { text: s('string', 'Text to type.'), press_enter: s('boolean', 'Press Enter after.'), ...Object.fromEntries([TAB_ID]) },
      required: ['text'],
      additionalProperties: true,
    },
    ubb: 'type',
  },
  {
    name: 'ubb_press_key',
    description: 'Press a key with optional modifiers, e.g. key:"s" modifiers:["ctrl"].',
    inputSchema: {
      type: 'object',
      properties: {
        key: s('string', 'Key name, e.g. "Enter", "Escape", "ArrowDown".'),
        modifiers: { type: 'array', items: s('string', '"ctrl"|"alt"|"shift"|"meta".') },
        ...Object.fromEntries([TAB_ID]),
      },
      required: ['key'],
      additionalProperties: true,
    },
    ubb: 'press_key',
  },
  {
    name: 'ubb_scroll',
    description: 'Scroll the page (direction up|down, amount px, default 600); or pass ref to scroll that element into view instead.',
    inputSchema: {
      type: 'object',
      properties: {
        direction: s('string', '"up" or "down".'),
        amount: s('number', 'Pixels (default 600).'),
        ref: s('string', 'Element to scroll into view instead of page scroll.'),
        ...Object.fromEntries([TAB_ID]),
      },
      additionalProperties: true,
    },
    ubb: 'scroll',
  },
  {
    name: 'ubb_hover',
    description: 'Hover an element by @eN ref (real mouse move — triggers hover menus).',
    inputSchema: { type: 'object', properties: { ref: s('string', '"@eN".'), ...Object.fromEntries([TAB_ID]) }, required: ['ref'], additionalProperties: true },
    ubb: 'hover',
  },
  {
    name: 'ubb_upload_file',
    description: 'Set local files on a file input by @eN ref.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: s('string', '"@eN" of the <input type=file>.'),
        files: { type: 'array', items: s('string', 'Absolute local paths.') },
        ...Object.fromEntries([TAB_ID]),
      },
      required: ['ref', 'files'],
      additionalProperties: true,
    },
    ubb: 'upload_file',
  },
  {
    name: 'ubb_wait_for',
    description: 'Wait for a condition: text_present | text_gone | element_visible | element_hidden | url_contains | url_matches | navigation | network_idle | timeout. Use after actions to verify results instead of re-screenshotting.',
    inputSchema: {
      type: 'object',
      properties: {
        condition: s('string', 'One of the listed conditions.'),
        text: s('string', 'Text for text_present/text_gone.'),
        timeout_ms: s('number', 'Max wait (default 15000).'),
        ...Object.fromEntries([TAB_ID]),
      },
      required: ['condition'],
      additionalProperties: true,
    },
    ubb: 'wait_for',
  },
  {
    name: 'ubb_screenshot',
    description: 'Screenshot: viewport (default), element by ref, or full page. By default saves to a file and returns the path (token-friendly); pass inline:true to get the image embedded in the conversation instead.',
    inputSchema: {
      type: 'object',
      properties: {
        save_to: s('string', 'Absolute path for the PNG/JPEG (extension appended if missing). Default: ~/.ubb/shots/<timestamp>.<ext>.'),
        inline: s('boolean', 'Return the image as content instead of a file path.'),
        ref: s('string', '"@eN" to capture one element.'),
        full_page: s('boolean', 'Capture the whole scrollable page.'),
        format: s('string', '"png" (default) or "jpeg".'),
        quality: s('number', '1-100 for jpeg.'),
        ...Object.fromEntries([TAB_ID]),
      },
      additionalProperties: true,
    },
    ubb: 'screenshot',
    binary: true,
  },
  {
    name: 'ubb_extract',
    description: 'Extract a loaded table/list as structured JSON (format:"csv" adds a csv string). Table mode: {selector} over <table>. List mode: {item_selector, fields:[{key, selector, read:"text"|"href"|"attribute", attribute}], ":scope" reads the item itself}. Reads loaded DOM only — check coverage.truncated and warnings; never assume completeness.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: s('string', 'Table selector (table mode).'),
        item_selector: s('string', 'Row/item selector (list mode).'),
        fields: { type: 'array', description: 'List-mode field specs: {key, selector, read, attribute}.', items: { type: 'object' } },
        format: s('string', '"json" (default) or "csv".'),
        ...Object.fromEntries([TAB_ID]),
      },
      additionalProperties: true,
    },
    ubb: 'extract',
  },
  {
    name: 'ubb_console_list',
    description: 'Console messages captured since attach (only_errors filters to errors).',
    inputSchema: {
      type: 'object',
      properties: {
        only_errors: s('boolean', 'Errors only.'),
        pattern: s('string', 'Regex filter on message text.'),
        limit: s('number', 'Max messages (default 50).'),
        clear: s('boolean', 'Clear the buffer after reading.'),
        ...Object.fromEntries([TAB_ID]),
      },
      additionalProperties: true,
    },
    ubb: 'console.list',
  },
  {
    name: 'ubb_network_list',
    description: 'Network requests captured since attach (url_pattern regex filter). Pair with ubb_call {"tool":"network.get","params":{"request_id"}} for a response body.',
    inputSchema: {
      type: 'object',
      properties: {
        url_pattern: s('string', 'Regex on request URL.'),
        limit: s('number', 'Max entries (default 50).'),
        clear: s('boolean', 'Clear the buffer after reading.'),
        ...Object.fromEntries([TAB_ID]),
      },
      additionalProperties: true,
    },
    ubb: 'network.list',
  },
  {
    name: 'ubb_element_info',
    description: 'Inspect an @eN ref: tag, role, name, attributes, box — for ambiguous snapshot entries.',
    inputSchema: { type: 'object', properties: { ref: s('string', '"@eN".'), ...Object.fromEntries([TAB_ID]) }, required: ['ref'], additionalProperties: true },
    ubb: 'element.info',
  },
  {
    name: 'ubb_request_help',
    description: 'Ask the human to complete an in-page step (login / CAPTCHA / consent / payment). Shows a banner and raises the tab; completes when ALL conditions hold or the user clicks 完成. Outcomes: completed | cancelled | timed_out. After cancelled/timed_out do NOT repeat the same request.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: s('string', 'What the user should do (max 300 chars).'),
        conditions: {
          type: 'array',
          description: 'Completion checks, max 8, each with exactly one of: url_contains / url_matches / text_present / element_visible.',
          items: { type: 'object' },
        },
        timeout_ms: s('number', '5000-300000 (default 120000).'),
        ...Object.fromEntries([TAB_ID]),
      },
      required: ['prompt'],
      additionalProperties: true,
    },
    ubb: 'request_help',
  },
  {
    name: 'ubb_call',
    description: 'Run ANY other UBB tool by name — escape hatch for the full catalog of 83 tools (record_start, screencast, cdp.call, clipboard, history.list, emulate, …). Use "ubb list"-style dotted names ("console.list" or "console_list"). Prefer the dedicated ubb_* tools when one exists.',
    inputSchema: {
      type: 'object',
      properties: {
        tool: s('string', 'Catalog tool name, e.g. "screencast.start", "download.status", "history.list".'),
        params: s('object', 'Tool parameters (same JSON as the `ubb` CLI takes).'),
      },
      required: ['tool'],
    },
  },
];

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

function writeScreenshot(dir, p) {
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(dir, `${stamp}.${p.format === 'jpeg' ? 'jpg' : 'png'}`);
}

async function callTool(reqId, { name, arguments: args }) {
  args = args && typeof args === 'object' ? { ...args } : {};
  try {
    let toolName;
    let params;
    if (name === 'ubb_call') {
      const raw = String(args.tool || '').replace(/^tool\./, '');
      if (!raw) throw new Error('ubb_call: tool name required');
      const names = await catalogNames();
      toolName = names.has(raw) ? raw : raw.replace(/_/g, '.');
      if (!names.has(toolName)) {
        throw new Error(`unknown UBB tool "${raw}" — see the catalog via ubb_call {"tool":"tool.list"} or use a dedicated ubb_* tool`);
      }
      params = args.params && typeof args.params === 'object' ? args.params : {};
    } else {
      const def = TOOLS.find((t) => t.name === name);
      if (!def) throw new Error(`unknown tool: ${name}`);
      toolName = def.ubb;
      // screenshot-specific knobs are adapter-side, never forwarded
      const { save_to, inline, ...rest } = args;
      params = rest;
      if (def.binary && inline !== true) {
        params.save_to = typeof save_to === 'string' && save_to
          ? save_to
          : writeScreenshot(path.join(path.dirname(CONFIG_PATH), 'shots'), { format: args.format });
      }
    }

    const p = callDaemon(`tool.${toolName}`, params);
    if (reqId != null) inflightMcp.set(reqId, p);
    let r;
    try {
      r = await p;
    } finally {
      if (reqId != null) inflightMcp.delete(reqId);
    }

    // binary result: file already requested via save_to → strip base64;
    // otherwise inline it as an image block
    if (r && typeof r.data_base64 === 'string') {
      const { data_base64, ...meta } = r;
      if (params.save_to) {
        fs.mkdirSync(path.dirname(path.resolve(params.save_to)), { recursive: true });
        fs.writeFileSync(params.save_to, Buffer.from(data_base64, 'base64'));
        return { content: [{ type: 'text', text: JSON.stringify({ ...meta, saved_to: path.resolve(params.save_to) }, null, 2) }] };
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
      const daemonId = inflightMcp.get(params.requestId)?.daemonId?.();
      if (daemonId != null && ws && ws.readyState === 1) {
        ws.send(JSON.stringify({ method: 'cancel', params: { id: daemonId } }));
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
            protocolVersion: typeof params?.protocolVersion === 'string' ? params.protocolVersion : '2024-11-05',
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
