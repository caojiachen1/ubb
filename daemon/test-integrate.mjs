// wave7a-integrate offline suite (contract §6.3/§6.4): the integration debt —
//   [A] download.status has ONE registration and it is the tools-downloads
//       superset (legacy fields state/bytes_received/total/paused/url intact);
//   [B] screencast slot: holder-aware start/stop (SCREENCAST_BUSY, no silent
//       takeover, an exited non-holder cannot stop the holder's cast) and — since
//       fix6 — a refused Page.stopScreencast reported as {stopped:false,reason}
//       instead of the old unconditional {stopped:true};
//   [C] the frame-origin gate: strict/off vault fills inside an iframe are
//       judged by the FRAME's own origin (fail-closed to the top-tab host
//       when the frame URL is unobtainable — never a pass);
//   [D] audit seq survives a service-worker restart through the
//       chrome.storage.session mirror (monotonic; the CLI cursor is never
//       fooled into a wraparound), and the ring itself never enters storage;
//   [E] statics: the liveview CLI side, MCP placeholder-gate wording,
//       background hydration wiring, test-replay config isolation.
//
//   node daemon/test-integrate.mjs
// Reverse controls (§6.3) — copy lib OUT of the repo (contract §0), break one
// line, re-run:
//   RC-A cp -r lib $TMP/rcA/lib; tools.js: neuter the SCREENCAST_BUSY check
//        node daemon/test-integrate.mjs --tools $TMP/rcA/lib/tools.js → [B] busy red
//   RC-B same fresh copy; enforceVaultOriginsFrame: missing frame URL returns
//        ALLOWED (skip the delegation) → [C] fail-closed red
//   RC-C cp lib/audit.js $TMP/rcC/audit.js; delete the _mirrorSeq() call in
//        log() → node daemon/test-integrate.mjs --audit $TMP/rcC/audit.js → [D] monotonic red
//   RC-fix6-A (screencast.stop back to the swallow) — patcher + clone live outside the repo:
//        node D:/Codebase/ubb-scratch/rc/fix6/patch.cjs a <rcdir>
//        node daemon/test-integrate.mjs --tools <rcdir>/lib/tools.js
//      → [B] must go red on {stopped:true} while Page.stopScreencast was refused
//   RC-fix11-A (确认退回"信账本") — 克隆在仓库外（契约 §0，仓库根=扩展根，`_` 条目会让扩展加载失败）：
//        cp -r lib D:/Codebase/ubb-scratch/rc/fix11/rc-a/lib
//        node D:/Codebase/ubb-scratch/rc/fix11/patch-a.cjs  # 给 confirmTxn 加"账本已有活事务 ⇒ 直接 confirmed"
//        node daemon/test-shield.mjs   --lib $RCROOT/rc-a/lib                    # [16]① 必须红
//        node daemon/test-integrate.mjs --shield-ctl $RCROOT/rc-a/lib/shield-ctl.js  # [L] runtime 那三条必须红

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { installChromeStub, validateCdpParams, makeDeliveryModel } from '../lib/testharness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
installChromeStub();
const chrome = globalThis.chrome;

const argv = process.argv.slice(2);
const optOf = (flagName) => {
  const i = argv.indexOf(flagName);
  return i >= 0 ? argv[i + 1] : null;
};
const RC = optOf('--tools') || optOf('--audit') || optOf('--shield-ctl') || optOf('--sites');
const TOOLS_PATH = optOf('--tools') ? path.resolve(HERE, optOf('--tools')) : path.resolve(HERE, '../lib/tools.js');
const LIBDIR = path.dirname(TOOLS_PATH);
const AUDIT_PATH = optOf('--audit') ? path.resolve(HERE, optOf('--audit')) : path.resolve(HERE, '../lib/audit.js');
// fix11: the gate module alone must be pointable at an RC copy (its lib/ siblings —
// actions.js, tabs.js, audit.js — stay the real ones, so a broken gate still drives
// the real input lanes).
// fix12-F3: point ONLY the site-rule module at a reverse-control copy (its siblings stay
// the real ones, so a remove that never writes storage still drives the real cache)
const SITES_PATH = optOf('--sites') ? path.resolve(HERE, optOf('--sites')) : path.join(LIBDIR, 'tools-sites.js');
const SHIELD_CTL_PATH = optOf('--shield-ctl') ? path.resolve(HERE, optOf('--shield-ctl')) : path.resolve(HERE, '../lib/shield-ctl.js');
const imp = (rel) => import(pathToFileURL(path.join(LIBDIR, rel)).href);

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
};
const codeOf = async (fn) => {
  try { return { ran: await fn() }; }
  catch (e) { return { code: e?.code ?? `plain throw: ${e?.message || e}`, msg: String(e?.message || e) }; }
};
const tick = () => new Promise((r) => setTimeout(r, 10));
if (RC) console.log(`\n[REVERSE CONTROL → ${RC}]`);

// shared sessions stub (targetTab needs an owning session, contract §9.3)
const { sessions } = await imp('tabs.js');
sessions.active = () => ({ id: 'offline', lastTabId: 1, touch: () => {} });
sessions.owns = () => true;

// ---------------------------------------------------------------- registries

async function loadReg() {
  const { registerTools } = await imp('tools.js');
  const { register: registerDownloads } = await imp('tools-downloads.js');
  const tools = new Map();
  const regCount = new Map();
  const dispatcher = {
    register(name, meta, fn) {
      regCount.set(name, (regCount.get(name) || 0) + 1);
      tools.set(name, { meta, fn });
    },
  };
  registerTools(dispatcher);
  registerDownloads(dispatcher); // registerExtras order proof: extras run after tools.js
  return {
    names: [...tools.keys()],
    metas: Object.fromEntries([...tools].map(([n, e]) => [n, e.meta])),
    regCount,
    call: (name, params = {}) => tools.get(name).fn(params),
  };
}

const cdpMod = await imp('cdp.js');
const cdpCalls = [];
cdpMod.cdp.ensure = async () => {};
// no invented CDP parameters reach the wire, even in this suite's flat stub
cdpMod.cdp.send = async (tabId, method, params = {}) => { validateCdpParams(method, params); cdpCalls.push({ method, ...params }); return {}; };

// ------------------------------------------------------------------- [A] download.status
console.log('\n[A] download.status: one registration, superset provider');
{
  const toolsSrc = fs.readFileSync(TOOLS_PATH, 'utf8');
  ok('lib/tools.js no longer registers download.status itself',
    !/R\('download\.status'/.test(toolsSrc));
  const reg = await loadReg();
  ok('download.status is registered exactly ONCE across the whole chain',
    (reg.regCount.get('download.status') || 0) === 1, `count=${reg.regCount.get('download.status')}`);
  ok('download.path is registered exactly ONCE too (old copy already removed)',
    (reg.regCount.get('download.path') || 0) === 1, `count=${reg.regCount.get('download.path')}`);
  chrome.downloads.search = async ({ id }) => [{
    id, state: 'complete', bytesReceived: 50, totalBytes: 100, paused: false,
    url: 'https://x.test/f.txt?token=LEAKME', finalUrl: 'https://x.test/f.txt?token=LEAKME',
    filename: '/home/u/Downloads/f.txt', mime: 'text/plain', startTime: '2026-01-01T00:00:00.000Z', tabId: 4,
  }];
  const st = await reg.call('download.status', { download_id: 7 });
  ok('legacy field state survives verbatim', st.state === 'complete', JSON.stringify(st));
  ok('legacy field bytes_received survives verbatim', st.bytes_received === 50);
  ok('legacy field total survives verbatim (totalBytes spelling)', st.total === 100);
  ok('legacy field paused survives verbatim', st.paused === false);
  ok('legacy field url survives, redactUrl-stripped', typeof st.url === 'string' && !st.url.includes('LEAKME'), st.url);
  ok('the WINNING provider is the tools-downloads superset (adds path/ready/hint/total_bytes)',
    st.path === '/home/u/Downloads/f.txt' && st.ready === true && typeof st.hint === 'string' && st.total_bytes === 100,
    JSON.stringify(st).slice(0, 220));
  const e1 = await codeOf(() => reg.call('download.status', {}));
  chrome.downloads.search = async () => [];
  const e2 = await codeOf(() => reg.call('download.status', { download_id: 9 }));
  ok('error codes match the old block (BAD_PARAMS / NOT_FOUND)',
    e1.code === 'BAD_PARAMS' && e2.code === 'NOT_FOUND', JSON.stringify([e1.code, e2.code]));
}

// ------------------------------------------------------------------- [B] screencast slot
console.log('\n[B] screencast: held slot, owner-gated stop');
{
  const reg = await loadReg();
  const T = { tab_id: 1 };
  const a = await reg.call('screencast.start', { ...T, owner: 'liveview:111' });
  ok('A (owner liveview:111) starts and the result echoes the owner', a.started === true && a.owner === 'liveview:111', JSON.stringify(a));
  const b = await codeOf(() => reg.call('screencast.start', { ...T, owner: 'liveview:222' }));
  ok('B is refused with SCREENCAST_BUSY while A holds the slot', b.code === 'SCREENCAST_BUSY', JSON.stringify(b));
  ok('the BUSY message names the holder and teaches both exits (stop / force)',
    /liveview:111/.test(b.msg || '') && /stop/i.test(b.msg || '') && /force/i.test(b.msg || ''), b.msg);
  ok('screencast.start description teaches the busy semantics', /SCREENCAST_BUSY/.test(reg.metas['screencast.start'].description));
  cdpCalls.length = 0;
  const bstop = await reg.call('screencast.stop', { ...T, owner: 'liveview:222' });
  ok('B exiting first does NOT stop A: owner-mismatched stop is refused', bstop.stopped === false && bstop.held_by === 'liveview:111', JSON.stringify(bstop));
  ok('the refused stop never touched the browser stream (no Page.stopScreencast)',
    !cdpCalls.some((c) => c.method === 'Page.stopScreencast'), JSON.stringify(cdpCalls.map((c) => c.method)));
  const pull = await codeOf(() => reg.call('screencast.next', { ...T, wait_ms: 0 }));
  ok('A\'s cast is still alive after B\'s stop (next answers, not NO_SCREENCAST)',
    !!pull.ran && (pull.ran.waiting === true || pull.ran.frame), JSON.stringify(pull));
  const take = await codeOf(() => reg.call('screencast.start', { ...T, owner: 'intruder', force: true }));
  ok('explicit force:true may still take the slot over', take.ran && take.ran.owner === 'intruder', JSON.stringify(take));
  cdpCalls.length = 0;
  const astop = await reg.call('screencast.stop', { ...T, owner: 'liveview:111' });
  ok('the old holder\'s stop after a force-takeover is refused (held_by intruder)', astop.stopped === false && astop.held_by === 'intruder', JSON.stringify(astop));
  ok('…and it did not stop the new holder\'s stream either', !cdpCalls.some((c) => c.method === 'Page.stopScreencast'));
  const istop = await reg.call('screencast.stop', { ...T, owner: 'intruder' });
  ok('the holder itself stops cleanly', istop.stopped === true);
  const again = await codeOf(() => reg.call('screencast.start', { ...T, owner: 'liveview:222' }));
  ok('after A exits normally, B can start', again.ran && again.ran.started === true, JSON.stringify(again));
  await reg.call('screencast.stop', { ...T, owner: 'liveview:222' });
  const legacy1 = await reg.call('screencast.start', { ...T });
  ok('no-owner callers still work, defaulting to owner "agent"', legacy1.started === true && legacy1.owner === 'agent');
  const legacy2 = await codeOf(() => reg.call('screencast.start', { ...T }));
  ok('two default-named agents still cannot silently replace each other', legacy2.code === 'SCREENCAST_BUSY', legacy2.code);
  const legacyStop = await reg.call('screencast.stop', { ...T });
  ok('a stop without owner keeps the old permissive semantics (back-compat)', legacyStop.stopped === true);
  const stopEmpty = await reg.call('screencast.stop', { ...T });
  ok('stopping a tab without any cast stays {stopped:false} (no error)', stopEmpty.stopped === false);

  // fix6 §F3-⑥ (the one fix5 reported and left alone): Page.stopScreencast was
  // swallowed behind .catch(() => {}) and the call still answered {stopped:true}.
  const realCdpSend = cdpMod.cdp.send;
  cdpMod.cdp.send = async (tabId, method, params = {}) => {
    if (method === 'Page.stopScreencast') {
      cdpCalls.push({ method, refused: true });
      throw new Error('-32000 Debugger is not attached');
    }
    return realCdpSend(tabId, method, params);
  };
  const hstart = await reg.call('screencast.start', { ...T, owner: 'holder' });
  cdpCalls.length = 0;
  const hstop = await reg.call('screencast.stop', { ...T, owner: 'holder' });
  cdpMod.cdp.send = realCdpSend;
  ok('stop：Page.stopScreencast 被拒 → 不再 {stopped:true}，而是 {stopped:false, reason:"cdp_stop_failed"}',
    hstop.stopped === false && hstop.reason === 'cdp_stop_failed' && /not attached/i.test(hstop.error || ''), JSON.stringify(hstop));
  ok('诚实形状把代价说清楚：扩展侧槽位已释放，浏览器侧可能仍在采集',
    hstop.local_slot_released === true && /may still be capturing/i.test(hstop.note || ''), hstop.note);
  ok('它确实上了线并被拒（不是没尝试就报失败）',
    cdpCalls.some((c) => c.method === 'Page.stopScreencast'), JSON.stringify(cdpCalls.map((c) => c.method)));
  const afterRefusedStop = await codeOf(() => reg.call('screencast.start', { ...T, owner: 'next' }));
  ok('被拒的 stop 仍然释放了槽位（下一次 start 不再吃 SCREENCAST_BUSY）',
    !!afterRefusedStop.ran && afterRefusedStop.ran.started === true, JSON.stringify(afterRefusedStop));
  await reg.call('screencast.stop', { ...T, owner: 'next' });
  ok('screencast.stop description 教了 stopped:false 的两个含义（held_by / cdp_stop_failed）',
    /held_by/.test(reg.metas['screencast.stop'].description) && /cdp_stop_failed/.test(reg.metas['screencast.stop'].description));
}

// ------------------------------------------------------------------- [B2] fix12-F2 lease
console.log('\n[B2] fix12-F2: screencast 槽位靠租约（活性证明），不靠名字');
{
  // one fake clock for the whole block: the lease is the ONLY thing that decides
  // whether a slot is reclaimable, and no offline test may wait 30 real seconds
  let offset = 0;
  const realNow = Date.now;
  Date.now = () => realNow.call(Date) + offset;
  const advance = (ms) => { offset += ms; };
  try {
    const reg = await loadReg();
    const T = { tab_id: 1 };
    const ghost = await reg.call('screencast.start', { ...T, owner: 'liveview:222', lease_ms: 30_000 });
    ok('租约参数回给调用侧（lease_ms 是可见的合同，不是内部变量）',
      ghost.started === true && ghost.lease_ms === 30_000, JSON.stringify(ghost));

    // ① 未过期：BUSY 仍然咬人（这就是"不许削弱防顶"那一条）
    const busy = await codeOf(() => reg.call('screencast.start', { ...T, owner: 'agent-x' }));
    ok('租约未过期时别的 owner 仍吃 SCREENCAST_BUSY（防顶没有被租约削弱）', busy.code === 'SCREENCAST_BUSY', JSON.stringify(busy));
    ok('BUSY 说的是还剩多少活性，而不是只点名字',
      /lease alive for another \d+ms/.test(busy.msg || '') && /30000|29\d\d\d/.test(busy.msg || ''), busy.msg);
    const stopRefused = await reg.call('screencast.stop', { ...T, owner: 'agent-x' });
    ok('活性租约下别人的 stop 依旧被拒（held_by + 剩余时间）',
      stopRefused.stopped === false && stopRefused.held_by === 'liveview:222' && stopRefused.lease_left_ms > 0, JSON.stringify(stopRefused));

    // ② 续租：拉帧就是活性证明
    advance(25_000);
    const pull = await reg.call('screencast.next', { ...T, wait_ms: 0, owner: 'liveview:222' });
    ok('screencast.next 把租约往后推（拉帧 = 活性证明）',
      pull.waiting === true && pull.lease_left_ms > 29_000, JSON.stringify(pull));
    const stillBusy = await codeOf(() => reg.call('screencast.start', { ...T, owner: 'agent-x' }));
    ok('刚续过租的 owner 别人仍然抢不走', stillBusy.code === 'SCREENCAST_BUSY', stillBusy.code);
    const anonPull = await reg.call('screencast.next', { ...T, wait_ms: 0 });
    ok('不带 owner 的拉帧同样续租（向后兼容旧调用侧，不是新漏洞：拉帧者必然是活的）',
      anonPull.waiting === true && anonPull.lease_left_ms > 29_000, JSON.stringify(anonPull));

    // ③ 过期：槽位自动回收，且抢占必须点名被回收的旧 owner
    advance(60_000); // 30s lease, nobody pulled for 55s+ → dead
    const expiredPull = await codeOf(() => reg.call('screencast.next', { ...T, wait_ms: 0, owner: 'someone-else' }));
    ok('别的 owner 过期后拉帧拿到 lease_expired + 点名旧持有者',
      !!expiredPull.ran && expiredPull.ran.lease_expired === true && /liveview:222/.test(expiredPull.ran.note || ''),
      JSON.stringify(expiredPull.ran || expiredPull.code));
    const stopGhost = await reg.call('screencast.stop', { ...T, owner: 'agent-x' });
    ok('过期租约允许任何调用侧收回槽位，并点名被回收的旧 owner',
      stopGhost.stopped === true && stopGhost.released_owner === 'liveview:222' && stopGhost.expired_ms > 0, JSON.stringify(stopGhost));
    // the 3B shape: taskkill /F leaves owner "liveview" and everything else starves
    cdpCalls.length = 0;
    const reg2 = await loadReg();
    const holder = await reg2.call('screencast.start', { ...T, owner: 'liveview', lease_ms: 20_000 });
    ok('真机 6e② 的起点：liveview 先占住槽位', holder.started === true && holder.lease_ms === 20_000, JSON.stringify(holder));
    advance(20_001); // liveview 被 taskkill /F —— 再没有人拉帧
    const after = await codeOf(() => reg2.call('screencast.start', { ...T, owner: 'agent-3b' }));
    ok('强杀后不再永远吃 BUSY：租约过期即回收（真机只能手工 stop 收回）',
      !!after.ran && after.ran.started === true, JSON.stringify(after.ran || after.code));
    ok('抢占的返回值必须点名被回收的旧 owner 与回收依据',
      after.ran?.reclaimed_from === 'liveview' && after.ran?.reclaimed_by === 'lease-expiry' &&
        /still marked as held by "liveview"/.test(after.ran?.note || ''), JSON.stringify(after.ran));
    ok('回收没有把旧的浏览器流留在页面上（startScreencast 重新上路、槽位换了主人）',
      cdpCalls.filter((c) => c.method === 'Page.startScreencast').length === 2, JSON.stringify(cdpCalls.map((c) => c.method)));
    const ghostStop = await reg2.call('screencast.stop', { ...T, owner: 'liveview' });
    ok('被回收的旧 owner 之后回来 stop 也只能是 no-op（它已经不持有）',
      ghostStop.stopped === false && ghostStop.held_by === 'agent-3b', JSON.stringify(ghostStop));
    await reg2.call('screencast.stop', { ...T, owner: 'agent-3b' });

    // ④ force:true 走同一条"点名"规矩，且活性租约抢不走
    const reg3 = await loadReg();
    await reg3.call('screencast.start', { ...T, owner: 'watcher', lease_ms: 30_000 });
    const forced = await reg3.call('screencast.start', { ...T, owner: 'stealer', force: true });
    ok('force 抢占的 note 说的是"你从谁手里抢的、它的租约还剩多久"',
      forced.reclaimed_from === 'watcher' && forced.reclaimed_by === 'force:true' &&
        /force:true while its lease still had \d+ms/.test(forced.note || ''), JSON.stringify(forced));
    ok('被 force 顶掉的 owner 自己 stop 也救不回来（held_by stealer）',
      (await reg3.call('screencast.stop', { ...T, owner: 'watcher' })).stopped === false);
    await reg3.call('screencast.stop', { ...T, owner: 'stealer' });

    // ⑤ 同一 owner 的心跳：renew:true 只续租，不重启浏览器流、也不对自己吃 BUSY
    const reg4 = await loadReg();
    cdpCalls.length = 0;
    await reg4.call('screencast.start', { ...T, owner: 'pump', lease_ms: 30_000 });
    advance(20_000);
    const plain = await codeOf(() => reg4.call('screencast.start', { ...T, owner: 'pump' }));
    ok('同 owner 不带 renew 的重复 start 仍然拒（不给自己开后门，也不悄悄重开流）',
      plain.code === 'SCREENCAST_BUSY' && /held by YOU/.test(plain.msg || ''), JSON.stringify({ code: plain.code, msg: (plain.msg || '').slice(0, 90) }));
    const beat = await reg4.call('screencast.start', { ...T, owner: 'pump', renew: true });
    ok('renew:true 是租约心跳（renewed:true），且没有第二次 Page.startScreencast',
      beat.started === true && beat.renewed === true &&
        cdpCalls.filter((c) => c.method === 'Page.startScreencast').length === 1, JSON.stringify({ beat, wire: cdpCalls.map((c) => c.method) }));
    ok('心跳把活性重新拉满（否则长跑的 liveview 会被自己的租约踢出去）',
      beat.lease_ms === 30_000 && /renewed YOUR lease/.test(beat.note || ''), JSON.stringify(beat));
    // a heartbeat must not become a takeover route
    const wrongBeat = await codeOf(() => reg4.call('screencast.start', { ...T, owner: 'other', renew: true }));
    ok('renew:true 只对当前 owner 有效，别人的心跳抢不到槽位', wrongBeat.code === 'SCREENCAST_BUSY', wrongBeat.code);
    await reg4.call('screencast.stop', { ...T, owner: 'pump' });

    // ⑥ 边界：租约不许被调成"永远不过期"
    const reg5 = await loadReg();
    const tiny = await reg5.call('screencast.start', { ...T, owner: 'tiny', lease_ms: 1 });
    ok('lease_ms 有下限（1ms 想都别想）', tiny.lease_ms === 5_000, JSON.stringify(tiny));
    await reg5.call('screencast.stop', { ...T, owner: 'tiny' });
    const huge = await reg5.call('screencast.start', { ...T, owner: 'huge', lease_ms: 99_999_999 });
    ok('lease_ms 有上限 300s：没人能把槽位焊死成永久', huge.lease_ms === 300_000, JSON.stringify(huge));
    await reg5.call('screencast.stop', { ...T, owner: 'huge' });
    const junk = await reg5.call('screencast.start', { ...T, owner: 'junk', lease_ms: 'abc' });
    ok('租约参数不是数字就回默认，而不是回 NaN 或永不回收', junk.lease_ms === 30_000, JSON.stringify(junk));
    await reg5.call('screencast.stop', { ...T, owner: 'junk' });
    ok('screencast.start 描述教的是租约语义（proof of life + lease_ms + renew），不是只教 owner 名字',
      /LEASE/.test(reg.metas['screencast.start'].description) && /lease_ms/.test(reg.metas['screencast.start'].description) &&
        /proof of life/.test(reg.metas['screencast.start'].description) && /"renew":true/.test(reg.metas['screencast.start'].description) &&
        /not first-come-first-served/.test(reg.metas['screencast.start'].description),
      reg.metas['screencast.start'].description.slice(0, 200));
    ok('screencast.next 描述教了"拉帧顺带续租"', /renews its lease/.test(reg.metas['screencast.next'].description), reg.metas['screencast.next'].description);
    ok('screencast.stop 描述教了过期即可回收（不再只有"必须同名 owner"一条路）',
      /LEASE has lapsed/i.test(reg.metas['screencast.stop'].description), reg.metas['screencast.stop'].description.slice(0, 200));
  } finally {
    Date.now = realNow;
  }
}

// ------------------------------------------------------------------- [C] frame origin gate
console.log('\n[C] vault origin inside frames: the FRAME origin decides, fail-closed fallback');
const { audit } = await imp('audit.js');
const { refs } = await imp('refs.js');
let EXT_FRAMES = [];
chrome.webNavigation.getAllFrames = async () => EXT_FRAMES.map((f) => ({ ...f, name: '' }));
let TOP_URL = 'https://top.test/page';
chrome.tabs.get = async (id) => ({ id, windowId: 1, url: TOP_URL, status: 'complete', active: true });
let worlds = {};
function mkWorld(w) {
  return {
    ...w,
    handle(op, args = {}) {
      switch (op) {
        case 'selfInfo':
          return { epoch: this.epoch, url: this.url, origin: this.origin, title: 'w', isFrame: this.frameId !== 0, sameOriginAncestry: false, name: '', stamp: null, innerWidth: this.innerWidth, innerHeight: this.innerHeight, dpr: 1, scroll: { x: 0, y: 0 } };
        case 'childFrameBoxes':
          return { frames: this.children.map((c, order) => ({ order, tag: 'iframe', id: '', name: '', src: c.src, liveUrl: '', sameOrigin: false, rect: c.rect, borderLeft: 0, borderTop: 0 })) };
        case 'describeRef': {
          const el = this.entries[Number(String(args.ref).slice(2)) - 1];
          if (!el) throw new Error('stale DOM ref: ' + args.ref);
          return { ref: args.ref, tag: 'input', role: el.role, name: el.name, local: el.rect, box: el.rect, visible: true, disabled: false, attributes: el.attributes, sensitive: el.sensitive };
        }
        case 'fillDom':
          return true;
        default:
          throw new Error('fake world: unhandled op ' + op);
      }
    },
  };
}
const PW_ENTRY = { role: 'textbox', name: 'password', rect: { x: 20, y: 40, width: 180, height: 22 }, attributes: { type: 'password', name: 'password' }, sensitive: { never: false, password: true } };
const OTP_ENTRY = { role: 'textbox', name: '短信验证码', rect: { x: 20, y: 40, width: 180, height: 22 }, attributes: { name: 'code' }, sensitive: { never: true, password: false } };
const GATE_STRICT_GH = { mode: 'strict', bindings: [{ name: 'gh_pw', exists: true, origins: ['github.com'] }] };
const GATE_UNBOUND = { mode: 'strict', bindings: [{ name: 'gh_pw', exists: true, origins: [] }] };
const GATE_GONE = { mode: 'strict', bindings: [{ name: 'gh_pw', exists: false, origins: ['github.com'] }] };
let nextTab = 10;
/** Build a fake frame world + one registered @eN frame ref; frameUrl null means
 *  the frame's own document URL is unknowable (about:blank-style). */
function frameCase({ frameUrl, topUrl = 'https://top.test/page', epoch = 'e2' }) {
  const tabId = nextTab++;
  TOP_URL = topUrl;
  const extUrl = frameUrl || 'about:blank';
  worlds = {
    0: mkWorld({ frameId: 0, url: topUrl, origin: topUrl, epoch: 'e0', innerWidth: 1280, innerHeight: 800, children: [{ src: frameUrl || '', rect: { x: 150, y: 250, width: 300, height: 200 } }] }),
    2: mkWorld({ frameId: 2, url: extUrl, origin: frameUrl || 'about:blank', epoch, innerWidth: 300, innerHeight: 200, children: [], entries: [OTP_ENTRY, PW_ENTRY, PW_ENTRY, PW_ENTRY] }),
  };
  EXT_FRAMES = [
    { frameId: 0, parentFrameId: -1, url: topUrl },
    { frameId: 2, parentFrameId: 0, url: extUrl },
  ];
  chrome.tabs.sendMessage = async (t, msg, opts) => {
    if (msg?.type !== 'UBB_BRIDGE') return { ok: true, state: { mode: 'off' } };
    const w = worlds[opts?.frameId];
    if (!w) throw new Error('could not establish connection. Receiving end does not exist.');
    return { ok: true, result: w.handle(msg.op, msg.args), frameId: opts.frameId, docEpoch: w.epoch };
  };
  const ref = refs.put(tabId, null, {
    role: 'textbox', name: 'password', frameId: 2, domRef: '@d2', epoch,
    ...(frameUrl ? { frameUrl } : {}),
    crossOrigin: true,
  });
  return { tabId, ref };
}
const vaultFill = (reg, c, over = {}) => reg.call('fill', {
  tab_id: c.tabId, ref: c.ref, value: 'resolved-by-daemon',
  __ubb_secret_fill: true, __ubb_secret_names: ['gh_pw'], __ubb_secret_gate: GATE_STRICT_GH, ...over,
});
{
  const reg = await loadReg();

  cdpCalls.length = 0;
  const denied = await codeOf(() => vaultFill(reg, frameCase({ frameUrl: 'https://evil.test/login', topUrl: 'https://github.com/' })));
  ok('strict: top tab is github.com but the OOPIF is evil.test → SECRET_ORIGIN_DENIED (the old top-host shape allowed this)',
    denied.code === 'SECRET_ORIGIN_DENIED', JSON.stringify(denied));
  ok('the denial judged the FRAME host, not the tab host',
    audit.list(10).some((e) => e.reason === 'origin_mismatch' && e.origin === 'evil.test' && e.decision === 'denied' && e.vault_entry === 'gh_pw' && e.frame === true),
    JSON.stringify(audit.list(3).map((e) => [e.action, e.reason, e.origin])));
  ok('nothing was typed into the mismatched frame', !cdpCalls.some((c) => String(c.method).startsWith('Input.')), JSON.stringify(cdpCalls.map((c) => c.method)));

  cdpCalls.length = 0;
  const trap = await codeOf(() => vaultFill(reg, frameCase({ frameUrl: 'https://github.com.evil.test/x' })));
  ok('suffix trap: frame host github.com.evil.test does NOT match the github.com binding',
    trap.code === 'SECRET_ORIGIN_DENIED' && audit.list(5).some((e) => e.origin === 'github.com.evil.test' && e.decision === 'denied'), JSON.stringify(trap));

  cdpCalls.length = 0;
  const frameOk = await codeOf(() => vaultFill(reg, frameCase({ frameUrl: 'https://github.com/login', topUrl: 'https://top.test/page' })));
  ok('frame origin wins: the github.com FRAME fills even though the TOP tab does not match (judgment uses the ref\'s own frame URL)',
    frameOk.ran && frameOk.ran.via === 'frame-coords', JSON.stringify(frameOk));
  ok('the allow was audited with the FRAME host', audit.list(8).some((e) => e.action === 'secret.fill' && e.origin === 'github.com' && e.decision === 'filled' && e.frame === true));
  ok('and a real input burst actually reached the frame', cdpCalls.some((c) => c.method === 'Input.insertText') && cdpCalls.some((c) => c.method === 'Input.dispatchMouseEvent'));

  cdpCalls.length = 0;
  const noUrlTopOk = await codeOf(() => vaultFill(reg, frameCase({ frameUrl: null, topUrl: 'https://github.com/' })));
  ok('no frameUrl → DEGRADES to the top-tab host judgment (github tab → allowed)',
    noUrlTopOk.ran && noUrlTopOk.ran.via === 'frame-coords', JSON.stringify(noUrlTopOk));
  const noUrlTopBad = await codeOf(() => vaultFill(reg, frameCase({ frameUrl: null, topUrl: 'https://evil.test/' })));
  ok('FAIL-CLOSED: an unobtainable frameUrl is never a free pass — the top-host gate still refuses (evil tab → denied)',
    noUrlTopBad.code === 'SECRET_ORIGIN_DENIED', JSON.stringify(noUrlTopBad));

  const unbound = await codeOf(() => vaultFill(reg, frameCase({ frameUrl: 'https://github.com/' }), { __ubb_secret_gate: GATE_UNBOUND }));
  ok('strict + unbound secret in a frame → denied with reason unbound',
    unbound.code === 'SECRET_ORIGIN_DENIED' && audit.list(3).some((e) => e.reason === 'unbound'), JSON.stringify(unbound));
  const gone = await codeOf(() => vaultFill(reg, frameCase({ frameUrl: 'https://github.com/' }), { __ubb_secret_gate: GATE_GONE }));
  ok('strict + vanished secret → denied with reason secret_gone',
    gone.code === 'SECRET_ORIGIN_DENIED' && audit.list(3).some((e) => e.reason === 'secret_gone'), JSON.stringify(gone));
  const ngC = frameCase({ frameUrl: 'https://github.com/' });
  const noGate = await codeOf(() => reg.call('fill', { tab_id: ngC.tabId, ref: ngC.ref, value: 'x', __ubb_secret_fill: true, __ubb_secret_names: ['gh_pw'] }));
  ok('gate missing with no daemon link → DAEMON_NOT_CONNECTED (the RPC fallback fails closed, not open)',
    noGate.code === 'DAEMON_NOT_CONNECTED', JSON.stringify(noGate));

  cdpCalls.length = 0;
  const otpC = frameCase({ frameUrl: 'https://github.com/' });
  const otp = await codeOf(() => reg.call('fill', {
    tab_id: otpC.tabId, value: '123456', __ubb_secret_fill: true, __ubb_secret_names: ['gh_pw'], __ubb_secret_gate: GATE_STRICT_GH,
    ref: refs.put(otpC.tabId, null, { role: 'textbox', name: '短信验证码', frameId: 2, domRef: '@d1', epoch: 'e2', frameUrl: 'https://github.com/', crossOrigin: true }),
  }));
  ok('OTP/验证码 inside a frame stays permanently refused whatever the origin',
    otp.code === 'SENSITIVE_FIELD' && !cdpCalls.some((c) => String(c.method).startsWith('Input.')), JSON.stringify(otp));

  const dFrame = frameCase({ frameUrl: 'https://evil.test/x', topUrl: 'https://github.com/' });
  const dBad = await codeOf(() => reg.call('fill', {
    tab_id: dFrame.tabId, ref: '@d2.2', value: 'x',
    __ubb_secret_fill: true, __ubb_secret_names: ['gh_pw'], __ubb_secret_gate: GATE_STRICT_GH,
  }));
  ok('@d<frameId>.n routed fills are gated by THAT frame\'s URL too (evil.test frame denied)',
    dBad.code === 'SECRET_ORIGIN_DENIED', JSON.stringify(dBad));
  const dUnknown = frameCase({ frameUrl: 'https://github.com/', topUrl: 'https://github.com/' });
  EXT_FRAMES = EXT_FRAMES.map((f) => (f.frameId === 2 ? { ...f, url: '' } : f)); // webNavigation lost the URL
  const dDeg = await codeOf(() => reg.call('fill', {
    tab_id: dUnknown.tabId, ref: '@d2.2', value: 'x',
    __ubb_secret_fill: true, __ubb_secret_names: ['gh_pw'], __ubb_secret_gate: GATE_STRICT_GH,
  }));
  ok('@d frame whose URL is unknown → top-host judgment (github tab allows; the gate still RAN)',
    dDeg.ran && dDeg.ran.via === 'dom' && audit.list(4).some((e) => e.action === 'secret.fill' && e.decision === 'filled'),
    JSON.stringify(dDeg));
}

// ------------------------------------------------------------------- [D] audit seq mirror
console.log('\n[D] audit: seq survives an SW restart via chrome.storage.session');
const { AuditRing } = await import(pathToFileURL(AUDIT_PATH).href);
{
  const sMap = new Map();
  chrome.storage.session = {
    get: async (k) => Object.fromEntries([...sMap].filter(([key]) => (Array.isArray(k) ? k : [k]).includes(key))),
    set: async (obj) => { for (const [key, v] of Object.entries(obj)) sMap.set(key, v); },
    remove: async (k) => { sMap.delete(k); },
  };

  const r1 = new AuditRing();
  await r1.hydrateSeq();
  r1.log({ action: 'a' }); r1.log({ action: 'b' }); r1.log({ action: 'c' });
  await tick();
  ok('first run assigns seq 1..3', r1.entries.map((e) => e.seq).join() === '1,2,3');
  ok('the mirror writes ONLY the counter key (ring bodies stay out of storage)',
    [...sMap.keys()].join() === 'ubb_audit_seq' && sMap.get('ubb_audit_seq') === 3, JSON.stringify([...sMap]));

  // ---- service-worker restart: NEW instance, SAME storage.session backing
  const r2 = new AuditRing();
  await r2.hydrateSeq();
  ok('after the restart the ring is empty but seq starts from the stored floor (3)', r2.seq === 3 && r2.entries.length === 0, `seq=${r2.seq}`);
  ok('an empty post-restart ring still answers minSeq with the floor, not 0', r2.minSeq() === 3, String(r2.minSeq()));
  r2.log({ action: 'd' });
  await tick();
  ok('the first post-restart entry is seq 4 — monotonic across the restart', r2.entries[0].seq === 4, JSON.stringify(r2.entries[0]));
  ok('storage advanced with it', sMap.get('ubb_audit_seq') === 4);

  // the exact cursor formulas of audit.tail / daemon cli/audit.mjs
  const since = 3; // a tailer that drained up to seq 3 before the restart
  ok('the CLI wraparound test (ring_seq < since) stays FALSE — no bogus reset note',
    !(r2.seq < since), `ring_seq=${r2.seq} since=${since}`);
  ok('the tailer resumes cleanly: listSince(3) returns exactly the new entry', r2.listSince(3).map((e) => e.seq).join() === '4');
  ok('dropped_before_cursor computes 0 (nothing wrongly announced)', Math.max(0, r2.minSeq() - since - 1) === 0);

  // ---- the race: log() landing BEFORE hydrate settles
  const r3 = new AuditRing();
  r3.log({ action: 'early' }); // pre-hydration entry
  await tick();
  ok('a pre-hydration log cannot clobber the stored seq (mirror gated until hydrated)',
    sMap.get('ubb_audit_seq') === 4, String(sMap.get('ubb_audit_seq')));
  await r3.hydrateSeq();
  ok('hydrate raises the floor over the racing entry', r3.seq === 4, String(r3.seq));
  r3.log({ action: 'post' });
  await tick();
  ok('the next entry lands at 5 — no re-issue of already-drained seqs',
    r3.entries[r3.entries.length - 1].seq === 5 && sMap.get('ubb_audit_seq') === 5);

  // ---- size discipline under load
  const r4 = new AuditRing();
  await r4.hydrateSeq();
  for (let i = 0; i < 600; i++) r4.log({ action: 'x', note: 'pad-pad-pad'.repeat(8) });
  await tick();
  ok('600 logs → ring capped at 500 while storage STILL holds one small integer',
    r4.entries.length === 500 && [...sMap.keys()].join() === 'ubb_audit_seq' && sMap.get('ubb_audit_seq') === 605,
    `entries=${r4.entries.length} stored=${sMap.get('ubb_audit_seq')}`);
  ok('seq is strictly monotonic through the eviction boundary',
    r4.entries.every((e, i, a) => i === 0 || e.seq > a[i - 1].seq));

  // ---- the SW wiring
  const bg = fs.readFileSync(path.resolve(HERE, '../background.js'), 'utf8');
  ok('background.js hydrates the seq BEFORE the daemon link opens',
    /function startLinkHydrated\(\)[\s\S]{0,200}hydrateSeq\(\)[\s\S]{0,80}link\.start\(\)/.test(bg));
  ok('every link.start entry point goes through it (exactly one bare call left)',
    (bg.match(/link\.start\(\)/g) || []).length === 1 && /startLinkHydrated\(\);/.test(bg) && /onStartup\.addListener\(startLinkHydrated\)/.test(bg),
    `bare calls=${(bg.match(/link\.start\(\)/g) || []).length}`);
}

// ------------------------------------------------------------------- [E] statics: the other side of each fix
console.log('\n[E] CLI / MCP / test-side statics');
{
  const lv = fs.readFileSync(path.resolve(HERE, 'cli/liveview.mjs'), 'utf8');
  ok('liveview declares an owner for the screencast slot', /export const LIVEVIEW_OWNER/.test(lv));
  ok('liveview start passes the owner AND a lease',
    /screencast\.start',\s*\{\s*\.\.\.target,\s*owner:\s*LIVEVIEW_OWNER,\s*lease_ms:\s*LIVEVIEW_LEASE_MS\s*\}/.test(lv));
  ok('liveview declares the lease it asks for (that is what releases a hard-killed slot)',
    /export const LIVEVIEW_LEASE_MS\s*=\s*(\d[\d_]*)/.test(lv) &&
      Number((lv.match(/export const LIVEVIEW_LEASE_MS\s*=\s*([\d_]+)/) || [0, '0'])[1].replace(/_/g, '')) <= 60_000,
    (lv.match(/export const LIVEVIEW_LEASE_MS[^\n]*/) || [''])[0]);
  ok('liveview pulls frames AS ITS OWN OWNER, so every pull renews the lease',
    /screencast\.next',\s*\{[^}]*owner:\s*LIVEVIEW_OWNER/.test(lv), (lv.match(/screencast\.next[^\n]*/) || [''])[0]);
  ok('liveview stop passes the owner (an exited liveview cannot kill another holder)', /screencast\.stop',\s*\{\s*\.\.\.target,\s*owner:\s*LIVEVIEW_OWNER\s*\}/.test(lv));
  ok('liveview handles SCREENCAST_BUSY explicitly and NEVER force-steals',
    /SCREENCAST_BUSY/.test(lv) && !/screencast\.start[^\n]*force:\s*true/.test(lv));
  ok('the busy refusal happens before the pull loop / shutdown is even set up',
    lv.indexOf('SCREENCAST_BUSY') > 0 && lv.indexOf('SCREENCAST_BUSY') < lv.indexOf('let stopped = false'));
  // fix12-F2: 6f could not prove Ctrl+C on this machine (nohup + Windows console),
  // so every path that can end the process must be wired HERE and pinned now.
  const exitWired = ['SIGINT', 'SIGTERM', 'SIGBREAK', 'uncaughtException', 'unhandledRejection']
    .filter((sig) => !new RegExp(`process\\.on\\('${sig}',[\\s\\S]{0,240}?shutdown\\(`).test(lv));
  ok('liveview 的每一条退出路径都走 shutdown()（含崩溃兜底），不是只挂 SIGINT/SIGTERM',
    exitWired.length === 0, `没接上的信号: ${exitWired.join(', ')}`);
  ok('shutdown 里那次 screencast.stop 是唯一出口且带 owner（幂等由 stopped 标志守住）',
    (lv.match(/screencast\.stop'/g) || []).length === 1 &&
      /const shutdown = async \(reason\) => \{\s*if \(stopped\) return;\s*stopped = true;/.test(lv),
    `stop 调用次数=${(lv.match(/screencast\.stop'/g) || []).length}`);
  ok('崩溃路径不许静默：uncaught/unhandled 都先打印是谁把 liveview 打死的',
    /console\.error\(`ubb liveview: uncaught/.test(lv) && /console\.error\(`ubb liveview: unhandled/.test(lv));
  ok('给用户的说明写死了强杀场景的回收方式（不假装 taskkill 能触发钩子）',
    /taskkill \/F 强杀时没有退出钩子[\s\S]{0,80}租约[\s\S]{0,40}槽位/.test(lv) ||
      /no exit hook[\s\S]{0,160}lease/i.test(lv), (lv.match(/[^\n]*taskkill[^\n]*/) || [''])[0].slice(0, 120));

  const { TOOLS: MCP_TOOLS } = await import(pathToFileURL(path.resolve(HERE, 'mcp-tools/index.mjs')).href);
  const listDesc = MCP_TOOLS.find((t) => t.name === 'ubb_secret_list')?.description || '';
  const fillDesc = MCP_TOOLS.find((t) => t.name === 'ubb_secret_fill')?.description || '';
  ok('ubb_secret_list teaches where {{secret:NAME}} substitutes (fill/fill_form/type/replay vars only)',
    /\{\{secret:NAME\}\}/.test(listDesc) && /fill_form/.test(listDesc) && /type/.test(listDesc) && /replay vars/.test(listDesc) && /never evaluate/.test(listDesc), listDesc.slice(0, 120));
  ok('ubb_secret_list states the strict origin rule incl. the frame-origin split',
    /strict/.test(listDesc) && /iframe/.test(listDesc) && /fail-closed/i.test(listDesc));
  ok('ubb_secret_list states OTP/CVV/card refusal for the placeholder path too',
    /OTP/.test(listDesc) && /CVV/.test(listDesc) && /card-number/.test(listDesc));
  ok('ubb_secret_fill description covers the placeholder gate', /\{\{secret:NAME\}\}/.test(fillDesc) && /fill_form/.test(fillDesc));
  ok('the curated catalog still aggregates (no schema shape break)', MCP_TOOLS.length >= 30, String(MCP_TOOLS.length));

  const tr = fs.readFileSync(path.resolve(HERE, 'test-replay.mjs'), 'utf8');
  const envAt = tr.indexOf('process.env.UBB_CONFIG_FILE = path.join(VAULT_DIR');
  const sImport = tr.indexOf("import(pathToFileURL(path.resolve(HERE, optOf('--secret') || './cli/secret.mjs'))");
  ok('test-replay pins UBB_CONFIG_FILE to the throwaway dir BEFORE importing cli/secret.mjs',
    envAt > 0 && sImport > envAt, `envAt=${envAt} sImport=${sImport}`);
  ok('…and pins the MODE itself (off), never the machine default', /getSecretOriginMode\(\) === 'off'/.test(tr));

  const toolsSrc = fs.readFileSync(TOOLS_PATH, 'utf8');
  ok('screencast entries carry owner + started_at (holder info in the BUSY error)', /owner,\s*started_at:/.test(toolsSrc));
  ok('the frame gate names the frame origin in its denial (the model sees which origin judged)', /FRAME this field lives in/.test(toolsSrc));
  ok('enforceVaultOriginsFrame delegates when the frame host is unknowable', /if \(!host\) return enforceVaultOrigins\(/.test(toolsSrc));
}

// ---------------------------------------------------------------- [K] fix9: the four input lanes carry equal-strength pass gates
console.log('\n[K] fix9：四条输入通路的闸门同强度（secret.fill = fill{ref}；replay 每步带点位/keys；human 自带确认；cdp.call 不许沉默）');
{
  const reg = await loadReg();
  const toolsSrc = fs.readFileSync(TOOLS_PATH, 'utf8');
  const secSrc = fs.readFileSync(path.join(LIBDIR, 'tools-secrets.js'), 'utf8');
  const repSrc = fs.readFileSync(path.join(LIBDIR, 'tools-replay.js'), 'utf8');
  const humSrc = fs.readFileSync(path.join(LIBDIR, 'human.js'), 'utf8');
  const optsOf = (src, anchor) => {
    const from = src.indexOf(anchor);
    if (from < 0) return null;
    const m = src.slice(from).match(/withPass\(tabId,[\s\S]{0,1800}?\}, (\{[^}]*\})\)/);
    return m ? m[1] : '(no opts object on that withPass)';
  };
  const fillOpts = optsOf(toolsSrc, "R('fill',");
  const secretOpts = optsOf(secSrc, "'secret.fill'");
  ok('credential 主力 secret.fill 的 pass opts 与 fill{ref} 同键（frameId + at + keys:true）',
    ['frameId', 'at: [box.cx, box.cy]', 'keys: true'].every((k) => String(secretOpts).includes(k)) &&
      ['frameId', 'at: [box.cx, box.cy]', 'keys: true'].every((k) => String(fillOpts).includes(k)),
    `secret=${JSON.stringify(secretOpts)} fill=${JSON.stringify(fillOpts)}`);
  ok('replay 的 click 步骤按当刻点位确认（at），keypress 走 keys:true（目标帧未知 ⇒ 铺全帧）',
    /case 'click'[\s\S]{0,1400}?withPass\(tabId,[\s\S]{0,500}?\{ at: \[box\.cx, box\.cy\]/.test(repSrc) &&
      /case 'keypress'[\s\S]{0,700}?withPass\(tabId,[\s\S]{0,400}?\{ keys: true \}/.test(repSrc),
    (repSrc.match(/withPass\(tabId,[^\n]*\n/g) || []).join(' | ').slice(0, 160));
  const humSends = [...humSrc.matchAll(/cdp\.send\(tabId, 'Input\./g)].map((m) => m.index);
  const humProven = humSends.filter((i) => humSrc.slice(Math.max(0, i - 220), i).includes('assertInputGate(tabId)'));
  ok('human.js 自己派发 Input.*，所以每一条派发点都得自己确认（一处不落）',
    humSends.length >= 7 && humProven.length === humSends.length, `${humProven.length}/${humSends.length}`);
  // fix10: the human arm of tools.js used to add its OWN gate.check() on top of
  // human.js's first proof and withPass's opening confirm — one extra round trip
  // per human action for a point that was already proved twice. The proof now
  // lives in exactly one place (human.js), and the arms must reflect that.
  const humanArms = [...toolsSrc.matchAll(/(?:await human\.isEnabled\(\)|humanOn)\)? \{\n/g)].map((m) =>
    (toolsSrc.slice(m.index + m[0].length).split('\n').slice(0, 10).find((l) => l.trim() && !l.trim().startsWith('//')) || '').trim());
  ok('逐派发确认只有一处：tools.js 的 6 个 human 分支都不再自己 gate.check()（human.js 内部仍然每次都确认）',
    humanArms.length >= 6 && humanArms.every((l) => !/gate\.check\(/.test(l)) && humProven.length === humSends.length,
    humanArms.filter((l) => /gate\.check/.test(l)).join(' | ') || `${humanArms.length} arms`);
  ok('cdp.call 保留裸发但必须开口：raw Input.* 的返回值与审计带 gate_bypassed',
    /const rawInput = [^\n]*Input\.[\s\S]{0,600}?if \(rawInput\) \{[\s\S]{0,400}?gate_bypassed = true/.test(toolsSrc) &&
      /gate_bypassed: rawInput/.test(toolsSrc), (toolsSrc.match(/.{0,40}gate_bypassed.{0,40}/g) || []).join(' | '));
  ok('这条告知也写进 cdp.call 的描述（模型选路前就看得见）', /gate_bypassed/.test((reg.metas['cdp.call'] || {}).description || ''), String((reg.metas['cdp.call'] || {}).description).slice(0, 120));
}

// ---------------------------------------------------------------- [L] fix11: the DOM is the only truth the gate may believe
console.log('\n[L] fix11：账本/DOM 双向失配 —— 任何一条输入通路的"已确认"都必须来自 DOM 点位回读');
{
  const ctlSrc = fs.readFileSync(SHIELD_CTL_PATH, 'utf8');
  const { assertInputGate, ensurePass, withPass, reconcileTab, sweepLeakedPasses, activePassCount, dropPasses } = await import(pathToFileURL(SHIELD_CTL_PATH).href);
  const src = fs.readFileSync(path.resolve(HERE, '../content/shield.js'), 'utf8');
  ok('world 的对账把过期/无人认领的令牌写回属性（不只是算 verdict 时忽略）',
    /function reconcile\(born\)[\s\S]{0,1800}?h\.setAttribute\('data-ubb-pass', serialize\(stamp\)\)[\s\S]{0,900}?v\.style\.pointerEvents = blocking \? 'auto' : 'none'/.test(src),
    (src.match(/function reconcile[\s\S]{0,120}/) || [''])[0].replace(/\n/g, ' '));
  ok('每次 apply 都按 stamp 复核过期（world 侧自收门，不靠那条 setTimeout）',
    /function revalidatePasses\(\)[\s\S]{0,260}?p\.expire > now/.test(src) && /function apply\(\)[\s\S]{0,900}?reconcile\(\);/.test(src));
  ok('world 的 pass 答复是 DOM 真相（dom_pass_tokens/blocking_hosts/host_in_dom），不是 passes.size',
    /dom_pass_tokens/.test(src) && /blocking_hosts/.test(src) && /host_in_dom/.test(src));
  ok('DOM 通路的每一次往返都带 claims（无人认领的令牌才被擦得掉，孤儿 host 才被关上）',
    /__ubbFramePass\(op, token, expire, at, owner, claims\)/.test(ctlSrc) && /erased \+= before/.test(ctlSrc));
  ok('有一条活的自收门周期（chrome.alarms，活在 SW 里；content world 的定时器说了不算）',
    /SHIELD_SWEEP_ALARM/.test(ctlSrc) && /export async function sweepLeakedPasses/.test(ctlSrc) && /export async function reconcileTab/.test(ctlSrc));

  // runtime, on a page with a real shield world: the same refusal every lane pays
  const prevSend = chrome.tabs.sendMessage;
  const prevScripting = chrome.scripting;
  chrome.scripting = {
    executeScript: async ({ target }) => [{ frameId: target.frameIds[0], result: undefined }], // 通道不答
  };
  chrome.tabs.sendMessage = async (_t, payload) =>
    payload?.type === 'UBB_PASS' || payload?.type === 'UBB_SHIELD_QUERY'
      ? { ok: true, pass: true, state: { mode: 'armed', blockMode: 'block', pass: true, pass_tokens: ['whatever-the-world-holds'] } }
      : { ok: true };
  const codeA = await codeOf(() => assertInputGate(1));
  ok('mouse()/key() 用的那一行闸门：通道不答 ⇒ 红（旧形状是退回世界的账本 → 事件照发）',
    codeA.code === 'SHIELD_PASS_FAILED' || codeA.code === 'NO_SESSION' || codeA.ran?.checked === false, JSON.stringify(codeA));
  const gate = await codeOf(() => ensurePass(1, { at: [60, 20], keys: false }));
  ok('ensurePass 在没有点位证明时不返回 gate（只可能红）', gate.code === 'SHIELD_PASS_FAILED', JSON.stringify({ code: gate.code, msg: String(gate.msg || '').slice(0, 60) }));
  const codeB = await codeOf(() => withPass(1, async () => 'ran', { at: [60, 20] }));
  ok('replay / secret.fill / frameFill 这些只调 withPass 的通路同样红，且动作体一次都没被执行',
    codeB.code === 'SHIELD_PASS_FAILED' && codeB.ran === undefined, JSON.stringify({ code: codeB.code, ran: codeB.ran }));
  chrome.scripting = {
    executeScript: async () => { throw new Error('Cannot access frame'); },
  };
  const sw = await reconcileTab(1);
  ok('reconcileTab 不许把"注入失败"报成"已经关上"（proven:false 是诚实的）', sw.proven === false, JSON.stringify(sw));
  chrome.tabs.sendMessage = prevSend;
  chrome.scripting = prevScripting;
  dropPasses(1);
  ok('清场：账本没有留下幽灵事务', activePassCount(1) === 0, String(activePassCount(1)));
}

// ---------------------------------------------------------------- [M] fix12-F3 site rules undo
console.log('\n[M] fix12-F3: site.rules 用户覆盖层必须有撤销通路（能加也要能撤）');
{
  // a storage that really keeps what the tools wrote — that is the only way to
  // catch a "removed" that never touched the disk (LIVE-RESULTS-3B §F4 shape)
  const disk = new Map();
  const prevLocal = chrome.storage.local;
  chrome.storage.local = {
    get: async (key) => {
      if (typeof key === 'string') return disk.has(key) ? { [key]: disk.get(key) } : {};
      if (Array.isArray(key)) return Object.fromEntries(key.filter((k) => disk.has(k)).map((k) => [k, disk.get(k)]));
      if (key && typeof key === 'object') {
        const out = {};
        for (const k of Object.keys(key)) if (disk.has(k)) out[k] = disk.get(k);
        return out;
      }
      return Object.fromEntries(disk);
    },
    set: async (obj) => { for (const [k, v] of Object.entries(obj)) disk.set(k, JSON.parse(JSON.stringify(v))); },
    remove: async (k) => { for (const key of [].concat(k)) disk.delete(key); },
  };
  chrome.runtime.getURL = (p) => `chrome-extension://ubb-offline-harness/${p}`;
  const PACKAGED = JSON.parse(fs.readFileSync(path.resolve(HERE, '../content/site-rules.json'), 'utf8'));
  const prevFetch = globalThis.fetch;
  globalThis.fetch = async (u) => ({
    ok: true,
    json: async () => (String(u).endsWith('site-rules.json') ? PACKAGED : { rules: [] }),
  });

  const sitesMod = await import(pathToFileURL(SITES_PATH).href);
  const ctl = await imp('bridge-ctl.js');
  const st = new Map();
  sitesMod.register({ register: (n, m, f) => st.set(n, { m, f }) });
  const sCall = (n, p = {}) => st.get(n).f(p);
  const USER_LAYER = () => (disk.get('ubbSiteRules') || []);
  const rule = (id, host = 'blog.example.com') => ({ id, match: { host_pattern: [host] }, extract: [{ op: 'text', select: 'h1' }] });

  ok('site.rules.remove / site.rules.clear 都注册了，且都是 sensitive（confirm 闸门）',
    st.has('site.rules.remove') && st.has('site.rules.clear') &&
      st.get('site.rules.remove').m.sensitive === true && st.get('site.rules.clear').m.sensitive === true &&
      !!st.get('site.rules.remove').m.description && !!st.get('site.rules.clear').m.description,
    [...st.keys()].join(', '));

  const base = await sCall('site.rules.list');
  ok('起点：6 条全是 packaged builtin，用户层为空',
    base.counts.user === 0 && base.counts.builtin === 6 && base.rules.every((r) => r.source === 'builtin'),
    JSON.stringify(base.counts));
  ok('list 把每条的可撤销性说明了（removable 与 source 一致，不许有假 promise）',
    base.rules.every((r) => r.removable === (r.source === 'user')) && /only user rules are removable/i.test(st.get('site.rules.list').m.description),
    JSON.stringify(base.rules.map((r) => [r.id, r.removable])));

  await sCall('site.rules.add', { rule: rule('fix12-demo'), confirm: true });
  const shadow = { id: 'github', match: { host_pattern: ['blog.example.com'] }, extract: [{ op: 'text', select: 'h1', prefix: 'USER-GITHUB: ' }] };
  await sCall('site.rules.add', { rule: shadow, confirm: true });
  const withTwo = await sCall('site.rules.list');
  ok('加了两条（其中一条按 fix6 的同 id 覆盖 builtin）后用户层里确实有两条',
    withTwo.counts.user === 2 && USER_LAYER().length === 2 &&
      withTwo.rules.find((r) => r.id === 'github')?.source === 'user' &&
      withTwo.rules.find((r) => r.id === 'github')?.removable === true, JSON.stringify(withTwo.rules.map((r) => [r.id, r.source])));
  ok('list 直接给出撤销通路的名字与参数（不是"去 storage 里删"那种没有通路的话）',
    /site\.rules\.remove/.test(withTwo.undo || '') && /site\.rules\.clear/.test(withTwo.undo || ''), withTwo.undo);
  const providerWithTwo = await sitesMod.effectiveSiteRules();
  ok('撤销之前 read_site 确实走的是用户层（否则撤销无从谈起）',
    providerWithTwo[0].id === 'fix12-demo' || providerWithTwo.findIndex((r) => r.id === 'github') < providerWithTwo.findIndex((r) => r.id === 'zhihu'),
    JSON.stringify(providerWithTwo.map((r) => r.id)));

  const noConfirm = await codeOf(() => sCall('site.rules.remove', { id: 'fix12-demo' }));
  ok('remove 不带 confirm 一律 NEEDS_CONFIRM（且什么都没删）',
    noConfirm.code === 'NEEDS_CONFIRM' && USER_LAYER().length === 2, JSON.stringify(noConfirm));
  const junkId = await codeOf(() => sCall('site.rules.remove', { id: 'has space!', confirm: true }));
  ok('remove 的 id 形状不对就 BAD_PARAMS（不带 storage 写入）',
    junkId.code === 'BAD_PARAMS' && USER_LAYER().length === 2, JSON.stringify(junkId));
  const ghost = await codeOf(() => sCall('site.rules.remove', { id: 'nosuchrule', confirm: true }));
  ok('remove 一个不存在的 id 必须红（SITE_RULE_NOT_FOUND），不许学 replay.delete 谎报 deleted',
    ghost.code === 'SITE_RULE_NOT_FOUND' && USER_LAYER().length === 2, JSON.stringify(ghost));
  const builtinDirect = await codeOf(() => sCall('site.rules.remove', { id: 'zhihu', confirm: true }));
  ok('builtin 不是可删对象：直接删 zhihu 要红并且点名它来自打包文件',
    builtinDirect.code === 'SITE_RULE_NOT_FOUND' && USER_LAYER().length === 2 && /PACKAGED/.test(builtinDirect.msg || ''), JSON.stringify(builtinDirect));

  const removedOne = await sCall('site.rules.remove', { id: 'fix12-demo', confirm: true });
  ok('remove 一条后 storage 里真的少了那条（不是只回了个好听的 JSON）',
    removedOne.removed === 'fix12-demo' && USER_LAYER().length === 1 && !USER_LAYER().some((r) => r.id === 'fix12-demo'),
    JSON.stringify(USER_LAYER().map((r) => r.id)));
  const afterOne = await sCall('site.rules.list');
  ok('remove 后 read_site 的候选集立刻不含它（缓存被作废，无需重载扩展）',
    afterOne.counts.user === 1 && !(await sitesMod.effectiveSiteRules()).some((r) => r.id === 'fix12-demo'),
    JSON.stringify(afterOne.counts));

  const unshadow = await sCall('site.rules.remove', { id: 'github', confirm: true });
  ok('撤掉同 id 的用户覆盖后打包那条回来了（fix6 的"user 优先"是可逆的）',
    unshadow.removed === 'github' && unshadow.builtin_now_effective === 'github' &&
      (await sCall('site.rules.list')).rules.find((r) => r.id === 'github')?.source === 'builtin',
    JSON.stringify(unshadow));
  const backToSix = await sCall('site.rules.list');
  ok('两条都撤完：list 回落到 6 条 builtin、storage 用户层为空',
    backToSix.counts.user === 0 && backToSix.counts.total === 6 && backToSix.rules.every((r) => r.source === 'builtin' && r.removable === false) &&
      USER_LAYER().length === 0, JSON.stringify({ c: backToSix.counts, layer: USER_LAYER() }));
  const warm = await sCall('site.rules.reload');
  ok('reload 后 warm 缓存里也只剩 6 条 builtin',
    warm.reloaded === true && warm.total === 6 && warm.ids.join(',') === PACKAGED.rules.map((r) => r.id).join(','),
    JSON.stringify({ total: warm.total, ids: warm.ids }));

  await sCall('site.rules.add', { rule: rule('clear-me-1'), confirm: true });
  await sCall('site.rules.add', { rule: rule('clear-me-2'), confirm: true });
  const noConfirmClear = await codeOf(() => sCall('site.rules.clear', {}));
  ok('clear 不带 confirm 同样 NEEDS_CONFIRM（什么都不删）',
    noConfirmClear.code === 'NEEDS_CONFIRM' && USER_LAYER().length === 2, JSON.stringify(noConfirmClear));
  const cleared = await sCall('site.rules.clear', { confirm: true });
  ok('clear 把整个用户层清空：storage 里是空数组，不是残留',
    cleared.cleared === 2 && JSON.stringify(USER_LAYER()) === '[]', JSON.stringify(USER_LAYER()));
  ok('clear 后 list 回到 6 条 builtin',
    (await sCall('site.rules.list')).counts.total === 6 && (await sCall('site.rules.list')).counts.user === 0,
    JSON.stringify((await sCall('site.rules.list')).counts));
  const clearEmpty = await sCall('site.rules.clear', { confirm: true });
  ok('空层再 clear 说的是"本来就空"，不是谎报删了两条',
    clearEmpty.cleared === 0 && /already empty/.test(clearEmpty.note || ''), JSON.stringify(clearEmpty));

  // 描述与精选目录同步（F3 要求 daemon/mcp-tools/sites.mjs 一起改）
  const { SITES_TOOLS: SITES_MCP } = await import(pathToFileURL(path.resolve(HERE, 'mcp-tools/sites.mjs')).href);
  const mcpList = SITES_MCP.find((t) => t.name === 'ubb_site_rules_list')?.description || '';
  ok('精选目录的 list 描述也教了 removable + remove/clear 两条撤销路',
    /removable/.test(mcpList) && /site\.rules\.remove/.test(mcpList) && /site\.rules\.clear/.test(mcpList), mcpList.slice(0, 200));
  ok('site.rules.add 的 note 不再把用户踢回"自己编辑 storage"，而是给 remove',
    /site\.rules\.remove/.test((await sCall('site.rules.add', { rule: rule('note-check'), confirm: true })).note || '') &&
      !/removing the rule id from key/.test(st.get('site.rules.add').m.description),
    st.get('site.rules.add').m.description.slice(-160));

  await sCall('site.rules.clear', { confirm: true });
  globalThis.fetch = prevFetch;
  chrome.storage.local = prevLocal;
  ok('清场：storage 用户层与精选目录都没留下这条演示规则',
    USER_LAYER().length === 0 && !ctl.getSiteRulesCache()?.some((r) => r.id === 'note-check'), String(USER_LAYER().length));
}

// ---------------------------------------------------------------- [N] fix19: pre-dispatch visibility fast-fail
console.log('\n[N] fix19：隐藏标签的指针/真键盘输入在派发前快退（三条真实出路）；可见态取证形状不退；缓存与导航失效');
{
  // ── a page the WHOLE input lane can run against ─────────────────────────────
  // One document per frameId, each with its own visibilityState and its own
  // delivery ring written in the REAL attribute grammar; the injected functions
  // chrome.scripting would serialise are RUN, not mocked, so whatever
  // shield-ctl asks the document stays the only authority on the answer.
  const TOPWIN = {};
  TOPWIN.top = TOPWIN;
  TOPWIN.self = TOPWIN;
  const DOCS = new Map(); // frameId → { win, attrs, vis }
  const PAGE = { reads: 0, wire: [], scriptings: [], deliverFrame: 0, drain: true };
  function pageDoc(frameId) {
    if (DOCS.has(frameId)) return DOCS.get(frameId);
    const attrs = { 'data-ubb-delivery': '' }; // present-but-empty = a recorder with no records yet
    const vis = { state: 'visible' };
    const doc = {
      get visibilityState() {
        return vis.state;
      },
      documentElement: {
        getAttribute: (k) => (k in attrs ? attrs[k] : null),
        setAttribute: (k, v) => {
          attrs[k] = String(v);
        },
      },
      querySelectorAll: () => [],
      elementFromPoint: () => ({
        tagName: 'BUTTON',
        classList: { contains: () => false },
        getAttribute: () => null,
        getBoundingClientRect: () => ({ left: 0, top: 0, width: 10, height: 10 }),
      }),
    };
    doc.body = doc.documentElement;
    const win = frameId === 0
      ? Object.assign({}, TOPWIN, { document: doc })
      : {
          document: doc,
          top: TOPWIN,
          self: null,
          frameElement: {
            getBoundingClientRect: () => ({ left: 0, top: 0 }),
            clientLeft: 0,
            clientTop: 0,
            ownerDocument: { defaultView: TOPWIN },
          },
          addEventListener: () => {},
        };
    if (frameId === 0) {
      win.top = win;
      win.self = win;
      TOPWIN.document = doc;
    }
    const entry = { win, doc, attrs, vis };
    DOCS.set(frameId, entry);
    return entry;
  }
  const ringLines = (f) => String(pageDoc(f).attrs['data-ubb-delivery'] || '').split(';').filter(Boolean);
  const setVis = (f, s) => {
    pageDoc(f).vis.state = s;
  };
  // the module under test is the one loadReg() registered from (LIBDIR-aware, so
  // a reverse-control copy drives its OWN cache): invalidateVisibilityCache(null)
  // is the module's own reset, which is exactly what "导航/换标签要失效" means.
  const toolsMod = await import(pathToFileURL(path.join(LIBDIR, 'tools.js')).href);
  const cacheOf = async (key) => (await toolsMod.visibilityCacheEntries()).find((e) => e.key === key) || null;
  const resetPage = () => {
    PAGE.reads = 0;
    PAGE.wire = [];
    PAGE.scriptings = [];
    PAGE.deliverFrame = 0;
    PAGE.drain = true;
    DOCS.clear();
    for (const f of [0, 2, 5]) pageDoc(f);
    FRAMES = [0];
    toolsMod.invalidateVisibilityCache(null);
  };

  // which documents the tab owns (the gate covers exactly these); [N1c] flips it
  // to [0,2] because that is the only way a frame-targeted action gets there.
  let FRAMES = [0];
  const installNChannel = () => {
    chrome.tabs.sendMessage = nSend; // hoisted below: nSend is only read when this runs
    chrome.webNavigation.getAllFrames = async () =>
      FRAMES.map((frameId) => ({ frameId, parentFrameId: frameId === 0 ? -1 : 0, url: frameId === 0 ? 'https://keep.test/page' : 'https://keep.test/child', name: '' }));
  };


  const prevScripting = chrome.scripting;
  const prevSend = chrome.tabs.sendMessage;
  const prevCdpSend = cdpMod.cdp.send;
  const prevTabsGet = chrome.tabs.get;
  const runInjected = (func, frameId, args) => {
    const { doc, win } = pageDoc(frameId);
    // the injected function's free variables (document / window / getComputedStyle
    // / chrome) become this wrapper's parameters, and ITS body is what runs — the
    // closest offline stand-in for "chrome.scripting serialised it into the page".
    const make = new Function('document', 'window', 'getComputedStyle', 'chrome', `return (${func.toString()})`);
    const inner = make(
      doc,
      win,
      () => ({ display: 'block', pointerEvents: 'none' }),
      { runtime: { id: 'ubb-offline-harness' } },
    );
    return inner(...args);
  };
  chrome.scripting = {
    executeScript: async ({ target, func, args = [] }) => {
      const name = String(func?.name || '');
      const frames = (target && target.frameIds) || [];
      PAGE.scriptings.push({ func: name, frames });
      if (name === '__ubbFrameVisibilityRead') PAGE.reads++;
      return frames.map((f) => ({ frameId: f, result: runInjected(func, f, args) }));
    },
  };
  const nSend = async (tabId, payload, opts) => {
    const f = opts?.frameId ?? 0;
    if (payload?.type === 'UBB_DELIVERY_QUERY') {
      const recs = ringLines(f).map((line) => {
        const f2 = line.split('~');
        return { seq: Number(f2[0]), type: f2[1], x: Number(f2[2]), y: Number(f2[3]), t: Number(f2[4]), shield_hit: f2[5] === '1' };
      });
      return { ok: true, recorder: true, seq: recs.length ? recs[recs.length - 1].seq : 0, records: recs };
    }
    if (payload?.type === 'UBB_PASS' || payload?.type === 'UBB_SHIELD_QUERY') {
      return { ok: true, pass: true, state: { mode: 'off', blockMode: 'block', dom_pass_tokens: [], blocking_hosts: 0 } };
    }
    if (payload?.type === 'UBB_BRIDGE') {
      // the addressing ops come from the [C] fake frame worlds; every mutating op
      // (clickDom/fillDom/selectDom) just lands — this group is about which PATH
      // runs, not about the bridge's own semantics.
      const w = worlds[f];
      if (w && ['selfInfo', 'childFrameBoxes', 'describeRef'].includes(payload.op)) {
        return { ok: true, result: w.handle(payload.op, payload.args || {}), frameId: f, docEpoch: w.epoch };
      }
      return { ok: true, result: true, frameId: f, docEpoch: 'e-n' };
    }
    return { ok: true };
  };
  installNChannel();
  // ack at once, DELIVER into the document's own ring (the fix17/18 model), and
  // a hidden queue is modelled honestly: drain=false ⇒ the record never appears.
  const queue = makeDeliveryModel({
    deliverMs: 0,
    hitTest: () => null,
    isShield: () => false,
    dispatch: (item) => {
      if (!PAGE.drain) return;
      if (item.type === 'mousemove') return;
      const recs = ringLines(PAGE.deliverFrame);
      const top = recs.reduce((m, l) => Math.max(m, Number(l.split('~')[0]) || 0), 0);
      const now = Date.now();
      recs.push([top + 1, item.type, item.x ?? '-', item.y ?? '-', now, '0'].join('~'));
      pageDoc(PAGE.deliverFrame).attrs['data-ubb-delivery'] = recs.join(';');
    },
  });
  cdpMod.cdp.send = async (tabId, method, params = {}) => {
    validateCdpParams(method, params);
    PAGE.wire.push({ method, ...params });
    if (method === 'Runtime.evaluate') {
      const e = String(params.expression || '');
      const value = /readyState/.test(e) ? 'complete' : /scrollY/.test(e) ? 0 : '';
      return { result: { value } };
    }
    if (method === 'Page.getNavigationHistory') return { currentIndex: 0, entries: [{ id: 1 }] };
    return queue.ack(method, params);
  };
  const visReads = () => PAGE.scriptings.filter((s) => s.func === '__ubbFrameVisibilityRead');
  const inputWire = () => PAGE.wire.filter((c) => String(c.method).startsWith('Input.'));
  // like codeOf, but the error OBJECT survives: this group asserts on e.data
  // (stage / dispatched / events_on_wire), which is the whole honesty claim.
  const grab = async (fn) => {
    try {
      return { ran: await fn() };
    } catch (e) {
      return { code: e?.code ?? `plain throw: ${e?.message || e}`, msg: String(e?.message || e), data: e?.data };
    }
  };
  const wall = async (fn) => {
    const t0 = Date.now();
    const out = await grab(fn);
    return { ...out, ms: Date.now() - t0 };
  };

  const reg = await loadReg();
  const toolsSrcN = fs.readFileSync(TOOLS_PATH, 'utf8');
  const N1 = { tab_id: 1 };

  // ── 1. 隐藏态：派发前快退 ────────────────────────────────────────────────────
  console.log('\n[N1] visibilityState=hidden 的指针动作：0 事件上线、远小于取证预算、三条出路都在');
  resetPage();
  setVis(0, 'hidden');
  {
    const r = await wall(() => reg.call('click', { ...N1, x: 65, y: 299 }));
    ok('[N1] 红在 INPUT_NOT_DELIVERED（与真机第七轮同一个错误码，形状不变）', r.code === 'INPUT_NOT_DELIVERED', JSON.stringify({ code: r.code, msg: (r.msg || '').slice(0, 80) }));
    ok('[N1] 判据来自目标文档自己的 visibilityState（不是窗口 focused / tab.active 的猜测）', r.msg && /visibilityState/.test(r.msg) && /"hidden"/.test(r.msg), (r.msg || '').slice(0, 120));
    ok('[N1] 派发前就退：stage:"pre-dispatch" + dispatched:false + events_on_wire:0', r.code === 'INPUT_NOT_DELIVERED' && r.data?.stage === 'pre-dispatch' && r.data?.dispatched === false && r.data?.events_on_wire === 0, JSON.stringify(r.data));
    ok('[N1] 真的什么都没发出去（Input.* 上线 0 条 ⇒ 不存在"重试就双发"）', inputWire().length === 0, JSON.stringify(inputWire().map((c) => c.method)));
    ok('[N1] 快退：整体 <1000ms（隐藏态不再等满 ' + 7000 + 'ms 取证预算，真机 12.09s 的白等结束）', r.ms < 1000, `wall=${r.ms}ms`);
    ok('[N1] 只花了一次可见性往返（判据本身不吃预算）', visReads().length === 1, `reads=${visReads().length}`);
    const msg = String(r.msg || '');
    ok('[N1] 出路①：由用户把窗口置于前台，并明说 agent 没有这个能力 / window.restore 也不改变遮挡', /前台/.test(msg) && /没有|不能|无法/.test(msg) && /window\.restore/.test(msg), msg.slice(0, 200));
    ok('[N1] 出路②：tab.create {"url":…,"active":true} 与 tab.select 都在，且如实写"select 仍可能 hidden"', /tab\.create/.test(msg) && /active/.test(msg) && /tab\.select/.test(msg) && /仍|照旧|不会/.test(msg), '(exit 2)');
    ok('[N1] 出路③：桥的合成事件通路（@d / clickDom / fillDom）被给出来', /@d/.test(msg) && /合成事件/.test(msg) && /(clickDom|fillDom)/.test(msg), '(exit 3)');
    ok('[N1] 出路③标了不等价：isTrusted:false + 语义不等价', /isTrusted/.test(msg) && /不等价/.test(msg), '(caveat)');
    ok('[N1] 说"别原样重试"（红不是抖动，盲重试要么双发要么再白等）', /别原样重试/.test(msg), '(no blind retry)');
    ok('[N1] 预算是常量，不写在调用点（VISIBLE/HIDDEN 两个数字都来自 tools.js 的导出）', /export const VISIBLE_WAIT_BUDGET_MS = 7000/.test(toolsSrcN) && /export const HIDDEN_BUDGET_MS = \d+/.test(toolsSrcN) && /export const VISIBILITY_CACHE_TTL_MS/.test(toolsSrcN), '(constants)');
    ok('[N1] 拒绝被审计（visibility.refuse + dispatched:false）',
      audit.list(20).some((e) => e.action === 'visibility.refuse' && e.dispatched === false && e.visibility_state === 'hidden'),
      JSON.stringify(audit.list(6).map((e) => e.action)));
  }

  console.log('\n[N1f] 同一条"页面一条都收不到"的页（投递环永不新增记录）做对照：读到 hidden ⇒ 立即红；读不到 ⇒ 仍按老路等满取证预算');
  {
    resetPage();
    PAGE.drain = false; // the LIVE-RESULTS-7 shape: records_seen stays 0 however long the door stays open
    setVis(0, 'hidden');
    const hidden = await wall(() => reg.call('click', { ...N1, x: 65, y: 299 }));
    ok('hidden：仍然 <1000ms 红在派发前（真机每次 12.09s 的白等就是这一格被省掉）',
      hidden.code === 'INPUT_NOT_DELIVERED' && hidden.data?.stage === 'pre-dispatch' && hidden.ms < 1000,
      JSON.stringify({ code: hidden.code, wall: hidden.ms }));
    ok('hidden：一条 Input.* 都没上线（不派发 = 不双发）', inputWire().length === 0, JSON.stringify(inputWire().length));
    resetPage();
    PAGE.drain = false;
    // a document that answers the visibility question with nonsense (an orphan
    // world): fix19 must NOT turn "could not read" into "visible", and must not
    // refuse either — it walks the pre-fix19 route and pays the proof budget.
    Object.defineProperty(pageDoc(0).doc, 'visibilityState', { get: () => 'not-a-state', configurable: true });
    const blind = await wall(() => reg.call('click', { ...N1, x: 65, y: 299 }));
    ok('读不到：照常派发（press+release 上了线），不是被新判据拒掉',
      inputWire().length >= 2, JSON.stringify(inputWire().map((c) => c.params && c.params.type)));
    ok('读不到：等满取证预算才红（≥6950ms，且红的形状还是 fix17/18 的那一条：stage 不是 pre-dispatch）',
      blind.code === 'INPUT_NOT_DELIVERED' && blind.data?.stage !== 'pre-dispatch' && blind.ms >= 6950,
      JSON.stringify({ code: blind.code, wall: blind.ms, stage: blind.data?.stage }));
  }

  console.log('\n[N1b] 其余真键盘/指针通路同一条规则（type / press_key / drag / scroll 的 wheel 兜底）');
  for (const [name, params] of [
    ['type', { text: 'hello' }],
    ['press_key', { key: 's', modifiers: ['ctrl'] }],
    ['drag', { from: { x: 10, y: 10 }, to: { x: 200, y: 200 } }],
    ['scroll', { direction: 'down', amount: 600 }],
  ]) {
    resetPage();
    setVis(0, 'hidden');
    const r = await wall(() => reg.call(name, { ...N1, ...params }));
    ok(`${name}：隐藏态同样红在派发前（INPUT_NOT_DELIVERED + stage pre-dispatch）`,
      r.code === 'INPUT_NOT_DELIVERED' && r.data?.stage === 'pre-dispatch', JSON.stringify({ code: r.code, data: r.data && r.data.stage }));
    ok(`${name}：0 条 Input.* 上线，且 <1000ms（不再白等那 7000ms 取证预算）`,
      inputWire().length === 0 && r.ms < 1000, JSON.stringify({ wire: inputWire().length, wall: r.ms }));
  }

  console.log('\n[N1c] 判据问的是"要挨这一下的那个文档"：帧内目标按帧的 visibilityState 判');
  {
    resetPage();
    setVis(0, 'visible'); // 顶层可见（窗口没被遮挡时帧也可见）
    const c = frameCase({ frameUrl: 'https://keep.test/child' });
    installNChannel(); // frameCase re-installs ITS send handler — take the channel back
    FRAMES = [0, 2];
    setVis(2, 'hidden'); // 只有帧文档读出来是 hidden
    setVis(0, 'visible');
    const r = await wall(() => reg.call('fill', { tab_id: c.tabId, ref: c.ref, value: 'x', __ubb_secret_fill: true }));
    ok('帧内 ref 的坐标通路：hidden 的帧文档被点名（frame_id:2 而非顶层）',
      r.code === 'INPUT_NOT_DELIVERED' && r.data?.frame_id === 2 && r.data?.visibility_state === 'hidden', JSON.stringify(r.data || { code: r.code }));
    ok('确实问了帧 2 的文档（executeScript 的 frameIds 就是 [2]）',
      (PAGE.scriptings.find((s) => s.func === '__ubbFrameVisibilityRead') || {}).frames?.join() === '2',
      JSON.stringify(PAGE.scriptings.map((s) => [s.func, s.frames && s.frames.join()])));
    ok('帧内物理点击一条都没发出（0 Input.* 上线）', inputWire().length === 0, JSON.stringify(inputWire().map((c2) => c2.method)));
  }

  console.log('\n[N1d] 缓存键 = `${tabId}:${frameId}`，同标签连续动作只测一次');
  {
    resetPage();
    setVis(0, 'hidden');
    for (let i = 0; i < 5; i++) await grab(() => reg.call('press_key', { ...N1, key: 'a' }));
    ok('5 次动作 = 1 次可见性往返（性能护栏：这条判据不许变成每动作一个新回合）', PAGE.reads === 1, `reads=${PAGE.reads}`);
    const entries = await toolsMod.visibilityCacheEntries();
    ok('缓存键点明标签与文档（1:0），值带状态与时刻', entries.some((e) => e.key === '1:0' && e.state === 'hidden' && typeof e.at === 'number'), JSON.stringify(entries));
  }

  console.log('\n[N1e] 出路③本身不被这条判据堵死：桥通路（@d / selector）在隐藏标签照常可用');
  {
    resetPage();
    setVis(0, 'hidden');
    const before = PAGE.reads;
    const s1 = await grab(() => reg.call('click', { ...N1, selector: '#b-save' }));
    ok('click{selector} 走桥内合成事件：隐藏标签也执行（不被 pre-dispatch 判据拒）',
      !!s1.ran && s1.ran.via === 'selector' && s1.code !== 'INPUT_NOT_DELIVERED', JSON.stringify(s1));
    const s2 = await grab(() => reg.call('fill', { ...N1, ref: '@d7', value: 'v' }));
    ok('fill{@dN} 走桥内 setter：隐藏标签也执行', !!s2.ran && !s2.code, JSON.stringify(s2));
    ok('桥通路没有为此多问一次可见性（判据只挂在真输入派发点上）', PAGE.reads === before, `reads=${PAGE.reads - before}`);
  }

  // ── 2. 可见态：取证形状一字不改 ─────────────────────────────────────────────
  console.log('\n[N2] visible：照常走完整投递取证，delivered:true / delivery_ms 形状不变');
  resetPage();
  setVis(0, 'visible');
  {
    const r = await wall(() => reg.call('click', { ...N1, x: 65, y: 299 }));
    ok('可见态动作成功且带页侧证据：delivered:true', !!r.ran && r.ran.delivered === true, JSON.stringify(r.code || r.ran));
    ok('返回形状未变（clicked/via/delivered/delivery_ms 四键）',
      JSON.stringify(Object.keys(r.ran || {}).sort()) === JSON.stringify(['clicked', 'delivered', 'delivery_ms', 'via']),
      JSON.stringify(Object.keys(r.ran || {})));
    ok('delivery_ms 毫秒级（<200ms：证据在第一次轮询就在）', typeof r.ran?.delivery_ms === 'number' && r.ran.delivery_ms < 200, JSON.stringify(r.ran?.delivery_ms));
    ok('取证真的在跑（投递环读 ≥1 次，判据没有把 withPass 的 expect 换掉）',
      PAGE.scriptings.some((s) => s.func === '__ubbFrameDeliveryRead'), JSON.stringify(PAGE.scriptings.map((s) => s.func)));
    ok('受信事件真的上线了（Input.dispatchMouseEvent ≥2：press+release）',
      PAGE.wire.filter((c) => c.method === 'Input.dispatchMouseEvent').length >= 2,
      JSON.stringify(PAGE.wire.map((c) => c.method)));
    ok('整个调用 <1000ms（可见标签不吃这条判据的亏）', r.ms < 1000, `wall=${r.ms}ms`);
  }
  console.log('\n[N2b] 可见态：连续 5 次动作仍然只测 1 次可见性');
  {
    resetPage();
    setVis(0, 'visible');
    const rs = [];
    for (let i = 0; i < 5; i++) rs.push(await grab(() => reg.call('click', { ...N1, x: 65, y: 299 })));
    ok('5 次全部成功且 5 次都带 delivered:true（缓存没有让任何一次跳过取证）',
      rs.every((x) => x.ran && x.ran.delivered === true), JSON.stringify(rs.map((x) => x.code || x.ran?.delivered)));
    ok('可见性只问了 1 次（TTL 内复用）', PAGE.reads === 1, `reads=${PAGE.reads}`);
  }

  // ── 3. 读不到 = 保守路径，不新增猜测 ────────────────────────────────────────
  console.log('\n[N3] 判据读不到（文档不答 / 没有 DOM 通路）：不当成 visible，也不拒——照常派发 + 照常取证');
  {
    resetPage();
    // the document answers the visibility question with nonsense (an orphan world,
    // a wedged frame): the only legal answers are the four real visibilityState
    // values, so this must degrade to the PRE-fix19 behaviour, never to an allow
    // that skips the proof and never to a refusal.
    const doc = pageDoc(0);
    Object.defineProperty(doc.doc, 'visibilityState', { get: () => '', configurable: true });
    const r = await wall(() => reg.call('click', { ...N1, x: 65, y: 299 }));
    ok('读不到时不拒（没有 pre-dispatch 的红）', r.code !== 'INPUT_NOT_DELIVERED' || r.data?.stage !== 'pre-dispatch', JSON.stringify({ code: r.code, stage: r.data?.stage }));
    ok('读不到时照常派发（Input.* 上了线）', inputWire().length >= 2, JSON.stringify(inputWire().map((c) => c.params && c.params.type)));
    ok('读不到时照常取证（投递环仍然被读过，判据没有把取证一起跳过）',
      PAGE.scriptings.some((s) => s.func === '__ubbFrameDeliveryRead'), '(proof still ran)');
    const blind = await cacheOf('1:0');
    ok('缓存把"读不到"记成 unknown，不是 visible', !!blind && blind.state === 'unknown', JSON.stringify(blind));
  }

  // ── 4. 导航失效 ─────────────────────────────────────────────────────────────
  console.log('\n[N4] 导航后缓存必须失效（新文档 = 新的可见性答案；陈旧 hidden 也不能继续拒）');
  {
    resetPage();
    setVis(0, 'hidden');
    chrome.tabs.get = async (id) => ({ id, windowId: 1, url: 'https://keep.test/page', status: 'complete', active: true });
    const a = await grab(() => reg.call('click', { ...N1, x: 65, y: 299 }));
    ok('起点：hidden 被拒并进了缓存', a.code === 'INPUT_NOT_DELIVERED' && PAGE.reads === 1, JSON.stringify({ code: a.code, reads: PAGE.reads }));
    setVis(0, 'visible'); // the user raised the window and the page navigated
    const n = await grab(() => reg.call('navigate', { ...N1, url: 'https://keep.test/next' }));
    ok('navigate 本身不受判据影响（它是 chrome.tabs.update，不是输入）', !!n.ran && n.ran.navigated === true, JSON.stringify(n.code || n.ran));
    const b = await wall(() => reg.call('click', { ...N1, x: 65, y: 299 }));
    ok('导航后再问一次（缓存条目被导航丢掉，reads=2）', PAGE.reads === 2, `reads=${PAGE.reads}`);
    ok('导航后的新答案立刻生效：不再拿陈旧的 hidden 拒一个现在可见的标签',
      !!b.ran && b.ran.delivered === true, JSON.stringify(b.code || b.ran));
    const reload = await grab(() => reg.call('reload', { ...N1 }));
    ok('reload 也算换文档（reloaded:true，且缓存再被丢掉）',
      !!reload.ran && PAGE.reads === 2, JSON.stringify(reload.code || reload.ran));
    const c2 = await grab(() => reg.call('click', { ...N1, x: 65, y: 299 }));
    ok('reload 之后同样重新读一次可见性（reads=3）', !!c2.ran && PAGE.reads === 3, `reads=${PAGE.reads}`);
    // tab.select: it CANNOT be trusted to have made the tab visible, and the
    // answer must not be the stale pre-select one either.
    setVis(0, 'hidden');
    const sel = await grab(() => reg.call('tab.select', { ...N1 }));
    ok('tab.select 明说自己没把窗口变可见（visible:false + visibility_state:"hidden"）',
      sel.ran && sel.ran.visible === false && sel.ran.visibility_state === 'hidden' && /遮挡|仍然|不会/.test(String(sel.ran.note || '')),
      JSON.stringify(sel.ran));
    ok('tab.select 没有把刚读到的答案写进缓存（select 后 0ms 的读数不许当 5 秒圣旨）',
      (await cacheOf('1:0')) === null, JSON.stringify(await cacheOf('1:0')));
  }

  // ── 5. 静态：调用点覆盖面 ───────────────────────────────────────────────────
  console.log('\n[N5] 静态钉子：判据挂在真输入的派发点上，且只挂在真输入上');
  {
    const sites = [...toolsSrcN.matchAll(/await guardInputVisibility\(tabId, \{ action: '([^']+)'/g)].map((m) => m[1]);
    ok('覆盖 9 类真输入通路（click×2 / hover / fill 坐标 / fill_form 坐标 / type / press_key / scroll wheel / drag / form.set 物理点击）',
      ['click', 'hover', 'fill', 'fill_form', 'type', 'press_key', 'scroll', 'drag', 'form.set'].every((a) => sites.includes(a)),
      sites.join(','));
    ok('click 的两个派发点（坐标 + ref）都挂了', sites.filter((a) => a === 'click').length === 2, sites.join(','));
    ok('桥通路（selector/@d）与主文档 setter 没有挂判据：出路③必须真的能走',
      !/guardInputVisibility[\s\S]{0,120}clickDom/.test(toolsSrcN) && !/guardInputVisibility\(tabId, \{ action: 'select_option'/.test(toolsSrcN),
      '(bridge paths unguarded)');
    ok('判据在 withPass 之前（源码顺序：guardInputVisibility 早于同分支的 withPass）',
      toolsSrcN.indexOf('await guardInputVisibility(tabId, { action: \'click\', ref: p.ref') <
        toolsSrcN.indexOf("R('hover'"),
      '(ordering)');
    ok('隐藏态的红复用既有错误码，不新增第四态（INPUT_NOT_DELIVERED 的 code 唯一）',
      /throw err\(\n?\s*'INPUT_NOT_DELIVERED',\s*\n?\s*hiddenInputMessage/.test(toolsSrcN), '(same code)');
  }

  chrome.scripting = prevScripting;
  chrome.tabs.sendMessage = prevSend;
  cdpMod.cdp.send = prevCdpSend;
  chrome.tabs.get = prevTabsGet;
  queue.cancel();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
