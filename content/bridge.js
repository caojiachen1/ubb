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

  // ---- structured extraction (BrowserSkill extract semantics) -----------------
  // Reads loaded DOM only; completeness is reported via coverage, never assumed.

  function cellText(el) {
    return el ? (el.textContent || '').replace(/\s+/g, ' ').trim() : null;
  }

  function extractData({
    selector, item_selector, fields,
    max_rows = 500, max_columns = 100, max_bytes = 1048576,
  } = {}) {
    const warnings = [];

    // ---- list mode: repeated cards with per-item field selectors
    if (item_selector) {
      if (!Array.isArray(fields) || !fields.length) {
        throw new Error('list mode needs fields: [{key, selector, read: text|href|attribute}]');
      }
      const roots = [...document.querySelectorAll(item_selector)].filter(visible);
      const items = [];
      let bytes = 0;
      let truncated = false;
      for (const rootEl of roots) {
        if (items.length >= max_rows) { truncated = true; warnings.push('row cap reached; remaining items skipped'); break; }
        const rec = {};
        for (const f of fields) {
          let v = null;
          const target = f.selector && f.selector !== ':scope' ? rootEl.querySelector(f.selector) : rootEl;
          if (!target) { rec[f.key] = null; continue; }
          if (f.read === 'href') v = target.href || target.getAttribute('href') || null;
          else if (f.read === 'attribute') v = f.attribute ? target.getAttribute(f.attribute) : null;
          else v = cellText(target);
          rec[f.key] = v;
        }
        bytes += JSON.stringify(rec).length;
        if (bytes > max_bytes) { truncated = true; warnings.push('byte budget reached mid-row; last row may be partial'); }
        items.push(rec);
        if (bytes > max_bytes) break;
      }
      return {
        mode: 'list',
        fields: fields.map((f) => f.key),
        items,
        coverage: { items: items.length, total_found: roots.length, truncated },
        warnings,
        url: location.href,
        title: document.title,
      };
    }

    // ---- table mode: <table> elements (selector optional)
    let tables;
    if (selector) {
      tables = [...document.querySelectorAll(selector)]
        .map((el) => (el.tagName === 'TABLE' ? el : el.querySelector('table')))
        .filter(Boolean);
    } else {
      tables = [...document.querySelectorAll('table')].filter(visible);
    }
    const out = [];
    let truncated = false;
    let bytes = 0;
    for (const t of tables) {
      if (out.length >= 20) { warnings.push('more than 20 tables matched; extras skipped'); break; }
      const headRow = t.tHead && t.tHead.rows[0];
      let headerCells = headRow ? [...headRow.cells] : null;
      let bodyRows = [...t.tBodies].flatMap((tb) => [...tb.rows]);
      if (!headerCells && bodyRows.length) {
        const first = [...bodyRows[0].cells];
        if (first.length && first.every((c) => c.tagName === 'TH')) {
          headerCells = first;
          bodyRows = bodyRows.slice(1);
        }
      }
      let headers = headerCells
        ? headerCells.slice(0, max_columns).map((c, i) => cellText(c) || `col${i}`)
        : null;
      if (headerCells && headerCells.length > max_columns) warnings.push('column cap: extra columns dropped');
      const rows = [];
      for (const tr of bodyRows) {
        if (rows.length >= max_rows) { truncated = true; warnings.push('row cap reached; remaining rows skipped'); break; }
        const cells = [...tr.cells].slice(0, max_columns);
        const row = headers
          ? headers.map((_, i) => cellText(cells[i]))
          : cells.map(cellText);
        if (!headers) row.columns_used = undefined; // positional rows stay arrays
        rows.push(row);
        bytes += JSON.stringify(row).length;
        if (bytes > max_bytes) { truncated = true; warnings.push('byte budget reached mid-table'); break; }
      }
      if (!headers) headers = null;
      out.push({
        headers,
        rows,
        coverage: {
          rows: rows.length,
          total_body_rows: bodyRows.length,
          columns: headers ? headers.length : (bodyRows[0] ? [...bodyRows[0].cells].length : 0),
          truncated: rows.length < bodyRows.length,
        },
      });
      if (bytes > max_bytes) break;
    }
    if (!out.length && !tables.length && selector) warnings.push(`no <table> under selector: ${selector}`);
    return {
      mode: 'table',
      tables: out,
      coverage: { tables: out.length, truncated },
      warnings,
      url: location.href,
      title: document.title,
    };
  }

  const api = { getPageText, fillDom, search, clickDom, getDomTree, extractData, visible, roleOf };
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
