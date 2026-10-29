#!/usr/bin/env node
// ubb — one-shot CLI for AI agents to drive the UBB browser extension.
//
//   ubb status                          daemon/extension health (auto-starts daemon)
//   ubb list                            tool catalog
//   ubb <tool.name> [json-args]         run a tool, print JSON result
//   ubb <tool.name> [json] --out FILE   write the base64 payload of any tool
//                       (screenshot, print_pdf, …) to FILE; a directory works
//                       too and takes the tool's filename_suggested
//   ubb download cat <id>               print a finished TEXT download (the
//                       extension has no fs, so this reads it on the Node side)
//   ubb daemon start|stop|status
//
// Config resolution: --token/--port > UBB_TOKEN/UBB_PORT env > ~/.ubb/config.json
// --port is ALWAYS the daemon port; a subcommand that opens its own listener has
// a dedicated flag (ubb liveview --view-port, default 8790).
// The daemon is spawned automatically (detached) if it is not running.

import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLI_COMMANDS, cliHelpLines, runCliCommand } from './cli/index.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE = path.join(HERE, 'ubb-bridge.mjs');
const CONFIG_PATH = path.join(os.homedir(), '.ubb', 'config.json');

// ------------------------------------------------------------------ args

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && argv[i + 1]) {
    const v = argv[i + 1];
    argv.splice(i, 2);
    return v;
  }
  return undefined;
};
const TOKEN = flag('token') || process.env.UBB_TOKEN || readConfig().token;
const PORT = Number(flag('port') || process.env.UBB_PORT || readConfig().port || 8765);
const OUT = flag('out') || null;

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return {};
  }
}

const [cmd, ...rest] = argv;

function die(msg) {
  console.error(`ubb: ${msg}`);
  process.exit(1);
}

// config must run before the token gate: on a fresh machine there IS no token
// yet, and `ubb config token <tok>` is the documented way to add one
if (cmd === 'config') {
  const [k, v] = rest;
  if (k === 'token' && v) {
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    const cfg = readConfig();
    cfg.token = v;
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
    console.log(`saved token to ${CONFIG_PATH}`);
  } else if (k === 'token' && !v) {
    // generate when absent — fresh machines pair without copying anything
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    const cfg = readConfig();
    if (typeof cfg.token === 'string' && cfg.token.length >= 32) {
      console.log(`token already set (${cfg.token.slice(0, 8)}…)`);
    } else {
      cfg.token = crypto.randomBytes(32).toString('hex');
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
      console.log(`generated new token (${cfg.token.slice(0, 8)}…) and saved to ${CONFIG_PATH}`);
    }
  } else if (k === 'port' && v) {
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    const cfg = readConfig();
    cfg.port = Number(v);
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
    console.log(`saved port to ${CONFIG_PATH}`);
  } else {
    die('usage: ubb config token <token> | ubb config port <n>');
  }
  process.exit(0);
}

// `ubb install`: register the repo bin dir into the per-user PATH (HKCU\Environment,
// no admin) — per-user, no elevation —
// plus the native messaging host so the extension auto-pairs without token copying.
if (cmd === 'install') {
  const binDir = path.join(HERE, '..', 'bin');
  const script = `$p=[Environment]::GetEnvironmentVariable('Path','User'); $d='${binDir.replace(/'/g, "''")}'; if (($p -split ';') -notcontains $d) { [Environment]::SetEnvironmentVariable('Path', ($p.TrimEnd(';') + ';' + $d), 'User'); Write-Output ('added to user PATH: ' + $d) } else { Write-Output ('already on user PATH: ' + $d) }`;
  const r = spawnSync('powershell', ['-NoProfile', '-Command', script], { stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
  const exePath = path.join(binDir, 'ubb.exe');
  const manifestDir = path.join(os.homedir(), '.ubb');
  const manifestPath = path.join(manifestDir, 'com.ubb.bridge.json');
  fs.mkdirSync(manifestDir, { recursive: true });
  const ORIGIN = 'chrome-extension://elhkfoiapjdaglefijfgapbffflphgim/';
  fs.writeFileSync(manifestPath, JSON.stringify({
    name: 'com.ubb.bridge',
    description: 'UBB native bridge (token auto-pairing)',
    path: exePath,
    type: 'stdio',
    allowed_origins: [ORIGIN],
  }, null, 2));
  for (const hive of ['Edge', 'Google\\Chrome']) {
    spawnSync('reg', ['add', `HKCU\\Software\\Microsoft\\${hive}\\NativeMessagingHosts\\com.ubb.bridge`, '/ve', '/d', manifestPath, '/f'], { stdio: 'ignore' });
  }
  console.log(`native pairing host registered: ${manifestPath}`);
  console.log('next: reload the UBB extension - it pairs automatically (no token copying)');
  process.exit(0);
}

// The CLI registry dispatches BEFORE the token gate: on a fresh machine there
// is no token yet, and `ubb secret add` is exactly what you run there — each
// subcommand decides its own credential needs. Built-ins keep priority so
// status/daemon/help/list are untouched, and every daemon/tool path below
// stays behind the gate (token validation is NOT weakened for them).
const BUILTIN_CMDS = new Set(['status', 'daemon', 'help', 'list']);
let cliHandled = false;
if (cmd && !BUILTIN_CMDS.has(cmd)) cliHandled = await runCliCommand(cmd, rest);

if (!TOKEN && !cliHandled) {
  die(`no token. Copy it from the UBB extension popup, then either:\n  ubb config token <token>\nor set UBB_TOKEN, or pass --token.`);
}

// ------------------------------------------------------------------ daemon mgmt

async function health(ms = 800) {
  try {
    const c = AbortSignal.timeout(ms);
    const r = await fetch(`http://127.0.0.1:${PORT}/health`, { signal: c });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

async function startDaemon() {
  // daemon logs (crash traces included) go to ~/.ubb/daemon.log, truncated per start
  let stdio = 'ignore';
  try {
    const logPath = path.join(path.dirname(CONFIG_PATH), 'daemon.log');
    const fd = fs.openSync(logPath, 'w');
    stdio = ['ignore', fd, fd];
  } catch { /* fall back to ignore */ }
  const child = spawn(process.execPath, [BRIDGE, '--port', String(PORT), '--token', TOKEN], {
    detached: true,
    stdio,
    windowsHide: true,
  });
  child.unref();
  for (let i = 0; i < 25; i++) {
    await delay(200);
    if (await health(400)) return true;
  }
  return false;
}

async function stopDaemon() {
  let r;
  try {
    r = await fetch(`http://127.0.0.1:${PORT}/shutdown?token=${encodeURIComponent(TOKEN)}`, { method: 'POST' });
  } catch {
    die('daemon is not running');
  }
  if (r.status === 403) die('daemon rejected the token (config.json changed? restart with: ubb daemon stop --token <old> or kill the process)');
  console.log(JSON.stringify(await r.json()));
}

// ------------------------------------------------------------------ rpc

function rpc(method, params, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/`, [`ubb-agent.${TOKEN}`]);
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch {}
      reject(new Error(`timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ id: 1, method, params }));
    });
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id === 1) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { ws.close(); } catch {}
        resolve(m);
      }
    });
    ws.addEventListener('close', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(e.code === 1008 ? 'daemon rejected the token (check ubb config token)' : `connection closed (${e.code})`));
    });
    ws.addEventListener('error', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error('connect-failed'));
    });
  });
}

async function call(method, params) {
  let m;
  try {
    m = await rpc(method, params);
  } catch (e) {
    if (e.message === 'connect-failed') {
      // auto-start daemon and retry once
      const up = await startDaemon();
      if (!up) die(`daemon failed to start on port ${PORT}; run: node "${BRIDGE}" --port ${PORT} --token <token>`);
      m = await rpc(method, params).catch((e2) => die(`rpc failed: ${e2.message}`));
    } else {
      die(`rpc failed: ${e.message}`);
    }
  }
  return m;
}

// --out is payload-agnostic: any tool that answers with data_base64 lands on
// disk. A tool that withholds the payload (too_big) is re-asked once with
// include_base64 so the bytes never have to pass through the conversation.
function outTarget(out, r) {
  const asDir =
    out.endsWith('/') || out.endsWith(path.sep) ||
    (() => { try { return fs.statSync(out).isDirectory(); } catch { return false; } })();
  if (!asDir) return out;
  const name = r.filename_suggested || `ubb-${new Date().toISOString().replace(/[:.]/g, '-')}.${String(r.format || 'bin').toLowerCase()}`;
  return path.join(out, name);
}

async function print(m, recall) {
  if (m.error) {
    console.error(JSON.stringify(m.error));
    process.exitCode = 2;
    return;
  }
  let r = m.result;
  if (OUT && r?.too_big && r.data_base64 === undefined && recall) {
    const again = await recall();
    if (again.error) {
      console.error(JSON.stringify(again.error));
      process.exitCode = 2;
      return;
    }
    r = again.result;
  }
  if (OUT && r?.data_base64) {
    const dest = outTarget(OUT, r);
    fs.mkdirSync(path.dirname(path.resolve(dest)), { recursive: true });
    fs.writeFileSync(dest, Buffer.from(r.data_base64, 'base64'));
    const { data_base64, ...meta } = r;
    console.log(JSON.stringify({ ...meta, saved_to: path.resolve(dest) }, null, 2));
    return;
  }
  if (r?.data_base64) {
    const { data_base64, ...meta } = r;
    const kb = Math.round((r.bytes || data_base64.length * 0.75) / 1024);
    console.log(JSON.stringify({ ...meta, note: `${r.format || 'binary'} ${kb}KB; use --out FILE to save` }, null, 2));
    return;
  }
  if (r?.text && typeof r.text === 'string' && r.text.length > 4000 && !process.env.UBB_RAW) {
    console.log(r.text); // snapshots/read_page read better as plain text
    return;
  }
  console.log(JSON.stringify(r, null, 2));
}

// ------------------------------------------------------------------ commands

if (cmd === 'status') {
  let h = await health(800);
  if (!h) {
    await startDaemon();
    h = await health();
  }
  console.log(JSON.stringify({ port: PORT, daemon: !!h, ...(h || {}) }, null, 2));
  if (h && !h.extension) {
    console.error('# daemon OK, extension not connected — load the UBB extension and paste this token in its popup:');
    console.error(`#   ${TOKEN}`);
  }
} else if (cmd === 'daemon') {
  const sub = rest[0];
  if (sub === 'stop') await stopDaemon();
  else if (sub === 'start') {
    const h = await health(500);
    if (h) console.log(JSON.stringify({ already_running: true, ...h }));
    else {
      const up = await startDaemon();
      console.log(up ? JSON.stringify({ started: true, ...(await health()) }) : die('failed to start'));
    }
  } else {
    let h = await health(800);
    if (!h && (sub === 'status' || !sub)) {
      await startDaemon();
      h = await health();
    }
    console.log(JSON.stringify({ port: PORT, daemon: !!h, ...(h || {}) }));
  }
} else if (!cmd || cmd === 'help') {
  console.log(`ubb — Universal Browser Bridge CLI

  ubb status                       daemon + extension health (auto-start)
  ubb list                         tool catalog
  ubb session.start | session.stop end the agent session (✅ group)
  ubb tab.create '{"url":"example.com"}'
  ubb snapshot                      take @eN snapshot of the active tab
  ubb click '{"ref":"@e3"}'
  ubb fill '{"ref":"@e7","value":"hi"}'
  ubb screenshot --out shot.png     viewport shot (full_page:true for full page)
  ubb download cat 42               print download #42 if it is text (--max-bytes N, --allow-path DIR)
  ubb daemon start|stop|status
  ubb config token <tok> | port <n>
${CLI_COMMANDS.length ? `\n  contributed subcommands:\n${cliHelpLines()}\n` : ''}
  --port is the DAEMON port everywhere (8765 by default). Preview/other local
  listeners get their own flag: ubb liveview --view-port 8790.

Tools are called as: ubb <tool.name> '<json-args>'`);
} else if (cmd === 'list') {
  await print(await call('tool.list'));
} else if (cliHandled) {
  // contributed subcommand already ran above the token gate
} else {
  let params = {};
  if (rest.length) {
    try {
      params = JSON.parse(rest.join(' '));
    } catch {
      die(`params must be valid JSON, e.g. ubb click '{"ref":"@e3"}'`);
    }
  }
  await print(
    await call(`tool.${cmd}`, params),
    () => call(`tool.${cmd}`, { ...params, include_base64: true }),
  );
}
