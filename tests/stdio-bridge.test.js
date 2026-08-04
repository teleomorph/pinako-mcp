// Tests for the --stdio-mcp shim's bridge-down resilience (host.js
// runStdioBridge). Unlike the rest of tests/, these need NO live bridge and no
// browser: each test spawns `node host.js --stdio-mcp http://127.0.0.1:<port>/mcp`
// against a port we control (dead, or served by an in-test stub bridge) and
// drives newline-delimited JSON-RPC over the child's stdio.
import { describe, it, expect, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const HOST_JS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'host.js');

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

// Minimal Streamable-HTTP MCP bridge stub. `rotateOnFirstToolCall` simulates
// the W-4 leader rotation: the first tools/call on an established session gets
// the bridge's 404 stale-session body, after which the session is forgotten
// and a re-initialize is required.
function startStub(port, { rotateOnFirstToolCall = false } = {}) {
  const state = { sessions: new Set(), toolCalls: 0, initializes: 0, rotated: false };
  const server = http.createServer((req, res) => {
    if (req.url !== '/mcp' || req.method !== 'POST') { res.writeHead(404); res.end(); return; }
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let msg = {};
      try { msg = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (_) {}
      const sid = req.headers['mcp-session-id'];
      if (msg.method === 'initialize') {
        state.initializes++;
        const newSid = randomUUID();
        state.sessions.add(newSid);
        res.writeHead(200, { 'Content-Type': 'application/json', 'mcp-session-id': newSid });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {
          protocolVersion: msg.params?.protocolVersion || '2025-03-26',
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: 'stub-bridge', version: '0.0.1' },
        }}));
        return;
      }
      if (msg.method === undefined || msg.id === undefined) { res.writeHead(202); res.end(); return; }
      if (sid && !state.sessions.has(sid)) {
        // Mirrors the real bridge's stale-session answer (Slice W spec compliance).
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32001, message: 'Session not found — reinitialize.' } }));
        return;
      }
      if (msg.method === 'tools/call') {
        state.toolCalls++;
        if (rotateOnFirstToolCall && !state.rotated) {
          state.rotated = true;
          state.sessions.delete(sid); // leader died; session gone
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32001, message: 'Session not found — reinitialize.' } }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'STUB BRIDGE EXECUTED THIS' }] } }));
        return;
      }
      if (msg.method === 'tools/list') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'stub_tool', description: 'stub', inputSchema: { type: 'object' } }] } }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }));
    });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ server, state })));
}

// Drives one shim child process; collects stdout JSON messages + stderr text.
function spawnShim(port) {
  const child = spawn(process.execPath, [HOST_JS, '--stdio-mcp', `http://127.0.0.1:${port}/mcp`], {
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd: path.dirname(HOST_JS),
  });
  const messages = [];
  const stderr = [];
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d.toString();
    let idx;
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      try { messages.push(JSON.parse(line)); } catch (_) { messages.push({ UNPARSEABLE: line }); }
    }
  });
  child.stderr.on('data', (d) => stderr.push(d.toString()));
  const send = (obj) => child.stdin.write(JSON.stringify(obj) + '\n');
  const waitFor = (pred, timeoutMs = 10000) => new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      const hit = messages.find(pred);
      if (hit) return resolve(hit);
      if (Date.now() - t0 > timeoutMs) return reject(new Error(`timed out waiting; saw: ${JSON.stringify(messages).slice(0, 2000)}\nstderr: ${stderr.join('')}`));
      setTimeout(tick, 50);
    };
    tick();
  });
  return { child, messages, stderr, send, waitFor };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const INIT = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '0' } } };

let cleanup = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0)) { try { await fn(); } catch (_) {} }
});

describe('--stdio-mcp shim resilience', () => {
  it('completes the handshake, serves the catalog, and fails tool calls gracefully with NOTHING listening', async () => {
    const port = await getFreePort();
    const shim = spawnShim(port);
    cleanup.push(() => shim.child.kill());

    shim.send(INIT);
    const init = await shim.waitFor((m) => m.id === 1 && m.result);
    expect(init.result.serverInfo.name).toBe('pinako');
    expect(init.result.capabilities.tools).toBeTruthy();

    shim.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    shim.send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    const list = await shim.waitFor((m) => m.id === 2 && m.result);
    expect(list.result.tools.length).toBeGreaterThan(10); // full local catalog, not empty

    shim.send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_tree_summary', arguments: {} } });
    const call = await shim.waitFor((m) => m.id === 3 && m.result);
    expect(call.result.isError).toBe(true);
    expect(call.result.content[0].text).toMatch(/NOT executed/);
    // Handshake/catalog/call must never surface as JSON-RPC errors (that's
    // what painted the client's attach banner).
    expect(shim.messages.filter((m) => m.error)).toEqual([]);
  }, 30000);

  it('reconnects transparently when the bridge comes up mid-session and emits tools/list_changed', async () => {
    const port = await getFreePort();
    const shim = spawnShim(port);
    cleanup.push(() => shim.child.kill());

    shim.send(INIT);
    await shim.waitFor((m) => m.id === 1 && m.result);
    shim.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    shim.send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    await shim.waitFor((m) => m.id === 2 && m.result); // local catalog while down

    const { server, state } = await startStub(port);
    cleanup.push(() => new Promise((r) => server.close(r)));
    await sleep(3500); // sit out the down-cooldown so the lazy connect fires

    shim.send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'stub_tool', arguments: {} } });
    const call = await shim.waitFor((m) => m.id === 3 && m.result, 15000);
    expect(call.result.content[0].text).toBe('STUB BRIDGE EXECUTED THIS');
    expect(call.result.isError).toBeUndefined();

    // Catalog was served locally while down → the shim must tell the client
    // to re-list once the live bridge is reachable.
    await shim.waitFor((m) => m.method === 'notifications/tools/list_changed', 15000);

    shim.send({ jsonrpc: '2.0', id: 4, method: 'tools/list', params: {} });
    const list = await shim.waitFor((m) => m.id === 4 && m.result);
    expect(list.result.tools[0].name).toBe('stub_tool'); // now the live bridge's catalog
    expect(state.initializes).toBeGreaterThanOrEqual(1); // shim-originated session
  }, 40000);

  it('re-handshakes transparently on a stale session (leader rotation) and retries the request once', async () => {
    const port = await getFreePort();
    const { server, state } = await startStub(port, { rotateOnFirstToolCall: true });
    cleanup.push(() => new Promise((r) => server.close(r)));
    const shim = spawnShim(port);
    cleanup.push(() => shim.child.kill());

    shim.send(INIT);
    await shim.waitFor((m) => m.id === 1 && m.result);
    shim.send({ jsonrpc: '2.0', method: 'notifications/initialized' });

    // First tools/call gets the -32001 stale-session 404; the shim must
    // rebuild the session and retry so the CLIENT sees only a clean success.
    shim.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'stub_tool', arguments: {} } });
    const call = await shim.waitFor((m) => m.id === 2 && m.result, 20000);
    expect(call.result.content[0].text).toBe('STUB BRIDGE EXECUTED THIS');
    expect(state.initializes).toBeGreaterThanOrEqual(2); // original session + re-handshake
    expect(state.toolCalls).toBe(2); // rotated call + transparent retry
    expect(shim.messages.filter((m) => m.error)).toEqual([]);
  }, 40000);
});
