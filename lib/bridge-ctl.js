// Thin wrapper over the content-script bridge (content/bridge.js):
// text extraction, React-safe form fill, element search, DOM-fallback tree.

export async function bridge(tabId, op, args = {}) {
  try {
    const r = await chrome.tabs.sendMessage(tabId, { type: 'UBB_BRIDGE', op, args });
    if (r && r.ok) return r.result;
    throw new Error(r?.error || `bridge op "${op}" failed`);
  } catch (e) {
    if (/could not establish connection|Receiving end does not exist/i.test(String(e))) {
      throw new Error('BRIDGE_UNREACHABLE');
    }
    throw e;
  }
}
