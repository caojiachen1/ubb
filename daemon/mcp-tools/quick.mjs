// Curated ubb_* definitions for the Wave 1-A quick-win tools. `ubb_call` still
// reaches every catalog tool; these four are the high-frequency ones.
import { s, TAB_ID } from './schema.mjs';

export const QUICK_TOOLS = [
  {
    name: 'ubb_dropdown_options',
    description:
      'List the options of a dropdown — the one thing a snapshot cannot show, because a closed <select> is not in the accessibility tree. Pass ref:"@eN" (from ubb_snapshot; this also works inside shadow DOM and iframes) or selector:"css" (light DOM only). Returns {tag, role, options:[{index,value,text,selected}], total, truncated} capped at 500 options. A custom ARIA combobox/listbox keeps its options out of the closed DOM: you get a note telling you to ubb_call ax.action {action:"expand"} and re-snapshot. Feed a returned value/text into ubb_call {"tool":"form.set","params":{"action":"select_option"}}.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: s('string', '"@eN" from ubb_snapshot — required for shadow-DOM controls.'),
        selector: s('string', 'CSS selector (light DOM only).'),
        ...Object.fromEntries([TAB_ID]),
      },
      additionalProperties: true,
    },
    ubb: 'dropdown_options',
  },
  {
    name: 'ubb_print_pdf',
    description:
      'Print the target tab to PDF (CDP Page.printToPDF). Units are CDP units: paper_width/paper_height in INCHES, margins in CM (a number applies to all four sides), scale 0.1-2, print_background defaults true. Returns {format:"pdf", bytes, data_base64, filename_suggested}; by default the adapter saves the PDF to ~/.ubb/shots/<timestamp>.pdf (pass save_to for a specific path, inline:true to get the base64). Above 3MB the base64 is dropped and you get {too_big:true, bytes, note} — nothing is saved; use the `ubb print_pdf --out <path>.pdf` CLI so the bytes never enter the conversation.',
    inputSchema: {
      type: 'object',
      properties: {
        landscape: s('boolean', 'Landscape orientation.'),
        scale: s('number', '0.1-2 (default 1).'),
        paper_width: s('number', 'Page width in inches (default: the browser default, 8.5).'),
        paper_height: s('number', 'Page height in inches (A4 = 11.69, Letter = 8.5).'),
        margins: { description: 'CM (CDP semantics): a number for all sides, or {top,bottom,left,right}.' },
        print_background: s('boolean', 'Include backgrounds/colors (default true).'),
        page_ranges: s('string', 'e.g. "1-3,5" — CDP pageRanges.'),
        tag_selection: { description: 'Advanced CDP tagSelection object (sent with displayTags:true).' },
        ...Object.fromEntries([TAB_ID]),
      },
      additionalProperties: true,
    },
    ubb: 'print_pdf',
    binary: true,
  },
  {
    name: 'ubb_search',
    description:
      'Open a search-engine results page in one call: engine ddg (default) | google | bing | baidu | sogou, query percent-encoded against a fixed URL table (a query that looks like a URL is opened as a page instead). Defaults to a NEW session tab that opens silently in the background and waits for load; pass new_tab:false to navigate the current target tab, active:true only if it must be visible. Returns {tab_id, url, title, engine, loaded} — the SERP markup is deliberately not parsed here: snapshot or ubb_read_page the result page instead.',
    inputSchema: {
      type: 'object',
      properties: {
        query: s('string', 'What to search for (max 1000 chars).'),
        engine: s('string', '"ddg" (default) | "google" | "bing" | "baidu" | "sogou".'),
        new_tab: s('boolean', 'false navigates the target tab instead of opening one (default true).'),
        active: s('boolean', 'Bring the new tab to front (default false).'),
        max_results: s('number', '1-100; applied only where the engine has a URL knob (google/bing/baidu).'),
        timeout_ms: s('number', 'Load-wait cap, 1000-60000 (default 20000).'),
        ...Object.fromEntries([TAB_ID]),
      },
      required: ['query'],
      additionalProperties: true,
    },
    ubb: 'search',
  },
  {
    name: 'ubb_batch',
    description:
      'Send up to 12 actions in ONE request: {actions:[{tool,params}], tab_id?}. Each step goes through the normal dispatcher, so per-tool timeouts, confirm gates, audit and redaction still apply — nothing is skipped. stop_on_error defaults to true (first failure stops the run; failed_at says which step). inherit_tab defaults to true and pins every tab-less step to one tab, which is the reliable way to keep a batch off the tab another agent touched last. batch itself, plus session.stop / tab.close / human.set, are refused. Returns {results:[{tool,ok,result|error}], executed, failed_at?}.',
    inputSchema: {
      type: 'object',
      properties: {
        actions: {
          type: 'array',
          description: '1-12 steps, each {tool:"dotted.name", params:{...}}.',
          items: { type: 'object' },
        },
        stop_on_error: s('boolean', 'Stop at the first failing step (default true).'),
        inherit_tab: s('boolean', 'Stamp the batch tab onto steps without tab_id (default true).'),
        ...Object.fromEntries([TAB_ID]),
      },
      required: ['actions'],
      additionalProperties: true,
    },
    ubb: 'batch',
  },
];
