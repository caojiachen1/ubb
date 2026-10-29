// Element reference store: @eN → { backendNodeId, frameId, ... } with per-tab
// generation (per-tab generations: stale refs stop resolving).
// The frame dimension: refs live in a tab NAMED by the EXTENSION frameId
// (webNavigation / sender.frameId / tabs.sendMessage namespace — NOT the CDP
// frameId). backendNodeIds are only unique within a renderer process, so two
// frames can hand out the same number: every entry carries its frameId, and
// the byBackend ledger marks cross-frame collisions so resolveRef can refuse
// instead of silently acting on a node in the wrong document.

import { err } from './config.js';

export const MAIN_FRAME = 0;

class TabRefs {
  constructor() {
    this.gen = 1;
    this.next = 1;
    this.refs = new Map(); // "@eN" → { backendNodeId, frameId, gen, ...meta }
    this.backendFrames = new Map(); // backendNodeId → Set(frameId) — cross-frame number reuse
  }
}

export class RefStore {
  constructor() {
    this.tabs = new Map(); // tabId → TabRefs
  }

  state(tabId) {
    let s = this.tabs.get(tabId);
    if (!s) {
      s = new TabRefs();
      this.tabs.set(tabId, s);
    }
    return s;
  }

  /** Navigation happened: bump generation, stale refs stop resolving. */
  bump(tabId) {
    const s = this.tabs.get(tabId);
    if (s) {
      s.gen += 1;
      s.refs.clear();
      s.backendFrames.clear();
    }
  }

  invalidate(tabId) {
    this.tabs.delete(tabId);
  }

  /**
   * Register a ref. meta.frameId (extension-frameId namespace) defaults to 0
   * (main frame). Frame refs may have backendNodeId === null: they are
   * addressed through the frame's own bridge (meta.domRef = "@dN").
   */
  put(tabId, backendNodeId, meta = {}) {
    const s = this.state(tabId);
    const { frameId: rawFrame, ...rest } = meta;
    const frameId = rawFrame ?? MAIN_FRAME;
    const name = `@e${s.next++}`;
    s.refs.set(name, { ...rest, backendNodeId, frameId, gen: s.gen });
    if (backendNodeId != null) {
      let set = s.backendFrames.get(backendNodeId);
      if (!set) {
        set = new Set();
        s.backendFrames.set(backendNodeId, set);
      }
      set.add(frameId);
    }
    return name;
  }

  get(tabId, name) {
    if (typeof name !== 'string' || !name.startsWith('@e')) {
      throw err('BAD_REF', `ref must look like "@eN" (got ${JSON.stringify(name)}); call snapshot first`);
    }
    const s = this.tabs.get(tabId);
    const entry = s && s.refs.get(name);
    if (!entry) throw err('REF_UNKNOWN', `${name} is unknown on this tab; take a fresh snapshot`);
    if (entry.gen !== s.gen) {
      throw err(
        'REF_STALE',
        `${name} refers to the previous page generation; take a fresh snapshot (or use find)`,
      );
    }
    return entry;
  }

  /**
   * True when the SAME backendNodeId was registered from two different frames
   * in this tab generation — a number collision across documents, the ref must
   * never be resolved through the shared CDP node index.
   */
  collides(tabId, entry) {
    const s = this.tabs.get(tabId);
    if (!s || !s.backendFrames || entry.backendNodeId == null) return false;
    const set = s.backendFrames.get(entry.backendNodeId);
    return !!set && set.size > 1;
  }

  /** Update metadata of an existing ref (e.g. richer name from DOM fallback). */
  meta(tabId, name, patch) {
    const s = this.tabs.get(tabId);
    const e = s && s.refs.get(name);
    if (e) Object.assign(e, patch);
  }
}

export const refs = new RefStore();
