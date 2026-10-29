// Wave 1-C: download observations + audit surface.
// The `download` tool in lib/tools.js only fires for an explicit URL/href, so an
// agent that clicks a link whose blob:/server-side download it never sees. The
// ledger below is fed by chrome.downloads listeners in background.js (which also
// push events to the agent), and read back here without needing a CDP session.

import { audit, redact, redactUrl, err, sleep } from './actions.js';

const basename = (p) => String(p || '').split(/[\\/]/).pop() || '';

// ---------------------------------------------------------------- tab attribution
// chrome.downloads hands the SW a DownloadItem on onCreated, and THAT TYPE HAS NO
// tabId field (only DownloadDelta does, and this Edge build never fills it either —
// LIVE-RESULTS-3B §3b: every recorded tab id on 4 different trigger paths was null).
// So a tab_id filter can only ever work on records WE attributed ourselves:
//   explicit  — our own `download` tool knows its targetTab, or the browser really
//               did hand us a tabId (>= 0)
//   heuristic — a page-initiated download matched to the one tab whose recorded
//               action + document origin explain it
//   none      — nothing explains it, and the record says so instead of guessing.
const ATTR_WINDOW_MS = 20_000;
// actions that can plausibly START a transfer (a read-only probe cannot)
const ATTR_ACTIONS = new Set([
  'click', 'dblclick', 'hover', 'drag', 'type', 'fill', 'fill_form', 'press_key', 'key', 'submit',
  'navigate', 'reload', 'go_back', 'go_forward', 'scroll', 'evaluate', 'dropdown_options',
  'upload_file', 'form.set', 'dialog.handle', 'replay', 'replay.run', 'webmcp.invoke', 'cdp.call', 'download',
]);
const originOf = (u) => {
  const s = String(u || '');
  if (!/^[a-z][a-z0-9+.-]*:\/\/[^/?#]/i.test(s)) return '';
  try {
    const x = new URL(s);
    if (!x.protocol.startsWith('http')) return ''; // blob:/data: carry no usable origin
    return x.origin;
  } catch {
    return '';
  }
};
const tabOf = async (id) => {
  try {
    const t = await chrome.tabs.get(id);
    return t && typeof t.url === 'string' ? t : null;
  } catch {
    return null;
  }
};

/**
 * The heuristic, isolated so a test can hand it a deterministic world.
 * @returns {Promise<{tab_id:number|null, tab_id_source:string, why:string}>}
 */
export async function attributeTab(item, recent = audit.list(200)) {
  const dlOrigin = originOf(item?.finalUrl || item?.url);
  const refOrigin = originOf(item?.referrer);
  if (!dlOrigin && !refOrigin) {
    return { tab_id: null, tab_id_source: 'none', why: 'the download carries no http(s) url or referrer to match a document against' };
  }
  const now = Date.now();
  const hits = [];
  const seen = new Set();
  for (const e of recent) {
    const id = e.tab_id;
    if (id == null || seen.has(id)) continue;
    if (!ATTR_ACTIONS.has(String(e.action))) continue;
    const age = now - Date.parse(e.t || '');
    if (!(age >= 0 && age <= ATTR_WINDOW_MS)) continue;
    seen.add(id);
    const tab = await tabOf(id);
    const tabOrigin = originOf(tab?.url);
    if (!tabOrigin) continue;
    if (refOrigin && tabOrigin === refOrigin) {
      hits.push({ tab_id: id, via: 'referrer', action: e.action, age_ms: Math.round(age) });
    } else if (dlOrigin && tabOrigin === dlOrigin) {
      hits.push({ tab_id: id, via: 'url', action: e.action, age_ms: Math.round(age) });
    }
  }
  const uniq = [...new Map(hits.map((h) => [h.tab_id, h])).values()];
  if (uniq.length === 1) {
    const h = uniq[0];
    return { tab_id: h.tab_id, tab_id_source: 'heuristic', why: `only tab ${h.tab_id} explains it: its document origin matches the download ${h.via}, and the recorded ${h.action} there was ${h.age_ms}ms ago` };
  }
  if (uniq.length > 1) {
    return { tab_id: null, tab_id_source: 'none', why: `${uniq.length} tabs (${uniq.map((h) => h.tab_id).join(', ')}) match that origin within ${ATTR_WINDOW_MS}ms — a guess would be a coin flip, so nothing was recorded` };
  }
  return { tab_id: null, tab_id_source: 'none', why: `no tab with a recorded action in the last ${ATTR_WINDOW_MS}ms has a document origin matching the ${refOrigin ? 'referrer' : 'download'} origin` };
}

const TEXT_MIME = /^(text\/|application\/(json|x-?javascript|ecmascript|xml|xhtml\+xml|atom\+xml|rss\+xml|yaml|x-yaml|graphql|sql))/i;
const TEXT_EXT = /\.(txt|csv|tsv|json|jsonl|md|markdown|xml|yml|yaml|log|ini|conf|srt|vtt|html?|css|js|mjs|ts|sql|sh|bat|py)$/i;

export function isTextish(mime, pathOrName) {
  if (mime && TEXT_MIME.test(String(mime))) return true;
  if (!mime || /^application\/(octet-stream|x-download|empty)$/i.test(String(mime))) {
    return TEXT_EXT.test(String(pathOrName || ''));
  }
  return false;
}

class DownloadLedger {
  constructor(max = 200) {
    this.max = max;
    this.items = []; // oldest first
    this.byId = new Map();
    this.emit = null; // (event, params) => void, wired to the agent link in background.js
    this.claims = new Map(); // downloadId -> {tab_id, at} from our own download tool
    this.pending = []; // attributions still in flight
    // what THIS browser actually hands us per onCreated item — counted, never
    // assumed: the tab_id description has to match these numbers, not the schema
    this.signals = { items: 0, with_tabid: 0, with_referrer: 0, with_final_url: 0, with_mime: 0, deltas_with_tabid: 0 };
  }

  setEmitter(fn) {
    this.emit = fn;
  }

  /**
   * F1-①: the `download` tool knows which tab it was asked for (targetTab), but
   * chrome.downloads.download() only ever answers with an id, so the call site
   * hands that tab over here instead of letting it die with a local variable.
   * onCreated may land before or after this, hence the small claim ring.
   */
  claim(id, tabId) {
    if (id == null || tabId == null) return false;
    const rec = this.byId.get(id);
    if (rec) {
      rec.tab_id = tabId;
      rec.tab_id_source = 'explicit';
      rec.tab_id_why = 'the download tool started it for this tab (targetTab)';
      return true;
    }
    this.claims.set(id, { tab_id: tabId, at: Date.now() });
    if (this.claims.size > 50) this.claims.delete(this.claims.keys().next().value);
    return false;
  }

  /** Await the attributions that were still running (the tools call this before filtering). */
  async settled() {
    while (this.pending.length) {
      const list = this.pending;
      this.pending = [];
      await Promise.allSettled(list);
    }
  }

  _attribute(rec, item) {
    const job = attributeTab(item)
      .then((a) => {
        if (rec.tab_id_source === 'explicit') return; // a claim that landed mid-flight wins
        rec.tab_id = a.tab_id;
        rec.tab_id_source = a.tab_id == null ? 'none' : 'heuristic';
        rec.tab_id_why = a.why;
      })
      .catch(() => {
        rec.tab_id_source = rec.tab_id_source || 'none';
        rec.tab_id_why = 'attribution failed (tabs.query/action ring unavailable)';
      });
    this.pending.push(job);
    return job;
  }

  _merge(rec, d) {
    if (!rec) return null;
    if (d.url != null || d.finalUrl != null) rec.url = redactUrl(d.finalUrl || d.url || rec.url || '');
    if (d.filename != null) {
      rec.abs = d.filename;
      rec.filename = basename(d.filename);
    }
    if (d.state != null) rec.state = d.state;
    if (d.bytesReceived != null) rec.bytes_received = d.bytesReceived;
    if (d.totalBytes != null) rec.total_bytes = d.totalBytes;
    if (d.paused != null) rec.paused = d.paused;
    if (d.mime != null) rec.mime = d.mime;
    // -1 / null is chrome's own "no originating tab" answer, never a tab id
    if (d.tabId != null && d.tabId >= 0) {
      rec.tab_id = d.tabId;
      if (rec.tab_id_source !== 'explicit') {
        rec.tab_id_source = 'explicit';
        rec.tab_id_why = 'chrome.downloads reported this tabId itself (an item or delta that carries one)';
      }
    }
    if (d.referrer != null) rec.referrer = d.referrer;
    if (d.startTime != null) rec.start_time = d.startTime;
    if (d.endTime != null) rec.end_time = d.endTime;
    if (d.error != null) rec.error = d.error;
    return rec;
  }

  /** Full chrome.downloads.DownloadItem (onCreated / search results). */
  ingest(d) {
    if (!d || d.id == null) return null;
    let rec = this.byId.get(d.id);
    const fresh = !rec;
    if (!rec) {
      rec = { id: d.id, url: '', filename: '', state: d.state, bytes_received: 0, total_bytes: -1, tab_id: null, tab_id_source: 'none' };
      this.byId.set(d.id, rec);
      this.items.push(rec);
      if (this.items.length > this.max) {
        const dropped = this.items.splice(0, this.items.length - this.max);
        for (const x of dropped) this.byId.delete(x.id);
      }
    }
    this._merge(rec, d);
    const claim = this.claims.get(d.id);
    if (claim) {
      this.claims.delete(d.id);
      rec.tab_id = claim.tab_id;
      rec.tab_id_source = 'explicit';
      rec.tab_id_why = 'the download tool started it for this tab (targetTab)';
    }
    // F1-②: nothing claims it and chrome gave no tabId → one honest heuristic pass.
    if (fresh && rec.tab_id_source === 'none') this._attribute(rec, d);
    return rec;
  }

  /** chrome.downloads.onChanged delta — only the changed sub-fields are present. */
  async applyDelta(delta) {
    if (!delta || delta.id == null) return null;
    let rec = this.byId.get(delta.id);
    if (!rec) {
      // service worker restarted after onCreated: hydrate from the browser ledger
      const [full] = await chrome.downloads.search({ id: delta.id }).catch(() => []);
      rec = this.ingest(full || { id: delta.id });
    }
    const before = rec && rec.state;
    this._merge(rec, {
      state: delta.state?.current,
      bytesReceived: delta.bytesReceived?.current,
      totalBytes: delta.totalBytes?.current,
      paused: delta.paused?.current,
      mime: delta.mime?.current,
      filename: delta.filename?.current,
      error: delta.error?.current,
      endTime: delta.endTime?.current,
      // DownloadDelta is the ONE type in this API that carries tabId; when the
      // browser fills it the record becomes trustworthy without any guessing
      tabId: delta.tabId?.current,
    });
    return { rec, before };
  }

  pub(rec) {
    if (!rec) return null;
    const out = {
      id: rec.id,
      url: rec.url,
      filename: rec.filename,
      state: rec.state,
      bytes_received: rec.bytes_received,
      total_bytes: rec.total_bytes,
      tab_id: rec.tab_id ?? null,
      start_time: rec.start_time,
    };
    out.tab_id_source = rec.tab_id_source || 'none';
    if (rec.mime) out.mime = rec.mime;
    if (rec.error) out.error = rec.error;
    return out;
  }

  withPath(rec) {
    const out = this.pub(rec);
    if (!out) return null;
    out.path = rec.abs;
    out.text_readable = isTextish(rec.mime, rec.abs || rec.filename);
    out.tab_id_why = rec.tab_id_why || 'no attribution attempted';
    return out;
  }

  list({ tab_id, state, limit = 50 } = {}) {
    let items = this.items;
    if (tab_id != null) items = items.filter((r) => r.tab_id === tab_id);
    if (state) items = items.filter((r) => r.state === state);
    return items.slice(-Math.max(1, limit)).reverse().map((r) => this.withPath(r));
  }

  get(id) {
    return this.byId.get(id) || null;
  }

  /** background.js listener entry point: record + tell the agent. */
  created(d) {
    const rec = this.ingest(d);
    if (rec && d) {
      this.signals.items += 1;
      if (d.tabId != null && d.tabId >= 0) this.signals.with_tabid += 1;
      if (typeof d.referrer === 'string' && d.referrer) this.signals.with_referrer += 1;
      if (typeof d.finalUrl === 'string' && d.finalUrl) this.signals.with_final_url += 1;
      if (typeof d.mime === 'string' && d.mime) this.signals.with_mime += 1;
    }
    if (rec && this.emit) this.emit('download.started', this.pub(rec));
    return rec;
  }

  async changed(delta) {
    if (delta && delta.tabId?.current != null && delta.tabId.current >= 0) this.signals.deltas_with_tabid += 1;
    const r = await this.applyDelta(delta);
    if (!r || !r.rec || !this.emit) return r && r.rec;
    const { rec, before } = r;
    if (rec.state !== before) {
      if (rec.state === 'complete') this.emit('download.completed', this.pub(rec));
      else if (rec.state === 'interrupted') this.emit('download.failed', this.pub(rec));
    }
    return rec;
  }
}

export const downloadLedger = new DownloadLedger(200);

async function lookup(id) {
  const [d] = await chrome.downloads.search({ id }).catch(() => []);
  if (d) downloadLedger.ingest(d);
  await downloadLedger.settled();
  return downloadLedger.get(id) || null;
}

export function register(dispatcher) {
  const R = (name, meta, fn) => dispatcher.register(name, meta, fn);

  R('download.list', {
    category: 'diagnostics',
    description:
      'Recent downloads observed by the extension (ring of 200, newest first) — includes blob: and server-generated downloads the agent never triggered itself, so use this instead of guessing after a click. Two providers are MERGED and deduped by download id (the ledger first, chrome.downloads for history it never saw). TAB FILTERING, as it really behaves: every record carries tab_id + tab_id_source, and a tab_id query can only match records whose source is "explicit" (the download tool started it for that tab, or chrome reported the tabId itself) or "heuristic" (exactly one tab with a recorded action in the last 20s has a document origin matching the download url/referrer). Chrome puts NO tabId on a DownloadItem, so a page-initiated download no single tab explains keeps tab_id:null and NO tab_id query will ever see it — drop the filter before concluding nothing downloaded. A zero-hit answer names both providers, the attribution mix and the reason. Each item carries an absolute path, so read text files from the terminal — never paste binary content into the conversation.',
  }, async (p = {}) => {
    const limit = Math.min(Math.max(Number(p.limit) || 50, 1), 200);
    const ledgerItems = downloadLedger.list({ tab_id: p.tab_id, state: p.state, limit });
    // chrome.downloads answers for downloads the ledger never saw (service-worker
    // restart). It used to run ONLY when the ledger came back empty, so a tab_id
    // query that matched nothing swapped the provider and reported count:0 with
    // source:"chrome.downloads" while the ledger was holding the record the whole
    // time (LIVE-RESULTS-2B 7c) — so ask both, always, and merge.
    const raw = await chrome.downloads.search({ limit }).catch(() => []);
    const history = Array.isArray(raw) ? raw : [];
    for (const d of history) downloadLedger.ingest(d);
    // an unattributed fresh record gets one heuristic pass; do not answer the
    // caller from a snapshot taken while that pass is still running
    await downloadLedger.settled();
    // the filter reads the LEDGER record, not the raw item: that is where the
    // explicit/heuristic attribution lives (a raw DownloadItem has no tabId)
    const browserItems = history
      .map((d) => downloadLedger.withPath(downloadLedger.get(d.id)))
      .filter((it) => it && (p.tab_id == null || it.tab_id === p.tab_id) && (!p.state || it.state === p.state))
      .reverse();
    const ledgerIds = new Set(ledgerItems.map((it) => it.id));
    const seen = new Set();
    const items = [];
    for (const it of [...ledgerItems, ...browserItems]) {
      if (!it || seen.has(it.id)) continue;
      seen.add(it.id);
      items.push(it);
    }
    const trimmed = items.slice(0, limit);
    const chromeOnly = trimmed.filter((it) => !ledgerIds.has(it.id)).length;
    // an empty answer must never blame one provider: both were queried
    let source = 'ledger+chrome.downloads';
    if (trimmed.length && chromeOnly === 0) source = 'ledger';
    else if (trimmed.length && ledgerIds.size === 0) source = 'chrome.downloads';
    const mix = { explicit: 0, heuristic: 0, none: 0 };
    for (const r of downloadLedger.items) mix[(r.tab_id_source === 'explicit' || r.tab_id_source === 'heuristic') ? r.tab_id_source : 'none'] += 1;
    const attributed = mix.explicit + mix.heuristic;
    let note;
    if (!trimmed.length) {
      const sig = downloadLedger.signals;
      const tabsSeen = [...new Set(downloadLedger.items.map((r) => r.tab_id).filter((t) => t != null))];
      note =
        `nothing matched — looked at ${downloadLedger.items.length} ledger record(s) and ${history.length} from chrome.downloads` +
        `${p.state ? `, state=${p.state}` : ''}` +
        `${p.tab_id == null ? '' : `, tab_id=${p.tab_id}`}. ` +
        `tab ids actually recorded: ${JSON.stringify(tabsSeen)}; attribution mix explicit=${mix.explicit} heuristic=${mix.heuristic} none=${mix.none}. ` +
        (p.tab_id == null
          ? `${mix.none} of them carry no tab at all, so no tab_id query could ever return them.`
          : `a tab_id filter only reaches the ${attributed} attributed record(s); the other ${mix.none} come from the page and ` +
            `this browser never hands out a tab for them (onCreated items seen: ${sig.items}, of which tabId present: ${sig.with_tabid}; ` +
            'onChanged deltas carrying tabId: ' + sig.deltas_with_tabid + ') — retry without tab_id (it does not narrow anything else), ' +
            'or start the transfer with the download tool + tab_id, which is attributed by construction.');
    }
    return redact({
      downloads: trimmed,
      count: trimmed.length,
      source,
      tab_attribution: mix,
      browser_signals: { ...downloadLedger.signals },
      ...(note ? { note } : {}),
      hint: 'complete items carry an absolute path: `ubb download cat <id>` prints the text ones (daemon-side, bounded + redacted); for binaries take the path only and keep its bytes out of the conversation',
    });
  });

  R('download.wait', {
    category: 'diagnostics',
    timeoutMs: 70_000,
    description:
      'Block until a download reaches complete|interrupted (or the timeout). Returns the final record with its absolute path. On timeout raises DOWNLOAD_PENDING with the current state — call again instead of assuming failure.',
  }, async (p = {}) => {
    const id = p.download_id;
    if (id == null) throw err('BAD_PARAMS', 'download_id required — take it from download.list or the download tool');
    const timeoutMs = Math.min(Math.max(Number(p.timeout_ms) || 30_000, 500), 300_000);
    const deadline = Date.now() + timeoutMs;
    let rec = null;
    let tries = 0;
    for (;;) {
      rec = await lookup(id);
      tries += 1;
      if (rec && (rec.state === 'complete' || rec.state === 'interrupted')) {
        return redact({
          done: true,
          ...downloadLedger.withPath(rec),
          hint: rec.state === 'complete'
            ? `read it from path — text-ish: \`ubb download cat ${id}\`; keep binary bytes out of the conversation`
            : 'interrupted: see the error field for the cause, do not click the same link again',
        });
      }
      if (!rec && tries >= 3) {
        throw err('NOT_FOUND', `no download with id ${id}; run download.list to find the real id`);
      }
      if (Date.now() >= deadline) {
        throw err(
          'DOWNLOAD_PENDING',
          `download ${id} is still ${rec ? rec.state : 'unknown'} after ${timeoutMs}ms — call download.wait again with a longer timeout_ms (it has not failed)`,
          { download_id: id, state: rec ? rec.state : null, bytes_received: rec?.bytes_received, total_bytes: rec?.total_bytes },
        );
      }
      await sleep(200);
    }
  });

  R('download.path', {
    category: 'diagnostics',
    description:
      'Filesystem path + state of a download by id (superset of the older download.path: adds state, size, mime, basename and text_readable, and answers for in-progress downloads too). Prefer download.list when you do not know the id.',
  }, async (p = {}) => {
    const id = p.download_id;
    if (id == null) throw err('BAD_PARAMS', 'download_id required — take it from download.list or the download tool');
    const rec = await lookup(id);
    if (!rec) throw err('NOT_FOUND', `no download with id ${id}; run download.list`);
    const out = downloadLedger.withPath(rec);
    out.ready = rec.state === 'complete';
    out.hint = out.text_readable
      ? `text-ish: \`ubb download cat ${id}\` prints it from the daemon side (or open the path in a terminal); binaries must not be read into the conversation (take the path only)`
      : 'binary: take the path only, do not put its content into the conversation';
    return redact(out);
  });

  R('download.status', {
    category: 'diagnostics',
    description:
      'Progress/state of one download by id (superset of the older download.status: state / bytes_received / total / paused / url are kept verbatim, id, filename, path, mime, total_bytes, text_readable and ready added). tab_id / tab_id_source / tab_id_why tell you whether this one is attributable to a tab at all: "explicit" = the download tool started it or the browser reported the tab, "heuristic" = matched to the single tab whose recent action + document origin explain it, "none" + tab_id:null = the browser never said which tab, so no tab_id filter can find it. Use it to poll an in-progress transfer, download.wait to block on it, download.path for the file only.',
  }, async (p = {}) => {
    const id = p.download_id;
    if (id == null) throw err('BAD_PARAMS', 'download_id required — take it from download.list or the download tool');
    const rec = await lookup(id);
    if (!rec) throw err('NOT_FOUND', `no download with id ${id}; run download.list to find the real id`);
    const out = downloadLedger.withPath(rec);
    // legacy spelling of download.status — callers that read `total` keep working
    out.total = rec.total_bytes;
    out.paused = rec.paused === true;
    out.ready = rec.state === 'complete';
    out.hint =
      rec.state === 'complete'
        ? out.text_readable
          ? 'complete + text-ish: `ubb download cat ' + id + '` prints it, or open path from a terminal'
          : 'complete + binary: take the path only, do not put its bytes into the conversation'
        : rec.state === 'interrupted'
          ? 'interrupted: see the error field, do not click the same link again'
          : 'still transferring: poll download.status again or block with download.wait';
    return redact(out);
  });

  R('audit.tail', {
    category: 'diagnostics',
    description:
      'Incremental read of the in-memory operation audit ring (500 entries, lost on service-worker restart — `ubb audit tail --follow` drains it to ~/.ubb/audit/*.jsonl). Pass the last seq you saw as since_seq; entries come back oldest-first with the same ordering. Use it to see what actually ran after a long task.',
  }, async (p = {}) => {
    const since = Number(p.since_seq) || 0;
    const limit = Math.min(Math.max(Number(p.limit) || 200, 1), 500);
    const entries = audit.listSince(since, limit);
    return redact({
      entries,
      count: entries.length,
      last_seq: entries.length ? entries[entries.length - 1].seq : since,
      ring_min_seq: audit.minSeq(),
      ring_seq: audit.seq,
      dropped_before_cursor: Math.max(0, audit.minSeq() - since - 1),
      note: audit.seq < since ? 'service worker restarted — seq reset; ring_seq is lower than your since_seq, resume from 0' : undefined,
    });
  });

  R('audit.stats', {
    category: 'diagnostics',
    description:
      'Per-tool call/error counts and timing (avg + max ms) bucketed by day over the last `window` days (default 7, "all" for everything kept). Read this before retry-looping a failing tool.',
  }, async (p = {}) => redact(audit.stats(p.window)));

  // download.read is deliberately NOT registered: a service worker cannot read
  // arbitrary local files (no fs, file:// fetch is refused). download.list /
  // download.path / download.status hand back the absolute path instead, and
  // `ubb download cat <id>` (daemon/cli/download.mjs) reads the text-ish ones
  // from the Node side, where reading a file is allowed and bounded.
}
