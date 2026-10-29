// Wave 1-C offline checks (contract §6.2/§6.3/§6.4): registry, audit ring,
// download ledger and the liveview handler — no browser, no daemon, no real port.
//
//   node daemon/test-downloads.mjs
//
// Reverse controls (contract §6.3 + AGENT-CONTRACT §0 — the clone lives OUTSIDE
// the repo, the repo root IS the extension root and a `_` entry breaks loading):
//   RC-fix12-1 拆掉显式 tab_id 透传:
//     node D:/Codebase/ubb-scratch/rc/fix12/make-rc-1.cjs   # writes a patched copy of
//     #   lib/tools.js with the downloadLedger.claim(id, tabId) line REMOVED and every
//     #   relative import rewritten to file:///D:/Codebase/ubb/lib/... so the shared
//     #   singletons (tools-downloads/actions/audit/tabs) stay the ones under test
//     node daemon/test-downloads.mjs --tools D:/Codebase/ubb-scratch/rc/fix12/rc-1/tools.js
//     → the fix12-F1 explicit-tab assertions MUST go red (a tab_id query is empty again).

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { installChromeStub } from '../lib/testharness.mjs';
import { AuditRing, audit } from '../lib/audit.js';
import { downloadLedger, isTextish, attributeTab } from '../lib/tools-downloads.js';
import { sessions } from '../lib/tabs.js';
import { makeHandler, LIVEVIEW_BIND, DEFAULT_VIEW_PORT, FRAME_FILE } from './cli/liveview.mjs';
import { CLI_COMMANDS } from './cli/index.mjs';
import { TOOLS as MCP_TOOLS } from './mcp-tools/index.mjs';

const optOf = (flag) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? path.resolve(process.argv[i + 1]) : null;
};
const TOOLS_PATH = optOf('--tools') || path.resolve('lib/tools.js');
if (optOf('--tools')) console.log(`\n[REVERSE CONTROL → tools=${TOOLS_PATH}]`);
const url = (rel) => pathToFileURL(path.resolve('lib', rel)).href;

installChromeStub();
const { registerTools } = await import(pathToFileURL(TOOLS_PATH).href);
const { registerExtras } = await import(url('tools-extra.js'));
const tools = new Map();
const dispatcher = { register: (name, meta, fn) => tools.set(name, { meta, fn }) };
registerTools(dispatcher);
registerExtras(dispatcher);
const names = [...tools.keys()];
const metas = Object.fromEntries([...tools].map(([n, e]) => [n, e.meta]));
const call = (name, params = {}) => tools.get(name).fn(params);

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
const throws = async (fn) => {
  try {
    await fn();
    return null;
  } catch (e) {
    return e;
  }
};

// ---------------------------------------------------------------- C1 registry
const EXPECTED = ['download.list', 'download.wait', 'download.path', 'download.status', 'audit.tail', 'audit.stats'];
ok(`all 1-C tools registered (${EXPECTED.join(', ')})`, EXPECTED.every((n) => names.includes(n)),
  EXPECTED.filter((n) => !names.includes(n)).join(', '));
const incomplete = EXPECTED.filter((n) => !metas[n] || !metas[n].category || !metas[n].description);
ok('each has category + description', incomplete.length === 0, incomplete.join(', '));
ok('all 1-C tools are category diagnostics', EXPECTED.every((n) => metas[n].category === 'diagnostics'),
  EXPECTED.map((n) => `${n}:${metas[n].category}`).join(', '));
// download.read is intentionally absent: a service worker cannot read local files
ok('download.read is NOT registered (extension-side fs is impossible)', !names.includes('download.read'));
// lib/tools.js still carries the pre-Wave download.status; registerExtras runs
// after registerTools, so the tools-downloads superset must be the one that wins.
ok('download.status resolves to the tools-downloads superset (Map.set winner)',
  /superset/i.test(metas['download.status']?.description || ''), JSON.stringify(metas['download.status']?.description));
ok('download.status description names the legacy fields it must keep',
  ['state', 'bytes_received', 'total', 'paused', 'url'].every((f) => (metas['download.status']?.description || '').includes(f)),
  metas['download.status']?.description);

// ---------------------------------------------------------------- C2 audit ring
const ring = new AuditRing();
for (let i = 1; i <= 600; i++) {
  ring.log({ action: i % 2 ? 'click' : 'navigate', ok: i % 7 !== 0, ms: i % 7 === 0 ? 900 : 10, tab_id: 1 });
}
ok('ring caps at 500 entries', ring.entries.length === 500, `got ${ring.entries.length}`);
ok('seq keeps counting past the cap', ring.seq === 600, `got ${ring.seq}`);
ok('seq is strictly monotonic in the ring', ring.entries.every((e, i) => e.seq === 101 + i),
  `first=${ring.entries[0]?.seq} last=${ring.entries[499]?.seq}`);
ok('list() keeps the newest-first contract', ring.list(3).length === 3 && ring.list(3)[0].seq === 600);
const tail = ring.listSince(590);
ok('listSince(590) returns only the 10 newer entries', tail.length === 10 && tail[0].seq === 591 && tail[9].seq === 600,
  JSON.stringify(tail.map((e) => e.seq)));
ok('listSince(0) returns the surviving ring from seq 101',
  ring.listSince(0).length === 200 && ring.listSince(0, 500).length === 500 && ring.listSince(0, 500)[0].seq === 101,
  `${ring.listSince(0).length}/${ring.listSince(0, 500).length} first=${ring.listSince(0, 500)[0]?.seq}`);
ok('listSince honours limit', ring.listSince(0, 7).length === 7);
ok('minSeq reports eviction (101)', ring.minSeq() === 101, `got ${ring.minSeq()}`);

const st = ring.stats();
const byName = Object.fromEntries(st.tools.map((t) => [t.tool, t]));
ok('stats: window defaults to the recent days kept', st.window_days === 1 && st.days.length === 1, JSON.stringify(st.days));
ok('stats: click calls counted (dispatcher entries only)', byName.click.calls === 300, JSON.stringify(byName.click));
ok('stats: click errors = 43', byName.click.errors === 43, JSON.stringify(byName.click));
ok('stats: navigate errors = 42', byName.navigate.errors === 42, JSON.stringify(byName.navigate));
ok('stats: total_ms = 43*900 + 257*10', byName.click.total_ms === 43 * 900 + 257 * 10, String(byName.click.total_ms));
ok('stats: max_ms = 900', byName.click.max_ms === 900, String(byName.click.max_ms));
ok('stats: avg_ms derived', byName.click.avg_ms === Math.round((41270 / 300) * 10) / 10, String(byName.click.avg_ms));
ok('stats: totals sum both tools', st.totals.calls === 600 && st.totals.errors === 85, JSON.stringify(st.totals));
ring.log({ action: 'manual_site', tab_id: 1 }); // no ok field → must not touch counters
ok('stats: manual audit.log() sites are not double-counted', ring.stats().totals.calls === 600, JSON.stringify(ring.stats().totals));
ok('stats: window=all works', ring.stats('all').window_days === 'all');

// the same singleton the tools read, driven through the tool surface
audit.log({ action: 'download.list', ok: true, ms: 4 });
audit.log({ action: 'download.list', ok: false, ms: 1200, error: 'NOT_FOUND' });
audit.log({ action: 'fill', ok: true, ms: 3, token: 'hunter2' });
const t1 = await call('audit.tail', {});
ok('audit.tail returns ring entries oldest-first with a cursor',
  t1.count >= 3 && t1.entries[0].seq <= t1.last_seq && t1.entries[t1.entries.length - 1].seq === t1.last_seq,
  JSON.stringify({ count: t1.count, last: t1.last_seq }));
const t2 = await call('audit.tail', { since_seq: t1.last_seq });
ok('audit.tail since_seq advances the cursor', t2.count === 0 && t2.last_seq === t1.last_seq, JSON.stringify(t2));
ok('audit.tail passes entries through redact()',
  !JSON.stringify(t1).includes('hunter2') && JSON.stringify(t1).includes('[redacted]'), JSON.stringify(t1.entries));
const s2 = await call('audit.stats', { window: 'all' });
const dl = s2.tools.find((t) => t.tool === 'download.list');
ok('audit.stats surfaces per-tool errors/timing', dl && dl.calls === 2 && dl.errors === 1 && dl.max_ms === 1200, JSON.stringify(dl));

// ---------------------------------------------------------------- C1 download ledger
const chromeStub = globalThis.chrome;
const store = new Map();
chromeStub.downloads.search = async (q = {}) =>
  q.id != null ? (store.has(q.id) ? [store.get(q.id)] : []) : [...store.values()];

const events = [];
downloadLedger.setEmitter((event, params) => events.push({ event, params }));
store.set(11, {
  id: 11,
  url: 'https://files.example.com/report.csv?token=supersecret',
  filename: 'C:\\Users\\me\\Downloads\\report.csv',
  state: 'in_progress',
  bytesReceived: 10,
  totalBytes: 100,
  mime: 'text/csv',
  tabId: 7,
  startTime: '2026-10-28T01:00:00.000Z',
});
store.set(12, {
  id: 12,
  url: 'blob:https://app.example.com/xyz',
  filename: 'C:\\Users\\me\\Downloads\\blob.bin',
  state: 'in_progress',
  bytesReceived: 1,
  totalBytes: 500,
  mime: 'application/octet-stream',
  tabId: 7,
  startTime: '2026-10-28T01:00:01.000Z',
});
downloadLedger.created(store.get(11));
downloadLedger.created(store.get(12));
Object.assign(store.get(11), { state: 'complete', bytesReceived: 100 });
await downloadLedger.changed({ id: 11, state: { previous: 'in_progress', current: 'complete' }, bytesReceived: { current: 100 } });
Object.assign(store.get(12), { state: 'interrupted', error: 'NETWORK_DISCONNECTED' });
await downloadLedger.changed({ id: 12, state: { previous: 'in_progress', current: 'interrupted' }, error: { current: 'NETWORK_DISCONNECTED' } });

ok('ledger emits download.started / completed / failed',
  events.map((e) => e.event).join(',') === 'download.started,download.started,download.completed,download.failed',
  JSON.stringify(events.map((e) => e.event)));
ok('event payload keeps basename only (no full path in the conversation)',
  events.every((e) => ['report.csv', 'blob.bin'].includes(e.params.filename)) && !JSON.stringify(events).includes('Users'),
  JSON.stringify(events[0].params));
ok('download.failed carries the chrome error string', events[3]?.params?.error === 'NETWORK_DISCONNECTED', JSON.stringify(events[3]));
ok('download.completed exposes redacted url + bytes', events[2]?.params?.bytes_received === 100 && events[2]?.params?.url?.includes('supersecret') === false,
  JSON.stringify(events[2]?.params));

const list1 = await call('download.list', {});
const rep = list1.downloads.find((d) => d.id === 11);
ok('download.list returns recorded items newest-first with an absolute path',
  list1.downloads[0].id === 12 && rep?.path === 'C:\\Users\\me\\Downloads\\report.csv' && rep?.state === 'complete',
  JSON.stringify(list1));
ok('download.list url went through redactUrl', /token=%5Bredacted%5D|token=\[redacted\]/.test(rep.url), rep.url);
ok('download.list tab_id filters without stealing the session tab',
  (await call('download.list', { tab_id: 7 })).count === 2 && (await call('download.list', { tab_id: 404 })).count === 0);

// ------------------------------------------------ fix7dl-1: merged providers, live 7c
// LIVE-RESULTS-2B 7c: without tab_id → {count:2, source:"ledger"}; with tab_id →
// {count:0, source:"chrome.downloads"} — the ledger was dropped and the browser
// query answered nothing. Same fixture shape here: a fresh download in a real tab
// plus browser history the ledger never saw.
store.set(20, {
  id: 20, url: 'https://files.example.com/live.csv', filename: 'E:\\report (1).csv', state: 'complete',
  bytesReceived: 132, totalBytes: 132, mime: 'text/csv', tabId: 888, startTime: '2026-10-28T01:00:02.000Z',
});
downloadLedger.created(store.get(20));
store.set(21, {
  id: 21, url: 'https://files.example.com/older.csv', filename: 'E:\\older.csv', state: 'complete',
  bytesReceived: 9, totalBytes: 9, mime: 'text/csv', tabId: 888, startTime: '2026-10-28T01:00:03.000Z',
});
const mergedTab = await call('download.list', { tab_id: 888 });
ok('fix7dl-1: a tab_id query still sees the download that just happened in that tab (live said count:0)',
  mergedTab.count === 2 && mergedTab.downloads.map((d) => d.id).sort().join(',') === '20,21',
  JSON.stringify(mergedTab));
ok('fix7dl-1: a tab_id query never swaps the provider out from under the ledger',
  /ledger/.test(mergedTab.source) && mergedTab.source !== 'chrome.downloads', mergedTab.source);
ok('fix7dl-1: the tab query keeps the absolute path + text gate fields of both providers',
  mergedTab.downloads.every((d) => typeof d.path === 'string' && d.text_readable === true), JSON.stringify(mergedTab.downloads.map((d) => [d.id, d.path])));
ok('fix7dl-1: tab_id and no-tab_id agree that the record is there',
  (await call('download.list', {})).downloads.some((d) => d.id === 20) && mergedTab.downloads.some((d) => d.id === 20));
const mergedAll = await call('download.list', { limit: 200 });
ok('fix7dl-1: merged output is deduped by download id (each id exactly once)',
  new Set(mergedAll.downloads.map((d) => d.id)).size === mergedAll.count && mergedAll.count > 3,
  `${mergedAll.count} rows / ${new Set(mergedAll.downloads.map((d) => d.id)).size} unique`);
ok('fix7dl-1: the ledger wins on a shared id (its richer tab_id/path survives the merge)',
  (() => {
    const d20 = mergedAll.downloads.find((x) => x.id === 20);
    return d20 && d20.tab_id === 888 && d20.path === 'E:\\report (1).csv';
  })(), JSON.stringify(mergedAll.downloads.find((x) => x.id === 20)));
ok('fix7dl-1: newest-first ordering survives the merge',
  mergedAll.downloads.every((d, i, a) => i === 0 || a[i - 1].id >= d.id || a[i - 1].start_time >= d.start_time),
  JSON.stringify(mergedAll.downloads.slice(0, 4).map((d) => d.id)));

// the download tool starts downloads with no originating tab (tabId -1): the real
// reason a tab-scoped query came back empty. count:0 is allowed to stay 0, but it
// must never come back bare.
store.set(22, {
  id: 22, url: 'https://files.example.com/tool.bin', filename: 'E:\\big (2).bin', state: 'complete',
  bytesReceived: 5, totalBytes: 5, mime: 'application/octet-stream', tabId: -1, startTime: '2026-10-28T01:00:04.000Z',
});
downloadLedger.created(store.get(22));
const noTabMatch = await call('download.list', { tab_id: 950659450 });
ok('fix7dl-1: an empty tab_id answer names BOTH sources it queried',
  noTabMatch.count === 0 && /ledger/.test(noTabMatch.note || '') && /chrome\.downloads/.test(noTabMatch.note || ''),
  JSON.stringify(noTabMatch));
// the old wording promised "tab_id filters both of them" and explained a zero with
// "the download tool has no originating tab (tabId:-1)". Since fix12 an unattributed
// record is tab_id:null with a reason, so the answer must show the MIX instead.
ok('fix12-F1: the zero answer says how many records are reachable by tab at all',
  /retry without tab_id/.test(noTabMatch.note || '') &&
    /explicit=\d+ heuristic=\d+ none=\d+/.test(noTabMatch.note || ''), String(noTabMatch.note));
ok('fix12-F1: and it names the browser-side evidence instead of a guess',
  /onCreated items seen: \d+.*tabId present: \d+/s.test(noTabMatch.note || '') && /deltas carrying tabId: \d+/.test(noTabMatch.note || ''),
  String(noTabMatch.note));
{
  const probe = await call('download.list', { limit: 200 });
  const want = { explicit: 0, heuristic: 0, none: 0 };
  for (const r of downloadLedger.items) want[r.tab_id_source === 'heuristic' || r.tab_id_source === 'explicit' ? r.tab_id_source : 'none'] += 1;
  ok('fix12-F1: every row carries tab_id AND a tab_id_source, never a silent null',
    probe.downloads.every((d) => 'tab_id' in d && ['explicit', 'heuristic', 'none'].includes(d.tab_id_source)),
    JSON.stringify(probe.downloads.slice(0, 3).map((d) => [d.id, d.tab_id, d.tab_id_source])));
  ok('fix12-F1: the published attribution mix is the ledger\'s own count (not a per-page slice)',
    JSON.stringify(probe.tab_attribution) === JSON.stringify(want), `${JSON.stringify(probe.tab_attribution)} vs ${JSON.stringify(want)}`);
  ok('fix12-F1: an empty tab_id answer still carries the mix + the evidence (never a bare count:0)',
    noTabMatch.count === 0 && noTabMatch.tab_attribution && /none=\d/.test(noTabMatch.note) && noTabMatch.browser_signals.items >= 1,
    JSON.stringify({ t: noTabMatch.tab_attribution, s: noTabMatch.browser_signals }));
}
ok('fix12-F1: download.list no longer promises that tab_id filters everything',
  !/filters both of them/i.test(metas['download.list'].description) &&
    /tab_id_source/.test(metas['download.list'].description) && /null/i.test(metas['download.list'].description),
  metas['download.list'].description);
ok('fix7dl-1: the empty answer does not claim a single provider',
  noTabMatch.source === 'ledger+chrome.downloads', noTabMatch.source);
ok('fix7dl-1: the same record is visible the moment the tab filter is dropped',
  (await call('download.list', {})).downloads.some((d) => d.id === 22));
{
  // in-suite negative control: the pre-fix provider-swap logic over this fixture
  const preFix = (tabId) => {
    const items = downloadLedger.list({ tab_id: tabId, limit: 50 });
    if (items.length) return { count: items.length, source: 'ledger', note: undefined };
    const all = [...store.values()].filter((d) => d.tabId === tabId);
    return { count: all.length, source: 'chrome.downloads', note: undefined };
  };
  const old = preFix(950659450);
  ok('fix7dl-1 RC: the OLD code answers the live query with a bare count:0 and a provider flip',
    old.count === 0 && old.source === 'chrome.downloads' && old.note === undefined, JSON.stringify(old));
  ok('fix7dl-1 RC: the NEW answer to the same query is 0 WITH an explanation',
    noTabMatch.count === 0 && !!noTabMatch.note && noTabMatch.source !== 'chrome.downloads');
}

ok('download.* needs no session (blob downloads show up after a plain click)',
  sessions.active() === null && (await call('download.path', { download_id: 11 })).ready === true);

// ---------------------------------------------------------------- fix12-F1
// LIVE-RESULTS-3B §3b: 4 downloads from 4 different trigger paths, every recorded
// tab_id was null, so a tab_id query could NEVER return one — while the tool
// description promised "tab_id filters both of them". Three sources now:
//   explicit  — the download tool's own targetTab (and any tabId chrome really reports)
//   heuristic — one tab whose recorded action + document origin explain the item
//   none      — nothing explains it: tab_id stays null and the record says why
const realActive = sessions.active;
sessions.active = () => ({ id: 'fix12', lastTabId: 950659512, touch: () => {}, created: new Set([950659512]), claimed: new Set() });
sessions.owns = () => true;
let nextDlId = 600;
const createdItems = [];
chrome.downloads.download = async () => {
  nextDlId += 1;
  // exactly what the browser answers on the wire: an id here, and LATER an
  // onCreated DownloadItem with no tabId field at all
  setTimeout(() => downloadLedger.created({ id: nextDlId, url: 'https://files.example.com/mine.csv', filename: 'E:\\mine.csv', state: 'complete', bytesReceived: 9, totalBytes: 9, mime: 'text/csv' }), 0);
  return nextDlId;
};
{
  const r = await call('download', { tab_id: 950659512, url: 'https://files.example.com/mine.csv' });
  ok('fix12-F1 ①: the download tool reports the tab it targeted',
    r.tab_id === 950659512 && r.tab_id_source === 'explicit', JSON.stringify(r));
  await new Promise((res) => setTimeout(res, 5));
  await downloadLedger.settled();
  const rec = downloadLedger.get(nextDlId);
  ok('①: the claim survives the tabId-less DownloadItem that arrives afterwards',
    rec && rec.tab_id === 950659512 && rec.tab_id_source === 'explicit', JSON.stringify(rec && [rec.tab_id, rec.tab_id_source]));
  const byTab = await call('download.list', { tab_id: 950659512 });
  ok('①: a tab_id query DOES return our own download (live said count:0 forever)',
    byTab.count === 1 && byTab.downloads[0]?.id === nextDlId && byTab.downloads[0]?.tab_id_source === 'explicit', JSON.stringify(byTab));
  ok('①: and the answer names the reason, not just the id',
    /targetTab|download tool/i.test(byTab.downloads[0]?.tab_id_why || ''), byTab.downloads[0]?.tab_id_why);
  // onCreated BEFORE the claim (the other ordering the API allows)
  downloadLedger.created({ id: 611, url: 'https://files.example.com/pre.csv', filename: 'E:\\pre.csv', state: 'complete', bytesReceived: 1, totalBytes: 1, mime: 'text/csv' });
  await downloadLedger.settled();
  downloadLedger.claim(611, 950659513);
  ok('①: a claim that lands after onCreated still writes the record',
    downloadLedger.get(611).tab_id === 950659513 && downloadLedger.get(611).tab_id_source === 'explicit', JSON.stringify(downloadLedger.get(611)));
}

// ② the heuristic, as a pure function over a world the test supplies
const now = Date.now();
const iso = (msAgo) => new Date(now - msAgo).toISOString();
const realTabsGet = chrome.tabs.get;
const WORLD = { 701: 'https://shop.example/cart', 702: 'https://shop.example/other', 703: 'https://nope.example/x' };
chrome.tabs.get = async (id) => (WORLD[id] ? { id, url: WORLD[id] } : (() => { throw new Error('No tab with id: ' + id); })());
{
  const hit = await attributeTab({ url: 'https://cdn.example/f.zip', referrer: 'https://shop.example/cart' }, [
    { seq: 1, t: iso(3_000), action: 'click', tab_id: 701, ok: true },
  ]);
  ok('②: one tab with a recent action + the matching referrer origin ⇒ heuristic hit',
    hit.tab_id === 701 && hit.tab_id_source === 'heuristic' && /click/.test(hit.why) && /\b\d+ms ago\b/.test(hit.why), JSON.stringify(hit));
  const byUrl = await attributeTab({ url: 'https://shop.example/report.csv' }, [
    { seq: 1, t: iso(1_500), action: 'navigate', tab_id: 701, ok: true },
  ]);
  ok('②: a navigate-triggered download matches on the download url origin too',
    byUrl.tab_id === 701 && byUrl.tab_id_source === 'heuristic' && /url/.test(byUrl.why), JSON.stringify(byUrl));
  const amb = await attributeTab({ url: 'https://cdn.example/f.zip', referrer: 'https://shop.example/cart' }, [
    { seq: 1, t: iso(100), action: 'click', tab_id: 701, ok: true },
    { seq: 2, t: iso(200), action: 'click', tab_id: 702, ok: true },
  ]);
  ok('②: TWO tabs explain it ⇒ refuse (tab_id stays null) and say it is a coin flip',
    amb.tab_id === null && amb.tab_id_source === 'none' && /coin flip/.test(amb.why) && /701, 702/.test(amb.why), JSON.stringify(amb));
  const stale = await attributeTab({ url: 'https://cdn.example/f.zip', referrer: 'https://shop.example/cart' }, [
    { seq: 1, t: iso(60_000), action: 'click', tab_id: 701, ok: true },
  ]);
  ok('②: an action outside the window is not evidence', stale.tab_id === null && /no tab with a recorded action/.test(stale.why), JSON.stringify(stale));
  const readonly = await attributeTab({ url: 'https://cdn.example/f.zip', referrer: 'https://shop.example/cart' }, [
    { seq: 1, t: iso(100), action: 'read_page', tab_id: 701, ok: true },
    { seq: 2, t: iso(100), action: 'screenshot', tab_id: 701, ok: true },
  ]);
  ok('②: a read-only action cannot "start" a download, so it is not evidence',
    readonly.tab_id === null && readonly.tab_id_source === 'none', JSON.stringify(readonly));
  const wrong = await attributeTab({ url: 'https://cdn.example/f.zip', referrer: 'https://shop.example/cart' }, [
    { seq: 1, t: iso(100), action: 'click', tab_id: 703, ok: true },
  ]);
  ok('②: an action in a tab whose origin does not match is refused, not stretched',
    wrong.tab_id === null && /document origin matching/.test(wrong.why), JSON.stringify(wrong));
  const blobless = await attributeTab({ url: 'blob:https://app.example.com/xyz' }, [
    { seq: 1, t: iso(100), action: 'click', tab_id: 701, ok: true },
  ]);
  ok('②: a blob: url with no referrer is refused instead of guessed',
    blobless.tab_id === null && /no http\(s\) url or referrer/.test(blobless.why), JSON.stringify(blobless));

  // ② end-to-end through the ledger: an item with NO tabId + a real audit action
  audit.log({ action: 'click', ok: true, ms: 12, tab_id: 701 });
  downloadLedger.created({ id: 620, url: 'https://shop.example/report.csv', filename: 'E:\\r.csv', state: 'complete', bytesReceived: 1, totalBytes: 1, mime: 'text/csv', referrer: 'https://shop.example/cart' });
  await downloadLedger.settled();
  ok('②: onCreated with no tabId lands as a heuristic record with its evidence',
    downloadLedger.get(620).tab_id === 701 && downloadLedger.get(620).tab_id_source === 'heuristic',
    JSON.stringify(downloadLedger.get(620)));
  ok('②: a tab_id query now finds a download the agent never started itself',
    (await call('download.list', { tab_id: 701 })).downloads.some((d) => d.id === 620), JSON.stringify(await call('download.list', { tab_id: 701 })));

  // ③ nothing explains it
  downloadLedger.created({ id: 621, url: 'https://stranger.example/x.bin', filename: 'E:\\x.bin', state: 'complete', bytesReceived: 1, totalBytes: 1, mime: 'application/octet-stream' });
  await downloadLedger.settled();
  const none = downloadLedger.get(621);
  ok('③: an unexplainable download keeps tab_id:null — it is never given a tab',
    none.tab_id === null && none.tab_id_source === 'none', JSON.stringify([none.tab_id, none.tab_id_source]));
  ok('③: …and the record carries the reason in tab_id_why (a human/agent can read the no)',
    typeof none.tab_id_why === 'string' && none.tab_id_why.length > 20, String(none.tab_id_why));
  const noneRow = (await call('download.list', { limit: 200 })).downloads.find((d) => d.id === 621);
  ok('③: download.list surfaces that reason per row, not only in the zero-note',
    noneRow && noneRow.tab_id === null && noneRow.tab_id_source === 'none' && /origin/.test(noneRow.tab_id_why), JSON.stringify(noneRow));
  const unreachable = await call('download.list', { tab_id: 999999 });
  ok('③: a tab_id query that can only miss says WHY instead of a bare count:0',
    unreachable.count === 0 && /none=\d+/.test(unreachable.note) && /attributed/.test(unreachable.note), String(unreachable.note).slice(0, 200));
}
chrome.tabs.get = realTabsGet;
sessions.active = realActive;

// structural pins: the three sources must stay wired the way the description says
{
  const dlSrc = fs.readFileSync(path.resolve('lib/tools-downloads.js'), 'utf8');
  const toolsSrc = fs.readFileSync(TOOLS_PATH, 'utf8');
  const bgSrc = fs.readFileSync(path.resolve('background.js'), 'utf8');
  ok('fix12-F1: the download tool really hands its targetTab to the ledger',
    /downloadLedger\.claim\(id, tabId\)/.test(toolsSrc) && /tab_id_source: 'explicit'/.test(toolsSrc), '');
  ok('fix12-F1: the chrome provider is no longer filtered by a raw DownloadItem.tabId (that field does not exist)',
    !/d\.tabId === p\.tab_id/.test(dlSrc) && /tabId != null && d\.tabId >= 0/.test(dlSrc), '');
  ok('fix12-F1: -1 is never recorded as a tab id (it is chrome\'s "no originating tab")',
    /tab_id: rec\.tab_id \?\? null/.test(dlSrc) && !/tab_id: d\.tabId/.test(dlSrc), '');
  ok('fix12-F1: background.js still feeds onCreated straight into the ledger (attribution lives in the module, not the listener)',
    /chrome\.downloads\.onCreated\.addListener\(\(item\) => downloadLedger\.created\(item\)\)/.test(bgSrc), '');
  ok('fix12-F1: the heuristic reads the ACTION RING for recency instead of inventing a new tracker',
    /audit\.list\(200\)/.test(dlSrc) && /ATTR_WINDOW_MS/.test(dlSrc), '');
  ok('fix12-F1: the browser-supplied signals are COUNTED, so the description can be checked against a real machine',
    /with_tabid/.test(dlSrc) && /deltas_with_tabid/.test(dlSrc) && /browser_signals/.test(dlSrc), '');
}

const p1 = await call('download.path', { download_id: 11 });
ok('download.path is a superset: ready + path + mime + text_readable + hint',
  p1.ready === true && p1.path === rep.path && p1.mime === 'text/csv' && p1.text_readable === true && /terminal/.test(p1.hint),
  JSON.stringify(p1));
const p2 = await call('download.path', { download_id: 12 });
ok('download.path marks a binary as not-text and never returns content',
  p2.ready === false && p2.text_readable === false && p2.state === 'interrupted' && !('data_base64' in p2) && !/base64/.test(JSON.stringify(p2)),
  JSON.stringify(p2));
ok('isTextish: text/csv + json yes, png/octet no, extension fallback',
  isTextish('text/csv', 'a.csv') && isTextish('application/json', 'a.json') && !isTextish('image/png', 'a.png') &&
  !isTextish('application/octet-stream', 'a.zip') && isTextish('', 'notes.txt'));

const w1 = await call('download.wait', { download_id: 11 });
ok('download.wait returns the completed record', w1.done === true && w1.state === 'complete' && w1.bytes_received === 100 && w1.path === rep.path,
  JSON.stringify(w1));
store.set(13, { id: 13, url: 'https://files.example.com/big.png', filename: 'C:\\Users\\me\\Downloads\\big.png', state: 'in_progress', bytesReceived: 100, totalBytes: 900, mime: 'image/png', tabId: 7 });
const ePending = await throws(() => call('download.wait', { download_id: 13, timeout_ms: 700 }));
ok('download.wait times out with DOWNLOAD_PENDING + current state',
  ePending?.code === 'DOWNLOAD_PENDING' && ePending?.data?.state === 'in_progress', JSON.stringify(ePending));
const eNotFound = await throws(() => call('download.wait', { download_id: 987654, timeout_ms: 5000 }));
ok('download.wait on an unknown id says NOT_FOUND (not a hang)', eNotFound?.code === 'NOT_FOUND', JSON.stringify(eNotFound));
ok('download.wait without download_id says BAD_PARAMS', (await throws(() => call('download.wait', {})))?.code === 'BAD_PARAMS');
ok('download.path without download_id says BAD_PARAMS', (await throws(() => call('download.path', {})))?.code === 'BAD_PARAMS');

// ------------------------------------------------------- download.status (Wave 4a)
const s11 = await call('download.status', { download_id: 11 });
ok('download.status keeps the legacy field set verbatim (state/bytes_received/total/url)',
  s11.state === 'complete' && s11.bytes_received === 100 && s11.total === 100 && s11.total === s11.total_bytes && /^https:\/\//.test(s11.url),
  JSON.stringify(s11));
ok('download.status url is the redactUrl-ed one (no token in the answer)', !s11.url.includes('supersecret'), s11.url);
ok('download.status adds the superset fields (id/filename/path/mime/text_readable/ready)',
  s11.id === 11 && s11.filename === 'report.csv' && s11.path === rep.path && s11.mime === 'text/csv' &&
    s11.text_readable === true && s11.ready === true && /ubb download cat 11/.test(s11.hint),
  JSON.stringify(s11));
const s12 = await call('download.status', { download_id: 12 });
ok('download.status answers for an interrupted binary and points at error, never bytes',
  s12.state === 'interrupted' && s12.error === 'NETWORK_DISCONNECTED' && s12.ready === false &&
    s12.text_readable === false && !('data_base64' in s12) && !/base64/.test(JSON.stringify(s12)),
  JSON.stringify(s12));
store.set(14, {
  id: 14, url: 'https://files.example.com/p.log', filename: 'C:\\Users\\me\\Downloads\\p.log', state: 'in_progress',
  bytesReceived: 40, totalBytes: 900, mime: 'text/plain', paused: true, tabId: 7,
});
downloadLedger.created(store.get(14));
const s14 = await call('download.status', { download_id: 14 });
ok('download.status reports paused straight from the chrome item',
  s14.paused === true && s14.state === 'in_progress' && s14.bytes_received === 40 && s14.total === 900 && s14.ready === false,
  JSON.stringify(s14));
store.set(15, {
  id: 15, url: 'https://files.example.com/q.txt', filename: 'C:\\Users\\me\\Downloads\\q.txt', state: 'in_progress',
  bytesReceived: 1, totalBytes: 900, mime: 'text/plain', paused: false, tabId: 7,
});
downloadLedger.created(store.get(15));
const evBeforePause = events.length;
await downloadLedger.changed({ id: 15, paused: { previous: false, current: true } });
ok('an onChanged paused delta lands on the record', downloadLedger.get(15).paused === true);
Object.assign(store.get(15), { paused: true }); // a real delta means the browser item moved too
ok('download.status reports the paused delta', (await call('download.status', { download_id: 15 })).paused === true);
await downloadLedger.changed({ id: 15, paused: { previous: true, current: false } });
Object.assign(store.get(15), { paused: false });
ok('and resuming flips it back', (await call('download.status', { download_id: 15 })).paused === false);
ok('pause/resume is not a state change, so no extra download.* event fires', events.length === evBeforePause,
  `${events.length - evBeforePause} extra: ${JSON.stringify(events.slice(evBeforePause).map((e) => e.event))}`);
ok('download.status without download_id says BAD_PARAMS', (await throws(() => call('download.status', {})))?.code === 'BAD_PARAMS');
ok('download.status on an unknown id says NOT_FOUND', (await throws(() => call('download.status', { download_id: 987654 })))?.code === 'NOT_FOUND');
ok('download.status is session-free like the other download.* tools', sessions.active() === null);

for (let i = 100; i < 350; i++) {
  downloadLedger.created({ id: i, url: 'https://e.com/f', filename: `/d/${i}.bin`, state: 'complete', bytesReceived: 5, totalBytes: 5, tabId: 9 });
}
ok('download ring capped at 200', downloadLedger.items.length === 200 && downloadLedger.byId.size === 200,
  `${downloadLedger.items.length}/${downloadLedger.byId.size}`);

// ---------------------------------------------------------------- C3 liveview
ok(`liveview binds loopback only (${LIVEVIEW_BIND})`, LIVEVIEW_BIND === '127.0.0.1', LIVEVIEW_BIND);
ok('liveview default preview port is 8790', DEFAULT_VIEW_PORT === 8790, String(DEFAULT_VIEW_PORT));
ok('liveview frame lands under ~/.ubb/liveview/latest.jpg',
  FRAME_FILE.replace(/\\/g, '/').endsWith('/.ubb/liveview/latest.jpg') || FRAME_FILE.replace(/\\/g, '/').endsWith('liveview/latest.jpg'), FRAME_FILE);

const TOKEN = 'a'.repeat(32);
const state = {
  frame: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
  events: [{ method: 'event.download.completed', params: { id: 11 }, at: '2026-10-28T01:00:01.000Z' }],
  frames: 3,
  size: 4,
  startedAt: '2026-10-28T01:00:00.000Z',
};
const handle = makeHandler({ token: TOKEN, state });
const mockRes = () => {
  const res = { status: 0, headers: {}, body: null, writeHead(s, h) { res.status = s; res.headers = h || {}; }, end(b) { res.body = b; } };
  return res;
};
const fetch1 = (url, headers = {}) => {
  const res = mockRes();
  handle({ url, headers, method: 'GET', socket: { remoteAddress: '127.0.0.1' } }, res);
  return res;
};

ok('/frame.jpg without token → 403', fetch1('/frame.jpg').status === 403, String(fetch1('/frame.jpg').status));
ok('/events without token → 403', fetch1('/events').status === 403);
ok('/ without token → 403', fetch1('/').status === 403);
ok('/liveview.js without token → 403', fetch1('/liveview.js').status === 403);
ok('/frame.jpg with a wrong token → 403', fetch1(`/frame.jpg?token=${'b'.repeat(32)}`).status === 403);
const good = fetch1(`/frame.jpg?token=${TOKEN}`);
ok('/frame.jpg with token → 200 image/jpeg + bytes',
  good.status === 200 && good.headers['Content-Type'] === 'image/jpeg' && Buffer.isBuffer(good.body) && good.body.length === 4);
ok('every liveview response is Cache-Control: no-store',
  good.headers['Cache-Control'] === 'no-store' && fetch1('/frame.jpg').headers['Cache-Control'] === 'no-store', JSON.stringify(good.headers));
const ev = fetch1(`/events?token=${TOKEN}`);
ok('/events returns the recent agent events', ev.status === 200 && JSON.parse(ev.body).events[0].name === 'download.completed', String(ev.body).slice(0, 120));
const home = fetch1(`/?token=${TOKEN}`);
const html = home.body?.toString() || '';
ok('/ serves console/liveview.html with an external script only',
  home.status === 200 && html.includes('<script src="liveview.js">') && !/<script(?![^>]*src)/.test(html), String(home.status));
ok('/ sets a cookie so subresources stay authorized', String(home.headers['Set-Cookie'] || '').startsWith('ubb_liveview='), JSON.stringify(home.headers));
ok('cookie-only request is authorized', fetch1('/frame.jpg', { cookie: `ubb_liveview=${TOKEN}` }).status === 200);
ok('unknown path with a valid token → 404', fetch1(`/nope.jpg?token=${TOKEN}`).status === 404);

const noState = makeHandler({ token: TOKEN, state: { frame: null, events: [] } });
const r2 = mockRes();
noState({ url: `/frame.jpg?token=${TOKEN}`, headers: {}, socket: {} }, r2);
ok('/frame.jpg before the first frame → 404, not a crash', r2.status === 404);
const broken = makeHandler({ token: TOKEN, state, consoleDir: 'Z:\\no-such-dir' });
const r3 = mockRes();
broken({ url: `/?token=${TOKEN}`, headers: {}, socket: {} }, r3);
ok('missing console/ file → 500 instead of throwing', r3.status === 500);

// ---------------------------------------------------------------- wiring tables
const cliNames = CLI_COMMANDS.map((c) => c.name);
ok('ubb audit + ubb liveview + ubb download are in the CLI registry with help text',
  cliNames.includes('audit') && cliNames.includes('liveview') && cliNames.includes('download') && CLI_COMMANDS.every((c) => c.describe && typeof c.run === 'function'),
  JSON.stringify(cliNames));
const contributed = MCP_TOOLS.filter((t) => t.name.startsWith('ubb_download_') || t.name.startsWith('ubb_audit_'));
ok('mcp catalog exposes the five curated 1-C tools', contributed.length === 5, JSON.stringify(contributed.map((t) => t.name)));
ok('every curated ubb_* maps to a registered extension tool',
  contributed.every((t) => names.includes(t.ubb)), contributed.filter((t) => !names.includes(t.ubb)).map((t) => t.ubb).join(', '));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
