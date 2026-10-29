// Operation audit ring: in-memory, but with a monotonic seq and per-day/per-tool
// counters so `ubb audit tail` (daemon CLI) can drain it to disk and `audit.stats`
// can answer "what is slow / failing" without a browser-side database.
// The seq counter alone is mirrored to chrome.storage.session (wave7a,
// integration-item #5): a service-worker restart used to reset it to 0 and the
// CLI read that as a wraparound. Only this one integer goes to storage — the
// 500-entry ring itself never does (quota).

const DAY_KEEP = 120;
const SEQ_KEY = 'ubb_audit_seq';

export class AuditRing {
  constructor(max = 500) {
    this.max = max;
    this.entries = [];
    this.seq = 0; // last assigned seq; 0 = nothing logged since SW start
    this.days = new Map(); // 'YYYY-MM-DD' -> Map(tool -> {calls, errors, total_ms, max_ms})
    this._seqHydrating = null;
    this._seqHydrated = false;
    this._seqPersistent = false; // chrome.storage.session actually usable here
    this._seqWriting = false;
    this._seqDirty = false;
  }

  /** Pull the mirrored seq back (once per SW boot). Background.js opens the
   *  daemon link only after this settles, so dispatchers never observe the
   *  pre-hydrate zero; log() re-raising the floor covers the racing paths. */
  hydrateSeq() {
    if (!this._seqHydrating) {
      this._seqHydrating = (async () => {
        try {
          if (typeof chrome === 'undefined' || !chrome.storage?.session) return;
          this._seqPersistent = true;
          const st = await chrome.storage.session.get(SEQ_KEY);
          const stored = Number(st && st[SEQ_KEY]) || 0;
          if (stored > this.seq) this.seq = stored;
        } catch {
          this._seqPersistent = false;
        }
        this._seqHydrated = true;
      })();
    }
    return this._seqHydrating;
  }

  /** Signature kept backward compatible: lib/tools.js has 26 call sites passing ad-hoc fields. */
  log(entry) {
    const t = new Date().toISOString();
    const e = { seq: ++this.seq, t, ...entry };
    this.entries.push(e);
    if (this.entries.length > this.max) this.entries.splice(0, this.entries.length - this.max);
    // only dispatcher completions carry ok===true/false; the manual audit.log()
    // sites would otherwise double-count the same tool call
    if (typeof e.ok === 'boolean') this._bump(t.slice(0, 10), String(e.action || '?'), e);
    if (this._seqPersistent) this._mirrorSeq();
    return e;
  }

  _mirrorSeq() {
    if (!this._seqHydrated) return; // don't clobber the stored value pre-hydration
    if (this._seqWriting) {
      this._seqDirty = true;
      return;
    }
    this._seqWriting = true;
    chrome.storage.session
      .set({ [SEQ_KEY]: this.seq })
      .then(() => {
        this._seqWriting = false;
        if (this._seqDirty) {
          this._seqDirty = false;
          this._mirrorSeq();
        }
      })
      .catch(() => {
        this._seqWriting = false;
      });
  }

  _bump(day, tool, e) {
    let byTool = this.days.get(day);
    if (!byTool) {
      byTool = new Map();
      this.days.set(day, byTool);
      while (this.days.size > DAY_KEEP) this.days.delete(this.days.keys().next().value);
    }
    const c = byTool.get(tool) || { calls: 0, errors: 0, total_ms: 0, max_ms: 0 };
    c.calls += 1;
    if (e.ok === false) c.errors += 1;
    const ms = Number(e.ms) || 0;
    c.total_ms += ms;
    if (ms > c.max_ms) c.max_ms = ms;
    byTool.set(tool, c);
  }

  /** Newest first (popup + audit.list consumers). */
  list(limit = 100) {
    return this.entries.slice(-Math.min(limit, this.entries.length)).reverse();
  }

  /** Oldest first after `since` — a cursor for incremental tailing. */
  listSince(since = 0, limit = 200) {
    return this.entries.filter((e) => e.seq > since).slice(0, Math.max(1, limit));
  }

  /** Lowest seq still in the ring (0 when empty) — tells a tailer whether it missed entries. */
  minSeq() {
    return this.entries.length ? this.entries[0].seq : this.seq;
  }

  /** window: number of recent days (default 7), or 'all'. */
  stats(window = 7) {
    const all = [...this.days.keys()].sort();
    const days = window === 'all' ? all : all.slice(-Math.max(1, Number(window) || 7));
    const tools = new Map();
    for (const day of days) {
      const byTool = this.days.get(day);
      if (!byTool) continue;
      for (const [name, c] of byTool) {
        const t = tools.get(name) || { tool: name, calls: 0, errors: 0, total_ms: 0, max_ms: 0 };
        t.calls += c.calls;
        t.errors += c.errors;
        t.total_ms += c.total_ms;
        if (c.max_ms > t.max_ms) t.max_ms = c.max_ms;
        tools.set(name, t);
      }
    }
    const rows = [...tools.values()]
      .map((t) => ({ ...t, avg_ms: t.calls ? Math.round((t.total_ms / t.calls) * 10) / 10 : 0 }))
      .sort((a, b) => b.calls - a.calls || b.errors - a.errors);
    return {
      window_days: window === 'all' ? 'all' : days.length,
      days,
      seq: this.seq,
      ring_min_seq: this.minSeq(),
      ring_size: this.entries.length,
      tools: rows,
      totals: {
        calls: rows.reduce((n, t) => n + t.calls, 0),
        errors: rows.reduce((n, t) => n + t.errors, 0),
      },
    };
  }
}

export const audit = new AuditRing();
