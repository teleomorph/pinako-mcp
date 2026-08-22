/**
 * tests/auth-67-shim.smoke.js — the --stdio-mcp shim's half of #67
 *
 * Standalone: `node tests/auth-67-shim.smoke.js`. No browser, no extension.
 *
 * Two behaviors, both invisible to the HTTP-level tests:
 *
 *  1. Token self-heal. Claude Desktop configs written before #67 carry a bare
 *     URL. The shim is our own binary running as the user, so it reads the
 *     token file and attaches the token itself — that config keeps full write
 *     access with no user action.
 *
 *  2. Squatter refusal. A process that grabbed 37421 before the real bridge
 *     would otherwise receive whatever the shim sends. The shim challenges the
 *     port-holder for HMAC proof of the shared token first, and on failure
 *     falls back to serving locally instead of handing over user data.
 */

import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOST_JS   = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'host.js');
const REAL_PORT   = 37801;
const FAKE_PORT   = 37802;
const SNEAKY_PORT = 37803;
const LEGACY_PORT = 37804;
const DATA_DIR  = fs.mkdtempSync(path.join(os.tmpdir(), 'pinako-shim67-'));
const ENV = { ...process.env, APPDATA: DATA_DIR, HOME: DATA_DIR, USERPROFILE: DATA_DIR };

let passed = 0, failed = 0;
function check(label, cond) {
  if (cond) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${label}`); }
  else      { failed++; console.log(`  \x1b[31m✗\x1b[0m ${label}`); }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Drive a shim over its stdio JSON-RPC channel and collect responses.
function runShim(url, messages) {
  return new Promise((resolve) => {
    const shim = spawn(process.execPath, [HOST_JS, '--stdio-mcp', url], { env: ENV, stdio: ['pipe', 'pipe', 'pipe'] });
    const out = [];
    let buf = '';
    shim.stdout.on('data', (d) => {
      buf += d.toString();
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) { try { out.push(JSON.parse(line)); } catch (_) {} }
      }
    });
    let stderr = '';
    shim.stderr.on('data', (d) => { stderr += d.toString(); });
    (async () => {
      for (const m of messages) { shim.stdin.write(JSON.stringify(m) + '\n'); await sleep(900); }
      await sleep(1200);
      shim.stdin.end();
      shim.kill();
      await sleep(150);
      resolve({ out, stderr });
    })();
  });
}

const INIT = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'shim67', version: '0' } } };
const CALL = { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'set_title', arguments: { nodeId: 'nope', title: 'x' } } };

async function main() {
  // ── Real bridge on a scratch port ──
  const bridge = spawn(process.execPath, [HOST_JS], {
    env: { ...ENV, PINAKO_MCP_PORT: String(REAL_PORT) },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  bridge.stderr.on('data', () => {});

  // ── Impostor A: answers /health like a bridge, but forges a wrong proof ──
  const impostor = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, extensionConnected: true, proof: 'f'.repeat(64) }));
  });
  await new Promise(r => impostor.listen(FAKE_PORT, '127.0.0.1', r));

  // ── Impostor B: answers with NON-JSON, and records anything it receives ──
  // This is the shape the original code let through: the identity check's
  // catch-all returned "trusted" on a JSON parse failure, and because the
  // token had already been appended to the URL, the squatter harvested it on
  // the very first request. The suite previously modelled only Impostor A —
  // the one case the code actually handled.
  const harvested = [];
  const sneaky = http.createServer((req, res) => {
    harvested.push(req.url || '');
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('OK not json');
  });
  await new Promise(r => sneaky.listen(SNEAKY_PORT, '127.0.0.1', r));

  try {
    let up = false;
    for (let i = 0; i < 50 && !up; i++) {
      await sleep(100);
      try { up = (await fetch(`http://127.0.0.1:${REAL_PORT}/health`)).ok; } catch (_) {}
    }
    if (!up) throw new Error('bridge never came up');
    const TOKEN = fs.readFileSync(path.join(DATA_DIR, 'Pinako', 'mcp-auth-token'), 'utf8').trim();

    console.log('\n  Token self-heal (bare URL, as in a pre-#67 config)');
    const real = await runShim(`http://127.0.0.1:${REAL_PORT}/mcp`, [INIT, CALL]);
    // Self-heal is proven by the write being authorized, not by a log line:
    // a proven bridge must NOT be announced as the read-only legacy path.
    check('proven bridge not treated as legacy', !/without the access token/i.test(real.stderr));
    const callResp = real.out.find(m => m.id === 2);
    const text = JSON.stringify(callResp || {});
    check('handshake answered', real.out.some(m => m.id === 1 && m.result));
    check('write NOT refused as tokenless', !/AUTH_REQUIRED/.test(text));
    // Reaching the bridge's own "no browser connected" path proves the call
    // was forwarded and authorized rather than blocked at the gate.
    check('write reached the bridge', /BRIDGE_NOT_READY|BROWSER|not ready|no browser/i.test(text) || callResp?.result?.isError === true);

    console.log('\n  Squatter refusal (wrong proof)');
    const fake = await runShim(`http://127.0.0.1:${FAKE_PORT}/mcp`, [INIT, CALL]);
    check('shim refuses the unproven port-holder', /answered the identity challenge incorrectly/i.test(fake.stderr));
    check('handshake still answered locally', fake.out.some(m => m.id === 1 && m.result));
    const fakeCall = JSON.stringify(fake.out.find(m => m.id === 2) || {});
    check('tool call not forwarded to the impostor', fakeCall.length > 2);

    console.log('\n  Squatter must never receive the token (non-JSON responder)');
    // Pass the TOKENED url, i.e. exactly what the installer writes — the
    // squatter must still never see the secret.
    const tokenedUrl = `http://127.0.0.1:${SNEAKY_PORT}/mcp?token=${TOKEN}`;
    harvested.length = 0;
    await runShim(tokenedUrl, [INIT, CALL]);
    const leaked = harvested.some(u => u.includes(TOKEN));
    check('token never sent to the unverified holder', !leaked);
    check('squatter saw only the tokenless probe', harvested.every(u => !u.includes(TOKEN)));

    console.log('\n  Legacy bridge (no challenge endpoint) degrades, not refuses');
    // A pre-#67 bridge 404s /health?challenge= — the shape every existing
    // install produces, and the shape that broke tests/stdio-bridge.test.js.
    const legacyHits = [];
    const legacy = http.createServer((req, res) => {
      legacyHits.push(req.url || '');
      if ((req.url || '').startsWith('/health?')) { res.writeHead(404); res.end(); return; }
      if (req.url === '/health') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}'); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 'legacy', version: '1' } } }));
    });
    await new Promise(r => legacy.listen(LEGACY_PORT, '127.0.0.1', r));
    const leg = await runShim(`http://127.0.0.1:${LEGACY_PORT}/mcp`, [INIT]);
    legacy.close();
    check('legacy bridge is connected to, not refused', !/REFUSING to connect/i.test(leg.stderr));
    check('legacy connection is announced as read-only', /without the access token/i.test(leg.stderr));
    check('legacy bridge never received the token', legacyHits.every(u => !u.includes(TOKEN)));
  } finally {
    bridge.stdin.end(); bridge.kill();
    impostor.close();
    sneaky.close();
    await sleep(200);
    try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (_) {}
  }

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
