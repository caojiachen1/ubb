// fix18 delivery-proof test — the suite that CONVICTS the ack≠delivery bug and
// pins the fix. LIVE-RESULTS-6: 20/20 real-browser clicks returned {clicked:...}
// while the page received zero events, because CDP `Input.*` acks the QUEUEING
// and a hidden tab delivers ~5000ms later — after the old withPass had already
// released the gate on the ack, so the shield ate its own agent's input. 1648
// offline assertions stayed green because no offline model could represent
// "tool said ok, page received nothing". This suite represents it
// (lib/testharness.mjs's makeDeliveryModel + the REAL content/shield.js running
// in a vm world, recording into the shared DOM attribute that lib/shield-ctl.js
// reads back) and then prosecutes:
//
//   [1] 定罪·修复前形状   ack 即成功 + 立即 release + deliverMs=5000
//                         → 必须复现 LIE：工具返回成功、页面记录为 0，事件全部落在自家 veil 上
//   [2] 定罪·当前代码     同一物理路径（direct withPass + tool click）→ 必须
//                         delivered:true（或红着抛 INPUT_NOT_DELIVERED），绝不允许 ok:true+页面零事件
//   [3] release 时序      关门时刻必须晚于投递时刻（而不是晚于 ack 时刻）
//   [4] shield_hit 不算证据  事件投到了、但 target 落在 .ubb-host-root 内 → 不得 delivered:true
//   [5] 可见标签不吃亏    deliverMs=0 → delivered:true、delivery_ms 毫秒级、取证往返有上界
//   [6] 重发边界          工具面不传 resend=拿不到证据直接红且 press/release 恰好各 1 条（永不双发）；
//                         move-only 允许重发、且至多重发一次
//   [7] 错误出路          INPUT_NOT_DELIVERED 的 message 必须给真实下一步，不许只是 failed
//   [8] 探针字段          shield.pass_gate 的 dispatch 条目必须带 delivery_verdict/delivery_ms/
//                         delivery_records_seen/last_shield_hit（fix17 第 5 项）
//   [9] 返回形状静态钉    click/fill/drag/form.set 四处必须都经 deliveredField(dl)
//
//   node daemon/test-delivery.mjs
//
// Reverse controls (§6.3) — each MUST go red on its named group, green again
// when restored. Clones live OUTSIDE the repo (contract §0 — nothing under
// daemon/ may start with `_`, the extension root IS the repo root):
//   D:/Codebase/ubb-scratch/rc/fix18/
//   ① 撤掉等待（withPass 回到 ack 即 release，投递取证整段旁路）:
//        cp -r <repo>/lib rc-a/lib && node patch-a.cjs rc-a
//        node daemon/test-delivery.mjs --lib D:/Codebase/ubb-scratch/rc/fix18/rc-a/lib
//      → [2]/[3]/[4]/[6]/[7]/[8] 红（正是真机第六轮的 LIE 形状回来了：ok:true + 页面零事件）
//   ② 让 shield_hit=true 也算证据（matchDelivery 的跳过被删）:
//        cp -r <repo>/lib rc-b/lib && node patch-b.cjs rc-b
//        node daemon/test-delivery.mjs --lib D:/Codebase/ubb-scratch/rc/fix18/rc-b/lib
//      → [4]/[6] 红（被 veil 吃掉的事件会被当成"投递成功"）
//   ③ 延迟回 0 且撤掉取证（内容脚本世界不再建投递环 = 早于 fix17 的世界：document_start
//     与 build() 两处打环都没了，capture 记录监听也没了）:
//        cp -r <repo>/content rc-c/content && node patch-c.cjs rc-c
//        node daemon/test-delivery.mjs --content D:/Codebase/ubb-scratch/rc/fix18/rc-c/content
//      → [1]/[2]/[3]/[4]/[5]/[6]/[7] 红：没有环可读 → unprovable → delivered:null + ok:true + 页面零记录，
//        正是"没人能定罪"的旧世界（定罪用例的禁形在 RC-c/RC-a 下都以 ok:true+page:0 复现）
//
// --lib <dir> swaps the whole lib/ import base, --content <dir> the content/
// source the fake page runs; both default to the real files.

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';

const arg = (name, dflt) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};
const dirUrl = (p, dflt) => {
  const raw = arg(p, null);
  const abs = raw ? (path.isAbsolute(raw) ? raw : path.resolve(ROOT, raw)) : path.resolve(ROOT, dflt);
  const href = pathToFileURL(abs + path.sep).href;
  return href.endsWith('/') ? href : href + '/';
};
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const LIB = new URL(dirUrl('--lib', 'lib'));
const CONTENT = new URL(dirUrl('--content', 'content'));
const RC = arg('--lib', null) || arg('--content', null) ? ` [REVERSE CONTROL → ${arg('--lib', '')} ${arg('--content', '')}]` : '';

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
async function grab(f) {
  try {
    return { r: await f(), e: null };
  } catch (e) {
    return { r: null, e };
  }
}
const nowMs = () => Date.now();

const SHIELD_SRC = fs.readFileSync(new URL('shield.js', CONTENT), 'utf8');

// ---------------------------------------------------------------- tiny DOM
// Copied discipline from daemon/test-shield.mjs (that suite is the reference for
// "the REAL shield.js runs here, it is not mocked"): enough platform for
// content/shield.js plus the functions chrome.scripting injects, and the one
// hit-test rule delivery proof lives on: a visible host whose veil is
// pointer-events:auto eats a real mouse event and the browser retargets the hit
// to the shadow host (.ubb-host-root); with the door open the same point hits
// the page button.
class El {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.nodeType = 1; // fix20: the page-side identity recorder only trusts element nodes
    this.childNodes = [];
    this.parentNode = null;
    this.attrs = {};
    this.style = {};
    this.shadowRoot = null;
    this.listeners = [];
    this.__doc = false;
  }
  get className() {
    return this.attrs.class || '';
  }
  set className(v) {
    this.attrs.class = v;
  }
  get classList() {
    const self = this;
    return { contains: (c) => String(self.attrs.class || '').split(/\s+/).includes(c) };
  }
  setAttribute(k, v) {
    this.attrs[k] = String(v);
  }
  getAttribute(k) {
    return this.attrs[k] === undefined ? null : String(this.attrs[k]);
  }
  appendChild(c) {
    c.parentNode = this;
    this.childNodes.push(c);
    return c;
  }
  append(...cs) {
    for (const c of cs) this.appendChild(c);
  }
  remove() {
    const p = this.parentNode;
    if (p) {
      const i = p.childNodes.indexOf(this);
      if (i >= 0) p.childNodes.splice(i, 1);
    }
    this.parentNode = null;
  }
  get isConnected() {
    let n = this;
    while (n.parentNode) n = n.parentNode;
    return n.__doc === true;
  }
  attachShadow() {
    this.shadowRoot = new El('#shadow-root');
    this.shadowRoot.parentNode = this;
    return this.shadowRoot;
  }
  addEventListener(type, fn, capture) {
    this.listeners.push({ type, fn, capture: capture === true || (capture && capture.capture === true) });
  }
  removeEventListener(type, fn) {
    this.listeners = this.listeners.filter((l) => !(l.type === type && l.fn === fn));
  }
  fire(e) {
    let stopped = false;
    for (const l of this.listeners.slice()) {
      if (l.type !== e.type) continue;
      try {
        l.fn(e);
      } catch {}
      if (e.__immediate) {
        stopped = true;
        break;
      }
    }
    return stopped;
  }
  _matches(sel) {
    return sel.startsWith('.') && this.className.split(/\s+/).includes(sel.slice(1));
  }
  _all() {
    const out = [];
    const walk = (n) => {
      for (const c of n.childNodes) {
        out.push(c);
        walk(c);
        if (c.shadowRoot) walk(c.shadowRoot);
      }
    };
    walk(this);
    return out;
  }
  querySelectorAll(sel) {
    return this._all().filter((e) => e._matches(sel));
  }
  querySelector(sel) {
    return this.querySelectorAll(sel)[0] || null;
  }
  // fix20: the ring now records the hit element's own box (page-side forensic).
  // Elements without a planted __rect report NaN and the recorder skips the box,
  // which keeps every pre-fix20 case on its old centre-distance semantics.
  getBoundingClientRect() {
    const r = this.__rect;
    return r ? { left: r[0], top: r[1], right: r[2], bottom: r[3] } : { left: NaN, top: NaN, right: NaN, bottom: NaN };
  }
}

const computed = (el) => ({
  display: el.style.display === 'none' ? 'none' : 'block',
  pointerEvents: el.style.pointerEvents === 'none' ? 'none' : 'auto',
});

function mkDocument() {
  const doc = new El('#document');
  doc.__doc = true;
  const html = doc.appendChild(new El('html'));
  const body = html.appendChild(new El('body'));
  const page = body.appendChild(new El('button'));
  page.setAttribute('id', 'b-save');
  doc.documentElement = html;
  doc.body = body;
  doc.readyState = 'loading';
  doc.createElement = (t) => new El(t);
  doc.querySelectorAll = (sel) => doc._all().filter((e) => e._matches(sel));
  doc.querySelector = (sel) => doc.querySelectorAll(sel)[0] || null;
  doc.elementFromPoint = (x, y) => {
    // planted exact-coordinate hits: the shield's own pill/stop button re-enable
    // pointer-events INSIDE the shadow tree while the veil itself is open, so the
    // browser retargets that point to the host even mid-pass. This is the only
    // way to model "the event WAS delivered, but it landed on our overlay".
    for (const h of state.hitAt || []) {
      if (h.x === x && h.y === y) return h.el ? h.el : h.who === 'page' ? page : doc.querySelectorAll('.ubb-host-root')[0] || page;
    }
    const found = doc.querySelectorAll('.ubb-host-root');
    for (let i = found.length - 1; i >= 0; i--) {
      const h = found[i];
      if (computed(h).display === 'none') continue;
      const veil = h.shadowRoot && h.shadowRoot.querySelector('.veil');
      if (veil && computed(veil).pointerEvents !== 'none') return h;
    }
    return page;
  };
  doc.__page = page;
  return doc;
}

// ---------------------------------------------------------------- fake chrome
const OURS = 'ubb-offline-harness';
const state = {
  doc: null,
  docs: new Map(), // frameId → its OWN document
  worlds: new Map(), // frameId → [world]
  sends: [], // chrome.tabs.sendMessage calls {payload,opts,at}
  scriptings: [], // chrome.scripting.executeScript calls {func,frameIds,...}
  wire: [], // CDP commands acked on the wire
  frames: [0],
  hitAt: [], // planted exact-coordinate hits (see elementFromPoint)
  deliverMs: 0, // ACK NOW, DELIVER LATER — the real machine sat at ~5000
  deliverFrame: 0, // which document the queued event lands in at delivery time
  releases: [], // {at, token, frameId} — WHEN a pass txn was actually closed
  delivered: [], // what the DOCUMENT received {type,x,y,acked_at,delivered_at,shield_hit}
};

/** The document-side record straight out of the SHARED DOM attribute — exactly
 *  what lib/shield-ctl.js's __ubbFrameDeliveryRead parses (same grammar). */
function deliveryRing(frameId = 0) {
  const el = frameDoc(frameId).documentElement;
  const raw = el.getAttribute('data-ubb-delivery');
  if (raw === null) return null; // no ring = a content-script world older than fix17
  const now = Date.now();
  return String(raw)
    .split(';')
    .filter(Boolean)
    .map((part) => part.split('~'))
    .filter((f) => f.length >= 6)
    .map((f) => ({ seq: Number(f[0]), type: f[1], x: f[2], y: f[3], t: Number(f[4]), shield_hit: f[5] === '1' }))
    .filter((r) => Number.isFinite(r.seq) && now - r.t <= 60000);
}
const ringPageHits = (frameId = 0) => (deliveryRing(frameId) || []).filter((r) => r.shield_hit === false);
const ringVeilHits = (frameId = 0) => (deliveryRing(frameId) || []).filter((r) => r.shield_hit === true);

function frameDoc(frameId) {
  let d = state.docs.get(frameId);
  if (!d) {
    d = mkDocument();
    state.docs.set(frameId, d);
  }
  return d;
}

function freshPage() {
  state.docs = new Map();
  state.doc = frameDoc(0);
  state.worlds = new Map();
  state.sends = [];
  state.scriptings = [];
  state.wire = [];
  state.frames = [0];
  state.hitAt = [];
  state.releases = [];
  state.delivered = [];
  state.deliverFrame = 0;
  queue.cancel();
  queue.wire.length = 0;
}

function mkWindow(doc) {
  const win = {
    listeners: [],
    location: { href: 'http://localhost:8102/widgets.html' },
    document: doc,
    addEventListener: (type, fn, capture) => {
      win.listeners.push({ type, fn, capture: capture === true || (capture && capture.capture === true) });
    },
    removeEventListener: (type, fn) => {
      win.listeners = win.listeners.filter((l) => !(l.type === type && l.fn === fn));
    },
    fire(e) {
      for (const l of win.listeners.slice()) {
        if (l.type !== e.type) continue;
        try {
          l.fn(e);
        } catch {}
        if (e.__immediate) return true;
      }
      return false;
    },
  };
  win.top = win;
  win.self = win;
  return win;
}

/** Run the real content/shield.js as ONE content-script world of ONE frame — the
 *  delivery ring (recordDelivery/composedPath shieldHit) is that world's own code,
 *  not a test-local fake. */
function injectWorld(frameId, { owner = OURS, arm = false } = {}) {
  const doc = frameDoc(frameId);
  const win = mkWindow(doc);
  const world = { frameId, owner, listeners: [], ctx: null, win };
  doc.readyState = 'complete';
  const chromeForCtx = {
    runtime: {
      id: owner,
      sendMessage: async () => ({}),
      onMessage: { addListener: (fn) => world.listeners.push(fn) },
    },
  };
  world.ctx = vm.createContext({
    window: win,
    document: doc,
    chrome: chromeForCtx,
    getComputedStyle: computed,
    console,
    setInterval: () => 0,
    clearInterval: () => {},
    setTimeout,
    clearTimeout,
    Math,
    Date,
  });
  vm.runInContext(SHIELD_SRC, world.ctx);
  if (arm) {
    for (const fn of world.listeners.slice()) fn({ type: 'UBB_SHIELD', mode: 'armed', blockMode: 'block' }, { frameId }, () => {});
  }
  const list = state.worlds.get(frameId) || [];
  list.push(world);
  state.worlds.set(frameId, list);
  return world;
}

/** Hand one delivered event to a frame the way a browser would: fresh Event per
 *  world, retargeted `target` from the hit test of THAT MOMENT, composedPath()
 *  from inside the world (so a shield hit is visible exactly the way
 *  content/shield.js reads it), capture dispatch on window first then document. */
function fireInput(frameId, { type, x = null, y = null, target }) {
  const doc = frameDoc(frameId);
  const pathOf = (t) => {
    const out = [];
    let n = t;
    while (n) {
      out.push(n);
      n = n.parentNode;
    }
    out.push(doc);
    return out;
  };
  let fired = 0;
  for (const w of state.worlds.get(frameId) || []) {
    const e = {
      type,
      target: target || doc.__page,
      clientX: x,
      clientY: y,
      button: 0,
      buttons: 0,
      isTrusted: true,
      defaultPrevented: false,
      preventDefault() {
        e.defaultPrevented = true;
      },
      stopPropagation() {
        e.__stopped = true;
      },
      stopImmediatePropagation() {
        e.__stopped = true;
        e.__immediate = true;
      },
      composedPath: () => pathOf(e.target),
    };
    fired++;
    if (w.win.fire(e)) continue;
    if (e.__stopped) continue;
    doc.fire(e);
  }
  return fired;
}

const hosts = () => state.doc.querySelectorAll('.ubb-host-root');
const hostCount = () => hosts().length;
const veils = () => hosts().map((h) => (h.shadowRoot && h.shadowRoot.querySelector('.veil')) || null);
const mouseOnWire = () => state.wire.filter((c) => c.method === 'Input.dispatchMouseEvent');
const deliveryReads = () => state.scriptings.filter((s) => s.func === '__ubbFrameDeliveryRead');
const deliveryQueries = () => state.sends.filter((s) => s.payload?.type === 'UBB_DELIVERY_QUERY');

/** Chrome semantics: {frameId} → only that frame runs; otherwise every frame and
 *  the first sendResponse wins. */
function deliver(tabId, payload, opts) {
  const targets = opts && typeof opts.frameId === 'number' ? [opts.frameId] : [...state.worlds.keys()];
  let anyListener = false;
  for (const fid of targets) {
    for (const w of state.worlds.get(fid) || []) {
      if (!w.listeners.length) continue;
      anyListener = true;
      let reply;
      let answered = false;
      for (const fn of w.listeners.slice()) {
        try {
          fn(payload, { tab: { id: tabId }, frameId: fid }, (v) => {
            if (!answered) {
              answered = true;
              reply = v;
            }
          });
        } catch {}
        if (answered) return reply;
      }
    }
  }
  if (anyListener) throw new Error('The message port closed before a response was received.');
  throw new Error('Could not establish connection. Receiving end does not exist.');
}

const { installChromeStub, collectRegistry, makeDeliveryModel } = await import(new URL('testharness.mjs', LIB).href);
const chromeStub = installChromeStub();

/** The delivery queue (lib/testharness.mjs): `Input.*` is ACKED at the wire and
 *  DELIVERED state.deliverMs later, hit-tested against the veil as it stands AT
 *  THAT MOMENT; the receiving document records {type,x,y,t,shield_hit} itself. */
const queue = makeDeliveryModel({
  deliverMs: 0,
  hitTest: (x, y, item) => {
    const doc = frameDoc(state.deliverFrame || 0);
    if (item && (item.type === 'keydown' || item.type === 'keyup' || item.type === 'input')) {
      const found = doc.querySelectorAll('.ubb-host-root');
      for (let i = found.length - 1; i >= 0; i--) {
        const v = found[i].shadowRoot && found[i].shadowRoot.querySelector('.veil');
        if (v && computed(v).pointerEvents !== 'none') return found[i];
      }
      return doc.__page;
    }
    return doc.elementFromPoint(x, y);
  },
  isShield: (target) => !!(target && target.classList && target.classList.contains('ubb-host-root')),
  dispatch: (item, target) => {
    fireInput(state.deliverFrame || 0, { type: item.type, x: item.x, y: item.y, target });
    state.delivered.push({ ...item, frameId: state.deliverFrame || 0, at: Date.now() });
  },
});

function wireChrome() {
  chromeStub.tabs.sendMessage = async (tabId, payload, opts) => {
    state.sends.push({ tabId, payload, opts, at: Date.now() });
    // the door-close on the wire is what "release" MEANS — timestamped, so the
    // suite can say whether the gate closed after the DELIVERY or after the ACK
    if (payload?.type === 'UBB_PASS' && (payload.op === 'close' || payload.on === false)) {
      state.releases.push({ at: Date.now(), token: payload.token || null, frameId: opts?.frameId ?? null });
    }
    return deliver(tabId, payload, opts);
  };
  chromeStub.webNavigation.getAllFrames = async () => state.frames.map((frameId) => ({ frameId, parentFrameId: frameId === 0 ? -1 : 0 }));
  chromeStub.scripting = {
    executeScript: async ({ target, func, args }) => {
      const frameIds = target.frameIds || [];
      const name = String(func?.name || '');
      state.scriptings.push({
        tabId: target.tabId,
        frameIds,
        func: name,
        at: Date.now(), // every取证 read is timestamped: "evidence before release" is an ORDER assertion
        op: name === '__ubbFramePass' ? args[0] : null,
        token: name === '__ubbFramePass' ? args[1] : null,
        owner: name === '__ubbFramePass' ? args[4] : args[0],
      });
      const out = [];
      for (const fid of frameIds) {
        const w = (state.worlds.get(fid) || [])[0];
        if (!w) continue; // a frame nobody injected: no result, like Chrome
        const fn = vm.runInContext(`(${func.toString()})`, w.ctx);
        out.push({ frameId: fid, result: fn(...args) });
      }
      if (!out.length) throw new Error('Cannot access a frame');
      return out;
    },
  };
  chromeStub.storage.local.get = async () => ({ ubb_shield_mode: 'block' });
}

wireChrome();
const { cdp } = await import(new URL('cdp.js', LIB).href);
const { sessions } = await import(new URL('tabs.js', LIB).href);
const shieldCtl = await import(new URL('shield-ctl.js', LIB).href);
const actions = await import(new URL('actions.js', LIB).href);
cdp.ensure = async () => ({});
// ACK NOW, DELIVER LATER — the whole bug in three lines: every Input.* returns
// the real ack immediately and lands in the queue with a delivery scheduled.
cdp.send = async (tabId, method, params = {}) => {
  state.wire.push({ method, params });
  if (queue.deliverMs !== state.deliverMs) queue.setDeliverMs(state.deliverMs);
  return queue.ack(method, params);
};
sessions.session = { id: 't', groupId: 1, created: new Set([1]), claimed: new Set(), lastTabId: 1, marks: new Map() };
const reg = await collectRegistry();
const { audit } = await import(new URL('audit.js', LIB).href);
const gateE = (since, phase) => audit.listSince(since).filter((e) => e.action === 'shield.pass_gate' && (!phase || e.phase === phase));

const X = 65; // the page button point (same fixture geometry as test-shield/live round 6)
const Y = 299;
const OX = 210; // a clean confirmation point for the split-point shield_hit case
const OY = 350;
const HX = 480; // the point where our OWN overlay sits (planted hit)
const HY = 420;
const pointerProof = (at, to) => [
  { types: ['mousedown', 'mousePressed'], at: at || null },
  { types: ['mouseup', 'mouseReleased', 'click'], at: to || at || null },
];
const inputItems = (from = 0) => queue.wire.slice(from).filter((q) => String(q.method).startsWith('Input.dispatchMouseEvent'));

console.log(`\n[fix-18] delivery proof — ack is not delivery${RC}`);

// ============================================================ 1. 定罪·修复前的判定形状
console.log('\n[1] 定罪·修复前：ack 即成功 + finally 立即关门 + 真机量级延迟(5000ms) = LIE');
{
  freshPage();
  injectWorld(0, { arm: true });
  state.deliverMs = 5000; // the LIVE-RESULTS-6 magnitude, no longer unrepresentable
  const w0 = queue.wire.length;
  const dl = {};
  // The pre-fix shape is still addressable through the CURRENT API surface:
  // withPass WITHOUT `expect` is exactly "ack 即成功, finally release"
  // ("no expect: the gate keeps its ack-only shape"). Same physical dispatch.
  const legacy = await grab(() =>
    shieldCtl.withPass(
      1,
      async () => {
        await actions.mouse(1, 'mouseMoved', X, Y);
        await actions.mouse(1, 'mousePressed', X, Y);
        await shieldCtl.sleep(30);
        await actions.mouse(1, 'mouseReleased', X, Y);
      },
      { at: [X, Y], delivery: dl },
    ),
  );
  ok('前提：修复前形状一路返回成功（没有 throw，这就是当时的 {clicked:...}）', !legacy.e && legacy.r !== null, JSON.stringify(legacy.e?.code || 'ok'));
  ok('返回的那一刻：3 条 Input.dispatchMouseEvent 全部 acked、0 条 delivered（ack 被当成了投递）', inputItems(w0).length === 3 && inputItems(w0).every((q) => q.acked_at && !q.delivered), JSON.stringify(inputItems(w0).map((q) => ({ t: q.type, d: q.delivered }))));
  ok('返回的那一刻：页面投递记录为 0（shield.js 的世界还什么都没记）', (deliveryRing(0) || []).length === 0, JSON.stringify(deliveryRing(0)));
  ok('门在投递之前就关了（release 跟着 ack 走，正是要钉死的时序）', state.releases.length >= 1 && veils()[0].style.pointerEvents === 'auto', JSON.stringify({ rel: state.releases.length, pe: veils()[0].style.pointerEvents }));
  // now let the real delivery happen (what the tool call had already promised
  // to be over): the events land on the CLOSED veil — the shield eats its own input
  queue.flush();
  ok('LIE 定罪：迟到 5s 的投递全部落在自家 veil（shield_hit:true），到达页面的记录恒 0 —— 真机 20/20 的形状', ringPageHits(0).length === 0 && ringVeilHits(0).length >= 2, JSON.stringify({ page: ringPageHits(0).length, veil: ringVeilHits(0).length }));
  ok('LIE 定罪·另一半：工具面对"门已关+记录空"毫无感知（dl 只有 not_requested，没有 delivered:false 可用）', dl.verdict === 'not_requested' && dl.delivered === undefined, JSON.stringify(dl));
  state.deliverMs = 0;
}

// ============================================================ 2. 定罪·当前代码不许撒谎
console.log('\n[2] 定罪·当前代码：真机量级延迟(5000ms)下，绝不允许 ok:true + 页面零事件');
{
  freshPage();
  injectWorld(0, { arm: true });
  state.deliverMs = 5000;
  const w0 = queue.wire.length;
  const dl = {};
  const cur = await grab(() =>
    shieldCtl.withPass(
      1,
      async () => {
        await actions.mouse(1, 'mouseMoved', X, Y);
        await actions.mouse(1, 'mousePressed', X, Y);
        await shieldCtl.sleep(30);
        await actions.mouse(1, 'mouseReleased', X, Y);
      },
      { at: [X, Y], delivery: dl, expect: pointerProof([X, Y]) },
    ),
  );
  const verdictOk = !cur.e || cur.e?.code === 'INPUT_NOT_DELIVERED';
  ok('当前代码只允许两种结局：成功带证据，或红着抛 INPUT_NOT_DELIVERED（不许别的错、更不许无声成功）', verdictOk, JSON.stringify(cur.e?.code || 'ok'));
  ok('这一条走的是"门保持敞开 → 迟到事件落到页面"的路：delivered:true', !cur.e && dl.delivered === true, JSON.stringify(cur.e?.code || dl.delivered));
  const items = inputItems(w0);
  ok('5000ms 延迟真的生效（不是测试自己糊过去的）：每条 Input 的 delivered_at - acked_at ≥ 5000', items.length >= 2 && items.filter((q) => q.type !== 'mousemove').every((q) => q.delivered && q.delivered_at - q.acked_at >= 5000), JSON.stringify(items.map((q) => ({ t: q.type, gap: q.delivered_at - q.acked_at }))));
  ok('取证到的是页面上的事件（mousedown+mouseup 两条新记录，shield_hit 全 false）', ringPageHits(0).filter((r) => r.type === 'mousedown' || r.type === 'mouseup').length === 2 && ringVeilHits(0).length === 0, JSON.stringify({ page: ringPageHits(0), veil: ringVeilHits(0) }));
  ok('delivery_ms 就是真机量级（≥4800 且在 7000ms 取证预算内；awaitDelivery 从派发后才起表）', typeof dl.ms === 'number' && dl.ms >= 4800 && dl.ms <= 7000, JSON.stringify(dl.ms));
  ok('证据通道如实上报：channel=scripting、eaten=0、matched 两条', dl.channel === 'scripting' && dl.eaten === 0 && (dl.matched || []).length === 2, JSON.stringify({ ch: dl.channel, eaten: dl.eaten, matched: (dl.matched || []).map((m) => m.type) }));
  // the forbidden LIE shape, stated once more as its own assertion:
  ok('禁形：绝不允许 "返回成功 + 页面零记录"（定罪用例的意义所在）', !(cur.r !== null && !cur.e && ringPageHits(0).length === 0), JSON.stringify({ threw: !!cur.e, page: ringPageHits(0).length }));
}
{
  // the same physical path through the actual tool (this is what an agent sees)
  freshPage();
  injectWorld(0, { arm: true });
  state.deliverMs = 5000;
  const seq = audit.seq;
  const t0 = nowMs();
  const r = await grab(() => reg.call('click', { tab_id: 1, x: X, y: Y }));
  const wall = nowMs() - t0;
  ok('工具面 click（5000ms 延迟）：要么 delivered:true，要么 INPUT_NOT_DELIVERED —— 其余结局即定罪', (!!r.r && r.r.delivered === true) || r.e?.code === 'INPUT_NOT_DELIVERED', JSON.stringify(r.e?.code || r.r));
  ok('工具没有提前返回：整个调用时长覆盖了投递窗口（wall ≥ 5000ms，3s stalled-race 不许把它变成谎报）', wall >= 5000, `wall=${wall}`);
  ok('返回形状带页侧证据：delivered:true + delivery_ms≥5000，页面环里 mousedown/mouseup 都在', r.r?.delivered === true && r.r?.delivery_ms >= 5000 && ringPageHits(0).length >= 2, JSON.stringify({ d: r.r?.delivered, ms: r.r?.delivery_ms, page: ringPageHits(0).map((x) => x.type) }));
  const d1 = gateE(seq, 'dispatch')[0];
  ok('探针把取证结论落进 audit（fix17 第 5 项）：delivery_verdict:"proven" + delivery_ms + delivery_records_seen≥2 + last_shield_hit:false', d1?.delivery_verdict === 'proven' && typeof d1.delivery_ms === 'number' && d1.delivery_ms >= 5000 && d1.delivery_records_seen >= 2 && d1.last_shield_hit === false, JSON.stringify(d1 && { v: d1.delivery_verdict, ms: d1.delivery_ms, seen: d1.delivery_records_seen, hit: d1.last_shield_hit }));
  state.deliverMs = 0;
}

// ============================================================ 3. release 时序钉死
console.log('\n[3] 门不得提前释放：release 的时刻必须晚于投递的时刻，不是晚于 ack 的时刻');
{
  freshPage();
  injectWorld(0, { arm: true });
  state.deliverMs = 600; // big enough to separate ack / delivery / release on one clock
  const w0 = queue.wire.length;
  const r0 = state.releases.length;
  const r = await grab(() => reg.call('click', { tab_id: 1, x: X, y: Y }));
  ok('前提：600ms 延迟下动作成功且带证据（时序断言只在真成功的动作上有意义）', !!r.r && r.r.delivered === true, JSON.stringify(r.e?.code || r.r));
  const items = inputItems(w0).filter((q) => q.type !== 'mousemove');
  const maxAck = Math.max(...items.map((q) => q.acked_at));
  const maxDel = Math.max(...items.map((q) => q.delivered_at));
  const rels = state.releases.slice(r0);
  const relAt = Math.max(...rels.map((x) => x.at));
  ok('关门发生了（UBB_PASS close 上了线）、投递都已完成、且关门时刻 ≥ 最后一条事件的 delivered_at', rels.length >= 1 && items.every((q) => q.delivered) && relAt >= maxDel, JSON.stringify({ relAt, maxDel, n: rels.length }));
  ok('关门晚于 ack 的幅度覆盖整个投递窗口（relAt - maxAck ≥ 600 = 延迟本身：等的是投递证据，不是 ack）', relAt - maxAck >= 600, JSON.stringify({ gap: relAt - maxAck }));
  ok('投递发生在 ack 之后而不是同时（delivered_at - acked_at ≥ 600，模型的延迟真实存在）', items.every((q) => q.delivered_at - q.acked_at >= 600), JSON.stringify(items.map((q) => q.delivered_at - q.acked_at)));
  // the whole point: the LAST evidence read happens BEFORE the door closes, and
  // the close happens only after a page-side (shield_hit:false) record exists.
  const lastRead = Math.max(...deliveryReads().map((s) => s.at));
  ok('取证读只发生在关门之前（最后一次 __ubbFrameDeliveryRead ≤ release），且 ≥2 次（基线 + 命中）——证据先于关门，顺序不许倒', deliveryReads().length >= 2 && lastRead <= relAt, JSON.stringify({ reads: deliveryReads().length, lastRead, relAt }));
  state.deliverMs = 0;
}

// ============================================================ 4. shield_hit=true 不算证据
console.log('\n[4] 投到了但落在 .ubb-host-root 内：shield_hit:true 的记录不得判成 delivered:true');
{
  // (a) the door is open and the confirm point is clear, but the dispatch point
  // carries our own overlay (pill/stop button re-enabling pointer-events inside
  // the shadow tree): the event IS delivered — to us — and that is NOT proof.
  freshPage();
  injectWorld(0, { arm: true });
  state.deliverMs = 0;
  state.hitAt = [{ x: HX, y: HY, who: 'host' }];
  const dl = {};
  const e = await grab(() =>
    shieldCtl.withPass(
      1,
      async () => {
        await actions.mouse(1, 'mousePressed', HX, HY);
        await actions.mouse(1, 'mouseReleased', HX, HY);
      },
      { at: [OX, OY], delivery: dl, expect: pointerProof([HX, HY]) },
    ),
  );
  ok('(a) 门是开的、确认点干净，事件投到了、target 落进自家 host：红（INPUT_NOT_DELIVERED），不许 delivered:true', e.e?.code === 'INPUT_NOT_DELIVERED' && dl.delivered !== true, JSON.stringify(e.e?.code || dl));
  ok('(a) 页面元素收到的记录恒 0，全部记录都落在自家遮罩上（shield_hit:true ≥ 2）', ringPageHits(0).length === 0 && ringVeilHits(0).length >= 2, JSON.stringify({ page: ringPageHits(0).length, veil: ringVeilHits(0).length }));
  ok('(a) 取证明细如实：eaten≥2、missing 点名 mousedown/mouseup、快退不等满预算（全被吃就早点红）', dl.eaten >= 2 && (dl.missing || []).length === 2 && typeof dl.ms === 'number' && dl.ms < 1200, JSON.stringify({ eaten: dl.eaten, missing: dl.missing, ms: dl.ms }));
  state.hitAt = [];
  // (b) a caller that betrays the protocol (releases inside fn, the OLD shape)
  // must still be refused by the current gate: evidence-first ordering holds.
  freshPage();
  injectWorld(0, { arm: true });
  state.deliverMs = 350;
  const dl2 = {};
  const e2 = await grab(() =>
    shieldCtl.withPass(
      1,
      async (gate) => {
        await actions.mouse(1, 'mousePressed', X, Y);
        await actions.mouse(1, 'mouseReleased', X, Y);
        await gate.release(); // early release — exactly what the old withPass finally did
      },
      { at: [X, Y], delivery: dl2, expect: pointerProof([X, Y]) },
    ),
  );
  ok('(b) 调用方提前关门时事件落在已关的 veil 上：仍然 INPUT_NOT_DELIVERED，不冒充成功', e2.e?.code === 'INPUT_NOT_DELIVERED' && dl2.delivered !== true, JSON.stringify(e2.e?.code || dl2.delivered));
  ok('(b) 落环的记录全部 shield_hit:true（被自家遮罩吃掉 = 真机第六轮的直接画像），页面记录 0', ringPageHits(0).length === 0 && ringVeilHits(0).length >= 2, JSON.stringify({ page: ringPageHits(0).length, veil: ringVeilHits(0).length }));
  state.deliverMs = 0;
}

// ============================================================ 5. 可见标签不吃亏
console.log('\n[5] 可见标签（deliverMs=0）：毫秒级 delivered:true，取证往返有上界，无谓等待为 0');
{
  freshPage();
  injectWorld(0, { arm: true });
  state.deliverMs = 0;
  const t0 = nowMs();
  const r = await grab(() => reg.call('click', { tab_id: 1, x: X, y: Y }));
  const wall = nowMs() - t0;
  ok('零延迟动作照常成功且带证据：delivered:true', !!r.r && r.r.delivered === true, JSON.stringify(r.e?.code || r.r));
  ok('delivery_ms 是毫秒级（<200ms；证据在第一次轮询就在，不必等投递窗口）', typeof r.r?.delivery_ms === 'number' && r.r.delivery_ms < 200, JSON.stringify(r.r?.delivery_ms));
  ok('整个工具调用没有为取证多等一秒（wall < 1000ms，含开闸/确认/关门的全部往返）', wall < 1000, `wall=${wall}`);
  ok('取证往返有上界：投递环读 ≤ 2（基线 1 次 + 首轮命中 1 次），绝不进入 250ms×N 的轮询', deliveryReads().length <= 2, `reads=${deliveryReads().length}`);
  ok('活世界确认只花 1 次寻址查询（UBB_DELIVERY_QUERY ≤ 1）', deliveryQueries().length <= 1, `queries=${deliveryQueries().length}`);

  // an expect-less caller (hover, replay, DOM writers) must not be charged for
  // forensics at all — the ack-only shape costs zero delivery-channel round trips
  freshPage();
  injectWorld(0, { arm: true });
  state.deliverMs = 0;
  const dl3 = {};
  const h = await grab(() =>
    shieldCtl.withPass(1, async () => {
      await actions.mouse(1, 'mouseMoved', X, Y);
    }, { at: [X, Y], delivery: dl3 }),
  );
  ok('无 expect 的通路零取证成本：0 次投递环读、0 次 UBB_DELIVERY_QUERY，verdict=not_requested', !h.e && deliveryReads().length === 0 && deliveryQueries().length === 0 && dl3.verdict === 'not_requested', JSON.stringify({ reads: deliveryReads().length, q: deliveryQueries().length, v: dl3.verdict }));
}

// ============================================================ 6. 重发策略的边界
console.log('\n[6] 重发边界：工具面不传 resend → 拿不到证据直接红且不双发；move-only 至多重发一次；press/release 永不自动重发');
{
  // (a) THE TOOL BRANCH: tools.js never passes opts.resend (grep: no `resend:` in
  // the whole file), so an unprovable-but-visible failure must go red WITHOUT a
  // second press/release pair. Model: the events are physically delivered into a
  // document the action does not poll (deliverFrame 7, action covers frame 0).
  freshPage();
  injectWorld(0, { arm: true });
  state.deliverMs = 0;
  state.deliverFrame = 7; // the queue lands the events in a document nobody polled
  const seq = audit.seq;
  const t0 = nowMs();
  const r = await grab(() => reg.call('click', { tab_id: 1, x: X, y: Y }));
  const wall = nowMs() - t0;
  ok('(a) 证据在预算内等不到 → INPUT_NOT_DELIVERED（红），不许 ok:true', r.e?.code === 'INPUT_NOT_DELIVERED', JSON.stringify(r.r || r.e?.code));
  ok('(a) 预算确实等满了（≥7000ms 的等待——这不是瞬间假红，是取证到顶）', wall >= 6950, `wall=${wall}`);
  const pressed = state.wire.filter((c) => c.method === 'Input.dispatchMouseEvent' && c.params.type === 'mousePressed').length;
  const released = state.wire.filter((c) => c.method === 'Input.dispatchMouseEvent' && c.params.type === 'mouseReleased').length;
  ok('(a) 双触发风险面为 0：mousePressed/mouseReleased 各恰好 1 条 —— 工具不重发 press/release，红就是红', pressed === 1 && released === 1, JSON.stringify({ pressed, released }));
  ok('(a) 红动作也收了门（红完不给用户留敞开的页）：UBB_PASS close 已上线且 veil 回到 pointer-events:auto', state.releases.length >= 1 && veils()[0].style.pointerEvents === 'auto', JSON.stringify({ rel: state.releases.length, pe: veils()[0].style.pointerEvents }));
  const dErr = gateE(seq, 'dispatch')[0];
  ok('(a) audit 探针同步记 not_delivered + delivery_retried:false（红动作的取证结论可见）', dErr?.delivery_verdict === 'not_delivered' && dErr.delivery_retried === false, JSON.stringify(dErr && { v: dErr.delivery_verdict, retried: dErr.delivery_retried }));
  state.deliverFrame = 0;

  // (b) THE SAFETY RULE AT withPass LEVEL: even when a caller hands over a resend
  // callback, a press/release expectation must NEVER auto-repeat (a swallowed
  // press may already have submitted a form: 100ms later a resend double-fires it)
  freshPage();
  injectWorld(0, { arm: true });
  state.deliverMs = 0;
  state.hitAt = [{ x: HX, y: HY, who: 'host' }];
  let resendCalls = 0;
  const dl2 = {};
  const e2 = await grab(() =>
    shieldCtl.withPass(
      1,
      async () => {
        await actions.mouse(1, 'mousePressed', HX, HY);
        await actions.mouse(1, 'mouseReleased', HX, HY);
      },
      { at: [OX, OY], delivery: dl2, expect: pointerProof([HX, HY]), resend: () => { resendCalls++; } },
    ),
  );
  ok('(b) 给着 resend 回调、缺的是 press/release：resend 一次都不许被调（重发策略的安全半边）', e2.e?.code === 'INPUT_NOT_DELIVERED' && resendCalls === 0 && dl2.retried !== true, JSON.stringify({ code: e2.e?.code, resendCalls, retried: dl2.retried }));
  state.hitAt = [];

  // (c) THE MOVE-ONLY BRANCH (exists in withPass but no tool uses it): a lost
  // pointer move may be repeated exactly once, with the door held open across
  // the repeat; a second miss goes red — never an endless retry loop.
  freshPage();
  injectWorld(0, { arm: true });
  state.deliverMs = 0;
  let movedOnce = 0;
  const resendAt = [];
  const veilPeAtResend = [];
  const dl3 = {};
  const e3 = await grab(() =>
    shieldCtl.withPass(
      1,
      async () => {
        movedOnce++;
        await actions.mouse(1, 'mouseMoved', X, Y);
      },
      {
        at: [X, Y],
        delivery: dl3,
        expect: [{ types: ['mousemove', 'mouseMoved'], at: [X, Y] }],
        resend: async () => {
          resendAt.push(nowMs());
          // veil pointer-events RIGHT BEFORE the repeat: the door must still be
          // open (pointer-events:none) — releasing first is the very bug being fixed
          const v = veils()[0];
          veilPeAtResend.push(v ? v.style.pointerEvents : '(no veil)');
          await actions.mouse(1, 'mouseMoved', X, Y);
        },
      },
    ),
  );
  const moved = state.wire.filter((c) => c.method === 'Input.dispatchMouseEvent' && c.params.type === 'mouseMoved').length;
  ok('(c) move-only 缺失时重发分支真的走了（retried:true）且第二次也没证据 → 最终红 INPUT_NOT_DELIVERED', e3.e?.code === 'INPUT_NOT_DELIVERED' && dl3.retried === true, JSON.stringify({ code: e3.e?.code, retried: dl3.retried }));
  ok('(c) 重发次数上界：mouseMoved 上线总数恰好 2（首发 1 + 重发 1，没有第三次 —— 双触发风险面 ≤1 次重发）', resendAt.length === 1 && moved === 2, JSON.stringify({ resend: resendAt.length, moved }));
  ok('(c) "保持门开重发"是真的：重发那一刻 veil 仍 pointer-events:none（先重发后关门，与旧 bug 的"先关门再等"相反）', veilPeAtResend.length === 1 && veilPeAtResend[0] === 'none', JSON.stringify(veilPeAtResend));
}

// ============================================================ 7. INPUT_NOT_DELIVERED 的出路
console.log('\n[7] INPUT_NOT_DELIVERED 的 message 必须给真实下一步，不许只是 "failed"');
{
  freshPage();
  injectWorld(0, { arm: true });
  state.deliverMs = 0;
  state.hitAt = [{ x: HX, y: HY, who: 'host' }];
  const dl = {};
  const e = await grab(() =>
    shieldCtl.withPass(
      1,
      async () => {
        await actions.mouse(1, 'mousePressed', HX, HY);
        await actions.mouse(1, 'mouseReleased', HX, HY);
      },
      { at: [OX, OY], delivery: dl, expect: pointerProof([HX, HY]) },
    ),
  );
  const msg = String(e.e?.message || '');
  ok('有 code 且不是被吞掉的 "failed"：code=INPUT_NOT_DELIVERED，message 是成句的中文诊断（>80 字符）', e.e?.code === 'INPUT_NOT_DELIVERED' && msg.length > 80 && msg !== 'INPUT_NOT_DELIVERED', JSON.stringify({ code: e.e?.code, len: msg.length }));
  ok('出路①：点名标签可见性（tab.select 不改 visibilityState / 把窗口提到前台）', /tab\.select/.test(msg) && /前台|visibilityState|窗口/.test(msg), msg.slice(0, 120));
  ok('出路②：给出替代通路（桥的合成事件 / @d ref 走 DOM 事件，不进投递队列）', /合成事件|桥|DOM 事件|@d/.test(msg), '(next-step 2)');
  ok('出路③：交回用户的通道（request_help）在指引里', /request_help/.test(msg), '(next-step 3)');
  ok('明说"别原样重试"（防 agent 拿红当抖动二次点击 → 双提交）', /别原样重试|不要重试|二选一|三选一/.test(msg), '(no-blind-retry)');
  const d = e.e?.data || {};
  ok('错误自带可核对的取证数据（data: waited_ms / records_seen / records_on_own_veil / missing_events / veil_at_read）', typeof d.waited_ms === 'number' && d.records_seen >= 2 && d.records_on_own_veil >= 2 && Array.isArray(d.missing_events) && d.missing_events.length === 2, JSON.stringify(d));
  state.hitAt = [];
}

// ============================================================ 8. 返回形状静态钉
console.log('\n[8] 静态：四个工具的返回都必须经 deliveredField(dl)，delivered:false 永远出不了成功返回');
{
  const toolsSrc = fs.readFileSync(new URL('tools.js', LIB), 'utf8');
  const ctlSrc = fs.readFileSync(new URL('shield-ctl.js', LIB), 'utf8');
  const nDeliveredField = (toolsSrc.match(/delivered:\s*deliveredField\(dl\)/g) || []).length;
  ok('click/fill/drag/form.set 的返回形状里 deliveredField(dl) 至少出现 4 次（四个工具全接上诚实三态）', nDeliveredField >= 4, `count=${nDeliveredField}`);
  ok('deliveredField 自己钉死：unprovable/not_requested 报 null，成功路径只可能是 true（false 出不了 throw 之外）', /dl\.verdict === 'unprovable' \|\| dl\.verdict === 'not_requested'\) return null/.test(toolsSrc), '(shape)');
  ok('tools.js 全文件没有任何 resend 入口（press/release/text 的重发面在工具层为 0，行为断言见 [6]）', !/resend:/.test(toolsSrc), '(no tool-level resend)');
  ok('withPass 的红路径也是先收门再 throw（红动作不许把页面留在敞开的遮挡下）', /await capped\(gate\.release\(\), PASS_RELEASE_MS\);\s*\n\s*throw deliveryFailure/.test(ctlSrc), '(ordering)');
  ok('matchDelivery 的判据里有且有对 shield_hit 的显式跳过（"落在自家遮罩上不算证据"这条规则就在源码里）', /if \(r\.shield_hit === true\) continue;/.test(ctlSrc), '(rule present)');
}

// ============================================================ 9. fix20 两条已记录残留
console.log('\n[9] fix20 残留一：命中身份 + 盒内/盒外容差 —— 残留二：>8 帧分块定向检索，不降级');
{
  // ── 残留一 ①（取证侧身份）：盒内正常投递，审计必须能回答"打到的是不是目标"
  freshPage();
  injectWorld(0, { arm: true });
  const pg = state.doc.__page;
  pg.className = 'btn save';
  pg.textContent = 'Save batch';
  pg.__rect = [55, 292, 75, 306]; // (X,Y)=(65,299) 距盒各边 ≥2px
  state.deliverMs = 0;
  const dl1 = {};
  const aSeq = audit.seq;
  const g1 = await grab(() =>
    shieldCtl.withPass(
      1,
      async () => {
        await actions.mouse(1, 'mousePressed', X, Y);
        await actions.mouse(1, 'mouseReleased', X, Y);
      },
      { at: [X, Y], delivery: dl1, expect: pointerProof([X, Y]) },
    ),
  );
  ok('前提：派发点在目标盒内，动作照常 delivered:true', g1.e === null && dl1.verdict === 'proven' && dl1.delivered === true, JSON.stringify({ v: dl1.verdict, code: g1.e?.code }));
  const mDump = JSON.stringify(dl1.matched || []);
  ok('残留一·记录侧：matched 证据带命中目标的 id/cls/text 与实际盒子（RC① 拿掉身份取证必红）', mDump.includes('b-save') && mDump.includes('btn') && mDump.includes('Save batch') && mDump.includes('"box":[55,292,75,306]'), mDump.slice(0, 240));
  const ringRaw = String(frameDoc(0).documentElement.getAttribute('data-ubb-delivery'));
  ok('身份是页侧记录器写进环的（不是读侧凭空补的）：环原始行含 id 与 box', ringRaw.includes('b-save') && ringRaw.includes('55,292,75,306'), ringRaw.slice(0, 180));
  const probeDump = JSON.stringify(gateE(aSeq, 'open'));
  ok('残留一·闸门侧：pass_gate 的 doms 带命中身份 he(tag#id) 与实际命中点 hat（RC① 下这条也红）', probeDump.includes('#b-save') && probeDump.includes('"hat":[65,299]'), probeDump.slice(0, 240));

  // ── 残留一 ②：真机 9px 出盒形状 —— 同 tag 的上排元素接走了事件
  freshPage();
  injectWorld(0, { arm: true });
  state.doc.__page.__rect = [55, 292, 75, 306];
  const row = state.doc.createElement('button');
  row.setAttribute('id', 'row-above');
  row.__rect = [55, 268, 75, 290]; // 派发点 y=299 在这只盒子外 9px —— LIVE-RESULTS-6 的 18/20 形状
  state.doc.body.appendChild(row);
  state.hitAt = [{ x: X, y: Y, el: row }];
  const dl2 = {};
  const g2 = await grab(() =>
    shieldCtl.withPass(
      1,
      async () => {
        await actions.mouse(1, 'mousePressed', X, Y);
        await actions.mouse(1, 'mouseReleased', X, Y);
      },
      { at: [X, Y], delivery: dl2, expect: pointerProof([X, Y]) },
    ),
  );
  ok('残留一·容差：命中点落在盒外 9px 的同 tag 元素上 → 必须红 INPUT_NOT_DELIVERED（旧 48px 中心距会放掉它）', g2.e?.code === 'INPUT_NOT_DELIVERED' && dl2.verdict === 'not_delivered', JSON.stringify({ code: g2.e?.code, v: dl2.verdict }));
  ok('红的那一刻审计仍可读：records_seen=2，每条记录写着实际命中的是 row-above（"打到的是不是目标"有答案）', (g2.e?.data || {}).records_seen === 2 && String(frameDoc(0).documentElement.getAttribute('data-ubb-delivery')).includes('row-above'), JSON.stringify({ seen: (g2.e?.data || {}).records_seen }));
  state.hitAt = [];

  // ── 残留一 ③：容差可测 —— 盒内 1px 算过 / 盒外(>N=2) 算不过
  const boxCase = async (rect) => {
    freshPage();
    injectWorld(0, { arm: true });
    state.doc.__page.__rect = rect;
    const dl = {};
    const r = await grab(() =>
      shieldCtl.withPass(
        1,
        async () => {
          await actions.mouse(1, 'mousePressed', X, Y);
          await actions.mouse(1, 'mouseReleased', X, Y);
        },
        { at: [X, Y], delivery: dl, expect: pointerProof([X, Y]) },
      ),
    );
    return { r, dl, code: r.e?.code || null };
  };
  const inn = await boxCase([66, 297, 80, 310]); // 点在盒左缘外 1px ≤ N=2 → 过（页侧 box 外扩取整只会更宽容）
  ok('容差·盒内/缘上 1px 算过（delivered:true）', inn.r.e === null && inn.dl.delivered === true, JSON.stringify({ code: inn.code }));
  const out3 = await boxCase([68, 299, 80, 310]); // 点在盒外 3px > N=2 → 不过
  ok('容差·盒外必红（RC② 把容差改成"任意点都算命中"后这条红）', out3.code === 'INPUT_NOT_DELIVERED', JSON.stringify({ code: out3.code }));

  // ── 残留二 ①：12 帧页面，事件落在第 9 帧 —— 旧 slice(0,8) 从此放弃取证，现在必须拿到
  freshPage();
  state.frames = Array.from({ length: 12 }, (_, i) => i);
  injectWorld(0, { arm: true });
  for (let f = 1; f < 12; f++) injectWorld(f, {});
  state.deliverFrame = 9;
  const dl9 = {};
  const g9 = await grab(() =>
    shieldCtl.withPass(
      1,
      async () => {
        await actions.mouse(1, 'mousePressed', X, Y);
        await actions.mouse(1, 'mouseReleased', X, Y);
      },
      { at: [X, Y], delivery: dl9, expect: pointerProof([X, Y]) },
    ),
  );
  ok('残留二①：>8 帧仍拿到正确那一帧（frameId 9）的证据且 delivered:true —— RC③ 恢复">8 帧降级"必红', g9.e === null && dl9.delivered === true && (dl9.matched || []).some((m) => m.frameId === 9), JSON.stringify({ v: dl9.verdict, m: (dl9.matched || []).map((x) => x.frameId) }));
  const readCalls = state.scriptings.filter((s) => s.func === '__ubbFrameDeliveryRead');
  const tailChunk = readCalls.filter((s) => s.frameIds.length === 4); // 尾块 [8..11]：分块全帧读的第一手证据
  ok('残留二①b：读取是分块(≤8)的定向检索（出现 4 帧尾块调用；每轮 poll 两次 executeScript，帧多只是成本不是放弃）', tailChunk.length >= 1 && readCalls.every((s) => s.frameIds.length <= 8), JSON.stringify(readCalls.map((s) => s.frameIds.length)));

  // ── 残留二 ②：>8 帧且拿不到证据 → 诚实红，不是 unprovable 降级成功
  freshPage();
  state.frames = Array.from({ length: 12 }, (_, i) => i);
  injectWorld(0, { arm: true });
  for (let f = 1; f < 12; f++) injectWorld(f, {});
  state.deliverFrame = 12; // 事件落进一个不在取证集合里的文档：12 帧都活着应答，但谁都没记录
  const dl10 = {};
  const g10 = await grab(() =>
    shieldCtl.withPass(
      1,
      async () => {
        await actions.mouse(1, 'mousePressed', X, Y);
        await actions.mouse(1, 'mouseReleased', X, Y);
      },
      { at: [X, Y], delivery: dl10, expect: pointerProof([X, Y]) },
    ),
  );
  ok('残留二②：多帧拿不到证据时是诚实红 INPUT_NOT_DELIVERED（verdict not_delivered，不是 unprovable、更不是 ok:true）', g10.e?.code === 'INPUT_NOT_DELIVERED' && dl10.verdict === 'not_delivered', JSON.stringify({ code: g10.e?.code, v: dl10.verdict }));
}

console.log('\n──────────────────────────────────────────');
queue.cancel();
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
