// Curated ubb_* definitions for the secret.* vault (contract §5).
// Rule for every description here: talk about NAMES, never about values — a
// value typed into these arguments enters the conversation transcript.
import { s, TAB_ID } from './schema.mjs';

export const SECRETS_TOOLS = [
  {
    name: 'ubb_secret_list',
    description: 'List the NAMES and origin bindings of credentials stored in the user\'s local vault (~/.ubb/secrets.json), plus the current secret_origin_mode ("off" default | "strict": a secret is only typeable on a page whose host matches its binding; a password field inside an iframe is judged against THAT frame\'s own origin when its URL is known — fail-closed to the tab host otherwise). Values are never returned by any tool. Use a name with ubb_secret_fill, or as a {{secret:NAME}} placeholder — the placeholder is substituted ONLY inside ubb_fill / fill_form values and replay vars (never evaluate/cdp.call/webmcp.invoke; ubb_type does NOT substitute — it has no target field the guard could classify, so a placeholder there stays literal text; use ubb_fill or ubb_secret_fill instead), and in mode "strict" it additionally obeys the origin binding (SECRET_ORIGIN_DENIED on mismatch, unbound secrets refused everywhere); OTP / one-time-code / CVV / card-number fields refuse it permanently.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: true },
    ubb: 'secret.list',
  },
  {
    name: 'ubb_secret_fill',
    description: 'Fill a password input from the vault by name: {"ref":"@e7","secret":"github_pw"}. The daemon hands the value to the extension at the moment of typing, so the plaintext never appears in your arguments, in the result, in the audit ring or in the logs. Every fill is audited as {secret name, target host, field_role:"password"} — never the value. In origin mode "strict" the secret must be bound (via `ubb secret bind <name> <host>`, by a human at a terminal; single-label hosts bind too, e.g. localhost or 127.0.0.1) to the page\'s host, otherwise SECRET_ORIGIN_DENIED; mode "off" (default) also allows unbound secrets. Preferred over ubb_fill for any password field. The {{secret:NAME}} placeholder form works the same way inside ubb_fill / fill_form values and replay vars — those three surfaces only: evaluate and the raw-CDP/WebMCP escape hatches never substitute, and ubb_type does NOT substitute either (a live OTP/CVV bypass, fixed 2026-10-28: type has no target field for the guard to classify, so a placeholder there stays literal text — use ubb_fill or this tool instead). OTP / one-time-code / CVV / card-number / private-key fields are refused permanently — the user must type those themselves. Fields whose name contains "secret" (e.g. client_secret) are refused here too: deliberate over-conservatism, not a bug to work around.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: s('string', 'Password input ref from ubb_snapshot / ubb_read_page, e.g. "@e7".'),
        secret: s('string', 'Vault entry NAME (not its value), e.g. "github_pw". See ubb_secret_list. The same name may only appear as a {{secret:NAME}} placeholder in fill / fill_form values and replay vars — never in type, evaluate or other code-running params, where it stays literal text (type has no field for the guard to classify) and the field-level guards still refuse.'),
        enforce: s('string', 'Optional per-call origin mode: "off" or "strict". Defaults to the user\'s configured secret_origin_mode; prefer leaving it unset.'),
        press_enter: s('boolean', 'Press Enter after filling (use to submit a login form).'),
        [TAB_ID[0]]: TAB_ID[1],
      },
      required: ['ref', 'secret'],
      additionalProperties: true,
    },
    ubb: 'secret.fill',
  },
  {
    name: 'ubb_secret_set',
    description: 'Store or overwrite a vault entry by name. confirm:true is required. DISCLOSURE: the value you pass travels through this conversation transcript, the daemon and the extension — ask the user to run `ubb secret add <name>` in their own terminal (reads from stdin) instead, and only use this when they explicitly agree. The result reports the name and byte count, never the value.',
    inputSchema: {
      type: 'object',
      properties: {
        name: s('string', 'Entry name: letters, digits, _ . - up to 64 chars (e.g. github_pw).'),
        value: s('string', 'The credential. Passing it here puts it in the transcript — prefer ubb secret add.'),
        confirm: s('boolean', 'true = the user agreed to hand the value over through this conversation.'),
      },
      required: ['name', 'value'],
      additionalProperties: true,
    },
    ubb: 'secret.set',
  },
  {
    name: 'ubb_secret_delete',
    description: 'Remove a vault entry by name. Name only; nothing about the stored value is echoed back.',
    inputSchema: {
      type: 'object',
      properties: {
        name: s('string', 'Entry name to remove.'),
      },
      required: ['name'],
      additionalProperties: true,
    },
    ubb: 'secret.delete',
  },
];
