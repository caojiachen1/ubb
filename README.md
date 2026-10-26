# UBB — Universal Browser Bridge

A browser extension that lets any AI agent (CLI tools, scripts, coding assistants) control the user's real, logged-in browser: open pages, click, fill forms, scrape content, take screenshots, watch console/network — through a local daemon over an authenticated WebSocket.

## Key features

- **83 tools**: navigation, interaction (ref / CSS selector / coordinates), accessibility-tree snapshots (paginated, hover-probing), screenshots (viewport / element / full page), structured table/list extraction, site-aware page rules (github / zhihu / juejin / wechat / xiaohongshu / x.com), user-action recording, pull-mode live screencast, console & network capture, whitelisted raw CDP, performance tracing, emulation, batch content fetch, clipboard, history, human-assistance requests, audit trail.
- **Session = tab group**: agent tabs are auto-grouped under a "⏳ UBB" tab group with status emoji. No separate window. Taking over an existing tab requires an on-page Allow/Deny banner (60s, default deny).
- **Shield on controlled tabs**: pulsing border + input blocking (clicks, keys, wheel, touch) with a one-click "Stop agent" interrupt. Hidden automatically during screenshots.
- **Security by default**: token-authenticated loopback WebSocket (extension dials out only — it never listens), password/OTP/payment fields are never auto-filled, destructive actions require explicit `confirm:true`, results are redacted (passwords, tokens, cookies, sensitive URL params), in-memory audit trail.
- **Experimental human mode** (default off): bezier mouse paths with jitter and dwell, per-key typing cadence with occasional typo+backspace, chunked scrolling.
- **Zero dependencies, zero telemetry**: the daemon is a single Node.js file; nothing is sent anywhere except to your own local daemon.

## Architecture

```
AI agent (any process)
  ⇅ newline-delimited JSON-RPC over stdio, or WebSocket
ubb-bridge.mjs (daemon, 127.0.0.1, token auth)
  ⇅ ws://127.0.0.1:<port>/  — extension connects out, never listens
UBB extension (MV3 service worker)
  ├─ chrome.debugger (CDP) — page control
  ├─ content scripts — shield, page bridge, foreign-frame monitor
  └─ offscreen document — clipboard
```

## Install

See [INSTALL.md](INSTALL.md). Summary:

1. Load the unpacked extension from this folder (`chrome://extensions` → Developer mode → Load unpacked).
2. Copy the pairing token from the extension popup.
3. Start the daemon: `node daemon/ubb-bridge.mjs --port 8765 --token <token>`
4. Verify: `node daemon/ubb.mjs status` → `"extension": true`

## Quick start

```bash
UBB="daemon/ubb.mjs"   # Node ≥ 18
node "$UBB" list                          # tool catalog
node "$UBB" tab.create '{"url":"example.com"}'
node "$UBB" snapshot                      # accessibility tree with @eN refs
node "$UBB" click '{"ref":"@e3"}'
node "$UBB" screenshot --out shot.png
node "$UBB" session.stop
```

Any agent that can spawn a process can use it: pipe JSON-RPC lines to the daemon's stdin, or connect as a WebSocket agent (`ubb-agent.<token>` subprotocol).

## Tools (83)

- **Session / tabs**: session.start/stop/status/name · tab.list/create/close/select/claim/release/mark · request_help (human-in-the-loop with completion conditions) · window.minimize/restore/state · resize_window · history.list
- **Navigation**: navigate · go_back · go_forward · reload
- **Interaction**: click (ref/selector/coords) · hover · fill · fill_form · form.set · type · press_key · scroll · drag · upload_file · download · download.status/path · ax.action · clipboard.read\*/clipboard.write · webmcp.list/invoke\*
- **Sensing**: snapshot (next_cursor pagination · probe_hover for hover menus) · read_page · read_site (site-aware extraction) · extract (table/list → JSON/CSV with coverage) · get_html · find · evaluate\* · wait_for · element.info · locator.count · element.visible/enabled/text/texts/attribute · tabs.content (batch) · export.gsuite · export.youtube
- **Capture**: screenshot (viewport/element/full_page) · screencast.start/next/stop · record_start/record_status/record_stop (semantic user-action trace; survives navigation) · assets.list/bundle
- **Diagnostics**: console.list · network.list/get · dialog.status/handle · cdp.call\* · cdp.events · perf.start/stop · bot.report · audit.list · emulate/emulate.reset
- **Experimental**: human.status / human.set\* (default off)

\* = gated: `confirm:true` required (evaluate & webmcp.invoke in MAIN world, clipboard.read, cdp.call write class, dangerous labels, human.set).

Ref discipline: refs (`@eN`) come from `snapshot` and stay valid across snapshots and across `next_cursor` pages of the same capture; navigation invalidates them (`REF_UNKNOWN`) — take a fresh snapshot. Large pages return `next_cursor` instead of silently truncating.

## Configuration

| Item | Where | Default |
|---|---|---|
| Pairing token | popup (view / paste / regenerate) | random 64-hex |
| Daemon port | popup / `--port` / `UBB_PORT` | 8765 |
| Shield mode | popup | border + block input |
| Human mode | popup / `human.set` | off |

Daemon CLI: `node daemon/ubb.mjs status|list|<tool> '<json>'` (auto-starts the daemon), `node daemon/ubb.mjs daemon start|stop`, `config token|port`.

## Error codes (common)

`EXTENSION_NOT_CONNECTED` · `NO_SESSION` · `TAB_NOT_OWNED` (claim first) · `REF_UNKNOWN` (re-snapshot) · `SENSITIVE_FIELD` (never auto-filled) · `NEEDS_CONFIRM` (retry with `confirm:true`) · `URL_BLOCKED` (chrome:// etc.) · `DEBUGGER_CONFLICT` (DevTools open) · `TOOL_TIMEOUT` · `CDP_TIMEOUT` (renderer stopped answering a CDP command, 45s cap) · `CDP_DETACHED` (debugger lost mid-command; next command re-attaches)

## Notes & limits

- Restricted pages (`chrome://`, `edge://`, extension store) are blocked by design.
- Service-worker restarts and daemon kills self-heal (session state survives via `chrome.storage.session`; refs do not survive browser restarts).
- `export.youtube` may be blocked by YouTube's caption enforcement without a logged-in profile; `export.gsuite` requires the user's Google login.
- HTML5 drag & drop lands more reliably with human mode enabled.
