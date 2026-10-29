// Hardening regressions: cancellation contract, connection epochs, first-attach
// serialization, restore barrier, secret substitution scope, liveview auth.
//
//   node daemon/test-hardening.mjs
//
// Offline only: fake WebSocket / chrome / vault. No browser, no daemon, no real
// home directory, no user vault.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { installChromeStub } from '../lib/testharness.mjs';

let pass = 0;
let fail = 0;
const ok = (name, fn) => {
  try {
    fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    fail++;
    console.log(`  ✗ ${name} — ${e.message}`);
  }
};
const okAsync = async (name, fn) => {
  try {
    await fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    fail++;
    console.log(`  ✗ ${name} — ${e.message}`);
  }
};

installChromeStub();
const { Dispatcher } = await import('../lib/protocol.js');
const { AgentLink } = await import('../lib/ws-client.js');
const { cdp } = await import('../lib/cdp.js');
const { sessions } = await import('../lib/tabs.js');

// ---------------------------------------------------------------- dispatcher
console.log('\n[dispatcher cancel contract]');
{
  const d = new Dispatcher();
  let effect = false;
  d.register('slow-side-effect', { timeoutMs: 1000 }, async () => {
    await delay(30);
    effect = true;
    return { done: true };
  });
  const p = d.handle({ id: 11, method: 'tool.slow-side-effect' });
  await delay(5);
  await okAsync('cancel() aborts a live request', async () => {
    assert.equal(d.cancel(11), true);
  });
  const reply = await p;
  await okAsync('a non-cooperative tool that finishes after cancel is NOT reported as success', async () => {
    assert.equal(reply.error.code, 'CANCELLED');
    assert.equal(reply.error.data?.outcome, 'unknown');
    assert.equal(reply.result, undefined);
  });
  await okAsync('the side effect really did happen (the contract is honest about it)', async () => {
    assert.equal(effect, true);
  });
  await okAsync('unknown request cancel returns false', async () => {
    assert.equal(d.cancel(999), false);
  });

  const d2 = new Dispatcher();
  d2.register('a', { timeoutMs: 1000 }, async () => delay(30));
  d2.register('b', { timeoutMs: 1000 }, async () => delay(30));
  const ps = [d2.handle({ id: 1, method: 'tool.a' }), d2.handle({ id: 2, method: 'tool.b' })];
  await delay(2);
  await okAsync('cancelAll() returns the number actually cancelled', async () => {
    assert.equal(d2.cancelAll(), 2);
    assert.equal(d2.cancelAll(), 0);
  });
  const rs = await Promise.all(ps);
  await okAsync('both cancelled replies say outcome unknown', async () => {
    for (const r of rs) assert.equal(r.error.data?.outcome, 'unknown');
  });
}

// ---------------------------------------------------------------- link epoch
console.log('\n[connection lifecycle]');
class FakeWS {
  constructor(url, protocols) {
    this.url = url;
    this.protocols = protocols;
    this.readyState = 0;
    this.sent = [];
    FakeWS.all.push(this);
  }
  addEventListener(kind, fn) {
    (this.listeners ||= {})[kind] ||= [];
    this.listeners[kind].push(fn);
  }
  fire(kind, ev = {}) {
    for (const fn of this.listeners?.[kind] || []) fn(ev);
  }
  open() {
    this.readyState = 1;
    this.fire('open');
  }
  message(obj) {
    this.fire('message', { data: JSON.stringify(obj) });
  }
  send(text) {
    this.sent.push(text);
  }
  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.fire('close', { code: 1000 });
  }
}
FakeWS.all = [];
globalThis.WebSocket = FakeWS;

await okAsync('restart during a pending config read opens exactly one socket', async () => {
  const resolvers = [];
  const link = new AgentLink(() => new Promise((resolve) => resolvers.push(resolve)));
  link.start();
  link.restart();
  assert.equal(resolvers.length, 2);
  for (const r of resolvers) r({ port: 1, token: 't', enabled: true });
  await delay(10);
  assert.equal(FakeWS.all.length, 1);
  link.stop();
});

await okAsync('a stale socket closing late cannot clear the live heartbeat', async () => {
  FakeWS.all.length = 0;
  const link = new AgentLink(async () => ({ port: 1, token: 't', enabled: true }));
  link.start();
  await delay(5);
  const first = FakeWS.all[0];
  first.open();
  first.message({ id: 'hello', result: { ok: true } });
  assert.equal(link.status, 'connected');
  link.start(); // new epoch, new socket
  await delay(5);
  const second = FakeWS.all[1];
  second.open();
  assert.equal(link._hbTimer != null, true);
  first.close();
  assert.equal(link._hbTimer != null, true, 'old close cleared the new heartbeat');
  link.stop();
});

await okAsync('reverse RPC rejects promptly when the link stops (no dangling promise)', async () => {
  const link = new AgentLink(async () => ({ port: 1, token: 't', enabled: true }));
  link.start();
  await delay(5);
  const ws = FakeWS.all.at(-1);
  ws.open();
  const p = link.requestDaemon('secret.list', {}, 5000);
  link.stop();
  let outcome = null;
  try {
    outcome = await Promise.race([p, delay(200).then(() => 'still pending')]);
  } catch (e) {
    outcome = e;
  }
  assert.notEqual(outcome, 'still pending', 'promise stayed pending after stop');
  assert.equal(outcome?.code, 'DAEMON_NOT_CONNECTED');
});

// ---------------------------------------------------------------- cdp queue
console.log('\n[cdp first-attach serialization]');
await okAsync('two first commands never run concurrently and attach once', async () => {
  let active = 0;
  let max = 0;
  let attach = 0;
  chrome.tabs.get = async (id) => ({ id, url: 'https://example.test' });
  chrome.debugger.attach = async () => { attach++; };
  chrome.debugger.detach = async () => {};
  chrome.debugger.sendCommand = async (_target, method) => {
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'f1', url: 'https://example.test' } } };
    if (method === 'Test.action') {
      active++;
      max = Math.max(max, active);
      await delay(20);
      active--;
    }
    return {};
  };
  cdp.forget(7);
  await Promise.all([cdp.send(7, 'Test.action'), cdp.send(7, 'Test.action')]);
  assert.equal(max, 1);
  assert.equal(attach, 1);
  cdp.forget(7);
  clearTimeout(cdp._idleTimer);
});

// ---------------------------------------------------------------- restore barrier
console.log('\n[session restore barrier]');
await okAsync('start() waits for restore instead of overwriting the saved session', async () => {
  let release;
  chrome.storage.session.get = () => new Promise((resolve) => { release = resolve; });
  chrome.tabs.get = async (id) => ({ id, url: 'https://example.test' });
  const ready = sessions.ready();
  await delay(5);
  const started = sessions.start();
  await delay(5);
  release({
    ubb_session: { id: 'saved-session', groupId: 1, created: [42], claimed: [], lastTabId: 42, startedAt: 1, paused: false },
  });
  await ready;
  const r = await started;
  assert.equal(r.already_active, true);
  assert.equal(sessions.active().id, 'saved-session');
  assert.equal(sessions.active().created.has(42), true);
  await sessions.stop({ close_created: false });
});

// ---------------------------------------------------------------- secret scope
console.log('\n[secret substitution scope]');
await okAsync('secrets only land in fill.value / fill_form.values[*]', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ubb-hard-'));
  const file = path.join(dir, 'secrets.json');
  fs.writeFileSync(file, JSON.stringify({ pw: 'CANARY-SECRET-123' }));
  process.env.UBB_SECRETS_FILE = file;
  process.env.UBB_CONFIG_FILE = path.join(dir, 'config.json');
  const S = await import('./cli/secret.mjs');

  const bad = S.prepareForward('fill', { ref: '{{secret:pw}}', value: '{{secret:pw}}' });
  assert.deepEqual(bad.outOfScope, ['ref']);
  assert.equal(bad.params.ref, '{{secret:pw}}', 'ref must never carry the plaintext');

  const good = S.prepareForward('fill', { ref: '@e1', value: '{{secret:pw}}' });
  assert.equal(good.params.value, 'CANARY-SECRET-123');
  assert.equal(good.replaced, 1);

  const form = S.prepareForward('fill_form', { values: { '@e1': '{{secret:pw}}', '@e2': 'plain' } });
  assert.equal(form.params.values['@e1'], 'CANARY-SECRET-123');
  assert.equal(form.params.values['@e2'], 'plain');

  fs.writeFileSync(file, '{not json');
  const noSecret = S.prepareForward('fill', { ref: '@e1', value: 'plain' });
  assert.equal(noSecret.replaced, 0, 'no placeholder must not read the vault');
  assert.throws(() => S.prepareForward('fill', { ref: '@e1', value: '{{secret:pw}}' }), (e) => e.code === 'VAULT_CORRUPT');
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.UBB_SECRETS_FILE;
  delete process.env.UBB_CONFIG_FILE;
});

// ---------------------------------------------------------------- liveview
console.log('\n[liveview auth]');
await okAsync('malformed cookie is a 403, not a crash; cookie is HttpOnly', async () => {
  const { makeHandler } = await import('./cli/liveview.mjs');
  const handler = makeHandler({ token: 'a'.repeat(32), state: { frame: null, events: [] } });
  const mk = () => ({ status: 0, headers: {}, body: null, writeHead(s, h) { this.status = s; this.headers = h || {}; }, end(b) { this.body = b; } });
  const bad = mk();
  handler({ url: '/frame.jpg', headers: { cookie: 'ubb_liveview=%E0%A4%A' }, socket: {} }, bad);
  assert.equal(bad.status, 403);
  const home = mk();
  handler({ url: `/?token=${'a'.repeat(32)}`, headers: {}, socket: {} }, home);
  assert.equal(home.status, 200);
  assert.match(String(home.headers['Set-Cookie'] || ''), /HttpOnly/i);
});

// ---------------------------------------------------------------- mcp schema
console.log('\n[mcp schema]');
await okAsync('every inputSchema type is a valid JSON Schema type', async () => {
  const { TOOLS } = await import('./mcp-tools/index.mjs');
  const allowed = new Set(['null', 'boolean', 'object', 'array', 'number', 'string', 'integer']);
  const bad = [];
  const scan = (x, p) => {
    if (!x || typeof x !== 'object') return;
    if (Object.hasOwn(x, 'type') && (typeof x.type === 'string' || Array.isArray(x.type))) {
      for (const t of [x.type].flat()) if (!allowed.has(t)) bad.push(`${p}.type=${t}`);
    }
    for (const [k, v] of Object.entries(x)) scan(v, `${p}.${k}`);
  };
  for (const t of TOOLS) scan(t.inputSchema, t.name);
  assert.deepEqual(bad, []);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
