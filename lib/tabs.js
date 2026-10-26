// Session manager: a session == one browser tab group with status emoji
// Agent tabs are created INTO the group;
// user tabs can be claimed into it after an on-page confirmation.
// No separate Agent window is ever opened.

import { err, GROUP_TITLES, GROUP_COLOR, randomHex } from './config.js';

const SESSION_KEY = 'ubb_session';

class SessionManager {
  constructor() {
    this.session = null; // { id, groupId, created:Set, claimed:Set, startedAt, lastTabId }
    this._restored = false;
  }

  /** Survive service-worker restarts (not full browser restarts). */
  async restore() {
    if (this._restored) return;
    this._restored = true;
    try {
      const st = await chrome.storage.session.get(SESSION_KEY);
      const saved = st?.[SESSION_KEY];
      if (!saved) return;
      const alive = async (id) => {
        try { await chrome.tabs.get(id); return true; } catch { return false; }
      };
      const created = [];
      const claimed = [];
      for (const id of saved.created || []) if (await alive(id)) created.push(id);
      for (const id of saved.claimed || []) if (await alive(id)) claimed.push(id);
      if (!created.length && !claimed.length) {
        await chrome.storage.session.remove(SESSION_KEY);
        return;
      }
      this.session = {
        id: saved.id,
        groupId: saved.groupId,
        created: new Set(created),
        claimed: new Set(claimed),
        lastTabId: saved.lastTabId,
        startedAt: saved.startedAt,
        starterTabId: null,
        name: saved.name,
        marks: new Map(Object.entries(saved.marks || {})),
      };
      await this._reapStarter();
    } catch {}
  }

  async persist() {
    try {
      if (!this.session) {
        await chrome.storage.session.remove(SESSION_KEY);
        return;
      }
      const s = this.session;
      await chrome.storage.session.set({
        [SESSION_KEY]: {
          id: s.id,
          groupId: s.groupId,
          created: [...s.created],
          claimed: [...s.claimed],
          lastTabId: s.lastTabId,
          startedAt: s.startedAt,
          name: s.name,
          marks: s.marks ? Object.fromEntries(s.marks) : {},
        },
      });
    } catch {}
  }

  active() {
    return this.session;
  }

  owns(tabId) {
    const s = this.session;
    if (!s) return false;
    return s.created.has(tabId) || s.claimed.has(tabId);
  }

  async _ensureGroup() {
    const s = this.session;
    if (s.groupId != null) return s.groupId;
    // tabGroups need at least one tab; create a temporary starter tab and
    // close it as soon as a real tab joins the group.
    const win = await lastFocusedWindow();
    const tab = await chrome.tabs.create({ url: 'about:blank', active: false, windowId: win });
    s.created.add(tab.id);
    s.starterTabId = tab.id;
    const groupId = await chrome.tabs.group({ tabIds: [tab.id] });
    await chrome.tabGroups.update(groupId, { title: GROUP_TITLES.running, color: GROUP_COLOR });
    s.groupId = groupId;
    s.lastTabId = tab.id;
    return groupId;
  }

  /** Close the temporary starter blank tab once a real tab joined the group. */
  async _reapStarter() {
    const s = this.session;
    if (s.starterTabId == null) return;
    const starter = s.starterTabId;
    s.starterTabId = null;
    s.created.delete(starter);
    if (s.lastTabId === starter) s.lastTabId = null;
    await chrome.tabs.remove(starter).catch(() => {});
  }

  async start() {
    if (this.session) {
      return { session_id: this.session.id, already_active: true, group_id: this.session.groupId };
    }
    this.session = {
      id: `s-${randomHex(6)}`,
      groupId: null,
      created: new Set(),
      claimed: new Set(),
      startedAt: Date.now(),
      lastTabId: null,
      marks: new Map(),
    };
    await this._ensureGroup();
    await this.persist();
    return {
      session_id: this.session.id,
      group_id: this.session.groupId,
      note: 'agent tabs will be created inside the UBB tab group; no new window is opened',
    };
  }

  /** Add a tab to the session group; recreate the group if the user closed it. */
  async _addToGroup(tabId) {
    const s = this.session;
    let alive = false;
    if (s.groupId != null) {
      try {
        await chrome.tabGroups.get(s.groupId);
        alive = true;
      } catch {
        alive = false;
      }
    }
    if (!alive) {
      s.groupId = await chrome.tabs.group({ tabIds: [tabId] });
      await chrome.tabGroups.update(s.groupId, { title: GROUP_TITLES.running, color: GROUP_COLOR });
      return;
    }
    await chrome.tabs.group({ tabIds: [tabId], groupId: s.groupId });
  }

  /** Create a tab inside the session group. */
  async createTab(url = 'about:blank', { active = false } = {}) {
    const s = await this._require();
    if (url !== 'about:blank') url = normalizeUrl(url);
    const win = await lastFocusedWindow();
    const tab = await chrome.tabs.create({ url, active, windowId: win });
    s.created.add(tab.id);
    s.lastTabId = tab.id;
    await this._addToGroup(tab.id);
    await this._reapStarter();
    await this.persist();
    return { tab_id: tab.id, url: tab.url || url, in_group: true };
  }

  /** Claim a user tab into the group (confirmation is handled by the caller). */
  async attachClaimed(tabId) {
    const s = await this._require();
    s.claimed.add(tabId);
    s.lastTabId = tabId;
    await this._addToGroup(tabId);
    await this.persist();
    return { tab_id: tabId, in_group: true };
  }

  async release(tabId) {
    const s = this.session;
    if (!s || !s.claimed.has(tabId)) throw err('TAB_NOT_OWNED', `tab ${tabId} is not a claimed tab`);
    s.claimed.delete(tabId);
    try {
      await chrome.tabs.ungroup([tabId]);
    } catch {}
    await this.persist();
    return { tab_id: tabId, released: true };
  }

  async setStatus(kind) {
    const s = this.session;
    if (!s || s.groupId == null) return;
    const base = GROUP_TITLES[kind] || GROUP_TITLES.running;
    const title = s.name ? `${base} · ${s.name}` : base;
    try {
      await chrome.tabGroups.update(s.groupId, { title });
    } catch {}
  }

  async stop({ close_created = true } = {}) {
    const s = this.session;
    if (!s) return { stopped: false, note: 'no active session' };
    for (const tabId of [...s.claimed]) {
      try {
        await chrome.tabs.ungroup([tabId]);
      } catch {}
    }
    for (const tabId of [...s.created]) {
      if (close_created) {
        try {
          await chrome.tabs.remove(tabId);
        } catch {}
      } else {
        try {
          await chrome.tabs.ungroup([tabId]);
        } catch {}
      }
    }
    try {
      if (s.groupId != null) await chrome.tabGroups.update(s.groupId, { title: GROUP_TITLES.done });
    } catch {}
    this.session = null;
    await this.persist();
    return { stopped: true, session_id: s.id, closed_created: close_created };
  }

  /** call after mutating lastTabId / created outside this module */
  async touch() {
    if (this.session) await this.persist();
  }

  _require() {
    if (!this.session) throw err('NO_SESSION', 'call session.start first (or use tab.create which auto-starts)');
    return this.session;
  }
}

async function lastFocusedWindow() {
  try {
    const wins = await chrome.windows.getAll({ populate: false, windowTypes: ['normal'] });
    const focused = wins.find((w) => w.focused) || wins[0];
    return focused?.id ?? undefined;
  } catch {
    return undefined;
  }
}

export function normalizeUrl(url) {
  if (typeof url !== 'string' || !url) throw err('BAD_URL', 'url must be a non-empty string');
  if (/^(https?|about|file):/i.test(url)) return url;
  return 'https://' + url;
}

export const sessions = new SessionManager();
