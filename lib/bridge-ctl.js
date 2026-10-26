// Thin wrapper over the content-script bridge (content/bridge.js):
// text extraction, React-safe form fill, element search, DOM-fallback tree.

// a navigation tearing the content-script context down mid-op resolves the
// sendMessage with undefined (empty error) — read-only ops settle on the new
// document within ~300ms, so retry those once; mutating ops must NEVER be
// retried here (the first attempt may have landed → double action)
const RETRYABLE_OPS = new Set(['getPageText', 'getDomTree', 'search', 'extractData', 'extractSite', 'visible', 'roleOf', 'recordStatus']);

export async function bridge(tabId, op, args = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await chrome.tabs.sendMessage(tabId, { type: 'UBB_BRIDGE', op, args });
      if (r && r.ok) return r.result;
      throw new Error(r?.error || `bridge op "${op}" failed`);
    } catch (e) {
      const msg = String(e?.message || e);
      if (attempt === 0 && RETRYABLE_OPS.has(op) && /bridge op ".*" failed$|^$/.test(msg)) {
        await new Promise((res) => setTimeout(res, 300));
        continue;
      }
      if (/could not establish connection|Receiving end does not exist/i.test(msg)) {
        throw new Error('BRIDGE_UNREACHABLE');
      }
      throw e;
    }
  }
}
