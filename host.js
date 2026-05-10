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
import { randomUUID } from 'node:crypto';

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
      forwardToExisting({ data: msg.data, browserId, browserBrand });
      _ensureSseConnection();
      return;
    }
    if (shutdownTimer) {
      clearTimeout(shutdownTimer);
      shutdownTimer = null;
    }
    extensionConnected = true;
    cachedData.set(browserId, {
      tree:         msg.data.tree         || [],
      libraries:    msg.data.libraries    || [],
      globalNotes:  msg.data.globalNotes  || [],
      bookmarks:    msg.data.bookmarks    || [],
      updatedAt:    Date.now(),
      browserId,
      browserBrand,
    });
    process.stderr.write(`[pinako-mcp] Tree updated from ${browserBrand} (${browserId.slice(0,16)}…): ${msg.data.tree?.length || 0} windows.\n`);
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
    path: `/edits?browserId=${encodeURIComponent(localBrowserId)}`,
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
    requestId: msg.requestId,
    ok:        msg.type === 'editApplied',
    result:    msg.result,
    error:     msg.error,
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

// ─── Phase 3 Slice A: unified edit dispatch ───────────────────────────────────
// Single entry point for agent ops, used by both the curl-testable /edit
// endpoint and every MCP write tool registered in createMcpServer(). Validates
// the op shape minimally, resolves the target browser via resolveBrowserData,
// then routes to local NM (Slice A) or SSE forwarder (Slice B). Returns a
// uniform result shape: { ok: true, ...wrapperResult } or { ok: false, error }.
// The 22 MCP write tools call this directly; /edit also calls it and translates
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
const SERVER_INSTRUCTIONS = `Pinako is a browser tab manager Chrome extension. This MCP server gives you read access to the user's live tab data.

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
      description: 'Lists all Pinako installs currently connected to this MCP server. Each entry: browserBrand (human-readable name like "Chrome" or "Brave"), browserId (stable per-install id), updatedAt (timestamp of last data update), windowCount (live windows), libraryCount. Use the browserBrand or browserId as the "browser" argument to other tools when multiple browsers are connected.',
    },
    async () => {
      const browsers = [...cachedData.values()].map(d => ({
        browserBrand:  d.browserBrand,
        browserId:     d.browserId,
        updatedAt:     d.updatedAt,
        windowCount:   (d.tree || []).filter(n => !n.incognito).length,
        libraryCount:  (d.libraries || []).length,
        bookmarkCount: (d.bookmarks || []).reduce((acc, root) => acc + countBookmarksRecursive(root), 0),
      }));
      return { content: [{ type: 'text', text: JSON.stringify({ browsers, count: browsers.length }) }] };
    }
  );

  // ═══ Write tools (Phase 3 Slice A) ═════════════════════════════════════════
  // 22 agent ops registered as MCP tools so AI clients (Claude Desktop, Cursor,
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
    description: 'APPENDS tags to a node, deduping and preserving order of existing tags. Use this when the user says "tag X with Y" or "also add Z" — it preserves prior tags. Use set_tags for full replacement, remove_tags for deletion.',
    inputSchema: {
      nodeId:    z.string().describe('Target node id.'),
      tags:      z.array(z.string()).min(1).describe('Tags to append (deduped against existing).'),
      scope:     z.string().optional().describe(SCOPE_TREE_OR_LIBRARY),
      libraryId: z.string().optional().describe('Required when scope=library.'),
      browser:   z.string().optional().describe(BROWSER_ARG_DESC),
    },
  }, async (args) => writeToolHandler('add_tags', args));

  srv.registerTool('remove_tags', {
    description: 'Filters specific tags off a node, preserving the rest. No-op for tags not present. Use this for "untag X from Y" requests.',
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
    description: 'Sets the row star color on a node. Accepts a named color (e.g. "yellow", "red", "purple") or an explicit hex (e.g. "#ffaa00"). Pass null to clear.',
    inputSchema: {
      nodeId:    z.string().describe('Target node id.'),
      color:     z.union([z.string(), z.null()]).describe('Color name, hex string, or null to clear.'),
      scope:     z.string().optional().describe(SCOPE_TREE_OR_LIBRARY),
      libraryId: z.string().optional().describe('Required when scope=library.'),
      browser:   z.string().optional().describe(BROWSER_ARG_DESC),
    },
  }, async (args) => writeToolHandler('set_star_color', args));

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
    description: 'Moves a node (and its full subtree) under newParentId at an optional position. SUBTREE SEMANTICS: all descendants come along. To move ONLY the node WITHOUT its children (e.g., "move tab X but leave the nested tabs"), use the outdent-first-child pattern: outdent the node\'s first child first (sibling-adoption pulls the rest under it), then move the now-empty target. Or wrap both ops in a single bulk_apply for atomicity. Pass newParentId=null to move to root (auto-wraps tabs into a new window).',
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
    description: 'Deletes a GHOST node (chromeId=null — closed/saved tabs that the user preserved in the tree). REJECTS subtrees that contain any live node (chromeId set) — those need a separate flow that closes the browser tab/window first, gated behind user confirmation (deferred to a later phase). Use this for "clean up these saved tabs I don\'t need anymore".',
    inputSchema: {
      nodeId:    z.string().describe('Target ghost node id.'),
      scope:     z.string().optional().describe(SCOPE_TREE_OR_LIBRARY),
      libraryId: z.string().optional().describe('Required when scope=library.'),
      browser:   z.string().optional().describe(BROWSER_ARG_DESC),
    },
  }, async (args) => writeToolHandler('delete_node', args));

  srv.registerTool('indent_node', {
    description: 'Nests a node under its previous sibling (one level deeper). Rejects when the node has no prior sibling (INDENT_NO_PREV_SIBLING). Auto-expands the new parent. Tree-only (not for libraries or bookmarks).',
    inputSchema: {
      nodeId:    z.string().describe('Node to indent.'),
      browser:   z.string().optional().describe(BROWSER_ARG_DESC),
    },
  }, async (args) => writeToolHandler('indent_node', args));

  srv.registerTool('outdent_node', {
    description: 'Promotes a node to its grandparent\'s level (one level shallower). Sibling-adoption preserves layout: the outdented node\'s younger siblings become its children, so visual row order is preserved. CHILD-EXTRACTION PATTERN: outdent the FIRST child of a target to free the target solo (target becomes empty, all children become adopted under the outdented first child). Tree-only.',
    inputSchema: {
      nodeId:    z.string().describe('Node to outdent.'),
      browser:   z.string().optional().describe(BROWSER_ARG_DESC),
    },
  }, async (args) => writeToolHandler('outdent_node', args));

  // ─── Library system ops ─────────────────────────────────────────────────────
  srv.registerTool('create_library', {
    description: 'Creates a new empty library with an auto-seeded "Notes" note. Returns createdLibraryId and createdNoteId in the result. Use add_to_library afterwards to populate. For just creating an organizational umbrella over EXISTING libraries, use create_library_group instead.',
    inputSchema: {
      title:       z.string().describe('Library title (trimmed, non-empty, max 200 chars).'),
      description: z.string().optional().describe('Optional description shown beneath title (max 1000 chars).'),
      browser:     z.string().optional().describe(BROWSER_ARG_DESC),
    },
  }, async (args) => writeToolHandler('create_library', args));

  srv.registerTool('add_to_library', {
    description: 'Clones nodes from a source surface into a library. INCLUDECHILDREN GUIDANCE: default true (subtree comes along, matching manual DND). Set FALSE when adding individual tabs ("add tab X to library") to avoid bundling unrelated nested children; keep TRUE for windows/groups/explicit "add subtree" requests. SOURCESCOPE: "tree" (default — main tab tree), "library" (cross-library copy; sourceLibraryId required), or "bookmarks" (clone from bookmark tree). Engine auto-wraps tab clones into ONE new window in the destination (libraries require tabs to have a window/tab/folder parent). Max 100 source ids per call.',
    inputSchema: {
      nodeIds:         z.array(z.string()).min(1).describe('Source node ids (max 100). Order of clones matches order here.'),
      libraryId:       z.string().describe('Destination library id.'),
      includeChildren: z.boolean().optional().describe('Default TRUE: include each source node\'s subtree. Set FALSE to clone only the leaf node.'),
      sourceScope:     z.string().optional().describe('"tree" (default), "library", or "bookmarks". Use "library" with sourceLibraryId to copy from another library.'),
      sourceLibraryId: z.string().optional().describe('Required when sourceScope="library".'),
      position:        z.number().optional().describe(POSITION_DESC),
      browser:         z.string().optional().describe(BROWSER_ARG_DESC),
    },
  }, async (args) => writeToolHandler('add_to_library', args));

  srv.registerTool('set_note_content', {
    description: 'Updates an existing note\'s content. MODE GUIDANCE: "replace" (default) overwrites — use for "update note X with Y", "replace note X". "append" concatenates after existing content — use for "add Y to note X", "note down that ...". For prepend, read existing content first then call replace with the combined string. Note char limit is tier-gated (50K Pro / 150K Pro+ / 250K Premium / 500K Enterprise); for append mode the FINAL length is what\'s gated.',
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
    description: 'Creates a new note in a library or in global notes. Use this when the user says "create a note about X", "save these findings as a new note", etc. For UPDATING an existing note, use set_note_content. Returns createdNoteId. Char limit is tier-gated.',
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
    description: 'Creates a new library group (an organizational umbrella over multiple libraries). Returns createdGroupId. After creating, use add_library_to_group to add member libraries.',
    inputSchema: {
      title:       z.string().describe('Group title (trimmed, non-empty, max 200 chars).'),
      description: z.string().optional().describe('Optional group description (max 1000 chars).'),
      browser:     z.string().optional().describe(BROWSER_ARG_DESC),
    },
  }, async (args) => writeToolHandler('create_library_group', args));

  srv.registerTool('delete_library_group', {
    description: 'Removes a library group (DISSOLVE semantics). Member libraries are KEPT and re-appear in the standalone library card list at the position the group occupied. Cascade-delete-members (also delete the libraries themselves) is a separate destructive op deferred behind user confirmation.',
    inputSchema: {
      groupId: z.string().describe('Group id to dissolve.'),
      browser: z.string().optional().describe(BROWSER_ARG_DESC),
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

  // ─── Composite ─────────────────────────────────────────────────────────────
  srv.registerTool('bulk_apply', {
    description: 'Atomically applies up to 100 sub-ops as a SINGLE undoable unit. Use for multi-step reorganizations ("move these 12 tabs into a new library called Research") so the user can undo the whole thing in one click. SUB-OP SCOPE INHERITANCE: sub-ops without explicit scope/libraryId inherit the bulk\'s; explicitly setting a different value is rejected (BULK_SCOPE_MISMATCH / BULK_LIBRARY_MISMATCH). EXCEPTION for create_note and set_note_content: their schemas accept two valid scopes (library-notes, global-notes), so EVERY sub-op of those types must include its own explicit scope field — bulk\'s outer scope is NOT auto-filled in. NESTING: bulk_apply cannot contain another bulk_apply.',
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
        const { data, browserId, browserBrand } = body;
        if (data) {
          const id    = browserId    || 'unknown';
          const brand = browserBrand || 'Unknown';
          cachedData.set(id, {
            tree:         data.tree         || [],
            libraries:    data.libraries    || [],
            globalNotes:  data.globalNotes  || [],
            bookmarks:    data.bookmarks    || [],
            updatedAt:    Date.now(),
            browserId:    id,
            browserBrand: brand,
          });
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
    if (!browserId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: { code: 'BAD_REQUEST', message: 'GET /edits requires ?browserId=X' } }));
      return;
    }
    if (forwarders.has(browserId)) {
      _dropForwarder(browserId, 'replaced by new SSE connection');
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
        const { requestId } = body;
        if (!requestId) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: { code: 'BAD_REQUEST', message: 'POST /edit-result requires { requestId }' } }));
          return;
        }
        const pending = pendingEdits.get(requestId);
        if (pending) {
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
  // handler is just the HTTP wrapper. The 22 MCP write tools registered in
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
          log(`POST /mcp rejected: no session (mcp-session-id=${sessionId})`);
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Bad Request: call initialize first' }, id: null }));
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
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Bad Request: session not found' }, id: null }));
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
        const body = JSON.stringify(payload);
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
