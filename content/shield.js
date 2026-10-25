// UBB shield: the "controlled tab" indicator + input blocker.
// - pulsing highlight frame around the viewport
// - input-blocking veil (user clicks/keys are swallowed while armed)
// - status pill with a Stop (interrupt) button
// - pass-through gate for agent CDP input (UBB_PASS) and screenshot hygiene (UBB_VISIBLE)
// (visual language: BrowserSkill/Qoder indicators; gating: QwenWork HIDE_FOR_TOOL_USE)

(() => {
  if (window.__ubbShield) return;
  window.__ubbShield = true;

  let mode = 'off'; // off | armed | paused
  let blockMode = 'block'; // block | border | off (from popup setting)
  let pass = false; // agent input in flight → veil lets events through
  let visible = true;
  let label = 'UBB agent control';
  let host = null;
  let veil = null;
  let pill = null;
  let pillLabel = null;
  let style = null;

  const CSS = `
    @keyframes ubb-pulse {
      0%,100% { box-shadow: inset 0 0 0 3px rgba(99,102,241,.9), inset 0 0 24px rgba(99,102,241,.35); }
      50%     { box-shadow: inset 0 0 0 3px rgba(129,140,248,1),  inset 0 0 48px rgba(99,102,241,.55); }
    }
    * { all: initial; box-sizing: border-box; }
    .host { position: fixed; inset: 0; z-index: 2147483647; pointer-events: none; font-family: system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; }
    .frame { position: absolute; inset: 0; pointer-events: none; animation: ubb-pulse 1.6s ease-in-out infinite; }
    .veil { position: absolute; inset: 0; pointer-events: auto; cursor: not-allowed; background: rgba(99,102,241,.05); }
    .pill {
      position: absolute; top: 10px; left: 50%; transform: translateX(-50%);
      display: flex; align-items: center; gap: 10px;
      background: rgba(30,27,75,.92); color: #e0e7ff;
      border: 1px solid rgba(129,140,248,.6); border-radius: 999px;
      padding: 7px 8px 7px 16px; font-size: 12.5px; line-height: 1;
      pointer-events: auto; user-select: none;
    }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: #818cf8; animation: ubb-blink 1s infinite; }
    @keyframes ubb-blink { 50% { opacity: .25; } }
    button.stop {
      all: unset; pointer-events: auto; cursor: pointer;
      background: #ef4444; color: #fff; border-radius: 999px;
      padding: 6px 14px; font-size: 12px; font-weight: 600;
    }
    button.stop:hover { background: #dc2626; }
    .confirm {
      position: absolute; inset: 0; pointer-events: auto; background: rgba(15,12,40,.45);
      display: flex; align-items: center; justify-content: center;
    }
    .card {
      background: #fff; color: #111827; border-radius: 14px; padding: 22px 26px;
      max-width: 440px; box-shadow: 0 24px 60px rgba(0,0,0,.35); font-size: 14px;
    }
    .card h3 { margin: 0 0 8px; font-size: 16px; }
    .card p { margin: 0 0 16px; color: #4b5563; }
    .card .btns { display: flex; gap: 10px; justify-content: flex-end; }
    .card button { all: unset; cursor: pointer; border-radius: 8px; padding: 8px 18px; font-size: 13px; font-weight: 600; }
    .card .allow { background: #4f46e5; color: #fff; }
    .card .deny { background: #e5e7eb; color: #374151; }
    .count { color: #6b7280; font-size: 12px; margin-left: 10px; }
  `;

  function build() {
    host = document.createElement('div');
    host.className = 'ubb-host-root';
    const root = host.attachShadow({ mode: 'open' });
    style = document.createElement('style');
    style.textContent = CSS;
    root.appendChild(style);

    const hostEl = document.createElement('div');
    hostEl.className = 'host';
    root.appendChild(hostEl);

    const frame = document.createElement('div');
    frame.className = 'frame';
    hostEl.appendChild(frame);

    veil = document.createElement('div');
    veil.className = 'veil';
    hostEl.appendChild(veil);

    pill = document.createElement('div');
    pill.className = 'pill';
    const dot = document.createElement('span');
    dot.className = 'dot';
    pillLabel = document.createElement('span');
    pillLabel.textContent = label;
    const stop = document.createElement('button');
    stop.className = 'stop';
    stop.textContent = '■ 停止代理';
    stop.addEventListener('click', () => {
      try {
        chrome.runtime.sendMessage({ type: 'UBB_INTERRUPT' });
      } catch {}
      // instant local relief: stop blocking until background re-arms
      mode = 'paused';
      apply();
    });
    pill.append(dot, pillLabel, stop);
    hostEl.appendChild(pill);

    host.style.display = 'none';
    (document.documentElement || document.body).appendChild(host);
    apply();
  }

  function apply() {
    if (!host) return;
    const show = (mode === 'armed' || mode === 'paused') && visible;
    host.style.display = show ? '' : 'none';
    if (pillLabel) {
      pillLabel.textContent =
        mode === 'paused'
          ? '⏸ 用户已接管 · 可自由操作'
          : `${label}（代理操作中，点击被忽略）`;
    }
    if (veil) {
      // pointer-events toggling is invisible; the tint NEVER changes with
      // pass state, so the shield does not flicker during agent operations
      const blocking = mode === 'armed' && blockMode === 'block' && !pass;
      veil.style.pointerEvents = blocking ? 'auto' : 'none';
      veil.style.background = 'rgba(99,102,241,.05)';
    }
  }

  function stateOf() {
    return { mode, blockMode, visible, pass, veil_pointer_events: veil ? veil.style.pointerEvents : null };
  }

  function blockingKeys() {
    return mode === 'armed' && blockMode === 'block' && !pass && visible;
  }

  // Keyboard/context-menu blocking at capture phase. CDP-injected key events
  // are indistinguishable from real ones in-page, so the background flips
  // `pass` on before each agent input burst (UBB_PASS) — exactly like the
  // QwenWork HIDE_FOR_TOOL_USE gate.
  for (const type of ['keydown', 'keyup', 'keypress']) {
    window.addEventListener(
      type,
      (e) => {
        if (blockingKeys()) {
          e.preventDefault();
          e.stopImmediatePropagation();
        }
      },
      true,
    );
  }
  window.addEventListener(
    'contextmenu',
    (e) => {
      if (blockingKeys()) e.preventDefault();
    },
    true,
  );
  // wheel/touch DEFAULT ACTIONS (page scroll, pinch zoom) are not stopped by
  // the veil's pointer-events — they must be prevented explicitly (passive off)
  for (const type of ['wheel', 'touchstart', 'touchmove']) {
    window.addEventListener(
      type,
      (e) => {
        if (blockingKeys()) {
          e.preventDefault();
          e.stopImmediatePropagation();
        }
      },
      { capture: true, passive: false },
    );
  }
  // middle-click autoscroll / drag-select also die on the veil, but make sure
  window.addEventListener(
    'mousedown',
    (e) => {
      if (blockingKeys() && e.button !== 0) e.preventDefault();
    },
    true,
  );

  function showConfirm({ reqId, title, timeoutMs }) {
    if (!host) build();
    const root = host.shadowRoot;
    const overlay = document.createElement('div');
    overlay.className = 'confirm';
    const card = document.createElement('div');
    card.className = 'card';
    const h = document.createElement('h3');
    h.textContent = title || 'UBB 请求确认';
    const p = document.createElement('p');
    p.textContent = '如果你同意，此标签页将并入 UBB 分组并接受代理控制；不同意则保持现状。';
    const btns = document.createElement('div');
    btns.className = 'btns';
    const deny = document.createElement('button');
    deny.className = 'deny';
    deny.textContent = '拒绝';
    const allow = document.createElement('button');
    allow.className = 'allow';
    allow.textContent = '允许';
    const count = document.createElement('span');
    count.className = 'count';
    btns.append(count, deny, allow);
    card.append(h, p, btns);
    overlay.appendChild(card);
    root.querySelector('.host').appendChild(overlay);

    const t0 = Date.now();
    const tick = setInterval(() => {
      const left = Math.max(0, Math.ceil((timeoutMs - (Date.now() - t0)) / 1000));
      count.textContent = `${left}s`;
      if (left <= 0) finish(false);
    }, 500);
    function finish(ok) {
      clearInterval(tick);
      overlay.remove();
      try {
        chrome.runtime.sendMessage({ type: 'UBB_CONFIRM_RESULT', reqId, ok });
      } catch {}
    }
    deny.addEventListener('click', () => finish(false));
    allow.addEventListener('click', () => finish(true));
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) finish(false);
    });
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'UBB_SHIELD') {
      mode = msg.mode || 'off';
      if (msg.label) label = msg.label;
      if (msg.blockMode) blockMode = msg.blockMode;
      if (!host && mode !== 'off') build();
      apply();
      sendResponse({ ok: true, state: stateOf() });
    } else if (msg.type === 'UBB_SHIELD_QUERY') {
      sendResponse({ ok: true, state: stateOf() });
    } else if (msg.type === 'UBB_PASS') {
      pass = !!msg.on;
      apply();
      sendResponse({ ok: true, pass });
    } else if (msg.type === 'UBB_VISIBLE') {
      visible = !!msg.on;
      apply();
      sendResponse({ ok: true });
    } else if (msg.type === 'UBB_CONFIRM') {
      showConfirm(msg);
      sendResponse({ ok: true });
    }
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', build, { once: true });
  } else {
    build();
  }
})();
