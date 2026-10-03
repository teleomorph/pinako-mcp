/**
 * tests/mcp-session-idle.smoke.js — idle MCP sessions are closed (2026-10-03)
 *
 * Standalone: `node tests/mcp-session-idle.smoke.js`. Needs NO browser and NO
 * extension: it spawns its own host.js on scratch ports with an isolated data
 * dir, like auth-67.smoke.js, so it never touches a live bridge.
 *
 * Why: a session used to end only on DELETE, which most AI apps never send, so
 * the leader kept every session it ever served (1,162 of them, 3.2 GB, after
 * 32 hours on the dev machine). Pins the rule in host.js "Idle MCP sessions
 * are closed":
 *   1. a session with no open request for the idle time is closed, and then
 *      answers 404 (the spec's "initialize again");
 *   2. a session whose GET push stream is open is never closed;
 *   3. past the idle cap, the oldest idle session is closed first.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOST_JS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'host.js');

let passed = 0, failed = 0;
function check(label, actual, expected) {
  const ok = actual === expected;
  if (ok) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${label}`); }
  else    { failed++; console.log(`  \x1b[31m✗\x1b[0m ${label}\n      expected: ${expected}\n      actual:   ${actual}`); }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function startHost(port, env) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pinako-idle-'));
  const child = spawn(process.execPath, [HOST_JS], {
    env: {
      ...process.env,
      PINAKO_MCP_PORT: String(port),
      APPDATA: dataDir, LOCALAPPDATA: dataDir, HOME: dataDir, USERPROFILE: dataDir,
      ...env,
    },
    stdio: ['pipe', 'pipe', 'pipe'],   // stdin stays OPEN: closing it shuts the host down
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', () => {});
  const base = `http://127.0.0.1:${port}`;
  let up = false;
  for (let i = 0; i < 80 && !up; i++) {
    await sleep(100);
    try { up = (await fetch(`${base}/health`)).ok; } catch (_) {}
  }
  if (!up) throw new Error(`host.js never came up on ${port}`);
  const token = fs.readFileSync(path.join(dataDir, 'Pinako', 'mcp-auth-token'), 'utf8').trim();
  const url = `${base}/mcp?token=${token}`;
  const stop = async () => {
    child.stdin.end();
    child.kill();
    await sleep(200);
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (_) {}
  };
  return { url, stop };
}

const HEADERS = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };

async function openSession(url) {
  const r = await fetch(url, {
    method: 'POST', headers: HEADERS,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'idle-smoke', version: '1' } } }),
  });
  await r.text();
  const sid = r.headers.get('mcp-session-id');
  if (!sid) throw new Error(`initialize returned no session id (status ${r.status})`);
  const n = await fetch(url, { method: 'POST', headers: { ...HEADERS, 'mcp-session-id': sid },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
  await n.text();
  return sid;
}

async function listTools(url, sid) {
  const r = await fetch(url, { method: 'POST', headers: { ...HEADERS, 'mcp-session-id': sid },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) });
  await r.text();
  return r.status;
}

async function main() {
  // ── 1 + 2: the idle time closes a quiet session, never one with a push stream ──
  console.log('\n  A quiet session is closed; one holding its push stream is not');
  const h1 = await startHost(37812, { PINAKO_MCP_SESSION_IDLE_MS: '400' });
  const streams = [];
  try {
    const quiet = await openSession(h1.url);
    const live  = await openSession(h1.url);
    const ac = new AbortController();
    streams.push(ac);
    const push = await fetch(h1.url, { method: 'GET', signal: ac.signal,
      headers: { Accept: 'text/event-stream', 'mcp-session-id': live } });
    check('the push stream opens', push.status, 200);
    check('the quiet session works before it goes idle', await listTools(h1.url, quiet), 200);

    await sleep(700);                       // past the 400 ms idle time
    const fresh = await openSession(h1.url); // creating a session runs the sweep
    check('the quiet session answers 404 once it has been idle too long', await listTools(h1.url, quiet), 404);
    check('the session with an open push stream is kept', await listTools(h1.url, live), 200);
    check('the session just created is kept', await listTools(h1.url, fresh), 200);

    ac.abort();                              // the client goes away
    await sleep(700);
    await openSession(h1.url);
    check('once its push stream closes, that session is closed after the idle time too', await listTools(h1.url, live), 404);
  } finally {
    for (const ac of streams) { try { ac.abort(); } catch (_) {} }
    await h1.stop();
  }

  // ── 3: the idle cap closes the oldest idle session first ──
  console.log('\n  Past the idle cap the oldest idle session goes first');
  const h2 = await startHost(37813, { PINAKO_MCP_SESSION_IDLE_MAX: '3' });
  try {
    const ids = [];
    for (let i = 0; i < 4; i++) { ids.push(await openSession(h2.url)); await sleep(20); }
    // The 4th creation saw 3 idle sessions (not over the cap): all four live.
    check('at the cap, nothing is closed', await listTools(h2.url, ids[0]), 200);
    await sleep(20);
    ids.push(await openSession(h2.url));     // idle now: 1, 2, 3, 0 (0 was just touched) → 4 > 3
    check('over the cap, the least recently used session is closed', await listTools(h2.url, ids[1]), 404);
    check('…and the one used just before is kept', await listTools(h2.url, ids[0]), 200);
    check('…and so are the others', `${await listTools(h2.url, ids[2])}/${await listTools(h2.url, ids[3])}/${await listTools(h2.url, ids[4])}`, '200/200/200');
  } finally {
    await h2.stop();
  }

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
