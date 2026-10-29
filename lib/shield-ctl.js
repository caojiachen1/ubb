// Shield controller: talks to content/shield.js.
// The shield = full-viewport pulsing highlight frame + input-blocking veil +
// status pill + Interrupt button (user requirement; hide-for-tool-use
// gating pattern, pulsing indicator visual language).

import { err } from './config.js';
import { audit } from './audit.js';

export const pendingConfirms = new Map(); // reqId → {resolve}
export const pendingHelp = new Map(); // reqId → {resolve(ok)}

const PASS_MSG_TIMEOUT_MS = 1200; // the frame's own ack
const PASS_DOM_TIMEOUT_MS = 2500; // chrome.scripting round trip
const PASS_RETRY_DELAY_MS = 150;
const PASS_TXN_TTL_MS = 45000; // ONE transaction's own deadline (never shared, renewed by each dispatch confirm)
const PASS_RELEASE_MS = 1500; // release is bounded… but the LEDGER, not the wire, is authoritative
// One action may not spend its whole tool budget on a gate that is not answering.
// LIVE-RESULTS-3A 8-4 burned secret.fill's entire 25s on exactly this. One failed
// round already costs a message timeout + two wedged DOM round trips, so the
// second round is only paid for when the first was FAST (that is the transient
// re-close the retry exists for); otherwise the refusal returns in seconds with
// the reason the last readback actually produced.
const PASS_CONFIRM_BUDGET_MS = 5000;

// ───────────────────────────── fix17 DELIVERY PROOF (see the delivery block)
// An ACK IS NOT A DELIVERY. CDP Input.dispatchMouseEvent returns as soon as the
// command is queued; on a document whose visibilityState is "hidden" (an Edge
// window behind another window — maximized and focused:true and still hidden,
// and tab.select cannot change it) the queued event reaches the document ~5
// SECONDS later. The old withPass() released the gate on the ack, so the veil
// was pointer-events:auto again by the time the event landed and the shield ate
// its own agent's input while the tool returned ok:true (LIVE-RESULTS-6: 20/20,
// 2/2 on the main line's own self-test). What closes the gap is not a better
// door judgement — the door was genuinely open — it is WAITING FOR THE
// DOCUMENT'S OWN RECORD of the event before closing the door, which both proves
// delivery and (because the door therefore stays open across the queue delay)
// makes the delivery land on the page instead of on the veil.
// COST, stated honestly: a visible tab pays milliseconds (the record is normally
// already there on the first poll). A hidden/occluded tab pays up to
// PASS_DELIVERY_BUDGET_MS per proven action, and PASS_DELIVERY_BUDGET_MS is
// deliberately above the ~5000ms the real browser was measured at.
const PASS_DELIVERY_PEEK_MS = 1200; // one read-only DOM round trip
const PASS_DELIVERY_POLL_MS = 250; // poll cadence while waiting for evidence
const PASS_DELIVERY_BUDGET_MS = 7000; // wait ceiling before refusing
const PASS_DELIVERY_RETRY_MS = 2000; // extra ceiling after a SAFE resend (moves only)
const PASS_DELIVERY_TOL_PX = 48; // how far a recorded point may sit from the dispatched one WHEN the record carries no box (a ring older than fix20)
// fix20 THE TOLERANCE, DEFINED: when the record carries the hit element's own box
// (field 10 of the ring line), the ONLY accepted shape is "the dispatch point lies
// inside that box, inflated by PASS_HIT_TOL_PX". N=2 is derived, not vibes: the
// page records Math.round(clientX) (≤0.5px), the caller dispatches a rounded
// centre of a fractional box (≤0.5px), and the box itself is floored/ceiled OUTWARD
// by the recorder (never shrinks); device-pixel quantisation at dpr≥1 adds ≤0.5px
// and one further 0.5px covers the fractional-centre the round-trip never sees.
// Worst documented real-world miss this catches: LIVE-RESULTS-6's dispatched point
// ~9px above the true button box — it now refuses instead of matching on tag-name.
const PASS_HIT_TOL_PX = 2;
const PASS_DELIVERY_MAX_FRAMES = 8; // PER ROUND TRIP (fix20): reads/installs fan out in chunks of this many frames over the WHOLE covered set — frame count no longer caps how far取证 reaches (residual #2)
const PASS_DELIVERY_ACTION = 'shield.delivery';

// fix16 judgement-path probe (see the probe block below). fix15's PASS_STATE_ASKS
// re-ask constant is GONE with the revert: an ack that delivered no state is
// reported, not re-asked and not refused — LIVE-RESULTS-5 proved that branch is
// unreachable on a real browser (manifest grants `scripting` ⇒ domPass() !== null),
// so the re-ask could only ever add latency to a path no live tab walks.

// ---------------------------------------------------------------- pass ledger
// tabId → Map<token, txn>, txn = {token, frameId, at, keys, frames:Set, deadline, timer}.
// fix1 confirmed the veil ONCE and then let three separate CDP Input.* commands
// go out; the two live-verification rounds proved that a confirmed gate can be
// re-closed in between — by this module's own delayed release (the old
// `capped(closePass, 800)` walked away and left the message + DOM write to land
// inside the NEXT action's dispatch window), by any other message that runs
// apply() (a re-arm from webNavigation/snapshot, a screenshot's UBB_VISIBLE), or
// simply by two overlapping transactions sharing one boolean per frame. All of
// those need exactly one thing to be harmless: the gate is a per-transaction
// token, and what any frame is told on the way out is the AGGREGATE over the
// ledger, never "my action finished".
const ledger = new Map();
const activeGate = new Map(); // tabId → gate, for assertInputGate()
let passSeq = 0;

function nextToken() {
  passSeq++;
  // unique per worker lifetime; the extension id keeps two copies of the
  // extension from ever sharing a token
  return `${extId() || 'ubb'}-${Date.now().toString(36)}-${passSeq}`;
}

function framePassOpen(tabId, frameId) {
  const byToken = ledger.get(tabId);
  if (!byToken) return false;
  for (const txn of byToken.values()) if (txn.frames.has(frameId)) return true;
  return false;
}

/** THE claim set for one frame: the pass tokens this service worker still holds
 *  open for that frame. It is what lets a DOM write tell "alive" apart from
 *  "claimed": a stamp whose issuer died (worker torn down, transaction forgotten
 *  on tab release) is alive by its own expiry yet nobody will ever release it, and
 *  that is exactly the token that left LIVE-RESULTS-3A 8-6's shield open over the
 *  user's page for 287 seconds. Every DOM channel call carries it, so a leaked
 *  stamp is erased by the next gate round instead of sitting there forever. */
function claimsFor(tabId, frameId) {
  const out = [];
  const byToken = ledger.get(tabId);
  if (byToken) for (const txn of byToken.values()) if (txn.frames.has(frameId)) out.push(txn.token);
  return out;
}

function registerTxn(tabId, txn) {
  if (!ledger.has(tabId)) ledger.set(tabId, new Map());
  ledger.get(tabId).set(txn.token, txn);
  armDeadline(tabId, txn);
  return txn;
}

/** A tool that dies mid-action must not leave the user's page un-shielded: the
 *  deadline belongs to the transaction, so it can never keep a LATER action's
 *  pass alive, and a wedged one cannot keep it alive past its own ttl either.
 *  The content script holds its own copy of this deadline, so the door also
 *  closes when the service worker itself is gone. */
function armDeadline(tabId, txn) {
  clearTimeout(txn.timer);
  const ttl = txn.ttl || PASS_TXN_TTL_MS;
  txn.deadline = Date.now() + ttl;
  txn.timer = setTimeout(() => {
    closeTxn(tabId, txn.token).catch(() => {});
  }, ttl);
}

function forgetTxn(tabId, token) {
  const byToken = ledger.get(tabId);
  const txn = byToken ? byToken.get(token) : null;
  if (txn) {
    clearTimeout(txn.timer);
    byToken.delete(token);
    if (!byToken.size) ledger.delete(tabId);
  }
  return txn || null;
}

/** How many pass transactions this tab has open right now (test/diagnostic). */
export function activePassCount(tabId) {
  return (ledger.get(tabId) || new Map()).size;
}

/** Forget a tab's transactions without talking to it (tab closed, worker torn down). */
export function dropPasses(tabId) {
  const byToken = ledger.get(tabId);
  if (!byToken) return { dropped: 0 };
  const n = byToken.size;
  for (const txn of [...byToken.values()]) {
    clearTimeout(txn.timer);
    byToken.delete(txn.token);
  }
  ledger.delete(tabId);
  activeGate.delete(tabId);
  noGateProbeAt.delete(tabId);
  forgetControlled(tabId);
  return { dropped: n, tabId };
}

// ------------------------------------------------------- fail-closed self-sweep
// A pass stamp that outlives its issuer is the fail-OPEN direction, and the only
// things that used to clear one were (a) the content world's own `setTimeout`,
// which a hidden/occluded tab throttles and an extension reload deletes, and
// (b) the transaction's own deadline in a service worker that can be torn down
// with it. LIVE-RESULTS-3A 8-6 measured the result: a token 287 seconds past its
// expiry still holding the veil at `none`, i.e. the shield wide open for the user
// while nobody was home. This is the gate that does not depend on any of those:
// the worker's 30-second alarm re-reads the DOM of every tab this extension took
// over and erases whatever the current ledger does not claim.
const CONTROLLED_TABS_KEY = 'ubb_shield_controlled_tabs';
const SHIELD_SWEEP_ALARM = 'ubb-shield-sweep';
const controlledTabs = new Set();
let controlledRestored = false;

function rememberControlled(tabId) {
  controlledTabs.add(tabId);
  try {
    chrome.storage.session.set({ [CONTROLLED_TABS_KEY]: [...controlledTabs] }).catch(() => {});
  } catch {}
}

function forgetControlled(tabId) {
  if (!controlledTabs.delete(tabId)) return;
  try {
    chrome.storage.session.set({ [CONTROLLED_TABS_KEY]: [...controlledTabs] }).catch(() => {});
  } catch {}
}

/** chrome.storage.session survives a service-worker restart (the ledger in this
 *  module does not) — which is precisely the state a leaked stamp needs someone
 *  to remember: the door's issuer is gone, the page still holds it open. */
async function restoreControlledTabs() {
  if (controlledRestored) return;
  controlledRestored = true;
  try {
    const st = await chrome.storage.session.get(CONTROLLED_TABS_KEY);
    for (const t of st?.[CONTROLLED_TABS_KEY] || []) controlledTabs.add(t);
  } catch {}
}

/**
 * Reconcile one frame's DOM against the ledger, without opening anything: erase
 * every stamp that is expired or claimed by no live transaction and write each
 * host's veil back from what survives. Runs through the DOM channel on purpose —
 * an orphan host's message world is dead, so a message can never reach it.
 */
export async function reconcileTab(tabId) {
  await restoreControlledTabs();
  const frames = await tabFrames(tabId);
  const reads = (await Promise.all(frames.map((f) => domPass(tabId, f, 'reconcile', null, null, 0)))).filter(
    (r) => r && !r.dom_failed && !r.inject_error,
  );
  return {
    proven: reads.length > 0,
    frames: reads.length,
    hosts: reads.reduce((n, r) => n + (r.hosts || 0), 0),
    ours: reads.reduce((n, r) => n + (r.ours || 0), 0),
    erased_unclaimed: reads.reduce((n, r) => n + (r.erased_unclaimed || 0), 0),
    still_blocking: reads.reduce((n, r) => n + (r.blocking || []).length, 0),
    open_tokens: reads.reduce((n, r) => n + (r.open_tokens || 0), 0),
  };
}

/** Sweep every tab this extension has taken over; called by the 30s alarm and
 *  importable by a test. A tab with a live transaction is left alone (its ledger
 *  entry is the claim), and a tab that no longer exists is dropped. */
export async function sweepLeakedPasses() {
  await restoreControlledTabs();
  const swept = [];
  for (const tabId of [...controlledTabs]) {
    try {
      await chrome.tabs.get(tabId);
    } catch {
      forgetControlled(tabId);
      continue;
    }
    if (activePassCount(tabId) > 0) continue;
    swept.push({ tabId, ...(await reconcileTab(tabId)) });
  }
  return { swept: swept.length, tabs: swept };
}

// Module-scope chrome.* must stay import-safe for Node harnesses that load this
// file before installChromeStub() (contract §9.5), hence the typeof guard.
const alarmsApi = typeof chrome !== 'undefined' && chrome ? chrome.alarms : null;
if (alarmsApi && typeof alarmsApi.create === 'function' && alarmsApi.onAlarm?.addListener) {
  alarmsApi.create(SHIELD_SWEEP_ALARM, { periodInMinutes: 0.5 });
  alarmsApi.onAlarm.addListener((a) => {
    if (a && a.name === SHIELD_SWEEP_ALARM) sweepLeakedPasses().catch(() => {});
  });
}

async function msg(tabId, payload) {
  try {
    return await chrome.tabs.sendMessage(tabId, payload);
  } catch {
    return { ok: false, unreachable: true };
  }
}

function extId() {
  try {
    return chrome.runtime?.id || '';
  } catch {
    return '';
  }
}

/** Settle a promise into a discriminated result with a hard ceiling — a wedged
 *  content script must never be able to hold a tool open (LIVE-RESULTS §2:
 *  one dead bridge burned the whole 40s TOOL_TIMEOUT, every call, forever). */
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
        resolve({ status: 'error', error: String(e?.message || e) });
      },
    );
  });
}

const UNREACHABLE = /Receiving end does not exist|could not establish connection/i;

/**
 * One message, ADDRESSED to one frame, with a bounded wait.
 * chrome.tabs.sendMessage without {frameId} broadcasts: every frame's listener
 * runs and only the FIRST sendResponse is read back — so a broadcast ack proves
 * nothing about the frame the input will actually land in (Wave 3 learned this
 * on write ops, LIVE-RESULTS #1 learned it on UBB_PASS).
 */
async function frameMsg(tabId, frameId, payload, timeoutMs = PASS_MSG_TIMEOUT_MS) {
  const r = await settle(chrome.tabs.sendMessage(tabId, payload, { frameId }), timeoutMs);
  if (r.status === 'timeout') return { delivered: false, timeout: true };
  if (r.status === 'error') return { delivered: false, unreachable: UNREACHABLE.test(r.error), error: r.error };
  return { delivered: true, reply: r.value ?? null };
}

/**
 * Runs INSIDE the target frame (chrome.scripting serialises this function, so
 * it must stay dependency-free and may not close over anything).
 * The token ledger lives IN THE DOM: `data-ubb-pass` = tokens this document's
 * live message world opened, `data-ubb-forced` = tokens THIS channel stamped.
 * The veil blocks only when the union of the two is empty, which is what makes
 * a late release from an earlier action unable to close a veil a later action
 * still needs — and what lets an orphaned host (dead listener, leftover from a
 * torn-down world) be opened and read from the outside at all.
 *
 * `claims` (the SW's live transaction list for this frame) turns this call into
 * the RECONCILIATION as well as the enforcement: every stamp that is expired or
 * nobody owns any more is erased FROM THE ATTRIBUTE (not just skipped by the
 * verdict), and the veil of EVERY host of this extension — orphans included, they
 * are exactly the ones no message can reach — is written from what survives, in
 * both directions:
 *   nothing alive  → pointer-events:auto  (fail-CLOSED for the user)
 *   something alive → pointer-events:none (a claimed door must not keep eating
 *   the agent's own events while the ledger says it is open)
 */
function __ubbFramePass(op, token, expire, at, owner, claims) {
  var found = Array.prototype.slice.call(document.querySelectorAll('.ubb-host-root'));
  var ownerOf = function (h) {
    var o = h.getAttribute('data-ubb-owner');
    // a host with no owner tag was built by an older build of THIS shield
    return !o || o === owner ? owner : null;
  };
  var ours = [];
  var foreign = [];
  var i;
  // entries are kept exactly as written ("token@expire"): rewriting a survivor
  // without its expiry would make it immortal and leak an open door
  var alive = function (h, name) {
    var raw = h.getAttribute(name) || '';
    var parts = raw.split('|');
    var out = [];
    var now = Date.now();
    for (var j = 0; j < parts.length; j++) {
      if (!parts[j]) continue;
      var k = parts[j].lastIndexOf('@');
      var e = k > 0 ? Number(parts[j].slice(k + 1)) : Infinity;
      if (e !== Infinity && !(e > now)) continue;
      if (out.indexOf(parts[j]) < 0) out.push(parts[j]);
    }
    return out;
  };
  var tokOf = function (p) {
    var k = p.lastIndexOf('@');
    return k > 0 ? p.slice(0, k) : p;
  };
  var veilOf = function (h) {
    var r = h.shadowRoot;
    return r && r.querySelector ? r.querySelector('.veil') : null;
  };
  var claim = {};
  var cl = claims || [];
  for (i = 0; i < cl.length; i++) claim[cl[i]] = 1;
  if (token && op !== 'close') claim[token] = 1; // my own token is claimed on the way in
  var kept = function (parts) {
    var out = [];
    for (var q = 0; q < parts.length; q++) if (claim[tokOf(parts[q])]) out.push(parts[q]);
    return out;
  };
  for (i = 0; i < found.length; i++) {
    if (ownerOf(found[i]) === owner) ours.push(found[i]);
    else foreign.push(found[i].getAttribute('data-ubb-owner'));
  }
  var openTokens = 0;
  var erased = 0;
  for (i = 0; i < ours.length; i++) {
    var h = ours[i];
    var before = (h.getAttribute('data-ubb-pass') || '').split('|').filter(Boolean).length +
      (h.getAttribute('data-ubb-forced') || '').split('|').filter(Boolean).length;
    var forced = kept(alive(h, 'data-ubb-forced'));
    var pass = kept(alive(h, 'data-ubb-pass'));
    erased += before - forced.length - pass.length;
    // my own token: added on the way in with ITS expiry, removed only by me
    var idx = -1;
    for (var q = 0; q < forced.length; q++) if (tokOf(forced[q]) === token) idx = q;
    if (op === 'close') {
      if (idx >= 0) forced.splice(idx, 1);
    } else if (idx < 0 && token) {
      forced.push(token + '@' + expire);
    }
    h.setAttribute('data-ubb-forced', forced.join('|'));
    h.setAttribute('data-ubb-pass', pass.join('|'));
    var open = pass.length + forced.length;
    if (open > openTokens) openTokens = open;
    // the host box is never a hit target; only the veil's pointer-events change
    h.style.pointerEvents = 'none';
    var stMode = h.getAttribute('data-ubb-mode') || 'armed';
    var stBlock = h.getAttribute('data-ubb-block') || 'block';
    var v = veilOf(h);
    if (v) v.style.pointerEvents = open === 0 && stMode === 'armed' && stBlock === 'block' ? 'auto' : 'none';
  }
  var blocking = [];
  for (i = 0; i < found.length; i++) {
    var hh = found[i];
    if (hh.style.display === 'none' || getComputedStyle(hh).display === 'none') continue;
    var hv = veilOf(hh);
    var pe = hv ? getComputedStyle(hv).pointerEvents : 'none';
    if (pe !== 'none') blocking.push({ owner: ownerOf(hh) || hh.getAttribute('data-ubb-owner'), veil: pe });
  }
  // fix20 HIT FORENSICS. Two residual defects lived here: (1) `at` arrives in
  // TOP-viewport coordinates but this function also runs inside subframes, where
  // elementFromPoint speaks the frame's OWN viewport — the gate used to skip the
  // check entirely there (at:null), so the "point must hit the target" tolerance
  // was structurally absent for every frame. Convert through the same-origin
  // frameElement chain when the chain exists; when it cannot be composed, say so
  // (hit_coord:"unreachable") instead of pretending the point was checked.
  // (2) a tag name cannot tell "the Savebatch button" from "the row above it"
  // (LIVE-RESULTS-6: 18/20 dispatched points ~9px OUTSIDE the button and hit
  // still answered "button"), so carry the identity of what was hit — id / a
  // recognisable class / aria-label / a text digest — plus the hit element's own
  // box and the point actually resolved.
  var hit = null;
  var hitAt = null;
  var hitCoord = 'none';
  if (at) {
    var lx = at[0];
    var ly = at[1];
    hitCoord = 'top';
    if (window.top !== window) {
      hitCoord = 'unreachable';
      try {
        var ox = 0;
        var oy = 0;
        var cur = window.frameElement;
        var hops = 0;
        var done = false;
        while (cur && hops++ < 10) {
          var fr = cur.getBoundingClientRect();
          ox += fr.left + (cur.clientLeft || 0);
          oy += fr.top + (cur.clientTop || 0);
          var pv = cur.ownerDocument ? cur.ownerDocument.defaultView : null;
          if (!pv) break;
          if (pv === pv.top) {
            done = true;
            break;
          }
          cur = pv.frameElement;
        }
        if (done) {
          lx = at[0] - ox;
          ly = at[1] - oy;
          hitCoord = 'local';
        }
      } catch (eConv) {
        hitCoord = 'unreachable';
      }
    }
    if (hitCoord !== 'unreachable') {
      hitAt = [lx, ly];
      var el = document.elementFromPoint(lx, ly);
      if (el) {
        var hTxt = null;
        var hBox = null;
        try {
          hTxt = String(el.textContent || el.value || '').replace(/\s+/g, ' ').trim().slice(0, 24) || null;
        } catch (eTxt) {}
        try {
          if (typeof el.getBoundingClientRect === 'function') {
            var hr = el.getBoundingClientRect();
            if (isFinite(hr.left) && isFinite(hr.top) && isFinite(hr.right) && isFinite(hr.bottom)) {
              hBox = [Math.floor(hr.left), Math.floor(hr.top), Math.ceil(hr.right), Math.ceil(hr.bottom)];
            }
          }
        } catch (eBox) {}
        var hCls = null;
        try {
          var cs = String(typeof el.className === 'string' ? el.className : (el.getAttribute && el.getAttribute('class')) || '').split(/\s+/);
          for (var ci = 0; ci < cs.length; ci++) if (cs[ci] && cs[ci].indexOf('ubb-') !== 0) { hCls = cs[ci]; break; }
        } catch (eCls) {}
        hit = {
          tag: String(el.tagName || '').toLowerCase(),
          is_shield_host: !!(el.classList && el.classList.contains && el.classList.contains('ubb-host-root')),
          owner: el.getAttribute ? el.getAttribute('data-ubb-owner') : null,
          id: (el.getAttribute && el.getAttribute('id')) || null,
          cls: hCls,
          aria: (el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('name') || el.getAttribute('data-testid'))) || null,
          text: hTxt,
          rect: hBox,
        };
      }
    }
  }
  return {
    hosts: found.length,
    ours: ours.length,
    foreign: foreign,
    blocking: blocking,
    hit: hit,
    hit_checked: !!(at && hitCoord !== 'unreachable'),
    hit_at: hitAt,
    hit_coord: hitCoord,
    open_tokens: openTokens,
    erased_unclaimed: erased,
  };
}

/**
 * Also runs INSIDE the frame: takes this extension's host(s) OUT OF THE RENDER
 * TREE for a print/screenshot render and puts back exactly what apply() had
 * stamped — so an unarmed or already-hidden shield does not light up afterwards.
 * Hiding is not a pointer-events question: a node that is not in the render tree
 * cannot put a single glyph into a PDF (the shield's pill text and its whole
 * stylesheet reached print_pdf output while it was only made transparent).
 */
function __ubbFrameHide(hide, owner) {
  var found = Array.prototype.slice.call(document.querySelectorAll('.ubb-host-root'));
  var ours = 0;
  var foreign = 0;
  var displayed = 0;
  for (var i = 0; i < found.length; i++) {
    var h = found[i];
    var o = h.getAttribute('data-ubb-owner');
    if (o && o !== owner) {
      foreign++;
      continue;
    }
    ours++;
    if (hide) {
      h.style.display = 'none';
    } else {
      var m = h.getAttribute('data-ubb-mode') || 'off';
      var vis = h.getAttribute('data-ubb-visible');
      h.style.display = (m === 'armed' || m === 'paused') && vis !== '0' ? '' : 'none';
    }
    if (h.style.display !== 'none' && getComputedStyle(h).display !== 'none') displayed++;
  }
  return { hosts: found.length, ours: ours, foreign: foreign, displayed: displayed, hidden: ours - displayed };
}

/** Frame-addressed DOM enforcement + readback, bounded.
 *  The three possible answers mean three different things and MUST stay
 *  distinguishable (LIVE-RESULTS-3A 8-1: a round trip that produced nothing was
 *  collapsing into the same `null` as "this channel does not exist", and the gate
 *  then fell back to a ledger answer and reported a confirmation nobody had
 *  proven):
 *    null                       → no chrome.scripting here at all (harness, or a
 *                                 frame this extension may not inject into)
 *    {dom_failed:'timeout'|…}   → the channel exists and gave no answer this time
 *                                 → NOT evidence of an open door
 *    {inject_error}             → our own injected function threw → gate is broken
 *  `claims` is this frame's live transaction list (see claimsFor). */
async function domPass(tabId, frameId, op, token, at, expire) {
  const ex = chrome.scripting && chrome.scripting.executeScript;
  if (typeof ex !== 'function') return null;
  const claims = claimsFor(tabId, frameId);
  const r = await settle(
    ex.call(chrome.scripting, {
      target: { tabId, frameIds: [frameId] },
      func: __ubbFramePass,
      args: [op, token, expire || Date.now() + PASS_TXN_TTL_MS, at || null, extId(), claims],
    }),
    PASS_DOM_TIMEOUT_MS,
  );
  // "our own injected function threw" must never degrade into the weaker ack
  // proof — that is how a broken gate passes every offline suite and then eats
  // agent input on a real browser
  if (r.status === 'error') {
    return { hosts: -1, ours: 0, foreign: [], blocking: [], hit: null, open_tokens: 0, inject_error: r.error };
  }
  if (r.status !== 'ok') {
    return { hosts: -1, ours: 0, foreign: [], blocking: [], hit: null, open_tokens: 0, dom_failed: 'timeout' };
  }
  const res = Array.isArray(r.value) ? r.value[0] && r.value[0].result : r.value;
  if (!res || typeof res.hosts !== 'number') {
    return { hosts: -1, ours: 0, foreign: [], blocking: [], hit: null, open_tokens: 0, dom_failed: 'no_answer' };
  }
  return res;
}

/** Bounded frame-addressed render-tree read + write (see __ubbFrameHide). */
async function domHide(tabId, frameId, hide) {
  const ex = chrome.scripting && chrome.scripting.executeScript;
  if (typeof ex !== 'function') return null;
  const r = await settle(
    ex.call(chrome.scripting, {
      target: { tabId, frameIds: [frameId] },
      func: __ubbFrameHide,
      args: [!!hide, extId()],
    }),
    PASS_DOM_TIMEOUT_MS,
  );
  if (r.status === 'error') return { hosts: -1, ours: 0, foreign: 0, displayed: 0, hidden: 0, inject_error: r.error };
  if (r.status !== 'ok') return null;
  const res = Array.isArray(r.value) ? r.value[0] && r.value[0].result : r.value;
  return res && typeof res.hosts === 'number' ? res : null;
}

/** A usable readback of the top document is the only proof that counts.
 *  `wantPoint` is the deliverable-1 rule: when the transaction knows the
 *  coordinate the event will be routed through, the readback MUST have answered
 *  for that coordinate — a veil-state-only "open" is how 3A said {"clicked":…}
 *  while the shield's own box sat on the point. */
function domVerdict(dom, label, wantPoint) {
  if (dom && dom.inject_error) {
    return {
      confirmed: false,
      reason: `${label}: 本扩展的强制/回读脚本在那个文档里抛错（这是闸门自己坏了，不是"这条通路不存在"，不能退回弱证明）：${dom.inject_error}`.slice(0, 300),
      dom,
    };
  }
  if (dom && dom.dom_failed) {
    return {
      confirmed: false,
      reason: `${label}: 盾牌状态的 DOM 回读在这一次往返里没有答案（${dom.dom_failed}）。"问不到"不是"门开着"——没有点位证明就不能放行输入`,
      dom,
    };
  }
  const blockers = (dom.blocking || []).filter((b) => b.owner === extId());
  const foreign = (dom.blocking || []).filter((b) => b.owner !== extId());
  if (foreign.length) {
    return {
      confirmed: false,
      reason: `${label}: 别家的遮挡层还盖着这个文档 (owner ${foreign.map((b) => b.owner).join(',')}) — 它不是本扩展的盾牌，本扩展无权替它开门`,
      dom,
    };
  }
  if (dom.hit && dom.hit.is_shield_host) {
    return { confirmed: false, reason: `${label}: document.elementFromPoint 仍然命中盾牌自身 (hosts=${dom.hosts})`, dom };
  }
  if (blockers.length) {
    return {
      confirmed: false,
      reason: `${label}: 盾牌 veil 仍处于 pointer-events=${blockers[0].veil}（文档内 ${dom.hosts} 个 .ubb-host-root），agent 输入一定会被吃掉`,
      dom,
    };
  }
  if (wantPoint && dom.hit_checked === false) {
    return { confirmed: false, reason: `${label}: 本次确认要求点位回读，但回读没有对那个坐标做 elementFromPoint`, dom };
  }
  return { confirmed: true, dom };
}

/** Did the ack deliver an ANSWER at all? (fix15's boundary)
 *  `!st` is the hole this function existed to close and closed it wrong: the
 *  message reached the frame and came back with NOTHING in it (Chrome resolves
 *  `undefined` when a listener answers without sendResponse — a world that is up
 *  but has no shield to report, the window between tab.create's armTab and
 *  webNavigation's re-arm). That is not the same fact as "asked, and the shield
 *  says it is not blocking" (mode border/off/paused), and it must never share its
 *  `confirmed: true` — the same distinction rearmFrame() draws between
 *  shield_unreachable and shield_not_active.
 *  Deliberately NOT tightened here: a responder that hands back a stateless
 *  OBJECT ({} / {ok:true}) keeps today's `not-armed` reading. Real content
 *  scripts cannot produce that shape (shield.js's stateOf() always carries mode;
 *  frameblock.js deliberately never sendResponse), and it is exactly what
 *  lib/testharness.mjs's default stub returns — tightening it would mean editing
 *  test-{fill,replay,secrets,security}.mjs, which are not this lane. Logged as a
 *  follow-up in D:/Codebase/ubb-scratch/log-fix15.md.
 *
 *  fix16: kept as DOCUMENTATION, not as code. The reasoning above is sound, the
 *  verdict built on it was unreachable (LIVE-RESULTS-5: 0/345 audit entries) and
 *  cost the 1/20 baseline, so ackVerdict is back on attribution-roots' shape.
 *  What used to be this predicate is now an OBSERVATION the probe carries on every
 *  round — `probe.acks[].st === null` beside `verdict:'not-armed'` is the exact
 *  "no state was delivered" signature, visible from `ubb audit tail` instead of
 *  acted on. See D:/Codebase/ubb-scratch/log-fix16.md. */

/** No chrome.scripting channel (harness / restricted frame): the frame's own
 *  addressed reply is the next best thing — and "no shield lives in this
 *  document" is a legitimate pass, because the veil only exists where
 *  shield.js runs (a tab that never received UBB_SHIELD shows nothing).
 *  What is NOT legitimate any more (LIVE-RESULTS-3A 8-1): reading this reply as
 *  proof of reachability from a LEDGER value. `state.pass` is computed by
 *  content/shield.js from the stamped DOM attributes, the transaction's own token
 *  must be among them, no host of ours may still be blocking, and when the action
 *  has a point the document's own elementFromPoint must answer for it. */
async function ackVerdict(tabId, frameId, passRes, txn = {}) {
  const at = txn.at || null;
  if (passRes.unreachable || passRes.timeout) {
    const q = await frameMsg(tabId, frameId, { type: 'UBB_SHIELD_QUERY', at });
    const st = q.reply && (q.reply.state || q.reply);
    if (!st) {
      return {
        confirmed: false,
        reason: `帧 ${frameId}: UBB_PASS 和 UBB_SHIELD_QUERY 都送不进去，DOM 回读通道在这个环境里又不存在 —— 那里可能正站着一个消息永远叫不醒的孤儿 host（重载后被拆掉的世界），没有任何人证明过点位可达，不能当成"没有盾牌"`,
      };
    }
    if (st.mode !== 'armed' || st.blockMode !== 'block') return { confirmed: true, via: 'no-shield', state: st };
    const claimedByDom = Array.isArray(st.dom_pass_tokens) && st.dom_pass_tokens.length > 0;
    if (claimedByDom && st.blocking_hosts === 0 && (!at || (st.hit && !st.hit.is_shield_host))) {
      return { confirmed: true, via: 'state-tokens', state: st };
    }
    return {
      confirmed: false,
      reason: `帧 ${frameId} 的盾牌报出 armed，但没有任何活监听器应答 UBB_PASS（${passRes.timeout ? 'ack 超时' : passRes.error}）：鼠标也许能穿过，键盘一定会被它的 capture 监听吃掉`,
    };
  }
  // ──────────────────────────── fix16 REVERT: back to attribution-roots' judgement
  // attribution-roots asks this branch ONE question — "did the shield say it is
  // not blocking?" — and answers it with a single shape: a state that is either
  // absent or carries a non-blocking mode/blockMode is `confirmed:true, via:'not-armed'`.
  // fix15 split the `!st` half out into "UNKNOWN" (+ PASS_STATE_ASKS bounded re-ask +
  // a shield.pass_state_unknown audit + an unknown-state refusal). LIVE-RESULTS-5
  // measured that split on the real browser:
  //   · 20/20 first-pointer-action LIE (attribution-roots: 1/20+, same recipe);
  //   · shield.pass_state_unknown = 0 denied / 0 recovered out of 345 audit entries
  //     ⇒ the unknown branch was NEVER ENTERED. ackVerdict only runs when
  //     domPass() === null, and domPass() is only null where chrome.scripting is
  //     missing — which manifest.json grants. Exactly the unreachability fix15 §4
  //     warned about.
  // Two things follow, and neither is a causal claim I am allowed to skip: the split
  // cannot have CAUSED the 20/20 (it never ran), and it cannot have fixed anything
  // either — it is dead code carrying a false reachability claim, bought at the price
  // of attribution-roots' judgement on every path that does run. So it comes out: the
  // judgement goes back verbatim, and whether the 1/20 → 20/20 gap tracks this revert
  // or something else in the build is exactly what the probe below is for next round.
  // fix15's distinction is not thrown away, it is DEMOTED FROM VERDICT TO EVIDENCE: the
  // probe reports "the ack delivered no state at all" (acks[].st === null next
  // to verdict:'not-armed') instead of acting on it. Closing the lie needs the DOM
  // path's own evidence — that is what shield.pass_gate is for (fix16 probe block,
  // and the round-6 recipe in D:/Codebase/ubb-scratch/log-fix16.md).
  // Still deliberately NOT tightened (fix15 §3, unchanged by this revert): a reply
  // carrying an object with no `mode` ({} / {ok:true}) reads as `not-armed` too.
  // Real content scripts cannot produce that shape (shield.js's stateOf() always
  // carries mode; frameblock.js deliberately never sendResponse), and it is exactly
  // what lib/testharness.mjs's default stub returns — tightening it would mean
  // editing test-{fill,replay,secrets,security}.mjs, which are not this lane.
  const reply = passRes.reply;
  const st = (reply && reply.state) || reply || null;
  if (!st || st.mode !== 'armed' || st.blockMode !== 'block') return { confirmed: true, via: 'not-armed', state: st };
  // A reply from the CURRENT shield answers for the DOM (`dom_pass_tokens` is the
  // stamped attribute list); an older/boolean-shaped reply only answers for itself,
  // and that is exactly the ledger-proof shape 3A exploited.
  const modern = Array.isArray(st.dom_pass_tokens);
  const tokens = modern ? st.dom_pass_tokens : null;
  const claimed = tokens ? tokens.indexOf(txn.token) >= 0 : reply && reply.pass === true;
  if (!claimed) {
    return {
      confirmed: false,
      reason: `帧 ${frameId} 报 mode=armed，可这个文档的 data-ubb-pass/data-ubb-forced 里没有本次事务的令牌 —— 账本（或这个世界自己的 passes 布尔）说开着，DOM 上却没人在开，不能当确认`,
      state: st,
    };
  }
  if (modern) {
    if (typeof st.blocking_hosts === 'number' && st.blocking_hosts > 0) {
      return { confirmed: false, reason: `帧 ${frameId}: DOM 上还有 ${st.blocking_hosts} 个本扩展 host 的 veil 是 pointer-events:auto`, state: st };
    }
    if (at && (!st.hit || st.hit.is_shield_host)) {
      return { confirmed: false, reason: `帧 ${frameId}: 文档自己的 document.elementFromPoint(${at}) 仍然命中盾牌 host`, state: st };
    }
  }
  return { confirmed: true, via: modern ? 'ack-dom' : 'ack', state: st };
}

// ──────────────────────────────────────────────────────── fix16 probe block
// Judgement-path probe. It changes NO verdict: it only writes what the gate
// already knew — but had thrown away — into the existing audit ring
// (`action:'shield.pass_gate'`, one aggregated entry per action opening + per
// action dispatch burst), so `ubb audit tail` can answer three questions about a
// real-browser action that LIVE-RESULTS-4/5 could only guess at:
//   Q1 how long did UBB_PASS op:'open' take, per round trip, and did it deliver?
//      → `ack_ms`/`dom_ms`/`del`/`acks[].ms` (+ `slowest` names the single
//        slowest round trip of the whole confirmation).
//   Q2 which criterion gave the final confirmed:true, and what did the point hit
//      at that moment? → `verdict` (stable vocabulary below) + `hit`/`veil`/`open`
//      read at the confirming round trip; `st:null` beside verdict:'not-armed' is
//      the "ack answered without any state" signature fix15 tried to refuse.
//   Q3 where did the ~5000ms go? → `ms`, `attempts`, `rounds[]` per-round ms,
//      `release_ms` (the capped(closeTxn) between attempts), `sleep_ms`,
//      `budget_stopped` (the refusal path) and `over_budget_ms`/`over_budget_ok`
//      — the latter is RECORD ONLY: a round that burns past PASS_CONFIRM_BUDGET_MS
//      and still confirms returns success today (ensurePass' budget check sits on
//      the failure branch), which is exactly the 5043-5076ms ok:true of round 5.
//      Changing that is NOT this round's job.
// Cost: 2 ring entries per input action (dispatch checks are aggregated into one,
// capped at PASS_PROBE_CHECKS with `dropped_checks` counting the rest), plus a
// throttled one for the "dispatched with no open pass transaction" shape.
const PASS_PROBE_ACTION = 'shield.pass_gate';
const PASS_PROBE_CHECKS = 8;
const PASS_PROBE_NOGATE_MS = 10000;
const noGateProbeAt = new Map(); // tabId → wall-clock ms of the last no-open-pass entry

function passProbeLog(entry) {
  try {
    audit.log({ action: PASS_PROBE_ACTION, ...entry });
  } catch {}
}

/** The frame's own reply, as evidence: delivered? how long? did it carry a state,
 *  and if so what did THAT world see at the point (pre-DOM-write, i.e. what the
 *  shield was actually doing when we asked). `st === null` = ack landed with no
 *  state in it at all. */
function probeAck(frameId, a, ms) {
  const reply = a && a.reply;
  const st = (reply && reply.state) || reply || null;
  return {
    f: frameId,
    ms: Number.isFinite(ms) ? ms : null,
    del: !!(a && a.delivered),
    to: !!(a && a.timeout),
    un: !!(a && a.unreachable),
    pass: reply ? reply.pass === true : null,
    st: st ? `${st.mode || '?'}/${st.blockMode || '?'}` : null,
    veil: st ? st.veil_pointer_events ?? null : null,
    bh: st ? st.blocking_hosts ?? null : null,
    hit: st && st.hit ? (st.hit.is_shield_host ? 'shield-host' : st.hit.tag || '?') : null,
    dt: st && Array.isArray(st.dom_pass_tokens) ? st.dom_pass_tokens.length : null,
  };
}

/** fix20: one readable string answering "was the element hit the element I
 *  wanted?" without a second DOM lookup — tag + the strongest identity the page
 *  offered (id > class > aria > text digest). Never prose, always ≤64 chars. */
function probeHitDigest(h) {
  if (!h) return null;
  if (h.is_shield_host) return 'shield-host';
  const ident = h.id ? '#' + h.id : h.cls ? '.' + h.cls : h.aria ? '[aria:' + h.aria + ']' : h.text ? '"' + h.text + '"' : '';
  return String(h.tag || '?') + ident;
}

/** One DOM round trip, as evidence: `kind` says which read this was (read = the
 *  first, retry = the dom_failed re-read, forced = the force-the-door-open read,
 *  sub = the named subframe's read). `hit` answers "what did elementFromPoint see
 *  at that point" POST-write; `veil` is every still-blocking host in the document. */
function probeDom(frameId, d, kind, ms) {
  if (d === null) return { f: frameId, kind: `${kind}-no-channel`, ms: Number.isFinite(ms) ? ms : null };
  const ours = extId();
  return {
    f: frameId,
    kind,
    ms: Number.isFinite(ms) ? ms : null,
    hosts: d.hosts,
    ours: d.ours,
    open: d.open_tokens,
    veil: (d.blocking || []).map((b) => `${b.owner === ours ? 'ours' : b.owner || '?'}:${b.veil}`),
    hit: d.hit ? (d.hit.is_shield_host ? 'shield-host' : d.hit.tag || '?') : d.hit_checked === false ? 'unchecked' : null,
    // fix20 audit-readable identity: WHICH element did the point actually hit —
    // tag alone passed LIVE-RESULTS-6's 9px-outside-the-button dispatch because a
    // neighbouring row is the same tag. `he` carries tag#id/.class/[aria]/"text",
    // `hat` the resolved point, `hbox` the hit element's own box in that document.
    he: d.hit ? probeHitDigest(d.hit) : null,
    hat: d.hit_at || null,
    hbox: d.hit && d.hit.rect ? d.hit.rect.join(',') : null,
    fail: d.dom_failed || null,
    inj: d.inject_error ? String(d.inject_error).slice(0, 60) : null,
  };
}

/** WHICH criterion answered "yes" — a stable field, never prose. */
function probeVerdict(v, txn, top) {
  if (!v || !v.confirmed) return 'refused';
  if (v.via === 'not-armed') return 'not-armed';
  if (v.via === 'ack-dom') return 'ack-dom';
  if (v.via === 'ack') return 'ack-only';
  if (v.via === 'no-shield') return 'no-shield';
  if (v.via === 'state-tokens') return 'state-tokens';
  if (txn.keys && top && top.ours > 0) return 'ledger+dom';
  // `forced` is its own field (see probe.forced): the vocabulary here stays closed,
  // so `verdict` can be grouped on in audit.tail instead of parsed.
  if (txn.at) return 'dom-point';
  return 'dom';
}

/** One confirmTxn round, compressed — this is what lands in the ring. */
function roundProbe(p) {
  const d = p && p.doms && p.doms.length ? p.doms[p.doms.length - 1] : null;
  const a = p && p.acks && p.acks.length ? p.acks[0] : null;
  const ackMs = p && p.acks ? p.acks.reduce((m, x) => Math.max(m, x.ms || 0), 0) : 0;
  return {
    ms: p ? p.ms : null,
    verdict: p ? p.verdict : 'no-probe',
    confirmed: p ? !!p.ok : false,
    full: p ? !!p.full : null,
    forced: p ? !!p.forced : false,
    del: p ? p.acks.some((x) => x.del) : null,
    ack_ms: ackMs,
    dom_ms: d ? d.ms : null,
    st: a ? a.st : null,
    st_delivered: !!a && a.st !== null,
    hit: d ? d.hit : null,
    veil: d ? d.veil : null,
    open: d ? d.open : null,
    fail: d ? d.fail || d.inj : null,
  };
}

/** Q3 in one field: which single round trip of this confirmation cost the most,
 *  so "≈5000ms" reads as an ACK timeout / a DOM timeout / a forced re-read / the
 *  release wait instead of a guess. */
function slowestRound(rounds) {
  let best = null;
  for (const r of rounds) {
    for (const [kind, ms] of [['ack', r.ack_ms], ['dom', r.dom_ms], ['round', r.ms]]) {
      if (typeof ms !== 'number' || !Number.isFinite(ms)) continue;
      if (kind === 'round') continue; // the round is the sum, not a candidate
      if (!best || ms > best.ms) best = { kind, ms, verdict: r.verdict, forced: r.forced, fail: r.fail || null };
    }
  }
  return best;
}

/** Extension-frameIds of this tab (0 always first); [] when webNavigation
 *  cannot answer — the gate then only knows the frame it was given. */
async function tabFrames(tabId) {
  try {
    const all = await chrome.webNavigation.getAllFrames({ tabId });
    const ids = (all || []).map((f) => f.frameId).filter((f) => Number.isInteger(f) && f >= 0);
    return ids.length ? [...new Set([0, ...ids])] : [0];
  } catch {
    return [0];
  }
}

/**
 * The frames one pass transaction has to cover. The top document always (its
 * veil hit-tests the whole viewport, iframe areas included). When the action
 * names its frame, THAT frame is the only other one opened — a pass for a click
 * in frame 7 must not hand frame 3 to the agent. When it cannot be known (a
 * bare {x,y} click may land in any iframe; a key burst goes to whatever has
 * focus) every frame is opened, because failing to open one eats the agent's
 * own input and the gate would then be a lie.
 */
function passFramesFor(opts, frames) {
  const named = Number.isInteger(opts.frameId) && opts.frameId >= 0 ? opts.frameId : null;
  return [...new Set(named === null ? [0, ...frames] : [0, named])];
}

/** Open + prove. `full` fans the token out to every frame the transaction
 *  covers (that is the opening round); a per-dispatch confirmation only needs
 *  the documents the event is actually routed through — the top document that
 *  hit-tests it and the named target frame — because a frame that already holds
 *  this token cannot lose it to anybody else's release. Keeps one dispatch
 *  confirmation at ~1 message + 1 executeScript even on a 30-frame page.
 *
 *  THE PROOF IS THE DOM, ALWAYS. There is deliberately no "the ledger already
 *  holds a live transaction for this tab, so it must be open" shortcut: that
 *  shortcut is what reported {"clicked":"@e533","at":[65,297]} nine times in a
 *  row on LIVE-RESULTS-3A while the DOM said `data-ubb-pass:""`, veil
 *  `pointer-events:auto` and `elementFromPoint` landing on the shield's own host,
 *  with zero SHIELD_PASS_FAILED in the audit. Every pass through here reads the
 *  point back; if that read refuses, the door is forced open through the DOM
 *  channel (which reaches hosts whose message world is dead) and read again; if
 *  it still refuses, the caller gets SHIELD_PASS_FAILED before a single Input.*
 *  exists on the wire. */
async function confirmTxn(tabId, txn, full = true) {
  const tp0 = Date.now();
  const ids = full ? [...txn.frames] : [...new Set(txn.frameId === null ? [0] : [0, txn.frameId])];
  const ackMs = new Map(); // frameId → ms of that frame's UBB_PASS open round trip (probe Q1)
  const inflight = new Map(
    ids.map((f) => [
      f,
      (async () => {
        const ta = Date.now();
        const r = await frameMsg(tabId, f, {
          type: 'UBB_PASS',
          op: 'open',
          token: txn.token,
          ttlMs: txn.ttl || PASS_TXN_TTL_MS,
          at: txn.at || null,
          on: true,
        });
        ackMs.set(f, Date.now() - ta);
        return r;
      })(),
    ]),
  );
  await Promise.all([...inflight.values()]);
  const topAck = await inflight.get(0);
  const targetAck = txn.frameId === null ? topAck : await inflight.get(txn.frameId);
  const doms = [];
  const domRead = async (frameId, kind, at) => {
    const td = Date.now();
    const d = await domPass(tabId, frameId, 'open', txn.token, at, txn.deadline);
    doms.push(probeDom(frameId, d, kind, Date.now() - td));
    return d;
  };
  // the top document hit-tests the event
  let top = await domRead(0, 'read', txn.at);
  let v;
  let forcedConfirmed = false;
  if (top === null) {
    v = await ackVerdict(tabId, 0, topAck, txn);
  } else {
    if (top.dom_failed || top.inject_error) {
      await sleep(PASS_RETRY_DELAY_MS);
      top = (await domRead(0, 'retry', txn.at)) || top;
    }
    v = domVerdict(top, '主文档', !!txn.at);
    if (!v.confirmed && top && !top.inject_error && !top.dom_failed) {
      // 强制开门（DOM 通路：孤儿 host 也照样写得到）再证明一次
      await sleep(PASS_RETRY_DELAY_MS);
      const again = await domRead(0, 'forced', txn.at);
      if (again) v = domVerdict(again, '主文档（强制重开之后）', !!txn.at);
      top = again;
      if (v.confirmed) forcedConfirmed = true;
    }
  }
  if (v.confirmed && txn.frameId > 0) {
    // fix20: the named frame is read AT ITS POINT (converted to frame-local
    // coordinates inside __ubbFramePass when the same-origin chain allows it);
    // a subframe read that skipped the point is how the at-tolerance died there
    let sub = await domRead(txn.frameId, 'sub', txn.at || null);
    if (sub && sub.dom_failed) {
      await sleep(PASS_RETRY_DELAY_MS);
      sub = (await domRead(txn.frameId, 'sub-retry', txn.at || null)) || sub;
    }
    // no DOM channel for that frame → its own addressed reply is all there is;
    // a channel that answered nothing is NOT a proof (domVerdict says so)
    v = sub === null ? await ackVerdict(tabId, txn.frameId, targetAck, txn) : domVerdict(sub, `帧 ${txn.frameId}`);
  }
  // pointer events only need the hit-test path clear; KEY events are eaten by the
  // capture-phase listeners of whichever world is ALIVE in that document — an
  // orphaned host answers nothing, so typing needs the frame's own reply as part
  // of the proof (otherwise press_key/type would go back to lying).
  if (v.confirmed && txn.keys && top && top.ours > 0 && !(targetAck && targetAck.delivered && targetAck.reply && targetAck.reply.pass === true)) {
    v = {
      confirmed: false,
      reason: `帧 ${txn.frameId === null ? 0 : txn.frameId} 的文档里有 ${top.ours} 个盾牌 host，却没有任何活监听器应答 UBB_PASS（重载后残留的世界）：鼠标也许能穿过，键盘一定会被它的 capture 监听吃掉`,
      top,
    };
  }
  // fix16 probe: what this round trip actually saw. Verdict-neutral — v is exactly
  // what attribution-roots would have returned; `probe` rides along beside it.
  const acks = [];
  for (const f of ids) acks.push(probeAck(f, await inflight.get(f), ackMs.get(f)));
  const probe = {
    ms: Date.now() - tp0,
    full: !!full,
    at: txn.at || null,
    ok: !!v.confirmed,
    acks,
    doms,
    verdict: probeVerdict(v, txn, top),
    forced: forcedConfirmed,
  };
  return { ...v, target: targetAck, topAck, top, probe };
}

/** Release ONE transaction. The frame is then told the AGGREGATE over the
 *  ledger (op:'close' + our token for the shield's token set, `on` for
 *  content/frameblock.js, which only understands the boolean): while another
 *  transaction still needs that frame open, nothing about that frame closes. */
async function closeTxn(tabId, token) {
  const txn = forgetTxn(tabId, token);
  if (!txn) return { closed: false, reason: 'no_such_transaction' };
  const frames = [...txn.frames];
  const results = await Promise.all(
    frames.map(async (f) => {
      const still = framePassOpen(tabId, f);
      await frameMsg(tabId, f, { type: 'UBB_PASS', op: 'close', token, ttlMs: txn.ttl || PASS_TXN_TTL_MS, on: still }, 800);
      // the DOM is only rewritten where it was rewritten on the way in
      if (f === 0 || (txn.frameId !== null && f === txn.frameId)) await domPass(tabId, f, 'close', token, null);
      return { frameId: f, stillOpen: still };
    }),
  );
  if (activeGate.get(tabId)?.token === token) activeGate.delete(tabId);
  return { closed: true, token, frames: results };
}

// ───────────────────────────────── fix17 delivery proof (page-side forensics)
// The gate's own verdict answers "is the door open RIGHT NOW at this point"; the
// promise an input tool makes is "the page received this event". Those are two
// different facts, and only the document can answer the second one, because CDP
// queues the event and acks the queueing. content/shield.js therefore keeps a
// read-only capture record of every trusted input event the document received —
// with the one field that makes the record meaningful, `shield_hit`: did it land
// on OUR overlay (veil/pill/stop button) instead of on the page. Capture phase
// fires even for the event the veil is about to swallow, which is precisely why
// "投到了页面元素" and "投到了自家遮罩" are separable at all. Everything below
// READS that record; nothing here changes what a page sees.

/** Runs INSIDE the frame. The read-only counterpart of __ubbFramePass: no
 *  attribute write, no style write, no listener — it only parses the ring.
 *  `recorder:false` means this document has NO delivery ring at all, i.e. it is
 *  served by a content-script world older than fix17: the gate then degrades to
 *  its old ack-only behaviour instead of refusing every action on a tab nobody
 *  reloaded since the extension was updated.
 *  fix20 adds three things and removes one excuse:
 *   · `want.types` — a TARGETED read (only the event types this action expects
 *     come back), so one poll over many frames stays small instead of "many
 *     frames ⇒ stop取证";
 *   · identity fields (id/cls/aria/text/box) parsed from ring fields 6..10 —
 *     which element the page actually received the event on;
 *   · `origin` — this frame's top-viewport offset through the same-origin
 *     frameElement chain, so the daemon can compare the dispatched TOP point
 *     against a record written in frame-local coordinates. Without a chain the
 *     origin stays null and matching degrades per record (never per frame-count). */
function __ubbFrameDeliveryRead(owner, want) {
  var ATTR = 'data-ubb-delivery';
  var el = document.documentElement || document.body;
  var out = { recorder: false, records: [], seq: 0, hosts: 0, veil: null, origin: null };
  if (!el || !el.getAttribute) return out;
  var raw = el.getAttribute(ATTR);
  if (raw === null) return out;
  out.recorder = true;
  var wantTypes = null;
  if (want && Array.isArray(want.types) && want.types.length) {
    wantTypes = {};
    for (var wt = 0; wt < want.types.length; wt++) wantTypes[String(want.types[wt]).toLowerCase()] = 1;
  }
  var now = Date.now();
  var parts = String(raw).split(';');
  for (var i = 0; i < parts.length; i++) {
    if (!parts[i]) continue;
    var f = parts[i].split('~');
    if (f.length < 6) continue;
    var s = Number(f[0]);
    var t = Number(f[4]);
    if (!isFinite(s) || !isFinite(t)) continue;
    if (t > now + 5000 || now - t > 60000) continue;
    var tl = String(f[1]).toLowerCase();
    if (wantTypes && !wantTypes[tl]) continue;
    var x = Number(f[2]);
    var y = Number(f[3]);
    var rec = {
      seq: s,
      type: f[1],
      x: isFinite(x) ? x : null,
      y: isFinite(y) ? y : null,
      t: t,
      shield_hit: f[5] === '1',
    };
    if (f.length > 6 && f[6] !== '-') rec.id = f[6];
    if (f.length > 7 && f[7] !== '-') rec.cls = f[7];
    if (f.length > 8 && f[8] !== '-') rec.aria = f[8];
    if (f.length > 9 && f[9] !== '-') rec.text = f[9];
    if (f.length > 10) {
      var bs = String(f[10]).split(',');
      if (bs.length === 4 && isFinite(Number(bs[0])) && isFinite(Number(bs[1])) && isFinite(Number(bs[2])) && isFinite(Number(bs[3]))) {
        rec.box = [Number(bs[0]), Number(bs[1]), Number(bs[2]), Number(bs[3])];
      }
    }
    out.records.push(rec);
    if (s > out.seq) out.seq = s;
  }
  out.records.sort(function (a, b) {
    return a.seq - b.seq;
  });
  try {
    if (window.top === window) out.origin = [0, 0];
    else {
      var ox = 0;
      var oy = 0;
      var cur = window.frameElement;
      var hops = 0;
      var done = false;
      while (cur && hops++ < 10) {
        var fr = cur.getBoundingClientRect();
        ox += fr.left + (cur.clientLeft || 0);
        oy += fr.top + (cur.clientTop || 0);
        var pv = cur.ownerDocument ? cur.ownerDocument.defaultView : null;
        if (!pv) break;
        if (pv === pv.top) {
          done = true;
          break;
        }
        cur = pv.frameElement;
      }
      if (done) out.origin = [ox, oy];
    }
  } catch (eOrg) {}
  var hosts = document.querySelectorAll ? document.querySelectorAll('.ubb-host-root') : null;
  for (var k = 0; hosts && k < hosts.length; k++) {
    var h = hosts[k];
    var o = h.getAttribute ? h.getAttribute('data-ubb-owner') : null;
    if (o && o !== owner) continue;
    out.hosts++;
    var r = h.shadowRoot;
    var v = r && r.querySelector ? r.querySelector('.veil') : null;
    if (v) out.veil = v.style.pointerEvents;
  }
  return out;
}

/** Runs INSIDE a SUBFRAME: installs the same record there. Necessary because
 *  content/shield.js is all_frames:false (manifest — not this lane), so on a
 *  frame-targeted action nobody inside the receiving document would ever note the
 *  event, and "no record" could not be told apart from "the veil ate it".
 *  Idempotent (window flag). It records POINTER and INPUT events but NOT keys:
 *  a subframe's blocker is content/frameblock.js's capture listener, which
 *  mutates nothing and keeps no token ledger in that document — a key event we
 *  cannot attribute is a key event we must not present as evidence. Keyboard
 *  delivery inside an iframe therefore stays unprovable (reported as such). */
function __ubbFrameDeliveryInstall(owner) {
  var ATTR = 'data-ubb-delivery';
  var MAX = 12;
  var TTL = 60000;
  var TYPES = ['mousedown', 'mouseup', 'click', 'input', 'wheel', 'touchstart'];
  var w = window;
  if (w.__ubbDelivery17 !== true) {
    var parse = function () {
      var el = document.documentElement || document.body;
      var raw = el && el.getAttribute ? el.getAttribute(ATTR) : null;
      var arr = [];
      if (!raw) return arr;
      var parts = String(raw).split(';');
      var now = Date.now();
      for (var i = 0; i < parts.length; i++) {
        if (!parts[i]) continue;
        var f = parts[i].split('~');
        if (f.length < 6) continue;
        var s = Number(f[0]);
        var t = Number(f[4]);
        if (!isFinite(s) || !isFinite(t)) continue;
        if (t > now + 5000 || now - t > TTL) continue;
        arr.push({ s: s, t: f[1], x: f[2], y: f[3], w: t, h: f[5], raw: parts[i] });
      }
      return arr;
    };
    var onEvent = function (e) {
      try {
        // trusted events only: page JS can dispatch an event that looks exactly
        // like a delivered one, and false evidence is worse than none
        if (!e || e.isTrusted !== true) return;
        var el = document.documentElement || document.body;
        if (!el || !el.setAttribute || !el.getAttribute) return;
        if (e.__ubbDelivery17 === true) return;
        try {
          e.__ubbDelivery17 = true;
        } catch (ignored) {}
        var type = String(e.type || '');
        if (!type) return;
        var recs = parse();
        var top = 0;
        for (var i = 0; i < recs.length; i++) if (recs[i].s > top) top = recs[i].s;
        var x = typeof e.clientX === 'number' && isFinite(e.clientX) ? String(Math.round(e.clientX)) : '-';
        var y = typeof e.clientY === 'number' && isFinite(e.clientY) ? String(Math.round(e.clientY)) : '-';
        var now = Date.now();
        var last = recs.length ? recs[recs.length - 1] : null;
        if (last && last.t === type && last.x === x && last.y === y && now - last.w < 3) return;
        var keep = recs.slice(Math.max(0, recs.length - MAX + 1));
        var lines = [];
        for (var k = 0; k < keep.length; k++) lines.push(keep[k].raw || [keep[k].s, keep[k].t, keep[k].x, keep[k].y, keep[k].w, keep[k].h].join('~'));
        // fix20 identity of the element the frame actually received this on (fields
        // 6..10, same grammar as content/shield.js): id / first non-ubb class /
        // aria-ish / text digest / own box, floored-ceiled OUTWARD. Delimiters in
        // values are flattened so the attribute grammar cannot be poisoned.
        var hId = '-';
        var hCls = '-';
        var hAr = '-';
        var hTx = '-';
        var hBx = '-';
        try {
          var tn = e.target;
          if (tn && tn.nodeType === 1 && tn.getAttribute) {
            var vId = tn.getAttribute('id');
            if (vId) hId = String(vId).replace(/[~;\r\n]/g, ' ').slice(0, 32);
            var cs = String(typeof tn.className === 'string' ? tn.className : tn.getAttribute('class') || '').split(/\s+/);
            for (var c2 = 0; c2 < cs.length; c2++) {
              if (cs[c2] && cs[c2].indexOf('ubb-') !== 0) {
                hCls = cs[c2].replace(/[~;\r\n]/g, ' ').slice(0, 24);
                break;
              }
            }
            var vAr = tn.getAttribute('aria-label') || tn.getAttribute('name') || tn.getAttribute('data-testid');
            if (vAr) hAr = String(vAr).replace(/[~;\r\n]/g, ' ').slice(0, 24);
            var vTx = String(tn.textContent || tn.value || '').replace(/\s+/g, ' ').trim().slice(0, 24);
            if (vTx) hTx = vTx;
            if (typeof tn.getBoundingClientRect === 'function') {
              var br = tn.getBoundingClientRect();
              if (isFinite(br.left) && isFinite(br.top) && isFinite(br.right) && isFinite(br.bottom)) {
                hBx = [Math.floor(br.left), Math.floor(br.top), Math.ceil(br.right), Math.ceil(br.bottom)].join(',');
              }
            }
          }
        } catch (ignored5) {}
        // no shield overlay lives in a subframe, so nothing here hits our own veil
        lines.push([top + 1, type, x, y, now, '0', hId, hCls, hAr, hTx, hBx].join('~'));
        el.setAttribute(ATTR, lines.join(';'));
      } catch (ignored2) {}
    };
    for (var j = 0; j < TYPES.length; j++) {
      try {
        w.addEventListener(TYPES[j], onEvent, true);
      } catch (ignored3) {}
    }
    w.__ubbDelivery17 = true;
  }
  var el0 = document.documentElement || document.body;
  if (el0 && el0.getAttribute && el0.getAttribute(ATTR) === null) el0.setAttribute(ATTR, '');
  return { recorder: true, installed: true };
}

/** One round trip over SEVERAL frames in a SINGLE chrome.scripting call, with a
 *  per-frame fallback: one dead or unreachable frame must not cost the evidence
 *  of the frames that do answer. Returns null when there is no DOM channel.
 *  `extraArgs` (fix20) rides along so the reader can be TARGETED (want types). */
async function deliveryRound(tabId, frames, func, extraArgs) {
  const ex = chrome.scripting && chrome.scripting.executeScript;
  if (typeof ex !== 'function') return null;
  const call = async (list) => {
    const r = await settle(
      ex.call(chrome.scripting, { target: { tabId, frameIds: list }, func, args: [extId(), ...(extraArgs || [])] }),
      PASS_DELIVERY_PEEK_MS,
    );
    if (r.status !== 'ok') return [];
    const v = Array.isArray(r.value) ? r.value : [];
    return v.map((item, i) => ({ f: item && Number.isInteger(item.frameId) ? item.frameId : list[i], result: item && item.result }));
  };
  let rows = await call(frames);
  if (!rows.length && frames.length > 1) {
    const each = await Promise.all(frames.map((f) => call([f])));
    rows = [];
    for (const list of each) rows.push(...list);
  }
  return rows;
}

/** Read every covered document's delivery ring. `byFrame` matters: each frame's
 *  ring numbers its own records from 1, so a "newer than the baseline" test is
 *  only sound PER frame. fix20: PASS_DELIVERY_MAX_FRAMES became a PER-ROUND-TRIP
 *  chunk size, not a coverage cap — the whole covered set is read in chunks, so
 *  a 20-frame page no longer degrades取证 to its first 8 documents (the ">8帧
 *  保守降级" residual). Each chunk costs one executeScript call; a targeted
 *  `want.types` keeps the payload small. */
async function deliveryPeek(tabId, frames, want) {
  const list = (Array.isArray(frames) && frames.length ? frames : [0]).filter((f) => Number.isInteger(f) && f >= 0);
  if (!list.length) list.push(0);
  const out = { ok: false, recorder: false, records: [], seq: 0, byFrame: new Map(), veil: null, hosts: 0, channel: null, frames: list };
  const rows = [];
  for (let i = 0; i < list.length; i += PASS_DELIVERY_MAX_FRAMES) {
    const chunk = list.slice(i, i + PASS_DELIVERY_MAX_FRAMES);
    const part = await deliveryRound(tabId, chunk, __ubbFrameDeliveryRead, want ? [want] : []);
    if (part && part.length) rows.push(...part);
  }
  if (rows.length) {
    for (const row of rows) {
      const res = row.result;
      // a stub/orphan that answers with the WRONG shape is not a recorder either
      if (!res || typeof res.recorder !== 'boolean' || !Array.isArray(res.records)) continue;
      out.ok = true;
      out.channel = 'scripting';
      out.byFrame.set(row.f, Number(res.seq) || 0);
      if (res.recorder) out.recorder = true;
      out.hosts += Number(res.hosts) || 0;
      if (res.veil) out.veil = res.veil;
      const org = Array.isArray(res.origin) && res.origin.length === 2 ? res.origin : null;
      for (const rec of res.records) {
        const r2 = { ...rec, frameId: row.f };
        if (org) {
          r2.ox = org[0];
          r2.oy = org[1];
        }
        out.records.push(r2);
      }
    }
  }
  if (!out.ok) {
    // the message world's channel: a harness without chrome.scripting, or a frame
    // the DOM channel cannot reach. ONE addressed query, never a broadcast.
    const f = list.length === 1 ? list[0] : 0;
    const a = await frameMsg(tabId, f, { type: 'UBB_DELIVERY_QUERY' }, PASS_DELIVERY_PEEK_MS);
    const rep = a && a.reply;
    if (a && a.delivered && rep && typeof rep.recorder === 'boolean' && Array.isArray(rep.records)) {
      out.ok = true;
      out.channel = 'message';
      out.recorder = !!rep.recorder;
      out.byFrame.set(f, Number(rep.seq) || 0);
      for (const rec of rep.records) out.records.push({ ...rec, frameId: f });
    }
    return out;
  }
  out.records.sort((a, b) => a.seq - b.seq || a.frameId - b.frameId);
  out.seq = out.records.length ? out.records[out.records.length - 1].seq : 0;
  return out;
}

/** Make sure every covered document CAN answer, and report which ones then do.
 *  Frames > 0 get the ring installed (the top document already carries one from
 *  content/shield.js itself). A frame that refuses installation is a HOLE in the
 *  evidence, and the caller must degrade to its old ack-only behaviour instead of
 *  refusing an input that did land somewhere we cannot see.
 *
 *  LIVENESS IS PART OF THE ANSWER, not a detail: only a live listener can note an
 *  event, so a document whose message world is dead cannot answer for delivery at
 *  all — the DOM-forced door still lets the agent's mouse through, and refusing
 *  that tab would be a new lie in the other direction. So `recorder:true` in the
 *  DOM is necessary but not sufficient: the addressed UBB_DELIVERY_QUERY has to be
 *  answered by a world (top document), or the injection has to have succeeded
 *  (a subframe — that injection IS a live isolated world). */
async function deliveryCoverage(tabId, frames) {
  const list = (Array.isArray(frames) && frames.length ? frames : [0]).filter((f) => Number.isInteger(f) && f >= 0);
  const sub = list.filter((f) => f > 0);
  const installed = new Set();
  // fix20: install in PER-ROUND-TRIP chunks over ALL subframes, not the first
  // 8 — beyond-8 frames were the hole that silently turned取证 unprovable.
  for (let i = 0; i < sub.length; i += PASS_DELIVERY_MAX_FRAMES) {
    const rows = await deliveryRound(tabId, sub.slice(i, i + PASS_DELIVERY_MAX_FRAMES), __ubbFrameDeliveryInstall);
    for (const row of rows || []) if (row.result && row.result.recorder === true) installed.add(row.f);
  }
  return { frames: list, installed };
}

/** The top document's own live answer for delivery (its ring AND its listener). */
async function deliveryLiveness(tabId, frameId) {
  const f = Number.isInteger(frameId) && frameId > 0 ? frameId : 0;
  const a = await frameMsg(tabId, f, { type: 'UBB_DELIVERY_QUERY' }, PASS_DELIVERY_PEEK_MS);
  const rep = a && a.reply;
  return {
    alive: !!(a && a.delivered && rep && typeof rep.recorder === 'boolean'),
    seq: rep && Number.isFinite(rep.seq) ? rep.seq : null,
    records: rep && Array.isArray(rep.records) ? rep.records : null,
  };
}

/** `expect` is what the ACTION knows it dispatched, stated in the page's own
 *  event names: [{types:['mousedown'], at:[x,y]}, {types:['mouseup','click']}].
 *  ALL groups must be satisfied, so a click is proven by the whole press+release
 *  pair arriving, not by "some event happened". */
function normalizeExpect(expect) {
  const groups = [];
  for (const g of Array.isArray(expect) ? expect : []) {
    if (!g) continue;
    const types = (Array.isArray(g.types) ? g.types : []).map((t) => String(t).toLowerCase()).filter(Boolean);
    if (!types.length) continue;
    const at = Array.isArray(g.at) && typeof g.at[0] === 'number' && typeof g.at[1] === 'number' ? g.at : null;
    groups.push({
      types,
      at,
      tol: Number.isFinite(g.tol) ? g.tol : PASS_DELIVERY_TOL_PX,
      // a POINTER MOVE is the only input whose duplicate is harmless — everything
      // else (press, release, key, text) is at most once per action, by rule below
      move: types.every((t) => t === 'mousemove' || t === 'mousemoved'),
    });
  }
  return groups;
}

function freshRecords(peek, base) {
  const out = [];
  for (const r of peek.records) {
    const floor = base && base.byFrame ? base.byFrame.get(r.frameId) : 0;
    if (r.seq > (Number.isFinite(floor) ? floor : 0)) out.push(r);
  }
  return out;
}

/** fix20 THE TOLERANCE, MADE TESTABLE. When the action states a dispatch point,
 *  a record counts as evidence of THAT point only if:
 *    · the record carries the hit element's box (ring field 10, recorded by the
 *      page at event time) → the dispatch point, translated into the record's
 *      frame-local space via the frame's composed origin, lies INSIDE that box
 *      inflated by PASS_HIT_TOL_PX. A point 1px inside the box passes; a point
 *      outside the box by more than PASS_HIT_TOL_PX does not — even if the type
 *      matches and the tag matches, which is precisely the LIVE-RESULTS-6 hole
 *      ("hit answered button" while the point sat ~9px above the real button).
 *    · no box (a ring from before fix20) → the old centre-distance rule under
 *      the caller's tol, so existing documents keep their semantics.
 *  Subframe records are compared in frame-local space when the reader composed
 *  the origin (same-origin chain); without an origin the coordinate check cannot
 *  be honest, so it is skipped per record — never applied with top coordinates. */
function recordAtOK(g, r) {
  if (!g.at) return true;
  let ex = g.at[0];
  let ey = g.at[1];
  if (r.frameId && r.frameId !== 0) {
    if (typeof r.ox !== 'number' || typeof r.oy !== 'number') return true;
    ex -= r.ox;
    ey -= r.oy;
  }
  if (Array.isArray(r.box) && r.box.length === 4) {
    return ex >= r.box[0] - PASS_HIT_TOL_PX && ex <= r.box[2] + PASS_HIT_TOL_PX && ey >= r.box[1] - PASS_HIT_TOL_PX && ey <= r.box[3] + PASS_HIT_TOL_PX;
  }
  if (typeof r.x !== 'number' || typeof r.y !== 'number') return false;
  return Math.abs(r.x - ex) <= g.tol && Math.abs(r.y - ey) <= g.tol;
}

/** THE point of the whole mechanism: a record whose shield_hit is true is NOT
 *  evidence of delivery, however fresh it is — it is the record of this extension
 *  eating its own agent's input. */
function matchDelivery(fresh, groups) {
  const used = new Set();
  const matched = [];
  const missing = [];
  for (const g of groups) {
    let found = null;
    for (const r of fresh) {
      if (used.has(r)) continue;
      if (r.shield_hit === true) continue;
      if (g.types.indexOf(String(r.type).toLowerCase()) < 0) continue;
      if (g.at && !recordAtOK(g, r)) continue;
      found = r; // newest match wins (fresh is in seq order)
    }
    if (!found) {
      missing.push(g);
      continue;
    }
    used.add(found);
    matched.push(found);
  }
  return { ok: groups.length > 0 && missing.length === 0, matched, missing };
}

/** Wait (bounded) for the document to admit it received what we dispatched.
 *  fix20: every poll is a TARGETED read — only the event types this action
 *  expects are pulled out of each ring — and the fan-out covers ALL frames in
 *  per-round-trip chunks, so ">8 frames" is a cost profile (ceil(N/8) calls per
 *  poll), not an evidence cliff. */
async function awaitDelivery(tabId, frames, base, groups, budgetMs) {
  const want = { types: [...new Set(groups.reduce((all, g) => all.concat(g.types), []))] };
  const t0 = Date.now();
  let last = null;
  for (;;) {
    const peek = await deliveryPeek(tabId, frames, want);
    const fresh = freshRecords(peek, base);
    const eaten = fresh.filter((r) => r.shield_hit === true);
    const m = matchDelivery(fresh, groups);
    const waited = Date.now() - t0;
    // FAIL FAST when the document says our own veil ate every event we are still
    // missing: the queue already drained those, and another 6s of polling cannot
    // un-eat them. (This is the shape of the old bug — a fresh record whose target
    // is our overlay — so it is also the shape that must NOT keep burning budget.)
    const allEaten =
      m.missing.length > 0 &&
      m.missing.every((g) => fresh.some((r) => r.shield_hit === true && g.types.indexOf(String(r.type).toLowerCase()) >= 0));
    last = {
      delivered: m.ok,
      ms: waited,
      seen: fresh.length,
      eaten: eaten.length,
      // fix20: matched evidence is AUDIT-READABLE — id/cls/text/box say WHICH
      // element the page received it on, so "打到的是不是我要的那个元素" is a
      // question the ring entry answers, not one a tag name hides.
      matched: m.matched.map((r) => ({
        type: r.type,
        x: r.x,
        y: r.y,
        seq: r.seq,
        frameId: r.frameId,
        id: r.id || null,
        cls: r.cls || null,
        aria: r.aria || null,
        text: r.text || null,
        box: r.box || null,
      })),
      missing: m.missing.map((g) => g.types.join('/')),
      last_shield_hit: fresh.length ? fresh[fresh.length - 1].shield_hit === true : null,
      veil: peek.veil,
      channel: peek.channel,
      eaten_all: allEaten,
    };
    if (last.delivered || last.eaten_all || waited >= budgetMs) return last;
    await sleep(Math.min(PASS_DELIVERY_POLL_MS, Math.max(1, budgetMs - waited)));
  }
}

/** RESEND POLICY — read this before adding a caller.
 *  Only a duplicate POINTER MOVE is harmless. A press/release pair or a key that
 *  we failed to SEE may have been swallowed by a page listener that ran BEFORE
 *  our capture listener (a document-start script, another world we cannot reach),
 *  in which case the page DID act on it and a resend double-fires it — a second
 *  submit, a second purchase, a second POST. The evidence channel cannot tell
 *  "never delivered" apart from "delivered, unrecorded", so:
 *    · move-only action  → resend once (idempotent: the pointer just ends up there)
 *    · press/release/key/text → NEVER auto-resend; refuse loudly instead and let
 *      the agent decide, because the agent is the only party that knows whether a
 *      repeat is safe on that page.
 *  Callers pass `opts.resend` only for the first kind. */
function resendAllowed(groups, res) {
  if (!res || !Array.isArray(res.missing) || !res.missing.length) return false;
  const unsatisfied = groups.filter((g) => res.missing.some((m) => String(m).split('/').indexOf(g.types[0]) >= 0));
  return unsatisfied.length > 0 && unsatisfied.every((g) => g.move === true);
}

function deliveryFailure(tabId, gate, res, base) {
  const seen = res ? res.seen : 0;
  const eaten = res ? res.eaten : 0;
  return err(
    'INPUT_NOT_DELIVERED',
    `遮挡在派发点上确实是开着的、CDP 也立刻 ack 了，但在 ${res ? res.ms : 0}ms 的投递取证里，目标文档没有记下一条"投到了页面元素"的受信输入事件（新增记录 ${seen} 条，其中 ${eaten} 条落在本扩展自己的遮罩上：veil 当刻=${res ? res.veil : '?'}）。工具不能把这件事报成成功：这一步页面要么根本没收到，要么被我们看不见的世界截走了。下一步（三选一，别原样重试）：① 让这个标签真的置于前台 —— tab.select 只激活标签，被别的窗口挡住时 visibilityState 仍然是 hidden，请让用户把挡住它的窗口点到后面/最小化，或把 UBB 窗口提到前面；② 改走桥的合成事件通路（先 snapshot 拿 @d ref，再 click/fill 走 DOM 事件），它不进这条投递队列；③ request_help 把这一步交回用户。`,
    {
      tab_id: tabId,
      token: gate ? gate.token : null,
      waited_ms: res ? res.ms : null,
      records_seen: seen,
      records_on_own_veil: eaten,
      missing_events: res ? res.missing : null,
      matched_events: res ? res.matched : null,
      veil_at_read: res ? res.veil : null,
      last_shield_hit: res ? res.last_shield_hit : null,
      channel: res ? res.channel : null,
    },
  );
}

function makeGate(tabId, txn) {
  // fix16 probe (Q1+Q2 per dispatched event, Q3 as the burst total): one entry for
  // the whole dispatch burst, logged on release, so a 19-event human click costs
  // one ring slot, not nineteen.
  const probe = { checks: [], dropped: 0, ms: 0, max_ms: 0, refused: null, logged: false, delivery: null };
  const recordCheck = (v, ms, at, refusedReason) => {
    probe.ms += ms;
    if (ms > probe.max_ms) probe.max_ms = ms;
    const { ms: roundMs, ...rest } = roundProbe(v && v.probe);
    const entry = { i: probe.checks.length + probe.dropped + 1, at: at || null, ms, round_ms: roundMs, ...rest };
    if (refusedReason) entry.refused = String(refusedReason).slice(0, 140);
    if (probe.checks.length < PASS_PROBE_CHECKS) probe.checks.push(entry);
    else if (refusedReason) {
      probe.checks[PASS_PROBE_CHECKS - 1] = entry; // the refusal outranks a routine check
      probe.dropped++;
    } else probe.dropped++;
    if (refusedReason && !probe.refused) probe.refused = String(refusedReason).slice(0, 220);
  };
  const logDispatch = () => {
    if (probe.logged) return;
    probe.logged = true;
    const d = probe.delivery || {};
    passProbeLog({
      phase: 'dispatch',
      tab_id: tabId,
      token: txn.token,
      at: txn.at,
      keys: !!txn.keys,
      checks: probe.checks.length + probe.dropped,
      dropped_checks: probe.dropped,
      ms: probe.ms,
      slowest_check_ms: probe.max_ms,
      verdicts: probe.checks.map((c) => c.verdict),
      refused: probe.refused,
      detail: probe.checks,
      // fix17 APPENDED to the fix16 probe (nothing above changed): what the
      // document itself admitted receiving. `delivery_verdict` is the closed
      // vocabulary — proven / not_delivered / unprovable / not_requested.
      delivery_verdict: d.verdict || 'not_requested',
      delivery_ms: typeof d.ms === 'number' ? d.ms : null,
      delivery_records_seen: typeof d.seen === 'number' ? d.seen : null,
      last_shield_hit: d.last_shield_hit === undefined ? null : !!d.last_shield_hit,
      delivery_eaten: typeof d.eaten === 'number' ? d.eaten : null,
      delivery_missing: d.missing || null,
      delivery_retried: d.retried === true,
      delivery_channel: d.channel || null,
      delivery_reason: d.reason || null,
    });
  };
  const fail = (reason) => {
    // the door is shut on the way out of a failed confirmation too, so a
    // rejected action never leaves the page half-open for the user
    capped(closeTxn(tabId, txn.token), PASS_RELEASE_MS);
    return err(
      'SHIELD_PASS_FAILED',
      `遮挡在本动作的派发点上又合上了（${reason}），所以从这里起一条输入事件都没有发出（前面已发的事件不在本次保证内）。下一步：让用户点盾牌状态条上的「■ 停止代理」（切到 paused，遮罩立即开门）；或在扩展 popup 把 shield 模式改成 border/off；若报"别家的遮挡层/文档内多个 host"，在 chrome://extensions 重载扩展；这个标签也可以 tab.release 再 tab.claim 重新接管。`,
    );
  };
  const gate = {
    token: txn.token,
    frameId: txn.frameId,
    at: txn.at,
    keys: txn.keys,
    frames: [...txn.frames],
    /** Prove THIS point, right now, immediately before one Input.* dispatch.
     *  An action whose pointer travels (drag) passes the coordinate it is about
     *  to use; without an argument the transaction's own point is confirmed. */
    async check(point) {
      if (!ledger.get(tabId)?.has(txn.token)) {
        recordCheck(null, 0, null, 'pass 事务已被撤销（标签被关/被释放）');
        logDispatch();
        throw fail('本次 pass 事务已被撤销（标签被关/被释放）');
      }
      const at = Array.isArray(point) && typeof point[0] === 'number' && typeof point[1] === 'number' ? point : txn.at;
      const tc = Date.now();
      const v = await confirmTxn(tabId, { ...txn, at }, false);
      if (!v.confirmed) {
        recordCheck(v, Date.now() - tc, at, v.reason);
        logDispatch();
        throw fail(v.reason);
      }
      recordCheck(v, Date.now() - tc, at, null);
      armDeadline(tabId, txn); // heartbeat: an actively dispatching transaction owns its deadline
      activeGate.set(tabId, gate);
      return v;
    },
    release() {
      logDispatch(); // the evidence of THIS action's dispatch burst, whatever follows
      return closeTxn(tabId, txn.token);
    },
    /** fix17: what the document itself admitted receiving. Written before
     *  release() so the SAME ring entry that carries the fix16 verdicts also
     *  carries delivery_ms / delivery_records_seen / last_shield_hit. */
    noteDelivery(info) {
      probe.delivery = info || null;
    },
  };
  return gate;
}

/**
 * Prove the veil is actually open in the document that will receive the input
 * BEFORE any event is dispatched. Unconfirmed → throw SHIELD_PASS_FAILED; the
 * alternative was the LIVE-RESULTS #1 lie (a {clicked:...} for an event the
 * page never saw).
 */
export async function ensurePass(tabId, opts = {}) {
  const frames = await tabFrames(tabId);
  const txn = registerTxn(tabId, {
    token: nextToken(),
    frameId: Number.isInteger(opts.frameId) && opts.frameId >= 0 ? opts.frameId : null,
    at: Array.isArray(opts.at) && typeof opts.at[0] === 'number' && typeof opts.at[1] === 'number' ? opts.at : null,
    keys: opts.keys === true,
    // one deadline per transaction — a shared TTL is how an earlier action kept
    // (or lost) a later one's door
    ttl: Number.isFinite(opts.ttlMs) && opts.ttlMs > 0 ? Math.min(opts.ttlMs, 120000) : PASS_TXN_TTL_MS,
    frames: new Set(passFramesFor(opts, frames)),
    deadline: 0,
    timer: null,
  });
  let last = { confirmed: false, reason: '未执行' };
  const t0 = Date.now();
  let attempts = 0;
  // fix16 probe bookkeeping for Q3 ("where did the ~5000ms go"). Nothing here
  // changes the verdict or the control flow — the numbers are collected on the
  // way past the existing branches and logged at both exits (return and throw).
  const rounds = [];
  let releaseMs = 0;
  let sleepMs = 0;
  let budgetStopped = false;
  for (let attempt = 0; attempt < 2; attempt++) {
    attempts = attempt + 1;
    last = await confirmTxn(tabId, txn);
    rounds.push(roundProbe(last.probe));
    if (last.confirmed) {
      const gate = makeGate(tabId, txn);
      activeGate.set(tabId, gate);
      const ms = Date.now() - t0;
      const { ms: frMs, ...fr } = roundProbe(last.probe);
      passProbeLog({
        phase: 'open',
        tab_id: tabId,
        token: txn.token,
        frame_id: txn.frameId,
        at: txn.at,
        keys: !!txn.keys,
        attempts,
        ...fr,
        round_ms: frMs,
        ms,
        budget_ms: PASS_CONFIRM_BUDGET_MS,
        over_budget_ms: ms > PASS_CONFIRM_BUDGET_MS,
        // RECORD ONLY, on purpose: an action may spend its whole gate budget and
        // still come back confirmed — the budget check below sits on the FAILURE
        // branch, so "5043-5076ms + ok:true" (LIVE-RESULTS-5) is legal here. That
        // is next round's target, not this round's change.
        over_budget_ok: ms > PASS_CONFIRM_BUDGET_MS && last.confirmed === true,
        budget_stopped: false,
        release_ms: releaseMs,
        sleep_ms: sleepMs,
        slowest: slowestRound(rounds),
        rounds,
        acks: (last.probe && last.probe.acks) || null,
        doms: (last.probe && last.probe.doms) || null,
        reason: null,
      });
      return { ...gate, verdict: last, dom: last.dom || null, via: last.via || 'dom' };
    }
    const tr = Date.now();
    await capped(closeTxn(tabId, txn.token), PASS_RELEASE_MS);
    releaseMs += Date.now() - tr;
    // A refusal must arrive inside the action's own budget, not after it. The
    // second attempt exists for the "the door re-closed a moment ago" race, and
    // it is worthless when the first attempt already burned most of the tool's
    // time: LIVE-RESULTS-3A 8-4 burned secret.fill's whole 25s on a gate that was
    // never going to open, and reported TOOL_TIMEOUT instead of the reason.
    if (Date.now() - t0 > PASS_CONFIRM_BUDGET_MS) {
      budgetStopped = true;
      last = { ...last, reason: `${last.reason}（第二轮确认没再付：本动作已在闸门上花掉 ${Date.now() - t0}ms）` };
      break;
    }
    const ts = Date.now();
    await sleep(PASS_RETRY_DELAY_MS);
    sleepMs += Date.now() - ts;
    if (attempt === 0) {
      // a second, independent transaction: the failed one's token is gone, so
      // whatever closed the door has to answer for the new one too
      txn.token = nextToken();
      registerTxn(tabId, txn);
    }
  }
  const ms = Date.now() - t0;
  const { ms: frMs, ...fr } = roundProbe(last.probe);
  passProbeLog({
    phase: 'open',
    tab_id: tabId,
    token: txn.token,
    frame_id: txn.frameId,
    at: txn.at,
    keys: !!txn.keys,
    attempts,
    ...fr,
    round_ms: frMs,
    ms,
    budget_ms: PASS_CONFIRM_BUDGET_MS,
    over_budget_ms: ms > PASS_CONFIRM_BUDGET_MS,
    over_budget_ok: false,
    budget_stopped: budgetStopped,
    release_ms: releaseMs,
    sleep_ms: sleepMs,
    slowest: slowestRound(rounds),
    rounds,
    acks: (last.probe && last.probe.acks) || null,
    doms: (last.probe && last.probe.doms) || null,
    reason: String(last.reason || '').slice(0, 220),
  });
  throw err(
    'SHIELD_PASS_FAILED',
    `控制遮罩没有让路，鼠标/键盘事件一定会被盾牌吃掉，所以本次没有向页面发出任何输入（尝试 ${attempts} 次独立 pass 事务、每次都做 DOM 点位回读，共 ${Date.now() - t0}ms）。${last.reason} — 下一步：让用户点盾牌状态条上的「■ 停止代理」（切到 paused，遮罩立即开门，动作即可正常）；或在扩展 popup 把 shield 模式从 block 改成 border/off；若报"别家的遮挡层/文档内 2 个 host"，说明页面上叠了第二份 .ubb-host-root（重复加载的扩展副本或重载后残留的内容脚本世界），在 chrome://extensions 重载扩展后重试；这个标签也可以 tab.release 再 tab.claim 重新接管。`,
  );
}

/** Wrap an agent-input action in pass-through gating. The action gets the gate
 *  as an argument so it can re-confirm its own point before each event.
 *
 *  fix17 TIMING — the door does not close on the ack any more:
 *    ensurePass (open + prove)            → the point is provably clear
 *    deliveryPeek (baseline, per frame)   → what the document had ALREADY seen
 *    fn(gate)                              → the CDP Input.* burst (acks fast)
 *    awaitDelivery (poll ~250ms, ≤7s)     → a FRESH record of that event landing
 *                                            on a page element, not on our veil
 *    release()                             → only now, after the evidence
 *  Two consequences, both intended:
 *   ① the hidden-tab case is FIXED, not just detected: holding the door open
 *      across the queue delay means the event arrives while the veil is still
 *      pointer-events:none, so it reaches the page (~5s slower, honest).
 *   ② an action that returns ok:true now carries page-side evidence. No evidence
 *      where evidence was obtainable → INPUT_NOT_DELIVERED, never ok:true.
 *  `opts.expect` opts an action in (see normalizeExpect); `opts.delivery` is an
 *  object the caller gets back so it can put delivered/delivery_ms in its own
 *  result shape; `opts.resend` is only ever allowed for a move-only action (see
 *  resendAllowed for why a press/release/key is never auto-repeated).
 *  Without `expect` the shape is exactly the old one — callers outside the input
 *  tools (replay, secrets, a JS-only DOM write) must not be charged for a trusted
 *  event they never dispatch. */
export async function withPass(tabId, fn, opts = {}) {
  const gate = await ensurePass(tabId, opts);
  const out = opts.delivery && typeof opts.delivery === 'object' ? opts.delivery : null;
  const groups = normalizeExpect(opts.expect);
  const named = Number.isInteger(gate.frameId) ? gate.frameId : null;
  const frames = gate.frames && gate.frames.length ? [...gate.frames] : [0];
  let base = null;
  let provable = false;
  let whyNot = null;
  let pollFrames = frames;
  if (groups.length) {
    // which documents could receive this event: the frame the action named (plus
    // the top document, which is where the veil would have eaten it), or every
    // frame the transaction covers when the action did not name one.
    const want = named === null ? frames : [...new Set([0, named])];
    pollFrames = want;
    const cov = await deliveryCoverage(tabId, want);
    const peek = await deliveryPeek(tabId, cov.frames);
    // fix20: coordinates are NO LONGER thrown away for non-top actions. Each
    // subframe record now arrives in ITS OWN viewport space plus, when the
    // same-origin frameElement chain composed one, a top-viewport origin (r.ox/
    // r.oy); recordAtOK translates the dispatch point per record. A frame whose
    // origin cannot be composed degrades THAT record to type-only — an honest,
    // documented limit, unlike the old blanket g.at=null for every subframe and
    // the old ">8 frames ⇒ nobody gets取证" cap.
    const live = peek.ok && peek.recorder ? await deliveryLiveness(tabId, 0) : { alive: false };
    const answers = (f) => (f === 0 ? peek.byFrame.has(0) && live.alive : cov.installed.has(f) && peek.byFrame.has(f));
    // fix20: the covered list is read COMPLETELY (in per-round-trip chunks), so a
    // frame beyond 8 is no longer a hole; a frame that genuinely does not answer
    // is, and a hole still degrades to "unprovable" — it must never become a
    // refusal of an input that did land in a document we could not reach.
    provable = !!peek.ok && !!peek.recorder && want.every(answers);
    if (!provable) {
      whyNot = !peek.ok
        ? '没有一条投递通路可问（既没有 chrome.scripting 回读，也没有人应答 UBB_DELIVERY_QUERY）'
        : !peek.recorder
          ? '那个文档里没有投递记录环（早于 fix17 的内容脚本世界；重载扩展或走一次导航以后才有）'
          : live.alive
            ? `文档 ${want.filter((f) => !answers(f)).join('/')} 没有可记录的活世界（或被并发占满，没有全部读到）`
            : '主文档没有活世界应答投递记录（孤儿世界：DOM 强开得了门，但那里没人记账）';
    } else {
      base = { byFrame: peek.byFrame, at: Date.now() };
    }
  }
  const report = (info) => {
    if (out) Object.assign(out, info);
    if (typeof gate.noteDelivery === 'function') gate.noteDelivery(info);
  };
  let ran;
  try {
    ran = await fn(gate);
  } catch (e) {
    // a failed action never leaves the page half-open — release on the way out
    await capped(gate.release(), PASS_RELEASE_MS);
    throw e;
  }
  if (!groups.length) {
    report({ verdict: 'not_requested', reason: 'no expect: the gate keeps its ack-only shape' });
    await capped(gate.release(), PASS_RELEASE_MS);
    return ran;
  }
  if (!provable) {
    // cannot prove, and that is said out loud instead of being turned into a
    // success: no ring in that document (a content-script world older than
    // fix17), or a frame whose recorder we could not install
    report({ verdict: 'unprovable', delivered: null, reason: 'no delivery ring in the document that receives this event' });
    await capped(gate.release(), PASS_RELEASE_MS);
    return ran;
  }
  let res = await awaitDelivery(tabId, frames, base, groups, PASS_DELIVERY_BUDGET_MS);
  let retried = false;
  if (!res.delivered && typeof opts.resend === 'function' && resendAllowed(groups, res)) {
    // SAFE-RESEND CASE ONLY: a pointer MOVE. Keeping the door open is what makes
    // the repeat meaningful — releasing first is exactly the bug being fixed.
    retried = true;
    try {
      await opts.resend();
    } catch {}
    const again = await awaitDelivery(tabId, frames, base, groups, PASS_DELIVERY_RETRY_MS);
    if (again.delivered) res = again;
  }
  if (!res.delivered) {
    report({
      verdict: 'not_delivered',
      delivered: false,
      ms: res.ms,
      seen: res.seen,
      eaten: res.eaten,
      missing: res.missing,
      last_shield_hit: res.last_shield_hit,
      channel: res.channel,
      retried,
      reason: res.eaten ? 'fresh records landed on this extension’s own veil' : 'no fresh record reached a page element',
    });
    // the door goes shut on the refusal too: a red action must not leave the
    // user's page unshielded while the agent decides what to do next
    await capped(gate.release(), PASS_RELEASE_MS);
    throw deliveryFailure(tabId, gate, res, base);
  }
  report({
    verdict: 'proven',
    delivered: true,
    ms: res.ms,
    seen: res.seen,
    eaten: res.eaten,
    matched: res.matched,
    last_shield_hit: res.last_shield_hit,
    channel: res.channel,
    retried,
  });
  // RELEASE AFTER THE EVIDENCE, never before it: this ordering is the fix, and
  // test-delivery.mjs pins it (release timestamp must be later than delivery).
  await capped(gate.release(), PASS_RELEASE_MS);
  return ran;
}

/** One line for lib/actions.js: `mouse()`/`key()` await this right before
 *  cdp.send and every withPass caller — including the ones outside this lane
 *  (replay, secrets, actions' own frame fill) — gets the per-dispatch point
 *  confirmation for free. No open transaction = nothing to confirm, so read-only
 *  paths never pay for it. */
export async function assertInputGate(tabId) {
  const gate = activeGate.get(tabId);
  if (!gate) {
    // fix16 probe, throttled: an Input.* about to go out with NO open pass
    // transaction is the one dispatch shape the gate cannot prove at all
    // (withPass-less caller, or the transaction was revoked mid-action). One entry
    // per tab per PASS_PROBE_NOGATE_MS, so a 19-event burst stays one line.
    const now = Date.now();
    if (now - (noGateProbeAt.get(tabId) || 0) >= PASS_PROBE_NOGATE_MS) {
      noGateProbeAt.set(tabId, now);
      passProbeLog({
        phase: 'dispatch',
        tab_id: tabId,
        verdict: 'no-open-pass',
        checks: 0,
        ms: 0,
        note: '这条派发前没有开着的 pass 事务，闸门没有确认过这个点（不是"确认通过了"）',
      });
    }
    return { checked: false, reason: 'no_open_pass' };
  }
  return gate.check();
}

export const shield = {
  /** arm / update the shield on a tab */
  async set(tabId, { mode = 'armed', label = 'UBB agent control', status = '' } = {}) {
    const stored = (await chrome.storage.local.get('ubb_shield_mode')).ubb_shield_mode || 'block';
    // remember who is under control: chrome.storage.session outlives the worker,
    // and the 30s sweep needs the list after a restart to close doors nobody
    // claims any more (see SHIELD_SWEEP_ALARM)
    if (mode === 'armed' || mode === 'paused') {
      await restoreControlledTabs();
      rememberControlled(tabId);
    } else forgetControlled(tabId);
    return msg(tabId, { type: 'UBB_SHIELD', mode, label, status, blockMode: stored });
  },
  async disarm(tabId) {
    forgetControlled(tabId);
    return msg(tabId, { type: 'UBB_SHIELD', mode: 'off' });
  },
  /** Temporarily let agent CDP input pass through the veil (tool-use gate).
   *  ADDRESSED to one frame: the old broadcast ack proved nothing about the
   *  document the input lands in. Prefer withPass()/ensurePass() — they verify
   *  and they hold a TOKEN; this legacy shape owns one synthetic transaction
   *  ('legacy') that a second caller cannot corrupt by accident. */
  async pass(tabId, on, frameId = 0) {
    const r = await frameMsg(tabId, frameId, {
      type: 'UBB_PASS',
      op: on ? 'open' : 'close',
      token: 'legacy',
      ttlMs: PASS_TXN_TTL_MS,
      on: !!on,
    });
    return r.reply ?? { ok: false, delivered: r.delivered };
  },
  /** Read the shield state of ONE frame (0 = main), bounded. */
  async queryFrame(tabId, frameId = 0) {
    return frameMsg(tabId, frameId, { type: 'UBB_SHIELD_QUERY' });
  },
  /** Read current shield state without changing it. */
  async query(tabId) {
    return msg(tabId, { type: 'UBB_SHIELD_QUERY' });
  },
  /** Hide/show the whole shield (screenshot + print/PDF hygiene). The shield
   *  only ever runs in the TOP document (manifest all_frames:false), so this is
   *  ADDRESSED to frame 0: a broadcast reply can come from any subframe's
   *  content script and proves nothing about the document being rendered. */
  async visible(tabId, on) {
    return frameMsg(tabId, 0, { type: 'UBB_VISIBLE', on: !!on });
  },
  /** On-page confirmation banner; resolves true/false. */
  async confirm(tabId, title, timeoutMs = 60000) {
    const reqId = Math.random().toString(36).slice(2);
    const p = new Promise((resolve) => {
      pendingConfirms.set(reqId, { resolve });
      setTimeout(() => {
        if (pendingConfirms.has(reqId)) {
          pendingConfirms.delete(reqId);
          resolve(false);
        }
      }, timeoutMs);
    });
    const r = await msg(tabId, { type: 'UBB_CONFIRM', reqId, title, timeoutMs });
    if (r?.unreachable) {
      pendingConfirms.delete(reqId);
      // Content script not reachable (e.g. before injection): be safe, deny.
      return false;
    }
    return p;
  },

  /** Non-blocking "please do X in this page" assistance banner. The page
   *  stays fully usable: the veil stops blocking while the banner is up. */
  async help(tabId, { reqId, title, timeoutMs }) {
    return msg(tabId, { type: 'UBB_HELP', reqId, title, timeoutMs });
  },

  /** Close the assistance banner (conditions met / timed out / aborted). */
  async helpClose(tabId, reqId) {
    return msg(tabId, { type: 'UBB_HELP_CLOSE', reqId });
  },

  /** Route a UBB_HELP_RESULT from the content script to the waiting tool. */
  helpResult(reqId, ok) {
    const p = pendingHelp.get(reqId);
    if (p) {
      pendingHelp.delete(reqId);
      p.resolve(!!ok);
    }
  },
};

/** Fire-and-forget with a cap: a modal JS dialog freezes content scripts,
 *  so shield messages must never block tool execution. */
function capped(promise, ms = 400) {
  return Promise.race([promise.catch(() => {}), sleep(ms)]);
}

/**
 * Arm a LATE-LOADING subframe (log-D §5): an iframe SPA-inserted after the
 * last arm broadcast never received UBB_SHIELD, so its frameblock listener
 * sits idle and the user could type into it while the tab is "controlled".
 * Reuses D's arm channel (the UBB_SHIELD message frameblock.js already
 * consumes) but addressed to exactly this frameId — never a broadcast, and
 * never an invented arm: the mode is QUERIED from the top shield, and a
 * paused (user-interrupted) or off tab must not silently become armed.
 */
export async function rearmFrame(tabId, frameId) {
  if (!(Number.isInteger(frameId) && frameId > 0)) return { sent: false, reason: 'main_frame' };
  let q;
  try {
    q = await shield.query(tabId);
  } catch (e) {
    return { sent: false, reason: 'shield_query_threw', error: String(e?.message || e).slice(0, 160) };
  }
  if (q && q.unreachable) {
    // msg() folds a dead channel into {ok:false,unreachable:true}; reporting that
    // as "shield_not_active" would be a verdict the query never delivered — the
    // tab may be fully armed, we simply could not ask.
    return { sent: false, reason: 'shield_unreachable', mode: null };
  }
  const st = q?.state || q;
  const mode = st?.mode;
  if (mode !== 'armed' && mode !== 'paused') return { sent: false, reason: 'shield_not_active', mode: mode || null };
  let stored;
  try {
    stored = (await chrome.storage.local.get('ubb_shield_mode')).ubb_shield_mode || 'block';
  } catch (e) {
    return { sent: false, reason: 'storage_unreadable', mode, error: String(e?.message || e).slice(0, 160) };
  }
  // the frame's document_start scripts may not have registered their listener
  // yet when onCommitted reaches us — one bounded retry, then leave it to the
  // snapshot resyncArm backstop (arm state is idempotent, so retrying is safe)
  let lastError = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await chrome.tabs.sendMessage(tabId, { type: 'UBB_SHIELD', mode, blockMode: stored }, { frameId });
      return { sent: true, mode, frameId, attempts: attempt + 1 };
    } catch (e) {
      lastError = String(e?.message || e).slice(0, 160);
      await sleep(400);
    }
  }
  return { sent: false, reason: 'frame_unreachable', mode, frameId, attempts: 2, error: lastError };
}

/**
 * Take the shield OUT OF THE RENDER TREE (display:none on the light-DOM host
 * collapses the whole shadow subtree) and prove it by reading the rendered
 * state back — not by hoping a message landed. Two channels, both needed:
 * the addressed UBB_VISIBLE makes the live world remember it (so its own
 * apply() does not paint the shield back mid-render), and the frame-addressed
 * DOM write reaches hosts whose message world is dead or wedged — which is
 * exactly the host that leaked the pill text and the entire stylesheet into
 * print_pdf output while only being made transparent.
 */
export async function hideShield(tabId) {
  const frames = await tabFrames(tabId);
  const ack = await frameMsg(tabId, 0, { type: 'UBB_VISIBLE', on: false }, PASS_MSG_TIMEOUT_MS);
  const reads = (await Promise.all(frames.map((f) => domHide(tabId, f, true)))).filter(Boolean);
  const broken = reads.find((r) => r.inject_error);
  if (broken) {
    return { proven: false, displayed: -1, inject_error: broken.inject_error, hosts: 0, ack };
  }
  if (!reads.length) {
    const st = ack.reply && (ack.reply.state || null);
    return { proven: false, via: 'ack', hosts: 0, displayed: 0, state: st, ack };
  }
  return {
    proven: true,
    hosts: reads.reduce((n, r) => n + r.hosts, 0),
    ours: reads.reduce((n, r) => n + r.ours, 0),
    displayed: reads.reduce((n, r) => n + r.displayed, 0),
    foreign: reads.reduce((n, r) => n + r.foreign, 0),
    ack,
  };
}

/** Restore to whatever apply() stamped (data-ubb-mode / data-ubb-visible), so an
 *  unarmed or user-paused tab does not light up because a render finished. */
export async function showShield(tabId) {
  const frames = await tabFrames(tabId);
  await frameMsg(tabId, 0, { type: 'UBB_VISIBLE', on: true }, 800);
  const reads = (await Promise.all(frames.map((f) => domHide(tabId, f, false)))).filter(Boolean);
  return { proven: reads.length > 0, displayed: reads.reduce((n, r) => n + r.displayed, 0) };
}

/** Wrap a capture action in shield-visibility gating. A render that still has
 *  the shield in its tree is retried once; a capture is never failed over it —
 *  the shield is in the picture, not a lie about an action. */
export async function withHiddenShield(tabId, fn) {
  let st = await hideShield(tabId);
  if (st.proven && st.displayed > 0) st = await hideShield(tabId);
  try {
    return await fn();
  } finally {
    await capped(showShield(tabId), PASS_RELEASE_MS);
  }
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
