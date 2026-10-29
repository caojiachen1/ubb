// Wave 2 cross-agent wiring offline self-check (contract §6.2/§6.3/§6.4) —
// no browser, no daemon:
//   node daemon/test-fill.mjs
// Reverse-control entry points (§6.3): --lib <alt lib dir> swaps the whole
// lib/ import base (used with patched copies), --mcp <file> points the
// writeScreenshot extraction at a patched mcp.mjs copy. Both default to the
// real files. Fake cdp.send/chrome.* monkey-patching follows daemon/test-quick.mjs.
//
// fix6 [8] (emulate / wait_for / perf.stop): clones stay OUTSIDE the repo (§0),
// patch one swallow back in, and the named assertions must go red —
//   node D:/Codebase/ubb-scratch/rc/fix6/patch.cjs b <rcdir>   # emulate network:'none'
//   node D:/Codebase/ubb-scratch/rc/fix6/patch.cjs d <rcdir>   # emulate.reset {reset:true}
//   node D:/Codebase/ubb-scratch/rc/fix6/patch.cjs e <rcdir>   # wait_for + perf.stop
//   node daemon/test-fill.mjs --lib file:///<rcdir>/lib

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const arg = (name, dflt) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};
const LIB = new URL(arg('--lib', '../lib') + '/', import.meta.url);
const MCP = new URL(arg('--mcp', './mcp.mjs'), import.meta.url);
const ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..');

let pass = 0;
let fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
};
async function grab(f) {
  try { return { r: await f(), e: null }; } catch (e) { return { r: null, e }; }
}
const describe = (x) => (x == null ? 'it returned instead of throwing' : `got ${x.code || x.name || 'plain throw'}: ${String(x.message || x).slice(0, 140)}`);

// ---------------------------------------------------------------- page stubs
// callOnNode ships .toString()'d functions into the "renderer"; in here the
// renderer is Node, so the few DOM globals they touch get minimal stubs.
globalThis.HTMLInputElement = class HTMLInputElement {
  get value() { return this._v ?? ''; }
  set value(v) { this._v = String(v); }
};
globalThis.HTMLTextAreaElement = class HTMLTextAreaElement {
  get value() { return this._v ?? ''; }
  set value(v) { this._v = String(v); }
};
globalThis.HTMLSelectElement = class HTMLSelectElement {
  get value() { return this._v ?? ''; }
  set value(v) { this._v = String(v); this.setterHits = (this.setterHits || 0) + 1; }
};
globalThis.InputEvent = class InputEvent extends Event {};
const SEL = new Map(); // css selector → element (the fake document the bridge sees)
globalThis.document = {
  activeElement: null,
  querySelector: (s) => SEL.get(s) ?? null,
  getElementById: () => null,
};

function mkEl(tag, attrs = {}) {
  const Base = tag === 'input' ? HTMLInputElement : tag === 'textarea' ? HTMLTextAreaElement : HTMLSelectElement;
  const el = new Base();
  el.attrs = attrs;
  el.tagName = tag.toUpperCase();
  el.type = attrs.type ?? (tag === 'input' ? 'text' : undefined);
  el.name = attrs.name || '';
  el.id = attrs.id || '';
  el.placeholder = attrs.placeholder || '';
  el.autocomplete = attrs.autocomplete || '';
  el._v = attrs.value ?? '';
  el.options = attrs.options;
  el.events = [];
  el.selection = null;
  el.clicked = false;
  el.getAttribute = (k) => el.attrs[k] ?? null;
  el.setAttribute = (k, v) => { el.attrs[k] = v; };
  el.focus = () => { document.activeElement = el; };
  el.click = () => { el.clicked = true; };
  el.dispatchEvent = (e) => { el.events.push(e); };
  el.setSelectionRange = (a, b) => { el.selection = [a, b]; };
  return el;
}

const { installChromeStub, collectRegistry, validateCdpParams, makeCdpGate } = await import(new URL('testharness.mjs', LIB));
installChromeStub();
const actions = await import(new URL('actions.js', LIB));
const { cdp, refs, sessions } = actions;
const quick = await import(new URL('tools-quick.js', LIB));
const { names, metas, call } = await collectRegistry();

const cleanups = [];
const after = (fn) => cleanups.push(fn);
const finish = () => {
  for (const fn of cleanups.reverse()) fn();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
};

// ============================================================ 1. ownership / statics
console.log('\n[1] callOnNode 归位 + tools.js 静态体检');
const toolsSrc = fs.readFileSync(new URL('tools.js', LIB), 'utf8');
const quickSrc = fs.readFileSync(new URL('tools-quick.js', LIB), 'utf8');
const bridgeSrc = fs.readFileSync(path.join(ROOT, 'content', 'bridge.js'), 'utf8');

ok('lib/actions.js exports callOnNode (正本)', typeof actions.callOnNode === 'function');
ok('lib/tools-quick.js no longer defines callOnNode itself', !/async function callOnNode/.test(quickSrc));
ok('lib/tools-quick.js imports callOnNode from ./actions.js', /callOnNode,?\n?\} from '\.\/actions\.js'|callOnNode[^\n]*from '\.\/actions\.js'/s.test(quickSrc));
// the live -32602 was a second, IDENTICAL copy of the bug: two implementations
// of the same plumbing drift/fail twice. One canonical, no private copies.
const replaySrc = fs.readFileSync(new URL('tools-replay.js', LIB), 'utf8');
const actionsSrc = fs.readFileSync(new URL('actions.js', LIB), 'utf8');
ok('tools-replay.js has NO private callOnNode copy (single source of truth)', !/async function callOnNode/.test(replaySrc));
ok('tools-replay.js imports the canonical callOnNode from ./actions.js', /callOnNode,/.test(replaySrc.slice(0, replaySrc.indexOf("from './actions.js'"))));
const BAD_WIRE = /send\(tabId, 'Runtime\.callFunctionOn', \{[^}]*backendNodeId/;
ok('the canonical callFunctionOn wire never carries backendNodeId (objectId is the only node handle)', !BAD_WIRE.test(actionsSrc));
ok('RC-static: that wire regex catches the OLD broken call shape', BAD_WIRE.test("await cdp.send(tabId, 'Runtime.callFunctionOn', { backendNodeId, functionDeclaration });"));
ok('RC-static: the private-copy regex catches a KNOWN copy', /async function callOnNode/.test("async function callOnNode(tabId, backendNodeId, functionDeclaration, args = []) { return cdp.send(tabId, 'Runtime.callFunctionOn', { backendNodeId }); }"));
ok('tools.js has ZERO data-ubb-tmp stamps left', !toolsSrc.includes('data-ubb-tmp'));
ok('tools.js sends zero DOM.setAttributeValue', !toolsSrc.includes('DOM.setAttributeValue'));
ok('the old download.path registration is gone from tools.js', !toolsSrc.includes("R('download.path'"));
ok('download.status is provided by tools-downloads.js, not tools.js (wave4a registered it, wave7a deleted the old block)',
  names.includes('download.status') && !toolsSrc.includes("R('download.status'"));
ok('download.status keeps the legacy field set in its description',
  ['state', 'bytes_received', 'total', 'paused', 'url'].every((f) => (metas['download.status']?.description || '').includes(f)),
  JSON.stringify(metas['download.status']?.description));
ok('download.path resolves to the C superset (Map.set winner)', /superset/i.test(metas['download.path']?.description || ''), JSON.stringify(metas['download.path']?.description));
const noDesc = names.filter((n) => !String(metas[n]?.description || '').trim());
ok(`every one of the ${names.length} registered tools declares a description`, noDesc.length === 0, 'missing: ' + noDesc.join(', '));
const thinDesc = names.filter((n) => String(metas[n]?.description || '').trim().length < 20);
ok('no description is a stub (>= 20 chars — the model reads these as usage docs)', thinDesc.length === 0, thinDesc.join(', '));
ok('quick keeps its four tools registered', ['dropdown_options', 'print_pdf', 'search', 'batch'].every((t) => names.includes(t)));
ok('bridge.js comment now points at lib/actions.js (was lib/tools.js)', /guardSensitiveField in lib\/actions\.js/.test(bridgeSrc) && !/kept textually in sync\s*\n\s*const SENSITIVE_FIELD =/.test(bridgeSrc));
ok('bridge.js splits the NEVER class from the password class', /SENSITIVE_FIELD_NEVER/.test(bridgeSrc) && /PASSWORD_FIELD/.test(bridgeSrc));
ok('ubb.mjs dispatches the CLI registry BEFORE the token gate', (() => {
  const src = fs.readFileSync(path.join(ROOT, 'daemon', 'ubb.mjs'), 'utf8');
  return src.indexOf('runCliCommand(cmd, rest)') < src.indexOf('if (!TOKEN') && /else if \(cliHandled\)/.test(src);
})());

// ============================================================ 2. fakes
const fakeSession = {
  id: 's-fill', groupId: 7, created: new Set([1]), claimed: new Set(),
  lastTabId: 1, startedAt: Date.now(), marks: new Map(), ownWindowId: null, ownWindowWanted: null,
};
sessions.session = fakeSession;
after(() => { sessions.session = null; });

const OPTS = [
  { value: 'cn', textContent: '  China  ', selected: true },
  { value: 'us', textContent: 'USA', selected: false },
  { value: 'fr', textContent: 'France', selected: false },
];
const EL = {
  text: mkEl('input', { type: 'text', name: 'q', id: 'qq', value: 'old' }),
  pw: mkEl('input', { type: 'password', name: 'password' }),
  otp: mkEl('input', { type: 'text', name: 'code', autocomplete: 'one-time-code' }),
  cvv: mkEl('input', { type: 'text', name: 'cvv' }),
  card: mkEl('input', { type: 'text', placeholder: '卡号' }),
  sel: mkEl('select', { options: OPTS }),
};
const BN = { text: 4100, pw: 4200, otp: 4300, cvv: 4310, card: 4320, sel: 4400 };
const NODES = new Map(Object.entries(BN).map(([k, v]) => [v, EL[k]]));
const REF = {
  text: refs.put(1, BN.text, { role: 'textbox', name: 'q' }),
  pw: refs.put(1, BN.pw, { role: 'textbox', name: 'password' }),
  otp: refs.put(1, BN.otp, { role: 'textbox', name: 'code' }),
  cvv: refs.put(1, BN.cvv, { role: 'textbox', name: 'cvv' }),
  card: refs.put(1, BN.card, { role: 'textbox', name: '卡号' }),
  sel: refs.put(1, BN.sel, { role: 'combobox', name: 'Country' }),
};

let cdpCalls = [];
const realSend = cdp.send;
const realEnsure = cdp.ensure;
// the mock now speaks real CDP: parameter contract + this Edge build's
// "Document needs to be requested first" ordering (attach runs one
// DOM.getDocument inside cdp.ensure — mirror that here).
const gate = makeCdpGate();
const OBJS = new Map(); // objectId → fake element
let objSeq = 0;
cdp.ensure = async () => {};
gate.attach(1);
cdp.send = async (tabId, method, params = {}) => {
  gate.check(tabId, method, params);
  cdpCalls.push({ tabId, method, params });
  if (method === 'DOM.getDocument') return { root: { nodeId: 900, backendNodeId: 900 } };
  if (method === 'DOM.pushNodesByBackendIdsToFrontend') {
    const bn = params.backendNodeIds[0];
    if (!NODES.has(bn)) throw new Error('No node with given id found');
    return { nodeIds: [bn + 1000] };
  }
  if (method === 'DOM.resolveNode') {
    const el = NODES.get(params.nodeId - 1000);
    if (!el) throw new Error('No node with given id found');
    const objectId = `obj-${++objSeq}`;
    OBJS.set(objectId, el);
    return { object: { objectId, type: 'object', className: el.tagName } };
  }
  if (method === 'Runtime.releaseObject') {
    if (!OBJS.delete(params.objectId)) throw new Error('Invalid object id');
    return {};
  }
  if (method === 'Runtime.callFunctionOn') {
    const target = OBJS.get(params.objectId);
    if (!target) throw new Error('Cannot find context with specified id');
    const fn = new Function(`return (${params.functionDeclaration})`)();
    // real CDP surfaces a page-side throw as exceptionDetails, never as a
    // transport error — same shape here or callOnNode misclassifies REF_STALE
    try {
      const value = fn.apply(target, (params.arguments || []).map((a) => a.value));
      return { result: { value } };
    } catch (e) {
      return { exceptionDetails: { exception: { description: String(e && e.stack ? e.stack : e) } } };
    }
  }
  if (method === 'DOM.getAttributes') {
    const el = NODES.get(params.nodeId - 1000);
    const flat = [];
    for (const [k, v] of Object.entries(el?.attrs || {})) if (k !== 'options' && k !== 'value') flat.push(k, String(v));
    return { attributes: flat };
  }
  if (method === 'DOM.getBoxModel') return { model: { content: [0, 0, 10, 0, 10, 10, 0, 10] } };
  return {};
};
after(() => { cdp.send = realSend; cdp.ensure = realEnsure; });
const callsOf = (m) => cdpCalls.filter((c) => c.method === m);
const noMarkerRun = () =>
  !cdpCalls.some((c) => c.method === 'DOM.setAttributeValue') && !JSON.stringify(cdpCalls).includes('data-ubb-tmp');

// ==================================================== 2b. the tightened mock bites (§6.3)
console.log('\n[2b] reverse controls: the mock that used to let the -32602 pass is now red on it');
const rcWire = await grab(() => {
  validateCdpParams('Runtime.callFunctionOn', { backendNodeId: 4242, functionDeclaration: 'function(){}', returnByValue: true, awaitPromise: true });
});
ok('RC-mock: the exact 2026-10 live-bug wire shape (backendNodeId on callFunctionOn) throws at the parameter contract',
  !!rcWire.e && /backendNodeId/.test(rcWire.e.message), describe(rcWire.e));
const rcWireOk = await grab(() => {
  validateCdpParams('Runtime.callFunctionOn', { objectId: 'obj-1', functionDeclaration: 'function(){}', arguments: [{ value: 1 }], returnByValue: true, awaitPromise: true });
});
ok('RC-mock control: the fixed objectId shape passes the contract', !rcWireOk.e, describe(rcWireOk.e));
const rcDoc = await grab(() => {
  const g = makeCdpGate();
  g.check(77, 'DOM.resolveNode', { nodeId: 7 });
});
ok('RC-mock: DOM.resolveNode without a prior DOM.getDocument reproduces "Document needs to be requested first"',
  !!rcDoc.e && /Document needs to be requested first/.test(rcDoc.e.message), describe(rcDoc.e));
const rcDocOk = await grab(() => {
  const g = makeCdpGate();
  g.check(77, 'DOM.getDocument', {});
  g.check(77, 'DOM.resolveNode', { nodeId: 7 });
});
ok('RC-mock control: with getDocument first the same resolveNode is accepted', !rcDocOk.e, describe(rcDocOk.e));

// ============================================================ 3. the three ex-marker paths
console.log('\n[3] fill / select_option / ax.action: callOnNode, zero page pollution');

cdpCalls = [];
const f1 = await call('fill', { ref: REF.text, value: 'new text', tab_id: 1 });
ok('fill(@eN) succeeds through callOnNode', f1.filled === REF.text, JSON.stringify(f1));
ok('fill: NO DOM.setAttributeValue, NO data-ubb-tmp on the wire', noMarkerRun());
ok('fill: Runtime.evaluate is no longer used to find the node back', callsOf('Runtime.evaluate').length === 0);
const cf1 = callsOf('Runtime.callFunctionOn').pop();
ok('fill: the node reaches callFunctionOn as an objectId, never a backendNodeId (the latter is not a Runtime.callFunctionOn parameter — the live -32602)',
  typeof cf1?.params.objectId === 'string' && cf1.params.backendNodeId === undefined, JSON.stringify(Object.keys(cf1?.params || {})));
ok('fill: that objectId came from DOM.resolveNode(nodeId) pushed from the ref backendNodeId',
  callsOf('DOM.pushNodesByBackendIdsToFrontend').some((c) => c.params.backendNodeIds[0] === BN.text) &&
    callsOf('DOM.resolveNode').some((c) => c.params.nodeId === BN.text + 1000) &&
    callsOf('DOM.resolveNode').at(-1)?.params.objectId === undefined,
  JSON.stringify(callsOf('DOM.resolveNode').map((c) => c.params)));
ok('fill: resolveNode only went out after a DOM.getDocument this generation (Edge ordering)',
  cdpCalls.findIndex((c) => c.method === 'DOM.getDocument') < cdpCalls.findIndex((c) => c.method === 'DOM.resolveNode'));
ok('fill keeps REPLACE semantics: focus + select-all of the old value first',
  EL.text.selection?.[0] === 0 && EL.text.selection?.[1] === 3 && document.activeElement === EL.text,
  JSON.stringify({ selection: EL.text.selection }));
ok('fill: selection happens BEFORE Input.insertText (replace, not append)',
  cdpCalls.findIndex((c) => c.method === 'Runtime.callFunctionOn') < cdpCalls.findIndex((c) => c.method === 'Input.insertText'));
ok('fill: the value lands as insertText text', callsOf('Input.insertText').pop()?.params.text === 'new text');

cdpCalls = [];
EL.sel._v = undefined;
const f2 = await call('form.set', { ref: REF.sel, action: 'select_option', value: 'USA', tab_id: 1 });
ok('select_option still selects by text and returns {selected}', f2.result?.selected === 'USA', JSON.stringify(f2));
ok('select_option: no marker round-trip', noMarkerRun());
ok('select_option: React-safe prototype setter was the writer', EL.sel.setterHits === 1 && EL.sel._v === 'us', JSON.stringify({ hits: EL.sel.setterHits, v: EL.sel._v }));
ok('select_option: one bubbling change event', EL.sel.events.length === 1 && EL.sel.events[0].type === 'change' && EL.sel.events[0].bubbles === true);
await call('form.set', { ref: REF.sel, action: 'select_option', value: 'France', tab_id: 1 });
ok('select_option matches on trimmed option text', EL.sel._v === 'fr');
const miss = await grab(() => call('form.set', { ref: REF.sel, action: 'select_option', value: 'Zzz', tab_id: 1 }));
ok('an unmatched option keeps failing as EVAL_ERROR naming the value',
  miss.e?.code === 'EVAL_ERROR' && /option not found: Zzz/.test(miss.e.message), describe(miss.e));

cdpCalls = [];
const a1 = await call('ax.action', { ref: REF.text, action: 'focus', tab_id: 1 });
ok('ax.action focus: {active:true} via callOnNode', a1?.active === true && noMarkerRun(), JSON.stringify(a1));
const a2 = await call('ax.action', { ref: REF.text, action: 'click', tab_id: 1 });
ok('ax.action click: el.click() fired', a2?.clicked === true && EL.text.clicked === true);
EL.text.events = [];
EL.text.value = '';
const a3 = await call('ax.action', { ref: REF.text, action: 'setValue', value: 'typed', tab_id: 1 });
ok('ax.action setValue: value + input AND change events, unchanged semantics',
  a3?.value === 'typed' && EL.text.events.map((e) => e.type).join(',') === 'input,change', JSON.stringify(a3));
EL.sel.attrs = { role: 'combobox' };
const a4 = await call('ax.action', { ref: REF.sel, action: 'expand', tab_id: 1 });
ok('ax.action expand: aria-expanded=true + click', a4?.expanded === true && EL.sel.getAttribute('aria-expanded') === 'true' && EL.sel.clicked === true);
const abad = await grab(() => call('ax.action', { ref: REF.text, action: 'nuke', tab_id: 1 }));
ok('ax.action still refuses unknown actions with BAD_PARAMS', abad.e?.code === 'BAD_PARAMS', describe(abad.e));
ok('the whole ax.action battery stamped nothing into the page', noMarkerRun());
ok('every callFunctionOn in this phase ran against a resolved objectId (zero backendNodeId on that wire)',
  callsOf('Runtime.callFunctionOn').length > 0 && callsOf('Runtime.callFunctionOn').every((c) => typeof c.params.objectId === 'string' && c.params.backendNodeId === undefined));

// dropdown_options still works with the relocated callOnNode
EL.sel.attrs = {};
const dd = await call('dropdown_options', { ref: REF.sel, tab_id: 1 });
ok('quick/dropdown_options unaffected by the relocation (reads <select> options)',
  dd.tag === 'select' && dd.total === 3 && dd.options[1].value === 'us' && dd.options[0].text === 'China', JSON.stringify(dd.options));

// ============================================================ 4. secret-fill gate on fill paths
console.log('\n[4] __ubb_secret_fill → guardSensitiveField allowPassword');

cdpCalls = [];
const pwNo = await grab(() => call('fill', { ref: REF.pw, value: 'plaintext', tab_id: 1 }));
ok('password field WITHOUT the stamp: SENSITIVE_FIELD and nothing typed',
  pwNo.e?.code === 'SENSITIVE_FIELD' && callsOf('Input.insertText').length === 0, describe(pwNo.e));
const pwYes = await call('fill', { ref: REF.pw, value: 'hunter2-TEST-ONLY', tab_id: 1, __ubb_secret_fill: true });
ok('password field WITH __ubb_secret_fill:true: allowed (placeholder path)',
  pwYes.filled === REF.pw && callsOf('Input.insertText').pop()?.params.text === 'hunter2-TEST-ONLY', JSON.stringify(pwYes));
for (const [key, ref] of [['otp/one-time-code', REF.otp], ['cvv', REF.cvv], ['卡号', REF.card]]) {
  const r = await grab(() => call('fill', { ref, value: 'x', tab_id: 1, __ubb_secret_fill: true }));
  ok(`${key}: SENSITIVE_FIELD EVEN with the stamp (E 死守线, no bypass)`, r.e?.code === 'SENSITIVE_FIELD', describe(r.e));
}
const ffNo = await grab(() => call('fill_form', { tab_id: 1, values: { [REF.pw]: 'p' } }));
ok('fill_form password without the stamp: refused', ffNo.e?.code === 'SENSITIVE_FIELD', describe(ffNo.e));
const insertsBeforeFf = callsOf('Input.insertText').length;
const ffYes = await call('fill_form', { tab_id: 1, values: { [REF.pw]: 'p' }, __ubb_secret_fill: true });
// fill_form now selects existing text through the node's own object (works in
// shadow roots) instead of DOM.focus; either focus path is valid, but exactly
// one insertText must follow it
ok('fill_form password with the stamp: filled', ffYes.filled?.length === 1 && callsOf('Input.insertText').length === insertsBeforeFf + 1 && callsOf('Input.insertText').at(-1)?.params.text === 'p', JSON.stringify(ffYes));
const ffOtp = await grab(() => call('fill_form', { tab_id: 1, values: { [REF.otp]: 'p' }, __ubb_secret_fill: true }));
ok('fill_form otp with the stamp: STILL refused', ffOtp.e?.code === 'SENSITIVE_FIELD', describe(ffOtp.e));

// the @d / selector bridge paths must forward the flag, else fillDom can never allow it
const bridgeMsgs = [];
const realSendMsg = chrome.tabs.sendMessage;
chrome.tabs.sendMessage = async (tabId, msg) => {
  if (msg?.type === 'UBB_BRIDGE') bridgeMsgs.push(msg);
  return { ok: true, result: true };
};
after(() => { chrome.tabs.sendMessage = realSendMsg; });
await call('fill', { ref: '@d7', value: 'x', tab_id: 1 });
ok('bridge(fillDom) @d path carries allowPassword:false without the stamp',
  bridgeMsgs.at(-1)?.op === 'fillDom' && bridgeMsgs.at(-1)?.args?.allowPassword === false, JSON.stringify(bridgeMsgs.at(-1)?.args));
await call('fill', { ref: '@d7', value: 'x', tab_id: 1, __ubb_secret_fill: true });
ok('bridge(fillDom) @d path carries allowPassword:true with the stamp', bridgeMsgs.at(-1)?.args?.allowPassword === true);
await call('fill', { selector: '#plain2', value: 'x', tab_id: 1, __ubb_secret_fill: true });
ok('bridge(fillDom) selector fallback forwards it too', bridgeMsgs.at(-1)?.args?.allowPassword === true);

// ============================================================ 5. content/bridge.js fillDom
console.log('\n[5] bridge fillDom: password yields ONLY to allowPassword; NEVER class never');
const win = {};
new Function('window', 'chrome', bridgeSrc)(win, globalThis.chrome);
const api = win.__ubbBridge;
ok('bridge.js loads and exposes fillDom', typeof api?.fillDom === 'function');

const pwBridge = mkEl('input', { type: 'password', name: 'password' });
const otpBridge = mkEl('input', { type: 'text', name: 'code', autocomplete: 'one-time-code' });
const cvvBridge = mkEl('input', { type: 'text', name: 'cvv' });
const cardBridge = mkEl('input', { type: 'text', name: 'card_number' });
const plainBridge = mkEl('input', { type: 'text', name: 'search' });
SEL.set('#pw', pwBridge); SEL.set('#otp', otpBridge); SEL.set('#cvv', cvvBridge); SEL.set('#card', cardBridge); SEL.set('#plain', plainBridge);

const b1 = await grab(() => api.fillDom({ selector: '#pw', value: 'v' }));
ok('password refused without allowPassword (SENSITIVE_FIELD)', /SENSITIVE_FIELD/.test(b1.e?.message || ''), describe(b1.e));
const b2 = await api.fillDom({ selector: '#pw', value: 'daemon-resolved', allowPassword: true });
ok('password fills with allowPassword:true (native setter + input + change)',
  b2 === true && pwBridge.value === 'daemon-resolved' && pwBridge.events.some((e) => e.type === 'change'), JSON.stringify(pwBridge.events.map((e) => e.type)));
for (const [name, sel] of [['otp autocomplete', '#otp'], ['cvv', '#cvv'], ['card_number', '#card']]) {
  const b = await grab(() => api.fillDom({ selector: sel, value: 'v', allowPassword: true }));
  ok(`NEVER-class ${name}: still refused WITH allowPassword:true`, /SENSITIVE_FIELD/.test(b.e?.message || ''), describe(b.e));
}
ok('allowPassword:false (not undefined-but-falsy edge) also refuses password',
  /SENSITIVE_FIELD/.test((await grab(() => api.fillDom({ selector: '#pw', value: 'v', allowPassword: false }))).e?.message || ''));
await api.fillDom({ selector: '#plain', value: 'ok' });
ok('non-sensitive input fills as before', plainBridge.value === 'ok');

// ============================================================ 6. ubb.mjs: fresh-machine CLI without a token
console.log('\n[6] ubb.mjs token-gate ordering (real subprocess, throwaway HOME)');
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ubb-fill-home-'));
const secretsFile = path.join(tmpHome, 'secrets.json');
const noTokenEnv = { ...process.env, HOME: tmpHome, USERPROFILE: tmpHome, UBB_TOKEN: '', UBB_SECRETS_FILE: secretsFile };
const runUbb = (args, opts = {}) => spawnSync(process.execPath, [path.join(ROOT, 'daemon', 'ubb.mjs'), ...args], { env: noTokenEnv, encoding: 'utf8', ...opts });

const sList = runUbb(['secret', 'list']);
ok('fresh machine (no token): `ubb secret list` runs, NOT die(no token)',
  sList.status === 0 && !/no token/.test(sList.stderr), `exit=${sList.status} ${String(sList.stderr).slice(0, 160)}`);
const sAdd = runUbb(['secret', 'add', 'rc_pw'], { input: 'hunter2-TEST-ONLY\n' });
ok('fresh machine: `ubb secret add` from stdin works before any token exists',
  sAdd.status === 0 && fs.existsSync(secretsFile) && !/no token/.test(sAdd.stderr), `exit=${sAdd.status} ${String(sAdd.stderr).slice(0, 200)}`);
const st = runUbb(['status']);
ok('daemon path keeps the gate: `ubb status` still dies(no token)',
  st.status === 1 && /no token/.test(st.stderr), `exit=${st.status} ${String(st.stderr).slice(0, 160)}`);
const tk = runUbb(['click', '{"ref":"@e1"}']);
ok('tool path keeps the gate: `ubb click` still dies(no token)',
  tk.status === 1 && /no token/.test(tk.stderr), `exit=${tk.status} ${String(tk.stderr).slice(0, 160)}`);
fs.rmSync(tmpHome, { recursive: true, force: true });

// ============================================================ 7. mcp.mjs: format-driven extensions + binary pdf
console.log('\n[7] mcp.mjs落盘扩展名 + ubb_print_pdf binary');
const mcpSrc = fs.readFileSync(MCP, 'utf8');
const grabFn = (name) => {
  const m = mcpSrc.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n\\}`));
  if (!m) throw new Error(`${name} not found in ${String(MCP)}`);
  return m[0];
};
const mkdirs = [];
const fsShim = { mkdirSync: (d) => mkdirs.push(d) };
const mod = new Function('fs', 'path', `${grabFn('extForFormat')}\n${grabFn('writeScreenshot')}\nreturn { extForFormat, writeScreenshot };`)(fsShim, path);
ok('png stays png, jpeg maps to jpg', mod.extForFormat('png') === 'png' && mod.extForFormat('jpeg') === 'jpg' && mod.extForFormat('jpg') === 'jpg');
ok('a PDF gets .pdf (was the .png bug)', mod.extForFormat('pdf') === 'pdf');
ok('unknown formats use the real format string', mod.extForFormat('webp') === 'webp' && mod.extForFormat('GIF') === 'gif');
ok('missing/empty format falls back to png (old default)', mod.extForFormat(undefined) === 'png' && mod.extForFormat('') === 'png');
ok('format is filtered at the boundary (no separators survive)', !/[\\/.]/.test(mod.extForFormat('../../evil')) && mod.extForFormat('../../evil').length > 0);
const fp = mod.writeScreenshot('shots-here', { format: 'pdf' });
ok('writeScreenshot names the file <stamp>.pdf', fp.startsWith('shots-here') && fp.endsWith('.pdf'), fp);
ok('writeScreenshot jpeg → .jpg, default → .png',
  mod.writeScreenshot('d', { format: 'jpeg' }).endsWith('.jpg') && mod.writeScreenshot('d', {}).endsWith('.png'));

const { TOOLS } = await import(new URL('mcp-tools/index.mjs', import.meta.url));
const pdfDef = TOOLS.find((t) => t.name === 'ubb_print_pdf');
ok('ubb_print_pdf is declared binary:true now', pdfDef?.binary === true, JSON.stringify(pdfDef?.binary));
ok('ubb_screenshot keeps binary:true', TOOLS.find((t) => t.name === 'ubb_screenshot')?.binary === true);
ok('too_big contract intact in the extension tool (3MB → note names --out)',
  /too_big/.test(fs.readFileSync(path.join(ROOT, 'lib', 'tools-quick.js'), 'utf8')) && /--out/.test(fs.readFileSync(path.join(ROOT, 'lib', 'tools-quick.js'), 'utf8')));

// ============================================================ 8. fix6: swallowed errors that made a return value lie
console.log('\n[8] fix6 — emulate / wait_for / perf.stop：失败必须改变返回值');
{
  const toolsSrc8 = fs.readFileSync(new URL('tools.js', LIB), 'utf8');
  const wire = [];
  let FAIL_METHODS = new Set();
  let EVAL_VALUE; // undefined = no answer at all
  let EVAL_THROWS = false;
  const savedSend = cdp.send;
  cdp.send = async (tabId, method, params = {}) => {
    wire.push({ method, params });
    if (FAIL_METHODS.has(method)) throw new Error(`-32601 ${method} refused by this target`);
    if (method === 'Runtime.evaluate') {
      if (EVAL_THROWS) return { exceptionDetails: { exception: { description: 'Runtime.callFunctionOn: page blew up' } } };
      return { result: { value: EVAL_VALUE } };
    }
    return {};
  };
  const callW = async (name, params) => {
    try { return { ran: await call(name, { tab_id: 1, ...params }) }; }
    catch (e) { return { code: e?.code ?? `plain: ${e?.message || e}`, msg: String(e?.message || e) }; }
  };

  // --- emulate {network:'none'}: the clear is refused
  FAIL_METHODS = new Set(['Network.emulateNetworkConditions']);
  wire.length = 0;
  const cleared = await callW('emulate', { network: 'none' });
  ok('emulate{network:"none"} 被拒 → 红着报（不再 {emulated:["network"]}）',
    cleared.code === 'EMULATE_FAILED' && !cleared.ran, JSON.stringify(cleared));
  ok('红的那条也要说实话：它确实试过 clear（offline:false + 无限带宽），只是被拒',
    wire.some((c) => c.method === 'Network.emulateNetworkConditions' && c.params.offline === false && c.params.downloadThroughput === -1),
    JSON.stringify(wire.map((c) => c.method)));
  ok('错误消息点明"什么都没清掉，旧模拟仍在生效"',
    /still in force|NOT cleared|nothing was cleared/i.test(cleared.msg || ''), cleared.msg);
  ok('RC-static: emulate 路径上再无 .catch(()=>{}) 吞 Network.emulateNetworkConditions',
    !/Network\.emulateNetworkConditions[^\n]*\.catch\(\(\) => \{\}\)/.test(toolsSrc8));

  // --- unknown preset must not fall through to "clear" while claiming success
  FAIL_METHODS = new Set();
  wire.length = 0;
  const bogus = await callW('emulate', { network: 'slow4g' });
  ok('未知 network 预设 → BAD_PARAMS（旧形状：悄悄当"清除"执行还回 {emulated:["network"]}）',
    bogus.code === 'BAD_PARAMS' && !bogus.ran, JSON.stringify(bogus));
  ok('拒了就一条 Network.emulateNetworkConditions 都不上线',
    !wire.some((c) => c.method === 'Network.emulateNetworkConditions'), JSON.stringify(wire.map((c) => c.method)));

  // --- positive control: a preset that works still answers {emulated:[…]}
  const off = await callW('emulate', { network: 'offline' });
  ok('对照：offline 真的落上时仍然 {emulated:["network"]}',
    !!off.ran && off.ran.emulated.join() === 'network' &&
    wire.some((c) => c.method === 'Network.emulateNetworkConditions' && c.params.offline === true), JSON.stringify(off));

  // --- emulate.reset: partial failure is no longer {reset:true}
  FAIL_METHODS = new Set(['Emulation.clearDeviceMetricsOverride', 'Network.emulateNetworkConditions']);
  wire.length = 0;
  const halfReset = await callW('emulate.reset', {});
  ok('emulate.reset 两步被拒 → reset:false + 点名是哪两步（不再无条件 {reset:true}）',
    halfReset.ran && halfReset.ran.reset === false &&
    halfReset.ran.failed.length === 2 &&
    halfReset.ran.failed.map((f) => f.step).sort().join() === 'network,viewport' &&
    halfReset.ran.cleared === 3, JSON.stringify(halfReset.ran || halfReset));
  ok('其余三步仍然照跑（有界、独立、不半途而废）：五步全部上过线',
    wire.map((c) => c.method).sort().join() === [
      'Emulation.clearDeviceMetricsOverride', 'Emulation.clearGeolocationOverride', 'Emulation.setCPUThrottlingRate',
      'Emulation.setEmulatedMedia', 'Network.emulateNetworkConditions',
    ].sort().join(), JSON.stringify(wire.map((c) => c.method)));
  FAIL_METHODS = new Set();
  const fullReset = await callW('emulate.reset', {});
  ok('对照：五步全落地时 {reset:true, cleared:5}', fullReset.ran?.reset === true && fullReset.ran?.cleared === 5, JSON.stringify(fullReset.ran));

  // --- wait_for element_hidden: a page it cannot read is not a page where the element is hidden
  EVAL_THROWS = true;
  const hiddenBlind = await callW('wait_for', { condition: 'element_hidden', selector: '#gone', timeout_ms: 600 });
  ok('wait_for{element_hidden} 在"页面根本读不到"时不再 ok:true（旧 catch(()=>false) 取反即通过）',
    hiddenBlind.code === 'WAIT_TIMEOUT' && !hiddenBlind.ran, JSON.stringify(hiddenBlind));
  ok('WAIT_TIMEOUT 说实话：点名每次读页都失败了',
    /every page read failed/i.test(hiddenBlind.msg || ''), hiddenBlind.msg);
  EVAL_THROWS = false;
  EVAL_VALUE = false;
  const hiddenReal = await callW('wait_for', { condition: 'element_hidden', selector: '#gone', timeout_ms: 900 });
  ok('对照：真读到 visible=false 时 element_hidden 仍然通过', !!hiddenReal.ran && hiddenReal.ran.ok === true, JSON.stringify(hiddenReal));
  EVAL_VALUE = undefined;
  const presentBlind = await callW('wait_for', { condition: 'element_visible', selector: '#x', timeout_ms: 600 });
  ok('读不到答案时 element_visible 也不给 ok（null ≠ true）',
    presentBlind.code === 'WAIT_TIMEOUT' && !presentBlind.ran, JSON.stringify(presentBlind));

  // --- webmcp.list: an unreadable page is not a page that declares nothing
  EVAL_THROWS = true;
  const mcpBlind = await callW('webmcp.list', {});
  ok('webmcp.list 读页失败 → note 明说"没读到"（不再冒充 "page declares no WebMCP tools"）',
    mcpBlind.ran && mcpBlind.ran.tools === null && /could not be read/i.test(mcpBlind.ran.note || ''),
    JSON.stringify(mcpBlind.ran || mcpBlind));
  EVAL_THROWS = false;
  EVAL_VALUE = undefined;
  const mcpEmpty = await callW('webmcp.list', {});
  ok('对照：真读到 null 时才说"页面没声明 WebMCP 工具"',
    mcpEmpty.ran?.tools === null && /declares no/i.test(mcpEmpty.ran?.note || ''), JSON.stringify(mcpEmpty.ran));

  // --- perf.stop: a refused Tracing.end is not a flush timeout
  FAIL_METHODS = new Set(['Tracing.end']);
  const perf = await callW('perf.stop', {});
  ok('perf.stop：Tracing.end 被拒 → stopped:false + end_error，不再冒充 timeout:true',
    perf.ran && perf.ran.stopped === false && /refused/.test(perf.ran.end_error) && perf.ran.timeout === undefined,
    JSON.stringify(perf.ran || perf));
  FAIL_METHODS = new Set();

  cdp.send = savedSend;
}

// ============================================================ 9. fix19: 读不到可见性 ⇒ 保守路径
console.log('\n[9] fix19 — 判据读不到（这套件没有 chrome.scripting）：不新增"读不到就拒"，也不新增"读不到就当可见"');
{
  // This harness has NO chrome.scripting at all, which is exactly the shape of
  // "the visibility question cannot be asked". fix19 must therefore change
  // NOTHING here: the action still dispatches, and the delivery proof still runs
  // (and still degrades to delivered:null / unprovable, not to a silent true).
  const tools9 = fs.readFileSync(new URL('tools.js', LIB), 'utf8');
  const grab9 = async (name, params) => {
    try {
      return { ran: await call(name, { tab_id: 1, ...params }), code: null };
    } catch (e) {
      return { ran: null, code: e?.code, data: e?.data, msg: String(e?.message || e) };
    }
  };
  ok('tools.js 有派发前的可见性判据（fix19），且读不到时不拒（UNKNOWN_VISIBILITY 与 visible 同走原路）',
    /async function guardInputVisibility/.test(tools9) &&
      /if \(state === 'visible' \|\| state === UNKNOWN_VISIBILITY\) return \{ state \};/.test(tools9),
    '(guard present + conservative branch)');
  ok('判据读不到时不当成 visible：缓存记 unknown，且没有把取证 expect 一起跳过（expect 仍在调用点上）',
    /const state = read === null \? UNKNOWN_VISIBILITY : read;/.test(tools9) && /expect: pointerProof\(/.test(tools9),
    '(no silent allow)');

  cdpCalls = [];
  const c9 = await grab9('click', { x: 120, y: 240 });
  ok('click{x,y}：读不到可见性 ⇒ 不红在派发前（没有 stage:"pre-dispatch" 这种新拒绝）',
    c9.code !== 'INPUT_NOT_DELIVERED' || c9.data?.stage !== 'pre-dispatch', JSON.stringify({ code: c9.code, stage: c9.data?.stage }));
  ok('click{x,y}：读不到时事件照常上线（mouseMoved/Pressed/Released 三条都在）',
    callsOf('Input.dispatchMouseEvent').filter((x) => x.params.type !== 'mouseMoved').length === 2,
    JSON.stringify(callsOf('Input.dispatchMouseEvent').map((x) => x.params.type)));
  ok('click{x,y}：取证形状仍是"读不到证据就 delivered:null"，不是被判据冒充成 delivered:true',
    !!c9.ran && c9.ran.delivered === null && c9.ran.delivery_ms === null, JSON.stringify(c9.ran || c9.code));

  cdpCalls = [];
  const k9 = await grab9('press_key', { key: 's', modifiers: ['ctrl'] });
  ok('press_key：读不到时照常派发（Input.dispatchKeyEvent 2 条），没有被新判据拒',
    callsOf('Input.dispatchKeyEvent').length === 2 && k9.code !== 'INPUT_NOT_DELIVERED',
    JSON.stringify({ keys: callsOf('Input.dispatchKeyEvent').length, code: k9.code }));
  cdpCalls = [];
  const t9 = await grab9('type', { text: 'abc' });
  ok('type：读不到时照常 insertText 上线（这条通路本来就 ack-only）',
    callsOf('Input.insertText').length === 1 && !t9.code, JSON.stringify({ code: t9.code, ins: callsOf('Input.insertText').length }));
}

finish();
