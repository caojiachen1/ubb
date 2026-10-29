// Thin wrapper over the content-script bridge (content/bridge.js):
// text extraction, React-safe form fill, element search, DOM-fallback tree —
// and since Wave 2-D, iframe-scoped calls: every op is ROUTED, never
// broadcast. chrome.tabs.sendMessage without a frameId delivers to EVERY frame
// that has a listener, so once bridge.js runs all_frames an implicit send
// would run fillDom/recordStart N times. frameId is always explicit here
// (extension-frameId namespace: 0 = main frame, ids from webNavigation /
// MessageSender.frameId — NOT CDP frameIds).

// a navigation tearing the content-script context down mid-op resolves the
// sendMessage with undefined (empty error) — read-only ops settle on the new
// document within ~300ms, so retry those once; mutating ops must NEVER be
// retried here (the first attempt may have landed → double action)
const RETRYABLE_OPS = new Set(['getPageText', 'getDomTree', 'search', 'extractData', 'extractSite', 'visible', 'roleOf', 'recordStatus', 'selfInfo', 'childFrameBoxes', 'describeRef']);

// A content script whose document is wedged (a blocking JS dialog, a frozen
// frame after an OOPIF interaction — LIVE-RESULTS §2 last row) never answers
// chrome.tabs.sendMessage. Without a ceiling every bridge call on that tab
// burned the full 40s TOOL_TIMEOUT, forever, and one dead frame made the whole
// tab unreadable. Two layers fix it: a bounded wait per call, then a
// per-(tab,frame) cooldown so the next caller fails fast instead of re-paying
// the wait. The cooldown is keyed by FRAME — frame-level accounting is what the
// code can guarantee; whether a wedged frame also jams the tab-level channel
// for sibling frames is a live-browser property (LIVE-RESULTS-2 §W saw frame
// 200 jam too). The cooldown therefore costs a PROVE-LIVENESS probe per call,
// not a blind wait, so even a tab-wide jam answers in ~1s per frame instead of
// 30s, and a healed frame is back without a navigation.
const BRIDGE_TIMEOUT_MS = 12_000;
const BRIDGE_HEAVY_TIMEOUT_MS = 30_000;
const HEAVY_OPS = new Set(['getPageText', 'getDomTree', 'extractData', 'extractSite', 'search']);
// 5s never fired in practice (LIVE-RESULTS-2 §W): a caller that just burned
// the FULL 30s budget only comes back after those 5s have already elapsed,
// so BRIDGE_WEDGED stayed invisible. 30s covers sequential callers; recovery
// is probe-verified, so a long window costs nothing when the frame is alive.
const WEDGE_COOLDOWN_MS = 30_000;
const WEDGE_PROBE_TIMEOUT_MS = 800;
const wedged = new Map(); // `tabId:frameId` → epoch ms until which calls probe first

export function bridgeWedgeOf(tabId, frameId = 0) {
  return Math.max(0, (wedged.get(`${tabId}:${frameId}`) || 0) - Date.now());
}

/** A committed document is a fresh chance: drop its cooldown (background.js calls
 *  this from webNavigation), and drop the whole tab when the tab goes away. */
export function clearBridgeWedge(tabId, frameId) {
  if (frameId == null) {
    for (const k of [...wedged.keys()]) if (k.startsWith(`${tabId}:`)) wedged.delete(k);
    return;
  }
  wedged.delete(`${tabId}:${frameId}`);
}

function settle(promise, ms) {
  return new Promise((resolve) => {
    let done = false;
    const t = setTimeout(() => {
      if (done) return;
      done = true;
      resolve({ status: 'timeout' });
    }, ms);
    Promise.resolve(promise).then(
      (value) => {
        if (done) return;
        done = true;
        clearTimeout(t);
        resolve({ status: 'ok', value });
      },
      (e) => {
        if (done) return;
        done = true;
        clearTimeout(t);
        resolve({ status: 'error', error: e });
      },
    );
  });
}

export async function bridgeEnvelope(tabId, op, args = {}, frameId = 0) {
  const key = `${tabId}:${frameId}`;
  if (bridgeWedgeOf(tabId, frameId) > 0) {
    // This frame hung on its previous call. Do not re-pay the full budget and
    // do not trust the clock either: the cheapest addressed op proves whether
    // the frame answers TODAY. Wedged → sub-second BRIDGE_WEDGED with the
    // cooldown re-armed; answering → the wedge is dropped and this call runs
    // for real (no navigation required — dialog.handle alone recovers it).
    const probe = await settle(chrome.tabs.sendMessage(tabId, { type: 'UBB_BRIDGE', op: 'selfInfo', args: {} }, { frameId }), WEDGE_PROBE_TIMEOUT_MS);
    if (probe.status === 'timeout') {
      wedged.set(key, Date.now() + WEDGE_COOLDOWN_MS);
      throw {
        code: 'BRIDGE_WEDGED',
        message:
          `frame ${frameId} of tab ${tabId} is on bridge-wedge cooldown (it hung on a previous call) and its ${WEDGE_PROBE_TIMEOUT_MS}ms liveness probe got no answer, ` +
          `so this call was skipped instead of burning another full budget — the cooldown holds per (tab,frame) and re-arms on every failed probe. Next: ` +
          `dialog.handle {"tab_id":${tabId}} to dismiss a blocking JS dialog, else reload/navigate that frame; frames of this tab that answer their own probes keep working.`,
      };
    }
    wedged.delete(key); // healed (or answered with an error — the real call below decides honestly)
    if (probe.status === 'error') {
      const pmsg = String(probe.error?.message || probe.error);
      if (/could not establish connection|Receiving end does not exist/i.test(pmsg)) {
        const e = new Error('BRIDGE_UNREACHABLE');
        e.frameId = frameId;
        throw e;
      }
    }
  }
  const budget = HEAVY_OPS.has(op) ? BRIDGE_HEAVY_TIMEOUT_MS : BRIDGE_TIMEOUT_MS;
  for (let attempt = 0; ; attempt++) {
    const sent = await settle(chrome.tabs.sendMessage(tabId, { type: 'UBB_BRIDGE', op, args }, { frameId }), budget);
    if (sent.status === 'timeout') {
      wedged.set(key, Date.now() + WEDGE_COOLDOWN_MS);
      throw {
        code: 'BRIDGE_TIMEOUT',
        message:
          `frame ${frameId} of tab ${tabId} did not answer bridge op "${op}" within ${budget}ms — its content script is wedged ` +
          `(a blocking JS dialog or a frozen frame is the usual cause), so no tool result is being faked. This (tab,frame) is now on a ${WEDGE_COOLDOWN_MS / 1000}s cooldown: ` +
          `the next call pays only a ${WEDGE_PROBE_TIMEOUT_MS}ms liveness probe (sub-second BRIDGE_WEDGED while it stays frozen, runs for real as soon as it answers). Next: ` +
          `dialog.handle {"tab_id":${tabId}} to dismiss a dialog, or ubb reload / navigate that tab;`,
      };
    }
    if (sent.status === 'error') {
      const msg = String(sent.error?.message || sent.error);
      if (/could not establish connection|Receiving end does not exist/i.test(msg)) {
        const err = new Error('BRIDGE_UNREACHABLE');
        err.frameId = frameId;
        throw err;
      }
      throw sent.error;
    }
    const r = sent.value;
    if (r && r.ok) return r; // {ok, result, frameId (sender echo), docEpoch}
    const msg = r?.error || `bridge op "${op}" failed`;
    if (attempt === 0 && RETRYABLE_OPS.has(op) && /bridge op ".*" failed$|^$/.test(String(msg))) {
      await new Promise((res) => setTimeout(res, 300));
      continue;
    }
    throw new Error(msg);
  }
}

/** Default frameId=0 keeps every pre-Wave-2 call site main-frame-only. */
export async function bridge(tabId, op, args = {}, frameId = 0) {
  // Site rules are data shipped in content/site-rules.json + user overrides in
  // chrome.storage.local, resolved SW-side (a content script cannot fetch its own
  // packaged resource without web_accessible_resources). lib/bridge-ctl is the one
  // choke point every read_site goes through, so we auto-attach the cached set here
  // and tools.js/read_site never change. Absent cache → the bridge uses its own
  // built-in constant (still correct for the shipped sites), so timing can't break it.
  let a = args;
  if (op === 'extractSite' && a && a.rules == null) {
    const rules = await ensureSiteRules();
    if (rules && rules.length) a = { ...a, rules };
  }
  const r = await bridgeEnvelope(tabId, op, a, frameId);
  return r.result;
}

// ---- site-rules cache (SW context; the only place that may touch fetch/chrome.storage)
// The provider (installed by lib/tools-sites.js) resolves the effective ordered list:
// user overrides first, then builtins not shadowed by id — so a user rule wins over a
// builtin with the same id, exactly like extractSite's own [userSiteRules, bundled].
let siteRulesCache = null;
let siteRulesProvider = null;
let siteRulesInflight = null;

export function setSiteRulesProvider(fn) {
  siteRulesProvider = typeof fn === 'function' ? fn : null;
}

export function setSiteRulesCache(list) {
  siteRulesCache = Array.isArray(list) ? list : null;
}

export function getSiteRulesCache() {
  return siteRulesCache;
}

// site.rules.reload calls this: the next extractSite re-runs the provider, so a
// freshly stored override or a re-fetched packaged file lands without an extension reload.
export function invalidateSiteRules() {
  siteRulesCache = null;
  siteRulesInflight = null;
}

async function ensureSiteRules() {
  if (siteRulesCache != null) return siteRulesCache;
  if (!siteRulesProvider) return null;
  if (!siteRulesInflight) {
    siteRulesInflight = Promise.resolve()
      .then(siteRulesProvider)
      .then((list) => {
        siteRulesCache = Array.isArray(list) ? list : null;
        return siteRulesCache;
      })
      .catch(() => {
        siteRulesCache = null;
        return null;
      })
      .finally(() => {
        siteRulesInflight = null;
      });
  }
  return siteRulesInflight;
}
