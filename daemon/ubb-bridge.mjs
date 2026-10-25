#!/usr/bin/env node
// UBB bridge daemon — connects ANY agent to the UBB browser extension.
//
//   node ubb-bridge.mjs --port 8765 --token <token>
//
// Roles:
//   - extension: exactly one WS client, subprotocol `ubb-auth.<token>`
//   - agent(s):  many WS clients, subprotocol `ubb-agent.<token>`,
//                plus one implicit stdio agent (newline-delimited JSON)
//
// Agent message (WS or stdio), one JSON object per line/frame:
//   → {"id":1,"method":"tool.navigate","params":{"url":"example.com"}}
//   ← {"id":1,"result":{...}} | {"id":1,"error":{"code":"...","message":"..."}}
//   ← {"method":"event.tab.navigated","params":{...}}
// Cancel: {"method":"cancel","params":{"id":1}}   Status: {"id":0,"method":"status"}

import http from 'node:http';
import { attachWs } from './wslib.mjs';

const args = process.argv.slice(2);
function argOf(name, def) {
  const i = args.indexOf(`--${name}`);
  if (i >= 0 && args[i + 1]) return args[i + 1];
  const env = { port: process.env.UBB_PORT, token: process.env.UBB_TOKEN };
  return env[name] || def;
}

const PORT = Number(argOf('port', 8765));
const TOKEN = String(argOf('token', ''));
if (!TOKEN) {
  console.error('[ubb-bridge] ERROR: --token <token> (or UBB_TOKEN env) is required; copy it from the extension popup.');
  process.exit(1);
}

const log = (...a) => console.error(`[ubb-bridge ${new Date().toISOString()}]`, ...a);

let extension = null; // { ws, info }
let seq = 0;
const routes = new Map(); // internalId → { agent }  (agent = { send(obj) })

// ---------------------------------------------------------------- agents

class StdioAgent {
  send(obj) {
    process.stdout.write(JSON.stringify(obj) + '\n');
  }
}
const stdioAgent = new StdioAgent();
const wsAgents = new Set();

function broadcast(obj) {
  stdioAgent.send(obj);
  for (const a of wsAgents) a.send(obj);
}

/** Forward an agent request to the extension and route the reply back. */
function dispatchToExtension(agent, msg) {
  if (!extension) {
    agent.send({ id: msg.id, error: { code: 'EXTENSION_NOT_CONNECTED', message: 'load the UBB extension and check its popup' } });
    return;
  }
  const intId = `x${++seq}`;
  routes.set(intId, { agent, agentId: msg.id });
  extension.ws.send(JSON.stringify({ id: intId, method: msg.method, params: msg.params || {} }));
}

function handleAgentMessage(agent, msg) {
  if (!msg || typeof msg !== 'object') return;
  if (msg.method === 'cancel') {
    if (extension && msg.params?.id != null) {
      for (const [intId, r] of routes) {
        if (r.agentId === msg.params.id) {
          extension.ws.send(JSON.stringify({ method: 'cancel', params: { id: intId } }));
          return;
        }
      }
    }
    return;
  }
  if (msg.method === 'status') {
    agent.send({
      id: msg.id,
      result: { extension_connected: !!extension, extension_info: extension?.info || null, inflight: routes.size },
    });
    return;
  }
  if (msg.method == null || msg.id == null) {
    agent.send({ id: msg.id ?? null, error: { code: 'BAD_REQUEST', message: 'need id and method' } });
    return;
  }
  dispatchToExtension(agent, msg);
}

// ---------------------------------------------------------------- http + ws

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, extension: !!extension, agents: wsAgents.size + 1 }));
    return;
  }
  if (req.url.startsWith('/shutdown')) {
    const t = new URL(req.url, 'http://127.0.0.1').searchParams.get('token');
    if (t !== TOKEN) {
      res.writeHead(403).end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, shutting_down: true }));
    log('shutdown requested');
    setTimeout(() => process.exit(0), 150);
    return;
  }
  res.writeHead(404).end();
});

function isLoopback(req) {
  const ra = req.socket.remoteAddress || '';
  return ra === '127.0.0.1' || ra === '::1' || ra === '::ffff:127.0.0.1';
}

attachWs(server, {
  onConnection(ws, req, protocol, meta) {
    if (!isLoopback(req)) {
      log('rejected non-loopback connection from', req.socket.remoteAddress);
      ws.close(1008, 'loopback only');
      return;
    }

    let role = null; // 'extension' | 'agent'
    let authenticated = false;
    let authTimer = null;

    const preAuthFrames = [];
    let authDecided = false;

    const finishAuth = async (r) => {
      clearTimeout(authTimer);
      if (r === 'extension' && extension && extension.ws !== ws) {
        // duplicate arrival: probe the incumbent before deciding (half-open
        // TCP sockets linger after an abrupt service-worker death)
        const alive = extension.ws.open ? await extension.ws.probe(1500) : false;
        if (alive && extension.ws.open) {
          log('refused duplicate extension connection (incumbent is alive)');
          authDecided = true;
          ws.close(1008, 'duplicate extension connection');
          return;
        }
        log('incumbent extension connection is dead, replacing');
        try { extension.ws.close(1000, 'replaced'); } catch {}
      }
      authDecided = true;
      authenticated = true;
      role = r;
      if (r === 'extension') {
        extension = { ws, info: null, lastFrame: Date.now() };
        log('extension connected');
      } else {
        wsAgents.add({ ws, send: (o) => ws.send(JSON.stringify(o)) });
        log('agent connected (ws)');
      }
      // replay frames that arrived while auth was being decided (e.g. hello)
      for (const m of preAuthFrames.splice(0)) handleWsFrame(m);
    };

    if (protocol === `ubb-auth.${TOKEN}`) finishAuth('extension');
    else if (protocol === `ubb-agent.${TOKEN}`) finishAuth('agent');
    else if (meta?.offeredAny) {
      // offered a subprotocol but neither matched → reject immediately
      log('rejected bad subprotocol');
      ws.close(1008, 'authentication failed');
      return;
    } else {
      // no subprotocol: first message must be {"method":"auth","params":{"token","role"}}
      authTimer = setTimeout(() => ws.close(1008, 'auth timeout'), 5000);
    }

    ws.onclose = () => {
      clearTimeout(authTimer);
      if (role === 'extension' && extension && extension.ws === ws) {
        extension = null;
        log('extension disconnected');
        for (const [intId, r] of routes) {
          r.agent.send({ id: r.agentId, error: { code: 'EXTENSION_DISCONNECTED', message: 'extension went away' } });
          routes.delete(intId);
        }
      } else if (role === 'agent') {
      for (const a of [...wsAgents]) {
        if (a.ws === ws) {
          wsAgents.delete(a);
          // fail this agent's in-flight calls so it doesn't hang
          for (const [intId, r] of routes) {
            if (r.agent === a) {
              routes.delete(intId);
              r.agent.send = () => {};
            }
          }
        }
      }
        log('agent disconnected (ws)');
      }
    };

    ws.onmessage = (text) => {
      let msg;
      try {
        msg = JSON.parse(text);
      } catch {
        return;
      }
      if (!authenticated) {
        if (msg?.method === 'auth' && msg?.params?.token === TOKEN) {
          finishAuth(msg.params.role === 'agent' ? 'agent' : 'extension');
        } else if (authDecided) {
          ws.close(1008, 'authentication failed');
        } else {
          preAuthFrames.push(msg); // arrived during the incumbent probe
        }
        return;
      }
      handleWsFrame(msg);
    };

    const handleWsFrame = (msg) => {
      if (role === 'extension') {
        if (extension && extension.ws === ws) extension.lastFrame = Date.now();
        handleExtensionMessage(msg);
      } else {
        const wrapper = [...wsAgents].find((a) => a.ws === ws);
        handleAgentMessage(wrapper || { send: (o) => ws.send(JSON.stringify(o)) }, msg);
      }
    };
  },
});

function handleExtensionMessage(msg) {
  if (!extension) return;
  const ws = extension.ws;
  if (msg.method === 'ping') {
    ws.send(JSON.stringify({ method: 'pong' }));
    return;
  }
  if (msg.method === 'hello') {
    const pv = msg.params?.protocol_version || '1.0';
    const min = msg.params?.min_compatible || '1.0';
    if (major(min) > 1) {
      ws.send(JSON.stringify({ id: msg.id, error: { code: 'version_skew', message: `daemon supports 1.x, extension wants ${pv}+` } }));
      return;
    }
    extension.info = msg.params;
    ws.send(JSON.stringify({ id: msg.id, result: { protocol_version: '1.0', daemon: 'ubb-bridge 1.0.0' } }));
    broadcast({ method: 'event.extension.connected', params: { info: extension.info } });
    return;
  }
  if (msg.id != null && (msg.result !== undefined || msg.error !== undefined)) {
    const route = routes.get(msg.id);
    if (route) {
      routes.delete(msg.id);
      const { id: _drop, ...rest } = msg;
      route.agent.send({ id: route.agentId, ...rest });
    }
    return;
  }
  if (msg.method) broadcast(msg); // events → all agents
}

// half-open watchdog: if the extension went silent, probe and drop if dead,
// so agent requests fail fast instead of timing out into a corpse socket
setInterval(async () => {
  if (!extension || !extension.ws.open) return;
  if (Date.now() - (extension.lastFrame || 0) < 45000) return;
  const alive = await extension.ws.probe(1200);
  if (alive) {
    extension.lastFrame = Date.now();
  } else {
    log('extension idle watchdog: dropping dead connection');
    try { extension.ws.close(); } catch {}
    extension = null;
  }
}, 15000);

server.listen(PORT, '127.0.0.1', () => {
  log(`listening on ws://127.0.0.1:${PORT}/ (token ${TOKEN.slice(0, 4)}…)`);
  stdioAgent.send({ method: 'event.daemon.ready', params: { port: PORT } });
});
server.on('error', (e) => {
  log('server error', e.message);
  process.exit(1);
});

// ---------------------------------------------------------------- stdio agent

let stdinBuf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  stdinBuf += chunk;
  let idx;
  while ((idx = stdinBuf.indexOf('\n')) >= 0) {
    const line = stdinBuf.slice(0, idx).trim();
    stdinBuf = stdinBuf.slice(idx + 1);
    if (line) {
      if (line === '{') continue; // tolerate pretty-printed first brace
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        stdioAgent.send({ id: null, error: { code: 'BAD_JSON', message: 'stdin lines must be one JSON object per line' } });
        continue;
      }
      handleAgentMessage(stdioAgent, msg);
    }
  }
});
process.stdin.on('end', () => {
  log('stdin closed; daemon stays alive for WS agents (use `ubb daemon stop` to stop)');
});

function major(v) {
  return Number(String(v).split('.')[0]) || 0;
}
