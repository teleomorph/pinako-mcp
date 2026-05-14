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
import { fileURLToPath } from 'node:url';

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

// Slice S1 (2026-05-13): per-tier read-tool size guard. Triggers a structured
// warning when a single tree/library/bookmarks/notes read would exceed the
// agent's context budget. Generous thresholds — not a hard cap; the caller
// can bypass with acknowledge_size:true if they explicitly want the full
// payload (e.g., model with a much bigger context window than typical).
// Calibration is TBD via real-tree measurement; initial values map roughly to
// "comfortable working budget" per tier assuming minimal mode.
const READ_TOKEN_LIMITS = {
  0: 30_000,    // free       — ~500 nodes at ~60 tok/node
  1: 120_000,   // Pro        — ~2000 nodes
  2: 300_000,   // Pro+       — ~5000 nodes
  3: 600_000,   // Premium    — ~10k nodes
  4: Infinity,  // Enterprise — no guard
};

// Per-mode token-per-node estimate for tree/bookmark/library payloads.
// Approximate; the size guard uses these to estimate the response weight
// before serializing it. Higher figures for richer modes (lite carries
// children/collapsed/ghost; full carries everything except favicons).
const TOKENS_PER_NODE = { minimal: 60, lite: 120, full: 250 };

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

// ─── Auto-organize observation log (S2c, 2026-05-13) ──────────────────────────
// Per-browser observation log for the LLM sift loop. Agents call
// record_observation to track patterns spanning batches ("noticed many
// cooking blogs across 7 batches"); get_observations returns the digest so
// the agent can inject it into the next batch prompt. Cleared automatically
// when the workflow ends (organizeStateUpdate handler flips workflowStep to
// 'idle'). Bounded per-browser at MAX_OBSERVATIONS_PER_SESSION to keep memory
// honest if an agent goes wild.
//
// Map<browserId, Array<{ pattern, count, examples, batch_n, recordedAt }>>
const _organizeObservationLog = new Map();
const MAX_OBSERVATIONS_PER_SESSION = 100;

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
const pendingEdits = new Map();   // requestId -> { resolve, timer, heartbeatTimer, browserId, path, dispatchedAt }
const EDIT_TIMEOUT_MS = 30_000;

// W-1 defense-in-depth (2026-05-12): NM heartbeat interval. While an applyEdit
// is in flight on the local NM path, the bridge writes a {type:'heartbeat'}
// NM message every NM_HEARTBEAT_MS. Each message reaches the SW's mcpPort
// listener, which is "activity" by Chrome's accounting and resets the 30s
// idle timer. Belt-and-suspenders complement to the SW→popup port heartbeat
// (background.js + pinako.js, also 2026-05-12) — that fix handles the common
// "popup slow but making progress" case; this layer handles "popup event
// loop completely blocked, can't fire its own setInterval." 25s is well
// under the 30s idle timer with margin for scheduling jitter. Heartbeats
// only fire while pendingEdits has at least one entry — no idle traffic.
const NM_HEARTBEAT_MS = 25_000;

// ─── Slice W-1 diagnostic instrumentation ─────────────────────────────────────
// Probes SW liveness at the moment EDIT_TIMEOUT fires so we know whether the
// 30s spent waiting was on a suspended SW vs a hung popup vs a routing fault.
// The local-NM path sends a `diagnosticPing` via nmWrite, waits up to 2s for a
// `diagnosticPong`, then logs the verdict before resolving the edit with
// EDIT_TIMEOUT. SSE path just logs forwarder state — the diagnostic ping
// design only works for the leader's directly-connected browser.
const _pendingPings = new Map();  // pingId -> { resolve, timer, sentAt }
const PING_TIMEOUT_MS = 2_000;

function _dispatchDiagnosticPing(reason) {
  return new Promise((resolve) => {
    if (_nmStdoutBroken) { resolve({ status: 'nm_stdout_broken' }); return; }
    const pingId = randomBytes(6).toString('hex');
    const sentAt = Date.now();
    const timer = setTimeout(() => {
      _pendingPings.delete(pingId);
      resolve({ status: 'no_reply', pingId, elapsedMs: Date.now() - sentAt });
    }, PING_TIMEOUT_MS);
    _pendingPings.set(pingId, { resolve, timer, sentAt });
    const ok = nmWrite({ type: 'diagnosticPing', pingId, reason });
    if (!ok) {
      clearTimeout(timer);
      _pendingPings.delete(pingId);
      resolve({ status: 'nm_write_failed', pingId });
    }
  });
}

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
    // Slice W-1 diagnostic: log which requestIds get LEADER_CHANGED on exit
    // so the post-mortem can correlate against the bridge log timeline.
    // Also surface dispatchedAt → exitTime for each so we know how long each
    // edit waited before the leader gave up.
    const now = Date.now();
    const summaries = [];
    for (const [requestId, entry] of pendingEdits) {
      try { clearTimeout(entry.timer); } catch (_) {}
      if (entry.heartbeatTimer) { try { clearInterval(entry.heartbeatTimer); } catch (_) {} }
      const waitedMs = entry.dispatchedAt ? (now - entry.dispatchedAt) : null;
      summaries.push(`${requestId.slice(0,8)}(path=${entry.path},waitedMs=${waitedMs})`);
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
    if (summaries.length > 0) {
      try { log(`LEADER_CHANGED resolved ${summaries.length} pending edit(s): ${summaries.join(', ')}`); } catch (_) {}
    }
    // Slice W-1 diagnostic: also drain _pendingPings so any probe await
    // inside an EDIT_TIMEOUT callback resolves FAST and gets a chance to
    // flush its log line before the 200ms process.exit kicks in. Without
    // this, when EPIPE fires async via the 'error' event, the probe's
    // setTimeout(2s) outlives the bridge process and the diagnostic line
    // is lost.
    if (typeof _pendingPings !== 'undefined' && _pendingPings.size > 0) {
      try {
        const pingCount = _pendingPings.size;
        for (const [pingId, p] of _pendingPings) {
          try { clearTimeout(p.timer); } catch (_) {}
          try { p.resolve({ status: 'nm_stdout_broken_during_probe', pingId, elapsedMs: Date.now() - p.sentAt }); } catch (_) {}
        }
        _pendingPings.clear();
        log(`LEADER_CHANGED drained ${pingCount} pending diagnostic ping(s)`);
      } catch (_) {}
    }
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
    // 2026-05-12 Slice Y bookmark expansion: preserve-when-omitted for
    // tree/libraries/globalNotes too. SW-side bookmark-only pushes
    // (triggered by chrome.bookmarks events from the SW listener,
    // independent of popup state) send ONLY bookmarks in data; preserve
    // cached tree/libraries/globalNotes when those fields are absent.
    // Backwards compatible: existing pushes that include all fields
    // continue to update those fields exactly as before (the 'in' check
    // detects presence regardless of value).
    const tree = (msg.data && 'tree' in msg.data)
      ? (msg.data.tree || [])
      : (prior?.tree || []);
    const libraries = (msg.data && 'libraries' in msg.data)
      ? (msg.data.libraries || [])
      : (prior?.libraries || []);
    const globalNotes = (msg.data && 'globalNotes' in msg.data)
      ? (msg.data.globalNotes || [])
      : (prior?.globalNotes || []);
    // Slice Z (2026-05-12): library panel structure follows the same
    // preserve-when-omitted contract as tree/libraries/globalNotes.
    // Older popup builds (pre-Slice Z) send pushes WITHOUT these fields;
    // we preserve prior cache values rather than wiping. The fields ride
    // the same wire as libraries — when libraries mutate, panel structure
    // typically ships alongside, so reads always see a consistent snapshot.
    const libraryGroups = (msg.data && 'libraryGroups' in msg.data)
      ? (msg.data.libraryGroups || [])
      : (prior?.libraryGroups || []);
    const libraryPanelOrder = (msg.data && 'libraryPanelOrder' in msg.data)
      ? (msg.data.libraryPanelOrder || [])
      : (prior?.libraryPanelOrder || []);
    cachedData.set(browserId, {
      tree,
      libraries,
      globalNotes,
      bookmarks,
      docs,
      libraryGroups,
      libraryPanelOrder,
      updatedAt:      Date.now(),
      browserId,
      browserBrand,
      userTier,
      userId,
      // Preserve forwarderToken across non-bookmark pushes — it was set
      // by the most recent /update; treeUpdate via direct NM doesn't carry
      // a token (NM-direct is implicitly trusted via Chrome's allowed_origins).
      forwarderToken: prior?.forwarderToken || null,
      // S2f Phase 3b bugfix (2026-05-14): preserve organizeState across
      // treeUpdate pushes. The sift loop fires many bulk_apply ops; each one
      // triggers a pushTreeUpdate from the popup. Without this preservation,
      // every push REPLACED the cachedData entry and dropped the
      // organizeState that auto_organize_bookmarks's Confirm-time push had
      // set — so by the time the agent finished the sift and called
      // complete_organize_sort, get_organize_state returned 'idle' and the
      // polish transition couldn't fire. The popup is the single source of
      // organize-workflow state truth; treeUpdate carries unrelated data
      // and should never clobber it.
      organizeState: prior?.organizeState || null,
    });
    // Slice Y bonus: broadcast resource-updated notifications for fields
    // that were present in this push. Subscribed clients use this to know
    // when to re-read; the bridge cache is already current by this point.
    //
    // Slice Z (2026-05-12, Option A folded): libraryGroups / libraryPanelOrder
    // are metadata ABOUT libraries, so a change in either fires the
    // pinako://libraries resource notification (rather than introducing
    // separate panel resources that would clutter resource lists for the
    // marginal subscription granularity benefit).
    {
      const updatedFields = [];
      if (msg.data && 'tree'        in msg.data) updatedFields.push('tree');
      const librariesPresent = msg.data && (
        'libraries'         in msg.data ||
        'libraryGroups'     in msg.data ||
        'libraryPanelOrder' in msg.data
      );
      if (librariesPresent) updatedFields.push('libraries');
      if (msg.data && 'globalNotes' in msg.data) updatedFields.push('mainTreeNotes');
      if (msg.data && 'bookmarks'   in msg.data) updatedFields.push('bookmarks');
      if (msg.data && 'docs'        in msg.data) updatedFields.push('docs');
      if (updatedFields.length > 0) broadcastResourceUpdated(updatedFields);
    }
    process.stderr.write(`[pinako-mcp] Tree updated from ${browserBrand} (${browserId.slice(0,16)}…): ${msg.data.tree?.length || 0} windows.\n`);
    // Diagnostic: surface docs/bookmarks counts on every NM update so we can
    // tell at a glance whether the extension is pushing them. Logged to the
    // disk log (not just stderr) so it survives across leader processes.
    try {
      const docsLen = Array.isArray(msg.data?.docs) ? msg.data.docs.length : '<absent>';
      const bmLen = Array.isArray(msg.data?.bookmarks)
        ? msg.data.bookmarks.reduce((acc, r) => acc + countBookmarksRecursive(r), 0)
        : '<absent>';
      const grpLen = Array.isArray(msg.data?.libraryGroups) ? msg.data.libraryGroups.length : '<absent>';
      const panelLen = Array.isArray(msg.data?.libraryPanelOrder) ? msg.data.libraryPanelOrder.length : '<absent>';
      log(`NM update from ${browserBrand}: docs=${docsLen} bookmarks=${bmLen} windows=${msg.data?.tree?.length || 0} groups=${grpLen} panel=${panelLen}`);
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
    if (pending.heartbeatTimer) { try { clearInterval(pending.heartbeatTimer); } catch (_) {} }
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
  } else if (msg.type === 'applyEditReceived') {
    // Slice W-1 diagnostic: SW acks dispatch BEFORE forwarding to popup. RTT
    // here = how long the message sat in the NM pipe / SW event loop. A small
    // RTT (<200ms) means SW is responsive; a large RTT means SW was suspended
    // and the NM stdin message was buffered.
    const pending = pendingEdits.get(msg.requestId);
    const rttMs = pending ? Date.now() - pending.dispatchedAt : null;
    log(`applyEditReceived ${(msg.requestId||'').slice(0,8)} rtt=${rttMs}ms swUptime=${msg.swUptime}ms`);
  } else if (msg.type === 'diagnosticPong') {
    const pending = _pendingPings.get(msg.pingId);
    if (!pending) return; // late reply or unknown ping
    clearTimeout(pending.timer);
    _pendingPings.delete(msg.pingId);
    pending.resolve({
      status: 'replied',
      pingId: msg.pingId,
      elapsedMs: Date.now() - pending.sentAt,
      swUptime: msg.swUptime,
      contexts: msg.contexts,
      popup: msg.popup,
    });
  } else if (msg.type === 'organizeStateUpdate') {
    // S2c (2026-05-13): popup → SW → bridge state push for the auto-organize
    // workflow. Cached on the per-browser entry so the get_organize_state MCP
    // tool can return it. Workflow steps: 'idle' | 'step-3' | 'step-4' |
    // 'sorting' | 'paused'. Agent loop pattern:
    //   1. Call auto_organize_bookmarks(scope) — Pinako popup opens, user reviews/
    //      confirms folder structure (Steps 3 + 4).
    //   2. User clicks Confirm & start sift — popup pushes workflowStep:
    //      'sorting' with the confirmed buckets here.
    //   3. Agent polls get_organize_state until workflowStep === 'sorting',
    //      then calls apply_heuristic_organize for the heuristic broad-sweep
    //      and the cursor-paginated LLM sift loop.
    //   4. If user clicks Pause, workflowStep flips to 'paused' — agent checks
    //      between batches and halts gracefully.
    const browserId = msg.browserId;
    if (!browserId) return;
    const prior = cachedData.get(browserId) || {};
    const payload = msg.payload && typeof msg.payload === 'object' ? msg.payload : {};
    prior.organizeState = {
      workflowStep:      typeof payload.workflowStep === 'string' ? payload.workflowStep : 'idle',
      scope:             typeof payload.scope === 'string' ? payload.scope : null,
      libraryId:         typeof payload.libraryId === 'string' ? payload.libraryId : null,
      includeOtherRoots: !!payload.includeOtherRoots,
      buckets:           Array.isArray(payload.buckets) ? payload.buckets : [],
      confirmedAt:       Number.isFinite(payload.confirmedAt) ? payload.confirmedAt : Date.now(),
      pushedAt:          Date.now(),
    };
    // S2c: clear the observation log when the workflow ends. Observations are
    // tied to a single sift-loop session — once the panel closes (workflowStep
    // → 'idle') they're no longer relevant. On 'step-3' / 'step-4' / 'sorting'
    // / 'paused' the log is preserved.
    if (prior.organizeState.workflowStep === 'idle' && _organizeObservationLog.has(browserId)) {
      _organizeObservationLog.delete(browserId);
      log(`organizeObservationLog cleared for ${msg.browserBrand || 'unknown'} (workflowStep → idle).`);
    }
    cachedData.set(browserId, prior);
    log(`organizeStateUpdate from ${msg.browserBrand || 'unknown'}: workflowStep=${prior.organizeState.workflowStep} buckets=${prior.organizeState.buckets.length}`);
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
    const dispatchedAt = Date.now();
    // W-1 defense-in-depth: NM heartbeat every 25s while this edit is in
    // flight. Each heartbeat reaches the SW's mcpPort listener (no-op handler
    // there), which counts as activity and resets Chrome's 30s SW idle timer
    // even if the popup-side port heartbeat has stalled.
    const heartbeatTimer = setInterval(() => {
      try { nmWrite({ type: 'heartbeat', requestId }); } catch (_) {}
    }, NM_HEARTBEAT_MS);
    const timer = setTimeout(async () => {
      try { clearInterval(heartbeatTimer); } catch (_) {}
      // Slice W-1 diagnostic: probe SW state BEFORE resolving with timeout so
      // we capture ground truth on what was responsive at the 30s mark.
      let probe;
      try { probe = await _dispatchDiagnosticPing(`edit_timeout local ${requestId.slice(0,8)}`); }
      catch (e) { probe = { status: 'probe_threw', error: e && e.message || String(e) }; }
      log(`EDIT_TIMEOUT local ${requestId.slice(0,8)} probe=${JSON.stringify(probe)}`);
      pendingEdits.delete(requestId);
      resolve({
        ok: false,
        requestId,
        error: { code: 'EDIT_TIMEOUT', message: `applyEdit ${requestId} timed out after ${EDIT_TIMEOUT_MS}ms` },
      });
    }, EDIT_TIMEOUT_MS);
    pendingEdits.set(requestId, { resolve, timer, heartbeatTimer, browserId, path: 'local', dispatchedAt });
    // The extension's SW NM listener picks this up, opens a long-lived port
    // to the popup (W-1 fix, 2026-05-12), popup runs mutateTreeForAgent and
    // posts the result back. SW relays editApplied/editFailed over NM.
    // nmWrite returns false (instead of throwing) when stdout is broken; we
    // resolve immediately in that case so the request doesn't hang for the
    // full 30s timeout.
    const ok = nmWrite({ type: 'applyEdit', op, requestId, browserId });
    if (!ok) {
      clearTimeout(timer);
      try { clearInterval(heartbeatTimer); } catch (_) {}
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
    const dispatchedAt = Date.now();
    const timer = setTimeout(() => {
      // Slice W-1 diagnostic for SSE path. We can't NM-ping the SSE-routed
      // browser (NM stdio reaches only the leader's local browser); the
      // closest signal is whether the forwarder SSE channel is still bound.
      const fwd = forwarders.get(browserId);
      const cache = cachedData.get(browserId);
      const updateAgeMs = cache ? Date.now() - cache.updatedAt : null;
      log(`EDIT_TIMEOUT sse ${requestId.slice(0,8)} forwarder=${fwd ? 'present' : 'absent'} updateAgeMs=${updateAgeMs}`);
      pendingEdits.delete(requestId);
      resolve({
        ok: false,
        requestId,
        error: { code: 'EDIT_TIMEOUT', message: `applyEdit ${requestId} timed out after ${EDIT_TIMEOUT_MS}ms` },
      });
    }, EDIT_TIMEOUT_MS);
    pendingEdits.set(requestId, { resolve, timer, browserId, path: 'sse', dispatchedAt });
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

// ─── Slice S1: read-tool size guard helpers ────────────────────────────────
// Counts nodes recursively in a tree or array of trees. Used by the size guard
// to estimate the payload weight of a read tool's response before serializing.
function _countNodesDeep(treeOrNode) {
  let count = 0;
  function walk(node) {
    if (!node) return;
    count++;
    if (Array.isArray(node.children)) {
      for (const child of node.children) walk(child);
    }
  }
  if (Array.isArray(treeOrNode)) {
    for (const root of treeOrNode) walk(root);
  } else {
    walk(treeOrNode);
  }
  return count;
}

// Token estimate for tree/bookmark/library payload shapes.
function _estimateTreeTokens(nodeCount, mode) {
  const perNode = TOKENS_PER_NODE[mode] || TOKENS_PER_NODE.lite;
  return nodeCount * perNode;
}

// Token estimate for notes payloads. Notes are content-heavy not node-heavy;
// estimate from cumulative character length (chars-to-tokens ~4:1).
function _estimateNotesTokens(notes) {
  if (!Array.isArray(notes)) return 0;
  let chars = 0;
  for (const n of notes) {
    chars += String((n && n.content) || '').length;
    chars += String((n && n.title) || '').length;
  }
  return Math.ceil(chars / 4);
}

// Returns a structured warning object when the estimated payload exceeds the
// per-tier token budget AND acknowledge is falsy. Returns null otherwise (no
// guard fired; proceed with normal payload). Caller passes estTokens (computed
// via the appropriate estimator), nodeCount (for the warning shape), the mode
// label, the scope label, browserData (for tier lookup), the tool-specific
// suggested_actions array, and the acknowledge_size flag from the caller.
function _checkReadSizeGuard({ estTokens, nodeCount, mode, scope, browserData, suggestedActions, acknowledge }) {
  if (acknowledge) return null;
  const tier = Number.isFinite(browserData?.userTier) ? browserData.userTier : 0;
  const tokenLimit = READ_TOKEN_LIMITS[tier] != null ? READ_TOKEN_LIMITS[tier] : READ_TOKEN_LIMITS[0];
  if (!Number.isFinite(tokenLimit) || estTokens <= tokenLimit) return null;
  return {
    warning: 'tree_too_large',
    counts: { nodes: nodeCount, est_tokens: estTokens, mode: mode || null },
    threshold: { tier, est_tokens_limit: tokenLimit },
    scope,
    suggested_actions: suggestedActions,
    bypass: 'Pass acknowledge_size:true to skip this guard and receive the full payload anyway.',
  };
}

// ─── Slice S2 Prep 2: exact-URL duplicate detection ─────────────────────────
// Walks a tree/bookmark/library structure and groups nodes by URL. Returns the
// duplicate sets (URLs appearing more than once), ordered by frequency
// descending. Skips nodes without a URL (folders, windows, groups). Exact byte
// match only — no query-string normalization, no fuzzy match. v2 polish
// (followups #22) covers near-duplicate matching.
//
// Per-instance parent breadcrumb (parentPath): slash-joined string of the
// non-empty ancestor titles ABOVE each URL-bearing node. Powers the Slice S2f
// dedup-as-sift-signal flow — duplicate instances enter the LLM sift loop
// with their original folder names available as semantic hints, then
// resolve_duplicate_landings reconciles them post-sift. Empty-title ancestors
// (chrome.bookmarks' outer root, unnamed Pinako windows) are skipped so
// "Bookmarks bar" prefixes don't pollute the path; "Other Bookmarks" and
// "Mobile Bookmarks" (which DO carry signal vs Bookmarks bar) are preserved.
function _findDuplicateUrls(tree) {
  // url → array of { id, title, parentPath }
  const urlMap = new Map();
  let scanned = 0;
  const pathStack = [];
  function walk(node) {
    if (!node) return;
    const url = node && typeof node.url === 'string' ? node.url : '';
    if (url.length > 0) {
      scanned++;
      let arr = urlMap.get(url);
      if (!arr) { arr = []; urlMap.set(url, arr); }
      arr.push({
        id: node.id,
        title: String(node.title || ''),
        parentPath: pathStack.join('/'),
      });
    }
    if (Array.isArray(node.children) && node.children.length > 0) {
      const title = node.title ? String(node.title) : '';
      const pushed = title.length > 0;
      if (pushed) pathStack.push(title);
      for (const child of node.children) walk(child);
      if (pushed) pathStack.pop();
    }
  }
  if (Array.isArray(tree)) {
    for (const root of tree) walk(root);
  } else {
    walk(tree);
  }
  const duplicateSets = [];
  let totalDuplicateInstances = 0;
  for (const [url, instances] of urlMap.entries()) {
    if (instances.length > 1) {
      // Up to 3 distinct sample titles (helps the agent surface what the URL is)
      const seen = new Set();
      const sampleTitles = [];
      for (const inst of instances) {
        if (inst.title && !seen.has(inst.title)) {
          seen.add(inst.title);
          sampleTitles.push(inst.title);
          if (sampleTitles.length >= 3) break;
        }
      }
      duplicateSets.push({
        url,
        count: instances.length,
        nodeIds: instances.map(x => x.id),
        parentPaths: instances.map(x => x.parentPath),
        sampleTitles,
      });
      totalDuplicateInstances += instances.length - 1;
    }
  }
  duplicateSets.sort((a, b) => b.count - a.count);
  return {
    duplicateSets,
    totalDuplicateInstances,
    uniqueDuplicateUrls: duplicateSets.length,
    totalScannedWithUrl: scanned,
  };
}

// ─── Slice S2a (2026-05-13): cursor pagination helpers ──────────────────────
// Cursor = last-seen stable Pinako node id (or Chrome bookmark id for
// bookmarks). Pagination is opt-in: callers that pass `after` OR `limit` get
// a paginated response shape (items[] + nextCursor); callers that omit both
// keep the original tree-shape response. Pagination ALWAYS returns a FLAT
// list of mode-shaped items — children stripped, parentId preserved for
// hierarchy reconstruction. This matches the auto-organize Step 7 sift loop
// (read 500 items, sift, bulk_apply move, read next 500 via cursor).
//
// Cursor robustness: when `after` doesn't match a node in the current list
// (the cursor node was moved or deleted between calls), pagination falls
// back to startIdx=0. The agent should still make forward progress because
// items already moved out of the source folder won't reappear in the
// flat list. This handles list churn during the sift loop naturally.
const PAGINATION_DEFAULT_LIMITS = {
  tree:           500,
  bookmarks:      500,
  library:        500,
  'main-tree-notes': 100,
  libraries:      50,
};

// Mode-aware flat-item shaper for tree-like data (tree, library children).
// Each output item is one node (no nested children) with parentId set so the
// agent can reconstruct hierarchy if needed. Returns a fresh array.
function _flattenTreeWithMode(nodes, scope, libraryId, mode, includeFavicons, parentId = null, out = []) {
  if (!Array.isArray(nodes)) return out;
  for (const node of nodes) {
    if (!node) continue;
    let shaped;
    if (mode === 'minimal') {
      shaped = minimalNode(node, scope, libraryId, parentId);
    } else if (mode === 'lite') {
      shaped = {
        id:    node.id,
        type:  node.type,
        title: node.title || '',
      };
      if (scope)     shaped.scope     = scope;
      if (libraryId) shaped.libraryId = libraryId;
      if (parentId)  shaped.parentId  = parentId;
      if (node.url) shaped.url = node.url;
      if (node.type === 'tab' && node.chromeId === null) shaped.ghost = true;
      if (node.type === 'tab' && node.openedDate) shaped.openedDate = node.openedDate;
      if (Array.isArray(node.tags) && node.tags.length > 0) shaped.tags = node.tags;
      if (node.memoText) shaped.memoText = node.memoText;
      if (node.collapsed) shaped.collapsed = true;
    } else { // full
      const sanitized = sanitizeNode(node);
      const noFavicons = includeFavicons ? sanitized : stripFavicons(sanitized);
      const { children: _ignore, ...rest } = noFavicons;
      shaped = { ...rest };
      if (parentId)  shaped.parentId  = parentId;
      if (scope)     shaped.scope     = scope;
      if (libraryId) shaped.libraryId = libraryId;
    }
    out.push(shaped);
    if (Array.isArray(node.children) && node.children.length > 0) {
      _flattenTreeWithMode(node.children, scope, libraryId, mode, includeFavicons, node.id, out);
    }
  }
  return out;
}

// Flatten the raw chrome.bookmarks tree (different shape from Pinako nodes)
// into a flat DFS pre-order list. Each item carries id, title, url (if leaf),
// parentId, dateAdded, index. Folders are included (no url field) so the
// agent can see structure; the sift loop typically filters to url-bearing
// nodes itself.
function _flattenBookmarksTree(nodes, parentId = null, out = []) {
  if (!Array.isArray(nodes)) return out;
  for (const node of nodes) {
    if (!node) continue;
    const item = {
      id:       node.id,
      title:    node.title || '',
      parentId: parentId,
    };
    if (typeof node.url === 'string')   item.url       = node.url;
    if (typeof node.dateAdded === 'number') item.dateAdded = node.dateAdded;
    if (typeof node.index === 'number') item.index     = node.index;
    out.push(item);
    if (Array.isArray(node.children) && node.children.length > 0) {
      _flattenBookmarksTree(node.children, node.id, out);
    }
  }
  return out;
}

// Slice a flat list by cursor + limit. Returns { items, nextCursor,
// totalItems, startIdx }. When `after` is provided but not found, falls
// back to startIdx=0 (handles list churn — the cursor node may have been
// moved out by a prior bulk_apply in the sift loop).
function _paginateByCursor(flatList, after, limit, idField = 'id') {
  let startIdx = 0;
  let cursorFound = true;
  if (after) {
    const foundIdx = flatList.findIndex(item => item[idField] === after);
    if (foundIdx >= 0) {
      startIdx = foundIdx + 1;
    } else {
      cursorFound = false;
      startIdx = 0;
    }
  }
  const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : flatList.length;
  const slice = flatList.slice(startIdx, startIdx + safeLimit);
  const endIdx = startIdx + slice.length;
  const nextCursor = (endIdx < flatList.length && slice.length > 0)
    ? slice[slice.length - 1][idField]
    : null;
  return {
    items:        slice,
    nextCursor,
    totalItems:   flatList.length,
    startIdx,
    cursorFound,
  };
}

// True when the caller passed pagination params. Both undefined → no
// pagination; either one set → paginate with sensible defaults.
function _isPaginationRequested(after, limit) {
  return after != null || limit != null;
}

// ─── Slice S2a (2026-05-13): get_tree_summary helpers ────────────────────────
// Lightweight structural summary of a tree/bookmarks/library scope, used by
// the auto-organize workflow at kickoff to decide WHETHER to proceed and at
// what scope. Returns counts, depth, top domains, top path-token patterns,
// and a small sample of titles. Crucially does NOT trigger the size guard —
// the whole point is "summarize before reading."

const _SUMMARY_STOP_TOKENS = new Set([
  'index','html','htm','php','aspx','jsp','main','home','page','default',
  'http','https','www','com','org','net','about','contact','login','signin',
  'logout','signup','register','help','support','faq','search','results',
  'view','viewtopic','watch','play','show','read','article','articles',
  'post','posts','category','categories','tag','tags','tagged','user','users',
  'profile','feed','rss','atom','sitemap','privacy','terms','tos','en','de',
  'fr','es','pt','it','ja','zh','ru','app','apps','api','v1','v2','v3',
  'docs','doc','documentation','www2','m','mobile','share','sharing',
]);

function _extractDomain(url) {
  if (!url || typeof url !== 'string') return null;
  try {
    const u = new URL(url);
    let host = u.hostname.toLowerCase();
    if (host.startsWith('www.')) host = host.slice(4);
    return host || null;
  } catch (_) {
    return null;
  }
}

function _extractPathTokens(url) {
  if (!url || typeof url !== 'string') return [];
  try {
    const u = new URL(url);
    // Split path on /, -, _, ., +. Lowercase. Filter to tokens >= 4 chars,
    // not all-numeric, not in stop-list. Dedupe within a single URL so
    // repeated tokens (e.g., /blog/blog/) don't over-inflate the count.
    const segs = u.pathname.split(/[\/\-_.+]+/).map(s => s.toLowerCase());
    const seen = new Set();
    const out = [];
    for (const s of segs) {
      if (s.length < 4) continue;
      if (/^\d+$/.test(s)) continue;
      if (_SUMMARY_STOP_TOKENS.has(s)) continue;
      if (seen.has(s)) continue;
      seen.add(s);
      out.push(s);
    }
    return out;
  } catch (_) {
    return [];
  }
}

// ─── Slice S2a (2026-05-13): heuristic rules + propose_categories ───────────
// Default rule library lives at pinako-mcp/src/heuristic-rules.json. Cached
// after first load (file is small, ~50KB, doesn't change at runtime).

let _heuristicRulesCache = null;
let _heuristicRulesCacheError = null;

function _loadHeuristicRules() {
  if (_heuristicRulesCache !== null) return _heuristicRulesCache;
  try {
    // host.js is at pinako-mcp/host.js; rules at pinako-mcp/src/heuristic-rules.json.
    // fileURLToPath decodes percent-encoded path segments correctly (URL
    // pathname encodes spaces as %20; fs.readFileSync needs the raw path).
    const scriptPath = fileURLToPath(import.meta.url);
    const scriptDir  = path.dirname(scriptPath);
    const rulesPath  = path.join(scriptDir, 'src', 'heuristic-rules.json');
    const json = JSON.parse(fs.readFileSync(rulesPath, 'utf8'));
    _heuristicRulesCache = Array.isArray(json.rules) ? json.rules : [];
    log(`heuristic rules loaded: ${_heuristicRulesCache.length} rules from ${rulesPath}`);
  } catch (err) {
    _heuristicRulesCacheError = err.message;
    log(`heuristic rules load failed: ${err.message}`);
    _heuristicRulesCache = [];
  }
  return _heuristicRulesCache;
}

// True if `url` matches `rule.match` (domain + optional path glob).
// Domain matches as exact OR subdomain ("spotify.com" matches "open.spotify.com").
// Wildcards in match.domain: leading "*." matches any subdomain (e.g., "*.gov"
// matches "irs.gov", "usa.gov"). Path glob uses "*" wildcards.
function _ruleMatchesUrl(rule, url) {
  if (!url || typeof url !== 'string') return false;
  let u;
  try { u = new URL(url); } catch (_) { return false; }
  const hostname = u.hostname.toLowerCase();
  const urlPath  = u.pathname;

  const matchDomain = rule.match && rule.match.domain;
  if (matchDomain) {
    const md = String(matchDomain).toLowerCase();
    if (md.startsWith('*.')) {
      // "*.gov" → match any hostname ending in ".gov"
      const suffix = md.slice(1); // ".gov"
      if (!hostname.endsWith(suffix)) return false;
    } else {
      // Exact OR subdomain match
      if (hostname !== md && !hostname.endsWith('.' + md)) return false;
    }
  }

  const matchPath = rule.match && rule.match.path;
  if (matchPath) {
    const escaped = String(matchPath).replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    const re = new RegExp('^' + escaped + '$');
    if (!re.test(urlPath)) return false;
  }
  return true;
}

// S2d Phase 3 (2026-05-14): find a folder in the raw chrome.bookmarks tree
// by its chrome.bookmarks id. Used by refine_folder_outliers to scope items
// for the LLM scan to a single bucket. Walks recursively from any root —
// the tree shape from chrome.bookmarks.getTree() is [{id:'0', children:[
// BookmarksBar, OtherBookmarks, MobileBookmarks]}], so a top-level call
// passes that wrapper array.
function _findBookmarkFolderByChromeId(nodes, folderId) {
  if (!Array.isArray(nodes)) return null;
  for (const n of nodes) {
    if (!n) continue;
    if (n.id === folderId && Array.isArray(n.children)) return n;
    const f = _findBookmarkFolderByChromeId(n.children, folderId);
    if (f) return f;
  }
  return null;
}

// Walk a tree and split nodes into matched (per first matching rule) vs
// unmatched (no rule fires). Low-confidence rules are skipped during this
// broad-sweep classification — they don't apply directly, only bias LLM
// categorization downstream.
function _applyHeuristicsToTree(roots, rules) {
  const matched   = [];
  const unmatched = [];
  function walk(node) {
    if (!node) return;
    const url = typeof node.url === 'string' ? node.url : '';
    if (url) {
      let hit = null;
      for (const rule of rules) {
        if (rule.confidence === 'low') continue;
        if (_ruleMatchesUrl(rule, url)) { hit = rule; break; }
      }
      if (hit) {
        matched.push({ node, ruleId: hit.ruleId, target: hit.target, confidence: hit.confidence });
      } else {
        unmatched.push(node);
      }
    }
    if (Array.isArray(node.children)) {
      for (const child of node.children) walk(child);
    }
  }
  if (Array.isArray(roots)) {
    for (const r of roots) walk(r);
  } else if (roots) {
    walk(roots);
  }
  return { matched, unmatched };
}

// Generate suggested category folder names from the unmatched residue.
// Algorithm: group residue by domain, take top domains by count, propose
// a folder name per domain. Then add path-token suggestions (tokens
// appearing >= minMatchCount across the residue) that aren't already
// covered by a domain suggestion. Returns 8-15 suggestions.
function _proposeCategoriesFromResidue(unmatched, opts = {}) {
  const minMatchCount = Number.isFinite(opts.minMatchCount) && opts.minMatchCount > 0
    ? opts.minMatchCount
    : 100;
  const maxSuggestions = Number.isFinite(opts.maxSuggestions) && opts.maxSuggestions > 0
    ? opts.maxSuggestions
    : 15;

  const byDomain = new Map();
  const pathTokenCounts = new Map();
  for (const node of unmatched) {
    const url = node.url;
    const domain = _extractDomain(url);
    if (domain) {
      if (!byDomain.has(domain)) byDomain.set(domain, []);
      byDomain.get(domain).push(node);
    }
    for (const t of _extractPathTokens(url)) {
      pathTokenCounts.set(t, (pathTokenCounts.get(t) || 0) + 1);
    }
  }

  const suggestions = [];

  // Domain-based suggestions first (more reliable signal).
  const domainEntries = [...byDomain.entries()]
    .filter(([_d, nodes]) => nodes.length >= minMatchCount)
    .sort((a, b) => b[1].length - a[1].length);
  for (const [domain, nodes] of domainEntries) {
    if (suggestions.length >= maxSuggestions) break;
    suggestions.push({
      target: _domainToCategoryName(domain),
      domain,
      count: nodes.length,
      basis: 'domain-frequency',
      sampleTitles: nodes.slice(0, 3).map(n => String(n.title || '')).filter(Boolean),
    });
  }

  // Path-token suggestions: only if not already covered by a domain
  // suggestion targeting the same conceptual name.
  const seenTargets = new Set(suggestions.map(s => s.target.toLowerCase()));
  const tokenEntries = [...pathTokenCounts.entries()]
    .filter(([t, c]) => c >= minMatchCount && !seenTargets.has(_tokenToCategoryName(t).toLowerCase()))
    .sort((a, b) => b[1] - a[1]);
  for (const [token, count] of tokenEntries) {
    if (suggestions.length >= maxSuggestions) break;
    suggestions.push({
      target: _tokenToCategoryName(token),
      pattern: `*${token}*`,
      count,
      basis: 'path-token',
    });
  }

  return suggestions;
}

function _domainToCategoryName(domain) {
  if (!domain) return 'Unknown';
  // "youtube.com" → "Youtube"; user can rename in the auto-organize panel.
  const base = String(domain).split('.')[0];
  return base.charAt(0).toUpperCase() + base.slice(1);
}

function _tokenToCategoryName(token) {
  if (!token) return 'Other';
  const cap = String(token).charAt(0).toUpperCase() + String(token).slice(1);
  return cap.endsWith('s') ? cap : cap + 's';
}

function _summarizeTreeStructure(roots, opts = {}) {
  const titlePool = [];
  let totalNodes  = 0;
  let urlBearing  = 0;
  let maxDepth    = 0;
  const depths    = [];
  const domainCounts    = new Map();
  const pathTokenCounts = new Map();
  const MAX_TITLE_POOL = 500;

  function walk(node, depth) {
    if (!node) return;
    totalNodes++;
    if (depth > maxDepth) maxDepth = depth;
    const url = typeof node.url === 'string' ? node.url : '';
    if (url) {
      urlBearing++;
      depths.push(depth);
      const domain = _extractDomain(url);
      if (domain) domainCounts.set(domain, (domainCounts.get(domain) || 0) + 1);
      for (const t of _extractPathTokens(url)) {
        pathTokenCounts.set(t, (pathTokenCounts.get(t) || 0) + 1);
      }
      const title = String((node.title || '')).trim();
      if (title && titlePool.length < MAX_TITLE_POOL) titlePool.push(title);
    }
    if (Array.isArray(node.children)) {
      for (const child of node.children) walk(child, depth + 1);
    }
  }
  if (Array.isArray(roots)) {
    for (const r of roots) walk(r, 0);
  } else if (roots) {
    walk(roots, 0);
  }

  depths.sort((a, b) => a - b);
  const medianDepth = depths.length
    ? depths[Math.floor(depths.length / 2)]
    : 0;

  const topDomains = [...domainCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([domain, count]) => ({ domain, count }));

  const samplePatterns = [...pathTokenCounts.entries()]
    .filter(([_token, count]) => count >= 3)  // noise floor
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([token, count]) => ({ pattern: `*${token}*`, token, count }));

  // Sample titles: deterministic stride over the pool so the result is
  // stable across calls (no Math.random — reproducible diagnostics). Cap at
  // 20.
  const sampleN = Math.min(20, titlePool.length);
  const sampleTitles = [];
  if (sampleN > 0) {
    const stride = Math.max(1, Math.floor(titlePool.length / sampleN));
    for (let i = 0, taken = 0; taken < sampleN && i < titlePool.length; i += stride, taken++) {
      sampleTitles.push(titlePool[i]);
    }
  }

  return {
    counts: { nodes: totalNodes, url_bearing_nodes: urlBearing },
    depth:  { max: maxDepth, median: medianDepth },
    topDomains,
    samplePatterns,
    sampleTitles,
  };
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
  // Agent-boundary scope normalization. Tool descriptions present
  // 'main-tree-notes' as the canonical scope value (the user-facing term);
  // the extension's wire format still uses the legacy 'global-notes' string.
  // Translate at this single chokepoint so MCP tools, the /edit HTTP endpoint,
  // and any future entry into executeEdit all behave the same.
  _normalizeNotesScope(op);
  if (op.type === 'bulk_apply' && Array.isArray(op.ops)) {
    for (const sub of op.ops) _normalizeNotesScope(sub);
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

function _normalizeNotesScope(op) {
  if (op && op.scope === 'main-tree-notes') op.scope = 'global-notes';
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

// ─── Agent response modes ────────────────────────────────────────────────────
// Three tiers for read tools, tuned for different agent workloads:
//
//   'minimal' — flat list, compact URLs, no children/collapsed/ghost.
//               Optimized for "find/search/filter X" scans. Smallest payload;
//               fits ~2000+ tabs comfortably in tool-result caps.
//
//   'lite'    — tree shape with children/collapsed/ghost preserved.
//               For hierarchical reads ("what's in this window?") and any
//               op where the structure matters.
//
//   'full'    — everything in the source data EXCEPT favicons.
//               For the rare case where the agent wants visual fields, full
//               URL fidelity, or rich-text note content (on get_library).
//
// Favicons (base64 data URIs, 1-3KB per tab) are NEVER returned unless the
// caller passes include_favicons:true. They have negligible value for agents
// and dominate payload size when present.

const MODES = new Set(['minimal', 'lite', 'full']);

// URL compaction for minimal mode. Drops fragments, queries, and trailing
// hash-like path segments. Title carries the primary semantic signal; URL
// in minimal mode is just a coarse hint at what the tab is. Full URL is
// always available via mode:'full'.
function compactUrl(url) {
  if (!url) return url;
  let u = String(url);
  const hashIdx = u.indexOf('#'); if (hashIdx >= 0) u = u.slice(0, hashIdx);
  const qIdx    = u.indexOf('?'); if (qIdx    >= 0) u = u.slice(0, qIdx);
  // Strip path segments that look like opaque IDs (long, mixed alphanumeric,
  // not broken up by enough word-separators to look like a slug).
  const isHashLike = (seg) => {
    if (seg.length <= 25) return false;
    const noBreaks = seg.replace(/[-_]/g, '');
    if (noBreaks.length < 20) return false;
    return /[a-z]/i.test(noBreaks) && /\d/.test(noBreaks);
  };
  const parts = u.split('/');
  const kept  = parts.filter(p => !isHashLike(p));
  let result  = kept.join('/');
  // Final length cap: 80 chars, truncate at last path boundary if needed.
  if (result.length > 80) {
    const cut = result.lastIndexOf('/', 80);
    if (cut > 'https://x'.length) result = result.slice(0, cut);
    else result = result.slice(0, 80);
  }
  return result;
}

// Strip favIconUrl recursively. Used in 'full' mode when include_favicons
// is not set (the default). favicons dominate payload size; agents almost
// never use them.
function stripFavicons(node) {
  if (!node || typeof node !== 'object') return node;
  const out = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === 'favIconUrl') continue;
    out[k] = (k === 'children' && Array.isArray(v)) ? v.map(stripFavicons) : v;
  }
  return out;
}

// Lite-mode node (tree shape). Keeps hierarchy, drops favicons, timestamps,
// visual fields, the empty per-node `notes` array. Includes openedDate so
// agents can answer time-based queries ("tabs older than 6 months").
function liteNode(node, scope, libraryId) {
  if (!node || typeof node !== 'object') return node;
  const out = {
    id:    node.id,
    type:  node.type,
    title: node.title || '',
  };
  if (scope)     out.scope     = scope;
  if (libraryId) out.libraryId = libraryId;
  if (node.url) out.url = node.url;
  if (node.type === 'tab' && node.chromeId === null) out.ghost = true;
  if (node.type === 'tab' && node.openedDate) out.openedDate = node.openedDate;
  if (Array.isArray(node.tags) && node.tags.length > 0) out.tags = node.tags;
  if (node.memoText) out.memoText = node.memoText;
  if (node.collapsed) out.collapsed = true;
  if (Array.isArray(node.children) && node.children.length > 0) {
    out.children = node.children.map(c => liteNode(c, scope, libraryId));
  }
  return out;
}

// Minimal-mode node. Single flat record per node; lineage preserved via
// parentId. Drops children, collapsed, ghost. URL compacted. openedDate
// kept for time-based queries. tags/memoText kept when non-empty (already
// conditional so they're free).
function minimalNode(node, scope, libraryId, parentId) {
  const out = {
    id:    node.id,
    type:  node.type,
    title: node.title || '',
  };
  if (scope)     out.scope     = scope;
  if (libraryId) out.libraryId = libraryId;
  if (parentId)  out.parentId  = parentId;
  if (node.url)  out.url       = compactUrl(node.url);
  if (node.type === 'tab' && node.openedDate) out.openedDate = node.openedDate;
  if (Array.isArray(node.tags) && node.tags.length > 0) out.tags = node.tags;
  if (node.memoText) out.memoText = node.memoText;
  return out;
}

// Flatten a tree into a minimal-mode array. parentId on each non-root node
// preserves enough lineage info for the agent to reconstruct hierarchy when
// it actually needs to (e.g. "tabs in window X" → filter where parentId===X).
function flattenForMinimal(nodes, scope, libraryId, parentId = null, out = []) {
  if (!Array.isArray(nodes)) return out;
  for (const node of nodes) {
    if (!node) continue;
    out.push(minimalNode(node, scope, libraryId, parentId));
    if (Array.isArray(node.children) && node.children.length > 0) {
      flattenForMinimal(node.children, scope, libraryId, node.id, out);
    }
  }
  return out;
}

// Dispatch helper: shape a tree (array of root nodes) according to mode.
function shapeTree(rootNodes, scope, libraryId, mode, includeFavicons) {
  if (mode === 'minimal') return flattenForMinimal(rootNodes, scope, libraryId);
  if (mode === 'lite')    return rootNodes.map(n => liteNode(n, scope, libraryId));
  // full
  return includeFavicons ? rootNodes : rootNodes.map(stripFavicons);
}

// Strip rich-text note content to id+title only. Note `content` is HTML/
// rich-text and dominates payload size for libraries with substantive notes
// (Demo Note alone can be 30KB+ of formatting markup). Used in minimal+lite
// modes. Full mode includes the content.
function liteNotes(notes) {
  if (!Array.isArray(notes)) return [];
  return notes.map(n => ({ id: n.id, title: n.title || '' }));
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

ROUTING — when the user expresses one of these intents, CALL THE LISTED TOOL FIRST instead of planning the task yourself by reading the tree:

  "organize / reorganize / clean up / sort / categorize / auto-organize / tidy / structure my bookmarks"
    → auto_organize_bookmarks  (drives the bookmark reorganization workflow end-to-end via an interactive popup panel; works on small AND large trees; do NOT read get_bookmarks and plan manually). BUT: this tool is Step 3 of the workflow. BEFORE calling it, offer the user a backup (Step 1) AND unconditionally run a dedup-scan-and-record pass (Step 2 — call find_duplicates without asking the user first; it's a read-only millisecond local scan that produces parentPath signal for better sorting). See AUTO-ORGANIZE BOOKMARKS WORKFLOW section below for the full sequence — read it before kickoff. Do NOT ask the user "want me to check for duplicates first?" — that's an old framing; the new flow folds dedup findings into a single combined kickoff message.

  "find / remove duplicate bookmarks" / "dedupe"
    → find_duplicates  (then ASK the user whether to (1) move duplicates to a 'Duplicates' folder for visual review or (2) delete the duplicate copies directly via bulk_apply delete_node({confirmedByUser:true}). Both are normal Pinako operations; present them as equal options, don\'t default-pick.)

  Questions about Pinako features / terminology / "how does X work"
    → search_docs  FIRST.  Pinako has product-specific meanings for "group", "folder", "memo", "ghost tab", "library group", "snapshot" etc. that differ from generic tab-manager intuition. Cheap local lookup; never guess from the term alone.

  Multiple browsers connected (Chrome + Brave both showing in list_browsers)
    → list_browsers  to learn names, then pass the chosen browser to subsequent tools via the browser argument.

WRITE TOOLS (Pro tier 1+)
Read tools (get_tree, search_tabs, list_libraries, get_library, get_main_tree_notes, get_bookmarks, list_browsers, find_duplicates, get_tree_summary, propose_categories, get_organize_state, get_observations, resolve_duplicate_landings, search_docs) require no special handling.

AUTO-ORGANIZE WORKFLOW TOOLS (see AUTO-ORGANIZE BOOKMARKS WORKFLOW section below): auto_organize_bookmarks (kickoff — call ONCE per session), get_organize_state (poll for user confirmation + Pause detection), apply_heuristic_organize (Step 7 broad-sweep returning planned moves), refine_folder_outliers (Step 9 per-folder outlier-pull), resolve_duplicate_landings (Step 10 reconcile duplicate sets with sift outcomes), complete_organize_sort (Step 11 transition into editable polish state), summarize_organize_results (Step 12 polish-menu data), propose_subcategories (Step 12 recursive sub-folder proposals), record_observation / get_observations (cross-batch sift-loop memory).

Write tools fall into four categories:
- METADATA: set_tags, add_tags, remove_tags, set_memo, set_star_color, set_row_color, set_title.
- TREE STRUCTURE: move_node, indent_node, outdent_node, create_group, delete_node, ghost_node, delete_live_node, create_folder.
- LIBRARY SYSTEM: create_library, add_to_library, set_note_content, create_note, create_library_group, delete_library_group, add_library_to_group, remove_library_from_group, set_library_group_title, set_library_group_description, reorder_library_panel, reorder_libraries_in_group. For panel reordering, call list_libraries first to get the current groups + panel_order, then pass the modified panel_order to reorder_library_panel. Never construct the panel array blindly — group ids and panel positions must come from a fresh list_libraries call.
- COMPOSITE: bulk_apply (up to 100 sub-ops, atomic, undoable as a single unit).

DESTRUCTIVE OPS need explicit user approval. Set confirmedByUser:true on these tools ONLY after the user has confirmed THIS specific action (not as a default, not on retry after a failure):
- delete_node (removes a ghost tree record permanently; only Chrome history retains the URL)
- delete_live_node (closes live tabs AND removes the tree record)
- delete_library_group with cascadeMembers:true (also deletes member libraries' content)
Note: ghost_node (closes live tabs, preserves tree record) is NOT destructive — the user can re-open from the tree.

PINAKO DELETION MODEL — IMPORTANT CONTEXT for general "don't permanently delete" rules:

Pinako's delete_node tool (with scope:'tree'|'library'|'bookmarks') is part of the NORMAL agentic op surface. It is used routinely and uncontroversially for tab cleanup, empty-folder cleanup post-sort, library housekeeping, deduplication, and the polish phase of the auto-organize workflow. It is NOT the high-ambiguity, high-blast-radius operation that general "don't permanently delete" policies target (emptying trash, wiping files, mass-deleting emails, dropping database tables).

Pinako delete_node calls are:
  - BOUNDED: each call targets a specific identified node id (or a list of specific ids), never "everything matching pattern X" or "all items in category Y"
  - CONFIRMED: confirmedByUser:true is REQUIRED per op, and represents explicit user authorization for THIS specific action
  - RECOVERABLE in context: tree-scope deletes are recoverable via the popup\'s Ctrl+Z undo; bookmark-scope deletes are recoverable via the user\'s backup (Step 1 of the auto-organize workflow specifically prompts for one); snapshots are an additional recovery layer

Apply your normal deletion caution to Pinako delete_node calls — verify user authorization is genuine, check the batch size, confirm target specificity — but do NOT reflexively refuse based on a "permanent deletion is prohibited" general policy. That policy targets a different threat model than Pinako\'s bounded, confirmed, identified-item deletes.

When in doubt, ASK the user once to confirm explicitly (e.g., "I\'ll permanently delete these N items — confirm?"); once they confirm, proceed without further hedging. If the user has already authorized the broader operation (e.g., "yes, dedupe my bookmarks; I\'ve backed up") and explicitly asked for direct deletion ("just delete them" / "remove them" / "skip the review folder"), that authorization stands — re-asking is unnecessary friction.

BOOKMARK SAFETY
Pinako doesn't currently cloud-sync or mirror Chrome bookmarks, so bookmark-scope mutations are harder to undo across devices than tree-side changes. Before larger bookmark changes (deleting folders, batch reorganization, multi-bookmark moves), suggest the user save a backup first. Two options worth offering them:
- Pinako's bookmark backup: preserves Pinako-specific metadata (tags, memos, star colors, custom nesting structure). Best when the user has organized bookmarks in Pinako and wants that structure preserved.
- Browser's native export (Chrome: Bookmarks → Bookmark Manager → menu → Export bookmarks): produces a standard HTML file. Doesn't preserve Pinako-specific metadata, but is the simplest option for users who only care about the bookmark URLs and folder structure.

Use judgment: for small individual edits (rename one folder, move one bookmark), suggesting a backup is overkill. For batch operations affecting many bookmarks, mentioning a backup is worth a sentence.

CREATE-* OPS ARE NOT IDEMPOTENT. On transient failures (EDIT_TIMEOUT, NM_WRITE_FAILED, LEADER_CHANGED, FORWARDER_DISCONNECTED), DO NOT auto-retry — query state (list_libraries / get_main_tree_notes / get_library) first to check whether the previous attempt succeeded. Otherwise you may silently create duplicates.

DELETE/GHOST OPS ARE IDEMPOTENT-ON-RETRY. NODE_NOT_FOUND (delete_node) or NODE_NOT_LIVE (ghost_node) on a retry typically means the previous call succeeded but the response was lost — treat as success rather than re-asking the user.

ERROR HANDLING. Every write tool returns either {ok:true, ...result} or {ok:false, error:{code, message, context}}. Branch on error.code to react programmatically (e.g., CONFIRMATION_REQUIRED → ask the user to confirm; NOTE_CONTENT_OVER_TIER_LIMIT → trim content or warn the user; LIBRARY_NOT_FOUND → re-fetch list_libraries; subOpIndex in bulk_apply errors identifies the failing sub-op so you can correct and resubmit).

DATA MODEL
The tab tree is hierarchical: Windows → Groups → Tabs.
- Each node has: id, type, title, url, favIconUrl, tags (string[]), memoText (short plain-text note, max 2500 chars), notes (rich text documents with title and HTML content), openedDate (Unix ms timestamp — the date the tab was opened or saved), collapsed, and children.
- Ghost tabs (chromeId = null) are tabs the user closed in the browser but chose to preserve in the Pinako tree. They can be reopened on demand. Treat them as saved/bookmarked tabs — they are NOT currently open in Chrome.
- Groups have a title and color. Windows have a title.
- Libraries are user-created collections of saved tabs organized into folders — like bookmarks but richer, with notes, tags, and memos.
- Main tree notes are rich text documents attached to the user's main tree (the live tab tree) rather than to a library or an individual tab. Refer to them as "main tree notes" in any user-facing language. ("global notes" is a legacy codebase term you may still encounter in older docs and internal field names; treat it as a synonym, but do not surface it to the user.)

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
When the user asks "find / list / count / tag / memo X", first distinguish two patterns:

LITERAL match — the user named an exact substring (URL, domain, specific tag value, exact title fragment):
  Examples: "tabs from stackoverflow.com", "tabs tagged 'urgent'", "the tab titled 'Inbox'".
  Approach: search_tabs for main tree; list_libraries + get_library for libraries if needed.

SEMANTIC / categorical intent — the user named a topic, theme, or concept:
  Examples: "find my exercise tabs", "anything about gardening", "show me cooking links", "tabs about programming", "tabs older than 6 months".
  Approach (faster AND more accurate than synonym iteration):
  1. Call get_tree({mode:"minimal"}) — flat list of every main-tree tab in compact form (~100 bytes/tab; fits 2000+ tab trees comfortably).
  2. Call list_libraries({include_tabs:true, mode:"minimal"}) — flat list of every library tab in compact form, one call across all libraries.
  3. Read the title+url+openedDate of every tab in those two responses and identify matches USING YOUR OWN UNDERSTANDING. You know "exercise" extends to squats, pushups, stretches, mobility, ancestral movement, primal patterns, strength training, etc. Match in-head; do not iterate search_tabs with keyword after keyword.
  4. Apply writes via per-scope bulk_apply (one per scope/libraryId — see WRITES below).

  Mode tiers (read tools):
  - "minimal" — flat list, compact URLs, no children/collapsed/ghost, keeps openedDate, tags, memoText. Smallest. Use for scan/find/filter.
  - "lite"    — tree shape, full URLs, includes children/collapsed/ghost/openedDate. Use when hierarchy matters ("what's in this window?", placement-aware ops).
  - "full"    — everything in source data except favicons. Use only when visual fields or rich-text note content are actually needed.
  - include_favicons:true — opt-in for the rare workflow that needs favicon images (e.g., organizing tabs by favicon color). Never default.

DO NOT call search_tabs multiple times with synonyms ("exercise", then "workout", then "fitness", then "stretch"...) — you will miss things (titles like "10-min Transform" with no obvious keyword) AND burn round-trips. Two well-chosen reads beat ten literal searches.

Both patterns cover tree + libraries by default. Skip bookmarks unless the user explicitly references them ("in my bookmarks", "across everything", "including bookmarks") — bookmark trees are often 10K+ entries and would dominate without adding signal.

When the query is about TABS / LINKS / WINDOWS / TREE structure, DO NOT include note content in the search. Notes are a separate surface — rich-text docs attached to a tree or library, not to individual tabs. Conflating "I have a tab about gardening" with "I wrote a note mentioning gardening" misleads the user. list_libraries and get_library return note metadata (id+title) but not content by default; that's intentional. Include note content only when the user explicitly says "notes" ("search my notes for X", "find the note about Y") — use get_main_tree_notes or get_library({lite:false}) then.

Report results BY SOURCE rather than as a bare total: "24 total — 3 live tabs, 8 ghosts in the main tree, 11 in 'Travel: Yucatán' library, 2 in 'Research Notes' library." The breakdown is often as useful as the count.

Override phrases that change scope:
- "in the main tree only" / "in the live tree" → skip libraries.
- "in my libraries only" → skip main tree.
- "in library X" → constrain to that one library.
- "everywhere" / "including bookmarks" → add bookmarks.

WRITES across multi-source results:
For "tag/memo all my X tabs as Y": issue ONE bulk_apply per scope (one for scope:'tree' main-tree nodes, one per affected library with scope:'library'+libraryId). Each bulk_apply is one undo step for the user — acceptable for now (cross-scope single-undo is on the roadmap).

MULTI-BROWSER
The user may have Pinako open in multiple browsers (Chrome + Brave, etc.) at the same time. Each install's tree, libraries, main tree notes, bookmarks, tags, and memos are independent data sources. Some may stay in step when both installs are signed into the same Pinako Pro account and cloud sync is current, but do not assume cross-install identity for any domain. Different accounts, signed-out installs, or in-flight sync can diverge them. Tools accept an optional 'browser' parameter (e.g., browser="Brave") to pick a specific install. Use list_browsers to discover what's connected and to see each install's updatedAt.

Selection rules:
- One browser connected: omit 'browser'; tools resolve automatically.
- Multiple connected, no browser chosen yet this conversation: tools return an ambiguity error. Ask the user which one, then retry with the chosen 'browser' value.
- After the user has named a browser (explicitly, or by answering the ambiguity prompt), treat it as the sticky default for the rest of the conversation. Reuse the same 'browser' value on every subsequent call without re-asking. Do NOT split the work across browsers, and do NOT re-ask which browser to use.
- Focus-shift exception: if a DIFFERENT browser's updatedAt is newer than the sticky choice's most recent updatedAt, the user has likely shifted attention to that browser. Ask once: "I noticed recent activity in <X>. Apply this to <X>, stay on <Y>, or do both?" Then adopt the answer as the new sticky default. updatedAt advances on any tree mutation (tab open/close, memo edit, note write), not strictly on window focus, so treat this as a heuristic and do NOT fire it again until updatedAt shifts further.
- Explicit overrides ("in both browsers", "do it in Chrome instead", "across all installs") win for that one call. If the user's phrasing sounds durable ("from now on use Chrome"), update the sticky default too.

LARGE TREE SIZE GUARD
Read tools (get_tree, get_bookmarks, get_library, get_main_tree_notes, list_libraries with include_tabs:true) check the estimated payload size against a per-tier budget BEFORE returning. When the payload would exceed the budget, the tool returns a structured warning INSTEAD of the data:

{
  "warning": "tree_too_large",
  "counts": { "nodes": N, "est_tokens": M, "mode": "lite" },
  "threshold": { "tier": T, "est_tokens_limit": L },
  "scope": "tree" | "bookmarks" | "library" | "main-tree-notes" | "libraries-with-tabs",
  "suggested_actions": [ ... tool-specific options ... ],
  "bypass": "Pass acknowledge_size:true to skip this guard and receive the full payload anyway."
}

When you receive this response:
1. Read suggested_actions. Each entry has {type, param, note}. Pick the option that matches the user's intent:
   - type:'mode', param:'minimal' — call the same tool again with mode:'minimal' (smaller payload, no tree structure / no rich content)
   - type:'scope', param:'per-library' — drop include_tabs and fetch one library at a time via get_library
   - type:'workflow', param:'auto_organize' — for organize/reorganize tasks, use the AUTO-ORGANIZE BOOKMARKS WORKFLOW workflow below
   - type:'acknowledge', param:'true' — only when the user genuinely needs the full payload and your model has sufficient context

2. NEVER paper over the warning by silently retrying with acknowledge_size:true. The guard exists to keep the agent from burning context on a payload too large to reason over.

3. For very large bookmark trees (10k+ entries) the warning is the rule, not the exception. Defer to auto-organize workflow for any reorganization task.

If the user's actual intent is reorganization rather than just "show me the tree," the right move is the auto-organize workflow (designed for this exact scale problem). Cost-optimization note: model choice matters. For pure categorization-into-folders tasks at scale, a small/cheap model (Haiku, GPT-4-mini, Grok-fast) is sufficient — categorization is a narrow pattern-match task that does NOT require frontier model capabilities. If the user is currently on a premium model and looking at a large-tree reorganize, mention that switching to a cheaper model for the bulk pass and reserving the premium for refinement can reduce cost roughly 3-5x with minimal quality loss. Final cost math is for you to estimate based on your current model's pricing and the est_tokens in the warning — Pinako stays out of model-pricing maintenance.

AUTO-ORGANIZE BOOKMARKS WORKFLOW

When the user asks you to "organize my bookmarks", "reorganize", "clean up my bookmarks", "auto-categorize", "sort my bookmarks into folders", or anything that maps to bulk reorganization of their bookmark collection, DO NOT plan it yourself by reading get_bookmarks and proposing categories manually. Pinako ships a dedicated workflow for this exact task with an interactive panel UI. You DRIVE the workflow from MCP tool calls; the USER drives the panel UI for the folder-structure decisions.

PRE-FLIGHT — BEFORE you call auto_organize_bookmarks, you MUST handle these in order:
  (a) Offer the user a backup (Step 1 below). For 1000+ bookmarks, insist. For a few hundred, mention it. WAIT for the user's response before continuing.
  (b) ALWAYS call find_duplicates({scope:'bookmarks', browser}) as part of pre-flight — do NOT ask permission first; it's a read-only millisecond local scan with zero side effects. This produces the parentPath context that the Step 8 LLM sift uses for better placement.
  (c) Roll the dedup findings + the destructive-consent ask into the SAME message that announces kickoff (see Step 2 for the prescribed phrasing). The user's "OK" approves both: (i) starting auto-organize AND (ii) the Step 10 auto-deletion of converged duplicate copies (delete_node with confirmedByUser:true). One combined consent. Then call auto_organize_bookmarks.
Skipping the backup offer is the most common mistake. ALWAYS at least mention the backup option before kickoff.

DO NOT ask the user "want me to check for duplicates?" as a separate question. The scan is part of standard pre-flight and runs unconditionally. The user's only consent is the combined kickoff prompt.

WORKFLOW STEPS (12-step, condensed)

1. SUGGEST A BACKUP. Pinako bookmark backup (preserves Pinako-specific metadata) or Chrome's native export (Bookmark Manager → menu → Export bookmarks). For a few hundred bookmarks, mention it; for 1000+ insist. ALWAYS surface this BEFORE calling auto_organize_bookmarks. Wait for the user's response; don't proceed until they have decided (back up, skip, or already done).

2. DEDUP-RECORD PASS (mandatory pre-flight, dedup-as-signal). UNCONDITIONALLY call find_duplicates({scope:'bookmarks', browser}) after the user has decided about backup (Step 1) and BEFORE calling auto_organize_bookmarks. The bridge auto-caches the result (each duplicate set carries each instance's parentPath — slash-joined breadcrumb of its current folder location) on lastDuplicateScan; the auto-organize pipeline reads this in Step 8 to use folder names as semantic signal, then reconciles post-sift in Step 10 via resolve_duplicate_landings.

   Do NOT move or delete duplicates here. Do NOT ask the user beforehand whether to scan — the scan is part of standard pre-flight. After the call returns, draft the COMBINED KICKOFF MESSAGE that bundles dedup findings + the destructive consent + the final OK-to-start prompt into ONE message to the user. Use this template:

   "Found [totalDuplicateInstances] duplicate copies across [uniqueDuplicateUrls] URLs. I'll use each copy's current folder as a sorting hint, then auto-delete redundant copies that land in the same bucket and bring divergent ones (different buckets) to you for review. Ready to start sorting?"

   Adapt the wording if zero duplicates: "No duplicates found — clean tree. Ready to start sorting?"

   The user's "yes" / "OK" / "go ahead" is the single consent that authorizes BOTH (a) calling auto_organize_bookmarks now AND (b) the Step 10 auto-deletion of converged duplicate copies via delete_node({confirmedByUser:true}). You do NOT need a second prompt at Step 10 — the consent here covers it.

   EXPLICIT-SKIP-DEDUP CASE: only if the user volunteers "skip dedup", "just organize without dedup", or similar, may you bypass the scan. This should be rare — the scan is free and improves placements. Do not preemptively offer the skip option; let the user volunteer it.

   STANDALONE DEDUP CASE: if the user wants to dedup OUTSIDE the auto-organize workflow (e.g. "clean up duplicates" with no mention of organizing), the original two-option flow applies — see find_duplicates tool description case A (move-to-Duplicates-folder vs delete-directly). That path is for users who want dedup as the final action, not as sorting setup.

3-5. KICKOFF. Call auto_organize_bookmarks({scope:'bookmarks', browser}) EXACTLY ONCE. This call does two things atomically:
  (a) computes heuristic-suggested category folders from the user's bookmark URL patterns — returned in the response as suggestions:[{target, count, sampleTitles}]
  (b) opens the auto-organize panel in the popup. The panel starts with the user's EXISTING bookmark folder structure (their current folders are the baseline buckets). The heuristic suggestions are overlaid in Step 4 as proposed ADDITIONS the user can accept, rename, or reject.

  CRITICAL FRAMING for your chat reply: do NOT present the matched-categories list as "the structure your bookmarks will use." That misframes the workflow. The user\'s EXISTING folders are the starting buckets; the heuristic suggestions are additions surfaced in Step 4 for user choice. A correct framing names both: "Your existing folders (tunes, Read, Travel, …) are the starting buckets. I\'ll then propose [N] additional categories for the [M] items the rules can auto-place." NEVER list the heuristic matches as if the user has agreed to that structure.

  After the call, tell the user the auto-organize panel is opening in the Pinako popup. Tell them to review their existing folder structure, trim or add as needed, click "Continue" to see the heuristic suggestion overlay, and click "Confirm & start sift" when ready. Do NOT call this tool more than once per session.

6. WAIT FOR USER CONFIRMATION. Poll get_organize_state({browser}) until workflowStep === 'sorting'. If workflowStep is still 'step-3' or 'step-4', the user is still editing the bucket structure — remind them in chat what to click. Don't proceed until 'sorting'.

  Once workflowStep === 'sorting', read state.buckets[] for the confirmed folder structure. Each bucket has {id, title, bookmarkFolderId, isSuggestion, isExisting, children}. bookmarkFolderId is the chrome.bookmarks folder id where moves go.

  STEP 5 (RULES, optional): BETWEEN the user clicking Confirm and you calling apply_heuristic_organize, ASK them once: "Before I sort, any special rules to apply? For example: links older than 5 years → Archive, all reddit.com → Social, anything matching nytimes.com/cooking → Recipes. Or just sort with the defaults." If they give rules, acknowledge them (you can\'t register custom rules in the heuristic library yet — v1 limitation — but you CAN apply them yourself during the Step 8 LLM sift loop by checking each item against the user\'s rules before falling back to LLM categorization). If they say "just go" or don\'t respond with rules, proceed. Don\'t pester — ask once, then move on.

7. HEURISTIC BROAD-SWEEP. Call apply_heuristic_organize({browser}) once. Returns:
  - moves[] {nodeId, title, url, newParentId, targetTitle, ruleId, confidence} — ready-to-apply moves
  - skippedTargets[] — heuristics that matched but where the user has no corresponding bucket. SURFACE THESE to the user ("I see 80 GitHub bookmarks but you didn't create a Programming folder — want one?"). They can Pause → Reset → add the folder → re-Confirm.
  - bucketSummary[] {title, bookmarkFolderId, willReceive} — preview of moves per bucket
  - unmatched_residue: count of bookmarks needing the LLM sift loop in Step 8

  APPLY THE MOVES via bulk_apply chunked at 100 ops per call, scope:'bookmarks'. Each op: {type:'move_node', nodeId, newParentId}. The chrome.bookmarks ids are translated to Pinako node ids server-side automatically; pass them through as-is.

8. LLM BATCH SIFT LOOP. For the unmatched_residue, you do the categorization yourself batch by batch:
  cursor = null
  loop:
    batch = get_bookmarks({after:cursor, limit:500, browser})
    if batch.items is empty: break
    SCOPE FILTER: if state.includeOtherRoots is false (default), skip items whose parentId traces back to Other Bookmarks (id '2') or Mobile Bookmarks (id '3') roots — only Bookmarks Bar items are in scope. When true, include all roots.

    DUPLICATE-SIGNAL INJECTION (Slice S2f, only when Step 2 dedup-record pass ran): before categorizing the batch, check duplicateContext from get_organize_state. If scopeMatchesWorkflow is true, build a Map<nodeId, parentPath> from the cached duplicate sets (each set has parallel nodeIds[] + parentPaths[] arrays). For each batch item whose id appears in that map, add a "path" field to the item's JSON entry when you construct the LLM categorization prompt — e.g. an item like {id:"17", title:"Daft Punk RAM", url:"spotify.com/..."} becomes {id:"17", title:"Daft Punk RAM", url:"spotify.com/...", path:"Gift ideas for mom"}. The path is the item's original folder location BEFORE this sort began, and is meaningful semantic signal (the user previously categorized this URL as part of their "Gift ideas for mom" collection — that biases the category). NON-DUPLICATE ITEMS GET NO PATH FIELD — keep them as {id, title, url} only; the dedup-coupled path injection is the ONLY case where path enters the sift payload. This bounds the token cost.

    categorize each remaining item against the user's confirmed buckets (state.buckets[].title from get_organize_state; skip the Review bucket — that's reserved for low-confidence destinations, not a regular category). For each item, assign a confidence in [0, 1]. If confidence >= 0.7, move to the matching bucket via newParentId = bucket.bookmarkFolderId. If confidence < 0.7, move to state.reviewBucket.bookmarkFolderId (the system Review folder) — that's the safety net the user reviews at the end. NEVER force-place a low-confidence item in a category; the Review folder exists exactly for this case.
    send bulk_apply with move_node ops for the categorized items (chunked at 100), scope:'bookmarks'
    cursor = batch.nextCursor

  BETWEEN BATCHES: call get_organize_state to check workflowStep. If it's 'paused', stop the loop, tell the user in chat ("Paused. Click Resume in the popup when you want me to continue, or Reset to return to setup."), and wait.

  USE THE OBSERVATION LOG. As you notice cross-batch patterns ("many cooking blogs without a clear domain", "tiktok.com URLs splitting between users and posts"), call record_observation({pattern, count, examples, batch_n}) to persist it. Before each next batch, call get_observations and include the digest in your categorization reasoning — cross-batch memory.

9. OUTLIER-PULL REFINEMENT (per populated folder). After Step 8 completes, scan each populated bucket for items that landed there but don't belong. Iterate over the user's confirmed buckets (state.buckets[] minus the Review bucket); for each, call refine_folder_outliers({folder_id: bucket.bookmarkFolderId, browser}). It returns the items in that folder + the sibling buckets. SCAN THE ITEMS for outliers — output should be SPARSE (5-15% relocations typical). For items that clearly belong in a sibling bucket, emit bulk_apply move_node ops with newParentId = siblingBucket.bookmarkFolderId. For ambiguous items (confidence < 0.7), route to reviewBucket.bookmarkFolderId. Most items stay; emit nothing for them.

  PATTERN EMERGENCE: if you notice a strong sub-pattern within a folder (e.g., 40% of "Music" items are clearly podcasts, or "News" splits into "Tech News" + "World News"), call record_observation. The user will see these in the Step 12 polish menu as sub-folder suggestions.

10. RESOLVE DUPLICATE LANDINGS (Slice S2f, only when Step 2 dedup-record pass ran). After Step 9 outlier-pull, call resolve_duplicate_landings({browser}). The tool partitions the recorded duplicate sets based on where each instance landed:

    CONVERGED — all surviving instances in same bucket. Per the Step 2 pre-consent, AUTO-DELETE the redundant copies: send ONE bulk_apply containing a delete_node sub-op per deleteNodeId across all converged sets, with confirmedByUser:true and scope:'bookmarks'. Aggregate the total deletableCount and the bucket distribution into a one-line user report: "Auto-deleted 287 duplicate copies — kept one of each in [Music, Programming, Recipes, …]."

    DIVERGED — instances split across multiple destinations. DO NOT auto-act. Hold the divergedSets[] for the Step 12 polish menu (the divergent count is surfaced there as a menu option). When the user picks that option, present each set per-row with options: consolidate to one bucket (delete the rest), leave as multiple homes (no action), or move minorities elsewhere.

    RESIDUE — all instances still in their original folders (sift didn't categorize any of them). Leave alone; the user's original placement stands.

    MISSING — instances that no longer exist (manual deletes during the workflow). Reported in summary.missing; the set is processed using surviving instances. Sets reduced to 1 surviving instance are skipped (no longer a duplicate).

    AMBIGUOUS-CASE PARKING: items routed to the Review bucket in Steps 8 and 9 are still the safety net. Mention to the user as part of the summary: "I sorted N items. M went to Review for your judgment. K duplicates were auto-consolidated; L duplicate sets need your decision in the polish menu."

11. ENTER POLISH STATE. After Step 10 completes, call complete_organize_sort({browser}) to transition the popup from the read-only sorting view to the editable polish view. The user can then add / rename / drag / delete-empty buckets while you drive the polish menu in chat. Without this call, the panel stays in sorting state and the user can't edit (by design — mid-sift editing is forbidden per the 2026-05-13 decision; refinement is deferred to Step 12).

12. POLISH MENU. After complete_organize_sort returns, call summarize_organize_results({browser}) for the post-sort summary: per-bucket counts, Review folder count, observation digest, sub-folder candidates (high-count buckets), and (Slice S2f) duplicates counts if Step 2 ran. Present the polish menu to the user in chat:

    "I sorted [totalSorted] items into your buckets:
      - Music: 148
      - Programming: 92
      - Research: 23
      - Review: 12 items I wasn't sure about
      - Auto-consolidated [converged] duplicate set(s); [diverged] need your review
    Want to refine further?
      • Review the Review folder ([reviewCount] items) — I'll take a focused pass
      • Resolve [diverged] divergent duplicate set(s) — pick one bucket per URL or keep multiple homes  [omit this option if diverged === 0]
      • Suggest sub-folders for [a high-count bucket] — I'll propose sub-categorization
      • Make corrections or add a new bucket — tell me what's wrong
      • Done — finish and exit"

    RECURSIVE LOOP — re-present the menu after each action until the user says Done. Actions map to existing tools:
      - Review the Review folder → refine_folder_outliers({folder_id: reviewBucket.bookmarkFolderId}) and route items to better buckets
      - Resolve divergent duplicate sets → use divergedSets[] from the resolve_duplicate_landings response. Walk the user through each set: show the URL, the sample title, and each instance's currentBucketTitle + originalParentPath. Ask: "[URL Title]: copies landed in [Music, Programming]; original folders were [Gift ideas for mom, March 2022]. Keep all, consolidate to Music (delete Programming copy), or consolidate to Programming?" Apply the user's choice via bulk_apply (delete_node for consolidations, no-op for keep-all). Loop through each diverged set.
      - Suggest sub-folders → call propose_subcategories({folder_id: bucket.bookmarkFolderId}) for the bucket the user named. Returns sub-category proposals (domain-frequency + path-token, scoped to that folder's contents). Present to user. On accept: create each sub-folder via create_folder({scope:'bookmarks', parentId:folder_id, title:suggestion.target}), then bulk_apply move_node ops to relocate matching items. Recursion depth bounded to 3 — track depth client-side; don't sub-categorize a sub-folder of a sub-folder.
      - Make corrections → if the user names a specific misplacement, use bulk_apply move_node directly; if they want new buckets, Pause → Reset → re-Confirm
      - Done → tell the user the workflow is complete. They click Done in the popup panel to close it (which pushes workflowStep:'idle' to clear bridge state).

SCOPE
v1 ships scope:'bookmarks' only. tree + library scopes (auto-organize main tree into libraries, sub-folder a large library) are planned but not implemented yet.

COST AND MODEL
Categorization at scale is a narrow pattern-match task. If the user is on a premium model (Sonnet, GPT-4, etc.) and looking at a large tree, mention that switching to a cheaper model (Haiku, GPT-4-mini, Grok-fast) for the bulk Step-8 sift and reserving the premium model for any refinement step reduces cost roughly 3-5x with minimal quality loss.

CONNECTION RECOVERY
If a tool returns "No data yet — open the Pinako extension first", or list_browsers returns an empty list when the user expects browsers to be connected, the Pinako extension's connection to this MCP server has lapsed. Tell the user to open the Pinako extension popup (click the Pinako icon in their browser toolbar). That re-establishes the native-messaging connection and brings the data back. This rarely happens after initial install, but can occur after PC sleep/wake, browser restart, or extended idle periods. The user does not need to restart your client (Claude Desktop, Cursor, etc.) — just opening the popup is enough.

For complete documentation, see: https://pinako.pro/docs/ai-connect`;

function createMcpServer() {
  const srv = new McpServer(
    { name: 'pinako', version: '1.2.0' },
    { instructions: SERVER_INSTRUCTIONS }
  );

  const BROWSER_ARG_DESC = 'Which Pinako install to query (browser brand like "Brave" or "Chrome", or browserId from list_browsers). Required when multiple browsers are connected; omit when only one is connected.';

  // Slice Y (2026-05-12): the bridge cache auto-refreshes on user activity
  // within ~1-2s via popup-side debounced pushTreeUpdate. This hint appended
  // to every Slice-Y-covered read tool teaches the agent to re-invoke fresh
  // when the user reports a change, rather than relying on prior conversation
  // responses that may pre-date the user's activity.
  const FRESHNESS_HINT = ' Cache is auto-refreshed on user activity within ~1-2s. For any "what\'s there now" or "current state" question, re-invoke this tool rather than relying on prior responses in this conversation. If the user references data that doesn\'t appear in your most recent tool response (a tab, library, note, or property they say they added or changed), re-invoke immediately rather than telling them you can\'t find it. The user\'s report is the source of truth; the cache may simply have refreshed since your last call.';

  // Common helper: normalize a caller's `mode` arg.
  const _normalizeMode = (m) => MODES.has(m) ? m : 'lite';

  srv.registerTool(
    'get_tree',
    {
      description:
        'Returns the tab tree (Windows → Groups → Tabs) from the Pinako extension. Three modes: ' +
        '"minimal" (FLAT list, compact URLs, drops children/collapsed/ghost, keeps openedDate — best for semantic search across 500+ tab trees); ' +
        '"lite" (DEFAULT — tree shape with children/collapsed/ghost, full URLs, keeps openedDate, no favicons); ' +
        '"full" (everything in source data EXCEPT favicons; useful only for visual-field workflows). ' +
        'Favicons are NEVER returned unless include_favicons:true (they\'re 1-3KB base64 blobs of zero agent value). ' +
        'Returns a structured {warning:"tree_too_large", suggested_actions:[...]} response (instead of the tree) when the estimated payload exceeds the per-tier read budget — call again with mode:"minimal" to shrink, with pagination (after/limit) to chunk through, or with acknowledge_size:true to bypass the guard. ' +
        'PAGINATION (Slice S2a): pass `after` (last-seen node id) and/or `limit` (default 500) to receive a FLAT paginated response: {items:[...], nextCursor:..., totalItems:N}. Items lose tree nesting but carry parentId so hierarchy can be reconstructed. Pagination bypasses the size guard automatically. Designed for the auto-organize sift loop — read 500 items, classify, bulk_apply moves, then read the next 500 via nextCursor. Cursor is robust to list churn: if the cursor node was moved between calls, pagination restarts from index 0 (the agent should still progress because moved items no longer appear in the flat list).' +
        FRESHNESS_HINT,
      inputSchema: {
        mode: z.enum(['minimal', 'lite', 'full']).optional().describe('Response mode. Default "lite". Use "minimal" for semantic-search scans.'),
        include_ghost_tabs: z.boolean().optional().describe('Include closed/ghost tabs (chromeId=null). Default true.'),
        include_favicons:   z.boolean().optional().describe('Include favIconUrl base64 data. Default false. Set true only for color-organization workflows.'),
        acknowledge_size:   z.boolean().optional().describe('Bypass the per-tier read-size guard and return the full payload anyway. Default false. Use only when your model has a context window large enough to comfortably absorb the warning\'s reported est_tokens.'),
        after:              z.string().optional().describe('Pagination cursor: last-seen node id from a previous paginated call. Omit on the first call. When present, returns items AFTER this id in DFS pre-order.'),
        limit:              z.number().int().min(1).max(5000).optional().describe('Max items per page. Default 500 when pagination is active. Triggers paginated response when set even without `after`.'),
        browser: z.string().optional().describe(BROWSER_ARG_DESC),
      },
    },
    async ({ mode, include_ghost_tabs = true, include_favicons = false, acknowledge_size = false, after, limit, browser }) => {
      mode = _normalizeMode(mode);
      const r = resolveBrowserData(browser);
      if (r.error) return r.error;
      const tree = getTree(r.data, include_ghost_tabs);

      // Slice S2a: paginated path. Returns a flat items[] + nextCursor.
      // Bypasses the size guard (pagination itself is the safety mechanism).
      if (_isPaginationRequested(after, limit)) {
        const effectiveLimit = Number.isFinite(limit) && limit > 0 ? limit : PAGINATION_DEFAULT_LIMITS.tree;
        const flat = _flattenTreeWithMode(tree, 'tree', null, mode, include_favicons);
        const page = _paginateByCursor(flat, after, effectiveLimit);
        return { content: [{ type: 'text', text: JSON.stringify({
          browser:    r.data.browserBrand,
          browserId:  r.data.browserId,
          scope:      'tree',
          mode,
          items:      page.items,
          nextCursor: page.nextCursor,
          totalItems: page.totalItems,
          cursorFound: page.cursorFound,
          updatedAt:  r.data.updatedAt,
        }) }] };
      }

      const out  = shapeTree(tree, 'tree', null, mode, include_favicons);

      const nodeCount = _countNodesDeep(out);
      const estTokens = _estimateTreeTokens(nodeCount, mode);
      const guard = _checkReadSizeGuard({
        estTokens, nodeCount, mode, scope: 'tree',
        browserData: r.data, acknowledge: acknowledge_size,
        suggestedActions: [
          { type: 'mode', param: 'minimal', note: 'Compact mode reduces tokens per node ~2-4x' },
          { type: 'pagination', param: 'after+limit', note: 'Pass limit:500 (and after:<lastId> on subsequent calls) for paginated reads — bypasses this guard and chunks the tree' },
          { type: 'workflow', param: 'auto_organize', note: 'If the user wants to reorganize, use the AUTO-ORGANIZE BOOKMARKS WORKFLOW workflow (see SERVER_INSTRUCTIONS); it reads in cursor-paginated batches and writes in chunked bulk_apply' },
        ],
      });
      if (guard) {
        return { content: [{ type: 'text', text: JSON.stringify({
          browser:   r.data.browserBrand,
          browserId: r.data.browserId,
          ...guard,
        }) }] };
      }

      return { content: [{ type: 'text', text: JSON.stringify({
        browser:   r.data.browserBrand,
        browserId: r.data.browserId,
        scope:     'tree',
        mode,
        tree:      out,
        updatedAt: r.data.updatedAt,
      }) }] };
    }
  );

  srv.registerTool(
    'search_tabs',
    {
      description: 'LITERAL substring search across main-tree tabs. Matches title, URL, memo text, and tags against the exact query string. Use ONLY when the user names a literal substring ("tabs from stackoverflow.com", "the tab titled exactly X"). For SEMANTIC / categorical intent ("find my exercise tabs", "anything about gardening") do NOT iterate this tool with synonyms — instead call get_tree({mode:"minimal"}) + list_libraries({include_tabs:true, mode:"minimal"}) and match in your own head. See SEARCH SCOPE in server instructions. Mode param: "minimal" (flat, compact URLs — default for this tool since results are already a focused list), "lite" (tree shape), "full" (everything except favicons).' + FRESHNESS_HINT,
      inputSchema: {
        query: z.string().describe('LITERAL substring (case-insensitive). For semantic intent, prefer get_tree.'),
        mode:  z.enum(['minimal', 'lite', 'full']).optional().describe('Response mode. Default "minimal" since search results are already a focused list.'),
        include_ghost_tabs: z.boolean().optional().describe('Include closed/ghost tabs. Default true.'),
        include_favicons:   z.boolean().optional().describe('Include favIconUrl base64. Default false.'),
        browser: z.string().optional().describe(BROWSER_ARG_DESC),
      },
    },
    async ({ query, mode, include_ghost_tabs = true, include_favicons = false, browser }) => {
      mode = _normalizeMode(mode || 'minimal');
      const r = resolveBrowserData(browser);
      if (r.error) return r.error;
      const results = searchInTree(r.data.tree, query, include_ghost_tabs);
      const out     = shapeTree(results, 'tree', null, mode, include_favicons);
      return { content: [{ type: 'text', text: JSON.stringify({
        browser: r.data.browserBrand,
        mode,
        results: out,
        count:   out.length,
      }) }] };
    }
  );

  srv.registerTool(
    'list_libraries',
    {
      description: 'Lists all Pinako libraries. Default: returns id, title, description, tabCount, and note metadata (id+title only, NO note content). Pass include_tabs:true to ALSO embed every library\'s tabs — the right call for cross-library searches ("find exercise tabs across all my libraries"), avoiding N separate get_library round-trips. With include_tabs, default mode is "minimal" (flat, compact URLs). Note CONTENT is never returned here; use get_library({mode:"full"}) if you need actual rich-text note bodies. Also returns the panel structure (groups + panel_order) needed as input to reorder_library_panel — always call this before any reorder op to source fresh group ids and panel positions. When include_tabs:true and the combined library payload exceeds the per-tier read budget, returns a structured {warning:"tree_too_large", suggested_actions:[...]} response instead — drop include_tabs and fetch one library at a time via get_library, or set acknowledge_size:true to bypass. ' +
        'PAGINATION (Slice S2a): pass `after` (last-seen library id) and/or `limit` (default 50) to chunk through libraries when the user has many. Returns {items:[...libraries...], nextCursor:..., totalItems:N, groups:[...], panel_order:[...]}. Pagination applies to the libraries array only — groups and panel_order are always returned in full (they are small metadata). When include_tabs:true is set alongside pagination, embedded tabs are kept tree-shaped within each library entry (use get_library with pagination if you need to chunk through a single huge library\'s tabs).' + FRESHNESS_HINT,
      inputSchema: {
        include_tabs: z.boolean().optional().describe('Embed each library\'s tabs in the response. Default false. Use this for cross-library semantic search in one call.'),
        mode:         z.enum(['minimal', 'lite', 'full']).optional().describe('Mode for embedded tabs (only used when include_tabs:true). Default "minimal".'),
        include_favicons: z.boolean().optional().describe('Include favIconUrl on embedded tabs. Default false.'),
        acknowledge_size: z.boolean().optional().describe('Bypass the per-tier read-size guard (only applies when include_tabs:true). Default false.'),
        after:        z.string().optional().describe('Pagination cursor: last-seen library id from a previous paginated call. Omit on the first call.'),
        limit:        z.number().int().min(1).max(500).optional().describe('Max libraries per page. Default 50 when pagination is active.'),
        browser:      z.string().optional().describe(BROWSER_ARG_DESC),
      },
    },
    async ({ include_tabs = false, mode, include_favicons = false, acknowledge_size = false, after, limit, browser }) => {
      mode = _normalizeMode(mode || 'minimal');
      const r = resolveBrowserData(browser);
      if (r.error) return r.error;
      const libs = (r.data.libraries || []).map(lib => {
        const entry = {
          id:          lib.id,
          title:       lib.title,
          description: lib.description || '',
          tabCount:    countTabsInLibrary(lib.children || []),
          notes:       liteNotes(lib.notes),
        };
        if (include_tabs) {
          entry.children = shapeTree(lib.children || [], 'library', lib.id, mode, include_favicons);
        }
        return entry;
      });

      // Size guard only relevant when include_tabs:true — without tabs the
      // response is just per-library metadata (small, even for 100+ libraries).
      if (include_tabs) {
        let nodeCount = 0;
        for (const lib of libs) nodeCount += _countNodesDeep(lib.children || []);
        const estTokens = _estimateTreeTokens(nodeCount, mode);
        const guard = _checkReadSizeGuard({
          estTokens, nodeCount, mode, scope: 'libraries-with-tabs',
          browserData: r.data, acknowledge: acknowledge_size,
          suggestedActions: [
            { type: 'mode', param: 'minimal', note: 'Use mode:"minimal" to reduce per-node tokens (~2-4x compression)' },
            { type: 'scope', param: 'per-library', note: 'Drop include_tabs and fetch one library at a time via get_library' },
            { type: 'pagination', param: 'after+limit', note: 'Pass limit:50 to chunk through libraries (cross-library tabs still embedded per-library; use get_library pagination for a single huge library)' },
            { type: 'workflow', param: 'auto_organize', note: 'If the user wants to reorganize, use the AUTO-ORGANIZE BOOKMARKS WORKFLOW workflow' },
          ],
        });
        if (guard) {
          return { content: [{ type: 'text', text: JSON.stringify({
            browser: r.data.browserBrand,
            ...guard,
          }) }] };
        }
      }

      // Slice Z (2026-05-12): expose library panel structure so agents can
      // construct a valid reorder_library_panel call. `groups` lists every
      // library group with its membership; `panel_order` is the unified
      // ordering of standalone libraries + groups on the cards panel
      // (each entry: {type:'library'|'group', id}). Both are sourced from
      // the popup's in-memory state via the same push pipeline as libraries.
      const groups = (r.data.libraryGroups || []).map(g => ({
        id:          g.id,
        title:       g.title,
        description: g.description || '',
        library_ids: g.libraryIds || [],
      }));
      const panel_order = r.data.libraryPanelOrder || [];

      // Slice S2a: paginated path. Pagination applies to the libraries array
      // only (groups + panel_order are small metadata, always returned in
      // full). Useful when the user has dozens of libraries.
      if (_isPaginationRequested(after, limit)) {
        const effectiveLimit = Number.isFinite(limit) && limit > 0 ? limit : PAGINATION_DEFAULT_LIMITS.libraries;
        const page = _paginateByCursor(libs, after, effectiveLimit);
        return { content: [{ type: 'text', text: JSON.stringify({
          browser:     r.data.browserBrand,
          mode:        include_tabs ? mode : undefined,
          items:       page.items,
          nextCursor:  page.nextCursor,
          totalItems:  page.totalItems,
          cursorFound: page.cursorFound,
          groups,
          panel_order,
        }) }] };
      }

      return { content: [{ type: 'text', text: JSON.stringify({
        browser:     r.data.browserBrand,
        mode:        include_tabs ? mode : undefined,
        libraries:   libs,
        groups,
        panel_order,
      }) }] };
    }
  );

  srv.registerTool(
    'get_library',
    {
      description: 'Returns one library\'s contents. Three modes: "minimal" (FLAT, compact URLs, drops children/collapsed/ghost — best for scanning), "lite" (DEFAULT — tree shape, full URLs, drops favicons and note content), "full" (everything including rich-text note bodies, but NO favicons unless include_favicons:true). Use "full" when you specifically need to read a note\'s rich-text body or visual properties. When the payload exceeds the per-tier read budget (large library + "full" mode is the typical trigger), returns a structured {warning:"tree_too_large", suggested_actions:[...]} response instead — switch to mode:"lite" or "minimal", paginate via after/limit, or pass acknowledge_size:true to bypass. ' +
        'PAGINATION (Slice S2a): pass `after` (last-seen node id) and/or `limit` (default 500) to receive a FLAT paginated response: {items:[...], nextCursor:..., totalItems:N, library:{id,title,description}, notes:[...]} — the library\'s tabs/windows/groups/folders are paginated; metadata + note titles are returned at the top level. Pagination bypasses the size guard automatically. Cursor is robust to list churn.' + FRESHNESS_HINT,
      inputSchema: {
        library_id: z.string().describe('Library id from list_libraries'),
        mode:       z.enum(['minimal', 'lite', 'full']).optional().describe('Response mode. Default "lite".'),
        include_favicons: z.boolean().optional().describe('Include favIconUrl base64. Default false.'),
        acknowledge_size: z.boolean().optional().describe('Bypass the per-tier read-size guard. Default false.'),
        after:      z.string().optional().describe('Pagination cursor: last-seen node id from a previous paginated call. Omit on the first call.'),
        limit:      z.number().int().min(1).max(5000).optional().describe('Max items per page. Default 500 when pagination is active.'),
        browser:    z.string().optional().describe(BROWSER_ARG_DESC),
      },
    },
    async ({ library_id, mode, include_favicons = false, acknowledge_size = false, after, limit, browser }) => {
      mode = _normalizeMode(mode);
      const r = resolveBrowserData(browser);
      if (r.error) return r.error;
      const lib = (r.data.libraries || []).find(l => l.id === library_id);
      if (!lib) return { content: [{ type: 'text', text: `Library not found: ${library_id} (in ${r.data.browserBrand})` }], isError: true };

      // Slice S2a: paginated path. Returns flat items + library metadata.
      // Library notes (titles only) are returned alongside, never paginated
      // (notes are few and small at the metadata level).
      if (_isPaginationRequested(after, limit)) {
        const effectiveLimit = Number.isFinite(limit) && limit > 0 ? limit : PAGINATION_DEFAULT_LIMITS.library;
        const flat = _flattenTreeWithMode(lib.children || [], 'library', library_id, mode, include_favicons);
        const page = _paginateByCursor(flat, after, effectiveLimit);
        return { content: [{ type: 'text', text: JSON.stringify({
          browser:    r.data.browserBrand,
          scope:      'library',
          libraryId:  library_id,
          mode,
          library:    { id: lib.id, title: lib.title, description: lib.description || '' },
          items:      page.items,
          nextCursor: page.nextCursor,
          totalItems: page.totalItems,
          cursorFound: page.cursorFound,
          notes:      liteNotes(lib.notes),
        }) }] };
      }

      let outLib;
      if (mode === 'minimal') {
        outLib = {
          id:          lib.id,
          title:       lib.title,
          description: lib.description || '',
          children:    flattenForMinimal(lib.children || [], 'library', library_id),
          notes:       liteNotes(lib.notes),
        };
      } else if (mode === 'lite') {
        const sanitized = sanitizeNode(lib);
        outLib = {
          id:          sanitized.id,
          title:       sanitized.title,
          description: sanitized.description || '',
          children:    (sanitized.children || []).map(c => liteNode(c, 'library', library_id)),
          notes:       liteNotes(sanitized.notes),
        };
      } else { // full
        const sanitized = sanitizeNode(lib);
        outLib = include_favicons ? sanitized : stripFavicons(sanitized);
      }

      // Token estimate covers children weight + (in 'full' mode) note bodies.
      const nodeCount = _countNodesDeep(outLib.children || []);
      let estTokens   = _estimateTreeTokens(nodeCount, mode);
      if (mode === 'full' && Array.isArray(outLib.notes)) {
        estTokens += _estimateNotesTokens(outLib.notes);
      }
      const guard = _checkReadSizeGuard({
        estTokens, nodeCount, mode, scope: 'library',
        browserData: r.data, acknowledge: acknowledge_size,
        suggestedActions: [
          { type: 'mode', param: 'minimal', note: 'Use mode:"minimal" or "lite" to reduce per-node tokens' },
          { type: 'pagination', param: 'after+limit', note: 'Pass limit:500 (and after:<lastId> on subsequent calls) for paginated reads — bypasses this guard and chunks the library' },
          { type: 'workflow', param: 'auto_organize', note: 'If the user wants to reorganize this library, use the AUTO-ORGANIZE BOOKMARKS WORKFLOW workflow scoped to this library' },
        ],
      });
      if (guard) {
        return { content: [{ type: 'text', text: JSON.stringify({
          browser:   r.data.browserBrand,
          libraryId: library_id,
          ...guard,
        }) }] };
      }

      return { content: [{ type: 'text', text: JSON.stringify({
        browser:   r.data.browserBrand,
        scope:     'library',
        libraryId: library_id,
        mode,
        library:   outLib,
      }) }] };
    }
  );

  srv.registerTool(
    'get_main_tree_notes',
    {
      description: 'Returns the main tree notes — rich text documents attached to the user\'s main tree (the live tab tree), as opposed to notes attached to a specific library. Cloud-synced, identical across browsers. (Legacy codebase name: "global notes". Surface as "main tree notes" in any user-facing language.) When the cumulative note content exceeds the per-tier read budget (this happens with a few very large notes), returns a structured {warning:"tree_too_large", suggested_actions:[...]} response instead — pass acknowledge_size:true to bypass if your model can absorb the reported est_tokens. ' +
        'PAGINATION (Slice S2a): pass `after` (last-seen note id) and/or `limit` (default 100) to receive notes one batch at a time: {items:[...notes...], nextCursor:..., totalItems:N}. Pagination returns notes in their stored order with full content bodies; pagination bypasses the size guard automatically. Useful when one or two notes are very large.' + FRESHNESS_HINT,
      inputSchema: {
        acknowledge_size: z.boolean().optional().describe('Bypass the per-tier read-size guard. Default false.'),
        after:            z.string().optional().describe('Pagination cursor: last-seen note id from a previous paginated call. Omit on the first call.'),
        limit:            z.number().int().min(1).max(1000).optional().describe('Max notes per page. Default 100 when pagination is active.'),
        browser: z.string().optional().describe(BROWSER_ARG_DESC),
      },
    },
    async ({ acknowledge_size = false, after, limit, browser }) => {
      const r = resolveBrowserData(browser);
      if (r.error) return r.error;
      const notes = r.data.globalNotes || [];

      // Slice S2a: paginated path returns notes in stored order with full
      // bodies, sliced by cursor. Bypasses the size guard.
      if (_isPaginationRequested(after, limit)) {
        const effectiveLimit = Number.isFinite(limit) && limit > 0 ? limit : PAGINATION_DEFAULT_LIMITS['main-tree-notes'];
        const page = _paginateByCursor(notes, after, effectiveLimit);
        return { content: [{ type: 'text', text: JSON.stringify({
          browser:     r.data.browserBrand,
          scope:       'main-tree-notes',
          items:       page.items,
          nextCursor:  page.nextCursor,
          totalItems:  page.totalItems,
          cursorFound: page.cursorFound,
        }) }] };
      }

      const estTokens = _estimateNotesTokens(notes);
      const guard = _checkReadSizeGuard({
        estTokens, nodeCount: notes.length, mode: null, scope: 'main-tree-notes',
        browserData: r.data, acknowledge: acknowledge_size,
        suggestedActions: [
          { type: 'pagination', param: 'after+limit', note: 'Pass limit:100 (and after:<lastNoteId> on subsequent calls) to read notes one batch at a time — bypasses this guard' },
          { type: 'acknowledge', param: 'true', note: 'No per-note partial-read tool yet; if the user really needs a specific note read by the agent, pass acknowledge_size:true (the bypass returns the full notes array; ensure your model has enough context budget for the reported est_tokens).' },
        ],
      });
      if (guard) {
        return { content: [{ type: 'text', text: JSON.stringify({
          browser: r.data.browserBrand,
          ...guard,
        }) }] };
      }
      return { content: [{ type: 'text', text: JSON.stringify({
        browser: r.data.browserBrand,
        mainTreeNotes: notes,
      }) }] };
    }
  );

  srv.registerTool(
    'get_bookmarks',
    {
      description: 'Returns the user\'s Chrome bookmark tree (raw chrome.bookmarks.getTree() result). Use this to discover bookmark node ids before calling add_to_library with sourceScope="bookmarks". Each node has: id (stable Chrome bookmark id; persists across the bookmark\'s lifetime), title, url (set for bookmarks, missing for folders), children (array, present for folders), dateAdded (Unix ms timestamp), parentId, index (0-based position within parent). Top-level roots are typically "Bookmarks Bar" (id "1") and "Other Bookmarks" (id "2"). When the bookmark tree exceeds the per-tier read budget (common — bookmark trees can hold 10K+ entries accumulated over years), returns a structured {warning:"tree_too_large", suggested_actions:[...]} response instead — use the AUTO-ORGANIZE BOOKMARKS WORKFLOW workflow to read in cursor-paginated chunks, or pass acknowledge_size:true to bypass. ' +
        'PAGINATION (Slice S2a): pass `after` (last-seen bookmark id) and/or `limit` (default 500) to receive a FLAT paginated response: {items:[{id,title,url?,parentId,dateAdded,index},...], nextCursor:..., totalItems:N}. DFS pre-order across all bookmark nodes (folders included). Pagination bypasses the size guard automatically. Designed for the auto-organize sift loop. Cursor is robust to list churn: if the cursor bookmark was moved between calls, pagination restarts from index 0.' + FRESHNESS_HINT,
      inputSchema: {
        acknowledge_size: z.boolean().optional().describe('Bypass the per-tier read-size guard. Default false.'),
        after:            z.string().optional().describe('Pagination cursor: last-seen bookmark id from a previous paginated call. Omit on the first call.'),
        limit:            z.number().int().min(1).max(5000).optional().describe('Max items per page. Default 500 when pagination is active. Triggers paginated response when set even without `after`.'),
        browser: z.string().optional().describe(BROWSER_ARG_DESC),
      },
    },
    async ({ acknowledge_size = false, after, limit, browser }) => {
      const r = resolveBrowserData(browser);
      if (r.error) return r.error;
      const bookmarks = r.data.bookmarks || [];

      // Slice S2a: paginated path. Returns a flat DFS list of all bookmark
      // nodes (folders + leaves). Bypasses the size guard.
      if (_isPaginationRequested(after, limit)) {
        const effectiveLimit = Number.isFinite(limit) && limit > 0 ? limit : PAGINATION_DEFAULT_LIMITS.bookmarks;
        const flat = _flattenBookmarksTree(bookmarks);
        const page = _paginateByCursor(flat, after, effectiveLimit);
        return { content: [{ type: 'text', text: JSON.stringify({
          browser:    r.data.browserBrand,
          browserId:  r.data.browserId,
          scope:      'bookmarks',
          items:      page.items,
          nextCursor: page.nextCursor,
          totalItems: page.totalItems,
          cursorFound: page.cursorFound,
          updatedAt:  r.data.updatedAt,
        }) }] };
      }

      const nodeCount = _countNodesDeep(bookmarks);
      // Bookmarks are denser per node than tabs (URL + title + dateAdded + parentId).
      // Treat as 'lite' equivalent for token estimation.
      const estTokens = _estimateTreeTokens(nodeCount, 'lite');
      const guard = _checkReadSizeGuard({
        estTokens, nodeCount, mode: 'lite', scope: 'bookmarks',
        browserData: r.data, acknowledge: acknowledge_size,
        suggestedActions: [
          { type: 'pagination', param: 'after+limit', note: 'Pass limit:500 (and after:<lastId> on subsequent calls) for paginated reads — bypasses this guard and chunks the tree' },
          { type: 'workflow', param: 'auto_organize', note: 'For organize/reorganize tasks, use the AUTO-ORGANIZE BOOKMARKS WORKFLOW workflow (see SERVER_INSTRUCTIONS); it reads in cursor-paginated batches' },
          { type: 'acknowledge', param: 'true', note: 'If you only need a one-shot read and your model has a large context window, pass acknowledge_size:true' },
        ],
      });
      if (guard) {
        return { content: [{ type: 'text', text: JSON.stringify({
          browser:   r.data.browserBrand,
          browserId: r.data.browserId,
          ...guard,
        }) }] };
      }
      return { content: [{ type: 'text', text: JSON.stringify({
        browser:   r.data.browserBrand,
        browserId: r.data.browserId,
        bookmarks,
        updatedAt: r.data.updatedAt,
      }) }] };
    }
  );

  srv.registerTool(
    'find_duplicates',
    {
      description: 'Finds exact-URL duplicates within a single scope (tree, bookmarks, or a specific library). Bridge-side scan; no LLM, no agent reasoning required. For v1 ships with exact URL match only — byte-identical URLs grouped together; URLs differing in tracking params (utm_source, fbclid, etc.) or fragment identifiers are treated as DISTINCT. Fuzzy / near-duplicate matching deferred to v2 polish.\n\n' +
        'AGENT FLOW DEPENDS ON CONTEXT — two cases:\n\n' +
        'CASE A: STANDALONE DEDUP (no auto-organize workflow active). Summarize counts + sample titles to the user → ASK which of two equally-valid paths:\n\n' +
        '  Option 1 — Move to a "Duplicates" folder: bulk_apply with move_node to relocate the duplicate copies into a single "Duplicates" folder under Bookmarks Bar. The user can scroll through the folder in Chrome\'s Bookmark Manager and remove them at leisure (Ctrl+A inside the folder + Delete clears the lot in ~3 seconds).\n\n' +
        '  Option 2 — Delete the duplicate copies directly: bulk_apply with delete_node({confirmedByUser:true}) on the duplicate node ids. Bounded (specific identified node ids), confirmed (user picked this path), recoverable via the user\'s Step 1 backup.\n\n' +
        'Phrase the choice neutrally; both options are normal Pinako operations. See PINAKO DELETION MODEL above for context.\n\n' +
        'CASE B: AUTO-ORGANIZE WORKFLOW (Step 2 of LARGE TREE ORGANIZATION). DO NOT ask the user "want me to check for duplicates?" first — this call is mandatory pre-flight, not optional. Do NOT move or delete duplicates here. The bridge auto-caches the duplicate sets (including each instance\'s parentPath) on lastDuplicateScan so the auto-organize pipeline can use each duplicate\'s original folder as semantic signal during the LLM sift (Step 8), then reconcile them post-sift via resolve_duplicate_landings (Step 10). After this call returns, draft ONE combined message that reports duplicate counts + auto-delete-on-converge consent + ready-to-start question — e.g. "Found N duplicates across M URLs. I\'ll use each copy\'s current folder as a sorting hint, then auto-delete redundant copies that land in the same bucket and bring divergent ones to you for review. Ready to start sorting?" The user\'s OK to that single message authorizes BOTH the auto_organize_bookmarks kickoff AND the Step 10 delete_node ops on converged duplicates (confirmedByUser:true). One consent, end-to-end.\n\n' +
        'In CASE A, keep ONE copy of each URL — the duplicate SETS contain ALL nodes with that URL; you move/delete count-1 (e.g., a set of 3 → 2 moved/deleted). "totalDuplicateInstances" = sum(count-1) across all sets — the number that would be acted on.\n\n' +
        'Response: duplicateSets ordered by frequency descending (most-duplicated URL first). Each set: {url, count, nodeIds[], parentPaths[] (parallel to nodeIds; slash-joined parent breadcrumb for each instance, e.g. "Music/Classical"; empty string for items at root level), sampleTitles[] (up to 3 distinct)}. Top-level also returns {cached:true, cachedAt} so the agent knows the parentPath context is available for downstream tools.',
      inputSchema: {
        scope: z.enum(['tree', 'bookmarks', 'library']).describe('Which data source to scan. "tree" = live tab tree (windows/groups/tabs). "bookmarks" = browser bookmark tree (Chrome bookmarks API source). "library" = a specific Pinako library (requires library_id).'),
        library_id: z.string().optional().describe('Library id from list_libraries. Required when scope:"library".'),
        match_mode: z.enum(['exact']).optional().describe('Match strategy. Currently only "exact" (byte-identical URL match) is supported.'),
        browser: z.string().optional().describe(BROWSER_ARG_DESC),
      },
    },
    async ({ scope, library_id, match_mode = 'exact', browser }) => {
      const r = resolveBrowserData(browser);
      if (r.error) return r.error;

      let scanTree;
      let scopeIdentifier;
      if (scope === 'tree') {
        scanTree = r.data.tree || [];
        scopeIdentifier = null;
      } else if (scope === 'bookmarks') {
        scanTree = r.data.bookmarks || [];
        scopeIdentifier = null;
      } else if (scope === 'library') {
        if (!library_id) {
          return { content: [{ type: 'text', text: JSON.stringify({
            error: { code: 'LIBRARY_ID_REQUIRED', message: 'library_id is required when scope:"library"' },
          }) }], isError: true };
        }
        const lib = (r.data.libraries || []).find(l => l.id === library_id);
        if (!lib) {
          return { content: [{ type: 'text', text: JSON.stringify({
            error: { code: 'LIBRARY_NOT_FOUND', message: `Library not found: ${library_id} (in ${r.data.browserBrand})` },
          }) }], isError: true };
        }
        scanTree = lib.children || [];
        scopeIdentifier = library_id;
      }

      const result = _findDuplicateUrls(scanTree);

      // Side effect: cache result on the per-browser cache entry so the
      // auto-organize workflow (Step 7 sift loop, Step 9 resolve_duplicate_landings)
      // can read each duplicate instance's parentPath as semantic signal. Always
      // caches the latest scan, regardless of whether auto-organize is active —
      // the workflow checks workflowStep + scope match before consuming.
      const cachedAt = Date.now();
      r.data.lastDuplicateScan = {
        scope,
        libraryId: scopeIdentifier,
        matchMode: match_mode,
        scannedAt: cachedAt,
        duplicateSets: result.duplicateSets,
        totalDuplicateInstances: result.totalDuplicateInstances,
        uniqueDuplicateUrls: result.uniqueDuplicateUrls,
        totalScannedWithUrl: result.totalScannedWithUrl,
      };

      return { content: [{ type: 'text', text: JSON.stringify({
        browser:    r.data.browserBrand,
        browserId:  r.data.browserId,
        scope,
        libraryId:  scopeIdentifier,
        matchMode:  match_mode,
        cached:     true,
        cachedAt,
        ...result,
      }) }] };
    }
  );

  srv.registerTool(
    'get_tree_summary',
    {
      description: 'Returns a lightweight structural summary of a tree/bookmarks/library WITHOUT returning the actual nodes. Bridge-side; no LLM. Designed for the auto-organize workflow kickoff (and any "should I read this whole tree?" decision the agent faces): the summary fits in <2KB regardless of tree size and lets the agent decide whether to proceed, what scope makes sense, and ballpark the cost. Does NOT trigger the size guard — the whole point is "summarize before reading."\n\n' +
        'Response shape: {browser, browserId, scope, libraryId?, counts:{nodes, url_bearing_nodes}, depth:{max, median}, topDomains:[{domain,count},...up to 15], samplePatterns:[{pattern,token,count},...up to 15], sampleTitles:[...up to 20]}. ' +
        'topDomains = highest-frequency hostnames (www-stripped). samplePatterns = path-token frequency across all URLs (stop-words filtered: html, www, login, etc.); token of "recipe" with pattern "*recipe*" means 389 URLs had "recipe" somewhere in their path. sampleTitles = a deterministic stride sample of node titles (stable across calls — safe to cite back to the user).\n\n' +
        'For scope:"library", library_id is required. For scope:"bookmarks", returns the cached browser bookmark tree summary (empty if user hasn\'t opened the bookmarks panel since the bridge started). For scope:"tree", summarizes the live tab tree.',
      inputSchema: {
        scope:      z.enum(['tree', 'bookmarks', 'library']).optional().describe('Which data source to summarize. Default "tree".'),
        library_id: z.string().optional().describe('Library id from list_libraries. Required when scope:"library".'),
        browser:    z.string().optional().describe(BROWSER_ARG_DESC),
      },
    },
    async ({ scope = 'tree', library_id, browser }) => {
      const r = resolveBrowserData(browser);
      if (r.error) return r.error;

      let roots;
      let scopeIdentifier = null;
      if (scope === 'tree') {
        roots = r.data.tree || [];
      } else if (scope === 'bookmarks') {
        roots = r.data.bookmarks || [];
      } else if (scope === 'library') {
        if (!library_id) {
          return { content: [{ type: 'text', text: JSON.stringify({
            error: { code: 'LIBRARY_ID_REQUIRED', message: 'library_id is required when scope:"library"' },
          }) }], isError: true };
        }
        const lib = (r.data.libraries || []).find(l => l.id === library_id);
        if (!lib) {
          return { content: [{ type: 'text', text: JSON.stringify({
            error: { code: 'LIBRARY_NOT_FOUND', message: `Library not found: ${library_id} (in ${r.data.browserBrand})` },
          }) }], isError: true };
        }
        roots = lib.children || [];
        scopeIdentifier = library_id;
      }

      const summary = _summarizeTreeStructure(roots);

      return { content: [{ type: 'text', text: JSON.stringify({
        browser:   r.data.browserBrand,
        browserId: r.data.browserId,
        scope,
        libraryId: scopeIdentifier,
        ...summary,
        updatedAt: r.data.updatedAt,
      }) }] };
    }
  );

  srv.registerTool(
    'propose_categories',
    {
      description: 'Bridge-side category proposal for the auto-organize workflow (Step 4). Applies the default heuristic rule library (50-165 high-confidence domain rules — Spotify→Music, GitHub→Programming, arXiv→Research, etc.) to the target scope, then proposes top-level folder names for the UNMATCHED residue based on domain frequency and path-token patterns. No LLM. Bridge-side, fast (typically <100ms even on 19k bookmarks).\n\n' +
        'Response shape: {browser, browserId, scope, libraryId?, totals:{scanned, matched, unmatched, rulesApplied}, matched:[{ruleId,target,count,sampleTitles:[]},...] (collapsed per target), suggestions:[{target,domain?,pattern?,count,basis:"domain-frequency"|"path-token",sampleTitles?},...up to 15]}.\n\n' +
        'Suggestions are ranked: highest-count domain suggestions first (more reliable signal), then path-token suggestions for residue not covered by domain suggestions. minMatchCount filter (default 100) — only patterns with at least N residue items get proposed, so the agent gets actionable categories not one-off noise. Maintain hedged language with the user: "I noticed about 1,847 Spotify links unmatched — suggest a Music folder?" The user can rename, reject, or extend in the auto-organize panel.\n\n' +
        'For scope:"library", library_id is required. For scope:"bookmarks", the cached bookmark tree is used (open the bookmarks panel first if empty). Designed to be called AFTER find_duplicates and AFTER user has confirmed their existing folder structure (Step 3) — the suggestions go on top of those user folders.',
      inputSchema: {
        scope:         z.enum(['tree', 'bookmarks', 'library']).optional().describe('Which data source to analyze. Default "tree".'),
        library_id:    z.string().optional().describe('Library id from list_libraries. Required when scope:"library".'),
        min_match_count: z.number().int().min(1).max(10000).optional().describe('Suggestion floor: only propose categories with at least N residue items. Default 100. Drop to 30-50 for smaller trees if no suggestions emerge.'),
        max_suggestions: z.number().int().min(1).max(50).optional().describe('Maximum number of category suggestions to return. Default 15.'),
        browser:       z.string().optional().describe(BROWSER_ARG_DESC),
      },
    },
    async ({ scope = 'tree', library_id, min_match_count, max_suggestions, browser }) => {
      const r = resolveBrowserData(browser);
      if (r.error) return r.error;

      let roots;
      let scopeIdentifier = null;
      if (scope === 'tree') {
        roots = r.data.tree || [];
      } else if (scope === 'bookmarks') {
        roots = r.data.bookmarks || [];
      } else if (scope === 'library') {
        if (!library_id) {
          return { content: [{ type: 'text', text: JSON.stringify({
            error: { code: 'LIBRARY_ID_REQUIRED', message: 'library_id is required when scope:"library"' },
          }) }], isError: true };
        }
        const lib = (r.data.libraries || []).find(l => l.id === library_id);
        if (!lib) {
          return { content: [{ type: 'text', text: JSON.stringify({
            error: { code: 'LIBRARY_NOT_FOUND', message: `Library not found: ${library_id} (in ${r.data.browserBrand})` },
          }) }], isError: true };
        }
        roots = lib.children || [];
        scopeIdentifier = library_id;
      }

      const rules = _loadHeuristicRules();
      const { matched, unmatched } = _applyHeuristicsToTree(roots, rules);

      // Collapse matched by target (the user-facing category folder name),
      // not by ruleId — many rules map to the same target ("Music" gets
      // hits from spotify-music, soundcloud, bandcamp, etc.). Include up
      // to 3 sample titles per target for the agent to summarize.
      const matchedByTarget = new Map();
      for (const m of matched) {
        let entry = matchedByTarget.get(m.target);
        if (!entry) {
          entry = { target: m.target, count: 0, ruleIds: new Set(), sampleTitles: [] };
          matchedByTarget.set(m.target, entry);
        }
        entry.count++;
        entry.ruleIds.add(m.ruleId);
        if (entry.sampleTitles.length < 3 && m.node.title) {
          entry.sampleTitles.push(String(m.node.title));
        }
      }
      const matchedSummary = [...matchedByTarget.values()]
        .sort((a, b) => b.count - a.count)
        .map(e => ({ target: e.target, count: e.count, ruleIds: [...e.ruleIds], sampleTitles: e.sampleTitles }));

      const suggestions = _proposeCategoriesFromResidue(unmatched, {
        minMatchCount: min_match_count,
        maxSuggestions: max_suggestions,
      });

      return { content: [{ type: 'text', text: JSON.stringify({
        browser:   r.data.browserBrand,
        browserId: r.data.browserId,
        scope,
        libraryId: scopeIdentifier,
        totals: {
          scanned:      matched.length + unmatched.length,
          matched:      matched.length,
          unmatched:    unmatched.length,
          rulesApplied: rules.length,
        },
        matched:     matchedSummary,
        suggestions,
        updatedAt:   r.data.updatedAt,
      }) }] };
    }
  );

  srv.registerTool(
    'auto_organize_bookmarks',
    {
      description: 'Auto-organize bookmarks. Kickoff tool for the bookmark reorganization workflow (Step 3 of the 12-step sequence). Use this when the user asks to organize, reorganize, clean up, sort, categorize, auto-sort, auto-categorize, tidy, structure, or otherwise rearrange their bookmarks — regardless of bookmark count.\n\n' +
        'CRITICAL: this tool is Step 3 of the workflow, not Step 1. BEFORE calling this tool:\n' +
        '  Step 1: Offer the user a backup. For 1000+ bookmarks INSIST; for a few hundred MENTION it. Two options: Pinako bookmark backup (preserves Pinako-specific metadata) or Chrome\'s native export (Bookmark Manager → menu → Export bookmarks). Wait for the user\'s response before continuing.\n' +
        '  Step 2: UNCONDITIONALLY call find_duplicates({scope:\'bookmarks\'}) WITHOUT asking the user first. It is a read-only millisecond local scan and produces parentPath signal for better Step 8 sift placement. Then draft ONE combined kickoff message: "Found N duplicates across M URLs. I\'ll use each copy\'s current folder as a sorting hint, then auto-delete redundant copies that land in the same bucket and bring divergent ones to you for review. Ready to start sorting?" The user\'s "yes" to that ONE message is the consent for both starting the sort AND Step 10 auto-deletion of converged duplicates. DO NOT ask "want me to check for duplicates first?" as a separate question — that is an OLD framing the new flow replaces.\n' +
        'Only after the user has decided about backup AND given OK to the combined kickoff message should you call this tool.\n\n' +
        'What this call does atomically:\n' +
        '  - Scans the user\'s bookmarks against the default heuristic rule library (165 rules across 26 categories) — DIAGNOSTIC ONLY at this stage. The matched-categories list tells you how many items the rules could auto-place IF the user accepts the suggested categories in Step 4.\n' +
        '  - Computes suggested category folders for the residue (domain-frequency + path-token patterns).\n' +
        '  - Opens the auto-organize panel in the Pinako popup. The panel shows the user\'s EXISTING bookmark folder structure as the starting point — NOT the heuristic categories. The heuristic-suggested categories are overlaid in Step 4 as proposed additions (with a ✨ suggested tag) after the user reviews their existing folders.\n\n' +
        'Response shape: {totals:{scanned, matched, unmatched, rulesApplied}, matched:[{ruleId, target, count, sampleTitles}], suggestions:[{target, count, basis, sampleTitles}], panelLaunch:{ok, channel:\'storage-local\', requestId}}.\n\n' +
        'IMPORTANT — how to frame the response in chat:\n' +
        '  Do NOT present the matched-categories list as "the structure your bookmarks will use" — that misframes the workflow. The user\'s EXISTING folders are the starting point; the heuristic suggestions are ADDITIONS they choose to accept in Step 4.\n' +
        '  GOOD framing: "I\'ve opened the auto-organize panel in your Pinako popup. You\'ll see your existing folder structure — review it, trim what you don\'t want, add new folders if you like, then click Continue. I\'ll then propose [N] additional category folders for [M] bookmarks the rules could auto-place (Video, Music, Social, etc.) — you can accept, rename, or reject each one. Once you click Confirm & start sift, I\'ll sort the [R] remaining items into your buckets."\n' +
        '  BAD framing: "Here\'s the structure: 🎬 Video 71, 🎵 Music 67, ..." (this implies the heuristic categories will be the buckets, which is false — the user\'s existing folders + their Step 4 choices are the buckets).\n\n' +
        'After this call, wait for the user to confirm in the popup. Poll state.workflowStep via get_organize_state until it becomes \'sorting\' (the user clicked "Confirm & start sift"). Then drive Steps 6-10 of the workflow (see AUTO-ORGANIZE BOOKMARKS WORKFLOW section in SERVER_INSTRUCTIONS for the full sequence).\n\n' +
        'Call this ONCE per session. Do not call again unless the user resets and re-kicks-off.\n\n' +
        'Delivery model: the bridge writes a pending-command record to the extension\'s chrome.storage.local. The Pinako popup picks it up live via chrome.storage.onChanged (or on next open if currently closed). Fire-and-forget — the tool returns the prepared data + a delivery receipt, not a guarantee the user has seen the panel. If the popup is closed for >60s the command is treated as stale and discarded. If the user reports the panel didn\'t open: ask them to close and re-open the Pinako popup (resets the NM connection), then retry.\n\n' +
        'v1 scope: bookmarks only. Tree + library scopes (auto-organize live tabs into libraries; sub-folder a large library) are planned but not yet implemented.',
      inputSchema: {
        scope:         z.enum(['bookmarks']).optional().describe('Which data source to organize. v1: \'bookmarks\' only. Default \'bookmarks\'. Tree + library coming later.'),
        min_match_count: z.number().int().min(1).max(10000).optional().describe('Suggestion floor: only propose categories with at least N residue items. Default 100.'),
        max_suggestions: z.number().int().min(1).max(50).optional().describe('Maximum number of category suggestions. Default 15.'),
        browser:       z.string().optional().describe(BROWSER_ARG_DESC),
      },
    },
    async ({ scope = 'bookmarks', min_match_count, max_suggestions, browser }) => {
      const r = resolveBrowserData(browser);
      if (r.error) return r.error;

      if (scope !== 'bookmarks') {
        return { content: [{ type: 'text', text: JSON.stringify({
          error: { code: 'SCOPE_NOT_SUPPORTED', message: `scope='${scope}' not yet supported. v1 ships 'bookmarks' only; see auto-organize-plan.md future-scope note.` },
        }) }], isError: true };
      }

      // Compute propose_categories internally so the panel has its
      // suggestions to overlay in Step 4.
      const roots = r.data.bookmarks || [];
      const rules = _loadHeuristicRules();
      const { matched, unmatched } = _applyHeuristicsToTree(roots, rules);
      const matchedByTarget = new Map();
      for (const m of matched) {
        let entry = matchedByTarget.get(m.target);
        if (!entry) {
          entry = { target: m.target, count: 0, ruleIds: new Set(), sampleTitles: [] };
          matchedByTarget.set(m.target, entry);
        }
        entry.count++;
        entry.ruleIds.add(m.ruleId);
        if (entry.sampleTitles.length < 3 && m.node.title) {
          entry.sampleTitles.push(String(m.node.title));
        }
      }
      const matchedSummary = [...matchedByTarget.values()]
        .sort((a, b) => b.count - a.count)
        .map(e => ({ target: e.target, count: e.count, ruleIds: [...e.ruleIds], sampleTitles: e.sampleTitles }));
      const suggestions = _proposeCategoriesFromResidue(unmatched, {
        minMatchCount: min_match_count,
        maxSuggestions: max_suggestions,
      });

      // Send a pending-command record to the popup via the SW. Delivery
      // channel is chrome.storage.local — the SW writes the key on
      // receiving this NM message; the popup's chrome.storage.onChanged
      // listener picks it up live (and a startup-check reads it on next
      // popup open if the popup was closed). No round-trip wait;
      // pendingCommand is fire-and-forget.
      const requestId = randomBytes(8).toString('hex');
      const ok = nmWrite({
        type:      'enqueueAgentCommand',
        command:   'openAutoOrganize',
        scope,
        suggestions,
        browserId: r.data.browserId,
        requestId,
        sentAt:    Date.now(),
      });

      return { content: [{ type: 'text', text: JSON.stringify({
        browser:   r.data.browserBrand,
        browserId: r.data.browserId,
        scope,
        totals: {
          scanned:      matched.length + unmatched.length,
          matched:      matched.length,
          unmatched:    unmatched.length,
          rulesApplied: rules.length,
        },
        matched:    matchedSummary,
        suggestions,
        panelLaunch: {
          ok,
          channel:   'storage-local',
          requestId,
          note: ok
            ? 'Pending-command record sent to the popup. If the popup is open, the panel launches immediately. Otherwise it launches on next popup open (within 60s of this tool call).'
            : 'NM bridge could not send the command (extension may be disconnected). Tell the user to open the Pinako popup, then retry.',
        },
        updatedAt: r.data.updatedAt,
      }) }] };
    }
  );

  // ─── S2c (2026-05-13): auto-organize sift loop ─────────────────────────────
  srv.registerTool(
    'apply_heuristic_organize',
    {
      description: 'Step 6 of the auto-organize workflow — heuristic broad-sweep. Runs the default rule library (165 rules across 26 categories) against the user\'s confirmed bucket structure (from Step 4 / get_organize_state) and returns a PLANNED move list. Does NOT mutate anything itself — agent reviews + commits via bulk_apply (chunked at 100 ops/call).\n\n' +
        'Prerequisites: auto_organize_bookmarks must have been called, the user must have confirmed the bucket structure in Step 4 (popup workflowStep === \'sorting\'), and get_organize_state must return non-empty buckets. If workflowStep is still \'step-3\' or \'step-4\', the tool returns an error — wait for the user to confirm in the popup.\n\n' +
        'Matching rule: a heuristic-matched bookmark is moveable IF its target category name (e.g. "Music", "Programming") matches a top-level bucket title in the user\'s confirmed structure (case-insensitive). Unmatched targets — categories the heuristics fire for but where the user has no corresponding bucket — are skipped and counted under `skippedTargets` so the agent can summarize them ("you have 80 GitHub bookmarks but no Programming folder; want to add one?"). v1 matches against TOP-LEVEL buckets only; sub-folder routing is Step 10 / S2d.\n\n' +
        'Response shape:\n' +
        '  totals: { scanned, matched, moveable, skipped_no_bucket, unmatched_residue }\n' +
        '  moves:  [{nodeId, title, url, newParentId, targetTitle, ruleId, confidence},...]\n' +
        '          nodeId and newParentId are chrome.bookmarks ids (pass directly to bulk_apply with scope:\'bookmarks\' — the popup translates to Pinako node ids internally). confidence is \'high\'|\'medium\' (low-confidence rules are excluded from broad-sweep per heuristic-rule-format spec).\n' +
        '  skippedTargets: [{target, count, reason, sampleTitles[]},...] — heuristic-matched items with no destination bucket\n' +
        '  bucketSummary:  [{title, bookmarkFolderId, willReceive},...] — preview of where moves will land\n' +
        '  unmatched_residue: count of bookmarks that didn\'t match any rule (drives the Step 7 LLM sift loop on get_bookmarks pagination)\n\n' +
        'For very large bookmark trees the moves array can be long (e.g. 5,000+). The agent should chunk into bulk_apply calls of up to 100 ops each. Per-call response shape stays bounded — moves are compact (~120 bytes per entry).',
      inputSchema: {
        confidence_floor: z.enum(['high', 'medium']).optional().describe('Minimum rule confidence to include in moves. Default \'medium\' (= medium + high). Drop to \'high\' to skip medium-confidence rules (e.g., medium.com → Articles) and only act on the most reliable ones.'),
        max_moves:        z.number().int().min(1).max(10000).optional().describe('Cap on moves[] length. Default 5000. If exceeded, response truncates moves[] and includes more_moves_available:true — call again after applying the first batch to receive the next chunk (cache-friendly via the pinako-mcp prompt cache).'),
        browser:          z.string().optional().describe(BROWSER_ARG_DESC),
      },
    },
    async ({ confidence_floor = 'medium', max_moves, browser }) => {
      const r = resolveBrowserData(browser);
      if (r.error) return r.error;

      const state = r.data.organizeState;
      if (!state) {
        return { content: [{ type: 'text', text: JSON.stringify({
          error: { code: 'ORGANIZE_STATE_NOT_READY', message: 'No auto-organize state cached for this browser. Call auto_organize_bookmarks first, then wait for the user to confirm the bucket structure in Step 4.' },
        }) }], isError: true };
      }
      if (state.workflowStep !== 'sorting' && state.workflowStep !== 'paused') {
        return { content: [{ type: 'text', text: JSON.stringify({
          error: { code: 'ORGANIZE_STATE_NOT_READY', message: `Workflow is in step '${state.workflowStep}'. The user must confirm the bucket structure in the popup (Step 4) before the heuristic broad-sweep can run.` },
          workflowStep: state.workflowStep,
        }) }], isError: true };
      }
      const buckets = Array.isArray(state.buckets) ? state.buckets : [];
      if (buckets.length === 0) {
        return { content: [{ type: 'text', text: JSON.stringify({
          error: { code: 'NO_BUCKETS_CONFIRMED', message: 'The confirmed bucket structure is empty. Ask the user to add at least one folder in the auto-organize panel before re-running.' },
        }) }], isError: true };
      }

      // Build top-level bucket lookup by lowercase title → bookmarkFolderId.
      // v1: top-level only; nested sub-folders are S2d / Step 12 polish menu.
      // S2d Phase 2: skip the Review system bucket — heuristics never route to
      // Review (that's exclusively for LLM low-confidence sift items).
      const bucketByTitleLc = new Map();
      for (const b of buckets) {
        if (b && b.isReview) continue;
        const titleLc = String(b.title || '').trim().toLowerCase();
        if (!titleLc || !b.bookmarkFolderId) continue;
        if (!bucketByTitleLc.has(titleLc)) bucketByTitleLc.set(titleLc, b);
      }

      // S2d Phase 1: respect the includeOtherRoots flag from the cached
      // organize state. When false (default), scope is limited to the
      // Bookmarks Bar root. When true, the full bookmark tree is walked
      // including Other Bookmarks (id '2') and Mobile Bookmarks (id '3').
      let roots = r.data.bookmarks || [];
      if (!state.includeOtherRoots) {
        const wrapper = roots[0];
        if (wrapper && Array.isArray(wrapper.children) && wrapper.children.length > 0) {
          // Bookmarks Bar is conventionally id '1' (find by id for safety).
          const bookmarksBar = wrapper.children.find(c => c && c.id === '1')
            || wrapper.children[0];
          roots = [bookmarksBar];
        }
      }
      const rules = _loadHeuristicRules();
      const { matched, unmatched } = _applyHeuristicsToTree(roots, rules);

      const allowMedium = confidence_floor === 'medium';
      const cap = Number.isFinite(max_moves) && max_moves > 0 ? max_moves : 5000;

      const moves = [];
      const skippedByTarget = new Map();
      const willReceiveByBucket = new Map();
      let skippedNoBucketCount = 0;

      for (const m of matched) {
        if (m.confidence !== 'high' && !(allowMedium && m.confidence === 'medium')) continue;
        const targetLc = String(m.target || '').trim().toLowerCase();
        const bucket = bucketByTitleLc.get(targetLc);
        if (!bucket) {
          skippedNoBucketCount++;
          let entry = skippedByTarget.get(m.target);
          if (!entry) {
            entry = { target: m.target, count: 0, sampleTitles: [] };
            skippedByTarget.set(m.target, entry);
          }
          entry.count++;
          if (entry.sampleTitles.length < 3 && m.node && m.node.title) {
            entry.sampleTitles.push(String(m.node.title));
          }
          continue;
        }
        // Skip the move if the bookmark is already in the right bucket (no-op).
        if (m.node && m.node.parentId && m.node.parentId === bucket.bookmarkFolderId) continue;

        if (moves.length < cap) {
          moves.push({
            nodeId:       String(m.node.id),
            title:        String(m.node.title || ''),
            url:          String(m.node.url || ''),
            newParentId:  String(bucket.bookmarkFolderId),
            targetTitle:  bucket.title,
            ruleId:       m.ruleId,
            confidence:   m.confidence,
          });
        }
        const willCount = willReceiveByBucket.get(bucket.bookmarkFolderId) || 0;
        willReceiveByBucket.set(bucket.bookmarkFolderId, willCount + 1);
      }

      const skippedTargets = [...skippedByTarget.values()]
        .map(e => ({ ...e, reason: `No bucket named '${e.target}' in the user's confirmed structure.` }))
        .sort((a, b) => b.count - a.count);
      const bucketSummary = buckets.map(b => ({
        title:            b.title,
        bookmarkFolderId: b.bookmarkFolderId,
        willReceive:      willReceiveByBucket.get(b.bookmarkFolderId) || 0,
      }));
      const moveable = [...willReceiveByBucket.values()].reduce((acc, n) => acc + n, 0);
      const moreMovesAvailable = moveable > moves.length;

      return { content: [{ type: 'text', text: JSON.stringify({
        browser:    r.data.browserBrand,
        browserId:  r.data.browserId,
        scope:      state.scope || 'bookmarks',
        totals: {
          scanned:           matched.length + unmatched.length,
          matched:           matched.length,
          moveable,
          skipped_no_bucket: skippedNoBucketCount,
          unmatched_residue: unmatched.length,
        },
        moves,
        moves_returned:        moves.length,
        more_moves_available:  moreMovesAvailable,
        skippedTargets,
        bucketSummary,
        confidence_floor,
        rulesApplied: rules.length,
        next_steps: 'Apply these moves via bulk_apply (scope:\'bookmarks\', chunked at 100 ops/call). After applying, drive the Step 7 LLM sift loop on the unmatched_residue: get_bookmarks(after, limit:500) → LLM categorize → bulk_apply move_node ops to the right bucket.bookmarkFolderId.',
        updatedAt:  r.data.updatedAt,
      }) }] };
    }
  );

  srv.registerTool(
    'refine_folder_outliers',
    {
      description: 'Step 8 of the auto-organize workflow — LLM outlier-pull refinement for a populated bucket. Returns the items currently in a folder + the sibling confirmed buckets (the OTHER user-approved categories). Use this AFTER the Step 7 sift loop completes, iterating over each populated bucket in turn. The output is sparse: scan the items and only emit relocations for the few items that DON\'T belong in this folder. Most items stay in place.\n\n' +
        'Why this matters: heuristic broad-sweep + LLM sift land items into buckets via domain rules + per-item categorization, but errors accumulate. Step 8 is the LLM-driven correction pass — second look at each folder, identify items that don\'t fit, relocate to the right sibling bucket (or Review if low-confidence). Typical: 5-15% of items in a folder get relocated.\n\n' +
        'Response shape: {folder:{title, bookmarkFolderId, totalItems, returnedItems}, items:[{nodeId, title, url, parentId, dateAdded}], nextCursor, siblingBuckets:[{title, bookmarkFolderId}], reviewBucket?:{title, bookmarkFolderId}, hint}.\n\n' +
        'Output protocol: emit bulk_apply move_node ops only for items that need relocation. For items confirmed-in-place, emit nothing. For items clearly out-of-place but ambiguous (confidence < 0.7), route to reviewBucket.bookmarkFolderId. Pattern emergence: if you notice a strong sub-pattern within a folder (e.g., 40% of "Music" items are clearly podcasts), call record_observation to surface a sub-folder suggestion for Step 12 polish.',
      inputSchema: {
        folder_id: z.string().describe('The chrome.bookmarks folder id (= bucket.bookmarkFolderId from get_organize_state.buckets) — the folder to scan for outliers.'),
        after:     z.string().optional().describe('Pagination cursor: last-seen nodeId from a previous call on this folder.'),
        limit:     z.number().int().min(1).max(500).optional().describe('Max items per page. Default 200 (smaller than sift-loop default of 500 since outlier scans involve more LLM reasoning per item).'),
        browser:   z.string().optional().describe(BROWSER_ARG_DESC),
      },
    },
    async ({ folder_id, after, limit, browser }) => {
      const r = resolveBrowserData(browser);
      if (r.error) return r.error;
      const state = r.data.organizeState;
      if (!state) {
        return { content: [{ type: 'text', text: JSON.stringify({
          error: { code: 'ORGANIZE_STATE_NOT_READY', message: 'No auto-organize state cached. Call auto_organize_bookmarks first and wait for the user to confirm.' },
        }) }], isError: true };
      }
      if (state.workflowStep !== 'sorting' && state.workflowStep !== 'paused') {
        return { content: [{ type: 'text', text: JSON.stringify({
          error: { code: 'ORGANIZE_STATE_NOT_READY', message: `Workflow is in step '${state.workflowStep}'. Outlier-pull only runs after the user confirms the bucket structure (workflowStep === 'sorting').` },
          workflowStep: state.workflowStep,
        }) }], isError: true };
      }

      const folder = _findBookmarkFolderByChromeId(r.data.bookmarks || [], folder_id);
      if (!folder) {
        return { content: [{ type: 'text', text: JSON.stringify({
          error: { code: 'FOLDER_NOT_FOUND', message: `Bookmark folder ${folder_id} not found in this browser's cached bookmark tree.` },
        }) }], isError: true };
      }

      // Flatten leaves (URL-bearing items only — sub-folders within this
      // folder aren't part of the outlier scan for v1; user-defined nesting
      // is preserved).
      const allItems = [];
      function walk(n) {
        if (!n) return;
        if (n.url) {
          allItems.push({
            nodeId:    String(n.id),
            title:     String(n.title || ''),
            url:       String(n.url),
            parentId:  String(n.parentId || ''),
            dateAdded: n.dateAdded || null,
          });
        }
        if (Array.isArray(n.children)) n.children.forEach(walk);
      }
      for (const c of (folder.children || [])) walk(c);

      // Paginate.
      const effectiveLimit = Number.isFinite(limit) && limit > 0 ? limit : 200;
      let startIdx = 0;
      let cursorFound = true;
      if (after) {
        const idx = allItems.findIndex(it => it.nodeId === after);
        if (idx >= 0) {
          startIdx = idx + 1;
        } else {
          // Bad cursor (item moved/deleted between calls) — restart from 0.
          startIdx = 0;
          cursorFound = false;
        }
      }
      const slice = allItems.slice(startIdx, startIdx + effectiveLimit);
      const nextCursor = (startIdx + slice.length < allItems.length)
        ? slice[slice.length - 1].nodeId
        : null;

      // Sibling buckets (exclude the current folder + Review system bucket).
      const buckets = Array.isArray(state.buckets) ? state.buckets : [];
      const siblingBuckets = buckets
        .filter(b => b && b.bookmarkFolderId && b.bookmarkFolderId !== folder_id && !b.isReview)
        .map(b => ({ title: b.title, bookmarkFolderId: b.bookmarkFolderId }));
      const reviewBucket = buckets.find(b => b && b.isReview);

      // Self bucket info (for the LLM's frame of reference: "this is the
      // Music folder; here's what's in it; here are the sibling categories").
      const selfBucket = buckets.find(b => b && b.bookmarkFolderId === folder_id);

      return { content: [{ type: 'text', text: JSON.stringify({
        browser:    r.data.browserBrand,
        browserId:  r.data.browserId,
        folder: {
          title:           selfBucket ? selfBucket.title : (folder.title || ''),
          bookmarkFolderId: folder_id,
          totalItems:      allItems.length,
          returnedItems:   slice.length,
        },
        items:        slice,
        nextCursor,
        cursorFound,
        siblingBuckets,
        reviewBucket: reviewBucket
          ? { title: reviewBucket.title, bookmarkFolderId: reviewBucket.bookmarkFolderId }
          : null,
        hint: 'Scan items for outliers. Most should stay in this folder (output nothing for them). For items that clearly belong in a sibling bucket, emit bulk_apply move_node ops with newParentId = siblingBucket.bookmarkFolderId. For items clearly out of place but ambiguous (confidence < 0.7), route to reviewBucket.bookmarkFolderId. Output should be sparse — typical folders see 5-15% relocations.',
      }) }] };
    }
  );

  srv.registerTool(
    'summarize_organize_results',
    {
      description: 'Step 12 of the auto-organize workflow — post-sort summary for the polish menu. Returns per-bucket item counts (queried from the cached chrome.bookmarks tree), Review folder count, total sorted items, a digest of the most-recent observations from record_observation, and (Slice S2f, 2026-05-14) a duplicates summary if Step 2 dedup-record + Step 10 resolve_duplicate_landings ran. Use this AFTER the sift loop + outlier-pull + duplicate-resolution are done to summarize results to the user and drive the recursive polish menu:\n\n' +
        '"I sorted N items into your buckets:\n  Music: 148\n  Programming: 92\n  Research: 23\n  Review: 12 items I wasn\'t sure about\nWant to refine further?\n  • Review the Review folder (12 items)\n  • Suggest sub-folders for any populated bucket\n  • Make corrections / add a new bucket\n  • Done"\n\n' +
        'Counts come from the bridge\'s bookmark cache (~1-2s stale via SW chrome.bookmarks listener). Refresh by calling get_bookmarks or making sure the SW push has fired recently. Pattern hint: high-count buckets are sub-folder candidates; low-count buckets may be over-granular.',
      inputSchema: {
        browser: z.string().optional().describe(BROWSER_ARG_DESC),
      },
    },
    async ({ browser }) => {
      const r = resolveBrowserData(browser);
      if (r.error) return r.error;
      const state = r.data.organizeState;
      if (!state) {
        return { content: [{ type: 'text', text: JSON.stringify({
          error: { code: 'ORGANIZE_STATE_NOT_READY', message: 'No auto-organize state cached. Call auto_organize_bookmarks first.' },
        }) }], isError: true };
      }
      const buckets = Array.isArray(state.buckets) ? state.buckets : [];

      // Count URL leaves under each bucket folder.
      function countLeaves(node) {
        if (!node) return 0;
        if (node.url) return 1;
        if (!Array.isArray(node.children)) return 0;
        let s = 0;
        for (const c of node.children) s += countLeaves(c);
        return s;
      }

      const bucketSummary = [];
      let reviewCount = 0;
      let totalSorted = 0;
      for (const b of buckets) {
        if (!b || !b.bookmarkFolderId) continue;
        const folder = _findBookmarkFolderByChromeId(r.data.bookmarks || [], b.bookmarkFolderId);
        const count = folder ? countLeaves(folder) : 0;
        const entry = {
          title:            b.title,
          bookmarkFolderId: b.bookmarkFolderId,
          count,
          isReview:         !!b.isReview,
          isSuggestion:     !!b.isSuggestion,
          isExisting:       !!b.isExisting,
        };
        bucketSummary.push(entry);
        if (b.isReview) {
          reviewCount = count;
        } else {
          totalSorted += count;
        }
      }

      // Observation digest (up to 5 most recent).
      const log_ = _organizeObservationLog.get(r.data.browserId) || [];
      const observationDigest = log_.slice(-5).map(o => ({
        pattern:    o.pattern,
        count:      o.count,
        batch_n:    o.batch_n,
        recordedAt: o.recordedAt,
      }));

      // Identify high-count buckets that may warrant sub-folder suggestions.
      const subFolderCandidates = bucketSummary
        .filter(b => !b.isReview && b.count >= 50)
        .sort((a, b) => b.count - a.count)
        .map(b => ({ title: b.title, count: b.count, bookmarkFolderId: b.bookmarkFolderId }));

      // Slice S2f (2026-05-14): surface duplicate context if a recent scan
      // exists for this workflow. The agent uses these counts to drive the
      // post-sift consolidation (Step 9 → resolve_duplicate_landings) and to
      // tell the user "N duplicates were auto-deleted / M need your review".
      const dupScan = r.data.lastDuplicateScan || null;
      let duplicates = null;
      if (dupScan && dupScan.scope === state.scope && (dupScan.libraryId || null) === (state.libraryId || null)) {
        duplicates = {
          totalSets:        dupScan.uniqueDuplicateUrls,
          totalInstances:   dupScan.totalDuplicateInstances,
          scannedAt:        dupScan.scannedAt,
          hint:             'Call resolve_duplicate_landings BEFORE complete_organize_sort to classify these sets as converged (auto-delete) / diverged (surface in polish menu) / residue (leave alone).',
        };
      }

      const polishMenuTemplate = duplicates
        ? 'I sorted [totalSorted] items into your buckets. [Review] has [reviewCount] items I wasn\'t sure about. There were also [duplicates.totalInstances] duplicates across [duplicates.totalSets] URLs — call resolve_duplicate_landings to reconcile them; converged sets auto-delete (Step 2 pre-consent), diverged sets get added to the polish menu below. Want to refine further?\n  - Review the Review folder ([reviewCount] items)\n  - Resolve [diverged] divergent duplicate sets (after resolve_duplicate_landings)\n  - Suggest sub-folders for [high-count bucket]\n  - Add corrections / new buckets\n  - Done'
        : 'I sorted [totalSorted] items into your buckets. [Review] has [reviewCount] items I wasn\'t sure about. Want to refine further?\n  - Review the Review folder ([reviewCount] items)\n  - Suggest sub-folders for [high-count bucket]\n  - Add corrections / new buckets\n  - Done';

      return { content: [{ type: 'text', text: JSON.stringify({
        browser:           r.data.browserBrand,
        browserId:         r.data.browserId,
        workflowStep:      state.workflowStep,
        bucketSummary,
        reviewCount,
        totalSorted,
        observationCount:  log_.length,
        observationDigest,
        subFolderCandidates,
        duplicates,
        polish_menu_template: polishMenuTemplate,
        updatedAt:         r.data.updatedAt,
      }) }] };
    }
  );

  srv.registerTool(
    'resolve_duplicate_landings',
    {
      description: 'Step 9 of the auto-organize workflow (Slice S2f, 2026-05-14). After the LLM sift (Step 7) and outlier-pull refinement (Step 8) have completed and BEFORE calling complete_organize_sort, call this to reconcile the duplicate sets recorded at Step 2 against where each instance now lives.\n\n' +
        'Prerequisite: find_duplicates must have been called earlier (Step 2) so lastDuplicateScan is cached on the bridge. If no cached scan exists for the active workflow scope, this returns counts of 0 across all categories — safe to call defensively.\n\n' +
        'Classification (per duplicate set, based on each instance\'s CURRENT chrome.bookmarks parent):\n\n' +
        '  CONVERGED — all surviving instances now sit under the same bucketFolderId (including the Review bucket). The user pre-consented at Step 2 to auto-deletion of redundant copies in this case. Action: issue bulk_apply with delete_node({confirmedByUser:true}) on each set\'s deleteNodeIds[] (which is nodeIds minus keepNodeId — by default the first surviving instance). One bulk_apply call across all converged sets is fine.\n\n' +
        '  DIVERGED — instances are split across 2 or more distinct destinations (multiple buckets, or a bucket + residue, or multiple buckets + residue). DO NOT auto-delete. Surface each diverged set to the user in the Step 12 polish menu so they can decide per-set: consolidate to one bucket / leave as multiple homes / move minorities elsewhere. Use the originalParentPath on each instance as additional context when explaining the set to the user.\n\n' +
        '  RESIDUE — all instances are still in their original (non-bucket) folders. The sift didn\'t categorize them. Leave them alone — they\'ll surface in the normal Review-folder flow or remain where the user originally put them.\n\n' +
        '  MISSING — a previously-recorded instance no longer exists (user manually deleted, or bridge cache stale). Counted in summary.missing; the set is otherwise processed using the surviving instances. Sets reduced to 1 surviving instance fall out of the duplicate space entirely and are not reported.\n\n' +
        'Response: { convergedSets:[{url, bucketFolderId, bucketTitle, isReview, keepNodeId, deleteNodeIds[], sampleTitle, originalParentPaths[]}], divergedSets:[{url, sampleTitle, instances:[{nodeId, currentParentId, currentBucketFolderId, currentBucketTitle, isReview, originalParentPath}]}], residueSets:[{url, sampleTitle, instances:[{nodeId, currentParentId, originalParentPath}]}], summary:{totalSets, converged, diverged, residue, missing, deletableCount, divergedInstanceCount}, next_steps }.\n\n' +
        'deletableCount = total number of delete_node ops needed across all converged sets (sum of deleteNodeIds.length). This is the "N duplicates auto-deleted" count to report to the user.',
      inputSchema: {
        browser: z.string().optional().describe(BROWSER_ARG_DESC),
      },
    },
    async ({ browser }) => {
      const r = resolveBrowserData(browser);
      if (r.error) return r.error;
      const state = r.data.organizeState;
      if (!state) {
        return { content: [{ type: 'text', text: JSON.stringify({
          error: { code: 'ORGANIZE_STATE_NOT_READY', message: 'No auto-organize state cached. Call auto_organize_bookmarks first.' },
        }) }], isError: true };
      }
      const dupScan = r.data.lastDuplicateScan;
      if (!dupScan || !Array.isArray(dupScan.duplicateSets) || dupScan.duplicateSets.length === 0) {
        return { content: [{ type: 'text', text: JSON.stringify({
          browser:        r.data.browserBrand,
          browserId:      r.data.browserId,
          convergedSets:  [],
          divergedSets:   [],
          residueSets:    [],
          summary:        { totalSets: 0, converged: 0, diverged: 0, residue: 0, missing: 0, deletableCount: 0, divergedInstanceCount: 0 },
          next_steps:     'No cached duplicate scan. If Step 2 dedup was skipped or scope changed, this is expected — proceed to complete_organize_sort.',
        }) }] };
      }

      // Build a Map<nodeId, parentId> by walking the cached bookmarks tree once.
      // Also Map<nodeId, currentParentTitle> so diverged instances can be
      // labeled with the user's current folder name (helps the polish-menu UX).
      const idToParent = new Map();
      const idToParentTitle = new Map();
      function indexBookmarks(node, parentId, parentTitle) {
        if (!node) return;
        if (node.id) {
          idToParent.set(String(node.id), parentId);
          idToParentTitle.set(String(node.id), parentTitle);
        }
        if (Array.isArray(node.children)) {
          for (const c of node.children) {
            indexBookmarks(c, node.id ? String(node.id) : parentId, String(node.title || parentTitle || ''));
          }
        }
      }
      const roots = r.data.bookmarks || [];
      for (const root of roots) indexBookmarks(root, null, '');

      // Build a Map<bucketFolderId, {bucketTitle, isReview}> from organizeState.
      const buckets = Array.isArray(state.buckets) ? state.buckets : [];
      const bucketByFolderId = new Map();
      function indexBuckets(arr) {
        for (const b of arr) {
          if (!b) continue;
          if (b.bookmarkFolderId) {
            bucketByFolderId.set(String(b.bookmarkFolderId), {
              bucketId:    b.id,
              bucketTitle: b.title,
              isReview:    !!b.isReview,
            });
          }
          if (Array.isArray(b.children)) indexBuckets(b.children);
        }
      }
      indexBuckets(buckets);

      const convergedSets = [];
      const divergedSets  = [];
      const residueSets   = [];
      let missing = 0;
      let deletableCount = 0;
      let divergedInstanceCount = 0;

      for (const set of dupScan.duplicateSets) {
        const nodeIds = Array.isArray(set.nodeIds) ? set.nodeIds : [];
        const parentPaths = Array.isArray(set.parentPaths) ? set.parentPaths : [];
        const sampleTitle = (Array.isArray(set.sampleTitles) && set.sampleTitles[0]) || '';

        // Resolve current locations; skip instances that no longer exist.
        const surviving = [];
        for (let i = 0; i < nodeIds.length; i++) {
          const nodeId = String(nodeIds[i]);
          if (!idToParent.has(nodeId)) {
            missing++;
            continue;
          }
          const currentParentId = idToParent.get(nodeId);
          const bucketInfo = currentParentId
            ? bucketByFolderId.get(String(currentParentId)) || null
            : null;
          surviving.push({
            nodeId,
            currentParentId,
            currentParentTitle:    idToParentTitle.get(nodeId) || '',
            currentBucketFolderId: bucketInfo ? currentParentId : null,
            currentBucketTitle:    bucketInfo ? bucketInfo.bucketTitle : null,
            isReview:              bucketInfo ? bucketInfo.isReview : false,
            originalParentPath:    parentPaths[i] || '',
            isInBucket:            !!bucketInfo,
          });
        }

        // If only one instance survives, this set is no longer a duplicate. Skip.
        if (surviving.length < 2) continue;

        // Classify: collect distinct destinations. "destination" =
        //   if in bucket → bucket folder id
        //   else → '__residue__::' + currentParentId (residue parents are
        //          distinct destinations from each other for the diverged check)
        const destinations = new Set();
        let allInBucket = true;
        for (const inst of surviving) {
          if (inst.isInBucket) {
            destinations.add('bucket::' + inst.currentBucketFolderId);
          } else {
            allInBucket = false;
            destinations.add('residue::' + (inst.currentParentId || 'unknown'));
          }
        }

        if (allInBucket && destinations.size === 1) {
          // Converged: all surviving instances in the same bucket. Keep first; delete rest.
          const keepNodeId = surviving[0].nodeId;
          const deleteNodeIds = surviving.slice(1).map(s => s.nodeId);
          deletableCount += deleteNodeIds.length;
          const first = surviving[0];
          convergedSets.push({
            url:                 set.url,
            bucketFolderId:      first.currentParentId,
            bucketTitle:         first.currentBucketTitle,
            isReview:            first.isReview,
            keepNodeId,
            deleteNodeIds,
            sampleTitle,
            originalParentPaths: surviving.map(s => s.originalParentPath),
          });
        } else if (!allInBucket && destinations.size === 1) {
          // All in residue, all under the same parent. Treat as residue.
          residueSets.push({
            url:        set.url,
            sampleTitle,
            instances:  surviving.map(s => ({
              nodeId:             s.nodeId,
              currentParentId:    s.currentParentId,
              currentParentTitle: s.currentParentTitle,
              originalParentPath: s.originalParentPath,
            })),
          });
        } else if (!allInBucket && destinations.size > 1
                   && [...destinations].every(d => d.startsWith('residue::'))) {
          // All in residue but in different residue parents — still residue
          // semantically (none sorted), agent leaves alone.
          residueSets.push({
            url:        set.url,
            sampleTitle,
            instances:  surviving.map(s => ({
              nodeId:             s.nodeId,
              currentParentId:    s.currentParentId,
              currentParentTitle: s.currentParentTitle,
              originalParentPath: s.originalParentPath,
            })),
          });
        } else {
          // Diverged: mix of buckets, or bucket + residue.
          divergedInstanceCount += surviving.length;
          divergedSets.push({
            url:        set.url,
            sampleTitle,
            instances:  surviving.map(s => ({
              nodeId:                s.nodeId,
              currentParentId:       s.currentParentId,
              currentParentTitle:    s.currentParentTitle,
              currentBucketFolderId: s.isInBucket ? s.currentParentId : null,
              currentBucketTitle:    s.currentBucketTitle,
              isReview:              s.isReview,
              originalParentPath:    s.originalParentPath,
            })),
          });
        }
      }

      const totalSets = convergedSets.length + divergedSets.length + residueSets.length;
      const nextSteps = totalSets === 0
        ? 'No duplicate sets needed reconciling. Proceed to complete_organize_sort.'
        : (convergedSets.length > 0
            ? `Converged: issue ONE bulk_apply with ${deletableCount} delete_node ops ({confirmedByUser:true}, scope:'bookmarks'} per Step 2 pre-consent). Then surface ${divergedSets.length} diverged set(s) to the user in the Step 12 polish menu. Residue sets (${residueSets.length}) require no action — leave them.`
            : `No converged duplicates to auto-delete. Surface ${divergedSets.length} diverged set(s) to the user in the Step 12 polish menu. Residue sets (${residueSets.length}) require no action.`);

      return { content: [{ type: 'text', text: JSON.stringify({
        browser:        r.data.browserBrand,
        browserId:      r.data.browserId,
        scope:          dupScan.scope,
        libraryId:      dupScan.libraryId,
        convergedSets,
        divergedSets,
        residueSets,
        summary: {
          totalSets,
          converged:             convergedSets.length,
          diverged:              divergedSets.length,
          residue:               residueSets.length,
          missing,
          deletableCount,
          divergedInstanceCount,
        },
        next_steps:     nextSteps,
      }) }] };
    }
  );

  srv.registerTool(
    'complete_organize_sort',
    {
      description: 'Auto-organize bookmarks: transition the workflow from sorting (Steps 6-9) into the polish phase (Step 10). Call this AFTER you have completed the LLM batch sort loop (Step 7) and the outlier-pull refinement pass (Step 8 via refine_folder_outliers across all populated buckets). The popup\'s auto-organize panel switches from the read-only sorting view to the editable polish view where the user can add / rename / drag / delete-empty buckets while you drive the polish menu in chat.\n\n' +
        'Workflow gating: state.workflowStep must be \'sorting\' (the agent has been actively sifting) or \'paused\' (user halted mid-sift; agent finished after Resume). Other states return ORGANIZE_STATE_NOT_READY.\n\n' +
        'Delivery model: the bridge writes a pending-command record to the extension\'s chrome.storage.local (mirrors auto_organize_bookmarks from S2b). The popup picks it up live via chrome.storage.onChanged and transitions to polish state. Fire-and-forget — the tool returns a delivery receipt, not a guarantee that the user has seen the transition. Within ~200ms typically.\n\n' +
        'After calling this, immediately call summarize_organize_results for the post-sort summary, then present the polish menu options to the user in chat: review the Review folder, suggest sub-folders for a high-count bucket, add corrections, or done.',
      inputSchema: {
        summary: z.string().max(500).optional().describe('Optional one-line agent-side summary of what was sorted. Forwarded to the popup for future UI polish (not displayed in v1).'),
        browser: z.string().optional().describe(BROWSER_ARG_DESC),
      },
    },
    async ({ summary, browser }) => {
      const r = resolveBrowserData(browser);
      if (r.error) return r.error;
      const state = r.data.organizeState;
      if (!state) {
        return { content: [{ type: 'text', text: JSON.stringify({
          error: { code: 'ORGANIZE_STATE_NOT_READY', message: 'No auto-organize state cached. Call auto_organize_bookmarks first.' },
        }) }], isError: true };
      }
      if (state.workflowStep !== 'sorting' && state.workflowStep !== 'paused') {
        return { content: [{ type: 'text', text: JSON.stringify({
          error: { code: 'ORGANIZE_STATE_NOT_READY', message: `Workflow is in step '${state.workflowStep}'. complete_organize_sort only valid from 'sorting' or 'paused'.` },
          workflowStep: state.workflowStep,
        }) }], isError: true };
      }
      const requestId = randomBytes(8).toString('hex');
      const ok = nmWrite({
        type:      'enqueueAgentCommand',
        command:   'transitionToPolish',
        browserId: r.data.browserId,
        summary:   typeof summary === 'string' ? summary : null,
        requestId,
        sentAt:    Date.now(),
      });
      return { content: [{ type: 'text', text: JSON.stringify({
        ok,
        browser:    r.data.browserBrand,
        browserId:  r.data.browserId,
        deliveryChannel: 'storage-local',
        requestId,
        note: ok
          ? 'Transition command sent. The popup will switch to polish state within a few hundred ms. Next: call summarize_organize_results and present the polish menu to the user.'
          : 'Bridge could not send the command (extension may be disconnected). Tell the user to open the Pinako popup, then retry.',
        updatedAt: r.data.updatedAt,
      }) }] };
    }
  );

  srv.registerTool(
    'propose_subcategories',
    {
      description: 'Step 12 polish-menu sub-folder proposal. Scopes domain-frequency + path-token analysis to a single bucket folder\'s contents and proposes sub-category names. Use this when the polish menu surfaces a high-count bucket (subFolderCandidates from summarize_organize_results) and the user accepts the "Suggest sub-folders for [bucket]" option.\n\n' +
        'Heuristic rules are NOT applied — the folder is already homogeneous by category (the parent bucket is its semantic group), so domain rules would just re-label everything as the parent\'s category. Pure pattern emergence: count domain frequencies + path-token frequencies within the folder, propose names for the dominant clusters.\n\n' +
        'Response shape: {folder:{title, bookmarkFolderId, totalItems}, suggestions:[{target, domain?, pattern?, count, basis:"domain-frequency"|"path-token", sampleTitles}], min_match_count_used, hint}.\n\n' +
        'After the user accepts: create the sub-folders via create_folder({scope:\'bookmarks\', parentId:folder_id, title:<suggested>}), then move items into them via bulk_apply move_node. Or call propose_subcategories again on one of the new sub-folders if the user wants deeper nesting (recursion depth bounded to 3 per the design spec — track this client-side).',
      inputSchema: {
        folder_id:       z.string().describe('The chrome.bookmarks folder id to scope sub-category analysis to.'),
        min_match_count: z.number().int().min(1).max(10000).optional().describe('Minimum residue items for a sub-category suggestion. Default 3 (much lower than propose_categories\'s default of 100 since sub-folders are smaller scope). Bump to 5-10 to filter noise on larger folders.'),
        max_suggestions: z.number().int().min(1).max(20).optional().describe('Maximum number of sub-category suggestions. Default 10.'),
        browser:         z.string().optional().describe(BROWSER_ARG_DESC),
      },
    },
    async ({ folder_id, min_match_count, max_suggestions, browser }) => {
      const r = resolveBrowserData(browser);
      if (r.error) return r.error;
      const folder = _findBookmarkFolderByChromeId(r.data.bookmarks || [], folder_id);
      if (!folder) {
        return { content: [{ type: 'text', text: JSON.stringify({
          error: { code: 'FOLDER_NOT_FOUND', message: `Bookmark folder ${folder_id} not found in this browser's cached bookmark tree.` },
        }) }], isError: true };
      }
      // Flatten URL leaves under the folder.
      const items = [];
      function walk(n) {
        if (!n) return;
        if (n.url) items.push(n);
        if (Array.isArray(n.children)) n.children.forEach(walk);
      }
      for (const c of (folder.children || [])) walk(c);

      const minCount = Number.isFinite(min_match_count) && min_match_count > 0 ? min_match_count : 3;
      const maxSugg  = Number.isFinite(max_suggestions) && max_suggestions > 0 ? max_suggestions : 10;
      const suggestions = _proposeCategoriesFromResidue(items, {
        minMatchCount: minCount,
        maxSuggestions: maxSugg,
      });

      return { content: [{ type: 'text', text: JSON.stringify({
        browser:    r.data.browserBrand,
        browserId:  r.data.browserId,
        folder: {
          title:            folder.title,
          bookmarkFolderId: folder_id,
          totalItems:       items.length,
        },
        suggestions,
        min_match_count_used: minCount,
        hint: 'After user accepts: create each sub-folder via create_folder({scope:\'bookmarks\', parentId:folder_id, title:suggestion.target}), then bulk_apply move_node ops to relocate matching items. For pattern-based suggestions, use the pattern hint to decide which items qualify. Stop at depth 3 to avoid runaway nesting.',
        updatedAt:  r.data.updatedAt,
      }) }] };
    }
  );

  srv.registerTool(
    'get_organize_state',
    {
      description: 'Reads the current auto-organize workflow state from the Pinako popup. Use this after calling auto_organize_bookmarks to learn when the user has finished Step 3+4 setup (workflowStep === \'sorting\') so you can begin the heuristic broad-sweep + LLM sift loop. Also use this between batches during sorting to detect when the user has clicked Pause (workflowStep === \'paused\') so you can halt gracefully at a safe boundary.\n\n' +
        'Response shape: { workflowStep: \'idle\'|\'step-3\'|\'step-4\'|\'sorting\'|\'paused\'|\'polish\', scope, buckets:[{id, title, bookmarkFolderId, isSuggestion, isExisting, children}], reviewBucket, duplicateContext, confirmedAt, pushedAt }.\n\n' +
        '- workflowStep=\'idle\': panel is closed (or has never been opened).\n' +
        '- workflowStep=\'step-3\'|\'step-4\': user is still editing the bucket structure. Wait + ask the user to confirm in the popup before proceeding.\n' +
        '- workflowStep=\'sorting\': user has confirmed. Begin apply_heuristic_organize + the LLM sift loop.\n' +
        '- workflowStep=\'paused\': user clicked Pause. Stop the sift loop at the next safe boundary, summarize progress, and tell the user you\'re halted. They will click Reset (returns to step-3) or Resume (returns to sorting) in the popup.\n' +
        '- workflowStep=\'polish\': sift has finished and complete_organize_sort has been called. The user can edit folders; the agent presents the polish menu.\n\n' +
        'Each bucket\'s `bookmarkFolderId` is the chrome.bookmarks folder id where the agent should move items via move_node / bulk_apply. Use this as the targetId when bulk-moving matched items into a category.\n\n' +
        'duplicateContext (Slice S2f, 2026-05-14): if find_duplicates was called for this scope, this field summarizes the cached scan: {setCount, totalInstances, scannedAt, scope, libraryId, scopeMatchesWorkflow}. When scopeMatchesWorkflow is true, the cached duplicate sets (with parentPaths) are usable as semantic signal during the LLM sift (Step 8) and reconcilable post-sift via resolve_duplicate_landings (Step 10). If null, no recent dedup scan exists for the active scope — call find_duplicates first if Step 2 of LARGE TREE ORGANIZATION applies.',
      inputSchema: {
        browser: z.string().optional().describe(BROWSER_ARG_DESC),
      },
    },
    async ({ browser }) => {
      const r = resolveBrowserData(browser);
      if (r.error) return r.error;
      const state = r.data.organizeState || null;
      // S2d Phase 2: identify the Review bucket so the agent has a clear
      // destination for low-confidence sift items. The popup auto-creates a
      // `Review` system bucket at sorting kickoff; it's marked isReview:true
      // in the buckets array.
      const reviewBucket = state && Array.isArray(state.buckets)
        ? state.buckets.find(b => b && b.isReview)
        : null;

      // Slice S2f (2026-05-14): summarize the cached duplicate scan if present.
      // scopeMatchesWorkflow tells the agent whether the cached scan covers
      // the active auto-organize scope (true → parentPaths are usable as
      // Step 7 sift signal AND reconcilable via resolve_duplicate_landings).
      const dupScan = r.data.lastDuplicateScan || null;
      let duplicateContext = null;
      if (dupScan) {
        const workflowScope    = state ? state.scope     : null;
        const workflowLibrary  = state ? state.libraryId : null;
        const scopeMatchesWorkflow = !!state
          && dupScan.scope === workflowScope
          && (dupScan.libraryId || null) === (workflowLibrary || null);
        duplicateContext = {
          setCount:             dupScan.uniqueDuplicateUrls,
          totalInstances:       dupScan.totalDuplicateInstances,
          scannedAt:            dupScan.scannedAt,
          scope:                dupScan.scope,
          libraryId:            dupScan.libraryId,
          scopeMatchesWorkflow,
        };
      }

      return { content: [{ type: 'text', text: JSON.stringify({
        browser:           r.data.browserBrand,
        browserId:         r.data.browserId,
        workflowStep:      state ? state.workflowStep      : 'idle',
        scope:             state ? state.scope             : null,
        libraryId:         state ? state.libraryId         : null,
        includeOtherRoots: state ? !!state.includeOtherRoots : false,
        buckets:           state ? state.buckets           : [],
        reviewBucket:      reviewBucket
          ? { title: reviewBucket.title, bookmarkFolderId: reviewBucket.bookmarkFolderId }
          : null,
        duplicateContext,
        confirmedAt:       state ? state.confirmedAt       : null,
        pushedAt:           state ? state.pushedAt         : null,
        note:         state
          ? (state.includeOtherRoots
              ? 'Scope is expanded: includes Bookmarks Bar + Other Bookmarks + Mobile Bookmarks. Sift loop should categorize items from all roots into the user\'s confirmed buckets. For items with confidence < 0.7 during the sift loop, route to reviewBucket.bookmarkFolderId instead of force-placing in a category.'
              : 'Scope is limited to Bookmarks Bar (default). Other Bookmarks + Mobile Bookmarks are excluded — sift loop should skip items whose parentId traces back to those roots. For items with confidence < 0.7 during the sift loop, route to reviewBucket.bookmarkFolderId instead of force-placing in a category.')
          : 'No workflow state cached yet. Call auto_organize_bookmarks first; the popup will push state when the user advances Step 4.',
      }) }] };
    }
  );

  srv.registerTool(
    'record_observation',
    {
      description: 'Records a pattern observation during the auto-organize LLM sift loop (Step 7). Use this when you notice a cross-batch pattern that influences how you should categorize subsequent batches — e.g. "many cooking blogs without a clear domain pattern landing in the residue", "most arxiv.org links are physics not CS", "TikTok URLs are showing up despite no Social bucket". The bridge keeps a per-session log per browser; get_observations digests it for inclusion in your next batch prompt.\n\n' +
        'Per-session log clears automatically when the workflow ends (workflowStep → \'idle\'). Cap of ' + MAX_OBSERVATIONS_PER_SESSION + ' observations per session — beyond that, oldest entries are evicted FIFO.\n\n' +
        'Best practice: keep pattern strings short (under 200 chars), include 2-3 examples (titles or URLs), and reference the batch number when known. The agent loops over batches; the observation log is your cross-batch memory.',
      inputSchema: {
        pattern:    z.string().min(1).max(500).describe('The observed pattern (e.g., "Cooking blogs landing in residue without a Recipes-style domain", "X.com URLs splitting between users and posts").'),
        count:      z.number().int().min(1).max(100000).optional().describe('Estimated count of items matching this pattern in the current batch. Optional.'),
        examples:   z.array(z.string()).max(5).optional().describe('Up to 5 illustrative titles or URLs. Optional.'),
        batch_n:    z.number().int().min(0).optional().describe('Which sift batch this observation came from (0-indexed). Optional but helpful for cross-batch tracking.'),
        browser:    z.string().optional().describe(BROWSER_ARG_DESC),
      },
    },
    async ({ pattern, count, examples, batch_n, browser }) => {
      const r = resolveBrowserData(browser);
      if (r.error) return r.error;
      const browserId = r.data.browserId;
      let log_ = _organizeObservationLog.get(browserId);
      if (!log_) {
        log_ = [];
        _organizeObservationLog.set(browserId, log_);
      }
      log_.push({
        pattern,
        count:      Number.isFinite(count) ? count : null,
        examples:   Array.isArray(examples) ? examples.slice(0, 5).map(s => String(s)) : [],
        batch_n:    Number.isFinite(batch_n) ? batch_n : null,
        recordedAt: Date.now(),
      });
      // FIFO evict if over cap.
      while (log_.length > MAX_OBSERVATIONS_PER_SESSION) log_.shift();
      return { content: [{ type: 'text', text: JSON.stringify({
        ok:                true,
        browser:           r.data.browserBrand,
        browserId,
        session_count:     log_.length,
        cap:               MAX_OBSERVATIONS_PER_SESSION,
      }) }] };
    }
  );

  srv.registerTool(
    'get_observations',
    {
      description: 'Returns the auto-organize sift-loop observation log for the current session. Use this between batches to inject prior observations into the next batch prompt — the agent\'s cross-batch memory. Empty when no observations have been recorded (or when the workflow just transitioned to \'idle\' and the log was cleared).\n\n' +
        'Response shape: {observations: [{pattern, count, examples, batch_n, recordedAt}], total, cap}. Observations are returned in insertion order (oldest first). For prompts, consider summarizing into 1-2 sentences per observation; the raw log can be hundreds of tokens at the cap of ' + MAX_OBSERVATIONS_PER_SESSION + '.',
      inputSchema: {
        filter_pattern: z.string().optional().describe('Optional case-insensitive substring filter on the pattern field. Returns only matching observations.'),
        batch_n_min:    z.number().int().min(0).optional().describe('Optional lower bound (inclusive) on batch_n. Useful for "show me observations since batch N".'),
        browser:        z.string().optional().describe(BROWSER_ARG_DESC),
      },
    },
    async ({ filter_pattern, batch_n_min, browser }) => {
      const r = resolveBrowserData(browser);
      if (r.error) return r.error;
      const log_ = _organizeObservationLog.get(r.data.browserId) || [];
      let observations = log_;
      if (filter_pattern && typeof filter_pattern === 'string') {
        const flc = filter_pattern.toLowerCase();
        observations = observations.filter(o => o.pattern.toLowerCase().includes(flc));
      }
      if (Number.isFinite(batch_n_min)) {
        observations = observations.filter(o => Number.isFinite(o.batch_n) && o.batch_n >= batch_n_min);
      }
      return { content: [{ type: 'text', text: JSON.stringify({
        browser:       r.data.browserBrand,
        browserId:     r.data.browserId,
        observations,
        total:         observations.length,
        session_total: log_.length,
        cap:           MAX_OBSERVATIONS_PER_SESSION,
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

  // ═══ MCP resources (Slice Y bonus, 2026-05-12) ════════════════════════════
  // Five fixed-URI resources mirror the five cache slices. Each one exposes
  // the same data as the corresponding read tool, just via the MCP resource
  // protocol. The point isn't access (clients can already read via tools);
  // the point is enabling subscriptions: when a client subscribes to a
  // resource URI, the server emits notifications/resources/updated whenever
  // that resource's content changes. Cache-mutation paths
  // (handleNmMessage + /update HTTP) call broadcastResourceUpdated() with
  // the list of fields that were present in the incoming push.
  //
  // Multi-browser caveat: these resource URIs don't carry a browser parameter.
  // If multiple browsers are connected, resources/read returns an ambiguity
  // error (same shape as the corresponding tool). The tools support a
  // `browser` argument for that case. ResourceTemplate-based per-browser
  // URIs are a future refinement when client adoption of resource
  // subscriptions matures (Claude Desktop doesn't subscribe yet as of
  // 2026-05-12; MCP Inspector does).
  const _resourceJsonContents = (uri, payload) => ({
    contents: [{
      uri: uri.toString(),
      mimeType: 'application/json',
      text: JSON.stringify(payload),
    }],
  });

  srv.registerResource(
    'tree',
    RESOURCE_URIS.tree,
    {
      title:       'Pinako tab tree',
      description: 'Current tab tree (Windows → Groups → Tabs) for the connected Pinako browser. Subscribe to receive notifications/resources/updated when the tree mutates. For multi-browser scenarios, use the get_tree tool with a browser argument.',
      mimeType:    'application/json',
    },
    async (uri) => {
      const r = resolveBrowserData();
      if (r.error) return _resourceJsonContents(uri, { error: r.error.content?.[0]?.text || 'unavailable' });
      return _resourceJsonContents(uri, {
        browser:   r.data.browserBrand,
        browserId: r.data.browserId,
        tree:      r.data.tree || [],
        updatedAt: r.data.updatedAt,
      });
    }
  );

  srv.registerResource(
    'libraries',
    RESOURCE_URIS.libraries,
    {
      title:       'Pinako libraries',
      description: 'Current list of Pinako libraries with metadata (id, title, description, tabCount, note metadata) PLUS library panel structure (groups, panel_order) — same shape as list_libraries. Subscribe to receive notifications/resources/updated when libraries OR panel structure mutate.',
      mimeType:    'application/json',
    },
    async (uri) => {
      const r = resolveBrowserData();
      if (r.error) return _resourceJsonContents(uri, { error: r.error.content?.[0]?.text || 'unavailable' });
      // Slice Z (2026-05-12, Option A folded): include groups + panel_order
      // here so resource subscribers see the same shape list_libraries
      // returns. Since pinako://libraries notification now fires for
      // libraryGroups / libraryPanelOrder mutations too, the resource read
      // must surface those fields or subscribers can't act on the signal.
      const groups = (r.data.libraryGroups || []).map(g => ({
        id:          g.id,
        title:       g.title,
        description: g.description || '',
        library_ids: g.libraryIds || [],
      }));
      return _resourceJsonContents(uri, {
        browser:     r.data.browserBrand,
        libraries:   r.data.libraries || [],
        groups,
        panel_order: r.data.libraryPanelOrder || [],
        updatedAt:   r.data.updatedAt,
      });
    }
  );

  srv.registerResource(
    'mainTreeNotes',
    RESOURCE_URIS.mainTreeNotes,
    {
      title:       'Pinako main tree notes',
      description: 'Rich-text notes attached to the user\'s main tree (as opposed to library notes or per-tab memos). Cloud-synced across the user\'s browsers. Subscribe to receive notifications/resources/updated when main tree notes mutate. (Legacy codebase name: "global notes".)',
      mimeType:    'application/json',
    },
    async (uri) => {
      const r = resolveBrowserData();
      if (r.error) return _resourceJsonContents(uri, { error: r.error.content?.[0]?.text || 'unavailable' });
      return _resourceJsonContents(uri, {
        browser:       r.data.browserBrand,
        mainTreeNotes: r.data.globalNotes || [],
        updatedAt:     r.data.updatedAt,
      });
    }
  );

  srv.registerResource(
    'bookmarks',
    RESOURCE_URIS.bookmarks,
    {
      title:       'Chrome bookmarks',
      description: 'User\'s Chrome bookmark tree as cached by the bridge. Subscribe to receive notifications/resources/updated when bookmarks mutate.',
      mimeType:    'application/json',
    },
    async (uri) => {
      const r = resolveBrowserData();
      if (r.error) return _resourceJsonContents(uri, { error: r.error.content?.[0]?.text || 'unavailable' });
      return _resourceJsonContents(uri, {
        browser:   r.data.browserBrand,
        bookmarks: r.data.bookmarks || [],
        updatedAt: r.data.updatedAt,
      });
    }
  );

  srv.registerResource(
    'docs',
    RESOURCE_URIS.docs,
    {
      title:       'Pinako user guide sections',
      description: 'Cached user-guide sections (titles, anchors, text) searchable via the search_docs tool. Subscribe to receive notifications/resources/updated when the bundled guide changes (typically only on extension updates).',
      mimeType:    'application/json',
    },
    async (uri) => {
      const r = resolveBrowserData();
      if (r.error) return _resourceJsonContents(uri, { error: r.error.content?.[0]?.text || 'unavailable' });
      return _resourceJsonContents(uri, {
        browser: r.data.browserBrand,
        docs:    r.data.docs || [],
        updatedAt: r.data.updatedAt,
      });
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
  const SCOPE_NOTES = "Required: 'library-notes' (notes attached to a specific library; libraryId required) or 'main-tree-notes' (notes attached to the main tree). NOTE: when wrapped in bulk_apply, you must set scope on EACH sub-op individually — bulk's outer scope is NOT inherited by create_note / set_note_content sub-ops because their schemas accept two scopes.";
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
    description: 'Sets the memo (short plain-text annotation, max 2500 chars) on a node. Pass empty string to clear. Memos are per-node and concise; for richer rich-text documents use create_note / set_note_content (which target a library or the main tree notes, not individual nodes). The memo content field is named "text" in this tool; "memo" is also accepted as an alias for resilience (if both are present, "text" wins).',
    inputSchema: {
      nodeId:    z.string().describe('Target node id.'),
      text:      z.string().describe('Memo text (max 2500 chars). Empty string clears the memo. Alias: "memo".'),
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
    description: 'Creates a new note in a library or in the main tree notes. Use this when the user says "create a note about X", "save these findings as a new note", etc. For UPDATING an existing note, use set_note_content. Returns createdNoteId. Char limit is tier-gated. Note content is sanitized at write time (HTML allowlist; <script>, on* event handlers, javascript: URLs are stripped) — write valid Tiptap-compatible HTML or plain text. NOT IDEMPOTENT: each call creates a new note. On transient failures, DO NOT auto-retry — call get_library or get_main_tree_notes to check whether the previous attempt succeeded before retrying.',
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
    description: 'Reorders the cards in the library panel (standalone library cards + library group cards). Pass the COMPLETE current list of entries in the desired order. Each entry is {type:"library"|"group", id:<id>}. ORDER ONLY — every existing entry must be present (rejects with PANEL_ORDER_MISMATCH if count differs, PANEL_ORDER_UNKNOWN_ENTRY if an unknown id is introduced). Use create_library / delete_library_group / etc. to change membership; this op cannot add or remove cards. Always call list_libraries first to fetch the current panel_order array — never construct the entries array blindly; group ids and panel positions must come from a fresh list_libraries call (the panel_order field in its response maps 1:1 to this op\'s entries arg). Max 200 entries.',
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
    description: 'Atomically applies up to 100 sub-ops as a SINGLE undoable unit. Use for multi-step reorganizations ("move these 12 tabs into a new library called Research") so the user can undo the whole thing in one click. SUB-OP SCOPE INHERITANCE: sub-ops without explicit scope/libraryId inherit the bulk\'s; explicitly setting a different value is rejected (BULK_SCOPE_MISMATCH / BULK_LIBRARY_MISMATCH). EXCEPTION for create_note and set_note_content: their schemas accept two valid scopes (library-notes, main-tree-notes), so EVERY sub-op of those types must include its own explicit scope field — bulk\'s outer scope is NOT auto-filled in. NESTING: bulk_apply cannot contain another bulk_apply. PER-SUB-OP CONFIRMATION: each destructive sub-op (delete_node, delete_live_node, delete_library_group with cascadeMembers:true) requires its OWN confirmedByUser:true field — the bulk_apply wrapper does NOT confer confirmation to sub-ops; obtain user approval for each destructive action individually. ERROR LOCATION: on failure, error.context.subOpIndex (and a "Sub-op N:" prefix in the message) identifies the failing sub-op — correct and resubmit just that one in a new bulk_apply, or fix and resubmit the whole batch.',
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
// Slice Y bonus (2026-05-12): parallel map of McpServer instances so the
// cache-mutation paths can broadcast notifications/resources/updated to
// every connected client. Populated alongside activeSessions in the
// onsessioninitialized callback; cleaned up in transport.onclose.
const activeServers = new Map();  // sessionId → McpServer

// Resource URI scheme. Five fixed URIs mirror the five cache slices the
// bridge tracks. Clients can subscribe to any subset; notifications fire
// only for the resources whose data actually changed (based on which
// fields were present in the incoming push).
const RESOURCE_URIS = {
  tree:          'pinako://tree',
  libraries:     'pinako://libraries',
  mainTreeNotes: 'pinako://mainTreeNotes',
  bookmarks:     'pinako://bookmarks',
  docs:          'pinako://docs',
};

function broadcastResourceUpdated(fields) {
  if (!Array.isArray(fields) || fields.length === 0) return;
  if (activeServers.size === 0) return;
  for (const field of fields) {
    const uri = RESOURCE_URIS[field];
    if (!uri) continue;
    for (const srv of activeServers.values()) {
      try {
        // sendResourceUpdated returns a Promise; swallow errors so a
        // disconnected client's send failure doesn't break the broadcast
        // to other clients.
        srv.server.sendResourceUpdated({ uri }).catch(() => {});
      } catch (_) {}
    }
  }
}

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
          // payload omits the field.
          // 2026-05-12 Slice Y bookmark expansion: same pattern extended to
          // tree/libraries/globalNotes/bookmarks. SW-side bookmark-only
          // pushes (forwarder forwards them via /update too) send ONLY
          // bookmarks in data; preserve cached tree/libraries/globalNotes
          // when those fields are absent. Symmetric with the NM path so
          // forwarder browsers get the same cache freshness guarantees as
          // the leader's local browser.
          const priorCache = cachedData.get(id);
          const docsField = (data && 'docs' in data)
            ? (data.docs || [])
            : (priorCache?.docs || []);
          const treeField = (data && 'tree' in data)
            ? (data.tree || [])
            : (priorCache?.tree || []);
          const librariesField = (data && 'libraries' in data)
            ? (data.libraries || [])
            : (priorCache?.libraries || []);
          const globalNotesField = (data && 'globalNotes' in data)
            ? (data.globalNotes || [])
            : (priorCache?.globalNotes || []);
          const bookmarksField = (data && 'bookmarks' in data)
            ? (data.bookmarks || [])
            : (priorCache?.bookmarks || []);
          // Slice Z (2026-05-12): mirror the NM path's preserve-when-omitted
          // for library panel structure.
          const libraryGroupsField = (data && 'libraryGroups' in data)
            ? (data.libraryGroups || [])
            : (priorCache?.libraryGroups || []);
          const libraryPanelOrderField = (data && 'libraryPanelOrder' in data)
            ? (data.libraryPanelOrder || [])
            : (priorCache?.libraryPanelOrder || []);
          cachedData.set(id, {
            tree:              treeField,
            libraries:         librariesField,
            globalNotes:       globalNotesField,
            bookmarks:         bookmarksField,
            docs:              docsField,
            libraryGroups:     libraryGroupsField,
            libraryPanelOrder: libraryPanelOrderField,
            updatedAt:      Date.now(),
            browserId:      id,
            browserBrand:   brand,
            userTier:       tier,
            userId:         uid,
            forwarderToken: fwToken,
          });
          // Slice Y bonus: broadcast resource-updated notifications for
          // fields that were present in this /update push (parallel to
          // the NM path's broadcast in handleNmMessage).
          //
          // Slice Z (2026-05-12, Option A folded): libraryGroups /
          // libraryPanelOrder fold into pinako://libraries notification.
          {
            const updatedFields = [];
            if (data && 'tree'        in data) updatedFields.push('tree');
            const librariesPresent = data && (
              'libraries'         in data ||
              'libraryGroups'     in data ||
              'libraryPanelOrder' in data
            );
            if (librariesPresent) updatedFields.push('libraries');
            if (data && 'globalNotes' in data) updatedFields.push('mainTreeNotes');
            if (data && 'bookmarks'   in data) updatedFields.push('bookmarks');
            if (data && 'docs'        in data) updatedFields.push('docs');
            if (updatedFields.length > 0) broadcastResourceUpdated(updatedFields);
          }
          // Same diagnostic line as the NM path so we can tell at a glance
          // whether docs were preserved or overwritten.
          try {
            const incomingDocs = Array.isArray(data?.docs) ? data.docs.length : '<absent>';
            const grpLen = Array.isArray(data?.libraryGroups) ? data.libraryGroups.length : '<absent>';
            const panelLen = Array.isArray(data?.libraryPanelOrder) ? data.libraryPanelOrder.length : '<absent>';
            log(`/update from ${brand}: incoming docs=${incomingDocs} → stored docs=${docsField.length} windows=${data?.tree?.length || 0} groups=${grpLen} panel=${panelLen}`);
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
          const srv = createMcpServer();
          transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (id) => {
              activeSessions.set(id, transport);
              // Slice Y bonus: register the server so broadcastResourceUpdated
              // can reach it on subsequent cache mutations.
              activeServers.set(id, srv);
              log(`MCP session created: ${id}`);
            },
            enableJsonResponse: true,
          });
          transport.onclose = () => {
            const id = [...activeSessions.entries()].find(([, t]) => t === transport)?.[0];
            if (id) {
              activeSessions.delete(id);
              activeServers.delete(id);
              log(`MCP session closed: ${id}`);
            }
          };
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
  let remote   = new StreamableHTTPClientTransport(new URL(httpUrl));

  // Slice W-4 (refined): we need to replay `initialize` on re-handshake
  // because the new bridge has an empty activeSessions Map and rejects
  // any tools/call without a valid session. The SDK's
  // StreamableHTTPClientTransport doesn't synthesize initialize on its
  // own — it just forwards whatever message we hand it. So we cache the
  // initialize request as it flows through from Claude Desktop on first
  // connect, and replay it before retrying the original failing message.
  // The initialize-replay response is intercepted so Claude Desktop
  // doesn't see a duplicate handshake completion.
  let cachedInitialize = null;   // the original {jsonrpc:'2.0',id:N,method:'initialize',params:...}
  let cachedInitNotif  = null;   // the optional {jsonrpc:'2.0',method:'notifications/initialized'} (no id)
  let suppressInitReplayId = null;  // id of an in-flight replay; intercept its response
  let reHandshakeInFlight = null;   // mutex so concurrent failing requests don't double-recreate the transport

  // remote → stdio (forward responses back to Claude Desktop). Defined as
  // a function so we can rebind onto a freshly-created transport after a
  // stale-session re-handshake.
  function wireRemoteListeners() {
    remote.onmessage = async (msg) => {
      // Slice W-4: swallow the initialize-replay response — the upstream
      // client already saw a handshake completion at the start of the
      // session; re-emitting one would confuse it.
      if (suppressInitReplayId !== null && msg && msg.id !== undefined && msg.id === suppressInitReplayId) {
        suppressInitReplayId = null;
        return;
      }
      try {
        await stdio.send(msg);
      } catch (err) {
        process.stderr.write(`[stdio-mcp] reply error: ${err.message}\n`);
      }
    };
    remote.onerror = (err) => {
      process.stderr.write(`[stdio-mcp] remote transport error: ${err.message}\n`);
    };
  }
  wireRemoteListeners();

  // Slice W-4: transparent stale-session re-handshake. After a leader
  // rotation (zombie recovery + forwarder promotion), the new bridge
  // returns HTTP 404 (code -32001 "Session not found — reinitialize.")
  // per Slice W's spec compliance. The SDK's StreamableHTTPClientTransport
  // surfaces this as a send error but doesn't auto-reset the session.
  // We detect the error, close the transport, build a fresh one, replay
  // the cached initialize (extracting the new session id from the
  // response headers via the transport's internal state), optionally
  // replay the cached `notifications/initialized`, and retry the
  // original failing message.
  const STALE_SESSION_RE = /Session not found|-32001|reinitialize|HTTP 404|status code 404/i;

  async function performReHandshake() {
    if (!cachedInitialize) {
      throw new Error('cannot re-handshake: no cached initialize message');
    }
    process.stderr.write(`[stdio-mcp] re-handshaking transparently...\n`);
    try { await remote.close(); } catch (_) {}
    remote = new StreamableHTTPClientTransport(new URL(httpUrl));
    wireRemoteListeners();
    await remote.start();
    // Intercept the initialize response (matches by id) so Claude Desktop
    // doesn't see a second handshake-complete reply.
    suppressInitReplayId = (cachedInitialize.id !== undefined) ? cachedInitialize.id : null;
    await remote.send(cachedInitialize);
    // Replay the initialized notification if we saw one. Notifications
    // have no id and no response; just fire-and-forget.
    if (cachedInitNotif) {
      try { await remote.send(cachedInitNotif); } catch (_) { /* tolerate */ }
    }
    process.stderr.write(`[stdio-mcp] re-handshake complete\n`);
  }

  // stdio (from Claude Desktop) → remote (HTTP MCP server)
  stdio.onmessage = async (msg) => {
    // Slice W-4: cache initialize + the optional initialized notification
    // on the way through so we can replay them on re-handshake. We cache
    // the LAST initialize we saw (typically only one per session, but if
    // Claude Desktop ever re-initializes we'd want the latest).
    if (msg && msg.method === 'initialize') {
      cachedInitialize = msg;
    } else if (msg && msg.method === 'notifications/initialized') {
      cachedInitNotif = msg;
    }
    try {
      await remote.send(msg);
    } catch (err) {
      let effectiveErr = err;
      const errStr = (err && err.message) ? err.message : String(err) || '';
      if (STALE_SESSION_RE.test(errStr) && cachedInitialize) {
        try {
          // Serialize concurrent re-handshakes — N in-flight failed sends
          // shouldn't all create N fresh transports.
          if (!reHandshakeInFlight) {
            reHandshakeInFlight = performReHandshake().finally(() => { reHandshakeInFlight = null; });
          }
          await reHandshakeInFlight;
          // Now retry the original message on the fresh session.
          await remote.send(msg);
          process.stderr.write(`[stdio-mcp] request retried after re-handshake\n`);
          return;
        } catch (retryErr) {
          process.stderr.write(`[stdio-mcp] re-handshake failed: ${retryErr.message}\n`);
          effectiveErr = retryErr;
        }
      }
      process.stderr.write(`[stdio-mcp] forward error: ${effectiveErr.message}\n`);
      // Return a JSON-RPC error if this was a request (has id)
      if (msg && msg.id !== undefined && msg.id !== null) {
        try {
          await stdio.send({
            jsonrpc: '2.0',
            id: msg.id,
            error: {
              code: -32603,
              message: `Pinako bridge: ${effectiveErr.message}. Make sure the Pinako extension is open.`,
            },
          });
        } catch (_) { /* stdio gone, give up */ }
      }
    }
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
