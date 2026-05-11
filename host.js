#!/usr/bin/env node
/**
 * pinako-mcp/host.js
 *
 * Dual-role process:
 *  A) Chrome Native Messaging host — talks to the Pinako extension via stdin/stdout
 *     using the 4-byte LE length-prefixed JSON protocol.
 *  B) HTTP MCP server — talks to AI clients (Claude Desktop, Cursor, etc.)
 *     via Streamable HTTP on localhost:37421.
 *
 * The extension pushes tree data over native messaging; MCP tools serve that
 * cached data to AI clients. No Supabase, no network calls.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { z } from 'zod';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID, randomBytes } from 'node:crypto';

// ─── Debug log file ───────────────────────────────────────────────────────────
// Cross-platform log path (host.js is bundled independently — no import from setup/paths.js)
function getLogPath() {
  const home = os.homedir();
  switch (os.platform()) {
    case 'win32':
      return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Pinako', 'pinako-mcp.log');
    case 'linux':
      return path.join(home, '.local', 'share', 'pinako', 'pinako-mcp.log');
    case 'darwin':
      return path.join(home, 'Library', 'Application Support', 'Pinako', 'pinako-mcp.log');
    default:
      return path.join(home, '.pinako', 'pinako-mcp.log');
  }
}
const LOG_PATH = getLogPath();
const recentRequests = []; // last 10 /mcp requests for /debug endpoint
let logDirCreated = false;

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  process.stderr.write(line);
  try {
    if (!logDirCreated) {
      fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
      logDirCreated = true;
    }
    fs.appendFileSync(LOG_PATH, line);
  } catch (_) {}
}

function logRequest(label, req, body) {
  const entry = {
    time: new Date().toISOString(),
    label,
    method: req.method,
    url: req.url,
    headers: req.headers,
    body,
  };
  recentRequests.push(entry);
  if (recentRequests.length > 10) recentRequests.shift();
  log(`${label}: ${req.method} ${req.url} | headers: ${JSON.stringify(req.headers)} | body: ${JSON.stringify(body)}`);
}

const MCP_PORT = 37421;
const STDIN_GRACE_MS = 30_000;

// Per-tier note content character limits. Mirrors NOTE_CHAR_LIMITS in
// Pinako/pinako.js (~line 3673). Phase 3 Slice B: enforced at the MCP write
// tool boundary (this file) for set_note_content and create_note (top-level
// AND inside bulk_apply). Wrapper-side _checkNoteContentTier in pinako.js
// stays as defense-in-depth for in-process callers (chat panel in Phase 4).
const NOTE_CHAR_LIMITS = { 0: 50000, 1: 50000, 2: 150000, 3: 250000, 4: 500000 };

// Last-resort handlers so an uncaught error in any async path is at least
// logged to disk before the process dies. Without these, an async throw in
// the /edit handler or NM listener would crash the host silently from the
// AI Bridge user's perspective.
process.on('uncaughtException', (err) => {
  try { log(`UNCAUGHT EXCEPTION: ${err && err.stack ? err.stack : String(err)}`); } catch (_) {}
});
process.on('unhandledRejection', (reason) => {
  try { log(`UNHANDLED REJECTION: ${reason && reason.stack ? reason.stack : String(reason)}`); } catch (_) {}
});

// ─── Mode detection ───────────────────────────────────────────────────────────
// --stdio-mcp <URL>: act as a stdio MCP server that proxies to a local HTTP MCP
// server. Used by Claude Desktop, whose mcpServers schema only accepts
// command + args (no direct HTTP URLs). Same binary, different mode.
const BRIDGE_URL = (() => {
  const idx = process.argv.indexOf('--stdio-mcp');
  if (idx === -1) return null;
  const url = process.argv[idx + 1];
  if (!url) {
    process.stderr.write('Error: --stdio-mcp requires a URL argument\n');
    process.stderr.write('Usage: pinako-mcp-service --stdio-mcp http://localhost:37421/mcp\n');
    process.exit(1);
  }
  return url;
})();

// ─── In-memory cache (per browser) ────────────────────────────────────────────
// Map<browserId, { tree, libraries, globalNotes, updatedAt, browserId, browserBrand }>.
// Each Pinako install (Chrome, Brave, Edge, etc.) writes to its own entry,
// keyed by the browser-side device id. Tools that take a `browser` arg pick
// one entry; tools called without `browser` while >1 entries exist return an
// "ambiguous, please specify" error so the AI prompts the user.
const cachedData = new Map();
let extensionConnected = false;
let shutdownTimer = null;
let forwardToExisting = null; // set on EADDRINUSE — forward data to old instance then exit

// 2026-05-11: forwarderToken binds an SSE /edits subscription to the
// forwarder process that registered the underlying browser via /update.
// Without it, ANY local process could GET /edits?browserId=X to intercept
// agent writes (full set_note_content payload visible on the wire), evict
// the legitimate forwarder, and POST /edit-result with fake outcomes that
// the leader resolves as the AI client's response.
//
// Threat model: 127.0.0.1 is "local trust" but other processes on the
// machine should NOT see write payloads or be able to spoof outcomes.
// Token-binding closes that gap: only the bridge process that posted
// /update with token T can subscribe to /edits and post /edit-result
// for that browserId.
//
// Forwarder side: generates one random token at startup; sends it on every
// /update POST and on the /edits subscribe + /edit-result POST.
// Leader side: stores the most recent token per browserId; validates on
// every /edits and /edit-result.
const _myForwarderToken = randomBytes(16).toString('hex');

// ─── Phase 2 Slice A: applyEdit pending registry ──────────────────────────────
// Tracks in-flight applyEdit RPCs from the HTTP /edit endpoint (and future MCP
// write tools in Phase 3). Each entry resolves when the matching editApplied /
// editFailed message arrives back over NM, or rejects on timeout. Single-browser
// only in Slice A; Slice B adds SSE forwarder routing for non-leader browsers.
const pendingEdits = new Map();   // requestId -> { resolve, timer, browserId }
const EDIT_TIMEOUT_MS = 30_000;

// localBrowserId — the browserId of the extension connected to THIS bridge
// process via direct NM stdio (as opposed to forwarded entries that arrived
// via /update from other bridge processes). Set on the first NM treeResponse
// or treeUpdate. Used by /edit to route locally vs via SSE: matching
// browserId → local nmWrite (fast path); non-matching → SSE to the
// forwarder that owns the target browser.
let localBrowserId = null;

// ─── Phase 2 Slice B: SSE forwarder infrastructure (leader-side) ──────────────
// `forwarders` tracks open SSE channels keyed by browserId. Forwarder bridges
// open `GET /edits?browserId=X` after their first /update succeeds; the leader
// writes applyEdit events down the stream when /edit resolves to a non-local
// browserId. `browserQueues` is the per-browserId Promise chain that
// serializes SSE dispatch — two clients (Claude Desktop + Cursor) racing
// /edit for the same browser get FIFO ordering at the leader. Per-browserId
// scope means Brave's writes don't block Chrome's. The popup-side
// _queueAgentCall queue gives a second layer of ordering at the extension;
// leader-side ordering matters when multiple AI clients race the same browser.
const forwarders = new Map();    // browserId -> { sseRes, heartbeatTimer }
const browserQueues = new Map(); // browserId -> Promise (serialization chain)
const SSE_HEARTBEAT_MS = 25_000;

// ─── Native Messaging write ───────────────────────────────────────────────────
// Chrome NM protocol: 4-byte LE length prefix + UTF-8 JSON body.
// Write to stdout only. Never use console.log() — it corrupts stdout.
//
// EPIPE handling. On Windows, Chrome doesn't reliably close the bridge's
// stdin pipe when the SW reconnects to a fresh bridge process; the OLD
// bridge keeps its HTTP server alive and continues to receive data via
// `/update` from the forwarder, but its outbound NM pipe (stdout) is
// severed. The next nmWrite throws EPIPE asynchronously, which (without
// this guard) crashes the request that triggered it without releasing
// port 37421. Phase 1 / v1.2.0 only sent ONE nmWrite (initial `getTree`)
// so this latent bug never bit; Phase 2 makes outbound NM the hot path.
//
// Fix: catch EPIPE both synchronously (rare) AND on the stream's 'error'
// event (the actual delivery path on Windows). Either way: log, mark the
// bridge as fatally degraded, exit so the forwarder can re-bind 37421
// and become a healthy leader.
let _nmStdoutBroken = false;

function _markNmStdoutBroken(reason) {
  if (_nmStdoutBroken) return;
  _nmStdoutBroken = true;
  try { log(`Native messaging stdout broken (${reason}); exiting so a healthy bridge can take port ${MCP_PORT}.`); } catch (_) {}
  // Phase 2 Slice B: best-effort LEADER_CHANGED notification. The 200ms
  // grace window is enough to flush HTTP responses to in-flight /edit
  // callers. Without this, pending entries would just hit their 30s timeout
  // and the AI client would wait the full window before retrying. Walk both
  // local-NM and SSE-routed entries (the latter would also hit
  // FORWARDER_DISCONNECTED via SSE close, but LEADER_CHANGED is the more
  // accurate diagnosis when the leader is the one going down).
  try {
    for (const [requestId, entry] of pendingEdits) {
      try { clearTimeout(entry.timer); } catch (_) {}
      try {
        entry.resolve({
          ok: false,
          requestId,
          error: {
            code: 'LEADER_CHANGED',
            message: 'Pinako AI Bridge leader process is exiting (zombie-leader recovery). The forwarder will promote within ~5 seconds; retry then.',
          },
        });
      } catch (_) {}
    }
    pendingEdits.clear();
  } catch (e) {
    try { log(`LEADER_CHANGED cleanup error: ${e.message}`); } catch (_) {}
  }
  // Settle in 200ms so any in-flight log/HTTP responses get flushed.
  setTimeout(() => process.exit(0), 200);
}

process.stdout.on('error', (err) => {
  if (err && (err.code === 'EPIPE' || /EPIPE|broken pipe/i.test(err.message || ''))) {
    _markNmStdoutBroken('stdout error EPIPE');
  } else {
    try { log(`stdout error: ${err && err.message ? err.message : String(err)}`); } catch (_) {}
  }
});

function nmWrite(obj) {
  if (_nmStdoutBroken) return false;
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  try {
    process.stdout.write(Buffer.concat([header, body]));
    return true;
  } catch (err) {
    if (err && (err.code === 'EPIPE' || /EPIPE|broken pipe/i.test(err.message || ''))) {
      _markNmStdoutBroken('nmWrite sync EPIPE');
      return false;
    }
    throw err;
  }
}

// ─── Native Messaging async read ─────────────────────────────────────────────
// Reads Chrome NM messages from stdin asynchronously so the event loop
// (and HTTP server) stays responsive between messages.
let stdinBuf = Buffer.alloc(0);

function handleNmMessage(msg) {
  if (msg.type === 'treeUpdate' || msg.type === 'treeResponse') {
    const browserId    = msg.browserId    || 'unknown';
    const browserBrand = msg.browserBrand || 'Unknown';
    // Phase 3 Slice B: per-browser tier (and userId for Phase 3C audit log)
    // travels alongside browser identity. Tier defaults to 0 when missing
    // (fail-closed for the per-content-cap check). userId may be empty for
    // browsers signed out of Pinako Pro — read tools work locally; write
    // tools wouldn't reach the bridge since the SW gate refuses to connect
    // for tier-0 users, but defaulting is still correct.
    const userTier = Number.isFinite(msg.userTier) ? msg.userTier : 0;
    const userId   = typeof msg.userId === 'string' ? msg.userId : '';
    // Identify local browser regardless of leader/forwarder role: NM stdio
    // ALWAYS reaches our local extension. Slice B uses localBrowserId on
    // both leader (route local-vs-SSE in /edit) and forwarder (open SSE
    // channel keyed by our browserId).
    if (browserId !== 'unknown' && localBrowserId !== browserId) {
      localBrowserId = browserId;
      log(`Local browser identified: ${browserBrand} (${browserId.slice(0,16)}…)`);
    }
    if (forwardToExisting) {
      // Forwarder path: relay data to leader, ensure SSE channel is open
      // so the leader can dispatch applyEdit events back to us.
      forwardToExisting({ data: msg.data, browserId, browserBrand, userTier, userId });
      _ensureSseConnection();
      return;
    }
    if (shutdownTimer) {
      clearTimeout(shutdownTimer);
      shutdownTimer = null;
    }
    extensionConnected = true;
    // 2026-05-11: when the data payload OMITS `bookmarks` (e.g., a
    // pushTreeUpdate from the popup after a non-bookmark agent op),
    // PRESERVE the previously cached bookmarks for this browserId
    // instead of wiping to []. Bookmarks aren't cloud-synced and can
    // only change via chrome.bookmarks-driven events; a non-bookmark
    // agent write can't have invalidated them. The initial getTree at
    // bridge start populates them; later pushes only override when the
    // op actually touched bookmarks.
    const prior = cachedData.get(browserId);
    const bookmarks = (msg.data && 'bookmarks' in msg.data)
      ? (msg.data.bookmarks || [])
      : (prior?.bookmarks || []);
    // 2026-05-11: same preserve-when-omitted pattern for docs (user guide
    // sections). The extension sends docs only on the initial getTree at
    // bridge start (and after extension updates that change the guide);
    // subsequent treeUpdates omit them. Preserve cached so we don't wipe
    // the search_docs corpus on every pushTreeUpdate.
    const docs = (msg.data && 'docs' in msg.data)
      ? (msg.data.docs || [])
      : (prior?.docs || []);
    cachedData.set(browserId, {
      tree:           msg.data.tree         || [],
      libraries:      msg.data.libraries    || [],
      globalNotes:    msg.data.globalNotes  || [],
      bookmarks,
      docs,
      updatedAt:      Date.now(),
      browserId,
      browserBrand,
      userTier,
      userId,
      // Preserve forwarderToken across non-bookmark pushes — it was set
      // by the most recent /update; treeUpdate via direct NM doesn't carry
      // a token (NM-direct is implicitly trusted via Chrome's allowed_origins).
      forwarderToken: prior?.forwarderToken || null,
    });
    process.stderr.write(`[pinako-mcp] Tree updated from ${browserBrand} (${browserId.slice(0,16)}…): ${msg.data.tree?.length || 0} windows.\n`);
    // Diagnostic: surface docs/bookmarks counts on every NM update so we can
    // tell at a glance whether the extension is pushing them. Logged to the
    // disk log (not just stderr) so it survives across leader processes.
    try {
      const docsLen = Array.isArray(msg.data?.docs) ? msg.data.docs.length : '<absent>';
      const bmLen = Array.isArray(msg.data?.bookmarks)
        ? msg.data.bookmarks.reduce((acc, r) => acc + countBookmarksRecursive(r), 0)
        : '<absent>';
      log(`NM update from ${browserBrand}: docs=${docsLen} bookmarks=${bmLen} windows=${msg.data?.tree?.length || 0}`);
    } catch (e) {
      try { log(`NM update log failed: ${e.message}`); } catch (_) {}
    }
  } else if (msg.type === 'editApplied' || msg.type === 'editFailed') {
    // applyEdit RPC reply from local extension. In forwarder mode, this is
    // an SSE-routed edit from the leader — POST result back to /edit-result
    // so the leader resolves its pendingEdits entry. In leader mode, resolve
    // our local pendingEdits directly (Slice A path). Late replies (after
    // timeout fired and removed the entry) are silently dropped either way.
    if (forwardToExisting) {
      _postEditResultToLeader(msg);
      return;
    }
    const pending = pendingEdits.get(msg.requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    pendingEdits.delete(msg.requestId);
    if (msg.type === 'editApplied') {
      pending.resolve(msg.result || { ok: true, requestId: msg.requestId });
    } else {
      pending.resolve({
        ok: false,
        requestId: msg.requestId,
        error: msg.error || { code: 'UNKNOWN_EDIT_FAILURE', message: 'editFailed without error details' },
      });
    }
  }
}

// Native messaging stdin handlers run only in default mode (Chrome NM host).
// In stdio-bridge mode, stdin carries MCP JSON-RPC and is owned by
// StdioServerTransport, not by Chrome's length-prefixed protocol.
if (!BRIDGE_URL) {
  process.stdin.on('data', (chunk) => {
    stdinBuf = Buffer.concat([stdinBuf, chunk]);
    // Drain complete messages from the buffer
    while (stdinBuf.length >= 4) {
      const msgLen = stdinBuf.readUInt32LE(0);
      if (stdinBuf.length < 4 + msgLen) break;
      const msgBody = stdinBuf.slice(4, 4 + msgLen);
      stdinBuf = stdinBuf.slice(4 + msgLen);
      try {
        handleNmMessage(JSON.parse(msgBody.toString('utf8')));
      } catch (e) {
        process.stderr.write(`[pinako-mcp] Bad message: ${e.message}\n`);
      }
    }
  });

  process.stdin.on('end', () => {
    extensionConnected = false;
    process.stderr.write('[pinako-mcp] Extension disconnected. Serving stale cache for 30s.\n');
    shutdownTimer = setTimeout(() => {
      process.stderr.write('[pinako-mcp] Grace period expired. Exiting.\n');
      process.exit(0);
    }, STDIN_GRACE_MS);
  });
}

// ─── Phase 2 Slice A: applyEdit dispatcher ────────────────────────────────────
// Sends an applyEdit message to the locally-connected extension over NM and
// returns a Promise that resolves with the editApplied / editFailed reply.
// Single-browser only in Slice A — `browserId` is informational so the result
// payload can echo it back. Slice B will route to non-leader browsers via SSE.
function dispatchEdit(op, browserId) {
  // Keep all logging OUTSIDE the Promise executor: process.stderr/stdout writes
  // can emit async error events that try/catch can't catch and that crash the
  // Promise. We log on entry/exit using the resolved value and the requestId
  // we generate up front.
  const requestId = randomUUID();
  log(`dispatchEdit ${requestId.slice(0,8)} starting op=${op.type} browserId=${(browserId||'').slice(0,16)}…`);
  return new Promise((resolve) => {
    if (_nmStdoutBroken) {
      resolve({
        ok: false,
        requestId,
        error: { code: 'NM_STDOUT_BROKEN', message: 'Native messaging stdout is broken (zombie leader). The bridge is exiting; reload the Pinako extension and retry in a few seconds.' },
      });
      return;
    }
    const timer = setTimeout(() => {
      pendingEdits.delete(requestId);
      resolve({
        ok: false,
        requestId,
        error: { code: 'EDIT_TIMEOUT', message: `applyEdit ${requestId} timed out after ${EDIT_TIMEOUT_MS}ms` },
      });
    }, EDIT_TIMEOUT_MS);
    pendingEdits.set(requestId, { resolve, timer, browserId, path: 'local' });
    // The extension's SW NM listener picks this up, forwards to the popup
    // via chrome.runtime.sendMessage, popup runs mutateTreeForAgent, replies
    // editApplied / editFailed back over NM. nmWrite returns false (instead
    // of throwing) when stdout is broken; we resolve immediately in that
    // case so the request doesn't hang for the full 30s timeout.
    const ok = nmWrite({ type: 'applyEdit', op, requestId, browserId });
    if (!ok) {
      clearTimeout(timer);
      pendingEdits.delete(requestId);
      resolve({
        ok: false,
        requestId,
        error: { code: 'NM_WRITE_FAILED', message: 'Native messaging write failed (stdout broken). The bridge is exiting; reload the Pinako extension and retry.' },
      });
    }
  });
}

// ─── Phase 2 Slice B: applyEdit dispatch via SSE ──────────────────────────────
// Sends an applyEdit event to a forwarder bridge over its SSE channel. The
// forwarder relays it to its local extension via NM, then POSTs back to
// /edit-result with the editApplied/editFailed result. We register the
// pending Promise the same shape as dispatchEdit so /edit awaits identically
// regardless of routing.
//
// Per-browserId serialization: chained through browserQueues so concurrent
// /edit calls for the same browserId fire SSE events in arrival order at the
// leader. A failure in one job doesn't break the chain.
function dispatchEditViaSse(op, browserId) {
  const prev = browserQueues.get(browserId) || Promise.resolve();
  const next = prev.then(
    () => _doSseDispatch(op, browserId),
    () => _doSseDispatch(op, browserId),
  );
  browserQueues.set(browserId, next.catch(() => {}));
  return next;
}

function _doSseDispatch(op, browserId) {
  const requestId = randomUUID();
  log(`dispatchEditViaSse ${requestId.slice(0,8)} starting op=${op.type} browserId=${(browserId||'').slice(0,16)}…`);
  return new Promise((resolve) => {
    const forwarder = forwarders.get(browserId);
    if (!forwarder) {
      resolve({
        ok: false,
        requestId,
        error: {
          code: 'FORWARDER_NOT_CONNECTED',
          message: `No active forwarder bridge for browserId ${(browserId||'').slice(0,16)}…. The target browser's Pinako popup may not be open.`,
        },
      });
      return;
    }
    const timer = setTimeout(() => {
      pendingEdits.delete(requestId);
      resolve({
        ok: false,
        requestId,
        error: { code: 'EDIT_TIMEOUT', message: `applyEdit ${requestId} timed out after ${EDIT_TIMEOUT_MS}ms` },
      });
    }, EDIT_TIMEOUT_MS);
    pendingEdits.set(requestId, { resolve, timer, browserId, path: 'sse' });
    try {
      forwarder.sseRes.write(`event: applyEdit\ndata: ${JSON.stringify({ requestId, op, browserId })}\n\n`);
    } catch (err) {
      clearTimeout(timer);
      pendingEdits.delete(requestId);
      log(`dispatchEditViaSse ${requestId.slice(0,8)} SSE write failed: ${err.message}`);
      resolve({
        ok: false,
        requestId,
        error: { code: 'SSE_WRITE_FAILED', message: `SSE write to forwarder failed: ${err.message}` },
      });
    }
  });
}

// Drop a forwarder when its SSE connection closes (forwarder process died,
// browser closed, leader restarting). Cleans the entry, stops the heartbeat,
// and rejects any in-flight pending edits routed to this browserId so the
// AI client gets a fast failure instead of waiting the full 30s timeout.
function _dropForwarder(browserId, reason) {
  const f = forwarders.get(browserId);
  if (!f) return;
  if (f.heartbeatTimer) clearInterval(f.heartbeatTimer);
  forwarders.delete(browserId);
  log(`Forwarder dropped: browserId=${(browserId||'').slice(0,16)}… reason=${reason}`);
  for (const [requestId, entry] of pendingEdits) {
    if (entry.path === 'sse' && entry.browserId === browserId) {
      clearTimeout(entry.timer);
      pendingEdits.delete(requestId);
      entry.resolve({
        ok: false,
        requestId,
        error: {
          code: 'FORWARDER_DISCONNECTED',
          message: `Forwarder bridge for browserId ${(browserId||'').slice(0,16)}… disconnected before the edit completed (${reason}).`,
        },
      });
    }
  }
}

// ─── Phase 2 Slice B: SSE client (forwarder-side) ─────────────────────────────
// When this process is in forwarder mode (EADDRINUSE → forwardToExisting set),
// it opens a long-running GET /edits?browserId=X to the leader. The leader
// streams applyEdit events down this channel; we relay each to our local
// extension via NM (same code path the leader uses). Reply travels back the
// other direction: extension → NM → handleNmMessage forwarder branch →
// _postEditResultToLeader → leader's pendingEdits resolves.
//
// Reconnect: 5s flat (matches PROMOTE_RETRY_MS). On disconnect we may
// promote to leader (port-bind succeeds) OR a peer forwarder may have
// promoted and is the new leader; either way the next _ensureSseConnection
// call probes the right state.
let sseClientReq       = null;
let sseClientReconnect = null;

function _ensureSseConnection() {
  if (!forwardToExisting) return; // leader doesn't connect to itself
  if (!localBrowserId) return;    // need our browserId first
  if (sseClientReq) return;       // already connecting/connected
  log(`Opening SSE channel to leader for browserId=${localBrowserId.slice(0,16)}…`);
  let sseBuf = '';
  const req = http.request({
    hostname: '127.0.0.1',
    port: MCP_PORT,
    // 2026-05-11: include forwarderToken so the leader token-binds this
    // SSE channel to THIS forwarder process (rejects other local
    // processes trying to subscribe to the same browserId).
    path: `/edits?browserId=${encodeURIComponent(localBrowserId)}&token=${encodeURIComponent(_myForwarderToken)}`,
    method: 'GET',
    headers: { 'Accept': 'text/event-stream' },
  });
  sseClientReq = req;
  req.on('response', (res) => {
    if (res.statusCode !== 200) {
      log(`SSE channel rejected: HTTP ${res.statusCode}`);
      sseClientReq = null;
      _scheduleSseReconnect();
      res.resume();
      return;
    }
    log('SSE channel open.');
    res.setEncoding('utf8');
    res.on('data', (chunk) => {
      sseBuf += chunk;
      let i;
      while ((i = sseBuf.indexOf('\n\n')) !== -1) {
        const event = sseBuf.slice(0, i);
        sseBuf = sseBuf.slice(i + 2);
        _handleSseEvent(event);
      }
    });
    res.on('end',   () => { log('SSE channel ended by leader.');   sseClientReq = null; _scheduleSseReconnect(); });
    res.on('error', (err) => { log(`SSE channel res error: ${err.message}`); sseClientReq = null; _scheduleSseReconnect(); });
    res.on('close', () => { sseClientReq = null; _scheduleSseReconnect(); });
  });
  req.on('error', (err) => {
    log(`SSE channel req error: ${err.message}`);
    sseClientReq = null;
    _scheduleSseReconnect();
  });
  req.end();
}

function _scheduleSseReconnect() {
  if (sseClientReconnect) return;
  if (!forwardToExisting) return; // we may have promoted to leader; no need to reconnect
  sseClientReconnect = setTimeout(() => {
    sseClientReconnect = null;
    _ensureSseConnection();
  }, PROMOTE_RETRY_MS);
}

function _handleSseEvent(eventText) {
  // SSE event format: "event: name\ndata: payload" terminated by "\n\n".
  // Lines starting with ":" are comments (heartbeats); skip them.
  const lines = eventText.split('\n');
  let eventName = null;
  const dataParts = [];
  for (const line of lines) {
    if (line.startsWith(':')) continue;
    if (line.startsWith('event: ')) eventName = line.slice(7).trim();
    else if (line.startsWith('data: ')) dataParts.push(line.slice(6));
  }
  if (eventName === 'ready') return;
  if (eventName !== 'applyEdit') {
    if (eventName) log(`SSE: ignoring unknown event ${eventName}`);
    return;
  }
  let data;
  try { data = JSON.parse(dataParts.join('\n')); }
  catch (e) { log(`SSE: bad applyEdit data: ${e.message}`); return; }
  const { requestId, op, browserId } = data || {};
  if (!requestId || !op) { log('SSE: applyEdit missing requestId or op'); return; }
  log(`SSE applyEdit ${requestId.slice(0,8)} for browserId=${(browserId||'').slice(0,16)}… op=${op.type}`);
  const ok = nmWrite({ type: 'applyEdit', op, requestId, browserId });
  if (!ok) {
    _postEditResultToLeader({
      type: 'editFailed',
      requestId,
      error: { code: 'NM_WRITE_FAILED', message: 'Forwarder native messaging write failed (stdout broken).' },
    });
  }
}

function _postEditResultToLeader(msg) {
  const body = JSON.stringify({
    requestId:      msg.requestId,
    ok:             msg.type === 'editApplied',
    result:         msg.result,
    error:          msg.error,
    // 2026-05-11: token-bound /edit-result. Without this, any local
    // process that observed a requestId could spoof a successful
    // editApplied for the AI client.
    forwarderToken: _myForwarderToken,
  });
  const req = http.request(
    { hostname: '127.0.0.1', port: MCP_PORT, path: '/edit-result', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
    (res) => { res.resume(); }
  );
  req.on('error', (err) => { log(`/edit-result post error: ${err.message}`); });
  req.write(body);
  req.end();
}

// ─── Phase 3 Slice D: destructive-op confirmation gate ───────────────────────
// MCP-boundary check that destructive ops carry confirmedByUser:true. The
// engine schemas enforce the same thing (z.literal(true)); the bridge layer
// is the canonical bypass-proof guard mirroring the per-content-cap pattern.
// Returns CONFIRMATION_REQUIRED early if missing — clear, distinct error code
// for AI clients to render a confirmation prompt before retrying.
//
// Two destructive surfaces:
//   - Always-destructive ops: ghost_node, delete_live_node. Listed in the set.
//   - Conditionally-destructive: delete_library_group with cascadeMembers:true.
//     Plain dissolve is non-destructive (Slice 1.5 back-compat).
// 2026-05-11 reshuffle: ghost_node moved OUT of the destructive list — the
// tree record is preserved so an erroneous ghost is reversible by re-opening
// from the tree. delete_node moved INTO the list — deleting tree records
// loses metadata (tags, memos, star color, custom title) permanently;
// only Chrome history retains the URL. delete_live_node remains (closes
// browser tabs AND removes tree records). delete_library_group with
// cascadeMembers:true stays conditionally destructive (handled below).
const _ALWAYS_DESTRUCTIVE_OP_TYPES = new Set(['delete_node', 'delete_live_node']);

function _isDestructiveOp(op) {
  if (!op || typeof op !== 'object') return false;
  if (_ALWAYS_DESTRUCTIVE_OP_TYPES.has(op.type)) return true;
  if (op.type === 'delete_library_group' && op.cascadeMembers === true) return true;
  return false;
}

function _checkConfirmedByUser(op, opIndex) {
  if (!_isDestructiveOp(op)) return null;
  if (op.confirmedByUser === true) return null;
  const opLabel = (op.type === 'delete_library_group') ? 'delete_library_group {cascadeMembers:true}' : op.type;
  const err = {
    code: 'CONFIRMATION_REQUIRED',
    message: `Destructive op ${opLabel} requires confirmedByUser:true. Ask the user to explicitly confirm this specific action, then retry with confirmedByUser:true. Do NOT set this flag without explicit user approval.`,
    context: { opType: op.type, ...(op.cascadeMembers !== undefined ? { cascadeMembers: op.cascadeMembers } : {}) },
  };
  if (typeof opIndex === 'number') err.context.subOpIndex = opIndex;
  return err;
}

// ─── Phase 3 Slice B: per-content-cap enforcement ─────────────────────────────
// MCP-boundary tier check for note content writes. Mirrors wrapper-side
// _checkNoteContentTier in pinako.js (~line 3015), kept in lockstep:
//  - applies to set_note_content and create_note (and those types as sub-ops
//    of bulk_apply)
//  - mode=append uses the cached existing note content for final-length math
//    (cache may be ~150ms stale per Slice B's pushTreeUpdate cadence; the
//    wrapper-side check catches the rare edge where this pass-through races)
//  - error envelope matches wrapper's NOTE_CONTENT_OVER_TIER_LIMIT shape so
//    AI clients see the same error code from either layer
function _resolveExistingNoteContent(browserData, scope, libraryId, noteId) {
  if (!browserData || !noteId) return '';
  if (scope === 'global-notes') {
    const list = Array.isArray(browserData.globalNotes) ? browserData.globalNotes : [];
    const note = list.find(n => n && n.id === noteId);
    return (note && note.content) || '';
  }
  if (scope === 'library-notes' && libraryId) {
    const libs = Array.isArray(browserData.libraries) ? browserData.libraries : [];
    const lib = libs.find(l => l && l.id === libraryId);
    const notes = (lib && Array.isArray(lib.notes)) ? lib.notes : [];
    const note = notes.find(n => n && n.id === noteId);
    return (note && note.content) || '';
  }
  return '';
}

function _checkNoteContentTierAtBridge(op, browserData, fallbackScope, fallbackLibraryId) {
  const tier = Number.isFinite(browserData?.userTier) ? browserData.userTier : 0;
  const tierLimit = NOTE_CHAR_LIMITS[tier] || NOTE_CHAR_LIMITS[0];
  const effectiveScope     = op.scope     || fallbackScope;
  const effectiveLibraryId = op.libraryId || fallbackLibraryId;
  const mode = op.mode || 'replace';
  const inputLength = ((op.content == null) ? '' : String(op.content)).length;
  let finalLength = inputLength;
  if (mode === 'append') {
    const existing = _resolveExistingNoteContent(browserData, effectiveScope, effectiveLibraryId, op.noteId);
    finalLength = existing.length + inputLength;
  }
  if (finalLength > tierLimit) {
    return {
      code: 'NOTE_CONTENT_OVER_TIER_LIMIT',
      message: `Note content (final length ${finalLength} chars after mode=${mode}) exceeds tier ${tier} limit of ${tierLimit} chars.`,
      context: { finalLength, mode, inputLength, tier, tierLimit },
    };
  }
  return null;
}

// ─── Phase 3 Slice A: unified edit dispatch ───────────────────────────────────
// Single entry point for agent ops, used by both the curl-testable /edit
// endpoint and every MCP write tool registered in createMcpServer(). Validates
// the op shape minimally, resolves the target browser via resolveBrowserData,
// then routes to local NM (Slice A) or SSE forwarder (Slice B). Returns a
// uniform result shape: { ok: true, ...wrapperResult } or { ok: false, error }.
// The MCP write tools registered in createMcpServer() call this directly; /edit also calls it and translates
// the result into an HTTP response via httpStatusForEditResult.
async function executeEdit(op, browserArg) {
  if (!op || typeof op !== 'object' || typeof op.type !== 'string') {
    return { ok: false, error: { code: 'BAD_REQUEST', message: 'op must be an object with a string `type` field' } };
  }
  const r = resolveBrowserData(browserArg);
  if (r.error) {
    return { ok: false, error: { code: 'BROWSER_NOT_FOUND', message: r.error.content[0].text } };
  }
  log(`executeEdit: op.type=${op.type} browserId=${r.data.browserId.slice(0,16)}… brand=${r.data.browserBrand}`);

  // Phase 3 Slice D: destructive-op confirmation gate. Bypass-proof at the
  // MCP boundary; engine schemas re-enforce the same thing as defense-in-
  // depth. Bulk-aware: walks bulk_apply.ops and rejects with subOpIndex.
  {
    const topErr = _checkConfirmedByUser(op);
    if (topErr) {
      log(`executeEdit: confirmation reject (${topErr.code}) for ${op.type} on ${r.data.browserBrand}`);
      return { ok: false, error: topErr };
    }
    if (op.type === 'bulk_apply' && Array.isArray(op.ops)) {
      for (let i = 0; i < op.ops.length; i++) {
        const subErr = _checkConfirmedByUser(op.ops[i], i);
        if (subErr) {
          log(`executeEdit: confirmation reject (${subErr.code}) for bulk_apply sub-op ${i} on ${r.data.browserBrand}`);
          return { ok: false, error: {
            code: subErr.code,
            message: `Sub-op ${i}: ${subErr.message}`,
            context: subErr.context,
          } };
        }
      }
    }
  }

  // Phase 3 Slice B: per-content-cap enforcement at the MCP boundary. Runs
  // before dispatch so oversize content never reaches the extension. Bulk-
  // aware: walks sub-ops for set_note_content/create_note inside bulk_apply,
  // returning the failing sub-op's index so AI clients can correct precisely.
  if (op.type === 'set_note_content' || op.type === 'create_note') {
    const err = _checkNoteContentTierAtBridge(op, r.data, op.scope, op.libraryId);
    if (err) {
      log(`executeEdit: tier-cap reject (${err.code}) for ${op.type} on ${r.data.browserBrand}`);
      return { ok: false, error: err };
    }
  } else if (op.type === 'bulk_apply' && Array.isArray(op.ops)) {
    const bulkScope     = op.scope     || 'tree';
    const bulkLibraryId = op.libraryId || null;
    for (let i = 0; i < op.ops.length; i++) {
      const sub = op.ops[i];
      if (!sub || (sub.type !== 'set_note_content' && sub.type !== 'create_note')) continue;
      const err = _checkNoteContentTierAtBridge(sub, r.data, bulkScope, bulkLibraryId);
      if (err) {
        log(`executeEdit: tier-cap reject (${err.code}) for bulk_apply sub-op ${i} (${sub.type}) on ${r.data.browserBrand}`);
        return { ok: false, error: {
          code: err.code,
          message: `Sub-op ${i} (${sub.type}): ${err.message}`,
          context: { ...err.context, subOpIndex: i },
        } };
      }
    }
  }

  if (localBrowserId && r.data.browserId === localBrowserId) {
    return await dispatchEdit(op, r.data.browserId);
  }
  if (forwarders.has(r.data.browserId)) {
    return await dispatchEditViaSse(op, r.data.browserId);
  }
  if (!localBrowserId) {
    return { ok: false, error: {
      code: 'BRIDGE_NOT_READY',
      message: 'Pinako AI Bridge has not yet received the initial connection from the Pinako popup. Open the popup and try again in a moment.',
    } };
  }
  return { ok: false, error: {
    code: 'FORWARDER_NOT_CONNECTED',
    message: `Pinako AI Bridge has the cache entry for ${r.data.browserBrand} but no active forwarder bridge to deliver writes. The Pinako popup in ${r.data.browserBrand} may not be open. Open it and try again.`,
    context: { requestedBrowser: r.data.browserBrand },
  } };
}

// Maps an executeEdit result to the HTTP status code /edit should respond
// with. Distinct status codes for distinct failure modes so curl callers can
// branch on status; MCP tool callers use error.code instead.
function httpStatusForEditResult(result) {
  if (result.ok) return 200;
  const code = result.error && result.error.code;
  if (code === 'BAD_REQUEST' || code === 'BROWSER_NOT_FOUND') return 400;
  if (code === 'BRIDGE_NOT_READY' || code === 'FORWARDER_NOT_CONNECTED') return 503;
  return 502; // engine validation errors, EDIT_TIMEOUT, LEADER_CHANGED, NM_WRITE_FAILED, etc.
}

// Shared handler for every MCP write tool. Pulls `browser` out of the args,
// drops undefined fields (so engine defaults apply for omitted scope/library/
// position/etc.), builds the op shape with `type`, and dispatches via
// executeEdit. The MCP content envelope wraps the executeEdit result; isError
// is set when ok=false so AI clients render the response as an error and can
// retry with corrected input.
async function writeToolHandler(opType, args) {
  const { browser, ...opFields } = args || {};
  const op = { type: opType };
  for (const [k, v] of Object.entries(opFields)) {
    if (v !== undefined) op[k] = v;
  }
  const result = await executeEdit(op, browser);
  return {
    content: [{ type: 'text', text: JSON.stringify(result) }],
    ...(result.ok ? {} : { isError: true }),
  };
}

// ─── Data helpers ─────────────────────────────────────────────────────────────
const STRIP_KEYS = new Set([
  '_depth', '_parentId', '_isLastChild', '_ancestorIds', 'isEditing', 'rowColorIsCustom',
]);

function sanitizeNode(node) {
  if (!node || typeof node !== 'object') return node;
  const out = {};
  for (const [k, v] of Object.entries(node)) {
    if (STRIP_KEYS.has(k)) continue;
    out[k] = (k === 'children' && Array.isArray(v)) ? v.map(sanitizeNode) : v;
  }
  return out;
}

function getTree(data, includeGhost = true) {
  if (!data) return null;
  const tree = data.tree.map(sanitizeNode);
  // Always strip incognito nodes — incognito data must never leave the local device
  function filterNodes(nodes) {
    return nodes
      .filter(n => !n.incognito)
      .filter(n => includeGhost || n.type !== 'tab' || n.chromeId !== null)
      .map(n => ({ ...n, children: n.children ? filterNodes(n.children) : [] }));
  }
  return filterNodes(tree);
}

// ─── Browser routing helpers ─────────────────────────────────────────────────
// `selectBrowser(arg)` resolves a `browser` tool argument (browserId or
// case-insensitive brand name like "Brave") to a single cached entry.
// `resolveBrowserData()` is the single decision point each tool uses to pick
// data: returns either { data } (proceed) or { error } (return to caller).
// Multi-browser ambiguity surfaces as a user-friendly error so the AI asks
// the user which browser to use, instead of silently merging or guessing.
function selectBrowser(arg) {
  if (!arg) return null;
  if (cachedData.has(arg)) return cachedData.get(arg);
  const lower = String(arg).toLowerCase();
  for (const data of cachedData.values()) {
    if (data.browserBrand.toLowerCase() === lower) return data;
  }
  return null;
}

function noDataError() {
  return {
    content: [{ type: 'text', text: 'No data yet — open the Pinako extension first.' }],
    isError: true,
  };
}

function multiBrowserError() {
  const brands = [...cachedData.values()].map(d => d.browserBrand);
  const list = brands.join(', ');
  const example = brands[0] ? `'${brands[0]}'` : "'Brave'";
  return {
    content: [{
      type: 'text',
      text: `Multiple Pinako installs detected: ${list}. Please specify which one with the 'browser' parameter (e.g., browser=${example}). Use list_browsers to see all connected browsers.`,
    }],
    isError: true,
  };
}

function resolveBrowserData(browserArg) {
  if (cachedData.size === 0) return { error: noDataError() };
  if (browserArg) {
    const data = selectBrowser(browserArg);
    if (!data) {
      const available = [...cachedData.values()].map(d => d.browserBrand).join(', ');
      return {
        error: {
          content: [{ type: 'text', text: `Browser '${browserArg}' not found. Connected browsers: ${available}.` }],
          isError: true,
        },
      };
    }
    return { data };
  }
  if (cachedData.size === 1) return { data: cachedData.values().next().value };
  return { error: multiBrowserError() };
}

function searchInTree(nodes, query, includeGhost, results = []) {
  const q = query.toLowerCase();
  for (const node of nodes) {
    // Never expose incognito nodes via MCP
    if (node.incognito) continue;
    if (node.type === 'tab') {
      if (!includeGhost && node.chromeId === null) continue;
      const hit =
        (node.title    || '').toLowerCase().includes(q) ||
        (node.url      || '').toLowerCase().includes(q) ||
        (node.memoText || '').toLowerCase().includes(q) ||
        (Array.isArray(node.tags) && node.tags.some(t => t.toLowerCase().includes(q)));
      if (hit) results.push(sanitizeNode(node));
    }
    if (node.children?.length) searchInTree(node.children, query, includeGhost, results);
  }
  return results;
}

function countTabsInLibrary(nodes) {
  let n = 0;
  for (const node of nodes) {
    if (node.type === 'tab') n++;
    if (node.children?.length) n += countTabsInLibrary(node.children);
  }
  return n;
}

// chrome.bookmarks tree shape: each node has .url for actual bookmarks,
// .children for folders. Counts only leaf bookmarks (with .url), skipping
// folders. Walks recursively starting from a root node.
function countBookmarksRecursive(node) {
  if (!node) return 0;
  let n = node.url ? 1 : 0;
  if (Array.isArray(node.children)) {
    for (const child of node.children) n += countBookmarksRecursive(child);
  }
  return n;
}

// ─── MCP Server factory ────────────────────────────────────────────────────────
// Each HTTP session gets its own McpServer + transport instance.
// Tool handlers read from the global cachedData (no per-session state needed).
const SERVER_INSTRUCTIONS = `Pinako is a browser tab manager Chrome extension. This MCP server gives you READ and WRITE access to the user's live tab data, libraries, library groups, notes, and browser bookmarks.

WRITE TOOLS (Pro tier 1+)
Read tools (get_tree, search_tabs, list_libraries, get_library, get_global_notes, get_bookmarks, list_browsers) require no special handling.

Write tools fall into four categories:
- METADATA: set_tags, add_tags, remove_tags, set_memo, set_star_color, set_row_color, set_title.
- TREE STRUCTURE: move_node, indent_node, outdent_node, create_group, delete_node, ghost_node, delete_live_node, create_folder.
- LIBRARY SYSTEM: create_library, add_to_library, set_note_content, create_note, create_library_group, delete_library_group, add_library_to_group, remove_library_from_group, set_library_group_title, set_library_group_description, reorder_library_panel, reorder_libraries_in_group.
- COMPOSITE: bulk_apply (up to 100 sub-ops, atomic, undoable as a single unit).

DESTRUCTIVE OPS need explicit user approval. Set confirmedByUser:true on these tools ONLY after the user has confirmed THIS specific action (not as a default, not on retry after a failure):
- delete_node (removes a ghost tree record permanently; only Chrome history retains the URL)
- delete_live_node (closes live tabs AND removes the tree record)
- delete_library_group with cascadeMembers:true (also deletes member libraries' content)
Note: ghost_node (closes live tabs, preserves tree record) is NOT destructive — the user can re-open from the tree.

CREATE-* OPS ARE NOT IDEMPOTENT. On transient failures (EDIT_TIMEOUT, NM_WRITE_FAILED, LEADER_CHANGED, FORWARDER_DISCONNECTED), DO NOT auto-retry — query state (list_libraries / get_global_notes / get_library) first to check whether the previous attempt succeeded. Otherwise you may silently create duplicates.

DELETE/GHOST OPS ARE IDEMPOTENT-ON-RETRY. NODE_NOT_FOUND (delete_node) or NODE_NOT_LIVE (ghost_node) on a retry typically means the previous call succeeded but the response was lost — treat as success rather than re-asking the user.

ERROR HANDLING. Every write tool returns either {ok:true, ...result} or {ok:false, error:{code, message, context}}. Branch on error.code to react programmatically (e.g., CONFIRMATION_REQUIRED → ask the user to confirm; NOTE_CONTENT_OVER_TIER_LIMIT → trim content or warn the user; LIBRARY_NOT_FOUND → re-fetch list_libraries; subOpIndex in bulk_apply errors identifies the failing sub-op so you can correct and resubmit).

DATA MODEL
The tab tree is hierarchical: Windows → Groups → Tabs.
- Each node has: id, type, title, url, favIconUrl, tags (string[]), memoText (short plain-text note, max 2500 chars), notes (rich text documents with title and HTML content), openedDate (Unix ms timestamp — the date the tab was opened or saved), collapsed, and children.
- Ghost tabs (chromeId = null) are tabs the user closed in the browser but chose to preserve in the Pinako tree. They can be reopened on demand. Treat them as saved/bookmarked tabs — they are NOT currently open in Chrome.
- Groups have a title and color. Windows have a title.
- Libraries are user-created collections of saved tabs organized into folders — like bookmarks but richer, with notes, tags, and memos.
- Global notes are rich text documents not attached to any specific tab or library.

CHRONOLOGY
openedDate (Unix ms) records when each tab was opened or saved. Use this for time-based queries like "tabs I opened today", "recent tabs", "what was I looking at last week". Compare against the current date.

TERMINOLOGY
- Memos: short plain-text snippets attached per node (max 2500 chars). Distinct from Notes.
- Notes: Tiptap-based rich text documents (title + HTML content) attachable per node or per library. A node can have multiple notes.
- Tags: categorization labels (string array) attached per node.
- Ghost tab: a closed tab preserved in the tree (chromeId = null). Not currently open in Chrome.

DOCS LOOKUP
search_docs(query, max_results?) gives you fast local access to Pinako's user guide (~10ms, bundled with this bridge, no internet needed). Treat it as a peer reference, not a fallback after failure.

Call search_docs BEFORE acting when any of these is true:

1. A PINAKO-SPECIFIC TERM is uncertain. Examples: "memo" vs "note", "group row color" or "group node color" vs Chrome "Tab Group" color, "folder" vs "group", "ghost tab", "library group", "snapshot". These have product-specific meanings that differ from generic tab-manager intuition; don't guess from the term alone.

2. The user uses ORDINARY-ENGLISH PHRASING that doesn't map 1:1 to a write tool. "Save this tab" — add_to_library? ghost_node? "Organize my research" — move_node, create_library, or bulk_apply? "Archive these" — ghost_node, move to library, or delete_live_node? "Color-code by topic" — set_row_color or set_star_color? When the verb is vague or could plausibly match multiple ops, check the guide before choosing.

3. The request is COMPLEX OR MULTI-STEP and you're unsure Pinako supports the constituent operations. Confirm capability before designing a multi-bulk_apply plan. Capability questions: "is there scheduling?", "does selective sync exist?", "can I link notes across libraries?". Shape questions: "are notes per-node or per-library?", "do tags propagate to children?".

4. BEFORE SAYING "I CAN'T DO THAT." Pinako has real limits (no live web fetch, no page-content access without read_page consent, no JS execution on tabs) AND unexpected affordances (library groups, snapshots, three-panel view, sync devices, blockchain backup). Verify before refusing.

5. The user asks an INTERNAL question about Pinako behavior, features, or workflow. Patterns: "How does X work?", "How do I X?", "Can Pinako X?", "What happens when I X?", "Why didn't X work?", "Does Pinako support X?", "Where do I find X?". Examples: "Can I undo this?", "What happens when I ghost a tab?", "Why didn't this sync?", "How do shared libraries work?", "How do I export a library?", "Can Pinako sync to mobile?", "Can Pinako schedule tabs to reopen?", "Can Pinako back up to blockchain?" — answer from the guide, not from generic tab-manager intuition.

When citing the guide back to the user, include the section anchor (e.g., "see #guide-library-groups in your user guide") so they can jump directly to that section in their own copy.

Cost of search_docs is negligible (local read, no LLM call). When in doubt, call it.

Skip search_docs when the request is direct and the tool is obvious ("tag this 'history'" → set_tags), or you've already established the vocabulary earlier in this conversation.

SEARCH SCOPE
When the user asks a lookup question over their saved data — "how many tabs about X do I have", "find Y", "where are my Z", "list everything tagged W" — search BOTH the main tree AND every library by default:
- Main tree: search_tabs (covers live + ghost tabs; matches title, URL, tags, memo text).
- Libraries: list_libraries → get_library on each → filter children for matches against title, URL, tags, memos.
Do NOT search bookmarks by default. Bookmark trees are often huge (10K+ entries common) and would dominate result counts without adding signal. Include bookmarks ONLY when the user explicitly references them: "bookmark(s)", "in my bookmarks", "across everything", "including bookmarks".
Report results BY SOURCE rather than as a bare total. Example: "24 total — 3 live tabs, 8 ghosts in the main tree, 11 in 'Travel: Yucatán' library, 2 in 'Research Notes' library." The breakdown is often as useful as the count.
Override phrases that change scope:
- "in the main tree only" / "in the live tree" → skip libraries.
- "in my libraries only" → skip main tree.
- "in library X" → constrain to that one library.
- "everywhere" / "including bookmarks" → add bookmarks.
For writes ("tag all my X tabs as 'Y'"), apply the same default scope: issue per-scope ops (scope:'tree' for main-tree nodes, scope:'library' with libraryId for each affected library) bundled into ONE bulk_apply so the user gets one-click undo.

MULTI-BROWSER
The user may have Pinako open in multiple browsers (Chrome + Brave, etc.) at the same time. Each install is a separate data source. Tools accept an optional 'browser' parameter (e.g., browser="Brave") to pick a specific install. When multiple browsers are connected and the user does NOT specify which to use, tools return an ambiguity error — ask the user which browser they want, then retry with the chosen 'browser' value. Use list_browsers to discover what's connected. Libraries and global notes are cloud-synced so their content is identical across the user's browsers, but live tab/window state and per-tab metadata differ per browser.

CONNECTION RECOVERY
If a tool returns "No data yet — open the Pinako extension first", or list_browsers returns an empty list when the user expects browsers to be connected, the Pinako extension's connection to this MCP server has lapsed. Tell the user to open the Pinako extension popup (click the Pinako icon in their browser toolbar). That re-establishes the native-messaging connection and brings the data back. This rarely happens after initial install, but can occur after PC sleep/wake, browser restart, or extended idle periods. The user does not need to restart your client (Claude Desktop, Cursor, etc.) — just opening the popup is enough.

For complete documentation, see: https://pinako.pro/docs/ai-connect`;

function createMcpServer() {
  const srv = new McpServer(
    { name: 'pinako', version: '1.2.0' },
    { instructions: SERVER_INSTRUCTIONS }
  );

  const BROWSER_ARG_DESC = 'Which Pinako install to query (browser brand like "Brave" or "Chrome", or browserId from list_browsers). Required when multiple browsers are connected; omit when only one is connected.';

  srv.registerTool(
    'get_tree',
    {
      description:
        'Returns the full tab tree (Windows → Groups → Tabs) from the Pinako extension. ' +
        'Each node includes: id, type, title, url, favIconUrl, chromeId (null = ghost/closed tab), ' +
        'openedDate, memoText, tags, notes, collapsed, and children.',
      inputSchema: {
        include_ghost_tabs: z.boolean().optional().describe('Include closed/ghost tabs (chromeId=null). Default true.'),
        browser: z.string().optional().describe(BROWSER_ARG_DESC),
      },
    },
    async ({ include_ghost_tabs = true, browser }) => {
      const r = resolveBrowserData(browser);
      if (r.error) return r.error;
      return { content: [{ type: 'text', text: JSON.stringify({
        browser: r.data.browserBrand,
        browserId: r.data.browserId,
        tree: getTree(r.data, include_ghost_tabs),
        updatedAt: r.data.updatedAt,
      }) }] };
    }
  );

  srv.registerTool(
    'search_tabs',
    {
      description: 'Searches all tabs for a query. Matches title, URL, memo text, and tags. Returns matching tab nodes.',
      inputSchema: {
        query: z.string().describe('Search query (case-insensitive)'),
        include_ghost_tabs: z.boolean().optional().describe('Include closed/ghost tabs. Default true.'),
        browser: z.string().optional().describe(BROWSER_ARG_DESC),
      },
    },
    async ({ query, include_ghost_tabs = true, browser }) => {
      const r = resolveBrowserData(browser);
      if (r.error) return r.error;
      const results = searchInTree(r.data.tree, query, include_ghost_tabs);
      return { content: [{ type: 'text', text: JSON.stringify({
        browser: r.data.browserBrand,
        results,
        count: results.length,
      }) }] };
    }
  );

  srv.registerTool(
    'list_libraries',
    {
      description: 'Lists all Pinako libraries (saved tab collections). Returns id, title, description, tab count, and library-level notes. Libraries are cloud-synced, so their list is identical across a user\'s browsers; the browser argument still applies for routing consistency.',
      inputSchema: {
        browser: z.string().optional().describe(BROWSER_ARG_DESC),
      },
    },
    async ({ browser }) => {
      const r = resolveBrowserData(browser);
      if (r.error) return r.error;
      const libs = (r.data.libraries || []).map(lib => ({
        id: lib.id, title: lib.title, description: lib.description || '',
        tabCount: countTabsInLibrary(lib.children || []), notes: lib.notes || [],
      }));
      return { content: [{ type: 'text', text: JSON.stringify({
        browser: r.data.browserBrand,
        libraries: libs,
      }) }] };
    }
  );

  srv.registerTool(
    'get_library',
    {
      description: 'Returns the full contents of a Pinako library: folders, tabs, memos, tags, notes.',
      inputSchema: {
        library_id: z.string().describe('Library id from list_libraries'),
        browser: z.string().optional().describe(BROWSER_ARG_DESC),
      },
    },
    async ({ library_id, browser }) => {
      const r = resolveBrowserData(browser);
      if (r.error) return r.error;
      const lib = (r.data.libraries || []).find(l => l.id === library_id);
      if (!lib) return { content: [{ type: 'text', text: `Library not found: ${library_id} (in ${r.data.browserBrand})` }], isError: true };
      return { content: [{ type: 'text', text: JSON.stringify({
        browser: r.data.browserBrand,
        library: sanitizeNode(lib),
      }) }] };
    }
  );

  srv.registerTool(
    'get_global_notes',
    {
      description: 'Returns global notes — rich text documents not attached to any specific tab or library. Cloud-synced, identical across browsers.',
      inputSchema: {
        browser: z.string().optional().describe(BROWSER_ARG_DESC),
      },
    },
    async ({ browser }) => {
      const r = resolveBrowserData(browser);
      if (r.error) return r.error;
      return { content: [{ type: 'text', text: JSON.stringify({
        browser: r.data.browserBrand,
        globalNotes: r.data.globalNotes || [],
      }) }] };
    }
  );

  srv.registerTool(
    'get_bookmarks',
    {
      description: 'Returns the user\'s Chrome bookmark tree (raw chrome.bookmarks.getTree() result). Use this to discover bookmark node ids before calling add_to_library with sourceScope="bookmarks". Each node has: id (stable Chrome bookmark id; persists across the bookmark\'s lifetime), title, url (set for bookmarks, missing for folders), children (array, present for folders), dateAdded (Unix ms timestamp), parentId, index (0-based position within parent). Top-level roots are typically "Bookmarks Bar" (id "1") and "Other Bookmarks" (id "2").',
      inputSchema: {
        browser: z.string().optional().describe(BROWSER_ARG_DESC),
      },
    },
    async ({ browser }) => {
      const r = resolveBrowserData(browser);
      if (r.error) return r.error;
      return { content: [{ type: 'text', text: JSON.stringify({
        browser:   r.data.browserBrand,
        browserId: r.data.browserId,
        bookmarks: r.data.bookmarks || [],
        updatedAt: r.data.updatedAt,
      }) }] };
    }
  );

  srv.registerTool(
    'list_browsers',
    {
      description: 'Lists all Pinako installs currently connected to this MCP server. Each entry: browserBrand (human-readable name like "Chrome" or "Brave"), browserId (stable per-install id), updatedAt (timestamp of last data update), windowCount (live windows), libraryCount, bookmarkCount, docsCount (number of cached user-guide sections searchable via search_docs). Use the browserBrand or browserId as the "browser" argument to other tools when multiple browsers are connected.',
    },
    async () => {
      const browsers = [...cachedData.values()].map(d => ({
        browserBrand:  d.browserBrand,
        browserId:     d.browserId,
        updatedAt:     d.updatedAt,
        windowCount:   (d.tree || []).filter(n => !n.incognito).length,
        libraryCount:  (d.libraries || []).length,
        bookmarkCount: (d.bookmarks || []).reduce((acc, root) => acc + countBookmarksRecursive(root), 0),
        docsCount:     Array.isArray(d.docs) ? d.docs.length : 0,
      }));
      return { content: [{ type: 'text', text: JSON.stringify({ browsers, count: browsers.length }) }] };
    }
  );

  // Phase 3 follow-up: search_docs (bundled user-guide lookup). Pinako's user
  // guide ships as three HTML fragments inside the extension package
  // (user-guide-content.html + user-guide-ai-connect-content.html +
  // user-guide-import-content.html). The extension's SW parses them into
  // anchored sections on first NM connect and pushes them via the `docs`
  // field on treeResponse. Bridge caches them per-browser; this tool searches
  // titles + body across the cached sections and returns ranked excerpts.
  //
  // Search is intentionally simple: token-overlap with title and subheadings
  // weighted 10× text. No embeddings — docs are small (~150 sections), AI
  // agents are already great at synthesizing once they have the right sections
  // in hand. Stopword filter prevents natural-language phrasings ("difference
  // between memo and note") from drowning real signal in body-match counts of
  // common words like "and", "to", "between".
  const _STOPWORDS = new Set([
    'a','an','the','and','or','but','if','of','in','on','at','to','for','from',
    'by','with','into','onto','about','against','through','during','before',
    'after','between','among','over','under','out','up','down','off',
    'is','are','was','were','be','been','being','am','do','does','did','have',
    'has','had','can','could','will','would','may','might','must','should',
    'shall','i','me','my','you','your','he','she','it','its','we','us','our',
    'they','them','their','this','that','these','those','what','which','who',
    'whom','whose','where','when','why','how','not','no','also','just','only',
    'more','most','some','any','all','each','every','both','either','neither',
    'very','too','than','then','so','yet',
  ]);
  function _searchDocsSections(docs, query, maxN) {
    const tokens = (query || '').toLowerCase().split(/\W+/)
      .filter(t => t.length > 1 && !_STOPWORDS.has(t));
    if (tokens.length === 0) return [];
    const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const scored = [];
    for (const d of docs) {
      const title = (d.title || '').toLowerCase();
      const text  = (d.text  || '').toLowerCase();
      const subs  = Array.isArray(d.subheadings) ? d.subheadings : [];
      let score = 0;
      let bestSubAnchorId = null;
      let bestSubAnchorScore = 0;
      for (const t of tokens) {
        if (title.includes(t)) score += 10;
        for (const sub of subs) {
          const subTitle = (sub.title || '').toLowerCase();
          if (subTitle.includes(t)) {
            score += 10;
            // Track which H3/H4 subheading scored highest so the AI can cite
            // a deeper anchor (#guide-memos) instead of just the H2 parent.
            const subHits = (subTitle.match(new RegExp(escapeRe(t), 'g')) || []).length;
            if (subHits > bestSubAnchorScore) {
              bestSubAnchorScore = subHits;
              bestSubAnchorId    = sub.id;
            }
          }
        }
        const matches = text.match(new RegExp(escapeRe(t), 'g'));
        if (matches) score += matches.length;
      }
      if (score > 0) scored.push({ d, score, subAnchor: bestSubAnchorId });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, maxN).map(({ d, score, subAnchor }) => ({
      id:      d.id,
      title:   d.title,
      source:  d.source,
      excerpt: (d.text || '').length > 500 ? (d.text || '').slice(0, 500) + '…' : (d.text || ''),
      score,
      ...(subAnchor ? { subAnchor } : {}),
    }));
  }

  srv.registerTool(
    'search_docs',
    {
      description: 'Searches the Pinako user guide. Returns sections matching the query with title, anchor id, source ("user-guide" / "ai-connect" / "import"), excerpt, and score. The guide is bundled with this bridge and served from local cache (~10ms, no internet). See the DOCS LOOKUP section in server instructions for WHEN to call this. Cite anchor ids back to the user ("see #guide-library-groups") so they can jump to that section in their own copy of the guide.',
      inputSchema: {
        query: z.string().describe('Search query — keywords or short phrase (case-insensitive).'),
        max_results: z.number().int().min(1).max(20).optional().describe('Cap on returned sections. Default 5.'),
        browser: z.string().optional().describe(BROWSER_ARG_DESC),
      },
    },
    async ({ query, max_results, browser }) => {
      const r = resolveBrowserData(browser);
      if (r.error) return r.error;
      const docs = Array.isArray(r.data.docs) ? r.data.docs : [];
      if (docs.length === 0) {
        return { content: [{ type: 'text', text: JSON.stringify({
          browser:  r.data.browserBrand,
          query,
          results:  [],
          count:    0,
          note:     'No docs cached yet for this browser. The extension pushes the user guide on its first connect; if this just rotated, re-call after the next treeUpdate.',
        }) }] };
      }
      const results = _searchDocsSections(docs, query, max_results || 5);
      return { content: [{ type: 'text', text: JSON.stringify({
        browser: r.data.browserBrand,
        query,
        results,
        count:   results.length,
      }) }] };
    }
  );

  // ═══ Write tools (Phase 3 Slice A) ═════════════════════════════════════════
  // Agent ops registered as MCP tools so AI clients (Claude Desktop, Cursor,
  // Cline, Continue.dev, etc.) can drive the same engine surface that's already
  // curl-testable via /edit. Schemas are intentionally LOOSE at this boundary
  // (field types only) — the engine's zod schemas in mutation-engine.js are
  // the canonical validators. Constraints are baked into description text;
  // the reference doc carries the full inventory.
  // ═════════════════════════════════════════════════════════════════════════

  const SCOPE_TREE_OR_LIBRARY = "Scope: 'tree' (default), 'library' (libraryId required), or 'bookmarks'. Most node-targeted ops only need scope when working outside the main tree.";
  const SCOPE_NOTES = "Required: 'library-notes' (notes attached to a specific library; libraryId required) or 'global-notes' (notes attached to the main tree). NOTE: when wrapped in bulk_apply, you must set scope on EACH sub-op individually — bulk's outer scope is NOT inherited by create_note / set_note_content sub-ops because their schemas accept two scopes.";
  const POSITION_DESC = "Optional 0-indexed insertion position; omit to append. Negative or out-of-range values clamp to ends.";

  // ─── Tag ops ────────────────────────────────────────────────────────────────
  srv.registerTool('set_tags', {
    description: 'REPLACES the entire tag array on a node. Pass an empty array to clear all tags. Use add_tags / remove_tags for delta updates that preserve existing tags. Constraints: each tag max 50 chars; max 50 tags per node.',
    inputSchema: {
      nodeId:    z.string().describe('Target node id.'),
      tags:      z.array(z.string()).describe('New tag array (replaces existing). Use [] to clear.'),
      scope:     z.string().optional().describe(SCOPE_TREE_OR_LIBRARY),
      libraryId: z.string().optional().describe('Required when scope=library.'),
      browser:   z.string().optional().describe(BROWSER_ARG_DESC),
    },
  }, async (args) => writeToolHandler('set_tags', args));

  srv.registerTool('add_tags', {
    description: 'APPENDS tags to a node, deduping and preserving order of existing tags. Use this when the user says "tag X with Y" or "also add Z" — it preserves prior tags. Use set_tags for full replacement, remove_tags for deletion. Constraints: each tag max 50 chars; max 50 tags per node total (existing + appended).',
    inputSchema: {
      nodeId:    z.string().describe('Target node id.'),
      tags:      z.array(z.string()).min(1).describe('Tags to append (deduped against existing).'),
      scope:     z.string().optional().describe(SCOPE_TREE_OR_LIBRARY),
      libraryId: z.string().optional().describe('Required when scope=library.'),
      browser:   z.string().optional().describe(BROWSER_ARG_DESC),
    },
  }, async (args) => writeToolHandler('add_tags', args));

  srv.registerTool('remove_tags', {
    description: 'Filters specific tags off a node, preserving the rest. No-op for tags not present. Use this for "untag X from Y" requests. Constraints: each tag max 50 chars.',
    inputSchema: {
      nodeId:    z.string().describe('Target node id.'),
      tags:      z.array(z.string()).min(1).describe('Tags to remove (no-op if missing).'),
      scope:     z.string().optional().describe(SCOPE_TREE_OR_LIBRARY),
      libraryId: z.string().optional().describe('Required when scope=library.'),
      browser:   z.string().optional().describe(BROWSER_ARG_DESC),
    },
  }, async (args) => writeToolHandler('remove_tags', args));

  // ─── Metadata ops ───────────────────────────────────────────────────────────
  srv.registerTool('set_memo', {
    description: 'Sets the memo (short plain-text annotation, max 2500 chars) on a node. Pass empty string to clear. Memos are per-node and concise; for richer rich-text documents use create_note / set_note_content (which target a library or the global notes, not individual nodes).',
    inputSchema: {
      nodeId:    z.string().describe('Target node id.'),
      text:      z.string().describe('Memo text (max 2500 chars). Empty string clears the memo.'),
      scope:     z.string().optional().describe(SCOPE_TREE_OR_LIBRARY),
      libraryId: z.string().optional().describe('Required when scope=library.'),
      browser:   z.string().optional().describe(BROWSER_ARG_DESC),
    },
  }, async (args) => writeToolHandler('set_memo', args));

  srv.registerTool('set_star_color', {
    description: 'Sets the row star color on a node. Accepts a named color (red, orange, yellow, green, blue, purple) OR its exact hex equivalent (#ff4d4f red, #fa8c16 orange, #fadb14 yellow, #52c41a green, #1890ff blue, #722ed1 purple). Arbitrary hex codes are NOT accepted — only the six pre-defined hex values. Pass null to clear.',
    inputSchema: {
      nodeId:    z.string().describe('Target node id.'),
      color:     z.union([z.string(), z.null()]).describe('Color name, hex string, or null to clear.'),
      scope:     z.string().optional().describe(SCOPE_TREE_OR_LIBRARY),
      libraryId: z.string().optional().describe('Required when scope=library.'),
      browser:   z.string().optional().describe(BROWSER_ARG_DESC),
    },
  }, async (args) => writeToolHandler('set_star_color', args));

  srv.registerTool('set_row_color', {
    description: 'Sets the rowColor of a Pinako Group node or Folder node. NOT related to Chrome Tab Group color (Chrome owns those — agent has no direct control over them; tabs join/leave Chrome Tab Groups implicitly via move_node positioning). Accepts: "accent2" (theme-tracking default), a named color ("blue", "red", "green", "purple", "yellow", "orange", "pink", "cyan", "grey"), an explicit 6-digit hex ("#1890ff"), or null (reset to "accent2"). Rejects on non-group/non-folder node types with INVALID_NODE_TYPE.',
    inputSchema: {
      nodeId:    z.string().describe('Target group or folder node id.'),
      rowColor:  z.union([z.string(), z.null()]).describe('"accent2", named color, 6-digit hex, or null to reset.'),
      scope:     z.string().optional().describe(SCOPE_TREE_OR_LIBRARY),
      libraryId: z.string().optional().describe('Required when scope=library.'),
      browser:   z.string().optional().describe(BROWSER_ARG_DESC),
    },
  }, async (args) => writeToolHandler('set_row_color', args));

  srv.registerTool('set_title', {
    description: 'Sets a custom title on a tab, window, group, or folder node. Trimmed; max 200 chars. Sets customTitle=true so the title persists across browser restarts.',
    inputSchema: {
      nodeId:    z.string().describe('Target node id.'),
      title:     z.string().describe('New title (trimmed, non-empty, max 200 chars).'),
      scope:     z.string().optional().describe(SCOPE_TREE_OR_LIBRARY),
      libraryId: z.string().optional().describe('Required when scope=library.'),
      browser:   z.string().optional().describe(BROWSER_ARG_DESC),
    },
  }, async (args) => writeToolHandler('set_title', args));

  // ─── Tree-structure ops ─────────────────────────────────────────────────────
  srv.registerTool('move_node', {
    description: 'Moves a node (and its full subtree) under newParentId at an optional position. SUBTREE SEMANTICS: all descendants come along. To move ONLY the node WITHOUT its children (e.g., "move tab X but leave the nested tabs"), use the outdent-first-child pattern: outdent the node\'s first child first (sibling-adoption pulls the rest under it), then move the now-empty target. Or wrap both ops in a single bulk_apply for atomicity. Pass newParentId=null to move to root (auto-wraps tabs into a new window). CHROME TAB GROUP behavior (Pinako has no direct ops for Chrome Tab Group membership — it\'s controlled implicitly by tree position): a tab JOINS a Chrome Tab Group only when moved INTO a position BETWEEN two existing group members. Moving a tab to the position immediately BEFORE the first group member or immediately AFTER the last member does NOT auto-join — it stays adjacent but outside the group. A grouped tab moved AWAY from its siblings forcibly leaves the group. So to add tabs to a Chrome Tab Group: move them between any two members. To position a tab next to a group without joining: move it before the first member or after the last.',
    inputSchema: {
      nodeId:      z.string().describe('Node to move (with its subtree).'),
      newParentId: z.union([z.string(), z.null()]).optional().describe('Destination parent id, or null for root.'),
      position:    z.number().optional().describe(POSITION_DESC),
      scope:       z.string().optional().describe(SCOPE_TREE_OR_LIBRARY),
      libraryId:   z.string().optional().describe('Required when scope=library.'),
      browser:     z.string().optional().describe(BROWSER_ARG_DESC),
    },
  }, async (args) => writeToolHandler('move_node', args));

  srv.registerTool('create_group', {
    description: 'Creates a new Pinako group node. Groups can contain other groups and windows but NOT tabs directly (tabs always live under a window or another tab). Position defaults to TOP of the destination siblings (matches the manual UI). For Chrome tab groups (the colored-strip groups in the browser tab bar), Pinako mirrors what Chrome shows; create those by moving tabs together in a window via move_node, not via this op.',
    inputSchema: {
      title:     z.string().describe('Group title (trimmed, non-empty, max 200 chars).'),
      rowColor:  z.string().optional().describe('Optional row background color: a named color, hex string, or "accent2" (default, theme-tracking).'),
      parentId:  z.union([z.string(), z.null()]).optional().describe('Parent node id (must be another group or null for root).'),
      position:  z.number().optional().describe(POSITION_DESC + ' Default TOP if omitted.'),
      scope:     z.string().optional().describe(SCOPE_TREE_OR_LIBRARY),
      libraryId: z.string().optional().describe('Required when scope=library.'),
      browser:   z.string().optional().describe(BROWSER_ARG_DESC),
    },
  }, async (args) => writeToolHandler('create_group', args));

  srv.registerTool('delete_node', {
    description: 'DESTRUCTIVE — permanently removes a GHOST node (chromeId=null) and its metadata (tags, memos, star color, custom title). For scope="bookmarks", removes the bookmark from the browser via chrome.bookmarks.remove. REJECTS subtrees that contain any live tab (chromeId set) with LIVE_NODE_REFUSED — for live tabs, use ghost_node first (closes the browser tab, preserves the tree record) then delete_node, OR use delete_live_node which does both in one shot. REQUIRES EXPLICIT USER APPROVAL: set confirmedByUser:true ONLY after the user has confirmed THIS specific deletion. Once deleted, only Chrome history retains the URL — Pinako-specific metadata is gone permanently. Idempotent-on-retry: NODE_NOT_FOUND on a retry typically means the previous call succeeded but the response was lost; treat as success rather than re-asking the user.',
    inputSchema: {
      nodeId:          z.string().describe('Target ghost node id (or bookmark id when scope="bookmarks").'),
      confirmedByUser: z.literal(true).describe('Must be exactly TRUE. Set ONLY after explicit user approval of this specific destructive action.'),
      scope:           z.string().optional().describe(SCOPE_TREE_OR_LIBRARY),
      libraryId:       z.string().optional().describe('Required when scope=library.'),
      browser:         z.string().optional().describe(BROWSER_ARG_DESC),
    },
  }, async (args) => writeToolHandler('delete_node', args));

  srv.registerTool('ghost_node', {
    description: 'Closes the live browser tab(s) for this node and all live descendants, while preserving the tree node with chromeId=null on every ghosted node. Mirrors the manual "X" button. REVERSIBLE: the user can re-open from the tree later (URLs and metadata stay in the tree). Use this for "close these tabs but keep them saved" intents — end-of-day cleanup, freeing memory, archiving research. No confirmedByUser required (2026-05-11): the tree record is preserved so an erroneous ghost is undoable by re-opening. The browser-tab close is still visible, so narrate the intent before invoking ("I\'ll close these but they\'ll stay saved in your tree"). Returns NODE_NOT_LIVE if nothing in the subtree is live. Idempotent-on-retry: NODE_NOT_LIVE on retry typically means the previous call already ghosted everything; treat as success.',
    inputSchema: {
      nodeId:    z.string().describe('Target node id (tab, window, group, or folder). The node and all live descendants will be ghosted.'),
      scope:     z.string().optional().describe(SCOPE_TREE_OR_LIBRARY),
      libraryId: z.string().optional().describe('Required when scope=library.'),
      browser:   z.string().optional().describe(BROWSER_ARG_DESC),
    },
  }, async (args) => writeToolHandler('ghost_node', args));

  srv.registerTool('delete_live_node', {
    description: 'DESTRUCTIVE — closes the live browser tab(s) AND removes the tree node entirely (compound of ghost_node + delete_node, but bypasses delete_node\'s LIVE_NODE_REFUSED). Use when the user wants both the browser tabs gone AND the saved tree node gone. Mirrors the manual trash button on live nodes. REQUIRES EXPLICIT USER APPROVAL: set confirmedByUser:true ONLY after the user has confirmed THIS specific deletion — do not set it as a default. The engine and bridge both enforce this; missing the flag returns CONFIRMATION_REQUIRED.',
    inputSchema: {
      nodeId:          z.string().describe('Target node id. The node, all descendants, and any live browser tabs in the subtree will be removed.'),
      confirmedByUser: z.literal(true).describe('Must be exactly TRUE. Set ONLY after explicit user approval of this specific destructive action.'),
      scope:           z.string().optional().describe(SCOPE_TREE_OR_LIBRARY),
      libraryId:       z.string().optional().describe('Required when scope=library.'),
      browser:         z.string().optional().describe(BROWSER_ARG_DESC),
    },
  }, async (args) => writeToolHandler('delete_live_node', args));

  srv.registerTool('indent_node', {
    description: 'Nests a node under its previous sibling (one level deeper). Rejects when the node has no prior sibling (INDENT_NO_PREV_SIBLING). Auto-expands the new parent. Works across tree, library, and bookmark scopes — a common pattern for quickly de-nesting then re-organizing tabs. For scope="bookmarks", the parent change syncs to chrome.bookmarks.move (when the new parent is a folder) or to Pinako\'s tab-under-tab override (when the new parent is a tab/bookmark — chrome.bookmarks can\'t represent that natively).',
    inputSchema: {
      nodeId:    z.string().describe('Node to indent.'),
      scope:     z.string().optional().describe(SCOPE_TREE_OR_LIBRARY),
      libraryId: z.string().optional().describe('Required when scope=library.'),
      browser:   z.string().optional().describe(BROWSER_ARG_DESC),
    },
  }, async (args) => writeToolHandler('indent_node', args));

  srv.registerTool('outdent_node', {
    description: 'Promotes a node to its grandparent\'s level (one level shallower). Sibling-adoption preserves layout: the outdented node\'s younger siblings become its children, so visual row order is preserved. CHILD-EXTRACTION PATTERN: outdent the FIRST child of a target to free the target solo (target becomes empty, all children become adopted under the outdented first child). Works across tree, library, and bookmark scopes. For scope="bookmarks", the parent change (and each adopted sibling\'s new parent) syncs to chrome.bookmarks.move or to Pinako\'s tab-under-tab override depending on the new parent\'s type.',
    inputSchema: {
      nodeId:    z.string().describe('Node to outdent.'),
      scope:     z.string().optional().describe(SCOPE_TREE_OR_LIBRARY),
      libraryId: z.string().optional().describe('Required when scope=library.'),
      browser:   z.string().optional().describe(BROWSER_ARG_DESC),
    },
  }, async (args) => writeToolHandler('outdent_node', args));

  // ─── Library system ops ─────────────────────────────────────────────────────
  srv.registerTool('create_library', {
    description: 'Creates a new empty library with an auto-seeded "Notes" note. Returns createdLibraryId and createdNoteId in the result. Use add_to_library afterwards to populate. For just creating an organizational umbrella over EXISTING libraries, use create_library_group instead. NOT IDEMPOTENT: each call creates a new library. On transient failures (EDIT_TIMEOUT, FORWARDER_DISCONNECTED, LEADER_CHANGED, NM_WRITE_FAILED), DO NOT auto-retry — call list_libraries to check whether the previous attempt succeeded before retrying, otherwise you may create duplicates.',
    inputSchema: {
      title:       z.string().describe('Library title (trimmed, non-empty, max 200 chars).'),
      description: z.string().optional().describe('Optional description shown beneath title (max 1000 chars).'),
      browser:     z.string().optional().describe(BROWSER_ARG_DESC),
    },
  }, async (args) => writeToolHandler('create_library', args));

  srv.registerTool('add_to_library', {
    description: 'Clones nodes from a source surface into a library. INCLUDECHILDREN GUIDANCE: default true (subtree comes along, matching manual DND). Set FALSE when adding individual tabs ("add tab X to library") to avoid bundling unrelated nested children; keep TRUE for windows/groups/explicit "add subtree" requests. SOURCESCOPE: "tree" (default — main tab tree), "library" (cross-library copy; sourceLibraryId required), "bookmarks" (clone from bookmark tree), or "sync" (clone from a connected device — another Pinako install on the same account, or a Chrome-synced mobile device; sourceDeviceId required). For "sync" sources, mobile devices resolve instantly (eager-loaded); PC/browser devices may add ~50-300ms latency on first use as the device tree fetches from Pinako cloud (cached for the rest of the session). Engine auto-wraps tab clones into ONE new window in the destination (libraries require tabs to have a window/tab/folder parent). Max 100 source ids per call.',
    inputSchema: {
      nodeIds:         z.array(z.string()).min(1).describe('Source node ids (max 100). Order of clones matches order here.'),
      libraryId:       z.string().describe('Destination library id.'),
      includeChildren: z.boolean().optional().describe('Default TRUE: include each source node\'s subtree. Set FALSE to clone only the leaf node.'),
      sourceScope:     z.string().optional().describe('"tree" (default), "library", "bookmarks", or "sync".'),
      sourceLibraryId: z.string().optional().describe('Required when sourceScope="library".'),
      sourceDeviceId:  z.string().optional().describe('Required when sourceScope="sync". Use the syncDevices.id of the device card (e.g. "device-pc", "device-phone").'),
      position:        z.number().optional().describe(POSITION_DESC),
      browser:         z.string().optional().describe(BROWSER_ARG_DESC),
    },
  }, async (args) => writeToolHandler('add_to_library', args));

  srv.registerTool('set_note_content', {
    description: 'Updates an existing note\'s content. MODE GUIDANCE: "replace" (default) overwrites — use for "update note X with Y", "replace note X". "append" concatenates after existing content — use for "add Y to note X", "note down that ...". For prepend, read existing content first then call replace with the combined string. Note char limit is tier-gated (50K Pro / 150K Pro+ / 250K Premium / 500K Enterprise); for append mode the FINAL length is what\'s gated. Note content is sanitized at write time (HTML allowlist; <script>, on* event handlers, javascript: URLs are stripped) — write valid Tiptap-compatible HTML or plain text. Idempotent on retry for replace mode; append mode on retry would double-append, so DO NOT auto-retry append on transient failures — re-read first.',
    inputSchema: {
      noteId:    z.string().describe('Note id within the target notes array.'),
      content:   z.string().describe('Note content (max varies by tier; see description).'),
      mode:      z.string().optional().describe('"replace" (default) or "append".'),
      scope:     z.string().describe(SCOPE_NOTES),
      libraryId: z.string().optional().describe('Required when scope=library-notes.'),
      browser:   z.string().optional().describe(BROWSER_ARG_DESC),
    },
  }, async (args) => writeToolHandler('set_note_content', args));

  srv.registerTool('create_note', {
    description: 'Creates a new note in a library or in global notes. Use this when the user says "create a note about X", "save these findings as a new note", etc. For UPDATING an existing note, use set_note_content. Returns createdNoteId. Char limit is tier-gated. Note content is sanitized at write time (HTML allowlist; <script>, on* event handlers, javascript: URLs are stripped) — write valid Tiptap-compatible HTML or plain text. NOT IDEMPOTENT: each call creates a new note. On transient failures, DO NOT auto-retry — call get_library or get_global_notes to check whether the previous attempt succeeded before retrying.',
    inputSchema: {
      title:     z.string().describe('Note title (trimmed, non-empty, max 200 chars).'),
      content:   z.string().optional().describe('Initial content (default empty). Char limit varies by tier.'),
      scope:     z.string().describe(SCOPE_NOTES),
      libraryId: z.string().optional().describe('Required when scope=library-notes.'),
      browser:   z.string().optional().describe(BROWSER_ARG_DESC),
    },
  }, async (args) => writeToolHandler('create_note', args));

  // ─── Library Group ops ──────────────────────────────────────────────────────
  srv.registerTool('create_library_group', {
    description: 'Creates a new library group (an organizational umbrella over multiple libraries). Returns createdGroupId. After creating, use add_library_to_group to add member libraries. NOT IDEMPOTENT: each call creates a new group. On transient failures, DO NOT auto-retry — call list_libraries to inspect existing groups before retrying.',
    inputSchema: {
      title:       z.string().describe('Group title (trimmed, non-empty, max 200 chars).'),
      description: z.string().optional().describe('Optional group description (max 1000 chars).'),
      browser:     z.string().optional().describe(BROWSER_ARG_DESC),
    },
  }, async (args) => writeToolHandler('create_library_group', args));

  srv.registerTool('delete_library_group', {
    description: 'Removes a library group. TWO MODES via cascadeMembers: (1) DEFAULT (cascadeMembers omitted/false) — DISSOLVE: member libraries are KEPT and re-appear in the standalone library card list at the position the group occupied. Safe; non-destructive. (2) cascadeMembers:true — DESTRUCTIVE: also deletes each member library (owned libraries are deleted from cloud; linked libraries are unlinked from this account). REQUIRES EXPLICIT USER APPROVAL when cascadeMembers:true: set confirmedByUser:true ONLY after the user has confirmed they want to lose the libraries\' content. Cascade is one-way — undo restores group structure but NOT the cascaded libraries\' content. Engine + bridge both enforce confirmedByUser when cascading.',
    inputSchema: {
      groupId:         z.string().describe('Group id to remove.'),
      cascadeMembers:  z.boolean().optional().describe('FALSE (default) = dissolve, libraries kept. TRUE = also delete member libraries. Destructive when true.'),
      confirmedByUser: z.literal(true).optional().describe('Required to be TRUE when cascadeMembers:true. Set ONLY after explicit user approval of cascade deletion.'),
      browser:         z.string().optional().describe(BROWSER_ARG_DESC),
    },
  }, async (args) => writeToolHandler('delete_library_group', args));

  srv.registerTool('add_library_to_group', {
    description: 'Adds an existing library to an existing group. A library can belong to at most one group; rejects with LIBRARY_ALREADY_IN_GROUP / LIBRARY_IN_OTHER_GROUP if it\'s already assigned somewhere.',
    inputSchema: {
      groupId:   z.string().describe('Target group id.'),
      libraryId: z.string().describe('Library id to add.'),
      position:  z.number().optional().describe(POSITION_DESC + ' Default appends.'),
      browser:   z.string().optional().describe(BROWSER_ARG_DESC),
    },
  }, async (args) => writeToolHandler('add_library_to_group', args));

  srv.registerTool('remove_library_from_group', {
    description: 'Removes a library from a group, returning it to the standalone library card list right after the group. The library itself is preserved. No-op if the library wasn\'t in the group (removing a stale ref is valid cleanup).',
    inputSchema: {
      groupId:   z.string().describe('Source group id.'),
      libraryId: z.string().describe('Library id to remove from the group.'),
      browser:   z.string().optional().describe(BROWSER_ARG_DESC),
    },
  }, async (args) => writeToolHandler('remove_library_from_group', args));

  srv.registerTool('set_library_group_title', {
    description: 'Renames a library group. Trimmed, non-empty, max 200 chars.',
    inputSchema: {
      groupId: z.string().describe('Target group id.'),
      title:   z.string().describe('New title.'),
      browser: z.string().optional().describe(BROWSER_ARG_DESC),
    },
  }, async (args) => writeToolHandler('set_library_group_title', args));

  srv.registerTool('set_library_group_description', {
    description: 'Updates a library group\'s description. Empty string clears it. Max 1000 chars.',
    inputSchema: {
      groupId:     z.string().describe('Target group id.'),
      description: z.string().describe('New description (empty string clears).'),
      browser:     z.string().optional().describe(BROWSER_ARG_DESC),
    },
  }, async (args) => writeToolHandler('set_library_group_description', args));

  srv.registerTool('reorder_library_panel', {
    description: 'Reorders the cards in the library panel (standalone library cards + library group cards). Pass the COMPLETE current list of entries in the desired order. Each entry is {type:"library"|"group", id:<id>}. ORDER ONLY — every existing entry must be present (rejects with PANEL_ORDER_MISMATCH if count differs, PANEL_ORDER_UNKNOWN_ENTRY if an unknown id is introduced). Use create_library / delete_library_group / etc. to change membership; this op cannot add or remove cards. Use list_libraries first to see current ordering, then submit the rearranged list. Max 200 entries.',
    inputSchema: {
      entries: z.array(z.object({
        type: z.string().describe('"library" or "group"'),
        id:   z.string().describe('Library or group id'),
      })).describe('Full ordered list of panel cards. Must match current set exactly.'),
      browser: z.string().optional().describe(BROWSER_ARG_DESC),
    },
  }, async (args) => writeToolHandler('reorder_library_panel', args));

  // ─── Bookmark-scope ops (Phase 3 Slice G) ──────────────────────────────────
  // Standard agent ops (move_node, set_title, delete_node) accept scope='bookmarks'
  // to operate on the browser's native bookmark tree. Plus a dedicated
  // create_folder tool for new bookmark folders.

  srv.registerTool('create_folder', {
    description: 'Creates a new folder node in a library or in the browser bookmarks. NOT for the main tab tree (the main tree uses windows + groups, not folders). Required scope: "library" (with libraryId) or "bookmarks". Default position is TOP of the parent (matches manual UI). For bookmarks, the folder is also created in the browser\'s native bookmark tree via chrome.bookmarks.create — synced automatically. parentId omitted/null places the new folder at the scope root.',
    inputSchema: {
      title:     z.string().describe('Folder title (trimmed, non-empty, max 200 chars).'),
      rowColor:  z.string().optional().describe('Optional row background color: a named color, hex string, or "accent2" (default).'),
      parentId:  z.union([z.string(), z.null()]).optional().describe('Parent folder id, or null for scope root.'),
      position:  z.number().optional().describe(POSITION_DESC + ' Default TOP if omitted.'),
      scope:     z.string().describe('"library" or "bookmarks".'),
      libraryId: z.string().optional().describe('Required when scope=library.'),
      browser:   z.string().optional().describe(BROWSER_ARG_DESC),
    },
  }, async (args) => writeToolHandler('create_folder', args));

  srv.registerTool('reorder_libraries_in_group', {
    description: 'Reorders the libraries within a single library group. Pass the COMPLETE current list of member library ids in the desired order. ORDER ONLY — every current member must be present (rejects with LIBRARY_ORDER_MISMATCH if count differs, LIBRARY_ORDER_UNKNOWN_MEMBER if an unknown id is introduced, LIBRARY_ORDER_DUPLICATE if duplicates). Use add_library_to_group / remove_library_from_group to change membership. Max 200.',
    inputSchema: {
      groupId:    z.string().describe('Target group id.'),
      libraryIds: z.array(z.string()).describe('Full ordered list of member library ids. Must match current membership exactly.'),
      browser:    z.string().optional().describe(BROWSER_ARG_DESC),
    },
  }, async (args) => writeToolHandler('reorder_libraries_in_group', args));

  // ─── Composite ─────────────────────────────────────────────────────────────
  srv.registerTool('bulk_apply', {
    description: 'Atomically applies up to 100 sub-ops as a SINGLE undoable unit. Use for multi-step reorganizations ("move these 12 tabs into a new library called Research") so the user can undo the whole thing in one click. SUB-OP SCOPE INHERITANCE: sub-ops without explicit scope/libraryId inherit the bulk\'s; explicitly setting a different value is rejected (BULK_SCOPE_MISMATCH / BULK_LIBRARY_MISMATCH). EXCEPTION for create_note and set_note_content: their schemas accept two valid scopes (library-notes, global-notes), so EVERY sub-op of those types must include its own explicit scope field — bulk\'s outer scope is NOT auto-filled in. NESTING: bulk_apply cannot contain another bulk_apply. PER-SUB-OP CONFIRMATION: each destructive sub-op (delete_node, delete_live_node, delete_library_group with cascadeMembers:true) requires its OWN confirmedByUser:true field — the bulk_apply wrapper does NOT confer confirmation to sub-ops; obtain user approval for each destructive action individually. ERROR LOCATION: on failure, error.context.subOpIndex (and a "Sub-op N:" prefix in the message) identifies the failing sub-op — correct and resubmit just that one in a new bulk_apply, or fix and resubmit the whole batch.',
    inputSchema: {
      ops:       z.array(z.object({}).passthrough()).min(1).describe('Array of agent ops (each with type + fields). Max 100.'),
      scope:     z.string().optional().describe('Default scope for sub-ops that omit it. NOT applied to create_note / set_note_content sub-ops (must specify per sub-op).'),
      libraryId: z.string().optional().describe('Default libraryId for sub-ops that omit it.'),
      browser:   z.string().optional().describe(BROWSER_ARG_DESC),
    },
  }, async (args) => writeToolHandler('bulk_apply', args));

  return srv;
}

// ─── HTTP server ──────────────────────────────────────────────────────────────
// Each MCP session gets its own transport instance (required by the SDK).
// Sessions are tracked by the Mcp-Session-Id header the server assigns.
const activeSessions = new Map(); // sessionId → StreamableHTTPServerTransport

const httpServer = http.createServer(async (req, res) => {
  // Health check
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      extensionConnected,
      browsers: [...cachedData.values()].map(d => ({
        browserBrand: d.browserBrand,
        browserId:    d.browserId,
        dataAge:      Date.now() - d.updatedAt,
      })),
    }));
    return;
  }

  // Debug: shows last 10 requests to /mcp
  if (req.url === '/debug') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ recentRequests }, null, 2));
    return;
  }

  // Internal: new host instance forwards fresh data here when EADDRINUSE
  if (req.url === '/update' && req.method === 'POST') {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const { data, browserId, browserBrand, userTier, userId, forwarderToken } = body;
        if (data) {
          const id    = browserId    || 'unknown';
          const brand = browserBrand || 'Unknown';
          // Phase 3 Slice B: per-browser tier flows through the forwarder
          // relay too. Same fail-closed default as the leader's NM path.
          const tier  = Number.isFinite(userTier) ? userTier : 0;
          const uid   = typeof userId === 'string' ? userId : '';
          // 2026-05-11: forwarderToken binds the SSE channel + /edit-result
          // posts for this browserId to the forwarder that just POSTed
          // /update. Stored alongside other browser identity so leader-side
          // /edits and /edit-result validators can match.
          const fwToken = (typeof forwarderToken === 'string' && forwarderToken.length > 0) ? forwarderToken : null;
          // 2026-05-11: docs uses the same preserve-when-omitted pattern as
          // handleNmMessage. The /update relay can fire twice within a few
          // seconds when an extension's SW calls connectNative more than once
          // (popup-open + reconnect, dev-mode toggle, etc.) — one path
          // populates docs via NM, then a forwarder relays a docsless update
          // that would wipe them. Preserve cached docs when the incoming
          // payload omits the field. Same shape for bookmarks would have
          // helped earlier; leaving the literal bookmarks fallback in place
          // for now since it matches what extension always sends today.
          const priorCache = cachedData.get(id);
          const docsField = (data && 'docs' in data)
            ? (data.docs || [])
            : (priorCache?.docs || []);
          cachedData.set(id, {
            tree:           data.tree         || [],
            libraries:      data.libraries    || [],
            globalNotes:    data.globalNotes  || [],
            bookmarks:      data.bookmarks    || [],
            docs:           docsField,
            updatedAt:      Date.now(),
            browserId:      id,
            browserBrand:   brand,
            userTier:       tier,
            userId:         uid,
            forwarderToken: fwToken,
          });
          // Same diagnostic line as the NM path so we can tell at a glance
          // whether docs were preserved or overwritten.
          try {
            const incomingDocs = Array.isArray(data?.docs) ? data.docs.length : '<absent>';
            log(`/update from ${brand}: incoming docs=${incomingDocs} → stored docs=${docsField.length} windows=${data?.tree?.length || 0}`);
          } catch (_) {}
          extensionConnected = true;
          if (shutdownTimer) { clearTimeout(shutdownTimer); shutdownTimer = null; }
          process.stderr.write(`[pinako-mcp] Cache refreshed via /update from ${brand}.\n`);
        }
        res.writeHead(200); res.end();
      } catch { res.writeHead(400); res.end(); }
    });
    return;
  }

  // ─── Phase 2 Slice B: leader-only endpoint guard ──────────────────────────
  // /edit, /edit-result, and /edits are leader-only — only the bridge
  // process holding port 37421 should serve these. Forwarders don't bind
  // their own HTTP server today, so this guard is mostly defensive against
  // the millisecond-scale race window during forwarder→leader promotion
  // (forwardToExisting clears synchronously after listen() succeeds, but
  // a request could in principle land mid-promotion).
  if (forwardToExisting && (
        req.url === '/edit' ||
        req.url === '/edit-result' ||
        (req.url && req.url.startsWith('/edits'))
      )) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: false,
      error: { code: 'LEADER_ONLY', message: 'This endpoint is served by the leader bridge only. Forwarders are read-only.' },
    }));
    return;
  }

  // ─── Phase 2 Slice B: SSE channel for forwarders ──────────────────────────
  // GET /edits?browserId=X opens a long-running text/event-stream. The leader
  // keeps the connection open and writes `event: applyEdit\ndata: {...}\n\n`
  // events when /edit dispatches to that browserId. Forwarder bridges relay
  // each event to their local extension via NM. Heartbeats every 25s keep the
  // connection alive across any localhost OS-idle timers. On req close, the
  // leader drops the forwarder entry and rejects in-flight pending edits for
  // that browserId so the AI client gets a fast failure.
  if (req.url && req.url.startsWith('/edits') && req.method === 'GET') {
    const url = new URL(req.url, 'http://127.0.0.1');
    const browserId = url.searchParams.get('browserId');
    const token     = url.searchParams.get('token');
    if (!browserId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: { code: 'BAD_REQUEST', message: 'GET /edits requires ?browserId=X' } }));
      return;
    }
    // 2026-05-11: token-bind the SSE subscription to the forwarder that
    // registered the underlying /update for this browserId. Without this,
    // any local process could subscribe to a victim browserId's edit
    // stream, observe full set_note_content payloads, and spoof results
    // via /edit-result. The expected token was stored when /update arrived.
    const expectedToken = cachedData.get(browserId)?.forwarderToken || null;
    if (!expectedToken) {
      // No /update has registered for this browserId yet (or registered
      // without a token — pre-2026-05-11 forwarders). Reject so the
      // attacker can't subscribe before the legitimate forwarder
      // establishes the binding.
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: { code: 'TOKEN_REQUIRED', message: 'No forwarder is registered for this browserId yet. Re-POST /update with forwarderToken first.' } }));
      return;
    }
    if (!token || token !== expectedToken) {
      log(`SSE /edits rejected for browserId=${browserId.slice(0,16)}… — token mismatch`);
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: { code: 'TOKEN_MISMATCH', message: 'forwarderToken does not match the token recorded on the most recent /update for this browserId.' } }));
      return;
    }
    // Reject a SECOND active SSE for the same browserId (rather than
    // evicting the first). Pre-2026-05-11 we evicted; combined with no
    // token check this let an attacker repeatedly steal the channel
    // from the legitimate forwarder. Now: the legitimate forwarder
    // keeps its channel; if its process actually died, req.on('close')
    // already dropped the entry, so this guard only fires on contention.
    if (forwarders.has(browserId)) {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: { code: 'SSE_ALREADY_CONNECTED', message: 'A forwarder is already subscribed to this browserId. Wait for the existing channel to close, or POST /update with a different forwarderToken to invalidate it.' } }));
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
    });
    res.write(`event: ready\ndata: {"browserId":"${browserId}"}\n\n`);
    const heartbeatTimer = setInterval(() => {
      try { res.write(`: hb\n\n`); }
      catch (_) { /* will fire 'close' below */ }
    }, SSE_HEARTBEAT_MS);
    forwarders.set(browserId, { sseRes: res, heartbeatTimer });
    log(`Forwarder SSE connected: browserId=${browserId.slice(0,16)}…`);
    req.on('close', () => { _dropForwarder(browserId, 'SSE req close'); });
    return;
  }

  // POST /edit-result — forwarders relay editApplied/editFailed back to us.
  // Body: { requestId, ok, result?, error? }. We resolve the matching
  // pendingEdits entry. Late replies (after timeout removed the entry) are
  // silently dropped, matching the NM-direct path's behavior in handleNmMessage.
  if (req.url === '/edit-result' && req.method === 'POST') {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const { requestId, forwarderToken } = body;
        if (!requestId) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: { code: 'BAD_REQUEST', message: 'POST /edit-result requires { requestId }' } }));
          return;
        }
        const pending = pendingEdits.get(requestId);
        if (pending) {
          // 2026-05-11: token-bind /edit-result to the forwarder that owns
          // the target browserId. Without this, any local process that
          // observed a requestId (via /debug, or by guessing) could spoof
          // a successful editApplied for the AI client. SSE-routed pending
          // entries have entry.browserId; the leader's expected token for
          // that browserId is in cachedData. Local-NM pending entries
          // (entry.path === 'local') bypass the token — no /edit-result
          // post comes from a separate process for those.
          if (pending.path === 'sse') {
            const expectedToken = cachedData.get(pending.browserId)?.forwarderToken || null;
            if (!expectedToken || forwarderToken !== expectedToken) {
              log(`/edit-result rejected for requestId=${requestId.slice(0,8)} — token mismatch (browserId=${(pending.browserId||'').slice(0,16)}…)`);
              res.writeHead(401, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: false, error: { code: 'TOKEN_MISMATCH', message: 'forwarderToken does not match the token recorded for this browserId.' } }));
              return;
            }
          }
          clearTimeout(pending.timer);
          pendingEdits.delete(requestId);
          if (body.ok) {
            pending.resolve(body.result || { ok: true, requestId });
          } else {
            pending.resolve({
              ok: false,
              requestId,
              error: body.error || { code: 'UNKNOWN_EDIT_FAILURE', message: '/edit-result without error details' },
            });
          }
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        log(`POST /edit-result error: ${e.message}`);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: { code: 'INTERNAL', message: e.message } }));
      }
    });
    return;
  }

  // ─── /edit endpoint (curl-testable; Slice A introduced, Slice A→B evolved) ──
  // Body: { op: <agent op shape>, browser?: <browserId|brand> }
  // Response: { ok, requestId?, error?, ...wrapper-result-fields }
  // Status: 200 ok, 400 BAD_REQUEST/BROWSER_NOT_FOUND, 503 BRIDGE_NOT_READY/
  //         FORWARDER_NOT_CONNECTED, 502 wrapper/engine/timeout failures.
  // After Phase 3 Slice A: routing + dispatch live in executeEdit; this
  // handler is just the HTTP wrapper. The MCP write tools registered in
  // createMcpServer() share executeEdit so their responses are identical.
  if (req.url === '/edit' && req.method === 'POST') {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', async () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const result = await executeEdit(body.op, body.browser);
        res.writeHead(httpStatusForEditResult(result), { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (e) {
        log(`POST /edit error: ${e.message}`);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: { code: 'INTERNAL', message: e.message } }));
      }
    });
    return;
  }

  if (req.url !== '/mcp') { res.writeHead(404); res.end(); return; }

  if (req.method === 'POST') {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', async () => {
      const body = Buffer.concat(chunks).toString('utf8');
      let parsed;
      try { parsed = body ? JSON.parse(body) : undefined; } catch (_) {}
      logRequest('POST /mcp', req, parsed);
      try {
        const sessionId = req.headers['mcp-session-id'];
        let transport;

        if (sessionId && activeSessions.has(sessionId)) {
          // Existing session — reuse its transport
          transport = activeSessions.get(sessionId);
        } else if (parsed?.method === 'initialize') {
          // New session — create a fresh transport + McpServer pair
          transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (id) => {
              activeSessions.set(id, transport);
              log(`MCP session created: ${id}`);
            },
            enableJsonResponse: true,
          });
          transport.onclose = () => {
            const id = [...activeSessions.entries()].find(([, t]) => t === transport)?.[0];
            if (id) { activeSessions.delete(id); log(`MCP session closed: ${id}`); }
          };
          const srv = createMcpServer();
          await srv.connect(transport);
        } else {
          // Unknown session ID for a non-initialize call. Per MCP streamable
          // HTTP spec, servers MUST return 404 (not 400) so SDK clients can
          // auto-recover by re-sending `initialize` on a fresh session. The
          // common case where this fires today is leader rotation: AI client
          // holds a session id from the previous leader, sends its next tool
          // call, lands on a new leader that has an empty activeSessions Map.
          // 404 here lets the official @modelcontextprotocol SDK transparently
          // re-handshake instead of surfacing "Bad Request" to the AI.
          log(`POST /mcp 404: unrecognized session (mcp-session-id=${sessionId}, method=${parsed?.method})`);
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: 'Session not found — reinitialize.' }, id: null }));
          return;
        }

        await transport.handleRequest(req, res, parsed);
        log(`POST /mcp done (status ${res.statusCode})`);
      } catch (e) {
        log(`POST /mcp error: ${e.message}\n${e.stack}`);
        if (!res.headersSent) { res.writeHead(500); res.end(JSON.stringify({ error: String(e.message) })); }
      }
    });
  } else {
    // GET (SSE stream) / DELETE / OPTIONS
    logRequest(`${req.method} /mcp`, req, null);
    try {
      const sessionId = req.headers['mcp-session-id'];
      const transport = sessionId ? activeSessions.get(sessionId) : undefined;
      if (!transport) {
        // Spec-compliant 404 for unknown session — see POST /mcp handler for
        // the rationale. Lets compliant MCP SDKs re-handshake transparently
        // instead of failing the request.
        log(`${req.method} /mcp 404: unrecognized session (mcp-session-id=${sessionId})`);
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: 'Session not found — reinitialize.' }, id: null }));
        return;
      }
      await transport.handleRequest(req, res);
      log(`${req.method} /mcp done`);
    } catch (e) {
      log(`${req.method} /mcp error: ${e.message}\n${e.stack}`);
      if (!res.headersSent) { res.writeHead(500); res.end(); }
    }
  }
});

// HTTP server only listens in default mode. The bridge mode is purely a
// stdio↔HTTP proxy and never opens a port itself.
//
// Forwarder takeover. When a forwarder is running and the leader exits
// (zombie-leader EPIPE detection above, or any other reason), port 37421
// becomes free. Without active retry, the forwarder stays in forwarder
// mode forever and only the next SW reconnect (which spawns a fresh
// bridge) ever restores HTTP service. Periodic re-bind closes that gap:
// every PROMOTE_RETRY_MS, the forwarder tries to bind. On success it
// becomes the new leader and clears `forwardToExisting`.
const PROMOTE_RETRY_MS = 5_000;
let promoteTimer = null;

function attemptListen() {
  return new Promise((resolve) => {
    let resolved = false;
    const onceErr = (e) => {
      if (resolved) return;
      resolved = true;
      httpServer.removeListener('listening', onceOk);
      resolve({ ok: false, error: e });
    };
    const onceOk = () => {
      if (resolved) return;
      resolved = true;
      httpServer.removeListener('error', onceErr);
      resolve({ ok: true });
    };
    httpServer.once('error', onceErr);
    httpServer.once('listening', onceOk);
    httpServer.listen(MCP_PORT, '127.0.0.1');
  });
}

async function tryBindOrForward(initialAttempt) {
  const r = await attemptListen();
  if (r.ok) {
    if (!initialAttempt) {
      log(`Forwarder promoted to leader; bound port ${MCP_PORT}.`);
    }
    forwardToExisting = null;
    if (promoteTimer) { clearInterval(promoteTimer); promoteTimer = null; }
    // Tear down forwarder-side SSE state — we ARE the leader now and don't
    // need a /edits stream against ourselves. Pending applyEdit events on the
    // old leader's queue were already failed when its SSE channel closed.
    if (sseClientReconnect) { clearTimeout(sseClientReconnect); sseClientReconnect = null; }
    if (sseClientReq) { try { sseClientReq.destroy(); } catch (_) {} sseClientReq = null; }
    extensionConnected = true;
    process.stderr.write(`[pinako-mcp] Listening on http://127.0.0.1:${MCP_PORT}/mcp\n`);
    nmWrite({ type: 'getTree' });
    return;
  }
  if (r.error && r.error.code === 'EADDRINUSE') {
    if (initialAttempt) {
      process.stderr.write(`[pinako-mcp] Port ${MCP_PORT} in use — relaying to existing instance.\n`);
      forwardToExisting = (payload) => {
        // 2026-05-11: include forwarderToken on every /update so the leader
        // can token-bind this browserId's SSE subscription + /edit-result
        // posts to THIS process. Without it, any local process could spoof.
        const body = JSON.stringify({ ...payload, forwarderToken: _myForwarderToken });
        const req = http.request(
          { hostname: '127.0.0.1', port: MCP_PORT, path: '/update', method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
          () => { process.stderr.write(`[pinako-mcp] Relayed tree update from ${payload.browserBrand || 'unknown'}.\n`); }
        );
        req.on('error', (err) => { process.stderr.write(`[pinako-mcp] Relay error: ${err.message}\n`); });
        req.write(body); req.end();
      };
      nmWrite({ type: 'getTree' });
      // Start promotion polling so we can take over when the leader dies.
      if (!promoteTimer) {
        promoteTimer = setInterval(() => { tryBindOrForward(false).catch(() => {}); }, PROMOTE_RETRY_MS);
      }
    }
    // else: still busy on retry, leave forwarder running and try again next tick.
    return;
  }
  process.stderr.write(`[pinako-mcp] HTTP error: ${r.error?.message || 'unknown'}\n`);
  if (initialAttempt) process.exit(1);
}

if (!BRIDGE_URL) {
  tryBindOrForward(true);
}

// ─── Stdio MCP bridge mode ────────────────────────────────────────────────────
// When invoked with `--stdio-mcp <URL>`, act as a stdio MCP server that proxies
// every JSON-RPC message to a local HTTP MCP server. Used by Claude Desktop,
// whose mcpServers config only accepts stdio subprocesses (command + args).
// Replaces the need for `npx mcp-remote` and the Node.js dependency on the
// end user's machine.
async function runStdioBridge(httpUrl) {
  const stdio  = new StdioServerTransport();
  const remote = new StreamableHTTPClientTransport(new URL(httpUrl));

  // stdio (from Claude Desktop) → remote (HTTP MCP server)
  stdio.onmessage = async (msg) => {
    try {
      await remote.send(msg);
    } catch (err) {
      process.stderr.write(`[stdio-mcp] forward error: ${err.message}\n`);
      // Return a JSON-RPC error if this was a request (has id)
      if (msg && msg.id !== undefined && msg.id !== null) {
        try {
          await stdio.send({
            jsonrpc: '2.0',
            id: msg.id,
            error: {
              code: -32603,
              message: `Pinako bridge: ${err.message}. Make sure the Pinako extension is open.`,
            },
          });
        } catch (_) { /* stdio gone, give up */ }
      }
    }
  };

  // remote → stdio (forward responses back to Claude Desktop)
  remote.onmessage = async (msg) => {
    try {
      await stdio.send(msg);
    } catch (err) {
      process.stderr.write(`[stdio-mcp] reply error: ${err.message}\n`);
    }
  };

  remote.onerror = (err) => {
    process.stderr.write(`[stdio-mcp] remote transport error: ${err.message}\n`);
  };
  stdio.onerror = (err) => {
    process.stderr.write(`[stdio-mcp] stdio transport error: ${err.message}\n`);
  };

  // Start stdio first (always succeeds — local pipes only).
  await stdio.start();

  // Try to connect to the remote, but stay alive even if the extension
  // isn't open yet. Per-call errors give a useful message; restarting
  // Claude Desktop after opening Pinako isn't required.
  try {
    await remote.start();
    process.stderr.write(`[stdio-mcp] connected to ${httpUrl}\n`);
  } catch (err) {
    process.stderr.write(`[stdio-mcp] could not connect to ${httpUrl} yet: ${err.message}\n`);
    process.stderr.write(`[stdio-mcp] open the Pinako extension and tools will start working.\n`);
  }

  // Shut down cleanly when Claude Desktop closes the stdio pipe.
  process.stdin.on('end', async () => {
    process.stderr.write('[stdio-mcp] stdin closed, shutting down\n');
    try { await stdio.close();  } catch (_) {}
    try { await remote.close(); } catch (_) {}
    process.exit(0);
  });
}

if (BRIDGE_URL) {
  runStdioBridge(BRIDGE_URL).catch((err) => {
    process.stderr.write(`[pinako-mcp stdio bridge] fatal: ${err.message}\n`);
    process.exit(1);
  });
}
