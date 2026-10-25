# UBB Installation

Prerequisites: Chrome or Edge (v116+). Three runtimes are available and they coexist:

| Runtime | Needs | When to use |
|---|---|---|
| **Rust CLI** (`bin/ubb.exe`) | nothing — single static binary | **default** — zero deps, instant start; ships in this repo, rebuild via `rust-cli/` |
| Node CLI | Node.js ≥ 18 (zero npm deps) | development — the extension tooling lives in JS, edits land with a reload |
| Web console (`console/index.html`) | any local static file server | browser-only control, zero processes |

The launchers `bin/ubb` (sh) and `bin/ubb.cmd` (cmd) run the Rust binary directly. The Node CLI (`node daemon/ubb.mjs`) takes the exact same commands and is interchangeable — use it when hacking on the extension tools.

## 1. Load the extension

1. Open `chrome://extensions` (or `edge://extensions`).
2. Enable **Developer mode** (bottom-left on Edge, top-right on Chrome).
3. Click **Load unpacked** and select this project folder (the one containing `manifest.json`).
4. Pin "UBB — Universal Browser Bridge" from the extensions menu if you want the toolbar icon.

## 2. Pair with the daemon

1. Click the UBB toolbar icon. The popup shows a **pairing token** (64 hex chars).
2. Start the daemon with that token:

```bash
node daemon/ubb.mjs config token <paste-token-here>   # saved to ~/.ubb/config.json
node daemon/ubb.mjs status                             # auto-starts the daemon
```

Equivalent without Node — the Rust binary is both client and daemon:

```bash
bin/ubb.exe config token <paste-token-here>
bin/ubb.exe status          # spawns `ubb.exe serve` (its own daemon) if none is running
```

The popup should now show **connected**.

## 3. Verify

```bash
node daemon/ubb.mjs status       # or: bin/ubb.exe status / bin/ubb status
# expect: "daemon": true, "extension": true
```

If `extension: false`, the popup token and the daemon token differ — fix with step 2. If the daemon is not running, this command auto-starts it (Node: `node daemon/ubb-bridge.mjs`; Rust: `ubb.exe serve`).

## 4. First run

```bash
node daemon/ubb.mjs session.start
node daemon/ubb.mjs tab.create '{"url":"example.com"}'
node daemon/ubb.mjs snapshot
node daemon/ubb.mjs screenshot --out shot.png
node daemon/ubb.mjs session.stop
```

## Web console (no daemon, no Node)

`console/index.html` drives UBB straight from a web page via the `externally_connectable` localhost channel — the page calls `chrome.runtime.sendMessage(EXT_ID, {type:'UBB_WEB_RPC', token, tool, params})` and the extension runs the tool.

1. Serve the folder over **http on loopback** (any port):
   `python -m http.server 8089 --directory console` or `npx serve console`
2. Open `http://127.0.0.1:8089/index.html`, paste the token, call tools from the buttons.
3. **Do not open the file via `file://`** — `chrome.runtime` is only injected on `http://localhost|127.0.0.1` origins; the page detects this and tells you.

Security: `externally_connectable.matches` admits `http://localhost/*` and `http://127.0.0.1/*` only, and every message must carry the daemon token (checked against the extension's stored token). Audit entries land as `web.rpc`.

## Rust CLI

`bin/ubb.exe` is a protocol-compatible single-binary rewrite of the CLI **and** the daemon (`ubb serve`). Source in `rust-cli/`:

```bash
cd rust-cli && cargo build --release   # → target/release/ubb.exe (~1 MB)
cp target/release/ubb.exe ../bin/ubb.exe
```

It speaks the same wire protocol (`ubb-auth.<token>` / `ubb-agent.<token>` subprotocols, `/health`, `/shutdown`), so Node and Rust daemons are interchangeable and the extension cannot tell them apart.

## For AI agents

Check for an existing setup before installing anything:

```bash
node daemon/ubb.mjs status        # extension:true → already installed, skip to use
```

If not installed, ask the user to do steps 1–2 (browser UI actions), then verify with `status`. Never load the extension or paste tokens on the user's behalf without asking.

Token and port resolve in this order: CLI flags → `UBB_TOKEN` / `UBB_PORT` env → `~/.ubb/config.json` (written by `ubb config token|port`).

## Daemon lifecycle

```bash
node daemon/ubb.mjs daemon start|stop|status     # Node daemon
bin/ubb.exe daemon start|stop|status             # Rust daemon
```

Any `ubb` tool call auto-starts the daemon if it is down. The extension reconnects automatically after browser restarts, extension reloads, or daemon restarts — including switches between the Node and Rust daemons.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `extension: false` | Token mismatch — redo step 2; check the popup shows "connected" |
| `EXTENSION_NOT_CONNECTED` on calls | Browser closed, or extension not loaded — run `status` |
| `DEBUGGER_CONFLICT` | A DevTools window or another automation extension holds the tab |
| `TAB_NOT_OWNED` | Only session tabs are operable — create with `tab.create` or claim with `tab.claim` |
| `URL_BLOCKED` | Restricted page (chrome://, edge://, store) — by design |
| Daemon port conflict | Change the port in the popup and restart with the same `--port` |
