// Foreign-extension iframe monitor: neutralizes chrome-extension:// iframes
// from OTHER extensions that make chrome.debugger.attach fail on a tab
// (exact problem + fix observed in TraeWork & QwenWork native-bridge code).
// Runs passively; only acts when armed by the background.

(() => {
  if (window.__ubbMonitor) return;
  window.__ubbMonitor = true;

  let armed = false;
  let observer = null;
  const OWN = location.protocol === 'chrome-extension:' ? location.host : chrome.runtime?.id;

  function neutralize(frame) {
    try {
      const src = frame.getAttribute('src') || '';
      let host = '';
      try {
        host = new URL(src, location.href).host;
      } catch {}
      if (src.startsWith('about:blank') || !src) return;
      if (!/^(chrome|edge)-extension:$/i.test(new URL(src, location.href).protocol)) return;
      if (host && host === OWN) return;
      frame.setAttribute('data-ubb-neutralized', src);
      frame.setAttribute('src', 'about:blank');
      const srcdoc = frame.getAttribute('srcdoc');
      if (srcdoc) frame.setAttribute('srcdoc', '');
    } catch {}
  }

  function scanAll(root) {
    try {
      root.querySelectorAll?.('iframe').forEach(neutralize);
      // shadow roots
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
      let el;
      while ((el = walker.nextNode())) {
        if (el.shadowRoot) scanAll(el.shadowRoot);
      }
    } catch {}
  }

  function arm(on) {
    armed = on;
    if (on) {
      scanAll(document);
      observer = new MutationObserver((muts) => {
        if (!armed) return;
        for (const m of muts) {
          if (m.type === 'attributes') {
            if (m.target.nodeName === 'IFRAME') neutralize(m.target);
          } else {
            for (const n of m.addedNodes) {
              if (n.nodeName === 'IFRAME') neutralize(n);
              else if (n.querySelectorAll) n.querySelectorAll?.('iframe').forEach(neutralize);
            }
          }
        }
      });
      observer.observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'srcdoc'] });
    } else if (observer) {
      observer.disconnect();
      observer = null;
    }
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'UBB_MONITOR') {
      arm(!!msg.on);
      sendResponse({ ok: true, armed: !!msg.on });
    }
  });
})();
