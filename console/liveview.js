// Live view page logic. Kept in an external file because extension-page CSP is
// script-src 'self' (no inline); served by `ubb liveview` from the same origin.

const FRAME_MS = 500;
const EVENTS_MS = 1000;

const img = document.getElementById('frame');
const empty = document.getElementById('empty');
const meta = document.getElementById('meta');
const list = document.getElementById('events');

let framesSeen = 0;

function tickFrame() {
  // cache-buster + no-store: the server always answers with the newest JPEG
  img.src = `/frame.jpg?_=${Date.now()}`;
}

img.addEventListener('load', () => {
  framesSeen += 1;
  if (!img.naturalWidth) return;
  img.hidden = false;
  empty.hidden = true;
  meta.textContent = `第 ${framesSeen} 次刷新 · ${img.naturalWidth}×${img.naturalHeight}`;
});

img.addEventListener('error', () => {
  meta.textContent = '取帧失败（服务已退出，或 token 无效）';
});

function summarize(params) {
  if (!params || typeof params !== 'object') return '';
  const parts = [];
  for (const [k, v] of Object.entries(params)) {
    if (v == null || typeof v === 'object') continue;
    parts.push(`${k}=${String(v).slice(0, 60)}`);
    if (parts.length >= 4) break;
  }
  return parts.join(' ');
}

function renderEvents(items) {
  list.replaceChildren(
    ...items.map((e) => {
      const li = document.createElement('li');
      const time = document.createElement('time');
      time.textContent = (e.at || '').slice(11, 19);
      const name = document.createElement('b');
      name.textContent = e.name;
      const span = document.createElement('span');
      span.textContent = summarize(e.params);
      li.append(time, name, span);
      return li;
    }),
  );
}

async function tickEvents() {
  try {
    const r = await fetch(`/events?_=${Date.now()}`, { credentials: 'same-origin' });
    if (r.status === 403) {
      list.replaceChildren();
      meta.textContent = '403：请用带 ?token= 的地址打开本页';
      return;
    }
    const data = await r.json();
    renderEvents(data.events || []);
    if (data.frames) meta.textContent = `已接收 ${data.frames} 帧 · ${(data.size / 1024).toFixed(0)} KB/帧`;
  } catch {
    meta.textContent = '事件流断开（liveview 服务已退出）';
  }
}

tickFrame();
tickEvents();
setInterval(tickFrame, FRAME_MS);
setInterval(tickEvents, EVENTS_MS);
