// UBB end-to-end loopback test (no browser needed):
// spawns the daemon, connects as the extension over WS, drives the agent side
// over stdio, and verifies auth + handshake + request/response routing.
//
//   node daemon/smoke.mjs
//
// Optional: --port 8898 --token test123

import { spawn } from 'node:child_process';

const args = process.argv.slice(2);
const argOf = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const PORT = argOf('port', '8898');
const TOKEN = argOf('token', 'test123');

let pass = 0, fail = 0;
const ok = (name, cond) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}`); }
};

const child = spawn(process.execPath, ['ubb-bridge.mjs', '--port', String(PORT), '--token', TOKEN], {
  cwd: new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
  stdio: ['pipe', 'pipe', 'pipe'],
});
child.stderr.on('data', (d) => process.stderr.write(`[daemon] ${d}`));

const stdoutLines = [];
let stdoutWaiters = [];
child.stdout.setEncoding('utf8');
let buf = '';
child.stdout.on('data', (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    const obj = JSON.parse(line);
    stdoutLines.push(obj);
    stdoutWaiters = stdoutWaiters.filter((w) => !w(obj));
  }
});
const nextStdout = (pred, ms = 5000) =>
  new Promise((resolve) => {
    const existing = stdoutLines.find(pred);
    if (existing) return resolve(existing);
    const t0 = Date.now();
    const w = (o) => {
      if (pred(o)) { resolve(o); return true; }
      return false;
    };
    stdoutWaiters.push(w);
    setTimeout(() => resolve(null), ms);
  });

function wsConnect(protocols) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/`, protocols);
    const events = { open: false, closeCode: null, messages: [] };
    ws.addEventListener('open', () => { events.open = true; resolve({ ws, events }); }, { once: true });
    ws.addEventListener('close', (e) => { events.closeCode = e.code; }, { once: true });
    ws.addEventListener('message', (e) => { events.messages.push(JSON.parse(e.data)); });
    ws.addEventListener('error', () => { /* handled via close */ });
    setTimeout(() => reject(new Error('ws connect timeout')), 4000);
  });
}
const nextWs = (events, pred, ms = 4000) =>
  new Promise((resolve) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      const m = events.messages.find(pred);
      if (m) { clearInterval(iv); resolve(m); }
      else if (Date.now() - t0 > ms) { clearInterval(iv); resolve(null); }
    }, 30);
  });
const send = (o) => child.stdin.write(JSON.stringify(o) + '\n');

try {
  console.log('== UBB daemon loopback test ==');

  // 0. daemon boots
  ok('daemon ready event on stdout', !!(await nextStdout((m) => m.method === 'event.daemon.ready')));

  // 1. wrong token → 1008 immediately
  {
    const { events } = await wsConnect(['ubb-auth.DEFINITELY-WRONG']);
    await new Promise((r) => setTimeout(r, 600));
    ok('wrong subprotocol token rejected with 1008', events.closeCode === 1008);
  }

  // 2. no subprotocol, no auth → 1008 after 5s
  {
    const { events } = await wsConnect([]);
    const code = await new Promise((resolve) => {
      const t0 = Date.now();
      const iv = setInterval(() => {
        if (events.closeCode != null || Date.now() - t0 > 6500) {
          clearInterval(iv);
          resolve(events.closeCode);
        }
      }, 100);
    });
    ok('unauthenticated connection timed out with 1008', code === 1008);
  }

  // 3. correct token + hello handshake
  const ext = await wsConnect([`ubb-auth.${TOKEN}`]);
  ext.ws.send(JSON.stringify({
    id: 'hello', method: 'hello',
    params: { protocol_version: '1.0', min_compatible: '1.0', client: 'ubb-extension', version: '1.0.0' },
  }));
  const hello = await nextWs(ext.events, (m) => m.id === 'hello');
  ok('hello answered with protocol_version', !!hello?.result?.protocol_version);
  ok('daemon identifies itself', /ubb-bridge/.test(hello?.result?.daemon || ''));

  // 4. heartbeat
  ext.ws.send(JSON.stringify({ method: 'ping' }));
  ok('ping → pong', !!(await nextWs(ext.events, (m) => m.method === 'pong')));

  // 5. agent → extension routing + reply back to agent
  send({ id: 1, method: 'tool.tab.create', params: { url: 'example.com' } });
  const req = await nextWs(ext.events, (m) => m.method === 'tool.tab.create');
  ok('tool request reached extension', !!req?.id && req.params?.url === 'example.com');
  ext.ws.send(JSON.stringify({ id: req.id, result: { tab_id: 42, in_group: true } }));
  const reply = await nextStdout((m) => m.id === 1);
  ok('tool result routed back to agent', reply?.result?.tab_id === 42);

  // 6. extension not connected → error path (drop and retry)
  ext.ws.close();
  await new Promise((r) => setTimeout(r, 300));
  send({ id: 2, method: 'tool.navigate', params: { url: 'x.com' } });
  const err = await nextStdout((m) => m.id === 2);
  ok('EXTENSION_NOT_CONNECTED error surfaced', err?.error?.code === 'EXTENSION_NOT_CONNECTED');

  // 7. bad stdin JSON → structured error, daemon survives
  child.stdin.write('not json\n');
  const bad = await nextStdout((m) => m.error?.code === 'BAD_JSON');
  ok('malformed stdin line answered with BAD_JSON', !!bad);
} finally {
  child.kill();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
