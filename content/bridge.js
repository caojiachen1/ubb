// UBB page bridge: main-content text extraction, React-safe form fill,
// keyword element search, DOM-fallback tree with @dN refs
// (role heuristics from Qoder/QwenWork content scripts).

(() => {
  if (window.__ubbBridge) return;
  const domRefs = new Map(); // "@dN" → WeakRef element
  let nextDom = 1;

  const CONTENT_SELECTORS = [
    'article', 'main', '[role="main"]', '[class*="article-body"]', '#content', '.content',
  ];

  function visible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0';
  }

  function roleOf(el) {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit.toLowerCase();
    const tag = el.tagName.toLowerCase();
    if (tag === 'a') return 'link';
    if (tag === 'button') return 'button';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'img') return 'image';
    if (tag === 'li') return 'listitem';
    if (/^h[1-6]$/.test(tag)) return 'heading';
    if (tag === 'input') {
      const t = (el.getAttribute('type') || 'text').toLowerCase();
      if (t === 'checkbox') return 'checkbox';
      if (t === 'radio') return 'radio';
      if (t === 'number') return 'spinbutton';
      if (t === 'range') return 'slider';
      if (t === 'search') return 'searchbox';
      if (['submit', 'button', 'reset'].includes(t)) return 'button';
      return 'textbox';
    }
    if (el.onclick || el.onmousedown) return 'button';
    return null;
  }

  function nameOf(el) {
    return (
      el.getAttribute('aria-label') ||
      el.getAttribute('title') ||
      el.getAttribute('placeholder') ||
      el.alt ||
      el.textContent?.trim().slice(0, 80) ||
      ''
    );
  }

  const INTERACTIVE = new Set([
    'button', 'link', 'textbox', 'searchbox', 'combobox', 'checkbox', 'radio',
    'slider', 'spinbutton', 'menuitem', 'option', 'tab', 'switch', 'treeitem',
  ]);

  function domRef(el) {
    for (const [k, wr] of domRefs) {
      if (wr.deref() === el) return k;
    }
    const k = `@d${nextDom++}`;
    domRefs.set(k, new WeakRef(el));
    return k;
  }

  function getDomTree({ filter = 'interactive', depth = 14, max_chars = 30000 } = {}) {
    const lines = [];
    let count = 0;
    const walk = (el, d) => {
      if (d > depth || lines.join('\n').length > max_chars) return;
      if (el.shadowRoot) walk(el.shadowRoot, d); // shadow-DOM piercing
      for (const child of el.children) {
        if (!visible(child)) continue;
        const role = roleOf(child);
        const keep = filter === 'all' ? true : role && INTERACTIVE.has(role);
        if (keep) {
          const name = nameOf(child).replace(/\s+/g, ' ');
          const bits = [domRef(child), role];
          if (name) bits.push(JSON.stringify(name.slice(0, 60)));
          if (child.disabled) bits.push('[disabled]');
          lines.push('  '.repeat(d) + bits.join(' '));
          count++;
        }
        if (child.shadowRoot) walk(child.shadowRoot, keep ? d + 1 : d);
        walk(child, keep ? d + 1 : d);
      }
    };
    walk(document.body, 0);
    return { text: lines.join('\n'), ref_count: count };
  }

  function getPageText({ max_chars = 50000 } = {}) {
    let best = '';
    for (const sel of CONTENT_SELECTORS) {
      for (const el of document.querySelectorAll(sel)) {
        const t = el.textContent || '';
        if (t.trim().length > best.trim().length) best = t;
      }
    }
    const text = (best || document.body?.innerText || '').replace(/\n{3,}/g, '\n\n').trim();
    return {
      text: text.slice(0, max_chars) + (text.length > max_chars ? `\n…[truncated]` : ''),
      url: location.href,
      title: document.title,
    };
  }

  function nativeSet(el, value) {
    // React/Vue-safe: use the prototype setter, then fire a bubbling input event
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(proto.prototype, 'value')?.set;
    if (setter) setter.call(el, String(value));
    else el.value = String(value);
    el.dispatchEvent(
      new InputEvent('input', { bubbles: true, inputType: 'insertText', data: String(value) }),
    );
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.focus();
    try {
      el.setSelectionRange(el.value.length, el.value.length);
    } catch {}
  }

  function fillDom({ selector, ref, value }) {
    const el = ref
      ? domRefs.get(ref)?.deref()
      : document.querySelector(selector);
    if (!el) throw new Error(ref ? 'stale DOM ref: ' + ref : 'selector not found: ' + selector);
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      nativeSet(el, value);
    } else if (el.isContentEditable) {
      el.focus();
      document.execCommand('selectAll');
      document.execCommand('insertText', false, String(value));
    } else {
      throw new Error('element is not fillable');
    }
    return true;
  }

  function search({ query, limit = 10 }) {
    const q = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
    if (!q.length) return { matches: [] };
    const out = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    let el;
    while ((el = walker.nextNode()) && out.length < limit * 3) {
      if (!visible(el)) continue;
      const aria = (el.getAttribute('aria-label') || '').toLowerCase();
      const title = (el.getAttribute('title') || '').toLowerCase();
      const role = roleOf(el) || '';
      const text = (el.textContent || '').trim().toLowerCase().slice(0, 120);
      let score = 0;
      for (const w of q) {
        if (aria.includes(w) || title.includes(w)) score += 3;
        if (role.includes(w)) score += 2;
        if (text.includes(w)) score += 1;
      }
      if (score > 0) out.push({ score, el });
    }
    out.sort((a, b) => b.score - a.score);
    return {
      matches: out.slice(0, limit).map(({ el, score }) => ({
        ref: INTERACTIVE.has(roleOf(el) || '') ? domRef(el) : null,
        role: roleOf(el),
        name: nameOf(el).slice(0, 60) || undefined,
        score,
        tag: el.tagName.toLowerCase(),
      })),
    };
  }

  function clickDom({ ref, selector }) {
    const el = selector ? document.querySelector(selector) : domRefs.get(ref)?.deref();
    if (!el) throw new Error(selector ? 'selector not found: ' + selector : 'stale DOM ref');
    el.scrollIntoView({ block: 'center' });
    el.click();
    return true;
  }

  const api = { getPageText, fillDom, search, clickDom, getDomTree, visible, roleOf };
  window.__ubbBridge = api;

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type !== 'UBB_BRIDGE') return;
    try {
      const fn = api[msg.op];
      if (typeof fn !== 'function') throw new Error(`unknown op ${msg.op}`);
      sendResponse({ ok: true, result: fn(msg.args || {}) });
    } catch (e) {
      sendResponse({ ok: false, error: String(e?.message || e) });
    }
  });
})();
