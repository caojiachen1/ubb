// Wave 1-B ("replay") curated ubb_* definitions. Shape: { name, description,
// inputSchema, ubb } — see core.mjs for examples and schema.mjs for s()/TAB_ID.
import { s, TAB_ID } from './schema.mjs';

const VARS = s('object', 'Values for the {{var.NAME}} placeholders in the trace, as {NAME: value}. Values never come back in the result (only names and lengths). A value may be "{{secret:NAME}}" — the daemon substitutes it vault-side (inside vars only, never inside the trace) and the matching replay step is then allowed to type a password field. Do not put plaintext secrets here.');

const REPLAY_PARAMS = {
  ...Object.fromEntries([TAB_ID]),
  vars: VARS,
  stop_on_error: s('boolean', 'Abort at the first failing step (default true).'),
  dry_run: s('boolean', 'Match and plan only, perform NOTHING. Run this first on an unknown page.'),
  start_at: s('number', 'Event index to resume from (0-based, as reported by a previous plan).'),
  max_steps: s('number', 'Steps to run from start_at (cap 500 per call).'),
  wait_between_ms: s('number', 'Settle pause between steps (default 250).'),
  confirm: s('boolean', 'Authorize destructive/paid labels for the whole run. Ask the user first.'),
  timeout_ms: s('number', 'Per-navigation load cap for navigate steps (default 20000).'),
};

export const REPLAY_TOOLS = [
  {
    name: 'ubb_replay',
    description:
      'Replay a recorded trace (the ubb_call "record_stop" result object, its events array, or an edited array whose values use {{var.NAME}}) on one tab with zero LLM calls per run. Each step is re-matched semantically against a fresh accessibility snapshot (role + name, selector/tag as tie-breaker) because recorded refs die on navigation; MATCH_NOT_FOUND returns the 3 closest candidates so you can fix the trace or resume with start_at. Passwords only through vars: {"PW":"{{secret:NAME}}"} — the daemon resolves placeholders strictly inside vars (never in the trace), and just those steps may type a password field; masked "***" values, plaintext passwords, unresolved {{secret:…}} and OTP/card/*secret* fields are refused with no bypass (SENSITIVE_FIELD / SECRET_UNRESOLVED); every vault-backed fill is audited by name, never by value. drag steps are reported as skipped. Cap 500 steps per call; long traces are slow because every targeting step re-snapshots, so chunk with start_at/max_steps. ALWAYS call with dry_run:true first and read the plan.',
    inputSchema: {
      type: 'object',
      properties: {
        trace: {
          description: 'The record_stop trace object (preferred: pass it back unchanged).',
          type: 'object',
        },
        events: { type: 'array', items: { type: 'object' }, description: 'Events array, as an alternative to trace.' },
        ...REPLAY_PARAMS,
      },
      additionalProperties: true,
    },
    ubb: 'replay',
  },
  {
    name: 'ubb_replay_run',
    description: 'Run a script previously stored by ubb_replay_save (same options as ubb_replay, no trace parameter).',
    inputSchema: {
      type: 'object',
      properties: { name: s('string', 'Saved script name (from ubb_replay_list).'), ...REPLAY_PARAMS },
      required: ['name'],
      additionalProperties: true,
    },
    ubb: 'replay.run',
  },
  {
    name: 'ubb_replay_save',
    description:
      'Store a trace as a named reusable script in the extension session (key ubb_replay:<name>, events only, ≤1MB) so it can be run with ubb_replay_run without holding the trace in context. Lives until the browser restarts — disk export is a CLI concern, not this tool.',
    inputSchema: {
      type: 'object',
      properties: {
        name: s('string', 'Script name: [A-Za-z0-9_.-]{1,64}.'),
        trace: { description: 'The record_stop trace object.', type: 'object' },
        events: { type: 'array', items: { type: 'object' }, description: 'Or just the events array.' },
      },
      required: ['name'],
      additionalProperties: true,
    },
    ubb: 'replay.save',
  },
  {
    name: 'ubb_replay_list',
    description: 'List saved replay scripts (name, saved_at, step count, urls — never event values).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: true },
    ubb: 'replay.list',
  },
  {
    name: 'ubb_replay_delete',
    description: 'Delete a saved replay script.',
    inputSchema: {
      type: 'object',
      properties: { name: s('string', 'Script name to delete.') },
      required: ['name'],
      additionalProperties: true,
    },
    ubb: 'replay.delete',
  },
];
