// UBB shared configuration and protocol constants.

export const PROTOCOL = {
  version: '1.0',
  minCompatible: '1.0',
  client: 'ubb-extension',
};

export const STORAGE_KEYS = {
  token: 'ubb_token',
  port: 'ubb_port',
  enabled: 'ubb_enabled',
  shieldMode: 'ubb_shield_mode', // 'block' | 'border' | 'off'
};

export const DEFAULTS = {
  port: 8765,
  enabled: true,
  shieldMode: 'block',
};

export const IDLE_DETACH_MS = 30_000;
export const HEARTBEAT_MS = 20_000;
export const HEARTBEAT_TIMEOUT_MS = 15_000;
export const DEFAULT_TOOL_TIMEOUT_MS = 40_000;
export const SCREENSHOT_TOOL_TIMEOUT_MS = 60_000;
export const TRACE_TOOL_TIMEOUT_MS = 120_000;
// Per-CDP-command deadline: bounds a hung renderer command so it cannot wedge
// the per-tab queue. Above the tool timeouts (40/60s) that agents see first;
// below TRACE (120s) — tracing data arrives via events, never a held command.
export const CDP_CMD_TIMEOUT_MS = 45_000;
export const BUILD = '2026.10.29-visible-gate';

export const GROUP_COLOR = 'purple';
export const GROUP_TITLES = {
  running: '⏳ UBB',
  done: '✅ UBB',
  error: '❌ UBB',
  paused: '⏸ UBB',
};

export function err(code, message, data) {
  return { code, message: message || code, ...(data ? { data } : {}) };
}

export function randomHex(bytes) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
}
