// secret.* — the ONLY place a credential value may be touched, and it never
// touches a plaintext the model supplied: the value is fetched from the local
// daemon over the already-authenticated extension socket at the moment of
// typing (_scratch/AGENT-CONTRACT.md §5). Values never reach tool results,
// audit entries, daemon logs or error messages (§4.6).

import {
  targetTab,
  resolveRef,
  attrsOf,
  guardSensitiveField,
  PASSWORD_FIELD,
  cdp,
  evalJs,
  key,
  withPass,
  shield,
  audit,
  redact,
  err,
} from './actions.js';
import { requestDaemon } from './ws-client.js';
import { isEnabled as humanOn, humanType } from './human.js';

const SECRET_NAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;

// mirror of originMatches() in daemon/cli/secret.mjs — lib/* cannot import the
// Node module (contract §1); test-secrets asserts both copies judge alike.
function originMatches(host, boundHost) {
  const h = String(host || '').toLowerCase();
  const b = String(boundHost || '').toLowerCase();
  return !!h && !!b && (h === b || h.endsWith('.' + b));
}

function tabHost(url) {
  try {
    return new URL(String(url || '')).hostname.toLowerCase();
  } catch {
    return '';
  }
}

async function ask(method, params) {
  let r;
  try {
    r = await requestDaemon(method, params);
  } catch (e) {
    if (e && e.code) throw e; // SECRET_UNKNOWN / SECRET_FETCH_TIMEOUT keep their guidance
    throw err('DAEMON_NOT_CONNECTED', `could not ask the local daemon (${method}): ${String(e?.message || e)} — check the UBB popup status / \`ubb daemon status\``);
  }
  if (!r || typeof r !== 'object') throw err('DAEMON_ERROR', `the daemon sent no answer for ${method} — restart it with \`ubb daemon stop\` then retry`);
  return r;
}

/** @param {string} name → the plaintext, held only in this local frame. */
async function fetchSecret(name) {
  const r = await ask('secret.resolve', { name });
  const value = r.value;
  if (typeof value !== 'string' || !value.length) {
    throw err('SECRET_UNKNOWN', `the daemon returned no value for secret "${name}" — list names with \`ubb secret list\``);
  }
  return value;
}

function checkedName(name) {
  const n = typeof name === 'string' ? name : '';
  if (!SECRET_NAME_RE.test(n)) {
    throw err('BAD_PARAMS', `secret name "${String(name).slice(0, 64)}" is invalid (letters, digits, _ . - up to 64 chars; e.g. github_pw)`);
  }
  return n;
}

export function register(dispatcher) {
  const R = (name, meta, fn) => dispatcher.register(name, meta, fn);

  R('secret.list', { category: 'secrets', description: 'Names of the secrets in the local daemon vault, plus vault path/mtime. Values are never returned — reference a name from secret.fill or a {{secret:NAME}} placeholder.' }, async () => {
    const r = await ask('secret.list', {});
    return redact({
      names: Array.isArray(r.names) ? r.names : [],
      vault_path: r.vault_path,
      vault_updated_at: r.vault_updated_at,
      note: 'values are never listed; use the name in secret.fill',
    });
  });

  R('secret.set', { category: 'secrets', sensitive: true, description: 'Store/overwrite a secret by name in the local vault. confirm:true required. WARNING: the value you pass here becomes part of this conversation transcript and crosses into the daemon — the safer route is to ask the user to run `ubb secret add <name>` in their terminal, which reads the value from stdin and never enters the conversation. Result and audit carry the name and byte count only.' }, async (p = {}) => {
    if (p.confirm !== true) {
      throw err('NEEDS_CONFIRM', 'secret.set writes a credential to disk and the value you pass lands in this transcript — prefer asking the user to run `ubb secret add <name>` themselves; retry with confirm:true only if they agree to hand it over here');
    }
    const name = checkedName(p.name);
    const value = typeof p.value === 'string' ? p.value : '';
    if (!value) throw err('BAD_PARAMS', 'secret.set needs {name, value} — and remember the value lands in the transcript; `ubb secret add` is better');
    const r = await ask('secret.set', { name, value });
    audit.log({ action: 'secret.set', name, bytes: r.bytes ?? value.length });
    return redact({ stored: r.name ?? name, bytes: r.bytes ?? value.length, note: 'value not returned; verify by using it in secret.fill' });
  });

  R('secret.delete', { category: 'secrets', description: 'Remove a secret by name from the local vault. Name only, never a value.' }, async (p = {}) => {
    const name = checkedName(p.name);
    const r = await ask('secret.delete', { name });
    audit.log({ action: 'secret.delete', name, existed: !!r.existed });
    return redact({ deleted: r.name ?? name, existed: !!r.existed });
  });

  R(
    'secret.fill',
    {
      category: 'secrets',
      description:
        'Fill a PASSWORD field from the vault by NAME: {"ref":"@e7","secret":"github_pw"}. The value is fetched from the local daemon at typing time, so it never appears in your arguments, results or logs. ' +
        'ORIGIN BINDING: a vault entry may be bound to hosts (ubb secret bind <name> <host>); origin mode "strict" (ubb secret mode strict) refuses any fill whose page host does not match the binding — unbound secrets are refused entirely under strict. The default mode "off" keeps unbound secrets typeable anywhere, but every fill is audited with {name, host, field_role:"password"} so harvesting attempts show up in `ubb audit tail`. ' +
        'The {{secret:NAME}} placeholder substitutes only in fill / fill_form values and replay vars — NOT in type (it has no target field to classify, so the placeholder stays literal there). ' +
        'Optional "enforce":"off"|"strict" overrides the configured mode for one call. ' +
        'OTP / one-time-code / CVV / card-number / private-key fields are refused permanently, with no bypass parameter. Fields whose NAME contains "secret" (e.g. client_secret) are also refused here — deliberate over-conservatism, not a bug; type those yourself.',
      timeoutMs: 25000,
    },
    async (p = {}) => {
      if (p.value != null || p.text != null) {
        throw err('SENSITIVE_FIELD', 'secret.fill takes the secret NAME only — a value here would sit in the transcript, the audit ring and the daemon log; drop it and pass {"ref":"@eN","secret":"<name>"}');
      }
      if (p.enforce != null && p.enforce !== 'off' && p.enforce !== 'strict') {
        throw err('BAD_PARAMS', `enforce must be "off" or "strict" (got ${JSON.stringify(String(p.enforce).slice(0, 24))})`);
      }
      const name = checkedName(p.secret);
      if (typeof p.ref !== 'string' || !p.ref.startsWith('@')) {
        throw err('BAD_PARAMS', 'secret.fill needs a snapshot ref like "@e7" — run snapshot first, then {"ref":"@e7","secret":"<name>"} (tab_id is honoured, pass it explicitly)');
      }
      const tabId = targetTab(p);
      const { nodeId, box, meta } = await resolveRef(tabId, p.ref);
      const attrs = await attrsOf(tabId, nodeId);
      const ac = String(attrs.autocomplete || '').toLowerCase();
      // §4.5 first, and it stays first: OTP/CVV/card/私钥/name-contains-secret are
      // refused even though this call is allowed to fill password fields.
      await guardSensitiveField(tabId, nodeId, meta, { allowPassword: true });
      const isPassword =
        attrs.type === 'password' ||
        ac === 'current-password' ||
        ac === 'new-password' ||
        PASSWORD_FIELD.test([attrs.type, attrs.autocomplete, attrs.name, attrs.id, attrs.placeholder, attrs['aria-label'], meta?.name].join(' '));
      if (!isPassword) {
        throw err('NOT_PASSWORD_FIELD', `${p.ref} is not a password field — secret.fill is for password inputs; for a normal field use fill with the "{{secret:${name}}}" placeholder`);
      }
      // __ubb_secret_binding is stamped by the daemon (agent copies of it are
      // stripped at the forward boundary), so this is the authoritative mode.
      const binding = p.__ubb_secret_binding && typeof p.__ubb_secret_binding === 'object' ? p.__ubb_secret_binding : {};
      const mode = binding.mode === 'strict' ? 'strict' : 'off';
      const origins = Array.isArray(binding.origins) ? binding.origins : [];
      const host = tabHost((await chrome.tabs.get(tabId)).url);
      if (mode === 'strict' && !origins.some((o) => originMatches(host, o))) {
        audit.log({
          action: 'secret.fill', tab_id: tabId, vault_entry: name, origin: host || null,
          field_role: 'password', mode, decision: 'denied', reason: origins.length ? 'origin_mismatch' : 'unbound',
        });
        throw err(
          'SECRET_ORIGIN_DENIED',
          `secret "${name}" ${origins.length ? `is bound to ${origins.join(', ')} but this tab is host ${JSON.stringify(host || '(unknown)')}` : 'has no origin binding and mode is strict'} — open the bound site, or bind it: \`ubb secret bind ${name} <host>\` (a human, not the agent, runs that). OTP/CVV remain refused everywhere.`,
        );
      }
      // visible notice through the existing shield channel before anything is typed
      await shield.help(tabId, {
        reqId: `secret-fill-${Date.now()}`,
        title: `ubb is auto-typing the saved password "${name}"${host ? ` into ${host}` : ''} — hit Interrupt if you did not ask for this login`,
        timeoutMs: 4000,
      });
      // The value is fetched BEFORE the door opens on purpose: a reverse RPC to
      // the daemon can take up to 10s and an open pass is the window in which the
      // USER's own input reaches the page — it must stay as short as the typing
      // itself. The plaintext only ever names the send the gate below refuses.
      const value = await fetchSecret(name); // held in this local frame only
      await withPass(tabId, async (gate) => {
        // same deterministic REPLACE as fill(): mark the node from the DOM
        // domain, select its current text from page JS, then insert over it
        await cdp.send(tabId, 'DOM.setAttributeValue', { nodeId, name: 'data-ubb-tmp', value: '1' });
        await evalJs(tabId, `(function(){var el=document.querySelector('[data-ubb-tmp]');el.removeAttribute('data-ubb-tmp');el.focus();try{el.setSelectionRange(0,(el.value||'').length)}catch(e){}})()`);
        // raw Input.insertText bypasses actions.mouse()/key(), so it carries its
        // own proof of THIS point — same strength as fill {ref} (lib/tools.js).
        // A refused check throws before the credential has a single character on
        // the wire, and this path never audits or returns the value.
        await gate.check();
        if (await humanOn()) await humanType(tabId, value);
        else await cdp.send(tabId, 'Input.insertText', { text: value });
        if (p.press_enter) {
          await key(tabId, 'keyDown', 'Enter');
          await key(tabId, 'keyUp', 'Enter');
        }
      }, { frameId: meta?.frameId ?? 0, at: [box.cx, box.cy], keys: true });
      // key names here deliberately avoid redact()'s sensitive substrings —
      // audit entries pass through redact() on the way out, and a key like
      // "secret" would blank the very field the stats need (integration §活一.3)
      // No `frame` key on purpose: a frame-scoped ref never reaches this line
      // (resolveRef returns nodeId null for it and the attrs/password check
      // refuses), so `origin` here is always the TAB host — the frame:true
      // marker belongs exclusively to the tools.js placeholder branch, the
      // one path that really does judge a frame's own origin.
      audit.log({
        action: 'secret.fill', tab_id: tabId, vault_entry: name, target: meta?.name, origin: host || null,
        field_role: 'password', mode, decision: 'filled', bytes: value.length,
      });
      const out = redact({ filled: p.ref, target: meta?.name, secret: name });
      // redact() blanks any key named "secret"; this one holds the name, which
      // SECRET_NAME_RE already proved cannot be a free-form value.
      out.secret = name;
      return out;
    },
  );
}
