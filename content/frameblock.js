// UBB frame-block: the input interceptor that reaches INTO iframes.
// Why this exists: the top-frame shield's veil swallows pointer events for
// whatever is under it (including iframe areas), but KEY events dispatch to the
// document that holds focus — and focus can sit inside a frame the agent just
// clicked. Without this script a user could type into an iframe form on a
// "controlled" tab, which contradicts the shield promise. Decision (Wave 2-D):
// interception must cover frames; borders/veils/pills must NOT (they would
// occlude each other and withHiddenShield only handles the top document).
//
// Rules: intercept-only — this file draws nothing and mutates nothing. It keeps
// one piece of state (mode/pass/help/blockMode), receives it through the same
// broadcast messages as the shield, and only ever calls preventDefault /
// stopImmediatePropagation on the way. Agent input is safe because CDP input
// events dispatch into the FOCUSED frame's own window chain (never the top
// window's listeners) and withPass()'s UBB_PASS broadcast reaches every frame
// before each agent input burst — the exact gate the top shield already uses.

(() => {
  if (window.__ubbFrameBlock) return;
  window.__ubbFrameBlock = true;
  if (window.top === window.self) return; // the top frame is shield.js's job

  let mode = 'off';
  let blockMode = 'block';
  let pass = false;
  let helpActive = false;

  const blocking = () => !helpActive && mode === 'armed' && blockMode === 'block' && !pass;

  for (const type of ['keydown', 'keyup', 'keypress']) {
    window.addEventListener(
      type,
      (e) => {
        if (blocking()) {
          e.preventDefault();
          e.stopImmediatePropagation();
        }
      },
      true,
    );
  }
  for (const type of ['wheel', 'touchstart', 'touchmove']) {
    window.addEventListener(
      type,
      (e) => {
        if (blocking()) {
          e.preventDefault();
          e.stopImmediatePropagation();
        }
      },
      { capture: true, passive: false },
    );
  }
  window.addEventListener(
    'contextmenu',
    (e) => {
      if (blocking()) e.preventDefault();
    },
    true,
  );
  // non-primary buttons (middle-click paste/autoscroll, back/forward gestures)
  window.addEventListener(
    'mousedown',
    (e) => {
      if (blocking() && e.button !== 0) e.preventDefault();
    },
    true,
  );

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || typeof msg !== 'object') return;
    // deliberately NEVER sendResponse: tabs.sendMessage without a frameId
    // broadcasts and the FIRST frame to respond wins the reply slot — the
    // shield-ctl callers must keep reading shield.js's (top-frame) state.
    switch (msg.type) {
      case 'UBB_SHIELD':
        mode = msg.mode || 'off';
        if (msg.blockMode) blockMode = msg.blockMode;
        if (msg.mode === 'off') helpActive = false;
        return;
      case 'UBB_PASS':
        pass = !!msg.on;
        return;
      case 'UBB_HELP':
        helpActive = true;
        return;
      case 'UBB_HELP_CLOSE':
        helpActive = false;
        return;
      default:
        return; // UBB_BRIDGE etc. belong to the bridge; ignore silently
    }
  });
})();
