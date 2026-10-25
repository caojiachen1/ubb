// Clipboard bridge: execCommand works in extension pages with the
// clipboardRead/clipboardWrite permissions (the documented offscreen pattern).
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== 'UBB_CLIPBOARD') return;
  try {
    const ta = document.getElementById('ta');
    ta.value = '';
    if (msg.op === 'write') {
      ta.value = String(msg.text ?? '');
      ta.focus();
      ta.select();
      ta.setSelectionRange(0, ta.value.length);
      const ok = document.execCommand('copy');
      sendResponse({ ok, chars: ta.value.length });
    } else {
      ta.focus();
      ta.select();
      const ok = document.execCommand('paste');
      sendResponse({ ok, text: ta.value });
    }
  } catch (e) {
    sendResponse({ ok: false, error: String(e) });
  }
  return true;
});
