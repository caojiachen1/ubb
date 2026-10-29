// Wave 1-B offline tests for lib/tools-replay.js — no browser, no daemon
// (contract §6.4): pure-function + registry checks only.
// Wave2-secrets extends it (§14): vault-backed vars, using throwaway fake
// credentials + UBB_SECRETS_FILE pointed at the OS temp dir — never the
// user's real ~/.ubb/secrets.json.
//   node daemon/test-replay.mjs
//
// The fixtures below are copied VERBATIM from the trace shapes content/bridge.js
// actually produces (recordTarget() → {selector,text,role,label}; record_start
// seeds {type:"start"}; click carries snapshotId+position; input masks passwords
// as "***"; scroll carries delta = absolute scrollX/scrollY; record_stop wraps
// events+snapshots). If bridge.js changes, this file must change with it.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { installChromeStub, collectRegistry, makeCdpGate } from '../lib/testharness.mjs';
installChromeStub();

// §14 reverse control: point the vault module at a deliberately broken copy that lives
// OUTSIDE the repo (contract §0: a `daemon/_rc-*.tmp.mjs` puts an underscore-prefixed entry in
// the extension root and Chrome/Edge then refuse to LOAD THE EXTENSION; here and below
// $RC = D:/Codebase/ubb-scratch/rc/<agent-name>/).
//   cp daemon/cli/secret.mjs $RC/rc-fwd/secret.mjs   ('replay' removed from SECRET_VARS_METHODS;
//   this file has no relative imports, so a plain copy is enough)
//   node daemon/test-replay.mjs --secret $RC/rc-fwd/secret.mjs   → [14] B/E/F turn red
// fix9 ② reverse control (contract §0: the clone lives OUTSIDE the repo, and its
// relative imports are rewritten to file:/// URLs so it shares the ONE copy of
// actions/tabs/audit the suite already loaded):
//   node -e '…read lib/tools-replay.js, replace from "./ → from "file:///D:/Codebase/ubb/lib/,
//            drop ", { at: [box.cx, box.cy], frameId: meta?.frameId ?? 0 }" and ", { keys: true }"…'
//   node daemon/test-replay.mjs --replay D:/Codebase/ubb-scratch/rc/fix9/rc-2/tools-replay.js
//   → [15] 红 7 条：回放跑完 ok:true、5 条事件全上线，而 7 次确认问的点位全是 null
//     (= 只查顶层 veil，不查点位) + 孤儿世界的 keypress 检查整个被跳过
const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const optOf = (flagName) => {
  const i = argv.indexOf(flagName);
  return i >= 0 ? argv[i + 1] : null;
};

const {
  normalizeTrace, intentFor, matchIntent, parseSnapshotText, applyVars, varNames, replayTrace,
} = await import('../lib/tools-replay.js');

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
};
const codeOf = async (fn) => {
  try { await fn(); return '(did not throw)'; }
  catch (e) { return e?.code ?? `plain throw: ${e?.message || e}`; }
};

// ---------------------------------------------------------------- fixtures

const EVENTS = [
  { type: 'start', timestamp: 0, url: 'https://example.com/list' },
  {
    type: 'click', timestamp: 1200, snapshotId: 'snap_1200',
    target: { selector: 'input#q.search-input', text: '', role: 'input', label: '搜索关键词' },
    position: { x: 210, y: 96 },
  },
  {
    type: 'input', timestamp: 1900,
    target: { selector: 'input#q.search-input', text: '', role: 'input', label: '搜索关键词' },
    value: '{{var.QUERY}}',
  },
  { type: 'keypress', timestamp: 2100, key: 'Enter' },
  {
    type: 'input', timestamp: 2400,
    target: { selector: 'input#pw', text: '', role: 'input', label: 'password' },
    value: '***',
  },
  {
    type: 'select', timestamp: 2600,
    target: { selector: 'select#sort', text: '默认 价格', role: 'select', label: '排序' },
    value: 'price',
  },
  { type: 'scroll', timestamp: 3000, target: { selector: 'document' }, delta: { x: 0, y: 820 } },
  {
    type: 'drag', timestamp: 3300, snapshotId: null,
    target: { selector: 'div.card', text: '卡片', role: 'div', label: '' },
    dropTarget: { selector: 'div.trash', text: '回收站', role: 'div', label: '' },
    from: { x: 100, y: 200 }, to: { x: 400, y: 500 },
  },
  {
    type: 'click', timestamp: 3600, snapshotId: 'snap_3600',
    target: { selector: 'button.danger', text: '删除账号', role: 'button', label: '' },
    position: { x: 50, y: 60 },
  },
  { type: 'navigation', timestamp: 3900, url: 'https://example.com/list?q=ubb', snapshotId: 'snap_3900', note: 'detected by URL poll' },
];

const TRACE = {
  id: 'rec_1764000000000_ab12cd',
  description: 'search, then delete',
  started_at: '2026-10-28T02:00:00.000Z',
  duration_ms: 3900,
  start_url: 'https://example.com/list',
  final_url: 'https://example.com/list?q=ubb',
  events: EVENTS,
  snapshots: [{ snapshotId: 'snap_1200', timestamp: 1200, url: 'https://example.com/list', content: '# 列表\n  input label=搜索关键词\n  button "删除账号"' }],
  event_count: EVENTS.length,
  snapshot_count: 1,
  complete: true,
  note: 'trace is data, not authorization; replay uses semantic targets in order',
};

// the live page the recorded targets get re-found on: snapshot-shaped candidates
// (role is an AX role, name comes from aria-label/textContent)
const PAGE = [
  { ref: '@e1', role: 'textbox', name: '搜索关键词' },
  { ref: '@e2', role: 'button', name: '搜索' },
  { ref: '@e3', role: 'combobox', name: '排序' },
  { ref: '@e4', role: 'button', name: '删除账号' },
];

const SECRET = 'sup3r-s3cret-query-value';
const PASSWORD_EVENTS = normalizeTrace(TRACE);
const probe = { candidates: async () => PAGE, selectorVisible: async () => false };
const recorder = () => {
  const calls = [];
  return { calls, perform: async (step) => { calls.push(step.action); } };
};
const planOf = (events = PASSWORD_EVENTS, over = {}) =>
  replayTrace(events, { probe, perform: async () => {}, dryRun: true, vars: { QUERY: SECRET }, ...over });

// ------------------------------------------------------------------ input shapes

console.log('\n[1] trace input shapes');
ok('record_stop object accepted', normalizeTrace(TRACE).length === EVENTS.length);
ok('events array accepted', normalizeTrace(EVENTS).length === EVENTS.length);
const VARSED = [{ type: 'input', timestamp: 1, target: { selector: 'input#a', role: 'input', label: 'q' }, value: 'hello {{var.NAME}}' }];
ok('array with {{var.NAME}} placeholders accepted', normalizeTrace(VARSED).length === 1);
ok('JSON text of the trace object accepted', normalizeTrace(JSON.stringify(TRACE)).length === EVENTS.length);
ok('garbage rejected with TRACE_FORMAT', (await codeOf(async () => normalizeTrace({ nope: 1 }))) === 'TRACE_FORMAT');
ok('events without a type rejected with TRACE_EMPTY', (await codeOf(async () => normalizeTrace([{ value: 1 }]))) === 'TRACE_EMPTY');

// ------------------------------------------------------------------- dry run plan

console.log('\n[2] dry_run plan (side-effect free)');
const dry = recorder();
const p1 = await replayTrace(PASSWORD_EVENTS, { probe, perform: dry.perform, dryRun: true, vars: { QUERY: SECRET } });
ok('dry_run performed nothing', dry.calls.length === 0, `perform ran ${dry.calls.length}×: ${dry.calls.join(',')}`);
ok('dry_run reports executed=0', p1.executed === 0, String(p1.executed));
ok('step 1 is a click re-matched to @e1', p1.steps[1].action === 'click' && p1.steps[1].matched_ref === '@e1', JSON.stringify(p1.steps[1]));
ok('step 1 intent carries the recorded match key', p1.steps[1].intent.role === 'textbox' && p1.steps[1].intent.name === '搜索关键词', JSON.stringify(p1.steps[1].intent));
ok('step 1 score clears the accept threshold', p1.steps[1].score >= 3, String(p1.steps[1].score));
ok('step 2 is a fill on the same target', p1.steps[2].action === 'fill' && p1.steps[2].matched_ref === '@e1', JSON.stringify(p1.steps[2]));
ok('step 2 keeps the template and reports the substituted length', p1.steps[2].value_template === '{{var.QUERY}}' && p1.steps[2].value_chars === SECRET.length, JSON.stringify(p1.steps[2]));
ok('step 3 is keypress Enter', p1.steps[3].action === 'keypress' && p1.steps[3].status === 'planned', JSON.stringify(p1.steps[3]));
ok('step 5 is select_option on @e3', p1.steps[5].action === 'select_option' && p1.steps[5].matched_ref === '@e3', JSON.stringify(p1.steps[5]));
ok('step 6 is a scroll (no target needed)', p1.steps[6].action === 'scroll' && !p1.steps[6].matched_ref, JSON.stringify(p1.steps[6]));
ok('step 9 is a navigate with a redacted url', p1.steps[9].action === 'navigate' && p1.steps[9].url === 'https://example.com/list?q=ubb', JSON.stringify(p1.steps[9]));
ok('plan lists exactly the blocked steps', p1.failed_steps.map((f) => f.step).join(',') === '4,8', JSON.stringify(p1.failed_steps));
ok('dry_run reports ok=false when a step is blocked', p1.ok === false);

// ---------------------------------------------------------------- drag / markers

console.log('\n[3] drag + start marker are skipped, never executed');
const dragStep = p1.steps[7];
ok('drag step is status=skipped with a reason', dragStep.status === 'skipped' && /drag/i.test(dragStep.detail || ''), JSON.stringify(dragStep));
ok('drag never becomes an action', dragStep.action === 'skip');
ok('start marker skipped', p1.steps[0].status === 'skipped');
ok('skipped counter covers start+drag+none else', p1.skipped === 2, String(p1.skipped));
ok('intentFor maps drag to skip', intentFor(EVENTS[7]).kind === 'skip');

// ------------------------------------------------------------------- vars safety

console.log('\n[4] vars substitution never leaks a value');
const dump = JSON.stringify(p1);
ok('no vars value anywhere in the result', !dump.includes(SECRET), dump.slice(0, 300));
ok('result names the vars it used', p1.vars.join(',') === 'QUERY', JSON.stringify(p1.vars));
ok('resolved_value is stripped from every step', p1.steps.every((s) => !('resolved_value' in s)));
const unused = await planOf(PASSWORD_EVENTS, { vars: { QUERY: SECRET, UNUSED: 'zzz-not-a-value' } });
ok('an unused var is not echoed either', !JSON.stringify(unused).includes('zzz-not-a-value'));
ok('applyVars fills only known names', applyVars('a{{var.X}}b', { X: 'Q' }).text === 'aQb');
ok('applyVars reports the missing NAME only', applyVars('{{var.X}}{{var.Y}}', { X: 'q' }).missing.join() === 'Y');
ok('varNames reads {{var.N}} and {{var:N}} alike', varNames('{{var.A}} {{var:B}}').join(',') === 'A,B');

// ------------------------------------------------------------------ *** refusal

console.log('\n[5] masked "***" values are refused hard');
ok('dry_run blocks the *** step with SENSITIVE_FIELD', p1.steps[4].error === 'SENSITIVE_FIELD', JSON.stringify(p1.steps[4]));
ok('the refusal points at vars or the user', /vars/.test(p1.steps[4].detail) && /user/.test(p1.steps[4].detail), p1.steps[4].detail);
ok('no bypass: a real run still stops on the *** step', (await codeOf(async () => {
  await replayTrace(PASSWORD_EVENTS, { probe, perform: async () => {}, vars: { QUERY: SECRET, PW: 'x' } });
})) === 'SENSITIVE_FIELD');
const run5 = recorder();
await codeOf(async () => replayTrace(PASSWORD_EVENTS, { probe, perform: run5.perform, vars: { QUERY: SECRET } }));
ok('steps before the refusal really ran', run5.calls.join(',') === 'click,fill,keypress', run5.calls.join(','));

// -------------------------------------------------------- plaintext / secret gates

console.log('\n[6] password-like fields: plaintext refused, vars allowed, OTP never');
const pwProbe = { candidates: async () => [{ ref: '@e9', role: 'textbox', name: 'password' }], selectorVisible: async () => false };
const pwEvent = (value) => [{ type: 'input', timestamp: 1, target: { selector: 'input#pw', role: 'input', label: 'password' }, value }];
const plainPw = await planOf(pwEvent('hunter2'), { probe: pwProbe, vars: {} });
ok('password-labelled field with a literal value → SENSITIVE_FIELD', plainPw.steps[0].error === 'SENSITIVE_FIELD', JSON.stringify(plainPw.steps[0]));
const viaVars = await planOf(pwEvent('{{var:PW}}'), { probe: pwProbe, vars: { PW: 'sentinel-pw-from-daemon' } });
ok('the same field is planned once the value arrives resolved through vars', viaVars.steps[0].status === 'planned' && !viaVars.steps[0].error, JSON.stringify(viaVars.steps[0]));
ok('the resolved value is not echoed back', !JSON.stringify(viaVars).includes('sentinel-pw-from-daemon'), JSON.stringify(viaVars.steps[0]));
const leftover = await planOf(pwEvent('{{var:PW}}'), { probe: pwProbe, vars: { PW: '{{secret:github_pw}}' } });
ok('an unreplaced {{secret:...}} blocks fail-closed with SECRET_UNRESOLVED', leftover.steps[0].error === 'SECRET_UNRESOLVED', JSON.stringify(leftover.steps[0]));
ok('the unresolved placeholder is not echoed either', !JSON.stringify(leftover).includes('github_pw'), JSON.stringify(leftover.steps[0]));
ok('a real run with an unresolved secret throws SECRET_UNRESOLVED', (await codeOf(async () => {
  await replayTrace(pwEvent('{{var:PW}}'), { probe: pwProbe, perform: async () => {}, vars: { PW: '{{secret:github_pw}}' } });
})) === 'SECRET_UNRESOLVED');
const otp = await planOf([{ type: 'input', timestamp: 1, target: { selector: 'input#otp', role: 'input', label: '短信验证码' }, value: '{{var:CODE}}' }], {
  probe: { candidates: async () => [{ ref: '@e8', role: 'textbox', name: '短信验证码' }], selectorVisible: async () => false },
  vars: { CODE: '123456' },
});
ok('OTP / 验证码 fields are refused even from vars', otp.steps[0].error === 'SENSITIVE_FIELD', JSON.stringify(otp.steps[0]));

// ----------------------------------------------------------------- confirm gate

console.log('\n[7] dangerous label needs whole-run confirm');
const NO_MASKED = PASSWORD_EVENTS.filter((_, i) => i !== 4);
const noConfirm = await codeOf(async () => {
  await replayTrace(NO_MASKED, { probe, perform: async () => {}, vars: { QUERY: SECRET } });
});
ok('危险标签 without confirm throws NEEDS_CONFIRM', noConfirm === 'NEEDS_CONFIRM', String(noConfirm));
const yes = recorder();
const okRun = await replayTrace(NO_MASKED, { probe, perform: yes.perform, vars: { QUERY: SECRET }, confirm: true });
ok('confirm:true lets the run finish', okRun.ok === true && okRun.executed === NO_MASKED.length - 2, `${okRun.ok} / executed=${okRun.executed} calls=${yes.calls.join(',')}`);
const flagged = okRun.steps.find((s) => s.needs_confirm);
ok('the dangerous step is flagged needs_confirm even when confirmed', flagged && flagged.matched_ref === '@e4', JSON.stringify(flagged));
const lenient = await replayTrace(PASSWORD_EVENTS, { probe, perform: async () => {}, vars: { QUERY: SECRET }, stopOnError: false });
ok('stop_on_error:false runs the rest and reports both blocks', lenient.executed === 6 && lenient.blocked === 2, `executed=${lenient.executed} blocked=${lenient.blocked}`);

// ------------------------------------------------------------------- step caps

console.log('\n[8] step caps and offsets');
const BIG = Array.from({ length: 501 }, () => EVENTS[1]);
ok('501 steps rejected with TOO_MANY_STEPS', (await codeOf(async () => planOf(BIG))) === 'TOO_MANY_STEPS');
const chunked = await planOf(PASSWORD_EVENTS, { startAt: 1, maxSteps: 3 });
ok('start_at + max_steps slice the plan', chunked.steps.length === 3 && chunked.steps[0].step === 1 && chunked.steps[2].step === 3, JSON.stringify(chunked.steps.map((s) => s.step)));
ok('max_steps above the cap rejected', (await codeOf(async () => planOf(PASSWORD_EVENTS, { maxSteps: 501 }))) === 'TOO_MANY_STEPS');

// ------------------------------------------------------------------- matching

console.log('\n[9] semantic re-matching');
const DUMP = '  @e1 button "Submit"\n@e2 textbox "Email"="a@b"\n  generic "x"\n  @e3 link "Say \\"hi\\""';
const parsed = parseSnapshotText(DUMP);
ok('snapshot text parsed into candidates (ref-less lines dropped)', parsed.length === 3 && parsed[0].name === 'Submit', JSON.stringify(parsed));
ok('escaped quotes in a name survive parsing', parsed[2].name === 'Say "hi"', JSON.stringify(parsed[2]));
ok('exact role+name wins', matchIntent(PAGE, intentFor(EVENTS[1])).ref === '@e1');
ok('role family match (textbox↔searchbox) still accepted', matchIntent([{ ref: '@e5', role: 'searchbox', name: '搜索关键词' }], intentFor(EVENTS[1])).ok === true);
ok('role-only match refused (would click the wrong button)', matchIntent([{ ref: '@e6', role: 'button', name: '完全无关' }], intentFor(EVENTS[1])).ok === false);
ok('name-only match under threshold refused', matchIntent([{ ref: '@e7', role: 'link', name: '搜索关键词' }], intentFor(EVENTS[1])).ok === false);
const miss = await planOf(PASSWORD_EVENTS, { probe: { candidates: async () => [{ ref: '@e1', role: 'heading', name: '无关标题' }], selectorVisible: async () => false } });
ok('unmatched step → MATCH_NOT_FOUND', miss.steps[1].error === 'MATCH_NOT_FOUND', JSON.stringify(miss.steps[1]));
ok('the message names what it looked for (role + name)', /role=textbox/.test(miss.steps[1].detail) && /搜索关键词/.test(miss.steps[1].detail), miss.steps[1].detail);
ok('the message lists the closest candidates tried', /无关标题/.test(miss.steps[1].detail) && /@e1/.test(miss.steps[1].detail));
const sel = await planOf(PASSWORD_EVENTS, { probe: { candidates: async () => [], selectorVisible: async (s) => s === 'button.danger' } });
ok('a visible recorded selector is the fallback target', sel.steps[8].via === 'selector' && sel.steps[8].matched_selector === 'button.danger', JSON.stringify(sel.steps[8]));
ok('navigate needs no target and survives an empty page', (await planOf([EVENTS[9]], { probe: { candidates: async () => [], selectorVisible: async () => false } })).steps[0].status === 'planned');
ok('a chrome:// navigation step is refused URL_BLOCKED', (await planOf([{ type: 'navigation', timestamp: 1, url: 'chrome://settings' }])).steps[0].error === 'URL_BLOCKED');

// ------------------------------------------------------- reverse controls (§6.3)

console.log('\n[10] reverse controls — a broken precondition changes the outcome');
const NO_TARGET = JSON.parse(JSON.stringify(TRACE));
delete NO_TARGET.events[2].target;
const rc1 = await planOf(normalizeTrace(NO_TARGET));
ok('RC1 fixture stripped of "target": step 2 no longer matches', rc1.steps[2].error === 'MATCH_NOT_FOUND', JSON.stringify(rc1.steps[2]));
ok('RC1 control holds: with the target present it does match', p1.steps[2].error === undefined && p1.steps[2].matched_ref === '@e1', JSON.stringify(p1.steps[2]));
const rc2 = await planOf(PASSWORD_EVENTS, { vars: {} });
ok('RC2 unknown var name: step 2 blocks with VAR_UNKNOWN', rc2.steps[2].error === 'VAR_UNKNOWN', JSON.stringify(rc2.steps[2]));
ok('RC2 the message names the var and leaks no value', /QUERY/.test(rc2.steps[2].detail) && !JSON.stringify(rc2).includes(SECRET), rc2.steps[2].detail);

// ------------------------------------------------------------------- registry

console.log('\n[11] offline registry + explicit tab_id (§6.2 / §9.3)');
const reg = await collectRegistry();
const NAMES = ['replay', 'replay.save', 'replay.list', 'replay.run', 'replay.delete'];
ok('all replay tools registered', NAMES.every((n) => reg.names.includes(n)), NAMES.filter((n) => !reg.names.includes(n)).join(','));
ok('every replay tool has category + description', NAMES.every((n) => reg.metas[n]?.category && reg.metas[n]?.description?.length > 40), JSON.stringify(NAMES.map((n) => reg.metas[n]?.category)));
ok('replay declares the 180s budget for long traces', reg.metas.replay.timeoutMs === 180000, String(reg.metas.replay.timeoutMs));
ok('replay honours tab_id and refuses without a session', (await codeOf(async () => reg.call('replay', { tab_id: 99999, trace: TRACE }))) === 'NO_SESSION');
ok('replay.run honours tab_id and refuses without a session', (await codeOf(async () => reg.call('replay.run', { tab_id: 99999, name: 'demo' }))) === 'NO_SESSION');

// ------------------------------------------------------ saved replay scripts

console.log('\n[12] replay.save / list / delete on chrome.storage.session');
const store = new Map();
globalThis.chrome.storage.session = {
  get: async (keys) => (keys == null
    ? Object.fromEntries(store)
    : Object.fromEntries([...store].filter(([k]) => (Array.isArray(keys) ? keys : [keys]).includes(k)))),
  set: async (obj) => { for (const [k, v] of Object.entries(obj)) store.set(k, v); },
  remove: async (k) => { store.delete(k); },
};
const saved = await reg.call('replay.save', { name: 'demo', trace: TRACE });
ok('save returns a summary only', saved.name === 'demo' && saved.steps === EVENTS.length && Array.isArray(saved.urls), JSON.stringify(saved));
ok('stored under key ubb_replay:<name>', store.has('ubb_replay:demo'), [...store.keys()].join(','));
ok('the stored record keeps the events', Array.isArray(store.get('ubb_replay:demo').events) && store.get('ubb_replay:demo').events.length === EVENTS.length);
ok('summary carries no event values', !JSON.stringify(saved).includes('{{var.QUERY}}') && !JSON.stringify(saved).includes('***'), JSON.stringify(saved));
ok('summary URLs are redacted of query secrets', saved.urls.every((u) => !/token=/.test(u)), JSON.stringify(saved.urls));
const listed = await reg.call('replay.list', {});
ok('list shows the script', listed.scripts.length === 1 && listed.scripts[0].name === 'demo', JSON.stringify(listed));
ok('list never returns events or snapshots', !JSON.stringify(listed).includes('snapshots') && !listed.scripts[0].events);
ok('bad script name refused with BAD_PARAMS', (await codeOf(async () => reg.call('replay.save', { name: 'no spaces', trace: TRACE }))) === 'BAD_PARAMS');
ok('over-1MB script refused with TRACE_TOO_LARGE', (await codeOf(async () => reg.call('replay.save', { name: 'huge', trace: { events: Array.from({ length: 40000 }, () => EVENTS[1]) } }))) === 'TRACE_TOO_LARGE');
await reg.call('replay.delete', { name: 'demo' });
ok('delete removes the key', !store.has('ubb_replay:demo'));
ok('list is empty after delete', (await reg.call('replay.list', {})).scripts.length === 0);
ok('a corrupt entry is ignored by list, not fatal', await (async () => {
  store.set('ubb_replay:broken', { name: 'broken', events: 'not-an-array' });
  const r = await reg.call('replay.list', {});
  store.delete('ubb_replay:broken');
  return r.scripts.length === 0;
})());

// ------------------------------------------------- end-to-end against a fake page

console.log('\n[13] full replay run through the tool (fake CDP page, no browser)');
const AX = [
  { nodeId: 1, role: { value: 'RootWebArea' }, name: { value: 'example' }, childIds: [2, 3, 4, 5, 6], ignored: false },
  { nodeId: 2, role: { value: 'button' }, name: { value: '搜索' }, backendDOMNodeId: 201, childIds: [], ignored: false },
  { nodeId: 3, role: { value: 'textbox' }, name: { value: '搜索关键词' }, backendDOMNodeId: 202, childIds: [], ignored: false },
  { nodeId: 4, role: { value: 'combobox' }, name: { value: '排序' }, backendDOMNodeId: 203, childIds: [], ignored: false },
  { nodeId: 5, role: { value: 'button' }, name: { value: '删除账号' }, backendDOMNodeId: 204, childIds: [], ignored: false },
  // §14: a real password input — only daemon-vault-backed steps may type it
  { nodeId: 6, role: { value: 'textbox' }, name: { value: 'password' }, backendDOMNodeId: 205, childIds: [], ignored: false },
];
const evalReply = (expression = '') => ({
  result: { value: /querySelector/.test(expression) ? false : /readyState/.test(expression) ? 'complete' : undefined },
});
const calls = [];
const pageStub = async ({ tabId }, method, params = {}) => {
  calls.push({ method, ...params });
  switch (method) {
    case 'Page.getFrameTree': return { frameTree: { frame: { id: 'F1', url: 'https://example.com/list' } } };
    case 'Accessibility.getFullAXTree': return { nodes: AX };
    case 'DOM.getFlattenedDocument': return { nodes: AX.filter((n) => n.backendDOMNodeId).map((n) => ({ nodeId: n.nodeId, backendNodeId: n.backendDOMNodeId })) };
    case 'DOM.getDocument': return { root: { nodeId: 1, backendNodeId: 1 } };
    case 'DOM.querySelector': return { nodeId: 5 };
    case 'DOM.describeNode': return { node: { backendNodeId: 204 } };
    case 'DOM.pushNodesByBackendIdsToFrontend': return { nodeIds: [params.backendNodeIds[0] + 1000] };
    // the live-callFunctionOn addressing chain: nodeId → objectId handle
    case 'DOM.resolveNode': return { object: { objectId: `obj-${params.nodeId}`, type: 'object' } };
    case 'Runtime.releaseObject': return {};
    case 'DOM.getBoxModel': return { model: { content: [10, 10, 110, 10, 110, 30, 10, 30] } };
    case 'DOM.getAttributes': return params.nodeId === 6 ? { attributes: ['type', 'password', 'name', 'password'] } : { attributes: ['type', 'text', 'name', 'q'] };
    case 'Runtime.evaluate': return evalReply(params.expression);
    case 'Runtime.callFunctionOn': return { result: { value: 24 } };
    default: return {};
  }
};
// every command the extension sends goes through the parameter-contract gate
// first (and the Edge "Document needs to be requested first" ordering):
// invented params fail HERE, offline, like -32602 fails live.
const gate = makeCdpGate();
const withGate = (stub) => async (target, method, params = {}) => {
  gate.check(target.tabId, method, params);
  return stub(target, method, params);
};
globalThis.chrome.debugger.sendCommand = withGate(pageStub);
const pageMsgs = [];
globalThis.chrome.tabs.sendMessage = async (tabId, payload) => { pageMsgs.push(payload); return { ok: true, result: { matches: [] } }; };
const navs = [];
globalThis.chrome.tabs.update = async (tabId, props) => { navs.push(props); return { id: tabId, url: props.url, status: 'complete' }; };
// targetTab() must resolve to tab 7 without a real session (contract §9.3)
const { sessions } = await import('../lib/actions.js');
sessions.active = () => ({ id: 'offline', lastTabId: 7, touch: () => {} });
sessions.owns = () => true;

const TRACE13 = {
  id: 'rec_13', description: 'search flow',
  start_url: 'https://example.com/list', final_url: 'https://example.com/list?q=x',
  events: [
    EVENTS[1],
    { ...EVENTS[2], value: '{{var.QUERY}}' },
    EVENTS[6],
    EVENTS[3],
    { type: 'navigation', timestamp: 4000, url: 'https://example.com/list?q=x' },
  ],
  snapshots: [],
};

const dry13 = await reg.call('replay', { tab_id: 7, trace: TRACE13, vars: { QUERY: SECRET }, dry_run: true });
const inputCalls = calls.filter((c) => /^Input\.|^Runtime\.callFunctionOn|^DOM\.setAttributeValue/.test(c.method));
ok('dry_run issued no input/JS command at all', inputCalls.length === 0 && navs.length === 0, JSON.stringify([...inputCalls, ...navs]));
ok('dry_run matched every step and executed nothing', dry13.executed === 0 && dry13.steps.filter((s) => s.matched_ref).length === 2, JSON.stringify(dry13.steps));
ok('dry_run still did not leak the value', !JSON.stringify(dry13).includes(SECRET), JSON.stringify(dry13));

calls.length = 0;
const run13 = await reg.call('replay', { tab_id: 7, trace: TRACE13, vars: { QUERY: SECRET }, wait_between_ms: 0 });
ok('the run executed all 5 steps', run13.executed === 5 && run13.ok === true, JSON.stringify({ e: run13.executed, ok: run13.ok, f: run13.failed_steps }));
ok('click went out as a physical CDP mouse sequence', calls.filter((c) => c.method === 'Input.dispatchMouseEvent').length === 3, JSON.stringify(calls.map((c) => c.method)));
ok('fill ran on the node via the objectId chain (resolveNode(nodeId 3) → callFunctionOn(objectId obj-3)) — never a backendNodeId on callFunctionOn',
  calls.some((c) => c.method === 'DOM.resolveNode' && c.nodeId === 3) &&
    calls.some((c) => c.method === 'Runtime.callFunctionOn' && c.objectId === 'obj-3' && c.backendNodeId === undefined),
  JSON.stringify(calls.filter((c) => c.method === 'Runtime.callFunctionOn' || c.method === 'DOM.resolveNode')));
ok('the value was passed as an argument, never inside the page code', (() => {
  const c = calls.find((x) => x.method === 'Runtime.callFunctionOn');
  return c.arguments[0].value === SECRET && !c.functionDeclaration.includes(SECRET);
})(), JSON.stringify(calls.find((x) => x.method === 'Runtime.callFunctionOn') || {}).slice(0, 200));
ok('no data-ubb-tmp tagging roundtrip (§9.7 / A proxy is replacing it)', !calls.some((c) => c.method === 'DOM.setAttributeValue' || /data-ubb-tmp/.test(JSON.stringify(c))));
ok('keypress went out as CDP key events', calls.filter((c) => c.method === 'Input.dispatchKeyEvent').length === 2);
ok('scroll used the recorded absolute position', calls.some((c) => c.method === 'Runtime.evaluate' && /window\.scrollTo\(0, 820\)/.test(c.expression)), JSON.stringify(calls.filter((c) => c.method === 'Runtime.evaluate').map((c) => c.expression)));
ok('navigate drove the same tab_id', navs.length === 1 && navs[0].url === 'https://example.com/list?q=x', JSON.stringify(navs));
ok('the executed plan is what came back (and stays value-free)', !JSON.stringify(run13).includes(SECRET) && run13.steps.every((s) => !('resolved_value' in s)));
ok('every step reports its match score and via', run13.steps.filter((s) => s.matched_ref).every((s) => s.score > 0 && s.via === 'accessibility'), JSON.stringify(run13.steps.map((s) => [s.via, s.score])));

const drifted = AX.map((n) => (n.nodeId === 3 ? { ...n, name: { value: '另一个字段' } } : n));
const driftReply = async (method, params = {}) => {
  if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'F1', url: 'https://example.com/list' } } };
  if (method === 'Accessibility.getFullAXTree') return { nodes: drifted };
  if (method === 'DOM.getFlattenedDocument') return { nodes: drifted.filter((n) => n.backendDOMNodeId).map((n) => ({ nodeId: n.nodeId, backendNodeId: n.backendDOMNodeId })) };
  if (method === 'DOM.getBoxModel') return { model: { content: [10, 10, 110, 10, 110, 30, 10, 30] } };
  if (method === 'DOM.getAttributes') return { attributes: ['type', 'text'] };
  if (method === 'Runtime.evaluate') return evalReply(params.expression);
  void params;
  return {};
};
const rc13 = await codeOf(async () => {
  globalThis.chrome.debugger.sendCommand = withGate(async (t, method, params) => driftReply(method, params));
  await reg.call('replay', { tab_id: 7, trace: { ...TRACE13, events: [EVENTS[2]] }, vars: { QUERY: SECRET }, wait_between_ms: 0 });
});
ok('RC3 page drift (field renamed live): the run stops with MATCH_NOT_FOUND', rc13 === 'MATCH_NOT_FOUND', String(rc13));

// ------------------------------------------- vault-backed vars (wave2-secrets)

console.log('\n[14] replay with {{secret:NAME}} inside vars (fake vault, never the user real one)');
{
  const VAULT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ubb-replay-vault-'));
  process.env.UBB_SECRETS_FILE = path.join(VAULT_DIR, 'secrets.json');
  // wave7a: pin the origin MODE too. prepareForward reads secret_origin_mode
  // from UBB_CONFIG_FILE (~/.ubb/config.json); without isolation this suite
  // inherited the running machine's mode — on a strict machine gh_pw (bound to
  // github.com) stamped a strict gate, the extension compared it against the
  // example.com fixture tab and [14] B ran false-red. A missing throwaway file
  // is deterministic "off" everywhere (same move as test-secrets.mjs).
  process.env.UBB_CONFIG_FILE = path.join(VAULT_DIR, 'config.json');
  const S = await import(pathToFileURL(path.resolve(HERE, optOf('--secret') || './cli/secret.mjs')).href);
  ok('[14] origin mode is isolated to the throwaway config (off, never the machine default)',
    S.getSecretOriginMode() === 'off');
  const { audit } = await import('../lib/audit.js');
  const VAULT_PW = 'vault-hunter-TEST-ONLY';
  S.setSecret('gh_pw', VAULT_PW, ['github.com']);
  const leak = (x) => JSON.stringify(x ?? '').includes(VAULT_PW);
  globalThis.chrome.debugger.sendCommand = withGate(pageStub); // RC3 swapped in the dumb drift stub — restore the recorder

  const pwTrace = { events: [{ type: 'input', timestamp: 1, target: { selector: 'input#pw', role: 'input', label: 'password' }, value: '{{var.PW}}' }] };

  // A1) a literal password as the trace value dies at the PLAN gate
  calls.length = 0;
  const codeA1 = await codeOf(async () => {
    await reg.call('replay', { tab_id: 7, trace: { events: [{ ...pwTrace.events[0], value: 'literal-pw-TEST' }] }, vars: {}, wait_between_ms: 0 });
  });
  ok('A1 password field + literal value → SENSITIVE_FIELD at the plan gate', codeA1 === 'SENSITIVE_FIELD', String(codeA1));
  // A2) a literal password through vars (template, but NO vault provenance) must die at the EXECUTOR guard
  calls.length = 0;
  const codeA2 = await codeOf(async () => {
    await reg.call('replay', { tab_id: 7, trace: pwTrace, vars: { PW: 'literal-pw-TEST' }, wait_between_ms: 0 });
  });
  ok('A2 password step WITHOUT vault provenance is refused at execution (SENSITIVE_FIELD)', codeA2 === 'SENSITIVE_FIELD', String(codeA2));
  ok('A2 nothing was typed into the password node (no callFunctionOn on its objectId handle)', !calls.some((c) => c.method === 'Runtime.callFunctionOn' && (c.objectId === 'obj-6' || c.backendNodeId === 205)), JSON.stringify(calls.map((c) => c.method)));

  // B) the real forward path: daemon resolves vars only, stamps the ledger
  const fwd = S.prepareForward('tool.replay', { tab_id: 7, trace: pwTrace, vars: { PW: '{{secret:gh_pw}}' }, wait_between_ms: 0 });
  ok('B daemon resolved ONLY the vars value', fwd.params.vars.PW === VAULT_PW && fwd.params.trace.events[0].value === '{{var.PW}}');
  ok('B the resolved-step ledger names varsKey→secret', fwd.params.__ubb_secret_vars?.PW?.join() === 'gh_pw' && fwd.params.__ubb_secret_fill === true);
  try {
  calls.length = 0;
  const runB = await reg.call('replay', fwd.params);
  ok('B the vault-backed password step executes', runB.executed === 1 && runB.ok === true, JSON.stringify(runB.failed_steps));
  ok('B step reports provenance by NAME only (and the flag survives redact — key has no sensitive substring)', runB.steps[0].value_from_vault === true && runB.steps[0].vault_entries.join() === 'gh_pw' && runB.steps[0].value_template === '{{var.PW}}', JSON.stringify(runB.steps[0]));
  ok('B the value rides only the injected call argument (objectId handle for the password node)', (() => {
    const c = calls.find((x) => x.method === 'Runtime.callFunctionOn' && x.objectId === 'obj-6');
    return !!c && c.arguments[0].value === VAULT_PW && !c.functionDeclaration.includes(VAULT_PW);
  })(), JSON.stringify(calls.filter((c) => c.method === 'Runtime.callFunctionOn')).slice(0, 200));
  ok('B STRONGER LEAK TEST: no plaintext in the replay result, steps, or audit entries', !leak(runB) && !leak(audit.list(30)), JSON.stringify(runB).slice(0, 200));
  ok('B audit surfaces the vault fill by name (replay.secret_fill + vault_entries)', audit.list(30).some((e) => e.action === 'replay.secret_fill' && e.vault_entries.join() === 'gh_pw'), JSON.stringify(audit.list(5).map((e) => e.action)));
  const dryB = await reg.call('replay', { ...fwd.params, dry_run: true });
  ok('B dry_run of the vault plan leaks nothing (template + char count only)', !leak(dryB) && dryB.steps[0].value_chars === VAULT_PW.length, JSON.stringify(dryB.steps[0]));
  } catch (e) {
    ok('B the vault-backed password step executes (no throw)', false, `threw ${e?.code || e}`);
  }

  // C) residual placeholder (daemon never ran / older daemon) — B fail-closed kept
  const codeC = await codeOf(async () => {
    await reg.call('replay', { tab_id: 7, trace: pwTrace, vars: { PW: '{{secret:gh_pw}}' }, wait_between_ms: 0 });
  });
  ok('C unresolved {{secret:…}} still blocks fail-closed with SECRET_UNRESOLVED', codeC === 'SECRET_UNRESOLVED', String(codeC));

  // D) unknown secret name: the daemon refuses the whole forward (bridge: SECRET_UNKNOWN)
  const fwdD = S.prepareForward('replay', { vars: { PW: '{{secret:ghost_absent}}' } });
  ok('D unknown name → missing list, params untouched, no value echo', fwdD.missing.join() === 'ghost_absent' && fwdD.params.vars.PW === '{{secret:ghost_absent}}');

  // E) placeholders inside the trace itself are NEVER substituted (structural fields)
  const fwdE = S.prepareForward('replay', { trace: { events: [{ type: 'input', value: '{{secret:gh_pw}}' }], description: 'gh={{secret:gh_pw}}' }, vars: {} });
  ok('E trace/events/description placeholders stay literal', fwdE.params.trace.events[0].value === '{{secret:gh_pw}}' && fwdE.params.trace.description === 'gh={{secret:gh_pw}}' && !leak(fwdE.params.trace));

  // F) replay.save can never persist a resolved secret: daemon restores it first
  const fwdF = S.prepareForward('tool.replay.save', { name: 'vaultdemo', events: [{ type: 'input', timestamp: 1, target: { selector: 'input#pw', role: 'input', label: 'password' }, value: VAULT_PW }] });
  ok('F replay.save restores the vault plaintext to its placeholder before forwarding', fwdF.params.events[0].value === '{{secret:gh_pw}}' && !leak(fwdF.params));
  await reg.call('replay.save', fwdF.params);
  ok('F storage.session holds NO plaintext vault value', !store.get('ubb_replay:vaultdemo') || !leak(store.get('ubb_replay:vaultdemo')), JSON.stringify(store.get('ubb_replay:vaultdemo') || {}).slice(0, 160));
  const listedF = await reg.call('replay.list', {});
  ok('F replay.list summary holds no plaintext', !leak(listedF), JSON.stringify(listedF).slice(0, 160));
  // G) forged provenance at the daemon boundary is stripped, not trusted
  const forgG = S.prepareForward('replay', { vars: { PW: 'literal' }, __ubb_secret_fill: true, __ubb_secret_vars: { PW: ['gh_pw'] } });
  ok('G forged replay markers stripped daemon-side (extension cannot be told a step is vault-backed)', forgG.params.__ubb_secret_fill === undefined && forgG.params.__ubb_secret_vars === undefined);
  fs.rmSync(VAULT_DIR, { recursive: true, force: true });
}

// ---------------------------------------------------------------- 15. fix9: per-step gate on the replay path
const REPLAY_SRC = path.resolve(HERE, optOf('--replay') || '../lib/tools-replay.js');
const RC15 = optOf('--replay') ? ` [REVERSE CONTROL → ${optOf('--replay')}]` : '';
console.log(`\n[15] fix9：replay 每一步按当刻点位确认、keypress 带 keys（中途遮罩回弹不许静默空转）${RC15}`);
{
  const src = fs.readFileSync(REPLAY_SRC, 'utf8');
  const { register: registerReplayGate } = await import(pathToFileURL(REPLAY_SRC).href);
  const mini = new Map();
  registerReplayGate({ register: (n, m, f) => mini.set(n, f) });
  const replayTool = mini.get('replay');
  ok('被测模块注册了 replay（RC 副本也算）', typeof replayTool === 'function');

  const EXT = globalThis.chrome.runtime.id;
  const origMsg = globalThis.chrome.tabs.sendMessage;
  const origScripting = globalThis.chrome.scripting;
  // one armed shield host in the page: the readback channel answers for the DOM,
  // the UBB_PASS reply answers for the document's LIVE listeners. Both knobs are
  // what the two missing opts (at / keys) decide whether the gate looks at.
  const G = { opens: [], closes: 0, hosts: 1, ackPass: true, blockFrom: Infinity, hitAt: null };
  globalThis.chrome.scripting = {
    executeScript: async ({ target, args }) => {
      const [op, token, expire, at] = args;
      if (op === 'open') G.opens.push(at || null);
      else G.closes++;
      const n = G.opens.length;
      const shut = n >= G.blockFrom || (Array.isArray(G.hitAt) && Array.isArray(at) && at[0] === G.hitAt[0] && at[1] === G.hitAt[1]);
      return [{
        frameId: target.frameIds[0],
        result: {
          hosts: G.hosts, ours: G.hosts, foreign: [],
          blocking: shut ? [{ owner: EXT, veil: 'auto' }] : [],
          hit: shut ? { tag: 'div', is_shield_host: true, owner: EXT } : null,
          open_tokens: shut ? 0 : 1,
        },
      }];
    },
  };
  globalThis.chrome.tabs.sendMessage = async (_t, payload) => {
    if (payload?.type === 'UBB_PASS' || payload?.type === 'UBB_SHIELD_QUERY') {
      return { ok: true, pass: G.ackPass, state: { mode: 'armed', blockMode: 'block', pass: G.ackPass } };
    }
    return { ok: true, result: { matches: [] } }; // bridge search op for the re-matcher
  };

  const TRACE15 = { id: 'rec_15', events: [EVENTS[1], EVENTS[3]], snapshots: [] };
  const run15 = async (over = {}) => {
    Object.assign(G, { opens: [], closes: 0, hosts: 1, ackPass: true, blockFrom: Infinity, hitAt: null }, over);
    calls.length = 0;
    let out = { code: null, res: null };
    try {
      out.res = await replayTool({ tab_id: 7, trace: TRACE15, wait_between_ms: 0 });
    } catch (e) {
      out.code = e?.code;
    }
    out.mouse = calls.filter((c) => c.method === 'Input.dispatchMouseEvent').length;
    out.keys = calls.filter((c) => c.method === 'Input.dispatchKeyEvent').length;
    return out;
  };

  // a) the honest run: 2 steps, 5 dispatched events, 7 confirmations
  let r = await run15();
  ok('前提：click 3 个鼠标事件 + keypress 2 个键事件都上了线路', r.res?.executed === 2 && r.mouse === 3 && r.keys === 2, JSON.stringify({ e: r.res?.executed, m: r.mouse, k: r.keys, code: r.code }));
  ok('确认次数 ≥ 派发次数 + 每步一次首确认（不许退回到"整段只确认开局"）', G.opens.length >= r.mouse + r.keys + 2, `opens=${G.opens.length} events=${r.mouse + r.keys}`);
  ok('click 那一步的每次确认都问的是当刻那一点（at=[60,20]；缺 at 时全是 null=只查顶层 veil）', G.opens.slice(0, 4).every((at) => Array.isArray(at) && at[0] === 60 && at[1] === 20), JSON.stringify(G.opens));

  // b) the point this step is about to use is covered → the step refuses, and the
  //    run stops there instead of idling the rest of the script
  r = await run15({ hitAt: [60, 20] });
  ok('点位被自家遮罩占着 → 这一步 SHIELD_PASS_FAILED（不是 ok:true 空转）', r.code === 'SHIELD_PASS_FAILED', String(r.code));
  ok('拒绝即 0 个鼠标事件上线（首确认就红，事件一条都没发）', r.mouse === 0 && r.keys === 0, JSON.stringify({ m: r.mouse, k: r.keys }));

  // c) mid-run bounce: the door closes again after the click step's dispatches
  r = await run15({ blockFrom: 5 });
  ok('click 落地后遮罩回弹 → keypress 那一步当场红（后续步骤不静默空转）', r.code === 'SHIELD_PASS_FAILED' && r.mouse === 3 && r.keys === 0, JSON.stringify({ code: r.code, m: r.mouse, k: r.keys }));

  // d) the orphan-world rule ONLY the keys opt turns on: the DOM readback says
  //    the veil is out of the way, but no live listener answers UBB_PASS for that
  //    document → pointer events may still pass, keystrokes are certainly eaten
  r = await run15({ ackPass: false });
  ok('孤儿世界：click 步骤照旧放行（DOM 通路治得了鼠标）', r.mouse === 3, JSON.stringify({ m: r.mouse, code: r.code }));
  ok('孤儿世界：keypress 步骤必须红（缺 keys:true 时这条检查整个被跳过）', r.code === 'SHIELD_PASS_FAILED', String(r.code));
  ok('孤儿世界：拒绝那一刻线路上 0 条 dispatchKeyEvent', r.keys === 0, JSON.stringify({ k: r.keys }));

  // e) the shapes, pinned against the module under test: a lost opt is a silent
  //    loss of a check, so it must not be able to slip through review
  const clickCase = (src.match(/case 'click': \{[\s\S]*?\n      \}/) || [''])[0];
  const keyCase = (src.match(/case 'keypress': \{[\s\S]*?\n      \}/) || [''])[0];
  ok('click 步骤的 withPass 带点位 opts（at:[box.cx,box.cy]）', /withPass\(tabId,[\s\S]*?\}, \{[^}]*at: \[box\.cx, box\.cy\]/.test(clickCase), (clickCase.match(/\}\);/) || ['(no opts object on withPass)'])[0]);
  ok('keypress 步骤的 withPass 带 keys:true', /withPass\(tabId,[\s\S]*?\}, \{[^}]*keys: true/.test(keyCase), (keyCase.match(/\}\);/) || ['(no opts object on withPass)'])[0]);

  globalThis.chrome.tabs.sendMessage = origMsg;
  if (origScripting) globalThis.chrome.scripting = origScripting;
  else delete globalThis.chrome.scripting;
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
