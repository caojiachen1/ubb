// Shield controller: talks to content/shield.js.
// The shield = full-viewport pulsing highlight frame + input-blocking veil +
// status pill + Interrupt button (user requirement; gating pattern from
// QwenWork's HIDE_FOR_TOOL_USE, visual language from BrowserSkill/Qoder).

export const pendingConfirms = new Map(); // reqId → {resolve}

async function msg(tabId, payload) {
  try {
    return await chrome.tabs.sendMessage(tabId, payload);
  } catch {
    return { ok: false, unreachable: true };
  }
}

export const shield = {
  /** arm / update the shield on a tab */
  async set(tabId, { mode = 'armed', label = 'UBB agent control', status = '' } = {}) {
    const stored = (await chrome.storage.local.get('ubb_shield_mode')).ubb_shield_mode || 'block';
    return msg(tabId, { type: 'UBB_SHIELD', mode, label, status, blockMode: stored });
  },
  async disarm(tabId) {
    return msg(tabId, { type: 'UBB_SHIELD', mode: 'off' });
  },
  /** Temporarily let agent CDP input pass through the veil (tool-use gate). */
  async pass(tabId, on) {
    return msg(tabId, { type: 'UBB_PASS', on: !!on });
  },
  /** Read current shield state without changing it. */
  async query(tabId) {
    return msg(tabId, { type: 'UBB_SHIELD_QUERY' });
  },
  /** Hide/show the whole shield (screenshot hygiene). */
  async visible(tabId, on) {
    return msg(tabId, { type: 'UBB_VISIBLE', on: !!on });
  },
  /** On-page confirmation banner; resolves true/false. */
  async confirm(tabId, title, timeoutMs = 60000) {
    const reqId = Math.random().toString(36).slice(2);
    const p = new Promise((resolve) => {
      pendingConfirms.set(reqId, { resolve });
      setTimeout(() => {
        if (pendingConfirms.has(reqId)) {
          pendingConfirms.delete(reqId);
          resolve(false);
        }
      }, timeoutMs);
    });
    const r = await msg(tabId, { type: 'UBB_CONFIRM', reqId, title, timeoutMs });
    if (r?.unreachable) {
      pendingConfirms.delete(reqId);
      // Content script not reachable (e.g. before injection): be safe, deny.
      return false;
    }
    return p;
  },
};

/** Fire-and-forget with a cap: a modal JS dialog freezes content scripts,
 *  so shield messages must never block tool execution. */
function capped(promise, ms = 400) {
  return Promise.race([promise.catch(() => {}), sleep(ms)]);
}

/** Wrap an agent-input action in pass-through gating. */
export async function withPass(tabId, fn) {
  await capped(shield.pass(tabId, true));
  try {
    return await fn();
  } finally {
    await capped(shield.pass(tabId, false));
  }
}

/** Wrap a capture action in shield-visibility gating. */
export async function withHiddenShield(tabId, fn) {
  await capped(shield.visible(tabId, false));
  await sleep(80);
  try {
    return await fn();
  } finally {
    await capped(shield.visible(tabId, true));
  }
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
