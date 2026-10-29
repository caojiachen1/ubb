// Local credential vault + `ubb secret …` CLI.
//
// daemon/ubb-bridge.mjs imports the storage functions from THIS file (contract
// §3 forbids a second unregistered daemon module) so the daemon and the CLI are
// one implementation, not two parsers.
//
// Storage: ~/.ubb/secrets.json, plaintext, current user only. Two record shapes
// live side by side: a bare string (no origin binding) and
// { "name": { "value": "…", "origins": ["github.com"] } } — wave2 harvest-risk
// binding (§_scratch/integration-items.md 活一). UBB_SECRETS_FILE overrides the
// path (tests must never read the real vault); UBB_CONFIG_FILE overrides
// ~/.ubb/config.json, whose `secret_origin_mode` ("off" default | "strict")
// gates where a bound secret may be typed.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';

export const SECRET_NAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const PLACEHOLDER_LOOSE = /\{\{secret:([^{}]*)\}\}/g;
// §5: only these two may ever receive a fully deep-resolved plaintext value —
// every one of their steps lands on a CLASSIFIABLE node (ref/selector), so the
// extension's guardSensitiveField runs before a keystroke. `type` is OUT (live
// incident, LIVE-RESULTS-2B §3c): it carries no target field, nothing can be
// classified, so we cannot prove it is not an OTP/CVV box — no substitution.
// evaluate / cdp.call / webmcp.invoke / batch are deliberately absent too —
// substituting there would hand the credential to arbitrary page JS.
export const SECRET_FILL_METHODS = new Set(['fill', 'fill_form']);
// wave2 (B hand-off): replay may carry vault values, but ONLY inside
// params.vars — never inside trace/events, or a resolved plaintext would end up
// written back into a saved script. Nodeless replay steps (keypress/scroll/
// navigate) never receive vars on the extension side — applyVars runs only on
// fill/select step values, and each of those matches a node the guard can
// classify before typing — so replay has no `type`-shaped variant of §3c.
export const SECRET_VARS_METHODS = new Set(['replay', 'replay.run']);
// scripts must never persist plaintext: any vault value found in these params
// is restored to its {{secret:NAME}} placeholder before forwarding.
export const SECRET_RESTORE_METHODS = new Set(['replay.save']);
// secret.fill carries no placeholder, but the daemon stamps the authoritative
// origin-binding + mode on it (the extension knows the tab's origin, §活一).
export const SECRET_BIND_METHODS = new Set(['secret.fill']);
// extension-trusted markers — an agent may not pre-set them; the daemon strips
// then re-stamps on the whitelisted methods only.
export const SECRET_MARKER_KEYS = ['__ubb_secret_fill', '__ubb_secret_vars', '__ubb_secret_binding', '__ubb_secret_names', '__ubb_secret_gate'];
// batch re-enters the dispatcher INSIDE the extension (tools-quick.js), so its
// step params never pass a substitution point — but a forged __ubb_secret_fill
// riding them would still release the password guard. Strip markers anyway.
export const SECRET_STRIP_ONLY_METHODS = new Set(['batch']);
// restoring shorter vault values would mangle ordinary text (a 3-char secret
// occurs "everywhere"); nothing realistic is this short and the flow still
// works via placeholders anyway.
const MIN_RESTORE_VALUE_LEN = 6;

export function secretsFile() {
  return process.env.UBB_SECRETS_FILE || path.join(os.homedir(), '.ubb', 'secrets.json');
}

export function configFile() {
  return process.env.UBB_CONFIG_FILE || path.join(os.homedir(), '.ubb', 'config.json');
}

function fail(code, message) {
  throw Object.assign(new Error(message), { code });
}

function assertName(name) {
  if (typeof name !== 'string' || !SECRET_NAME_RE.test(name)) {
    fail('BAD_SECRET_NAME', `"${String(name).slice(0, 64)}" is not a valid secret name (allowed: letters, digits, _ . - up to 64 chars)`);
  }
  return name;
}

function readStore() {
  let raw;
  try {
    raw = fs.readFileSync(secretsFile(), 'utf8');
  } catch {
    return {};
  }
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch {
    fail('VAULT_CORRUPT', `cannot parse ${secretsFile()} — fix or delete that file (no values are reported here)`);
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    fail('VAULT_CORRUPT', `${secretsFile()} must contain a JSON object of {"name": "value"}`);
  }
  return obj;
}

function writeStore(store) {
  const file = secretsFile();
  const firstCreate = !fs.existsSync(file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(store, null, 2) + '\n');
  try {
    fs.chmodSync(file, 0o600);
  } catch {}
  if (firstCreate) {
    console.error(`[ubb] WARNING: secrets are now stored in PLAINTEXT at ${file}`);
    console.error('[ubb]         keep this disk encrypted and your OS account password-protected.');
    if (process.platform === 'win32') {
      console.error('[ubb]         note: chmod is a no-op on Windows — the file inherits the ACL of your');
      console.error('[ubb]         user profile directory. Per-user ACL + BitLocker/FileVault are the real control.');
    }
  }
}

/** {name: "value"} and {name:{value,origins}} are one record; never throws on shape. */
function readRecord(store, name) {
  const raw = store[name];
  if (typeof raw === 'string') return raw.length ? { value: raw, origins: [] } : null;
  if (raw && typeof raw === 'object' && typeof raw.value === 'string' && raw.value.length) {
    const origins = Array.isArray(raw.origins) ? raw.origins.filter((o) => typeof o === 'string' && o) : [];
    return { value: raw.value, origins };
  }
  return null;
}

// ---------------------------------------------------------------- origin binding

/** "https://GitHub.com:443/login" → "github.com"; garbage throws BAD_ORIGIN_HOST. */
export function normalizeOriginHost(raw) {
  let h = String(raw ?? '').trim().toLowerCase();
  if (/^[a-z][a-z0-9+.-]*:\/\//.test(h)) h = h.slice(h.indexOf('//') + 2);
  h = h.split('/')[0].split(':')[0].replace(/^\.+|\.+$/g, '');
  // single-label hosts bind too (live-2B §2d: requiring a dot made strict mode
  // unusable on localhost dev pages; IPs already passed via their dots). The
  // github.com.evil.test suffix defense lives in originMatches' exact-or-
  // subdomain rule below — not in a dot requirement here.
  if (!/^[a-z0-9.-]+$/.test(h) || h.startsWith('.') || h.endsWith('.') || h.includes('..')) {
    fail('BAD_ORIGIN_HOST', `"${String(raw).slice(0, 120)}" is not a bindable host (expected e.g. github.com, localhost or 127.0.0.1, no path/port)`);
  }
  return h;
}

/** Bound host matches the exact hostname or any subdomain of it. */
export function originMatches(host, boundHost) {
  const h = String(host || '').toLowerCase();
  const b = String(boundHost || '').toLowerCase();
  return !!h && !!b && (h === b || h.endsWith('.' + b));
}

export function resolveSecret(name) {
  assertName(name);
  return readRecord(readStore(), name)?.value ?? null;
}

export function secretRecord(name) {
  assertName(name);
  return readRecord(readStore(), name);
}

/** origins=undefined keeps an existing binding; [] clears it; [...] rebinds. */
export function setSecret(name, value, origins) {
  assertName(name);
  if (typeof value !== 'string' || value.length === 0) {
    fail('BAD_SECRET_VALUE', `secret "${name}" needs a non-empty string value (the value itself is never echoed back)`);
  }
  const store = readStore();
  const bound = origins === undefined || origins === null ? readRecord(store, name)?.origins ?? [] : [...new Set(Array.from(origins, normalizeOriginHost))];
  store[name] = bound.length ? { value, origins: bound } : value;
  writeStore(store);
  return { name, bytes: value.length, origins: bound };
}

export function bindSecret(name, hosts) {
  assertName(name);
  const store = readStore();
  const rec = readRecord(store, name);
  if (!rec) fail('SECRET_UNKNOWN', `no secret named "${name}" to bind — add it first (ubb secret add ${name})`);
  const bound = [...new Set(Array.from(hosts ?? [], normalizeOriginHost))];
  store[name] = bound.length ? { value: rec.value, origins: bound } : rec.value;
  writeStore(store);
  return { name, origins: bound };
}

export function deleteSecret(name) {
  assertName(name);
  const store = readStore();
  if (!(name in store)) return { name, existed: false };
  delete store[name];
  writeStore(store);
  return { name, existed: true };
}

export function listNames() {
  return Object.keys(readStore()).sort();
}

/** names + bindings only, never values. */
export function listRecords() {
  const store = readStore();
  return Object.keys(store)
    .sort()
    .map((name) => {
      const rec = readRecord(store, name);
      return { name, bound: !!(rec && rec.origins.length), origins: rec?.origins ?? [] };
    });
}

// ---------------------------------------------------------------- origin mode (config)

export function getSecretOriginMode() {
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(configFile(), 'utf8'));
  } catch {
    return 'off';
  }
  return cfg && cfg.secret_origin_mode === 'strict' ? 'strict' : 'off';
}

export function setSecretOriginMode(mode) {
  if (mode !== 'off' && mode !== 'strict') {
    fail('BAD_SECRET_MODE', `secret_origin_mode must be "off" or "strict" (got "${String(mode).slice(0, 24)}")`);
  }
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(configFile(), 'utf8'));
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) cfg = {};
  } catch {
    cfg = {};
  }
  cfg.secret_origin_mode = mode;
  const file = configFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // the config file also holds the daemon token — never print its contents
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n');
  try {
    fs.chmodSync(file, 0o600);
  } catch {}
  return { mode, file };
}

export function vaultInfo() {
  const file = secretsFile();
  let mtime = null;
  try {
    mtime = fs.statSync(file).mtime.toISOString();
  } catch {}
  return { path: file, updated_at: mtime, count: listNames().length };
}

function stripMarkers(p) {
  if (p && typeof p === 'object' && !Array.isArray(p)) {
    for (const k of SECRET_MARKER_KEYS) delete p[k];
  }
  return p;
}

/**
 * Deep-scan string values for {{secret:NAME}} and resolve them (fill /
 * fill_form only). Names that are syntactically fine but absent land in
 * `missing`; malformed tokens land in `invalid`. Neither list ever carries a
 * value. `denied` names strict-mode-unbound secrets: the target origin is
 * unknowable here (the daemon never sees the tab), but an UNBOUND secret under
 * strict is refused on every origin — so it is rejected pre-substitution and
 * its value never leaves the daemon. Bound names are resolved, and the
 * extension (the one party that knows the tab origin) enforces the match via
 * __ubb_secret_names.
 */
export function substituteSecrets(params, tool = 'fill') {
  const missing = [];
  const invalid = [];
  let replaced = 0;
  const used = new Map(); // name → origins of that record
  const outOfScope = [];
  const input = params && typeof params === 'object' && !Array.isArray(params) ? stripMarkers({ ...params }) : {};
  // Only schema-declared value leaves may carry a secret. A placeholder in
  // ref/selector/id would otherwise be replaced too, and a failure message
  // ("no such ref @<value>") could echo the plaintext back to the caller.
  const allowed = new Set();
  if (tool === 'fill_form') {
    if (input.values && typeof input.values === 'object' && !Array.isArray(input.values)) {
      for (const [k, v] of Object.entries(input.values)) {
        if (typeof v === 'string' && v.includes('{{secret:')) allowed.add(`values.${k}`);
      }
    }
  } else if (typeof input.value === 'string' && input.value.includes('{{secret:')) {
    allowed.add('value');
  }
  const scan = (v, path) => {
    if (typeof v === 'string') {
      if (v.includes('{{secret:') && !allowed.has(path) && outOfScope.length < 8) outOfScope.push(path || '(root)');
      return v;
    }
    if (Array.isArray(v)) return v.map((x, i) => scan(x, `${path}.${i}`));
    if (v && typeof v === 'object') {
      const o = {};
      for (const [k, x] of Object.entries(v)) o[k] = scan(x, path ? `${path}.${k}` : k);
      return o;
    }
    return v;
  };
  const scanned = scan(input, '');
  if (!allowed.size) {
    return { params: scanned, missing, invalid, replaced: 0, denied: [], outOfScope };
  }
  const store = readStore();
  const walk = (v, path) => {
    if (typeof v === 'string') {
      if (!allowed.has(path) || !v.includes('{{secret:')) return v;
      return v.replace(PLACEHOLDER_LOOSE, (whole, raw) => {
        if (!SECRET_NAME_RE.test(raw)) {
          invalid.push(String(raw).slice(0, 64));
          return whole;
        }
        const rec = readRecord(store, raw);
        if (!rec) {
          missing.push(raw);
          return whole;
        }
        replaced++;
        used.set(raw, rec.origins);
        return rec.value;
      });
    }
    if (Array.isArray(v)) return v.map((x, i) => walk(x, `${path}.${i}`));
    if (v && typeof v === 'object') {
      const o = {};
      for (const [k, x] of Object.entries(v)) o[k] = walk(x, path ? `${path}.${k}` : k);
      return o;
    }
    return v;
  };
  const out = stripMarkers(walk(scanned, ''));
  const names = [...used.keys()];
  const mode = getSecretOriginMode();
  const denied = mode === 'strict' ? names.filter((n) => !used.get(n) || !used.get(n).length) : [];
  if (replaced && !denied.length && out && typeof out === 'object' && !Array.isArray(out)) {
    out.__ubb_secret_fill = true;
    out.__ubb_secret_names = names; // names only — never values or counts per name
    // authoritative binding snapshot (same trust model as secret.fill's
    // __ubb_secret_binding): the extension compares it against the tab host;
    // a name the daemon stamped can never be forged agent-side (markers strip)
    out.__ubb_secret_gate = { mode, bindings: names.map((n) => ({ name: n, exists: true, origins: used.get(n) || [] })) };
  }
  return { params: out, missing: [...new Set(missing)], invalid: [...new Set(invalid)], replaced, denied, outOfScope };
}

/**
 * replay / replay.run: substitute ONLY inside the values of params.vars.
 * trace / events / name stay untouched, so no plaintext can ride a structural
 * field back into a saved script. `resolved` maps each vars key whose value
 * came from the vault to the secret NAMES used — the extension releases the
 * password-field guard exactly for those replay steps and nothing else.
 */
export function substituteSecretVars(params) {
  const missing = [];
  const invalid = [];
  let replaced = 0;
  const resolved = {};
  const originsUsed = new Map(); // name → origins of that record
  const store = readStore();
  const p = stripMarkers(params && typeof params === 'object' && !Array.isArray(params) ? { ...params } : {});
  const vars = p.vars;
  if (vars && typeof vars === 'object' && !Array.isArray(vars)) {
    const out = {};
    for (const [k, v] of Object.entries(vars)) {
      if (typeof v !== 'string') {
        out[k] = v;
        continue;
      }
      const used = [];
      out[k] = v.replace(PLACEHOLDER_LOOSE, (whole, raw) => {
        if (!SECRET_NAME_RE.test(raw)) {
          invalid.push(String(raw).slice(0, 64));
          return whole;
        }
        const rec = readRecord(store, raw);
        if (!rec) {
          missing.push(raw);
          return whole;
        }
        replaced++;
        used.push(raw);
        originsUsed.set(raw, rec.origins);
        return rec.value;
      });
      if (used.length) resolved[k] = used;
    }
    p.vars = out;
  }
  const names = [...originsUsed.keys()];
  const denied = getSecretOriginMode() === 'strict' ? names.filter((n) => !originsUsed.get(n) || !originsUsed.get(n).length) : [];
  if (replaced && !denied.length) {
    p.__ubb_secret_fill = true;
    p.__ubb_secret_vars = resolved;
    p.__ubb_secret_names = names; // flat ledger for the extension's origin gate
    p.__ubb_secret_gate = { mode: getSecretOriginMode(), bindings: names.map((n) => ({ name: n, exists: true, origins: originsUsed.get(n) || [] })) };
  }
  return { params: p, missing: [...new Set(missing)], invalid: [...new Set(invalid)], replaced, denied, resolved };
}

/** replay.save: a vault plaintext must never persist into chrome.storage.session,
 *  so every occurrence of a stored value is restored to its placeholder. */
export function restoreVaultPlaintext(params) {
  const store = readStore();
  const pairs = Object.keys(store)
    .map((name) => ({ name, value: readRecord(store, name)?.value }))
    .filter((r) => r.value && r.value.length >= MIN_RESTORE_VALUE_LEN)
    .sort((a, b) => b.value.length - a.value.length);
  const names = new Set();
  let hits = 0;
  const walk = (v) => {
    if (typeof v === 'string') {
      let s = v;
      for (const { name, value } of pairs) {
        if (s.includes(value)) {
          hits += s.split(value).length - 1;
          names.add(name);
          s = s.split(value).join(`{{secret:${name}}}`);
        }
      }
      return s;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const o = {};
      for (const [k, x] of Object.entries(v)) o[k] = walk(x);
      return o;
    }
    return v;
  };
  const out = pairs.length ? walk(params && typeof params === 'object' ? params : {}) : params ?? {};
  return { params: out, hits, names: [...names] };
}

/** secret.fill: authoritative binding stamp (agent-supplied markers were
 *  stripped, so a phishing page cannot self-declare "no binding"). Priority
 *  params.enforce > config secret_origin_mode > "off". */
function stampSecretBinding(params) {
  const p = stripMarkers(params && typeof params === 'object' && !Array.isArray(params) ? { ...params } : {});
  const name = typeof p.secret === 'string' ? p.secret : '';
  let origins = [];
  if (SECRET_NAME_RE.test(name)) origins = readRecord(readStore(), name)?.origins ?? [];
  const mode = p.enforce === 'strict' || p.enforce === 'off' ? p.enforce : getSecretOriginMode();
  p.__ubb_secret_binding = { mode, origins };
  return p;
}

/** names + bindings only (never values) for the extension's origin gate on the
 *  placeholder path — the extension knows the tab host, the daemon knows the
 *  vault; this is the join. Unknown/malformed names come back exists:false so
 *  the extension can fail closed under strict. */
export function secretBindings(names) {
  const store = readStore();
  const list = Array.isArray(names) ? names.slice(0, 32) : [];
  const bindings = list.map((raw) => {
    const name = String(raw ?? '').slice(0, 64);
    if (!SECRET_NAME_RE.test(name)) return { name, exists: false, origins: [] };
    const rec = readRecord(store, name);
    return { name, exists: !!rec, origins: rec ? rec.origins : [] };
  });
  return { mode: getSecretOriginMode(), bindings };
}

/** Forward-time hook: returns the params the extension should receive. */
export function prepareForward(method, params) {
  const tool = String(method || '').replace(/^tool\./, '');
  const base = { tool, missing: [], invalid: [], replaced: 0 };
  if (SECRET_FILL_METHODS.has(tool)) return { ...base, ...substituteSecrets(params, tool) };
  if (SECRET_VARS_METHODS.has(tool)) return { ...base, ...substituteSecretVars(params) };
  if (SECRET_RESTORE_METHODS.has(tool)) {
    const r = restoreVaultPlaintext(params);
    return { ...base, params: r.params, replaced: r.hits, secrets_restored: r.names };
  }
  if (SECRET_BIND_METHODS.has(tool)) return { ...base, params: stampSecretBinding(params) };
  if (SECRET_STRIP_ONLY_METHODS.has(tool)) {
    const p = stripMarkers(params && typeof params === 'object' && !Array.isArray(params) ? { ...params } : {});
    // batch steps dispatch INSIDE the extension — no later strip point exists
    if (Array.isArray(p.actions)) {
      for (const a of p.actions) if (a && typeof a === 'object') stripMarkers(a.params);
    }
    return { ...base, params: p };
  }
  return { ...base, params: stripMarkers(params && typeof params === 'object' && !Array.isArray(params) ? { ...params } : params ?? {}) };
}

// ---------------------------------------------------------------- cli

function usage() {
  console.error(`usage:
  ubb secret add <name> [--origin host]…  read the value from stdin (cat pw | ubb secret add github_pw --origin github.com)
  ubb secret list              names + origin bindings — values are never printed
  ubb secret bind <name> <host>…   set the origin binding (no hosts clears the binding); hosts may be single-label (localhost) or IPs (127.0.0.1)
  ubb secret rm <name>
  ubb secret mode [off|strict]  origin enforcement: off = unbound secrets may be typed anywhere (each fill audited), strict = a secret must be bound to the page's host
  ubb secret has <name>        exit 0 = present, 1 = absent, no output
placeholders: {{secret:NAME}} substitutes ONLY in fill / fill_form values and
replay vars — never in type (it has no target field to classify), evaluate,
cdp.call or webmcp.invoke; for the focused-element case use fill or secret.fill.`);
  process.exit(1);
}

async function readStdinValue() {
  if (process.stdin.isTTY) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    try {
      return (await rl.question('value> ')).replace(/\r?\n$/, '');
    } finally {
      rl.close();
    }
  }
  return fs.readFileSync(0, 'utf8').replace(/\r?\n$/, '');
}

async function run(argv) {
  try {
    await runInner(argv);
  } catch (e) {
    // never let a vault error print a stack trace, and never print a value
    console.error(`ubb secret: ${e?.message || e}`);
    process.exitCode = 1;
  }
}

async function runInner(argv) {
  const [sub, name, ...rest] = argv;
  if (sub === 'add') {
    if (!name) usage();
    const origins = [];
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] !== '--origin') usage();
      if (!rest[++i]) usage();
      origins.push(rest[i]);
    }
    const value = await readStdinValue();
    if (!value) {
      console.error(`ubb secret: empty input for "${name}" — nothing stored`);
      process.exitCode = 1;
      return;
    }
    const r = setSecret(name, value, origins.length ? origins : undefined);
    console.log(`stored secret "${r.name}" (${r.bytes} bytes)${r.origins.length ? ` [bound to: ${r.origins.join(', ')}]` : ' [no origin binding]'} in ${secretsFile()}`);
    return;
  }
  if (sub === 'list') {
    const records = listRecords();
    if (!records.length) console.log('(no secrets stored yet)');
    else {
      for (const r of records) console.log(`${r.name}${r.origins.length ? `  <- ${r.origins.join(', ')}` : '  (no origin binding)'}`);
      console.error(`origin mode: ${getSecretOriginMode()} (change with: ubb secret mode [off|strict])`);
    }
    return;
  }
  if (sub === 'bind') {
    if (!name) usage();
    const r = bindSecret(name, rest);
    console.log(r.origins.length ? `bound "${r.name}" to: ${r.origins.join(', ')}` : `origin binding cleared for "${r.name}" (now typeable anywhere, subject to origin mode)`);
    return;
  }
  if (sub === 'mode') {
    // `mode`'s second slot is a VALUE, not a secret name — the shared
    // [sub, name, ...rest] destructure used to eat it into `name`, which made
    // every `ubb secret mode strict` fall into the query branch below (live-verify §9).
    if (rest.length) {
      fail('BAD_USAGE', `ubb secret mode takes at most one value (off|strict), got: ${JSON.stringify([name, ...rest]).slice(0, 80)}`);
    }
    if (name !== undefined) {
      const r = setSecretOriginMode(name);
      console.log(`secret_origin_mode: ${r.mode} (written to ${r.file})`);
      return;
    }
    const mode = getSecretOriginMode();
    console.log(`secret_origin_mode: ${mode}`);
    console.log(mode === 'strict' ? '  strict: a secret may only be typed on a page whose host matches its origin binding; unbound secrets are refused (SECRET_ORIGIN_DENIED)' : '  off: an unbound secret may be typed on any page; every fill is audited (name + host, never the value)');
    return;
  }
  if (sub === 'rm') {
    if (!name) usage();
    if (rest.length) fail('BAD_USAGE', `ubb secret rm takes exactly one name, got: ${JSON.stringify(rest).slice(0, 80)}`);
    const r = deleteSecret(name);
    console.log(r.existed ? `removed "${r.name}"` : `no secret named "${r.name}"`);
    if (!r.existed) process.exitCode = 1;
    return;
  }
  if (sub === 'has') {
    if (!name) usage();
    if (rest.length) fail('BAD_USAGE', `ubb secret has takes exactly one name, got: ${JSON.stringify(rest).slice(0, 80)}`);
    let present = false;
    try {
      present = resolveSecret(name) != null;
    } catch {
      present = false;
    }
    process.exitCode = present ? 0 : 1; // existence only — never echoes anything
    return;
  }
  usage();
}

export const SECRET_COMMANDS = [
  {
    name: 'secret',
    describe: 'local credential vault: ubb secret add <name> [--origin host] | list | bind <name> <host>… | mode [off|strict] | rm <name> | has <name> (values only ever come from stdin, never from argv/shell history)',
    run,
  },
];
