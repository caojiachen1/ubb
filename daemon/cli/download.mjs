// `ubb download cat <id>` — print a finished download that is text.
//
// There is deliberately no `download.read` extension tool: a MV3 service worker
// has no filesystem and `fetch('file://…')` is refused (see lib/tools-downloads.js).
// The daemon does have fs, so this command resolves the id to the path the
// browser itself recorded (one daemon→extension `download.path` call), then reads
// the file here. Three gates, all of them required to pass:
//   1. text gate   — the extension's text_readable AND a local mime/extension check
//                      AND a byte sniff; binary answers "take the path" instead of
//                      dumping bytes into the conversation (no flag overrides it).
//   2. size gate   — a bounded read (--max-bytes, hard ceiling) with an explicit
//                      truncation marker, so a 2 GB export cannot be slurped.
//   3. path gate   — only a path the daemon answered with, and only inside a
//                      download root; the caller cannot hand this command a path.
//                      The root set is the guessed ~/Downloads + --allow-path +
//                      UBB_DOWNLOAD_DIRS, and when those refuse, the folders the
//                      browser declares through download.list (one extra read).
// Redaction reuses lib/redact.js, the extension's own rules, so a downloaded
// password/cookie/token never reaches stdout in clear.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { redact, redactUrl } from '../../lib/redact.js';
import { AgentClient, resolveCreds } from './audit.mjs';

export const DEFAULT_MAX_BYTES = 200_000;
export const HARD_MAX_BYTES = 5_000_000;
/** Downloads outside these roots are refused; extend with --allow-path / UBB_DOWNLOAD_DIRS. */
export const DOWNLOADS_DIR = path.join(os.homedir(), 'Downloads');

// Same ext/mime table lib/tools-downloads.js applies on the browser side. Kept as
// a second opinion here on purpose: a wrong text_readable from the extension must
// not be enough to push binary bytes into the terminal.
const TEXT_MIME = /^(text\/|application\/(json|x-?javascript|ecmascript|xml|xhtml\+xml|atom\+xml|rss\+xml|yaml|x-yaml|graphql|sql))/i;
const UNKNOWN_MIME = /^$|^application\/(octet-stream|x-download|empty)$/i;
const TEXT_EXT = /\.(txt|csv|tsv|json|jsonl|md|markdown|xml|yml|yaml|log|ini|conf|srt|vtt|html?|css|js|mjs|ts|sql|sh|bat|py)$/i;

function fail(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

export function looksTextual(mime, pathOrName) {
  const m = String(mime || '');
  if (TEXT_MIME.test(m)) return true;
  if (UNKNOWN_MIME.test(m)) return TEXT_EXT.test(String(pathOrName || ''));
  return false;
}

/** True when a prefix of bytes does not look like text (NULs / undecodable / control noise). */
export function sniffBinary(buf) {
  const head = buf.subarray(0, Math.min(buf.length, 8192));
  if (head.includes(0)) return true;
  const text = new TextDecoder('utf-8', { fatal: false }).decode(head);
  if (!text.length) return false;
  let bad = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0);
    if (ch === '\uFFFD') bad++;
    else if (c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d && c !== 0x0c && c !== 0x1b) bad++;
    else if (c === 0x7f) bad++;
  }
  return bad / text.length > 0.01;
}

function normKey(p) {
  const n = path.resolve(p);
  return process.platform === 'win32' ? n.toLowerCase() : n;
}

export function isInside(root, target) {
  const r = normKey(root).replace(/[\\/]+$/, '');
  const t = normKey(target);
  return t === r || t.startsWith(r + path.sep) || t.startsWith(r + '/');
}

/** Root list the answered path has to live under (real dirs only). */
export function resolveRoots({ extra = [], env = process.env } = {}) {
  const fromEnv = String(env.UBB_DOWNLOAD_DIRS || '').split(path.delimiter).filter(Boolean);
  const roots = [];
  for (const r of [DOWNLOADS_DIR, ...fromEnv, ...extra]) {
    if (!r || !path.isAbsolute(r)) {
      throw fail('BAD_PARAMS', `download root must be an absolute path, got ${JSON.stringify(r)} — fix --allow-path / UBB_DOWNLOAD_DIRS`);
    }
    roots.push(path.resolve(r));
  }
  return [...new Set(roots)];
}

/** A download folder is never one of the two places holding this machine's secrets. */
function isCredentialDir(dir) {
  const home = path.resolve(os.homedir());
  return [path.join(home, '.ubb'), path.join(home, '.ssh')].some((g) => isInside(g, dir));
}

/**
 * Candidate roots taken from the records the browser itself reported: download.list
 * answers an absolute path per download, and the folder a browser wrote a download
 * into IS a download folder. On this machine that is E:\ while the guessed
 * ~/Downloads root made `ubb download cat` unusable out of the box
 * (LIVE-RESULTS-2B 7d). The values come from a TOOL RESPONSE, never from argv, and
 * the gate is not weakened: an answered path still has to be inside one root.
 */
export function rootsFromRecords(items) {
  const dirs = new Set();
  for (const it of Array.isArray(items) ? items : []) {
    const p = it && it.path;
    if (typeof p !== 'string' || !p || p.includes('\0')) continue;
    if (!path.isAbsolute(p) && !path.win32.isAbsolute(p)) continue;
    if (p.split(/[\\/]+/).includes('..')) continue;
    const dir = path.resolve(path.dirname(p));
    if (isCredentialDir(dir)) continue;
    dirs.add(dir);
  }
  return [...dirs];
}

/** Read the declared folders back through one download.list call. */
export async function discoverDownloadRoots(toolCall, { limit = 200 } = {}) {
  try {
    const res = await toolCall('download.list', { limit });
    return { dirs: rootsFromRecords(res && res.downloads), error: null };
  } catch (e) {
    return { dirs: [], error: `${e.code || 'ERR'} ${String(e.message || e).slice(0, 120)}` };
  }
}

/**
 * The path gate. `answered` is whatever download.path returned — never a value
 * the caller typed. Returns the realpath of a regular file inside one of `roots`.
 */
export function checkDownloadPath(answered, roots) {
  if (typeof answered !== 'string' || !answered) {
    throw fail('MISSING_PATH', 'the extension did not report a path for this download (empty filename) — it may still be queued; run download.list');
  }
  if (answered.includes('\0')) throw fail('PATH_REFUSED', 'the reported path contains a NUL byte — refusing');
  if (!path.isAbsolute(answered) && !path.win32.isAbsolute(answered)) {
    throw fail('PATH_REFUSED', `the reported path is not absolute (${answered}) — ubb download cat only accepts a path the browser recorded`);
  }
  const segs = answered.split(/[\\/]+/);
  if (segs.includes('..')) throw fail('PATH_REFUSED', `the reported path traverses upwards (${answered}) — refusing to read it`);
  let st;
  try {
    st = fs.lstatSync(answered);
  } catch {
    throw fail('NOT_READABLE', `cannot stat ${answered} — the file was moved or deleted since the download`);
  }
  if (st.isSymbolicLink()) throw fail('PATH_REFUSED', `${answered} is a symlink — ubb download cat refuses to follow download paths out of the download roots`);
  if (st.isDirectory()) throw fail('PATH_REFUSED', `${answered} is a directory, not the downloaded file`);
  if (!st.isFile()) throw fail('PATH_REFUSED', `${answered} is not a regular file (device/fifo/socket)`);
  let real;
  try {
    real = fs.realpathSync(answered);
  } catch {
    throw fail('NOT_READABLE', `cannot resolve ${answered} — it disappeared between the download and now`);
  }
  if (!roots.some((r) => isInside(r, real))) {
    throw fail(
      'OUTSIDE_ROOT',
      `${real} is not under a download root (${roots.join(', ')}) — if that is really your download folder add it: ubb download cat <id> --allow-path <dir> (or set UBB_DOWNLOAD_DIRS)`,
    );
  }
  return { real, size: st.size };
}

// ------------------------------------------------------------------ redaction

// One probe per key, so the rules stay exactly lib/redact.js' (contract §4.3).
const sensitiveKey = (k) => redact({ [k]: 'probe' })[k] === '[redacted]';
const mask = '[redacted]';

const URL_RE = /\bhttps?:\/\/[^\s"'<>()[\]\\]+/g;
// redactUrl() re-serialises, so only pay it for URLs that can carry a query
const maskUrl = (u) => (u.includes('?') ? redactUrl(u) : u);

function tryJson(text) {
  const t = text.trim();
  if (!t || !/^[[{]/.test(t)) return undefined;
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
}

function tryJsonLines(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return undefined;
  const parsed = [];
  for (const l of lines) {
    try {
      const v = JSON.parse(l);
      if (!v || typeof v !== 'object') return undefined;
      parsed.push(v);
    } catch {
      return undefined;
    }
  }
  return parsed;
}

const KV_RE = /^(\s*)(["']?)([A-Za-z0-9_.\-]+)\2(\s*[:=]\s*)(\S(?:.*\S)?)\s*$/;

/** Mask sensitive keys (JSON/JSONL/CSV/TSV/ini-ish) and sensitive URL params in text. */
export function redactText(text) {
  const urlsFixed = text.replace(URL_RE, maskUrl);
  const json = tryJson(urlsFixed);
  if (json !== undefined) return JSON.stringify(redact(json), null, 2);
  const lines = tryJsonLines(urlsFixed);
  if (lines) return lines.map((o) => JSON.stringify(redact(o))).join('\n');

  const delim = (() => {
    const first = (urlsFixed.split(/\r?\n/)[0] || '').trim();
    if (!first) return null;
    if (first.includes('\t')) return '\t';
    const bare = first.replace(/"[^"]*"/g, '');
    const commas = (bare.match(/,/g) || []).length;
    return commas >= 1 && !KV_RE.test(first) ? ',' : null;
  })();
  if (delim) {
    const cells = (line) => (delim === ',' ? line.split(/,(?=(?:(?:[^"]*"){2})*[^"]*$)/) : line.split('\t'));
    const header = cells(urlsFixed.split(/\r?\n/)[0]).map((c) => c.replace(/^"|"$/g, '').trim());
    if (header.length > 1 && header.some(sensitiveKey)) {
      const hide = header.map((h) => sensitiveKey(h));
      return urlsFixed
        .split(/\r?\n/)
        .map((line, i) => (i === 0 ? line : cells(line).map((c, j) => (hide[j] && c.trim() ? mask : c)).join(delim)))
        .join('\n');
    }
  }

  return urlsFixed
    .split('\n')
    .map((line) => {
      const m = KV_RE.exec(line);
      if (!m || !sensitiveKey(m[3])) return line;
      return `${m[1]}${m[2]}${m[3]}${m[4]}${mask}`;
    })
    .join('\n');
}

// ------------------------------------------------------------------ the reader

/**
 * Argument validation, split out so the CLI can refuse a bad call BEFORE it
 * opens a socket. `download cat` takes a numeric id — never a path.
 */
export function validateArgs(rawId, maxBytes = DEFAULT_MAX_BYTES) {
  const raw = String(rawId ?? '').trim();
  if (!/^\d+$/.test(raw)) {
    throw fail(
      'BAD_ID',
      `ubb download cat takes the NUMERIC download id (got ${JSON.stringify(raw)}); it never takes a path — find ids with: ubb download.list or ubb_call download.list`,
    );
  }
  const wanted = Number(maxBytes) || DEFAULT_MAX_BYTES;
  if (wanted > HARD_MAX_BYTES) {
    throw fail('BAD_PARAMS', `--max-bytes is capped at ${HARD_MAX_BYTES} bytes (got ${maxBytes}) — open a file that big in a terminal, not in the conversation`);
  }
  return { id: Number(raw), cap: Math.min(Math.max(wanted, 1), HARD_MAX_BYTES) };
}

/**
 * One download, printed as text. Everything browser-side comes through
 * `toolCall` so the whole flow is testable without a daemon.
 */
export async function catDownload({
  download_id,
  toolCall,
  maxBytes = DEFAULT_MAX_BYTES,
  extraRoots = [],
  env = process.env,
  autoRoots = true,
}) {
  const { id, cap } = validateArgs(download_id, maxBytes);
  let info;
  try {
    info = await toolCall('download.path', { download_id: id });
  } catch (e) {
    if (e.code === 'NOT_FOUND') throw fail('NOT_FOUND', `no download with id ${id} — run: ubb download.list`);
    throw e;
  }
  if (!info || typeof info !== 'object') throw fail('BAD_ANSWER', 'download.path returned nothing — is the extension connected? ubb status');
  if (info.state && info.state !== 'complete') {
    throw fail('NOT_COMPLETE', `download ${id} is ${info.state} — wait for it: ubb_call download.wait '{"download_id":${id}}'`);
  }
  if (info.text_readable !== true || !looksTextual(info.mime, info.path || info.filename)) {
    throw fail(
      'BINARY',
      `download ${id} (${info.filename || 'unnamed'}${info.mime ? `, ${info.mime}` : ''}) is not text — take the path instead of its bytes: ${info.path || '(no path reported)'}`,
    );
  }

  const roots = resolveRoots({ extra: extraRoots, env });
  let decided;
  let autoRoot = null;
  try {
    decided = checkDownloadPath(info.path, roots);
  } catch (e) {
    if (e.code !== 'OUTSIDE_ROOT' || autoRoots === false) throw e;
    // the guessed ~/Downloads root is not the browser's answer; ask the browser
    // where its downloads live before refusing anything
    const found = await discoverDownloadRoots(toolCall);
    const merged = resolveRoots({ extra: [...extraRoots, ...found.dirs], env });
    try {
      decided = checkDownloadPath(info.path, merged);
      autoRoot = found.dirs.find((d) => isInside(d, decided.real)) || null;
    } catch (e2) {
      if (e2.code === 'OUTSIDE_ROOT') {
        e2.message += ` — download.list offered ${found.dirs.length ? found.dirs.join(', ') : 'no folder'}${found.error ? ` (reading them failed: ${found.error})` : ''}; if that really is your download folder add it with --allow-path DIR`;
      }
      throw e2;
    }
  }
  const { real, size } = decided;
  if (size === 0) return { id, path: real, bytes: 0, total: 0, truncated: false, text: '', ...(autoRoot ? { auto_root: autoRoot } : {}) };

  const want = Math.min(size, cap);
  let fd;
  let buf;
  try {
    fd = fs.openSync(real, 'r');
    buf = Buffer.alloc(want);
    const { bytesRead } = fs.readSync(fd, buf, 0, want, 0);
    buf = buf.subarray(0, bytesRead);
  } catch (e) {
    throw fail('READ_FAILED', `cannot read ${real} — ${e.message}`);
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }
  if (sniffBinary(buf)) {
    throw fail(
      'BINARY',
      `download ${id} claims to be text but its bytes are not (${info.mime || 'no mime'}, ${buf.length}B sniffed) — take the path instead: ${real}`,
    );
  }
  let text = buf.toString('utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const truncated = size > want;
  text = redactText(text);
  if (truncated) text += `\n…[ubb download cat: showed ${want} of ${size} bytes — raise --max-bytes (max ${HARD_MAX_BYTES}) or open ${real}]`;
  return { id, path: real, bytes: want, total: size, truncated, text, mime: info.mime || null, filename: info.filename || null, ...(autoRoot ? { auto_root: autoRoot } : {}) };
}

// ----------------------------------------------------------------------- CLI

function flagAll(argv, name) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === `--${name}` && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) {
      out.push(argv[++i]);
    } else if (argv[i].startsWith(`--${name}=`)) {
      out.push(argv[i].slice(name.length + 3));
    }
  }
  return out;
}

const USAGE =
  'usage: ubb download cat <download-id> [--max-bytes N] [--allow-path DIR] [--no-auto-roots]\n' +
  '       (id from: ubb download.list / ubb_call download.list — a path is never accepted here)\n' +
  '       binary downloads are refused on purpose: there is no download.read, take download.path\n' +
  '       anything else under `ubb download` (e.g. ubb download \'{"url":"…"}\') is the download TOOL';

// The CLI only owns the `download` NAME for these second tokens. `download` is
// also a registered extension tool, and a live agent that typed
// `ubb download '{"url":…}'` was handed this usage text instead of the tool
// (LIVE-RESULTS-2B 7g) — so the name is shared, and `takes()` decides who gets it.
const DOWNLOAD_ACTIONS = new Set(['cat', 'list', 'path', 'status', 'wait', 'help']);

/** Which argv shapes the `download` subcommand owns; false = dispatch to tool.download. */
export function ownsDownloadArgv(argv = []) {
  const first = String(argv[0] ?? '');
  return argv.length === 0 || first.startsWith('-') || DOWNLOAD_ACTIONS.has(first);
}

async function runCat(idArg, argv) {
  if (!idArg || idArg.startsWith('--')) throw Object.assign(new Error(USAGE), { code: 'BAD_ID' });
  const maxBytes = flagAll(argv, 'max-bytes')[0] || process.env.UBB_DOWNLOAD_MAX_BYTES || DEFAULT_MAX_BYTES;
  const extraRoots = flagAll(argv, 'allow-path');
  // fail before opening a socket: a bad id / cap / root is a typing mistake
  validateArgs(idArg, maxBytes);
  resolveRoots({ extra: extraRoots });
  const creds = resolveCreds();
  const client = new AgentClient(creds);
  await client.connect();
  let res;
  try {
    res = await catDownload({
      download_id: idArg,
      toolCall: (n, p) => client.tool(n, p),
      maxBytes,
      extraRoots,
      autoRoots: !argv.includes('--no-auto-roots'),
    });
  } finally {
    client.close();
  }
  process.stdout.write(res.text + (res.text.endsWith('\n') || res.text === '' ? '' : '\n'));
  console.error(
    `ubb download cat: #${res.id} ${res.path} — ${res.bytes}/${res.total} bytes${res.truncated ? ' (TRUNCATED by --max-bytes)' : ''}, text gate + redaction applied${res.auto_root ? ` (root auto-read from download.list: ${res.auto_root})` : ''}`,
  );
}

export const DOWNLOAD_COMMANDS = [
  {
    name: 'download',
    describe:
      'download cat <id> [--max-bytes N] [--allow-path DIR] — print a finished text download from the daemon side (no download.read exists in the extension: a service worker has no fs); binaries are refused, only their path is shown. The download folders the browser itself declares are read back from download.list when the guessed ~/Downloads root refuses an answered path, so an E:\\ download works without a flag. `ubb download (json)` is the download TOOL, not this subcommand.',
    takes: ownsDownloadArgv,
    async run(argv = []) {
      const [sub, ...rest] = argv;
      if (sub === undefined || sub === 'help') {
        console.error(USAGE);
        process.exit(0);
        return;
      }
      if (sub === 'cat') {
        try {
          await runCat(rest[0], rest.slice(1));
        } catch (e) {
          console.error(`ubb download cat: ${e.code || 'ERR'} — ${e.message}`);
          process.exit(1);
        }
        return;
      }
      if (DOWNLOAD_ACTIONS.has(sub)) {
        console.error(`ubb download ${sub}: use the tool instead — ubb ${sub === 'list' ? 'download.list' : `download.${sub} '{"download_id":<id>}'`}`);
        process.exit(2);
        return;
      }
      console.error(USAGE);
      process.exit(2);
    },
  },
];
