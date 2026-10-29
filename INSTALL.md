# UBB Installation

Prerequisites: Chrome or Edge (v116+). Three runtimes are available and they coexist:

| Runtime | Needs | When to use |
|---|---|---|
| **Rust CLI** (`bin/ubb.exe`) | nothing — single static binary | **default** — zero deps, instant start; ships in this repo, rebuild via `rust-cli/` |
| Node CLI | Node.js ≥ 18 (zero npm deps) | fallback — only when the Rust CLI is not available; the extension tooling lives in JS, edits land with a reload |
| Web console (`console/index.html`) | any local static file server | browser-only control, zero processes |

The launchers `bin/ubb` (sh) and `bin/ubb.cmd` (cmd) run the Rust binary directly — prefer `ubb` (or `bin/ubb.exe`). The Node CLI (`node daemon/ubb.mjs`) takes the exact same commands, including the subcommands documented below; use it only when the Rust CLI is not found (e.g. hacking on the daemon before a rebuild). **The Rust binary is rebuilt from `rust-cli/` and may lag the Node CLI's newer subcommands** (`secret`, `audit`, `liveview`, `download`) — if `ubb <subcommand>` is unknown, run the Node form: `node daemon/ubb.mjs <subcommand>`.

## 1. Load the extension

1. Open `chrome://extensions` (or `edge://extensions`).
2. Enable **Developer mode** (bottom-left on Edge, top-right on Chrome).
3. Click **Load unpacked** and select this project folder (the one containing `manifest.json`).
4. Pin "UBB — Universal Browser Bridge" from the extensions menu if you want the toolbar icon.

After any edit to `lib/*`, `content/*`, `background.js` or `manifest.json`, press ↻ on the extension card — the service worker and the content scripts (`content/bridge.js` all frames, `content/frameblock.js` all frames, `content/shield.js` top frame only) restart with it. `content/site-rules.json` does **not** need this: see [Site rules](#5-site-rules-json-not-code).

Then prove the reload actually took, rather than assuming it: `ubb status` reports `extension_build`, which must equal the `BUILD` constant in `lib/config.js`. A click that does nothing, a `-32602`, or a `SECRET_FETCH_TIMEOUT` is more often "the process answering me is older than the code I just read" than a bug — and the extension is only half of it: **the daemon keeps its code in memory too**, so a daemon started days ago runs days-old logic no matter how fresh your checkout is.

## 2. Put `ubb` on PATH, pair automatically

```bash
bin/ubb install      # PATH + native pairing host registration (idempotent)
ubb status           # auto-starts the daemon; expect "extension": true
```

That's the whole setup — **no token copying**. `install` registers a native messaging host (`com.ubb.bridge`) pinned to this extension's id in the per-user registry (Edge + Chrome hives, no admin). At every extension startup the browser launches that host, the host answers with the config token (generating one on a fresh machine) and ensures the daemon is running — the extension auto-pairs, and if the token ever rotates it self-heals on the next service-worker start.

Manual override still works: `ubb config token <token>` (or `ubb config token` with no argument generates one) — the extension syncs from it on its next start. To uninstall, remove `D:\Codebase\ubb\bin` from your user PATH and delete the `HKCU\Software\Microsoft\Edge\NativeMessagingHosts\com.ubb.bridge` registry key.

## 3. Verify

```bash
ubb status       # auto-starts the daemon; expect "extension": true
# no `ubb` on PATH? bin/ubb.exe status — or the Node CLI: node daemon/ubb.mjs status
# expect: "daemon": true, "extension": true, "extension_build": "<BUILD from lib/config.js>"
# same proof straight from the daemon, no CLI at all:
curl -s http://127.0.0.1:8765/health   # → {"ok":true,"extension":true,"extension_build":"<BUILD>","agents":1}
```

To prove the extension really picked up the code you just edited (not *something* connected): `ubb status` **or** `curl http://127.0.0.1:8765/health` (port from `--port` / `UBB_PORT` / `~/.ubb/config.json`) must report `extension_build` **equal to the `BUILD` constant in `lib/config.js`** (this batch that is `2026.10.29-visible-gate`). `extension: true` on its own only ever proved *a socket is up*, never that it is *this* code. Both halves have to be restarted for the value to move: the **extension** via `chrome://extensions` ↻, the **daemon** by killing the old process — it keeps its code in memory, so a daemon that has been up since two days ago runs two-days-old logic no matter how fresh the checkout is. This batch lost a whole live round to exactly that: the extension was reloaded, the daemon was not, so the reverse-RPC branch was absent from the process actually answering (`SECRET_FETCH_TIMEOUT` instead of a fill). `extension_build` **missing** → stale daemon; **present but a different string** → extension never reloaded.

If `extension: false`, the popup token and the daemon token differ — fix with step 2. If the daemon is not running, this command auto-starts it (Rust: `ubb.exe serve`; Node: `node daemon/ubb-bridge.mjs`).

If `extension_build` is **missing from the output**, the daemon that is answering you predates this batch (check `~/.ubb/daemon.log`'s first line for its start time) — stop it (`ubb daemon stop`) and let the next call start the current code; extension-side fixes will not appear until you do, because the old process does not know the field exists. If it is present but **stale**, the extension was never reloaded (step 1's ↻). Note that the Rust `ubb.exe` may also lag the Node CLI's newer subcommands — `node daemon/ubb.mjs status` is the reference shape.

## 4. First run

```bash
ubb session.start
ubb tab.create '{"url":"example.com"}'
ubb snapshot
ubb screenshot --out shot.png
ubb session.stop
# Node fallback for every command above: node daemon/ubb.mjs <command>
```

## 5. Site rules: JSON, not code

Page extraction for github / zhihu / juejin / wechat / xiaohongshu / x.com lives in `content/site-rules.json` and is executed by the rule interpreter inside `content/bridge.js`. Adding or fixing a site is a **data change**: validate, store, reload — no code edit, no extension reload.

```bash
ubb site.rules.validate '{"rules":[{"id":"github","match":{"hosts":["github.com"]},"blocks":[…]}]}'
ubb site.rules.add '{"rules":[…],"confirm":true}'   # → chrome.storage.local key "ubbSiteRules"
ubb site.rules.reload                                # re-assemble the service-worker cache
ubb site.rules.list                                  # effective set, in match order (user | builtin)
```

User rules merge ahead of the built-ins and win on the same `id`. Anything executable in a rule (`eval`, `script`, `function`, `on*`, `html`, `url`, `src`, …) is refused by validation, so a rule can never become code. There is no `site.rules.remove` yet — overwrite the same `id`, or clear the storage key from the web console.

## 6. Credentials: store locally, name them to the agent

Only if you want the agent to submit logins for you. The value stays on your machine and never enters the conversation: `ubb secret add` reads it from **stdin**, so it does not land in your shell history either.

```bash
ubb secret add github_pw                      # paste/type the value, Ctrl-Z(Windows)/Ctrl-D to end
ubb secret add github_pw --origin github.com  # bind it to a host (repeatable: subdomains match)
ubb secret list                               # names + bindings — values are never printed
ubb secret has github_pw                      # exit 0 present / 1 absent, silent either way
ubb secret bind github_pw github.com          # (re)set bindings; no hosts = clear the binding
                                              # single-label hosts bind too: ubb secret bind dev_pw localhost
ubb secret rm github_pw
ubb secret mode                                # show the current mode
ubb secret mode strict                         # or: ubb secret mode off   (default is off)
```

`ubb secret mode <off|strict>` takes **one** value and writes it. It did not use to: the value was parsed as a secret name, so `ubb secret mode strict` printed the current mode and wrote nothing, and the only way to change it was the doubled `ubb secret mode strict strict`. That workaround now fails loudly (`ubb secret mode takes at most one value (off|strict)`), as does an illegal value like `ubb secret mode loose` (exit 1, naming the two legal values) — if you scripted the doubled form, change it to the single one. Same family, same batch: `ubb secret rm|has` now reject stray extra arguments instead of silently ignoring them.

Where things live: `~/.ubb/secrets.json` (`{ "<name>": "<value>" }`, plaintext, your user profile's ACL + disk encryption are the real control; `UBB_SECRETS_FILE` overrides the path for tests). The mode flag is `secret_origin_mode` in `~/.ubb/config.json` — the same file that holds your token, so edit it carefully.

Then the agent refers to the name only:

```bash
ubb secret.fill '{"ref":"@e7","secret":"github_pw"}'
ubb fill '{"ref":"@e7","value":"{{secret:github_pw}}"}'
```

What that means for safety, in plain words: the extension fetches the plaintext from the daemon at the moment it types, so no password is ever in a tool argument, result, audit entry, daemon log or the chat transcript. `{{secret:NAME}}` is substituted **only** in `fill`, `fill_form` and `replay`'s `vars` values — **not in `type`** (capability shrinkage after the 2026-10-28 live incident: `type` has no target field the never-fill guard could classify, so a placeholder there used to drop plaintext into whatever box had focus, including OTP/CVV boxes; it now stays literal text — use `fill` or `secret.fill` instead) — and never in `evaluate`, `cdp.call` or `webmcp.invoke`. OTP / 验证码 / CVV / card number / private key fields are refused whatever the source, with no bypass parameter.

**Default mode `off`** is the choice made on 2026-10-28 and it is still the default: an unbound secret can be typed into any page's password field (each fill is audited — `ubb audit tail`). If that trade is not what you want, bind your entries and switch to strict — that is the whole tightening path:

```bash
ubb secret bind github_pw github.com   # host binding; subdomains match, repeatable
ubb secret mode strict                 # now: must be bound, and the page host must match, or it is refused
ubb secret mode                        # read it back — the output must say strict
```

Strict refuses **before the value is fetched**, and the refusal is `SECRET_ORIGIN_DENIED` with no `secret.resolve` ever leaving the extension. One honesty note, because the two halves were verified differently: the CLI parsing above is daemon/CLI-side and was exercised against a real CLI run with a throwaway config; **strict's live refusal path has never been seen in a real session** — the live pass that should have caught it was blocked by a daemon process started on 2026-10-26, which does not contain the reverse-RPC branch at all, so `secret.fill` came back as `SECRET_FETCH_TIMEOUT` instead. Restart the daemon before concluding anything about strict mode.

Never store a value with `secret.set` from an agent if you can avoid it — that value goes into the conversation transcript. Ask the user to run `ubb secret add` instead.

## 7. Watch what the agent did: audit + live view

```bash
ubb audit tail                      # drain the ring → ~/.ubb/audit/<today>.jsonl (summary on stderr)
ubb audit tail --since 120          # incremental; cursor = the last seq you already read
ubb audit tail --follow             # keep polling every 2s until you press Ctrl-C
ubb audit tail --out mysession.jsonl
ubb audit stats                     # per-tool calls / errors / timings, 7-day window
ubb audit stats --window all

ubb liveview                        # human-facing preview: http://127.0.0.1:8790 (loopback only)
ubb liveview --view-port 8791       # move the preview listener
ubb liveview --tab 12 --fps 4       # a specific session tab
```

`ubb audit tail` does not print entries to stdout: whatever it pulls is appended as JSONL (default `~/.ubb/audit/<day>.jsonl`, `--out` to move it) and it prints one summary line on stderr. The in-memory ring holds 500 entries, so pull often or use `--follow`; entries that left the ring before the first pull are reported as `dropped_before_cursor`. The `seq` numbering survives a service-worker restart (mirrored into `chrome.storage.session`), the entries themselves do not.

The preview page shows the agent's screencast JPEG next to a live event feed; the latest frame is also written to `~/.ubb/liveview/latest.jpg` so you can point any image viewer at it.

**`--port` is the daemon port everywhere** (8765 by default). It is *not* the preview port any more: `ubb liveview --port 8791` now means "the daemon is on 8791" and prints a warning telling you to use `--view-port`. `--daemon-port` still works as an alias for the daemon port, and `UBB_LIVEVIEW_PORT` sets the preview default. If the preview port equals the daemon port the CLI refuses to start rather than colliding. The liveview listener binds `127.0.0.1` only and requires the token (`?token=…`, then a cookie); a LAN address gets connection-refused.

One screencast per tab: if an agent cast is already running, `ubb liveview` stops with `SCREENCAST_BUSY` naming the holder instead of hijacking it, and it never stops somebody else's cast on the way out. Run one liveview at a time. `screencast.stop` is honest about what it managed to stop: `stopped:false` + `held_by` means another client owns the slot (untouched), and `stopped:false` + `reason:"cdp_stop_failed"` means the browser refused `Page.stopScreencast` — our slot is released, frames are no longer delivered, but the tab may still be capturing, and it is deliberately **not** reported as stopped.

## 8. Downloads

```bash
ubb download.list                      # ring of the last 200 downloads (newest first)
ubb download.wait '{"download_id":42}' # block until terminal state or DOWNLOAD_PENDING
ubb download.path '{"download_id":42}' # absolute path + state + text_readable
ubb download cat 42                    # print it, from the daemon side (text files only)
ubb download cat 42 --max-bytes 200000
ubb download cat 42 --allow-path "D:/Other/Downloads"   # or set UBB_DOWNLOAD_DIRS
```

There is deliberately **no `download.read` tool**: an MV3 service worker has no filesystem and `file://` fetches are refused, so reading the file happens in the daemon. `ubb download cat` accepts only a numeric download **id** (never a path), only paths that `download.path` actually answered and that sit under a download root (default `~/Downloads`), and only text: binary payloads are refused (`BINARY`) rather than pasted into the conversation as base64. Output is redacted (JSON/JSONL/CSV/ini/URL query aware).

## Web console (no daemon, no Node)

`console/index.html` drives UBB straight from a web page via the `externally_connectable` localhost channel — the page calls `chrome.runtime.sendMessage(EXT_ID, {type:'UBB_WEB_RPC', token, tool, params})` and the extension runs the tool.

1. Serve the folder over **http on loopback** (any port):
   `python -m http.server 8089 --directory console` or `npx serve console`
2. Open `http://127.0.0.1:8089/index.html`, paste the token, call tools from the buttons.
3. **Do not open the file via `file://`** — `chrome.runtime` is only injected on `http://localhost|127.0.0.1` origins; the page detects this and tells you.

`console/liveview.html` is the same trick for the human preview (served by `ubb liveview` automatically — see step 7).

Security: `externally_connectable.matches` admits `http://localhost/*` and `http://127.0.0.1/*` only, and every message must carry the daemon token (checked against the extension's stored token). Audit entries land as `web.rpc`. One consequence worth knowing: that channel reaches the extension's dispatcher directly, **past** the daemon's `{{secret:NAME}}` substitution point, so a placeholder sent through the web console stays an unresolved placeholder string (no plaintext is produced — it fails safe, it does not decrypt).

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
ubb status        # extension:true → already installed, skip to use
# Node fallback: node daemon/ubb.mjs status
```

If not installed, ask the user to do steps 1–2 (browser UI actions), then verify with `status`. Never load the extension or paste tokens on the user's behalf without asking.

Token and port resolve in this order: CLI flags → `UBB_TOKEN` / `UBB_PORT` env → `~/.ubb/config.json` (written by `ubb config token|port`).

After your first real task, one thing needs the user: the new tools only exist once the extension has been reloaded (step 1's ↻). `ubb list` against a stale extension shows the old catalog — the offline check that does not need a browser is `node daemon/test-foundation.mjs`. Confirm the reload landed with `ubb status` → `extension_build` matching `lib/config.js`'s `BUILD`; and remember daemon-side changes need the daemon restarted, which is the user's process to kill, not yours.

Two reporting rules for agents working in this repo, learned the expensive way: a green offline suite is **not** a live result (the offline suite was 1137/1137 green — since grown, see README's [Verification status](README.md#verification-status) — while the real browser silently refused every coordinate click, because the mock had swallowed the shield channel), and an action that returns `ok:true` is not evidence that the page received anything — assert the *effect*, and if you cannot, say "offline-proven, awaiting a live re-check" instead of "verified".

## Daemon lifecycle

```bash
ubb daemon start|stop|status                     # Rust daemon (default)
node daemon/ubb.mjs daemon start|stop|status     # Node daemon (fallback)
```

Any `ubb` tool call auto-starts the daemon if it is down. The extension reconnects automatically after browser restarts, extension reloads, or daemon restarts — including switches between the Node and Rust daemons. `ubb audit tail` / `ubb liveview` / `ubb download cat` open their own agent WebSocket, so they need a reachable daemon + loaded extension but do not disturb an existing agent session.

**Nothing but a restart makes new code run.** A daemon is judged by its `extension_build`-adjacent identity only from the moment it boots, and an extension only picks up `lib/*` / `content/*` / `background.js` edits on ↻. `ubb status` is the one command that separates the two: `daemon` says the port answered, `extension` says a socket is up, and the **pair of version fields** says whether either of them is the code you are reading. When a live result contradicts the source, check the versions before believing either.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `extension: false` | Token mismatch — redo step 2; check the popup shows "connected" |
| `ubb status` prints **no** `extension_build` | The daemon answering you is an older process (its own code is in memory) — `ubb daemon stop`, then any call re-spawns the current one; `~/.ubb/daemon.log`'s first line tells you when the running one started |
| `extension_build` ≠ the `BUILD` in `lib/config.js` | The extension was never reloaded — press ↻ on the extension card (step 1). `extension: true` only means *something* is connected |
| `EXTENSION_NOT_CONNECTED` on calls | Browser closed, or extension not loaded — run `status` |
| `SHIELD_PASS_FAILED` | The shield's overlay would not move aside for that frame at that point, so the action was **aborted and nothing was sent** (this is the fix for the old "`ok:true` but the page did nothing"). Do not blind-retry. Exits, in order: 「■ 停止代理」 in the page's top-right strip → popup shield mode `block`→`border`→`off` → reload the extension → `tab.release` + `tab.claim` |
| Click/type/press_key does nothing **and the call fails fast with `INPUT_NOT_DELIVERED`** (`data.stage:"pre-dispatch"`, `dispatched:false`, `events_on_wire:0`) | **This is not a bug — it is this machine's input-queue behaviour.** The target document's own `document.visibilityState` is not `"visible"`: the Edge/Chrome window is **minimized or covered by another window**. A hidden document never drains its trusted-input queue at all, so a pointer/real-keyboard action (`click` by ref/coordinates, `hover`, `drag`, `type`, `press_key`, `fill`'s iframe coordinate path, `form.set`'s physical click, `scroll`'s wheel fallback) is refused **before dispatch** rather than waiting out the 7 s proof budget. **`tab.select` does not fix it** — it activates the tab and focuses the window, but an occluded window stays `hidden` through it; `window.restore` only focuses/restores and does not raise a covered window either. **Only the user raising that Edge/Chrome window to the front changes it** (no tool call can). The other real exits: `tab.create {"url":…,"active":true}` (a foreground tab), or the `@d<frameId>.<n>` / `{selector}` bridge path — but that is `isTrusted:false` in-page synthetic input and is **not semantically equivalent** to a real click. Do not guess past `tab.create {"active":true}`. The seventh live pass measured exactly this shape (occluded Edge window, 20/20): the door stayed open (`veil_at_read:"none"`), the page recorded nothing (`records_seen:0`) over the full 7 s, and each click went red only after **≈12.09 s** (≈5.07 s ack + 7 s proof budget); fix19's pre-dispatch fast-fail that replaces that wait is **offline-proven, awaiting a real-browser re-check**. Note the second origin — **no `stage`, `waited_ms≈7000`** — is fix17/18's post-dispatch delivery-proof refusal: events did go out but the document's ring recorded none, and a press/release/key is **never** auto-repeated, so decide whether a repeat is safe rather than blind-retrying. Sensing, screenshots, extraction, network/console, downloads and the bridge paths keep working on a background tab — only trusted pointer/keyboard input is refused. (See README's [An ack is not a delivery](README.md#an-ack-is-not-a-delivery-input_not_delivered-fix1719) and [Notes & limits](README.md#notes--limits).) |
| `BRIDGE_TIMEOUT` / `BRIDGE_WEDGED` | That frame's content bridge stopped answering; the bound is per frame (12 s / 30 s for heavy reads), then a **30 s** cooldown during which the call first pays an 800 ms `selfInfo` liveness probe: no answer → sub-second `BRIDGE_WEDGED` (window re-arms), answer → cooldown dropped and the call runs, so a healed frame needs no navigation. What the cooldown guarantees is the **cost bound per `(tab,frame)`**, not that a sibling frame is unaffected — each frame is judged by its own probe (offline-pinned; the live "did one frame jam the whole tab?" question is still open). Clear a pending dialog (`dialog.handle`) or reload the tab; navigation and `tab.close` clear the record |
| `SECRET_FETCH_TIMEOUT` on `secret.fill` | Usually not the vault: the running daemon has no reverse-RPC branch (started before this batch). Restart it, then re-check |
| `REF_STALE: … gave no runtime handle` on a `{ref}` action | `DOM.resolveNode` handed back nothing for that node — take a fresh snapshot; frame-scoped and shadow-tree targets go through the bridge/coordinate path instead. (This path is offline-pinned only — see README's [Notes & limits](README.md#notes--limits)) |
| `DEBUGGER_CONFLICT` | A DevTools window or another automation extension holds the tab |
| `TAB_NOT_OWNED` | Only session tabs are operable — create with `tab.create` or claim with `tab.claim` |
| `URL_BLOCKED` | Restricted page (chrome://, edge://, store) — by design |
| `BAD_URL` | Not a URL with a scheme and not a bare host — UBB refuses to guess `https://` for odd shapes (that is what used to launder `chrome://` past the gate) |
| Daemon port conflict | Change the port in the popup and restart with the same `--port` (the liveview preview moves with `--view-port`) |
| `ubb secret add` says `no token` | On a brand-new machine the CLI subcommands run before the token gate; if you see this, you are on a stale `bin/ubb.exe` — use `node daemon/ubb.mjs secret add …` and rebuild the Rust CLI |
| `SECRET_UNKNOWN` | The vault has no entry with that name — `ubb secret list`; the message never contains a value |
| `SECRET_ORIGIN_DENIED` | Mode is `strict` and the page host does not match the binding (or the entry is unbound) — `ubb secret bind <name> <host>`, or `ubb secret mode off` if you accept that trade |
| `SECRET_UNRESOLVED` | A `{{secret:…}}` reached execution unresolved — the fill is refused; check the name and that the value went through `vars` / `fill` / `fill_form` (`type` never substitutes — the placeholder stays literal there) |
| `FRAME_UNSUPPORTED` | That frame is out-of-process (cross-site OOPIF): MV3 gives it no CDP input channel, **and a page-level debugger session's `Input.*` does not reach it either — so the coordinate tools refuse as well**. `click` / `hover` / `fill` / `fill_form` / `form.set`'s physical click / `ax.action {focus\|click}` / `drag` / `snapshot {probe_hover}` all answer this code **before** putting any `Input.*` on the wire; `evaluate` / `upload_file` / `ax.action {setValue\|expand}` too. Exits: act through that frame's own bridge with an `@d<frameId>.<n>` ref (`find {"frame_id":N}` produces them — in-page synthetic events), let the user click, or `tab.create` the frame URL as a top-level tab. Sensing (`read_page` / `find` / `element.info`) and same-process child frames (cross-origin, same site) are unaffected — the coordinate path lands there for real |
| `FRAME_UNREACHABLE` | No content bridge in that frame (`srcdoc:` / `about:blank` / `file:`) — manifest-level change needed; re-snapshot and work from the parent frame |
| `FRAME_AMBIGUOUS` / `REF_FRAME_AMBIGUOUS` | Two frames look alike — UBB refuses to guess; pass `frame_id` explicitly |
| `SCREENCAST_BUSY` | Another client holds the tab's single cast (name is in the message) — let it stop, or take over with `force:true` |
| `DOWNLOAD_PENDING` | The transfer has not reached a terminal state — poll `download.status`, or `download.wait` with a bigger `timeout_ms` |
| `MATCH_NOT_FOUND` during replay | The page drifted from the recording — the message lists the 3 closest candidates; fix the trace, or resume with `start_at` |
| `ubb liveview` prints nothing | It waits on the agent's screencast; open a tab first (`tab.create`) and pass `--tab <id>` if the session has several |
