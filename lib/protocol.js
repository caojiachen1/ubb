// JSON-RPC dispatcher with per-request AbortController (cancel semantics
// and per-tool timeouts.

import { err, DEFAULT_TOOL_TIMEOUT_MS } from './config.js';

export class Dispatcher {
  constructor() {
    this.tools = new Map(); // name → { meta, fn(params, ctx) }
    this.pending = new Map(); // requestId → AbortController
    this.onFinish = null;
  }

  register(name, meta, fn) {
    this.tools.set(name, { meta, fn });
  }

  listTools() {
    return [...this.tools.entries()].map(([name, { meta }]) => ({
      name,
      description: meta.description || '',
      category: meta.category || 'general',
      timeout_ms: meta.timeoutMs || DEFAULT_TOOL_TIMEOUT_MS,
      sensitive: !!meta.sensitive,
    }));
  }

  cancel(requestId) {
    const ac = this.pending.get(requestId);
    if (!ac) return false;
    if (!ac.signal.aborted) ac.abort();
    return true;
  }

  /** Abort every in-flight tool; returns how many were actually cancelled. */
  cancelAll() {
    let cancelled = 0;
    for (const ac of this.pending.values()) {
      if (ac.signal.aborted) continue;
      ac.abort();
      cancelled += 1;
    }
    return cancelled;
  }

  /**
   * Handle one inbound daemon message. Returns the response object to send
   * back, or null (notifications handled internally).
   */
  async handle(msg) {
    if (!msg || typeof msg !== 'object') return null;
    if (msg.method === 'cancel' && msg.params?.id != null) {
      const cancelled = this.cancel(msg.params.id);
      return msg.id != null ? { id: msg.id, result: { cancelled } } : null;
    }
    if (msg.method === 'tool.list') {
      return msg.id != null ? { id: msg.id, result: { tools: this.listTools() } } : null;
    }
    if (msg.method == null || msg.id == null) return null;

    const name = msg.method.startsWith('tool.') ? msg.method.slice(5) : msg.method;
    const entry = this.tools.get(name);
    if (!entry) {
      return { id: msg.id, error: err('UNKNOWN_TOOL', `unknown tool "${msg.method}"`) };
    }

    const ac = new AbortController();
    this.pending.set(msg.id, ac);
    const timeoutMs = entry.meta.timeoutMs || DEFAULT_TOOL_TIMEOUT_MS;
    const t0 = Date.now();
    try {
      const result = await withTimeout(
        entry.fn(msg.params || {}, { signal: ac.signal, requestId: msg.id }),
        timeoutMs,
        err('TOOL_TIMEOUT', `${name} exceeded ${timeoutMs}ms`, { outcome: 'unknown' }),
        ac,
      );
      // A cooperative abort does not stop a non-cooperative tool. If the work
      // completed after cancellation, reporting success would invite the agent
      // to act on a result the user already revoked.
      if (ac.signal.aborted) {
        if (this.onFinish) this.onFinish(name, msg.params || {}, false, Date.now() - t0, 'CANCELLED');
        return {
          id: msg.id,
          error: err('CANCELLED', `${name} was cancelled after it started; side effects are unknown`, { outcome: 'unknown' }),
        };
      }
      if (this.onFinish) this.onFinish(name, msg.params || {}, true, Date.now() - t0);
      return { id: msg.id, result: result === undefined ? { ok: true } : result };
    } catch (e) {
      const error = e && e.code ? { ...e } : err('TOOL_FAILED', String(e?.message || e));
      // "cancelled" / "timed out" never means "nothing happened": queued work
      // may have run, and an in-flight CDP action cannot be un-sent.
      if (ac.signal.aborted && !error.data) error.data = { outcome: 'unknown' };
      if (this.onFinish) this.onFinish(name, msg.params || {}, false, Date.now() - t0, error.code);
      return { id: msg.id, error };
    } finally {
      this.pending.delete(msg.id);
    }
  }
}

function withTimeout(promise, ms, timeoutError, ac) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ac.abort();
      reject(timeoutError);
    }, ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}
