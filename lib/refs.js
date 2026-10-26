// Element reference store: @eN → CDP backendNodeId, with per-tab generation
// (per-tab generations: stale refs stop resolving).

import { err } from './config.js';

class TabRefs {
  constructor() {
    this.gen = 1;
    this.next = 1;
    this.refs = new Map(); // "@eN" → { backendNodeId, role, name, gen }
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
    }
  }

  invalidate(tabId) {
    this.tabs.delete(tabId);
  }

  put(tabId, backendNodeId, meta = {}) {
    const s = this.state(tabId);
    const name = `@e${s.next++}`;
    s.refs.set(name, { backendNodeId, gen: s.gen, ...meta });
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

  /** Update metadata of an existing ref (e.g. richer name from DOM fallback). */
  meta(tabId, name, patch) {
    const s = this.tabs.get(tabId);
    const e = s && s.refs.get(name);
    if (e) Object.assign(e, patch);
  }
}

export const refs = new RefStore();
