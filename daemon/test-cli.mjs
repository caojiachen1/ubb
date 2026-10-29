// Wave 4a CLI offline checks (contract §6.2/§6.3/§6.4) — no browser, no real
// credentials, nothing under the user's ~/.ubb is read or written:
//
//   node daemon/test-cli.mjs
//
// [A] `ubb download cat` gates, driven through the exported catDownload with an
//     injected tool call (the seam the real CLI fills with AgentClient.tool).
// [B] the unified --port meaning (daemon port vs. liveview --view-port).
// [C] static wiring (help text, registries, no redaction/binary bypass).
// [D] end-to-end through daemon/ubb.mjs + a real daemon + a FAKE extension.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  catDownload, looksTextual, sniffBinary, resolveRoots, isInside, redactText, validateArgs,
  rootsFromRecords, ownsDownloadArgv,
  DEFAULT_MAX_BYTES, HARD_MAX_BYTES, DOWNLOADS_DIR, DOWNLOAD_COMMANDS,
} from './cli/download.mjs';
import { resolveLiveviewPorts, DEFAULT_VIEW_PORT, LIVEVIEW_BIND } from './cli/liveview.mjs';
import { CLI_COMMANDS, runCliCommand } from './cli/index.mjs';
import { TOOLS as MCP_TOOLS } from './mcp-tools/index.mjs';

const ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..');

let pass = 0;
let fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
};
const skip = (name, why) => console.log(`  – SKIP ${name} (${why})`);
const grab = async (fn) => {
  try { return { r: await fn(), e: null }; } catch (e) { return { r: null, e }; }
};
const throwsSync = (fn) => {
  try {
    fn();
    return null;
  } catch (e) {
    return e;
  }
};
const codeOf = (e) => (e ? e.code || e.name || 'plain throw' : '(no throw)');
const msgOf = (e) => String((e && e.message) || e || '');
const captureErr = (fn) => {
  const orig = console.error;
  const lines = [];
  console.error = (...a) => lines.push(a.join(' '));
  try {
    const r = fn();
    return { r, lines };
  } catch (e) {
    return { r: null, lines: [...lines, `THREW ${e.message}`], threw: e };
  } finally {
    console.error = orig;
  }
};

// ---------------------------------------------------------------- fixtures
// A fake "Downloads" folder + a second folder that is NOT a root. Both live in
// os.tmpdir(); the temp HOME keeps ~/.ubb out of the picture entirely.
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ubb-cli-')));
const DL = path.join(TMP, 'Downloads');
const OTHER = path.join(TMP, 'elsewhere');
const FAKE_HOME = path.join(TMP, 'home');
fs.mkdirSync(DL, { recursive: true });
fs.mkdirSync(OTHER, { recursive: true });
fs.mkdirSync(FAKE_HOME, { recursive: true });
const F = (n) => path.join(DL, n);
const write = (name, data) => {
  fs.writeFileSync(F(name), data);
  return F(name);
};

const CSV = write('report.csv',
  'user,password,url\nalice,s3cretPW,https://x.example/cb?token=TKVA99&next=1\nbob,pw2,https://y.example/plain\n');
const TXT = write('notes.txt',
  'password = hunter2plain\napi_key: "ak-9f8e7d"\nnote: all clear\nfeed https://e.example/dl?Signature=SIGSEKRIT&x=1\n');
const JSON1 = write('data.json', '{"token":"tok-ABC123","user":{"password":"pw-XYZ789"},"keep":"visible"}');
const JSONL = write('events.jsonl',
  '{"authorization":"Bearer AAA111","path":"/x"}\n{"cookie":"BBB222","path":"/y"}\n');
write('empty.txt', '');
const BIG = F('big.txt');
fs.writeFileSync(BIG, '0123456789abcdef\n'.repeat(400)); // 6400 bytes of honest text
const BIN = F('blob.bin');
fs.writeFileSync(BIN, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x00, 0x00, 0x01, 0x02, 0xff, 0xfe, 0x00, 0x00]));
// a .txt whose BYTES are binary: the only way to prove the sniff gate is separate
// from the mime/ext gate
const FAKE_TXT = F('fake.txt');
fs.writeFileSync(FAKE_TXT, Buffer.concat([Buffer.from('PNG\r\n\x1a\n'), Buffer.alloc(64, 0x01), Buffer.from([0, 0])]));
const OUTSIDE = path.join(OTHER, 'outside.txt');
fs.writeFileSync(OUTSIDE, 'password=hunter2outside\n');
const INI = write('app.ini', '[svc]\ntoken=tok-INI-9999\nurl=http://e.example/a?api_key=INIKEY99&z=2\nplain=visible\n');

// fixture preconditions (a broken fixture would make the suite silently green)
const UBB_HOME = path.join(os.homedir(), '.ubb');
ok('fixture: everything lives in the temp tree and never under the real ~/.ubb',
  isInside(TMP, DL) && isInside(TMP, OTHER) && !isInside(UBB_HOME, TMP) && isInside(fs.realpathSync(os.tmpdir()), TMP),
  `${TMP} vs ${UBB_HOME}`);
ok('fixture: blob.bin really carries NULs and fake.txt is undecodable',
  fs.readFileSync(BIN).includes(0) && sniffBinary(fs.readFileSync(FAKE_TXT)));
ok(`fixture: big.txt is ${fs.statSync(BIG).size} bytes, i.e. bigger than the --max-bytes the cases use`,
  fs.statSync(BIG).size > 1000, `${fs.statSync(BIG).size} bytes`);
ok('fixture: default cap is 200KB and the hard ceiling is above it',
  DEFAULT_MAX_BYTES === 200_000 && HARD_MAX_BYTES > DEFAULT_MAX_BYTES, `${DEFAULT_MAX_BYTES}/${HARD_MAX_BYTES}`);
ok('resolveRoots always keeps the real ~/Downloads (a normal download needs no flag)',
  resolveRoots({ env: {} }).some((r) => isInside(r, DOWNLOADS_DIR)), JSON.stringify(resolveRoots({ env: {} })));

// ------------------------------------------------------------------ [A] cat gates
// A second "browser download folder" outside every static root — this machine
// really downloads to E:\ while the CLI guesses ~\Downloads (LIVE-RESULTS-2B 7d).
const ED = path.join(TMP, 'edrive');
fs.mkdirSync(ED, { recursive: true });
const EREPORT = path.join(ED, 'report (1).csv');
fs.writeFileSync(EREPORT, 'id,service,token,password\n1,github,ghp_EVADE123,ehpw\n');
const EBIN = path.join(ED, 'big (2).bin');
fs.writeFileSync(EBIN, fs.readFileSync(BIN));
const answers = new Map();
const toolCalls = [];
// the fake extension-side download.list, kept as a fixture so the root-discovery
// assertions below are deterministic (the merged provider list itself is proven
// offline in test-downloads and end-to-end in [D])
let FIXTURE_LIST = [];
let listShouldFail = false;
const listCalls = () => toolCalls.filter((c) => c.name === 'download.list').length;
const toolCall = async (name, params) => {
  toolCalls.push({ name, params });
  if (name === 'download.list') {
    if (listShouldFail) throw Object.assign(new Error('no session'), { code: 'NO_SESSION' });
    return { downloads: FIXTURE_LIST, count: FIXTURE_LIST.length, source: 'ledger' };
  }
  if (name !== 'download.path') throw Object.assign(new Error(`unexpected tool ${name}`), { code: 'WIRING' });
  const a = answers.get(params.download_id);
  if (!a) throw Object.assign(new Error(`no download ${params.download_id}`), { code: 'NOT_FOUND' });
  return a;
};
const done = (id, file, mime) => ({
  id, state: 'complete', ready: true, path: file, filename: path.basename(file), mime,
  text_readable: mime ? /^text\/|^application\/json/.test(mime) : /\.(txt|csv|json|jsonl|ini)$/.test(file),
  bytes_received: fs.statSync(file).size, total_bytes: fs.statSync(file).size, url: 'https://e.example/f',
});
const cat = (id, extra = {}) =>
  catDownload({ download_id: id, toolCall, extraRoots: [DL], env: {}, ...extra });

answers.set(11, done(11, CSV, 'text/csv'));
const r11 = await cat(11);
ok('cat text/csv: exactly ONE daemon→extension download.path call',
  toolCalls.length === 1 && toolCalls[0].name === 'download.path' && toolCalls[0].params.download_id === 11,
  JSON.stringify(toolCalls));
ok('cat text/csv: the non-sensitive cells survive',
  r11.text.includes('alice') && r11.text.includes('bob') && r11.text.includes('https://y.example/plain'), r11.text);
ok('cat text/csv: the password COLUMN is masked', !r11.text.includes('s3cretPW') && !r11.text.includes('pw2'), r11.text);
ok('cat text/csv: a sensitive query param inside a cell is masked', !r11.text.includes('TKVA99'), r11.text);
ok('cat returns {id,path,bytes,total,truncated}',
  r11.id === 11 && r11.path === fs.realpathSync(CSV) && r11.bytes === r11.total && r11.truncated === false, JSON.stringify({ ...r11, text: undefined }));

answers.set(12, done(12, TXT, 'text/plain'));
const r12 = await cat(12);
ok('cat text/plain: key=value secrets masked, prose kept',
  !r12.text.includes('hunter2plain') && !r12.text.includes('ak-9f8e7d') && r12.text.includes('all clear'), r12.text);
ok('cat text/plain: ?Signature= in a URL masked', !r12.text.includes('SIGSEKRIT'), r12.text);

answers.set(13, done(13, JSON1, 'application/json'));
const r13 = await cat(13);
ok('cat json: nested secret keys masked, harmless key kept',
  !r13.text.includes('tok-ABC123') && !r13.text.includes('pw-XYZ789') && r13.text.includes('visible'), r13.text);

answers.set(14, done(14, JSONL, 'application/jsonl'));
const r14 = await cat(14);
ok('cat jsonl: every line redacted on its own',
  !r14.text.includes('AAA111') && !r14.text.includes('BBB222') && r14.text.includes('/x') && r14.text.includes('/y'), r14.text);

answers.set(15, done(15, INI, 'text/plain'));
const r15 = await cat(15);
ok('cat ini: token= masked and the api_key query param masked',
  !r15.text.includes('tok-INI-9999') && !r15.text.includes('INIKEY99') && r15.text.includes('plain=visible'), r15.text);

answers.set(16, done(16, BIN, 'application/octet-stream'));
const c16 = await grab(() => cat(16));
ok('cat binary → BINARY, not content', codeOf(c16.e) === 'BINARY', `${codeOf(c16.e)} ${msgOf(c16.e)}`);
ok('cat binary → the refusal names the path and never emits base64',
  msgOf(c16.e).includes(path.basename(BIN)) && msgOf(c16.e).includes(BIN) && !/base64|\\\\x/i.test(msgOf(c16.e)), msgOf(c16.e));

answers.set(17, { ...done(17, BIN, 'application/octet-stream'), text_readable: true }); // extension lies (mime)
const c17 = await grab(() => cat(17));
ok('text_readable:true + octet-stream mime is STILL refused (local mime gate)',
  codeOf(c17.e) === 'BINARY', `${codeOf(c17.e)} ${msgOf(c17.e)}`);
answers.set(18, done(18, FAKE_TXT, 'text/plain'));
const c18 = await grab(() => cat(18));
ok('text_readable:true + text/plain + a .txt whose bytes are binary is refused (sniff gate)',
  codeOf(c18.e) === 'BINARY', `${codeOf(c18.e)} ${msgOf(c18.e)}`);

answers.set(21, done(21, BIG, 'text/plain'));
const BIG_SIZE = fs.statSync(BIG).size;
const r21 = await cat(21, { maxBytes: 1000 });
ok('byte cap: reads exactly --max-bytes and marks truncated',
  r21.bytes === 1000 && r21.total === BIG_SIZE && r21.truncated === true, JSON.stringify({ ...r21, text: undefined }));
ok('byte cap: the truncation marker is inside the answer, not only on stderr',
  r21.text.includes(`showed 1000 of ${BIG_SIZE} bytes`), r21.text.slice(-90));
const c22 = await grab(() => cat(21, { maxBytes: HARD_MAX_BYTES + 1 }));
ok('--max-bytes above the hard ceiling is refused, not clamped silently',
  codeOf(c22.e) === 'BAD_PARAMS' && msgOf(c22.e).includes(String(HARD_MAX_BYTES)), msgOf(c22.e));
answers.set(23, { ...done(23, BIG, 'text/plain'), bytes_received: 10, total_bytes: 6400, state: 'in_progress', ready: false });
const c23 = await grab(() => cat(23));
ok('an in-progress download is refused with a wait instruction',
  codeOf(c23.e) === 'NOT_COMPLETE' && /download\.wait/.test(msgOf(c23.e)), msgOf(c23.e));
const c24 = await grab(() => cat(999));
ok('unknown id → NOT_FOUND (mapped through from the tool error)', codeOf(c24.e) === 'NOT_FOUND', msgOf(c24.e));
answers.set(25, done(25, F('empty.txt'), 'text/plain'));
ok('a 0-byte text download answers empty without throwing', (await cat(25)).text === '');

// -- the path gate: only what the daemon answered, never what the caller typed
const CALLER_PATHS = ['C:\\Users\\me\\.ssh\\id_rsa', '../../etc/passwd', '/etc/passwd', `${DL}\\report.csv`, '11 --out x', '3.5', '-1', ''];
let callsBefore = toolCalls.length;
for (const p of CALLER_PATHS) {
  const c = await grab(() => cat(p));
  ok(`a caller-composed id is refused as BAD_ID: ${JSON.stringify(p)}`, codeOf(c.e) === 'BAD_ID', msgOf(c.e));
}
ok('refusing caller paths cost zero tool calls (the id never reaches the extension)',
  toolCalls.length === callsBefore, `${toolCalls.length - callsBefore} extra calls`);
ok('validateArgs is the pre-socket guard: a numeric id + a sane cap come back, anything else is BAD_ID/BAD_PARAMS',
  validateArgs('42').id === 42 && validateArgs(' 7 ', '1000').cap === 1000 && validateArgs('5').cap === DEFAULT_MAX_BYTES &&
    codeOf(throwsSync(() => validateArgs('..\\a.txt'))) === 'BAD_ID' &&
    codeOf(throwsSync(() => validateArgs('5', String(HARD_MAX_BYTES + 1)))) === 'BAD_PARAMS',
  JSON.stringify([validateArgs('42'), validateArgs(' 7 ', '1000').cap]));

const pathCases = [
  ['path traversal in the answered path', `${DL}\\..\\elsewhere\\outside.txt`, 'PATH_REFUSED'],
  ['answered path outside every root', OUTSIDE, 'OUTSIDE_ROOT'],
  ['relative answered path', 'Downloads/report.csv', 'PATH_REFUSED'],
  ['NUL byte in the answered path', `${CSV}\0.png`, 'PATH_REFUSED'],
  ['answered path is a directory', DL, 'PATH_REFUSED'],
  ['answered file vanished', F('gone.csv'), 'NOT_READABLE'],
];
for (const [name, answeredPath, want] of pathCases) {
  answers.set(30, { ...done(30, CSV, 'text/csv'), path: answeredPath });
  const c = await grab(() => cat(30));
  ok(`${name} → ${want}`, codeOf(c.e) === want, `${codeOf(c.e)} ${msgOf(c.e)}`);
}
answers.set(31, { ...done(31, CSV, 'text/csv'), path: undefined });
const c31 = await grab(() => cat(31));
ok('an answer without a path says MISSING_PATH', codeOf(c31.e) === 'MISSING_PATH', msgOf(c31.e));

let symlinkMade = false;
const LINK = F('link.txt');
try {
  fs.symlinkSync(OUTSIDE, LINK, 'file');
  symlinkMade = true;
} catch (e) {
  skip('symlink escape case', `no symlink privilege here (${e.code})`);
}
if (symlinkMade) {
  answers.set(32, { ...done(32, CSV, 'text/csv'), path: LINK });
  const c32 = await grab(() => cat(32));
  ok('a download path that is a symlink is refused (no following out of the root)',
    codeOf(c32.e) === 'PATH_REFUSED', `${codeOf(c32.e)} ${msgOf(c32.e)}`);
}
answers.set(33, { ...done(33, OUTSIDE, 'text/plain'), path: OUTSIDE });
const r33 = await cat(33, { extraRoots: [OTHER] });
ok('--allow-path opens a second root (and still redacts)',
  r33.bytes > 0 && !r33.text.includes('hunter2outside'), r33.text);
ok('isInside: root itself and children yes, siblings/prefix tricks no',
  isInside(DL, DL) && isInside(DL, CSV) && !isInside(DL, OTHER) && !isInside(DL, `${DL}-evil${path.sep}x`), `${DL} ${OTHER}`);
{
  const withEnv = resolveRoots({ extra: [DL], env: { UBB_DOWNLOAD_DIRS: `${OTHER}${path.delimiter}${OTHER}` } });
  const relative = (() => {
    try {
      resolveRoots({ extra: ['relative/dir'], env: {} });
      return null;
    } catch (e) {
      return e;
    }
  })();
  ok('resolveRoots takes UBB_DOWNLOAD_DIRS, dedupes, and rejects a relative root',
    withEnv.some((r) => isInside(r, OTHER)) && withEnv.filter((r) => isInside(r, OTHER)).length === 1 && codeOf(relative) === 'BAD_PARAMS',
    `${JSON.stringify(withEnv)} / ${msgOf(relative)}`);
}

// ------------------------------------------- fix7dl-2: the browser-declared root
// `ubb download cat` was unusable out of the box on a machine that downloads to
// E:\ (LIVE-RESULTS-2B 7d): the guess ~\Downloads is not a download root. The
// folders the browser reports through download.list are read back as CANDIDATE
// roots — only after the static ones refused, never from argv, gate unchanged.
FIXTURE_LIST = [
  { id: 50, path: EREPORT, state: 'complete' },
  { id: 11, path: CSV, state: 'complete' },
  { id: 53, path: EBIN, state: 'complete' },
];
answers.set(50, done(50, EREPORT, 'text/csv'));
const dlBefore50 = toolCalls.length;
const listsBefore50 = listCalls();
const r50 = await cat(50);
ok('cat of a download in the browser-declared folder works with no --allow-path (live 7d: E:\\)',
  r50.bytes === fs.statSync(EREPORT).size && r50.path === fs.realpathSync(EREPORT) && r50.auto_root === fs.realpathSync(ED),
  JSON.stringify({ ...r50, text: undefined }));
ok('the auto-read root is announced in the answer (nothing is widened silently)',
  typeof r50.auto_root === 'string' && r50.auto_root.length > 0, JSON.stringify({ auto_root: r50.auto_root }));
ok('redaction still runs on an auto-rooted file', !r50.text.includes('ghp_EVADE123') && r50.text.includes('github'), r50.text);
ok('root discovery costs exactly ONE extra tool call, and it is download.list',
  toolCalls.length === dlBefore50 + 2 && toolCalls[dlBefore50].name === 'download.path' && toolCalls[dlBefore50 + 1].name === 'download.list',
  JSON.stringify(toolCalls.slice(dlBefore50).map((c) => c.name)));
ok('the happy path never pays for discovery (static root hit → no extra download.list)',
  listCalls() === listsBefore50 + 1 && (await cat(11)).text.includes('alice') && listCalls() === listsBefore50 + 1,
  `${listCalls()} list calls in total`);

answers.set(51, done(51, path.join(OTHER, 'outside.txt'), 'text/plain'));
const c51 = await grab(() => cat(51));
ok('a folder no download ever mentions stays refused (the gate is not "any path")',
  codeOf(c51.e) === 'OUTSIDE_ROOT' && msgOf(c51.e).includes(fs.realpathSync(OTHER)), msgOf(c51.e));
ok('the refusal says which folders the browser offered and how to add one',
  /download\.list offered/.test(msgOf(c51.e)) && /--allow-path/.test(msgOf(c51.e)), msgOf(c51.e));
const dlBefore51 = toolCalls.length;
const c51b = await grab(() => cat(51, { autoRoots: false }));
ok('--no-auto-roots restores the pure static gate (same OUTSIDE_ROOT, zero list calls)',
  codeOf(c51b.e) === 'OUTSIDE_ROOT' && toolCalls.length === dlBefore51 + 1 &&
    toolCalls[dlBefore51].name === 'download.path',
  JSON.stringify(toolCalls.slice(dlBefore51).map((c) => c.name)));

{
  const list = [
    { path: path.join(ED, 'report.csv') },
    { path: path.join(ED, 'sub', 'deeper.csv') },
    { path: 'relative/report.csv' },
    { path: `${ED}${path.sep}..${path.sep}elsewhere${path.sep}x.txt` },
    { path: path.join(os.homedir(), '.ssh', 'id_rsa') },
    { path: path.join(os.homedir(), '.ubb', 'secrets.json') },
    { path: path.join(DL, 'plain.csv') },
  ];
  const dirs = rootsFromRecords(list);
  const realDL = fs.realpathSync(DL);
  ok('rootsFromRecords: one dir per record folder, deduped, junk skipped',
    dirs.length === 3 && dirs.includes(fs.realpathSync(ED)) &&
      dirs.includes(path.resolve(path.join(ED, 'sub'))) && dirs.includes(realDL),
    JSON.stringify(dirs));
  ok('a declared folder never lands on the credential dirs (.ssh / .ubb)',
    !dirs.some((d) => d.toLowerCase().includes('.ssh') || d.toLowerCase().includes('.ubb')), JSON.stringify(dirs));
  ok('rootsFromRecords ignores records without a usable path (and a non-list)',
    rootsFromRecords([{ path: '' }, { path: null }, {}, null]).length === 0 && rootsFromRecords(undefined).length === 0);
  if (process.platform === 'win32') {
    const flat = rootsFromRecords([{ path: 'E:\\report (1).csv' }]);
    ok('a drive-root download folder is accepted — that IS the live E:\\ shape (7d)',
      flat.length === 1 && isInside(flat[0], 'E:\\report (1).csv'), JSON.stringify(flat));
  } else {
    skip('drive-root download folder case', 'the E:\\ shape only exists on Windows');
  }
  listShouldFail = true;
  const c51c = await grab(() => cat(51));
  listShouldFail = false;
  ok('a failing download.list cannot open anything: still OUTSIDE_ROOT, and it says so',
    codeOf(c51c.e) === 'OUTSIDE_ROOT' && /reading them failed/.test(msgOf(c51c.e)), msgOf(c51c.e));
}

// the hard requirement of fix7dl-2: the id is still never a path, and refusing it
// costs zero tool calls — the root gate got smarter, the input surface did not.
{
  const callsNow = toolCalls.length;
  for (const p of ['../../etc/passwd', path.join(ROOT, 'README.md')]) {
    const c = await grab(() => cat(p));
    ok(`fix7dl-2: a caller-composed path is still BAD_ID: ${p}`, codeOf(c.e) === 'BAD_ID' && !/OUTSIDE_ROOT/.test(msgOf(c.e)), msgOf(c.e));
  }
  ok('fix7dl-2: refusing those two cost zero tool calls (no download.path, no download.list)',
    toolCalls.length === callsNow, `${toolCalls.length - callsNow} extra calls`);
}

// gate units (the two halves of the text decision, asserted separately)
ok('looksTextual: mime table first, extension only when the mime is unknown',
  looksTextual('text/csv', 'a') && looksTextual('application/json', 'a') && !looksTextual('image/png', 'a.png') &&
    looksTextual('', 'notes.txt') && !looksTextual('application/octet-stream', 'a.zip') && !looksTextual('application/pdf', 'a.pdf'));
ok('sniffBinary: NULs/undecodable yes, utf-8 + tabs/CRLF/ESC no',
  sniffBinary(Buffer.from('a\0b')) && sniffBinary(fs.readFileSync(BIN)) &&
    !sniffBinary(Buffer.from('héllo\tworld\r\n\escalping\u001b[0m')) && !sniffBinary(Buffer.alloc(0)));
ok('redactText keeps non-secret text byte-identical when nothing is sensitive',
  redactText('just a note\nsecond line\n') === 'just a note\nsecond line\n');

// ------------------------------------------------------------------ [B] --port
const A = (arr) => ['node', 'daemon/ubb.mjs', ...arr];
const P = (arr, env = {}, fallback = 8765) => resolveLiveviewPorts(A(arr), { env, fallbackDaemonPort: fallback });
ok('--port is the DAEMON port, the preview keeps its default',
  (() => { const r = P(['liveview', '--port', '8899']); return r.daemon === 8899 && r.view === DEFAULT_VIEW_PORT; })(),
  JSON.stringify(P(['liveview', '--port', '8899'])));
ok('--view-port moves the preview and leaves --port as the daemon port',
  (() => { const r = P(['liveview', '--view-port', '9001', '--port', '8899']); return r.daemon === 8899 && r.view === 9001 && r.legacy === false; })(),
  JSON.stringify(P(['liveview', '--view-port', '9001', '--port', '8899'])));
ok('UBB_PORT env is the daemon port when no flag is given',
  (() => { const r = P(['liveview'], { UBB_PORT: '8877' }); return r.daemon === 8877 && r.view === 8790; })(),
  JSON.stringify(P(['liveview'], { UBB_PORT: '8877' })));
ok('UBB_LIVEVIEW_PORT env is the preview port',
  (() => { const r = P(['liveview'], { UBB_LIVEVIEW_PORT: '9100' }); return r.view === 9100 && r.daemon === 8765; })(),
  JSON.stringify(P(['liveview'], { UBB_LIVEVIEW_PORT: '9100' })));
ok('--daemon-port still works as the pre-Wave-4 alias (no --port present)',
  (() => { const r = P(['liveview', '--daemon-port', '8899']); return r.daemon === 8899 && r.view === 8790; })(),
  JSON.stringify(P(['liveview', '--daemon-port', '8899'])));
{
  const cap = captureErr(() => P(['liveview', '--daemon-port', '8899', '--port', '9001']));
  ok('both --daemon-port and --port → --port wins, with a printed warning',
    cap.r.daemon === 9001 && cap.lines.some((l) => /ignoring --daemon-port 8899/.test(l)), JSON.stringify(cap));
}
ok('the config-resolved daemon port is the fallback when no flag/env',
  (() => { const r = P(['liveview'], {}, 8712); return r.daemon === 8712 && r.view === 8790; })(),
  JSON.stringify(P(['liveview'], {}, 8712)));
{
  const c = captureErr(() => P(['liveview', '--port', '8790']));
  ok('a preview that would collide with the daemon port is refused, naming --view-port',
    c.lines.join(' ').includes('THREW') && /--view-port/.test(msgOf(c.threw)), msgOf(c.threw));
}
{
  const c = captureErr(() => P(['liveview', '--view-port', 'abc']));
  ok('--view-port must be a number', /must be a number/.test(msgOf(c.threw)), msgOf(c.threw));
}
{
  const c = captureErr(() => resolveLiveviewPorts(A(['liveview']), { env: {}, fallbackDaemonPort: null }));
  ok('no flag, no env, no config → a named error instead of a silent 8765',
    /cannot resolve the daemon port/.test(msgOf(c.threw)), msgOf(c.threw));
}
ok('the legacy hint fires when --port is given without --view-port (old liveview scripts)',
  P(['liveview', '--port', '8791']).legacy === true && P(['liveview', '--view-port', '8791']).legacy === false);
ok('liveview still binds loopback only and defaults the preview to 8790',
  LIVEVIEW_BIND === '127.0.0.1' && DEFAULT_VIEW_PORT === 8790);
{
  const src = fs.readFileSync(path.join(ROOT, 'daemon', 'cli', 'liveview.mjs'), 'utf8');
  const help = CLI_COMMANDS.find((c) => c.name === 'liveview').describe;
  ok('liveview no longer reads --port as its own listen port', !/rawFlag\('port'\)/.test(src) && !/usePortFlag: false/.test(src), '');
  ok('liveview help text teaches --view-port and says --port is the daemon',
    /--view-port/.test(help) && !/--port is the preview/.test(help), help);
  ok('ubb.mjs help states the global --port meaning + download cat', (() => {
    const s = fs.readFileSync(path.join(ROOT, 'daemon', 'ubb.mjs'), 'utf8');
    return /ubb download cat <id>/.test(s) && /--port is ALWAYS the daemon port|--port is the DAEMON port everywhere/.test(s);
  })());
  ok('ubb.mjs still splices --token/--port/--out and keeps the token gate', (() => {
    const s = fs.readFileSync(path.join(ROOT, 'daemon', 'ubb.mjs'), 'utf8');
    return /flag\('token'\)/.test(s) && /flag\('port'\)/.test(s) && /flag\('out'\)/.test(s) &&
      /if \(!TOKEN && !cliHandled\)/.test(s) && s.indexOf('runCliCommand(cmd, rest)') < s.indexOf('if (!TOKEN');
  })());
}

// ------------------------------------------------------------------ [C] statics
{
  const src = fs.readFileSync(path.join(ROOT, 'daemon', 'cli', 'download.mjs'), 'utf8');
  ok('no bypass flag for binary content or redaction',
    !/allow-binary|no-redact|skipRedact|redactContent/.test(src));
  ok('the CLI only ever reads through the answered path (no argv path input)',
    !/argv.*isAbsolute|readFileSync\(.*argv/.test(src) && /checkDownloadPath\(info\.path/.test(src) && /\/\^\\d\+\$\//.test(src));
  ok('download cat is registered as a CLI subcommand with help text',
    CLI_COMMANDS.some((c) => c.name === 'download') && DOWNLOAD_COMMANDS[0].describe.includes('download cat'));
  ok('the download tools stay curated for MCP and map to registered extension tools',
    MCP_TOOLS.filter((t) => t.ubb && t.ubb.startsWith('download.')).every((t) => /download\.(list|wait|path)/.test(t.ubb)) &&
      MCP_TOOLS.some((t) => /ubb download cat/.test(t.description || '')));
}

// ---------------- fix7dl-4: `download` the subcommand vs `download` the tool
// LIVE-RESULTS-2B 7g: `ubb download '{"url":…}'` was eaten by the subcommand and
// answered `usage: ubb download cat <id>`; the tool was only reachable through a
// raw WS. The name is now shared and `takes()` decides who answers.
{
  const TOOL_ARGV = ['{"url":"https://e.example/x.bin"}'];
  ok('fix7dl-4: ubb download \'<json>\' is NOT owned by the CLI (it falls through to tool.download)',
    ownsDownloadArgv(TOOL_ARGV) === false && ownsDownloadArgv(['{}']) === false && ownsDownloadArgv(['{"ref":"@e307"}']) === false,
    JSON.stringify(TOOL_ARGV));
  ok('fix7dl-4: ubb download cat <id> is still owned by the CLI',
    ownsDownloadArgv(['cat', '11']) === true && ownsDownloadArgv(['cat']) === true);
  ok('fix7dl-4: the other known actions + bare `ubb download` (usage) stay with the CLI',
    ['list', 'path', 'status', 'wait', 'help'].every((a) => ownsDownloadArgv([a, '{"download_id":1}']) === true) &&
      ownsDownloadArgv([]) === true && ownsDownloadArgv(['--help']) === true);
  ok('fix7dl-4: the download tool really is a tool the fallthrough can reach',
    MCP_TOOLS.some((t) => t.ubb === 'download') || /R\('download'/.test(fs.readFileSync(path.join(ROOT, 'lib', 'tools.js'), 'utf8')));
  ok('fix7dl-4: runCliCommand returns false for a non-owned argv (no subcommand body ran)',
    (await runCliCommand('download', TOOL_ARGV)) === false);
  ok('fix7dl-4: an unknown command name still returns false (unchanged)',
    (await runCliCommand('totally.not.a.command', [])) === false);
  {
    // the takes() gate must be opt-in: secret/audit/liveview cannot change shape
    const others = CLI_COMMANDS.filter((c) => c.name !== 'download');
    ok('fix7dl-4: no other contributed subcommand declares takes() — their dispatch is byte-for-byte the old one',
      others.every((c) => c.takes === undefined) && others.map((c) => c.name).includes('secret') &&
        others.map((c) => c.name).includes('audit') && others.map((c) => c.name).includes('liveview'),
      JSON.stringify(others.map((c) => `${c.name}:${c.takes ? 'takes' : '-'}`)));
    let probeRan = 0;
    CLI_COMMANDS.push({ name: '__probe_no_takes__', describe: 'p', run: () => { probeRan++; } });
    CLI_COMMANDS.push({ name: '__probe_takes__', describe: 'p', takes: () => false, run: () => { probeRan++; } });
    const a = await runCliCommand('__probe_no_takes__', []);
    const b = await runCliCommand('__probe_takes__', ['{"x":1}']);
    CLI_COMMANDS.splice(CLI_COMMANDS.length - 2, 2);
    ok('fix7dl-4: gate semantics — no takes() → always runs; takes():false → never runs, reports unhandled',
      a === true && b === false && probeRan === 1, `a=${a} b=${b} ran=${probeRan}`);
  }
  {
    // source-level: the CLI body must not be reachable for a JSON argv anymore
    const idx = fs.readFileSync(path.join(ROOT, 'daemon', 'cli', 'index.mjs'), 'utf8');
    ok('fix7dl-4: the fallthrough lives in the registry lookup, not in a download special-case',
      /c\.takes && !c\.takes\(argv\)/.test(idx) && !/download/.test(idx.split('runCliCommand')[1].split('}')[0]), idx.split('export async function runCliCommand')[1]?.slice(0, 240));
  }
}

// ------------------------------------------------------------------ [D] end to end
const freePort = () =>
  new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
const PORT = await freePort();
const TOKEN = 'f'.repeat(32) + '-one-shot-test-token';
// a throwaway HOME: ~/.ubb/config.json resolves to the empty temp tree, never the
// user's real vault/token file, and the one-shot token below wins anyway.
const childEnv = { ...process.env, UBB_TOKEN: TOKEN, UBB_PORT: String(PORT), HOME: FAKE_HOME, USERPROFILE: FAKE_HOME };
delete childEnv.UBB_DOWNLOAD_DIRS;
delete childEnv.UBB_LIVEVIEW_PORT;

const daemon = spawn(process.execPath, [path.join(ROOT, 'daemon', 'ubb-bridge.mjs'), '--port', String(PORT), '--token', TOKEN], {
  stdio: ['ignore', 'ignore', 'pipe'],
  env: childEnv,
  windowsHide: true,
});
let daemonErr = '';
daemon.stderr.on('data', (d) => { daemonErr += d; });
const wsUrl = `ws://127.0.0.1:${PORT}/`;
const health = () => fetch(`http://127.0.0.1:${PORT}/health`).then((r) => r.ok).catch(() => false);
let extWs = null;
const extToolHits = [];
const extAnyHits = [];
const extDownloadHits = [];
// the browser side of download.list for [D]: the folders it declares as its own.
// id 33 (TMP/elsewhere) is deliberately NOT in here — no download ever lived in
// that folder, which is what the OUTSIDE_ROOT gate is for.
const EXT_LIST_RECORDS = [
  { id: 11, path: CSV, state: 'complete', text_readable: true },
  { id: 60, path: path.join(ED, 'report (1).csv'), state: 'complete', text_readable: true },
];
const runCli = (args, env = childEnv) =>
  new Promise((resolve) => {
    const c = spawn(process.execPath, [path.join(ROOT, 'daemon', 'ubb.mjs'), ...args], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    let err = '';
    c.stdout.on('data', (d) => { out += d; });
    c.stderr.on('data', (d) => { err += d; });
    const timer = setTimeout(() => { try { c.kill(); } catch {} resolve({ code: -1, out, err: `${err}\n(timeout)` }); }, 25_000);
    c.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, out, err });
    });
  });

try {
  let up = false;
  for (let i = 0; i < 60 && !(up = await health()); i++) await new Promise((r) => setTimeout(r, 100));
  ok('e2e: test daemon is up on a one-shot port/token', up, `daemon stderr: ${daemonErr.slice(0, 200)}`);
  if (!up) throw new Error('daemon never came up');

  extWs = new WebSocket(wsUrl, [`ubb-auth.${TOKEN}`]);
  await new Promise((resolve, reject) => {
    extWs.addEventListener('open', resolve, { once: true });
    extWs.addEventListener('error', () => reject(new Error('fake extension could not connect')), { once: true });
    setTimeout(() => reject(new Error('fake extension open timed out')), 4000);
  });
  extWs.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (!m.method) return;
    extAnyHits.push(m.method);
    if (m.method === 'tool.download.path') {
      extToolHits.push(m.params);
      const a = answers.get(m.params.download_id);
      extWs.send(JSON.stringify({ id: m.id, ...(a ? { result: a } : { error: { code: 'NOT_FOUND', message: `no download ${m.params.download_id}` } }) }));
    } else if (m.method === 'tool.download.list') {
      extWs.send(JSON.stringify({ id: m.id, result: { downloads: EXT_LIST_RECORDS, count: EXT_LIST_RECORDS.length, source: 'ledger' } }));
    } else if (m.method === 'tool.download') {
      extDownloadHits.push(m.params);
      extWs.send(JSON.stringify({ id: m.id, result: { download_id: 777, url: m.params?.url || null } }));
    }
  });

  const good = await runCli(['download', 'cat', '11', '--allow-path', DL]);
  ok('e2e: ubb download cat prints the file through daemon + fake extension',
    good.code === 0 && good.out.includes('alice') && extToolHits.length === 1, JSON.stringify(good).slice(0, 300));
  ok('e2e: the password column never reaches stdout, and the summary goes to stderr',
    !good.out.includes('s3cretPW') && !good.out.includes('TKVA99') && /ubb download cat: #11/.test(good.err),
    JSON.stringify({ out: good.out.slice(0, 120), err: good.err.slice(0, 160) }));
  ok('e2e: cat on a static-root file asked NO download.list (discovery is only a rescue)',
    !extAnyHits.includes('tool.download.list'), JSON.stringify(extAnyHits));

  const badId = await runCli(['download', 'cat', path.join(FAKE_HOME, '.ubb', 'secrets.json'), '--allow-path', DL]);
  ok('e2e: a caller-typed path is refused BEFORE anything is asked or read',
    badId.code === 1 && /BAD_ID/.test(badId.err) && extToolHits.length === 1 && !badId.out.includes('hunter'),
    JSON.stringify(badId).slice(0, 240));

  // fix7dl-2 with the REAL socket: a second caller-composed path, and the browser
  // folder is discovered through download.list instead of a hand-typed root.
  const typed = await runCli(['download', 'cat', path.join(ROOT, 'README.md')]);
  const anyBefore = extAnyHits.length;
  const caller2 = await runCli(['download', 'cat', '../../etc/passwd']);
  ok('e2e fix7dl-2: a repo path handed to `download cat` is BAD_ID (not OUTSIDE_ROOT), zero tool calls',
    typed.code === 1 && /BAD_ID/.test(typed.err) && !/OUTSIDE_ROOT/.test(typed.err) && extAnyHits.length === anyBefore,
    JSON.stringify(typed).slice(0, 240));
  ok('e2e fix7dl-2: "../../etc/passwd" too — the id never reaches the extension',
    caller2.code === 1 && /BAD_ID/.test(caller2.err) && extAnyHits.length === anyBefore,
    JSON.stringify(caller2).slice(0, 240));

  answers.set(60, done(60, path.join(ED, 'report (1).csv'), 'text/csv'));
  const autoRoot = await runCli(['download', 'cat', '60']);
  ok('e2e fix7dl-2: cat of a download in the folder the browser declares works with NO --allow-path (live 7d)',
    autoRoot.code === 0 && autoRoot.out.includes('github') && !autoRoot.out.includes('ghp_EVADE123'),
    JSON.stringify(autoRoot).slice(0, 260));
  ok('e2e fix7dl-2: the root it used is named on stderr, so nothing is widened silently',
    /root auto-read from download\.list/.test(autoRoot.err) && autoRoot.err.includes(fs.realpathSync(ED)),
    autoRoot.err.slice(0, 300));
  ok('e2e fix7dl-2: the rescue really cost one download.list call',
    extAnyHits.filter((m) => m === 'tool.download.list').length === 1, JSON.stringify(extAnyHits));
  const noAuto = await runCli(['download', 'cat', '60', '--no-auto-roots']);
  ok('e2e fix7dl-2: --no-auto-roots puts the old OUTSIDE_ROOT back (the gate is not gone)',
    noAuto.code === 1 && /OUTSIDE_ROOT/.test(noAuto.err) && /not under a download root/.test(noAuto.err),
    JSON.stringify(noAuto).slice(0, 260));
  const stillOut = await runCli(['download', 'cat', '33', '--allow-path', FAKE_HOME]);
  ok('e2e fix7dl-2: a folder no download ever mentions stays refused even after discovery',
    stillOut.code === 1 && /OUTSIDE_ROOT/.test(stillOut.err) && /download\.list offered/.test(stillOut.err),
    JSON.stringify(stillOut).slice(0, 300));
  ok('e2e: an answered path outside the roots exits 1 with OUTSIDE_ROOT',
    stillOut.code === 1 && /OUTSIDE_ROOT/.test(stillOut.err), JSON.stringify(stillOut).slice(0, 240));

  // fix7dl-4 with the REAL socket: the shared `download` name has to reach the tool.
  const viaTool = await runCli(['download', '{"url":"https://e.example/x.bin"}']);
  ok('e2e fix7dl-4: ubb download \'{"url":…}\' reaches tool.download (live 7g answered the cat usage instead)',
    viaTool.code === 0 && extDownloadHits.length === 1 && extDownloadHits[0].url === 'https://e.example/x.bin' &&
      /777/.test(viaTool.out), JSON.stringify(viaTool).slice(0, 300));
  ok('e2e fix7dl-4: it does not print the download-cat usage any more',
    !/usage: ubb download cat/.test(viaTool.out + viaTool.err), JSON.stringify(viaTool).slice(0, 300));
  const catStill = await runCli(['download', 'cat', '11', '--allow-path', DL]);
  ok('e2e fix7dl-4: ubb download cat 11 still runs as the CLI (no extra tool.download, cat summary on stderr)',
    catStill.code === 0 && extDownloadHits.length === 1 && /ubb download cat: #11/.test(catStill.err),
    JSON.stringify(catStill).slice(0, 200));
  const bare = await runCli(['download']);
  ok('e2e fix7dl-4: bare `ubb download` still prints usage instead of firing the tool with no params',
    bare.code === 0 && /usage: ubb download cat/.test(bare.err) && extDownloadHits.length === 1,
    JSON.stringify(bare).slice(0, 240));
  const deadTool = await runCli(['download', '{"ref":"@e307"}']);
  ok('e2e fix7dl-4: the ref shape goes to the tool too (the extension answers, not the usage text)',
    !/usage: ubb download cat/.test(deadTool.out + deadTool.err) && extDownloadHits.length === 2 && extDownloadHits[1].ref === '@e307',
    JSON.stringify(deadTool).slice(0, 240));

  const binary = await runCli(['download', 'cat', '16', '--allow-path', DL]);
  ok('e2e: a binary download exits 1, prints no bytes, names the path',
    binary.code === 1 && /BINARY/.test(binary.err) && binary.out === '' && binary.err.includes('blob.bin'),
    JSON.stringify(binary).slice(0, 240));

  const capped = await runCli(['download', 'cat', '21', '--allow-path', DL, '--max-bytes', '64']);
  ok('e2e: --max-bytes is honoured across the real CLI path',
    capped.code === 0 && capped.out.includes(`showed 64 of ${BIG_SIZE} bytes`) && /\(TRUNCATED by --max-bytes\)/.test(capped.err),
    JSON.stringify(capped).slice(0, 200));

  let ghostPort = await freePort();
  while (ghostPort === DEFAULT_VIEW_PORT) ghostPort = await freePort();
  const lv = await runCli(['liveview', '--port', String(ghostPort)]);
  ok('e2e: ubb liveview --port aims at the DAEMON (nothing there) and hints --view-port',
    lv.code !== 0 && /--view-port/.test(lv.err) && /DAEMON port/.test(lv.err), JSON.stringify(lv).slice(0, 260));

  const help = await runCli(['help']);
  ok('e2e: ubb help lists download cat and the --port rule',
    help.code === 0 && /ubb download cat/.test(help.out) && /--view-port/.test(help.out), help.out.slice(-400));
} catch (e) {
  ok('e2e harness survived', false, `${e.message} — daemon stderr: ${daemonErr.slice(0, 300)}`);
} finally {
  try { extWs?.close(); } catch {}
  try { daemon.kill(); } catch {}
}

console.log(`\n${pass} passed, ${fail} failed`);
try {
  fs.rmSync(TMP, { recursive: true, force: true });
} catch {}
process.exit(fail ? 1 : 0);
