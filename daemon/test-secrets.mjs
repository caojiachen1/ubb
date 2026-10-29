// Wave 1-E offline/loopback tests for the secret vault (contract §5, §6),
// extended by wave2-secrets: origin-bound secret.fill, replay vars
// substitution, replay.save plaintext restoration (integration-items 活一/活二).
//
//   node daemon/test-secrets.mjs
//
// No real browser is driven (§6.4). The user's own ~/.ubb/secrets.json and
// ~/.ubb/config.json (it holds the daemon token) are never read:
// UBB_SECRETS_FILE / UBB_CONFIG_FILE point at throwaway files in the OS temp
// dir and the only credentials in play are the FAKE_* constants below.
//
// Reverse controls (§6.3) — copy, break one precondition, run, then delete the copy.
//   §0 IS NOT COSMETIC HERE: the repo root IS the extension root, so a clone named
//   `lib/_rc-*.tmp.js` / `daemon/_rc-*.tmp.mjs` puts an underscore-prefixed entry INSIDE the
//   extension and Chrome/Edge then REFUSE TO LOAD THE WHOLE EXTENSION — a real reload of this
//   batch broke exactly that way. Every clone below therefore lives OUTSIDE the repo, in
//   `D:/Codebase/ubb-scratch/rc/<agent-name>/…` (set `RC=D:/Codebase/ubb-scratch/rc/<agent-name>`
//   and read `$RC` as that directory; a leading `_` is only ever OK inside ubb-scratch).
//   Two consequences of leaving the directory: a *lib* clone's `from './x.js'` specifiers must be
//   rewritten to `from 'file:///D:/Codebase/ubb/lib/x.js'`, which is also what keeps the copy on
//   the ONE actions/tabs/ws-client/audit instance the suite already loaded (an un-rewritten copy
//   dies with NO_SESSION and proves nothing — see RC-G9); a *daemon* clone must either have no
//   relative imports (cli/secret.mjs) or be carried out as the whole directory (`cp -r daemon`).
//   The broken CONTENT is what an RC is about, never the location.
//   RC-A cp lib/tools-secrets.js → $RC/rc-a/tools-secrets.js  (origin comparison always true;
//        + the file:/// specifier rewrite)
//        node daemon/test-secrets.mjs --secrets $RC/rc-a/tools-secrets.js
//        → [10] the strict DENIAL cases turn red
//   RC-B cp daemon/cli/secret.mjs → $RC/rc-b/secret.mjs   ('replay' removed from SECRET_VARS_METHODS;
//        this file has no relative imports, so the plain copy is enough)
//        node daemon/test-secrets.mjs --secret $RC/rc-b/secret.mjs
//        → [9] the replay vars positives turn red (B's failure path is a real assertion)
//   RC-C cp lib/tools-secrets.js → $RC/rc-c/tools-secrets.js  (audit entry gains the plaintext)
//        node daemon/test-secrets.mjs --secrets $RC/rc-c/tools-secrets.js
//        → [10] "audit holds no value" turns red
//   RC1 (E): `cp -r daemon $RC/rc-1/daemon` (the whole dir, so './wslib.mjs' and './cli/secret.mjs'
//        still resolve) + widen the method allowlist to evaluate →
//        node daemon/test-secrets.mjs --bridge $RC/rc-1/daemon/ubb-bridge.mjs
//   RC2 (E): cp lib/actions.js → $RC/rc-2/actions.js (neuter SENSITIVE_FIELD_NEVER, specifier
//        rewrite as in RC-A) → node daemon/test-secrets.mjs --actions $RC/rc-2/actions.js
//   RC-D (fix7 §3c): copy daemon/cli/secret.mjs to
//        D:/Codebase/ubb-scratch/rc7/_rc-type.mjs (already outside the repo — legal) with
//        SECRET_FILL_METHODS back
//        to {fill, fill_form, type} — reproduces the live bypass — then
//        node daemon/test-secrets.mjs --secret ../../ubb-scratch/rc7/_rc-type.mjs
//        → [2] "type: NOT substituted, placeholder stays literal…" (and its
//        no-stamp sibling) turn red. The [6.2] "type over the wire" half keeps
//        its green BY DESIGN: the spawned bridge imports the REAL cli/secret.mjs,
//        so that assertion is pinned to shipped code, not to the RC copy.
//   RC-E (fix7 §2d): same-copy patch restoring the old `!h.includes('.')`
//        requirement in normalizeOriginHost →
//        node daemon/test-secrets.mjs --secret ../../ubb-scratch/rc7/_rc-dot.mjs
//        → dies at the "origin host ACCEPTS the bare single-label localhost"
//        line with exactly the incident error (BAD_ORIGIN_HOST "localhost").
//   RC-F (fix7 trap): same-copy patch originMatches() → `h.includes(b)` →
//        node daemon/test-secrets.mjs --secret ../../ubb-scratch/rc7/_rc-includes.mjs
//        → [8] the suffix/prefix trap trio (incl. xlocalhost.test) turns red.
//   RC-G9 (fix9 ①) 还原 secret.fill 的"withPass 不带 opts + insertText 不带逐派发确认":
//        注意：本节与 [12] 用 --secrets 换的是**扩展侧模块**，副本必须留在仓库外（§0），
//        并把 `from './x.js'` 改写成 `from 'file:///D:/Codebase/ubb/lib/x.js'`，
//        这样副本与测试进程共用同一份 actions/tabs/ws-client/audit 单例（否则 NO_SESSION）。
//        node daemon/test-secrets.mjs --secrets D:/Codebase/ubb-scratch/rc/fix9/rc-1/tools-secrets.js
//        → [12] 红 7 条，最坏那条原文是「拒绝即线路 0 条 Input.insertText … — ["Input.insertText"]」：
//          明文已经作为 insertText 上了线路，之后 key() 的确认才红（= 7g 谎报的凭据版）。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { installChromeStub, collectRegistry } from '../lib/testharness.mjs';
import { audit as auditRing } from '../lib/audit.js';
import { redact } from '../lib/redact.js';
import { cdp as hub } from '../lib/cdp.js';
import { sessions } from '../lib/tabs.js';
import { refs } from '../lib/refs.js';
import { AgentLink } from '../lib/ws-client.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------- fixtures
const FAKE = 'hunter2-TEST-ONLY';
const FAKE2 = 'correct-horse-TEST-ONLY';
const FAKE3 = 'session-cookie-TEST-ONLY';
const FAKE4 = 'bare-legacy-TEST-ONLY';
const VAULT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ubb-secret-test-'));
const VAULT = path.join(VAULT_DIR, 'secrets.json');
const CONFIG = path.join(VAULT_DIR, 'config.json'); // never the user's real one (token!)
process.env.UBB_SECRETS_FILE = VAULT;
process.env.UBB_CONFIG_FILE = CONFIG;

const argv = process.argv.slice(2);
const optOf = (flagName) => {
  const i = argv.indexOf(flagName);
  return i >= 0 ? argv[i + 1] : null;
};
const BRIDGE = path.resolve(HERE, optOf('--bridge') || 'ubb-bridge.mjs');
// --actions / --bridge / --secret / --secrets point the suite at deliberately
// broken copies (RC runs)
const ACTIONS = optOf('--actions') ? path.resolve(HERE, optOf('--actions')) : path.join(HERE, '../lib/actions.js');
const SECRETS_DAEMON = pathToFileURL(path.resolve(HERE, optOf('--secret') || './cli/secret.mjs')).href;
const SECRETS_EXT = pathToFileURL(path.resolve(HERE, optOf('--secrets') || '../lib/tools-secrets.js')).href;
const RC = optOf('--bridge') || optOf('--actions') || optOf('--secret') || optOf('--secrets')
  ? ` [REVERSE CONTROL → ${optOf('--bridge') || optOf('--actions') || optOf('--secret') || optOf('--secrets')}]`
  : '';
const S = await import(SECRETS_DAEMON);

const PORT = 8931;
const TOKEN = 'sectest-token-0000000000000000000000ab';

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
  return [FAKE, FAKE2, FAKE3, FAKE4].some((v) => s.includes(v));
};

// ---------------------------------------------------------------- 1. vault
console.log(`\n== 1. vault storage${RC} ==`);

ok('missing vault file lists as empty (no throw)', S.listNames().length === 0);
ok('resolveSecret on absent vault returns null', S.resolveSecret('nope') === null);

S.setSecret('github_pw', FAKE);
S.setSecret('alt_pw', FAKE2);
ok('round-trip resolveSecret', S.resolveSecret('github_pw') === FAKE);
ok('vault shape is {"name":"value"}', JSON.parse(fs.readFileSync(VAULT, 'utf8')).github_pw === FAKE);
ok('listNames returns names only', JSON.stringify(S.listNames()) === '["alt_pw","github_pw"]');
ok('deleteSecret removes and reports existed', S.deleteSecret('alt_pw').existed === true && S.resolveSecret('alt_pw') === null);
ok('deleteSecret of an unknown name is not an error', S.deleteSecret('alt_pw').existed === false);

for (const bad of ['../etc/passwd', 'has space', 'x'.repeat(65), 'a/b', '带中文', '']) {
  let code = null;
  try {
    S.setSecret(bad, FAKE3);
  } catch (e) {
    code = e.code;
  }
  ok(`name rejected: ${JSON.stringify(bad).slice(0, 24)}`, code === 'BAD_SECRET_NAME', `got ${code}`);
}
ok('a rejected name never touched the vault', S.listNames().join() === 'github_pw', S.listNames().join());

// ---------------------------------------------------------------- 2. forward allowlist
console.log(`\n== 2. {{secret:NAME}} forward rules${RC} ==`);
{
  const r = S.prepareForward('tool.fill', { ref: '@e7', value: '{{secret:github_pw}}', tab_id: 3 });
  ok('fill: placeholder replaced', r.params.value === FAKE);
  ok('fill: __ubb_secret_fill set', r.params.__ubb_secret_fill === true);
  ok('fill: replaced counter', r.replaced === 1 && r.missing.length === 0);

  const ff = S.prepareForward('fill_form', { values: { '@e5': 'alice', '@e7': '{{secret:github_pw}}' } });
  ok('fill_form: nested map replaced', ff.params.values['@e7'] === FAKE && ff.params.values['@e5'] === 'alice');

  // THE 2B §3c regression: `type` has no target field to classify, so the
  // never-fill guard structurally cannot run on its path — the placeholder
  // must stay LITERAL and the vault value must never ride this method.
  const t = S.prepareForward('type', { text: '{{secret:github_pw}}!' });
  ok('type: NOT substituted, placeholder stays literal (was the live bypass channel)', t.params.text === '{{secret:github_pw}}!' && t.replaced === 0 && !containsValue(t.params));
  ok('type: no __ubb_secret_fill / names / gate stamped', t.params.__ubb_secret_fill === undefined && t.params.__ubb_secret_names === undefined && t.params.__ubb_secret_gate === undefined);
  const forgT = S.prepareForward('type', { text: 'plain', __ubb_secret_fill: true, __ubb_secret_names: ['github_pw'] });
  ok('type: even a forged marker is stripped and nothing resolves (no strip-then-release path exists)', forgT.params.__ubb_secret_fill === undefined && forgT.params.__ubb_secret_names === undefined && forgT.params.text === 'plain' && !containsValue(forgT.params));

  // replay keeps its own section below: it substitutes, but only inside vars
  for (const method of ['evaluate', 'tool.evaluate', 'cdp.call', 'webmcp.invoke', 'batch', 'ext.call', 'insert_text']) {
    const r2 = S.prepareForward(method, { expression: `fetch("http://127.0.0.1",{{secret:github_pw}})` });
    ok(`${method}: NOT substituted`, r2.params.expression.includes('{{secret:github_pw}}') && r2.replaced === 0 && !r2.params.__ubb_secret_fill);
    ok(`${method}: no plaintext in forwarded params`, !containsValue(r2.params));
  }

  const miss = S.prepareForward('fill', { value: '{{secret:no_such_name}}' });
  ok('unknown name → missing list', miss.missing.join() === 'no_such_name', JSON.stringify(miss.missing));
  ok('unknown name → params untouched', miss.params.value === '{{secret:no_such_name}}');
  const inv = S.prepareForward('fill', { value: '{{secret:../etc/passwd}}' });
  ok('path-shaped name is malformed, never resolved', inv.invalid.length === 1 && inv.replaced === 0);
  ok('forwarded params never contain plaintext', !containsValue(inv.params));
}

// ---------------------------------------------------------------- 3. guardSensitiveField
console.log(`\n== 3. guardSensitiveField${RC} ==`);
installChromeStub();
const { guardSensitiveField } = await import(pathToFileURL(ACTIONS).href);
const chromeStub = globalThis.chrome;

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
// pre-seed a CDP session object so send() skips the real attach path
const fakeSession = { tabId: 1, queue: Promise.resolve(), gen: 1, frameId: null, console: [], net: [], dialogs: [], enabledDomains: new Set(), domFetched: true };
hub.sessions.set(1, fakeSession);

async function guard(attrs, opts) {
  withAttrs(attrs);
  try {
    await guardSensitiveField(1, 7, { name: attrs.name || '' }, opts);
    return { outcome: 'ALLOWED' };
  } catch (e) {
    return { outcome: e?.code || 'THREW', message: e?.message || '' };
  }
}

const g = (attrs, opts) => guard(attrs, opts);
ok('password refused for the 3-arg call sites (fill/fill_form compat)', (await g({ type: 'password', name: 'pw' })).outcome === 'SENSITIVE_FIELD');
ok('current-password refused by default', (await g({ type: 'text', autocomplete: 'current-password' })).outcome === 'SENSITIVE_FIELD');
const pwMsg = (await g({ type: 'password', name: 'pw' })).message;
ok('refusal tells the agent what to do instead (secret.fill / placeholder)', /secret\.fill/.test(pwMsg) && /secret:/.test(pwMsg), pwMsg);
ok('password allowed with allowPassword', (await g({ type: 'password', name: 'pw' }, { allowPassword: true })).outcome === 'ALLOWED');
ok('autocomplete=current-password allowed with allowPassword', (await g({ type: 'text', autocomplete: 'current-password' }, { allowPassword: true })).outcome === 'ALLOWED');
const otpRes = await g({ type: 'text', autocomplete: 'one-time-code' }, { allowPassword: true });
ok('OTP input refused even with allowPassword', otpRes.outcome === 'SENSITIVE_FIELD');
ok('OTP refusal is value-free and offers no bypass', !/bypass|allowPassword/i.test(otpRes.message) && !containsValue(otpRes.message), otpRes.message);
ok('name=otp refused even with allowPassword', (await g({ type: 'text', name: 'otp_code' }, { allowPassword: true })).outcome === 'SENSITIVE_FIELD');
ok('name=验证码 refused even with allowPassword', (await g({ type: 'text', name: '验证码' }, { allowPassword: true })).outcome === 'SENSITIVE_FIELD');
ok('cvv refused even with allowPassword', (await g({ type: 'text', name: 'cvv' }, { allowPassword: true })).outcome === 'SENSITIVE_FIELD');
ok('cvc refused even with allowPassword', (await g({ type: 'text', name: 'cvc' }, { allowPassword: true })).outcome === 'SENSITIVE_FIELD');
ok('card number refused even with allowPassword', (await g({ type: 'text', name: 'card_number' }, { allowPassword: true })).outcome === 'SENSITIVE_FIELD');
ok('卡号 refused even with allowPassword', (await g({ type: 'text', id: '卡号' }, { allowPassword: true })).outcome === 'SENSITIVE_FIELD');
ok('私钥 refused even with allowPassword', (await g({ type: 'text', placeholder: '私钥' }, { allowPassword: true })).outcome === 'SENSITIVE_FIELD');
ok('name contains "secret" (client_secret) refused even with allowPassword — deliberate, pinned', (await g({ type: 'password', name: 'client_secret' }, { allowPassword: true })).outcome === 'SENSITIVE_FIELD');
ok('name=secret refused even with allowPassword', (await g({ type: 'password', name: 'secret' }, { allowPassword: true })).outcome === 'SENSITIVE_FIELD');
ok('password+otp combined refused (hard class wins)', (await g({ type: 'password', name: 'password_cvv' }, { allowPassword: true })).outcome === 'SENSITIVE_FIELD');
ok('plain text field still allowed', (await g({ type: 'text', name: 'email' })).outcome === 'ALLOWED');

// ---------------------------------------------------------------- 4. reverse RPC pairing
console.log(`\n== 4. ws-client requestDaemon pairing${RC} ==`);
{
  const link = new AgentLink(async () => ({ port: PORT, token: TOKEN, enabled: false }));
  const frames = [];
  link.ws = { readyState: 1, send: (t) => frames.push(JSON.parse(t)) };

  const p = link.requestDaemon('secret.resolve', { name: 'github_pw' });
  ok('request uses an s<seq> id (never collides with the x<seq> agent routes)', /^s\d+$/.test(frames[0]?.id), frames[0]?.id);
  ok('request carries method + params', frames[0].method === 'secret.resolve' && frames[0].params.name === 'github_pw');
  ok('in-flight request is not treated as a tool request', link.consumePendingResponse({ id: 'x1', result: {} }) === false);
  ok('reply pairs by id', (await (async () => {
    link.consumePendingResponse({ id: frames[0].id, result: { value: FAKE } });
    const r = await p;
    return r.value === FAKE;
  })()));

  let code = null;
  try {
    await link.requestDaemon('secret.resolve', { name: 'gone' }, 60);
  } catch (e) {
    code = e.code;
  }
  ok('unanswered request → SECRET_FETCH_TIMEOUT', code === 'SECRET_FETCH_TIMEOUT', `got ${code}`);

  const pErr = link.requestDaemon('secret.resolve', { name: 'gone' });
  const errFrame = frames[frames.length - 1];
  link.consumePendingResponse({ id: errFrame.id, error: { code: 'SECRET_UNKNOWN', message: `no secret named "gone"` } });
  let code2 = null;
  try {
    await pErr;
  } catch (e) {
    code2 = e.code;
  }
  ok('daemon error surfaces with its own code', code2 === 'SECRET_UNKNOWN', `got ${code2}`);

  const pDead = link.requestDaemon('secret.resolve', { name: 'github_pw' });
  link.ws = null;
  link.stop();
  let code3 = null;
  try {
    await pDead;
  } catch (e) {
    code3 = e.code;
  }
  ok('socket close rejects in-flight requests instead of hanging', code3 === 'DAEMON_NOT_CONNECTED', `got ${code3}`);
}

// ---------------------------------------------------------------- 5. registry
console.log(`\n== 5. extension tool registry (offline)${RC} ==`);
const reg = await collectRegistry();
const M = reg.metas;
for (const n of ['secret.list', 'secret.set', 'secret.delete', 'secret.fill']) {
  ok(`${n} registered by lib/tools-extra.js`, reg.names.includes(n));
  ok(`${n} has category + description`, M[n]?.category === 'secrets' && (M[n]?.description || '').length > 40);
}
ok('secret.set is sensitive:true (confirm-gated)', M['secret.set']?.sensitive === true);
ok('secret.fill description forbids plaintext args and names the bypass-free classes', /OTP/.test(M['secret.fill'].description) && /never appears/i.test(M['secret.fill'].description));

let code = null;
try {
  await reg.call('secret.fill', { ref: '@e7', secret: 'github_pw', tab_id: 99999 });
} catch (e) {
  code = e?.code;
}
ok('secret.fill without a session throws NO_SESSION', code === 'NO_SESSION', `got ${code}`);

code = null;
try {
  await reg.call('secret.fill', { ref: '@e7', secret: '../etc/passwd', tab_id: 1 });
} catch (e) {
  code = e?.code;
}
ok('secret.fill rejects a malformed secret name before touching the daemon', code === 'BAD_PARAMS', `got ${code}`);

code = null;
try {
  await reg.call('secret.fill', { ref: '@e7', secret: 'github_pw', value: FAKE, tab_id: 1 });
} catch (e) {
  code = e?.code;
}
ok('secret.fill refuses a value passed as an argument (SENSITIVE_FIELD)', code === 'SENSITIVE_FIELD', `got ${code}`);

code = null;
try {
  await reg.call('secret.set', { name: 'x_pw', value: FAKE });
} catch (e) {
  code = e?.code;
}
ok('secret.set without confirm throws NEEDS_CONFIRM', code === 'NEEDS_CONFIRM', `got ${code}`);

// secret.list / set / delete travel over the link — drive them with a fake socket
{
  const link = new AgentLink(async () => ({ port: PORT, token: TOKEN, enabled: false }));
  const frames = [];
  link.ws = { readyState: 1, send: (t) => frames.push(JSON.parse(t)) };

  const pList = reg.call('secret.list', {});
  await new Promise((r) => setTimeout(r, 0));
  const f = frames[frames.length - 1];
  ok('secret.list asks the daemon (no tab, no session needed)', f.method === 'secret.list');
  link.consumePendingResponse({ id: f.id, result: { names: ['github_pw'], vault_path: VAULT, vault_updated_at: 'x' } });
  const listed = await pList;
  ok('secret.list output carries names', listed.names.join() === 'github_pw');
  ok('secret.list output holds NO value anywhere', !containsValue(listed), JSON.stringify(listed));

  const pDel = reg.call('secret.delete', { name: 'github_pw' });
  await new Promise((r) => setTimeout(r, 0));
  const f2 = frames[frames.length - 1];
  link.consumePendingResponse({ id: f2.id, result: { name: 'github_pw', existed: true } });
  const del = await pDel;
  ok('secret.delete returns name + existed only', del.deleted === 'github_pw' && del.existed === true && !containsValue(del));

  code = null;
  link.ws = null; // socket gone BEFORE the ask starts: the tool must fail fast, not sit on the 10s timer
  try {
    await reg.call('secret.list', {});
  } catch (e) {
    code = e?.code ?? 'THREW';
  }
  ok('secret.list without a daemon link → DAEMON_NOT_CONNECTED', code === 'DAEMON_NOT_CONNECTED', `got ${code}`);
}

// ---------------------------------------------------------------- 5b. secret.fill target rules
console.log(`\n== 5b. secret.fill target rules (offline CDP + offline link)${RC} ==`);
{
  await sessions.start({});
  sessions.session.created.add(1); // targetTab() must accept tab_id 1
  fakeSession.nodeIndex = new Map([[55, 7]]);
  fakeSession.nodeIndexGen = fakeSession.gen;
  const ref = refs.put(1, 55, { role: 'textbox', name: 'pw' });

  const link = new AgentLink(async () => ({ port: PORT, token: TOKEN, enabled: false }));
  const frames = [];
  link.ws = { readyState: 1, send: (t) => frames.push(JSON.parse(t)) };

  let cdpCalls = [];
  const answer = async (attrs) => {
    cdpCalls = [];
    frames.length = 0;
    chromeStub.debugger.sendCommand = async (_t, method, params) => {
      cdpCalls.push({ method, params });
      if (method === 'DOM.getAttributes') {
        const flat = [];
        for (const [k, v] of Object.entries(attrs)) flat.push(k, String(v));
        return { attributes: flat };
      }
      if (method === 'DOM.getBoxModel') return { model: { content: [10, 10, 110, 10, 110, 30, 10, 30] } };
      return {};
    };
    const p = reg.call('secret.fill', { ref, secret: 'github_pw', tab_id: 1, press_enter: true });
    p.catch(() => {});
    await new Promise((r) => setTimeout(r, 5));
    const asked = frames.find((f) => f.method === 'secret.resolve');
    return { p, asked };
  };
  const inserted = () => cdpCalls.filter((c) => c.method === 'Input.insertText').map((c) => c.params.text);

  // a) an ordinary field is NOT a secret.fill target — and nothing is fetched
  let r = await answer({ type: 'text', name: 'email' });
  code = null;
  try {
    await r.p;
  } catch (e) {
    code = e?.code;
  }
  ok('secret.fill on a non-password field → NOT_PASSWORD_FIELD', code === 'NOT_PASSWORD_FIELD', `got ${code}`);
  ok('secret.fill does not ask the daemon for a non-password field', !r.asked && frames.length === 0);
  ok('secret.fill does not insert anything for a non-password field', inserted().length === 0);

  // b) OTP stays hard-refused even on this "allowed" path
  r = await answer({ type: 'text', name: 'code', autocomplete: 'one-time-code' });
  code = null;
  try {
    await r.p;
  } catch (e) {
    code = e?.code;
  }
  ok('secret.fill on an OTP input → SENSITIVE_FIELD', code === 'SENSITIVE_FIELD', `got ${code}`);
  ok('secret.fill never fetches a value for an OTP input', !r.asked && inserted().length === 0);

  // c) the happy path: value comes from the daemon at typing time
  r = await answer({ type: 'password', name: 'pw' });
  ok('password target → asks the daemon by NAME only', r.asked?.method === 'secret.resolve' && r.asked.params.name === 'github_pw' && !containsValue(r.asked.params));
  ok('the ask rides an s<seq> id', /^s\d+$/.test(r.asked?.id), r.asked?.id);
  link.consumePendingResponse({ id: r.asked.id, result: { value: FAKE } });
  const filled = await r.p;
  ok('secret.fill result carries ref + target + NAME', filled.filled === ref && filled.target === 'pw' && filled.secret === 'github_pw');
  ok('secret.fill result holds NO value', !containsValue(filled), JSON.stringify(filled));
  ok('the plaintext lands only in the injected CDP input command', inserted().join() === FAKE, JSON.stringify(inserted()));
  ok('replace semantics: node marked then re-read before typing', cdpCalls.some((c) => c.method === 'DOM.setAttributeValue' && c.params.name === 'data-ubb-tmp'));
  ok('press_enter dispatched as a real key pair', cdpCalls.some((c) => c.method === 'Input.dispatchKeyEvent' && c.params.key === 'Enter' && c.params.type === 'keyDown') && cdpCalls.some((c) => c.params?.key === 'Enter' && c.params?.type === 'keyUp'));
  ok('no daemon request leaked into the result path', !containsValue(cdpCalls.filter((c) => c.method !== 'Input.insertText')));

  // d) the vault says no → nothing is typed
  r = await answer({ type: 'password', name: 'pw' });
  link.consumePendingResponse({ id: r.asked.id, error: { code: 'SECRET_UNKNOWN', message: 'no secret named "github_pw"' } });
  code = null;
  try {
    await r.p;
  } catch (e) {
    code = e?.code;
  }
  ok('SECRET_UNKNOWN from the daemon stops the fill', code === 'SECRET_UNKNOWN' && inserted().length === 0, `got ${code}`);

  await sessions.stop({ close_created: false });
  sessions.session = null;
}
// ---------------------------------------------------------------- 6. live daemon loopback
console.log(`\n== 6. daemon loopback (spawned bridge + fake extension/agent sockets)${RC} ==`);
S.setSecret('github_pw', FAKE);
const child = spawn(process.execPath, [BRIDGE, '--port', String(PORT), '--token', TOKEN], {
  cwd: HERE,
  env: { ...process.env, UBB_SECRETS_FILE: VAULT },
  stdio: ['pipe', 'pipe', 'pipe'],
});
let daemonOut = '';
let daemonErr = '';
child.stdout.setEncoding('utf8');
child.stderr.setEncoding('utf8');
child.stdout.on('data', (d) => (daemonOut += d));
child.stderr.on('data', (d) => (daemonErr += d));

function wsConnect(protocols) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/`, protocols);
    const ev = { messages: [], closed: null };
    ws.addEventListener('open', () => resolve({ ws, ev }), { once: true });
    ws.addEventListener('close', (c) => (ev.closed = c.code));
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
    const to = setTimeout(() => {
      clearInterval(iv);
      resolve(null);
    }, ms);
    hit();
  });
const noneSeen = async (ev, pred, ms = 400) => {
  await new Promise((r) => setTimeout(r, ms));
  return !ev.messages.some(pred);
};
const t0 = Date.now();
while (Date.now() - t0 < 8000) {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/health`, { signal: AbortSignal.timeout(300) });
    if (r.ok) break;
  } catch {
    await new Promise((r) => setTimeout(r, 150));
  }
}

const ext = await wsConnect([`ubb-auth.${TOKEN}`]);
ext.ws.send(JSON.stringify({ id: 'hello', method: 'hello', params: { protocol_version: '1.0', min_compatible: '1.0', client: 'ubb-extension', version: 'test' } }));
ok('extension handshake ok', !!(await next(ext.ev, (m) => m.id === 'hello' && m.result)));

const agentA = await wsConnect([`ubb-agent.${TOKEN}`]);
const agentB = await wsConnect([`ubb-agent.${TOKEN}`]);
const sendA = (o) => agentA.ws.send(JSON.stringify(o));

// 6.1 fill gets the plaintext
sendA({ id: 101, method: 'tool.fill', params: { ref: '@e7', value: '{{secret:github_pw}}', tab_id: 1 } });
const got101 = await next(ext.ev, (m) => m.method === 'tool.fill');
ok('fill reached the extension', !!got101);
ok('fill: value resolved to the vault entry', got101?.params?.value === FAKE);
ok('fill: __ubb_secret_fill set for the extension guard', got101?.params?.__ubb_secret_fill === true);
ok('fill: route id keeps the x prefix', /^x\d+$/.test(got101?.id), got101?.id);
ext.ws.send(JSON.stringify({ id: got101.id, result: { filled: '@e7' } }));
const rep101 = await next(agentA.ev, (m) => m.id === 101);
ok('fill reply still routed back to its agent', rep101?.result?.filled === '@e7');

// 6.2 the critical negative: evaluate must NOT be substituted
sendA({ id: 102, method: 'tool.evaluate', params: { expression: "credentials('{{secret:github_pw}}')", tab_id: 1 } });
const got102 = await next(ext.ev, (m) => m.method === 'tool.evaluate');
ok('evaluate forwarded', !!got102);
ok('evaluate: placeholder left literal (KEY NEGATIVE)', got102?.params?.expression === "credentials('{{secret:github_pw}}')", `extension got ${JSON.stringify(got102?.params?.expression)}`);
ok('evaluate: no plaintext ever forwarded', !containsValue(got102?.params), `LEAKED into page-JS args: ${JSON.stringify(got102?.params)}`);
ok('evaluate: no __ubb_secret_fill stamped', got102?.params?.__ubb_secret_fill === undefined);
ext.ws.send(JSON.stringify({ id: got102.id, result: { ok: true } }));

sendA({ id: 103, method: 'cdp.call', params: { method: 'Runtime.evaluate', params: { expression: '{{secret:github_pw}}' }, tab_id: 1 } });
const got103 = await next(ext.ev, (m) => m.method === 'cdp.call');
ok('cdp.call: nested params NOT substituted', got103?.params?.params?.expression === '{{secret:github_pw}}' && !containsValue(got103?.params));

sendA({ id: 104, method: 'tool.batch', params: { steps: [{ method: 'fill', params: { value: '{{secret:github_pw}}' } }] } });
const got104 = await next(ext.ev, (m) => m.method === 'tool.batch');
ok('batch: NOT substituted (no nested-method laundering)', got104?.params?.steps[0]?.params?.value === '{{secret:github_pw}}');
sendA({ id: 105, method: 'tool.replay', params: { steps: [{ value: '{{secret:github_pw}}' }] } });
const got105 = await next(ext.ev, (m) => m.method === 'tool.replay');
ok('replay: structural steps[] NOT substituted (substitution is scoped to vars)', got105?.params?.steps[0]?.value === '{{secret:github_pw}}');
sendA({ id: 106, method: 'tool.type', params: { text: '{{secret:github_pw}}', tab_id: 1 } });
const got106 = await next(ext.ev, (m) => m.method === 'tool.type');
ok('type over the wire: extension receives the LITERAL placeholder with NO __ubb_secret_fill and no plaintext (2B §3c incident regression — what landed in #cvv as 35 chars must now stay a 24-char literal)', got106?.params?.text === '{{secret:github_pw}}' && got106?.params?.__ubb_secret_fill === undefined && !containsValue(got106?.params), JSON.stringify(got106?.params));

// 6.3 unknown name: SECRET_UNKNOWN, name-only message, nothing forwarded
const before = ext.ev.messages.length;
sendA({ id: 107, method: 'tool.fill', params: { value: '{{secret:nope_not_stored}}' } });
const rep107 = await next(agentA.ev, (m) => m.id === 107);
ok('unknown name → SECRET_UNKNOWN', rep107?.error?.code === 'SECRET_UNKNOWN', JSON.stringify(rep107));
ok('SECRET_UNKNOWN message names the entry', /nope_not_stored/.test(rep107?.error?.message || ''));
ok('SECRET_UNKNOWN message carries no value', !containsValue(rep107?.error));
ok('unknown name never reaches the extension', ext.ev.messages.length === before);

sendA({ id: 108, method: 'tool.fill', params: { value: '{{secret:../etc/passwd}}' } });
const rep108 = await next(agentA.ev, (m) => m.id === 108);
ok('path-shaped placeholder → BAD_SECRET_NAME, unforwarded', rep108?.error?.code === 'BAD_SECRET_NAME' && !containsValue(rep108));

// 6.4 reverse RPC: extension asks, daemon answers — and NOTHING is broadcast
ext.ws.send(JSON.stringify({ id: 's1', method: 'secret.resolve', params: { name: 'github_pw' } }));
const repS1 = await next(ext.ev, (m) => m.id === 's1');
ok('daemon answers secret.resolve on the extension socket', repS1?.result?.value === FAKE);
await new Promise((r) => setTimeout(r, 500));
ok('reverse reply was NOT broadcast to agent A', !agentA.ev.messages.some((m) => m.id === 's1' || containsValue(m)));
ok('reverse reply was NOT broadcast to agent B', !agentB.ev.messages.some((m) => m.id === 's1' || containsValue(m)));
ok('reverse reply was NOT written to daemon stdout', !daemonOut.includes('"s1"') && !daemonOut.includes(FAKE));
// a stray `x…` id reply with no route must still be dropped, not broadcast
ext.ws.send(JSON.stringify({ id: 'x99999', result: { leaked: true } }));
ok('unrouted extension reply still dropped', await noneSeen(agentA.ev, (m) => m?.leaked));
ok('normal agent→extension traffic keeps working after the secret branch', ext.ev.messages.some((m) => /^x\d+$/.test(String(m.id))));

ext.ws.send(JSON.stringify({ id: 's2', method: 'secret.list', params: {} }));
const repS2 = await next(ext.ev, (m) => m.id === 's2');
ok('secret.list over reverse RPC returns names', (repS2?.result?.names || []).includes('github_pw'));
ok('secret.list over reverse RPC holds no value', !containsValue(repS2));

ext.ws.send(JSON.stringify({ id: 's3', method: 'secret.set', params: { name: 'cli_pw', value: FAKE2 } }));
const repS3 = await next(ext.ev, (m) => m.id === 's3');
ok('secret.set stores and echoes only name+bytes', repS3?.result?.stored === 'cli_pw' && !containsValue(repS3));
ok('set is readable afterwards', S.resolveSecret('cli_pw') === FAKE2);

ext.ws.send(JSON.stringify({ id: 's4', method: 'secret.resolve', params: { name: 'cli_pw' } }));
ok('resolved just-written secret', (await next(ext.ev, (m) => m.id === 's4'))?.result?.value === FAKE2);

ext.ws.send(JSON.stringify({ id: 's5', method: 'secret.delete', params: { name: 'cli_pw' } }));
ok('secret.delete works', (await next(ext.ev, (m) => m.id === 's5'))?.result?.existed === true);

ext.ws.send(JSON.stringify({ id: 's6', method: 'secret.resolve', params: { name: 'not_there' } }));
const repS6 = await next(ext.ev, (m) => m.id === 's6');
ok('unknown name over reverse RPC → SECRET_UNKNOWN (name only)', repS6?.error?.code === 'SECRET_UNKNOWN' && /not_there/.test(repS6.error.message) && !containsValue(repS6));

ext.ws.send(JSON.stringify({ id: 's7', method: 'page.captureScreenshot', params: {} }));
ok('non-secret reverse method refused', (await next(ext.ev, (m) => m.id === 's7'))?.error?.code === 'RPC_METHOD_NOT_ALLOWED');

ext.ws.send(JSON.stringify({ id: 's8', method: 'secret.resolve', params: { name: '../etc/passwd' } }));
ok('invalid name over reverse RPC → BAD_SECRET_NAME', (await next(ext.ev, (m) => m.id === 's8'))?.error?.code === 'BAD_SECRET_NAME');

// 6.4b wave2 hand-offs over the REAL forward path (replay vars, save restore, fill stamp)
S.setSecret('bound_pw', FAKE3, ['github.com']); // FAKE3 is unique in the vault → deterministic restore target
sendA({ id: 111, method: 'tool.replay', params: { tab_id: 4, vars: { PW: '{{secret:bound_pw}}', Q: 'plain' }, trace: { events: [{ type: 'input', value: '{{secret:bound_pw}}' }] } } });
const got111 = await next(ext.ev, (m) => m.method === 'tool.replay' && m.params?.vars);
ok('replay over the wire: vars value resolved', got111?.params?.vars?.PW === FAKE3 && got111?.params?.vars?.Q === 'plain');
ok('replay over the wire: per-key resolved ledger stamped for the extension guard', got111?.params?.__ubb_secret_vars?.PW?.join() === 'bound_pw' && got111?.params?.__ubb_secret_fill === true);
ok('replay over the wire: trace.events kept the placeholder (no plaintext in structural fields)', got111?.params?.trace?.events?.[0]?.value === '{{secret:bound_pw}}');
ext.ws.send(JSON.stringify({ id: got111.id, result: { ok: true } }));

sendA({ id: 112, method: 'tool.replay.save', params: { name: 'demo', events: [{ type: 'input', value: FAKE3 }] } });
const got112 = await next(ext.ev, (m) => m.method === 'tool.replay.save' && m.params?.name === 'demo');
ok('replay.save over the wire: vault plaintext restored to its placeholder before it can reach storage.session', got112?.params?.events?.[0]?.value === '{{secret:bound_pw}}' && !containsValue(got112?.params), JSON.stringify(got112?.params));
ext.ws.send(JSON.stringify({ id: got112.id, result: { saved: true } }));

sendA({ id: 113, method: 'tool.replay', params: { tab_id: 4, vars: { PW: 'literal' }, __ubb_secret_fill: true, __ubb_secret_vars: { PW: ['bound_pw'] } } });
const got113 = await next(ext.ev, (m) => m.params?.vars?.PW === 'literal');
ok('forged replay markers stripped daemon-side (extension cannot be told "this step is vault-backed")', got113?.params?.__ubb_secret_fill === undefined && got113?.params?.__ubb_secret_vars === undefined && !containsValue(got113?.params));
ext.ws.send(JSON.stringify({ id: got113.id, result: { ok: true } }));

const before114 = ext.ev.messages.length;
sendA({ id: 114, method: 'tool.replay', params: { vars: { PW: '{{secret:not_stored_xyz}}' } } });
const rep114 = await next(agentA.ev, (m) => m.id === 114);
ok('replay vars unknown name → SECRET_UNKNOWN from the daemon, nothing forwarded', rep114?.error?.code === 'SECRET_UNKNOWN' && ext.ev.messages.length === before114 && !containsValue(rep114));

sendA({ id: 115, method: 'tool.secret.fill', params: { ref: '@e7', secret: 'bound_pw', tab_id: 1 } });
const got115 = await next(ext.ev, (m) => m.method === 'tool.secret.fill');
ok('secret.fill stamped with the authoritative binding (config default off)', got115?.params?.__ubb_secret_binding?.mode === 'off' && got115?.params?.__ubb_secret_binding?.origins?.join() === 'github.com', JSON.stringify(got115?.params));
ext.ws.send(JSON.stringify({ id: got115.id, result: { filled: '@e7' } }));

S.setSecretOriginMode('strict'); // writes the THROWAWAY CONFIG (UBB_CONFIG_FILE), not the user's
sendA({ id: 116, method: 'tool.secret.fill', params: { ref: '@e7', secret: 'bound_pw', tab_id: 1 } });
const got116 = await next(ext.ev, (m) => m.method === 'tool.secret.fill' && m.id !== got115.id);
ok('secret.fill stamp follows config strict', got116?.params?.__ubb_secret_binding?.mode === 'strict');
sendA({ id: 117, method: 'tool.secret.fill', params: { ref: '@e7', secret: 'bound_pw', enforce: 'off', tab_id: 1 } });
const got117 = await next(ext.ev, (m) => m.method === 'tool.secret.fill' && m.params?.enforce === 'off');
ok('secret.fill: params.enforce overrides config (priority params > config > default)', got117?.params?.__ubb_secret_binding?.mode === 'off');
ext.ws.send(JSON.stringify({ id: got116.id, result: { filled: '@e7' } }));
ext.ws.send(JSON.stringify({ id: got117.id, result: { filled: '@e7' } }));
S.setSecretOriginMode('off');

// 6.5 existing agent routing / events / broadcast still intact (regression)
sendA({ id: 109, method: 'tool.tab.create', params: { url: 'example.com' } });
const got109 = await next(ext.ev, (m) => m.method === 'tool.tab.create');
ok('plain tool call unaffected by the secret branch', got109?.id && got109.params.url === 'example.com');
ext.ws.send(JSON.stringify({ method: 'event.tab.navigated', params: { tab_id: 1 } }));
ok('extension events still broadcast to every agent', !!(await next(agentB.ev, (m) => m.method === 'event.tab.navigated')));
sendA({ id: 110, method: 'status' });
ok('status frame still works', (await next(agentA.ev, (m) => m.id === 110))?.result?.extension_connected === true);

// 6.6 daemon logs carry no plaintext, ever
await new Promise((r) => setTimeout(r, 200));
ok('daemon stderr (log) contains no value', !containsValue(daemonErr), daemonErr.split('\n').find((l) => containsValue(l)) || '');
ok('daemon stdout contains no value', !containsValue(daemonOut));
ok('vault file on disk is the only place a value lives', fs.readFileSync(VAULT, 'utf8').includes(FAKE));

try {
  agentB.ws.close();
  agentA.ws.close();
  ext.ws.close();
} catch {}
child.kill();

// ---------------------------------------------------------------- 7. empty-vault behaviour over RPC
console.log(`\n== 7. absent vault${RC} ==`);
{
  const emptyPath = path.join(VAULT_DIR, 'does-not-exist.json');
  process.env.UBB_SECRETS_FILE = emptyPath;
  ok('listNames on a missing vault → []', S.listNames().length === 0);
  ok('vaultInfo on a missing vault → count 0, no throw', S.vaultInfo().count === 0 && S.vaultInfo().updated_at === null);
  ok('resolveSecret on a missing vault → null', S.resolveSecret('github_pw') === null);
  process.env.UBB_SECRETS_FILE = VAULT;
}

// ---------------------------------------------------------------- 8. record shapes + origin config
console.log(`\n== 8. vault record shapes + origin mode config${RC} ==`);
{
  fs.writeFileSync(VAULT, JSON.stringify({ legacy_pw: FAKE4, bound_pw: { value: FAKE2, origins: ['github.com'] }, junk: 42 }), null, 2);
  ok('bare-string record resolves (backward compat, no binding)', S.resolveSecret('legacy_pw') === FAKE4 && S.secretRecord('legacy_pw').origins.length === 0);
  ok('object record resolves through the same door', S.resolveSecret('bound_pw') === FAKE2 && S.secretRecord('bound_pw').origins.join() === 'github.com');
  ok('malformed record shape is unresolvable without crashing (and leaks nothing)', S.resolveSecret('junk') === null && !containsValue(S.listRecords()));
  ok('listRecords reports names+bindings only, never values', S.listRecords().every((r) => !('value' in r)) && !containsValue(S.listRecords()));

  S.setSecret('bound_pw', FAKE2);
  ok('re-set without origins KEEPS the binding (rotating a password must not unbind it)', S.secretRecord('bound_pw').origins.join() === 'github.com');
  const r1 = S.setSecret('newbound_pw', FAKE2, ['https://GitHub.com:443/login', 'login.microsoftonline.com']);
  ok('setSecret origins normalize (scheme/port/path stripped, deduped)', r1.origins.join(',') === 'github.com,login.microsoftonline.com');
  ok('bound record persists in the object shape', JSON.parse(fs.readFileSync(VAULT, 'utf8')).newbound_pw.origins.includes('github.com'));
  ok('bindSecret replaces the list', S.bindSecret('newbound_pw', ['example.com']).origins.join() === 'example.com');
  ok('bindSecret with no hosts clears back to the bare-string shape', S.bindSecret('newbound_pw', []).origins.length === 0 && typeof JSON.parse(fs.readFileSync(VAULT, 'utf8')).newbound_pw === 'string');
  let bcode = null;
  try { S.bindSecret('absent_name_xyz', ['a.test']); } catch (e) { bcode = e.code; }
  ok('bind on an unknown name → SECRET_UNKNOWN (no value echo)', bcode === 'SECRET_UNKNOWN');

  // single-label hosts must bind (2B §2d: the old dot requirement made strict
  // mode unusable on every localhost dev page); junk shapes must still be refused.
  for (const bad of ['not a host', 'under_score.test', 'a..b.test', '']) {
    let code = null;
    try {
      S.normalizeOriginHost(bad);
    } catch (e) {
      code = e.code;
    }
    ok(`origin host rejected: ${JSON.stringify(bad).slice(0, 24)}`, code === 'BAD_ORIGIN_HOST', `got ${code}`);
  }
  ok('origin host ACCEPTS the bare single-label localhost (2B §2d incident command)', S.normalizeOriginHost('localhost') === 'localhost');
  ok('origin host: localhost normalizes out of a full dev URL with port', S.normalizeOriginHost('http://LOCALHOST:8102/widgets.html') === 'localhost');
  ok('origin host: bare IP and dotted hosts keep working (no over-correction)', S.normalizeOriginHost('127.0.0.1') === '127.0.0.1' && S.normalizeOriginHost('login.microsoftonline.com') === 'login.microsoftonline.com');
  ok('normalizeOriginHost accepts https/host:port forms', S.normalizeOriginHost('https://GitHub.com:443/x') === 'github.com');
  ok('match: exact host', S.originMatches('github.com', 'github.com') === true);
  ok('match: subdomain counts as the bound host', S.originMatches('www.github.com', 'github.com') === true);
  ok('match: github.com.evil.test suffix trap REFUSED', S.originMatches('github.com.evil.test', 'github.com') === false);
  ok('match: evilgithub.com prefix trap REFUSED', S.originMatches('evilgithub.com', 'github.com') === false);
  ok('match: localhost binding matches a localhost tab (strict recovery path)', S.originMatches('localhost', 'localhost') === true);
  ok('match: xlocalhost.test does NOT match a localhost binding (single-label prefix trap)', S.originMatches('xlocalhost.test', 'localhost') === false);
  ok('match: empty host or empty binding never matches', S.originMatches('', 'github.com') === false && S.originMatches('github.com', '') === false);
  ok('match: case-insensitive', S.originMatches('GITHUB.COM', 'github.com') === true);

  ok('default origin mode is off when no config file exists', S.getSecretOriginMode() === 'off');
  fs.writeFileSync(CONFIG, JSON.stringify({ token: 'keepme-TEST-ONLY', port: 8765 }));
  S.setSecretOriginMode('strict');
  const cfgAfter = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  ok('storage layer: setSecretOriginMode("strict") writes config (NOT the CLI parse path — see the CLI block below)',
    cfgAfter.secret_origin_mode === 'strict' && S.getSecretOriginMode() === 'strict');
  ok('mode write preserves unrelated config keys (the token file is shared!)', cfgAfter.token === 'keepme-TEST-ONLY' && cfgAfter.port === 8765);
  let mcode = null;
  try { S.setSecretOriginMode('loose'); } catch (e) { mcode = e.code; }
  ok('invalid mode rejected with BAD_SECRET_MODE', mcode === 'BAD_SECRET_MODE');
  S.setSecretOriginMode('off');
  ok('back to off', S.getSecretOriginMode() === 'off');

  // ---- the REAL argv path (`node daemon/ubb.mjs secret …`) ----
  // the assertions above call setSecretOriginMode() directly, which is exactly
  // why live-verify §9's bug survived: `ubb secret mode strict` printed the
  // CURRENT mode and wrote nothing, because the shared
  // `[sub, name, ...rest]` parse ate the value into the secret-name slot.
  const UBB = path.resolve(HERE, 'ubb.mjs');
  const cfgMode = () => {
    try {
      return JSON.parse(fs.readFileSync(CONFIG, 'utf8')).secret_origin_mode;
    } catch {
      return '(no config)';
    }
  };
  const cli = (args) => spawnSync(process.execPath, [UBB, 'secret', ...args], {
    encoding: 'utf8',
    cwd: HERE,
    env: { ...process.env, UBB_SECRETS_FILE: VAULT, UBB_CONFIG_FILE: CONFIG, HOME: VAULT_DIR, USERPROFILE: VAULT_DIR },
    windowsHide: true,
  });
  const one = cli(['mode', 'strict']);
  ok('CLI: `ubb secret mode strict` — ONE arg sets strict (the value must not be parsed as a secret name)',
    one.status === 0 && /secret_origin_mode: strict \(written to/.test(one.stdout) && cfgMode() === 'strict',
    JSON.stringify({ code: one.status, out: one.stdout.trim(), err: one.stderr.trim(), cfg: cfgMode() }));
  const query = cli(['mode']);
  ok('CLI: `ubb secret mode` with no value still QUERIES and writes nothing',
    query.status === 0 && /secret_origin_mode: strict/.test(query.stdout) && /strict: a secret may only be typed/.test(query.stdout) && cfgMode() === 'strict',
    JSON.stringify({ code: query.status, out: query.stdout.trim(), cfg: cfgMode() }));
  const off = cli(['mode', 'off']);
  ok('CLI: `ubb secret mode off` round-trips the other value through the same single-arg path',
    off.status === 0 && cfgMode() === 'off', JSON.stringify({ code: off.status, out: off.stdout.trim(), cfg: cfgMode() }));
  ok('CLI: the mode write still preserves the token key (never clobbers ~/.ubb/config.json)',
    (() => { const c = JSON.parse(fs.readFileSync(CONFIG, 'utf8')); return c.token === 'keepme-TEST-ONLY' && c.port === 8765; })(),
    fs.readFileSync(CONFIG, 'utf8').replace(/"token": ".*"/, '"token": "…"'));
  const doubled = cli(['mode', 'strict', 'strict']);
  ok('CLI: the old two-arg workaround now FAILS LOUDLY instead of silently setting (forked tongue)',
    doubled.status === 1 && /at most one value/.test(doubled.stderr) && cfgMode() === 'off',
    JSON.stringify({ code: doubled.status, out: doubled.stdout.trim(), err: doubled.stderr.trim(), cfg: cfgMode() }));
  const badMode = cli(['mode', 'loose']);
  ok('CLI: `ubb secret mode loose` exits 1 naming the two legal values and leaves the config alone',
    badMode.status === 1 && /must be "off" or "strict"/.test(badMode.stderr) && cfgMode() === 'off',
    JSON.stringify({ code: badMode.status, err: badMode.stderr.trim(), cfg: cfgMode() }));
  // same-shape audit of the sibling subcommands (they read argv[1] as a NAME,
  // which is correct — but they used to swallow trailing junk silently)
  S.setSecret('cli_probe_pw', FAKE);
  const rmExtra = cli(['rm', 'cli_probe_pw', 'typo_second_name']);
  ok('CLI: `ubb secret rm <name> <junk>` is refused instead of deleting only the first name quietly',
    rmExtra.status === 1 && /exactly one name/.test(rmExtra.stderr) && S.resolveSecret('cli_probe_pw') === FAKE,
    JSON.stringify({ code: rmExtra.status, err: rmExtra.stderr.trim(), still: S.resolveSecret('cli_probe_pw') === FAKE }));
  const hasExtra = cli(['has', 'cli_probe_pw', 'junk']);
  ok('CLI: `ubb secret has <name> <junk>` refuses the junk instead of ignoring it',
    hasExtra.status === 1 && /exactly one name/.test(hasExtra.stderr),
    JSON.stringify({ code: hasExtra.status, err: hasExtra.stderr.trim() }));
  ok('CLI: `ubb secret has <name>` keeps its exit-code-only contract (0 present / 1 absent, no output)',
    cli(['has', 'cli_probe_pw']).status === 0 && cli(['has', 'cli_probe_pw']).stdout === ''
      && cli(['has', 'never_stored_pw']).status === 1 && cli(['has', 'never_stored_pw']).stdout === '');
  // the exact incident command from 2B §2d, through the REAL argv path
  const bindLocal = cli(['bind', 'cli_probe_pw', 'localhost']);
  ok('CLI: `ubb secret bind <name> localhost` writes the binding (2B §2d: it used to die as "not a bindable host")',
    bindLocal.status === 0 && /bound "cli_probe_pw" to: localhost/.test(bindLocal.stdout) && S.secretRecord('cli_probe_pw').origins.join() === 'localhost',
    JSON.stringify({ code: bindLocal.status, out: bindLocal.stdout.trim(), err: bindLocal.stderr.trim() }));
  const bindBack = cli(['bind', 'cli_probe_pw']);
  ok('CLI: clearing the binding still round-trips to the bare-string shape', bindBack.status === 0 && typeof JSON.parse(fs.readFileSync(VAULT, 'utf8')).cli_probe_pw === 'string');
  const rmReal = cli(['rm', 'cli_probe_pw']);
  ok('CLI: `ubb secret rm <name>` with exactly one name still deletes it (the guard did not over-tighten)',
    rmReal.status === 0 && /removed "cli_probe_pw"/.test(rmReal.stdout) && S.resolveSecret('cli_probe_pw') === null,
    JSON.stringify({ code: rmReal.status, out: rmReal.stdout.trim(), still: S.resolveSecret('cli_probe_pw') !== null }));
}

// ---------------------------------------------------------------- 9. wave2 forward rules
console.log(`\n== 9. forward scope: replay vars / replay.save restore / secret.fill stamp${RC} ==`);
{
  S.setSecret('bound_pw', FAKE2, ['github.com']);
  S.setSecret('free_pw', 'free-horse-TEST-ONLY');

  const rp = S.prepareForward('tool.replay', { tab_id: 4, name: 'x', trace: { events: [{ type: 'input', value: '{{secret:bound_pw}}', label: 'password-field' }] }, vars: { PW: '{{secret:bound_pw}}', Q: 'plain' } });
  ok('replay vars: vault value resolved (substitution IS scoped to vars values)', rp.params.vars.PW === FAKE2 && rp.params.vars.Q === 'plain' && rp.replaced === 1);
  ok('replay vars: resolved-step ledger maps varsKey→secret names (B hand-off)', rp.params.__ubb_secret_vars?.PW?.join() === 'bound_pw' && !('Q' in (rp.params.__ubb_secret_vars ?? {})) && rp.params.__ubb_secret_fill === true);
  ok('replay: trace.events placeholder survives (no plaintext into script-shaped fields)', rp.params.trace.events[0].value === '{{secret:bound_pw}}' && !containsValue(rp.params.trace));
  ok('replay: label/name structural fields untouched', rp.params.trace.events[0].label === 'password-field' && rp.params.name === 'x');

  const rr = S.prepareForward('replay.run', { name: 'demo', vars: { PW: '{{secret:bound_pw}}' } });
  ok('replay.run joins the whitelist with the same vars scope', rr.params.vars.PW === FAKE2 && rr.replaced === 1);

  // 2B §3c asked whether replay has a `type`-shaped (no-node) consumer of vars:
  // it has none — trace steps keep their {{var.*}} templates verbatim, only
  // vars VALUES resolve, and on the extension applyVars runs solely on
  // fill/select values, every one of which must match a node before typing.
  const kp = S.prepareForward('replay', { tab_id: 4, vars: { PW: '{{secret:bound_pw}}' }, trace: { events: [{ type: 'keypress', key: '{{var.PW}}' }, { type: 'input', value: '{{var.PW}}' }] } });
  ok('replay: no nodeless step can receive a vault value — forwarded trace steps stay literal templates, only vars.PW holds the plaintext', kp.params.trace.events[0].key === '{{var.PW}}' && kp.params.trace.events[1].value === '{{var.PW}}' && kp.params.vars.PW === FAKE2 && !containsValue(kp.params.trace), JSON.stringify(kp.params.trace));

  const forg = S.prepareForward('replay', { vars: { PW: 'literal-from-agent' }, __ubb_secret_fill: true, __ubb_secret_vars: { PW: ['bound_pw'] } });
  ok('forged replay markers stripped daemon-side (an agent cannot self-release password steps)', forg.params.__ubb_secret_fill === undefined && forg.params.__ubb_secret_vars === undefined && forg.params.vars.PW === 'literal-from-agent');
  const forgFill = S.prepareForward('fill', { value: 'plain', __ubb_secret_fill: true });
  ok('forged __ubb_secret_fill stripped from fill too (wave2-fill honors it, so the daemon must own it)', forgFill.params.__ubb_secret_fill === undefined);

  const missR = S.prepareForward('replay', { vars: { PW: '{{secret:not_stored_xyz}}' } });
  ok('replay: unknown name → missing list + params untouched (bridge refuses forward: SECRET_UNKNOWN)', missR.missing.join() === 'not_stored_xyz' && missR.params.vars.PW === '{{secret:not_stored_xyz}}' && !containsValue(missR.params));

  const sv = S.prepareForward('replay.save', { name: 'demo', events: [{ type: 'input', value: FAKE2 }, { type: 'click', target: { label: 'ok' } }] });
  ok('replay.save: vault plaintext restored to its placeholder before forwarding', sv.params.events[0].value === '{{secret:bound_pw}}' && (sv.secrets_restored || []).includes('bound_pw'));
  ok('replay.save: forwarded params hold NO plaintext (storage.session stays credential-free)', !containsValue(sv.params));
  ok('replay.save: unrelated strings untouched', sv.params.events[1].target.label === 'ok' && sv.params.name === 'demo');

  fs.rmSync(CONFIG, { force: true });
  const st1 = S.prepareForward('tool.secret.fill', { ref: '@e7', secret: 'bound_pw' });
  ok('secret.fill: stamped mode off (no config file = default)', st1.params.__ubb_secret_binding.mode === 'off');
  ok('secret.fill: stamped with the REAL origin bindings of the record', st1.params.__ubb_secret_binding.origins.join() === 'github.com');
  const st2 = S.prepareForward('secret.fill', { secret: 'free_pw' });
  ok('secret.fill: unbound secret stamps empty origins', st2.params.__ubb_secret_binding.origins.length === 0);
  const st3 = S.prepareForward('secret.fill', { secret: 'free_pw', enforce: 'strict' });
  ok('secret.fill: params.enforce beats the default', st3.params.__ubb_secret_binding.mode === 'strict');
  fs.writeFileSync(CONFIG, JSON.stringify({ secret_origin_mode: 'strict' }));
  const st4 = S.prepareForward('secret.fill', { secret: 'free_pw' });
  ok('secret.fill: config strict applies when params are silent', st4.params.__ubb_secret_binding.mode === 'strict');
  const st5 = S.prepareForward('secret.fill', { secret: 'free_pw', enforce: 'off' });
  ok('secret.fill: params.enforce="off" overrides config strict (spec priority params > config; the escape hatch is audited, see report)', st5.params.__ubb_secret_binding.mode === 'off');
  const st6 = S.prepareForward('secret.fill', { secret: 'bound_pw', __ubb_secret_binding: { mode: 'off', origins: [] } });
  ok('forged binding stamp is overwritten by vault truth', st6.params.__ubb_secret_binding.origins.join() === 'github.com');
  S.setSecretOriginMode('off');
}

// ---------------------------------------------------------------- 10. extension-side enforcement
console.log(`\n== 10. secret.fill origin enforcement (extension module)${RC} ==`);
{
  const { register: registerSecretsRC } = await import(SECRETS_EXT);
  const mini = new Map();
  registerSecretsRC({ register: (n, m, f) => mini.set(n, f) });
  const fillTool = mini.get('secret.fill');
  ok('the extension module registered secret.fill (copy under test)', typeof fillTool === 'function');

  await sessions.start({});
  sessions.session.created.add(1);
  fakeSession.nodeIndex = new Map([[55, 7]]);
  fakeSession.nodeIndexGen = fakeSession.gen;
  const ref = refs.put(1, 55, { role: 'textbox', name: 'pw' });
  const link = new AgentLink(async () => ({ port: PORT, token: TOKEN, enabled: false }));
  const frames = [];
  link.ws = { readyState: 1, send: (t) => frames.push(JSON.parse(t)) };

  S.bindSecret('bound_pw', ['github.com']); // value FAKE2
  const PW_ATTRS = { type: 'password', name: 'pw' };
  let timeline = [];
  let tabUrl = 'https://github.com/login';
  chromeStub.tabs.get = async (id) => ({ id, url: tabUrl });
  const origSend = chromeStub.tabs.sendMessage;
  chromeStub.tabs.sendMessage = async (_t, payload) => {
    if (payload?.type === 'UBB_HELP') timeline.push('shield-help');
    return origSend(_t, payload);
  };

  async function attempt(attrs, { binding = null, extra = {}, url = 'https://github.com/login' } = {}) {
    tabUrl = url;
    frames.length = 0;
    timeline = [];
    chromeStub.debugger.sendCommand = async (_t, method, params) => {
      timeline.push(`cdp:${method}`);
      if (method === 'DOM.getAttributes') {
        const flat = [];
        for (const [k, v] of Object.entries(attrs)) flat.push(k, String(v));
        return { attributes: flat };
      }
      if (method === 'DOM.getBoxModel') return { model: { content: [10, 10, 110, 10, 110, 30, 10, 30] } };
      return {};
    };
    const p = fillTool({ ref, secret: 'bound_pw', tab_id: 1, ...(binding ? { __ubb_secret_binding: binding } : {}), ...extra });
    p.catch(() => {});
    await new Promise((r) => setTimeout(r, 5));
    const asked = frames.find((f) => f.method === 'secret.resolve');
    return { p, asked };
  }
  const settle = async (t, value) => {
    if (t.asked) link.consumePendingResponse({ id: t.asked.id, result: { value: value ?? FAKE2 } });
    return await t.p;
  };
  const failOf = async (t) => {
    try {
      const r = await t.p;
      return { code: null, res: r };
    } catch (e) {
      return { code: e?.code, message: e?.message || '' };
    }
  };
  const inserted = () => timeline.filter((x) => x === 'cdp:Input.insertText').length;
  const lastAudit = () => auditRing.list(30).find((e) => e.action === 'secret.fill' && e.vault_entry);
  const auditSlice = () => JSON.stringify(auditRing.list(30));

  // a) OFF mode: today's behavior stays (unbound/mismatched hosts are typeable) — but audited
  let t = await attempt(PW_ATTRS, { binding: { mode: 'off', origins: [] }, url: 'https://somesite.test/login' });
  let res = await settle(t);
  const entryOff = lastAudit();
  ok('off mode: unbound secret still fills (auto-login keeps working without confirm clicks)', res.filled === ref && inserted() === 1 && !!t.asked);
  ok('off mode: audit entry has vault_entry + origin + field_role + decision', entryOff.vault_entry === 'bound_pw' && entryOff.origin === 'somesite.test' && entryOff.field_role === 'password' && entryOff.decision === 'filled' && entryOff.mode === 'off' && entryOff.tab_id === 1, JSON.stringify(entryOff));
  ok('off mode: audit holds NO plaintext', !containsValue(auditSlice()), auditSlice().slice(0, 200));
  ok('audit keys survive redact() on the way out (no "secret"/"token"-shaped key → stats not blind)', redact(entryOff).vault_entry === 'bound_pw' && redact(entryOff).origin === 'somesite.test', JSON.stringify(redact(entryOff)));
  ok('a shield notice went out BEFORE the text was inserted', timeline.indexOf('shield-help') !== -1 && timeline.indexOf('shield-help') < timeline.indexOf('cdp:Input.insertText'), timeline.join(','));
  ok('the notice itself carries no plaintext', !containsValue(JSON.stringify(timeline)));

  // b) STRICT + unbound → denied without ever fetching the value
  t = await attempt(PW_ATTRS, { binding: { mode: 'strict', origins: [] } });
  let f = await failOf(t);
  ok('strict: unbound secret → SECRET_ORIGIN_DENIED', f.code === 'SECRET_ORIGIN_DENIED', String(f.code));
  ok('strict+unbound: the value was never even fetched, nothing typed, no notice', !t.asked && inserted() === 0 && timeline.indexOf('shield-help') === -1);
  ok('strict+unbound: denial audited (decision denied, reason unbound)', lastAudit().decision === 'denied' && lastAudit().reason === 'unbound' && lastAudit().origin === 'github.com', JSON.stringify(lastAudit()));
  ok('the denial message names the secret but holds no plaintext', /bound_pw/.test(f.message) && !containsValue(f.message), f.message);

  // c) STRICT + bound to ANOTHER host → denied (the phishing case)
  t = await attempt(PW_ATTRS, { binding: { mode: 'strict', origins: ['login.microsoftonline.com'] }, url: 'https://github.com/login' });
  f = await failOf(t);
  ok('strict: bound-but-mismatched → denied', f.code === 'SECRET_ORIGIN_DENIED' && !t.asked && inserted() === 0);
  ok('mismatch denial audited with reason origin_mismatch', lastAudit().reason === 'origin_mismatch' && lastAudit().decision === 'denied');

  // d) suffix trap: github.com.evil.test must NOT match a github.com binding
  t = await attempt(PW_ATTRS, { binding: { mode: 'strict', origins: ['github.com'] }, url: 'https://github.com.evil.test/fake' });
  f = await failOf(t);
  ok('strict: github.com.evil.test suffix trap is DENIED (not a subdomain)', f.code === 'SECRET_ORIGIN_DENIED' && inserted() === 0);

  // e) subdomain + exact host match and fill
  t = await attempt(PW_ATTRS, { binding: { mode: 'strict', origins: ['github.com'] }, url: 'https://www.github.com/login' });
  res = await settle(t);
  ok('strict: subdomain of the bound host fills', res.filled === ref && inserted() === 1 && lastAudit().mode === 'strict' && lastAudit().decision === 'filled' && lastAudit().origin === 'www.github.com');
  t = await attempt(PW_ATTRS, { binding: { mode: 'strict', origins: ['github.com'] }, url: 'https://github.com/' });
  res = await settle(t);
  ok('strict: exact bound host fills', res.filled === ref && inserted() === 1);

  // e2) the localhost path (2B §2d): single-label bindings must work here too —
  // the CLI used to refuse to ever create one
  t = await attempt(PW_ATTRS, { binding: { mode: 'strict', origins: ['localhost'] }, url: 'http://localhost:8102/widgets.html' });
  res = await settle(t);
  ok('strict: a localhost binding fills the localhost dev page', res.filled === ref && inserted() === 1 && lastAudit().decision === 'filled' && lastAudit().origin === 'localhost', JSON.stringify(lastAudit()));
  t = await attempt(PW_ATTRS, { binding: { mode: 'strict', origins: ['localhost'] }, url: 'https://xlocalhost.test/' });
  f = await failOf(t);
  ok('strict: xlocalhost.test does NOT match a localhost binding (single-label prefix trap stays shut)', f.code === 'SECRET_ORIGIN_DENIED' && inserted() === 0);

  // f) no stamped binding (stale daemon, direct call) → conservative default = off
  t = await attempt(PW_ATTRS, { url: 'https://anywhere.test/' });
  res = await settle(t);
  ok('missing daemon stamp defaults to mode off (today behavior), still audited', res.filled === ref && lastAudit().mode === 'off' && lastAudit().decision === 'filled');

  // g) malformed enforce
  t = await attempt(PW_ATTRS, { extra: { enforce: 'loose' } });
  f = await failOf(t);
  ok('enforce must be off|strict', f.code === 'BAD_PARAMS' && !t.asked, String(f.code));

  // h) the permanent classes beat everything: no mode, no binding, no enforce changes them
  for (const [label, attrs, binding] of [
    ['OTP (autocomplete=one-time-code) under strict+matching binding', { type: 'text', name: 'code', autocomplete: 'one-time-code' }, { mode: 'strict', origins: ['github.com'] }],
    ['OTP under off', { type: 'text', name: 'code', autocomplete: 'one-time-code' }, { mode: 'off', origins: [] }],
    ['name=验证码 under strict+mismatch', { type: 'text', name: '验证码' }, { mode: 'strict', origins: ['other.test'] }],
    ['cvv under off', { type: 'text', name: 'cvv' }, { mode: 'off', origins: [] }],
    ['card number under strict+matching', { type: 'text', name: 'card_number' }, { mode: 'strict', origins: ['github.com'] }],
    ['client_secret (name contains "secret") under strict+matching', { type: 'password', name: 'client_secret' }, { mode: 'strict', origins: ['github.com'] }],
    ['client_secret under off with allowPassword path', { type: 'password', name: 'client_secret' }, { mode: 'off', origins: [] }],
  ]) {
    t = await attempt(attrs, { binding, url: 'https://github.com/login' });
    f = await failOf(t);
    ok(`${label} → SENSITIVE_FIELD, never fetched`, f.code === 'SENSITIVE_FIELD' && !t.asked && inserted() === 0, String(f.code));
  }

  await sessions.stop({ close_created: false });
  sessions.session = null;
  chromeStub.tabs.sendMessage = origSend;
}

// ---------------------------------------------------------------- 11. wave5a placeholder-path ledger
console.log(`\n== 11. {{secret:NAME}} names ledger + strict pre-refusal (wave5a)${RC} ==`);
{
  S.setSecretOriginMode('off');
  const f1 = S.prepareForward('fill', { ref: '@e7', value: '{{secret:bound_pw}}' });
  ok('off: fill stamps __ubb_secret_names with the used names (names only)', Array.isArray(f1.params.__ubb_secret_names) && f1.params.__ubb_secret_names.join() === 'bound_pw');
  const gate1 = f1.params.__ubb_secret_gate;
  ok('off: fill stamps __ubb_secret_gate {mode,bindings} (daemon-authoritative, same trust as secret.fill)', gate1?.mode === 'off' && gate1.bindings?.[0]?.name === 'bound_pw' && gate1.bindings[0].origins.join() === 'github.com' && gate1.bindings[0].exists === true, JSON.stringify(gate1));
  ok('gate holds bindings, never values', !containsValue(gate1));
  ok('multi-placeholder fill lists every name once', S.prepareForward('fill_form', { values: { '@e7': '{{secret:bound_pw}}', '@e8': '{{secret:bound_pw}} {{secret:free_pw}}' } }).params.__ubb_secret_names.sort().join() === 'bound_pw,free_pw');

  const evL = S.prepareForward('evaluate', { expression: "'{{secret:bound_pw}}'" });
  ok('evaluate: no names ledger, no gate, no fill flag (whitelist stays a real gate)', evL.params.__ubb_secret_names === undefined && evL.params.__ubb_secret_gate === undefined && evL.params.__ubb_secret_fill === undefined && evL.params.expression.includes('{{secret:'));

  S.setSecretOriginMode('strict');
  const f2 = S.prepareForward('fill', { value: '{{secret:bound_pw}}' });
  ok('strict + bound: forwarded with gate mode strict + its real origins', f2.denied.length === 0 && f2.params.__ubb_secret_gate.mode === 'strict' && f2.params.__ubb_secret_gate.bindings[0].origins.join() === 'github.com');
  const f3 = S.prepareForward('fill', { value: '{{secret:free_pw}}' });
  ok('strict + UNBOUND: denied pre-forward (origin-independent), no stamp at all', f3.denied.join() === 'free_pw' && f3.params.__ubb_secret_fill === undefined && f3.params.__ubb_secret_names === undefined);
  const r3 = S.prepareForward('replay', { vars: { PW: '{{secret:free_pw}}' } });
  ok('strict + unbound replay vars: same pre-refusal', r3.denied.join() === 'free_pw' && r3.params.__ubb_secret_vars === undefined);
  const r4 = S.prepareForward('replay.run', { vars: { PW: '{{secret:bound_pw}}' } });
  ok('strict + bound replay: vars ledger AND names+gate both stamped', r4.params.__ubb_secret_vars?.PW?.join() === 'bound_pw' && r4.params.__ubb_secret_names?.join() === 'bound_pw' && r4.params.__ubb_secret_gate.mode === 'strict');
  S.setSecretOriginMode('off');

  const forgN = S.prepareForward('fill', { value: 'plain', __ubb_secret_fill: true, __ubb_secret_names: ['bound_pw'], __ubb_secret_gate: { mode: 'off', bindings: [{ name: 'bound_pw', exists: true, origins: [] }] } });
  ok('forged names/gate markers are stripped (agent cannot self-declare a vault fill)', forgN.params.__ubb_secret_fill === undefined && forgN.params.__ubb_secret_names === undefined && forgN.params.__ubb_secret_gate === undefined);
  ok('marker key list carries the new ledger keys', S.SECRET_MARKER_KEYS.includes('__ubb_secret_names') && S.SECRET_MARKER_KEYS.includes('__ubb_secret_gate'));

  const bt = S.prepareForward('batch', { actions: [{ tool: 'fill', params: { value: 'x', __ubb_secret_fill: true, __ubb_secret_names: ['a'] } }, { tool: 'click', params: { ref: '@e1' } }] });
  ok('batch step markers stripped daemon-side (batch re-dispatches INSIDE the extension — no later strip point)', bt.params.actions[0].params.__ubb_secret_fill === undefined && bt.params.actions[0].params.__ubb_secret_names === undefined && bt.params.actions[1].params.ref === '@e1');
  const pt = S.prepareForward('snapshot', { frames: true, __ubb_secret_binding: { mode: 'off', origins: [] } });
  ok('pass-through methods also lose forged top-level markers', pt.params.__ubb_secret_binding === undefined && pt.params.frames === true);

  const bnd = S.secretBindings(['bound_pw', 'free_pw', 'nope_xyz', '../evil']);
  ok('secret.bindings answers names+origins+exists, never values', bnd.mode === 'off' && bnd.bindings[0].origins.join() === 'github.com' && bnd.bindings[1].origins.length === 0 && bnd.bindings[2].exists === false && bnd.bindings[3].exists === false && !containsValue(bnd), JSON.stringify(bnd));
}

// the registry description must carry the pinned refusals (they must never get
// "fixed" away later without first failing this assertion)
{
  const m = (await collectRegistry()).metas['secret.fill'];
  ok('secret.fill description pins the permanent classes AND the name-contains-secret refusal AND the origin rules', /client_secret/.test(m.description) && /OTP/.test(m.description) && /SECRET_ORIGIN_DENIED|origin/i.test(m.description) && /audit/i.test(m.description), m.description.slice(0, 160));
}

// ---------------------------------------------------------------- 12. fix9: the pass gate on the credential path
console.log(`\n== 12. fix9 secret.fill 的逐派发闸门（闸门不过 ⇒ 线路零 Input、明文不留痕）${RC} ==`);
{
  const { register: registerSecretsGate } = await import(SECRETS_EXT);
  const mini = new Map();
  registerSecretsGate({ register: (n, m, f) => mini.set(n, f) });
  const fillTool = mini.get('secret.fill');

  await sessions.start({});
  sessions.session.created.add(1);
  fakeSession.nodeIndex = new Map([[55, 7]]);
  fakeSession.nodeIndexGen = fakeSession.gen;
  const ref = refs.put(1, 55, { role: 'textbox', name: 'pw' });
  const link = new AgentLink(async () => ({ port: PORT, token: TOKEN, enabled: false }));
  const frames = [];
  link.ws = { readyState: 1, send: (t) => frames.push(JSON.parse(t)) };

  const EXT = globalThis.chrome.runtime.id;
  const origDbg = globalThis.chrome.debugger.sendCommand;
  const origMsg = globalThis.chrome.tabs.sendMessage;
  const origScripting = globalThis.chrome.scripting;
  const origTabsGet = globalThis.chrome.tabs.get;
  globalThis.chrome.tabs.get = async (id) => ({ id, url: 'https://github.com/login' });

  // A page with ONE armed shield host in it: the same two proof channels the
  // real gate uses (chrome.scripting readback + the frame's own UBB_PASS reply),
  // with the two knobs this fix is about — WHEN the veil comes back, and whether
  // a live listener is answering for that document at all.
  const G = { opens: [], ackPass: true, hosts: 1, blockFromOpen: Infinity, noAnswer: false, slowMs: 0 };
  globalThis.chrome.scripting = {
    executeScript: async ({ target, args }) => {
      const [op, token, expire, at] = args;
      if (G.slowMs) await new Promise((r) => setTimeout(r, G.slowMs));
      // a document that is busy / whose world was torn down answers NOTHING for
      // the readback — the shape that used to collapse into "this channel does
      // not exist" and then into a ledger-based confirmation (LIVE-RESULTS-3A 8-1)
      if (G.noAnswer) return [{ frameId: target.frameIds[0], result: undefined }];
      if (op === 'open') G.opens.push(at || null);
      const n = G.opens.length;
      const shut = op === 'open' && n >= G.blockFromOpen;
      return [{
        frameId: target.frameIds[0],
        result: {
          hosts: G.hosts,
          ours: G.hosts,
          foreign: [],
          blocking: shut ? [{ owner: EXT, veil: 'auto' }] : [],
          hit: shut ? { tag: 'div', is_shield_host: true, owner: EXT } : null,
          open_tokens: shut ? 0 : 1,
        },
      }];
    },
  };
  globalThis.chrome.tabs.sendMessage = async (_t, payload) => {
    if (payload?.type === 'UBB_PASS') return { ok: true, pass: G.ackPass, state: { mode: 'armed', blockMode: 'block', pass: G.ackPass } };
    if (payload?.type === 'UBB_SHIELD_QUERY') return { ok: true, state: { mode: 'armed', blockMode: 'block', pass: G.ackPass } };
    return { ok: true };
  };

  let wire = [];
  const dbg = async (_t, method, params = {}) => {
    wire.push({ method, params });
    if (method === 'DOM.getAttributes') {
      const flat = [];
      for (const [k, v] of Object.entries({ type: 'password', name: 'pw' })) flat.push(k, String(v));
      return { attributes: flat };
    }
    if (method === 'DOM.getBoxModel') return { model: { content: [10, 10, 110, 10, 110, 30, 10, 30] } };
    if (method === 'DOM.resolveNode') return { object: { objectId: 'obj-7', type: 'object' } };
    if (method === 'Runtime.evaluate') return { result: { value: undefined } };
    return {};
  };

  async function attempt(over = {}) {
    Object.assign(G, { opens: [], ackPass: true, hosts: 1, blockFromOpen: Infinity, noAnswer: false, slowMs: 0 }, over);
    wire = [];
    frames.length = 0;
    globalThis.chrome.debugger.sendCommand = dbg;
    const p = fillTool({ ref, secret: 'bound_pw', tab_id: 1, press_enter: true, __ubb_secret_binding: { mode: 'off', origins: [] } });
    p.catch(() => {});
    await new Promise((r) => setTimeout(r, 5));
    const asked = frames.find((f) => f.method === 'secret.resolve');
    if (asked) link.consumePendingResponse({ id: asked.id, result: { value: FAKE2 } });
    let out = { code: null, res: null, message: '' };
    try {
      out.res = await p;
    } catch (e) {
      out.code = e?.code;
      out.message = e?.message || '';
    }
    return out;
  }
  const inputOnWire = () => wire.filter((c) => String(c.method).startsWith('Input.'));
  const auditSlice = () => JSON.stringify(auditRing.list(30));

  // a) the door is shut again at the dispatch point: the confirmation that opened
  //    the pass passed, the one taken immediately before Input.insertText did not
  let r = await attempt({ blockFromOpen: 2 });
  ok('派发点那一刻遮罩回弹 → SHIELD_PASS_FAILED（不是 {filled:…} 谎报）', r.code === 'SHIELD_PASS_FAILED', String(r.code));
  ok('拒绝即线路 0 条 Input.insertText / 0 条 dispatchKeyEvent（口令一个字符都没发）', inputOnWire().length === 0, JSON.stringify(inputOnWire().map((c) => c.method)));
  ok('失败路径的返回值里没有任何明文', r.res === null && !containsValue(JSON.stringify(r)), JSON.stringify(r).slice(0, 160));
  ok('失败路径的审计里没有任何明文', !containsValue(auditSlice()), auditSlice().slice(0, 200));
  ok('错误消息自带下一步且不泄露值', /下一步|停止代理|border\/off/.test(r.message) && !containsValue(r.message), r.message.slice(0, 120));
  ok('首确认与派发确认都问的是当刻那一点（withPass 必须带 at）', G.opens.length >= 2 && G.opens.every((at) => Array.isArray(at) && at[0] === 60 && at[1] === 20), JSON.stringify(G.opens));

  // b) the orphan-world rule: DOM readback says the veil is out of the way, but no
  //    live listener answers UBB_PASS for that document, so the capture-phase key
  //    listeners would eat every keystroke — only txn.keys=true checks this
  r = await attempt({ ackPass: false });
  ok('孤儿世界（host 在、没人应答 UBB_PASS）→ secret.fill 拒绝（keys:true 才查得到这一层）', r.code === 'SHIELD_PASS_FAILED', String(r.code));
  ok('这一条同样是 0 条 Input.* 上线（不是"发出但被吃掉"）', inputOnWire().length === 0, JSON.stringify(inputOnWire().map((c) => c.method)));
  ok('拒绝时线路与审计都没有明文的第二个副本', !containsValue(JSON.stringify(wire)) && !containsValue(auditSlice()), JSON.stringify(wire.map((c) => c.method)));

  // c) and the door really is open: the fill still lands (the gate is not a blanket no)
  r = await attempt({});
  ok('门开着时照常填：1 条 Input.insertText + Enter 的 keyDown/keyUp', inputOnWire().filter((c) => c.method === 'Input.insertText').length === 1 &&
    inputOnWire().filter((c) => c.method === 'Input.dispatchKeyEvent').length === 2 && r.res?.filled === ref, JSON.stringify(inputOnWire().map((c) => c.method)));
  ok('填成功时确认次数 ≥ 派发次数（逐派发，不是开局一次）', G.opens.length >= inputOnWire().length, `opens=${G.opens.length} inputs=${inputOnWire().length}`);
  ok('成功路径的返回值仍不含明文', !containsValue(JSON.stringify(r.res)), JSON.stringify(r.res));
  ok('成功路径的审计仍不含明文（只有 vault_entry + bytes）', !containsValue(auditSlice()), auditSlice().slice(0, 220));

  // d) the 3A 8-4 shape: the readback channel answers NOTHING at all (a busy or
  //    torn-down document costs the full 2.5s per round trip). The old gate read
  //    that as "no such channel" and fell back to the world's ledger boolean →
  //    ok:true with the veil never opened, or a whole TOOL_TIMEOUT burned on
  //    retries. It must now refuse, inside the tool's own 25s budget, in seconds.
  const t0 = Date.now();
  r = await attempt({ noAnswer: true, slowMs: 2500 });
  const burned = Date.now() - t0;
  ok('回读通道一次都不答 → 不是 ok:true、也不是白烧满 25s：红着拒绝（SHIELD_PASS_FAILED）', r.code === 'SHIELD_PASS_FAILED', JSON.stringify({ code: r.code, burned }));
  ok('红的那一次线路 0 条 Input.*（口令一个字符都没有上线）', inputOnWire().length === 0, JSON.stringify(inputOnWire().map((c) => c.method)));
  ok('超时这条不再成立：整次 secret.fill 在 12s 内返回（预算远小于 timeoutMs 25000）', burned < 12000, `${burned}ms`);
  ok('第二轮确认被自预算挡掉时，消息里说清为什么只付了一轮', /第二轮确认没再付/.test(r.message), r.message.slice(0, 140));
  ok('这条快速失败的路径上也没有任何明文', !containsValue(JSON.stringify(r)), JSON.stringify(r).slice(0, 120));

  // the shape itself, pinned against the module under test (RC copy included):
  // these two opts ARE the check, so losing them must be loud even when the
  // harness page happens to answer "clean" on every round
  const gateSrc = fs.readFileSync(fileURLToPath(SECRETS_EXT), 'utf8');
  const fillBody = (gateSrc.match(/'secret\.fill'[\s\S]*$/) || [''])[0];
  const checkAt = fillBody.indexOf('gate.check()');
  const insertAt = fillBody.indexOf("'Input.insertText'");
  ok('raw Input.insertText 之前有它自己的点位确认（它不经 mouse()/key()，没人替它确认）', checkAt !== -1 && insertAt !== -1 && checkAt < insertAt, JSON.stringify({ checkAt, insertAt }));
  ok('secret.fill 的 withPass 带 keys:true + at（缺一个就是 fix8 残留面 #4 的漏检形状）', /withPass\(tabId,[\s\S]{0,1600}?\}, \{[^}]*keys: true[^}]*\}\)/.test(fillBody) && /withPass\(tabId,[\s\S]{0,1600}?\}, \{[^}]*at: \[box\.cx, box\.cy\]/.test(fillBody), (fillBody.match(/\}, \{[^}]*\}\);/) || ['(no opts on withPass)'])[0]);

  globalThis.chrome.debugger.sendCommand = origDbg;
  globalThis.chrome.tabs.sendMessage = origMsg;
  globalThis.chrome.scripting = origScripting;
  globalThis.chrome.tabs.get = origTabsGet;
  await sessions.stop({ close_created: false });
  sessions.session = null;
}

fs.rmSync(VAULT_DIR, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
