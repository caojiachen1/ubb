// UBB page bridge: main-content text extraction, React-safe form fill,
// keyword element search, DOM-fallback tree with @dN refs
// (role heuristics tuned on common content and social sites).

(() => {
  if (window.__ubbBridge) return;
  const domRefs = new Map(); // "@dN" → WeakRef element
  let nextDom = 1;
  // one identity per JS context: the extension compares this against the value
  // it saw at snapshot time to catch a frame whose document was swapped
  const DOC_EPOCH = Math.random().toString(36).slice(2, 10);
  // same rule as guardSensitiveField in lib/actions.js — kept textually in
  // sync (正本 there). The NEVER class has no bypass; the password class
  // yields ONLY to allowPassword, which lib/tools.js sets from the
  // daemon-stamped __ubb_secret_fill (contract §4.5/§5 placeholder path).
  const PASSWORD_FIELD = /(password|passwd|密码)/i;
  const SENSITIVE_FIELD_NEVER =
    /(otp|one[-\s]?time|验证码|cvv|cvc|card.?number|卡号|secret|私钥)/i;

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

  function getDomTree({ filter = 'interactive', depth = 14, max_chars = 30000, framePath } = {}) {
    const rootDoc = resolveDoc(framePath);
    const lines = [];
    const entries = [];
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
          entries.push({ ref: bits[0], role, name: name.slice(0, 60), depth: d, disabled: !!child.disabled });
          count++;
        }
        if (child.shadowRoot) walk(child.shadowRoot, keep ? d + 1 : d);
        walk(child, keep ? d + 1 : d);
      }
    };
    walk(rootDoc.body || rootDoc.documentElement, 0);
    return { text: lines.join('\n'), ref_count: count, entries };
  }

  function getPageText({ max_chars = 50000, framePath } = {}) {
    const doc = resolveDoc(framePath);
    const view = doc.defaultView || window;
    let best = '';
    for (const sel of CONTENT_SELECTORS) {
      for (const el of doc.querySelectorAll(sel)) {
        const t = el.textContent || '';
        if (t.trim().length > best.trim().length) best = t;
      }
    }
    const text = (best || doc.body?.innerText || '').replace(/\n{3,}/g, '\n\n').trim();
    return {
      text: text.slice(0, max_chars) + (text.length > max_chars ? `\n…[truncated]` : ''),
      url: view.location.href,
      title: doc.title,
    };
  }

  function nativeSet(el, value) {
    // React/Vue-safe: use the prototype setter, then fire a bubbling input
    // event. Constructors are resolved in the ELEMENT's realm: a framePath-
    // descended node is from another window and fails top-realm instanceof.
    const win = (el.ownerDocument && el.ownerDocument.defaultView) || window;
    const TA = win.HTMLTextAreaElement || HTMLTextAreaElement;
    const IN = win.HTMLInputElement || HTMLInputElement;
    const proto = el instanceof TA || el.tagName === 'TEXTAREA' ? TA : IN;
    const setter = Object.getOwnPropertyDescriptor(proto.prototype, 'value')?.set;
    if (setter) setter.call(el, String(value));
    else el.value = String(value);
    el.dispatchEvent(new (win.InputEvent || InputEvent)('input', { bubbles: true, inputType: 'insertText', data: String(value) }));
    el.dispatchEvent(new (win.Event || Event)('change', { bubbles: true }));
    el.focus();
    try {
      el.setSelectionRange(el.value.length, el.value.length);
    } catch {}
  }

  function fillDom({ selector, ref, value, allowPassword, framePath }) {
    const doc = resolveDoc(framePath);
    const el = ref
      ? domRefs.get(ref)?.deref()
      : doc.querySelector(selector);
    if (!el) throw new Error(ref ? 'stale DOM ref: ' + ref : 'selector not found: ' + selector);
    // same split rule as the @eN fill path: OTP/payment/key fields are never
    // auto-filled; password fields yield only to a daemon-resolved secret
    // (allowPassword from __ubb_secret_fill) — a plaintext value in the args
    // still means nothing, the daemon never stamps without a placeholder.
    const isInput = el instanceof HTMLInputElement || el.tagName === 'INPUT';
    if (isInput) {
      const hay = [el.type, el.autocomplete, el.name, el.id, el.placeholder, el.getAttribute('aria-label')].join(' ');
      if (el.autocomplete === 'one-time-code' || SENSITIVE_FIELD_NEVER.test(hay)) {
        throw new Error('SENSITIVE_FIELD: this looks like an OTP / payment / secret-key field — UBB never auto-fills these, whatever the source; ask the user to type it');
      }
      if ((el.type === 'password' || PASSWORD_FIELD.test(hay)) && allowPassword !== true) {
        throw new Error('SENSITIVE_FIELD: password field — plaintext values are refused here; use a {{secret:NAME}} placeholder in fill so the daemon resolves it');
      }
    }
    if (isInput || el instanceof HTMLTextAreaElement || el.tagName === 'TEXTAREA') {
      nativeSet(el, value);
    } else if (el.isContentEditable) {
      el.focus();
      doc.execCommand('selectAll');
      doc.execCommand('insertText', false, String(value));
    } else {
      throw new Error('element is not fillable');
    }
    return true;
  }

  function search({ query, limit = 10, framePath } = {}) {
    const q = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
    if (!q.length) return { matches: [] };
    const doc = resolveDoc(framePath);
    const out = [];
    const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_ELEMENT);
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

  // ---- frame identity + geometry (Wave 2-D) ---------------------------------
  // Same-origin hops are descended with framePath (indices into the document-
  // order list that childFrameBoxes returns); cross-origin frames get their own
  // injected copy of this script and are ROUTED by the extension via
  // tabs.sendMessage({frameId}) — the two mechanisms never guess at each other.

  function frameIndexOf(doc, order) {
    const els = [...doc.querySelectorAll('iframe, frame')];
    return els[order] || null;
  }

  function childFrameBoxes() {
    const els = [...document.querySelectorAll('iframe, frame')];
    return {
      frames: els.map((el, order) => {
        let sameOrigin = false;
        let liveUrl = '';
        try {
          sameOrigin = !!el.contentDocument;
          if (sameOrigin) liveUrl = el.contentWindow.location.href;
        } catch {}
        const r = el.getBoundingClientRect();
        return {
          order,
          tag: el.tagName.toLowerCase(),
          id: el.id || '',
          name: el.getAttribute('name') || '',
          src: el.src || (el.getAttribute('srcdoc') != null ? 'srcdoc' : ''),
          liveUrl,
          sameOrigin,
          rect: { x: r.x, y: r.y, width: r.width, height: r.height },
          borderLeft: el.clientLeft,
          borderTop: el.clientTop,
        };
      }),
    };
  }

  function selfInfo() {
    let isFrame = true;
    try { isFrame = window.self !== window.top; } catch { isFrame = true; }
    let sameOriginAncestry = false;
    try { void window.top.location.href; sameOriginAncestry = true; } catch {}
    let stamp = null;
    try { stamp = window.frameElement ? window.frameElement.getAttribute('data-ubb-fh') : null; } catch {}
    return {
      epoch: DOC_EPOCH,
      url: location.href,
      origin: location.origin,
      title: document.title,
      isFrame,
      sameOriginAncestry,
      name: window.name || '',
      stamp,
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      dpr: window.devicePixelRatio,
      scroll: { x: window.scrollX || 0, y: window.scrollY || 0 },
    };
  }

  function resolveDoc(framePath) {
    let doc = document;
    for (const idx of framePath || []) {
      const el = frameIndexOf(doc, idx);
      if (!el) throw new Error('FRAME_PATH_MISS: no child frame at index ' + idx);
      let cd = null;
      try { cd = el.contentDocument; } catch {}
      if (!cd) throw new Error('FRAME_CROSS_ORIGIN: hop ' + idx + ' is not same-origin — route the message to that frame instead');
      doc = cd;
    }
    return doc;
  }

  // one hop up: childRect (child viewport CSS px) → coords in el's own viewport
  function composeUp(el, childRect) {
    const r = el.getBoundingClientRect();
    let kx = 1;
    let ky = 1;
    try {
      if (el.contentWindow && el.contentWindow.innerWidth > 0) kx = r.width / el.contentWindow.innerWidth;
      if (el.contentWindow && el.contentWindow.innerHeight > 0) ky = r.height / el.contentWindow.innerHeight;
    } catch {}
    return {
      x: r.x + el.clientLeft + childRect.x * kx,
      y: r.y + el.clientTop + childRect.y * ky,
      width: childRect.width * kx,
      height: childRect.height * ky,
    };
  }

  // compose an element's rect up to THIS frame's viewport through same-origin
  // ancestors (getBoundingClientRect is already scroll-correct in each frame)
  function absoluteRect(el) {
    let rect = el.getBoundingClientRect();
    let view = el.ownerDocument.defaultView;
    while (view && view !== window) {
      let fe = null;
      try { fe = view.frameElement; } catch { break; }
      if (!fe) break;
      rect = composeUp(fe, rect);
      view = fe.ownerDocument.defaultView;
    }
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  }

  function describeRef({ ref, selector, framePath, scroll } = {}) {
    const doc = resolveDoc(framePath);
    const el = ref ? domRefs.get(ref)?.deref() : doc.querySelector(selector);
    if (!el) throw new Error(ref ? 'stale DOM ref: ' + ref : 'selector not found: ' + selector);
    if (scroll) {
      try { el.scrollIntoView({ block: 'center', inline: 'nearest' }); } catch {}
    }
    const view = el.ownerDocument.defaultView || window;
    const st = view.getComputedStyle ? view.getComputedStyle(el) : null;
    const vis = visible(el);
    const hay = [el.type, el.autocomplete, el.name, el.id, el.placeholder, el.getAttribute('aria-label'), nameOf(el)].join(' ');
    const isInput = el instanceof HTMLInputElement;
    return {
      ref: domRef(el),
      tag: el.tagName.toLowerCase(),
      role: roleOf(el),
      name: nameOf(el).slice(0, 80),
      local: el.getBoundingClientRect(),
      box: absoluteRect(el), // in THIS frame's viewport; the extension composes
      // frame-chain offsets on top for routed (cross-origin) frames
      visible: vis && (!st || (st.visibility !== 'hidden' && st.display !== 'none')),
      disabled: !!el.disabled,
      checked: typeof el.checked === 'boolean' ? el.checked : undefined,
      attributes: {
        type: el.type || undefined,
        name: el.name || undefined,
        id: el.id || undefined,
        placeholder: el.placeholder || undefined,
        autocomplete: el.autocomplete || undefined,
        'aria-label': el.getAttribute('aria-label') || undefined,
        href: el.href || undefined,
        src: el.src || undefined,
      },
      // same split as fillDom — the routed fill guard reads this
      sensitive: {
        never: isInput && (el.autocomplete === 'one-time-code' || SENSITIVE_FIELD_NEVER.test(hay)),
        password: isInput && (el.type === 'password' || PASSWORD_FIELD.test(hay)),
      },
    };
  }

  function selectDom({ ref, selector, value, framePath }) {
    const doc = resolveDoc(framePath);
    const el = ref ? domRefs.get(ref)?.deref() : doc.querySelector(selector);
    if (!el) throw new Error(ref ? 'stale DOM ref: ' + ref : 'selector not found: ' + selector);
    if (el.tagName !== 'SELECT') throw new Error('element is not a <select>');
    const opt = [...(el.options || [])].find((o) => o.value === value || (o.textContent || '').trim() === value);
    if (!opt) throw new Error('option not found: ' + value);
    const view = el.ownerDocument.defaultView || window;
    Object.getOwnPropertyDescriptor(view.HTMLSelectElement.prototype, 'value').set.call(el, opt.value);
    el.dispatchEvent(new view.Event('change', { bubbles: true }));
    // honest flag: this is a synthetic DOM event, not trusted user/CDP input
    return { selected: (opt.textContent || '').trim(), synthetic: true };
  }

  // identity handshake for ambiguous child frames (same URL siblings):
  // attr works only same-origin (child reads its own frameElement); window.name
  // works cross-origin per HTML spec (the child's OWN read returns the raw
  // value). Both are stamped → read → restored, so the page keeps its state.
  function stampChild({ order, token, via = 'attr' }) {
    const el = frameIndexOf(document, order);
    if (!el) throw new Error('no child frame at index ' + order);
    try {
      if (via === 'attr') {
        el.setAttribute('data-ubb-fh', String(token));
        return { ok: true };
      }
      const prev = el.contentWindow ? el.contentWindow.name : '';
      el.contentWindow.name = String(token);
      return { ok: true, restore: prev || '' };
    } catch (e) {
      return { ok: false, error: String(e?.message || e) };
    }
  }

  function unstampChild({ order, via = 'attr', restore }) {
    const el = frameIndexOf(document, order);
    if (!el) return { ok: false, error: 'frame element gone' };
    try {
      if (via === 'attr') el.removeAttribute('data-ubb-fh');
      else el.contentWindow.name = String(restore || '');
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e?.message || e) };
    }
  }

  function readStamp() {
    const out = { name: window.name || '', stamp: null };
    try { out.stamp = window.frameElement ? window.frameElement.getAttribute('data-ubb-fh') : null; } catch {}
    return out;
  }


  // ---- structured extraction: tables/lists → JSON/CSV with coverage ----------
  // Reads loaded DOM only; completeness is reported via coverage, never assumed.

  function cellText(el) {
    return el ? (el.textContent || '').replace(/\s+/g, ' ').trim() : null;
  }

  function extractData({
    selector, item_selector, fields,
    max_rows = 500, max_columns = 100, max_bytes = 1048576,
    framePath,
  } = {}) {
    const warnings = [];
    const doc = resolveDoc(framePath);
    const view = doc.defaultView || window;

    // ---- list mode: repeated cards with per-item field selectors
    if (item_selector) {
      if (!Array.isArray(fields) || !fields.length) {
        throw new Error('list mode needs fields: [{key, selector, read: text|href|attribute}]');
      }
      const roots = [...doc.querySelectorAll(item_selector)].filter(visible);
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
        url: view.location.href,
        title: doc.title,
      };
    }

    // ---- table mode: <table> elements (selector optional)
    let tables;
    if (selector) {
      tables = [...doc.querySelectorAll(selector)]
        .map((el) => (el.tagName === 'TABLE' ? el : el.querySelector('table')))
        .filter(Boolean);
    } else {
      tables = [...doc.querySelectorAll('table')].filter(visible);
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
      url: view.location.href,
      title: doc.title,
    };
  }

  // ---- site-aware extraction: hostname-routed page rules ---------------------
  // Hostname-routed structured extraction returning {text, images, videos}.
  // Image positions are referenced inline as {{IMG_N}} markers.

  function genericExtract(doc = document) {
    const clone = doc.body.cloneNode(true);
    for (const sel of ['script', 'style', 'noscript', 'iframe', 'svg', 'nav', 'footer', 'header']) {
      clone.querySelectorAll(sel).forEach((el) => el.remove());
    }
    const text = (clone.innerText || clone.textContent || '')
      .replace(/\n{3,}/g, '\n\n').replace(/[ \t]+/g, ' ').trim();
    const images = [];
    const main = doc.querySelector('article, main, .content, .post-content, .entry-content') || doc.body;
    for (const img of main.querySelectorAll('img')) {
      const src = img.src || img.getAttribute('data-src');
      if (!src || src.startsWith('data:image/svg')) continue;
      const w = img.naturalWidth || img.width || 0;
      const h = img.naturalHeight || img.height || 0;
      if (w > 0 && w < 100 && h > 0 && h < 100) continue;
      images.push({ src, alt: img.alt || '' });
    }
    return { text, images };
  }

  function imgRef(images, img, src) {
    images.push({ src, alt: img.alt || '' });
    return '![' + (img.alt || '') + ']({{IMG_' + (images.length - 1) + '}})';
  }

  // Site rules are DATA, not code (content/site-rules.json): the six extractors
  // this engine replaces were hardcoded here, so every new site meant editing
  // the extension and reloading it. A rule only names selectors and literal
  // text — there is deliberately NO executable field anywhere in this grammar,
  // so a hostile rule file cannot become an injection surface (the block
  // interpreter below only ever reads the keys it knows, and site.rules.validate
  // rejects unknown/executable keys before anything is stored).
  // Kept deep-equal with content/site-rules.json by daemon/test-sites.mjs.
  const DEFAULT_SITE_RULES = [
    {
      id: 'github',
      match: { host_pattern: ['github.com'] },
      referer: 'https://github.com',
      extract: [
        { op: 'text', select: '[itemprop="name"] a, .AppHeader-context-item-label', prefix: '# ' },
        { op: 'text', select: '.f4.my-3, [class*="About"] p, .repository-content .f4' },
        { op: 'join_texts', select: '.topic-tag, a[data-octo-click="topic_click"]', prefix: 'Topics: ', separator: ', ', emit_on: 'matched' },
        { op: 'text', select: '#readme article, .markdown-body', lead_part: '\n---\n' },
        { op: 'images', select: 'img', within: '#readme article, .markdown-body', src_attrs: ['src'], exclude: 'badge|shields\\.io|avatar' },
        {
          op: 'group', when: { selector_found: '.js-issue-title, .gh-header-title' },
          then: [
            { op: 'reset' },
            { op: 'text', select: '.js-issue-title, .gh-header-title', prefix: '# ' },
            { op: 'text', select: '.comment-body .markdown-body' },
            { op: 'images', select: 'img', within: '.comment-body .markdown-body', src_attrs: ['src'], exclude: 'avatar' },
            { op: 'repeat', select: '.timeline-comment .comment-body', max: 11, then: [{ op: 'text', item: true, prefix: '---\n' }] },
          ],
        },
      ],
    },
    {
      id: 'zhihu',
      match: { host_pattern: ['zhihu.com'] },
      referer: 'https://www.zhihu.com',
      extract: [
        { op: 'text', select: '.QuestionHeader-title, h1.QuestionPage-title', prefix: '# ' },
        { op: 'text', select: '.QuestionHeader-detail .RichText' },
        {
          op: 'repeat', select: '.RichContent-inner, .Post-RichText, .RichText.ztext', max: 6, min_chars: 50,
          then: [
            { op: 'text', from_closest: { within: '.AnswerItem, .ContentItem', select: '.AuthorInfo-name, .UserLink-link' }, prefix: '## ', suffix: ' 的回答' },
            { op: 'text', item: true },
            { op: 'images', select: 'img[data-original], img[data-actualsrc], figure img', item: true, src_attrs: ['data-original', 'data-actualsrc', 'src'], exclude: 'equation|avatar' },
          ],
        },
        // one gate for the whole zhuanlan fallback: three separately-gated
        // blocks would each see the parts the previous one pushed and drop the
        // body images (the old zhihuExtract checked parts.length <= 1 once)
        {
          op: 'group', when: { parts_below: 2 },
          then: [
            { op: 'text', select: '.Post-Title', prefix: '# ' },
            { op: 'text', select: '.Post-RichTextContainer, .RichText.ztext.Post-RichText' },
            { op: 'images', select: 'img[data-original], img[data-actualsrc], figure img', within: '.Post-RichTextContainer, .RichText.ztext.Post-RichText', src_attrs: ['data-original', 'data-actualsrc', 'src'], exclude: 'equation|avatar' },
          ],
        },
      ],
    },
    {
      id: 'juejin',
      match: { host_pattern: ['juejin.cn'] },
      referer: 'https://juejin.cn',
      extract: [
        { op: 'text', select: '.article-title, h1', prefix: '# ' },
        { op: 'text', select: '.author-name, .username', prefix: 'Author: ' },
        { op: 'text', select: '.article-content, .markdown-body' },
        { op: 'images', select: 'img', within: '.article-content, .markdown-body', src_attrs: ['src', 'data-src'], exclude: 'avatar|user-gold-cdn' },
        { op: 'join_texts', select: '.tag-list .tag, a[href*="/tag/"]', prefix: 'Tags: ', separator: ', ', drop_empty: true, emit_on: 'values' },
      ],
    },
    {
      id: 'wechat',
      match: { host_pattern: ['mp.weixin.qq.com'] },
      referer: 'https://mp.weixin.qq.com',
      extract: [
        { op: 'text', select: '#activity-name, .rich_media_title', prefix: '# ' },
        { op: 'text', select: '#js_name, .rich_media_meta_nickname', prefix: 'Author: ' },
        { op: 'text', select: '#js_content, .rich_media_content' },
        { op: 'images', select: 'img[data-src]', within: '#js_content, .rich_media_content', src_attrs: ['data-src'] },
      ],
    },
    {
      id: 'xiaohongshu',
      match: { host_pattern: ['xiaohongshu.com'] },
      referer: 'https://www.xiaohongshu.com',
      extract: [
        {
          op: 'text', prefix: '# ',
          attempts: [
            { select: '#detail-title, .note-content .title, [class*="note-title"], [class*="noteTitle"]' },
            { select: 'h1, [class*="title"]' },
          ],
        },
        {
          op: 'images', skip_data_uri: true, dedup: true, min_width: 50, width_default: 999,
          src_attrs: ['src', 'data-src', 'currentSrc'],
          attempts: [
            { select: '.note-image-list img, [class*="slide"] img[src*="xhscdn"], [class*="swiper-slide"] img, [class*="carousel"] img[src], .media-container img' },
            { select: 'img[src*="xhscdn"], img[src*="xiaohongshu"]' },
          ],
        },
        {
          op: 'text',
          attempts: [
            { select: '#detail-desc', min_chars: 10 },
            { select: '.note-content .desc', min_chars: 10 },
            { select: '[class*="note-text"]', min_chars: 10 },
            { select: '[class*="noteText"]', min_chars: 10 },
            { select: '[class*="content"] [class*="desc"]', min_chars: 10 },
            { select: '.note-detail .content', min_chars: 10 },
            { select: '[id*="detail"] [class*="desc"]', min_chars: 10 },
            { select: '[class*="note"] p, [class*="note"] span, [class*="detail"] p, [class*="detail"] span', pick: 'longest', min_chars: 20 },
          ],
        },
        { op: 'join_texts', select: '[class*="tag"] a, a[href*="/search_result/"], a[href*="/explore/"] [class*="tag"]', prefix: '\nTags: ', separator: ' ', dedup: true, filter_prefix: '#', emit_on: 'values' },
        { op: 'videos', select: 'video', count_part: '\n[Video: {N} clip(s) captured]' },
      ],
    },
    {
      id: 'twitter',
      match: { host_pattern: ['x.com', 'twitter.com'] },
      join: '\n\n---\n\n',
      referer: 'https://x.com',
      extract: [
        {
          op: 'group', when: { selector_found: 'article[data-testid="tweet"]' },
          then: [
            { op: 'text', within: 'article[data-testid="tweet"]', select: '[data-testid="User-Name"]', prefix: '@' },
            { op: 'text', within: 'article[data-testid="tweet"]', select: '[data-testid="tweetText"]' },
            { op: 'images', within: 'article[data-testid="tweet"]', select: '[data-testid="tweetPhoto"] img', src_attrs: ['src'], exclude: 'emoji|profile_images' },
            { op: 'videos', within: 'article[data-testid="tweet"]', select: 'video' },
            { op: 'text', within: 'article[data-testid="tweet"]', select: 'time', attr: 'datetime', prefix: 'Time: ' },
            { op: 'join_texts', within: 'article[data-testid="tweet"]', select: '[data-testid$="count"]', prefix: 'Engagement: ', separator: ' | ', drop_empty: true, emit_on: 'matched' },
          ],
        },
        {
          op: 'repeat', select: 'article[data-testid="tweet"]', max: 20, when: { parts_below: 1 },
          then: [
            { op: 'text', select: '[data-testid="tweetText"]', head: { select: '[data-testid="User-Name"]', prefix: '@', suffix: ': ', split_on: '·', split_index: 0 } },
            { op: 'images', item: true, select: '[data-testid="tweetPhoto"] img', src_attrs: ['src'], exclude: 'emoji|profile_images' },
          ],
        },
      ],
    },
  ];

  let userSiteRules = []; // pushed by site.rules.reload — shadow builtins by order + id
  let bundledRules = null;
  let bundledRulesFrom = 'builtin-constant';

  async function loadBundledRules() {
    if (bundledRules) return;
    try {
      // fallback path only: lib/tools-sites.js (SW) fetches the packaged file and
      // bridge-ctl attaches it to every extractSite call, so this fetch usually
      // never runs. It stays because a content script cannot reach its own
      // packaged resource without web_accessible_resources — if the SW cache is
      // cold/empty (provider error) and this fetch fails too, the constant below
      // is what answers, so read_site never goes blank
      const res = await fetch(chrome.runtime.getURL('content/site-rules.json'));
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data.rules) && data.rules.length) {
          bundledRules = data.rules;
          bundledRulesFrom = 'packaged-json';
          return;
        }
      }
    } catch { /* packaged JSON unreachable */ }
    bundledRules = DEFAULT_SITE_RULES;
  }

  const activeSiteRules = () => [...userSiteRules, ...bundledRules];

  const elText = (el) => (el && el.textContent || '').trim();

  // every block runs inside a try/catch by the caller: a missing selector or a
  // bad regex loses THAT item, never the whole extraction (extract's discipline:
  // report coverage, never assume completeness)
  function gatePass(b, doc, st) {
    const w = b.when;
    if (!w) return true;
    if (w.selector_found && !doc.querySelector(w.selector_found)) return false;
    if (w.selector_absent && doc.querySelector(w.selector_absent)) return false;
    if (w.parts_below != null && st.parts.length >= w.parts_below) return false;
    return true;
  }

  function ruleRoot(b, ctx) {
    const scope = ctx.item || ctx.doc;
    if (b.item) return ctx.item || ctx.doc;
    if (b.within) return scope.querySelector(b.within);
    return scope;
  }

  // one attempt = {select, pick?, min_chars?}. pick 'first' (default): the
  // FIRST matched element, kept only when its text clears min_chars (or when no
  // min_chars is set — an existing-but-empty element still counts, as the old
  // extractors did). pick 'longest': first element achieving the max text
  // length above min_chars.
  function pickEl(attempt, root) {
    const min = attempt.min_chars || 0;
    if (attempt.pick === 'longest') {
      let best = null;
      let bestLen = 0;
      for (const el of root.querySelectorAll(attempt.select)) {
        const n = elText(el).length;
        if (n > min && n > bestLen) { best = el; bestLen = n; }
      }
      return best;
    }
    const el = root.querySelector(attempt.select);
    if (!el) return null;
    return min ? (elText(el).length > min ? el : null) : el;
  }

  function runTextBlock(b, st, ctx) {
    let el = null;
    if (b.item && ctx.item) el = ctx.item;
    else if (b.from_closest && ctx.item) {
      const anc = ctx.item.closest(b.from_closest.within);
      if (anc) el = anc.querySelector(b.from_closest.select);
    } else {
      const root = ruleRoot(b, ctx);
      if (!root) return;
      for (const a of (b.attempts || [b])) {
        el = pickEl(a, root);
        if (el) break;
      }
    }
    if (!el) return;
    let value = b.attr ? el.getAttribute(b.attr) : elText(el);
    if (value == null) return; // old twitter pushed "Time: null"; missing data is skipped now
    if (b.lead_part) st.parts.push(b.lead_part);
    if (b.head && ctx.item) {
      const headEl = ctx.item.querySelector(b.head.select);
      if (headEl) {
        let h = String(headEl.textContent || '');
        if (b.head.split_on) h = (h.split(b.head.split_on)[b.head.split_index || 0] || '');
        value = (b.head.prefix || '') + h.trim() + (b.head.suffix || '') + value;
      }
    }
    st.parts.push((b.prefix || '') + value + (b.suffix || ''));
  }

  function runJoinTextsBlock(b, st, ctx) {
    const root = ruleRoot(b, ctx);
    if (!root) return;
    const els = [...root.querySelectorAll(b.select)];
    let vals = els.map(elText);
    if (b.filter_prefix) vals = vals.filter((t) => t.startsWith(b.filter_prefix));
    if (b.drop_empty) vals = vals.filter(Boolean);
    if (b.dedup) vals = [...new Set(vals)];
    if ((b.emit_on === 'values' ? vals : els).length) st.parts.push((b.prefix || '') + vals.join(b.separator || ', '));
  }

  function runImagesBlock(b, st, ctx) {
    const root = ruleRoot(b, ctx);
    if (!root) return;
    let els = [];
    for (const a of (b.attempts || [b])) {
      els = [...root.querySelectorAll(a.select)];
      if (els.length) break;
    }
    const rx = b.exclude ? new RegExp(b.exclude) : null;
    const seen = new Set();
    for (const img of els) {
      let src = null;
      for (const name of (b.src_attrs || ['src', 'data-src'])) {
        src = /^(src|currentSrc|poster|href)$/.test(name) ? img[name] : img.getAttribute(name);
        if (src) break;
      }
      if (!src) continue;
      if (b.skip_data_uri && String(src).startsWith('data:')) continue;
      if (rx && rx.test(src)) continue;
      if (b.min_width) {
        const w = img.naturalWidth || img.width || parseInt(img.getAttribute('width')) || b.width_default || 0;
        if (w < b.min_width) continue;
      }
      if (b.dedup) {
        if (seen.has(src)) continue;
        seen.add(src);
      }
      st.parts.push(imgRef(st.images, img, src));
    }
  }

  function runVideosBlock(b, st, ctx, rule) {
    const root = ruleRoot(b, ctx);
    if (!root) return;
    const pageUrl = (ctx.doc.defaultView || window).location.href;
    for (const v of root.querySelectorAll(b.select || 'video')) {
      let src = v.src || v.currentSrc;
      if (!src) { const s = v.querySelector('source'); if (s) src = s.src; }
      if (src && !String(src).startsWith('blob:')) st.videos.push({ src, poster: v.poster || undefined, type: 'video', referer: rule.referer });
      else if (v.poster) st.videos.push({ src: pageUrl, poster: v.poster, type: 'video-blob', referer: rule.referer, note: 'video is blob: access via the original page' });
    }
    if (b.count_part && st.videos.length) st.parts.push(b.count_part.replace('{N}', String(st.videos.length)));
  }

  function runBlock(st, b, ctx, rule) {
    switch (b.op) {
      case 'reset': st.parts.length = 0; st.images.length = 0; return;
      case 'text': return runTextBlock(b, st, ctx);
      case 'join_texts': return runJoinTextsBlock(b, st, ctx);
      case 'images': return runImagesBlock(b, st, ctx);
      case 'videos': return runVideosBlock(b, st, ctx, rule);
      case 'repeat': {
        const root = ruleRoot(b, ctx);
        if (!root) return;
        const items = [...root.querySelectorAll(b.select)].slice(0, b.max == null ? Infinity : b.max);
        for (const item of items) {
          if (b.min_chars && elText(item).length <= b.min_chars) continue;
          for (const sub of b.then || []) runBlockSafe(st, sub, { ...ctx, item }, rule);
        }
        return;
      }
      case 'group': {
        for (const sub of b.then || []) runBlockSafe(st, sub, ctx, rule);
        return;
      }
      default: throw new Error('unknown op: ' + b.op);
    }
  }

  function runBlockSafe(st, b, ctx, rule) {
    try {
      if (!gatePass(b, ctx.doc, st)) { st.blocks_skipped++; return; }
      st.blocks_run++;
      runBlock(st, b, ctx, rule);
    } catch (e) {
      st.warnings.push(`block ${b && b.op || '?'}: ${String(e?.message || e)}`);
      st.blocks_skipped++;
    }
  }

  // returns null when the rule produces nothing usable (empty text or rejected)
  function runSiteRule(rule, doc) {
    const st = { parts: [], images: [], videos: [], warnings: [], blocks_run: 0, blocks_skipped: 0 };
    for (const b of rule.extract || []) runBlockSafe(st, b, { doc }, rule);
    let text = st.parts.join(rule.join || '\n\n');
    if (rule.normalize && rule.normalize.collapse_blank_lines) text = text.replace(/\n{3,}/g, '\n\n');
    const rj = rule.reject;
    if (rj) {
      if (rj.text_below != null && text.trim().length < rj.text_below) return null;
      if (rj.text_matches && new RegExp(rj.text_matches).test(text)) return null;
    }
    if (!text.trim()) return null;
    return { text, images: st.images, videos: st.videos, referer: rule.referer, coverage: st };
  }

  async function extractSite({ max_chars = 50000, framePath, rules } = {}) {
    // rules comes from the SW (lib/bridge-ctl attaches the packaged site-rules.json
    // + storage overrides on every extractSite call) — a content script cannot fetch
    // its own packaged resource without web_accessible_resources, so the service
    // worker is the only context that can read it. Absent rules fall back to the
    // built-in constant, so a stale/unserved cache still answers read_site.
    let active;
    if (Array.isArray(rules) && rules.length) {
      active = rules;
    } else {
      await loadBundledRules();
      active = activeSiteRules();
    }
    const doc = resolveDoc(framePath);
    const view = doc.defaultView || window;
    const host = view.location.hostname;
    let r = null;
    let site = 'generic';
    let ruleId = null;
    for (const rule of active) {
      try {
        if (!rule || typeof rule !== 'object' || !rule.match || !Array.isArray(rule.extract)) continue;
        const hp = Array.isArray(rule.match.host_pattern) ? rule.match.host_pattern : [rule.match.host_pattern];
        const hit = hp.find((h) => h && host.includes(String(h)));
        if (!hit) continue;
        if (rule.match.path_pattern && !new RegExp(rule.match.path_pattern).test(view.location.href)) continue;
        if (rule.match.test_selector && !doc.querySelector(rule.match.test_selector)) continue;
        r = runSiteRule(rule, doc);
        if (!r) continue; // rejected rules yield to lower-priority ones, then generic
        site = hit;
        ruleId = rule.id || hit;
        break;
      } catch { r = null; } // a broken rule must never take read_site down
    }
    let coverage = null;
    if (!r) {
      r = genericExtract(doc);
      coverage = { engine: 'generic' };
    } else {
      const c = r.coverage;
      coverage = { rule: ruleId, blocks_run: c.blocks_run, blocks_skipped: c.blocks_skipped, warnings: c.warnings };
    }
    const fullText = String(r.text || '');
    coverage.truncated = fullText.length > max_chars;
    return {
      site,
      text: fullText.slice(0, max_chars),
      images: r.images || [],
      videos: r.videos || [],
      url: view.location.href,
      title: doc.title,
      rule: ruleId || 'generic',
      coverage,
    };
  }

  // recursive walk: every string under a selector-carrying key must at least
  // PARSE against this document (existence is not required — this is a syntax probe)
  function collectRuleSelectors(node, out) {
    if (Array.isArray(node)) { for (const x of node) collectRuleSelectors(x, out); return out; }
    if (!node || typeof node !== 'object') return out;
    for (const [k, v] of Object.entries(node)) {
      if (typeof v === 'string' && /^(select|within|test_selector|selector_found|selector_absent)$/.test(k)) out.push(v);
      else if (typeof v === 'object') collectRuleSelectors(v, out);
    }
    return out;
  }

  function siteRulesCheck({ rules } = {}) {
    const results = [];
    for (const rule of Array.isArray(rules) ? rules : []) {
      const sels = collectRuleSelectors(rule, []);
      const issues = [];
      for (const sel of sels) {
        try { document.querySelector(sel); } catch (e) { issues.push({ selector: sel, error: String(e?.message || e) }); }
      }
      results.push({ id: rule && rule.id, selectors_checked: sels.length, issues });
    }
    return { results };
  }

  const saneRule = (r) => r && typeof r === 'object' && typeof r.id === 'string' && r.match && typeof r.match === 'object' && Array.isArray(r.extract);

  function siteRulesSet({ rules } = {}) {
    const list = Array.isArray(rules) ? rules : [];
    userSiteRules = list.filter(saneRule);
    return { accepted: userSiteRules.length, rejected: list.length - userSiteRules.length };
  }

  async function siteRulesList() {
    await loadBundledRules();
    const userIds = new Set(userSiteRules.map((r) => r.id));
    return {
      rules: [
        ...userSiteRules.map((r) => ({ id: r.id, source: 'user', match: r.match })),
        ...bundledRules.filter((r) => !userIds.has(r.id)).map((r) => ({ id: r.id, source: 'builtin', match: r.match })),
      ],
      builtin_source: bundledRulesFrom,
    };
  }


  // ---- user action recording (semantic trace, hardened) ----------------------
  // Events survive same-tab navigation via sessionStorage; password fields are
  // masked as ***; hard cap 10 minutes; stop via record_stop.

  const REC_KEY = '__ubb_rec';
  const REC_MAX_MS = 600000;
  const REC_MAX_BYTES = 2 * 1024 * 1024;

  function recordTarget(el) {
    const cls = el.className && typeof el.className === 'string' ? '.' + el.className.split(/\s+/).filter(Boolean).join('.') : '';
    // additive fields only (B's fixtures read the old names): the COMPUTED AX
    // role (Chrome exposes it as element.computedRole) with the tag-name
    // fallback roleOf() already used, so replay matching stops guessing from
    // 'input'/'a' alone
    return {
      selector: el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + cls,
      text: (el.textContent || '').trim().slice(0, 50),
      role: el.getAttribute('role') || el.tagName.toLowerCase(),
      ariaRole: el.computedRole || roleOf(el) || el.tagName.toLowerCase(),
      label: el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('name') || '',
      frame: window.self !== window.top ? 1 : 0,
    };
  }

  function recHash(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) h = ((h << 5) - h + str.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  }

  function recordStart({ description } = {}) {
    let rec = null;
    const orphan = (() => { try { return JSON.parse(sessionStorage.getItem(REC_KEY) || 'null'); } catch { return null; } })();
    if (orphan && orphan.active) {
      // same-tab navigation: adopt the previous page's recording and continue
      rec = orphan;
      rec.events.push({ type: 'navigation', timestamp: Date.now() - rec._t0, url: location.href, note: 'page changed; recording continued' });
    } else {
      try { sessionStorage.removeItem(REC_KEY); } catch {}
      rec = {
        id: 'rec_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
        description: String(description || ''),
        startedAt: new Date().toISOString(),
        _t0: Date.now(),
        startUrl: location.href,
        events: [{ type: 'start', timestamp: 0, url: location.href }],
        snapshots: [],
        active: true,
      };
    }
    window.__ubbRecording = rec;
    const ts = () => Date.now() - rec._t0;

    let snapHash = '';
    function captureSnapshot() {
      if (rec.snapshots.length >= 50) return null;
      let content = '# ' + document.title + '\n# url: ' + location.href + '\n';
      try {
        const walk = (el, d) => {
          if (d > 4 || !el) return '';
          let out = '';
          const tag = el.tagName ? el.tagName.toLowerCase() : '';
          const role = el.getAttribute ? el.getAttribute('role') || '' : '';
          let text = '';
          if (el.childNodes.length === 1 && el.childNodes[0].nodeType === 3) text = el.childNodes[0].textContent.trim().slice(0, 60);
          const label = el.getAttribute ? el.getAttribute('aria-label') || el.getAttribute('placeholder') || '' : '';
          if (tag && (role || text || ['button', 'a', 'input', 'select', 'h1', 'h2', 'h3'].includes(tag))) {
            out += '  '.repeat(d) + tag + (role ? '[' + role + ']' : '') + (text ? ' "' + text + '"' : '') + (label ? ' label=' + label : '') + '\n';
          }
          for (let i = 0; i < el.children.length && i < 50; i++) out += walk(el.children[i], d + 1);
          return out;
        };
        content += walk(document.body, 0);
      } catch { /* keep the title/url header */ }
      if (content.length > 102400) content = content.slice(0, 102400);
      const h = recHash(content);
      if (h === snapHash) return null;
      snapHash = h;
      const snapId = 'snap_' + ts();
      rec.snapshots.push({ snapshotId: snapId, timestamp: ts(), url: location.href, content });
      return snapId;
    }

    const pending = [];
    let pendingTimer = null;
    let persistTimer = null;
    function persist() {
      // sessionStorage keeps the trace across SAME-origin navigations; the
      // background store covers cross-origin ones (sessionStorage is per-origin)
      try { sessionStorage.setItem(REC_KEY, JSON.stringify(rec)); } catch { /* quota: keep in memory */ }
      try {
        const plain = JSON.parse(JSON.stringify(rec, (k, v) => (k.startsWith('_') ? undefined : v)));
        chrome.runtime.sendMessage({ type: 'UBB_REC_SAVE', rec: plain }).catch(() => {});
      } catch { /* SW unreachable: sessionStorage path still covers same-origin */ }
    }
    function flushPending() {
      for (const p of pending) rec.events.push(p.event);
      pending.length = 0;
      if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null; }
      persist();
    }
    function bufferEvent(el, ev) {
      const i = pending.findIndex((p) => p.el === el);
      if (i >= 0) pending[i].event = ev; else pending.push({ el, event: ev });
      if (pendingTimer) clearTimeout(pendingTimer);
      pendingTimer = setTimeout(flushPending, 500);
    }
    function recordEvent(ev) {
      flushPending();
      rec.events.push(ev);
      if (!persistTimer) persistTimer = setTimeout(persist, 300);
    }
    const ac = new AbortController();
    rec._ac = ac;
    const on = (type, fn, opts) => document.addEventListener(type, fn, { capture: true, signal: ac.signal, ...opts });

    let pointerDrag = null, htmlDrag = null, suppressedClick = null;
    const finishDrag = (drag, endX, endY, dropEl) => {
      if (!drag) return;
      const dx = endX - drag.startX, dy = endY - drag.startY;
      if (dx * dx + dy * dy < 25) return;
      const dest = dropEl || document.elementFromPoint(endX, endY) || drag.el;
      const snapId = captureSnapshot();
      recordEvent({ type: 'drag', timestamp: ts(), snapshotId: snapId, target: drag.target, dropTarget: dest ? recordTarget(dest) : null, from: { x: drag.startX, y: drag.startY }, to: { x: endX, y: endY } });
      suppressedClick = { x: endX, y: endY, until: Date.now() + 500 };
    };
    on('pointerdown', (e) => {
      if (e.button !== 0 || e.isPrimary === false) return;
      pointerDrag = { el: e.target, target: recordTarget(e.target), startX: e.clientX, startY: e.clientY };
    });
    on('pointerup', (e) => {
      if (!pointerDrag) return;
      const d = pointerDrag; pointerDrag = null;
      finishDrag(d, e.clientX, e.clientY, document.elementFromPoint(e.clientX, e.clientY) || e.target);
    });
    on('pointercancel', () => { pointerDrag = null; });
    on('dragstart', (e) => {
      pointerDrag = null;
      htmlDrag = { el: e.target, target: recordTarget(e.target), startX: e.clientX, startY: e.clientY, dropEl: null, endX: e.clientX, endY: e.clientY };
    });
    on('drop', (e) => { if (htmlDrag) { htmlDrag.dropEl = e.target; htmlDrag.endX = e.clientX; htmlDrag.endY = e.clientY; } });
    on('dragend', (e) => {
      if (!htmlDrag) return;
      const d = htmlDrag; htmlDrag = null;
      finishDrag(d, d.dropEl ? d.endX : e.clientX, d.dropEl ? d.endY : e.clientY, d.dropEl || e.target);
    });
    on('click', (e) => {
      if (suppressedClick && Date.now() <= suppressedClick.until && Math.abs(e.clientX - suppressedClick.x) <= 5 && Math.abs(e.clientY - suppressedClick.y) <= 5) {
        suppressedClick = null;
        return;
      }
      suppressedClick = null;
      const snapId = captureSnapshot();
      recordEvent({ type: 'click', timestamp: ts(), snapshotId: snapId, target: recordTarget(e.target), position: { x: e.clientX, y: e.clientY } });
    });
    on('input', (e) => {
      const val = e.target.type === 'password' ? '***' : (e.target.value || '');
      bufferEvent(e.target, { type: 'input', timestamp: ts(), target: recordTarget(e.target), inputType: e.target.type || undefined, value: String(val).slice(0, 200) });
    });
    on('change', (e) => {
      if (e.target.tagName !== 'SELECT') return;
      recordEvent({ type: 'select', timestamp: ts(), target: recordTarget(e.target), value: e.target.value });
    });
    on('keydown', (e) => {
      if (['Enter', 'Escape', 'Tab'].includes(e.key)) recordEvent({ type: 'keypress', timestamp: ts(), key: e.key, target: recordTarget(e.target) });
    });
    let scrollTimer = null;
    on('scroll', () => {
      if (scrollTimer) clearTimeout(scrollTimer);
      scrollTimer = setTimeout(() => {
        if (rec.active) recordEvent({ type: 'scroll', timestamp: ts(), target: { selector: 'document' }, delta: { x: window.scrollX, y: window.scrollY } });
      }, 300);
    }, { passive: true });
    window.addEventListener('popstate', () => {
      if (rec.active) recordEvent({ type: 'navigation', timestamp: ts(), url: location.href, snapshotId: captureSnapshot() });
    }, { signal: ac.signal });
    window.addEventListener('hashchange', () => {
      if (rec.active) recordEvent({ type: 'navigation', timestamp: ts(), url: location.href, snapshotId: captureSnapshot() });
    }, { signal: ac.signal });
    // full navigations kill this JS context — flush synchronously so the next
    // page's recordStart adopts the trace from sessionStorage
    window.addEventListener('pagehide', () => {
      if (rec._ac) { rec._ac.abort(); rec._ac = null; }
      try { sessionStorage.setItem(REC_KEY, JSON.stringify(rec)); } catch {}
    }, { signal: ac.signal, capture: true });

    let pollUrl = location.href;
    rec._navPoll = setInterval(() => {
      if (!rec.active) return;
      if (location.href !== pollUrl) {
        pollUrl = location.href;
        recordEvent({ type: 'navigation', timestamp: ts(), url: location.href, snapshotId: captureSnapshot(), note: 'detected by URL poll' });
      }
      if (Date.now() - rec._t0 > REC_MAX_MS) recStopInternal();
      if (JSON.stringify(rec).length > REC_MAX_BYTES) recStopInternal();
    }, 800);

    function recStopInternal() {
      ac.abort();
      clearInterval(rec._navPoll);
      rec.active = false;
      persist();
    }
    rec._stop = recStopInternal;
    persist();
    return {
      id: rec.id, started_at: rec.startedAt, adopted: !!orphan && !!orphan.active,
      max_duration_ms: REC_MAX_MS,
      note: 'recording survives same-tab navigation; stop with record_stop; never record banking/SSO/password-manager pages',
    };
  }

  function recordStatus() {
    const r = window.__ubbRecording;
    return r
      ? { active: true, id: r.id, events: r.events.length, snapshots: r.snapshots.length, elapsed_ms: Date.now() - r._t0 }
      : { active: false, orphaned: (() => { try { return !!JSON.parse(sessionStorage.getItem(REC_KEY) || 'null'); } catch { return false; } })() };
  }

  function recordStop() {
    const r = window.__ubbRecording;
    if (!r) {
      const o = (() => { try { return JSON.parse(sessionStorage.getItem(REC_KEY) || 'null'); } catch { return null; } })();
      if (o) {
        try { sessionStorage.removeItem(REC_KEY); } catch {}
        return { id: o.id, description: o.description, started_at: o.startedAt, duration_ms: Date.now() - o._t0, start_url: o.startUrl, final_url: location.href, events: o.events, snapshots: o.snapshots, event_count: o.events.length, snapshot_count: o.snapshots.length, complete: true, recovered: 'same-origin' };
      }
      // cross-origin navigation: the background store has the last saved trace
      return chrome.runtime
        .sendMessage({ type: 'UBB_REC_LOAD' })
        .then((resp) => {
          if (!resp || !resp.ok || !resp.rec) throw new Error('no recording in progress');
          const o = resp.rec;
          return { id: o.id, description: o.description, started_at: o.startedAt, duration_ms: Date.now() - new Date(o.startedAt).getTime(), start_url: o.startUrl, final_url: location.href, events: o.events, snapshots: o.snapshots, event_count: o.events.length, snapshot_count: o.snapshots.length, complete: true, recovered: 'background' };
        });
    }
    if (r._stop) r._stop(); else if (r._ac) r._ac.abort();
    clearInterval(r._navPoll);
    r.active = false;
    const trace = {
      id: r.id, description: r.description, started_at: r.startedAt,
      duration_ms: Date.now() - r._t0, start_url: r.startUrl, final_url: location.href,
      events: r.events, snapshots: r.snapshots,
      event_count: r.events.length, snapshot_count: r.snapshots.length,
      complete: true,
      note: 'trace is data, not authorization; replay uses semantic targets in order',
    };
    try { sessionStorage.removeItem(REC_KEY); } catch {}
    chrome.runtime.sendMessage({ type: 'UBB_REC_SAVE', rec: null }).catch(() => {});
    delete window.__ubbRecording;
    return trace;
  }

  // the exposed op takes an args object (the old direct exposure of `visible`
  // always answered false: dispatch calls fn(msg.args), never fn(el))
  function visibleOp({ selector, ref, framePath } = {}) {
    const doc = resolveDoc(framePath);
    const el = ref ? domRefs.get(ref)?.deref() : doc.querySelector(selector);
    return { visible: visible(el) };
  }
  function roleOfOp({ selector, ref, framePath } = {}) {
    const doc = resolveDoc(framePath);
    const el = ref ? domRefs.get(ref)?.deref() : doc.querySelector(selector);
    return { role: el ? roleOf(el) : null };
  }

  const api = {
    getPageText, fillDom, search, clickDom, getDomTree, extractData, extractSite,
    recordStart, recordStatus, recordStop, visible: visibleOp, roleOf: roleOfOp,
    selfInfo, childFrameBoxes, describeRef, selectDom, stampChild, unstampChild, readStamp,
    siteRulesList, siteRulesSet, siteRulesCheck,
  };
  window.__ubbBridge = api;

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type !== 'UBB_BRIDGE') return;
    try {
      const fn = api[msg.op];
      if (typeof fn !== 'function') throw new Error(`unknown op ${msg.op}`);
      // ops may return promises (record_stop recovers a trace from the
      // background store) — keep the message channel open for them
      Promise.resolve(fn(msg.args || {})).then(
        (result) => sendResponse({ ok: true, result, frameId: sender.frameId, docEpoch: DOC_EPOCH }),
        (e) => sendResponse({ ok: false, error: String(e?.message || e), frameId: sender.frameId, docEpoch: DOC_EPOCH }),
      );
      return true;
    } catch (e) {
      sendResponse({ ok: false, error: String(e?.message || e), frameId: sender.frameId, docEpoch: DOC_EPOCH });
    }
  });
})();
