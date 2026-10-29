// Curated ubb_* tool definitions (Wave 0 baseline catalog). `ubb_call` still reaches the
// full extension catalog, so new tools need not appear here; the sibling *.mjs files in
// this directory own the curated entries of their own feature.
import { s, TAB_ID } from './schema.mjs';

export const CORE_TOOLS = [
  {
    name: 'ubb_session_start',
    description: 'Start an agent session. Default: agent tabs are auto-grouped into the "⏳ UBB" tab group in the user\'s window, opening silently in the background. own_window:true creates a DEDICATED UNFOCUSED agent window instead (user is never disturbed); raise it with ubb_tab_select only when the page must be visible.',
    inputSchema: {
      type: 'object',
      properties: {
        own_window: s('boolean', 'Run all agent tabs in a dedicated unfocused window.'),
        name: s('string', 'Session label shown in the tab group.'),
      },
      additionalProperties: true,
    },
    ubb: 'session.start',
  },
  {
    name: 'ubb_session_stop',
    description: 'End the session: group turns ✅, agent-created tabs close, claimed tabs return to the user. Call this when the task is done.',
    inputSchema: {
      type: 'object',
      properties: { close_created: s('boolean', 'false keeps agent-created tabs open.') },
      additionalProperties: true,
    },
    ubb: 'session.stop',
  },
  {
    name: 'ubb_session_status',
    description: 'Active session info (also confirms the daemon/extension link).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: true },
    ubb: 'session.status',
  },
  {
    name: 'ubb_tab_list',
    description: 'List tabs. scope "user" lists the user\'s own tabs (take one over with ubb_tab_claim); scope "session" lists session tabs.',
    inputSchema: {
      type: 'object',
      properties: { scope: s('string', '"session" (default) or "user".') },
      additionalProperties: true,
    },
    ubb: 'tab.list',
  },
  {
    name: 'ubb_tab_create',
    description: 'Create a tab inside the UBB group (auto-starts a session if needed). Opens SILENTLY in the background and WAITS for the page to finish loading before returning (loaded flag; cap with timeout_ms, default 20s) — safe to snapshot right after. Pass active:true only for pages that must be visible (CSS hover menus, video).',
    inputSchema: {
      type: 'object',
      properties: {
        url: s('string', 'URL; scheme optional ("example.com" is fine).'),
        active: s('boolean', 'Bring the new tab to front.'),
        timeout_ms: s('number', 'Load-wait cap (default 20000).'),
      },
      required: ['url'],
      additionalProperties: true,
    },
    ubb: 'tab.create',
  },
  {
    name: 'ubb_tab_close',
    description: 'Close a session-owned tab.',
    inputSchema: { type: 'object', properties: { tab_id: s('number', 'Tab to close.') }, required: ['tab_id'], additionalProperties: true },
    ubb: 'tab.close',
  },
  {
    name: 'ubb_tab_select',
    description: 'Bring a session tab (+ its window) to front. Only needed for visibility-dependent work: CSS :hover menus, live screencast of animated pages, lazy-load-dependent extraction.',
    inputSchema: { type: 'object', properties: { tab_id: s('number', 'Tab to raise.') }, required: ['tab_id'], additionalProperties: true },
    ubb: 'tab.select',
  },
  {
    name: 'ubb_tab_claim',
    description: 'Take over a tab the user opened (from ubb_tab_list scope:"user"). An on-page banner appears and the USER must click 允许 within 60s (default deny). Never work around a denied claim.',
    inputSchema: { type: 'object', properties: { tab_id: s('number', 'User tab to claim.') }, required: ['tab_id'], additionalProperties: true },
    ubb: 'tab.claim',
  },
  {
    name: 'ubb_tab_release',
    description: 'Release a claimed tab back to the user.',
    inputSchema: { type: 'object', properties: { tab_id: s('number', 'Claimed tab to release.') }, additionalProperties: true },
    ubb: 'tab.release',
  },
  {
    name: 'ubb_navigate',
    description: 'Navigate the target tab. Auto-prepends https://. chrome://, edge:// and extension-store pages are blocked.',
    inputSchema: {
      type: 'object',
      properties: { url: s('string', 'Destination URL.'), ...Object.fromEntries([TAB_ID]) },
      required: ['url'],
      additionalProperties: true,
    },
    ubb: 'navigate',
  },
  {
    name: 'ubb_reload',
    description: 'Reload the target tab.',
    inputSchema: { type: 'object', properties: { ...Object.fromEntries([TAB_ID]) }, additionalProperties: true },
    ubb: 'reload',
  },
  {
    name: 'ubb_snapshot',
    description: 'Accessibility-tree snapshot with @eN refs — the ONLY source of refs for ubb_click/fill/hover/upload_file. Refs survive across snapshots of one capture; navigation invalidates them (REF_UNKNOWN → take a fresh snapshot). Large pages return next_cursor: pass it back to read more of the SAME capture (refs stay valid within one capture). probe_hover reveals a collapsed hover menu: hover the trigger, then use the revealed items\' refs (CSS :hover needs a visible window).',
    inputSchema: {
      type: 'object',
      properties: {
        tab_id: s('number', 'Session tab.'),
        filter: s('string', '"interactive" (default) or "all".'),
        max_chars: s('number', 'Truncation budget (default 60000).'),
        cursor: s('string', 'next_cursor from a previous snapshot of the same capture.'),
        probe_hover: s('string', '"@eN" of a collapsed submenu trigger to reveal.'),
      },
      additionalProperties: true,
    },
    ubb: 'snapshot',
  },
  {
    name: 'ubb_read_page',
    description: 'Main-content plain text of the page (article/main heuristics).',
    inputSchema: {
      type: 'object',
      properties: { max_chars: s('number', 'Text budget (default 50000).'), ...Object.fromEntries([TAB_ID]) },
      additionalProperties: true,
    },
    ubb: 'read_page',
  },
  {
    name: 'ubb_find',
    description: 'Keyword search over visible elements; returns matches with @eN refs where possible. Handy when the snapshot is unclear.',
    inputSchema: {
      type: 'object',
      properties: { query: s('string', 'Text to find.'), limit: s('number', 'Max matches (default 10).'), ...Object.fromEntries([TAB_ID]) },
      required: ['query'],
      additionalProperties: true,
    },
    ubb: 'find',
  },
  {
    name: 'ubb_click',
    description: 'Click an element by @eN ref (preferred), a CSS selector, or x/y coordinates. Destructive/paid labels (删除/支付/purchase/delete…) require confirm:true AFTER asking the user.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: s('string', '"@eN" from ubb_snapshot.'),
        selector: s('string', 'CSS selector alternative.'),
        x: s('number', 'Viewport x (with y, for coordinate clicks).'),
        y: s('number', 'Viewport y.'),
        double: s('boolean', 'Double click.'),
        confirm: s('boolean', 'Required for destructive/paid labels, after asking the user.'),
        ...Object.fromEntries([TAB_ID]),
      },
      additionalProperties: true,
    },
    ubb: 'click',
  },
  {
    name: 'ubb_fill',
    description: 'Set a form field value by @eN ref (React/Vue-safe; REPLACES existing text). Password/OTP/payment fields are ALWAYS refused — ask the user to type those. press_enter:true submits, but pressing the page\'s submit button via ubb_click is more reliable on custom UIs.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: s('string', '"@eN" from ubb_snapshot.'),
        value: s('string', 'Value to set.'),
        selector: s('string', 'CSS selector alternative.'),
        press_enter: s('boolean', 'Press Enter after filling.'),
        ...Object.fromEntries([TAB_ID]),
      },
      required: ['value'],
      additionalProperties: true,
    },
    ubb: 'fill',
  },
  {
    name: 'ubb_fill_form',
    description: 'Batch fill several fields: values = { "@e2": "Alice", "@e5": "hi@x.com" }. Sensitive fields are refused individually.',
    inputSchema: {
      type: 'object',
      properties: { values: s('object', 'Map of ref → value.'), ...Object.fromEntries([TAB_ID]) },
      required: ['values'],
      additionalProperties: true,
    },
    ubb: 'fill_form',
  },
  {
    name: 'ubb_type',
    description: 'Type text into the currently focused element (after a click), optionally pressing Enter.',
    inputSchema: {
      type: 'object',
      properties: { text: s('string', 'Text to type.'), press_enter: s('boolean', 'Press Enter after.'), ...Object.fromEntries([TAB_ID]) },
      required: ['text'],
      additionalProperties: true,
    },
    ubb: 'type',
  },
  {
    name: 'ubb_press_key',
    description: 'Press a key with optional modifiers, e.g. key:"s" modifiers:["ctrl"].',
    inputSchema: {
      type: 'object',
      properties: {
        key: s('string', 'Key name, e.g. "Enter", "Escape", "ArrowDown".'),
        modifiers: { type: 'array', items: s('string', '"ctrl"|"alt"|"shift"|"meta".') },
        ...Object.fromEntries([TAB_ID]),
      },
      required: ['key'],
      additionalProperties: true,
    },
    ubb: 'press_key',
  },
  {
    name: 'ubb_scroll',
    description: 'Scroll the page (direction up|down, amount px, default 600); or pass ref to scroll that element into view instead.',
    inputSchema: {
      type: 'object',
      properties: {
        direction: s('string', '"up" or "down".'),
        amount: s('number', 'Pixels (default 600).'),
        ref: s('string', 'Element to scroll into view instead of page scroll.'),
        ...Object.fromEntries([TAB_ID]),
      },
      additionalProperties: true,
    },
    ubb: 'scroll',
  },
  {
    name: 'ubb_hover',
    description: 'Hover an element by @eN ref (real mouse move — triggers hover menus).',
    inputSchema: { type: 'object', properties: { ref: s('string', '"@eN".'), ...Object.fromEntries([TAB_ID]) }, required: ['ref'], additionalProperties: true },
    ubb: 'hover',
  },
  {
    name: 'ubb_upload_file',
    description: 'Set local files on a file input by @eN ref.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: s('string', '"@eN" of the <input type=file>.'),
        files: { type: 'array', items: s('string', 'Absolute local paths.') },
        ...Object.fromEntries([TAB_ID]),
      },
      required: ['ref', 'files'],
      additionalProperties: true,
    },
    ubb: 'upload_file',
  },
  {
    name: 'ubb_wait_for',
    description: 'Wait for a condition: text_present | text_gone | element_visible | element_hidden | url_contains | url_matches | navigation | network_idle | timeout. Use after actions to verify results instead of re-screenshotting.',
    inputSchema: {
      type: 'object',
      properties: {
        condition: s('string', 'One of the listed conditions.'),
        text: s('string', 'Text for text_present/text_gone.'),
        timeout_ms: s('number', 'Max wait (default 15000).'),
        ...Object.fromEntries([TAB_ID]),
      },
      required: ['condition'],
      additionalProperties: true,
    },
    ubb: 'wait_for',
  },
  {
    name: 'ubb_screenshot',
    description: 'Screenshot: viewport (default), element by ref, or full page. By default saves to a file and returns the path (token-friendly); pass inline:true to get the image embedded in the conversation instead.',
    inputSchema: {
      type: 'object',
      properties: {
        save_to: s('string', 'Absolute path for the PNG/JPEG (extension appended if missing). Default: ~/.ubb/shots/<timestamp>.<ext>.'),
        inline: s('boolean', 'Return the image as content instead of a file path.'),
        ref: s('string', '"@eN" to capture one element.'),
        full_page: s('boolean', 'Capture the whole scrollable page.'),
        format: s('string', '"png" (default) or "jpeg".'),
        quality: s('number', '1-100 for jpeg.'),
        ...Object.fromEntries([TAB_ID]),
      },
      additionalProperties: true,
    },
    ubb: 'screenshot',
    binary: true,
  },
  {
    name: 'ubb_extract',
    description: 'Extract a loaded table/list as structured JSON (format:"csv" adds a csv string). Table mode: {selector} over <table>. List mode: {item_selector, fields:[{key, selector, read:"text"|"href"|"attribute", attribute}], ":scope" reads the item itself}. Reads loaded DOM only — check coverage.truncated and warnings; never assume completeness.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: s('string', 'Table selector (table mode).'),
        item_selector: s('string', 'Row/item selector (list mode).'),
        fields: { type: 'array', description: 'List-mode field specs: {key, selector, read, attribute}.', items: { type: 'object' } },
        format: s('string', '"json" (default) or "csv".'),
        ...Object.fromEntries([TAB_ID]),
      },
      additionalProperties: true,
    },
    ubb: 'extract',
  },
  {
    name: 'ubb_console_list',
    description: 'Console messages captured since attach (only_errors filters to errors).',
    inputSchema: {
      type: 'object',
      properties: {
        only_errors: s('boolean', 'Errors only.'),
        pattern: s('string', 'Regex filter on message text.'),
        limit: s('number', 'Max messages (default 50).'),
        clear: s('boolean', 'Clear the buffer after reading.'),
        ...Object.fromEntries([TAB_ID]),
      },
      additionalProperties: true,
    },
    ubb: 'console.list',
  },
  {
    name: 'ubb_network_list',
    description: 'Network requests captured since attach (url_pattern regex filter). Pair with ubb_call {"tool":"network.get","params":{"request_id"}} for a response body.',
    inputSchema: {
      type: 'object',
      properties: {
        url_pattern: s('string', 'Regex on request URL.'),
        limit: s('number', 'Max entries (default 50).'),
        clear: s('boolean', 'Clear the buffer after reading.'),
        ...Object.fromEntries([TAB_ID]),
      },
      additionalProperties: true,
    },
    ubb: 'network.list',
  },
  {
    name: 'ubb_element_info',
    description: 'Inspect an @eN ref: tag, role, name, attributes, box — for ambiguous snapshot entries.',
    inputSchema: { type: 'object', properties: { ref: s('string', '"@eN".'), ...Object.fromEntries([TAB_ID]) }, required: ['ref'], additionalProperties: true },
    ubb: 'element.info',
  },
  {
    name: 'ubb_request_help',
    description: 'Ask the human to complete an in-page step (login / CAPTCHA / consent / payment). Shows a banner and raises the tab; completes when ALL conditions hold or the user clicks 完成. Outcomes: completed | cancelled | timed_out. After cancelled/timed_out do NOT repeat the same request.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: s('string', 'What the user should do (max 300 chars).'),
        conditions: {
          type: 'array',
          description: 'Completion checks, max 8, each with exactly one of: url_contains / url_matches / text_present / element_visible.',
          items: { type: 'object' },
        },
        timeout_ms: s('number', '5000-300000 (default 120000).'),
        ...Object.fromEntries([TAB_ID]),
      },
      required: ['prompt'],
      additionalProperties: true,
    },
    ubb: 'request_help',
  },
  {
    name: 'ubb_call',
    description: 'Run ANY other UBB tool by name — escape hatch for the full catalog of 83 tools (record_start, screencast, cdp.call, clipboard, history.list, emulate, …). Use "ubb list"-style dotted names ("console.list" or "console_list"). Prefer the dedicated ubb_* tools when one exists.',
    inputSchema: {
      type: 'object',
      properties: {
        tool: s('string', 'Catalog tool name, e.g. "screencast.start", "download.status", "history.list".'),
        params: s('object', 'Tool parameters (same JSON as the `ubb` CLI takes).'),
      },
      required: ['tool'],
    },
  },
];
