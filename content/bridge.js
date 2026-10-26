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

  // ---- site-aware extraction (TraeWork extractor rules, de-duplicated) --------
  // Hostname-routed structured extraction returning {text, images, videos}.
  // Image positions are referenced inline as {{IMG_N}} markers.

  function genericExtract() {
    const clone = document.body.cloneNode(true);
    for (const sel of ['script', 'style', 'noscript', 'iframe', 'svg', 'nav', 'footer', 'header']) {
      clone.querySelectorAll(sel).forEach((el) => el.remove());
    }
    const text = (clone.innerText || clone.textContent || '')
      .replace(/\n{3,}/g, '\n\n').replace(/[ \t]+/g, ' ').trim();
    const images = [];
    const main = document.querySelector('article, main, .content, .post-content, .entry-content') || document.body;
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

  function githubExtract() {
    const parts = [], images = [];
    const repo = document.querySelector('[itemprop="name"] a, .AppHeader-context-item-label');
    if (repo) parts.push('# ' + repo.textContent.trim());
    const desc = document.querySelector('.f4.my-3, [class*="About"] p, .repository-content .f4');
    if (desc) parts.push(desc.textContent.trim());
    const topics = document.querySelectorAll('.topic-tag, a[data-octo-click="topic_click"]');
    if (topics.length) parts.push('Topics: ' + [...topics].map((t) => t.textContent.trim()).join(', '));
    const readme = document.querySelector('#readme article, .markdown-body');
    if (readme) {
      parts.push('\n---\n', readme.textContent.trim());
      for (const img of readme.querySelectorAll('img')) {
        if (img.src && !/badge|shields\.io|avatar/.test(img.src)) parts.push(imgRef(images, img, img.src));
      }
    }
    const issueTitle = document.querySelector('.js-issue-title, .gh-header-title');
    if (issueTitle) {
      parts.length = 0; images.length = 0;
      parts.push('# ' + issueTitle.textContent.trim());
      const body = document.querySelector('.comment-body .markdown-body');
      if (body) {
        parts.push(body.textContent.trim());
        for (const img of body.querySelectorAll('img')) {
          if (img.src && !img.src.includes('avatar')) parts.push(imgRef(images, img, img.src));
        }
      }
      document.querySelectorAll('.timeline-comment .comment-body').forEach((c, i) => {
        if (i > 10) return;
        parts.push('---\n' + c.textContent.trim());
      });
    }
    return parts.length ? { text: parts.join('\n\n'), images, referer: 'https://github.com' } : null;
  }

  function zhihuExtract() {
    const parts = [], images = [];
    const q = document.querySelector('.QuestionHeader-title, h1.QuestionPage-title');
    if (q) parts.push('# ' + q.textContent.trim());
    const qd = document.querySelector('.QuestionHeader-detail .RichText');
    if (qd) parts.push(qd.textContent.trim());
    const richSel = 'img[data-original], img[data-actualsrc], figure img';
    document.querySelectorAll('.RichContent-inner, .Post-RichText, .RichText.ztext').forEach((answer, i) => {
      if (i > 5) return;
      const text = answer.textContent.trim();
      if (text.length <= 50) return;
      const item = answer.closest('.AnswerItem, .ContentItem');
      const author = item ? item.querySelector('.AuthorInfo-name, .UserLink-link') : null;
      if (author) parts.push('## ' + author.textContent.trim() + ' 的回答');
      parts.push(text);
      for (const img of answer.querySelectorAll(richSel)) {
        const src = img.getAttribute('data-original') || img.getAttribute('data-actualsrc') || img.src;
        if (src && !/equation|avatar/.test(src)) parts.push(imgRef(images, img, src));
      }
    });
    if (parts.length <= 1) {
      const at = document.querySelector('.Post-Title');
      const ac = document.querySelector('.Post-RichTextContainer, .RichText.ztext.Post-RichText');
      if (at) parts.push('# ' + at.textContent.trim());
      if (ac) {
        parts.push(ac.textContent.trim());
        for (const img of ac.querySelectorAll(richSel)) {
          const src = img.getAttribute('data-original') || img.getAttribute('data-actualsrc') || img.src;
          if (src && !/equation|avatar/.test(src)) parts.push(imgRef(images, img, src));
        }
      }
    }
    return parts.length ? { text: parts.join('\n\n'), images, referer: 'https://www.zhihu.com' } : null;
  }

  function juejinExtract() {
    const parts = [], images = [];
    const title = document.querySelector('.article-title, h1');
    if (title) parts.push('# ' + title.textContent.trim());
    const author = document.querySelector('.author-name, .username');
    if (author) parts.push('Author: ' + author.textContent.trim());
    const content = document.querySelector('.article-content, .markdown-body');
    if (content) {
      parts.push(content.textContent.trim());
      for (const img of content.querySelectorAll('img')) {
        const src = img.src || img.getAttribute('data-src');
        if (src && !/avatar|user-gold-cdn/.test(src)) parts.push(imgRef(images, img, src));
      }
    }
    const tags = document.querySelectorAll('.tag-list .tag, a[href*="/tag/"]');
    if (tags.length) parts.push('Tags: ' + [...tags].map((t) => t.textContent.trim()).filter(Boolean).join(', '));
    return parts.length ? { text: parts.join('\n\n'), images, referer: 'https://juejin.cn' } : null;
  }

  function wechatExtract() {
    const parts = [], images = [];
    const title = document.querySelector('#activity-name, .rich_media_title');
    if (title) parts.push('# ' + title.textContent.trim());
    const author = document.querySelector('#js_name, .rich_media_meta_nickname');
    if (author) parts.push('Author: ' + author.textContent.trim());
    const content = document.querySelector('#js_content, .rich_media_content');
    if (content) {
      parts.push(content.textContent.trim());
      for (const img of content.querySelectorAll('img[data-src]')) {
        parts.push(imgRef(images, img, img.getAttribute('data-src')));
      }
    }
    return parts.length ? { text: parts.join('\n\n'), images, referer: 'https://mp.weixin.qq.com' } : null;
  }

  function xiaohongshuExtract() {
    const parts = [], images = [], videos = [];
    const titleEl = document.querySelector('#detail-title, .note-content .title, [class*="note-title"], [class*="noteTitle"]')
      || document.querySelector('h1, [class*="title"]');
    if (titleEl) parts.push('# ' + titleEl.textContent.trim());
    let noteImages = document.querySelectorAll('.note-image-list img, [class*="slide"] img[src*="xhscdn"], [class*="swiper-slide"] img, [class*="carousel"] img[src], .media-container img');
    if (!noteImages.length) noteImages = document.querySelectorAll('img[src*="xhscdn"], img[src*="xiaohongshu"]');
    const seen = new Set();
    for (const img of noteImages) {
      const src = img.src || img.getAttribute('data-src') || img.currentSrc;
      if (!src || src.startsWith('data:') || seen.has(src)) continue;
      const w = img.naturalWidth || img.width || parseInt(img.getAttribute('width')) || 999;
      if (w < 50) continue;
      seen.add(src);
      parts.push(imgRef(images, img, src));
    }
    const contentSel = ['#detail-desc', '.note-content .desc', '[class*="note-text"]', '[class*="noteText"]', '[class*="content"] [class*="desc"]', '.note-detail .content', '[id*="detail"] [class*="desc"]'];
    let contentEl = null;
    for (const sel of contentSel) {
      const el = document.querySelector(sel);
      if (el && el.textContent.trim().length > 10) { contentEl = el; break; }
    }
    if (!contentEl) {
      let longest = '';
      for (const el of document.querySelectorAll('[class*="note"] p, [class*="note"] span, [class*="detail"] p, [class*="detail"] span')) {
        const t = el.textContent.trim();
        if (t.length > longest.length && t.length > 20) { longest = t; contentEl = el; }
      }
    }
    if (contentEl) parts.push(contentEl.textContent.trim());
    const tagEls = document.querySelectorAll('[class*="tag"] a, a[href*="/search_result/"], a[href*="/explore/"] [class*="tag"]');
    const tags = [...new Set([...tagEls].map((t) => t.textContent.trim()).filter((t) => t && t.startsWith('#')))];
    if (tags.length) parts.push('\nTags: ' + tags.join(' '));
    for (const v of document.querySelectorAll('video')) {
      let src = v.src || v.currentSrc;
      if (!src) { const s = v.querySelector('source'); if (s) src = s.src; }
      if (src && !src.startsWith('blob:')) videos.push({ src, poster: v.poster || undefined, type: 'video', referer: 'https://www.xiaohongshu.com' });
      else if (v.poster) videos.push({ src: location.href, poster: v.poster, type: 'video-blob', referer: 'https://www.xiaohongshu.com', note: 'video is blob: access via the original page' });
    }
    if (videos.length) parts.push('\n[Video: ' + videos.length + ' clip(s) captured]');
    return parts.length ? { text: parts.join('\n\n'), images, videos, referer: 'https://www.xiaohongshu.com' } : null;
  }

  function twitterExtract() {
    const parts = [], images = [], videos = [];
    const articles = document.querySelectorAll('article[data-testid="tweet"]');
    const first = articles[0];
    if (first) {
      const author = first.querySelector('[data-testid="User-Name"]');
      if (author) parts.push('@' + author.textContent.trim());
      const tweet = first.querySelector('[data-testid="tweetText"]');
      if (tweet) parts.push(tweet.textContent.trim());
      for (const img of first.querySelectorAll('[data-testid="tweetPhoto"] img')) {
        if (img.src && !/emoji|profile_images/.test(img.src)) parts.push(imgRef(images, img, img.src));
      }
      for (const v of first.querySelectorAll('video')) {
        let src = v.src || v.currentSrc;
        if (!src) { const s = v.querySelector('source'); if (s) src = s.src; }
        if (src && !src.startsWith('blob:')) videos.push({ src, poster: v.poster || undefined, type: 'video', referer: 'https://x.com' });
        else if (v.poster) videos.push({ src: location.href, poster: v.poster, type: 'video-blob', referer: 'https://x.com', note: 'video is blob: access via the original page' });
      }
      const time = first.querySelector('time');
      if (time) parts.push('Time: ' + time.getAttribute('datetime'));
      const metrics = first.querySelectorAll('[data-testid$="count"]');
      if (metrics.length) parts.push('Engagement: ' + [...metrics].map((m) => m.textContent.trim()).filter(Boolean).join(' | '));
    }
    if (!parts.length) {
      [...articles].slice(0, 20).forEach((tw) => {
        const text = tw.querySelector('[data-testid="tweetText"]');
        const author = tw.querySelector('[data-testid="User-Name"]');
        if (!text) return;
        parts.push((author ? '@' + author.textContent.split('·')[0].trim() + ': ' : '') + text.textContent.trim());
        for (const img of tw.querySelectorAll('[data-testid="tweetPhoto"] img')) {
          if (img.src && !/emoji|profile_images/.test(img.src)) parts.push(imgRef(images, img, img.src));
        }
      });
      parts.sort(() => 0); // keep timeline order
    }
    return parts.length ? { text: parts.join('\n\n---\n\n'), images, videos, referer: 'https://x.com' } : null;
  }

  function extractSite({ max_chars = 50000 } = {}) {
    const host = location.hostname;
    const routes = [
      ['github.com', githubExtract], ['zhihu.com', zhihuExtract], ['juejin.cn', juejinExtract],
      ['mp.weixin.qq.com', wechatExtract], ['xiaohongshu.com', xiaohongshuExtract],
      ['x.com', twitterExtract], ['twitter.com', twitterExtract],
    ];
    const hit = routes.find(([h]) => host.includes(h));
    let r = null;
    let site = hit ? hit[0] : 'generic';
    try { r = hit ? hit[1]() : null; } catch { r = null; }
    if (!r || !String(r.text || '').trim()) { r = genericExtract(); site = 'generic'; }
    return {
      site,
      text: String(r.text || '').slice(0, max_chars),
      images: r.images || [],
      videos: r.videos || [],
      url: location.href,
      title: document.title,
    };
  }

  // ---- user action recording (TraeWork recorder semantics, hardened) ----------
  // Events survive same-tab navigation via sessionStorage; password fields are
  // masked as ***; hard cap 10 minutes; stop via record_stop.

  const REC_KEY = '__ubb_rec';
  const REC_MAX_MS = 600000;
  const REC_MAX_BYTES = 2 * 1024 * 1024;

  function recordTarget(el) {
    const cls = el.className && typeof el.className === 'string' ? '.' + el.className.split(/\s+/).filter(Boolean).join('.') : '';
    return {
      selector: el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + cls,
      text: (el.textContent || '').trim().slice(0, 50),
      role: el.getAttribute('role') || el.tagName.toLowerCase(),
      label: el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('name') || '',
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
      bufferEvent(e.target, { type: 'input', timestamp: ts(), target: recordTarget(e.target), value: String(val).slice(0, 200) });
    });
    on('change', (e) => {
      if (e.target.tagName !== 'SELECT') return;
      recordEvent({ type: 'select', timestamp: ts(), target: recordTarget(e.target), value: e.target.value });
    });
    on('keydown', (e) => {
      if (['Enter', 'Escape', 'Tab'].includes(e.key)) recordEvent({ type: 'keypress', timestamp: ts(), key: e.key });
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

  const api = { getPageText, fillDom, search, clickDom, getDomTree, extractData, extractSite, recordStart, recordStatus, recordStop, visible, roleOf };
  window.__ubbBridge = api;

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type !== 'UBB_BRIDGE') return;
    try {
      const fn = api[msg.op];
      if (typeof fn !== 'function') throw new Error(`unknown op ${msg.op}`);
      // ops may return promises (record_stop recovers a trace from the
      // background store) — keep the message channel open for them
      Promise.resolve(fn(msg.args || {})).then(
        (result) => sendResponse({ ok: true, result }),
        (e) => sendResponse({ ok: false, error: String(e?.message || e) }),
      );
      return true;
    } catch (e) {
      sendResponse({ ok: false, error: String(e?.message || e) });
    }
  });
})();
