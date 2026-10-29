// fix-1 offline gate test — the shield pass-through channel that LIVE-RESULTS
// 阻断性发现 #1 broke in the real browser, modelled instead of mocked away: the
// ACTUAL content/shield.js source runs (node:vm) against a tiny DOM,
// chrome.tabs.sendMessage implements Chrome's frame-addressing + first-responder
// semantics, chrome.scripting.executeScript really re-serialises the injected
// function, and every CDP command lands on a wire the assertions can inspect.
//
//   node daemon/test-shield.mjs
//
// Reverse controls (§6.3) — each one MUST go red. Clones live OUTSIDE the repo
// (contract §0): RCROOT=D:/Codebase/ubb-scratch/rc/fix1
//   a) 幂等去掉:
//        cp -r lib $RCROOT/rc-a/lib && cp -r content $RCROOT/rc-a/content
//        node -e 'const f=process.env.RCROOT+"/rc-a/content/shield.js",fs=require("fs");let s=fs.readFileSync(f,"utf8");if(!s.includes("      h.remove();"))process.exit(9);fs.writeFileSync(f,s.replace("      h.remove();","      // RC-a: no reap"))'
//        node daemon/test-shield.mjs --lib $RCROOT/rc-a/lib --content $RCROOT/rc-a/content
//      → [1] 的三条 host 唯一性断言必须红
//   b) 把 pass 确认退回"只看 ack / 只看 400ms 超时":
//        cp -r lib $RCROOT/rc-b/lib
//        node -e 'const f=process.env.RCROOT+"/rc-b/lib/shield-ctl.js",fs=require("fs");const s=fs.readFileSync(f,"utf8");const A="export async function ensurePass(tabId, opts = {}) {\n  const frameId";if(!s.includes(A))process.exit(9);fs.writeFileSync(f,s.replace(A,"export async function ensurePass(tabId, opts = {}) {\n  await capped(shield.pass(tabId, true));\n  return { confirmed: true, frameId: 0, at: null, frames: [0] };\n  const frameId"))'
//        node daemon/test-shield.mjs --lib $RCROOT/rc-b/lib
//      → [3] "未确认不得上线鼠标事件" 必须红
//   c) 把 frameId 去掉重走广播语义:
//        cp -r lib $RCROOT/rc-c/lib
//        node -e 'const f=process.env.RCROOT+"/rc-c/lib/shield-ctl.js",fs=require("fs");const s=fs.readFileSync(f,"utf8");const A="chrome.tabs.sendMessage(tabId, payload, { frameId }), timeoutMs";if(!s.includes(A))process.exit(9);fs.writeFileSync(f,s.replace(A,"chrome.tabs.sendMessage(tabId, payload), timeoutMs"))'
//        node daemon/test-shield.mjs --lib $RCROOT/rc-c/lib
//      → [2] 的定向断言必须红
//   fix6 [8] (补 arm 的结论必须可见) — 克隆在仓库外（§0），patcher 一次改两处：
//        node D:/Codebase/ubb-scratch/rc/fix6/patch.cjs c <rcdir>
//        node daemon/test-shield.mjs --lib <rcdir>/lib --bg <rcdir>/background.js
//      → 问不到盾牌被说成 "shield_not_active" 必须红；background.js 退回
//        rearmFrame(…).catch(() => {}) 时两条 static 必须红
//   fix7 三条时序/渲染树对照（克隆目录 D:/Codebase/ubb-scratch/rc/fix7，patcher
//   用的锚点字符串见下；缺锚点即 exit 9，不会静默"跑了个没改的副本"）：
//   ① 把派发前的点位确认退回"只看整体 veil 状态"（删 domVerdict 的 hit 判据）:
//        node daemon/test-shield.mjs --lib .../rc/fix7/rc-1/lib
//      → [9] 红三条，形状正是 LIVE-RESULTS-2B 7g 的谎报：
//        {"clicked":[65,299],"via":"coords"} + 线路上 mouseMoved/mousePressed/mouseReleased
//   ② 把 pass 事务改回共享布尔 / 共享 TTL（撤销关整扇门）:
//        node daemon/test-shield.mjs --lib .../rc-2/lib --content .../rc-2/content
//      → [10] 红五条，含派发采样 {"type":"mouseMoved","veil":"auto","hit_page":false}
//        （第一个事件就是打在合上的遮罩上的）+ "跨动作不共享 TTL" 红
//   ③ 把 withHiddenShield 改回只设 pointer-events（host 留在渲染树里）:
//        node daemon/test-shield.mjs --lib .../rc/fix7/rc-3/lib --content .../rc-3/content
//      → [12] 红四条：窗口内 computed display 仍是 "block"、回读 displayed=1、
//        消息送不到的孤儿 host 照旧进渲染树 —— 就是 6d 泄进 PDF 的那一层
//   fix8 三条反向对照（闸门装进 actions.mouse()/key()；克隆目录 D:/Codebase/ubb-scratch/rc/fix8）：
//   ① 去掉 mouse() 里的闸门调用（只删第一次出现的 assertInputGate，key() 保留）:
//        cp -r lib $RCROOT8/rc-1/lib
//        node -e 'const f=process.env.RCROOT8+"/rc-1/lib/actions.js",fs=require("fs");const s=fs.readFileSync(f,"utf8");const A="  await assertInputGate(tabId);";if(!s.includes(A))process.exit(9);fs.writeFileSync(f,s.replace(A,"  // RC-1: mouse() 不再逐派发确认"))'
//        node daemon/test-shield.mjs --lib $RCROOT8/rc-1/lib
//      → [13]①的 SHIELD_PASS_FAILED/零 Input 上线路 与 静态"mouse() 体内 assertInputGate 先于 cdp.send"
//        红，③ 的下界（opens ≥ events+1）也红
//   ② 让闸门失败时仍继续派发（两处 assertInputGate 都吞掉异常）:
//        cp -r lib $RCROOT8/rc-2/lib
//        node -e 'const f=process.env.RCROOT8+"/rc-2/lib/actions.js",fs=require("fs");let s=fs.readFileSync(f,"utf8");const A="  await assertInputGate(tabId);";if(!s.includes(A))process.exit(9);while(s.includes(A))s=s.replace(A,"  await assertInputGate(tabId).catch(() => {});");fs.writeFileSync(f,s)'
//        node daemon/test-shield.mjs --lib $RCROOT8/rc-2/lib
//      → [13]①/②/②b 的"线路上 0 条 Input.*"必红（事件照发，回到 7g 的谎报形状）
//   ③ 故意造成双重确认（click 坐标路径的 mouseMoved 前塞回一次显式 gate.check）:
//        cp -r lib $RCROOT8/rc-3/lib
//        node -e 'const f=process.env.RCROOT8+"/rc-3/lib/tools.js",fs=require("fs");const s=fs.readFileSync(f,"utf8");const A="        await mouse(tabId, '\''mouseMoved'\'', p.x, p.y);";if(!s.includes(A))process.exit(9);fs.writeFileSync(f,s.replace(A,"        await gate.check();\n"+A))'
//        node daemon/test-shield.mjs --lib $RCROOT8/rc-3/lib
//      → [13]③ 的上界（opens ≤ events+1）与静态"零双重确认"红（opens=5, events=3）
//   fix9 两条反向对照（human.js 自发的 Input.* / cdp.call 的裸发形状；克隆在
//   D:/Codebase/ubb-scratch/rc/fix9，仓库内零 _ 条目）：
//   ③ 去掉 human.js 的逐派发确认（`if (prove) await assertInputGate(tabId);` 与 6 处
//     `await assertInputGate(tabId);` 全替换成注释）:
//        cp -r lib $RCROOT9/rc-3/lib && patch lib/human.js
//        node daemon/test-shield.mjs --lib $RCROOT9/rc-3/lib
//      → [14] 红 7 条：{"clicked":[65,299],"via":"coords"} 与 {"typed":true} —— 遮罩在动作中途
//        关上，19 条鼠标事件 / 8 条键事件全部上了线路、页面一条没收到，而确认数掉回 opens=2
//   ④ 把 cdp.call 的 Input.* 还原成"裸发且返回值干净"（删掉 if (rawInput) 那段与审计里的键）:
//        cp -r lib $RCROOT9/rc-4/lib && patch lib/tools.js
//        node daemon/test-shield.mjs --lib $RCROOT9/rc-4/lib
//      → [15] 红 5 条，返回值原文就是那个沉默形状：{"method":"Input.dispatchMouseEvent","result":{}}
//        （事件发了、没人说它没经过盾牌确认；审计里 gate_bypassed=null）
//   fix10 一条反向对照（human 通路的重叠确认不许悄悄回来；克隆在
//   D:/Codebase/ubb-scratch/rc/fix10，仓库内零 _ 条目，§0）：
//   ① 往 tools.js 的 human 分支塞回一次显式 gate.check()（withPass 的回调参数一起恢复）:
//        cp -r lib $RCROOT10/rc-1/lib
//        node -e 'const f=process.env.RCROOT10+"/rc-1/lib/tools.js",fs=require("fs");let s=fs.readFileSync(f,"utf8");const R=[["      await withPass(tabId, async () => {\n        if (await human.isEnabled()) {","      await withPass(tabId, async (gate) => {\n        if (await human.isEnabled()) {\n          await gate.check();"],["    const input = withPass(tabId, async () => {\n      if (humanOn) {","    const input = withPass(tabId, async (gate) => {\n      if (humanOn) {\n        await gate.check();"],["      if (await human.isEnabled()) {\n        await human.humanType(tabId, p.text);","      await gate.check();\n      if (await human.isEnabled()) {\n        await human.humanType(tabId, p.text);"]];for(const [a,b] of R){if(!s.includes(a))process.exit(9);s=s.replace(a,b);}fs.writeFileSync(f,s)'
//        node daemon/test-shield.mjs --lib $RCROOT10/rc-1/lib
//      → [12] 末尾的两条静态 + [14] 的两条往返上界红：opens 恒等于 bound+1（实测 8/7、type 的 4/keys+1），
//        [13]② 的 type 那条作为副产物一起红（塞回的那一刀把它的注入点整体后移了一格）
//        —— 多付的就是那一个来回，事件一条没少发，页面却看不出区别
//   fix11 三条反向对照（账本↔DOM 双向失配；克隆目录 D:/Codebase/ubb-scratch/rc/fix11，仓库内零 `_` 条目）：
//   a) 把点位回读从确认里撤掉，恢复"账本说开着就算确认"（confirmTxn 开头短路）:
//        cp -r lib $RC11/rc-a/lib && node $RC11/patch-a.cjs
//        node daemon/test-shield.mjs --lib $RC11/rc-a/lib
//      → [16]① 红：`{"clicked":[65,299],"via":"coords"}` 照样回来 + 线路上 3 条 Input.dispatchMouseEvent，
//        而那一刻 DOM 明明白白写着回读没有答案、点位被占（就是 3A 8-1 的 9/9 谎报形状）
//   b) 去掉 world 初始化时对孤儿 host 的对账（document_start 那句 reconcile(true)）:
//        cp -r content $RC11/rc-b/content && node $RC11/patch-b.cjs
//        node daemon/test-shield.mjs --content $RC11/rc-b/content
//      → [16]② 红：world 重建后 veil 仍 pointer-events:none、死令牌还挂在属性上（3A 8-6 的敞开）
//   c) 让过期令牌不再参与 pass/veil 计算（aliveParts 不按 stamp 排除到期条目）:
//        cp -r content $RC11/rc-c/content && node $RC11/patch-c.cjs
//        node daemon/test-shield.mjs --content $RC11/rc-c/content
//      → [16]② 红三条 + [10] 的"无人撤销时自收门"红：过期令牌照旧算"开着"，门永远不关
//   fix15 两条反向对照（**已被 fix16 回退取代，留作诊断材料**；克隆目录
//   D:/Codebase/ubb-scratch/rc/fix15，仓库内零 `_` 条目，§0）。回退后这两条 patcher
//   会因缺锚点自行 exit 9（它们的锚点就是被撤下的 unknown-state/PASS_STATE_ASKS），
//   跑不动是预期的，别再照这两条跑：
//   a) 把 :567 恢复成原形状（`!st` 与"问了、确实不拦"合成分支，两者都 confirmed:true）:
//        mkdir rc-a && cp -r <repo>/lib rc-a/lib && node rc/fix15/patch-a.cjs rc-a
//        node daemon/test-shield.mjs --lib D:/Codebase/ubb-scratch/rc/fix15/rc-a/lib
//      → [17]① 红：原文就是 LIVE-RESULTS-4 1-0 的谎报形状 `{"clicked":[65,299],"via":"coords"}`
//        + 线路上 3 条 Input.dispatchMouseEvent，而那一刻盾牌一个字都没回答（12 红）
//   b) 让 border/off 也走未知拒绝（过度收紧）:
//        mkdir rc-b && cp -r <repo>/lib rc-b/lib && node rc/fix15/patch-b.cjs rc-b
//        node daemon/test-shield.mjs --lib D:/Codebase/ubb-scratch/rc/fix15/rc-b/lib
//      → [17]② 红五条：off / armed+blockMode:border 的合法放行全部变成 SHIELD_PASS_FAILED（6 红）
//   fix16 两条反向对照（判定路径探针 + attribution-roots 回退；克隆目录
//   D:/Codebase/ubb-scratch/rc/fix16，仓库内零 `_` 条目，§0；patcher 缺锚点即 exit 9）：
//   a) 把探针字段整个拿掉（passProbeLog() 变空）:
//        mkdir rc-a && cp -r <repo>/lib rc-a/lib && node rc/fix16/patch-a.cjs rc-a
//        node daemon/test-shield.mjs --lib D:/Codebase/ubb-scratch/rc/fix16/rc-a/lib
//      → 20 红：[18] 全部 + [17] 的 ①a/①b/①c/②border 四条"确认放行那次动作里探针字段
//        必须真实出现"的断言（Q1 耗时/delivered、Q2 verdict+hit、Q3 预算分解一起消失）
//   b) 回退后再把 border/off（含 !st）改成拒绝（过度收紧）:
//        mkdir rc-b && cp -r <repo>/lib rc-b/lib && node rc/fix16/patch-b.cjs rc-b
//        node daemon/test-shield.mjs --lib D:/Codebase/ubb-scratch/rc/fix16/rc-b/lib
//      → 12 红：②off/②border 的合法放行与点击照常落地全部变 SHIELD_PASS_FAILED，
//        加上 ①a/①b 的 not-armed 放行、②border 的探针 verdict、RC-static 的回退锚点
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
// fix6: the frame re-arm wiring lives in background.js (outside lib/), so an RC
// copy of it has to be pointable separately.
const BG = path.resolve(HERE, arg('--bg', '../background.js'));

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
const codeOf = async (f) => (await grab(f)).e?.code || '(no throw)';

const SHIELD_SRC = fs.readFileSync(new URL('shield.js', CONTENT), 'utf8');

// ---------------------------------------------------------------- tiny DOM
// Enough platform for the REAL shield.js plus the function chrome.scripting
// injects, and one hit-test rule the whole bug hinged on: a visible host whose
// veil is pointer-events:auto eats a real mouse event, and the browser
// retargets that hit to the shadow host (.ubb-host-root).
class El {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
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
  // shield-ctl's hit readback asks `el.classList.contains('ubb-host-root')`, so
  // the fake element has to answer it like a real one does
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
  /** Every capture-phase listener of this node, in REGISTRATION ORDER — the one
   *  ordering rule this whole bug hinges on: content/shield.js registers its
   *  delivery record BEFORE its own blocking listener, so an event our blocker
   *  goes on to eat is still recorded (with shield_hit:true). */
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
}

const computed = (el) => ({
  display: el.style.display === 'none' ? 'none' : 'block',
  // .veil is pointer-events:auto in the shadow stylesheet; inline wins
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
  // doc.addEventListener comes from El now: the delivery record registers on
  // document too in a real world, and a stub that swallows it cannot model that
  doc.querySelectorAll = (sel) => doc._all().filter((e) => e._matches(sel));
  doc.querySelector = (sel) => doc.querySelectorAll(sel)[0] || null;
  doc.elementFromPoint = (x, y) => {
    // a planted hit at an EXACT coordinate: the shield's own pill / helpcard /
    // confirm overlay live inside the same shadow tree and re-enable
    // pointer-events, so a real hit-test there retargets to the host while the
    // veil itself is open. This is what a whole-veil-state read cannot see.
    for (const h of state.hitAt || []) {
      if (h.x === x && h.y === y) return h.who === 'page' ? page : doc.querySelectorAll('.ubb-host-root')[0] || page;
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
const OURS = 'ubb-offline-harness'; // chrome.runtime.id of lib/testharness.mjs's stub
const state = {
  doc: null,
  docs: new Map(), // frameId → its OWN document (a real frame's DOM is not the top document's)
  worlds: new Map(), // frameId → [world]  (several worlds per frame = the bug)
  sends: [], // {tabId,payload,opts} — opts undefined means a BROADCAST
  scriptings: [], // {tabId,frameIds,func,op,token,at,owner}
  wire: [], // CDP commands actually dispatched
  frames: [0],
  hitAt: [], // [{x,y,who}] planted exact-coordinate hits (see elementFromPoint)
  // ── fix17 DELIVERY MODEL KNOBS ──────────────────────────────────────────────
  // An `Input.*` command is ACKED the moment it reaches the wire and DELIVERED
  // `deliverMs` later, into the frame `deliverFrame` owns, where the hit test of
  // THAT MOMENT decides whether the event lands on the page or on this extension's
  // own veil. Default 0 = what the suites used to assume implicitly; the delay
  // groups set 5000 to reproduce the real browser (LIVE-RESULTS-6).
  deliverMs: 0,
  deliverFrame: 0,
  releases: [], // {at, token} — WHEN each pass transaction was actually closed
  injected: [], // every chrome.scripting call: {func, frameIds, op}
  delivered: [], // what the DOCUMENT received: {type,x,y,acked_at,delivered_at,shield_hit}
};

/** The document-side record, straight out of the SHARED DOM (not a world-local
 *  variable) — exactly what lib/shield-ctl.js reads back. */
function deliveryRing(frameId = 0) {
  const el = frameDoc(frameId).documentElement;
  const raw = el.getAttribute('data-ubb-delivery');
  if (raw === null) return null; // no ring at all = the older content-script world
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

/** One document per frame, the way a browser actually gives them out: a pass
 *  stamped in frame 7's host must not be visible (or reusable) in frame 0. */
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
  state.injected = [];
  state.deliverFrame = 0;
  queue.cancel();
  queue.wire.length = 0;
}

/** A frame's window: the same listener registry the element stub has, because the
 *  delivery record and the blocking listener are BOTH registered on window at
 *  capture phase, and their registration ORDER is the thing under test. */
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

/** Run the real content/shield.js as ONE content-script world of ONE frame.
 *  arm:true → controlled tab (mode armed, veil blocking).
 *  thenKill:true → the world an extension reload tears down: its host node
 *  stays in the DOM, its message listener is gone (a veil nothing can open).
 *  freeze:true → a HIDDEN/occluded tab whose timers Chrome throttles: every
 *  setTimeout the shield arms (token expiry, sweep) is queued and never runs,
 *  which is exactly how 3A's token sat expired for 287 seconds.
 *  owner → which extension id built it (a second installed copy differs). */
function injectWorld(frameId, { owner = OURS, arm = false, thenKill = false, ready = 'complete', freeze = false } = {}) {
  const doc = frameDoc(frameId);
  const win = mkWindow(doc);
  const world = { frameId, owner, listeners: [], ctx: null, timers: [], win };
  doc.readyState = ready;
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
    setTimeout: freeze ? (fn) => (world.timers.push(fn), world.timers.length) : setTimeout,
    clearTimeout: freeze ? () => {} : clearTimeout,
    Math,
    Date,
  });
  vm.runInContext(SHIELD_SRC, world.ctx);
  if (arm) {
    for (const fn of world.listeners.slice()) fn({ type: 'UBB_SHIELD', mode: 'armed', blockMode: 'block' }, { frameId }, () => {});
  }
  if (thenKill) world.listeners = [];
  const list = state.worlds.get(frameId) || [];
  list.push(world);
  state.worlds.set(frameId, list);
  return world;
}

/** ONE delivered input event, as a browser would hand it to a frame: a fresh
 *  Event object per world (isolated worlds never share one), the retargeted
 *  `target` the hit test produced, `composedPath()` from inside that world (so a
 *  shield hit is visible exactly the way content/shield.js reads it), and
 *  capture-phase dispatch on window first, then document.
 *  This is what the offline suites were missing: before fix17 an `Input.*` stub
 *  ACKED and the document model saw nothing, so "tool said ok, page got nothing"
 *  was not representable — 1648 green assertions and a 20/20 live lie. */
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
    if (w.win.fire(e)) continue; // that world stopped it; another world still gets its own copy
    if (e.__stopped) continue;
    doc.fire(e);
  }
  return fired;
}

const hosts = () => state.doc.querySelectorAll('.ubb-host-root');
/** The same read for one named frame's own document. */
const hostsIn = (frameId) => (state.docs.get(frameId) || state.doc).querySelectorAll('.ubb-host-root');
/** The newest world of the main frame — its `timers` array is what a throttled
 *  (hidden-tab) world never gets to run. */
const world0 = () => (state.worlds.get(0) || []).slice(-1)[0] || null;
const hostCount = () => hosts().length;
const veils = () => hosts().map((h) => (h.shadowRoot && h.shadowRoot.querySelector('.veil')) || null);
const mouseOnWire = () => state.wire.filter((c) => c.method === 'Input.dispatchMouseEvent');
const passSends = (on) => state.sends.filter((s) => s.payload?.type === 'UBB_PASS' && (on === undefined || s.payload.on === on));
/** Distinct pass TRANSACTION tokens seen. With every dispatch re-confirming its
 *  own point, the number of UBB_PASS sends is no longer the number of gate
 *  ROUNDS — a round is one token, and that is what "重试有界" has to mean now. */
const passTxnTokens = (on) => [...new Set(passSends(on).map((s) => s.payload?.token).filter(Boolean))];
const opensAt = (frameId) => passSends(true).filter((s) => s.opts?.frameId === frameId);
/** Drop a stale same-owner host in, the way a torn-down world leaves one. */
function plantHost(owner) {
  const h = state.doc.createElement('div');
  h.className = 'ubb-host-root';
  h.setAttribute('data-ubb-owner', owner);
  const root = h.attachShadow({ mode: 'open' });
  const inner = root.appendChild(state.doc.createElement('div'));
  inner.className = 'veil';
  inner.style.pointerEvents = 'auto';
  state.doc.documentElement.appendChild(h);
  return h;
}

/** Chrome semantics: with {frameId} only that frame runs; without it EVERY
 *  frame runs and the first sendResponse wins the reply slot. A frame whose
 *  listeners never answer rejects differently from one with no listeners. */
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

/** ── the delivery queue ──────────────────────────────────────────────────────
 * Built on lib/testharness.mjs's model: `Input.*` is ACKED the moment it reaches
 * the wire and DELIVERED `state.deliverMs` later, hit-tested against the veil as
 * it stands AT THAT MOMENT — which is the one thing the old stub refused to
 * represent, and the reason "tool ok:true, page received nothing" could not be
 * written as an assertion. The document records the event itself: the recorder is
 * the REAL content/shield.js running in a vm context, not a test-local fake. */
const queue = makeDeliveryModel({
  deliverMs: 0,
  hitTest: (x, y, item) => {
    const doc = frameDoc(state.deliverFrame || 0);
    // KEY events are not hit-tested by a browser: they go to the focused document.
    // The veil still decides, because content/shield.js answers "was this key
    // eaten by our own blocker" from blockingKeys() — the fake models the same
    // rule through the same blocking state, so a blocking veil is also a hit.
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
const realSend = chromeStub.tabs.sendMessage;
function wireChrome() {
  chromeStub.tabs.sendMessage = async (tabId, payload, opts) => {
    state.sends.push({ tabId, payload, opts, at: Date.now() });
    // the door-close is what "release" MEANS on the wire; timestamped, so a test
    // can say whether the gate closed before or after the event was delivered
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
        // only the pass channel has the (op, token, expire, at, owner, claims)
        // shape; the delivery channels take [owner] — do not fake an op for them
        op: name === '__ubbFramePass' ? args[0] : null,
        token: name === '__ubbFramePass' ? args[1] : null,
        expire: name === '__ubbFramePass' ? args[2] : null,
        at: name === '__ubbFramePass' ? args[3] : null,
        owner: name === '__ubbFramePass' ? args[4] : args[0],
      });
      state.injected.push({ func: name, frameIds, op: args[0] });
      // re-serialise exactly like Chrome: a func that closed over module scope
      // dies right here, the same way it would in the browser. One result PER
      // FRAME, because that is what chrome.scripting hands back.
      const out = [];
      for (const fid of frameIds) {
        const w = (state.worlds.get(fid) || [])[0];
        if (!w) continue; // a frame nobody injected: no result for it, like Chrome
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
const { bridge, bridgeWedgeOf, clearBridgeWedge } = await import(new URL('bridge-ctl.js', LIB).href);
cdp.ensure = async () => ({});
// ACK NOW, DELIVER LATER — the whole bug in two lines. Everything the older
// suites assert (mouseOnWire(), the parameter contract, the command order) is
// unchanged: state.wire is still the wire, filled at ack time.
cdp.send = async (tabId, method, params = {}) => {
  state.wire.push({ method, params });
  if (queue.deliverMs !== state.deliverMs) queue.setDeliverMs(state.deliverMs);
  return queue.ack(method, params);
};
sessions.session = { id: 't', groupId: 1, created: new Set([1]), claimed: new Set(), lastTabId: 1, marks: new Map() };
const reg = await collectRegistry();

console.log(`\n[fix-1] shield pass gate — real content/shield.js driving real lib/shield-ctl.js${RC}`);

// ============================================================ 1. one host per document
console.log('\n[1] 双重注入：每文档必须恰好 1 个 .ubb-host-root');
{
  freshPage();
  injectWorld(0);
  ok('单次注入 = 1 个 host', hostCount() === 1, `got ${hostCount()}`);
  injectWorld(0); // a second world of the SAME extension id, same document
  ok('同 id 第二个世界再跑一遍 shield.js：DOM 级幂等收敛到恰好 1 个', hostCount() === 1, `got ${hostCount()}`);

  freshPage();
  injectWorld(0, { arm: true });
  plantHost(OURS);
  ok('现场：一个同 owner 的残留 host 叠在活盾牌上（实机测到的 length=2）', hostCount() === 2);
  deliver(1, { type: 'UBB_SHIELD', mode: 'armed', blockMode: 'block' }, { frameId: 0 });
  ok('活世界每次收信都把同 owner 残留剪掉（幂等持续生效，不是只在 build 时）', hostCount() === 1, `got ${hostCount()}`);

  freshPage();
  injectWorld(0, { arm: true });
  plantHost('other-ext');
  deliver(1, { type: 'UBB_SHIELD_QUERY' }, { frameId: 0 });
  ok('别家 owner 的 host 一律不删（不越权动别人的遮罩）', hostCount() === 2, `got ${hostCount()}`);
}

// ============================================================ 2. frame-directed pass
console.log('\n[2] UBB_PASS 必须定向到目标 frame（广播语义 = 没有确认能力）');
{
  freshPage();
  injectWorld(0, { arm: true });
  ok('前置：armed 时 veil 确实在吃事件（elementFromPoint 命中盾牌 host）', state.doc.elementFromPoint(65, 299) === hosts()[0]);
  const r = await grab(() => reg.call('click', { tab_id: 1, x: 65, y: 299 }));
  ok('确认让路后坐标 click 落地（鼠标事件上了 CDP 线路）', !!r.r?.clicked && mouseOnWire().length >= 3, JSON.stringify(r.e?.code || r.r));
  ok('没有一条 UBB_PASS 是广播（每条都带显式 {frameId}）', passSends().length > 0 && passSends().every((s) => s.opts && typeof s.opts.frameId === 'number'), JSON.stringify(passSends().map((s) => s.opts)));
  ok('主文档 pass 落在 frameId 0 且 on:true', passSends(true).some((s) => s.opts?.frameId === 0));
  ok('DOM 强制/回读同样按帧定向（target.frameIds 恰含一帧，无 all_frames）', state.scriptings.filter((s) => s.func === '__ubbFramePass').length > 0 && state.scriptings.filter((s) => s.func === '__ubbFramePass').every((s) => s.frameIds.length === 1), JSON.stringify(state.scriptings.map((s) => [s.func, s.frameIds])));
  // fix17 ADAPTATION（写在报告里）：这一条原本对整个 state.scriptings 说话，而 fix17
  // 往同一个通道里加了"投递取证读"（多帧一次读，只读不写）。原话对强制/回读通路
  // 一字未改，只是把口径收到它真正在盯的那个函数上 —— 并且下面立刻补一条对投递读的
  // 同强度要求：它也不许 all_frames，必须逐帧点名。
  ok('投递取证读同样是逐帧点名（frameIds 里只有真实帧号，绝不出现 all_frames:true）', state.scriptings.filter((s) => s.func === '__ubbFrameDeliveryRead').length > 0 && state.scriptings.filter((s) => s.func === '__ubbFrameDeliveryRead').every((s) => s.frameIds.length >= 1 && s.frameIds.every((f) => Number.isInteger(f))), JSON.stringify(state.scriptings.filter((s) => s.func.startsWith('__ubbFrameDelivery')).map((s) => [s.func, s.frameIds])));

  freshPage();
  injectWorld(0, { arm: true });
  let letThrough = null;
  await shieldCtl.withPass(1, async () => {
    letThrough = state.doc.elementFromPoint(65, 299) === state.doc.__page;
  }, { at: [65, 299] });
  ok('闸门放行的是"回读证明不挡路"，不是 ack 布尔值', letThrough === true);

  freshPage();
  injectWorld(0, { arm: true });
  injectWorld(7); // OOPIF: frameblock/bridge live there, no shield host
  state.frames = [0, 7];
  const rr = await grab(() => reg.call('click', { tab_id: 1, x: 180, y: 324 }));
  ok('OOPIF 坐标点击：主文档(0) 与目标帧(7) 都被 addressed', !!rr.r?.clicked && passSends(true).some((s) => s.opts?.frameId === 7) && passSends(true).some((s) => s.opts?.frameId === 0), JSON.stringify(rr.e?.code || rr.r));
  state.frames = [0];
}

// ============================================================ 3. unconfirmed pass = no input
console.log('\n[3] pass 未经确认 → 红着报错，且 0 个鼠标事件上线路');
{
  freshPage();
  injectWorld(0, { arm: true });
  plantHost('foreign-copy'); // a duplicate UBB copy / foreign veil we may not touch
  const e = await grab(() => reg.call('click', { tab_id: 1, x: 65, y: 299 }));
  ok('遮挡层没让路 → SHIELD_PASS_FAILED（不再谎报 {clicked:...}）', e.e?.code === 'SHIELD_PASS_FAILED', JSON.stringify(e.r || e.e?.code || e.e?.message));
  ok('错误消息自带下一步（点名重复副本 / 重载扩展）', /下一步|重载扩展|别家/.test(String(e.e?.message)), String(e.e?.message).slice(0, 110));
  ok('中止后 CDP 线路上 0 条 Input.dispatchMouseEvent', mouseOnWire().length === 0, JSON.stringify(mouseOnWire().map((m) => m.params.type)));
  ok('重试确有发生（≥ 2 个独立 pass 事务被打开）', passTxnTokens(true).length >= 2, `got ${passTxnTokens(true).length}`);
  ok('失败路径也把 pass 收回（不给页面留半开的门）', passSends(false).length > 0);

  const f2 = await grab(() => reg.call('scroll', { tab_id: 1, direction: 'down', amount: 300 }));
  void f2;
}
{
  // orphan-only document: no live listener anywhere. The DOM heal clears the
  // pointer path, but the dead world's capture-phase key listeners cannot be
  // turned off from outside — typing must still be refused, not pretended.
  freshPage();
  injectWorld(0, { arm: true, thenKill: true });
  const e = await grab(() => reg.call('type', { tab_id: 1, text: 'hi' }));
  ok('只剩孤儿世界 → type 报 SHIELD_PASS_FAILED（DOM 治得了鼠标，治不了 capture 键盘监听）', e.e?.code === 'SHIELD_PASS_FAILED', JSON.stringify(e.r || e.e?.code));
  ok('拒绝即没有任何 Input.insertText / dispatchKeyEvent 上线', state.wire.filter((c) => String(c.method).startsWith('Input.')).length === 0, JSON.stringify(state.wire.map((c) => c.method)));
}
{
  // the LIVE bug replayed: an orphaned armed host stacked under the live one.
  // Only the DOM channel can reach it — and the live world reaps it anyway.
  freshPage();
  injectWorld(0, { arm: true, thenKill: true });
  injectWorld(0, { arm: true });
  ok('孤儿 host 被同 owner 的活实例收编（不再有两层吃事件的 veil）', hostCount() === 1, `got ${hostCount()}`);
  const r = await grab(() => reg.call('click', { tab_id: 1, x: 65, y: 299 }));
  ok('收编后同一条命令落地（实机复现路径由红转绿）', !!r.r?.clicked && mouseOnWire().length >= 3, JSON.stringify(r.e?.code || r.r));
}

// ============================================================ 4. bounded retry lands
console.log('\n[4] 第一轮确认失败 → 有界重试后成功');
{
  freshPage();
  injectWorld(0, { arm: true });
  delete chromeStub.scripting; // no DOM channel → the ack/state path decides
  let first = true;
  chromeStub.tabs.sendMessage = async (tabId, payload, opts) => {
    state.sends.push({ tabId, payload, opts });
    if (first && payload?.type === 'UBB_PASS' && payload.on === true) {
      first = false;
      throw new Error('Could not establish connection. Receiving end does not exist.'); // document_start race
    }
    return deliver(tabId, payload, opts);
  };
  const r = await grab(() => reg.call('click', { tab_id: 1, x: 10, y: 20 }));
  const moved = mouseOnWire().length;
  const tries = passTxnTokens(true).length;
  wireChrome();
  ok('第一次撞空窗（监听器尚未注册），第二次成功 → 动作照常落地', !!r.r?.clicked && moved >= 3, JSON.stringify(r.e?.code || r.r));
  ok('重试有界：恰好 2 个 pass 事务（第 3 个不存在）', tries === 2, `got ${tries}`);
}

// ============================================================ 5. release restores blocking
console.log('\n[5] 动作结束后遮罩必须重新挡住用户（安全不变量不退）');
{
  freshPage();
  injectWorld(0, { arm: true });
  await reg.call('click', { tab_id: 1, x: 65, y: 299 });
  const veil = veils()[0];
  ok('pass 已释放：veil 回到 pointer-events:auto', veil.style.pointerEvents === 'auto', String(veil.style.pointerEvents));
  ok('elementFromPoint 重新命中盾牌自身（用户点击仍被挡）', state.doc.elementFromPoint(65, 299) === hosts()[0]);
  ok('释放消息同样是 addressed 的', passSends(false).every((s) => s.opts && typeof s.opts.frameId === 'number'));
  ok('全程只有一份 host（幂等没被动作打穿）', hostCount() === 1, `got ${hostCount()}`);
}

// ============================================================ 6. wedged bridge channel
console.log('\n[6] 桥通道卡死：每帧有界超时 + 帧级熔断（不再白烧满 40s，也不拖垮整标签）');
{
  freshPage();
  clearBridgeWedge(1);
  const hang = new Promise(() => {}); // a wedged content script never settles
  let hangVisible = true;
  const seen = [];
  chromeStub.tabs.sendMessage = async (tabId, msg, opts) => {
    seen.push({ msg, opts });
    // a wedged DOCUMENT answers nothing at all (Chrome semantics: the
    // sendMessage port stays open) — hang EVERY op of frame 0, not just one
    if (msg?.type === 'UBB_BRIDGE' && opts?.frameId === 0) return hangVisible ? hang : { ok: true, result: true };
    return deliver(tabId, msg, opts);
  };
  const t0 = Date.now();
  const code = await codeOf(() => bridge(1, 'visible', {}, 0));
  const hung = Date.now() - t0;
  ok('挂死的桥被有界截断：BRIDGE_TIMEOUT（≈12s，不是 40s TOOL_TIMEOUT）', code === 'BRIDGE_TIMEOUT' && hung > 9000 && hung < 20000, `${code} in ${hung}ms`);
  ok('桥请求始终带显式 frameId（超时也按帧记账）', seen.every((s) => s.msg?.type !== 'UBB_BRIDGE' || (s.opts && typeof s.opts.frameId === 'number')), JSON.stringify(seen.map((s) => s.opts)));
  const t1 = Date.now();
  const code2 = await codeOf(() => bridge(1, 'getPageText', {}, 0));
  ok('同一帧随后立即熔断：BRIDGE_WEDGED 亚秒返回（不再重复付 12s）', code2 === 'BRIDGE_WEDGED' && Date.now() - t1 < 1000, `${code2} in ${Date.now() - t1}ms`);
  const t2 = Date.now();
  const other = await grab(() => bridge(1, 'getPageText', {}, 7));
  ok('坏掉的只是那一帧：同标签其它帧不被连坐（立刻 BRIDGE_UNREACHABLE）', other.e?.message === 'BRIDGE_UNREACHABLE' && Date.now() - t2 < 3000, JSON.stringify(other.e?.message));
  clearBridgeWedge(1, 0);
  hangVisible = false;
  const rec = await grab(() => bridge(1, 'visible', {}, 0));
  ok('webNavigation 调用 clearBridgeWedge 后该帧恢复服务（不是永久拉黑）', rec.r === true, JSON.stringify(rec.e?.code || rec.r));
  unwireChromeForTest();
  clearBridgeWedge(1);
  wireChrome();
}

function unwireChromeForTest() {
  chromeStub.tabs.sendMessage = realSend;
}

/** fix15: the recording + frame-delivering sendMessage on its OWN, so a test can
 *  keep chrome.scripting deleted (the ack path at shield-ctl.js:567 is only
 *  reached when there is no DOM readback channel at all). */
function wireAckPathSend() {
  chromeStub.tabs.sendMessage = async (tabId, payload, opts) => {
    state.sends.push({ tabId, payload, opts });
    return deliver(tabId, payload, opts);
  };
}

// ============================================================ 7. F4: the cooldown actually bites
console.log('\n[7] fix5-F4：帧 A wedge 不拖帧 B、亚秒快拒、窗长覆盖顺序调用者、自愈无需导航');
{
  freshPage();
  clearBridgeWedge(1);
  const hang = new Promise(() => {});
  let aWedged = true;
  const seenOps = [];
  chromeStub.tabs.sendMessage = async (tabId, msg, opts) => {
    if (msg?.type === 'UBB_BRIDGE') {
      seenOps.push({ op: msg.op, frameId: opts?.frameId });
      if (opts?.frameId === 0) return aWedged ? hang : { ok: true, result: { text: 'frame 0 healed', url: 'u', title: 't' } };
      if (opts?.frameId === 3) return { ok: true, result: { text: 'frame 3 is fine', url: 'u', title: 't' } };
    }
    return deliver(tabId, msg, opts);
  };
  const tA = Date.now();
  const codeA = await codeOf(() => bridge(1, 'visible', {}, 0));
  const waitA = Date.now() - tA;
  ok('帧 A 的第一次超时仍是有界 12s BRIDGE_TIMEOUT（发现成本，不假装成功）', codeA === 'BRIDGE_TIMEOUT' && waitA > 9000 && waitA < 20000, `${codeA} in ${waitA}ms`);
  const rem = bridgeWedgeOf(1, 0);
  ok('冷却窗 >20s：覆盖"刚烧满预算才回来的顺序调用者"（实机 5s 窗就是这么漏掉的）', rem > 20000, `${rem}ms left`);
  const tB = Date.now();
  const b = await grab(() => bridge(1, 'getPageText', {}, 3));
  const waitB = Date.now() - tB;
  ok('帧 A wedge 后帧 B 仍然可用且亚秒返回（heavy op 走自己的 (tab,frame) 记账）', b.r?.text === 'frame 3 is fine' && waitB < 1000, JSON.stringify(b.e?.message || { waitB }));
  const tW = Date.now();
  const codeW = await codeOf(() => bridge(1, 'getPageText', {}, 0));
  const waitW = Date.now() - tW;
  ok('帧 A 第二次调用：只付活性探针（≤800ms）即 BRIDGE_WEDGED，不再烧满 30s', codeW === 'BRIDGE_WEDGED' && waitW < 1000, `${codeW} in ${waitW}ms`);
  ok('快拒没有把真 op 上线（帧 0 冷却期间只发过 selfInfo 探针）', seenOps.filter((s) => s.frameId === 0 && s.op !== 'selfInfo').length === 1, JSON.stringify(seenOps));
  ok('探针超时同样续期冷却（每次快拒重新计时）', bridgeWedgeOf(1, 0) > 20000, `${bridgeWedgeOf(1, 0)}ms`);
  aWedged = false; // the dialog was handled / the document unfroze on its own
  const tH = Date.now();
  const heal = await grab(() => bridge(1, 'getPageText', {}, 0));
  ok('帧自愈后探针应答即恢复真调用（无需导航/clear，快拒不是永久拉黑）', heal.r?.text === 'frame 0 healed' && Date.now() - tH < 2500, JSON.stringify(heal.e?.code || heal.e?.message || heal.r));
  unwireChromeForTest();
  clearBridgeWedge(1);
  wireChrome();
}

// ============================================================ 8. fix6: the frame re-arm verdict must survive to the caller
console.log('\n[8] fix6：补 arm 的结论必须看得见（rearmFrame 不许 reject，调用方不许把结论扔进 .catch(()=>{})）');
{
  freshPage();
  const sc = fs.readFileSync(new URL('shield-ctl.js', LIB), 'utf8');
  const bg = fs.readFileSync(BG, 'utf8');

  // a) no shield world at all → the QUERY itself is unanswered. That is NOT the
  //    same fact as "the shield is off", and the old shape reported it as such.
  let r = await shieldCtl.rearmFrame(1, 5);
  ok('顶层盾牌问不到 → reason:"shield_unreachable"（旧形状谎报成"shield_not_active"）',
    r.sent === false && r.reason === 'shield_unreachable', JSON.stringify(r));
  ok('问不到时一帧都没有被 arm（fail passive，且这是 reason 之外的硬证据）',
    state.sends.filter((s) => s.payload?.type === 'UBB_SHIELD').length === 0, JSON.stringify(state.sends.map((s) => s.payload?.type)));

  freshPage();
  injectWorld(0, { arm: true }); // tab is armed in the TOP frame
  // b) the late frame has no listener yet → the failure must be reported WITH why
  r = await shieldCtl.rearmFrame(1, 7);
  ok('补 arm 落空 → {sent:false, reason:"frame_unreachable"} + mode + attempts（调用方看得出没 arm 上）',
    r.sent === false && r.reason === 'frame_unreachable' && r.mode === 'armed' && r.attempts === 2, JSON.stringify(r));
  ok('落空的真因随返回值一起交出去（审计里能看到是哪种失败）',
    /Receiving end|could not establish connection/i.test(r.error || ''), r.error);
  ok('对照：帧里确有活监听器时补 arm 仍是一次成功的 {sent:true}',
    (injectWorld(7, { arm: true }), (await shieldCtl.rearmFrame(1, 7)).sent === true));

  // c) rearmFrame must be TOTAL: every failure comes back as a verdict, never a
  //    rejection the caller is free to swallow.
  const savedGet = chromeStub.storage.local.get;
  chromeStub.storage.local.get = async () => { throw new Error('storage unavailable'); };
  const rec = await grab(() => shieldCtl.rearmFrame(1, 9));
  chromeStub.storage.local.get = savedGet;
  r = rec.r;
  ok('storage 抛错也不 reject：{sent:false, reason:"storage_unreadable"} + error（吞错的 .catch 无从下手）',
    !rec.e && r && r.sent === false && r.reason === 'storage_unreadable' && /storage unavailable/.test(r.error || ''),
    rec.e ? `rejected instead of answering: ${rec.e.message}` : JSON.stringify(r));

  // d) background.js: the verdict lands in the audit ring instead of the bit bucket
  ok('background.js 仍走 rearmFrame(tabId, frameId) 这个"查询后再 arm"的通路',
    /rearmFrame\(tabId, frameId\)/.test(bg));
  ok('补 arm 的结论进 audit（action:shield.rearm_frame + sent + reason），ubb audit tail 看得见',
    /action: 'shield\.rearm_frame'[\s\S]{0,240}sent:[\s\S]{0,240}reason:/.test(bg), bg.match(/action: 'shield\.rearm_frame'/)?.[0]);
  ok('RC-static: rearmFrame 调用处再无 .catch(() => {}) 把结论丢掉',
    !/rearmFrame\(tabId, frameId\)\.catch\(\(\) => \{\}\)/.test(bg), bg.match(/rearmFrame\(tabId, frameId\)[^\n]*/)?.[0]);
  ok('RC-static: 该 regex 确实咬得住旧的吞错形状',
    /rearmFrame\(tabId, frameId\)\.catch\(\(\) => \{\}\)/.test("rearmFrame(tabId, frameId).catch(() => {});"));
  ok('lib/shield-ctl.js 的 rearmFrame 每条返回都带 sent（永不给出"看不出来"的形状）',
    (sc.match(/return \{ sent:/g) || []).length >= 6 && !/return \{ reason:/.test(sc));

  unwireChromeForTest();
  wireChrome();
}

// ============================================================ 9. fix7-① point confirmation at dispatch time
console.log('\n[9] fix7-①：确认之后、派发之前遮挡又起来 → 该动作必须 SHIELD_PASS_FAILED 且线路上 0 条 Input');
{
  freshPage();
  injectWorld(0, { arm: true });
  // the exact LIVE-RESULTS-2B shape: the gate read back clean, and only then did
  // something put occlusion back over THIS point (the pill sits at top-centre and
  // keeps pointer-events:auto while the veil is open — a whole-veil read still
  // says "open" at that moment)
  let probes = 0;
  const seen = [];
  const realExec = chromeStub.scripting.executeScript;
  chromeStub.scripting.executeScript = async (inj) => {
    const out = await realExec(inj);
    seen.push({ probe: probes + 1, veil: veils()[0] ? veils()[0].style.pointerEvents : null });
    if (++probes === 1) state.hitAt = [{ x: 65, y: 299, who: 'host' }]; // 回读通过之后才盖上
    return out;
  };
  const e = await grab(() => reg.call('click', { tab_id: 1, x: 65, y: 299 }));
  chromeStub.scripting.executeScript = realExec;
  await shieldCtl.sleep(60); // the failed check releases its own transaction
  ok('闸门确认过，但派发那一刻点位被占 → 红着拒绝（不再 {clicked:…} 谎报）', e.e?.code === 'SHIELD_PASS_FAILED', JSON.stringify(e.r || e.e?.code));
  ok('拒绝即 CDP 线路上 0 条 Input.dispatchMouseEvent（一条都没发）', mouseOnWire().length === 0, JSON.stringify(mouseOnWire().map((m) => m.params.type)));
  ok('拒绝那一刻整体 veil 是"开门"的：红只能来自点位确认，不能来自 blocking 列表', seen.length >= 2 && seen[1].veil === 'none', JSON.stringify(seen));
  ok('拒绝之后门也收回了（不给页面留半开的门）', veils()[0].style.pointerEvents === 'auto' && shieldCtl.activePassCount(1) === 0, String(veils()[0].style.pointerEvents));
  ok('错误消息说清是"派发前那一刻"发现的', /派发/.test(String(e.e?.message)), String(e.e?.message).slice(0, 80));

  // same shield, same instant, a point nobody covers → the action lands
  freshPage();
  injectWorld(0, { arm: true });
  state.hitAt = [{ x: 300, y: 400, who: 'host' }];
  const r = await grab(() => reg.call('click', { tab_id: 1, x: 65, y: 299 }));
  ok('对照：被占的不是这个点 → 同一条命令照常落地（确认的是点位，不是全局开关）', !!r.r?.clicked && mouseOnWire().length >= 3, JSON.stringify(r.e?.code || r.r));
}

// ============================================================ 10. fix7-② transaction timing inside one action
console.log('\n[10] fix7-②：一个 pass 事务内多次派发之间遮挡不得恢复；一份事务的撤销不关另一份的门；期限每事务一份');
{
  freshPage();
  injectWorld(0, { arm: true });
  const gA = await shieldCtl.ensurePass(1, { at: [65, 299] });
  const gB = await shieldCtl.ensurePass(1, { at: [65, 299] });
  await gA.release(); // A finishes early: its release lands inside B's action
  ok('A 释放后 B 的门还开着：veil 仍是 pointer-events:none（撤销发的是聚合状态，不是布尔）', veils()[0].style.pointerEvents === 'none', String(veils()[0].style.pointerEvents));
  ok('A 释放后 B 的命中测试依然干净（elementFromPoint 落在页面元素上）', state.doc.elementFromPoint(65, 299) === state.doc.__page);
  ok('账本里只剩 B 一份事务', shieldCtl.activePassCount(1) === 1, `got ${shieldCtl.activePassCount(1)}`);
  const v = await gB.check();
  ok('B 自己再确认仍然通过', v.confirmed === true, v.reason);
  await gB.release();
  ok('最后一份事务释放后门才关上（用户重新被挡）', veils()[0].style.pointerEvents === 'auto' && shieldCtl.activePassCount(1) === 0, String(veils()[0].style.pointerEvents));
  ok('A 的撤销消息带的是"帧还开着"的聚合 on:true，不是 on:false', state.sends.filter((s) => s.payload?.op === 'close').some((s) => s.payload.on === true), JSON.stringify(state.sends.filter((s) => s.payload?.op === 'close').map((s) => s.payload.on)));
}
{
  // every dispatch of a real tool action happens with the point provably clear
  freshPage();
  injectWorld(0, { arm: true });
  const other = await shieldCtl.ensurePass(1, { at: [65, 299] });
  const samples = [];
  const origSend = cdp.send;
  cdp.send = async (tabId, method, params) => {
    if (String(method).startsWith('Input.')) {
      samples.push({
        type: params?.type || method,
        veil: veils()[0] ? veils()[0].style.pointerEvents : null,
        hit_page: state.doc.elementFromPoint(params?.x ?? 65, params?.y ?? 299) === state.doc.__page,
      });
    }
    return origSend(tabId, method, params);
  };
  let probes = 0;
  const realExec = chromeStub.scripting.executeScript;
  chromeStub.scripting.executeScript = async (inj) => {
    const out = await realExec(inj);
    if (++probes === 2) await other.release(); // the other action ends mid-our-burst
    return out;
  };
  const rr = await grab(() => reg.call('click', { tab_id: 1, x: 65, y: 299 }));
  chromeStub.scripting.executeScript = realExec;
  cdp.send = origSend;
  ok('动作照常落地（另一条事务在它中间结束没有把它饿死）', !!rr.r?.clicked && mouseOnWire().length >= 3, JSON.stringify(rr.e?.code || rr.r));
  ok('每一次 Input.* 派发那一刻遮挡都是开着的（veil=none 且命中页面元素）', samples.length >= 3 && samples.every((s) => s.veil === 'none' && s.hit_page), JSON.stringify(samples));
  ok('派发之间确实发生过一次撤销（采样点 > 1 次事务释放）', state.sends.filter((s) => s.payload?.op === 'close').length >= 1);
}
{
  freshPage();
  injectWorld(0, { arm: true });
  const shortTxn = await shieldCtl.ensurePass(1, { at: [65, 299], ttlMs: 200 });
  ok('短事务开门', veils()[0].style.pointerEvents === 'none');
  const longTxn = await shieldCtl.ensurePass(1, { at: [65, 299], ttlMs: 20000 });
  await shieldCtl.sleep(500); // only the short one is past its own deadline
  ok('期限是每事务一份：到期的只有那一份，长事务仍开门（跨动作不共享 TTL）', veils()[0].style.pointerEvents === 'none' && shieldCtl.activePassCount(1) === 1, `count=${shieldCtl.activePassCount(1)} veil=${veils()[0].style.pointerEvents}`);
  ok('到期那份自己发出了撤销（不需要谁替它释放）', state.sends.some((s) => s.payload?.op === 'close' && s.payload.token === shortTxn.token), JSON.stringify(state.sends.filter((s) => s.payload?.op === 'close').map((s) => s.payload.token)));
  await longTxn.release();
  ok('两份都不在账本后，门重新挡住用户', veils()[0].style.pointerEvents === 'auto' && shieldCtl.activePassCount(1) === 0);
}
{
  // assertInputGate: the one-line hook lib/actions.js can call from mouse()/key()
  freshPage();
  injectWorld(0, { arm: true });
  ok('没有开门的事务时它什么都不做（只读通路不付费）', (await shieldCtl.assertInputGate(1)).checked === false);
  const g = await shieldCtl.ensurePass(1, { at: [65, 299] });
  const c = await shieldCtl.assertInputGate(1);
  ok('有事务时它做的就是把同一个点位再确认一次', c.confirmed === true && veils()[0].style.pointerEvents === 'none', JSON.stringify(c.confirmed));
  await g.release();
  ok('事务释放后它不再替任何动作确认', (await shieldCtl.assertInputGate(1)).checked === false);
}
{
  // the expiry must survive every re-stamp: writing a survivor back as a bare
  // token makes the open door immortal (a lost worker then never closes it)
  freshPage();
  injectWorld(0, { arm: true });
  const g2 = await shieldCtl.ensurePass(1, { at: [65, 299], ttlMs: 5000 });
  const before = hosts()[0].getAttribute('data-ubb-forced');
  deliver(1, { type: 'UBB_SHIELD_QUERY' }, { frameId: 0 }); // 一次重 arm / 查询引发的 apply()
  const after = hosts()[0].getAttribute('data-ubb-forced');
  ok('apply() 回写 forced 令牌时保留 @expire（写回裸令牌=不朽的门）', before === after && /@\d+/.test(after), `${before} → ${after}`);
  hosts()[0].setAttribute('data-ubb-forced', `lost-token@${Date.now() - 1000}`); // 过期残留
  const g3 = await shieldCtl.ensurePass(1, { at: [65, 299] });
  ok('过期的强制令牌被当刻剔除，不会被"续命"回来', !/lost-token/.test(hosts()[0].getAttribute('data-ubb-forced')), hosts()[0].getAttribute('data-ubb-forced'));
  await g2.release().catch(() => {});
  await g3.release();
  ok('全部撤销后 veil 回到 auto（账本里一个不朽令牌都没留下）', veils()[0].style.pointerEvents === 'auto' && shieldCtl.activePassCount(1) === 0, String(veils()[0].style.pointerEvents));
}
{
  // the issuer disappearing (worker torn down / tab dropped) must NOT leave the
  // user's page un-shielded forever: the stamped deadlines expire in the page
  freshPage();
  injectWorld(0, { arm: true });
  const g4 = await shieldCtl.ensurePass(1, { at: [65, 299], ttlMs: 1500 });
  ok('前提：开门了', veils()[0].style.pointerEvents === 'none' && state.doc.elementFromPoint(65, 299) === state.doc.__page);
  shieldCtl.dropPasses(1); // 撤销者消失了
  await shieldCtl.sleep(2200); // 页面侧的令牌下限是 1s（不让一次真动作被半路的过期打断）
  ok('无人撤销时页面按自己那份到期时间收门（fail-safe，不是永远敞开）', veils()[0].style.pointerEvents === 'auto' && state.doc.elementFromPoint(65, 299) === hosts()[0], String(veils()[0].style.pointerEvents));
  void g4;
}

// ============================================================ 11. fix7-③ the pass reaches only the target frame
console.log('\n[11] fix7-③：指名帧的动作只开那一帧（+顶层命中层），别帧的盾牌一条消息都收不到');
{
  freshPage();
  injectWorld(0, { arm: true });
  injectWorld(3, { arm: true });
  injectWorld(7, { arm: true });
  state.frames = [0, 3, 7];
  await shieldCtl.withPass(1, async (gate) => { await gate.check(); }, { frameId: 7, at: [180, 324] });
  const touched = [...new Set(state.sends.filter((s) => s.payload?.type === 'UBB_PASS').map((s) => s.opts?.frameId))].sort((a, b) => a - b);
  ok('UBB_PASS 只落在 0 与 7', touched.join(',') === '0,7', JSON.stringify(touched));
  ok('帧 3 连撤销都没收到（跨帧动作的 pass 不外溢）', state.sends.every((s) => s.opts?.frameId === 0 || s.opts?.frameId === 7));
  ok('帧 3 的 pass 从未被打开（它的 capture 监听器仍在挡用户）', (state.worlds.get(3)[0]).listeners.length > 0 && state.sends.filter((s) => s.opts?.frameId === 3 && s.payload?.type === 'UBB_PASS').length === 0);
  state.frames = [0];
}
{
  freshPage();
  injectWorld(0, { arm: true });
  injectWorld(3, { arm: true });
  injectWorld(7, { arm: true });
  state.frames = [0, 3, 7];
  const r = await grab(() => reg.call('click', { tab_id: 1, x: 20, y: 20 }));
  const opened = [...new Set(passSends(true).map((s) => s.opts?.frameId))].sort((a, b) => a - b);
  ok('对照：裸坐标 click 不知道会落进哪一帧 → 每一帧都必须开门（否则事件被没开的帧吃掉，又变成谎报）', opened.join(',') === '0,3,7' && !!r.r?.clicked, JSON.stringify(opened));
  const t2 = await grab(() => reg.call('type', { tab_id: 1, text: 'hi' }));
  ok('对照：type 的焦点所在帧同样未知 → 全帧开门', t2.r?.typed === true && [...new Set(passSends(true).map((s) => s.opts?.frameId))].sort((a, b) => a - b).join(',') === '0,3,7', JSON.stringify(t2.e?.code || t2.e?.message || t2.r));
  state.frames = [0];
}

// ============================================================ 12. fix7-④ print/PDF render tree
console.log('\n[12] fix7-④：withHiddenShield 期间 host 必须不在渲染树里（盾牌的字与样式表不许进 PDF）');
{
  freshPage();
  injectWorld(0, { arm: true });
  ok('前置：armed 盾牌确实在渲染树里（这正是 6d 泄的字源）', computed(hosts()[0]).display !== 'none' && hosts()[0].style.display !== 'none');
  let inside = null;
  await shieldCtl.withHiddenShield(1, async () => {
    inside = { display: hosts()[0].style.display, computed: computed(hosts()[0]).display, proof: await shieldCtl.hideShield(1) };
  });
  ok('窗口内 host 是 display:none（从渲染树摘掉，不是只设 pointer-events）', inside.display === 'none' && inside.computed === 'none', JSON.stringify(inside));
  ok('回读证明：文档里 0 个本扩展 host 还在被渲染', inside.proof.proven === true && inside.proof.displayed === 0, JSON.stringify(inside.proof));
  ok('窗口结束即恢复（armed+visible → 重新进渲染树）', computed(hosts()[0]).display !== 'none' && hosts()[0].style.display === '');

  freshPage();
  injectWorld(0, { arm: true, thenKill: true }); // UBB_VISIBLE can never reach it
  ok('前置：孤儿 host（监听器已死）正停在渲染树里', computed(hosts()[0]).display !== 'none');
  let orphan = null;
  await shieldCtl.withHiddenShield(1, async () => {
    orphan = { display: hosts()[0].style.display, proof: await shieldCtl.hideShield(1) };
  });
  ok('孤儿 host 也被 DOM 通路摘出渲染树 —— 只靠消息的那版做不到，这就是泄进 PDF 的那一层', orphan.display === 'none' && orphan.proof.displayed === 0, JSON.stringify(orphan));

  freshPage();
  injectWorld(0); // never armed: mode off
  const before = hosts()[0].style.display;
  await shieldCtl.withHiddenShield(1, async () => {});
  ok('未 arm 的标签打印恢复后仍然不显示盾牌', hosts()[0].style.display === 'none' && before === 'none', String(hosts()[0].style.display));
}
{
  const src = fs.readFileSync(new URL('shield.js', CONTENT), 'utf8');
  ok('盾牌样式表自带 @media print 摘除（握手全失败时打印里也没有盾牌的字）', /@media print[\s\S]{0,200}display: none !important/.test(src));
  ok('影子样式表里的 <style> 不再被 all:initial 画成正文（6d 泄的整份样式表就是它）', /^\s*style \{ display: none !important; \}/m.test(src));
  ok('UBB_VISIBLE 是指向 frame 0 的（盾牌只活在主文档；广播回复证明不了正在被渲染的那个文档）', /frameMsg\(tabId, 0, \{ type: 'UBB_VISIBLE'/.test(fs.readFileSync(new URL('shield-ctl.js', LIB), 'utf8')));
}
{
  // fix8: the per-dispatch proof moved INTO actions.mouse()/key() (assertInputGate).
  // What tools.js must no longer do is confirm the same dispatch twice (a check
  // here AND one inside mouse()): every extra round is one more executeScript on
  // the action's critical path. Pinned statically against the --lib base so an RC
  // copy flips it, and dynamically in [13] with real counts on the fake wire.
  const toolsSrc = fs.readFileSync(new URL('tools.js', LIB), 'utf8');
  const actionsSrc = fs.readFileSync(new URL('actions.js', LIB), 'utf8');
  const mouseBody = (actionsSrc.match(/export async function mouse\([\s\S]*?\n\}/) || [''])[0];
  const keyBody = (actionsSrc.match(/export async function key\([\s\S]*?\n\}/) || [''])[0];
  ok('actions.mouse() 自己逐派发确认：assertInputGate 在那条 cdp.send 之前', /assertInputGate\(tabId\)/.test(mouseBody) && mouseBody.indexOf('assertInputGate(tabId)') < mouseBody.indexOf('cdp.send'), mouseBody.slice(0, 60));
  ok('actions.key() 自己逐派发确认：assertInputGate 在那条 cdp.send 之前', /assertInputGate\(tabId\)/.test(keyBody) && keyBody.indexOf('assertInputGate(tabId)') < keyBody.indexOf('cdp.send'), keyBody.slice(0, 60));
  ok('零双重确认：tools.js 里没有任何一处 gate.check() 还蹲在 mouse()/key() 派发点前面', !/gate\.check\([^)]*\);[^\n]*\n\s*(await )?(mouse|key)\(tabId/.test(toolsSrc), (toolsSrc.match(/gate\.check\([^)]*\);[^\n]*\n\s*(await|return)? ?(mouse|key)\(tabId/) || [''])[0]);
  ok('绕过 mouse()/key() 的裸派发点（raw insertText / DOM.focus / wheel）仍各自显式 check（≥6 处）', (toolsSrc.match(/gate\.check\(/g) || []).length >= 6, `got ${(toolsSrc.match(/gate\.check\(/g) || []).length}`);
  // fix10: human.js now proves every dispatch it sends, and withPass's opening
  // confirm already covers the walk's first samples — so the explicit check the
  // human arm of tools.js used to make was a SECOND confirmation of the same
  // instant. Pin that the human arm's first statement is the dispatch itself.
  const humanArms = [...toolsSrc.matchAll(/(?:await human\.isEnabled\(\)|humanOn)\)? \{\n/g)].map((m) => {
    const first = toolsSrc.slice(m.index + m[0].length).split('\n').slice(0, 10).find((l) => l.trim() && !l.trim().startsWith('//'));
    return (first || '').trim();
  });
  ok('每个 human 分支的第一条语句就是它自己的派发（重叠的那次显式 check 已删）', humanArms.length >= 6 && humanArms.every((l) => /^await (human\.|withPass\()/.test(l) || /^return human\./.test(l)), `${humanArms.length} arms: ${humanArms.filter((l) => /gate\.check/.test(l)).join(' | ') || 'no check in any arm'}`);
  ok('human 分支里一次 gate.check() 都没有（多付的来回不许悄悄回来）', !humanArms.some((l) => /gate\.check\(/.test(l)), humanArms.filter((l) => /gate\.check/.test(l)).join(' | '));
}

{
  // A gate whose own injected script throws must announce itself: silently
  // falling back to the weaker ack proof is how a broken gate stays green
  // offline and then eats agent input on a real browser.
  freshPage();
  injectWorld(0, { arm: true });
  const exec2 = chromeStub.scripting.executeScript;
  chromeStub.scripting.executeScript = async () => {
    throw new Error('ReferenceError: count is not defined');
  };
  const e2 = await grab(() => reg.call('click', { tab_id: 1, x: 65, y: 299 }));
  chromeStub.scripting.executeScript = exec2;
  ok('注入脚本自己抛错 → 不再退回 ack 弱证明，红着报"闸门自己坏了"', e2.e?.code === 'SHIELD_PASS_FAILED' && /count is not defined/.test(String(e2.e?.message)), JSON.stringify(e2.r || String(e2.e?.message).slice(0, 90)));
  ok('这条路径同样 0 个鼠标事件上线', mouseOnWire().length === 0, JSON.stringify(mouseOnWire().map((m) => m.params.type)));
}

// ============================================================ 13. fix8: the gate lives inside actions.mouse()/key() now
console.log('\n[13] fix8：mouse()/key() 逐派发闸门 —— replay/type/press_key/fill{ref} 残留面关闭，且同一次派发只确认一次');
{
  // ① 闸门失败 = SHIELD_PASS_FAILED + 线路上零 Input.*（正是 replay / secret.fill /
  //    press_key / fill {ref} 这些"只调 actions.mouse()/key()"的通路以前缺的那一段）
  freshPage();
  injectWorld(0, { arm: true });
  const g8 = await shieldCtl.ensurePass(1, { at: [65, 299] });
  state.hitAt = [{ x: 65, y: 299, who: 'host' }]; // 首确认通过之后、派发之前遮挡又起来
  const e1 = await grab(() => actions.mouse(1, 'mousePressed', 65, 299));
  ok('actions.mouse()：派发那一刻点位被占 → SHIELD_PASS_FAILED（与 tools.js 同形同码）', e1.e?.code === 'SHIELD_PASS_FAILED', JSON.stringify(e1.r || e1.e?.code));
  ok('拒绝即线路上 0 条 Input.*（那条 dispatchMouseEvent 根本没发出）', state.wire.filter((c) => String(c.method).startsWith('Input.')).length === 0, JSON.stringify(state.wire.map((c) => c.method)));
  const e2 = await grab(() => actions.key(1, 'keyDown', 'a'));
  ok('actions.key()：同一闸门、同一拒绝，dispatchKeyEvent 也不许上线路', e2.e?.code === 'SHIELD_PASS_FAILED' && state.wire.filter((c) => c.method === 'Input.dispatchKeyEvent').length === 0, JSON.stringify(e2.e?.code || e2.r));
  await shieldCtl.sleep(120); // the failed check releases its own transaction
  ok('失败即收门：账本清空，不给后面留"永远红着拒绝"的幽灵闸门', shieldCtl.activePassCount(1) === 0, `got ${shieldCtl.activePassCount(1)}`);
  void g8;
}
{
  // 没有开门的事务 = assertInputGate 不拦不付费（fix7-shield 既定语义：只读通路不吃这刀）
  freshPage();
  injectWorld(0);
  ok('前提：账本里没有活事务', shieldCtl.activePassCount(1) === 0);
  const r0 = await grab(() => actions.mouse(1, 'mouseMoved', 5, 5));
  ok('无事务时 mouse() 照常派发（闸门只对 withPass 通路生效，不改变无盾语义）', !r0.e && mouseOnWire().length === 1, JSON.stringify(r0.e?.code || mouseOnWire().length));
}
{
  // ② type 通路吃到闸门（假 CDP 线路实证）：insertText 落地后遮挡才恢复 → Enter 被拦
  freshPage();
  injectWorld(0, { arm: true });
  let probesT = 0;
  const execT = chromeStub.scripting.executeScript;
  chromeStub.scripting.executeScript = async (inj) => {
    const out = await execT(inj);
    if (++probesT === 2) plantHost('foreign-copy'); // 派发点确认之前才盖上
    return out;
  };
  const e = await grab(() => reg.call('type', { tab_id: 1, text: 'hi', press_enter: true }));
  chromeStub.scripting.executeScript = execT;
  await shieldCtl.sleep(120);
  ok('type：插入时点位干净（insertText 已发），随后遮挡恢复 → key() 闸门红着拒绝', e.e?.code === 'SHIELD_PASS_FAILED' && state.wire.some((c) => c.method === 'Input.insertText'), JSON.stringify(e.e?.code || state.wire.map((c) => c.method)));
  ok('type：线路上 0 条 dispatchKeyEvent（Enter 没有"发出但被遮罩吃掉"）', state.wire.filter((c) => c.method === 'Input.dispatchKeyEvent').length === 0, JSON.stringify(state.wire.map((c) => c.params?.type).filter(Boolean)));
}
{
  // ②b press_key 的动作体现在不含任何显式 gate.check —— 拒绝完全来自 key() 内部
  freshPage();
  injectWorld(0, { arm: true });
  let probesP = 0;
  const execP = chromeStub.scripting.executeScript;
  chromeStub.scripting.executeScript = async (inj) => {
    const out = await execP(inj);
    if (++probesP === 1) plantHost('foreign-copy');
    return out;
  };
  const ep = await grab(() => reg.call('press_key', { tab_id: 1, key: 's', modifiers: ['ctrl'] }));
  chromeStub.scripting.executeScript = execP;
  await shieldCtl.sleep(120);
  ok('press_key：首确认后遮挡恢复 → SHIELD_PASS_FAILED（闸门在 key() 里，不在动作体里）', ep.e?.code === 'SHIELD_PASS_FAILED', JSON.stringify(ep.e?.code || ep.r));
  ok('press_key：0 条 dispatchKeyEvent 上线路', state.wire.filter((c) => c.method === 'Input.dispatchKeyEvent').length === 0, JSON.stringify(state.wire.map((c) => c.method)));
}
{
  // ③ 双重确认消除：一次坐标 click = 3 次派发、4 次 open 确认（1 首确认 + 每派发 1）
  freshPage();
  injectWorld(0, { arm: true });
  const r = await reg.call('click', { tab_id: 1, x: 65, y: 299 });
  const events = mouseOnWire().length;
  const opens = state.scriptings.filter((s) => s.op === 'open').length;
  ok('前提：坐标 click 三次派发照常落地', events === 3 && !!r.clicked, JSON.stringify({ events, r }));
  ok('上界：确认(executeScript open)次数 ≤ 派发数+1（check-then-send 双程回到 +1 以上即红）', opens <= events + 1, `opens=${opens} events=${events}`);
  ok('下界：每一次派发前都真的确认过（不许退回到"只确认首刀"）', opens >= events + 1, `opens=${opens} events=${events}`);
}
{
  // ③b drag 的行进坐标：每个事件按"当刻那一点"确认一次（gate.at 与账本 txn.at 同一数组）
  freshPage();
  injectWorld(0, { arm: true });
  state.hitAt = [{ x: 60, y: 60, who: 'host' }]; // (10,10)→(110,110) 十步，i=5 恰在 (60,60)
  const e = await grab(() => reg.call('drag', { tab_id: 1, from: { x: 10, y: 10 }, to: { x: 110, y: 110 } }));
  await shieldCtl.sleep(120);
  const seq = mouseOnWire().map((m) => `${m.params.type}:${m.params.x},${m.params.y}`);
  ok('drag：i=5 的 (60,60) 被占 → 当场 SHIELD_PASS_FAILED（确认的是当刻坐标，不是开局那一点）', e.e?.code === 'SHIELD_PASS_FAILED', JSON.stringify(e.e?.code || e.r));
  ok('drag：停下之前恰好 5 条（pressed + 4 次 moved），(60,60) 起线路上再无事件', seq.length === 5 && seq[4] === 'mouseMoved:50,50', JSON.stringify(seq));
}
{
  // ②c replay 的 click/keypress 步骤就是裸调 actions.mouse()/key()（tools-replay.js 不在
  //    本车道，读源码钉住"它走的正是装了闸门的这两个函数"；运行时闸门由上面 ①② 钉死）
  const rep = fs.readFileSync(new URL('tools-replay.js', LIB), 'utf8');
  ok('replay click 步骤：withPass 内直接派发 actions.mouse()（吃到 mouse() 的闸门）', /case 'click'[\s\S]{0,1600}?withPass\(tabId[\s\S]{0,300}?await mouse\(tabId/.test(rep));
  ok('replay keypress 步骤：withPass 内直接派发 actions.key()（吃到 key() 的闸门）', /case 'keypress'[\s\S]{0,400}?withPass\(tabId[\s\S]{0,260}?await key\(tabId/.test(rep));
}

// ============================================================ 14. fix9: human mode dispatches Input.* itself → it owes the gate too
console.log('\n[14] fix9：human 模式逐派发闸门（bezier 行进按步长确认，press/key/insertText/wheel 每次都确认）');
{
  // human mode is a storage flag; the toggle is read through the same stub the
  // extension uses, so this drives the REAL human.js dispatch sites
  const origGet = chromeStub.storage.local.get;
  chromeStub.storage.local.get = async (k) => (k === 'ubb_human_mode' ? { ubb_human_mode: true } : { ubb_shield_mode: 'block' });
  const actionable = () => mouseOnWire().filter((m) => m.params.type !== 'mouseMoved').length;
  const keysOnWire = () => state.wire.filter((c) => c.method === 'Input.dispatchKeyEvent').length;
  const opensCount = () => state.scriptings.filter((s) => s.op === 'open').length;
  try {
    // a) the door itself is honest: the load-bearing events each carry a proof
    freshPage();
    injectWorld(0, { arm: true });
    const rh = await grab(() => reg.call('click', { tab_id: 1, x: 65, y: 299 }));
    const press = mouseOnWire().filter((m) => m.params.type === 'mousePressed').length;
    const rel = mouseOnWire().filter((m) => m.params.type === 'mouseReleased').length;
    ok('human click 照旧落地（闸门不是永远红）：press+release 上线', !rh.e && press === 1 && rel === 1 && !!rh.r?.clicked, JSON.stringify(rh.e?.code || rh.r));
    // before this fix the ONLY proofs in a human click were ensurePass + the one
    // gate.check() in tools.js = 2, while press+release alone are 2 → the +1 is
    // exactly the confirmation human.js owes for each of its own dispatches
    ok('human click：可动作事件的每一次派发都有确认（确认数 ≥ 动作事件数 + 1）', opensCount() >= actionable() + 1, `opens=${opensCount()} actionable=${actionable()}`);
    // fix10 upper bound: withPass's own opening confirm + the travel proofs
    // (every GATE_EVERY-th sample and always the last, so ceil(steps/4) of the
    // steps-1 walking samples) + the pre-press micro-move + press + release.
    // One extra explicit gate.check() in tools.js' human arm is opens+1 → red.
    {
      const moved = mouseOnWire().filter((m) => m.params.type === 'mouseMoved').length;
      const steps = moved - 1; // the pre-press micro move is the last mouseMoved
      const bound = 1 + Math.ceil(steps / 4) + 1 + actionable();
      ok('上界：一次 human click 的确认数 ≤ 1 首确认 + 行进 ceil(steps/4) + 落点微动 + press + release', opensCount() <= bound, `opens=${opensCount()} bound=${bound} (moved=${moved} steps=${steps} actionable=${actionable()})`);
    }

    // b) the bounce the batch is afraid of: the veil comes back mid-travel
    freshPage();
    injectWorld(0, { arm: true });
    let probesH = 0;
    const execH = chromeStub.scripting.executeScript;
    chromeStub.scripting.executeScript = async (inj) => {
      const out = await execH(inj);
      if (++probesH === 3) plantHost('foreign-copy'); // after the opening + tools.js pre-check + 1 travel proof
      return out;
    };
    const eb = await grab(() => reg.call('click', { tab_id: 1, x: 65, y: 299 }));
    chromeStub.scripting.executeScript = execH;
    await shieldCtl.sleep(120);
    ok('行进途中遮罩回弹 → human click 红着拒绝（不再 {clicked:…} 谎报）', eb.e?.code === 'SHIELD_PASS_FAILED', JSON.stringify(eb.e?.code || eb.r));
    ok('拒绝即 0 条 mousePressed / 0 条 mouseReleased 上线（行进采样不算承诺）', mouseOnWire().filter((m) => m.params.type === 'mousePressed' || m.params.type === 'mouseReleased').length === 0, JSON.stringify(mouseOnWire().map((m) => m.params.type)));
    // c) per-key typing: a bounce between two characters must stop the rest
    freshPage();
    injectWorld(0, { arm: true });
    let probesT = 0;
    const execT = chromeStub.scripting.executeScript;
    chromeStub.scripting.executeScript = async (inj) => {
      const out = await execT(inj);
      if (++probesT === 4) plantHost('foreign-copy');
      return out;
    };
    const et = await grab(() => reg.call('type', { tab_id: 1, text: 'abcd' }));
    chromeStub.scripting.executeScript = execT;
    await shieldCtl.sleep(120);
    ok('human type 中途回弹 → SHIELD_PASS_FAILED（8 个键事件只发了前几个）', et.e?.code === 'SHIELD_PASS_FAILED', JSON.stringify(et.e?.code || et.r));
    ok('停下之后线路上再无键事件（每个 dispatchKeyEvent 都各自确认过）', keysOnWire() < 8 && keysOnWire() >= 2, JSON.stringify(state.wire.filter((c) => c.method === 'Input.dispatchKeyEvent').map((c) => c.params.type)));
    // d) the human branch of fill (humanType inside a keys:true transaction)
    freshPage();
    injectWorld(0, { arm: true });
    const ef = await grab(() => reg.call('type', { tab_id: 1, text: 'q' }));
    ok('human type 正常路径：确认数 ≥ 键事件数 + 1', !ef.e && opensCount() >= keysOnWire() + 1, `opens=${opensCount()} keys=${keysOnWire()}`);
    ok('上界：一次 human type 的确认数 ≤ 键事件数 + 1（首确认之外每条派发恰好一次；tools.js 再塞一次重叠 check 即红）', opensCount() <= keysOnWire() + 1, `opens=${opensCount()} keys=${keysOnWire()}`);
  } finally {
    chromeStub.storage.local.get = origGet;
  }
  {
    // static: the proof must sit at each dispatch SITE, not somewhere in the file
    const humSrc = fs.readFileSync(new URL('human.js', LIB), 'utf8');
    const sendIdxs = [...humSrc.matchAll(/cdp\.send\(tabId, 'Input\./g)].map((m) => m.index);
    const proven = sendIdxs.filter((i) => humSrc.slice(Math.max(0, i - 220), i).includes('assertInputGate(tabId)'));
    ok('human.js 每一条 Input.* 派发点之前都有确认（≥7 处，一处不落）', sendIdxs.length >= 7 && proven.length === sendIdxs.length, `${proven.length}/${sendIdxs.length}`);
    ok('bezier 行进按步长确认（GATE_EVERY）且最后一步必确认，press 仍各自确认', /GATE_EVERY/.test(humSrc) && /i % GATE_EVERY === 0 \|\| i === steps/.test(humSrc));
    ok('human.js 用的是 shield-ctl 导出的同一个闸门（不是自己造一个弱确认）', /import \{[^}]*assertInputGate[^}]*\} from '\.\/shield-ctl\.js'/.test(humSrc));
  }
}

// ============================================================ 16. fix11: the ledger is never proof, and a dead world's door gets closed
console.log('\n[16] fix11：账本/DOM 双向失配 —— ① 有活事务也必须点位回读 ② world 重建/死掉都要 fail-closed 收门');
{
  // ① 症状 A 的确切形状：闸门手上有一条活事务，DOM 那个点却被占着，而回读这一次
  //    没有给出答案（真机上是 2.5s 往返空手而归）。旧代码把"没有答案"当成"这条通路
  //    不存在"，退回世界自己的账本布尔，于是 9/9 报 {"clicked":…} 而门从未开过。
  freshPage();
  injectWorld(0, { arm: true });
  const exec0 = chromeStub.scripting.executeScript;
  chromeStub.scripting.executeScript = async () => [{ frameId: 0, result: undefined }]; // 往返空手而归
  state.hitAt = [{ x: 65, y: 299, who: 'host' }]; // 点位确实被自家遮罩占着（elementFromPoint 命中 host）
  const eA = await grab(() => reg.call('click', { tab_id: 1, x: 65, y: 299 }));
  chromeStub.scripting.executeScript = exec0;
  ok('①回读没有答案 = 不是"门开着"：坐标 click 红着拒绝，不许 ok:true', eA.e?.code === 'SHIELD_PASS_FAILED', JSON.stringify(eA.r || eA.e?.code));
  ok('①拒绝即 CDP 线路 0 条 Input.*（3A 的 9/9 谎报就是三条事件全上线、页面零记录）', mouseOnWire().length === 0, JSON.stringify(mouseOnWire().map((m) => m.params.type)));
  ok('①理由里说清是"回读没有答案"，不是含糊的"遮罩没让路"', /回读|点位/.test(String(eA.e?.message)), String(eA.e?.message || '').slice(0, 120));
  ok('①失败路径把事务收回账本（不留"账本说开着"的幽灵事务）', shieldCtl.activePassCount(1) === 0, `count=${shieldCtl.activePassCount(1)}`);
  state.hitAt = [];
}
{
  // ①b 快路径单独钉：账本里已经有一条活事务（首确认刚过），派发前那一次确认走的
  //    就是"已有活事务"的分支 —— 它必须仍然回读点位，而不是"账本开着就算确认"。
  freshPage();
  injectWorld(0, { arm: true });
  const g = await shieldCtl.ensurePass(1, { at: [65, 299] });
  ok('①b前提：账本里确有一条活事务，且门是开着的', shieldCtl.activePassCount(1) === 1 && veils()[0].style.pointerEvents === 'none');
  state.hitAt = [{ x: 65, y: 299, who: 'host' }]; // 全局 veil 仍 none，只有这一个点被占（盾牌自己的 pill 就是这种）
  const c = await grab(() => shieldCtl.assertInputGate(1));
  ok('①b已有活事务的快路径仍然做点位回读：点被占 → 该次确认红', c.e?.code === 'SHIELD_PASS_FAILED', JSON.stringify(c.r?.confirmed ?? c.e?.code));
  const m = await grab(() => actions.mouse(1, 'mousePressed', 65, 299));
  ok('①b红的那次派发没有上线路（0 条 dispatchMouseEvent）', m.e?.code === 'SHIELD_PASS_FAILED' && mouseOnWire().length === 0, JSON.stringify(state.wire.map((w) => w.method)));
  const gOpen = await shieldCtl.ensurePass(1, { at: [7, 7] }); // 另一个点仍然可用：确认的是点位不是全局布尔
  ok('①b换一个没被占的点：同一条快路径照样确认通过（不是一律红）', typeof gOpen.token === 'string' && gOpen.verdict?.confirmed === true, JSON.stringify(gOpen.via || gOpen.verdict?.reason));
  await gOpen.release().catch(() => {});
  state.hitAt = [];
  await g.release().catch(() => {});
}
{
  // ①c 反向：点位回读说"这个点被 veil 盖着"是**可以救的**——强制走 DOM 通路把门
  //    重新拧开再证明一次；这一条保证"修谎报"不会顺手把所有动作变成永远红。
  freshPage();
  injectWorld(0, { arm: true });
  const g2 = await shieldCtl.ensurePass(1, { at: [65, 299] });
  await g2.release(); // 账本空了，veil 回到 auto（正常）
  ok('①c前提：释放后 veil 挡住用户', veils()[0].style.pointerEvents === 'auto' && shieldCtl.activePassCount(1) === 0);
  const r = await grab(() => reg.call('click', { tab_id: 1, x: 65, y: 299 }));
  ok('①c下一次动作自己把门强制拧开并证明：照常落地（不需要谁先去"开账本"）', !!r.r?.clicked && mouseOnWire().length >= 3, JSON.stringify(r.e?.code || r.r));
  await shieldCtl.sleep(60);
  ok('①c落地后门仍收回拦截态', veils()[0].style.pointerEvents === 'auto' && shieldCtl.activePassCount(1) === 0, String(veils()[0].style.pointerEvents));
}
{
  // ② 症状 B：world 被拆掉/重建后，共享 DOM 上留着过期（或无人认领）的令牌，而新
  //    world 的 passes 是空的。没有任何一步去调 apply() 的话，veil 就停在 none ——
  //    盾牌对用户敞开（3A 实测 287 秒）。初始化对账必须把它写回拦截态并清掉死令牌。
  freshPage();
  injectWorld(0, { arm: true, thenKill: true }); // 旧 world：host 在、监听器已死
  const dead = hosts()[0];
  dead.setAttribute('data-ubb-pass', `ghost-token@${Date.now() - 1000}`); // 过期 1s 的令牌还挂在属性上
  dead.setAttribute('data-ubb-forced', `ghost-forced@${Date.now() - 1000}`);
  const dv = dead.shadowRoot.querySelector('.veil');
  dv.style.pointerEvents = 'none'; // 死世界留下的"敞着"
  ok('②前提：属性里挂着过期令牌、veil 停在 none（对用户敞开）', state.doc.elementFromPoint(65, 299) === state.doc.__page);
  injectWorld(0, { ready: 'loading' }); // world 重建，但还没接管文档（build 被 DOMContentLoaded 挡着）——只有初始化对账能救
  const after = hosts()[0];
  const av = after.shadowRoot.querySelector('.veil');
  ok('②world 初始化即对账：属性里没人认领/已过期的令牌被清掉（不是只在算 verdict 时忽略）', !/ghost-token|ghost-forced/.test(after.getAttribute('data-ubb-pass') + '|' + after.getAttribute('data-ubb-forced')), `${after.getAttribute('data-ubb-pass')} / ${after.getAttribute('data-ubb-forced')}`);
  ok('②fail-closed：本 world 手里没有活令牌 ⇒ veil 被强制写回拦截态', av.style.pointerEvents === 'auto', String(av.style.pointerEvents));
  ok('②对用户重新设防：elementFromPoint 又命中盾牌 host', state.doc.elementFromPoint(65, 299) === after);
}
{
  // ②b 一个"还没过期但没人认领"的令牌（issuer 已死的活事务）也要被清：world 侧按
  //     自己的账本认领，SW 侧按 pass 账本认领（DOM 通路是孤儿 host 唯一收得到的手）。
  freshPage();
  injectWorld(0, { arm: true, thenKill: true });
  const h2 = hosts()[0];
  h2.setAttribute('data-ubb-pass', `orphan-token@${Date.now() + 40000}`); // 40s 后才过期，但没人会去释放它
  h2.shadowRoot.querySelector('.veil').style.pointerEvents = 'none';
  ok('②b前提：活着的孤儿令牌 + 敞开的 veil（正是 fail-open 的那 287 秒）', state.doc.elementFromPoint(65, 299) === state.doc.__page);
  shieldCtl.dropPasses(1); // 账本空了（SW 重启/标签被释放就是这个状态）
  const sw = await shieldCtl.reconcileTab(1);
  ok('②b孤儿 host 走 DOM 通路收（消息永远送不到它）：claims 里没有的令牌被擦掉', sw.proven === true && sw.erased_unclaimed >= 1 && !/orphan-token/.test(h2.getAttribute('data-ubb-pass')), JSON.stringify(sw));
  ok('②b擦完即写回拦截态（盾牌重新对用户设防）', h2.shadowRoot.querySelector('.veil').style.pointerEvents === 'auto' && state.doc.elementFromPoint(65, 299) === h2, String(h2.shadowRoot.querySelector('.veil').style.pointerEvents));
  const rec = await grab(() => reg.call('click', { tab_id: 1, x: 65, y: 299 }));
  ok('②b收门之后同一条指针动作照常落地（fail-closed 不等于把自己锁死）', !!rec.r?.clicked && mouseOnWire().length >= 3, JSON.stringify(rec.e?.code || rec.r));
}
{
  // ②c 30 秒自收门：不依赖 content world 的 setTimeout（后台标签会被节流，world 死了就没了）
  freshPage();
  injectWorld(0, { arm: true, thenKill: true });
  await shieldCtl.shield.set(1, { mode: 'armed' }); // 记下"这个标签被接管过"（storage.session 能活过 SW 重启）
  const h3 = hosts()[0];
  h3.setAttribute('data-ubb-pass', `nobody@${Date.now() + 400000}`); // 甚至还没到期，但 issuer 已经没了
  h3.setAttribute('data-ubb-mode', 'armed');
  h3.shadowRoot.querySelector('.veil').style.pointerEvents = 'none';
  const swept = await shieldCtl.sweepLeakedPasses();
  ok('②c周期对账把无人认领的开门擦掉并关上（sweep 报告里看得见擦了几个）', swept.swept === 1 && swept.tabs[0].erased_unclaimed >= 1, JSON.stringify(swept));
  ok('②c关上的是 DOM，不是账本：veil 重新 pointer-events:auto', h3.shadowRoot.querySelector('.veil').style.pointerEvents === 'auto' && h3.getAttribute('data-ubb-pass') === '', `${h3.getAttribute('data-ubb-pass')} / ${h3.shadowRoot.querySelector('.veil').style.pointerEvents}`);
  const gg = await shieldCtl.ensurePass(1, { at: [65, 299] });
  const s2 = await shieldCtl.sweepLeakedPasses();
  const stillOpen = hosts()[0].shadowRoot.querySelector('.veil').style.pointerEvents === 'none';
  await gg.release();
  ok('②c手里还有活事务的标签不被 sweep 误关（claims 里有它就不擦）', s2.swept === 0 && stillOpen, JSON.stringify(s2));
}
{
  // ②d 自收门不靠定时器：真机上"world 还活着但 setTimeout 被节流"就是 3A 8-6 的
  //     那 287 秒。这里把世界的定时器全部冻住（queued 永不执行），令牌的 stamp 到期
  //     后没有任何 timer 会去收门 —— 只有每次 apply()/arm 时按 stamp 复核才收得住。
  freshPage();
  injectWorld(0, { arm: true, freeze: true });
  ok('②d前提：veil 挡住用户，且这个世界没有任何会跑的定时器', veils()[0].style.pointerEvents === 'auto', String(veils()[0].style.pointerEvents));
  deliver(1, { type: 'UBB_PASS', op: 'open', token: 'throttled', ttlMs: 300, at: [65, 299] }, { frameId: 0 });
  ok('②d开门：veil=none 且属性里有本次令牌', veils()[0].style.pointerEvents === 'none' && /throttled@\d+/.test(hosts()[0].getAttribute('data-ubb-pass')), hosts()[0].getAttribute('data-ubb-pass'));
  await shieldCtl.sleep(1300); // 令牌 stamp（content 侧下限 1s）早已过期；那条到期定时器被冻住了，一次都没跑
  ok('②d被冻住的到期定时器没有把它续命回来（timer 队列里那条还挂着，期间没人动过 DOM）', world0().timers.length > 0 && veils()[0].style.pointerEvents === 'none', `queued=${world0().timers.length} veil=${veils()[0].style.pointerEvents} pass=${hosts()[0].getAttribute('data-ubb-pass')}`);
  const qr = deliver(1, { type: 'UBB_SHIELD_QUERY', at: [65, 299] }, { frameId: 0 });
  ok('②d按 stamp 复核：过期令牌不再参与 pass 判定（这个 world 的 passes.size 不算数）', qr.state.pass === false && qr.state.dom_pass_tokens.indexOf('throttled') < 0, JSON.stringify({ pass: qr.state.pass, dom: qr.state.dom_pass_tokens }));
  ok('②d同一次 apply 就把 veil 写回拦截态（不等任何 setTimeout，用户重新被挡）', veils()[0].style.pointerEvents === 'auto' && state.doc.elementFromPoint(65, 299) === hosts()[0], String(veils()[0].style.pointerEvents));
}
{
  // 结构性钉桩：确认通路里不许再有"账本说开着就算确认"那条路
  const sc = fs.readFileSync(new URL('shield-ctl.js', LIB), 'utf8');
  const src = fs.readFileSync(new URL('shield.js', CONTENT), 'utf8');
  ok('confirmTxn 里没有"账本已有活事务 ⇒ 直接 confirmed"的短路', !/if \(ledger\.get\(tabId\)\?\.has\(txn\.token\)\)\s*return \{ confirmed: true/.test(sc) && !/confirmed: true, via: 'ledger'/.test(sc));
  ok('ackVerdict 只在"chrome.scripting 整个不存在"时被调用（往返没答案不许退回弱证明）', /if \(top === null\) \{\r?\n\s*v = await ackVerdict/.test(sc), (sc.match(/ackVerdict\(tabId, 0[^\n]*/) || [''])[0]);
  ok('ack 的确认要求 DOM 章里有本次 token（dom_pass_tokens），不是世界自己的 pass 布尔', /dom_pass_tokens[\s\S]{0,200}indexOf\(txn\.token\)/.test(sc));
  ok('"问不到"不再是"没有盾牌"：消息与查询都送不进去时红着拒绝', !/if \(!st[\s\S]{0,80}confirmed: true, via: 'no-shield'/.test(sc));
  ok('每次 DOM 通路都带 claims（无人认领的令牌才被擦得掉）', /args: \[op, token, [^\n]*extId\(\), claims\]/.test(sc) && /function __ubbFramePass\(op, token, expire, at, owner, claims\)/.test(sc));
  ok('world 侧对账在 apply() 的 host 早退之前（旧的第一行 if (!host) return 就是漏口）', /function apply\(\) \{[\s\S]{0,900}?reconcile\(\);[\s\S]{0,80}?if \(!host\) return;/.test(src), (src.match(/function apply\(\)[\s\S]{0,200}/) || [''])[0].slice(0, 90));
  ok('document_start 就有一次 born 对账（reconcile(true)），不等 build/DOMContentLoaded', /reconcile\(true\);/.test(src));
  ok('过期复核不依赖定时器：revalidatePasses 在任何 pass 判定前跑', /function revalidatePasses\(\)/.test(src) && /function passing\(\)[\s\S]{0,220}?revalidatePasses\(\);/.test(src));
  ok('fail-closed 的周期收门挂在活着的进程上（chrome.alarms，而不是 content world 的 setTimeout）', /SHIELD_SWEEP_ALARM/.test(sc) && /periodInMinutes/.test(sc) && /sweepLeakedPasses/.test(sc));
}

// ============================================================ 15. fix9: cdp.call's raw Input.* must say so
console.log('\n[15] fix9：cdp.call 的 Input.* 仍走裸发（受控逃生口不削弱），但返回值不许沉默');
{
  const { audit } = await import(new URL('audit.js', LIB).href);
  freshPage();
  injectWorld(0, { arm: true });
  const r1 = await grab(() => reg.call('cdp.call', { tab_id: 1, method: 'Input.dispatchMouseEvent', params: { type: 'mousePressed', x: 5, y: 5, button: 'left', buttons: 1, clickCount: 1 }, confirm: true }));
  ok('前提：raw Input.dispatchMouseEvent 照样上了线路（能力没被这条改动拿走）', !r1.e && mouseOnWire().length === 1, JSON.stringify(r1.e?.code || state.wire.map((c) => c.method)));
  ok('裸发的返回值必须显式带 gate_bypassed:true（不许"发了但没人说"的沉默形状）', r1.r?.gate_bypassed === true, JSON.stringify(r1.r));
  ok('并自带 note 说明它不经盾牌确认、可能被自家遮罩吃掉', /gate|shield|遮罩|eaten/i.test(String(r1.r?.note || '')), String(r1.r?.note || '(no note)').slice(0, 90));
  const r2 = await grab(() => reg.call('cdp.call', { tab_id: 1, method: 'Input.insertText', params: { text: 'x' }, confirm: true }));
  ok('Input.insertText 同一条规则（三个 Input 写档一个都不能漏）', r2.r?.gate_bypassed === true, JSON.stringify(r2.r));
  const r3 = await grab(() => reg.call('cdp.call', { tab_id: 1, method: 'Page.navigate', params: { url: 'https://example.com/' }, confirm: true }));
  ok('非 Input.* 不挂这个键（不给无关命令造假信号）', !r3.e && r3.r?.gate_bypassed === undefined && r3.r?.note === undefined, JSON.stringify(r3.r));
  const r4 = await grab(() => reg.call('cdp.call', { tab_id: 1, method: 'DOM.getDocument' }));
  ok('读档同样不带 gate_bypassed', !r4.e && r4.r?.gate_bypassed === undefined, JSON.stringify(r4.r));
  ok('审计条目也记 gate_bypassed（事后能从 ubb audit tail 看出哪条没经确认）', audit.list(30).some((e) => e.action === 'cdp.call' && e.method === 'Input.dispatchMouseEvent' && e.gate_bypassed === true), JSON.stringify(audit.list(10).map((e) => [e.action, e.method, e.gate_bypassed])));
  ok('工具描述里就告知（模型在调用前看得见这条路不经盾牌确认）', /gate_bypassed/.test(reg.metas['cdp.call'].description), reg.metas['cdp.call'].description.slice(0, 200));
  // structural: the flag and the return are in the same branch, so a bare Input.*
  // send cannot come back "clean" any more than it can come back silently
  ok('cdp.call 的体里 gate_bypassed 由 Input.* 分支决定（结构上不可能裸发且沉默）', /const rawInput = [^\n]*Input\.[\s\S]{0,600}?if \(rawInput\) \{[\s\S]{0,400}?gate_bypassed = true[\s\S]{0,400}?return out;/.test(fs.readFileSync(new URL('tools.js', LIB), 'utf8')));
}

// ============================================================ 17. fix16 REVERT: the ack branch is attribution-roots' judgement again
console.log('\n[17] fix16 回退：判定语义 = attribution-roots —— "空回答(!st)"与 border/off 同走 not-armed 合法放行；fix15 的"未知态拒绝 + PASS_STATE_ASKS 有界重问 + shield.pass_state_unknown 审计"整组撤下（真机 345 条里 0 次进入），"没交付状态"降级为探针证据（[18]）而不改判据；border/off 的合法放行仍不许被顺手收紧');
{
  const { audit } = await import(new URL('audit.js', LIB).href);
  const scRaw = fs.readFileSync(new URL('shield-ctl.js', LIB), 'utf8');
  const strip = (s) => s.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  const unknownEntries = (since) => audit.listSince(since).filter((e) => e.action === 'shield.pass_state_unknown');
  const gateEntries = (since, phase) => audit.listSince(since).filter((e) => e.action === 'shield.pass_gate' && (!phase || e.phase === phase));

  // ---- ①a 回退后的真实行为（这是已知并被如实记录的代价，不是新漏洞）：UBB_PASS 送进去
  //         了、一个状态都没带回（Chrome 语义 = 监听器在、没人 sendResponse），
  //         attribution-roots 判它 not-armed 并放行。fix15 在这条路上加的拒绝被
  //         LIVE-RESULTS-5 证明真机不可达（ackVerdict 只在 chrome.scripting 缺席时才被
  //         调用，而 manifest 声明了 scripting ⇒ 345 条审计里 pass_state_unknown = 0），
  //         调用，而 manifest 声明了 scripting ⇒ 345 条审计里 pass_state_unknown = 0）。
  //         它既不可能造成 20/20（从没跑过），也不可能修好什么（带着一个假的可达性断言的
  //         死代码），所以整组撤下，回到已知基线；1/20 → 20/20 这个差到底跟着哪次改动走，
  //         是 [18] 探针下一轮要回答的问题。"没交付状态"改由 [18] 的探针如实上报。
  freshPage();
  injectWorld(0, { arm: true }); // 有活监听器 ⇒ 消息"送得进去"（不是 unreachable）
  delete chromeStub.scripting; // 没有 DOM 回读通路 ⇒ ack 通路说了算（:567 就是这条通路）
  chromeStub.tabs.sendMessage = async (tabId, payload, opts) => {
    state.sends.push({ tabId, payload, opts, at: Date.now() });
    if (payload?.type === 'UBB_PASS') {
      // Chrome 语义：监听器存在但没 sendResponse —— 消息是真"送进去了"（门真的开了），
      // 只是那一个世界没有把状态带回给调用方。fix17 之前这里连 deliver() 都没走，等于
      // "门没开"，那是另一种形状（[3] 已经盯它）。
      try { deliver(tabId, payload, opts); } catch {}
      return undefined;
    }
    return deliver(tabId, payload, opts);
  };
  let seq0 = audit.seq;
  const rA = await grab(() => reg.call('click', { tab_id: 1, x: 65, y: 299 }));
  ok('①a回退已落地：空回答（!st）与 border/off 同一条 not-armed 合法放行 ⇒ 动作照常落地（attribution-roots 语义，谎报形状是本轮如实交出的已知代价）', !!rA.r?.clicked && mouseOnWire().length >= 3, JSON.stringify(rA.e?.code || rA.r));
  ok('①a没留下 fix15 拒绝分支的残迹：这一轮不报 SHIELD_PASS_FAILED，探针 verdict 里也不许出现 unknown-state', !rA.e && !gateEntries(seq0).some((e) => String(e.verdict || '').includes('unknown')), JSON.stringify(gateEntries(seq0).map((e) => [e.phase, e.verdict])));
  ok('①a shield.pass_state_unknown 审计随回退一起消失（运行时 0 条 + 代码层 0 引用；注释里作为诊断材料保留）', unknownEntries(seq0).length === 0 && !/pass_state_unknown/.test(strip(scRaw)), JSON.stringify(unknownEntries(seq0)));
  ok('①a"没交付状态"从判据降级为证据：同一次确认在探针里如实记 verdict:"not-armed" + st:null + st_delivered:false（下一轮真机据此能一眼辨出谎报形状）', gateEntries(seq0, 'open')[0]?.verdict === 'not-armed' && gateEntries(seq0, 'open')[0]?.st === null && gateEntries(seq0, 'open')[0]?.st_delivered === false, JSON.stringify(gateEntries(seq0, 'open')[0] && { verdict: gateEntries(seq0, 'open')[0].verdict, st: gateEntries(seq0, 'open')[0].st, st_delivered: gateEntries(seq0, 'open')[0].st_delivered }));
  await shieldCtl.sleep(60);
  ok('①a回退没动账本/释放那半边：动作完成后门照样收回拦截态、账本清零', veils()[0].style.pointerEvents === 'auto' && shieldCtl.activePassCount(1) === 0, `${veils()[0].style.pointerEvents} count=${shieldCtl.activePassCount(1)}`);
  // 有界重问是否真撤下了：一条事务的开场确认恰好问一次（用 ensurePass 单独量，不掺派发轮次）
  state.sends = [];
  const gA = await grab(() => shieldCtl.ensurePass(1, { at: [65, 299] }));
  ok('①a PASS_STATE_ASKS 的那次额外重问已撤下：一条 pass 事务的开场确认恰好一次 UBB_PASS open（旧代码 = 问 + 再问）', !!gA.r && passSends(true).length === 1 && passTxnTokens(true).length === 1, `sends=${passSends(true).length} tokens=${passTxnTokens(true).length}`);
  await (gA.r ? gA.r.release() : Promise.resolve()).catch(() => {});

  // ---- ①b 本轮刻意没收紧的那一条（写清楚，免得下一个人当事故）：回了个对象、但对象里
  //         没有任何盾牌状态（{} / {ok:true}）。真的内容脚本给不出这个形状（shield.js 的
  //         stateOf() 永远带 mode，frameblock.js 故意从不 sendResponse），而
  //         lib/testharness.mjs 的默认桩就是这个形状 —— 把它一起变红要改的是
  //         test-{fill,replay,secrets,security}.mjs，不在本车道，交主线（log-fix15 §边界）。
  freshPage();
  injectWorld(0, { arm: true });
  delete chromeStub.scripting;
  chromeStub.tabs.sendMessage = async (tabId, payload, opts) => {
    state.sends.push({ tabId, payload, opts, at: Date.now() });
    if (payload?.type === 'UBB_PASS') {
      try { deliver(tabId, payload, opts); } catch {} // 同①a：门真的开了，回的却是个没状态的对象
      return { ok: true }; // 有回复、没状态
    }
    return deliver(tabId, payload, opts);
  };
  seq0 = audit.seq;
  const rB = await grab(() => reg.call('click', { tab_id: 1, x: 65, y: 299 }));
  ok('①b边界（fix15 §3 那条刻意没收紧的，回退后原样成立）：回了对象但没状态 ⇒ 仍按 not-armed 放行', !!rB.r?.clicked && unknownEntries(seq0).length === 0, JSON.stringify(rB.e?.code || rB.r));
  ok('①b"回了对象但没状态"与①a"一个字都没回"在探针里是可分的（st:"?/?" + st_delivered:true vs st:null + false）—— 这正是回退后用证据代替判据的那条线', gateEntries(seq0, 'open')[0]?.st === '?/?' && gateEntries(seq0, 'open')[0]?.st_delivered === true, JSON.stringify(gateEntries(seq0, 'open')[0] && { st: gateEntries(seq0, 'open')[0].st, st_delivered: gateEntries(seq0, 'open')[0].st_delivered }));

  // ---- ①c 回退的范围：只回退 :567 那一组。DOM 通路存在、可它这一趟没答（result:
  //         undefined ⇒ dom_failed:no_answer）仍然红着拒绝 —— "问不到不是门开着"属于
  //         fix11 的 DOM 判据，不在回退清单里，更不许被这次回退顺手放宽（否则
  //         LIVE-RESULTS-3A 那 9/9 的 {"clicked":…} + 页面零事件就回来了）。
  freshPage();
  injectWorld(0, { arm: true });
  wireChrome(); // 回退之后这条通路重新有 chrome.scripting —— 真机一直是这样
  const execC = chromeStub.scripting.executeScript;
  chromeStub.scripting.executeScript = async () => [{ frameId: 0, result: undefined }]; // 往返空手而归
  seq0 = audit.seq;
  const eC = await grab(() => reg.call('click', { tab_id: 1, x: 65, y: 299 }));
  chromeStub.scripting.executeScript = execC;
  ok('①c回退没有越界：DOM 往返没有答案 = 不是"门开着"，坐标 click 照旧红在 SHIELD_PASS_FAILED', eC.e?.code === 'SHIELD_PASS_FAILED', JSON.stringify(eC.r || eC.e?.code));
  ok('①c红的那次 CDP 线路上 0 条 Input.*（3A 9/9 的谎报形状没被这次回退带回来）', mouseOnWire().length === 0, JSON.stringify(state.wire.map((w) => w.method)));
  const refC = gateEntries(seq0, 'open')[0];
  ok('①c红着的那次同样被探针记账：verdict:"refused" + attempts:2 + reason 非空（回退后拒绝路径依然可审计、可复盘）', refC?.verdict === 'refused' && refC?.attempts === 2 && !!refC?.reason, JSON.stringify(refC && { verdict: refC.verdict, attempts: refC.attempts, reason: String(refC.reason).slice(0, 40) }));
  ok('①c失败路径照样把事务收回账本（回退没碰 ledger/release 那半边）', shieldCtl.activePassCount(1) === 0, `count=${shieldCtl.activePassCount(1)}`);

  // ---- ② border / off 是"问了、也确实不拦"，一条都不许变成拒绝（防过度收紧）
  let notArmedConfirms = 0;
  freshPage();
  injectWorld(0, {}); // 从未 arm：mode 停在 'off'
  delete chromeStub.scripting;
  wireAckPathSend();
  const gOff = await grab(() => shieldCtl.ensurePass(1, { at: [65, 299] }));
  ok('②off（问了、确实不拦）仍是合法放行：confirmed:true + via:"not-armed"', gOff.r?.verdict?.confirmed === true && gOff.r?.via === 'not-armed', JSON.stringify(gOff.e?.code || { via: gOff.r?.via, confirmed: gOff.r?.verdict?.confirmed }));
  if (gOff.r?.verdict?.confirmed === true && gOff.r?.via === 'not-armed') notArmedConfirms++;
  const rOff = await grab(() => reg.call('click', { tab_id: 1, x: 65, y: 299 }));
  ok('②off 的指针动作照常上线（可用性没被这次改动拿走）', !!rOff.r?.clicked && mouseOnWire().length >= 3, JSON.stringify(rOff.e?.code || mouseOnWire().length));
  await (gOff.r ? gOff.r.release() : Promise.resolve()).catch(() => {});

  freshPage();
  injectWorld(0, { arm: true });
  deliver(1, { type: 'UBB_SHIELD', mode: 'armed', blockMode: 'border' }, { frameId: 0 }); // 设防但不拦：横幅模式
  delete chromeStub.scripting;
  wireAckPathSend();
  const seqBorder = audit.seq;
  const gBorder = await grab(() => shieldCtl.ensurePass(1, { at: [65, 299] }));
  ok('②armed + blockMode:border 仍走 not-armed 的合法放行（不许被并进未知拒绝）', gBorder.r?.verdict?.confirmed === true && gBorder.r?.via === 'not-armed', JSON.stringify(gBorder.e?.code || { via: gBorder.r?.via, state: gBorder.r?.verdict?.state?.blockMode }));
  if (gBorder.r?.verdict?.confirmed === true && gBorder.r?.via === 'not-armed') notArmedConfirms++;
  ok('②border/off 两轮确实各确认了一次，而这两轮一条拒绝都不产生（回退后 shield.pass_state_unknown 这个 action 已结构性消失，缺席才有意义；夹具=先各确认一次）', notArmedConfirms === 2 && unknownEntries(seqBorder).length === 0, `confirms=${notArmedConfirms} ${JSON.stringify(unknownEntries(seqBorder))}`);
  const rBorder = await grab(() => reg.call('click', { tab_id: 1, x: 65, y: 299 }));
  ok('②border 下点击照常落地（0 条 Input 才是回归）', !!rBorder.r?.clicked && mouseOnWire().length >= 3, JSON.stringify(rBorder.e?.code || mouseOnWire().length));
  ok('②border 这一轮在探针里是"问了、也确实答了"：verdict:"not-armed" + st:"armed/border" + st_delivered:true（与①a的 st:null 判据相同、证据不同）', gateEntries(seqBorder, 'open')[0]?.verdict === 'not-armed' && gateEntries(seqBorder, 'open')[0]?.st === 'armed/border' && gateEntries(seqBorder, 'open')[0]?.st_delivered === true, JSON.stringify(gateEntries(seqBorder, 'open')[0] && { verdict: gateEntries(seqBorder, 'open')[0].verdict, st: gateEntries(seqBorder, 'open')[0].st, st_delivered: gateEntries(seqBorder, 'open')[0].st_delivered }));
  await (gBorder.r ? gBorder.r.release() : Promise.resolve()).catch(() => {});

  // ---- 结构性钉桩：回退必须是"整组回退"，且不许越界到别的判据
  const sc = scRaw;
  ok('RC-static：回退已落地 —— attribution-roots 那一行原样在源里（!st 与 border/off 同一个合法放行）', /if \(!st \|\| st\.mode !== 'armed' \|\| st\.blockMode !== 'block'\)\s*return \{ confirmed: true, via: 'not-armed', state: st \};/.test(sc), (sc.match(/if \(!st[\n]*/) || [''])[0].slice(0, 120));
  ok('RC-static：fix15 的未知态三件套在代码层一处不剩（unknown-state / PASS_STATE_ASKS / pass_state_unknown / deliveredAnswer 只许留在注释里当诊断材料）', !/(unknown-state|PASS_STATE_ASKS|pass_state_unknown|deliveredAnswer)/.test(strip(sc)), (strip(sc).match(/.{0,60}(unknown-state|PASS_STATE_ASKS|pass_state_unknown|deliveredAnswer).{0,40}/) || [''])[0]);
  ok('RC-static：回退没有越界 —— dom_failed 仍是"没有点位证明就不放行"的红判据（fix11 那条 DOM 语义一字未动）', /dom_failed[\s\S]{0,240}问不到.不是.门开着/.test(sc) && /if \(dom && dom\.dom_failed\) \{/.test(sc), (sc.match(/if \(dom && dom\.dom_failed\) \{[\s\S]{0,80}/) || [''])[0].replace(/\n/g, ' '));
  const ackBody = (sc.match(/async function ackVerdict\([\s\S]*?\n\}/) || [''])[0];
  const domBody = (sc.match(/function domVerdict\([\s\S]*?\n\}/) || [''])[0];
  ok('RC-static：探针不参与判定 —— ackVerdict/domVerdict 的判据代码里一个 probe 字样都没有（只记不改；注释里提到它不算；夹具=两段函数体都取到才算）', ackBody.length > 800 && domBody.length > 500 && !/probe/i.test(strip(ackBody)) && !/probe/i.test(strip(domBody)), `ackBody=${ackBody.length} domBody=${domBody.length}`);
  ok('RC-static：预算耗尽的止损分支仍只在失败路径上（成功即 return，探针只把 over_budget_ok 记下来，本轮不改语义）', /if \(last\.confirmed\) \{[\s\S]{0,2000}?return \{ \.\.\.gate, verdict: last[\s\S]{0,1400}?if \(Date\.now\(\) - t0 > PASS_CONFIRM_BUDGET_MS\)/.test(sc), (sc.match(/return \{ \.\.\.gate, verdict: last[^\n]*/) || [''])[0]);
  unwireChromeForTest();
  wireChrome();
}

// ============================================================ 18. fix16 judgement-path probe (shield.pass_gate)
console.log('\n[18] fix16 判定路径探针（shield.pass_gate）：一次动作必须把 Q1 各段耗时与 delivered、Q2 confirmed 由哪个判据给出+那次点位命中什么、Q3 预算花在哪 落进 audit ring —— 只记，不改判');
{
  const { audit } = await import(new URL('audit.js', LIB).href);
  const gateE = (since, phase) =>
    audit.listSince(since).filter((e) => e.action === 'shield.pass_gate' && (!phase || e.phase === phase));

  // ---- ①真机那条路（chrome.scripting 在 ⇒ manifest 声明 scripting 的现实形状）
  freshPage();
  injectWorld(0, { arm: true });
  wireChrome();
  const seq1 = audit.seq;
  const r1 = await grab(() => reg.call('click', { tab_id: 1, x: 65, y: 299 }));
  const o1 = gateE(seq1, 'open')[0];
  const d1 = gateE(seq1, 'dispatch')[0];
  ok('前提：健康盾牌下一次坐标 click 照常落地（3 条 Input 上线）', !!r1.r?.clicked && mouseOnWire().length === 3, JSON.stringify(r1.e?.code || r1.r));
  ok('Q2 判据是稳定字段：这次 confirmed:true 由 verdict:"dom-point" 给出（不是自然语言）', o1?.verdict === 'dom-point' && o1?.confirmed === true, JSON.stringify(o1 && { verdict: o1.verdict, confirmed: o1.confirmed, forced: o1.forced }));
  ok('Q2 那次确认看点位命中的是什么：hit:"button"（页面按钮）+ 没有拦人的 veil + open_tokens≥1', o1?.hit === 'button' && Array.isArray(o1.veil) && o1.veil.length === 0 && o1.open >= 1, JSON.stringify(o1 && { hit: o1.hit, veil: o1.veil, open: o1.open }));
  ok('Q1 UBB_PASS open 的 ack 往返耗时与 delivered 各自记账（acks[].ms/del/st，st 是 ack 那一刻盾牌自己报的 mode/blockMode）', o1?.acks?.[0]?.del === true && typeof o1.acks[0].ms === 'number' && o1.acks[0].st === 'armed/block' && typeof o1.ack_ms === 'number', JSON.stringify(o1 && { acks: o1.acks, ack_ms: o1.ack_ms }));
  ok('Q1 DOM 往返耗时单独记（doms[].ms + kind 说明是哪一趟：read/retry/forced/sub）', Array.isArray(o1?.doms) && typeof o1.doms[0].ms === 'number' && o1.doms[0].kind === 'read', JSON.stringify(o1 && o1.doms));
  ok('轻量：一次动作 = 两条 ring 条目（开场一条 + 派发聚合成一条），不刷爆 500 环', gateE(seq1).length === 2, JSON.stringify(gateE(seq1).map((e) => [e.phase, e.checks])));
  ok('Q2 逐派发同样留判据：3 次 check ⇒ verdicts 三条 dom-point，且与开场同一条事务（token 对得上）', d1?.checks === 3 && d1.verdicts.join() === 'dom-point,dom-point,dom-point' && d1.token === o1.token, JSON.stringify(d1 && { checks: d1.checks, verdicts: d1.verdicts }));
  ok('Q1/Q3 每次 check 各自耗时，burst 总耗时/最慢一次/丢弃数都在（19 事件的 human 动作也只是一条）', d1?.detail?.length === 3 && d1.detail.every((c) => typeof c.ms === 'number' && typeof c.ack_ms === 'number' && typeof c.dom_ms === 'number') && typeof d1.ms === 'number' && typeof d1.slowest_check_ms === 'number' && d1.dropped_checks === 0, JSON.stringify(d1 && { ms: d1.ms, slowest: d1.slowest_check_ms, dropped: d1.dropped_checks }));
  ok('成功的那次派发聚合不许带拒绝痕迹（refused:null），红的那次才带（下一条 ③ 验证）', d1?.refused === null, JSON.stringify(d1 && d1.refused));

  // ---- ②没有任何活 pass 事务的派发：闸门给不出确认，这件事本身必须可见（有界）
  freshPage();
  injectWorld(0, { arm: true });
  wireChrome();
  const seq2 = audit.seq;
  const m1 = await grab(() => actions.mouse(4242, 'mouseMoved', 5, 5));
  ok('Q2 反面：派发前没有开着的 pass 事务 ⇒ 探针记 verdict:"no-open-pass"（明说这不是"确认通过了"）', !m1.e && gateE(seq2, 'dispatch').length === 1 && gateE(seq2, 'dispatch')[0].verdict === 'no-open-pass', JSON.stringify(gateE(seq2).map((e) => [e.verdict, e.checks])));
  await grab(() => actions.mouse(4242, 'mousePressed', 5, 5));
  ok('轻量：同一个标签的后续派发不再逐条刷 ring（10s 窗内一条封顶）', gateE(seq2, 'dispatch').length === 1, `entries=${gateE(seq2, 'dispatch').length}`);
  shieldCtl.dropPasses(4242);

  // ---- ③"≈5000ms 花在哪"：ack 挂满 1.2s + 两趟 DOM 各 2.2s，最后靠 forced 那趟
  //         确认 ⇒ 预算(5s)已被打满，动作仍以成功收尾。本轮只记录，不改这条语义。
  freshPage();
  injectWorld(0, { arm: true });
  wireChrome();
  const execR = chromeStub.scripting.executeScript;
  let domCalls = 0;
  let ackHung = false;
  const sendR = chromeStub.tabs.sendMessage;
  chromeStub.tabs.sendMessage = async (tabId, payload, opts) => {
    state.sends.push({ tabId, payload, opts });
    if (!ackHung && payload?.type === 'UBB_PASS' && payload.on === true) {
      ackHung = true;
      return new Promise(() => {}); // ack 挂满 PASS_MSG_TIMEOUT_MS
    }
    return deliver(tabId, payload, opts);
  };
  chromeStub.scripting.executeScript = async (a) => {
    domCalls++;
    if (domCalls === 1) {
      await shieldCtl.sleep(2200);
      // 慢一点、然后给出" veil 还拦着"这一趟（把代码推进 forced 重开分支）
      return [{ frameId: 0, result: { hosts: 1, ours: 1, foreign: [], blocking: [{ owner: OURS, veil: 'auto' }], hit: null, hit_checked: true, open_tokens: 0, erased_unclaimed: 0 } }];
    }
    if (domCalls === 2) {
      await shieldCtl.sleep(2200);
      return execR(a); // 真回读：这一趟把门拧开并证明 ⇒ 仍然 confirmed
    }
    return execR(a); // 之后的派发照常快（不然这条测试要跑到天荒地老）
  };
  const seq3 = audit.seq;
  const t3 = Date.now();
  const r3 = await grab(() => reg.call('click', { tab_id: 1, x: 65, y: 299 }));
  const wall3 = Date.now() - t3;
  chromeStub.scripting.executeScript = execR;
  chromeStub.tabs.sendMessage = sendR;
  const o3 = gateE(seq3, 'open')[0];
  ok('前提：这条慢动作确实打满了 5s 预算并以成功落地（LIVE-RESULTS-5 的 5043-5076ms ok:true 形状）', !!r3.r?.clicked && !!o3 && o3.ms > 5000 && wall3 > 5000, JSON.stringify(o3 && { ms: o3.ms, verdict: o3.verdict }));
  ok('Q3 预算耗尽却以成功收尾的分支：over_budget_ms:true + over_budget_ok:true + budget_stopped:false（只记录，没被顺手改成拒绝）', o3?.over_budget_ms === true && o3?.over_budget_ok === true && o3?.budget_stopped === false && o3?.confirmed === true, JSON.stringify(o3 && { ob: o3.over_budget_ms,obo: o3.over_budget_ok, bs: o3.budget_stopped, v: o3.verdict }));
  ok('Q3 那 5s 落在哪一段：slowest 点名 dom（2.2s）而不是靠猜；budget_ms 就是 5000 这条常量', o3?.slowest?.kind === 'dom' && o3.slowest.ms >= 2000 && o3.budget_ms === 5000, JSON.stringify(o3 && { slowest: o3.slowest, budget_ms: o3.budget_ms }));
  ok('Q3 分解字段齐全：attempts / rounds[] / release_ms / sleep_ms / ack_ms / dom_ms（哪个等待或重试吃掉了时间，事后能算）', o3?.attempts === 1 && o3.rounds.length === 1 && typeof o3.release_ms === 'number' && typeof o3.sleep_ms === 'number' && typeof o3.rounds[0].ack_ms === 'number' && typeof o3.rounds[0].dom_ms === 'number', JSON.stringify(o3 && { attempts: o3.attempts, release_ms: o3.release_ms, sleep_ms: o3.sleep_ms, round: o3.rounds[0] }));
  ok('Q2 forced 分支不许被吞：这个 dom-point 是"强制重开之后"那一趟给的（forced:true，verdict 仍走同一套词汇）', o3?.forced === true && o3?.verdict === 'dom-point', JSON.stringify(o3 && { forced: o3.forced, verdict: o3.verdict, doms: (o3.doms || []).map((d) => d.kind) }));
  ok('ack 没答也别装：del:false + to:true 如实上报，且与 verdict 同时可见（真机上"消息送进去但没人答"就长这样）', o3?.del === false && o3?.acks?.[0]?.to === true, JSON.stringify(o3 && { del: o3.del, ack: o3.acks && o3.acks[0] }));
  unwireChromeForTest();
  wireChrome();
}

// ============================================================ 19. fix18: the release TIMING the delivery proof depends on
console.log('\n[19] fix18 时序钉：release 必须晚于投递时刻（不是晚于 ack）—— LIVE-RESULTS-6 的 t=205 开门 / t=5211 投递 / t=5261 关门，这个顺序就是修复本身');
{
  freshPage();
  injectWorld(0, { arm: true });
  wireChrome();
  // 500ms 在这里钉"顺序"（本套件跑得起），真机量级 5000ms 的定罪在 daemon/test-delivery.mjs
  state.deliverMs = 500;
  const w0 = queue.wire.length;
  const r0 = state.releases.length;
  const r = await grab(() => reg.call('click', { tab_id: 1, x: 65, y: 299 }));
  const items = queue.wire.slice(w0).filter((q) => q.method === 'Input.dispatchMouseEvent' && q.type !== 'mousemove');
  const maxAck = Math.max(...items.map((q) => q.acked_at));
  const maxDel = Math.max(...items.map((q) => q.delivered_at));
  const rels = state.releases.slice(r0);
  const relAt = rels.length ? Math.max(...rels.map((x) => x.at)) : 0;
  ok('前提：500ms 投递延迟下的 click 成功且带证据（delivered:true + 页面收到 mousedown/mouseup 两条 shield_hit:false 记录）', !!r.r && r.r.delivered === true && ringPageHits(0).filter((x) => x.type === 'mousedown' || x.type === 'mouseup').length === 2, JSON.stringify(r.e?.code || { d: r.r?.delivered, page: ringPageHits(0).map((x) => x.type) }));
  ok('关门晚于投递：最后一条 UBB_PASS close 的时刻 ≥ 最后一条事件的 delivered_at', rels.length >= 1 && relAt >= maxDel, JSON.stringify({ relAt, maxDel, n: rels.length }));
  ok('关门不是跟着 ack 走的：close 时刻 - 最后一条 ack ≥ 投递延迟 500ms（withPass 等的是证据，不是确认回执）', relAt - maxAck >= 500, JSON.stringify({ gap: relAt - maxAck }));
  ok('延迟真实存在（不是断言自己糊弄自己）：本通路每条 Input 的 delivered_at - acked_at ≥ 500', items.length >= 2 && items.every((q) => q.delivered_at - q.acked_at >= 500), JSON.stringify(items.map((q) => q.delivered_at - q.acked_at)));
  state.deliverMs = 0;
  queue.cancel();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
