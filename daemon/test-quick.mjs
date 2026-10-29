// Wave 1-A offline self-check (contract §6.2/§6.3/§6.4) — no browser, no daemon:
//   node daemon/test-quick.mjs
// Phase order is load-bearing: sessions.session is process-global, so the
// session-free NO_SESSION assertions run before the fake session goes in.

import { installChromeStub, collectRegistry, validateCdpParams, makeCdpGate } from '../lib/testharness.mjs';

let pass = 0;
let fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
};

installChromeStub();
const { cdp, refs, sessions, err } = await import('../lib/actions.js');
const quick = await import('../lib/tools-quick.js');
const { Dispatcher } = await import('../lib/protocol.js');

const CANARY = 'SECRETValue999';
const cleanups = [];
const after = (fn) => cleanups.push(fn);

/** Run f, returning {r,e} so a throw is just another observed outcome. */
async function grab(f) {
  try { return { r: await f(), e: null }; } catch (e) { return { r: null, e }; }
}
const describe = (x) => (x == null ? 'it returned instead of throwing' : `got ${x.code || 'plain throw'}: ${String(x.message || x).slice(0, 120)}`);

// ============================================================ 1. registry (§6.2)
console.log('\n[1] registry');
const { names, metas, call } = await collectRegistry();

for (const t of ['dropdown_options', 'print_pdf', 'search', 'batch']) {
  ok(`${t} is registered`, names.includes(t));
  ok(`${t} meta carries category + description`, !!metas[t]?.category && !!metas[t]?.description);
  ok(`${t} is not sensitive (no confirm gate added)`, !metas[t]?.sensitive);
}
ok('print_pdf meta category is "capture"', metas.print_pdf?.category === 'capture', metas.print_pdf?.category);
ok('print_pdf carries a timeoutMs (90000)', metas.print_pdf?.timeoutMs === 90000, String(metas.print_pdf?.timeoutMs));
ok('batch timeout is widened (180000)', metas.batch?.timeoutMs === 180000, String(metas.batch?.timeoutMs));
ok('the four new tools sit on top of the 83 baseline', names.length >= 87, `got ${names.length}`);
ok('no tool lost its category', names.filter((n) => !metas[n]?.category).length === 0);

// ============================================================ 2. session-free failures
console.log('\n[2] no session: NO_SESSION / BAD_PARAMS, and no value in the message');
for (const [t, params] of [
  ['dropdown_options', { ref: '@e1' }],
  ['print_pdf', {}],
  ['search', { query: 'hello', new_tab: false }],
]) {
  const { e } = await grab(() => call(t, params));
  ok(`${t} without a session throws NO_SESSION`, e?.code === 'NO_SESSION', describe(e));
}
for (const [t, params] of [
  ['dropdown_options', {}],
  ['search', {}],
  ['batch', {}],
  ['batch', { actions: [] }],
]) {
  const { e } = await grab(() => call(t, params));
  ok(`${t} rejects ${JSON.stringify(params)} with BAD_PARAMS`, e?.code === 'BAD_PARAMS', describe(e));
}

// messages name the failing parameter, never its content
const eng = await grab(() => call('search', { query: `${CANARY} hunter2`, engine: 'nope', new_tab: false }));
ok('unknown engine: BAD_PARAMS names the engine, not the query',
  eng.e?.code === 'BAD_PARAMS' && /nope/.test(eng.e.message) && !eng.e.message.includes(CANARY), String(eng.e?.message));
const long = await grab(() => call('search', { query: `${CANARY} `.repeat(200) }));
ok('oversized query is refused without echoing it',
  long.e?.code === 'BAD_PARAMS' && !long.e.message.includes(CANARY), String(long.e?.message));
const scaleErr = await grab(() => call('print_pdf', { scale: CANARY }));
ok('print_pdf rejects a bad scale without echoing it',
  scaleErr.e?.code === 'BAD_PARAMS' && !scaleErr.e.message.includes(CANARY), describe(scaleErr.e));
const thirteen = await grab(() => call('batch', { actions: Array.from({ length: 13 }, () => ({ tool: 'click' })) }));
ok('13 batch actions are refused up front', thirteen.e?.code === 'BAD_PARAMS' && /12/.test(thirteen.e.message), describe(thirteen.e));

// ============================================================ 3. fakes for the chrome/CDP surface
const fakeSession = {
  id: 's-test', groupId: 7, created: new Set([1]), claimed: new Set(),
  lastTabId: 1, startedAt: Date.now(), marks: new Map(), ownWindowId: null, ownWindowWanted: null,
};
sessions.session = fakeSession;
after(() => { sessions.session = null; });

const SELECT = {
  tagName: 'SELECT', multiple: false, disabled: false, getAttribute: () => null,
  options: Array.from({ length: 501 }, (_, i) => ({
    value: `v${i}`, textContent: i === 3 ? `  Opt   ${i}  ` : `Opt ${i}`, selected: i === 7,
  })),
};
const NODES = new Map([
  [4242, SELECT],
  [4243, { tagName: 'DIV', getAttribute: (k) => (k === 'role' ? 'combobox' : null), querySelectorAll: () => [] }],
  [4244, {
    tagName: 'DIV', getAttribute: (k) => (k === 'role' ? 'listbox' : null),
    querySelectorAll: () => [{ textContent: 'Red', getAttribute: () => null }, { textContent: 'Blue', getAttribute: () => 'true' }],
  }],
]);
const cdpCalls = [];
let pdfPayload = { data: '' };
const realSend = cdp.send;
const realEnsure = cdp.ensure;
// CDP-parameter-contract + Edge document-first ordering gate (§live bug 2026-10)
const gate = makeCdpGate();
const OBJS = new Map(); // objectId → fake node
cdp.ensure = async () => {};
gate.attach(1); // lib/cdp.js ends attach with a DOM.getDocument — mirror it
cdp.send = async (tabId, method, params = {}) => {
  gate.check(tabId, method, params);
  cdpCalls.push({ tabId, method, params });
  if (method === 'DOM.getDocument') return { root: { nodeId: 900, backendNodeId: 900 } };
  if (method === 'DOM.pushNodesByBackendIdsToFrontend') {
    if (!NODES.has(params.backendNodeIds[0])) throw new Error('No node with given id found');
    return { nodeIds: [params.backendNodeIds[0] + 1000] };
  }
  if (method === 'DOM.resolveNode') {
    const el = NODES.get(params.nodeId - 1000);
    if (!el) throw new Error('No node with given id found');
    const objectId = `obj-${params.nodeId}`;
    OBJS.set(objectId, el);
    return { object: { objectId, type: 'object' } };
  }
  if (method === 'Runtime.releaseObject') {
    OBJS.delete(params.objectId);
    return {};
  }
  if (method === 'Runtime.callFunctionOn') {
    const target = OBJS.get(params.objectId);
    if (!target) throw new Error('Cannot find context with specified id');
    const fn = new Function(`return (${params.functionDeclaration})`)();
    const value = fn.apply(target, (params.arguments || []).map((a) => a.value));
    return { result: { value } };
  }
  if (method === 'Page.printToPDF') return pdfPayload;
  if (method === 'Runtime.evaluate') {
    return { result: { value: params.expression.includes('document.querySelector') ? null : 'complete' } };
  }
  return {};
};
after(() => { cdp.send = realSend; cdp.ensure = realEnsure; });

const navigated = [];
const createdUrls = [];
const realUpdate = chrome.tabs.update;
const realCreate = chrome.tabs.create;
chrome.tabs.update = async (tabId, props) => { navigated.push(props.url); return { ...props, id: tabId }; };
chrome.tabs.create = async (opts) => { createdUrls.push(opts.url); return { id: 1, windowId: 1, url: 'about:blank', title: 'stub' }; };
after(() => { chrome.tabs.update = realUpdate; chrome.tabs.create = realCreate; });

// ============================================================ 4. search URL building
console.log('\n[4] search: constant table + encodeURIComponent');
const TRICKY = '"><script>alert(1)</script> 中文 &x=1';
for (const [engine, param] of [['ddg', 'q'], ['google', 'q'], ['bing', 'q'], ['baidu', 'wd'], ['sogou', 'query']]) {
  const built = quick.searchUrl(engine, TRICKY);
  ok(`${engine}: query round-trips through searchParams`,
    new URL(built.url).searchParams.get(param) === TRICKY, built.url);
  ok(`${engine}: no raw markup/space/ampersand survives in the query string`,
    !/[<>"& ]/.test(new URL(built.url).search.slice(1)), built.url);
  ok(`${engine}: host and path come from the table`, built.url.startsWith('https://'), built.url);
}
ok('google/bing/baidu take a result-count knob',
  /num=5/.test(quick.searchUrl('google', TRICKY, 5).url) &&
  /count=5/.test(quick.searchUrl('bing', TRICKY, 5).url) &&
  /rn=5/.test(quick.searchUrl('baidu', TRICKY, 5).url));
ok('ddg/sogou report count_applied:false instead of inventing a param',
  quick.searchUrl('ddg', TRICKY, 5).count_applied === false && quick.searchUrl('sogou', TRICKY, 5).count_applied === false);
const offTable = await grab(async () => quick.searchUrl('yahoo', 'x'));
ok('searchUrl refuses an engine outside the table', offTable.e?.code === 'BAD_PARAMS' && /ddg\|google/.test(offTable.e.message), describe(offTable.e));

const injection = await grab(async () => quick.searchUrl('ddg', 'x$(rm -rf)'));
ok('searchUrl treats shell-ish text as data only',
  !injection.e && new URL(injection.r.url).searchParams.get('q') === 'x$(rm -rf)' && !injection.r.url.includes('$'),
  JSON.stringify(injection.r));
const emptyQ = await grab(async () => quick.searchUrl('ddg', '   '));
ok('searchUrl refuses an empty query', emptyQ.e?.code === 'BAD_PARAMS', describe(emptyQ.e));

const sameTab = await call('search', { query: TRICKY, engine: 'baidu', new_tab: false, timeout_ms: 500 });
ok('search(new_tab:false) navigates the target tab with the encoded URL',
  navigated.length === 1 && new URL(navigated[0]).searchParams.get('wd') === TRICKY, String(navigated[0]));
ok('search returns url/title/engine/loaded/hint',
  typeof sameTab.url === 'string' && 'title' in sameTab && sameTab.engine === 'baidu' && 'loaded' in sameTab && /snapshot/.test(sameTab.hint),
  JSON.stringify(sameTab));

const newTab = await call('search', { query: TRICKY, timeout_ms: 500 });
ok('search defaults to a new session tab',
  createdUrls.length === 1 && new URL(createdUrls[0]).searchParams.get('q') === TRICKY && newTab.tab_id === 1, String(createdUrls));
ok('search default engine is ddg', newTab.engine === 'ddg', newTab.engine);
const maxNote = await call('search', { query: 'quantum tunneling', max_results: 5, timeout_ms: 500 });
ok('max_results on an engine without the knob returns a note, not a fake param',
  /no result-count/.test(maxNote.note || '') && !/max_results=|num=/.test(createdUrls[createdUrls.length - 1]), String(maxNote.note));
const urlQuery = await call('search', { query: 'www.example.com/pricing', timeout_ms: 500 });
ok('a URL-looking query is opened as a page, with a note',
  createdUrls[createdUrls.length - 1] === 'https://www.example.com/pricing' && /looks like a URL/.test(urlQuery.note) && urlQuery.engine === 'url',
  String(createdUrls[createdUrls.length - 1] || urlQuery.note));
const blocked = await grab(() => call('search', { query: 'chrome://settings', timeout_ms: 500 }));
ok('a restricted-URL query is refused (URL_BLOCKED)', blocked.e?.code === 'URL_BLOCKED', describe(blocked.e));

// ============================================================ 5. dropdown_options
console.log('\n[5] dropdown_options via backendNodeId→nodeId→objectId, then Runtime.callFunctionOn');
const refSel = refs.put(1, 4242, { role: 'combobox', name: 'Country' });
const refCombo = refs.put(1, 4243, { role: 'combobox', name: 'Sort' });
const refList = refs.put(1, 4244, { role: 'listbox', name: 'Colours' });

const dd = await call('dropdown_options', { ref: refSel, tab_id: 1 });
const ddCall = cdpCalls.filter((c) => c.method === 'Runtime.callFunctionOn').pop();
ok('reads a closed <select>: total/options/truncated at the 500 cap',
  dd.tag === 'select' && dd.total === 501 && dd.options.length === 500 && dd.truncated === true,
  JSON.stringify({ tag: dd.tag, total: dd.total, n: dd.options?.length }));
ok('entries are {index,value,text,selected} with whitespace collapsed',
  dd.options[3].index === 3 && dd.options[3].value === 'v3' && dd.options[3].text === 'Opt 3' &&
  dd.options[3].selected === false && dd.options[7].selected === true, JSON.stringify(dd.options[3]));
ok('multiple/disabled are reported', dd.multiple === false && dd.disabled === false);
ok('the node is addressed by a resolved objectId — Runtime.callFunctionOn has NO backendNodeId parameter (the live -32602), no marker round-trip',
  typeof ddCall.params.objectId === 'string' && ddCall.params.backendNodeId === undefined &&
    !JSON.stringify(ddCall.params).includes('data-ubb-tmp'),
  JSON.stringify(Object.keys(ddCall.params)));
ok('the ref→objectId chain really went pushNodes(4242)→resolveNode(5242) before the call',
  cdpCalls.some((c) => c.method === 'DOM.pushNodesByBackendIdsToFrontend' && c.params.backendNodeIds[0] === 4242) &&
    cdpCalls.some((c) => c.method === 'DOM.resolveNode' && c.params.nodeId === 5242),
  JSON.stringify(cdpCalls.map((c) => c.method)));
const rcWire = await grab(() => {
  validateCdpParams('Runtime.callFunctionOn', { backendNodeId: 4242, functionDeclaration: 'function(){}', returnByValue: true, awaitPromise: true });
});
ok('RC-mock: the OLD wire shape (backendNodeId on callFunctionOn) is red at the parameter contract',
  !!rcWire.e && /backendNodeId/.test(rcWire.e.message), describe(rcWire.e));
ok('the page function goes over as functionDeclaration with the limit as an argument',
  /^function readDropdown/.test(ddCall.params.functionDeclaration) && ddCall.params.arguments?.[0]?.value === 500);

const closed = await call('dropdown_options', { ref: refCombo, tab_id: 1 });
ok('a custom ARIA combobox returns the expand-it-first note instead of guessing',
  closed.options.length === 0 && /ax\.action \{action:'expand'\}/.test(closed.note), JSON.stringify(closed));
const openLb = await call('dropdown_options', { ref: refList, tab_id: 1 });
ok('an already-rendered listbox reports its in-DOM options with aria-selected',
  openLb.total === 2 && openLb.options[1].selected === true && /currently rendered/.test(openLb.note), JSON.stringify(openLb));

const badRef = await grab(() => call('dropdown_options', { ref: '@e999', tab_id: 1 }));
ok('an unknown ref keeps the refs error code (REF_UNKNOWN)', badRef.e?.code === 'REF_UNKNOWN', describe(badRef.e));
NODES.delete(4242);
const gone = await grab(() => call('dropdown_options', { ref: refSel, tab_id: 1 }));
ok('a node that left the document maps to REF_STALE with a snapshot hint',
  gone.e?.code === 'REF_STALE' && /snapshot/.test(gone.e.message), describe(gone.e));
NODES.set(4242, SELECT);
const noMatch = await grab(() => call('dropdown_options', { selector: '#in-a-shadow-root', tab_id: 1 }));
ok('the light-DOM selector path says "shadow DOM needs a ref" when it finds nothing',
  noMatch.e?.code === 'SELECTOR_FAILED' && /shadow/i.test(noMatch.e.message), describe(noMatch.e));

// ============================================================ 6. print_pdf
console.log('\n[6] print_pdf');
const small = Buffer.from('%PDF-1.4 tiny').toString('base64');
pdfPayload = { data: small };
const p1 = await call('print_pdf', { tab_id: 1, landscape: true, scale: 0.8, paper_width: 8.27, paper_height: 11.69, margins: 1.5, print_background: false });
const lastPdf = () => cdpCalls.filter((c) => c.method === 'Page.printToPDF').pop();
ok('returns {format,bytes,data_base64,filename_suggested}',
  p1.format === 'pdf' && p1.data_base64 === small && p1.bytes === Math.round((small.length * 3) / 4) && /\.pdf$/.test(p1.filename_suggested),
  JSON.stringify({ ...p1, data_base64: `${String(p1.data_base64).length}b` }));
ok('CDP params keep inch/cm semantics; print_background:false only when asked',
  lastPdf().params.paperWidth === 8.27 && lastPdf().params.paperHeight === 11.69 && lastPdf().params.scale === 0.8 &&
  lastPdf().params.landscape === true && lastPdf().params.printBackground === false &&
  lastPdf().params.marginTop === 1.5 && lastPdf().params.marginRight === 1.5, JSON.stringify(lastPdf().params));
await call('print_pdf', { tab_id: 1 });
ok('print_background defaults to true', lastPdf().params.printBackground === true);
ok('a small payload keeps data_base64 and has no too_big', !!p1.data_base64 && !p1.too_big);

pdfPayload = { data: 'A'.repeat(Math.ceil((3.2 * 1024 * 1024) / 0.75)) };
const big = await call('print_pdf', { tab_id: 1 });
ok('over 3MB: too_big + bytes + note and NO base64 in the payload',
  big.too_big === true && big.bytes > 3 * 1024 * 1024 && big.data_base64 === undefined && /--out/.test(big.note),
  JSON.stringify({ ...big, note: String(big.note).slice(0, 60) }));
ok('the too_big note names the CLI path that saves it', /ubb print_pdf --out/.test(big.note || ''), String(big.note).slice(0, 90));
const forced = await call('print_pdf', { tab_id: 1, include_base64: true });
ok('include_base64:true is the --out refetch path', forced.data_base64?.length > 1e6 && !forced.too_big);
await call('print_pdf', { tab_id: 1, tag_selection: { strategy: 'include' } });
ok('tag_selection is forwarded together with displayTags', lastPdf().params.displayTags === true);

// ---------------- fix7dl-3: every tag_selection shape lands, or it is refused
// The live finding (LIVE-RESULTS-2B 6e): `tag_selection:true` passed the old
// `typeof === "object"` gate, never reached args, and the call still returned ok.
pdfPayload = { data: small };
await call('print_pdf', { tab_id: 1 });
const bareParams = lastPdf().params;
ok('a call without tag_selection sends NEITHER CDP tag param (the baseline the shapes must move)',
  !('displayTags' in bareParams) && !('tagSelection' in bareParams), JSON.stringify(bareParams));
const tsTrue = await call('print_pdf', { tab_id: 1, tag_selection: true });
ok('tag_selection:true is not dropped: displayTags:true reaches Page.printToPDF',
  lastPdf().params.displayTags === true && tsTrue.format === 'pdf', JSON.stringify(lastPdf().params));
ok('tag_selection:true answers with what was actually sent',
  typeof tsTrue.tag_selection_applied === 'string' && /displayTags/.test(tsTrue.tag_selection_applied),
  String(tsTrue.tag_selection_applied));
const tsFalse = await call('print_pdf', { tab_id: 1, tag_selection: false });
ok('tag_selection:false is honoured as off and REPORTED as off (no silent ignore)',
  !('displayTags' in lastPdf().params) && /neither/i.test(tsFalse.tag_selection_applied || ''),
  JSON.stringify({ p: lastPdf().params, n: tsFalse.tag_selection_applied }));
const tsObj = await call('print_pdf', { tab_id: 1, tag_selection: { strategy: 'include', tags: ['report'] } });
const objWire = JSON.stringify(lastPdf().params);
ok('the object shape still forwards tagSelection verbatim (+ displayTags, as CDP needs)',
  JSON.stringify(lastPdf().params.tagSelection) === JSON.stringify({ strategy: 'include', tags: ['report'
  ] }) && lastPdf().params.displayTags === true && /tagSelection/.test(tsObj.tag_selection_applied),
  JSON.stringify(lastPdf().params));
for (const [label, bad] of [['a string', 'yes'], ['a number', 1], ['zero', 0], ['an array', ['report']]]) {
  const { e, r } = await grab(() => call('print_pdf', { tab_id: 1, tag_selection: bad }));
  ok(`tag_selection as ${label} → BAD_PARAMS instead of a dropped param`,
    e?.code === 'BAD_PARAMS' && r === null && /tag_selection/.test(String(e?.message)), describe(e));
}
ok('no bad tag_selection shape reaches CDP (the wire is exactly what the object call left)',
  JSON.stringify(lastPdf().params) === objWire, JSON.stringify(lastPdf().params));
// the task bans a functional promise nobody proved: the live PDF shows no marks evidence
ok('print_pdf description teaches both shapes WITHOUT promising tagged output',
  /tag_selection/.test(metas.print_pdf.description) && /NOT a promise/i.test(metas.print_pdf.description),
  metas.print_pdf.description);
ok('the tag_selection answer always points at the PDF as the only proof',
  /NOT proof|verify the produced PDF/.test(tsTrue.tag_selection_applied + tsObj.tag_selection_applied),
  `${tsTrue.tag_selection_applied} | ${tsObj.tag_selection_applied}`);

pdfPayload = { data: 'A'.repeat(Math.ceil((3.2 * 1024 * 1024) / 0.75)) };
const tooBigTag = await call('print_pdf', { tab_id: 1, tag_selection: true });
ok('the too_big shape keeps tag_selection_applied too (the param is never lost on the big path)',
  tooBigTag.too_big === true && /displayTags/.test(tooBigTag.tag_selection_applied || ''), JSON.stringify({ ...tooBigTag, note: undefined }));
pdfPayload = { data: small };

pdfPayload = { data: '' };
const noDoc = await grab(() => call('print_pdf', { tab_id: 1 }));
ok('an empty printToPDF reply becomes PRINT_TO_PDF_FAILED', noDoc.e?.code === 'PRINT_TO_PDF_FAILED', describe(noDoc.e));
const badSize = await grab(() => call('print_pdf', { paper_width: 0, tab_id: 1 }));
ok('paper_width 0 is refused at the boundary', badSize.e?.code === 'BAD_PARAMS', describe(badSize.e));
const badMargin = await grab(() => call('print_pdf', { margins: { left: -2 }, tab_id: 1 }));
ok('a negative margin is refused and names the side', badMargin.e?.code === 'BAD_PARAMS' && /margins\.left/.test(badMargin.e.message), describe(badMargin.e));

// ============================================================ 7. batch
console.log('\n[7] batch re-enters the dispatcher');
const d = new Dispatcher();
quick.register(d);
d.register('click', { category: 'interaction', timeoutMs: 5000 }, async (p) => ({ clicked: p.ref, tab_id: p.tab_id ?? null }));
d.register('boom', { category: 'interaction', timeoutMs: 5000 }, async () => { throw err('BOOM', 'step exploded'); });
d.register('slow', { category: 'interaction', timeoutMs: 250 }, async () => { await new Promise((r) => setTimeout(r, 1200)); return { done: true }; });
// registered on purpose: the refusals below must come from the guard, not from an unknown tool
d.register('session.stop', { category: 'session' }, async () => ({ stopped: true }));
d.register('tab.close', { category: 'tabs' }, async () => ({ closed: 1 }));
d.register('human.set', { category: 'diagnostics' }, async () => ({ human: true }));

const batch = (params) => d.handle({ id: 'B', method: 'tool.batch', params });

const twelve = await batch({ actions: Array.from({ length: 12 }, (_, i) => ({ tool: 'click', params: { ref: `@e${i}` } })) });
ok('12 actions run in one request',
  twelve.result?.executed === 12 && twelve.result.results.every((s) => s.ok),
  JSON.stringify({ executed: twelve.result?.executed, failed_at: twelve.result?.failed_at, first_error: twelve.result?.results.find((s) => !s.ok)?.error }));
ok('13 actions are refused before anything runs',
  (await batch({ actions: Array.from({ length: 13 }, () => ({ tool: 'click' })) })).error?.code === 'BAD_PARAMS');
const nested = await batch({ actions: [{ tool: 'click' }, { tool: 'batch', params: { actions: [] } }] });
ok('nested batch is refused', nested.error?.code === 'BAD_PARAMS' && /nest/.test(nested.error.message), describe(nested.error));
for (const name of ['session.stop', 'tab.close', 'human.set']) {
  const r = await batch({ actions: [{ tool: name }] });
  ok(`batch refuses the terminal/global tool ${name}`, r.error?.code === 'BAD_PARAMS' && r.error.message.includes(name), describe(r.error));
}

const pinned = await batch({ tab_id: 1, actions: [{ tool: 'click', params: { ref: '@e1' } }, { tool: 'click', params: { ref: '@e2' } }] });
ok('inherit_tab stamps the batch tab onto steps that omitted tab_id',
  pinned.result?.results.every((s) => s.ok && s.result.tab_id === 1), JSON.stringify(pinned.result));
const unpinned = await batch({ tab_id: 1, inherit_tab: false, actions: [{ tool: 'click', params: { ref: '@e1' } }] });
ok('inherit_tab:false leaves the steps alone', unpinned.result.results[0].result.tab_id === null, JSON.stringify(unpinned.result));
const explicit = await batch({ tab_id: 1, actions: [{ tool: 'click', params: { ref: '@e1', tab_id: 5 } }] });
ok('a step that names its own tab_id is not overwritten', explicit.result.results[0].result.tab_id === 5, JSON.stringify(explicit.result));

const halt = await batch({ tab_id: 1, actions: [{ tool: 'click' }, { tool: 'boom' }, { tool: 'click' }] });
ok('stop_on_error defaults to true: executed 2, failed_at 1, third never ran',
  halt.result?.executed === 2 && halt.result.failed_at === 1 && halt.result.results.length === 2 &&
  halt.result.results[1].error.code === 'BOOM', JSON.stringify(halt.result));
ok('the failed step carries the tool error code+message, not a value dump',
  halt.result.results[1].error.message === 'step exploded', JSON.stringify(halt.result.results[1].error));
const carryOn = await batch({ tab_id: 1, stop_on_error: false, actions: [{ tool: 'click' }, { tool: 'boom' }, { tool: 'click' }] });
ok('stop_on_error:false runs all three and keeps the failure inline',
  carryOn.result?.executed === 3 && carryOn.result.results[1].ok === false && carryOn.result.results[2].ok === true);
const unknownStep = await batch({ tab_id: 1, actions: [{ tool: 'not.a.registered.tool' }, { tool: 'click' }] });
ok('an unregistered step reports UNKNOWN_TOOL (the dispatcher still owns the catalog)',
  unknownStep.result?.results[0].ok === false && unknownStep.result.results[0].error.code === 'UNKNOWN_TOOL' &&
  unknownStep.result.executed === 1 && unknownStep.result.failed_at === 0, JSON.stringify(unknownStep.result));
const timed = await batch({ tab_id: 1, actions: [{ tool: 'slow' }] });
ok('per-tool timeout is inherited, not bypassed', timed.result?.results[0].error?.code === 'TOOL_TIMEOUT', JSON.stringify(timed.result));

sessions.session = null;
const noSessionStep = await batch({ actions: [{ tool: 'dropdown_options', params: { ref: '@e1' } }] });
ok('a step that needs a session still reports NO_SESSION through batch',
  noSessionStep.result?.results[0].ok === false && noSessionStep.result.results[0].error.code === 'NO_SESSION',
  JSON.stringify(noSessionStep.result));
sessions.session = fakeSession;

// ============================================================ 8. inherit with no tab yet
console.log('\n[8] batch inherit when the first step creates the tab');
d.register('tab.create', { category: 'tabs', timeoutMs: 5000 }, async () => ({ tab_id: 77, in_group: true }));
fakeSession.lastTabId = null;
fakeSession.created.add(77);
const firstCreates = await batch({ actions: [{ tool: 'tab.create' }, { tool: 'click', params: { ref: '@e3' } }] });
ok('the tab_id produced by step 1 is inherited by step 2',
  firstCreates.result?.results[1].result.tab_id === 77, JSON.stringify(firstCreates.result));

// ============================================================ report
for (const fn of cleanups.reverse()) fn();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
