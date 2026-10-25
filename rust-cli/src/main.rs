// ubb — Rust fallback CLI + daemon for UBB.
//
//   ubb serve --port 8765 --token <token>     daemon mode (protocol-compatible
//                                             with daemon/ubb-bridge.mjs)
//   ubb status / list / daemon ... / config ... / <tool> '<json>'
//                                             client mode, mirrors daemon/ubb.mjs
//
// Wire protocol (identical to the Node implementation):
//   extension: one WS client, subprotocol `ubb-auth.<token>` (or first-message auth)
//   agents:    WS clients, subprotocol `ubb-agent.<token>`
//   agent   → {"id":1,"method":"tool.x","params":{...}}
//   agent   ← {"id":1,"result":{...}} | {"id":1,"error":{"code","message"}}
//   cancel:    {"method":"cancel","params":{"id":1}}   status: {"id":0,"method":"status"}

use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use sha1::{Digest, Sha1};
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::protocol::{CloseFrame, Message, Role};
use tokio_tungstenite::tungstenite::Error as WsError;

const GUID: &str = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

// ------------------------------------------------------------------ shared state

type Tx = mpsc::UnboundedSender<Message>;

#[derive(Clone)]
enum Sink {
    Stdio,
    Ws(u64),
}

struct ExtState {
    out: Tx,
    info: Value,
    last_frame: Instant,
}

struct Route {
    sink: Sink,
    agent_id: Value,
}

struct AppState {
    ext: Mutex<Option<ExtState>>,
    ws_agents: Mutex<Vec<(u64, Tx)>>,
    routes: Mutex<HashMap<String, Route>>,
    seq: AtomicU64,
    agent_seq: AtomicU64,
    /// bumped on every frame received from the extension (liveness probing)
    ext_tick: AtomicU64,
}

impl AppState {
    fn new() -> Self {
        Self {
            ext: Mutex::new(None),
            ws_agents: Mutex::new(Vec::new()),
            routes: Mutex::new(HashMap::new()),
            seq: AtomicU64::new(0),
            agent_seq: AtomicU64::new(0),
            ext_tick: AtomicU64::new(0),
        }
    }

    fn ext_out(&self) -> Option<Tx> {
        self.ext.lock().unwrap().as_ref().map(|e| e.out.clone())
    }

    fn send_agent(&self, sink: &Sink, obj: &Value) {
        let text = obj.to_string();
        match sink {
            Sink::Stdio => {
                emit(&text);
            }
            Sink::Ws(id) => {
                let agents = self.ws_agents.lock().unwrap();
                if let Some((_, tx)) = agents.iter().find(|(i, _)| i == id) {
                    let _ = tx.send(Message::Text(text.clone().into()));
                }
            }
        }
    }

    fn broadcast(&self, obj: &Value) {
        let text = obj.to_string();
        emit(&text);
        let agents = self.ws_agents.lock().unwrap();
        for (_, tx) in agents.iter() {
            let _ = tx.send(Message::Text(text.clone().into()));
        }
    }
}

// ------------------------------------------------------------------ helpers

// console write that matches node's behavior on Windows: when stdout is a real
// console, go through WriteConsoleW so CJK renders under non-UTF8 codepages
fn emit(s: &str) {
    #[cfg(windows)]
    {
        use std::io::IsTerminal;
        if std::io::stdout().is_terminal() {
            #[link(name = "kernel32")]
            extern "system" {
                fn GetStdHandle(nstdhandle: u32) -> *mut core::ffi::c_void;
                fn WriteConsoleW(
                    consoleoutput: *mut core::ffi::c_void,
                    buffer: *const u16,
                    numberofcharstowrite: u32,
                    numberofcharswritten: *mut u32,
                    reserved: *mut core::ffi::c_void,
                ) -> i32;
            }
            const STD_OUTPUT_HANDLE: u32 = u32::MAX - 10; // (DWORD)-11
            unsafe {
                let h = GetStdHandle(STD_OUTPUT_HANDLE);
                let mut line = String::with_capacity(s.len() + 1);
                line.push_str(s);
                line.push(10u8 as char);
                let wide: Vec<u16> = line.encode_utf16().collect();
                let mut written = 0u32;
                if WriteConsoleW(h, wide.as_ptr(), wide.len() as u32, &mut written, std::ptr::null_mut()) != 0 {
                    return;
                }
            }
        }
    }
    println!("{s}");
}

fn log(msg: &str) {
    eprintln!("[ubb-bridge-rs] {msg}");
}

fn major(v: &Value) -> u64 {
    v.as_str()
        .and_then(|s| s.split('.').next())
        .and_then(|s| s.parse().ok())
        .unwrap_or(0)
}

fn close(code: u16, reason: &str) -> Message {
    Message::Close(Some(CloseFrame {
        code: CloseCode::from(code),
        reason: reason.to_owned().into(),
    }))
}

fn drop_ext(state: &AppState, reason: &str) {
    let mut ext = state.ext.lock().unwrap();
    if let Some(e) = ext.take() {
        let _ = e.out.send(close(1000, reason));
        log("extension disconnected");
        let routes: Vec<Route> = state.routes.lock().unwrap().drain().map(|(_, v)| v).collect();
        for r in routes {
            state.send_agent(
                &r.sink,
                &json!({"id": r.agent_id, "error": {"code": "EXTENSION_DISCONNECTED", "message": "extension went away"}}),
            );
        }
    }
}

/// Send `{"method":"ping"}` to the current extension and return true if any
/// frame arrives within `ms` (mirrors wslib probe(): app-level ping).
async fn probe_ext(state: &Arc<AppState>, ms: u64) -> bool {
    let Some(out) = state.ext_out() else { return false };
    let before = state.ext_tick.load(Ordering::SeqCst);
    let _ = out.send(Message::Text(json!({"method": "ping"}).to_string().into()));
    let deadline = Instant::now() + Duration::from_millis(ms);
    while Instant::now() < deadline {
        if state.ext_tick.load(Ordering::SeqCst) != before {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(30)).await;
    }
    false
}

fn handle_agent_message(state: &Arc<AppState>, sink: &Sink, msg: &Value) {
    let method = msg.get("method").and_then(|m| m.as_str()).map(String::from);
    if method.as_deref() == Some("cancel") {
        let want = msg.pointer("/params/id").cloned();
        if let (Some(out), Some(want)) = (state.ext_out(), want) {
            let routes = state.routes.lock().unwrap();
            for (int_id, r) in routes.iter() {
                if r.agent_id == want {
                    let _ = out.send(Message::Text(
                        json!({"method": "cancel", "params": {"id": int_id}}).to_string().into(),
                    ));
                    return;
                }
            }
        }
        return;
    }
    if method.as_deref() == Some("status") {
        let ext = state.ext.lock().unwrap();
        state.send_agent(
            sink,
            &json!({
                "id": msg.get("id"),
                "result": {
                    "extension_connected": ext.is_some(),
                    "extension_info": ext.as_ref().map(|e| e.info.clone()),
                    "inflight": state.routes.lock().unwrap().len(),
                }
            }),
        );
        return;
    }
    let id = msg.get("id");
    if method.is_none() || id.is_none() || id == Some(&Value::Null) {
        state.send_agent(
            sink,
            &json!({"id": id.unwrap_or(&Value::Null), "error": {"code": "BAD_REQUEST", "message": "need id and method"}}),
        );
        return;
    }
    let Some(out) = state.ext_out() else {
        state.send_agent(
            sink,
            &json!({"id": id, "error": {"code": "EXTENSION_NOT_CONNECTED", "message": "load the UBB extension and check its popup"}}),
        );
        return;
    };
    let int_id = format!("x{}", state.seq.fetch_add(1, Ordering::SeqCst) + 1);
    state.routes.lock().unwrap().insert(
        int_id.clone(),
        Route { sink: sink.clone(), agent_id: id.unwrap().clone() },
    );
    let params = match msg.get("params") {
        Some(v) if !v.is_null() => v.clone(),
        _ => json!({}),
    };
    let _ = out.send(Message::Text(
        json!({"id": int_id, "method": method, "params": params}).to_string().into(),
    ));
}

fn handle_extension_message(state: &Arc<AppState>, msg: &Value) {
    let method = msg.get("method").and_then(|m| m.as_str()).map(String::from);
    match method.as_deref() {
        Some("ping") => {
            if let Some(out) = state.ext_out() {
                let _ = out.send(Message::Text(json!({"method": "pong"}).to_string().into()));
            }
        }
        Some("hello") => {
            let min = msg.pointer("/params/min_compatible").cloned().unwrap_or(json!("1.0"));
            if major(&min) > 1 {
                if let Some(out) = state.ext_out() {
                    let _ = out.send(Message::Text(
                        json!({"id": msg.get("id"), "error": {"code": "version_skew", "message": "daemon supports 1.x, extension wants a newer protocol"}})
                            .to_string()
                            .into(),
                    ));
                }
                return;
            }
            let info = msg.get("params").cloned().unwrap_or(Value::Null);
            if let Some(out) = state.ext_out() {
                let _ = out.send(Message::Text(
                    json!({"id": msg.get("id"), "result": {"protocol_version": "1.0", "daemon": "ubb-bridge-rs 1.0.0"}})
                        .to_string()
                        .into(),
                ));
            }
            // connection registration already logged; hello only carries info
            state.broadcast(&json!({"method": "event.extension.connected", "params": {"info": info}}));
        }
        _ => {
            let has_id = msg.get("id").map(|v| !v.is_null()).unwrap_or(false);
            let is_reply = has_id && (msg.get("result").is_some() || msg.get("error").is_some());
            if is_reply {
                let key = msg.get("id").and_then(|v| v.as_str()).map(String::from);
                if let Some(key) = key {
                    let route = state.routes.lock().unwrap().remove(&key);
                    if let Some(r) = route {
                        let mut out = json!({"id": r.agent_id});
                        if let (Some(a), Some(m)) = (out.as_object_mut(), msg.as_object()) {
                            for (k, v) in m {
                                if k != "id" {
                                    a.insert(k.clone(), v.clone());
                                }
                            }
                        }
                        state.send_agent(&r.sink, &out);
                    }
                }
            } else if msg.get("method").is_some() {
                state.broadcast(msg); // events → all agents
            }
        }
    }
}

// ------------------------------------------------------------------ ws server

fn ws_accept(key: &str) -> String {
    let mut h = Sha1::new();
    h.update(key.as_bytes());
    h.update(GUID.as_bytes());
    base64::engine::general_purpose::STANDARD.encode(h.finalize())
}

fn find_head_end(buf: &[u8]) -> Option<usize> {
    buf.windows(4).position(|w| w == b"\r\n\r\n").map(|i| i + 4)
}

async fn handle_connection(state: Arc<AppState>, token: String, mut stream: TcpStream, addr: SocketAddr) {
    let loopback = match addr.ip() {
        std::net::IpAddr::V4(v4) => v4.is_loopback(),
        std::net::IpAddr::V6(v6) => v6.is_loopback(),
    };
    if !loopback {
        log("rejected non-loopback connection");
        return;
    }

    // read the HTTP request head (GET requests carry no body, so stopping at
    // the first \r\n\r\n is safe for both /health and the ws upgrade)
    let mut buf = Vec::new();
    let mut chunk = [0u8; 4096];
    loop {
        if let Some(i) = find_head_end(&buf) {
            buf.truncate(i);
            break;
        }
        match stream.read(&mut chunk).await {
            Ok(0) | Err(_) => return,
            Ok(n) => buf.extend_from_slice(&chunk[..n]),
        }
        if buf.len() > 64 * 1024 {
            return;
        }
    }
    let head = String::from_utf8_lossy(&buf).to_string();
    let mut lines = head.lines();
    let request_line = lines.next().unwrap_or("");
    let mut parts = request_line.split_whitespace();
    let _method = parts.next().unwrap_or("");
    let path = parts.next().unwrap_or("");
    let mut sec_ws_key: Option<String> = None;
    let mut offered: Vec<String> = Vec::new();
    let mut is_upgrade = false;
    for line in lines {
        let Some((k, v)) = line.split_once(':') else { continue };
        match k.trim().to_ascii_lowercase().as_str() {
            "sec-websocket-key" => sec_ws_key = Some(v.trim().to_string()),
            "sec-websocket-protocol" => {
                offered = v.split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect()
            }
            "upgrade" => is_upgrade = v.trim().eq_ignore_ascii_case("websocket"),
            _ => {}
        }
    }

    if !is_upgrade {
        let (status, body) = if path.starts_with("/shutdown") {
            if !path.contains(&format!("token={token}")) {
                ("403 Forbidden", "{}".to_string())
            } else {
                log("shutdown requested");
                let b = json!({"ok": true, "shutting_down": true}).to_string();
                let _ = write_http(&mut stream, "200 OK", &b).await;
                // give the socket a beat to flush before exit, like the node daemon
                tokio::time::sleep(Duration::from_millis(150)).await;
                std::process::exit(0);
            }
        } else if path.starts_with("/health") {
            let ext = state.ext.lock().unwrap().is_some();
            let agents = state.ws_agents.lock().unwrap().len() + 1; // + stdio agent
            ("200 OK", json!({"ok": true, "extension": ext, "agents": agents}).to_string())
        } else {
            ("404 Not Found", String::new())
        };
        let _ = write_http(&mut stream, status, &body).await;
        return;
    }

    // ---- websocket upgrade (echo the first offered protocol, like wslib)
    let Some(key) = sec_ws_key else { return };
    let mut resp = format!(
        "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {}\r\n",
        ws_accept(&key)
    );
    if let Some(c) = offered.first() {
        resp.push_str(&format!("Sec-WebSocket-Protocol: {c}\r\n"));
    }
    resp.push_str("\r\n");
    if stream.write_all(resp.as_bytes()).await.is_err() {
        return;
    }
    let ws = tokio_tungstenite::WebSocketStream::from_raw_socket(stream, Role::Server, None).await;
    let (mut write, mut read) = ws.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<Message>();
    tokio::spawn(async move {
        while let Some(m) = rx.recv().await {
            if write.send(m).await.is_err() {
                break;
            }
        }
        let _ = write.close().await;
    });

    // ---- authenticate
    let role: &'static str = match &offered {
        p if p.first().map(String::as_str) == Some(&format!("ubb-auth.{token}")) => "extension",
        p if p.first().map(String::as_str) == Some(&format!("ubb-agent.{token}")) => "agent",
        p if !p.is_empty() => {
            let _ = tx.send(close(1008, "authentication failed"));
            return;
        }
        _ => {
            // no subprotocol: first message must be auth within 5s
            let first = tokio::time::timeout(Duration::from_secs(5), read.next()).await;
            let Ok(Some(Ok(Message::Text(t)))) = first else {
                let _ = tx.send(close(1008, "auth timeout"));
                return;
            };
            let msg: Value = serde_json::from_str(t.as_str()).unwrap_or(Value::Null);
            let ok = msg.get("method").and_then(|m| m.as_str()) == Some("auth")
                && msg.pointer("/params/token").and_then(|x| x.as_str()) == Some(token.as_str());
            if !ok {
                let _ = tx.send(close(1008, "authentication failed"));
                return;
            }
            if msg.pointer("/params/role").and_then(|r| r.as_str()) == Some("agent") {
                "agent"
            } else {
                "extension"
            }
        }
    };

    // ---- extension singleton: probe incumbent, replace if dead
    let my_agent_id: u64;
    if role == "extension" {
        if state.ext.lock().unwrap().is_some() {
            if probe_ext(&state, 1500).await {
                log("refused duplicate extension connection (incumbent is alive)");
                let _ = tx.send(close(1008, "duplicate extension connection"));
                return;
            }
            log("incumbent extension connection is dead, replacing");
            drop_ext(&state, "replaced");
        }
        *state.ext.lock().unwrap() = Some(ExtState {
            out: tx.clone(),
            info: Value::Null,
            last_frame: Instant::now(),
        });
        log("extension connected");
        my_agent_id = 0;
    } else {
        my_agent_id = state.agent_seq.fetch_add(1, Ordering::SeqCst) + 1;
        state.ws_agents.lock().unwrap().push((my_agent_id, tx.clone()));
        log("agent connected (ws)");
    }

    let sink = if role == "agent" { Sink::Ws(my_agent_id) } else { Sink::Stdio };

    while let Some(frame) = read.next().await {
        let msg = match frame {
            Ok(Message::Text(t)) => serde_json::from_str::<Value>(t.as_str()).unwrap_or(Value::Null),
            Ok(Message::Ping(p)) => {
                let _ = tx.send(Message::Pong(p));
                continue;
            }
            Ok(Message::Pong(_)) => {
                state.ext_tick.fetch_add(1, Ordering::SeqCst);
                if let Some(e) = state.ext.lock().unwrap().as_mut() {
                    e.last_frame = Instant::now();
                }
                continue;
            }
            Ok(Message::Close(_)) | Err(_) => break,
            Ok(_) => continue,
        };
        state.ext_tick.fetch_add(1, Ordering::SeqCst);
        if let Some(e) = state.ext.lock().unwrap().as_mut() {
            e.last_frame = Instant::now();
        }
        if role == "extension" {
            handle_extension_message(&state, &msg);
        } else {
            handle_agent_message(&state, &sink, &msg);
        }
    }

    // ---- teardown
    if role == "extension" {
        drop_ext(&state, "gone");
    } else {
        state.ws_agents.lock().unwrap().retain(|(i, _)| *i != my_agent_id);
        state
            .routes
            .lock()
            .unwrap()
            .retain(|_, r| !matches!(&r.sink, Sink::Ws(i) if *i == my_agent_id));
        log("agent disconnected (ws)");
    }
}

async fn write_http(stream: &mut TcpStream, status: &str, body: &str) -> std::io::Result<()> {
    let resp = format!(
        "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    stream.write_all(resp.as_bytes()).await
}

async fn run_daemon(port: u16, token: String) {
    let state = Arc::new(AppState::new());
    let listener = TcpListener::bind(("127.0.0.1", port))
        .await
        .unwrap_or_else(|e| {
            log(&format!("server error {e}"));
            std::process::exit(1);
        });
    log(&format!(
        "listening on ws://127.0.0.1:{port}/ (token {}…)",
        &token[..token.len().min(4)]
    ));
    emit(&json!({"method": "event.daemon.ready", "params": {"port": port}}).to_string());

    // half-open watchdog: probe a silent extension and drop it if dead
    {
        let state = state.clone();
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(15)).await;
                let idle = {
                    match state.ext.lock().unwrap().as_ref() {
                        Some(e) => e.last_frame.elapsed() >= Duration::from_secs(45),
                        None => false,
                    }
                };
                if !idle {
                    continue;
                }
                if probe_ext(&state, 1200).await {
                    if let Some(e) = state.ext.lock().unwrap().as_mut() {
                        e.last_frame = Instant::now();
                    }
                } else {
                    log("extension idle watchdog: dropping dead connection");
                    drop_ext(&state, "dead");
                }
            }
        });
    }

    // stdio agent: newline-delimited JSON on stdin, replies/events on stdout
    {
        let state = state.clone();
        std::thread::spawn(move || {
            use std::io::BufRead;
            let stdin = std::io::stdin();
            for line in stdin.lock().lines() {
                let Ok(line) = line else { break };
                let line = line.trim();
                if line.is_empty() || line == "{" {
                    continue; // tolerate pretty-printed first brace, like the node daemon
                }
                let Ok(msg) = serde_json::from_str::<Value>(line) else {
                    println!(
                        "{}",
                        json!({"id": null, "error": {"code": "BAD_JSON", "message": "stdin lines must be one JSON object per line"}})
                    );
                    continue;
                };
                handle_agent_message(&state, &Sink::Stdio, &msg);
            }
            log("stdin closed; daemon stays alive for WS agents");
        });
    }

    loop {
        match listener.accept().await {
            Ok((stream, addr)) => {
                let state = state.clone();
                let token = token.clone();
                tokio::spawn(handle_connection(state, token, stream, addr));
            }
            Err(e) => log(&format!("accept error {e}")),
        }
    }
}

// ------------------------------------------------------------------ client

fn home_dir() -> Option<std::path::PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(std::path::PathBuf::from)
}

fn config_path() -> std::path::PathBuf {
    home_dir().unwrap_or_default().join(".ubb").join("config.json")
}

fn read_config() -> Value {
    std::fs::read_to_string(config_path())
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or(Value::Null)
}

fn write_config(map: &serde_json::Map<String, Value>) {
    let p = config_path();
    if let Some(dir) = p.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let _ = std::fs::write(p, serde_json::to_string_pretty(map).unwrap_or_default());
}

async fn health(port: u16, ms: u64) -> Option<Value> {
    let fut = async {
        let mut s = TcpStream::connect(("127.0.0.1", port)).await.ok()?;
        let req = format!("GET /health HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n");
        s.write_all(req.as_bytes()).await.ok()?;
        let mut buf = Vec::new();
        // a process-exit teardown can RST after the payload; keep what we got
        let _ = s.read_to_end(&mut buf).await;
        let text = String::from_utf8_lossy(&buf);
        let body = text.split("\r\n\r\n").nth(1)?;
        // the node daemon answers with chunked encoding; slice out the JSON
        let (a, b) = (body.find('{')?, body.rfind('}')? + 1);
        serde_json::from_str(&body[a..b]).ok()
    };
    tokio::time::timeout(Duration::from_millis(ms), fut).await.ok()?
}

fn spawn_detached_self(port: u16, token: &str) {
    let exe = match std::env::current_exe() {
        Ok(e) => e,
        Err(_) => return,
    };
    let mut cmd = std::process::Command::new(exe);
    cmd.args(["serve", "--port", &port.to_string(), "--token", token]);
    // daemon logs (crash traces included) go to ~/.ubb/daemon.log, truncated per start
    let log_path = config_path().with_file_name("daemon.log");
    let log = std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(&log_path)
        .ok();
    match log {
        Some(f) => {
            let err = f.try_clone().expect("clone daemon log handle");
            cmd.stdout(std::process::Stdio::from(f))
                .stderr(std::process::Stdio::from(err));
        }
        None => {
            cmd.stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
        }
    }
    cmd.stdin(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        cmd.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
    }
    // the Child handle is dropped on purpose: the daemon outlives the CLI process
    let _ = cmd.spawn();
}

async fn wait_daemon(port: u16) -> bool {
    for _ in 0..25 {
        tokio::time::sleep(Duration::from_millis(200)).await;
        if health(port, 400).await.is_some() {
            return true;
        }
    }
    false
}

async fn rpc(port: u16, token: &str, method: &str, params: &Value, timeout_ms: u64) -> Result<Value, String> {
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;
    use tokio_tungstenite::tungstenite::http::header::{HeaderName, HeaderValue};
    let url = format!("ws://127.0.0.1:{port}/");
    let mut req = url.into_client_request().map_err(|_| "connect-failed".to_string())?;
    req.headers_mut().insert(
        HeaderName::from_static("sec-websocket-protocol"),
        HeaderValue::from_str(&format!("ubb-agent.{token}")).map_err(|_| "connect-failed".to_string())?,
    );
    let (ws, _resp) = tokio_tungstenite::connect_async(req)
        .await
        .map_err(|e| match e {
            WsError::ConnectionClosed | WsError::AlreadyClosed => "connection closed".to_string(),
            _ => "connect-failed".to_string(),
        })?;
    let (mut write, mut read) = ws.split();
    let _ = write
        .send(Message::Text(
            json!({"id": 1, "method": method, "params": params}).to_string().into(),
        ))
        .await;
    let deadline = Instant::now() + Duration::from_millis(timeout_ms);
    loop {
        let remain = deadline.saturating_duration_since(Instant::now());
        if remain.is_zero() {
            return Err(format!("timeout after {timeout_ms}ms"));
        }
        match tokio::time::timeout(remain, read.next()).await {
            Err(_) => return Err(format!("timeout after {timeout_ms}ms")),
            Ok(None) => return Err("connection closed".to_string()),
            Ok(Some(Ok(Message::Text(t)))) => {
                if let Ok(m) = serde_json::from_str::<Value>(t.as_str()) {
                    if m.get("id").and_then(|v| v.as_i64()) == Some(1) {
                        return Ok(m);
                    }
                }
            }
            Ok(Some(Ok(Message::Close(Some(cf))))) => {
                return Err(if u16::from(cf.code) == 1008 {
                    "daemon rejected the token (check ubb config token)".to_string()
                } else {
                    format!("connection closed ({})", u16::from(cf.code))
                });
            }
            Ok(Some(Ok(Message::Close(None)))) => return Err("connection closed".to_string()),
            Ok(Some(Ok(_))) => continue,
            Ok(Some(Err(e))) => return Err(format!("connection closed ({e})")),
        }
    }
}

async fn call(port: u16, token: &str, method: &str, params: &Value) -> Result<Value, String> {
    match rpc(port, token, method, params, 60_000).await {
        Ok(m) => Ok(m),
        Err(e) if e == "connect-failed" => {
            spawn_detached_self(port, token);
            if !wait_daemon(port).await {
                return Err(format!("daemon failed to start on port {port}"));
            }
            rpc(port, token, method, params, 60_000).await
        }
        Err(e) => Err(e),
    }
}

fn print_result(m: &Value, out: Option<&str>) -> i32 {
    if let Some(err) = m.get("error") {
        eprintln!("{err}");
        return 2;
    }
    let r = m.get("result").cloned().unwrap_or(Value::Null);
    if let (Some(file), Some(b64)) = (out, r.get("data_base64").and_then(|v| v.as_str()).map(String::from)) {
        use base64::engine::general_purpose::STANDARD as B64;
        let path = std::path::Path::new(file);
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        return match B64.decode(b64.as_bytes()) {
            Ok(bytes) => match std::fs::write(path, &bytes) {
                Ok(_) => {
                    let mut meta = r.clone();
                    if let Some(o) = meta.as_object_mut() {
                        o.remove("data_base64");
                        let saved = std::fs::canonicalize(path)
                            .map(|p| p.display().to_string())
                            .unwrap_or_else(|_| file.to_string());
                        o.insert("saved_to".into(), json!(saved));
                    }
                    emit(&serde_json::to_string_pretty(&meta).unwrap_or_default());
                    0
                }
                Err(_) => {
                    eprintln!("failed to write {file}");
                    1
                }
            },
            Err(e) => {
                eprintln!("base64 decode failed: {e}");
                1
            }
        };
    }
    if let Some(b64) = r.get("data_base64").and_then(|v| v.as_str()) {
        let mut meta = r.clone();
        if let Some(o) = meta.as_object_mut() {
            o.remove("data_base64");
            let kb = b64.len() * 3 / 4 / 1024;
            o.insert("note".into(), json!(format!("screenshot {kb}KB; use --out FILE to save")));
        }
        emit(&serde_json::to_string_pretty(&meta).unwrap_or_default());
        return 0;
    }
    if let Some(text) = r.get("text").and_then(|v| v.as_str()) {
        // node checks JS .length (UTF-16 units); chars() is the closest Rust analog
        if text.chars().count() > 4000 && std::env::var_os("UBB_RAW").is_none() {
            emit(text);
            return 0;
        }
    }
    emit(&serde_json::to_string_pretty(&r).unwrap_or_default());
    0
}

fn die(msg: &str) -> ! {
    eprintln!("ubb: {msg}");
    std::process::exit(1);
}

// ------------------------------------------------------------------ main

#[tokio::main(flavor = "multi_thread")]
async fn main() {
    let mut positional: Vec<String> = Vec::new();
    let mut token_flag: Option<String> = None;
    let mut port_flag: Option<u16> = None;
    let mut out_flag: Option<String> = None;
    let mut it = std::env::args().skip(1);
    while let Some(a) = it.next() {
        match a.as_str() {
            "--token" => token_flag = it.next(),
            "--port" => port_flag = it.next().and_then(|v| v.parse().ok()),
            "--out" => out_flag = it.next(),
            _ => positional.push(a),
        }
    }
    let cfg = read_config();
    let token = token_flag
        .or_else(|| std::env::var("UBB_TOKEN").ok())
        .or_else(|| cfg.get("token").and_then(|v| v.as_str()).map(String::from));
    let port = port_flag
        .or_else(|| std::env::var("UBB_PORT").ok().and_then(|v| v.parse().ok()))
        .or_else(|| cfg.get("port").and_then(|v| v.as_u64()).map(|v| v as u16))
        .unwrap_or(8765);

    let cmd = positional.first().cloned().unwrap_or_default();
    let rest: Vec<String> = positional.iter().skip(1).cloned().collect();

    if cmd == "serve" {
        let token = token.unwrap_or_default();
        if token.is_empty() {
            die("serve requires --token <token> (or UBB_TOKEN env)");
        }
        run_daemon(port, token).await;
        return;
    }

    // config must run before the token gate: on a fresh machine there IS no
    // token yet, and `ubb config token <tok>` is the documented way to add one
    if cmd == "config" {
        let mut c = cfg.as_object().cloned().unwrap_or_default();
        match (rest.first().map(String::as_str), rest.get(1)) {
            (Some("token"), Some(v)) => {
                c.insert("token".into(), json!(v));
                write_config(&c);
                println!("saved token to {}", config_path().display());
            }
            (Some("port"), Some(v)) => match v.parse::<u16>() {
                Ok(p) => {
                    c.insert("port".into(), json!(p));
                    write_config(&c);
                    println!("saved port to {}", config_path().display());
                }
                Err(_) => die("port must be a number"),
            },
            _ => die("usage: ubb config token <token> | ubb config port <n>"),
        }
        return;
    }

    let Some(token) = token else {
        die("no token. Copy it from the UBB extension popup, then either:\n  ubb config token <token>\nor set UBB_TOKEN, or pass --token.");
    };

    match cmd.as_str() {
        "status" => {
            let mut h = health(port, 800).await;
            if h.is_none() {
                spawn_detached_self(port, &token);
                for _ in 0..25 {
                    tokio::time::sleep(Duration::from_millis(200)).await;
                    if let Some(x) = health(port, 400).await {
                        h = Some(x);
                        break;
                    }
                }
            }
            let daemon = h.is_some();
            let mut out = json!({"port": port, "daemon": daemon});
            if let (Some(a), Some(h)) = (out.as_object_mut(), h.as_ref().and_then(|v| v.as_object())) {
                for (k, v) in h {
                    a.insert(k.clone(), v.clone());
                }
            }
            emit(&serde_json::to_string_pretty(&out).unwrap_or_default());
            if daemon && !h.as_ref().and_then(|h| h.get("extension")).and_then(|v| v.as_bool()).unwrap_or(false) {
                eprintln!("# daemon OK, extension not connected — load the UBB extension and paste this token in its popup:");
                eprintln!("#   {token}");
            }
        }
        "daemon" => match rest.first().map(String::as_str) {
            Some("stop") => match http_shutdown(port, &token).await {
                Ok(body) => println!("{body}"),
                Err(()) => die("daemon is not running"),
            },
            Some("start") => {
                if let Some(h) = health(port, 500).await {
                    let mut o = json!({"already_running": true});
                    if let (Some(a), Some(b)) = (o.as_object_mut(), h.as_object()) {
                        for (k, v) in b {
                            a.insert(k.clone(), v.clone());
                        }
                    }
                    emit(&serde_json::to_string_pretty(&o).unwrap_or_default());
                } else {
                    spawn_detached_self(port, &token);
                    if !wait_daemon(port).await {
                        die("failed to start");
                    }
                    let h = health(port, 400).await.unwrap_or(json!({}));
                    let mut o = json!({"started": true});
                    if let (Some(a), Some(b)) = (o.as_object_mut(), h.as_object()) {
                        for (k, v) in b {
                            a.insert(k.clone(), v.clone());
                        }
                    }
                    emit(&serde_json::to_string_pretty(&o).unwrap_or_default());
                }
            }
            _ => {
                let mut h = health(port, 800).await;
                if h.is_none() {
                    spawn_detached_self(port, &token);
                    for _ in 0..25 {
                        tokio::time::sleep(Duration::from_millis(200)).await;
                        if let Some(x) = health(port, 400).await {
                            h = Some(x);
                            break;
                        }
                    }
                }
                let daemon = h.is_some();
                let mut out = json!({"port": port, "daemon": daemon});
                if let (Some(a), Some(b)) = (out.as_object_mut(), h.as_ref().and_then(|v| v.as_object())) {
                    for (k, v) in b {
                        a.insert(k.clone(), v.clone());
                    }
                }
                emit(&serde_json::to_string_pretty(&out).unwrap_or_default());
            }
        },
        "help" | "" => {
            println!("ubb (rust fallback) — Universal Browser Bridge CLI

  ubb status                       daemon + extension health (auto-start)
  ubb list                         tool catalog
  ubb <tool.name> '<json-args>'    run a tool, print JSON result
  ubb screenshot --out shot.png
  ubb daemon start|stop|status
  ubb config token <tok> | port <n>

Zero-Node fallback: this binary runs the daemon itself (`ubb serve`).");
        }
        "list" => match call(port, &token, "tool.list", &Value::Null).await {
            Ok(m) => std::process::exit(print_result(&m, out_flag.as_deref())),
            Err(e) => die(&format!("rpc failed: {e}")),
        },
        tool => {
            let raw = rest.join(" ");
            let params: Value = if raw.is_empty() {
                Value::Null
            } else {
                serde_json::from_str(&raw).unwrap_or_else(|e| die(&format!("params must be valid JSON: {e}")))
            };
            match call(port, &token, &format!("tool.{tool}"), &params).await {
                Ok(m) => std::process::exit(print_result(&m, out_flag.as_deref())),
                Err(e) => die(&format!("rpc failed: {e}")),
            }
        }
    }
}

async fn http_shutdown(port: u16, token: &str) -> Result<String, ()> {
    let fut = async {
        let mut s = TcpStream::connect(("127.0.0.1", port)).await.ok()?;
        let req = format!("POST /shutdown?token={token} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        s.write_all(req.as_bytes()).await.ok()?;
        let mut buf = Vec::new();
        // a process-exit teardown can RST after the payload; keep what we got
        let _ = s.read_to_end(&mut buf).await;
        let text = String::from_utf8_lossy(&buf).to_string();
        if !text.starts_with("HTTP/1.1 200") {
            return None;
        }
        let body = text.split("\r\n\r\n").nth(1)?;
        let (a, b) = (body.find('{')?, body.rfind('}')? + 1);
        Some(body[a..b].to_string())
    };
    match tokio::time::timeout(Duration::from_millis(2000), fut).await {
        Ok(Some(body)) => Ok(body),
        _ => Err(()),
    }
}
