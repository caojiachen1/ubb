// Page sensing: CDP Accessibility full tree snapshot with @eN refs
// (BrowserSkill/AX approach) + DOM fallback tree through the content bridge
// (Qoder/QwenWork approach) when the AX tree is empty or too generic.

import { cdp } from './cdp.js';
import { refs } from './refs.js';
import { err } from './config.js';
import { bridge } from './bridge-ctl.js';

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
  if (get('disabled')) f.push('disabled');
  if (get('checked')) f.push('checked');
  if (get('readonly')) f.push('readonly');
  if (get('required')) f.push('required');
  if (get('expanded') === true) f.push('expanded');
  if (get('expanded') === false) f.push('collapsed');
  if (get('haspopup')) f.push('haspopup'); // hover/submenu trigger marker
  if (get('level')) f.push(`h${get('level')}`);
  return f;
}

// Pagination store: the full text of the most recent capture per tab, so
// next_cursor continuations re-read the SAME capture (BrowserSkill semantics)
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
export async function takeSnapshot(tabId, { filter = 'interactive', max_chars = 60000, cursor = null } = {}) {
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
      truncated: nextOff < cap.text.length,
      next_cursor: nextOff < cap.text.length ? `${nonce}:${nextOff}` : null,
      page: { offset: off, capture_chars: cap.text.length },
      ax_debug: { nodes: cap.nodes, error: null },
    };
  }
  await cdp.ensure(tabId);
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
  // (BrowserSkill semantics). New snapshots merely register additional refs.

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

  const text = lines.join('\n') || '(empty page)';
  const nonce = Math.random().toString(36).slice(2, 10);
  captures.set(tabId, {
    gen: refs.state(tabId).gen,
    nonce,
    text,
    ref_count: count,
    source,
    nodes: tree?.nodes?.length ?? null,
  });
  return {
    text: text.slice(0, max_chars),
    ref_count: count,
    source,
    truncated: text.length > max_chars,
    next_cursor: text.length > max_chars ? `${nonce}:${max_chars}` : null,
    ax_debug: { nodes: tree?.nodes?.length ?? null, error: axErr },
  };
}

function collapse(s) {
  const t = String(s).replace(/\s+/g, ' ').trim();
  return t.length > 80 ? t.slice(0, 77) + '…' : t;
}

/**
 * Resolve an @eN ref to a CDP nodeId (pushes backend node to frontend,
 * scrolls into view) and returns { nodeId, box }.
 */
export async function resolveRef(tabId, ref) {
  const entry = refs.get(tabId, ref); // throws REF_STALE / REF_UNKNOWN
  const st = cdp.buffers(tabId);
  // Index the whole flattened DOM (QwenWork-proven path on Edge): one call
  // gives backendNodeId→nodeId for everything, including shadow DOM (pierce).
  // This sidesteps pushNodesByBackendIdsToFrontend/resolveNode, which this
  // Edge build rejects with "Document needs to be requested first".
  if (!st || !st.nodeIndex || st.nodeIndexGen !== st.gen) {
    let m = null;
    const flat = await cdp.send(tabId, 'DOM.getFlattenedDocument', { depth: -1, pierce: true }).catch(() => null);
    if (flat?.nodes) {
      m = new Map();
      for (const n of flat.nodes) {
        if (n.backendNodeId != null && n.nodeId != null) m.set(n.backendNodeId, n.nodeId);
      }
    } else {
      const doc = await cdp.send(tabId, 'DOM.getDocument', { depth: -1 }).catch(() => null);
      if (doc?.root) {
        m = new Map();
        (function walk(n) {
          if (n.backendDOMNodeId != null && n.nodeId != null) m.set(n.backendDOMNodeId, n.nodeId);
          (n.children || []).forEach(walk);
        })(doc.root);
      }
    }
    if (st) {
      st.nodeIndex = m;
      st.nodeIndexGen = st.gen;
    }
  }
  let nodeId = st?.nodeIndex?.get(entry.backendNodeId);
  if (!nodeId) {
    // last resort: the classic push path (works on some builds)
    const pushed = await cdp.send(tabId, 'DOM.pushNodesByBackendIdsToFrontend', {
      backendNodeIds: [entry.backendNodeId],
    }).catch(() => null);
    nodeId = pushed?.nodeIds?.[0];
  }
  if (!nodeId) throw err('REF_RESOLVE_FAILED', `could not resolve ${ref} to a DOM node (page may have changed)`);
  await cdp.send(tabId, 'DOM.scrollIntoViewIfNeeded', { nodeId }).catch(() => {});
  const box = await boxOf(tabId, nodeId);
  return { nodeId, box, meta: entry };
}

export async function boxOf(tabId, nodeId) {
  const model = await cdp.send(tabId, 'DOM.getBoxModel', { nodeId }).catch(() => null);
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
