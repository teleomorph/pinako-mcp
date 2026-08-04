/**
 * tests/auth-67.smoke.js — local HTTP auth surface (ai-todo #67)
 *
 * Standalone: `node tests/auth-67.smoke.js`. Unlike the vitest suites in this
 * folder it needs NO browser and NO extension — it spawns its own host.js on
 * a scratch port with an isolated data dir (APPDATA/HOME redirected), so it
 * never touches the developer's real token or collides with a live bridge.
 *
 * Covers the three things the design promises:
 *   Tier A — loopback-only: bad Host and any browser Origin are refused.
 *   Tier B — a tokenless connection reads but cannot write; a tokened one can.
 *   Squat  — /health answers an HMAC challenge only a token-holder can forge.
 */

import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HOST_JS  = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'host.js');
const PORT     = 37799;                       // scratch port, not the real 37421
const BASE     = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pinako-auth67-'));

let passed = 0, failed = 0;
function check(label, actual, expected) {
  const ok = actual === expected;
  if (ok) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${label}`); }
  else    { failed++; console.log(`  \x1b[31m✗\x1b[0m ${label}\n      expected: ${expected}\n      actual:   ${actual}`); }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function status(url, opts) {
  try { return (await fetch(url, opts)).status; }
  catch (e) { return `ERR ${e.message}`; }
}

// `Host` is a forbidden header name for fetch(), which silently drops an
// override — so the rebinding case has to go out over raw http.
function rawStatus(pathname, headers) {
  return new Promise((resolve) => {
    const req = http.request({ hostname: '127.0.0.1', port: PORT, path: pathname, method: 'GET', headers },
      (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', (e) => resolve(`ERR ${e.message}`));
    req.end();
  });
}
async function main() {
  const child = spawn(process.execPath, [HOST_JS], {
    env: {
      ...process.env,
      PINAKO_MCP_PORT: String(PORT),
      APPDATA: DATA_DIR,        // win32 data dir
      HOME: DATA_DIR,           // posix data dir
      USERPROFILE: DATA_DIR,
    },
    stdio: ['pipe', 'pipe', 'pipe'],   // stdin stays OPEN: closing it shuts the host down
  });
  child.stderr.on('data', () => {});   // keep the pipe drained

  try {
    // Wait for the port
    let up = false;
    for (let i = 0; i < 50 && !up; i++) {
      await sleep(100);
      try { up = (await fetch(`${BASE}/health`)).ok; } catch (_) {}
    }
    if (!up) throw new Error(`host.js never came up on ${PORT}`);

    const tokenFile = path.join(DATA_DIR, 'Pinako', 'mcp-auth-token');
    const TOKEN = fs.readFileSync(tokenFile, 'utf8').trim();
    check('token file is 64 hex chars', /^[0-9a-f]{64}$/.test(TOKEN), true);
    if (process.platform !== 'win32') {
      check('token file is 0600', (fs.statSync(tokenFile).mode & 0o777), 0o600);
    }

    console.log('\n  Tier A — loopback only');
    // The DNS-rebinding shape: an attacker page resolves its own hostname to
    // 127.0.0.1, so the request arrives on loopback carrying THEIR Host.
    check('non-loopback Host refused',   await rawStatus('/health', { Host: 'evil.example.com' }), 403);
    check('localhost Host still allowed', await rawStatus('/health', { Host: `localhost:${PORT}` }), 200);
    check('browser Origin refused',      await status(`${BASE}/health`, { headers: { Origin: 'https://evil.example.com' } }), 403);
    check('/debug is gone',              await status(`${BASE}/debug`), 404);

    console.log('\n  /health disclosure');
    const anon = await (await fetch(`${BASE}/health`)).json();
    const auth = await (await fetch(`${BASE}/health?token=${TOKEN}`)).json();
    check('tokenless hides browser ids', Array.isArray(anon.browsers), false);
    check('tokenless still reports up',  anon.ok, true);
    check('tokened exposes browsers',    Array.isArray(auth.browsers), true);

    console.log('\n  Port-squat challenge');
    const nonce = crypto.randomBytes(8).toString('hex');
    const chal  = await (await fetch(`${BASE}/health?challenge=${nonce}`)).json();
    const want  = crypto.createHmac('sha256', TOKEN).update(nonce).digest('hex');
    check('proof matches HMAC(token, nonce)', chal.proof, want);
    const chal2 = await (await fetch(`${BASE}/health?challenge=${nonce}x`)).json();
    check('proof is nonce-bound',             chal2.proof === want, false);

    console.log('\n  POST /edit');
    const editBody = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ op: { type: 'set_title' } }) };
    check('tokenless refused', await status(`${BASE}/edit`, editBody), 401);
    check('bad token refused', await status(`${BASE}/edit?token=deadbeef`, editBody), 401);
    check('bearer header accepted', await status(`${BASE}/edit`, {
      ...editBody, headers: { ...editBody.headers, Authorization: `Bearer ${TOKEN}` },
    }) !== 401, true);

    console.log('\n  Tier B — /mcp');
    const initBody = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'auth67', version: '0' } },
      }),
    };
    check('bad token refused',        await status(`${BASE}/mcp?token=deadbeef`, initBody), 401);
    check('tokened URL still routes', await status(`${BASE}/mcp?token=${TOKEN}`, initBody), 200);

    // Open a TOKENLESS session and exercise the read/write split on it.
    const sess = await fetch(`${BASE}/mcp`, initBody);
    const sid  = sess.headers.get('mcp-session-id');
    const call = async (tool, query = '') => {
      const r = await fetch(`${BASE}/mcp${query}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'mcp-session-id': sid },
        body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: tool, arguments: {} } }),
      });
      const j = await r.json();
      let inner = null;
      try { inner = JSON.parse(j?.result?.content?.[0]?.text); } catch (_) {}
      return { json: j, code: inner?.error?.code ?? null };
    };

    const readAnon  = await call('list_browsers');
    check('tokenless READ works',    readAnon.json?.result?.isError === true, false);
    const writeAnon = await call('set_title');
    check('tokenless WRITE blocked', writeAnon.code, 'AUTH_REQUIRED');
    check('block is in-band (not a protocol error)', writeAnon.json?.result?.isError, true);
    check('block names the fix', /re-run the Pinako AI Bridge installer/i.test(JSON.stringify(writeAnon.json)), true);

    // Same session, now presenting the token: the gate must let it through to
    // real argument validation (which then rejects the empty args).
    const writeAuthed = await call('set_title', `?token=${TOKEN}`);
    check('tokened WRITE passes the gate', writeAuthed.code === 'AUTH_REQUIRED', false);

    // A write tool the annotation table marks read-only would be a silent
    // hole; assert the allowlist is the read set, not a superset.
    const writeish = await call('delete_node');
    check('destructive tool also blocked tokenless', writeish.code, 'AUTH_REQUIRED');

  } finally {
    child.stdin.end();
    child.kill();
    await sleep(200);
    try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (_) {}
  }

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
