// Wave 2-D frames offline self-check (contract §6.2/§6.3/§6.4) — no browser,
// no daemon:   node daemon/test-frames.mjs
// Reverse controls (§6.3): --lib <alt lib dir> swaps the lib import base;
// use with patched copies (lib_rc1: host offset dropped, lib_rc2: backendNodeIds
// share one ledger across frames, lib_rc3: normalizeUrl/isRestrictedUrl reverted).
// Fake-world routing follows daemon/test-fill.mjs / test-replay.mjs stub patterns.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const arg = (name, dflt) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};
const LIB = new URL(arg('--lib', '../lib') + '/', import.meta.url);
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
const codeOf = async (f) => {
  try { await f(); return 'NO-THROW'; } catch (e) { return e?.code ?? 'plain throw'; }
};

const { installChromeStub, collectRegistry } = await import(new URL('testharness.mjs', LIB));
installChromeStub();
const tabs = await import(new URL('tabs.js', LIB));
const cdpMod = await import(new URL('cdp.js', LIB));
const { normalizeUrl } = tabs;
const { isRestrictedUrl } = cdpMod.cdp;
const { stripLeadingScheme } = cdpMod;
const snapshot = await import(new URL('snapshot.js', LIB));
const { composeFrameBoxes, matchChildrenToFrames, frameChain } = snapshot;
const { refs } = await import(new URL('refs.js', LIB));
const actions = await import(new URL('actions.js', LIB));

// ============================================================ 1. statics / wiring
console.log('\n[1] manifest + bridge wiring (all_frames safety)');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const cs = Object.fromEntries(manifest.content_scripts.map((c) => [c.js[0], c]));
ok('shield stays TOP-ONLY (borders must not multiply)', cs['content/shield.js'] && cs['content/shield.js'].all_frames === false);
ok('bridge injected into EVERY frame', cs['content/bridge.js']?.all_frames === true);
ok('frameblock exists, all_frames, intercepts only', cs['content/frameblock.js']?.all_frames === true && cs['content/frameblock.js']?.run_at === 'document_start');
ok('monitor all_frames too (extension iframes can nest)', cs['content/monitor.js']?.all_frames === true);

const bridgeCtlSrc = fs.readFileSync(new URL('bridge-ctl.js', LIB), 'utf8');
ok('bridge-ctl ALWAYS passes an explicit {frameId} (no broadcast once all_frames)', /sendMessage\(tabId, \{ type: 'UBB_BRIDGE', op, args \}, \{ frameId \}\)/.test(bridgeCtlSrc));
ok('default frame is main (frameId=0)', /export async function bridgeEnvelope\(tabId, op, args = \{\}, frameId = 0\)/.test(bridgeCtlSrc) && /export async function bridge\(tabId, op, args = \{\}, frameId = 0\)/.test(bridgeCtlSrc));

const bridgeSrc = fs.readFileSync(path.join(ROOT, 'content', 'bridge.js'), 'utf8');
for (const opName of ['selfInfo', 'childFrameBoxes', 'describeRef', 'selectDom', 'stampChild', 'unstampChild', 'readStamp']) {
  ok(`bridge.js registers ${opName}`, new RegExp(`api = \\{[^}]*\\b${opName}\\b`, 's').test(bridgeSrc) || new RegExp(`\\b${opName}(?=[,\\s])`, 'g').test(bridgeSrc.match(/const api = \{[\s\S]*?\};/)[0]));
}
ok('bridge.js echoes frameId + docEpoch in the envelope', /sendResponse\(\{ ok: true, result, frameId: sender.frameId, docEpoch: DOC_EPOCH \}\)/.test(bridgeSrc));
ok('bridge.js recordTarget carries the additive ariaRole/frame fields', /ariaRole: el\.computedRole/.test(bridgeSrc) && /frame: window\.self !== window top?|frame: window\.self !== window\.top/.test(bridgeSrc));
ok('bridge.js keypress records a target', /type: 'keypress'[^}]*target: recordTarget\(e\.target\)/.test(bridgeSrc));
ok('bridge.js input records inputType', /type: 'input'[^}]*inputType: e\.target\.type/.test(bridgeSrc));
ok('the old visible(el) op got an args-object wrapper', /function visibleOp\(\{ selector, ref/.test(bridgeSrc));

const frameblockSrc = fs.readFileSync(path.join(ROOT, 'content', 'frameblock.js'), 'utf8');
ok('frameblock skips the top frame (shield owns it)', /if \(window\.top === window\.self\) return;/.test(frameblockSrc));
ok('frameblock NEVER sendResponses (must not steal shield.js reply slot)', !/sendResponse\(/.test(frameblockSrc));
ok('frameblock mutates nothing (no style/element writes)', !/document\.documentElement\.appendChild|createElement/.test(frameblockSrc));

const actionsSrc = fs.readFileSync(new URL('actions.js', LIB), 'utf8');
ok('guardSensitiveField 4-arg signature intact (Wave-2 deliverable, must not break)', /export async function guardSensitiveField\(tabId, nodeId, meta, opts = \{\}\)/.test(actionsSrc));
ok('callOnNode is still the canonical node path', /export async function callOnNode\(tabId, backendNodeId, functionDeclaration, args = \[\]\)/.test(actionsSrc));

// ============================================================ 2. frame offset math
console.log('\n[2] composeFrameBoxes (viewport penetration math)');
{
  const step = { x: 150, y: 250, width: 300, height: 200, borderLeft: 0, borderTop: 0, childInnerWidth: 300, childInnerHeight: 200 };
  const local = { x: 20, y: 30, width: 100, height: 24 };
  const b = composeFrameBoxes([step], local);
  ok('one hop: host offset + local rect', b.x === 170 && b.y === 280 && b.width === 100 && b.height === 24, JSON.stringify(b));
  ok('center point for Input.dispatchMouseEvent', b.cx === 220 && b.cy === 292, JSON.stringify(b));

  const outer = { x: 100, y: 100, width: 400, height: 200, borderLeft: 2, borderTop: 3, childInnerWidth: 800, childInnerHeight: 400 };
  const inner = { x: 40, y: 50, width: 200, height: 100, borderLeft: 0, borderTop: 0, childInnerWidth: 200, childInnerHeight: 100 };
  const n = composeFrameBoxes([outer, inner], { x: 10, y: 20, width: 50, height: 10 });
  // innermost first: (40+10, 50+20) then scale 0.5 + border + host offset: (100+2+50*.5, 100+3+70*.5)
  ok('two nested hops compose inside-out', n.x === 127 && n.y === 138, JSON.stringify(n));
  ok('CSS-scaled host frame scales the payload box too', n.width === 25 && n.height === 5, JSON.stringify(n));

  const scrolledHost = { x: 150, y: -150, width: 300, height: 200, borderLeft: 0, borderTop: 0, childInnerWidth: 300, childInnerHeight: 200 };
  const s = composeFrameBoxes([scrolledHost], { x: 20, y: 30, width: 100, height: 24 });
  ok('host page scroll is already inside the measured rect and propagates', s.y === -120, JSON.stringify(s));

  const childScrolled = composeFrameBoxes([step], { x: 20, y: -70, width: 100, height: 24 });
  ok('child-internal scroll lands in the composed box (element can leave the viewport)', childScrolled.y === 180 && childScrolled.cy === 192, JSON.stringify(childScrolled));

  const dprStep = { ...step, devicePixelRatio: 2 };
  const d = composeFrameBoxes([dprStep], local);
  ok('devicePixelRatio does NOT enter the math (CDP input is CSS px)', d.x === 170 && d.y === 280, JSON.stringify(d));

  const border = { x: 10, y: 10, width: 300, height: 200, borderLeft: 5, borderTop: 6, childInnerWidth: 295, childInnerHeight: 194 };
  const bb = composeFrameBoxes([border], { x: 0, y: 0, width: 50, height: 20 });
  ok('iframe border offsets (clientLeft/clientTop) shift the content origin', bb.x === 15 && bb.y === 16, JSON.stringify(bb));

  const rc = await grab(async () => composeFrameBoxes([], local));
  ok('empty chain (main frame) = identity', JSON.stringify(composeFrameBoxes([], local)) === JSON.stringify({ ...local, cx: local.x + local.width / 2, cy: local.y + local.height / 2 }));
  void rc;
}

// ============================================================ 3. pairing
console.log('\n[3] matchChildrenToFrames (ext frame ↔ <iframe> element, no guessing)');
{
  const dom = [
    { order: 0, src: 'https://a.test/x', liveUrl: '', sameOrigin: false, name: '' },
    { order: 1, src: 'about:blank', liveUrl: 'https://b.test/y', sameOrigin: true, name: '' },
  ];
  const ext = [
    { frameId: 2, url: 'https://a.test/x', name: '' },
    { frameId: 3, url: 'https://b.test/y', name: '' },
  ];
  const r = matchChildrenToFrames(ext, dom);
  ok('src match pairs a cross-origin child', r.pairs.some((p) => p.frameId === 2 && p.order === 0));
  ok('same-origin liveUrl wins over the stale src (navigated frame)', r.pairs.some((p) => p.frameId === 3 && p.order === 1), JSON.stringify(r));

  const dupDom = [
    { order: 0, src: 'https://a.test/x', liveUrl: '', sameOrigin: false, name: 'left' },
    { order: 1, src: 'https://a.test/x', liveUrl: '', sameOrigin: false, name: 'right' },
  ];
  const dupExt = [
    { frameId: 4, url: 'https://a.test/x', name: 'right' },
    { frameId: 5, url: 'https://a.test/x', name: 'left' },
  ];
  const rn = matchChildrenToFrames(dupExt, dupDom);
  ok('same-url siblings disambiguated by the name attribute', rn.pairs.length === 2 && rn.pairs.find((p) => p.frameId === 4).order === 1 && rn.pairs.find((p) => p.frameId === 5).order === 0, JSON.stringify(rn.pairs));

  const nameless = [
    { order: 0, src: 'https://a.test/x', liveUrl: '', sameOrigin: false, name: '' },
    { order: 1, src: 'https://a.test/x', liveUrl: '', sameOrigin: false, name: '' },
  ];
  const ra = matchChildrenToFrames(dupExt.map((e) => ({ ...e, name: '' })), nameless);
  ok('truly ambiguous pairs are REPORTED, never assigned at random', ra.pairs.length === 0 && ra.unresolved.length === 2 && ra.unresolved[0].reason === 'ambiguous-same-url' && ra.unresolved[0].candidateOrders.join() === '0,1', JSON.stringify(ra));

  const rm = matchChildrenToFrames([{ frameId: 9, url: 'https://gone.test', name: '' }], dom);
  ok('frame with no DOM element at all → no-matching-element (src swapped/nested)', rm.unresolved[0]?.reason === 'no-matching-element', JSON.stringify(rm));

  const rb = matchChildrenToFrames([{ frameId: 10, url: 'about:blank', name: '' }], [{ order: 0, src: '', liveUrl: '', sameOrigin: true, name: '' }]);
  ok('attribute-less <iframe> pairs with an about:blank child', rb.pairs[0]?.frameId === 10 && rb.pairs[0]?.order === 0, JSON.stringify(rb.pairs));

  const usedTwice = matchChildrenToFrames(
    [{ frameId: 2, url: 'https://a.test/x', name: '' }, { frameId: 3, url: 'https://a.test/x', name: '' }],
    [{ order: 0, src: 'https://a.test/x', liveUrl: '', sameOrigin: false, name: '' }],
  );
  ok('one element cannot be paired to two frames (first takes it, second unresolved)', usedTwice.pairs.length === 1 && usedTwice.unresolved.length === 1, JSON.stringify(usedTwice));
}

// ============================================================ 4. frame chain
console.log('\n[4] frameChain (parent walking via webNavigation ids)');
{
  const all = [
    { frameId: 0, parentFrameId: -1 },
    { frameId: 2, parentFrameId: 0 },
    { frameId: 7, parentFrameId: 2 },
  ];
  ok('two-level chain from the top', frameChain(all, 7).join() === '0,2,7', JSON.stringify(frameChain(all, 7)));
  ok('the top frame alone is a one-entry chain (steps need ≥2, guarded by frameStepsFor)', frameChain(all, 0).join() === '0', JSON.stringify(frameChain(all, 0)));
  ok('a frame not in the list returns null (gone)', frameChain(all, 99) === null);
  const cyc = [{ frameId: 0, parentFrameId: 3 }, { frameId: 3, parentFrameId: 0 }];
  ok('parent loops terminate (guard, no infinite walk)', (() => { const r = frameChain(cyc, 3); return r === null || r.length <= 64; })());
}

// ============================================================ 5. ref frame namespace
console.log('\n[5] refs: frame dimension, @eN appearance untouched');
{
  const a = refs.put(101, 999, { role: 'button', name: 'main' });
  const b = refs.put(101, 999, { role: 'button', name: 'framed', frameId: 2, domRef: '@d5', epoch: 'e1' });
  ok('@eN appearance is preserved (Wave 1 regex-safe)', /^@e\d+$/.test(a) && /^@e\d+$/.test(b), `${a} ${b}`);
  ok('names never collide across frames even with the SAME backendNodeId', a !== b);
  const ea = refs.get(101, a);
  const eb = refs.get(101, b);
  ok('main-frame entry defaults to frameId 0', ea.frameId === 0);
  ok('frame entry carries frameId + domRef + epoch', eb.frameId === 2 && eb.domRef === '@d5' && eb.epoch === 'e1', JSON.stringify(eb));
  ok('cross-frame collision of the same backendNodeId is DETECTED', refs.collides(101, ea) === true && refs.collides(101, eb) === true);
  const solo = refs.put(101, 555, { role: 'link', name: 'x' });
  ok('no false collision for a lone backendNodeId', refs.collides(101, refs.get(101, solo)) === false);
  const same = refs.put(101, 555, { role: 'link', name: 'x', frameId: 0 });
  ok('same frame + same backend = re-registration, not a cross-frame collision', refs.collides(101, refs.get(101, same)) === false);
  refs.bump(101);
  // bump() clears the tables AND bumps the generation (Wave 1 behavior): the
  // next get is REF_UNKNOWN; REF_STALE stays reserved for stores that survive
  ok('navigation bump still kills frame refs', (await codeOf(async () => refs.get(101, b))) === 'REF_UNKNOWN');
  const c1 = refs.put(202, 777, { role: 'button', name: 'n' });
  refs.invalidate(202);
  ok('invalidate still wins over frame bookkeeping', (await codeOf(async () => refs.get(202, c1))) === 'REF_UNKNOWN');
  ok('BAD_REF message shape unchanged', (await codeOf(async () => refs.get(101, '@x'))) === 'BAD_REF');
  void c1;
}

// ============================================================ 6. URL gate (A's hole, closed at the shared layer)
console.log('\n[6] normalizeUrl / isRestrictedUrl — the chrome:// laundering bypass');
{
  ok('chrome://settings keeps its scheme (was laundered to https://chrome://…)', normalizeUrl('chrome://settings') === 'chrome://settings', normalizeUrl('chrome://settings'));
  ok('edge://downloads passes through unprefixed', normalizeUrl('edge://downloads') === 'edge://downloads');
  ok('file:// keeps its scheme (unchanged from Wave 1 — it was already whitelisted)', normalizeUrl('file:///C:/x/y.html') === 'file:///C:/x/y.html');
  ok('blob:/javascript:/data: are no longer prefixed either', normalizeUrl('blob:https://a.test/uuid') === 'blob:https://a.test/uuid' && normalizeUrl('javascript:alert(1)') === 'javascript:alert(1)' && normalizeUrl('data:text/html,x') === 'data:text/html,x');
  ok('bare host still gets https:// (main use case preserved)', normalizeUrl('example.com') === 'https://example.com' && normalizeUrl('sub.example.com:8443/p?q=1#f') === 'https://sub.example.com:8443/p?q=1#f');
  ok('about:blank survives untouched (tab.create default)', normalizeUrl('about:blank') === 'about:blank');
  ok('garbage without a host shape is refused instead of laundered', (await codeOf(async () => normalizeUrl('hello world'))) === 'BAD_URL' && (await codeOf(async () => normalizeUrl('   '))) === 'BAD_URL');
  ok('empty/non-string still BAD_URL', (await codeOf(async () => normalizeUrl(''))) === 'BAD_URL' && (await codeOf(async () => normalizeUrl(42))) === 'BAD_URL');

  ok('isRestrictedUrl: direct chrome:// / edge:// / store', isRestrictedUrl('chrome://settings') && isRestrictedUrl('edge://version') && isRestrictedUrl('https://chrome.google.com/webstore/x') && isRestrictedUrl('chrome-extension://abc/p.html'));
  ok('isRestrictedUrl: a laundered https://chrome:// shape is caught too', isRestrictedUrl('https://chrome://settings') && isRestrictedUrl('http://chrome-extension://x'));
  ok('isRestrictedUrl: script pseudo-schemes are refused', isRestrictedUrl('javascript:alert(1)') && isRestrictedUrl('blob:https://x/y') && isRestrictedUrl('data:text/html,<script>'));
  ok('isRestrictedUrl: normal pages and about:blank are NOT restricted', !isRestrictedUrl('https://example.com') && !isRestrictedUrl('about:blank') && !isRestrictedUrl('file:///C:/x'));
  ok('no false positives on substrings inside the path', !isRestrictedUrl('https://example.com/docs?next=javascript:start') && !isRestrictedUrl('https://read.chrome.dev/guide'));
  ok('stripLeadingScheme peels exactly one layer', stripLeadingScheme('https://chrome://x') === 'chrome://x' && stripLeadingScheme('example.com') === 'example.com');

  {
    // the bypass COMPOSITION (this is exactly how A's hole worked): laundering ×
    // a gate that only looks at the outer scheme. Both fixes off → the laundered
    // URL sails into tabs.update as a "normal https" page (RC3 reproduces it red).
    let laundered;
    try { laundered = normalizeUrl('chrome://settings'); } catch { laundered = 'THREW'; }
    const gateBlind = /^https?:\/\//i.test(laundered) && !isRestrictedUrl(laundered);
    ok('gate composition: chrome:// can NEVER reach tabs.update dressed as https://', !gateBlind, `normalizeUrl gave ${JSON.stringify(laundered)}, gate blind: ${gateBlind}`);
  }
}

// ============================================================ 7. registry (offline, contract §6.2)
console.log('\n[7] offline registry: frames.* tools');
const reg = await collectRegistry();
ok('frames.list and frames.probe are registered', reg.names.includes('frames.list') && reg.names.includes('frames.probe'), reg.names.filter((n) => n.startsWith('frames.')).join());
ok('frames.probe carries category + a long description + 60s timeout', reg.metas['frames.probe']?.category === 'diagnostics' && reg.metas['frames.probe'].description.length > 120 && reg.metas['frames.probe'].timeoutMs === 60000);
ok('frames.probe description declares itself READ-ONLY', /READ-ONLY/i.test(reg.metas['frames.probe'].description));
ok('without a session both refuse with NO_SESSION', (await codeOf(() => reg.call('frames.list', {}))) === 'NO_SESSION' && (await codeOf(() => reg.call('frames.probe', {}))) === 'NO_SESSION');
ok('snapshot/find/extract/read_page descriptions mention the frame parameters', /frame\[N\]|frame_id/.test(reg.metas['read_page'].description) && /@d<frameId>/.test(reg.metas.find.description) && /frames:false/.test(reg.metas.snapshot.description));

const { sessions } = await import(new URL('tabs.js', LIB));
await sessions.start({});
sessions.session.created.add(1);
const fakeSession = {
  tabId: 1, queue: Promise.resolve(), gen: 1, frameId: 'MAIN',
  console: [], net: [], dialogs: [], enabledDomains: new Set(['Accessibility']), domFetched: true, frames: new Map(),
};
const cdp = actions.cdp;
const realEnsure = cdp.ensure;
const realSend = cdp.send;
const realBuffers = cdp.buffers;
cdp.ensure = async () => {};
cdp.buffers = () => fakeSession;

const TOP = 'https://top.test/page';
const PAY = 'https://pay.test/checkout';
const EXT_FRAMES = [
  { frameId: 0, parentFrameId: -1, url: TOP },
  { frameId: 2, parentFrameId: 0, url: PAY },
];
chrome.webNavigation.getAllFrames = async () => EXT_FRAMES.map((f) => ({ ...f, name: '' }));

// ============================================================ 8. fake frame world end-to-end
console.log('\n[8] fake frame world: snapshot sections + coordinate actions + gates');

function mkWorld(w) {
  return {
    ...w,
    stampedAttr: null,
    stampedName: null,
    handle(op, args = {}) {
      switch (op) {
        case 'selfInfo':
          return { epoch: this.epoch, url: this.url, origin: this.origin, title: 'w', isFrame: this.frameId !== 0, sameOriginAncestry: this.sameOriginAncestry, name: '', stamp: null, innerWidth: this.innerWidth, innerHeight: this.innerHeight, dpr: 1, scroll: { x: 0, y: 0 } };
        case 'getDomTree': {
          const entries = this.entries.map((e, i) => ({ ref: `@d${i + 1}`, role: e.role, name: e.name, depth: 1 }));
          return { text: entries.map((e) => `  ${e.ref} ${e.role} "${e.name}"`).join('\n'), ref_count: entries.length, entries };
        }
        case 'childFrameBoxes':
          return { frames: this.children.map((c, order) => ({ order, tag: 'iframe', id: '', name: c.name || '', src: c.src, liveUrl: c.sameOrigin ? c.liveUrl : '', sameOrigin: c.sameOrigin, rect: c.rect, borderLeft: c.borderLeft || 0, borderTop: c.borderTop || 0 })) };
        case 'describeRef': {
          const idx = args.ref ? Number(String(args.ref).slice(2)) - 1 : (args.refIdx ?? 0);
          const el = this.entries[idx];
          if (!el) throw new Error('stale DOM ref: ' + args.ref);
          const rect = el.rect;
          return { ref: args.ref, tag: 'button', role: el.role, name: el.name, local: rect, box: rect, visible: true, disabled: false, checked: el.checked, attributes: el.attributes || { type: el.type }, sensitive: el.sensitive || { never: false, password: false } };
        }
        case 'getPageText':
          return { text: 'page text of ' + this.url, url: this.url, title: 'w' };
        case 'extractData':
          return { mode: 'table', tables: [], coverage: { tables: 0, truncated: false }, warnings: [], url: this.url, title: 'w' };
        case 'selectDom':
          return { selected: args.value, synthetic: true };
        case 'fillDom':
          return true;
        case 'clickDom':
          return true;
        case 'search':
          return { matches: this.entries.map((e, i) => ({ ref: `@d${i + 1}`, role: e.role, name: e.name, score: 5, tag: 'button' })).slice(0, args.limit || 10) };
        case 'stampChild': {
          const target = this.childWorlds?.[args.order];
          if (!target || !target.stampSupported) return { ok: false, error: 'child rejects stamps (simulated)' };
          if (args.via === 'attr') target.stampedAttr = args.token;
          else target.stampedName = args.token;
          return { ok: true, restore: '' };
        }
        case 'unstampChild': {
          const t2 = this.childWorlds?.[args.order];
          if (t2) { t2.stampedAttr = null; t2.stampedName = null; }
          return { ok: true };
        }
        case 'readStamp':
          return { name: this.stampedName || '', stamp: this.stampedAttr };
        default:
          throw new Error('fake world: unhandled op ' + op);
      }
    },
  };
}

const w2 = mkWorld({
  frameId: 2, url: PAY, origin: 'https://pay.test', epoch: 'e-poison', sameOriginAncestry: false,
  innerWidth: 300, innerHeight: 200, stampSupported: true,
  children: [],
  entries: [
    { role: 'button', name: 'Save draft', rect: { x: 20, y: 30, width: 100, height: 24 } },
    { role: 'textbox', name: 'Card note', type: 'text', rect: { x: 20, y: 90, width: 200, height: 20 } },
    { role: 'textbox', name: 'password', type: 'password', rect: { x: 20, y: 90, width: 200, height: 20 }, sensitive: { never: false, password: true } },
    { role: 'textbox', name: 'cvv', type: 'text', rect: { x: 20, y: 90, width: 200, height: 20 }, sensitive: { never: true, password: false } },
    { role: 'button', name: 'Pay invoice', rect: { x: 10, y: 10, width: 50, height: 20 } },
    { role: 'combobox', name: 'Country', rect: { x: 20, y: 90, width: 200, height: 20 } },
  ],
});
const w3 = mkWorld({
  frameId: 3, url: 'https://dup.test/x', origin: 'https://dup.test', epoch: 'e3', sameOriginAncestry: false,
  innerWidth: 100, innerHeight: 100, stampSupported: false, children: [],
  entries: [{ role: 'button', name: 'dup one', rect: { x: 5, y: 5, width: 10, height: 10 } }],
});
const worlds = {
  0: mkWorld({
    frameId: 0, url: TOP, origin: 'https://top.test', epoch: 'e-top', sameOriginAncestry: true,
    innerWidth: 1280, innerHeight: 800, children: [{ src: PAY, sameOrigin: false, rect: { x: 150, y: 250, width: 300, height: 200 } }],
    entries: [{ role: 'link', name: 'top link', rect: { x: 1, y: 1, width: 5, height: 5 } }],
  }),
  2: w2,
  3: w3,
};
worlds[0].childWorlds = { 0: w2 }; // fake knows order→frame (a real parent only knows the element)

let sentRoute = [];
let broadcasts = [];
const realSendMsg = chrome.tabs.sendMessage;
chrome.tabs.sendMessage = async (tabId, msg, opts) => {
  if (msg?.type !== 'UBB_BRIDGE') { broadcasts.push(msg); return { ok: true, state: { mode: 'off' } }; }
  const fid = opts?.frameId;
  sentRoute.push({ op: msg.op, frameId: fid, args: msg.args });
  const w = worlds[fid];
  if (!w) throw new Error('could not establish connection. Receiving end does not exist.');
  return { ok: true, result: w.handle(msg.op, msg.args), frameId: fid, docEpoch: w.epoch };
};
let cdpCalls = [];
const MAIN_AX = [
  { nodeId: '1', role: { value: 'RootWebArea' }, name: { value: 'top' }, childIds: ['2', '3', '4'], ignored: false },
  { nodeId: '2', role: { value: 'link' }, name: { value: 'top link' }, backendDOMNodeId: 4001, ignored: false, childIds: [] },
  { nodeId: '3', role: { value: 'button' }, name: { value: 'top btn' }, backendDOMNodeId: 4002, ignored: false, childIds: [] },
  { nodeId: '4', role: { value: 'textbox' }, name: { value: 'top q' }, backendDOMNodeId: 4003, ignored: false, childIds: [] },
];
// the fake runtime-handle ledger: DOM.resolveNode mints objectId → the backendNodeId
// it was minted for, so callFunctionOn can only address a node that really resolved.
// MINTED survives releaseObject so the wiring assertions can still read the trail.
const OBJS = new Map();
const MINTED = new Map();
const nodeToBackend = (nodeId) => {
  const fromIndex = MAIN_AX.find((n) => String(n.nodeId) === String(nodeId));
  if (fromIndex) return fromIndex.backendDOMNodeId;
  const n = Number(nodeId);
  return Number.isFinite(n) && n >= 1000 ? n - 1000 : null; // pushNodes hands back bn + 1000
};
cdp.send = async (tabId, method, params = {}) => {
  cdpCalls.push({ method, params });
  if (method === 'Accessibility.getFullAXTree') return { nodes: MAIN_AX };
  if (method === 'DOM.getFlattenedDocument') return { nodes: MAIN_AX.filter((n) => n.backendDOMNodeId).map((n) => ({ nodeId: n.nodeId, backendNodeId: n.backendDOMNodeId, frameId: 'MAIN' })) };
  if (method === 'DOM.getDocument') return { root: { nodeId: 1, backendNodeId: 1, nodeType: 9, childNodeCount: 0, children: [] } };
  if (method === 'DOM.pushNodesByBackendIdsToFrontend') return { nodeIds: [params.backendNodeIds[0] + 1000] };
  if (method === 'DOM.resolveNode') {
    const objectId = 'o' + params.nodeId;
    const bn = nodeToBackend(params.nodeId);
    OBJS.set(objectId, bn);
    MINTED.set(objectId, bn);
    return { object: { objectId } };
  }
  if (method === 'Runtime.callFunctionOn') {
    const target = OBJS.get(params.objectId);
    if (target == null) {
      throw new Error(`fake CDP: Runtime.callFunctionOn got objectId=${JSON.stringify(params.objectId)}, which no DOM.resolveNode ever minted (keys: ${[...OBJS.keys()].join() || 'none'})`);
    }
    return { result: { value: { addressedAsObjectId: target } } };
  }
  if (method === 'Runtime.releaseObject') { OBJS.delete(params.objectId); return {}; }
  if (method === 'DOM.getBoxModel') return { model: { content: [0, 0, 120, 0, 120, 40, 0, 40] } };
  if (method === 'DOM.getAttributes') return { attributes: ['type', 'text'] };
  if (method === 'Page.captureScreenshot') return { data: 'QUJDRA==' };
  if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'MAIN', url: TOP }, childFrames: [{ frame: { id: 'CDP2', url: PAY, parentId: 'MAIN' } }] } };
  if (method === 'Page.createIsolatedWorld') return { executionContextId: 77 };
  if (method === 'DOM.getFrameOwner') return { backendNodeId: 10, nodeID: 10 };
  if (method === 'Accessibility.getPartialAXTree') return { nodes: [{ properties: [{ name: 'checked', value: { value: false } }] }] };
  return {};
};

const snap = await snapshot.takeSnapshot(1, { filter: 'interactive' });
ok('snapshot main tree is unchanged in shape (AX path still wins)', snap.source === 'accessibility-cdp' && snap.text.includes('@e1 link "top link"'), snap.text.split('\n')[0]);
ok('a frame section header names frame id, url and cross-origin', /# frame\[2\] https:\/\/pay\.test\/checkout · cross-origin · 6 element/.test(snap.text), snap.text.split('\n').find((l) => l.includes('# frame')) || '');
ok('frame refs are indented under the header', /\n {2,}@e\d+ button "Save draft"/.test(snap.text), JSON.stringify(snap.text.slice(snap.text.indexOf('# frame'))));
ok('ref_count includes the frame elements', snap.ref_count === 3 + 6, `${snap.ref_count}`);
const frameRef = (snap.text.match(/@e\d+(?=.*Save draft)/) || [])[0];
const payRef = (snap.text.match(/@e\d+(?=.*Pay invoice)/) || [])[0];
const noteRef = (snap.text.match(/@e\d+(?=.*Card note)/) || [])[0];
const pwRef = (snap.text.match(/@e\d+(?=.*"password")/) || [])[0];
const cvvRef = (snap.text.match(/@e\d+(?=.*"cvv")/) || [])[0];
const selRef = (snap.text.match(/@e\d+(?=.*Country)/) || [])[0];
ok('every frame op in this capture carried an explicit frameId', sentRoute.every((r) => typeof r.frameId === 'number'), JSON.stringify([...new Set(sentRoute.map((r) => r.frameId))]));
const frameEntries = refs.get(1, frameRef);
ok('the snapshot registered the frame ref with {frameId:2, domRef, epoch}', frameEntries.frameId === 2 && frameEntries.domRef === '@d1' && frameEntries.epoch === 'e-poison', JSON.stringify(frameEntries));

{
  const { nodeId, box } = await snapshot.resolveRef(1, frameRef);
  ok('resolveRef(frame ref) → NO CDP node (coordinate path)', nodeId === null);
  ok('box composed: host (150,250) + local (20,30) → (170,280,100,24)', box.x === 170 && box.y === 280 && box.width === 100 && box.height === 24, JSON.stringify(box));
  const rr = await grab(() => snapshot.resolveRef(1, frameRef));
  void rr;
  w2.epoch = 'swapped';
  ok('frame document swap (epoch) → REF_STALE, not a wrong click', (await codeOf(() => snapshot.resolveRef(1, frameRef))) === 'REF_STALE');
  w2.epoch = 'e-poison';
}

{
  cdpCalls = [];
  const r = await reg.call('click', { ref: frameRef, tab_id: 1 });
  const moves = cdpCalls.filter((c) => c.method === 'Input.dispatchMouseEvent');
  ok('click(frame ref) dispatches at the composed CENTER (real input crosses the frame)', moves.length >= 3 && moves[1].params.x === 220 && moves[1].params.y === 292, JSON.stringify(moves.map((m) => [m.params.type, m.params.x, m.params.y])));
  ok('click result reports the coordinate via', r.clicked === frameRef && r.at.join() === '220,292', JSON.stringify(r));
  const bad = await grab(() => reg.call('click', { ref: payRef, tab_id: 1 }));
  ok('DANGEROUS_LABEL gate fires inside a frame too ("Pay invoice" NEEDS_CONFIRM)', bad.e?.code === 'NEEDS_CONFIRM', JSON.stringify(bad.e));
  const okc = await reg.call('click', { ref: payRef, tab_id: 1, confirm: true });
  ok('with confirm:true the frame click lands', okc.clicked === payRef);
}

{
  cdpCalls = [];
  const r = await reg.call('fill', { ref: noteRef, value: 'hello', tab_id: 1 });
  ok('fill(frame ref) → via frame-coords', r.via === 'frame-coords' && r.filled === noteRef, JSON.stringify(r));
  const order = cdpCalls.map((c) => c.method + ':' + (c.params.type ?? c.params.key ?? ''));
  ok('focus is a REAL click, then Ctrl+A, then insertText (all trusted input)', order.join('|').includes('Input.dispatchMouseEvent:mousePressed') && order.some((o) => o === 'Input.dispatchKeyEvent:keyDown' ) && cdpCalls.some((c) => c.method === 'Input.insertText' && c.params.text === 'hello'), JSON.stringify(order));
  const ctrlA = cdpCalls.find((c) => c.method === 'Input.dispatchKeyEvent' && c.params.key === 'a');
  ok('replace semantics: ctrl held (modifiers=2) on the select-all key', ctrlA?.params?.modifiers === 2, JSON.stringify(ctrlA));
}
{
  cdpCalls = [];
  const pw = await grab(() => reg.call('fill', { ref: pwRef, value: 'plaintext', tab_id: 1 }));
  ok('password field INSIDE a frame: SENSITIVE_FIELD, nothing typed', pw.e?.code === 'SENSITIVE_FIELD' && !cdpCalls.some((c) => c.method === 'Input.insertText'), JSON.stringify(pw.e));
  cdpCalls = [];
  const pw2 = await reg.call('fill', { ref: pwRef, value: 'v', tab_id: 1, __ubb_secret_fill: true });
  ok('the stamp unlocks password (same E contract as main frame)', pw2.filled === pwRef && cdpCalls.some((c) => c.method === 'Input.insertText'));
  cdpCalls = [];
  const cvv = await grab(() => reg.call('fill', { ref: cvvRef, value: 'v', tab_id: 1, __ubb_secret_fill: true }));
  ok('NEVER-class inside a frame stays refused WITH the stamp', cvv.e?.code === 'SENSITIVE_FIELD' && !cdpCalls.some((c) => c.method === 'Input.insertText'), JSON.stringify(cvv.e));
}

{
  const shot = await reg.call('screenshot', { ref: frameRef, tab_id: 1 });
  const clip = cdpCalls.filter((c) => c.method === 'Page.captureScreenshot').pop();
  ok('screenshot(ref) clips the COMPOSED frame box', clip?.params?.clip?.x === 170 && clip?.params?.clip?.y === 280 && clip?.params?.clip?.width === 100, JSON.stringify(clip?.params?.clip));
  ok('screenshot packs bytes as usual', shot.bytes > 0 && shot.ref === frameRef);
}

{
  const sf = await reg.call('form.set', { ref: selRef, action: 'select_option', value: 'DE', tab_id: 1 });
  ok('select_option inside a frame routes selectDom to frameId 2 and marks synthetic', sf.via === 'frame-bridge' && sf.result.synthetic === true && sentRoute.at(-1).op === 'selectDom' && sentRoute.at(-1).frameId === 2, JSON.stringify(sf));
  const up = await grab(() => reg.call('upload_file', { ref: frameRef, file: 'x.txt', tab_id: 1 }));
  ok('upload_file on a frame ref refuses with FRAME_UNSUPPORTED (not a silent miss)', up.e?.code === 'FRAME_UNSUPPORTED', JSON.stringify(up.e));
  const info = await reg.call('element.info', { ref: noteRef, tab_id: 1 });
  ok('element.info works on frame refs (composed box + bridge attrs + frame block)', info.box.w === 200 && info.frame?.ext_frame_id === 2 && info.frame.cross_origin === true, JSON.stringify(info));
}

// ambiguous sibling: TWO more frames share one URL; the stamp handshake decides
{
  const dupUrl = 'https://dup.test/x';
  const dupDomChild = { src: dupUrl, sameOrigin: false, rect: { x: 600, y: 100, width: 100, height: 100 } };
  const dupDomChild2 = { src: dupUrl, sameOrigin: false, rect: { x: 900, y: 100, width: 100, height: 100 } };
  worlds[0].children = [worlds[0].children[0], dupDomChild, dupDomChild2];
  worlds[0].childWorlds = { 0: w2, 1: w3, 2: w3 };
  EXT_FRAMES.push({ frameId: 3, parentFrameId: 0, url: dupUrl });
  EXT_FRAMES.push({ frameId: 4, parentFrameId: 0, url: dupUrl });
  w3.url = dupUrl;
  const snap2 = await snapshot.takeSnapshot(1, { filter: 'interactive' });
  ok('the ambiguous twin is still LISTED for perception (frame[3] section)', /# frame\[3\] https:\/\/dup\.test\/x/.test(snap2.text), snap2.text.match(/# frame\[3\].*/)?.[0]);
  const dupRef = (snap2.text.match(/@e\d+(?=.*dup one)/) || [])[0];
  const amb = await grab(() => snapshot.resolveRef(1, dupRef));
  ok('but coordinate actions REFUSE rather than guess the sibling (FRAME_AMBIGUOUS)', amb.e?.code === 'FRAME_AMBIGUOUS', JSON.stringify(amb.e));
  w3.stampSupported = true;
  const b = await snapshot.resolveRef(1, dupRef);
  ok('after the stamp handshake resolves (window.name round-trip), the box composes', b.box.x === 605 && b.box.y === 105, JSON.stringify(b.box));
  // cleanup: remove the twins so later sections see the stable world
  worlds[0].children = [worlds[0].children[0]];
  worlds[0].childWorlds = { 0: w2 };
  EXT_FRAMES.length = 2;
}

// ============================================================ 8b. fix5-F1: OOPIF targets refuse, never ok
console.log('\n[8b] fix5-F1：跨站 OOPIF 内的坐标动作 = FRAME_UNSUPPORTED + 0 条 Input 上线（LIVE-RESULTS-2 §6b）');
{
  const OOP = 'https://oop.test/pay';
  const w5 = mkWorld({
    frameId: 5, url: OOP, origin: 'https://oop.test', epoch: 'e-oop', sameOriginAncestry: false,
    innerWidth: 200, innerHeight: 100, stampSupported: false, children: [],
    entries: [
      { role: 'button', name: 'Save draft', rect: { x: 10, y: 10, width: 100, height: 20 } },
      { role: 'checkbox', name: 'terms', type: 'checkbox', rect: { x: 10, y: 40, width: 12, height: 12 }, checked: false },
    ],
  });
  // webNavigation sees frame 5; the PAGE SESSION's frame tree does NOT (that is
  // exactly the live boundary: cross-site document = no CDP record = no Input channel)
  EXT_FRAMES.push({ frameId: 5, parentFrameId: 0, url: OOP });
  worlds[5] = w5;
  worlds[0].children = [worlds[0].children[0], { src: OOP, sameOrigin: false, rect: { x: 600, y: 100, width: 200, height: 100 } }];
  worlds[0].childWorlds = { 0: w2, 1: w5 };

  const snapOop = await snapshot.takeSnapshot(1, { filter: 'interactive' });
  const oopBtn = (snapOop.text.match(/@e\d+(?=.*Save draft)/g) || []).pop(); // frame[5]'s own section entry
  const oopChk = (snapOop.text.match(/@e\d+(?=.*"terms")/) || [])[0];
  ok('OOPIF frame still gets its snapshot section (sensing is bridge-reachable — live 6c proved it)', /# frame\[5\] https:\/\/oop\.test\/pay/.test(snapOop.text), snapOop.text.match(/# frame\[5\].*/)?.[0]);

  ok('frameIsOutOfProcess: 页面帧树里同 URL 文档在场 = 同进程（frame 2 不拒）', (await snapshot.frameIsOutOfProcess(1, 2)) === false);
  ok('frameIsOutOfProcess: 页面帧树里确证缺席 = OOPIF（frame 5）', (await snapshot.frameIsOutOfProcess(1, 5)) === true);

  cdpCalls = [];
  const oc = await grab(() => reg.call('click', { ref: oopBtn, tab_id: 1 }));
  ok('click(OOPIF ref) → FRAME_UNSUPPORTED，不再是 ok:true', oc.e?.code === 'FRAME_UNSUPPORTED', JSON.stringify(oc.r || oc.e?.code));
  ok('OOPIF 拒绝时 CDP 线路上 0 条 Input.*（这正是 6b 的谎报形状）', cdpCalls.filter((c) => String(c.method).startsWith('Input.')).length === 0, JSON.stringify(cdpCalls.map((c) => c.method)));
  ok('消息给真实出路（@d 桥通路 / 用户手点 / tab.create 顶层）', /@d5\.|user|tab\.create|bridge/.test(String(oc.e?.message)), String(oc.e?.message).slice(0, 120));

  cdpCalls = [];
  const oh = await grab(() => reg.call('hover', { ref: oopBtn, tab_id: 1 }));
  ok('hover(OOPIF ref) 同样拒绝且 0 Input 上线', oh.e?.code === 'FRAME_UNSUPPORTED' && cdpCalls.filter((c) => String(c.method).startsWith('Input.')).length === 0, JSON.stringify(oh.e?.code));
  cdpCalls = [];
  const ofi = await grab(() => reg.call('fill', { ref: oopBtn, value: 'x', tab_id: 1 }));
  ok('fill(OOPIF ref) 拒绝且 0 Input.insertText 上线', ofi.e?.code === 'FRAME_UNSUPPORTED' && !cdpCalls.some((c) => String(c.method).startsWith('Input.')), JSON.stringify(ofi.e?.code));
  const ofm = await grab(() => reg.call('fill_form', { tab_id: 1, values: { [oopBtn]: 'x' } }));
  ok('fill_form 的 frame 分支同样被守卫', ofm.e?.code === 'FRAME_UNSUPPORTED', JSON.stringify(ofm.e?.code));
  cdpCalls = [];
  const oc2 = await grab(() => reg.call('form.set', { ref: oopChk, action: 'check', tab_id: 1 }));
  ok('form.set 物理点击分支拒绝 OOPIF（select_option 走桥不受此限）', oc2.e?.code === 'FRAME_UNSUPPORTED' && cdpCalls.filter((c) => String(c.method).startsWith('Input.')).length === 0, JSON.stringify(oc2.e?.code));
  cdpCalls = [];
  const oa = await grab(() => reg.call('ax.action', { ref: oopBtn, action: 'focus', tab_id: 1 }));
  ok('ax.action focus/click 分支拒绝 OOPIF', oa.e?.code === 'FRAME_UNSUPPORTED' && cdpCalls.filter((c) => String(c.method).startsWith('Input.')).length === 0, JSON.stringify(oa.e?.code));
  const od = await grab(() => reg.call('drag', { tab_id: 1, from: { ref: oopBtn }, to: { x: 400, y: 400 } }));
  ok('drag 端点落在 OOPIF 也拒绝', od.e?.code === 'FRAME_UNSUPPORTED', JSON.stringify(od.e?.code));
  const oph = await grab(() => reg.call('snapshot', { tab_id: 1, probe_hover: oopBtn, frames: false }));
  ok('snapshot.probe_hover 对 OOPIF 红着拒绝（不静默“没展开也算展开”）', oph.e?.code === 'FRAME_UNSUPPORTED', JSON.stringify(oph.e?.code));

  // 正向对照：同一次运行里同进程帧（frame 2）的坐标动作必须照常可用——
  // 守卫按 URL 连接两套 id 空间，绝不是一刀切拒掉所有帧动作
  cdpCalls = [];
  const sp = await reg.call('click', { ref: frameRef, tab_id: 1 });
  ok('同进程帧（frame 2，CDP 帧树在场）的 click 不受影响（6a 正向对照）', sp.clicked === frameRef && cdpCalls.some((c) => c.method === 'Input.dispatchMouseEvent'), JSON.stringify(sp));
  // 感知通路保持可用
  const oinfo = await reg.call('element.info', { ref: oopBtn, tab_id: 1 });
  ok('element.info/read 通路对 OOPIF 保持可用（只拒动作，不拒感知）', oinfo.frame?.ext_frame_id === 5 && oinfo.box.w === 100, JSON.stringify(oinfo.box));
  const orp = await reg.call('read_page', { tab_id: 1, frame_id: 5, max_chars: 100 });
  ok('read_page 对 OOPIF 照常（桥进得去，live 6c 已证）', typeof orp.text === 'string', JSON.stringify(orp.text));

  // unit edges of the judge
  EXT_FRAMES.push({ frameId: 6, parentFrameId: 0, url: TOP }); // loads the TOP url → in-process by definition
  ok('frameIsOutOfProcess: 与顶层同 URL 的帧不判 OOPIF', (await snapshot.frameIsOutOfProcess(1, 6)) === false);
  EXT_FRAMES.pop();
  EXT_FRAMES.push({ frameId: 7, parentFrameId: 0, url: 'about:blank' });
  ok('frameIsOutOfProcess: about:blank/srcdoc 不判（不可判 ≠ 拒）', (await snapshot.frameIsOutOfProcess(1, 7)) === false);
  EXT_FRAMES.pop();
  const savedTree = cdp.send;
  cdp.send = async () => ({}); // degenerate/stub frame tree
  EXT_FRAMES.push({ frameId: 5, parentFrameId: 0, url: OOP });
  ok('frameIsOutOfProcess: 取不到/退化帧树时不判 OOPIF（不许伤同进程通路）', (await snapshot.frameIsOutOfProcess(1, 5)) === false);
  EXT_FRAMES.pop();
  cdp.send = savedTree;

  // cleanup
  worlds[0].children = [worlds[0].children[0]];
  worlds[0].childWorlds = { 0: w2 };
  delete worlds[5];
  EXT_FRAMES.length = 2;
}

{
  sentRoute = [];
  const rp = await reg.call('read_page', { tab_id: 1, frame_id: 2, max_chars: 100 });
  ok('read_page frame_id routes getPageText to that frame', rp.text !== undefined && sentRoute.at(-1).op === 'getPageText' && sentRoute.at(-1).frameId === 2);
  const badF = await grab(() => reg.call('read_page', { tab_id: 1, frame_id: -3 }));
  ok('a nonsense frame_id is refused at the boundary (BAD_PARAMS)', badF.e?.code === 'BAD_PARAMS', JSON.stringify(badF.e));
  const fp = await reg.call('extract', { tab_id: 1, frame_path: [0], selector: 'table' });
  ok('extract frame_path is forwarded to the bridge args', sentRoute.at(-1).args?.framePath?.join() === '0' && sentRoute.at(-1).frameId === 0, JSON.stringify(sentRoute.at(-1)));
  void fp;
  const f = await reg.call('find', { tab_id: 1, query: 'Save', frame_id: 2 });
  ok('frame-routed find refs carry the @d<frame>.<n> form', f.matches[0]?.ref === '@d2.1', JSON.stringify(f.matches[0]));
  cdpCalls = [];
  await reg.call('click', { ref: '@d2.1', tab_id: 1 });
  const clicked = sentRoute.filter((s) => s.op === 'clickDom').pop();
  ok('@d2.1 clickDom is routed to frame 2 with the bare @d1', clicked?.frameId === 2 && clicked?.args?.ref === '@d1', JSON.stringify(clicked));
  const legacy = await reg.call('click', { ref: '@d7', tab_id: 1 });
  const legacyRoute = sentRoute.filter((s) => s.op === 'clickDom').pop();
  ok('bare @dN still means the MAIN frame (Wave 1 shape)', legacyRoute?.frameId === 0 && legacyRoute?.args?.ref === '@d7', JSON.stringify(legacyRoute));
  void legacy;
}

{
  const fr = await reg.call('frames.list', { tab_id: 1 });
  ok('frames.list reports both frames with reachability', fr.frames.length === 2 && fr.frames[1].bridge === 'reachable', JSON.stringify(fr.frames));
  const pr = await reg.call('frames.probe', { tab_id: 1 });
  ok('frames.probe: per-CDP-frame getFullAXTree/createIsolatedWorld/getFrameOwner results', pr.cdp_frames.length === 2 && pr.cdp_frames[1].createIsolatedWorld.ok === true && 'getFrameOwner' in pr.cdp_frames[1], JSON.stringify(pr.cdp_frames[1]));
  ok('frames.probe: pairing rows + window_name_handshake + dpr recorded', Array.isArray(pr.pairing) && !!pr.checks.window_name_handshake && pr.checks.device_pixel_ratio === 1, JSON.stringify(pr.checks.window_name_handshake));
  ok('frames.probe: coordinate sample composed (170,280)', JSON.stringify(pr.checks.coordinate_path_sample?.viewport_box || {}) === JSON.stringify({ x: 170, y: 280, w: 100, h: 24 }), JSON.stringify(pr.checks.coordinate_path_sample));
  ok('frames.probe: flattened-doc reach keyed by CDP frameId', pr.checks.flattened_document_node_counts.MAIN === 3, JSON.stringify(pr.checks.flattened_document_node_counts));
}

{
  // main-frame refs still act through the node path (unchanged Wave 1/2 semantics)
  cdpCalls = [];
  OBJS.clear();
  MINTED.clear();
  const mref = (snap.text.match(/@e1\b/) || [])[0];
  const g = await grab(() => reg.call('fill', { ref: mref, value: 'x', tab_id: 1 }));
  const r = g.r;
  const cfo = cdpCalls.filter((c) => c.method === 'Runtime.callFunctionOn');
  ok('main-frame fill still goes through Runtime.callFunctionOn (no detour)', r?.filled === mref && cfo.length > 0, g.e ? `${g.e.code}: ${g.e.message}` : JSON.stringify(r));
  ok('the node reaches callFunctionOn as an objectId, never a backendNodeId (CDP has no such param)', cfo.length > 0 && cfo.every((c) => typeof c.params.objectId === 'string' && c.params.backendNodeId === undefined), JSON.stringify(cfo.map((c) => Object.keys(c.params))));
  ok('the objectId came from DOM.resolveNode of the node behind backendNodeId 4001', cfo.length > 0 && cfo.every((c) => MINTED.get(c.params.objectId) === 4001) && cdpCalls.some((c) => c.method === 'DOM.resolveNode' && MINTED.get('o' + c.params.nodeId) === 4001), JSON.stringify(cfo.map((c) => c.params.objectId)));
}

{
  // ============================================================ 10. fix5-F2/F3: reclaimed nodeId + honest scroll
  console.log('\n[10] fix5-F2/F3：同代际 nodeId 被回收 → 重建一次并重试；scrollIntoView 失败必须报错');
  const LIVE = new Map([[4001, '2'], [4002, '3'], [4003, '4']]); // backendNodeId → CURRENT live nodeId (page truth)
  const DEAD = new Set(); // nodeIds the DOM agent reclaimed (element still exists!)
  const RESOLVE_DEAD = new Set(); // nodeIds DOM.resolveNode alone refuses
  let scrollFail = null; // raw CDP error message for DOM.scrollIntoViewIfNeeded
  let inputFail = null; // raw CDP error message for Input.* (F3②: rejected input must reject the tool)
  const bnOfNode = (nid) => { for (const [bn, live] of LIVE) if (String(live) === String(nid)) return bn; return null; };
  cdp.send = async (tabId, method, params = {}) => {
    cdpCalls.push({ method, params });
    const nid = params.nodeId;
    if (method === 'Accessibility.getFullAXTree') return { nodes: MAIN_AX };
    if (method === 'DOM.getFlattenedDocument') return { nodes: [...LIVE.entries()].map(([backendNodeId, nodeId]) => ({ nodeId, backendNodeId, frameId: 'MAIN' })) };
    if (method === 'DOM.getDocument') return { root: { nodeId: 1, backendNodeId: 1, nodeType: 9, children: [] } };
    if (method === 'DOM.pushNodesByBackendIdsToFrontend') {
      const bn = params.backendNodeIds[0];
      if (!LIVE.has(bn)) throw new Error('No node with given id found');
      return { nodeIds: [LIVE.get(bn)] };
    }
    if (nid != null && DEAD.has(String(nid)) && ['DOM.scrollIntoViewIfNeeded', 'DOM.getBoxModel', 'DOM.focus', 'DOM.getAttributes', 'DOM.describeNode'].includes(method)) {
      throw new Error('No node with given id found');
    }
    if (method === 'DOM.scrollIntoViewIfNeeded') { if (scrollFail) throw new Error(scrollFail); return {}; }
    if (method === 'DOM.getBoxModel') return { model: { content: [0, 0, 120, 0, 120, 40, 0, 40] } };
    if (method === 'DOM.getAttributes') return { attributes: ['type', 'text'] };
    if (method === 'DOM.describeNode') return { node: { localName: 'a' } };
    if (method === 'DOM.resolveNode') {
      if (RESOLVE_DEAD.has(String(nid)) || DEAD.has(String(nid))) throw new Error('No node with given id found');
      const objectId = 'o' + params.nodeId;
      const bn = bnOfNode(params.nodeId);
      OBJS.set(objectId, bn);
      MINTED.set(objectId, bn);
      return { object: { objectId } };
    }
    if (method === 'Runtime.callFunctionOn') {
      const target = OBJS.get(params.objectId);
      if (target == null) throw new Error('fake CDP: callFunctionOn objectId never minted');
      return { result: { value: { addressedAsObjectId: target } } };
    }
    if (method === 'Runtime.releaseObject') { OBJS.delete(params.objectId); return {}; }
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'MAIN', url: TOP }, childFrames: [{ frame: { id: 'CDP2', url: PAY, parentId: 'MAIN' } }] } };
    if (String(method).startsWith('Input.') && inputFail) throw new Error(inputFail);
    if (method === 'Accessibility.getPartialAXTree') return { nodes: [{ properties: [{ name: 'checked', value: { value: false } }] }] };
    return {};
  };
  fakeSession.gen = 42;
  fakeSession.nodeIndex = new Map([[4001, { nodeId: '2', frameId: 'MAIN' }], [4002, { nodeId: '3', frameId: 'MAIN' }], [4003, { nodeId: '4', frameId: 'MAIN' }]]);
  fakeSession.nodeIndexGen = 42;
  fakeSession.domFetched = true;
  fakeSession.nodeDocGen = 42;

  // (a) snapshot-side reclaim: the cached nodeId died, the element lives (5g)
  DEAD.add('2');
  LIVE.set(4001, '77');
  cdpCalls = [];
  const rc1 = await grab(() => reg.call('click', { ref: '@e1', tab_id: 1 }));
  ok('F2: reclaimed nodeId → 重建一次并重试成功（不再 REF_STALE 指错方向）', !!rc1.r?.clicked, rc1.e ? `${rc1.e.code}: ${String(rc1.e.message).slice(0, 120)}` : '');
  ok('F2: 全树扫描恰 1 次（只在失败分支重建，不是每次动作）', cdpCalls.filter((c) => c.method === 'DOM.getFlattenedDocument').length === 1, `got ${cdpCalls.filter((c) => c.method === 'DOM.getFlattenedDocument').length}`);
  ok('F2: 重建后的缓存是活句柄 77', fakeSession.nodeIndex?.get(4001)?.nodeId === '77');
  cdpCalls = [];
  const rc2 = await grab(() => reg.call('click', { ref: '@e1', tab_id: 1 }));
  ok('F2: 下一次动作复用新索引，0 次全树扫描', !!rc2.r?.clicked && cdpCalls.filter((c) => c.method === 'DOM.getFlattenedDocument').length === 0, JSON.stringify(cdpCalls.map((c) => c.method)));

  // (b) resolve-side reclaim: box path fine, DOM.resolveNode died → actions retry
  RESOLVE_DEAD.add('77');
  LIVE.set(4001, '88');
  cdpCalls = [];
  const rf1 = await grab(() => reg.call('form.set', { ref: '@e1', action: 'select_option', value: 'x', tab_id: 1 }));
  ok('F2: DOM.resolveNode 收口处的回收同样重建一次并重试（callOnNode 落地）', rf1.e == null && cdpCalls.some((c) => c.method === 'Runtime.callFunctionOn'), JSON.stringify(rf1.e?.code || String(rf1.e?.message).slice(0, 120)));
  ok('F2: actions 侧重建恰一次全树扫描', cdpCalls.filter((c) => c.method === 'DOM.getFlattenedDocument').length === 1, `got ${cdpCalls.filter((c) => c.method === 'DOM.getFlattenedDocument').length}`);

  // (c) the node is REALLY gone: rebuild finds nothing → REF_STALE "gone", zero input online
  LIVE.delete(4001);
  DEAD.add('88');
  fakeSession.nodeIndex = new Map([[4001, { nodeId: '88', frameId: 'MAIN' }]]);
  fakeSession.nodeIndexGen = 42;
  cdpCalls = [];
  const rg = await grab(() => reg.call('click', { ref: '@e1', tab_id: 1 }));
  ok('F2: 重建仍拿不到真节点 → REF_STALE（诚实的 gone 文案，不是 churn 文案）', rg.e?.code === 'REF_STALE' && /gone from the document/.test(String(rg.e.message)), JSON.stringify(rg.e?.code || rg.e?.message));
  ok('F2: 这条 REF_STALE 与"代际变了"的文案可区分', !/previous page generation/.test(String(rg.e?.message)), String(rg.e?.message).slice(0, 90));
  ok('F2: 拒绝时 0 条 Input 上线', cdpCalls.filter((c) => String(c.method).startsWith('Input.')).length === 0, JSON.stringify(cdpCalls.map((c) => c.method)));

  // (d) churn: rebuild keeps handing out handles that die instantly → distinct guidance
  LIVE.set(4001, '99');
  DEAD.add('99');
  fakeSession.nodeIndex = new Map([[4001, { nodeId: '99', frameId: 'MAIN' }]]);
  fakeSession.nodeIndexGen = 42;
  const rch = await grab(() => reg.call('click', { ref: '@e1', tab_id: 1 }));
  ok('F2: 重建后句柄立死 → churn 文案（"元素多半还在，重复一次/重拍快照"，与 gone 分开）', rch.e?.code === 'REF_STALE' && /reclaimed/.test(String(rch.e.message)) && /repeat this action once/.test(String(rch.e.message)), JSON.stringify(rch.e?.code || String(rch.e?.message).slice(0, 120)));

  // (e) F3: scrollIntoViewIfNeeded fails for a REAL reason → the tool errors, no {scrolled_to} lie
  LIVE.set(4001, '2');
  DEAD.clear();
  fakeSession.nodeIndex = new Map([[4001, { nodeId: '2', frameId: 'MAIN' }]]);
  fakeSession.nodeIndexGen = 42;
  scrollFail = 'Node does not have a layout object';
  const rs = await grab(() => reg.call('scroll', { ref: '@e1', tab_id: 1 }));
  ok('F3: scroll{"ref"} 在 scrollIntoViewIfNeeded 失败时报错（不再谎报 {scrolled_to}）', rs.e?.code === 'ELEMENT_NOT_VISIBLE' && /scrolled into view/.test(String(rs.e.message)), JSON.stringify(rs.r || rs.e?.code));
  const rs2 = await grab(() => reg.call('scroll', { ref: '@e1', tab_id: 1 }));
  ok('F3: 反复失败反复红（错误没有被一次"重试成功"掩盖成静默）', rs2.e?.code === 'ELEMENT_NOT_VISIBLE', JSON.stringify(rs2.r || rs2.e?.code));
  scrollFail = null;
  const rs3 = await reg.call('scroll', { ref: '@e1', tab_id: 1 });
  ok('F3: 成功路径仍返回 {scrolled_to}（有界、不吞、不演）', rs3.scrolled_to === '@e1', JSON.stringify(rs3));
  // stale-shaped scroll failure routes into the F2 retry instead of ELEMENT_NOT_VISIBLE
  scrollFail = null;
  DEAD.add('2');
  LIVE.set(4001, '31');
  fakeSession.nodeIndex = new Map([[4001, { nodeId: '2', frameId: 'MAIN' }]]);
  fakeSession.nodeIndexGen = 42;
  const rsm = await grab(() => reg.call('scroll', { ref: '@e1', tab_id: 1 }));
  ok('F3+F2: scroll 的失败是"句柄回收"形状时走重建重试并成功（5g 的复发形态被治好）', rsm.r?.scrolled_to === '@e1', JSON.stringify(rsm.e?.code || rsm.e?.message || rsm.r));

  // F3② (tools.js click): the old `await input.catch(() => {})` fed a REJECTED
  // input command (SHIELD_PASS_FAILED / CDP error) into {clicked:...} anyway
  DEAD.clear();
  LIVE.set(4001, '2');
  fakeSession.nodeIndex = new Map([[4001, { nodeId: '2', frameId: 'MAIN' }]]);
  fakeSession.nodeIndexGen = 42;
  inputFail = 'simulated: Input domain command rejected';
  cdpCalls = [];
  const rif = await grab(() => reg.call('click', { ref: '@e1', tab_id: 1 }));
  ok('F3②: Input 命令被拒 → click 红着报，不再靠 input.catch(()=>{}) 伪造 {clicked}', rif.e != null && rif.r == null, JSON.stringify(rif.r || (rif.e && String(rif.e.message || rif.e).slice(0, 90))));
  inputFail = null;
}

chrome.tabs.sendMessage = realSendMsg;
cdp.send = realSend;
cdp.ensure = realEnsure;
cdp.buffers = realBuffers;
await sessions.stop({ close_created: false });
sessions.session = null;

// ============================================================ 9. guard invariants across frames
console.log('\n[9] security invariants survived the frame rewrite');
const toolsSrc = fs.readFileSync(new URL('tools.js', LIB), 'utf8');
ok('fill frame branch calls guardFrameField BEFORE any input command', toolsSrc.indexOf('guardFrameField') < toolsSrc.indexOf('frameFillInput', toolsSrc.indexOf('guardFrameField')));
ok('guardFrameField has NO bypass for the NEVER class', /s\.never \|\| SENSITIVE_FIELD_NEVER\.test\(hay\)/.test(toolsSrc));
ok('frame path still ends in withPass (user shield stays honest about agent input)', /async function frameFillInput[\s\S]*withPass/.test(toolsSrc));
ok('redact is applied to frames.* output', /return redact\(out\)/.test(fs.readFileSync(new URL('tools-frames.js', LIB), 'utf8')));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
