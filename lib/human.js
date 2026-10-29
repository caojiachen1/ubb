// Experimental human-behaviour engine (default OFF, popup toggle).
// When enabled, click/type/fill/drag/scroll go through human-like motion:
// bezier mouse paths with jitter, off-center hit points, dwell hesitation,
// per-key typing cadence with occasional typo+backspace.

import { cdp } from './cdp.js';
import { sleep, assertInputGate } from './shield-ctl.js';

const KEY = 'ubb_human_mode';

// Human mode drives chrome.* Input.* itself, so it owes the same per-dispatch
// proof every other input path pays (fix7-shield / fix8): an event this file
// sends after the veil closed is an event the page never receives, and the tool
// would still report success.
//
// Which dispatches get a proof: every event the page can ACT on — press, release,
// keyDown/keyUp, insertText, wheel — one proof each, thrown from inside the send
// site so a refused proof means that command never reaches the wire. The bezier
// approach samples are the exception: an eaten mouseMoved changes nothing the
// caller promised (the pointer merely did not travel), while proof-per-sample
// would put 6-24 extra message+executeScript rounds on every human click, so the
// travel is re-proved every GATE_EVERY-th step and always on the last one — and
// the press that follows carries its own proof regardless.
const GATE_EVERY = 4;

export async function isEnabled() {
  try {
    const st = await chrome.storage.local.get(KEY);
    return st[KEY] === true;
  } catch {
    return false;
  }
}

export async function setEnabled(v) {
  await chrome.storage.local.set({ [KEY]: !!v });
  return !!v;
}

const rand = (a, b) => a + Math.random() * (b - a);
const ri = (a, b) => Math.floor(rand(a, b + 1));

const lastMouse = new Map(); // tabId → {x, y}

async function move(tabId, x, y, prove = true) {
  if (prove) await assertInputGate(tabId);
  await cdp.send(tabId, 'Input.dispatchMouseEvent', {
    type: 'mouseMoved', x, y, button: 'none', buttons: 0, clickCount: 0,
  });
  lastMouse.set(tabId, { x, y });
}

/** Quadratic-bezier walk from last position to (tx,ty) with perpendicular bulge. */
export async function humanMoveTo(tabId, tx, ty) {
  let from = lastMouse.get(tabId);
  if (!from) {
    from = { x: ri(200, 700), y: ri(300, Math.max(320, ty + 200)) };
  }
  const dist = Math.hypot(tx - from.x, ty - from.y);
  const steps = Math.max(6, Math.min(24, Math.round(dist / 40)));
  const mx = (from.x + tx) / 2;
  const my = (from.y + ty) / 2;
  const nx = -(ty - from.y);
  const ny = tx - from.x;
  const len = Math.hypot(nx, ny) || 1;
  const bulge = rand(-0.25, 0.25) * dist;
  const cx = mx + (nx / len) * bulge;
  const cy = my + (ny / len) * bulge;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const u = 1 - t;
    const x = u * u * from.x + 2 * u * t * cx + t * t * tx + rand(-1.5, 1.5);
    const y = u * u * from.y + 2 * u * t * cy + t * t * ty + rand(-1.5, 1.5);
    // travel samples: proof every GATE_EVERY-th step and always on the last one
    // (see GATE_EVERY); the press/release below each carries its own proof
    await move(tabId, x, y, i % GATE_EVERY === 0 || i === steps);
    await sleep(ri(6, 18));
  }
  return { x: tx, y: ty };
}

/** Pick a jittered hit point inside the box (avoid dead-center signature). */
export function jitterPoint(box) {
  const ox = (Math.random() - 0.5) * 0.5 * box.width;
  const oy = (Math.random() - 0.5) * 0.5 * box.height;
  return {
    x: Math.min(box.x + box.width - 2, Math.max(box.x + 2, box.cx + ox)),
    y: Math.min(box.y + box.height - 2, Math.max(box.y + 2, box.cy + oy)),
  };
}

/** Human click: bezier approach → dwell → micro-pause → press/release. */
export async function humanClick(tabId, box, { clickCount = 1, button = 'left' } = {}) {
  const p = jitterPoint(box);
  await humanMoveTo(tabId, p.x, p.y);
  await sleep(ri(50, 160)); // dwell / hesitation
  await move(tabId, p.x + rand(-1, 1), p.y + rand(-1, 1));
  await assertInputGate(tabId); // the press: the event the page acts on
  await cdp.send(tabId, 'Input.dispatchMouseEvent', {
    type: 'mousePressed', x: p.x, y: p.y, button, buttons: 1, clickCount,
  });
  await sleep(ri(45, 110));
  await assertInputGate(tabId); // and the release, one proof per dispatch
  await cdp.send(tabId, 'Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: p.x, y: p.y, button, buttons: 1, clickCount,
  });
  return { x: Math.round(p.x), y: Math.round(p.y) };
}

const QWERTY_NEIGHBORS = {
  a: 'sq', b: 'vn', c: 'xv', d: 'sf', e: 'wr', f: 'dg', g: 'fh', h: 'gj', i: 'uo',
  j: 'hk', k: 'jl', l: 'k', m: 'n', n: 'bm', o: 'ip', p: 'o', q: 'w', r: 'et',
  s: 'ad', t: 'ry', u: 'yi', v: 'cb', w: 'qe', x: 'zc', y: 'tu', z: 'x',
};

function keyCodeOfChar(ch) {
  if (/^[a-z]$/.test(ch)) return { key: ch, code: 'Key' + ch.toUpperCase(), vk: ch.toUpperCase().charCodeAt(0) };
  if (/^[A-Z]$/.test(ch)) return { key: ch, code: 'Key' + ch, vk: ch.charCodeAt(0), mods: 8 }; // 8 = Shift
  if (/^[0-9]$/.test(ch)) return { key: ch, code: 'Digit' + ch, vk: ch.charCodeAt(0) };
  if (ch === ' ') return { key: ' ', code: 'Space', vk: 32 };
  if (ch === '\n') return { key: 'Enter', code: 'Enter', vk: 13 };
  if (ch === '\t') return { key: 'Tab', code: 'Tab', vk: 9 };
  return null; // non-keyboard char → insertText path
}

async function pressKey(tabId, k, { modifiers = 0 } = {}) {
  const mods = modifiers | (k.mods || 0);
  // keyDown and keyUp are two dispatches, so they are proved twice: a key whose
  // up half got eaten by our own veil leaves the page holding a stuck key
  await assertInputGate(tabId);
  await cdp.send(tabId, 'Input.dispatchKeyEvent', {
    type: 'keyDown', modifiers: mods, key: k.key, code: k.code,
    windowsVirtualKeyCode: k.vk, ...(k.key.length === 1 ? { text: k.key } : {}),
  });
  await assertInputGate(tabId);
  await cdp.send(tabId, 'Input.dispatchKeyEvent', {
    type: 'keyUp', modifiers: mods, key: k.key, code: k.code, windowsVirtualKeyCode: k.vk,
  });
}

/** Per-character typing with human cadence; CJK/symbols via per-char insertText. */
export async function humanType(tabId, text) {
  const str = String(text ?? '');
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    const k = keyCodeOfChar(ch);
    // occasional typo + backspace for plain-latin runs
    if (k && /^[a-z]$/.test(ch) && str.length >= 10 && Math.random() < 0.04) {
      const nb = QWERTY_NEIGHBORS[ch];
      const wrong = nb ? nb[ri(0, nb.length - 1)] : ch;
      if (wrong !== ch) {
        await pressKey(tabId, keyCodeOfChar(wrong));
        await sleep(ri(90, 240));
        await pressKey(tabId, { key: 'Backspace', code: 'Backspace', vk: 8 });
        await sleep(ri(60, 140));
      }
    }
    if (k) {
      await pressKey(tabId, k);
    } else {
      await assertInputGate(tabId); // per-char insertText is its own dispatch
      await cdp.send(tabId, 'Input.insertText', { text: ch });
    }
    // cadence: base 30-85ms, occasional longer pause at spaces
    await sleep(ch === ' ' ? ri(70, 180) : ri(28, 85));
    if (Math.random() < 0.05) await sleep(ri(150, 420)); // thinking pause
  }
  return { chars: str.length };
}

/** Chunked human scroll (smaller wheel/scrollBy steps with pauses). */
export async function humanScrollChunks(tabId, dir, amount) {
  const chunks = Math.max(2, Math.min(5, Math.round(Math.abs(amount) / 350) || 2));
  const per = Math.round(amount / chunks);
  for (let i = 0; i < chunks; i++) {
    await assertInputGate(tabId); // a wheel chunk is the scroll the page must feel
    await cdp.send(tabId, 'Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: ri(300, 600), y: ri(200, 500),
      deltaX: 0, deltaY: per + ri(-30, 30),
    });
    await sleep(ri(90, 260));
  }
  return { chunks };
}
