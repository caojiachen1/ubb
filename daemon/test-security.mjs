// wave5a-security offline tests (contract §6) — the two security tails:
//   TAIL 1: late-loaded iframe input gap (log-D §5) — background.js's
//           chrome.webNavigation.onCommitted(frameId>0) re-arms frameblock for
//           exactly the new frame, with the QUERIED shield mode only.
//   TAIL 2: strict origin mode now also governs the {{secret:NAME}} placeholder
//           path (log-wave2secrets "off/strict 实际暴露面") — daemon stamps a
//           names ledger + authoritative binding gate; the extension (which
//           knows the tab host) refuses strict mismatches before typing.
//
//   node daemon/test-security.mjs
//
// No real browser is driven (§6.4). UBB_SECRETS_FILE / UBB_CONFIG_FILE point at
// throwaway files in the OS temp dir; the only "credentials" are the V_* fixtures.
//
// Reverse controls (§6.3) — copy, break one precondition, run, delete.
//   §0 APPLIES TO EVERY CLONE HERE: the repo root IS the extension root, so `lib/_rc-*.tmp.js` /
//   `daemon/_rc-*.tmp.mjs` would leave an underscore-prefixed entry inside the extension and
//   Chrome/Edge refuse to load the whole thing. All clones go to
//   $RC = D:/Codebase/ubb-scratch/rc/<agent-name>/ (a leading `_` is only legal in ubb-scratch),
//   and a lib/*.js clone must have its `from './x.js'` specifiers rewritten to
//   `from 'file:///D:/Codebase/ubb/lib/x.js'` (that is also what keeps it on the suite's single
//   actions/tabs/audit instance) — or copy the whole directory: `cp -r lib $RC/rc-x/lib`.
//   RC-2  cp lib/shield-ctl.js $RC/rc-2/shield-ctl.js  (rearmFrame always armed, never queries)
//         node daemon/test-security.mjs --shield $RC/rc-2/shield-ctl.js
//         → [2] the paused / off tabs turn red (unconditional arm breaks the shield promise)
//   RC-1  cp lib/actions.js $RC/rc-1/actions.js        (originMatches() → return true)
//         node daemon/test-security.mjs --actions $RC/rc-1/actions.js
//         → [3][5] the strict DENIAL cases turn red
//   RC-3  cp daemon/cli/secret.mjs $RC/rc-3/secret.mjs (SECRET_FILL_METHODS.add('evaluate');
//         this file has no relative imports, so the plain copy works)
//         node daemon/test-security.mjs --secret $RC/rc-3/secret.mjs
//         → [3] "evaluate never substituted" turns red (proves the whitelist is the real gate)
//   RC-T  (fix7 §3c) patch SECRET_FILL_METHODS back to {fill,fill_form,type} in a
//         copy under D:/Codebase/ubb-scratch/rc7/_rc-type.mjs, then
//         node daemon/test-security.mjs --secret ../../ubb-scratch/rc7/_rc-type.mjs
//         → [3] "type: out of the substitution whitelist since 2B §3c…" turns red
//         (the [4] wire half keeps its green because the spawned bridge imports
//         the REAL cli/secret.mjs — the wire assertion is pinned to shipped code)
//   RC-L  (fix7 §2d) restore the `!h.includes('.')` requirement in the same-copy
//         normalizeOriginHost → daemon/test-secrets.mjs --secret dies at its
//         localhost-accept line with BAD_ORIGIN_HOST "localhost"
//   RC-M  (fix7 trap) originMatches() → `h.includes(b)` in the same copy →
//         [3] "daemon and extension origin matchers judge all 10 traps alike"
//         red on github.com.evil.test / evilgithub.com / xlocalhost.test

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { installChromeStub, collectRegistry } from '../lib/testharness.mjs';
import { audit as auditRing } from '../lib/audit.js';
import { redact } from '../lib/redact.js';
import { cdp as hub } from '../lib/cdp.js';
import { sessions } from '../lib/tabs.js';
import { AgentLink } from '../lib/ws-client.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const V_BOUND = 'bound-W5A-TESTONLY-9';
const V_FREE = 'free-W5A-TESTONLY-7';
const V_LEGACY = 'legacy-W5A-TESTONLY-5';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ubb-security-'));
const VAULT = path.join(TMP, 'secrets.json');
const CONFIG = path.join(TMP, 'config.json');
process.env.UBB_SECRETS_FILE = VAULT;
process.env.UBB_CONFIG_FILE = CONFIG;
fs.writeFileSync(VAULT, JSON.stringify({ bound_pw: { value: V_BOUND, origins: ['github.com'] }, free_pw: V_FREE }));

const argv = process.argv.slice(2);
const optOf = (flag) => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : null;
};
const SHIELD_PATH = path.resolve(HERE, optOf('--shield') || '../lib/shield-ctl.js');
const ACTIONS_PATH = path.resolve(HERE, optOf('--actions') || '../lib/actions.js');
const SECRET_PATH = path.resolve(HERE, optOf('--secret') || './cli/secret.mjs');
const BRIDGE = path.resolve(HERE, optOf('--bridge') || 'ubb-bridge.mjs');
const RC = optOf('--shield') || optOf('--actions') || optOf('--secret')
  ? ` [REVERSE CONTROL → ${optOf('--shield') || optOf('--actions') || optOf('--secret')}]`
  : '';

let pass = 0;
let fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
};
const containsValue = (haystack) => {
  const s = typeof haystack === 'string' ? haystack : JSON.stringify(haystack ?? '');
  return [V_BOUND, V_FREE, V_LEGACY].some((v) => s.includes(v));
};
const setMode = (mode) => fs.writeFileSync(CONFIG, JSON.stringify({ token: 'never-printed', secret_origin_mode: mode }));
// shared across sections 5–6 (same chrome stub, same audit ring)
let tabUrl = 'https://github.com/login';
const gate = (mode, name, origins, exists = true) => ({ mode, bindings: [{ name, origins, exists }] });
// audit.list() is NEWEST FIRST — watermarks go through the monotonic seq
const phSince = (seq) => auditRing.list(200).filter((e) => e.seq > seq && e.via === 'placeholder').sort((a, b) => a.seq - b.seq);

installChromeStub();
const chromeStub = globalThis.chrome;
const A = await import(pathToFileURL(ACTIONS_PATH).href);
const S = await import(pathToFileURL(SECRET_PATH).href);
const SH = await import(pathToFileURL(SHIELD_PATH).href);

// ---------------------------------------------------------------- 1. tail-1 wiring (static)
console.log(`\n== 1. late-frame arm wiring (background.js / frameblock channel)${RC} ==`);
{
  const bg = fs.readFileSync(path.resolve(HERE, '../background.js'), 'utf8');
  ok('background.js listens to chrome.webNavigation.onCommitted', /chrome\.webNavigation\.onCommitted\.addListener/.test(bg));
  ok('the onCommitted listener returns early on the MAIN frame (frameId 0 keeps the onCompleted path)', /onCommitted\.addListener[\s\S]{0,220}if \(frameId === 0\) return;/.test(bg), bg.match(/onCommitted\.addListener\([\s\S]{0,220}/)?.[0]);
  ok('the listener gates on session ownership before arming anything', /onCommitted\.addListener[\s\S]{0,500}sessions\.owns\(tabId\)/.test(bg));
  ok('it delegates to rearmFrame (queried-mode helper), not an ad-hoc broadcast', /rearmFrame\(tabId, frameId\)/.test(bg) && /import \{[^}]*rearmFrame[^}]*\} from '\.\/lib\/shield-ctl\.js'/.test(bg));
  ok('the pre-existing main-frame onCompleted arm is intact', /onCompleted\.addListener[\s\S]{0,120}if \(frameId !== 0\) return;[\s\S]{0,200}shield\.set\(tabId, \{ mode: 'armed'/.test(bg));
  const fb = fs.readFileSync(path.resolve(HERE, '../content/frameblock.js'), 'utf8');
  ok('frameblock keeps consuming the UBB_SHIELD arm channel (no second protocol invented)', /case 'UBB_SHIELD':/.test(fb));
  ok('frameblock still refuses to answer broadcasts (first-responder slot belongs to shield.js)', !/sendResponse\s*\(/.test(fb));
  const sc = fs.readFileSync(path.resolve(HERE, '../lib/shield-ctl.js'), 'utf8');
  ok('rearmFrame addresses the frame with an explicit frameId option (no broadcast, D’s anti-trap rule)', /chrome\.tabs\.sendMessage\(tabId, \{ type: 'UBB_SHIELD'[\s\S]{0,80}\{ frameId \}\)/.test(sc));
}

// ---------------------------------------------------------------- 2. tail-1 functional: rearmFrame
console.log(`\n== 2. rearmFrame — arm the NEW frame only, with the QUERIED mode${RC} ==`);
{
  let sends = [];
  let queryState = { mode: 'armed' }; // what shield.js in the TOP frame answers
  let shieldStored = 'block';
  let failOnce = new Set();
  let failAlways = new Set();
  chromeStub.storage.local.get = async () => ({ ubb_shield_mode: shieldStored });
  chromeStub.tabs.sendMessage = async (tabId, payload, opts) => {
    sends.push({ tabId, payload, opts });
    if (payload?.type === 'UBB_SHIELD_QUERY') {
      if (queryState === null) throw new Error('Could not establish connection');
      return { ok: true, state: { ...queryState } };
    }
    const fid = opts?.frameId;
    if (fid != null && (failAlways.has(fid) || failOnce.has(fid))) {
      failOnce.delete(fid);
      throw new Error('Receiving end does not exist');
    }
    return {};
  };
  const armSends = () => sends.filter((s) => s.opts && s.payload?.type === 'UBB_SHIELD');

  queryState = { mode: 'armed' };
  sends = [];
  let r = await SH.rearmFrame(1, 7);
  ok('armed tab: the new frame gets exactly one UBB_SHIELD addressed to frameId 7', r.sent === true && armSends().length === 1 && armSends()[0].opts.frameId === 7 && armSends()[0].payload.mode === 'armed', JSON.stringify(armSends()));
  ok('the arm reuses the broadcast payload shape frameblock.js already parses', armSends()[0].payload.type === 'UBB_SHIELD' && armSends()[0].payload.blockMode === 'block');
  ok('the shield state itself was QUERIED first (never assumed)', sends[0]?.payload?.type === 'UBB_SHIELD_QUERY' && sends[0].opts === undefined);

  sends = [];
  queryState = { mode: 'paused' };
  r = await SH.rearmFrame(1, 8);
  ok('PAUSED tab (user hit Interrupt): new frame is told paused, NEVER armed', armSends().every((s) => s.payload.mode === 'paused') && armSends().length === 1 && !armSends().some((s) => s.payload.mode === 'armed'), JSON.stringify(armSends()));

  sends = [];
  queryState = { mode: 'off' };
  r = await SH.rearmFrame(1, 9);
  ok('off shield: nothing is armed on the new frame (no invented control)', armSends().length === 0 && r.sent === false && r.reason === 'shield_not_active');

  sends = [];
  queryState = null; // top shield unreachable (SW race / restricted page)
  r = await SH.rearmFrame(1, 10);
  ok('unreachable top shield → no frame is ever armed (fail passive)', armSends().length === 0 && r.sent === false);

  sends = [];
  queryState = { mode: 'armed' };
  r = await SH.rearmFrame(1, 0);
  ok('frameId 0: rearmFrame is a no-op — the main-frame onCompleted path is untouched', sends.length === 0 && r.sent === false && r.reason === 'main_frame');
  r = await SH.rearmFrame(1, -1);
  ok('negative frameId rejected the same way', r.reason === 'main_frame');
  r = await SH.rearmFrame(1, '3');
  ok('non-integer frameId rejected (only real webNavigation ids arm)', r.reason === 'main_frame');

  sends = [];
  shieldStored = 'soft';
  r = await SH.rearmFrame(1, 12);
  ok('the stored blockMode rides along (same payload shield.set would broadcast)', armSends()[0]?.payload?.blockMode === 'soft' && r.sent === true);
  shieldStored = 'block';

  sends = [];
  failOnce.add(13);
  r = await SH.rearmFrame(1, 13);
  ok('document_start race: one bounded retry lands the arm on a still-loading frame', r.sent === true && armSends().length === 2, JSON.stringify(armSends().length));
  sends = [];
  failAlways.add(14);
  r = await SH.rearmFrame(1, 14);
  ok('never-reachable frame (srcdoc/blank): exactly 2 attempts then give up — resyncArm stays the backstop', r.sent === false && r.reason === 'frame_unreachable' && armSends().length === 2);
}

// ---------------------------------------------------------------- 3. tail-2 daemon ledger
console.log(`\n== 3. {{secret:NAME}} ledger + strict pre-refusal + whitelist (daemon module)${RC} ==`);
{
  setMode('off');
  const f1 = S.prepareForward('fill', { ref: '@e7', value: '{{secret:bound_pw}}' });
  ok('fill still resolves the value (daemon→extension wire only)', f1.params.value === V_BOUND && f1.params.__ubb_secret_fill === true);
  ok('fill stamps the NAMES ledger (never values)', f1.params.__ubb_secret_names?.join() === 'bound_pw' && !containsValue(f1.params.__ubb_secret_names));
  ok('fill stamps the binding gate {mode,bindings}', f1.params.__ubb_secret_gate?.mode === 'off' && f1.params.__ubb_secret_gate.bindings[0].origins.join() === 'github.com' && !containsValue(f1.params.__ubb_secret_gate), JSON.stringify(f1.params.__ubb_secret_gate));

  // THE historical red line (E): evaluate must stay outside the whitelist —
  // RC-3 proves this assertion bites
  for (const m of ['evaluate', 'cdp.call', 'webmcp.invoke', 'ext.call', 'batch']) {
    const r2 = S.prepareForward(m, { expression: `'{{secret:bound_pw}}'` });
    ok(`${m}: never substituted, never ledgered, plaintext-free`, r2.params.expression.includes('{{secret:bound_pw}}') && r2.params.__ubb_secret_fill === undefined && r2.params.__ubb_secret_names === undefined && r2.params.__ubb_secret_gate === undefined && !containsValue(r2.params));
  }

  const rp = S.prepareForward('replay', { vars: { PW: '{{secret:bound_pw}}', Q: 'plain' }, trace: { events: [{ value: '{{secret:bound_pw}}' }] } });
  ok('replay vars keep the per-key ledger AND gain names+gate', rp.params.__ubb_secret_vars?.PW?.join() === 'bound_pw' && rp.params.__ubb_secret_names?.join() === 'bound_pw' && rp.params.__ubb_secret_gate?.mode === 'off');
  ok('replay structural trace untouched', rp.params.trace.events[0].value === '{{secret:bound_pw}}');

  // the 2B §3c channel: `type` used to be substituted while NOTHING on its
  // path can be field-classified (no ref/selector) — removed from the whitelist
  const tp = S.prepareForward('type', { text: '{{secret:bound_pw}}' });
  ok('type: out of the substitution whitelist since 2B §3c — literal forwarded, unmarked, plaintext-free', tp.params.text.includes('{{secret:bound_pw}}') && tp.params.__ubb_secret_fill === undefined && tp.params.__ubb_secret_names === undefined && !containsValue(tp.params), JSON.stringify(tp.params));
  const tpF = S.prepareForward('type', { text: 'x', __ubb_secret_fill: true, __ubb_secret_names: ['bound_pw'] });
  ok('type: forged markers stripped too (the extension ledger branch can never be agent-lit)', tpF.params.__ubb_secret_fill === undefined && tpF.params.__ubb_secret_names === undefined);

  setMode('strict');
  const f2 = S.prepareForward('fill', { value: '{{secret:bound_pw}}' });
  ok('strict + bound: forwarded with the gate saying strict/github.com', f2.denied.length === 0 && f2.params.__ubb_secret_gate.mode === 'strict' && f2.params.__ubb_secret_gate.bindings[0].origins.join() === 'github.com');
  const f3 = S.prepareForward('fill', { value: '{{secret:free_pw}}' });
  ok('strict + UNBOUND: refused pre-forward (origin-independent) — no stamps ride out', f3.denied.join() === 'free_pw' && f3.params.__ubb_secret_fill === undefined && f3.params.__ubb_secret_names === undefined);
  const f4 = S.prepareForward('replay', { vars: { PW: '{{secret:free_pw}}' } });
  ok('strict + unbound replay vars: same pre-refusal', f4.denied.join() === 'free_pw' && f4.params.__ubb_secret_fill === undefined);
  setMode('off');

  const forg = S.prepareForward('fill', { value: 'x', __ubb_secret_fill: true, __ubb_secret_names: ['bound_pw'], __ubb_secret_gate: { mode: 'off', bindings: [{ name: 'bound_pw', exists: true, origins: ['anywhere.test'] }] } });
  ok('forged names/gate stripped (agents cannot self-issue a vault fill)', forg.params.__ubb_secret_fill === undefined && forg.params.__ubb_secret_names === undefined && forg.params.__ubb_secret_gate === undefined);
  const bt = S.prepareForward('batch', { actions: [{ tool: 'fill', params: { __ubb_secret_fill: true, value: 'pw' } }] });
  ok('batch step params are marker-stripped too (batch re-dispatches inside the extension)', bt.params.actions[0].params.__ubb_secret_fill === undefined && bt.params.actions[0].params.value === 'pw');

  const bnd = S.secretBindings(['bound_pw', 'free_pw', 'ghost_pw', '../evil']);
  ok('secret.bindings: names+origins+exists+mode, never a value', bnd.mode === 'off' && bnd.bindings[0].origins.join() === 'github.com' && bnd.bindings[1].origins.length === 0 && bnd.bindings[2].exists === false && bnd.bindings[3].exists === false && !containsValue(bnd), JSON.stringify(bnd));

  // anti-drift pin (contract §9.7): daemon matcher === extension matcher
  const pairs = [['github.com', 'github.com', true], ['www.github.com', 'github.com', true], ['GITHUB.COM', 'github.com', true], ['github.com.evil.test', 'github.com', false], ['evilgithub.com', 'github.com', false], ['', 'github.com', false], ['github.com', '', false], ['localhost', 'localhost', true], ['xlocalhost.test', 'localhost', false], ['a.localhost', 'localhost', true]];
  const drift = pairs.filter(([h, b, want]) => S.originMatches(h, b) !== want || A.originMatches(h, b) !== want);
  ok('daemon and extension origin matchers judge all 10 traps alike (suffix trap + single-label localhost)', drift.length === 0, JSON.stringify(drift));
  ok('guardSensitiveField signature intact for every other wave (4-arg, opts-only growth)', /export async function guardSensitiveField\(tabId, nodeId, meta, opts = \{\}\)/.test(fs.readFileSync(ACTIONS_PATH, 'utf8')));
}

// ---------------------------------------------------------------- 4. tail-2 over the real loopback wire
console.log(`\n== 4. placeholder path over the daemon wire (spawned bridge)${RC} ==`);
{
  const PORT = 8941;
  const TOKEN = 'ws5a-token-0000000000000000000000ab';
  setMode('strict');
  const child = spawn(process.execPath, [BRIDGE, '--port', String(PORT), '--token', TOKEN], {
    cwd: HERE,
    env: { ...process.env, UBB_SECRETS_FILE: VAULT, UBB_CONFIG_FILE: CONFIG },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let daemonErr = '';
  let daemonOut = '';
  child.stderr.setEncoding('utf8');
  child.stdout.setEncoding('utf8');
  child.stderr.on('data', (d) => (daemonErr += d));
  child.stdout.on('data', (d) => (daemonOut += d));

  function wsConnect(protocols) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}/`, protocols);
      const ev = { messages: [] };
      ws.addEventListener('open', () => resolve({ ws, ev }), { once: true });
      ws.addEventListener('message', (m) => ev.messages.push(JSON.parse(m.data)));
      ws.addEventListener('error', () => reject(new Error('ws error')));
      setTimeout(() => reject(new Error('ws connect timeout')), 5000);
    });
  }
  const next = (ev, pred, ms = 2500) =>
    new Promise((resolve) => {
      const hit = () => {
        const m = ev.messages.find(pred);
        if (m) {
          clearInterval(iv);
          clearTimeout(to);
          resolve(m);
        }
      };
      const iv = setInterval(hit, 25);
      const to = setTimeout(() => resolve(null), ms);
      hit();
    });
  const settle = async () => {
    const t0 = Date.now();
    while (Date.now() - t0 < 8000) {
      try {
        const r = await fetch(`http://127.0.0.1:${PORT}/health`, { signal: AbortSignal.timeout(300) });
        if (r.ok) return;
      } catch {}
      await new Promise((r) => setTimeout(r, 150));
    }
  };
  await settle();

  const ext = await wsConnect([`ubb-auth.${TOKEN}`]);
  ext.ws.send(JSON.stringify({ id: 'hello', method: 'hello', params: { protocol_version: '1.0', min_compatible: '1.0', client: 'ubb-extension', version: 'test' } }));
  ok('extension handshake', !!(await next(ext.ev, (m) => m.id === 'hello' && m.result)));
  const agent = await wsConnect([`ubb-agent.${TOKEN}`]);
  const sendA = (o) => agent.ws.send(JSON.stringify(o));

  // strict + unbound: the AGENT gets SECRET_ORIGIN_DENIED and the extension
  // socket sees NOTHING — the plaintext never crosses this boundary
  const before1 = ext.ev.messages.length;
  sendA({ id: 201, method: 'tool.fill', params: { ref: '@e7', value: '{{secret:free_pw}}' } });
  const rep201 = await next(agent.ev, (m) => m.id === 201);
  ok('strict+unbound over the wire: agent error is SECRET_ORIGIN_DENIED', rep201?.error?.code === 'SECRET_ORIGIN_DENIED' && /free_pw/.test(rep201?.error?.message || ''), JSON.stringify(rep201));
  ok('strict+unbound: the error names the secret, carries NO value', !containsValue(rep201));
  await new Promise((r) => setTimeout(r, 300));
  ok('strict+unbound: nothing was forwarded to the extension at all', ext.ev.messages.length === before1);

  // strict + bound: forwarded, value resolved, ledger + gate attached
  sendA({ id: 202, method: 'tool.fill', params: { ref: '@e7', value: '{{secret:bound_pw}}' } });
  const got202 = await next(ext.ev, (m) => m.method === 'tool.fill');
  ok('strict+bound over the wire: extension receives the resolved fill', got202?.params?.value === V_BOUND);
  ok('extension receives the names ledger', got202?.params?.__ubb_secret_names?.join() === 'bound_pw');
  ok('extension receives the STRICT gate with the real binding', got202?.params?.__ubb_secret_gate?.mode === 'strict' && got202.params.__ubb_secret_gate.bindings[0].origins.join() === 'github.com');
  ext.ws.send(JSON.stringify({ id: got202.id, result: { filled: '@e7' } }));
  ok('fill reply still routes back to its agent', (await next(agent.ev, (m) => m.id === 202))?.result?.filled === '@e7');

  // reverse RPC from the extension: bindings only, and never broadcast to agents
  const agentBefore = agent.ev.messages.length;
  ext.ws.send(JSON.stringify({ id: 's9', method: 'secret.bindings', params: { names: ['bound_pw', 'ghost'] } }));
  const repS9 = await next(ext.ev, (m) => m.id === 's9');
  ok('secret.bindings answers the extension socket with mode+names+origins', repS9?.result?.mode === 'strict' && repS9.result.bindings[0].origins.join() === 'github.com' && repS9.result.bindings[1].exists === false, JSON.stringify(repS9));
  ok('the bindings reply holds no value', !containsValue(repS9));
  await new Promise((r) => setTimeout(r, 250));
  ok('reverse-RPC replies are never broadcast to agents', agent.ev.messages.length === agentBefore);

  // off mode: the placeholder path still flows through FILL — but `type` is out
  // of the whitelist now (2B §3c: the bypass channel that put 35 plaintext chars
  // into #cvv/#code-box); the extension must receive the literal, unmarked
  setMode('off');
  sendA({ id: 203, method: 'tool.type', params: { text: '{{secret:free_pw}}', tab_id: 1 } });
  const got203 = await next(ext.ev, (m) => m.method === 'tool.type');
  ok('type over the real wire: LITERAL placeholder, no __ubb_secret_fill/names/gate, no plaintext (the 2B §3c regression)', got203?.params?.text === '{{secret:free_pw}}' && got203?.params?.__ubb_secret_fill === undefined && got203?.params?.__ubb_secret_names === undefined && got203?.params?.__ubb_secret_gate === undefined && !containsValue(got203?.params), JSON.stringify(got203?.params));
  sendA({ id: 205, method: 'tool.fill', params: { ref: '@e7', value: '{{secret:free_pw}}', tab_id: 1 } });
  const got205 = await next(ext.ev, (m) => m.method === 'tool.fill' && m.id !== got202?.id);
  ok('off mode: the SUBSTITUTION itself still works where a node can be classified (fill keeps gate mode off + names ledger)', got205?.params?.value === V_FREE && got205.params.__ubb_secret_gate?.mode === 'off' && got205.params.__ubb_secret_names?.join() === 'free_pw');

  // the E red line, live on the wire
  sendA({ id: 204, method: 'tool.evaluate', params: { expression: "fetch('/steal',{body:'{{secret:bound_pw}}'})", tab_id: 1 } });
  const got204 = await next(ext.ev, (m) => m.method === 'tool.evaluate');
  ok('evaluate over the wire: placeholder stays literal, no markers, no plaintext (KEY NEGATIVE)', got204?.params?.expression?.includes('{{secret:bound_pw}}') && got204.params.__ubb_secret_fill === undefined && !containsValue(got204?.params), JSON.stringify(got204?.params));
  await new Promise((r) => setTimeout(r, 200));
  ok('daemon logs never printed a value', !containsValue(daemonErr) && !containsValue(daemonOut));

  try { agent.ws.close(); ext.ws.close(); } catch {}
  child.kill();
}

// ---------------------------------------------------------------- 5. tail-2 extension-side gate
console.log(`\n== 5. enforceVaultOrigins at the guard (extension module)${RC} ==`);
{
  chromeStub.tabs.get = async (id) => ({ id, url: tabUrl });
  const fakeSession = { tabId: 1, queue: Promise.resolve(), gen: 1, frameId: null, console: [], net: [], dialogs: [], enabledDomains: new Set(), domFetched: true };
  hub.sessions.set(1, fakeSession);
  function withAttrs(attrs) {
    chromeStub.debugger.sendCommand = async (_t, method) => {
      if (method === 'DOM.getAttributes') {
        const flat = [];
        for (const [k, v] of Object.entries(attrs)) flat.push(k, String(v));
        return { attributes: flat };
      }
      return {};
    };
  }
  const PW = { type: 'password', name: 'pw' };
  async function guarded(attrs, opts) {
    withAttrs(attrs);
    try {
      await A.guardSensitiveField(1, 7, { name: attrs.name || '' }, opts);
      return { outcome: 'ALLOWED' };
    } catch (e) {
      return { outcome: e?.code || 'THREW', message: e?.message || '' };
    }
  }

  // strict + matching host → allowed (and audited without ever fetching — the
  // value already sits in params from the daemon substitution; NO secret.resolve
  // request is ever made on this path)
  let n = auditRing.seq;
  let res = await guarded(PW, { allowPassword: true, vaultNames: ['bound_pw'], vaultGate: gate('strict', 'bound_pw', ['github.com']) });
  ok('strict + bound-to-current-host: the placeholder fill is allowed', res.outcome === 'ALLOWED', JSON.stringify(res));
  let ents = phSince(n);
  ok('allowed fill audited {vault_entry, origin, mode, decision:filled} with no value', ents.length === 1 && ents[0].vault_entry === 'bound_pw' && ents[0].origin === 'github.com' && ents[0].mode === 'strict' && ents[0].decision === 'filled' && !containsValue(ents), JSON.stringify(ents));
  ok('the audit entry survives redact() (keys dodge the sensitive-substring net)', redact(ents[0]).vault_entry === 'bound_pw' && redact(ents[0]).origin === 'github.com');

  // strict + the phishing suffix trap
  n = auditRing.seq;
  tabUrl = 'https://github.com.evil.test/fake';
  res = await guarded(PW, { allowPassword: true, vaultNames: ['bound_pw'], vaultGate: gate('strict', 'bound_pw', ['github.com']) });
  ents = phSince(n);
  ok('strict + github.com.evil.test suffix trap: SECRET_ORIGIN_DENIED (RC-1 target)', res.outcome === 'SECRET_ORIGIN_DENIED', JSON.stringify(res));
  ok('mismatch denial audited reason origin_mismatch, decision denied', ents[0]?.reason === 'origin_mismatch' && ents[0]?.decision === 'denied' && ents[0]?.origin === 'github.com.evil.test');
  ok('the denial message names the secret + binding, carries no value', /bound_pw/.test(res.message) && !containsValue(res.message), res.message);

  // strict + unbound reaching the extension (e.g. mode flipped between stamps)
  tabUrl = 'https://github.com/login';
  n = auditRing.seq;
  res = await guarded(PW, { allowPassword: true, vaultNames: ['free_pw'], vaultGate: gate('strict', 'free_pw', []) });
  ok('strict + unbound (extension side): denied reason unbound', res.outcome === 'SECRET_ORIGIN_DENIED' && phSince(n)[0]?.reason === 'unbound');

  // vanished between substitution and fill
  res = await guarded(PW, { allowPassword: true, vaultNames: ['bound_pw'], vaultGate: gate('strict', 'bound_pw', ['github.com'], false) });
  ok('secret deleted mid-flight: denied reason secret_gone (fail closed)', res.outcome === 'SECRET_ORIGIN_DENIED' && /vanished/.test(res.message));

  // strict subdomain host passes
  tabUrl = 'https://login.github.com/sso';
  res = await guarded(PW, { allowPassword: true, vaultNames: ['bound_pw'], vaultGate: gate('strict', 'bound_pw', ['github.com']) });
  ok('strict + subdomain of the bound host: allowed', res.outcome === 'ALLOWED', JSON.stringify(res));

  // off mode (the user default): everything flows, everything leaves a trace
  tabUrl = 'https://totally-unrelated.test/';
  n = auditRing.seq;
  res = await guarded(PW, { allowPassword: true, vaultNames: ['bound_pw'], vaultGate: gate('off', 'bound_pw', ['github.com']) });
  ents = phSince(n);
  ok('off + mismatched host: allowed (today behavior) — but audited', res.outcome === 'ALLOWED' && ents.length === 1 && ents[0].mode === 'off' && ents[0].decision === 'filled' && ents[0].origin === 'totally-unrelated.test');
  ok('the off-mode audit line has no value yet reads as a vault fill after redact()', !containsValue(ents[0]) && redact(ents[0]).vault_entry === 'bound_pw');

  // legacy flag-only params (old daemon / test-fill fixtures): unchanged behavior
  n = auditRing.seq;
  res = await guarded(PW, { allowPassword: true });
  ok('allowPassword without a names ledger: unchanged pass (no ledger = nothing to gate)', res.outcome === 'ALLOWED' && phSince(n).length === 0);

  // the NEVER class outranks the whole mechanism
  res = await guarded({ type: 'text', name: 'cvv' }, { allowPassword: true, vaultNames: ['bound_pw'], vaultGate: gate('off', 'bound_pw', []) });
  ok('cvv with a perfect ledger: still SENSITIVE_FIELD, never checked/filled', res.outcome === 'SENSITIVE_FIELD');
  res = await guarded({ type: 'text', autocomplete: 'one-time-code' }, { allowPassword: true, vaultNames: ['bound_pw'], vaultGate: gate('off', 'bound_pw', []) });
  ok('OTP same', res.outcome === 'SENSITIVE_FIELD');

  // RPC branch: names only (no stamped gate) → the extension ASKS the daemon
  const frames = [];
  const link = new AgentLink(async () => ({ port: 1, token: 'x', enabled: false }));
  link.ws = { readyState: 1, send: (t) => frames.push(JSON.parse(t)) };
  withAttrs(PW);
  n = auditRing.seq;
  const p = A.guardSensitiveField(1, 7, { name: 'pw' }, { allowPassword: true, vaultNames: ['bound_pw'] });
  await new Promise((r) => setTimeout(r, 5));
  const asked = frames.find((f) => f.method === 'secret.bindings');
  ok('no stamped gate → reverse RPC secret.bindings fires with NAMES only', !!asked && asked.params.names.join() === 'bound_pw' && !containsValue(asked), JSON.stringify(frames));
  let threw = null;
  link.consumePendingResponse({ id: asked.id, result: { mode: 'strict', bindings: [{ name: 'bound_pw', exists: true, origins: ['login.microsoftonline.com'] }] } });
  tabUrl = 'https://github.com/login';
  try {
    await p;
  } catch (e) {
    threw = e;
  }
  ok('RPC answer mismatched → SECRET_ORIGIN_DENIED before any typing', threw?.code === 'SECRET_ORIGIN_DENIED', String(threw?.code));
  ok('the gate NEVER asks secret.resolve (no value fetch on the placeholder path)', !frames.some((f) => f.method === 'secret.resolve'));
  link.stop();
}

// ---------------------------------------------------------------- 6. type tool end-to-end through the gate
console.log(`\n== 6. the real type/fill tools consult the ledger (registry harness)${RC} ==`);
{
  const reg = await collectRegistry();
  await sessions.start({});
  sessions.session.created.add(1);
  const typed = [];
  chromeStub.debugger.sendCommand = async (_t, method, params) => {
    if (method === 'Input.insertText') typed.push(params.text);
    return {};
  };
  chromeStub.tabs.sendMessage = async () => ({});

  tabUrl = 'https://totally-unrelated.test/';
  typed.length = 0;
  let code = null;
  try {
    await reg.call('type', { text: V_BOUND, tab_id: 1, __ubb_secret_fill: true, __ubb_secret_names: ['bound_pw'], __ubb_secret_gate: gate('strict', 'bound_pw', ['github.com']) });
  } catch (e) {
    code = e?.code;
  }
  ok('type on a mismatched host under strict: SECRET_ORIGIN_DENIED and NOTHING typed', code === 'SECRET_ORIGIN_DENIED' && typed.length === 0, `code=${code} typed=${JSON.stringify(typed)}`);

  tabUrl = 'https://github.com/login';
  typed.length = 0;
  await reg.call('type', { text: V_BOUND, tab_id: 1, __ubb_secret_fill: true, __ubb_secret_names: ['bound_pw'], __ubb_secret_gate: gate('strict', 'bound_pw', ['github.com']) });
  ok('type on the bound host under strict: goes through', typed.length === 1 && typed[0] === V_BOUND);

  typed.length = 0;
  let n = auditRing.seq;
  await reg.call('type', { text: 'hello', tab_id: 1 });
  ok('type without vault markers: untouched path (typed normally, no placeholder audit line)', typed.length === 1 && phSince(n).length === 0);

  const toolsSrc = fs.readFileSync(path.resolve(HERE, '../lib/tools.js'), 'utf8');
  ok('fill/fill_form thread the ledger into every guard branch (2× frame + 2× main-frame)', (toolsSrc.match(/vaultNames, vaultGate\)/g) || []).length === 3 && (toolsSrc.match(/vaultNames, vaultGate \}/g) || []).length === 2 && toolsSrc.includes('p.__ubb_secret_gate'), `frame=${(toolsSrc.match(/vaultNames, vaultGate\)/g) || []).length} main=${(toolsSrc.match(/vaultNames, vaultGate \}/g) || []).length}`);
  const repSrc = fs.readFileSync(path.resolve(HERE, '../lib/tools-replay.js'), 'utf8');
  ok('replay vault steps carry their per-step ledger into the same guard (vars走同一判定)', /vaultNames: step\.vault_entries, vaultGate: p\.__ubb_secret_gate/.test(repSrc));

  await sessions.stop({ close_created: false });
  sessions.session = null;
}

// ---------------------------------------------------------------- 7. frames.probe read-only + pairing basis
console.log(`\n== 7. frames.probe: really read-only, and it says HOW it paired${RC} ==`);
{
  const TOP_URL = 'https://host.test/live';
  const PAY = 'https://pay.test/child';
  const DUP = 'https://dup.test/x';
  const SAME = 'https://same.test/x';
  // the site-policy error live-verify §1 hit, long enough that the old
  // truncate(_,120) amputated the part explaining it
  const LONG_BLOCK = 'Failed to read a named property \'name\' from \'Window\': Blocked a frame with origin "https://host.test" from accessing a cross-origin frame. window.name is not exposed to this origin by the site isolation policy of this build';
  tabUrl = TOP_URL;

  const mk = (fid, url, o = {}) => ({
    frameId: fid, url, origin: new URL(url).origin, epoch: 'e' + fid,
    isFrame: fid !== 0, sameOriginAncestry: !!o.sameOriginAncestry,
    scroll: { x: 0, y: o.scrollY ?? 0 },
    innerWidth: o.iw ?? 320, innerHeight: o.ih ?? 200,
    name: '', stamped: null,
    entries: [{ role: 'button', name: 'far down button', rect: { x: 22, y: 3000, width: 129, height: 22 } }],
  });
  const worlds = {
    0: mk(0, TOP_URL, { sameOriginAncestry: true, scrollY: 2520, iw: 1280, ih: 635 }),
    2: mk(2, PAY),
    3: mk(3, DUP),
    4: mk(4, DUP),
    5: mk(5, SAME),
    6: mk(6, SAME),
  };
  // DOM <iframe> elements of the top document → which extension frame they host
  const els = [
    { order: 0, world: 2, src: PAY, sameOrigin: false, name: '', rect: { x: 150, y: 250, width: 320, height: 200 } },
    { order: 1, world: 3, src: DUP, sameOrigin: false, name: '', rect: { x: 10, y: 10, width: 100, height: 100 } },
    { order: 2, world: 4, src: DUP, sameOrigin: false, name: '', rect: { x: 20, y: 20, width: 100, height: 100 } },
    { order: 3, world: 5, src: SAME, liveUrl: SAME, sameOrigin: true, name: '', rect: { x: 30, y: 30, width: 100, height: 100 } },
    { order: 4, world: 6, src: SAME, liveUrl: SAME, sameOrigin: true, name: '', rect: { x: 40, y: 40, width: 100, height: 100 } },
  ];
  const handle = (w, op, args) => {
    switch (op) {
      case 'selfInfo':
        return { epoch: w.epoch, url: w.url, origin: w.origin, title: 'w', isFrame: w.isFrame, sameOriginAncestry: w.sameOriginAncestry, name: w.name, stamp: w.stamped, innerWidth: w.innerWidth, innerHeight: w.innerHeight, dpr: 1.875, scroll: { ...w.scroll } };
      case 'getDomTree': {
        const entries = w.entries.map((e, i) => ({ ref: `@d${i + 1}`, role: e.role, name: e.name, depth: 1 }));
        return { text: entries.map((e) => `  ${e.ref} ${e.role} "${e.name}"`).join('\n'), entries, ref_count: entries.length };
      }
      case 'childFrameBoxes':
        return { frames: w.frameId === 0 ? els.map((e) => ({ order: e.order, tag: 'iframe', id: '', name: e.name, src: e.src, liveUrl: e.sameOrigin ? e.liveUrl : '', sameOrigin: e.sameOrigin, rect: e.rect, borderLeft: 0, borderTop: 0 })) : [] };
      case 'describeRef': {
        const el = w.entries.find((e) => e.ref === args.ref) || w.entries[0];
        // THE live behaviour (§1): scrollIntoView moves the document it is
        // called in — 2520 → 911 — so any "read-only" claim is falsifiable here
        if (args.scroll) w.scroll.y = 911;
        return { ref: args.ref, tag: 'button', role: el.role, name: el.name, local: el.rect, box: el.rect, visible: true, disabled: false, checked: undefined, attributes: {} };
      }
      case 'stampChild': {
        if (args.via === 'name') throw new Error(LONG_BLOCK); // cross-origin identity channel blocked
        const t = worlds[els[args.order]?.world];
        if (!t) return { ok: false, error: 'no such element' };
        t.stamped = args.token;
        return { ok: true, restore: '' };
      }
      case 'unstampChild': {
        const t = worlds[els[args.order]?.world];
        if (t) t.stamped = null;
        return { ok: true };
      }
      case 'readStamp':
        return { name: '', stamp: w.stamped };
      default:
        throw new Error('fake world: unhandled op ' + op);
    }
  };
  const bridgeCalls = [];
  chromeStub.tabs.sendMessage = async (tabId, msg, opts) => {
    if (msg?.type !== 'UBB_BRIDGE') return { ok: true };
    const fid = opts?.frameId;
    bridgeCalls.push({ op: msg.op, frameId: fid, args: msg.args });
    const w = worlds[fid];
    if (!w) throw new Error('Receiving end does not exist.');
    try {
      return { ok: true, result: handle(w, msg.op, msg.args), frameId: fid, docEpoch: w.epoch };
    } catch (e) {
      return { ok: false, error: String(e?.message || e) };
    }
  };
  const extFrames = [
    { frameId: 0, parentFrameId: -1, url: TOP_URL },
    { frameId: 2, parentFrameId: 0, url: PAY },
    { frameId: 3, parentFrameId: 0, url: DUP },
    { frameId: 4, parentFrameId: 0, url: DUP },
    { frameId: 5, parentFrameId: 0, url: SAME },
    { frameId: 6, parentFrameId: 0, url: SAME },
  ];
  chromeStub.webNavigation.getAllFrames = async () => extFrames.map((f) => ({ ...f, name: '' }));
  const realSend = hub.send;
  hub.send = async (tabId, method, params = {}) => {
    if (method === 'Page.getFrameTree') {
      return { frameTree: { frame: { id: 'MAIN', url: TOP_URL }, childFrames: [{ frame: { id: 'CDP2', url: PAY, parentId: 'MAIN' } }] } };
    }
    if (method === 'Accessibility.getFullAXTree') return { nodes: [] };
    if (method === 'Page.createIsolatedWorld') return { executionContextId: 5 };
    if (method === 'DOM.getFlattenedDocument') return { nodes: [{ nodeId: '1', backendNodeId: 9, frameId: 'MAIN' }] };
    if (method === 'DOM.getFrameOwner') return { backendNodeId: 9 };
    if (method === 'DOM.pushNodesByBackendIdsToFrontend') return { nodeIds: [params.backendNodeIds[0] + 1] };
    if (method === 'DOM.getBoxModel') return { model: { content: [0, 0, 120, 0, 120, 40, 0, 40] } };
    return {};
  };

  const snap = await import(pathToFileURL(path.resolve(HERE, '../lib/snapshot.js')).href);
  const { refs } = await import(pathToFileURL(path.resolve(HERE, '../lib/refs.js')).href);
  const reg = await collectRegistry();
  await sessions.start({});
  sessions.session.created.add(1);
  const pr = await reg.call('frames.probe', { tab_id: 1 });

  ok('PROBE IS READ-ONLY IN FACT: every frame keeps its scrollY (§1: one probe moved 2520 → 911)',
    pr.checks.page_state_unchanged?.unchanged === true && worlds[0].scroll.y === 2520 && Object.values(worlds).every((w) => w.scroll.y === (w.frameId === 0 ? 2520 : 0)),
    JSON.stringify({ report: pr.checks.page_state_unchanged, top: worlds[0].scroll.y }));
  ok('the coordinate sample asked the bridge for scroll:false (the mutation lever is off)',
    bridgeCalls.some((c) => c.op === 'describeRef' && c.args?.scroll === false) && !bridgeCalls.some((c) => c.op === 'describeRef' && c.args?.scroll === true),
    JSON.stringify(bridgeCalls.filter((c) => c.op === 'describeRef').map((c) => c.args)));
  ok('the composed sample box is positive-and-off-screen, not the old phantom y=-1299',
    pr.checks.coordinate_path_sample?.viewport_box?.y === 3250 && pr.checks.coordinate_path_sample.on_screen === false,
    JSON.stringify(pr.checks.coordinate_path_sample));
  const row0 = pr.pairing.find((p) => p.parent_frame_id === 0) || {};
  ok('every paired edge carries the BASIS it was resolved on (resolved_by)',
    row0.paired?.length === 1 && row0.paired[0].resolved_by === 'url', JSON.stringify(row0.paired));
  ok('same-url siblings resolved by the stamp handshake report stamp:attr + the element order',
    row0.unresolved?.filter((u) => u.resolved_by === 'stamp:attr').map((u) => `${u.frame_id}@${u.order}`).join() === '5@3,6@4',
    JSON.stringify(row0.unresolved));
  ok('cross-origin ambiguous siblings stay unresolved AND say why, with the FULL handshake error',
    row0.unresolved?.filter((u) => u.resolved_by === 'unresolved').length === 2
      && row0.unresolved.every((u) => u.resolved_by !== 'unresolved' || (u.stamp_attempt.includes('Blocked a frame with origin') && u.stamp_attempt.length > 120)),
    JSON.stringify(row0.unresolved?.find((u) => u.resolved_by === 'unresolved')));
  ok('checks.window_name_handshake keeps the whole policy error (the 120-char cut is gone)',
    /^failed: Failed to read a named property 'name' from 'Window': Blocked/.test(pr.checks.window_name_handshake)
      && pr.checks.window_name_handshake.length === LONG_BLOCK.length + 'failed: '.length,
    JSON.stringify(pr.checks.window_name_handshake));
  const tally = pr.checks.pairing_resolved_by || {};
  ok('checks.pairing_resolved_by tallies url vs handshake per page (§1 could not observe this)',
    tally.url === 1 && tally.unresolved === 2 && tally['stamp:attr'] === 2 && Object.keys(tally).length === 3,
    JSON.stringify(tally));
  ok('a handshake-blocked page gets an explicit note that pairing is URL/order only',
    /blocked on this page/.test(pr.checks.pairing_note || ''), JSON.stringify(pr.checks.pairing_note));

  // the ACTION path must NOT have been neutered by the read-only fix
  const ref = refs.put(1, null, { role: 'button', name: 'far down button', frameId: 2, domRef: '@d1', epoch: worlds[2].epoch });
  const act = await snap.frameElementBox(1, refs.get(1, ref));
  ok('frameElementBox default stays scroll:true — actions still bring the element into view',
    act.scrolled === true && worlds[2].scroll.y === 911, JSON.stringify({ scrolled: act.scrolled, y: worlds[2].scroll.y }));
  const dsr = bridgeCalls.map((c, i) => (c.op === 'describeRef' ? i : -1)).filter((i) => i >= 0).pop();
  const cfbAfter = bridgeCalls.slice(dsr + 1).some((c) => c.op === 'childFrameBoxes' && c.frameId === 0);
  ok('after a scroll the frame chain is RE-SAMPLED, so box and scroll come from one instant',
    cfbAfter === true, JSON.stringify(bridgeCalls.slice(dsr).map((c) => `${c.op}@${c.frameId}`)));
  worlds[2].scroll.y = 0;
  worlds[0].scroll.y = 2520;
  const meas = await snap.frameElementBox(1, refs.get(1, ref), { scroll: false });
  ok('scroll:false measures without touching the page (and composes the same box)',
    worlds[0].scroll.y === 2520 && worlds[2].scroll.y === 0 && Math.round(meas.box.y) === 3250,
    JSON.stringify({ box: meas.box, top: worlds[0].scroll.y, child: worlds[2].scroll.y }));

  const probeSrc = fs.readFileSync(path.resolve(HERE, '../lib/tools-frames.js'), 'utf8');
  ok('the probe advertises the no-scroll guarantee and the new observability fields',
    /scroll:false/.test(probeSrc) && /page_state_unchanged/.test(probeSrc) && /resolved_by/.test(probeSrc), '');
  const mcpSrc = fs.readFileSync(path.resolve(HERE, 'mcp-tools/frames.mjs'), 'utf8');
  ok('the curated ubb_frames_probe description tells the same story (no scroll, resolved_by)',
    /does not click, type, navigate or scroll/.test(mcpSrc) && /resolved_by/.test(mcpSrc), '');
  ok('frames.probe output still holds no vault value', !containsValue(pr));

  hub.send = realSend;
  await sessions.stop({ close_created: false });
  sessions.session = null;
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
