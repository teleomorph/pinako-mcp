/**
 * tests/forwarder-reregister.smoke.js — a follower Bridge survives a leader change
 *
 * Standalone: `node tests/forwarder-reregister.smoke.js`. No browser, no
 * extension: it spawns real host.js processes on a scratch port with an
 * isolated data dir, and plays each one's browser over native messaging.
 *
 * The defect this pins (found live 2026-09-25): a follower Bridge registers its
 * browser with the leader only by relaying tree data (POST /update, carrying
 * its forwarderToken), and the leader keeps that registration in memory. When
 * the leader changed hands, the new leader had never heard of the surviving
 * follower. The follower's edit channel then failed with HTTP 401
 * TOKEN_REQUIRED every 5 seconds, and nothing re-sent the registration until
 * that browser happened to change a tab. Until then no AI client could see or
 * write that browser at all: 776 rejected attempts in one day of a real log,
 * and that Chrome missing from list_browsers.
 *
 * Two ways the leader changes hands, both seen live:
 *   Phase 1 — the leader process dies and a follower takes the port.
 *   Phase 2 — the leader's browser reconnects its native port. The new Bridge
 *             for that browser relays to the old leader, which exits as stale
 *             and takes that relay with it; either survivor may win the port.
 * After each, every surviving browser must be listed by the leader AND reachable
 * for writes, without its browser having to push anything first.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOST_JS  = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'host.js');
const PORT     = 37788;                       // scratch port, not the real 37421
const BASE     = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pinako-fwd-rereg-'));
const LOG_FILE = path.join(DATA_DIR, 'Pinako', 'pinako-mcp.log');

let passed = 0, failed = 0;
function check(label, actual, expected) {
  const ok = actual === expected;
  if (ok) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${label}`); }
  else    { failed++; console.log(`  \x1b[31m✗\x1b[0m ${label}\n      expected: ${expected}\n      actual:   ${actual}`); }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Every knob host.js (and a host extension, when this checkout has one) reads
// is a PINAKO_* variable: strip any the developer's shell carries. Then point
// every data root at the scratch dir so nothing here can touch the real token,
// archive or log. All bridges share ONE data dir on purpose: a follower only
// relays to a leader that proves it holds the same access token.
const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('PINAKO_')));
const ENV = {
  ...baseEnv,
  PINAKO_MCP_PORT: String(PORT),
  APPDATA: DATA_DIR, LOCALAPPDATA: DATA_DIR, HOME: DATA_DIR, USERPROFILE: DATA_DIR,
  PINAKO_NO_SHELL_OPEN: '1', PINAKO_EMB_DISABLE: '1', PINAKO_FTS_DISABLE: '1', PINAKO_MIGRATE_DISABLE: '1',
};

// Distinct in their first 16 characters: host.js logs browser ids truncated
// to 16, and phase 2 reads the log to tell the leader from the follower.
const ID = { a: 'browserA-test-0001', b: 'browserB-test-0002', c: 'browserC-test-0003' };

const bridges = [];

// One host.js plus a fake extension on the other end of its native port. The
// fake answers the two messages the way the real service worker does:
// getTree -> a full treeResponse snapshot, applyEdit -> editApplied. It never
// pushes a treeUpdate on its own, which is exactly the idle browser that
// stayed invisible after a handover.
function spawnBridge(label, browserId, brand) {
  const child = spawn(process.execPath, [HOST_JS], { env: ENV, stdio: ['pipe', 'pipe', 'pipe'] });
  const b = { label, browserId, brand, child, getTrees: 0, exited: false };
  child.on('exit', () => { b.exited = true; });
  child.stderr.on('data', () => {});
  const send = (obj) => {
    const body = Buffer.from(JSON.stringify(obj), 'utf8');
    const hdr = Buffer.alloc(4); hdr.writeUInt32LE(body.length, 0);
    try { child.stdin.write(Buffer.concat([hdr, body])); } catch (_) {}
  };
  let buf = Buffer.alloc(0);
  child.stdout.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 4) {
      const n = buf.readUInt32LE(0);
      if (buf.length < 4 + n) break;
      let msg = null;
      try { msg = JSON.parse(buf.slice(4, 4 + n).toString('utf8')); } catch (_) {}
      buf = buf.slice(4 + n);
      if (!msg) continue;
      if (msg.type === 'getTree') {
        b.getTrees++;
        send({
          type: 'treeResponse', browserId, browserBrand: brand, userTier: 4, userId: '',
          data: {
            tree: [{ id: `${label}-w1`, type: 'window', title: `${brand} window`, children: [] }],
            libraries: [], globalNotes: [], bookmarks: [], libraryGroups: [], libraryPanelOrder: [], docs: [],
          },
        });
      } else if (msg.type === 'applyEdit') {
        send({ type: 'editApplied', requestId: msg.requestId, result: { ok: true, requestId: msg.requestId } });
      }
    }
  });
  bridges.push(b);
  return b;
}

let TOKEN = null;
async function knownBrowsers() {
  try {
    const j = await (await fetch(`${BASE}/health?token=${TOKEN}`)).json();
    return (j.browsers || []).map(x => x.browserId).sort();
  } catch (_) { return []; }
}
async function waitFor(pred, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await pred()) return true; await sleep(250); }
  return false;
}
async function writeTo(browserId) {
  try {
    const r = await fetch(`${BASE}/edit?token=${TOKEN}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ browser: browserId, op: { type: 'set_title', nodeId: 'x', title: 'probe' } }),
    });
    const j = await r.json();
    return j && j.ok === true ? 'ok' : `${r.status} ${j?.error?.code || JSON.stringify(j)}`;
  } catch (e) { return `ERR ${e.message}`; }
}
const same = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
const logSize = () => { try { return fs.statSync(LOG_FILE).size; } catch (_) { return 0; } };
const logSince = (offset) => { try { return fs.readFileSync(LOG_FILE, 'utf8').slice(offset); } catch (_) { return ''; } };

async function main() {
  const A = spawnBridge('a', ID.a, 'TestA');
  const up = await waitFor(async () => { try { return (await fetch(`${BASE}/health`)).ok; } catch (_) { return false; } }, 10_000);
  if (!up) throw new Error(`host.js never came up on ${PORT}`);
  TOKEN = fs.readFileSync(path.join(DATA_DIR, 'Pinako', 'mcp-auth-token'), 'utf8').trim();

  const B = spawnBridge('b', ID.b, 'TestB');
  const C = spawnBridge('c', ID.c, 'TestC');

  console.log('\n  Baseline: one leader, two followers');
  check('the leader lists all three browsers',
    await waitFor(async () => same(await knownBrowsers(), [ID.a, ID.b, ID.c]), 20_000), true);
  check('a write reaches follower B', await waitFor(async () => (await writeTo(ID.b)) === 'ok', 15_000), true);
  check('a write reaches follower C', await waitFor(async () => (await writeTo(ID.c)) === 'ok', 15_000), true);

  // ── Phase 1: the leader dies, a follower takes the port ──
  console.log('\n  Phase 1: the leader process dies');
  A.child.kill();
  const healed1 = await waitFor(async () => same(await knownBrowsers(), [ID.b, ID.c]), 45_000);
  check('the new leader lists BOTH surviving browsers', healed1, true);
  if (!healed1) console.log(`      the leader lists: ${JSON.stringify(await knownBrowsers())}`);
  const mark = logSize();
  check('a write reaches B after the handover', await writeTo(ID.b), 'ok');
  check('a write reaches C after the handover', await writeTo(ID.c), 'ok');

  // ── Phase 2: the leader's browser reconnects its native port ──
  // Tell the leader from the follower by how the write above arrived: an edit
  // for a follower's browser crosses the /edits channel, and the follower logs
  // "SSE applyEdit … for browserId=<its id>". The leader's own does not.
  console.log('\n  Phase 2: the leader\'s browser reconnects (stale-leader exit)');
  if (!healed1) {
    check('phase 2 skipped: phase 1 never produced a working pair', false, true);
    return;
  }
  const viaSse = logSince(mark);
  const bIsFollower = viaSse.includes(`SSE applyEdit`) && viaSse.includes(`for browserId=${ID.b.slice(0, 16)}`);
  const leader = bIsFollower ? C : B;
  const follower = bIsFollower ? B : C;
  console.log(`      leader is ${leader.label.toUpperCase()}, follower is ${follower.label.toUpperCase()}`);
  const fresh = spawnBridge(`${leader.label}2`, leader.browserId, leader.brand);
  check('the old leader exits when its browser reconnects',
    await waitFor(async () => leader.exited, 15_000), true);
  const healed2 = await waitFor(async () => {
    if (!same(await knownBrowsers(), [leader.browserId, follower.browserId])) return false;
    return (await writeTo(leader.browserId)) === 'ok' && (await writeTo(follower.browserId)) === 'ok';
  }, 45_000);
  check('after the reconnect the leader lists and reaches both browsers', healed2, true);
  if (!healed2) {
    console.log(`      the leader lists: ${JSON.stringify(await knownBrowsers())}; fresh bridge exited=${fresh.exited}`);
    console.log(`      write to ${leader.label}: ${await writeTo(leader.browserId)}; to ${follower.label}: ${await writeTo(follower.browserId)}`);
  }

  // ── No storm ──
  // Re-registering asks the browser for a full snapshot, bookmarks included,
  // so it has to be a one-off per handover rather than one per 5 s retry.
  // Budget per process: its start-up snapshot, one on promotion, one re-register.
  console.log('\n  Re-registration is not a storm');
  const counts = bridges.map(x => `${x.label}:${x.getTrees}`).join(' ');
  check(`no Bridge asked its browser for more than 3 snapshots (${counts})`,
    bridges.every(x => x.getTrees <= 3), true);
}

main()
  .catch((e) => { failed++; console.error(e); })
  .finally(async () => {
    for (const b of bridges) { try { b.child.stdin.end(); } catch (_) {} try { b.child.kill(); } catch (_) {} }
    await sleep(300);
    if (failed && process.env.KEEP_LOG) {
      try { fs.copyFileSync(LOG_FILE, process.env.KEEP_LOG); } catch (_) {}
    }
    try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (_) {}
    console.log(`\n  ${passed} passed, ${failed} failed\n`);
    process.exit(failed === 0 ? 0 : 1);
  });
