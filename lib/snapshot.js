// Page sensing: CDP Accessibility full tree snapshot with @eN refs
// CDP Accessibility full tree snapshot with @eN refs, plus a DOM fallback tree
// through the content bridge when the AX tree is empty or too generic.
// Wave 2-D made sensing frame-aware: child documents get their own indented
// section (via their own injected bridge) and their @eN refs carry a frameId —
// those refs act through the coordinate path, never through the main-session
// node index. The coordinate path reaches SAME-PROCESS child documents only:
// the page-level debugger session has no Input channel into an
// out-of-process frame (LIVE-RESULTS-2 §6b), so actions on those frames
// refuse with FRAME_UNSUPPORTED instead of returning ok.

import { cdp, flattenFrameTree } from './cdp.js';
import { refs, MAIN_FRAME } from './refs.js';
import { err } from './config.js';
import { bridge, bridgeEnvelope } from './bridge-ctl.js';
import { shield } from './shield-ctl.js';

const INTERACTIVE_ROLES = new Set([
  'button',
  'link',
  'textbox',
  'searchbox',
  'combobox',
  'checkbox',
  'radio',
  'slider',
  'spinbutton',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
  'tab',
  'switch',
  'treeitem',
]);

const SENSITIVE_NAME = /(password|passwd|密码|otp|one[-\s]?time|验证码|cvv|cvc|card number|银行卡|卡号)/i;

function nodeName(node) {
  const v = node.name;
  if (v && typeof v === 'object') return v.value || '';
  return typeof v === 'string' ? v : '';
}

function nodeValue(node) {
  const v = node.value;
  if (v && typeof v === 'object') return v.value;
  return typeof v === 'string' ? v : undefined;
}

function flagsOf(node) {
  const f = [];
  const props = node.properties || [];
  const get = (name) => props.find((p) => p.name === name)?.value?.value;
  // CDP AX values are typed, but a string "false" is truthy. Only a real
  // boolean true may produce a state flag, otherwise an unchecked box reads
  // as checked and an editable field as readonly.
  if (get('disabled') === true) f.push('disabled');
  if (get('checked') === true) f.push('checked');
  if (get('readonly') === true) f.push('readonly');
  if (get('required') === true) f.push('required');
  if (get('expanded') === true) f.push('expanded');
  if (get('expanded') === false) f.push('collapsed');
  const popup = get('haspopup');
  if (popup != null && popup !== false && popup !== 'false') f.push('haspopup'); // hover/submenu trigger marker
  const level = get('level');
  if (typeof level === 'number') f.push(`h${level}`);
  return f;
}

// Pagination store: the full text of the most recent capture per tab, so
// next_cursor continuations re-read the SAME capture
// instead of re-walking a page that may have changed underneath.
const captures = new Map(); // tabId → { gen, nonce, text, ref_count, source, nodes }

export function dropCapture(tabId) {
  captures.delete(tabId);
}

/**
 * Take an accessibility-tree snapshot and (re)register @eN refs.
 * With `cursor` ("nonce:offset"), serve the next page of the stored capture.
 * Returns { text, ref_count, source, truncated, next_cursor }.
 */
export async function takeSnapshot(tabId, { filter = 'interactive', max_chars = 60000, cursor = null, frames = true } = {}) {
  if (cursor != null) {
    const cap = captures.get(tabId);
    if (!cap) {
      throw err('CAPTURE_GONE', 'no stored capture on this tab (service worker restarted or none taken); take a fresh snapshot');
    }
    if (cap.gen !== refs.state(tabId).gen) {
      captures.delete(tabId);
      throw err('CAPTURE_STALE', 'the page navigated since that capture; take a fresh snapshot');
    }
    const [nonce, offStr] = String(cursor).split(':');
    if (nonce !== cap.nonce) {
      throw err('CAPTURE_GONE', 'cursor belongs to an older capture; take a fresh snapshot');
    }
    const off = Math.max(0, parseInt(offStr, 10) || 0);
    const nextOff = off + max_chars;
    return {
      text: cap.text.slice(off, nextOff),
      ref_count: cap.ref_count,
      source: cap.source,
      frame_count: cap.frame_count ?? 0,
      truncated: nextOff < cap.text.length,
      next_cursor: nextOff < cap.text.length ? `${nonce}:${nextOff}` : null,
      page: { offset: off, capture_chars: cap.text.length },
      ax_debug: { nodes: cap.nodes, error: null },
    };
  }
  await cdp.ensure(tabId);
  // Edge permits debugger attach on its own internal pages, so the hub's
  // restricted-URL check never fires there — enforce it for sensing too
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (tab && cdp.isRestrictedUrl(tab.url)) {
    throw err('URL_BLOCKED', `cannot automate a restricted page: ${tab.url}`);
  }
  if (!cdp.buffers(tabId)?.enabledDomains.has('Accessibility')) {
    await cdp.send(tabId, 'Accessibility.enable').catch(() => {});
    cdp.buffers(tabId)?.enabledDomains.add('Accessibility');
  }
  let axErr = null;
  const getTree = () =>
    cdp.send(tabId, 'Accessibility.getFullAXTree').catch((e) => {
      axErr = String(e?.message || e);
      return null;
    });
  let tree = await getTree();
  for (let i = 0; i < 2 && (!tree || !Array.isArray(tree.nodes) || tree.nodes.length < 2); i++) {
    await new Promise((r) => setTimeout(r, 400));
    tree = await getTree();
  }
  // NOTE: refs stay valid across snapshots; only navigation invalidates them
  // New snapshots merely register additional refs.

  const lines = [];
  let count = 0;
  if (Array.isArray(tree?.nodes) && tree.nodes.length > 1) {
    // nodeId → node (childIds reference nodeIds; resolving them via the
    // PARENT map was a bug that made the walk visit ~nothing)
    const byId = new Map();
    for (const n of tree.nodes) byId.set(n.nodeId, n);
    const root = tree.nodes[0];
    // AX childIds can contain cycles/shared nodes — guard with visited + depth cap
    const visited = new Set();
    const MAX_DEPTH = 60;
    const walk = (node, depth) => {
      if (depth > MAX_DEPTH || visited.has(node)) return;
      visited.add(node);
      if (node.ignored) {
        for (const cid of node.childIds || []) {
          const c = byId.get(cid);
          if (c && !visited.has(c)) walk(c, depth);
        }
        return;
      }
      const role = (node.role?.value || '').toLowerCase();
      const name = nodeName(node);
      const interactive = INTERACTIVE_ROLES.has(role);
      if (filter === 'interactive' ? interactive : true) {
        const ref = node.backendDOMNodeId
          ? refs.put(tabId, node.backendDOMNodeId, { role, name })
          : null;
        count++;
        const bits = [];
        if (ref) bits.push(ref);
        bits.push(role || 'generic');
        if (name) bits.push(JSON.stringify(collapse(name)));
        const fl = flagsOf(node);
        if (fl.length) bits.push(`[${fl.join(' ')}]`);
        const val = nodeValue(node);
        if (val !== undefined && (role === 'textbox' || role === 'searchbox' || role === 'combobox')) {
          const text = SENSITIVE_NAME.test(name) ? '[redacted]' : String(val).slice(0, 60);
          if (text) bits.push(`="${text}"`);
        }
        lines.push('  '.repeat(depth) + bits.join(' '));
      }
      const nextDepth = filter === 'interactive' && !interactive && depth > 0 ? depth : depth + 1;
      for (const cid of node.childIds || []) {
        const c = byId.get(cid);
        if (c && !visited.has(c)) walk(c, nextDepth);
      }
    };
    walk(root, 0);
  }

  let source = 'accessibility-cdp';
  if (count < 3) {
    // Fallback: DOM tree via content script; refs are @dN handled by the bridge.
    const fb = await bridge(tabId, 'getDomTree', { filter, max_chars: max_chars / 2 });
    if (fb && typeof fb.text === 'string' && fb.text.length) {
      source = 'dom-fallback';
      lines.length = 0;
      lines.push(fb.text);
      count = fb.ref_count || 0;
    }
  }

  // frame sections: every bridge-reachable child document gets its own indented
  // block; refs registered there carry {frameId, domRef, epoch} and resolve
  // through the coordinate path. Disabled with frames:false, and silently
  // skipped when getAllFrames is unavailable (offline harnesses).
  let frameInfo = { lines: [], count: 0, frames: [] };
  if (frames) {
    frameInfo = await captureFrameSections(tabId).catch(() => ({ lines: [], count: 0, frames: [] }));
    if (frameInfo.lines.length) {
      lines.push('');
      lines.push(...frameInfo.lines);
      count += frameInfo.count;
    }
  }

  const text = lines.join('\n') || '(empty page)';
  const nonce = Math.random().toString(36).slice(2, 10);
  captures.set(tabId, {
    gen: refs.state(tabId).gen,
    nonce,
    text,
    ref_count: count,
    source,
    frame_count: frameInfo.frames.length,
    nodes: tree?.nodes?.length ?? null,
  });
  return {
    text: text.slice(0, max_chars),
    ref_count: count,
    source,
    frame_count: frameInfo.frames.length,
    truncated: text.length > max_chars,
    next_cursor: text.length > max_chars ? `${nonce}:${max_chars}` : null,
    ax_debug: { nodes: tree?.nodes?.length ?? null, error: axErr },
  };
}

function collapse(s) {
  const t = String(s).replace(/\s+/g, ' ').trim();
  return t.length > 80 ? t.slice(0, 77) + '…' : t;
}

// The DOM agent reclaims nodeIds INSIDE one document generation (its own
// getDocument prefixes, subtree swaps, child-document page swaps — none of
// which bump st.gen): CDP then answers "No node with given id found" for a
// node that is still in the page (LIVE-RESULTS-2 §5g: the same backendNodeId
// stayed readable via DOM.describeNode the whole time). Distinct from a
// generation change — the element exists, only the cached handle died.
function nodeHandleStale(e) {
  return /no node with given id|node with given id does not belong|does not belong to the document/i.test(
    String(e?.message || e),
  );
}

/** backendNodeId→nodeId map from one flattened scan (pierce reaches shadow DOM
 *  and same-process child documents; OOPIF documents never appear in it). */
async function buildNodeIndex(tabId) {
  let m = null;
  const flat = await cdp.send(tabId, 'DOM.getFlattenedDocument', { depth: -1, pierce: true }).catch(() => null);
  if (flat?.nodes) {
    m = new Map();
    for (const n of flat.nodes) {
      if (n.backendNodeId != null && n.nodeId != null) m.set(n.backendNodeId, { nodeId: n.nodeId, frameId: n.frameId || null });
    }
  } else {
    const doc = await cdp.send(tabId, 'DOM.getDocument', { depth: -1 }).catch(() => null);
    if (doc?.root) {
      m = new Map();
      (function walk(n) {
        if (n.backendDOMNodeId != null && n.nodeId != null) m.set(n.backendDOMNodeId, { nodeId: n.nodeId, frameId: n.frameId || null });
        (n.children || []).forEach(walk);
      })(doc.root);
    }
  }
  return m;
}

/** Forced re-index after a reclaimed-nodeId failure (F2). Callers may only
 *  reach for it ON FAILURE — an unconditional rebuild would turn every ref
 *  action into a depth:-1,pierce:true full-tree scan. */
export async function rebuildNodeIndex(tabId) {
  const st = cdp.buffers(tabId);
  if (!st) return null;
  const m = await buildNodeIndex(tabId);
  st.nodeIndex = m;
  st.nodeIndexGen = st.gen;
  return m;
}

function normIndexEntry(raw) {
  // harnesses inject raw-number index Maps; the live builder stores {nodeId, frameId}
  return raw == null ? null : typeof raw === 'object' ? raw : { nodeId: raw, frameId: null };
}

/** Scroll + measure one nodeId, honestly.
 *  F3 (LIVE-RESULTS-2 §5g): a failed DOM.scrollIntoViewIfNeeded used to be
 *  swallowed while the tool still returned {scrolled_to:"@eN"} and scrollY
 *  never moved. Now a scroll failure surfaces: stale-handle errors keep their
 *  raw CDP shape so resolveRef can re-index and retry once; anything else is
 *  ELEMENT_NOT_VISIBLE with the real reason attached (hidden/detached — the
 *  class the old boxOf path reported anyway). */
async function scrollAndBoxOf(tabId, nodeId, idx, st) {
  try {
    await cdp.send(tabId, 'DOM.scrollIntoViewIfNeeded', { nodeId });
  } catch (e) {
    if (nodeHandleStale(e)) throw e;
    throw err('ELEMENT_NOT_VISIBLE', `the element cannot be scrolled into view (hidden, detached, or gone): ${String(e?.message || e).slice(0, 140)}`);
  }
  const foreign = idx?.frameId && st?.frameId && idx.frameId !== st.frameId;
  return foreign ? await composeCdpNodeBox(tabId, nodeId, idx.frameId) : await boxOf(tabId, nodeId);
}

function mapBoxFailure(e) {
  // when no re-index retry was eligible, a dead handle is still an honest
  // REF_STALE — and the generation-change guidance (refs.get) stays distinct
  if (e?.code === 'NODE_HANDLE_STALE' || nodeHandleStale(e)) {
    return err('REF_STALE', 'that element is gone from the document (or its frame was destroyed); take a fresh snapshot');
  }
  return e;
}

/**
 * F1 (LIVE-RESULTS-2 §6b): the page-level debugger session's
 * Input.dispatchMouseEvent does NOT route into an out-of-process frame — the
 * shield gate confirmed the veil open, the coordinates were right, the frame
 * received zero events, and ok:true was the silent lie. The build's own
 * boundary is the CDP frame tree: every same-process child document appears
 * in the page session's Page.getFrameTree; a cross-site document simply does
 * not (frames.probe called this "该帧没有 CDP 记录"). Extension frameIds and CDP
 * frameIds are different namespaces, so the join is by document URL count —
 * and only a PROVEN absence answers true: an unfetchable/degenerate tree
 * must never block the same-process path that live #6a proved works.
 */
export async function frameIsOutOfProcess(tabId, extFrameId) {
  if (!(Number.isInteger(extFrameId) && extFrameId > 0)) return false;
  const all = await listExtFrames(tabId);
  const target = all?.find((f) => f.frameId === extFrameId);
  const url = String(target?.url || '');
  if (!target || !/^https?:/i.test(url)) return false; // gone / about:blank / srcdoc: undecidable ≠ refuse
  let tree;
  try {
    tree = await cdp.send(tabId, 'Page.getFrameTree');
  } catch {
    return false;
  }
  const root = tree?.frameTree?.frame;
  if (!root || !String(root.url || '').trim()) return false; // stub or attach refused: undecidable
  if (String(root.url || '') === url) return false; // a frame loading the top URL renders in-process
  const cdpKids = flattenFrameTree(tree).filter((f) => f.frameId !== root.id);
  const need = all.filter((f) => f.frameId !== 0 && String(f.url || '') === url).length;
  const have = cdpKids.filter((f) => String(f.url || '') === url).length;
  return have < need;
}

/**
 * Resolve an @eN ref. Main-frame refs → { nodeId, box } (CDP node path).
 * Frame refs (entry.frameId > 0) → { nodeId: null, box } where box is the
 * element's TOP-VIEWPORT rectangle composed through the frame chain — the
 * coordinate path, the only one that reaches same-process child frames from
 * MV3; out-of-process ones are refused by the action tools (frameIsOutOfProcess).
 */
export async function resolveRef(tabId, ref) {
  const entry = refs.get(tabId, ref); // throws REF_STALE / REF_UNKNOWN
  if (entry.frameId != null && entry.frameId !== MAIN_FRAME) {
    const { box, desc } = await frameElementBox(tabId, { ...entry, ref });
    return { nodeId: null, box, meta: { ...entry, ref }, frame: { extFrameId: entry.frameId, desc } };
  }
  if (refs.collides(tabId, entry)) {
    throw err(
      'REF_FRAME_AMBIGUOUS',
      `${ref}'s backendNodeId was registered from more than one document this generation — the shared node index cannot pick safely; take a fresh snapshot (frame refs come from the frame sections)`,
    );
  }
  const st = cdp.buffers(tabId);
  // Index the whole flattened DOM (reliable path on Edge): one call
  // gives backendNodeId→nodeId for everything, including shadow DOM (pierce).
  // This sidesteps pushNodesByBackendIdsToFrontend/resolveNode, which this
  // Edge build rejects with "Document needs to be requested first".
  if (st && (!st.nodeIndex || st.nodeIndexGen !== st.gen)) {
    st.nodeIndex = await buildNodeIndex(tabId);
    st.nodeIndexGen = st.gen;
  }
  let idx = normIndexEntry(st?.nodeIndex?.get(entry.backendNodeId));
  let nodeId = idx?.nodeId;
  const fromIndex = nodeId != null;
  if (!nodeId) {
    // last resort: the classic push path (works on some builds)
    const pushed = await cdp.send(tabId, 'DOM.pushNodesByBackendIdsToFrontend', {
      backendNodeIds: [entry.backendNodeId],
    }).catch(() => null);
    nodeId = pushed?.nodeIds?.[0];
    idx = { nodeId, frameId: null };
  }
  if (!nodeId) throw err('REF_RESOLVE_FAILED', `could not resolve ${ref} to a DOM node (page may have changed)`);
  let box;
  try {
    box = await scrollAndBoxOf(tabId, nodeId, idx, st);
  } catch (e) {
    if (!fromIndex || !nodeHandleStale(e)) throw mapBoxFailure(e);
    // F2: same generation, reclaimed handle — rebuild the index ONCE and
    // retry once. Never on success, never per action.
    st.nodeIndex = await buildNodeIndex(tabId);
    st.nodeIndexGen = st.gen;
    idx = normIndexEntry(st.nodeIndex?.get(entry.backendNodeId));
    if (!idx?.nodeId) {
      throw err('REF_STALE', 'that element is gone from the document (or its frame was destroyed); take a fresh snapshot');
    }
    nodeId = idx.nodeId;
    try {
      box = await scrollAndBoxOf(tabId, nodeId, idx, st);
    } catch (e2) {
      if (!nodeHandleStale(e2)) throw mapBoxFailure(e2);
      throw err(
        'REF_STALE',
        'the element is likely still in the document, but its cached DOM node handle was reclaimed and the fresh handle died again immediately (agent churn); repeat this action once — the node index was just rebuilt — or take a fresh snapshot',
      );
    }
  }
  // A same-process child-document node (frameId present and ≠ main): the node
  // itself is CDP-addressable (callOnNode/DOM.focus work), but its box lives in
  // that frame's coordinate space — compose it into the top viewport through
  // the DOM.getFrameOwner chain. OOPIF nodes never reach here (no index entry,
  // no push, and refs for them come from the frame sections instead).
  const foreign = idx?.frameId && st?.frameId && idx.frameId !== st.frameId;
  return { nodeId, box, meta: entry, frame: foreign ? { cdpFrameId: idx.frameId } : undefined };
}

/** Node box of a same-process subframe element, walked up via frame owners. */
async function composeCdpNodeBox(tabId, nodeId, nodeFrameId) {
  const st = cdp.buffers(tabId);
  let rect = await boxOf(tabId, nodeId);
  let fid = nodeFrameId;
  let guard = 0;
  while (fid && fid !== st?.frameId && guard++ < 8) {
    const owner = await cdp.send(tabId, 'DOM.getFrameOwner', { frameId: fid }).catch(() => null);
    const oid = owner?.backendNodeId
      ? (await cdp.send(tabId, 'DOM.pushNodesByBackendIdsToFrontend', { backendNodeIds: [owner.backendNodeId] }).catch(() => null))?.nodeIds?.[0]
      : null;
    if (!oid) {
      throw err(
        'REF_FRAME_AMBIGUOUS',
        'the node lives in a child document whose host frame box cannot be composed (OOPIF, or getFrameOwner unsupported here) — take a fresh snapshot so it registers as a frame ref and acts through the coordinate path',
      );
    }
    const host = await boxOf(tabId, oid);
    rect = {
      x: host.x + rect.x,
      y: host.y + rect.y,
      width: rect.width,
      height: rect.height,
      cx: host.x + rect.cx,
      cy: host.y + rect.cy,
    };
    fid = st?.frames?.get(fid)?.parentId || null;
  }
  return rect;
}

export async function boxOf(tabId, nodeId) {
  const model = await cdp.send(tabId, 'DOM.getBoxModel', { nodeId }).catch((e) => {
    // F2: a dead nodeId used to land in the same ELEMENT_NOT_VISIBLE bucket as
    // a genuinely hidden node (LIVE-RESULTS-2 §5g 判别 ④: element had a real
    // box, only the cached handle was reclaimed). Keep the two apart.
    if (nodeHandleStale(e)) throw err('NODE_HANDLE_STALE', `DOM node handle reclaimed: ${String(e?.message || e).slice(0, 120)}`);
    return null;
  });
  if (model?.model?.content) {
    const q = model.model.content; // [x1,y1, x2,y2, x3,y3, x4,y4]
    const xs = [q[0], q[2], q[4], q[6]];
    const ys = [q[1], q[3], q[5], q[7]];
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    const w = Math.max(...xs) - x;
    const h = Math.max(...ys) - y;
    if (w > 0 && h > 0) return { x, y, width: w, height: h, cx: x + w / 2, cy: y + h / 2 };
  }
  throw err('ELEMENT_NOT_VISIBLE', 'element has no visible box (hidden or zero-size)');
}

// ---------------------------------------------------------------- frames (2-D)

const FRAME_SECTION_CHARS = 15000;
const FRAME_SECTION_MAX = 16;

/**
 * Compose an element rect from a frame's own viewport up to the TOP viewport.
 * steps[0] is the outermost iframe element (rects measured in ITS parent's
 * viewport — getBoundingClientRect already carries every ancestor scroll),
 * steps[i].child* fields describe the frame it wraps. Pure math, offline-tested.
 */
export function composeFrameBoxes(steps, local) {
  let { x, y, width, height } = local;
  for (let i = steps.length - 1; i >= 0; i--) {
    const s = steps[i];
    const kx = s.childInnerWidth > 0 ? s.width / s.childInnerWidth : 1;
    const ky = s.childInnerHeight > 0 ? s.height / s.childInnerHeight : 1;
    x = s.x + (s.borderLeft || 0) + x * kx;
    y = s.y + (s.borderTop || 0) + y * ky;
    width *= kx;
    height *= ky;
  }
  return { x, y, width, height, cx: x + width / 2, cy: y + height / 2 };
}

/**
 * Pair webNavigation child frames (extension ids) with the parent document's
 * iframe elements. Deterministic only when candidates are unique; ties are
 * broken by the frame[name] attribute, otherwise reported as unresolved (the
 * caller may try the stamp handshake; actions on unresolved frames refuse
 * rather than click a sibling with the same URL).
 */
export function matchChildrenToFrames(extChildren, domChildren) {
  const pairs = [];
  const unresolved = [];
  const used = new Set();
  const candidates = (ext) =>
    domChildren.filter(
      (d) =>
        (d.sameOrigin && d.liveUrl && d.liveUrl === ext.url) ||
        (d.src && ext.url && d.src === ext.url) ||
        (!d.src && ext.url === 'about:blank'),
    );
  for (const ext of extChildren) {
    const free = candidates(ext).filter((d) => !used.has(d.order));
    if (free.length === 0) {
      unresolved.push({ frameId: ext.frameId, reason: 'no-matching-element', url: ext.url });
      continue;
    }
    let pick = free[0];
    // how this edge was resolved — the coordinate path trusts it, so the
    // diagnostic has to be able to say it out loud (live-verify §1)
    let matchedBy = 'url';
    if (free.length > 1) {
      const byName = ext.name ? free.filter((d) => d.name === ext.name) : [];
      if (byName.length === 1) {
        pick = byName[0];
        matchedBy = 'url+frame-name';
      } else {
        unresolved.push({
          frameId: ext.frameId,
          reason: 'ambiguous-same-url',
          url: ext.url,
          candidateOrders: free.map((d) => d.order),
        });
        continue;
      }
    }
    used.add(pick.order);
    pairs.push({ frameId: ext.frameId, order: pick.order, dom: pick, matchedBy });
  }
  return { pairs, unresolved };
}

export async function listExtFrames(tabId) {
  if (typeof chrome.webNavigation?.getAllFrames !== 'function') return null; // offline stubs
  const frames = await chrome.webNavigation.getAllFrames({ tabId }).catch(() => null);
  if (!Array.isArray(frames)) return null;
  return frames.filter((f) => f && typeof f.frameId === 'number');
}

/** [0, parent, …, self] extension-frameId chain; null when the frame is gone. */
export function frameChain(allFrames, extFrameId) {
  const byId = new Map(allFrames.map((f) => [f.frameId, f]));
  const chain = [];
  let cur = byId.get(extFrameId);
  if (!cur) return null;
  let guard = 0;
  while (cur && guard++ < 64) {
    chain.unshift(cur.frameId);
    cur = cur.parentFrameId == null || cur.parentFrameId === cur.frameId ? null : byId.get(cur.parentFrameId);
  }
  return chain[0] === MAIN_FRAME ? chain : null;
}

/**
 * Stamp handshake for ambiguous siblings: parent stamps the element (DOM
 * attribute for same-origin children, window.name for cross-origin ones —
 * both readable by the child from inside its own document), the child reads
 * the token back, and the parent restores whatever it stamped.
 */
async function stampResolve(tabId, parentFrameId, unresolved, domChildren) {
  const out = [];
  for (const u of unresolved) {
    const token = 'fh' + Math.random().toString(36).slice(2, 10);
    for (const order of u.candidateOrders || []) {
      const d = domChildren.find((c) => c.order === order);
      if (!d) continue;
      const via = d.sameOrigin ? 'attr' : 'name';
      const st = await bridge(tabId, 'stampChild', { order, token, via }, parentFrameId).catch((e) => ({ ok: false, error: String(e?.message || e) }));
      if (!st?.ok) {
        // WHY the handshake failed is the whole diagnostic for a cross-origin
        // page (site policy vs. a frame that simply refuses stamps) — keep it
        (u.stampFailures = u.stampFailures || []).push(`${via}@${order}: ${st?.error || 'no answer'}`);
        continue;
      }
      const read = await bridge(tabId, 'readStamp', {}, u.frameId).catch(() => null);
      await bridge(tabId, 'unstampChild', { order, via, restore: st.restore }, parentFrameId).catch(() => {});
      const hit = via === 'attr' ? read?.stamp === token : read?.name === token;
      if (hit) {
        out.push({ frameId: u.frameId, order, dom: d, matchedBy: `stamp:${via}` });
        u.resolvedBy = `stamp:${via}`;
        break;
      }
    }
  }
  return out;
}

/**
 * iframe-element steps from the top viewport down to extFrameId (steps[i]
 * wraps chain[i+1]). Throws FRAME_AMBIGUOUS when an edge cannot be resolved
 * without guessing — coordinates must never be sent to a sibling frame.
 */
export async function frameStepsFor(tabId, extFrameId) {
  const all = await listExtFrames(tabId);
  if (!all) throw err('FRAMES_UNSUPPORTED', 'chrome.webNavigation.getAllFrames is unavailable in this context');
  const chain = frameChain(all, extFrameId);
  if (!chain || chain.length < 2) {
    throw err('REF_STALE', `frame ${extFrameId} is gone (navigated/closed); take a fresh snapshot`);
  }
  const steps = [];
  const meta = [];
  for (let i = 1; i < chain.length; i++) {
    const parentExt = chain[i - 1];
    const childExt = chain[i];
    const extChildren = all.filter((f) => f.parentFrameId === parentExt).map((f) => ({ frameId: f.frameId, url: f.url, name: f.name || '' }));
    const { frames: domChildren } = await bridge(tabId, 'childFrameBoxes', {}, parentExt);
    const { pairs, unresolved } = matchChildrenToFrames(extChildren, domChildren);
    let hit = pairs.find((p) => p.frameId === childExt);
    const ambiguous = unresolved.filter((x) => x.candidateOrders?.length);
    if (!hit && ambiguous.length) {
      const stamped = await stampResolve(tabId, parentExt, ambiguous, domChildren);
      hit = stamped.find((p) => p.frameId === childExt);
    }
    if (!hit) {
      const why = (ambiguous.find((x) => x.frameId === childExt)?.stampFailures || []).join(' | ');
      throw err(
        'FRAME_AMBIGUOUS',
        `cannot tell which <iframe> element hosts frame ${childExt} (same-url siblings the stamp could not disambiguate) — run frames.probe to see the pairing, or act on the parent page; take a snapshot on the frame itself for perception` +
          (why ? ` — stamp attempts: ${why.slice(0, 500)}` : ''),
      );
    }
    const childInfo = await bridge(tabId, 'selfInfo', {}, childExt).catch(() => null);
    if (!childInfo) {
      throw err('FRAME_UNREACHABLE', `the bridge is not running in frame ${childExt} (about:blank/srcdoc/file or injection blocked)`);
    }
    steps.push({
      x: hit.dom.rect.x,
      y: hit.dom.rect.y,
      width: hit.dom.rect.width,
      height: hit.dom.rect.height,
      borderLeft: hit.dom.borderLeft || 0,
      borderTop: hit.dom.borderTop || 0,
      childInnerWidth: childInfo.innerWidth,
      childInnerHeight: childInfo.innerHeight,
    });
    meta.push({ extFrameId: childExt, info: childInfo, pairOrder: hit.order, resolvedBy: hit.matchedBy || 'url' });
  }
  return { chain, steps, meta };
}

/**
 * Viewport box (top-frame CSS px) of an element addressed inside its frame by
 * the frame bridge's @dN ref. Also the staleness gate: the frame's doc epoch
 * must equal the one recorded at snapshot time.
 *
 * `scroll` defaults to true because a coordinate ACTION needs the element in
 * the viewport; a pure MEASUREMENT must pass `scroll:false` — this call is the
 * only page-state lever the frame path has (live-verify §1: frames.probe
 * claimed READ-ONLY and still moved the page 2520 → 911 px).
 */
export async function frameElementBox(tabId, entry, { scroll = true } = {}) {
  const first = await frameStepsFor(tabId, entry.frameId);
  const deepest = first.meta[first.meta.length - 1];
  if (entry.epoch && deepest.info.epoch !== entry.epoch) {
    throw err('REF_STALE', `${entry.ref || 'ref'}: its iframe navigated to a new document; take a fresh snapshot`);
  }
  const d = await bridge(tabId, 'describeRef', { ref: entry.domRef, scroll }, entry.frameId);
  if (!d || !d.local || d.local.width <= 0 || d.local.height <= 0) {
    throw err('ELEMENT_NOT_VISIBLE', 'the element inside the iframe has no visible box (hidden, zero-size, or gone)');
  }
  // d.box is composed to the routed frame's own viewport (same-origin hops);
  // this call adds the frame-chain offset up to the TOP viewport.
  // scrollIntoView above moved the ANCESTOR documents too, so the chain offsets
  // taken before it no longer describe this element — re-sample them (live-verify
  // §1 reported viewport_box.y=-1299 because box and scroll came from two
  // different moments).
  const { steps } = scroll ? await frameStepsFor(tabId, entry.frameId) : first;
  return { box: composeFrameBoxes(steps, d.local), desc: d, scrolled: !!scroll };
}

/**
 * Indented frame sections for the snapshot text + @eN registration inside them.
 * Returns { lines, count }. Never throws: sensing the main document must not
 * die because one iframe is hostile.
 */
export async function captureFrameSections(tabId) {
  const lines = [];
  let count = 0;
  const all = await listExtFrames(tabId);
  if (!all || all.length < 2) return { lines, count, frames: [] };
  const topUrl = all.find((f) => f.frameId === MAIN_FRAME)?.url || '';
  let topOrigin = '';
  try { topOrigin = new URL(topUrl).origin; } catch {}
  const kids = all.filter((f) => f.frameId !== MAIN_FRAME).slice(0, FRAME_SECTION_MAX);
  for (const f of kids) {
    let env;
    try {
      env = await bridgeEnvelope(tabId, 'selfInfo', {}, f.frameId);
    } catch {
      continue; // no bridge there (srcdoc/blank/file/disabled) — invisible to sensing
    }
    const info = env.result;
    if (cdp.isRestrictedUrl(info.url)) continue;
    let crossOrigin = true;
    try { crossOrigin = new URL(info.url).origin !== topOrigin; } catch {}
    let tree = null;
    try {
      tree = await bridge(tabId, 'getDomTree', { filter: 'interactive', max_chars: FRAME_SECTION_CHARS }, f.frameId);
    } catch { /* frame alive but tree read failed: still list the section header */ }
    const entries = Array.isArray(tree?.entries) ? tree.entries : [];
    const bits = [`# frame[${f.frameId}] ${truncateUrl(info.url)}`];
    bits.push(crossOrigin ? '· cross-origin' : '· same-origin');
    bits.push(`· ${entries.length} element(s)${info.innerWidth ? ` · viewport ${Math.round(info.innerWidth)}x${Math.round(info.innerHeight)}` : ''}`);
    if (!entries.length && tree?.text) bits.push('(flat text tree)');
    lines.push(bits.join(' '));
    // late-armed-frame relief: this per-frame enumeration is also the moment
    // the arm broadcast is re-delivered (frameblock starts blocking again)
    for (const e of entries) {
      const ref = refs.put(tabId, null, {
        role: e.role || 'generic',
        name: e.name || '',
        frameId: f.frameId,
        domRef: e.ref,
        epoch: info.epoch,
        frameUrl: info.url,
        crossOrigin,
      });
      count++;
      lines.push('  '.repeat(1 + (e.depth || 0)) + [ref, e.role || 'generic', e.name ? JSON.stringify(collapse(e.name)) : null, e.disabled ? '[disabled]' : null].filter(Boolean).join(' '));
    }
    if (!entries.length && tree?.text) lines.push(tree.text);
  }
  if (lines.length) {
    lines.unshift('# ── child frames (refs act via the coordinate path; real CDP input lands in same-process frames — out-of-process frame targets refuse with FRAME_UNSUPPORTED)');
    // late-armed-frame relief: re-deliver the CURRENT shield state (queried,
    // never assumed — a user-interrupted tab stays paused) so frames that
    // loaded after the last arm broadcast start blocking again.
    resyncArm(tabId);
  }
  return { lines, count, frames: kids.map((k) => ({ frameId: k.frameId, url: k.url })) };
}

async function resyncArm(tabId) {
  try {
    const q = await shield.query(tabId);
    const st = q?.state || q;
    if (st && (st.mode === 'armed' || st.mode === 'paused')) {
      await shield.set(tabId, { mode: st.mode });
    }
  } catch {}
}

function truncateUrl(u) {
  const s = String(u || '');
  return s.length > 120 ? s.slice(0, 117) + '…' : s;
}
