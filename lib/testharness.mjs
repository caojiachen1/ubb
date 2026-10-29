// Offline registry harness — runs lib/ tool modules in Node with a minimal
// chrome stub so tool registration can be verified without a browser
// (_scratch/AGENT-CONTRACT.md §6.2). Not loaded by the extension.
// Keys here cover lib/tools.js + lib/actions.js; add the key your module needs
// when — and only when — a test actually fails without it.

const evt = () => ({ addListener() {}, removeListener() {} });
const stubStore = () => ({ get: async () => ({}), set: async () => {}, remove: async () => {} });

// ---- CDP command parameter contract ----------------------------------------
// The live -32602 disaster (Runtime.callFunctionOn fed a backendNodeId that
// the command does not accept; CDP drops unknown keys, every identifier
// arrives empty, all ref paths die on a real browser while 1065 offline
// assertions stay green): a stub that ignores the parameter shape lets
// invented APIs through. validateCdpParams throws on ANY key outside the
// real protocol surface for the commands listed below; makeCdpGate adds the
// one documented ordering rule of this Edge build: DOM.resolveNode/push are
// rejected with "Document needs to be requested first" until a
// DOM.getDocument has run for the tab.
// Parameter lists follow devtools-protocol 0.0.1727723 (current Chromium).
// The two Page.printToPDF tail-params at the end (displayTags/tagSelection)
// are NOT in the published schema but are real Chromium-side params (DevTools
// "print with visible tags"); flagged for live re-verification, everything
// else below is verbatim protocol surface.
export const CDP_PARAM_CONTRACT = {
  'Accessibility.getFullAXTree': ['depth', 'frameId'],
  'DOM.describeNode': ['nodeId', 'backendNodeId', 'objectId', 'depth', 'pierce'],
  'DOM.disable': [],
  'DOM.enable': [],
  'DOM.focus': ['nodeId', 'backendNodeId', 'objectId'],
  'DOM.getAttributes': ['nodeId'],
  'DOM.getBoxModel': ['nodeId', 'backendNodeId', 'objectId'],
  'DOM.getFrameOwner': ['frameId'],
  'DOM.getDocument': ['depth', 'pierce'],
  'DOM.getFlattenedDocument': ['depth', 'pierce'],
  'DOM.pushNodesByBackendIdsToFrontend': ['backendNodeIds'],
  'DOM.querySelector': ['nodeId', 'selector'],
  'DOM.querySelectorAll': ['nodeId', 'selector'],
  'DOM.releaseNode': ['nodeId'],
  'DOM.removeNode': ['nodeId'],
  'DOM.resolveNode': ['nodeId', 'backendNodeId', 'objectGroup', 'executionContextId'],
  'DOM.scrollIntoViewIfNeeded': ['nodeId', 'backendNodeId', 'objectId', 'rect'],
  'DOM.setFileInputFiles': ['files', 'nodeId', 'backendNodeId', 'objectId'],
  'Input.dispatchDragEvent': ['type', 'x', 'y', 'data', 'modifiers'],
  'Input.dispatchKeyEvent': ['type', 'modifiers', 'timestamp', 'text', 'unmodifiedText', 'keyIdentifier', 'code', 'key', 'windowsVirtualKeyCode', 'nativeVirtualKeyCode', 'autoRepeat', 'isKeypad', 'isSystemKey', 'location', 'commands'],
  'Input.dispatchMouseEvent': ['type', 'x', 'y', 'modifiers', 'timestamp', 'button', 'buttons', 'clickCount', 'force', 'tangentialPressure', 'tiltX', 'tiltY', 'twist', 'deltaX', 'deltaY', 'pointerType'],
  'Input.dispatchTouchEvent': ['type', 'touchPoints', 'modifiers', 'timestamp'],
  'Input.insertText': ['text'],
  'Log.enable': [],
  'Network.enable': [],
  'Page.captureScreenshot': ['format', 'quality', 'clip', 'fromSurface', 'captureBeyondViewport', 'optimizeForSpeed'],
  'Page.createIsolatedWorld': ['frameId', 'worldName', 'grantUniveralAccess', 'contentSecurityPolicy'],
  'Page.disable': [],
  'Page.enable': [],
  'Page.getFrameTree': [],
  'Page.handleJavaScriptDialog': ['accept', 'promptText'],
  'Page.navigate': ['url', 'referrer', 'transitionType', 'frameId', 'referrerPolicy'],
  'Page.printToPDF': ['landscape', 'displayHeaderFooter', 'printBackground', 'scale', 'paperWidth', 'paperHeight', 'marginTop', 'marginBottom', 'marginLeft', 'marginRight', 'pageRanges', 'headerTemplate', 'footerTemplate', 'preferCSSPageSize', 'transferMode', 'generateTaggedPDF', 'generateDocumentOutline', 'displayTags', 'tagSelection'],
  'Page.reload': ['ignoreCache', 'scriptToEvaluateOnLoad', 'loaderId'],
  'Page.setInterceptFileChooserDialog': ['enabled'],
  'Page.startScreencast': ['format', 'quality', 'maxWidth', 'maxHeight', 'everyNthFrame', 'maxFramesInFlight', 'sendLastFrame'],
  'Page.stopScreencast': [],
  'Runtime.disable': [],
  'Runtime.enable': [],
  'Runtime.callFunctionOn': ['functionDeclaration', 'objectId', 'arguments', 'silent', 'returnByValue', 'generatePreview', 'userGesture', 'awaitPromise', 'executionContextId', 'objectGroup', 'throwOnSideEffect', 'uniqueContextId', 'serializationOptions'],
  'Runtime.evaluate': ['expression', 'objectGroup', 'includeCommandLineAPI', 'silent', 'contextId', 'returnByValue', 'generatePreview', 'userGesture', 'awaitPromise', 'throwOnSideEffect', 'timeout', 'disableBreaks', 'replMode', 'allowUnsafeEvalBlockedByCSP', 'uniqueContextId', 'serializationOptions'],
  'Runtime.releaseObject': ['objectId'],
};

export function validateCdpParams(method, params = {}) {
  const allowed = CDP_PARAM_CONTRACT[method];
  if (!allowed) return;
  const unknown = Object.keys(params || {}).filter((k) => !allowed.includes(k));
  if (unknown.length) {
    throw new Error(
      `CDP_CONTRACT: ${method} has no parameter(s) ${unknown.join(', ')} (real params: ${allowed.join(', ') || 'none'}) — CDP silently DROPS unknown params, so this is exactly how an invented API reaches the wire and dies live`,
    );
  }
}

/**
 * Stateful stub-side protocol gate. check(tabId, method, params) validates the
 * parameter contract AND simulates this Edge build's ordering rule: any
 * DOM.resolveNode / DOM.pushNodesByBackendIdsToFrontend before the tab has had
 * a DOM.getDocument throws "Document needs to be requested first" (-32007).
 * attach(tabId) mirrors what lib/cdp.js does on debugger attach (it ends
 * _ensureNow with a DOM.getDocument).
 */
export function makeCdpGate() {
  const docSeen = new Set();
  return {
    attach(tabId) {
      docSeen.add(tabId);
    },
    forget(tabId) {
      docSeen.delete(tabId);
    },
    reset() {
      docSeen.clear();
    },
    check(tabId, method, params = {}) {
      validateCdpParams(method, params);
      if (method === 'DOM.getDocument') {
        docSeen.add(tabId);
        return;
      }
      if ((method === 'DOM.resolveNode' || method === 'DOM.pushNodesByBackendIdsToFrontend') && !docSeen.has(tabId)) {
        throw new Error('CDP_CONTRACT: -32007 Document needs to be requested first — a DOM.getDocument must precede DOM.resolveNode/push in this document generation');
      }
    },
  };
}

/**
 * ── fix17 DELIVERY MODEL ─────────────────────────────────────────────────────
 * The single reason 1648 offline assertions stayed green while a real browser
 * lied 20/20: our stubs treated `Input.dispatchMouseEvent` as if its ack WERE
 * its delivery, and content/shield.js never saw an event at all. This is the
 * missing piece of the wire — a queue, not a shortcut:
 *
 *   queue.ack(method, params)   resolves IMMEDIATELY (what Chrome does), and
 *                               schedules the event to be DELIVERED to the
 *                               document model `deliverMs` later;
 *   at delivery time           the model hit-tests the CURRENT veil state
 *                               (deliverMs > 0 is exactly how a gate that closed
 *                               on the ack ends up eating its own input), and
 *                               hands the event to the document, which records
 *                               {type, x, y, t, shield_hit}.
 *
 * `deliverMs` is a knob the test script owns (0 by default; a delay group sets
 * 5000 to reproduce the real machine). `hitTest(x, y)` returns the element the
 * browser would retarget the event to; the model flags a hit as `shield_hit`
 * through `isShield`, so the caller decides what "our own veil" means.
 * A command that is not an input command is simply acked.
 */
export const INPUT_DELIVERY_METHODS = {
  'Input.dispatchMouseEvent': (p) => ({ type: p.type, x: p.x, y: p.y }),
  'Input.dispatchKeyEvent': (p) => ({ type: p.type, x: null, y: null }),
  'Input.insertText': () => ({ type: 'insertText', x: null, y: null }),
  'Input.dispatchTouchEvent': (p) => ({ type: p.type, x: null, y: null }),
};

/** DOM event names the browser produces for a CDP input command. */
export function domEventType(method, type) {
  const t = String(type || '');
  if (method === 'Input.dispatchMouseEvent') {
    if (t === 'mousePressed') return 'mousedown';
    if (t === 'mouseReleased') return 'mouseup';
    if (t === 'mouseMoved') return 'mousemove';
    if (t === 'mouseWheel') return 'wheel';
    return t ? t.toLowerCase() : 'mousedown';
  }
  if (method === 'Input.dispatchKeyEvent') {
    if (t === 'keyDown') return 'keydown';
    if (t === 'keyUp') return 'keyup';
    if (t === 'char') return 'input';
    return t ? t.toLowerCase() : 'keydown';
  }
  if (method === 'Input.insertText') return 'input';
  if (method === 'Input.dispatchTouchEvent') return t === 'touchStart' ? 'touchstart' : 'touchmove';
  return null;
}

export function makeDeliveryModel({ deliverMs = 0, hitTest, isShield, dispatch, onAck, now = () => Date.now() } = {}) {
  const queue = [];
  const timers = new Set();
  let delay = Number.isFinite(deliverMs) ? deliverMs : 0;
  const model = {
    get deliverMs() {
      return delay;
    },
    setDeliverMs(ms) {
      delay = Number.isFinite(ms) && ms >= 0 ? ms : 0;
    },
    /** the commands that reached the wire, in order, with WHEN they were acked
     *  and WHEN they were delivered — the timing assertion ("release must come
     *  after delivery") reads these fields, not a sleep. */
    wire: queue,
    pending: () => queue.filter((q) => !q.delivered).length,
    /** ack fast, deliver late: returns the value a real CDP client gets back. */
    async ack(method, params = {}) {
      const shape = INPUT_DELIVERY_METHODS[method];
      if (onAck) onAck(method, params);
      if (!shape) return {};
      const info = shape(params);
      const item = {
        method,
        params,
        type: domEventType(method, info.type),
        x: info.x,
        y: info.y,
        acked_at: now(),
        delivered_at: null,
        delivered: false,
        shield_hit: null,
      };
      queue.push(item);
      let t = null;
      const land = () => {
        if (t !== null) timers.delete(t);
        item.delivered_at = now();
        item.delivered = true;
        const target = hitTest ? hitTest(item.x, item.y, item) : null;
        item.shield_hit = isShield ? !!isShield(target, item) : false;
        if (dispatch) dispatch(item, target);
      };
      if (delay > 0) {
        t = setTimeout(land, delay);
        timers.add(t);
      } else land(); // delay 0 = the model the suites had before, kept deterministic
      return {};
    },
    /** flush every scheduled delivery without waiting (teardown helper) */
    flush() {
      for (const t of [...timers]) {
        clearTimeout(t);
        timers.delete(t);
      }
      for (const item of queue) {
        if (item.delivered) continue;
        item.delivered_at = now();
        item.delivered = true;
        const target = hitTest ? hitTest(item.x, item.y, item) : null;
        item.shield_hit = isShield ? !!isShield(target, item) : false;
        if (dispatch) dispatch(item, target);
      }
      return queue.length;
    },
    /** forget the schedule (a test that is done with a page) */
    cancel() {
      for (const t of timers) clearTimeout(t);
      timers.clear();
    },
  };
  return model;
}

/**
 * Install (once) the smallest chrome surface the tool modules touch.
 * The default debugger stub validates every command against the parameter
 * contract, so suites that never patch CDP still cannot send invented keys.
 */
export function installChromeStub() {
  if (globalThis.chrome) return globalThis.chrome;
  const tab = { id: 1, windowId: 1, url: 'about:blank', title: 'offline stub', status: 'complete', active: true, groupId: -1 };
  const defaultGate = makeCdpGate();
  globalThis.chrome = {
    runtime: {
      id: 'ubb-offline-harness',
      getManifest: () => ({ version: '0' }),
      sendMessage: async () => ({}),
      onMessage: evt(),
      onMessageExternal: evt(),
    },
    tabs: {
      query: async () => [tab],
      get: async (id) => ({ ...tab, id }),
      create: async () => tab,
      update: async () => tab,
      remove: async () => {},
      reload: async () => {},
      sendMessage: async () => ({}),
      group: async () => 7,
      ungroup: async () => {},
      onRemoved: evt(),
    },
    windows: {
      get: async () => ({ id: 1, focused: true, state: 'normal' }),
      update: async () => ({}),
      create: async () => ({ id: 1, tabs: [tab] }),
      getAll: async () => [{ id: 1, focused: true }],
      remove: async () => {},
    },
    tabGroups: { query: async () => [], get: async () => ({ id: 7 }), update: async () => ({}) },
    storage: { local: stubStore(), session: stubStore() },
    debugger: {
      attach: async () => {},
      detach: async () => {},
      sendCommand: async ({ tabId } = {}, method, params = {}) => {
        defaultGate.check(tabId, method, params);
        return {};
      },
      onEvent: evt(),
      onDetach: evt(),
    },
    downloads: { download: async () => 1, search: async () => [], onChanged: evt() },
    history: { search: async () => [] },
    management: { getAll: async () => [] },
    webNavigation: { onCompleted: evt() },
    alarms: { create: () => {}, onAlarm: evt() },
    offscreen: { hasDocument: async () => true, createDocument: async () => {} },
  };
  return globalThis.chrome;
}

/**
 * Register the whole tool surface into a fake dispatcher.
 * Returns { names, metas, tools, call } — `call(name, params)` runs a tool
 * without timeouts/cancellation, exactly as the dispatcher would invoke it.
 */
export async function collectRegistry() {
  installChromeStub();
  const { registerTools } = await import('./tools.js');
  const { registerExtras } = await import('./tools-extra.js');
  const tools = new Map();
  const dispatcher = { register: (name, meta, fn) => tools.set(name, { meta, fn }) };
  registerTools(dispatcher);
  registerExtras(dispatcher);
  return {
    names: [...tools.keys()],
    metas: Object.fromEntries([...tools].map(([name, e]) => [name, e.meta])),
    tools,
    call: (name, params = {}) => tools.get(name).fn(params),
  };
}
