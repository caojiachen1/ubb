# UBB Installation

Prerequisites: Chrome or Edge (v116+), Node.js ≥ 18. No npm install needed (zero dependencies).

## 1. Load the extension

1. Open `chrome://extensions` (or `edge://extensions`).
2. Enable **Developer mode** (bottom-left on Edge, top-right on Chrome).
3. Click **Load unpacked** and select this project folder (the one containing `manifest.json`).
4. Pin "UBB — Universal Browser Bridge" from the extensions menu if you want the toolbar icon.

## 2. Pair with the daemon

1. Click the UBB toolbar icon. The popup shows a **pairing token** (64 hex chars).
2. Start the daemon with that token:

```bash
node daemon/ubb-bridge.mjs --port 8765 --token <paste-token-here>
```

The popup should now show **connected**. (Alternative: run `node daemon/ubb.mjs config token <token>` first, then omit `--token`.)

## 3. Verify

```bash
node daemon/ubb.mjs status
# expect: "daemon": true, "extension": true
```

If `extension: false`, the popup token and the daemon token differ — fix with step 2. If the daemon is not running, this command auto-starts it.

## 4. First run

```bash
node daemon/ubb.mjs session.start
node daemon/ubb.mjs tab.create '{"url":"example.com"}'
node daemon/ubb.mjs snapshot
node daemon/ubb.mjs screenshot --out shot.png
node daemon/ubb.mjs session.stop
```

## For AI agents

Check for an existing setup before installing anything:

```bash
node daemon/ubb.mjs status        # extension:true → already installed, skip to use
```

If not installed, ask the user to do steps 1–2 (browser UI actions), then verify with `status`. Never load the extension or paste tokens on the user's behalf without asking.

Token and port resolve in this order: CLI flags → `UBB_TOKEN` / `UBB_PORT` env → `~/.ubb/config.json` (written by `ubb config token|port`).

## Daemon lifecycle

```bash
node daemon/ubb.mjs daemon start|stop|status
```

Any `ubb` tool call auto-starts the daemon if it is down. The extension reconnects automatically after browser restarts, extension reloads, or daemon restarts.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `extension: false` | Token mismatch — redo step 2; check the popup shows "connected" |
| `EXTENSION_NOT_CONNECTED` on calls | Browser closed, or extension not loaded — run `status` |
| `DEBUGGER_CONFLICT` | A DevTools window or another automation extension holds the tab |
| `TAB_NOT_OWNED` | Only session tabs are operable — create with `tab.create` or claim with `tab.claim` |
| `URL_BLOCKED` | Restricted page (chrome://, edge://, store) — by design |
| Daemon port conflict | Change the port in the popup and restart with the same `--port` |
