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
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import pkg from './package.json' with { type: 'json' };
import { PINAKO_ICONS } from './icons.js';

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
const LOG_MAX_BYTES = 5 * 1024 * 1024; // rotate active log past 5 MB (was unbounded; a crash loop once grew it to 27 MB)
const recentRequests = []; // last 10 /mcp requests for /debug endpoint
let logDirCreated = false;
let logBytesWritten = 0;
let logSizeSeeded = false;

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  process.stderr.write(line);
  try {
    if (!logDirCreated) {
      fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
      logDirCreated = true;
    }
    // Seed the running size from the existing file once, then track in-process
    // to avoid stat()ing on every write.
    if (!logSizeSeeded) {
      try { logBytesWritten = fs.statSync(LOG_PATH).size; } catch (_) { logBytesWritten = 0; }
      logSizeSeeded = true;
    }
    const len = Buffer.byteLength(line);
    // Size-capped rotation: keep exactly one previous log (.old). Bounds disk
    // use at ~2×LOG_MAX_BYTES so a future crash loop can't fill the disk.
    if (logBytesWritten + len > LOG_MAX_BYTES) {
      try {
        fs.rmSync(LOG_PATH + '.old', { force: true });
        fs.renameSync(LOG_PATH, LOG_PATH + '.old');
      } catch (_) {}
      logBytesWritten = 0;
    }
    fs.appendFileSync(LOG_PATH, line);
    logBytesWritten += len;
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

// ─── Canonical bulk_apply sub-op-type list (MIRROR) ──────────────────────────
// MIRROR — keep in sync with Pinako/mutation-engine.js BULK_APPLY_SUB_OP_TYPES
// and supabase/functions/chat-completion/index.ts BULK_APPLY_SUB_OP_TYPES.
// The mutation-engine.js copy is the source of truth; smoke tests at
// Pinako/tests/mutation-engine.smoke.js fail loudly if these three arrays
// drift. The constant is unused at runtime today (the engine's per-op schemas
// reject unknown types via validate()); it exists so a drift-detection smoke
// test can parse the list out of each surface's source text.
// eslint-disable-next-line no-unused-vars
const BULK_APPLY_SUB_OP_TYPES = [
  'set_tags',
  'add_tags',
  'remove_tags',
  'set_memo',
  'set_star_color',
  'set_row_color',
  'set_title',
  'create_group',
  'create_window',
  'create_folder',
  'delete_node',
  'ghost_node',
  'delete_live_node',
  'move_node',
  'indent_node',
  'outdent_node',
  'create_library',
  'add_to_library',
  'add_to_bookmarks',
  'set_note_content',
  'create_note',
  'delete_note',
  'create_library_group',
  'delete_library_group',
  'add_library_to_group',
  'remove_library_from_group',
  'set_library_group_title',
  'set_library_group_description',
  'set_library_title',
  'set_library_description',
  'delete_library',
  'reorder_library_panel',
  'reorder_libraries_in_group',
];

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

// Phase 4.5-F (2026-05-20): the MCP-side auto-organize observation log,
// long-poll waiter map, and fire-waiters helper were removed when the
// auto_organize_bookmarks et al. MCP tools were deleted. Auto-organize
// now runs entirely in the extension popup (Phase 4.5 native chat
// migration); see Pinako/auto-organize-{engine,orchestrator,storage}.js.

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
  // In --stdio-mcp mode stdout IS the MCP stdio channel to the AI client —
  // no extension is attached, and a length-prefixed NM frame written here
  // would splice into the JSON-RPC line stream and corrupt it (observed with
  // a host extension's periodic queries gluing onto a notification line).
  // Report unwritable, same as a broken NM stdout.
  if (BRIDGE_URL) return false;
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

// ─── Local host extensions ────────────────────────────────────────────────────
// Optional developer extension point: a host-ext.js placed next to host.js, or
// at ../bridge-ext/host-ext.js relative to it, is loaded at startup and may
// register handlers for additional NM message types, plus additional MCP tools
// (via onMcpTools — registrars run once per McpServer instance, i.e. per MCP
// session). Absent in normal installs; load failures are non-fatal and logged.
// Handlers receive the raw NM message and reply via the provided nmWrite.
const _extNmHandlers = new Map();
const _extMcpToolRegistrars = [];
// host.js runs in TWO module systems and must resolve its directory + a
// require() against whichever primitives the current context provides:
//   • Dev: raw ES module (`node host.js`, since package.json sets
//     "type":"module") — exposes import.meta.url, but NOT require/__dirname.
//   • Prod: CommonJS bundle (esbuild --format=cjs → pkg) — exposes
//     require/__dirname, but esbuild EMPTIES import.meta.url to undefined.
// Using the wrong one crashes at startup (this bug, in both directions).
// `typeof` on an absent identifier is safe (yields "undefined", never throws).
// fs/path are already imported at the top of the file.
let _hostDir, _hostRequire;
if (typeof __dirname !== 'undefined') {
  _hostDir     = __dirname;   // CommonJS bundle (prod)
  _hostRequire = require;
} else {
  _hostDir     = path.dirname(fileURLToPath(import.meta.url));   // ES module (dev)
  _hostRequire = createRequire(import.meta.url);
}
// ─── --diag: runtime diagnostics ──────────────────────────────────────────────
// Prints the embedded runtime's version and core-module availability, then
// exits. A packaged build runs a bundled Node that is NOT the dev machine's
// node — after a runtime/target bump, `pinako-mcp-service --diag` proves what
// actually ships (version, snapshot mode, node:sqlite presence).
if (process.argv.includes('--diag')) {
  let sqliteState = 'unavailable';
  try {
    const sq = _hostRequire('node:sqlite');
    if (sq && typeof sq.DatabaseSync === 'function') sqliteState = 'available';
  } catch (e) {
    sqliteState = `unavailable (${e && e.message ? e.message : e})`;
  }
  process.stdout.write(
    `node: ${process.version} (${process.platform}-${process.arch})\n` +
    `packaged: ${process.pkg ? 'yes' : 'no'}\n` +
    `node:sqlite: ${sqliteState}\n`
  );
  process.exit(0);
}

(function loadHostExtensions() {
  const candidates = [
    path.join(_hostDir, 'host-ext.js'),
    path.join(_hostDir, '..', 'bridge-ext', 'host-ext.js'),
  ];
  for (const p of candidates) {
    try {
      if (!fs.existsSync(p)) continue;
      const ext = _hostRequire(p);
      if (typeof ext === 'function') {
        ext({
          onNmMessage: (type, fn) => { if (type && typeof fn === 'function') _extNmHandlers.set(type, fn); },
          nmWrite,
          log: (m) => { try { log(`[host-ext] ${m}`); } catch (_) {} },
          getLocalBrowserId: () => { try { return localBrowserId; } catch (_) { return null; } },
          // Register extra MCP tools: fn(srv, { z }) is invoked for every server
          // instance createMcpServer() builds (one per MCP session).
          onMcpTools: (fn) => { if (typeof fn === 'function') _extMcpToolRegistrars.push(fn); },
          // Dispatch an agent edit op through the same pipeline the built-in
          // write tools use (browser resolution, confirmation/tier gates, local
          // NM or SSE-forwarder routing). Returns the executeEdit result object.
          executeEdit: (op, browserArg) => executeEdit(op, browserArg),
        });
        try { log(`Host extension loaded: ${p}`); } catch (_) {}
      }
    } catch (e) {
      try { log(`Host extension load failed (${p}): ${e && e.message ? e.message : e}`); } catch (_) {}
    }
  }
})();

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
    // S3.8 §7.4: the tab-world flag-label registry (hex→label + name→hex
    // snapshot). Rides the initial getTree and a dedicated flagLabels-only
    // push on registry edits; every other update omits it — preserve.
    const flagLabels = (msg.data && 'flagLabels' in msg.data)
      ? (msg.data.flagLabels || null)
      : (prior?.flagLabels || null);
    cachedData.set(browserId, {
      tree,
      libraries,
      globalNotes,
      bookmarks,
      docs,
      libraryGroups,
      libraryPanelOrder,
      flagLabels,
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
    // S3.8 §7.4: a flagLabels-only push carries no tree, so the usual line
    // reported "0 windows" — which reads like a wipe when you're scanning the
    // log. Name what actually changed instead.
    const flagsOnlyPush = !!(msg.data && 'flagLabels' in msg.data && !('tree' in msg.data));
    process.stderr.write(flagsOnlyPush
      ? `[pinako-mcp] Flag-label registry updated from ${browserBrand} (${browserId.slice(0,16)}…).\n`
      : `[pinako-mcp] Tree updated from ${browserBrand} (${browserId.slice(0,16)}…): ${msg.data.tree?.length || 0} windows.\n`);
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
    // 2026-05-15 multi-browser fix: in forwarder mode, the cache MCP tools
    // serve from is the LEADER's, not ours. Relay this push so the leader's
    // cachedData reflects the panel state. Without it, get_organize_state on
    // the leader returns 'idle' indefinitely for forwarder-side browsers and
    // the agent's Step 6 poll stalls forever (Confirm in the popup never
    // surfaces to the agent). Symmetric to the treeUpdate forwarder branch
    // above. The forwarder's own cachedData is unused for MCP serving, so
    // we don't populate it here.
    if (forwardToExisting) {
      _postOrganizeStateToLeader(msg);
      return;
    }
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
    cachedData.set(browserId, prior);
    log(`organizeStateUpdate from ${msg.browserBrand || 'unknown'}: workflowStep=${prior.organizeState.workflowStep} buckets=${prior.organizeState.buckets.length}`);
    // Phase 4.5-F: organizeState cache write is kept (popup still pushes
    // these NM messages whenever the auto-organize panel transitions) but
    // no MCP tool reads from it. The auto-organize workflow now runs
    // entirely in the popup; if a future MCP-side surface needs the data,
    // it's already cached.
  } else if (_extNmHandlers.has(msg.type)) {
    // Local host extension handler (see loadHostExtensions above).
    try { _extNmHandlers.get(msg.type)(msg); }
    catch (e) { try { log(`host-ext handler error (${msg.type}): ${e && e.message ? e.message : e}`); } catch (_) {} }
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

// ─── S2g #2 (2026-05-14): agent-command routing for forwarder targets ────────
// Panel-launch tools (auto_organize_bookmarks, complete_organize_sort) deliver
// their popup-launch / state-transition signals via the bridge → SW NM channel
// using a {type:'enqueueAgentCommand', ...} message. The SW writes the payload
// to chrome.storage.local._pinako_pending_agent_command, the popup picks it up
// via chrome.storage.onChanged.
//
// On the leader, nmWrite reaches the leader's SW directly. On a forwarder
// target (target browserId !== localBrowserId), nmWrite still reaches the
// LEADER's SW — wrong browser; the targeted forwarder's SW never sees the
// command. Bug documented as auto-organize-plan.md Sub-slice S2g #2.
//
// Mirror Slice 2B's dispatchEditViaSse pattern: route via the existing /edits
// SSE channel when target ≠ local browser. The forwarder-side _handleSseEvent
// (below) relays the inbound SSE event to its own SW via nmWrite (same shape
// the leader uses). The SW's enqueueAgentCommand handler is identical
// regardless of whether the bridge is leader or forwarder.
//
// Fire-and-forget, unlike applyEdit. Agent commands have no response-required
// semantic — the popup either renders the panel or doesn't; there's no
// editApplied / editFailed reply path to wait on. So no requestId tracking on
// the leader side beyond what's already in the payload for observability.
function _dispatchAgentCommandViaSse(payload, browserId) {
  const forwarder = forwarders.get(browserId);
  if (!forwarder) {
    return { ok: false, reason: 'FORWARDER_NOT_CONNECTED' };
  }
  try {
    forwarder.sseRes.write(`event: agentCommand\ndata: ${JSON.stringify(payload)}\n\n`);
    return { ok: true };
  } catch (err) {
    log(`dispatchAgentCommandViaSse SSE write failed: ${err.message}`);
    return { ok: false, reason: 'SSE_WRITE_FAILED', message: err.message };
  }
}

// Route an enqueueAgentCommand payload to the SW that hosts the targeted
// browser:
//  - target === local browser  → nmWrite (current path; reaches local SW)
//  - target is a connected forwarder → SSE event to that forwarder bridge
//  - bridge hasn't seen its local extension yet → nmWrite anyway (best
//    effort during the SW handshake window)
//  - target cached but no forwarder bound → fail clean
//
// Observability (2026-05-14): every routing decision logs to the bridge log.
// Triage table for the disk log line:
//   route=NM-leader-local ok=true   → message reached leader's SW. Downstream
//                                     bug is on SW or popup side.
//   route=NM-leader-local ok=false  → leader's nmWrite failed (stdout broken,
//                                     bridge about to exit / has exited).
//   route=SSE-forwarder ok=true     → SSE write succeeded; forwarder should
//                                     relay to its SW. Downstream bug if
//                                     panel still doesn't open.
//   route=SSE-forwarder ok=false    → SSE write failed (forwarder dropped
//                                     mid-flight, etc.); reason field tells
//                                     why.
//   route=NM-leader-bootstrap       → localBrowserId not set yet (SW
//                                     handshake in flight); best-effort
//                                     nmWrite anyway.
//   route=NONE FORWARDER_NOT_CONNECTED → target is cached but neither leader
//                                     nor forwarder; popup likely closed.
function _routeAgentCommand(payload, browserId) {
  const idShort = (browserId || '').slice(0, 16);
  const cmd = payload && payload.command ? payload.command : '?';
  if (localBrowserId && browserId === localBrowserId) {
    const ok = nmWrite(payload);
    log(`agentCommand route=NM-leader-local cmd=${cmd} browserId=${idShort}… ok=${ok}`);
    return { ok, channel: 'nm-leader-local' };
  }
  if (forwarders.has(browserId)) {
    const r = _dispatchAgentCommandViaSse(payload, browserId);
    log(`agentCommand route=SSE-forwarder cmd=${cmd} browserId=${idShort}… ok=${r.ok}${r.reason ? ' reason=' + r.reason : ''}`);
    return { ok: r.ok, channel: 'sse-forwarder', reason: r.reason };
  }
  if (!localBrowserId) {
    const ok = nmWrite(payload);
    log(`agentCommand route=NM-leader-bootstrap cmd=${cmd} ok=${ok} (localBrowserId not set yet — SW handshake in flight)`);
    return { ok, channel: 'nm-leader-bootstrap' };
  }
  log(`agentCommand route=NONE cmd=${cmd} browserId=${idShort}… reason=FORWARDER_NOT_CONNECTED (target ≠ leader and no forwarder bound — popup likely closed in target browser)`);
  return { ok: false, channel: 'none', reason: 'FORWARDER_NOT_CONNECTED' };
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
  // S2g #2 (2026-05-14): agent-command relay. Leader bridge SSE-writes
  // {type:'enqueueAgentCommand', ...} payloads when the targeted browser is
  // not the leader's local browser. Forwarder relays the same shape to its
  // own SW via nmWrite — identical to what the leader does for its own SW.
  // Fire-and-forget; no reply path to /edit-result.
  if (eventName === 'agentCommand') {
    let data;
    try { data = JSON.parse(dataParts.join('\n')); }
    catch (e) { log(`SSE: bad agentCommand data: ${e.message}`); return; }
    const { command, browserId } = data || {};
    if (!command) { log('SSE: agentCommand missing command field'); return; }
    log(`SSE agentCommand command=${command} for browserId=${(browserId||'').slice(0,16)}…`);
    const ok = nmWrite(data);
    if (!ok) log(`SSE agentCommand nmWrite to forwarder SW failed for command=${command}`);
    return;
  }
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

// 2026-05-15 multi-browser fix: forwarder → leader relay for auto-organize
// workflow state. Mirrors _postEditResultToLeader but for organizeStateUpdate
// NM messages. The leader serves MCP requests and reads organizeState from
// its own cachedData — a forwarder caching locally is invisible to MCP
// callers. Token-bound the same way /edit-result is.
function _postOrganizeStateToLeader(msg) {
  const body = JSON.stringify({
    browserId:      msg.browserId,
    browserBrand:   msg.browserBrand,
    userTier:       msg.userTier,
    userId:         msg.userId,
    payload:        msg.payload,
    forwarderToken: _myForwarderToken,
  });
  const req = http.request(
    { hostname: '127.0.0.1', port: MCP_PORT, path: '/organize-state-update', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
    (res) => { res.resume(); }
  );
  req.on('error', (err) => { log(`/organize-state-update post error: ${err.message}`); });
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
// 2026-05-24: widened to include delete_library + delete_note so the MCP
// bridge boundary enforces confirmedByUser for the full destructive set.
// Pre-fix the bridge only gated delete_node / delete_live_node (+ the
// delete_library_group cascade special-case below); delete_library and
// delete_note relied solely on the engine schema's z.literal(true).refine()
// catching them at the popup layer. With this widening the bridge layer
// becomes the truly canonical bypass-proof guard the surrounding comment
// claims. Engine layer remains as defense-in-depth.
const _ALWAYS_DESTRUCTIVE_OP_TYPES = new Set(['delete_node', 'delete_live_node', 'delete_library', 'delete_note']);

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

// Counts nodes recursively in a tree or array of trees.
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

// Cross-scope duplicate scan. Walks multiple scoped trees in a single pass and
// tags each URL occurrence with its sourceScope (and sourceLibraryId for
// library-scope instances). A URL counts as a duplicate if it appears 2+ times
// across the unioned scopes — one tab + one bookmark with the same URL is a
// cross-scope duplicate. Used when the user's question spans multiple surfaces
// ("do I already have this saved" / "is this open tab a bookmark already").
// Each duplicateSet's response adds parallel sourceScopes[] + sourceLibraryIds[]
// arrays alongside the existing nodeIds[] / parentPaths[] so the agent can route
// downstream bulk_apply ops to the correct scope per-instance (single bulk_apply
// with one outer scope won't work when instances span scopes).
function _findDuplicateUrlsCrossScope(scopedTrees) {
  const urlMap = new Map();
  let scanned = 0;
  for (const { tree, sourceScope, sourceLibraryId } of scopedTrees) {
    const pathStack = [];
    function walk(node) {
      if (!node) return;
      const url = node && typeof node.url === 'string' ? node.url : '';
      if (url.length > 0) {
        scanned++;
        let arr = urlMap.get(url);
        if (!arr) { arr = []; urlMap.set(url, arr); }
        arr.push({
          id:              node.id,
          title:           String(node.title || ''),
          parentPath:      pathStack.join('/'),
          sourceScope,
          sourceLibraryId: sourceLibraryId || null,
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
  }
  const duplicateSets = [];
  let totalDuplicateInstances = 0;
  for (const [url, instances] of urlMap.entries()) {
    if (instances.length > 1) {
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
        count:            instances.length,
        nodeIds:          instances.map(x => x.id),
        parentPaths:      instances.map(x => x.parentPath),
        sourceScopes:     instances.map(x => x.sourceScope),
        sourceLibraryIds: instances.map(x => x.sourceLibraryId),
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
//
// `opts` (2026-05-19): composable shape opt-ins for the lite branch. Pass-
// through to liteNode (then children are stripped since pagination is flat).
// Ignored by minimal and full modes (their shapes are fixed).
//
// Flat pagination shapes each node in isolation, so the tabgroup-ancestor
// inheritance liteNode does through its own children recursion has to be
// threaded here too (N5) — otherwise a paginated read of a containment-world
// tree drops the per-tab chromeGroup* fields that the nested read emits.
function _flattenTreeWithMode(nodes, scope, libraryId, mode, includeFavicons, opts, parentId = null, out = []) {
  if (!Array.isArray(nodes)) return out;
  for (const node of nodes) {
    if (!node) continue;
    let shaped;
    if (mode === 'minimal') {
      shaped = minimalNode(node, scope, libraryId, parentId);
    } else if (mode === 'lite') {
      // Route through liteNode so composable opt-ins apply consistently
      // between paginated (flat) and non-paginated (tree-shaped) reads.
      // Strip children after shaping since pagination is flat.
      const lite = liteNode(node, scope, libraryId, opts);
      const { children: _ignoreChildren, ...rest } = lite;
      shaped = rest;
      if (parentId) shaped.parentId = parentId;
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
      const childOpts = (mode === 'lite' && node.type === 'tabgroup')
        ? Object.assign({}, opts || {}, {
            _tgAncestor: {
              groupId: node.chromeGroupId != null ? node.chromeGroupId : null,
              title:   node.title || '',
              color:   node.color || '',
            },
          })
        : opts;
      _flattenTreeWithMode(node.children, scope, libraryId, mode, includeFavicons, childOpts, node.id, out);
    }
  }
  return out;
}

// Flatten the raw chrome.bookmarks tree (different shape from Pinako nodes)
// into a flat DFS pre-order list. Each item carries id, title, url (if leaf),
// parentId, dateAdded, index. Folders are included (no url field) so the
// agent can see structure; the sift loop typically filters to url-bearing
// nodes itself.
//
// 2026-05-25 (V3 follow-up — chat-side composable mirror): accepts a 4th
// `opts` argument and a 5th `parentPath` recursion-state argument so the
// composable shape on MCP's get_bookmarks mirrors the chat side. opts:
//   { leavesOnly, foldersOnly, includePath, minimal }
// Default behavior (no opts) is unchanged: every node emitted, full field
// set (id, title, parentId, url, dateAdded, index). Pre-existing callers
// (pagination-only path; the sift loop) keep their behavior.
//
// Folder detection on the Chrome shape: `!node.url && Array.isArray(node.children)`.
// Chrome's tree doesn't carry an explicit `type` field — folders simply
// have a `children` array and no `url`. (Chat-side uses `node.type === 'folder'`
// because convertChromeBookmarks stamps it explicitly; here we infer.)
function _flattenBookmarksTree(nodes, parentId = null, out = [], opts = {}, parentPath = '') {
  if (!Array.isArray(nodes)) return out;
  const leavesOnly  = opts.leavesOnly  === true;
  const foldersOnly = opts.foldersOnly === true;
  const includePath = opts.includePath === true;
  const minimal     = opts.minimal     === true;
  for (const node of nodes) {
    if (!node) continue;
    const isLeaf   = typeof node.url === 'string' && node.url.length > 0;
    const isFolder = !isLeaf && Array.isArray(node.children);
    const shouldEmit =
      (leavesOnly  && isLeaf)   ||
      (foldersOnly && isFolder) ||
      (!leavesOnly && !foldersOnly);
    const ownPath = parentPath ? `${parentPath} / ${node.title || ''}` : (node.title || '');
    if (shouldEmit) {
      const item = {
        id:       node.id,
        title:    node.title || '',
        parentId: parentId,
      };
      if (isLeaf) item.url = node.url;
      // dateAdded + index always emitted on MCP unless minimal:true was passed.
      // (Chat-side gates dateAdded behind include_date_added; MCP's pre-V3
      // behavior was always-emit, preserved here for back-compat with existing
      // pagination callers + the sift loop.)
      if (!minimal && typeof node.dateAdded === 'number') item.dateAdded = node.dateAdded;
      if (!minimal && typeof node.index === 'number')     item.index     = node.index;
      if (includePath) item.path = ownPath;
      out.push(item);
    }
    if (Array.isArray(node.children) && node.children.length > 0) {
      // Path inheritance: only folders contribute to the path; leaves don't
      // accumulate (a leaf's children, if any, would be a weird Chrome shape
      // — defensive: pass parentPath unchanged when the current node isn't
      // a folder, matching chat-side behavior).
      _flattenBookmarksTree(node.children, node.id, out, opts, isFolder ? ownPath : parentPath);
    }
  }
  return out;
}

// 2026-05-25 (V3 follow-up): MCP-side helpers for the composable shape.
// Mirror the chat-side _find*ForChat / _buildBookmarkPathForChat helpers
// (Pinako/pinako.js:~18938-19016) but operate on the raw chrome.bookmarks
// tree shape rather than the Pinako-converted tree. Folder detection
// uses the same `!url && Array.isArray(children)` rule as the extended
// _flattenBookmarksTree above.

// Depth-first walk to find a node by Chrome bookmark id. Returns the
// node or null.
function _findBookmarkNodeById(nodes, targetId) {
  if (!Array.isArray(nodes)) return null;
  for (const n of nodes) {
    if (!n) continue;
    if (n.id === targetId) return n;
    if (Array.isArray(n.children) && n.children.length > 0) {
      const hit = _findBookmarkNodeById(n.children, targetId);
      if (hit) return hit;
    }
  }
  return null;
}

// Case-insensitive top-level root lookup ("Bookmarks Bar" / "Bookmarks bar"
// / "Favorites bar" / localized variants). First step of the `parent`
// title-shorthand resolution cascade. Some Chrome variants wrap real roots
// in a virtual empty-titled container at the top; this function looks at
// the top level FIRST, then walks one level into empty-titled wrappers if
// needed.
function _findBookmarkRootByTitle(rootNodes, title) {
  if (!Array.isArray(rootNodes) || typeof title !== 'string') return null;
  const target = title.toLowerCase().trim();
  if (!target) return null;
  for (const n of rootNodes) {
    if (n && typeof n.title === 'string' && n.title.toLowerCase().trim() === target) {
      return n;
    }
  }
  // Empty-titled wrapper case: walk one level deeper.
  for (const n of rootNodes) {
    if (n && (!n.title || n.title.trim() === '') && Array.isArray(n.children)) {
      for (const c of n.children) {
        if (c && typeof c.title === 'string' && c.title.toLowerCase().trim() === target) {
          return c;
        }
      }
    }
  }
  return null;
}

// DFS walk for any folder with a matching (case-insensitive) title at any
// depth. First-match-wins on collisions — the caller is expected to
// disambiguate via folders_only's `path` field if two folders share a
// title in different subtrees.
function _findBookmarkFolderByTitle(rootNodes, title) {
  const target = String(title || '').toLowerCase().trim();
  if (!target) return null;
  function walk(nodes) {
    if (!Array.isArray(nodes)) return null;
    for (const n of nodes) {
      if (!n) continue;
      const isLeaf   = typeof n.url === 'string' && n.url.length > 0;
      const isFolder = !isLeaf && Array.isArray(n.children);
      if (isFolder && (n.title || '').toLowerCase().trim() === target) {
        return n;
      }
      if (Array.isArray(n.children) && n.children.length > 0) {
        const hit = walk(n.children);
        if (hit) return hit;
      }
    }
    return null;
  }
  return walk(rootNodes);
}

// Build the breadcrumb path ("Bookmarks Bar / Travel / 2024") to a given
// node by walking the tree. Returns the slash-joined path string or null
// if the node isn't found. Used to seed `parentResolvedPath` when emitting
// `path` on a parent-scoped folders_only response.
function _buildBookmarkPath(rootNodes, targetId) {
  function walk(nodes, breadcrumb) {
    if (!Array.isArray(nodes)) return null;
    for (const n of nodes) {
      if (!n) continue;
      const myPath = breadcrumb ? `${breadcrumb} / ${n.title || ''}` : (n.title || '');
      if (n.id === targetId) return myPath;
      if (Array.isArray(n.children) && n.children.length > 0) {
        const hit = walk(n.children, myPath);
        if (hit) return hit;
      }
    }
    return null;
  }
  return walk(rootNodes, '');
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
// and a small sample of titles. The whole point is "summarize before reading"
// — fits in <2KB regardless of tree size.

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
//
// COMPOSABLE OPTS (2026-05-19): the 4th argument `opts` lets callers tailor
// the lite shape per field. Field-level defaults match the pre-2026-05-19
// MCP lite shape for fields MCP already returned (openedDate, tags, memoText,
// collapsed all default-true) PLUS adds the chat-side fields for parity
// (chromeGroupId/Title/Color, starColor, rowColor,
// customTitle all default-true; only emitted when present, so cheap-when-
// absent — most existing MCP callers see no behavior change since these
// fields are typically unset on tab nodes). The mutation engine + audit log
// are unaffected.
//
// `opts.minimal: true` forces every include_* flag to false → basics-only
// shape (id, type, title, scope, libraryId, url, ghost). Shortcut for cheap
// large-tree scans.
//
// Window Groups (type='group') are tree nodes — always returned as nodes
// regardless of include_chrome_tab_groups. That flag controls only the
// browser Tab Group METADATA fields (chromeGroupId/Title/Color).
//
// include_chrome_tab_groups contract (N5, tab-group-node-plan.md). Those
// fields are emitted for BOTH representations of a browser Tab Group, so
// existing agent consumers keep a stable tab-level shape across the
// migration:
//   - SNAPSHOT world (legacy): read from the member tab's own
//     groupSnapshot {groupId, title, color}.
//   - CONTAINMENT world (tabgroup nodes): member tabs carry NO snapshot —
//     the group identity lives on the type='tabgroup' ANCESTOR node
//     ({chromeGroupId, title, color}), and every tab in that branch (at any
//     depth — tabs nested under a member are members too) derives its
//     fields from it. The tabgroup node ALSO serializes as a typed
//     container carrying chromeGroupId + chromeGroupColor of its own; its
//     `title` already IS the group name, so no chromeGroupTitle is added.
// The ancestor wins when both are somehow present: containment is the
// structural truth and is what the tree actually renders.
// Suppression rules are identical in both worlds — a ghost member
// (chromeId === null) keeps title/color and drops the stale live id.
function liteNode(node, scope, libraryId, opts) {
  if (!node || typeof node !== 'object') return node;
  opts = opts || {};
  const minimal = opts.minimal === true;

  const wantOpenedDate     = minimal ? false : (opts.include_opened_date       !== false);
  const wantTags           = minimal ? false : (opts.include_tags              !== false);
  const wantMemos          = minimal ? false : (opts.include_memos             !== false);
  const wantLineage        = minimal ? false : (opts.include_lineage           !== false);
  const wantChromeGroups   = minimal ? false : (opts.include_chrome_tab_groups !== false);
  const wantStarColor      = minimal ? false : (opts.include_star_color        !== false);
  const wantRowColor       = minimal ? false : (opts.include_row_color         !== false);
  const wantCustomTitle    = minimal ? false : (opts.include_custom_title      !== false);

  const out = {
    id:    node.id,
    type:  node.type,
    title: node.title || '',
  };
  if (scope)     out.scope     = scope;
  if (libraryId) out.libraryId = libraryId;
  if (node.url) out.url = node.url;
  if (node.type === 'tab' && node.chromeId === null) out.ghost = true;

  if (wantOpenedDate && node.type === 'tab' && node.openedDate) out.openedDate = node.openedDate;
  if (wantTags && Array.isArray(node.tags) && node.tags.length > 0) out.tags = node.tags;
  if (wantMemos && node.memoText) out.memoText = node.memoText;

  if (wantLineage) {
    // Collapsed flag only. parentWindow/parentGroup reads removed 2026-07-16:
    // nothing ever assigns those fields on tree nodes (they exist only on the
    // flat entries the extension's semantic-search context builders create,
    // so the reads were dead since 2026-05-19). Ancestry is conveyed
    // structurally by nested `children`; flat search_pinako hits carry
    // parentPath; minimal mode carries parentId.
    if (node.collapsed) out.collapsed = true;
  }
  if (wantChromeGroups && node.type === 'tab') {
    // Group identity {groupId, title, color}: from the tabgroup ANCESTOR
    // when the tab sits in a containment branch, else from the tab's own
    // legacy groupSnapshot. Live groupId is suppressed on ghosts
    // (chromeId === null) and absent on library clones (stored as null) —
    // title/color are the durable group identity.
    const gs = opts._tgAncestor || node.groupSnapshot;
    if (gs) {
      if (gs.groupId != null && node.chromeId !== null) out.chromeGroupId = gs.groupId;
      if (gs.title) out.chromeGroupTitle = gs.title;
      if (gs.color) out.chromeGroupColor = gs.color;
    }
  }
  if (wantChromeGroups && node.type === 'tabgroup') {
    // The container itself: its `title` already carries the group name, so
    // only the id (live only) and the color are added.
    if (node.chromeGroupId != null) out.chromeGroupId = node.chromeGroupId;
    if (node.color) out.chromeGroupColor = node.color;
  }
  if (wantStarColor && node.starColor) out.starColor = node.starColor;
  if (wantRowColor && node.rowColor) out.rowColor = node.rowColor;
  if (wantCustomTitle && node.customTitle) out.customTitle = true;

  if (Array.isArray(node.children) && node.children.length > 0) {
    // A tabgroup node stamps its identity onto a DERIVED opts object so its
    // whole branch inherits it; every other node passes opts through
    // untouched (no allocation on the common path). Inlined rather than
    // factored into a helper so liteNode stays self-contained — the smoke
    // harness slices this one function out of host.js and evals it alone.
    const childOpts = node.type === 'tabgroup'
      ? Object.assign({}, opts, {
          _tgAncestor: {
            groupId: node.chromeGroupId != null ? node.chromeGroupId : null,
            title:   node.title || '',
            color:   node.color || '',
          },
        })
      : opts;
    out.children = node.children.map(c => liteNode(c, scope, libraryId, childOpts));
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
// `opts` (2026-05-19): composable per-field opt-ins for the lite path. Pass-
// through to liteNode; ignored by minimal/full modes (which have their own
// fixed shapes). When mode='lite' AND composable opts are set, composable
// behavior wins (mode is the legacy dispatcher).
function shapeTree(rootNodes, scope, libraryId, mode, includeFavicons, opts) {
  if (mode === 'minimal') return flattenForMinimal(rootNodes, scope, libraryId);
  if (mode === 'lite')    return rootNodes.map(n => liteNode(n, scope, libraryId, opts));
  // full
  return includeFavicons ? rootNodes : rootNodes.map(stripFavicons);
}

// Extract composable shape opts from a tool input destructure. Returns an
// opts object suitable for liteNode / shapeTree. Used by get_tree, get_library,
// list_libraries (when include_tabs:true). Only forwards keys the agent
// explicitly set; liteNode applies its own defaults for omitted keys.
function _extractShapeOpts(input) {
  if (!input || typeof input !== 'object') return {};
  const opts = {};
  if (input.minimal === true) opts.minimal = true;
  if (input.include_opened_date       !== undefined) opts.include_opened_date       = input.include_opened_date;
  if (input.include_tags              !== undefined) opts.include_tags              = input.include_tags;
  if (input.include_memos             !== undefined) opts.include_memos             = input.include_memos;
  if (input.include_lineage           !== undefined) opts.include_lineage           = input.include_lineage;
  if (input.include_chrome_tab_groups !== undefined) opts.include_chrome_tab_groups = input.include_chrome_tab_groups;
  if (input.include_star_color        !== undefined) opts.include_star_color        = input.include_star_color;
  if (input.include_row_color         !== undefined) opts.include_row_color         = input.include_row_color;
  if (input.include_custom_title      !== undefined) opts.include_custom_title      = input.include_custom_title;
  return opts;
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

// `tgAncestor` (N5) carries the nearest type='tabgroup' ancestor down the walk.
// Hits are pushed as DETACHED flat copies, so the containment inheritance
// liteNode performs through its own children recursion cannot run here — the
// stamp is recorded per hit in `stamps` (index-parallel to `results`) and
// applied by the caller when it shapes in lite mode. Without it a containment-
// world member silently loses its chromeGroup* fields on a lite search, while
// the same tab read via get_tree emits them.
function searchInTree(nodes, query, includeGhost, results = [], stamps = [], tgAncestor = null) {
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
      if (hit) {
        // Flat result list: strip children before pushing. searchInTree already
        // recurses into node.children below and pushes every matching nested tab
        // as its OWN top-level entry, so retaining children here would let the
        // downstream shapeTree('minimal') -> flattenForMinimal re-descend and
        // re-emit those same nested tabs, double-counting tab-under-tab nesting
        // (inflated `count`, duplicate result rows). The copy is independent of
        // node.children, so the recursion below still finds nested matches.
        const flat = sanitizeNode(node);
        delete flat.children;
        results.push(flat);
        stamps.push(tgAncestor);
      }
    }
    if (node.children?.length) {
      const childStamp = node.type === 'tabgroup'
        ? {
            groupId: node.chromeGroupId != null ? node.chromeGroupId : null,
            title:   node.title || '',
            color:   node.color || '',
          }
        : tgAncestor;
      searchInTree(node.children, query, includeGhost, results, stamps, childStamp);
    }
  }
  return results;
}

// Omnibus search across a tree-shaped scope (main tree, library children, or
// chrome.bookmarks tree). Mirrors Pinako's UI search bars: matches title, URL,
// memoText, and tags across NON-tab nodes too (groups, windows, folders,
// library-folders). Each hit returns the set of matchedFields that produced
// it, plus parentPath, so the agent can prioritize or display per-source.
// Powers MCP `search_pinako` (the omnibus tool); legacy `search_tabs`
// continues to use searchInTree above for tab-only main-tree results.
// S3.8 §7.4: resolve a node's starColor to its user-named flag LABEL via the
// registry snapshot the extension delivers ({labels: {hex: label}, names:
// {name: hex}}). Legacy stores may hold a bare color NAME; the names snapshot
// covers that without a hardcoded palette copy. Unlabeled/unknown → ''.
// Both maps are JSON-derived, so every lookup is own-property guarded: without
// it a starColor of 'constructor' (or 'toString', '__proto__'…) resolves off the
// prototype chain and a function ends up standing in for a label.
function _flagLabelOf(starColor, flagLabels) {
  if (!starColor || !flagLabels || !flagLabels.labels) return '';
  const own = (o, k) => !!o && Object.prototype.hasOwnProperty.call(o, k);
  const s = String(starColor);
  const hex = s.charAt(0) === '#'
    ? s.toLowerCase()
    : (own(flagLabels.names, s) ? flagLabels.names[s] : s);
  return (own(flagLabels.labels, hex) && flagLabels.labels[hex]) || '';
}

function _searchInTreeOmni({
  tree, query, scope, sourceLibraryId, matchFields, exactTag, includeGhost, limit, results, flagLabels,
}) {
  if (!Array.isArray(tree) || tree.length === 0) return;
  const q = query.toLowerCase();
  const wantTitle = matchFields.includes('title');
  const wantUrl   = matchFields.includes('url');
  const wantMemo  = matchFields.includes('memo');
  const wantTags  = matchFields.includes('tags');
  const wantFlag  = matchFields.includes('flag'); // S3.8 §7.4 — parity with the native chat route
  const pathStack = [];

  function walk(node) {
    if (!node) return;
    if (results.length >= limit) return;
    // Never expose incognito nodes via MCP
    if (node.incognito) return;

    const title    = String(node.title || '');
    const url      = node.url || '';
    const memo     = node.memoText || '';
    const tagArr   = Array.isArray(node.tags) ? node.tags : [];
    const flag     = wantFlag ? _flagLabelOf(node.starColor, flagLabels) : '';
    const nodeType = node.type || (typeof url === 'string' && url.length > 0 ? 'bookmark' : 'folder');

    // For tree scope, optionally skip ghost tabs.
    const isGhostTab = node.type === 'tab' && node.chromeId === null;

    const matched = [];
    if (wantTitle && title && title.toLowerCase().includes(q)) matched.push('title');
    if (wantUrl   && url   && url.toLowerCase().includes(q))   matched.push('url');
    if (wantMemo  && memo  && memo.toLowerCase().includes(q))  matched.push('memo');
    if (wantTags  && tagArr.length > 0) {
      if (exactTag) {
        if (tagArr.some(t => String(t).toLowerCase() === q)) matched.push('tags');
      } else {
        if (tagArr.some(t => String(t).toLowerCase().includes(q))) matched.push('tags');
      }
    }
    if (wantFlag && flag && flag.toLowerCase().includes(q)) matched.push('flag');

    if (matched.length > 0 && !(isGhostTab && !includeGhost)) {
      const entry = {
        type:           nodeType,
        scope,
        nodeId:         node.id,
        title,
        matchedFields:  matched,
        parentPath:     pathStack.join('/'),
      };
      if (sourceLibraryId) entry.sourceLibraryId = sourceLibraryId;
      if (url)             entry.url = url;
      if (tagArr.length)   entry.tags = [...tagArr];
      if (memo)            entry.memoText = memo;
      if (flag)            entry.flag = flag;
      if (node.type === 'tab' && node.chromeId === null) entry.ghost = true;
      results.push(entry);
    }

    if (Array.isArray(node.children) && node.children.length > 0) {
      const pushed = title.length > 0;
      if (pushed) pathStack.push(title);
      for (const child of node.children) {
        if (results.length >= limit) break;
        walk(child);
      }
      if (pushed) pathStack.pop();
    }
  }
  for (const root of tree) {
    if (results.length >= limit) break;
    walk(root);
  }
}

function _stripHtmlForSearch(html) {
  // Bridge-side DOM strip: replace tag soup with spaces, collapse whitespace.
  // Pinako notes are Tiptap HTML — typically well-formed; this is enough for
  // substring search. Not a full HTML parser; doesn't try to decode entities
  // because they wouldn't normally land in user-typed search queries anyway.
  return String(html || '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/\s+/g, ' ').trim();
}

function _searchInNotes({
  notesArray, query, scope, sourceLibraryId, matchFields, limit, results,
}) {
  if (!Array.isArray(notesArray) || notesArray.length === 0) return;
  const q = query.toLowerCase();
  const wantTitle   = matchFields.includes('title');
  const wantContent = matchFields.includes('content');
  for (const note of notesArray) {
    if (results.length >= limit) return;
    if (!note) continue;
    const title = String(note.title || '');
    const matched = [];
    if (wantTitle && title && title.toLowerCase().includes(q)) matched.push('title');

    let stripped = '';
    let contentHitIdx = -1;
    if (wantContent) {
      stripped = _stripHtmlForSearch(note.content);
      if (stripped) {
        contentHitIdx = stripped.toLowerCase().indexOf(q);
        if (contentHitIdx >= 0) matched.push('content');
      }
    }
    if (matched.length === 0) continue;

    // 200-char snippet centered on the first content hit; otherwise the
    // note's leading 200 chars so the agent has SOME context.
    let snippet;
    if (contentHitIdx >= 0) {
      const start = Math.max(0, contentHitIdx - 80);
      const end   = Math.min(stripped.length, contentHitIdx + q.length + 80);
      snippet = (start > 0 ? '…' : '') + stripped.slice(start, end) + (end < stripped.length ? '…' : '');
    } else {
      snippet = stripped.length > 200 ? stripped.slice(0, 200) + '…' : stripped;
    }

    const entry = {
      type:           'note',
      scope,
      noteId:         note.id,
      title,
      matchedFields:  matched,
      snippet,
    };
    if (sourceLibraryId) entry.sourceLibraryId = sourceLibraryId;
    results.push(entry);
  }
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

// A broad scope:"all" search auto-includes the bookmark tree only when it has
// at most this many links; above it, search_pinako skips bookmarks and returns
// a bookmarksSkipped notice so the agent asks the user before searching them.
// Bookmark trees run to 10K+ links and would dominate the result budget and
// burn tokens without adding signal. Explicit scope:"bookmarks" is never gated
// (the user directed that one). Mirrored on the chat side in Pinako/pinako.js
// (_executeChatToolSearchPinako).
const BOOKMARK_SEARCH_CONFIRM_THRESHOLD = 600;

// ─── MCP Server factory ────────────────────────────────────────────────────────
// Each HTTP session gets its own McpServer + transport instance.
// Tool handlers read from the global cachedData (no per-session state needed).
const SERVER_INSTRUCTIONS = `Pinako is a browser tab manager Chrome extension. This MCP server gives you READ and WRITE access to the user's live tab data, libraries, library groups, notes, and browser bookmarks.

ROUTING - when the user expresses one of these intents, CALL THE LISTED TOOL FIRST instead of planning the task yourself by reading the tree:

  "organize / clean up / sort / categorize my bookmarks"
    -> search_docs({query:"playbook", full_sections:true}) FIRST, then follow it. There is no one-call "auto-organize" tool; don't look for one or tell the user to use one. The short version: get_tree_summary({scope:"bookmarks"}) for size, then get_bookmarks' COMPOSABLE OPTS (folders_only to find a destination, parent+leaves_only for exact ids) rather than a whole-tree read or a paginated walk, then create_folder + move_node / bulk_apply (scope:"bookmarks"). Surface the backup warning from BOOKMARK SCOPE RECOVERY below before any destructive bookmark op.

  "find / remove duplicate bookmarks" / "dedupe"
    -> find_duplicates({scope:"bookmarks"}), then ASK whether to (1) move duplicates to a 'Duplicates' folder for review or (2) delete them directly via bulk_apply delete_node({confirmedByUser:true}). Present both as equal options; don't default-pick.

  "do I already have this saved" / "is this URL in any of my libraries"
    -> find_duplicates({scope:"cross-scope"}) (defaults to tree + bookmarks + all libraries; narrow via crossScopes). Each set's sourceScopes[] / sourceLibraryIds[] tells you where each copy lives; route downstream bulk_apply ops per scope (one batch per scope, NOT one outer scope).

  "find all my items tagged X" / "memo containing Z" / "search my bookmarks/libraries/notes for ..."
    -> search_pinako (literal substring; scope param picks the surface: "libraries-all" for cross-library lookups, "bookmarks", "notes", "all"). For a named specific tag MUST pass exact_tag:true (substring "food" over-matches "football"). Do NOT call list_libraries({include_tabs:true}) and grep in your head when search_pinako does it bridge-side in one call.

  "how many tabs / items do I have" / "how big is X" / any pure COUNT question
    -> get_tree_summary({scope}) FIRST. Exact counts + cheap structural overview. Never count by searching (search tools are substring finders, not counters) and never pull the whole tree just to tally it.

  Questions about Pinako features / terminology / "how does X work"
    -> search_docs FIRST. "Group", "folder", "memo", "ghost tab", "library group", "snapshot" have product-specific meanings; never guess from the term alone. Excerpts are 500 chars, so pass full_sections:true when you need the whole answer rather than the section's name. search_docs({query:"orientation", full_sections:true}) returns the capabilities map if you're starting cold.

  A browser-data task when you don't yet know which browser to act on
    -> list_browsers FIRST; if more than one browser shows, ASK the user which (see MULTI-BROWSER below). Exception: the user named a browser in the request itself.

SEARCH SCOPE - semantic vs literal:
LITERAL (user names an exact substring, domain, tag value, or title fragment) -> search_pinako / search_tabs.
SEMANTIC / categorical (user names a topic: "my exercise tabs", "anything about gardening") -> do NOT iterate synonym searches; you will miss items AND burn round-trips. Read the surface cheaply - get_tree({mode:"minimal"}) for the main tree, list_libraries({include_tabs:true, mode:"minimal"}) for libraries - and classify every item with your own understanding. WEIGHT CONTAINER ANCESTORS: an enclosing Window Group / browser Tab Group / Folder / Window / Library title is deliberate categorization - treat every tab inside a group named "Recipes" as a recipe unless its own title/url clearly says otherwise. But a matching container is an INCLUSION signal, NOT a filter: classify EVERY item on its own merits and include matches outside any on-topic container. Never treat an ancestor TAB's title as a category signal (tabs can nest under unrelated tabs). When container context matters, read "lite" (tree shape) rather than "minimal" (flat).

Both patterns cover tree + libraries by default. Search BOOKMARKS only when the user says "bookmark(s)". Broad words alone ("everywhere", "all") do NOT pull in bookmarks - bookmark trees can run 10K+ links. Exception: a small collection (<=600 links) may be auto-included on a broad query; larger, search tree + libraries first, then ASK before adding bookmarks. search_pinako enforces this on scope:"all" - honor its bookmarksSkipped notice by asking, then re-call with include_bookmarks:true.

Include NOTE content only when the user explicitly says "notes" - notes are rich-text docs attached to a tree or library, not to tabs; conflating "a tab about X" with "a note mentioning X" misleads the user.

Report search results BY SOURCE, not as a bare total: "24 total - 3 live tabs, 8 ghosts in the main tree, 11 in 'Travel' library, 2 in 'Research' library."

Scope-override phrases: "main tree only" -> skip libraries; "libraries only" / "in library X" -> constrain accordingly; any "bookmark(s)" phrase -> add bookmarks.

WRITE TOOLS (Pro tier 1+). Rules that span tools:
- Rename rules: set_library_title renames a library (set_title returns INVALID_TARGET on the library container); set_library_group_title renames the umbrella group; in-library FOLDER nodes (type 'library-folder') rename via set_title.
- Delete rules: delete_library removes one library; delete_library_group removes the group (with cascadeMembers:true, also its member libraries). To detach a library from a group without deleting content, use remove_library_from_group.
- Panel reordering: ALWAYS call list_libraries first and build from its returned groups + panel_order - never construct the array blindly.
- "MOVE to bookmarks" is two steps: add_to_bookmarks, then delete_node on the source after success (no atomic move in v1).

STRUCTURE RULES (tree + library organization):
- "Folder" is ONE concept - never reason about folder vs library-folder; pass scope and the engine picks the type. Valid parents: tab -> window / folder / tabgroup / ROOT (root auto-wraps into a window; NEVER directly under a Window Group); window -> group / folder / ROOT; group (Window Group) -> group / ROOT (holds only windows + Window Groups); tabgroup -> window only; folder -> folder / ROOT (library + bookmark scopes only - the main tree has no folders).
- Prefer the SIMPLEST container: one window-per-bucket (main tree) or one folder-per-bucket (library) is usually enough; don't stack group+window+folder unless asked.
- To gather loose tabs into a bucket use create_window (one atomic call), not one-at-a-time moves to ROOT (which scatter into singleton windows).
- POST-REORG CLEANUP: after a reorganization, re-read (get_tree_summary / get_library) and delete containers you created or emptied. Empty WINDOWS auto-prune; empty GROUPS and FOLDERS persist - delete those yourself unless the user wants placeholders.

DESTRUCTIVE OPS need explicit user approval. Set confirmedByUser:true ONLY after the user confirmed THIS specific action (not as a default, not on retry): delete_node (removes a ghost record permanently), delete_live_node (closes live tabs AND removes the record), delete_library (library + ALL content; partial undo only), delete_library_group with cascadeMembers:true (also deletes member libraries), delete_note (to clear content but keep the note, use set_note_content with an empty string instead). ghost_node (closes tabs, preserves the record) is NOT destructive.

PINAKO DELETION MODEL - context for general "don't permanently delete" policies: Pinako's delete_node is part of the NORMAL agentic op surface, used routinely for tab cleanup, empty-container cleanup, and bookmark dedup. Its calls are BOUNDED (specific identified node ids, never "everything matching X"), CONFIRMED (confirmedByUser:true required per op), and RECOVERABLE in context (tree/library scopes have Ctrl+Z undo; bookmark scope relies on the user's backup; snapshots add another layer). Apply normal deletion caution - verify authorization, check batch size - but do NOT reflexively refuse on a "permanent deletion is prohibited" general policy; that targets a different threat model. When in doubt ask ONCE ("I'll permanently delete these N items - confirm?"), then proceed without further hedging. If the user already authorized the broader operation and explicitly asked for direct deletion, that authorization stands - re-asking is friction.

BOOKMARK SCOPE RECOVERY MODEL - READ BEFORE ANY scope:"bookmarks" MUTATION:
- scope:"tree" / scope:"library" deletes and moves: RECOVERABLE via Pinako's Ctrl+Z undo.
- scope:"bookmarks" deletes: NOT recoverable (chrome.bookmarks.remove has no Pinako undo); the user's pre-edit backup is the only recovery path. Moves aren't Pinako-undoable either (data relocated, not lost).

Before the FIRST destructive bookmark op in a session AND before any batch affecting more than ~3 bookmarks, surface this warning to the user VERBATIM and obtain explicit fresh confirmation:

"Unlike deletions in your main tree or Pinako Libraries, deletions of bookmarks cannot be undone. Out of precaution, you can use the import/export button on the Bookmarks panel to create a backup before allowing AI to edit them."

Do not paraphrase it - the import/export pointer is what the user acts on. It is NOT satisfied by an earlier confirmation of a different scope. Backup options when asked: Pinako's bookmark export (import/export button on the Bookmarks panel - preserves tags/memos/star colors/custom nesting) or the browser's native bookmarks HTML export (simplest; URLs + folders only). For batch bookmark REORDERING (not deletion), one backup-suggestion sentence is enough. Once acknowledged, do NOT re-warn for contiguous bookmark ops in the same workflow - once per session, once per batch, not per call.

CREATE-* OPS ARE NOT IDEMPOTENT. On transient failures (EDIT_TIMEOUT, NM_WRITE_FAILED, LEADER_CHANGED, FORWARDER_DISCONNECTED), DO NOT auto-retry - query state first (list_libraries / get_library / get_main_tree_notes) to check whether the previous attempt succeeded, or you may silently create duplicates.

DELETE/GHOST OPS ARE IDEMPOTENT-ON-RETRY. NODE_NOT_FOUND (delete_node) or NODE_NOT_LIVE (ghost_node) on a retry typically means the previous call succeeded - treat as success rather than re-asking the user.

ERROR HANDLING. Every write returns {ok:true, ...result} or {ok:false, error:{code, message, context}}. Branch on error.code (CONFIRMATION_REQUIRED -> ask the user; NOTE_CONTENT_OVER_TIER_LIMIT -> trim or warn; LIBRARY_NOT_FOUND -> re-fetch list_libraries; bulk_apply errors carry context.subOpIndex to pinpoint the failing sub-op).

DATA MODEL. The tab tree is hierarchical: Window Groups (type 'group' - Pinako's organizational rows, with title + row color) -> Windows -> Tabs. Each node: id, type, title, url, favIconUrl, tags (string[]), memoText (plain text, max 2500 chars), notes (rich-text docs with title + HTML content), openedDate (Unix ms - when the tab was opened or saved; use for time-based queries like "tabs from last week"), collapsed, children.
- Ghost tabs (chromeId = null) are tabs the user closed but preserved in the tree; re-openable on demand. Treat as saved/bookmarked tabs - NOT currently open.
- Memos are short per-node plain-text snippets; Notes are Tiptap rich-text documents attached per node or per library (a node can have several); Tags are per-node labels.
- Libraries are user-created collections of saved tabs organized into folders - like bookmarks but richer (notes, tags, memos).
- Main Notes are rich-text documents attached to the main tree. Always call them "Main Notes" to the user (internal names like 'globalNotes' / "owner_type:'global'" are legacy - never surface them).

BROWSER TAB GROUPS - the colored, named chips in the browser's own tab strip. The browser owns their title and color; Pinako mirrors them read-only. In the tree a Tab Group is a CONTAINER NODE (type='tabgroup') directly under a window, holding its member tabs as children (tabs nested under a member are members too); empty title is legal. Membership is exactly containment and is controlled by move_node and nothing else - move a tab INTO or OUT OF the tabgroup node. You cannot create, rename, recolor, or dissolve a browser Tab Group - set_title and set_row_color reject tabgroup nodes. Never confuse browser Tab Groups with Window Groups (type='group') or Library Groups.

DOCS LOOKUP. search_docs(query, max_results?) searches Pinako's bundled user guide (~10ms, local, no internet). Call it BEFORE acting when: (1) a Pinako-specific term is uncertain ("memo" vs "note", "folder" vs "group", "ghost tab", "snapshot"); (2) ordinary-English phrasing doesn't map 1:1 to a write tool ("save this tab", "archive these", "color-code by topic"); (3) a complex request needs a capability check before you design a multi-step plan; (4) BEFORE saying "I can't do that" - Pinako has real limits AND unexpected affordances (library groups, snapshots, three-panel view, sync devices, blockchain backup); (5) the user asks how Pinako behaves ("Can I undo this?", "Why didn't this sync?", "Can Pinako sync to mobile?") - answer from the guide, not generic tab-manager intuition. When citing the guide, include the section anchor (e.g. "see #guide-library-groups in your user guide"). Skip it when the request is direct and the tool is obvious ("tag this 'history'" -> set_tags) or the vocabulary is already established this conversation.

REPORTING - summarize, don't enumerate. For any write affecting MORE THAN 5 items, report a COUNT plus destination ("Tagged 14 tabs 'work'", "Moved 30 bookmarks into 'Review'"), NOT the item list. 5 or fewer: a short list is fine. If the user asks "which ones?", enumerate then. Hard rule across every item type. (A search the user explicitly asked to SEE is different - the list is the answer; still lead with the count + by-source breakdown for large sets.)

WRITES across multi-source results: ONE bulk_apply per scope (one for scope:'tree', one per affected library with scope:'library'+libraryId). Each bulk_apply is one undo step.

MULTI-BROWSER. The user may run Pinako in several browsers (Chrome + Brave, ...) at once. Each install's tree, libraries, Main Notes, bookmarks, tags, and memos are independent data sources - never assume cross-install identity (accounts, sign-out state, or in-flight sync can diverge them). Tools accept an optional 'browser' parameter (brand like "Brave", or browserId from list_browsers). Selection rules:
- One browser connected: omit 'browser'.
- Multiple connected, none chosen yet this conversation: do NOT guess from memory or the user's "primary" browser. Call list_browsers and ASK, using entry [0] (most recently active, sorted by updatedAt desc) as a suggested default with both options visible: "I see multiple browsers open; <X> looks most recently active. Work there, or in <Y>?" Exception: the user named a browser in the request itself - use it directly.
- After the user names a browser, it is the STICKY default for the rest of the conversation - reuse it on every call, don't re-ask, don't split work across browsers.
- Focus-shift exception: if a DIFFERENT browser's updatedAt becomes newer than the sticky choice's, ask once: "I noticed recent activity in <X>. Apply this to <X>, stay on <Y>, or both?" Then adopt the answer. updatedAt advances on any tree mutation, not strictly focus - treat as a heuristic and don't re-fire until it shifts again.
- Explicit overrides ("in both browsers", "do it in Chrome instead") win for that call; durable phrasing ("from now on use Chrome") updates the sticky default.

LARGE READS. Manage response cost via the shape opts (minimal:true for basics-only; selectively disable include_* fields the question doesn't need) and pagination (after + limit) when chunking big surfaces - pagination is the only safe way to traverse 10K+ bookmark trees.

CONNECTION RECOVERY. If a tool returns "No data yet - open the Pinako extension first", or list_browsers is unexpectedly empty, the extension's connection to this server has lapsed (PC sleep/wake, browser restart, extended idle). Tell the user to open the Pinako popup (click the Pinako icon in the browser toolbar) - that re-establishes the connection; no client restart needed.

For complete documentation, see: https://pinako.pro/docs/ai-connect`;

// serverInfo advertised in the MCP initialize response. `icons` (SEP-973) is
// what Claude Desktop renders beside the connector name — without it a local
// (stdio) connector falls back to a generic lettered avatar while the cloud
// connector, which does send icons, shows the logo. `title` + `websiteUrl`
// give clients a human label + link beyond the protocol `name`. Mirrors
// supabase/functions/mcp-server/index.ts SERVER_INFO.
const SERVER_INFO = {
  name: 'pinako',
  title: 'Pinako',
  version: pkg.version,
  websiteUrl: 'https://pinako.pro',
  icons: PINAKO_ICONS,
};

function createMcpServer() {
  const srv = new McpServer(
    SERVER_INFO,
    { instructions: SERVER_INSTRUCTIONS }
  );

  const BROWSER_ARG_DESC = 'Which Pinako install to query (browser brand like "Brave" or "Chrome", or browserId from list_browsers). Omit when only one browser is connected. When multiple are connected and the user has not yet chosen one this conversation, do NOT guess this value from memory or the user\'s "primary" browser — call list_browsers and ask the user (see MULTI-BROWSER in server instructions). After the user has chosen, reuse that value for the rest of the conversation.';

  // Slice Y (2026-05-12): the bridge cache auto-refreshes on user activity
  // within ~1-2s via popup-side debounced pushTreeUpdate. This hint appended
  // to every Slice-Y-covered read tool teaches the agent to re-invoke fresh
  // when the user reports a change, rather than relying on prior conversation
  // responses that may pre-date the user's activity.
  const FRESHNESS_HINT = ' Cache is auto-refreshed on user activity within ~1-2s. For any "what\'s there now" or "current state" question, re-invoke this tool rather than relying on prior responses in this conversation. If the user references data that doesn\'t appear in your most recent tool response (a tab, library, note, or property they say they added or changed), re-invoke immediately rather than telling them you can\'t find it. The user\'s report is the source of truth; the cache may simply have refreshed since your last call.';

  // Common helper: normalize a caller's `mode` arg.
  const _normalizeMode = (m) => MODES.has(m) ? m : 'lite';

  // ─── MCP-spec tool annotations (2026-05-14) ─────────────────────────────────
  // Per the 2025-11-25 MCP spec ToolAnnotationsSchema, every tool registration
  // can carry `readOnlyHint`, `destructiveHint`, `idempotentHint`,
  // `openWorldHint`. Spec-aware MCP clients use these hints to differentiate
  // auto-approval policy: read-only tools can be auto-approved without a per-
  // call user prompt, destructive tools always prompt, etc.
  //
  // Bucketing rule (data-mutation perspective):
  //   READ_ONLY        — does not modify user data. Includes pure data reads
  //                      AND tools that have UI-only side effects but don't
  //                      touch the tree/library/bookmark/note state
  //                      (auto_organize_bookmarks opens a panel,
  //                      complete_organize_sort transitions panel state,
  //                      record_observation writes to bridge-side ephemeral
  //                      log only). 21 tools.
  //   EDIT             — modifies user data but additively / reversibly.
  //                      set_*, add_*, create_*, move_*, indent_*, outdent_*,
  //                      reorder_*, ghost_node, add_to_library, etc. 26 tools.
  //   DESTRUCTIVE      — permanent data loss without explicit recovery path.
  //                      delete_node, delete_live_node, delete_library,
  //                      delete_library_group, delete_note, ghost_node.
  //                      bulk_apply marked destructive because it can carry
  //                      delete sub-ops. 6+1 tools.
  //
  // openWorldHint=false on every Pinako tool — the surface is closed: local
  // browser data only, no external network calls.
  const READ_ONLY = { readOnlyHint: true,  openWorldHint: false };
  const EDIT      = { readOnlyHint: false, destructiveHint: false, idempotentHint: true,  openWorldHint: false };
  const EDIT_NID  = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }; // create_*, add_to_library
  const DESTRUCT  = { readOnlyHint: false, destructiveHint: true,  idempotentHint: true,  openWorldHint: false };
  const COMPOSITE = { readOnlyHint: false, destructiveHint: true,  idempotentHint: false, openWorldHint: false }; // bulk_apply: variable
  const TOOL_ANNOTATIONS = {
    // Read-only (10) — safe to auto-approve in client autoApprove arrays.
    // Phase 4.5-F (2026-05-20): the 11 auto-organize MCP tools
    // (auto_organize_bookmarks, apply_heuristic_organize, propose_categories,
    // propose_subcategories, refine_folder_outliers, resolve_duplicate_landings,
    // complete_organize_sort, summarize_organize_results, get_organize_state,
    // record_observation, get_observations) were removed when the
    // auto-organize workflow migrated to the extension's native AI chat
    // panel. The popup orchestrator drives the workflow deterministically
    // there; the MCP route has no surface for it.
    get_tree:                       READ_ONLY,
    search_tabs:                    READ_ONLY,
    search_pinako:                  READ_ONLY,
    list_libraries:                 READ_ONLY,
    get_library:                    READ_ONLY,
    get_main_tree_notes:            READ_ONLY,
    get_bookmarks:                  READ_ONLY,
    list_browsers:                  READ_ONLY,
    find_duplicates:                READ_ONLY,
    get_tree_summary:               READ_ONLY,
    search_docs:                    READ_ONLY,
    // Edit, idempotent (17) — set_X, add/remove tags, structure changes that
    // converge on a single end state when called repeatedly.
    set_tags:                       EDIT,
    add_tags:                       EDIT,
    remove_tags:                    EDIT,
    set_memo:                       EDIT,
    set_star_color:                 EDIT,
    set_row_color:                  EDIT,
    set_title:                      EDIT,
    set_note_content:               EDIT,
    set_library_group_title:        EDIT,
    set_library_group_description:  EDIT,
    set_library_title:              EDIT,
    set_library_description:        EDIT,
    reorder_library_panel:          EDIT,
    reorder_libraries_in_group:     EDIT,
    move_node:                      EDIT,
    add_library_to_group:           EDIT,
    remove_library_from_group:      EDIT,
    // Edit, NOT idempotent (9) — create_* duplicates on retry per
    // SERVER_INSTRUCTIONS "CREATE-* OPS ARE NOT IDEMPOTENT" rule.
    create_group:                   EDIT_NID,
    create_window:                  EDIT_NID,
    create_folder:                  EDIT_NID,
    create_library:                 EDIT_NID,
    create_note:                    EDIT_NID,
    create_library_group:           EDIT_NID,
    add_to_library:                 EDIT_NID,
    add_to_bookmarks:               EDIT_NID,
    indent_node:                    EDIT_NID,
    outdent_node:                   EDIT_NID,
    // Destructive (6) — delete_* / ghost_node permanently or near-permanently
    // remove data. Idempotent on retry per SERVER_INSTRUCTIONS
    // "DELETE/GHOST OPS ARE IDEMPOTENT-ON-RETRY" rule.
    delete_node:                    DESTRUCT,
    delete_live_node:               DESTRUCT,
    delete_library:                 DESTRUCT,
    delete_library_group:           DESTRUCT,
    delete_note:                    DESTRUCT,
    ghost_node:                     DESTRUCT,
    // Composite (1) — variable; can carry destructive sub-ops.
    bulk_apply:                     COMPOSITE,
  };

  srv.registerTool(
    'get_tree',
    {
      description:
        'Returns the tab tree (Window Groups → Windows → Tabs; type="tabgroup" container nodes mirror the browser\'s own Tab Groups, holding their member tabs as children). Default "lite": tree shape with children/collapsed/ghost, full URLs, plus tags, memos, openedDate, Tab Group metadata, and colors when present. Shape control: minimal:true = basics-only (id/type/title/url/ghost — cheap large-tree scans); individual include_*:false opts drop a field group; include_favicons:true opts INTO per-tab favIconUrl base64 (heavy, 1-3KB/tab, useful only for favicon-color workflows). Legacy mode enum: "minimal" (FLAT compact list — best for semantic scans across 500+ tab trees), "lite" (default), "full" (everything except favicons); composable opts take precedence over mode. ' +
        'PAGINATION: pass `after` (last-seen node id) and/or `limit` (default 500) for a FLAT paged response {items[], nextCursor, totalItems}; items carry parentId to reconstruct hierarchy; if the cursor node moved between calls, pagination restarts from 0 (moved items no longer appear, so progress continues). ' +
        'For counts or a structural overview prefer get_tree_summary; for a substring lookup prefer search_pinako (cheaper than enumerating).' +
        FRESHNESS_HINT,
      inputSchema: {
        mode: z.enum(['minimal', 'lite', 'full']).optional().describe('Legacy response mode. Default "lite". Composable opts (minimal + include_*) take precedence when both are passed.'),
        include_ghost_tabs: z.boolean().optional().describe('Include closed/ghost tabs (chromeId=null). Default true.'),
        include_favicons:   z.boolean().optional().describe('Include favIconUrl base64 data per tab. Default false. Heavy: 1-3KB per tab. Set true only for color-organize workflows that sample favicon colors.'),
        after:              z.string().optional().describe('Pagination cursor: last-seen node id from a previous paginated call. Omit on the first call. When present, returns items AFTER this id in DFS pre-order.'),
        limit:              z.number().int().min(1).max(5000).optional().describe('Max items per page. Default 500 when pagination is active. Triggers paginated response when set even without `after`.'),
        browser: z.string().optional().describe(BROWSER_ARG_DESC),
        // ── Composable shape opt-ins (active when mode is "lite" or unset) ──
        minimal:                   z.boolean().optional().describe('Shortcut: when true, forces every include_* flag to false. Returns basics-only (id, type, title, scope, libraryId, url, ghost flag) per node. Use for cheap large-tree scans.'),
        include_opened_date:       z.boolean().optional().describe('Include openedDate on tab nodes (Unix ms timestamp). Default true.'),
        include_tags:              z.boolean().optional().describe('Include the tags array per node. Default true.'),
        include_memos:             z.boolean().optional().describe('Include memoText per node. Default true.'),
        include_lineage:           z.boolean().optional().describe('Include the collapsed flag (which subtrees the user has folded up). Default true. Tree position/ancestry needs no flag — the nested children structure conveys it (or parentId in minimal/paginated mode).'),
        include_chrome_tab_groups: z.boolean().optional().describe('Include chromeGroupId + chromeGroupTitle + chromeGroupColor metadata on tab nodes (the colored-strip Tab Group in the browser\'s own tab bar, mirrored read-only). Member tabs derive these fields from their tabgroup ancestor, and the tabgroup node itself carries chromeGroupId + chromeGroupColor. NOT to be confused with Window Groups (type="group"), which are always returned as nodes regardless of this flag. Default true.'),
        include_star_color:        z.boolean().optional().describe('Include per-node starColor when set. Default true (cheap when absent).'),
        include_row_color:         z.boolean().optional().describe('Include per-node rowColor when set (Window Group / Folder background tint). Default true (cheap when absent).'),
        include_custom_title:      z.boolean().optional().describe('Include the customTitle flag indicating a user-customized title. Default true (cheap when absent).'),
      },
      annotations: TOOL_ANNOTATIONS.get_tree,
    },
    async (args) => {
      let { mode, include_ghost_tabs = true, include_favicons = false, after, limit, browser } = args;
      mode = _normalizeMode(mode);
      const shapeOpts = _extractShapeOpts(args);
      const r = resolveBrowserData(browser);
      if (r.error) return r.error;
      const tree = getTree(r.data, include_ghost_tabs);

      // Slice S2a: paginated path. Returns a flat items[] + nextCursor.
      if (_isPaginationRequested(after, limit)) {
        const effectiveLimit = Number.isFinite(limit) && limit > 0 ? limit : PAGINATION_DEFAULT_LIMITS.tree;
        const flat = _flattenTreeWithMode(tree, 'tree', null, mode, include_favicons, shapeOpts);
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

      const out  = shapeTree(tree, 'tree', null, mode, include_favicons, shapeOpts);

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
      description: 'LITERAL substring search across main-tree TAB nodes ONLY (no groups/windows/folders/libraries/bookmarks/notes). Matches title, URL, memo, tags. Legacy — prefer search_pinako (omnibus, scope-aware) unless you specifically mean live tabs only. For SEMANTIC / categorical intent do NOT iterate this with synonyms — read the surface and classify (SEARCH SCOPE in server instructions). Results use the same composable shape as get_tree (mode default "minimal" here since results are already a focused list; opts take precedence over mode).' + FRESHNESS_HINT,
      inputSchema: {
        query: z.string().describe('LITERAL substring (case-insensitive). For semantic intent, prefer get_tree.'),
        mode:  z.enum(['minimal', 'lite', 'full']).optional().describe('Legacy response mode. Default "minimal" since search results are already a focused list. Composable opts (minimal + include_*) take precedence when both are passed.'),
        include_ghost_tabs: z.boolean().optional().describe('Include closed/ghost tabs. Default true.'),
        include_favicons:   z.boolean().optional().describe('Include favIconUrl base64. Default false. Heavy: 1-3KB per tab.'),
        browser: z.string().optional().describe(BROWSER_ARG_DESC),
        // ── Composable shape opt-ins (active when mode is "lite" or unset) ──
        minimal:                   z.boolean().optional().describe('See get_tree.'),
        include_opened_date:       z.boolean().optional().describe('See get_tree.'),
        include_tags:              z.boolean().optional().describe('See get_tree.'),
        include_memos:             z.boolean().optional().describe('See get_tree.'),
        include_lineage:           z.boolean().optional().describe('See get_tree.'),
        include_chrome_tab_groups: z.boolean().optional().describe('See get_tree.'),
        include_star_color:        z.boolean().optional().describe('See get_tree.'),
        include_row_color:         z.boolean().optional().describe('See get_tree.'),
        include_custom_title:      z.boolean().optional().describe('See get_tree.'),
      },
      annotations: TOOL_ANNOTATIONS.search_tabs,
    },
    async (args) => {
      let { query, mode, include_ghost_tabs = true, include_favicons = false, browser } = args;
      if (typeof query !== 'string' || query.trim().length === 0) {
        return { content: [{ type: 'text', text: JSON.stringify({
          error: { code: 'EMPTY_QUERY', message: 'query must be a non-empty substring. search_tabs is a literal substring finder, not a counter — an empty query is not a valid "match everything". To COUNT tabs or get a structural overview, call get_tree_summary; to ENUMERATE every tab, call get_tree.' },
        }) }], isError: true };
      }
      mode = _normalizeMode(mode || 'minimal');
      const shapeOpts = _extractShapeOpts(args);
      const r = resolveBrowserData(browser);
      if (r.error) return r.error;
      const stamps  = [];
      const results = searchInTree(r.data.tree, query, include_ghost_tabs, [], stamps);
      // Lite hits are shaped one-by-one so each carries its own tabgroup
      // ancestor stamp (N5); minimal and full emit no chromeGroup* fields, so
      // they stay on the shared shapeTree path.
      const out     = (mode === 'lite')
        ? results.map((n, i) => liteNode(
            n, 'tree', null,
            stamps[i] ? Object.assign({}, shapeOpts, { _tgAncestor: stamps[i] }) : shapeOpts))
        : shapeTree(results, 'tree', null, mode, include_favicons, shapeOpts);
      return { content: [{ type: 'text', text: JSON.stringify({
        browser: r.data.browserBrand,
        mode,
        results: out,
        count:   out.length,
      }) }] };
    }
  );

  srv.registerTool(
    'search_pinako',
    {
      description: 'Omnibus LITERAL substring search across Pinako surfaces — the broad replacement for search_tabs. Bridge-side scan, no LLM. Matches non-tab nodes too (groups, folders, library/note titles) — the gap search_tabs has. Use WHENEVER the user names a literal substring. NOT for SEMANTIC / categorical intent ("my recipe tabs", "anything about X"): literal matching silently MISSES members whose title/url lacks the query word — read the surface and classify yourself instead (SEARCH SCOPE in server instructions). Do NOT fetch-and-filter (list_libraries + grep in your head) when this does it bridge-side in one call. ' +
        'SCOPES (default match_fields): "tree" default (title,url,tags,memo,flag) · "library" = one library, library_id required (same fields) · "libraries-all" = union across every library, hits carry sourceLibraryId (same fields) · "bookmarks" (title,url,flag — bookmarks carry no Pinako tags/memos) · "notes" = library notes + Main Notes, hits carry a 200-char snippet (title,content) · "all" = tree + libraries + notes, plus bookmarks ONLY when the collection is ≤600 links or include_bookmarks:true — larger collections return a bookmarksSkipped notice instead (ask the user, then re-call). ' +
        'For a specific named tag MUST set exact_tag:true (substring "food" otherwise leaks "football"). ' +
        'RESPONSE: flat results[] in discovery order — type, scope, nodeId/noteId, title, matchedFields, parentPath, plus url / tags / memoText / flag / snippet / ghost / sourceLibraryId when applicable; truncated:true when the limit was hit (narrow the query/scope or raise limit).' + FRESHNESS_HINT,
      inputSchema: {
        query:              z.string().describe('LITERAL substring (case-insensitive). For semantic intent, prefer get_tree/list_libraries + in-head matching.'),
        scope:              z.enum(['tree', 'library', 'libraries-all', 'bookmarks', 'notes', 'all']).optional().describe('Which data surface to search. Default "tree".'),
        library_id:         z.string().optional().describe('Library id from list_libraries. Required when scope:"library".'),
        match_fields:       z.array(z.enum(['title', 'url', 'tags', 'memo', 'flag', 'content'])).optional().describe('Which fields to match. Defaults are scope-aware: tree/library/libraries-all default to ["title","url","tags","memo","flag"]; bookmarks defaults to ["title","url","flag"]; notes defaults to ["title","content"]; "all" scope uses the scope-appropriate default per surface. "flag" matches the user-named star-color label (e.g. a color named "Important"); hits carry it as `flag`. "content" only applies to notes scope; for other scopes it is ignored.'),
        exact_tag:          z.boolean().optional().describe('When true, tag matches must equal the query exactly (case-insensitive). When false (default), tag matches use substring semantics. Use exact_tag:true whenever the user names a specific tag.'),
        include_ghost_tabs: z.boolean().optional().describe('Include closed/ghost tabs in tree scope. Default true.'),
        include_bookmarks:  z.boolean().optional().describe('Set true ONLY after the user confirms they want their browser bookmarks searched in a broad scope:"all" query. Bypasses the >600-link confirmation gate. No effect on other scopes (scope:"bookmarks" always searches them; tree/library/notes never do).'),
        limit:              z.number().int().min(1).max(2000).optional().describe('Max results across all surfaces in this call. Default 200.'),
        browser:            z.string().optional().describe(BROWSER_ARG_DESC),
      },
      annotations: TOOL_ANNOTATIONS.search_pinako,
    },
    async ({ query, scope = 'tree', library_id, match_fields, exact_tag = false, include_ghost_tabs = true, include_bookmarks = false, limit, browser }) => {
      if (typeof query !== 'string' || query.length === 0) {
        return { content: [{ type: 'text', text: JSON.stringify({
          error: { code: 'EMPTY_QUERY', message: 'query must be a non-empty string' },
        }) }], isError: true };
      }
      const r = resolveBrowserData(browser);
      if (r.error) return r.error;

      const effectiveLimit = Number.isFinite(limit) && limit > 0 ? Math.min(limit, 2000) : 200;
      // S3.8 §7.4: 'flag' (the user's star label) joins the tree/library and
      // bookmark defaults — parity with the native chat route's defaults.
      const treeFields     = (Array.isArray(match_fields) && match_fields.length > 0) ? match_fields : ['title', 'url', 'tags', 'memo', 'flag'];
      const bookmarkFields = (Array.isArray(match_fields) && match_fields.length > 0) ? match_fields : ['title', 'url', 'flag'];
      const noteFields     = (Array.isArray(match_fields) && match_fields.length > 0) ? match_fields : ['title', 'content'];
      const flagLabels     = r.data.flagLabels || null;

      const results = [];
      let bookmarksSkipped = null;

      function runTree() {
        _searchInTreeOmni({
          tree:            r.data.tree || [],
          query, scope:    'tree',
          sourceLibraryId: null,
          matchFields:     treeFields,
          exactTag:        exact_tag,
          includeGhost:    include_ghost_tabs,
          limit:           effectiveLimit,
          results,
          flagLabels,
        });
      }
      function runLibrary(lib) {
        _searchInTreeOmni({
          tree:            lib.children || [],
          query, scope:    'library',
          sourceLibraryId: lib.id,
          matchFields:     treeFields,
          exactTag:        exact_tag,
          includeGhost:    true,
          limit:           effectiveLimit,
          results,
          flagLabels,
        });
      }
      function runBookmarks() {
        _searchInTreeOmni({
          tree:            r.data.bookmarks || [],
          query, scope:    'bookmarks',
          sourceLibraryId: null,
          matchFields:     bookmarkFields,
          exactTag:        exact_tag,
          includeGhost:    true,
          limit:           effectiveLimit,
          results,
          flagLabels,
        });
      }
      function runNotes() {
        for (const lib of (r.data.libraries || [])) {
          if (results.length >= effectiveLimit) return;
          _searchInNotes({
            notesArray:      lib.notes,
            query, scope:    'library-notes',
            sourceLibraryId: lib.id,
            matchFields:     noteFields,
            limit:           effectiveLimit,
            results,
          });
        }
        if (results.length < effectiveLimit) {
          _searchInNotes({
            notesArray:      r.data.globalNotes,
            query, scope:    'main-tree-notes',
            sourceLibraryId: null,
            matchFields:     noteFields,
            limit:           effectiveLimit,
            results,
          });
        }
      }

      if (scope === 'tree') {
        runTree();
      } else if (scope === 'bookmarks') {
        runBookmarks();
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
        runLibrary(lib);
      } else if (scope === 'libraries-all') {
        for (const lib of (r.data.libraries || [])) {
          if (results.length >= effectiveLimit) break;
          runLibrary(lib);
        }
      } else if (scope === 'notes') {
        runNotes();
      } else if (scope === 'all') {
        runTree();
        if (results.length < effectiveLimit) {
          for (const lib of (r.data.libraries || [])) {
            if (results.length >= effectiveLimit) break;
            runLibrary(lib);
          }
        }
        // Bookmark gate: a broad "all" search includes the bookmark tree only
        // when it's small (≤ threshold links) or the user confirmed via
        // include_bookmarks. Large bookmark collections dominate the result
        // budget and burn tokens without adding signal, so skip them and
        // surface a bookmarksSkipped notice for the agent to act on.
        const bookmarkLeafCount = (r.data.bookmarks || []).reduce((acc, root) => acc + countBookmarksRecursive(root), 0);
        if (include_bookmarks || bookmarkLeafCount <= BOOKMARK_SEARCH_CONFIRM_THRESHOLD) {
          if (results.length < effectiveLimit) runBookmarks();
        } else {
          bookmarksSkipped = {
            bookmarkCount: bookmarkLeafCount,
            threshold:     BOOKMARK_SEARCH_CONFIRM_THRESHOLD,
            message:       `Broad search skipped your browser bookmarks because there are ${bookmarkLeafCount} of them (above the ${BOOKMARK_SEARCH_CONFIRM_THRESHOLD}-link threshold where they add cost and noise without signal). Tell the user their browser bookmarks were not searched and ask whether to include them; if they confirm, re-call with include_bookmarks:true (or scope:"bookmarks" to search only that surface).`,
          };
        }
        if (results.length < effectiveLimit) runNotes();
      }

      return { content: [{ type: 'text', text: JSON.stringify({
        browser:   r.data.browserBrand,
        browserId: r.data.browserId,
        query,
        scope,
        libraryId:           scope === 'library' ? library_id : null,
        matchFieldsApplied: Array.isArray(match_fields) && match_fields.length > 0 ? match_fields : 'scope-default',
        exactTag:           exact_tag,
        limit:              effectiveLimit,
        results,
        count:              results.length,
        truncated:          results.length >= effectiveLimit,
        ...(bookmarksSkipped ? { bookmarksSkipped } : {}),
      }) }] };
    }
  );

  srv.registerTool(
    'list_libraries',
    {
      description: 'Lists all Pinako libraries. Default: id, title, description, tabCount, note metadata (id+title, NO content — use get_library({mode:"full"}) for note bodies). include_tabs:true embeds every library\'s tabs (the right call for cross-library searches, avoiding N get_library round-trips; embedded default mode "minimal", shape opts per get_tree). Also returns panel structure (groups + panel_order) — ALWAYS call this before reorder_library_panel to source fresh ids and positions. ' +
        'PAGINATION: `after` (last-seen library id) + `limit` (default 50) chunk the libraries array only — groups and panel_order always return in full.' + FRESHNESS_HINT,
      inputSchema: {
        include_tabs: z.boolean().optional().describe('Embed each library\'s tabs in the response. Default false. Use this for cross-library semantic search in one call.'),
        mode:         z.enum(['minimal', 'lite', 'full']).optional().describe('Legacy mode for embedded tabs (only used when include_tabs:true). Default "minimal". Composable opts (minimal + include_*) take precedence when both are passed.'),
        include_favicons: z.boolean().optional().describe('Include favIconUrl base64 on embedded tabs. Default false. Heavy: 1-3KB per tab.'),
        after:        z.string().optional().describe('Pagination cursor: last-seen library id from a previous paginated call. Omit on the first call.'),
        limit:        z.number().int().min(1).max(500).optional().describe('Max libraries per page. Default 50 when pagination is active.'),
        browser:      z.string().optional().describe(BROWSER_ARG_DESC),
        // ── Composable shape opt-ins (apply to embedded children when include_tabs:true and mode is "lite" or unset) ──
        minimal:                   z.boolean().optional().describe('See get_tree (applies when include_tabs).'),
        include_opened_date:       z.boolean().optional().describe('See get_tree (applies when include_tabs).'),
        include_tags:              z.boolean().optional().describe('See get_tree (applies when include_tabs).'),
        include_memos:             z.boolean().optional().describe('See get_tree (applies when include_tabs).'),
        include_lineage:           z.boolean().optional().describe('See get_tree (applies when include_tabs).'),
        include_chrome_tab_groups: z.boolean().optional().describe('See get_tree (applies when include_tabs).'),
        include_star_color:        z.boolean().optional().describe('See get_tree (applies when include_tabs).'),
        include_row_color:         z.boolean().optional().describe('See get_tree (applies when include_tabs).'),
        include_custom_title:      z.boolean().optional().describe('See get_tree (applies when include_tabs).'),
      },
      annotations: TOOL_ANNOTATIONS.list_libraries,
    },
    async (args) => {
      let { include_tabs = false, mode, include_favicons = false, after, limit, browser } = args;
      mode = _normalizeMode(mode || 'minimal');
      const shapeOpts = _extractShapeOpts(args);
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
          entry.children = shapeTree(lib.children || [], 'library', lib.id, mode, include_favicons, shapeOpts);
        }
        return entry;
      });

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
      description: 'Returns ONE library\'s contents (children tree + notes). Find the id via list_libraries first. Legacy modes: "minimal" (FLAT compact scan), "lite" (DEFAULT — tree shape, no favicons or note content), "full" (adds rich-text note bodies; favicons still need include_favicons:true). Children use the same composable shape opts as get_tree (opts take precedence over mode). ' +
        'PAGINATION: `after` + `limit` (default 500) return flat items + library metadata + note titles at top level.' + FRESHNESS_HINT,
      inputSchema: {
        library_id: z.string().describe('Library id from list_libraries'),
        mode:       z.enum(['minimal', 'lite', 'full']).optional().describe('Legacy response mode. Default "lite". Composable opts (minimal + include_*) take precedence when both are passed.'),
        include_favicons: z.boolean().optional().describe('Include favIconUrl base64. Default false. Heavy: 1-3KB per tab.'),
        after:      z.string().optional().describe('Pagination cursor: last-seen node id from a previous paginated call. Omit on the first call.'),
        limit:      z.number().int().min(1).max(5000).optional().describe('Max items per page. Default 500 when pagination is active.'),
        browser:    z.string().optional().describe(BROWSER_ARG_DESC),
        // ── Composable shape opt-ins (active when mode is "lite" or unset) ──
        minimal:                   z.boolean().optional().describe('See get_tree.'),
        include_opened_date:       z.boolean().optional().describe('See get_tree.'),
        include_tags:              z.boolean().optional().describe('See get_tree.'),
        include_memos:             z.boolean().optional().describe('See get_tree.'),
        include_lineage:           z.boolean().optional().describe('See get_tree.'),
        include_chrome_tab_groups: z.boolean().optional().describe('See get_tree.'),
        include_star_color:        z.boolean().optional().describe('See get_tree.'),
        include_row_color:         z.boolean().optional().describe('See get_tree.'),
        include_custom_title:      z.boolean().optional().describe('See get_tree.'),
      },
      annotations: TOOL_ANNOTATIONS.get_library,
    },
    async (args) => {
      let { library_id, mode, include_favicons = false, after, limit, browser } = args;
      mode = _normalizeMode(mode);
      const shapeOpts = _extractShapeOpts(args);
      const r = resolveBrowserData(browser);
      if (r.error) return r.error;
      const lib = (r.data.libraries || []).find(l => l.id === library_id);
      if (!lib) return { content: [{ type: 'text', text: `Library not found: ${library_id} (in ${r.data.browserBrand})` }], isError: true };

      // Slice S2a: paginated path. Returns flat items + library metadata.
      // Library notes (titles only) are returned alongside, never paginated
      // (notes are few and small at the metadata level).
      if (_isPaginationRequested(after, limit)) {
        const effectiveLimit = Number.isFinite(limit) && limit > 0 ? limit : PAGINATION_DEFAULT_LIMITS.library;
        const flat = _flattenTreeWithMode(lib.children || [], 'library', library_id, mode, include_favicons, shapeOpts);
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
          children:    (sanitized.children || []).map(c => liteNode(c, 'library', library_id, shapeOpts)),
          notes:       liteNotes(sanitized.notes),
        };
      } else { // full
        const sanitized = sanitizeNode(lib);
        outLib = include_favicons ? sanitized : stripFavicons(sanitized);
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
      description: 'Returns the Main Notes — rich text documents attached to the user\'s main tree (the live tab tree), as opposed to notes attached to a specific library. Cloud-synced, identical across browsers. (Internal field name `globalNotes` is legacy; always surface as "Main Notes" to the user.) ' +
        'PAGINATION (Slice S2a): pass `after` (last-seen note id) and/or `limit` (default 100) to receive notes one batch at a time: {items:[...notes...], nextCursor:..., totalItems:N}. Pagination returns notes in their stored order with full content bodies. Useful when one or two notes are very large.' + FRESHNESS_HINT,
      inputSchema: {
        after:            z.string().optional().describe('Pagination cursor: last-seen note id from a previous paginated call. Omit on the first call.'),
        limit:            z.number().int().min(1).max(1000).optional().describe('Max notes per page. Default 100 when pagination is active.'),
        browser: z.string().optional().describe(BROWSER_ARG_DESC),
      },
      annotations: TOOL_ANNOTATIONS.get_main_tree_notes,
    },
    async ({ after, limit, browser }) => {
      const r = resolveBrowserData(browser);
      if (r.error) return r.error;
      const notes = r.data.globalNotes || [];

      // Slice S2a: paginated path returns notes in stored order with full
      // bodies, sliced by cursor.
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

      return { content: [{ type: 'text', text: JSON.stringify({
        browser: r.data.browserBrand,
        mainTreeNotes: notes,
      }) }] };
    }
  );

  srv.registerTool(
    'get_bookmarks',
    {
      description: 'Returns the browser bookmark tree. Node fields: id (stable Chrome bookmark id — write tools like move_node / delete_node / add_to_library sourceScope:"bookmarks" accept these), title, url (leaves only), children (folders), dateAdded (Unix ms), parentId, index. ' +
        'PREFER the composable opts over fetching the whole tree (cheaper, focused): `parent` (folder id OR case-insensitive title; cascade id → root title → nested-title DFS; direct children only; PARENT_NOT_FOUND returns context.availableRoots for recovery), `folders_only` (flat folder list, each with a `path` breadcrumb like "Bookmarks Bar / Travel / 2024" — cheap full-structure overview, use to find a folder before creating one), `leaves_only` (URL leaves only; pairs with `parent` for "loose items in folder X"), `minimal` (drops dateAdded + index). Filters are mutually exclusive (INVALID_FILTERS) and force a flat items[] shape. ' +
        'PAGINATION (`after`/`limit`, default 500) is the fallback for whole-tree walks: flat DFS pre-order (each folder\'s entire subtree precedes its next sibling); if the cursor node moved, pagination restarts from 0. Default no-param call returns the full nested tree — avoid it on 10K+ trees.' + FRESHNESS_HINT,
      inputSchema: {
        after:               z.string().optional().describe('Pagination cursor: last-seen bookmark id from a previous paginated call. Omit on the first call.'),
        limit:               z.number().int().min(1).max(5000).optional().describe('Max items per page. Default 500 when pagination is active. Triggers paginated response when set even without `after`.'),
        parent:              z.string().optional().describe('Bookmark folder id OR title (case-insensitive). Returns direct children only. Resolution cascade: id → top-level root title → nested folder title DFS.'),
        parent_id:           z.string().optional().describe('Strict-id alias for `parent` (no title fallback). Use this when you have a known id and want to fail fast on a typo rather than letting it fall through to title matching.'),
        leaves_only:         z.boolean().optional().describe('Emit only bookmark URL leaves. Mutually exclusive with folders_only.'),
        folders_only:        z.boolean().optional().describe('Emit only folders. Mutually exclusive with leaves_only. ALWAYS includes a path field on each item.'),
        include_date_added:  z.boolean().optional().describe('No-op on MCP (dateAdded always emitted). Kept for cross-surface symmetry.'),
        minimal:             z.boolean().optional().describe('Drop dateAdded + index from emitted items.'),
        browser:             z.string().optional().describe(BROWSER_ARG_DESC),
      },
      annotations: TOOL_ANNOTATIONS.get_bookmarks,
    },
    async ({ after, limit, parent, parent_id, leaves_only, folders_only, include_date_added: _include_date_added, minimal, browser }) => {
      const r = resolveBrowserData(browser);
      if (r.error) return r.error;
      const bookmarks = r.data.bookmarks || [];

      const parentInput   = typeof parent    === 'string' && parent.length    > 0 ? parent    : null;
      const parentIdInput = typeof parent_id === 'string' && parent_id.length > 0 ? parent_id : null;
      const parentRequested = parentInput || parentIdInput;

      const leavesOnly  = leaves_only  === true;
      const foldersOnly = folders_only === true;
      if (leavesOnly && foldersOnly) {
        return { content: [{ type: 'text', text: JSON.stringify({
          ok: false,
          error: {
            code: 'INVALID_FILTERS',
            message: 'leaves_only and folders_only are mutually exclusive. Pass one, the other, or neither.',
          },
        }) }] };
      }

      const minimalFlag = minimal === true;
      const includePath = foldersOnly; // always emit `path` for folders_only responses
      const shapeOpts   = { leavesOnly, foldersOnly, includePath, minimal: minimalFlag };

      // Resolve parent (id-first, then title cascade). `parent_id` is strict-id only.
      let scopedRoots        = bookmarks;
      let parentResolved     = null;
      let parentResolvedPath = '';
      if (parentRequested) {
        let parentNode = _findBookmarkNodeById(bookmarks, parentRequested);
        if (!parentNode && parentInput) {
          parentNode = _findBookmarkRootByTitle(bookmarks, parentInput);
          if (!parentNode) {
            parentNode = _findBookmarkFolderByTitle(bookmarks, parentInput);
          }
        }
        if (!parentNode) {
          // Build a useful availableRoots hint. Some Chrome variants wrap the
          // real roots in a virtual empty-titled container at the top — walk
          // one level deeper if the top is all empty-titled so availableRoots
          // surfaces real titles like "Bookmarks Bar" / "Other Bookmarks".
          let rootTitles = bookmarks
            .filter(n => n && typeof n.title === 'string' && n.title.length > 0 && Array.isArray(n.children))
            .map(n => n.title);
          if (rootTitles.length === 0 && bookmarks.length > 0) {
            for (const n of bookmarks) {
              if (n && Array.isArray(n.children)) {
                for (const c of n.children) {
                  if (c && typeof c.title === 'string' && c.title.length > 0 && Array.isArray(c.children)) {
                    rootTitles.push(c.title);
                  }
                }
              }
            }
          }
          const usedField = parentInput ? 'parent' : 'parent_id';
          return { content: [{ type: 'text', text: JSON.stringify({
            ok: false,
            error: {
              code: 'PARENT_NOT_FOUND',
              message: `${usedField} ${JSON.stringify(parentRequested)} did not resolve. ` +
                       `Available top-level roots in this browser: ${JSON.stringify(rootTitles)}. ` +
                       `For \`parent\` you can pass a top-level root title, any folder title, OR a Chrome bookmark folder id. ` +
                       `Re-list with get_bookmarks({folders_only: true}) to discover folder titles and ids with paths.`,
              context: { availableRoots: rootTitles },
            },
          }) }] };
        }
        if (Array.isArray(parentNode.children)) {
          scopedRoots = parentNode.children;
        } else {
          // The id resolved but the node is a leaf bookmark with no children.
          // Return an empty direct-children list rather than throwing.
          scopedRoots = [];
        }
        parentResolved = parentNode.id;
        if (includePath) {
          parentResolvedPath = _buildBookmarkPath(bookmarks, parentNode.id) || '';
        }
      }

      // FLAT PATH — triggers when ANY of:
      //   • Existing pagination opts (`after`/`limit`)
      //   • New composable opts (`parent`/`parent_id`/`leaves_only`/`folders_only`)
      // Filtered responses are naturally flat, so we use the items[] shape
      // rather than the nested `bookmarks` tree.
      const flatPathTrigger = parentRequested || _isPaginationRequested(after, limit) || leavesOnly || foldersOnly;
      if (flatPathTrigger) {
        const effectiveLimit = Number.isFinite(limit) && limit > 0 ? limit : PAGINATION_DEFAULT_LIMITS.bookmarks;
        let flat;
        if (parentRequested) {
          // Depth-1 read: walk ONLY direct children of the resolved parent,
          // apply filters inline. Matches the chat-side parent-scoped path.
          flat = scopedRoots.map(n => {
            if (!n) return null;
            const isLeaf   = typeof n.url === 'string' && n.url.length > 0;
            const isFolder = !isLeaf && Array.isArray(n.children);
            if (leavesOnly  && !isLeaf)   return null;
            if (foldersOnly && !isFolder) return null;
            const item = { id: n.id, title: n.title || '', parentId: parentResolved };
            if (isLeaf) item.url = n.url;
            if (!minimalFlag && typeof n.dateAdded === 'number') item.dateAdded = n.dateAdded;
            if (!minimalFlag && typeof n.index === 'number')     item.index     = n.index;
            if (includePath) {
              item.path = parentResolvedPath
                ? `${parentResolvedPath} / ${n.title || ''}`
                : (n.title || '');
            }
            return item;
          }).filter(Boolean);
        } else {
          // Full-tree walk with filters + optional path tracking. Pre-V3 callers
          // (no opts, just `after`/`limit`) hit this branch with opts={} and
          // get the original shape unchanged.
          flat = _flattenBookmarksTree(bookmarks, null, [], shapeOpts);
        }
        const page = _paginateByCursor(flat, after, effectiveLimit);
        return { content: [{ type: 'text', text: JSON.stringify({
          ok:         true,
          browser:    r.data.browserBrand,
          browserId:  r.data.browserId,
          scope:      'bookmarks',
          ...(parentResolved ? { parent_id: parentResolved, scope_depth: 'direct-children-only' } : {}),
          ...(leavesOnly     ? { filter: 'leaves_only'  } : {}),
          ...(foldersOnly    ? { filter: 'folders_only' } : {}),
          items:      page.items,
          nextCursor: page.nextCursor,
          totalItems: page.totalItems,
          cursorFound: page.cursorFound,
          updatedAt:  r.data.updatedAt,
        }) }] };
      }

      // DEFAULT PATH — no params at all. Full nested chrome.bookmarks tree.
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
      description: 'Finds exact-URL duplicates within ONE scope or across MULTIPLE. Bridge-side, no LLM; exact byte-identical URL match (differing tracking params / fragments count as distinct). ' +
        'SCOPE: "tree" / "bookmarks" / "library" (single-scope) or "cross-scope" (union across surfaces — use when the question spans them, e.g. "do I already have this saved"; pick surfaces via crossScopes, default tree+bookmarks+all-libraries — "libraries" plural = every library in the install). ' +
        'FLOW: summarize counts + sample titles, then ASK the user which of two equally-valid paths (phrase neutrally): (1) move the duplicate copies into one "Duplicates" folder for review, or (2) delete the duplicate copies directly via bulk_apply delete_node({confirmedByUser:true}). Keep ONE copy per URL: each set lists ALL nodes with that URL, so act on count-1 (a set of 3 → 2 acted on). totalDuplicateInstances = sum(count-1). ' +
        'CROSS-SCOPE ROUTING (critical): each instance may live in a different scope, so a single bulk_apply with one outer scope WON\'T work — group nodeIds by their sourceScopes[] value and issue ONE bulk_apply per distinct scope (matching scope/libraryId per sub-op). ' +
        'Response: duplicateSets by frequency desc — {url, count, nodeIds[], parentPaths[] (parallel), sampleTitles[] (≤3)}. Cross-scope adds parallel sourceScopes[] ("tree"|"bookmarks"|"library") and sourceLibraryIds[] (null for tree/bookmarks). Top level carries {cached:true, cachedAt}.',
      inputSchema: {
        scope: z.enum(['tree', 'bookmarks', 'library', 'cross-scope']).describe('Which data source to scan. "tree" = live tab tree (windows/groups/tabs). "bookmarks" = browser bookmark tree (Chrome bookmarks API source). "library" = a specific Pinako library (requires library_id). "cross-scope" = union of multiple scopes; specify which via crossScopes (defaults to all three).'),
        library_id: z.string().optional().describe('Library id from list_libraries. Required when scope:"library".'),
        crossScopes: z.array(z.enum(['tree', 'bookmarks', 'libraries'])).optional().describe('Which scopes to union when scope:"cross-scope". Defaults to ["tree", "bookmarks", "libraries"] (all three). Use ["tree", "bookmarks"] for the prototypical "is this open tab already bookmarked" question. "libraries" (plural) means ALL libraries in this install — a URL appearing in any single library counts toward the cross-scope dedup. Ignored when scope is not "cross-scope".'),
        match_mode: z.enum(['exact']).optional().describe('Match strategy. Currently only "exact" (byte-identical URL match) is supported.'),
        browser: z.string().optional().describe(BROWSER_ARG_DESC),
      },
      annotations: TOOL_ANNOTATIONS.find_duplicates,
    },
    async ({ scope, library_id, crossScopes, match_mode = 'exact', browser }) => {
      const r = resolveBrowserData(browser);
      if (r.error) return r.error;

      let scanTree;
      let scopeIdentifier = null;
      let result;
      let effectiveCrossScopes = null;
      if (scope === 'tree') {
        scanTree = r.data.tree || [];
        result = _findDuplicateUrls(scanTree);
      } else if (scope === 'bookmarks') {
        scanTree = r.data.bookmarks || [];
        result = _findDuplicateUrls(scanTree);
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
        result = _findDuplicateUrls(scanTree);
      } else if (scope === 'cross-scope') {
        const requested = Array.isArray(crossScopes) && crossScopes.length > 0
          ? crossScopes
          : ['tree', 'bookmarks', 'libraries'];
        // Dedup + freeze for the response so the agent sees exactly which
        // scopes the bridge actually walked (a duplicate 'tree' value would
        // double-count silently otherwise).
        effectiveCrossScopes = [...new Set(requested)];
        const scopedTrees = [];
        if (effectiveCrossScopes.includes('tree')) {
          scopedTrees.push({ tree: r.data.tree || [], sourceScope: 'tree', sourceLibraryId: null });
        }
        if (effectiveCrossScopes.includes('bookmarks')) {
          scopedTrees.push({ tree: r.data.bookmarks || [], sourceScope: 'bookmarks', sourceLibraryId: null });
        }
        if (effectiveCrossScopes.includes('libraries')) {
          for (const lib of (r.data.libraries || [])) {
            scopedTrees.push({ tree: lib.children || [], sourceScope: 'library', sourceLibraryId: lib.id });
          }
        }
        result = _findDuplicateUrlsCrossScope(scopedTrees);
      }

      // Side effect: cache result on the per-browser cache entry so the
      // auto-organize workflow (Step 7 sift loop, Step 9 resolve_duplicate_landings)
      // can read each duplicate instance's parentPath as semantic signal. Always
      // caches the latest scan, regardless of whether auto-organize is active —
      // the workflow checks workflowStep + scope match before consuming, and a
      // cached scope of "cross-scope" naturally fails the workflow's per-scope
      // match check so cross-scope results don't leak into the sift loop.
      const cachedAt = Date.now();
      r.data.lastDuplicateScan = {
        scope,
        libraryId: scopeIdentifier,
        matchMode: match_mode,
        crossScopes: effectiveCrossScopes,
        scannedAt: cachedAt,
        duplicateSets: result.duplicateSets,
        totalDuplicateInstances: result.totalDuplicateInstances,
        uniqueDuplicateUrls: result.uniqueDuplicateUrls,
        totalScannedWithUrl: result.totalScannedWithUrl,
      };

      return { content: [{ type: 'text', text: JSON.stringify({
        browser:     r.data.browserBrand,
        browserId:   r.data.browserId,
        scope,
        libraryId:   scopeIdentifier,
        ...(effectiveCrossScopes ? { crossScopes: effectiveCrossScopes } : {}),
        matchMode:   match_mode,
        cached:      true,
        cachedAt,
        ...result,
      }) }] };
    }
  );

  srv.registerTool(
    'get_tree_summary',
    {
      description: 'Returns a lightweight structural summary of a tree/bookmarks/library WITHOUT returning the actual nodes. Bridge-side; no LLM. THIS IS THE RIGHT TOOL FOR "how many tabs / windows / items" and "how big is X" questions: counts.nodes is the total node count and counts.url_bearing_nodes is the tab/link count — never count by searching (an empty/broad search is not a counter) or by pulling the whole tree. Also designed for the "should I read this whole tree?" decision the agent faces before any large read: the summary fits in <2KB regardless of tree size and lets the agent decide whether to proceed, what scope makes sense, and ballpark the cost.\n\n' +
        'Response shape: {browser, browserId, scope, libraryId?, counts:{nodes, url_bearing_nodes}, depth:{max, median}, topDomains:[{domain,count},...up to 15], samplePatterns:[{pattern,token,count},...up to 15], sampleTitles:[...up to 20]}. ' +
        'topDomains = highest-frequency hostnames (www-stripped). samplePatterns = path-token frequency across all URLs (stop-words filtered: html, www, login, etc.); token of "recipe" with pattern "*recipe*" means 389 URLs had "recipe" somewhere in their path. sampleTitles = a deterministic stride sample of node titles (stable across calls — safe to cite back to the user).\n\n' +
        'For scope:"library", library_id is required. For scope:"bookmarks", returns the cached browser bookmark tree summary (empty if user hasn\'t opened the bookmarks panel since the bridge started). For scope:"tree", summarizes the live tab tree.',
      inputSchema: {
        scope:      z.enum(['tree', 'bookmarks', 'library']).optional().describe('Which data source to summarize. Default "tree".'),
        library_id: z.string().optional().describe('Library id from list_libraries. Required when scope:"library".'),
        browser:    z.string().optional().describe(BROWSER_ARG_DESC),
      },
      annotations: TOOL_ANNOTATIONS.get_tree_summary,
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
    'list_browsers',
    {
      description: 'Lists all Pinako installs currently connected to this MCP server. Each entry: browserBrand (human-readable name like "Chrome" or "Brave"), browserId (stable per-install id), updatedAt (timestamp of last data update — any tree mutation, memo edit, note write, etc.), windowCount (live windows), libraryCount, bookmarkCount, docsCount (number of cached user-guide sections searchable via search_docs), subscriptionTier (integer 0-4 indicating the install\'s Pinako subscription: 0=Free, 1=Pro, 2=Pro+, 3=Premium, 4=Enterprise; the per-tier note content character cap is 50K / 50K / 150K / 250K / 500K respectively, so BEFORE a planned create_note or set_note_content whose content might exceed the cap for this tier, warn the user proactively instead of letting NOTE_CONTENT_OVER_TIER_LIMIT surface as a rejection). Response is sorted by updatedAt descending — entry [0] is the most recently active install, which the agent can surface as a recency hint when asking the user which browser to target. Use the browserBrand or browserId as the "browser" argument to other tools when multiple browsers are connected.',
      annotations: TOOL_ANNOTATIONS.list_browsers,
    },
    async () => {
      const browsers = [...cachedData.values()]
        .map(d => ({
          browserBrand:     d.browserBrand,
          browserId:        d.browserId,
          updatedAt:        d.updatedAt,
          windowCount:      (d.tree || []).filter(n => !n.incognito).length,
          libraryCount:     (d.libraries || []).length,
          bookmarkCount:    (d.bookmarks || []).reduce((acc, root) => acc + countBookmarksRecursive(root), 0),
          docsCount:        Array.isArray(d.docs) ? d.docs.length : 0,
          subscriptionTier: Number.isFinite(d.userTier) ? d.userTier : 0,
        }))
        .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
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
  // Full-section retrieval (WP-8 of the 2026-07-07 efficiency audit, finding
  // F5). A 500-char excerpt truncates mid-section, so an answer sitting past
  // that boundary was unreachable without a second, differently-phrased search
  // that might never surface it. `full_sections:true` swaps the excerpt for the
  // WHOLE section body on the top FULL_TOP_N hits (capped at FULL_CHAR_CAP
  // each); hits below that rank keep their excerpt, so one call still returns
  // the ranked tail for orientation. Kept in lockstep with the chat executor's
  // _searchDocsForChat in Pinako/pinako.js (same constants, same fields).
  const _DOCS_EXCERPT_CAP   = 500;
  const _DOCS_FULL_TOP_N    = 2;
  const _DOCS_FULL_CHAR_CAP = 4000;

  // Body hits score with DIMINISHING RETURNS instead of linearly (Batch 54).
  // Title and subheading hits are worth 10 each; body hits used to be worth 1
  // each with NO ceiling, so a long section beat a precisely-titled short one
  // on sheer length — "cloud sync" landed on #guide-synced-devices, "3 panel
  // view" on #guide-libraries, "ai semantic search" on #guide-ai-librarian,
  // and "workona tab manager" didn't reach the top 5 at all. The 20th mention
  // of a term says little the 3rd didn't; sublinear term-frequency weighting
  // is the standard fix (same shape BM25 uses). Measured over two gold sets —
  // 40 self-title queries and 45 hand-labeled natural phrasings — this moved
  // top-1 from 62.5%→72.5% and 80.0%→86.7% with ZERO ranking regressions on
  // either set. Keep identical to pinako.js's _docsBodyScoreForChat.
  //   1 hit → 2 · 3 → 4 · 7 → 6 · 15 → 8 · 31 → 10 · 63 → 12
  function _docsBodyScore(hits) {
    return Math.round(2 * Math.log2(1 + hits));
  }
  function _searchDocsSections(docs, query, maxN, fullSections) {
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
        if (matches) score += _docsBodyScore(matches.length);
      }
      if (score > 0) scored.push({ d, score, subAnchor: bestSubAnchorId });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, maxN).map(({ d, score, subAnchor }, rank) => {
      const body = d.text || '';
      const full = !!fullSections && rank < _DOCS_FULL_TOP_N;
      const cap  = full ? _DOCS_FULL_CHAR_CAP : _DOCS_EXCERPT_CAP;
      const cut  = body.length > cap;
      const clipped = cut ? body.slice(0, cap) + '…' : body;
      return {
        id:     d.id,
        title:  d.title,
        source: d.source,
        // `text` = whole section (full mode); `excerpt` = 500-char head.
        // Never both — the field name IS how the model knows which it got.
        ...(full ? { text: clipped, ...(cut ? { truncated: true } : {}) }
                 : { excerpt: clipped }),
        score,
        ...(subAnchor ? { subAnchor } : {}),
      };
    });
  }

  srv.registerTool(
    'search_docs',
    {
      description: 'Searches the Pinako user guide. Returns ranked sections with title, anchor id, source ("user-guide" / "ai-connect" / "import" / "agent"), excerpt, and score. Bundled with this bridge, served from local cache (~10ms, no internet). Two RESERVED single-word queries address agent-only material and match nothing else in the corpus: "orientation" returns the two-part capabilities map (what Pinako is, which anchor documents what — the right first call in a cold conversation), and "playbook" returns the two-part bookmark playbook (run it before any broad bookmark survey or reorganization). Pair either with full_sections:true and one call returns both halves whole. See the DOCS LOOKUP section in server instructions for WHEN to call this. Cite anchor ids back to the user ("see #guide-library-groups") so they can jump to that section in their own copy of the guide — EXCEPT ids starting with "agent-", which exist only in this corpus and would be a dead link for them.',
      inputSchema: {
        query: z.string().describe('Search query — keywords or short phrase (case-insensitive).'),
        max_results: z.number().int().min(1).max(20).optional().describe('Cap on returned sections. Default 5.'),
        full_sections: z.boolean().optional().describe('Return the WHOLE section body (field `text`, capped ~4000 chars, `truncated:true` if cut) for the top 2 hits instead of a 500-char `excerpt`; lower-ranked hits keep their excerpt. Use it when an excerpt cut off before the answer, or up front for a procedure you intend to follow rather than just name.'),
        browser: z.string().optional().describe(BROWSER_ARG_DESC),
      },
      annotations: TOOL_ANNOTATIONS.search_docs,
    },
    async ({ query, max_results, full_sections, browser }) => {
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
      const results = _searchDocsSections(docs, query, max_results || 5, full_sections === true);
      return { content: [{ type: 'text', text: JSON.stringify({
        browser: r.data.browserBrand,
        query,
        results,
        count:   results.length,
        ...(full_sections === true
          ? { fullSections: Math.min(results.length, _DOCS_FULL_TOP_N) }
          : {}),
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
      description: 'Current tab tree (Window Groups → Windows → Tabs) for the connected Pinako browser. Subscribe to receive notifications/resources/updated when the tree mutates. For multi-browser scenarios, use the get_tree tool with a browser argument.',
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
      title:       'Pinako Main Notes',
      description: 'Rich-text notes attached to the user\'s main tree (as opposed to library notes or per-tab memos). Cloud-synced across the user\'s browsers. Subscribe to receive notifications/resources/updated when Main Notes mutate. (Internal field name `globalNotes` is legacy.)',
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
  // 2026-05-24: narrower variant for ops that don't apply to bookmark scope.
  // delete_live_node + ghost_node have no meaning on bookmarks (no live tabs);
  // create_group fails because bookmark tree shape has no Window Group node type.
  // Engine returns INVALID_NODE_TYPE / INVALID_PARENT for these on bookmarks
  // scope; this narrower describe spares the agent the trial-and-error.
  const SCOPE_TREE_OR_LIBRARY_ONLY = "Scope: 'tree' (default) or 'library' (libraryId required). NOT applicable to 'bookmarks' — this op operates on Pinako tree/library structures that don't exist in the Chrome bookmark tree.";
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
    annotations: TOOL_ANNOTATIONS.set_tags,
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
    annotations: TOOL_ANNOTATIONS.add_tags,
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
    annotations: TOOL_ANNOTATIONS.remove_tags,
  }, async (args) => writeToolHandler('remove_tags', args));

  // ─── Metadata ops ───────────────────────────────────────────────────────────
  srv.registerTool('set_memo', {
    description: 'Sets the memo (short plain-text annotation, max 2500 chars) on a node. Pass empty string to clear. Memos are per-node and concise; for richer rich-text documents use create_note / set_note_content (which target a library or the Main Notes, not individual nodes). The memo content field is named "text" in this tool; "memo" is also accepted as an alias for resilience (if both are present, "text" wins).',
    inputSchema: {
      nodeId:    z.string().describe('Target node id.'),
      text:      z.string().describe('Memo text (max 2500 chars). Empty string clears the memo. Alias: "memo".'),
      scope:     z.string().optional().describe(SCOPE_TREE_OR_LIBRARY),
      libraryId: z.string().optional().describe('Required when scope=library.'),
      browser:   z.string().optional().describe(BROWSER_ARG_DESC),
    },
    annotations: TOOL_ANNOTATIONS.set_memo,
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
    annotations: TOOL_ANNOTATIONS.set_star_color,
  }, async (args) => writeToolHandler('set_star_color', args));

  srv.registerTool('set_row_color', {
    description: 'Sets the rowColor of a Window Group node or Folder node. NOT related to browser Tab Group color (the browser owns those; agent has no direct control over them, and tabgroup nodes are rejected with INVALID_NODE_TYPE - tabs join/leave browser Tab Groups via move_node, see that tool). Accepts: "accent2" (theme-tracking default), a named color ("blue", "red", "green", "purple", "yellow", "orange", "pink", "cyan", "grey"), an explicit 6-digit hex ("#1890ff"), or null (reset to "accent2"). Rejects on non-group/non-folder node types (including tabgroup) with INVALID_NODE_TYPE.',
    inputSchema: {
      nodeId:    z.string().describe('Target group or folder node id.'),
      rowColor:  z.union([z.string(), z.null()]).describe('"accent2", named color, 6-digit hex, or null to reset.'),
      scope:     z.string().optional().describe(SCOPE_TREE_OR_LIBRARY),
      libraryId: z.string().optional().describe('Required when scope=library.'),
      browser:   z.string().optional().describe(BROWSER_ARG_DESC),
    },
    annotations: TOOL_ANNOTATIONS.set_row_color,
  }, async (args) => writeToolHandler('set_row_color', args));

  srv.registerTool('set_title', {
    description: 'Sets a custom title on a tab, window, Window Group (type="group"), or folder node. Trimmed; max 200 chars. Sets customTitle=true so the title persists across browser restarts. Rejects tabgroup nodes with INVALID_TARGET (the browser owns a Tab Group name, Pinako does not) and rejects the library container (use set_library_title).',
    inputSchema: {
      nodeId:    z.string().describe('Target node id.'),
      title:     z.string().describe('New title (trimmed, non-empty, max 200 chars).'),
      scope:     z.string().optional().describe(SCOPE_TREE_OR_LIBRARY),
      libraryId: z.string().optional().describe('Required when scope=library.'),
      browser:   z.string().optional().describe(BROWSER_ARG_DESC),
    },
    annotations: TOOL_ANNOTATIONS.set_title,
  }, async (args) => writeToolHandler('set_title', args));

  // ─── Tree-structure ops ─────────────────────────────────────────────────────
  srv.registerTool('move_node', {
    description: 'Moves a node and its FULL subtree under newParentId (null = root, which auto-wraps a tab into a new window). To move a node WITHOUT its children, outdent its FIRST child first (sibling-adoption pulls the rest under it), then move the now-empty target — or wrap both in one bulk_apply. VALID PARENT BY MOVED-NODE TYPE (engine rejects others with INVALID_PARENT): tab → ROOT/window/folder/tabgroup (NEVER directly under a Window Group — move into a window first); window → ROOT/group/folder; group → ROOT/group; folder → ROOT/folder; tabgroup → window only. (Tab-under-tab nesting is reachable only via indent_node, not move_node.) Browser Tab Group membership follows CONTAINMENT: move the tab into a type="tabgroup" node to join, out of it to leave — position within the branch never affects membership; moving the tabgroup node carries the whole group. You cannot create, rename, recolor, or dissolve a browser Tab Group. scope:"bookmarks" moves go through chrome.bookmarks.move and are NOT Pinako-undoable; for batch reorg, suggest a backup first. Example — join a browser Tab Group by inserting between two existing members: {nodeId:"tab-12", newParentId:"<tabgroup node id>", position:1}.',
    inputSchema: {
      nodeId:      z.string().describe('Node to move (with its subtree).'),
      newParentId: z.union([z.string(), z.null()]).optional().describe('Destination parent id, or null for root.'),
      position:    z.number().optional().describe(POSITION_DESC),
      scope:       z.string().optional().describe(SCOPE_TREE_OR_LIBRARY),
      libraryId:   z.string().optional().describe('Required when scope=library.'),
      browser:     z.string().optional().describe(BROWSER_ARG_DESC),
    },
    annotations: TOOL_ANNOTATIONS.move_node,
  }, async (args) => writeToolHandler('move_node', args));

  srv.registerTool('create_group', {
    description: 'Creates a new Window Group node (type="group" — Pinako\'s organizational row for nesting windows). Window Groups can contain other Window Groups and windows but NOT tabs directly (tabs always live under a window, a tabgroup node, or another tab). Position defaults to TOP of the destination siblings (matches the manual UI). This does NOT create a browser Tab Group (the colored-strip groups in the browser tab bar): Pinako mirrors those read-only and has no create op for them — tabs join an EXISTING browser Tab Group via move_node.',
    inputSchema: {
      title:     z.string().describe('Group title (trimmed, non-empty, max 200 chars).'),
      rowColor:  z.string().optional().describe('Optional row background color: a named color, hex string, or "accent2" (default, theme-tracking).'),
      parentId:  z.union([z.string(), z.null()]).optional().describe('Parent node id (must be another group or null for root).'),
      position:  z.number().optional().describe(POSITION_DESC + ' Default TOP if omitted.'),
      scope:     z.string().optional().describe(SCOPE_TREE_OR_LIBRARY_ONLY),
      libraryId: z.string().optional().describe('Required when scope=library.'),
      browser:   z.string().optional().describe(BROWSER_ARG_DESC),
    },
    annotations: TOOL_ANNOTATIONS.create_group,
  }, async (args) => writeToolHandler('create_group', args));

  srv.registerTool('create_window', {
    description: 'Creates a new window node by RELOCATING one or more existing tabs into it (tabIds, at least one; an empty window is invalid). Bundles loose tabs into a window in ONE atomic step instead of moving tabs to root one at a time. Scope "tree" (default) or "library" (libraryId required); NOT bookmarks. parentId may be a group, folder, or library-folder, or omitted/null for the scope root. In the main tree, relocating LIVE tabs opens a real browser window containing them (created in the background, so focus is not stolen); ghost/saved and library tabs stay saved-only. Default position appends to the destination. Tabs are MOVED, not copied.',
    inputSchema: {
      tabIds:    z.array(z.string()).min(1).describe('Existing tab node ids to relocate into the new window (at least one; moved, not copied; placed in the given order).'),
      title:     z.string().optional().describe('Optional window title (trimmed, non-empty, max 200 chars). Defaults to "Window".'),
      parentId:  z.union([z.string(), z.null()]).optional().describe('Parent container id (a group, folder, or library-folder), or null for the scope root.'),
      position:  z.number().optional().describe(POSITION_DESC + ' Default append if omitted.'),
      scope:     z.string().optional().describe(SCOPE_TREE_OR_LIBRARY_ONLY),
      libraryId: z.string().optional().describe('Required when scope=library.'),
      browser:   z.string().optional().describe(BROWSER_ARG_DESC),
    },
    annotations: TOOL_ANNOTATIONS.create_window,
  }, async (args) => writeToolHandler('create_window', args));

  srv.registerTool('delete_node', {
    description: 'DESTRUCTIVE — permanently removes a GHOST node (chromeId=null) and its metadata (tags/memos/colors/title); for scope="bookmarks", removes the browser bookmark via chrome.bookmarks.remove. REFUSES subtrees containing any live tab (LIVE_NODE_REFUSED) — ghost_node first, then delete_node, or use delete_live_node. Set confirmedByUser:true ONLY after the user confirmed THIS specific deletion. Idempotent-on-retry (NODE_NOT_FOUND on retry = already deleted; treat as success). RECOVERY ASYMMETRY: tree/library deletes are Pinako-undoable (Ctrl+Z); scope:"bookmarks" deletes are NOT — before the first bookmark delete in a session or any batch over ~3 bookmarks, surface the backup warning from the server instructions (BOOKMARK SCOPE RECOVERY) VERBATIM and get fresh confirmation.',
    inputSchema: {
      nodeId:          z.string().describe('Target ghost node id (or bookmark id when scope="bookmarks").'),
      confirmedByUser: z.literal(true).describe('Must be exactly TRUE. Set ONLY after explicit user approval of this specific destructive action.'),
      scope:           z.string().optional().describe(SCOPE_TREE_OR_LIBRARY),
      libraryId:       z.string().optional().describe('Required when scope=library.'),
      browser:         z.string().optional().describe(BROWSER_ARG_DESC),
    },
    annotations: TOOL_ANNOTATIONS.delete_node,
  }, async (args) => writeToolHandler('delete_node', args));

  srv.registerTool('ghost_node', {
    description: 'Closes the live browser tab(s) for this node and all live descendants, while preserving the tree node with chromeId=null on every ghosted node. Mirrors the manual "X" button. REVERSIBLE: the user can re-open from the tree later (URLs and metadata stay in the tree). Use this for "close these tabs but keep them saved" intents — end-of-day cleanup, freeing memory, archiving research. No confirmedByUser required (2026-05-11): the tree record is preserved so an erroneous ghost is undoable by re-opening. The browser-tab close is still visible, so narrate the intent before invoking ("I\'ll close these but they\'ll stay saved in your tree"). Returns NODE_NOT_LIVE if nothing in the subtree is live. Idempotent-on-retry: NODE_NOT_LIVE on retry typically means the previous call already ghosted everything; treat as success.',
    inputSchema: {
      nodeId:    z.string().describe('Target node id (tab, window, group, or folder). The node and all live descendants will be ghosted.'),
      scope:     z.string().optional().describe(SCOPE_TREE_OR_LIBRARY_ONLY),
      libraryId: z.string().optional().describe('Required when scope=library.'),
      browser:   z.string().optional().describe(BROWSER_ARG_DESC),
    },
    annotations: TOOL_ANNOTATIONS.ghost_node,
  }, async (args) => writeToolHandler('ghost_node', args));

  srv.registerTool('delete_live_node', {
    description: 'DESTRUCTIVE — closes the live browser tab(s) AND removes the tree node entirely (compound of ghost_node + delete_node, but bypasses delete_node\'s LIVE_NODE_REFUSED). Use when the user wants both the browser tabs gone AND the saved tree node gone. Mirrors the manual trash button on live nodes. SCOPE NOTE: bookmark items are never "live" (no chromeId), so delete_live_node should NOT be used on scope:"bookmarks" — use delete_node with scope:"bookmarks" instead (and surface the bookmark non-undoability warning from delete_node\'s description before doing so). REQUIRES EXPLICIT USER APPROVAL: set confirmedByUser:true ONLY after the user has confirmed THIS specific deletion — do not set it as a default. The engine and bridge both enforce this; missing the flag returns CONFIRMATION_REQUIRED.',
    inputSchema: {
      nodeId:          z.string().describe('Target node id. The node, all descendants, and any live browser tabs in the subtree will be removed.'),
      confirmedByUser: z.literal(true).describe('Must be exactly TRUE. Set ONLY after explicit user approval of this specific destructive action.'),
      scope:           z.string().optional().describe(SCOPE_TREE_OR_LIBRARY_ONLY),
      libraryId:       z.string().optional().describe('Required when scope=library.'),
      browser:         z.string().optional().describe(BROWSER_ARG_DESC),
    },
    annotations: TOOL_ANNOTATIONS.delete_live_node,
  }, async (args) => writeToolHandler('delete_live_node', args));

  srv.registerTool('indent_node', {
    description: 'Nests a node under its previous sibling (one level deeper). Rejects when the node has no prior sibling (INDENT_NO_PREV_SIBLING). Auto-expands the new parent. Works across tree, library, and bookmark scopes — a common pattern for quickly de-nesting then re-organizing tabs. For scope="bookmarks", the parent change syncs to chrome.bookmarks.move (when the new parent is a folder) or to Pinako\'s tab-under-tab override (when the new parent is a tab/bookmark — chrome.bookmarks can\'t represent that natively).',
    inputSchema: {
      nodeId:    z.string().describe('Node to indent.'),
      scope:     z.string().optional().describe(SCOPE_TREE_OR_LIBRARY),
      libraryId: z.string().optional().describe('Required when scope=library.'),
      browser:   z.string().optional().describe(BROWSER_ARG_DESC),
    },
    annotations: TOOL_ANNOTATIONS.indent_node,
  }, async (args) => writeToolHandler('indent_node', args));

  srv.registerTool('outdent_node', {
    description: 'Promotes a node to its grandparent\'s level (one level shallower). Sibling-adoption preserves layout: the outdented node\'s younger siblings become its children, so visual row order is preserved. CHILD-EXTRACTION PATTERN: outdent the FIRST child of a target to free the target solo (target becomes empty, all children become adopted under the outdented first child). Works across tree, library, and bookmark scopes. For scope="bookmarks", the parent change (and each adopted sibling\'s new parent) syncs to chrome.bookmarks.move or to Pinako\'s tab-under-tab override depending on the new parent\'s type.',
    inputSchema: {
      nodeId:    z.string().describe('Node to outdent.'),
      scope:     z.string().optional().describe(SCOPE_TREE_OR_LIBRARY),
      libraryId: z.string().optional().describe('Required when scope=library.'),
      browser:   z.string().optional().describe(BROWSER_ARG_DESC),
    },
    annotations: TOOL_ANNOTATIONS.outdent_node,
  }, async (args) => writeToolHandler('outdent_node', args));

  // ─── Library system ops ─────────────────────────────────────────────────────
  srv.registerTool('create_library', {
    description: 'Creates a new empty library with an auto-seeded "Notes" note. Returns createdLibraryId and createdNoteId in the result. Use add_to_library afterwards to populate. For just creating an organizational umbrella over EXISTING libraries, use create_library_group instead. NOT IDEMPOTENT: each call creates a new library. On transient failures (EDIT_TIMEOUT, FORWARDER_DISCONNECTED, LEADER_CHANGED, NM_WRITE_FAILED), DO NOT auto-retry — call list_libraries to check whether the previous attempt succeeded before retrying, otherwise you may create duplicates.',
    inputSchema: {
      title:       z.string().describe('Library title (trimmed, non-empty, max 200 chars).'),
      description: z.string().optional().describe('Optional description shown beneath title (max 1000 chars).'),
      browser:     z.string().optional().describe(BROWSER_ARG_DESC),
    },
    annotations: TOOL_ANNOTATIONS.create_library,
  }, async (args) => writeToolHandler('create_library', args));

  srv.registerTool('add_to_library', {
    description: 'Clones TREE nodes (windows/tabs/groups/folders) from a source surface into a library. Pass only source TREE ids (e.g. children[] from get_library), NOT note ids from notes[] (those will not resolve — duplicate a note via create_note instead). includeChildren default TRUE (subtree comes along, matching DND); set FALSE when adding individual tabs to avoid bundling unrelated nested children. sourceScope: "tree" (default) / "library" (sourceLibraryId required) / "bookmarks" / "sync" (a connected device; sourceDeviceId required — mobile resolves instantly, PC devices may add ~50-300ms on first use). Tab clones auto-wrap into ONE new window. Max 100 source ids. UNRESOLVED IDS are skipped and returned in result.skippedNodeIds rather than failing the batch — if non-empty, re-match those by title/URL and retry just them; never drop them or narrow to a "safe" subset.',
    inputSchema: {
      nodeIds:         z.array(z.string()).min(1).describe('Source TREE node ids (max 100). MUST be ids from the source\'s tree (windows/tabs/groups/folders — e.g. items in `children[]` from get_library). Library-scope note ids from `notes[]` are NOT supported (they won\'t resolve and come back in result.skippedNodeIds); use create_note instead to duplicate notes. Order of clones matches order here.'),
      libraryId:       z.string().describe('Destination library id.'),
      includeChildren: z.boolean().optional().describe('Default TRUE: include each source node\'s subtree. Set FALSE to clone only the leaf node.'),
      sourceScope:     z.string().optional().describe('"tree" (default), "library", "bookmarks", or "sync".'),
      sourceLibraryId: z.string().optional().describe('Required when sourceScope="library".'),
      sourceDeviceId:  z.string().optional().describe('Required when sourceScope="sync". Use the syncDevices.id of the device card (e.g. "device-pc", "device-phone").'),
      position:        z.number().optional().describe(POSITION_DESC),
      browser:         z.string().optional().describe(BROWSER_ARG_DESC),
    },
    annotations: TOOL_ANNOTATIONS.add_to_library,
  }, async (args) => writeToolHandler('add_to_library', args));

  srv.registerTool('add_to_bookmarks', {
    description: 'Clones tree or library nodes INTO the browser bookmark tree (inverse of add_to_library). "save tab X as a bookmark" / "back up these to bookmarks" → this tool; "MOVE to bookmarks" → this tool then delete_node on the source (no atomic move in v1). sourceScope "tree" (default) or "library" (sourceLibraryId required). Type conversion: tab → bookmark leaf, window/group/folder → bookmark folder. parentBookmarkFolderId targets a folder id from get_bookmarks; omit for the first root ("Bookmarks Bar"). Returns addedBookmarkNodeIds. NOT IDEMPOTENT — DO NOT auto-retry; check get_bookmarks first. Ctrl+Z fully reverses this op (Pinako entries AND the Chrome bookmarks). For large adds (50+), suggest a bookmark backup first as cheap insurance. Max 100 source ids.',
    inputSchema: {
      nodeIds:                 z.array(z.string()).min(1).describe('Source TREE node ids (max 100). MUST be ids from the source\'s tree (windows/tabs/groups/folders).'),
      sourceScope:             z.string().optional().describe('"tree" (default) or "library". Bookmarks→bookmarks is not supported here (use move_node for in-bookmark reorder).'),
      sourceLibraryId:         z.string().optional().describe('Required when sourceScope="library".'),
      includeChildren:         z.boolean().optional().describe('Default TRUE: include each source node\'s subtree. Set FALSE to clone only the leaf node.'),
      parentBookmarkFolderId:  z.string().optional().describe('Pinako internal id of the destination bookmark folder (from get_bookmarks). Omit to default to the first root ("Bookmarks Bar").'),
      position:                z.number().optional().describe(POSITION_DESC),
      browser:                 z.string().optional().describe(BROWSER_ARG_DESC),
    },
    annotations: TOOL_ANNOTATIONS.add_to_bookmarks,
  }, async (args) => writeToolHandler('add_to_bookmarks', args));

  srv.registerTool('set_note_content', {
    description: 'Updates an existing note. mode "replace" (default) overwrites; "append" concatenates (the FINAL combined length is what\'s tier-gated: 50K Pro / 150K Pro+ / 250K Premium / 500K Enterprise). For prepend, read first then replace with the combined string. Content is sanitized (script / on* / javascript: stripped). PASS HTML RAW: `content` is a JSON string the engine stores literally then renders — do NOT entity-escape `<` `>` `&` (writing `&lt;p&gt;` renders visible "&lt;p&gt;" instead of a `<p>` element). Replace is idempotent on retry; append is NOT (re-read before retrying append). CONCURRENCY (LWW): for read-then-write flows pass expected_last_modified (the note.last_modified you read) to guard against a concurrent edit from another device / portal session — engine rejects with NOTE_STALE if newer; re-read and retry. Omit for blind overwrites.',
    inputSchema: {
      noteId:    z.string().describe('Note id within the target notes array.'),
      content:   z.string().describe('Note content (max varies by tier; see description).'),
      mode:      z.string().optional().describe('"replace" (default) or "append".'),
      scope:     z.string().describe(SCOPE_NOTES),
      libraryId: z.string().optional().describe('Required when scope=library-notes.'),
      expected_last_modified: z.number().int().nonnegative().optional().describe('Optional last-write-wins guard. Pass the note.last_modified value you read with get_tree. Engine rejects with NOTE_STALE if the note has been modified since. Omit for blind overwrites.'),
      browser:   z.string().optional().describe(BROWSER_ARG_DESC),
    },
    annotations: TOOL_ANNOTATIONS.set_note_content,
  }, async (args) => writeToolHandler('set_note_content', args));

  srv.registerTool('create_note', {
    description: 'Creates a new note in a library or in the Main Notes. Use this when the user says "create a note about X", "save these findings as a new note", etc. For UPDATING an existing note, use set_note_content. Returns createdNoteId. Char limit is tier-gated. Note content is sanitized at write time (HTML allowlist; <script>, on* event handlers, javascript: URLs are stripped) — write valid Tiptap-compatible HTML or plain text. PASS HTML RAW: the `content` value is a JSON string the engine stores literally then renders; do NOT entity-escape `<` `>` `&` (they are valid unescaped inside a JSON string). Writing `&lt;p&gt;...&lt;/p&gt;` stores literal entity text that renders as visible `&lt;p&gt;` rather than a `<p>` element. NOT IDEMPOTENT: each call creates a new note. On transient failures, DO NOT auto-retry — call get_library or get_main_tree_notes to check whether the previous attempt succeeded before retrying.',
    inputSchema: {
      title:     z.string().describe('Note title (trimmed, non-empty, max 200 chars).'),
      content:   z.string().optional().describe('Initial content (default empty). Char limit varies by tier.'),
      scope:     z.string().describe(SCOPE_NOTES),
      libraryId: z.string().optional().describe('Required when scope=library-notes.'),
      browser:   z.string().optional().describe(BROWSER_ARG_DESC),
    },
    annotations: TOOL_ANNOTATIONS.create_note,
  }, async (args) => writeToolHandler('create_note', args));

  srv.registerTool('delete_note', {
    description: 'Permanently deletes a note from a library or the main tree. Cloud-side delete is automatic on next persist (the per-scope notes sync diffs current ids against existing Supabase rows and removes missing ones). LAST-NOTE BEHAVIOR: this op allows deleting any note including the only note in a scope. Pinako auto-reseeds an empty notes array with a default "Notes" note on next access — matches manual UI semantics. confirmedByUser:true is REQUIRED — destructive op, obtain explicit user approval for THIS specific deletion (not as a default, not on retry). Returns NOTE_NOT_FOUND for unknown ids. To CLEAR a note\'s content without deleting the note record, use set_note_content with empty string.',
    inputSchema: {
      noteId:           z.string().describe('Note id within the target notes array (note-* format, from get_library / get_main_tree_notes).'),
      scope:            z.string().describe(SCOPE_NOTES),
      libraryId:        z.string().optional().describe('Required when scope=library-notes.'),
      // 2026-05-24: tightened z.boolean() → z.literal(true) to match delete_library + delete_node and the engine schema. See delete_library above for rationale.
      confirmedByUser:  z.literal(true).describe('Must be exactly TRUE. Set ONLY after explicit user approval of this specific destructive action.'),
      browser:          z.string().optional().describe(BROWSER_ARG_DESC),
    },
    annotations: TOOL_ANNOTATIONS.delete_note,
  }, async (args) => writeToolHandler('delete_note', args));

  // ─── Library Group ops ──────────────────────────────────────────────────────
  srv.registerTool('create_library_group', {
    description: 'Creates a new library group (an organizational umbrella over multiple libraries). Returns createdGroupId. After creating, use add_library_to_group to add member libraries. NOT IDEMPOTENT: each call creates a new group. On transient failures, DO NOT auto-retry — call list_libraries to inspect existing groups before retrying.',
    inputSchema: {
      title:       z.string().describe('Group title (trimmed, non-empty, max 200 chars).'),
      description: z.string().optional().describe('Optional group description (max 1000 chars).'),
      browser:     z.string().optional().describe(BROWSER_ARG_DESC),
    },
    annotations: TOOL_ANNOTATIONS.create_library_group,
  }, async (args) => writeToolHandler('create_library_group', args));

  srv.registerTool('delete_library_group', {
    description: 'Removes a library group. TWO MODES via cascadeMembers: (1) DEFAULT (cascadeMembers omitted/false) — DISSOLVE: member libraries are KEPT and re-appear in the standalone library card list at the position the group occupied. Safe; non-destructive. (2) cascadeMembers:true — DESTRUCTIVE: also deletes each member library (owned libraries are deleted from cloud; linked libraries are unlinked from this account). REQUIRES EXPLICIT USER APPROVAL when cascadeMembers:true: set confirmedByUser:true ONLY after the user has confirmed they want to lose the libraries\' content. Cascade is one-way — undo restores group structure but NOT the cascaded libraries\' content. Engine + bridge both enforce confirmedByUser when cascading.',
    inputSchema: {
      groupId:         z.string().describe('Group id to remove.'),
      cascadeMembers:  z.boolean().optional().describe('FALSE (default) = dissolve, libraries kept. TRUE = also delete member libraries. Destructive when true.'),
      confirmedByUser: z.literal(true).optional().describe('Required to be TRUE when cascadeMembers:true. Set ONLY after explicit user approval of cascade deletion.'),
      browser:         z.string().optional().describe(BROWSER_ARG_DESC),
    },
    annotations: TOOL_ANNOTATIONS.delete_library_group,
  }, async (args) => writeToolHandler('delete_library_group', args));

  srv.registerTool('add_library_to_group', {
    description: 'Adds an existing library to an existing group. A library can belong to at most one group; rejects with LIBRARY_ALREADY_IN_GROUP / LIBRARY_IN_OTHER_GROUP if it\'s already assigned somewhere.',
    inputSchema: {
      groupId:   z.string().describe('Target group id.'),
      libraryId: z.string().describe('Library id to add.'),
      position:  z.number().optional().describe(POSITION_DESC + ' Default appends.'),
      browser:   z.string().optional().describe(BROWSER_ARG_DESC),
    },
    annotations: TOOL_ANNOTATIONS.add_library_to_group,
  }, async (args) => writeToolHandler('add_library_to_group', args));

  srv.registerTool('remove_library_from_group', {
    description: 'Removes a library from a group, returning it to the standalone library card list right after the group. The library itself is preserved. No-op if the library wasn\'t in the group (removing a stale ref is valid cleanup).',
    inputSchema: {
      groupId:   z.string().describe('Source group id.'),
      libraryId: z.string().describe('Library id to remove from the group.'),
      browser:   z.string().optional().describe(BROWSER_ARG_DESC),
    },
    annotations: TOOL_ANNOTATIONS.remove_library_from_group,
  }, async (args) => writeToolHandler('remove_library_from_group', args));

  srv.registerTool('set_library_group_title', {
    description: 'Renames a library group. Trimmed, non-empty, max 200 chars.',
    inputSchema: {
      groupId: z.string().describe('Target group id.'),
      title:   z.string().describe('New title.'),
      browser: z.string().optional().describe(BROWSER_ARG_DESC),
    },
    annotations: TOOL_ANNOTATIONS.set_library_group_title,
  }, async (args) => writeToolHandler('set_library_group_title', args));

  srv.registerTool('set_library_group_description', {
    description: 'Updates a library group\'s description. Empty string clears it. Max 1000 chars.',
    inputSchema: {
      groupId:     z.string().describe('Target group id.'),
      description: z.string().describe('New description (empty string clears).'),
      browser:     z.string().optional().describe(BROWSER_ARG_DESC),
    },
    annotations: TOOL_ANNOTATIONS.set_library_group_description,
  }, async (args) => writeToolHandler('set_library_group_description', args));

  srv.registerTool('set_library_title', {
    description: 'Renames a library. Trimmed, non-empty, max 200 chars. THIS IS THE ONLY rename path for a library (the container) — set_title rejects the library container with INVALID_TARGET (the library root is type \'library\', not a renamable tree node; in-library FOLDER nodes, type \'library-folder\', ARE renamable via set_title). MUST use this tool, not set_title, when the user asks to "rename library X to Y" or fix a library name typo. Mirrors set_library_group_title for the umbrella-group case.',
    inputSchema: {
      libraryId: z.string().describe('Target library id (folder-* format, from list_libraries / get_library).'),
      title:     z.string().describe('New title.'),
      browser:   z.string().optional().describe(BROWSER_ARG_DESC),
    },
    annotations: TOOL_ANNOTATIONS.set_library_title,
  }, async (args) => writeToolHandler('set_library_title', args));

  srv.registerTool('set_library_description', {
    description: 'Updates a library\'s description (shown beneath the title on library cards). Empty string clears it. Max 1000 chars. Mirrors set_library_group_description for the umbrella-group case.',
    inputSchema: {
      libraryId:   z.string().describe('Target library id.'),
      description: z.string().describe('New description (empty string clears).'),
      browser:     z.string().optional().describe(BROWSER_ARG_DESC),
    },
    annotations: TOOL_ANNOTATIONS.set_library_description,
  }, async (args) => writeToolHandler('set_library_description', args));

  srv.registerTool('delete_library', {
    description: 'Permanently deletes a single library and ALL its content (tabs, notes, tags, memos, child windows/groups/folders). Removes the library from any group it belongs to AND from the panel order. DESTRUCTIVE: cannot be fully undone — Ctrl+Z restores the libraryData entry but does NOT restore the group/panelOrder cleanup and does NOT recreate the cloud row. Use this instead of the hack of wrapping the library in a temporary group and cascade-deleting the group; that workaround required two MCP roundtrips and a visible UI artifact. confirmedByUser:true is REQUIRED — obtain explicit user approval for THIS specific library deletion (not as a default, not on retry). Returns LIBRARY_NOT_FOUND for unknown ids. To remove a library from a group without deleting its content, use remove_library_from_group instead.',
    inputSchema: {
      libraryId:        z.string().describe('Target library id (folder-* format, from list_libraries / get_library).'),
      // 2026-05-24: tightened from z.boolean() to z.literal(true). Pre-fix
      // the bridge layer accepted confirmedByUser:false (Zod passed; engine
      // schema's z.literal(true).refine() at mutation-engine.js was the only
      // catch). Now both layers reject the same shape, restoring the
      // defense-in-depth the host.js comment at _checkConfirmedByUser claims.
      confirmedByUser:  z.literal(true).describe('Must be exactly TRUE. Set ONLY after explicit user approval of this specific destructive action.'),
      browser:          z.string().optional().describe(BROWSER_ARG_DESC),
    },
    annotations: TOOL_ANNOTATIONS.delete_library,
  }, async (args) => writeToolHandler('delete_library', args));

  srv.registerTool('reorder_library_panel', {
    description: 'Reorders the cards in the library panel (standalone library cards + library group cards). Pass the COMPLETE current list of entries in the desired order. Each entry is {type:"library"|"group", id:<id>}. ORDER ONLY — every existing entry must be present (rejects with PANEL_ORDER_MISMATCH if count differs, PANEL_ORDER_UNKNOWN_ENTRY if an unknown id is introduced). Use create_library / delete_library_group / etc. to change membership; this op cannot add or remove cards. Always call list_libraries first to fetch the current panel_order array — never construct the entries array blindly; group ids and panel positions must come from a fresh list_libraries call (the panel_order field in its response maps 1:1 to this op\'s entries arg). Max 200 entries.',
    inputSchema: {
      entries: z.array(z.object({
        type: z.string().describe('"library" or "group"'),
        id:   z.string().describe('Library or group id'),
      })).describe('Full ordered list of panel cards. Must match current set exactly.'),
      browser: z.string().optional().describe(BROWSER_ARG_DESC),
    },
    annotations: TOOL_ANNOTATIONS.reorder_library_panel,
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
    annotations: TOOL_ANNOTATIONS.create_folder,
  }, async (args) => writeToolHandler('create_folder', args));

  srv.registerTool('reorder_libraries_in_group', {
    description: 'Reorders the libraries within a single library group. Pass the COMPLETE current list of member library ids in the desired order. ORDER ONLY — every current member must be present (rejects with LIBRARY_ORDER_MISMATCH if count differs, LIBRARY_ORDER_UNKNOWN_MEMBER if an unknown id is introduced, LIBRARY_ORDER_DUPLICATE if duplicates). Use add_library_to_group / remove_library_from_group to change membership. Max 200.',
    inputSchema: {
      groupId:    z.string().describe('Target group id.'),
      libraryIds: z.array(z.string()).describe('Full ordered list of member library ids. Must match current membership exactly.'),
      browser:    z.string().optional().describe(BROWSER_ARG_DESC),
    },
    annotations: TOOL_ANNOTATIONS.reorder_libraries_in_group,
  }, async (args) => writeToolHandler('reorder_libraries_in_group', args));

  // ─── Composite ─────────────────────────────────────────────────────────────
  srv.registerTool('bulk_apply', {
    description: 'Atomically applies up to 250 sub-ops as ONE undoable unit. USE ONLY for (a) the SAME op on 4 OR MORE targets, or (b) a heterogeneous multi-step reorganization wanting one-click atomic undo. At 1-3 same-op targets use the underlying tool directly. The 4-target rule is firm, not a soft preference. ' +
      'ENVELOPE SCOPE — every sub-op\'s scope must equal the envelope scope (a sub-op that omits scope inherits it). Concrete shapes per sub-op type: ' +
      '• tree mutations (move_node, set_tags, delete_node in the main tree, …) → scope:"tree" (or omit), no libraryId. ' +
      '• library-LIST ops (delete_library, set_library_title, set_library_description, add_to_library) → scope:"library-list", NO envelope libraryId; each sub-op carries its own target libraryId, so cross-LIBRARY batches ARE supported ("delete N libraries", "rename N libraries" = ONE bulk). ' +
      '• in-ONE-library tree mutations (move_node / set_tags / etc. within a library) → scope:"library" + libraryId; sub-ops share that library. ' +
      '• note ops (delete_note, set_note_content, create_note) → EVERY sub-op needs its own explicit scope ("library-notes" + libraryId, or "main-tree-notes"); the envelope does NOT auto-fill it, so set the envelope scope to match. ' +
      '• library-group ops (delete_library_group, set_library_group_*, add/remove_library_to/from_group, reorder_libraries_in_group) → scope:"library-groups", no envelope libraryId. ' +
      '• bookmarks → scope:"bookmarks". ' +
      'NOT one bulk: cross-SCOPE mixes (tree + library together) and cross-library tree-internal moves (one library source, another dest — use add_to_library). Nesting forbidden. ' +
      'PER-SUB-OP CONFIRMATION: each destructive sub-op (delete_node / delete_live_node / delete_note / delete_library / delete_library_group{cascadeMembers:true}) requires its OWN confirmedByUser:true — the wrapper does NOT confer it; obtain user approval per destructive action. ' +
      'On failure, error.context.subOpIndex identifies the failing sub-op. For N>250, plan ceil(N/250) contiguous-slice bulks UPFRONT; BULK_OPS_OVER_LIMIT returns context.batchesRequired + context.recommendedNextBatchSize. ' +
      'Example — note writes carry their OWN scope per sub-op: {scope:"library-notes", libraryId:"folder-abc", ops:[{type:"set_note_content", noteId:"note-1", content:"<p>Updated</p>", scope:"library-notes", libraryId:"folder-abc"}, {type:"delete_note", noteId:"note-2", scope:"library-notes", libraryId:"folder-abc", confirmedByUser:true}]}.',
    inputSchema: {
      ops:       z.array(z.object({}).passthrough()).min(1).describe('Array of agent ops (each with type + fields). Max 250 per call (raised from 100 on 2026-05-22). Engine returns BULK_OPS_OVER_LIMIT with context.batchesRequired + context.recommendedNextBatchSize when exceeded — plan ceil(N/250) sequential calls upfront, contiguous slices.'),
      scope:     z.string().optional().describe('Envelope scope. MUST equal every sub-op scope (or sub-op inherits when omitted). Valid values: tree (default), library-list, library, library-notes, main-tree-notes, library-groups, bookmarks. NOT auto-filled into create_note / set_note_content sub-ops — those must specify scope per sub-op. See main description for the concrete envelope shape per sub-op type.'),
      libraryId: z.string().optional().describe('Envelope libraryId. Required when scope is `library` or `library-notes` (in-library scopes — envelope picks which library, every sub-op libraryId must match). For `library-list` and `library-groups` (collection scopes) OMIT the envelope libraryId — each sub-op carries its own target libraryId / groupId and cross-library batches are supported. Omit for `tree`, `main-tree-notes`, `bookmarks` scopes. NOTE: envelope libraryId is NOT auto-injected into sub-ops. For sub-op types whose schema requires libraryId (delete_library, set_library_title, set_library_description, add_to_library), include the libraryId field on each sub-op (under `library-list` scope it is the per-sub-op TARGET; under `library` scope it must equal the envelope). Sub-op types that only operate on the bulk\'s draft (set_tags, move_node, set_memo, etc. under scope:\'library\') do NOT need to repeat libraryId.'),
      browser:   z.string().optional().describe(BROWSER_ARG_DESC),
    },
    annotations: TOOL_ANNOTATIONS.bulk_apply,
  }, async (args) => writeToolHandler('bulk_apply', args));

  // Local host extensions (see loadHostExtensions) may contribute additional
  // MCP tools. Run per server instance so every MCP session sees them; a
  // throwing registrar is logged and never breaks the built-in surface.
  for (const fn of _extMcpToolRegistrars) {
    try { fn(srv, { z }); }
    catch (e) { try { log(`host-ext tool registration failed: ${e && e.message ? e.message : e}`); } catch (_) {} }
  }

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
        // 2026-05-15 zombie-leader detection. If a forwarder POSTs /update
        // for a browserId that matches OUR localBrowserId, another process
        // owns the live NM pipe to that browser — ours is stale. Without
        // this check the stale leader keeps port 37421 bound for STDIN_GRACE_MS
        // (30s, or longer if Chrome doesn't close the old pipe promptly),
        // and any agentCommand routed NM-leader-local during that window
        // writes to a dead pipe. Exit promptly so the new forwarder's
        // promotion poll (every PROMOTE_RETRY_MS = 5s) takes the port.
        // Send 200 first so the new forwarder doesn't retry; exit on next tick.
        if (browserId && browserId === localBrowserId) {
          log(`/update from ${browserBrand || 'unknown'}: stale-leader detected (incoming browserId matches our localBrowserId ${(localBrowserId||'').slice(0,16)}…). Exiting so the new bridge can promote.`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, note: 'stale-leader, exiting' }));
          setTimeout(() => {
            process.stderr.write('[pinako-mcp] Stale-leader exit (zombie-bridge recovery).\n');
            process.exit(0);
          }, 100);
          return;
        }
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
          // S3.8 §7.4: the flag-label registry follows the NM path's
          // preserve-when-omitted contract too. It was missing here, so every
          // ordinary /update relay (which omits flagLabels) rebuilt the entry
          // without it and non-leader browsers lost their labels until the
          // next registry edit re-pushed them.
          const flagLabelsField = (data && 'flagLabels' in data)
            ? (data.flagLabels || null)
            : (priorCache?.flagLabels || null);
          cachedData.set(id, {
            tree:              treeField,
            libraries:         librariesField,
            globalNotes:       globalNotesField,
            bookmarks:         bookmarksField,
            docs:              docsField,
            libraryGroups:     libraryGroupsField,
            libraryPanelOrder: libraryPanelOrderField,
            flagLabels:        flagLabelsField,
            updatedAt:      Date.now(),
            browserId:      id,
            browserBrand:   brand,
            userTier:       tier,
            userId:         uid,
            forwarderToken: fwToken,
            // 2026-05-15 multi-browser fix: preserve organizeState across
            // treeUpdate relays from forwarders. The NM path at L464 has
            // the same line (`ebfad6f S2f Phase 3b bugfix #2`); the HTTP
            // /update path was missed in that fix. Without this, every
            // /update from a forwarder during the sift loop (bulk_apply
            // → pushTreeUpdate → forwardToExisting → /update) would wipe
            // organizeState and the agent's next poll would see 'idle'.
            organizeState: priorCache?.organizeState || null,
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
        req.url === '/organize-state-update' ||
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
  // 2026-05-15 multi-browser fix: forwarder → leader relay for auto-organize
  // workflow state. POST'd by _postOrganizeStateToLeader on the forwarder
  // when its local SW emits an organizeStateUpdate NM message (popup
  // confirm / pause / resume / reset / done). Mirrors handleNmMessage's
  // organizeStateUpdate branch for the NM-direct path.
  if (req.url === '/organize-state-update' && req.method === 'POST') {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const { browserId, browserBrand, payload, forwarderToken } = body;
        if (!browserId) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: { code: 'BAD_REQUEST', message: 'POST /organize-state-update requires { browserId }' } }));
          return;
        }
        // Token-bind to the forwarder that owns this browserId — same
        // pattern as /edit-result. Without it, any local process that
        // observed a browserId could spoof workflowStep:'sorting' and
        // race the agent into firing destructive bulk_apply moves
        // against the wrong bucket structure.
        const expectedToken = cachedData.get(browserId)?.forwarderToken || null;
        if (!expectedToken || forwarderToken !== expectedToken) {
          log(`/organize-state-update rejected for browserId=${(browserId||'').slice(0,16)}… — token mismatch`);
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: { code: 'TOKEN_MISMATCH', message: 'forwarderToken does not match the token recorded for this browserId.' } }));
          return;
        }
        const prior = cachedData.get(browserId) || {};
        const p = payload && typeof payload === 'object' ? payload : {};
        prior.organizeState = {
          workflowStep:      typeof p.workflowStep === 'string' ? p.workflowStep : 'idle',
          scope:             typeof p.scope === 'string' ? p.scope : null,
          libraryId:         typeof p.libraryId === 'string' ? p.libraryId : null,
          includeOtherRoots: !!p.includeOtherRoots,
          buckets:           Array.isArray(p.buckets) ? p.buckets : [],
          confirmedAt:       Number.isFinite(p.confirmedAt) ? p.confirmedAt : Date.now(),
          pushedAt:          Date.now(),
        };
        cachedData.set(browserId, prior);
        log(`organizeStateUpdate (HTTP relay) from ${browserBrand || 'unknown'}: workflowStep=${prior.organizeState.workflowStep} buckets=${prior.organizeState.buckets.length}`);
        // Phase 4.5-F: organizeState cache write retained (popup pushes
        // these regardless), but no MCP tool reads from it; auto-organize
        // workflow runs entirely in the popup.
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        log(`POST /organize-state-update error: ${e.message}`);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: { code: 'INTERNAL', message: e.message } }));
      }
    });
    return;
  }

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
// JSON-RPC messages to a local HTTP MCP server. Used by Claude Desktop, whose
// mcpServers config only accepts stdio subprocesses (command + args). Replaces
// the need for `npx mcp-remote` and the Node.js dependency on the end user's
// machine.
//
// Resilience contract (2026-08-03): the bridge on `httpUrl` is spawned by a
// BROWSER (native messaging), so "nothing is listening on 37421" is a normal,
// expected state — the user simply hasn't opened a browser yet. The old shim
// proxied `initialize` to the bridge, so a stopped bridge failed the MCP
// handshake and the AI client painted a "could not attach" error banner on
// every launch. The shim must therefore NEVER let bridge downtime reach the
// handshake:
//   - `initialize` / `notifications/initialized` are ALWAYS answered by a
//     local in-process McpServer — the same createMcpServer() the HTTP bridge
//     builds per session, so serverInfo / instructions / capabilities /
//     tool catalog are identical by construction (no cached copy to drift).
//   - The remote session is shim-originated: we self-author an `initialize`
//     to the bridge lazily (on demand, plus a background retry while down),
//     never forwarding the client's own handshake.
//   - `tools/list` and other catalog/utility requests forward to the live
//     bridge when it's up, and fall back to the local instance when not.
//   - `tools/call` while the bridge is down returns an in-band tool result
//     with isError:true and actionable text — the model relays it; no
//     protocol error, no banner.
//   - When the bridge comes back, the shim reconnects transparently and (if
//     it ever served a locally-answered tools/list) emits
//     notifications/tools/list_changed so the client refreshes its catalog
//     from the live bridge.
async function runStdioBridge(httpUrl) {
  const stdio = new StdioServerTransport();

  // ── Local fallback backend ──
  // A loopback transport wired straight to stdio: whatever the local server
  // answers goes back to the client verbatim. Only messages we explicitly
  // route here (feedLocal) reach it, so it can never double-answer a request
  // that was forwarded to the live bridge.
  const loopback = {
    async start() {},
    async close() {},
    async send(msg) {
      try { await stdio.send(msg); }
      catch (err) { process.stderr.write(`[stdio-mcp] local reply error: ${err.message}\n`); }
    },
    onmessage: null,
    onerror: null,
    onclose: null,
  };
  const localServer = createMcpServer();
  await localServer.connect(loopback);
  const feedLocal = (msg) => {
    try { loopback.onmessage && loopback.onmessage(msg); }
    catch (err) { process.stderr.write(`[stdio-mcp] local dispatch error: ${err.message}\n`); }
  };

  // ── Remote (live bridge) session state ──
  let remote = null;                 // StreamableHTTPClientTransport with an established session
  let ensureInFlight = null;         // mutex: concurrent callers share one connection attempt
  let clientProtocolVersion = '2025-03-26'; // echo the client's negotiated version to the bridge
  let servedLocalToolsList = false;  // catalog was answered locally → notify list_changed on reconnect
  let downLogged = false;            // log unreachability once per outage, not per retry
  let retryTimer = null;
  let shimIdCounter = 0;
  const shimSuppressIds = new Set(); // shim-originated request ids; swallow their responses

  // Session-not-found from a live bridge after leader rotation (Slice W-4) —
  // distinct from "nothing is listening": the bridge is up but our session id
  // died with the old leader, so rebuild the session and retry the message.
  const STALE_SESSION_RE = /Session not found|-32001|reinitialize|HTTP 404|status code 404/i;
  // Transport-level unreachability — the bridge process isn't there (or is
  // wedged). This marks the remote DOWN and starts the background retry.
  const CONNECTION_ERR_RE = /fetch failed|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|EPIPE|socket hang up|network|timed out/i;

  const withTimeout = (promise, ms, what) => new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(what)), ms);
    if (t.unref) t.unref();
    promise.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); }
    );
  });

  function wireRemoteListeners(t) {
    t.onmessage = async (msg) => {
      // Swallow responses to shim-originated requests (the self-authored
      // initialize) — the client already completed its own handshake locally.
      if (msg && msg.id !== undefined && shimSuppressIds.has(msg.id)) {
        shimSuppressIds.delete(msg.id);
        return;
      }
      try { await stdio.send(msg); }
      catch (err) { process.stderr.write(`[stdio-mcp] reply error: ${err.message}\n`); }
    };
    t.onerror = (err) => {
      process.stderr.write(`[stdio-mcp] remote transport error: ${err.message}\n`);
    };
  }

  function teardownRemote() {
    if (remote) { const t = remote; remote = null; t.close().catch(() => {}); }
  }

  function scheduleRetry() {
    if (retryTimer) return;
    retryTimer = setInterval(() => { ensureRemote(); }, 15000);
    if (retryTimer.unref) retryTimer.unref();
  }

  function stopRetry() {
    if (retryTimer) { clearInterval(retryTimer); retryTimer = null; }
  }

  function markRemoteDown(reason) {
    teardownRemote();
    if (!downLogged) {
      downLogged = true;
      process.stderr.write(`[stdio-mcp] bridge unreachable at ${httpUrl} (${reason}) — serving handshake/catalog locally; will keep retrying\n`);
    }
    scheduleRetry();
  }

  async function establishRemoteSession() {
    const t = new StreamableHTTPClientTransport(new URL(httpUrl));
    wireRemoteListeners(t);
    await t.start();
    const initId = `pinako-shim-init-${++shimIdCounter}`;
    shimSuppressIds.add(initId);
    try {
      // ECONNREFUSED fails in milliseconds; the timeout only bounds a bridge
      // whose port is open but wedged (zombie leader mid-rotation).
      await withTimeout(t.send({
        jsonrpc: '2.0',
        id: initId,
        method: 'initialize',
        params: {
          protocolVersion: clientProtocolVersion,
          capabilities: {},
          clientInfo: { name: 'pinako-stdio-bridge', version: pkg.version },
        },
      }), 8000, 'bridge initialize timed out');
      // send() resolves after the HTTP response headers are processed, so the
      // transport already holds the Mcp-Session-Id for subsequent requests.
      await t.send({ jsonrpc: '2.0', method: 'notifications/initialized' }).catch(() => {});
      return t;
    } catch (err) {
      shimSuppressIds.delete(initId);
      t.close().catch(() => {});
      throw err;
    }
  }

  // Establish (or reuse) the shim→bridge session. Returns true when the
  // remote is usable. Never throws; failure marks the remote down and lets
  // the caller fall back to local handling.
  function ensureRemote() {
    if (remote) return Promise.resolve(true);
    if (!ensureInFlight) {
      ensureInFlight = (async () => {
        try {
          const t = await establishRemoteSession();
          remote = t;
          stopRetry();
          if (downLogged) {
            downLogged = false;
            process.stderr.write(`[stdio-mcp] reconnected to ${httpUrl}\n`);
          } else {
            process.stderr.write(`[stdio-mcp] connected to ${httpUrl}\n`);
          }
          // The client's catalog may have come from the local fallback; tell
          // it to re-list so it picks up the live bridge's catalog (normally
          // identical — same binary — but version skew across an update or a
          // host-extension delta would otherwise linger until app restart).
          if (servedLocalToolsList) {
            servedLocalToolsList = false;
            try { await stdio.send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }); } catch (_) {}
          }
          return true;
        } catch (err) {
          markRemoteDown((err && err.message) ? err.message : String(err));
          return false;
        } finally {
          ensureInFlight = null;
        }
      })();
    }
    return ensureInFlight;
  }

  // Answer a message without the live bridge. Requests that only need the
  // catalog/protocol (tools/list, ping, prompts/*, resources/*) go to the
  // local instance — byte-identical behavior to the real bridge. tools/call
  // needs live browser data, so it gets an in-band, actionable tool error
  // the model can relay (never a protocol error, which clients render as a
  // server failure).
  async function respondWithoutBridge(msg, detail) {
    const isRequest = msg && msg.method !== undefined && msg.id !== undefined && msg.id !== null;
    if (!isRequest) return; // notification or stray response — nothing to answer
    if (msg.method === 'tools/call') {
      const text = (detail && !CONNECTION_ERR_RE.test(detail))
        ? `Pinako bridge error: ${detail}. The Pinako browser extension may be restarting — try again in a few seconds.`
        : 'Pinako Bridge isn\'t running — no browser with the Pinako extension is connected right now. Ask the user to open their browser (with the Pinako extension enabled); the bridge reconnects automatically within a few seconds. This request was NOT executed.';
      try {
        await stdio.send({
          jsonrpc: '2.0',
          id: msg.id,
          result: { content: [{ type: 'text', text }], isError: true },
        });
      } catch (_) { /* stdio gone, give up */ }
      return;
    }
    if (msg.method === 'tools/list') servedLocalToolsList = true;
    feedLocal(msg);
  }

  // stdio (from the AI client) → remote bridge, local fallback, or both
  stdio.onmessage = async (msg) => {
    // The handshake is ALWAYS local — a stopped bridge must never be able to
    // fail it (that failure is exactly what painted the client's attach
    // banner). The local instance shares createMcpServer() with the real
    // bridge, so the client sees the same serverInfo/instructions/catalog.
    if (msg && msg.method === 'initialize') {
      if (msg.params && msg.params.protocolVersion) {
        clientProtocolVersion = msg.params.protocolVersion;
      }
      feedLocal(msg);
      ensureRemote(); // background warm-up; don't block the handshake on it
      return;
    }
    if (msg && msg.method === 'notifications/initialized') {
      feedLocal(msg);
      return;
    }

    // Lazy per-message connect: fails in milliseconds when nothing listens.
    const up = await ensureRemote();
    if (!up) {
      await respondWithoutBridge(msg, null);
      return;
    }

    try {
      await remote.send(msg);
      return;
    } catch (err) {
      let effectiveErr = err;
      const errStr = (err && err.message) ? err.message : String(err) || '';
      if (STALE_SESSION_RE.test(errStr)) {
        // Slice W-4: leader rotated, session id died with it. Rebuild the
        // shim-originated session and retry the original message once.
        process.stderr.write('[stdio-mcp] stale session — re-handshaking transparently...\n');
        teardownRemote();
        try {
          if (await ensureRemote()) {
            await remote.send(msg);
            process.stderr.write('[stdio-mcp] request retried after re-handshake\n');
            return;
          }
        } catch (retryErr) {
          effectiveErr = retryErr;
        }
      }
      const emsg = (effectiveErr && effectiveErr.message) ? effectiveErr.message : String(effectiveErr);
      process.stderr.write(`[stdio-mcp] forward error: ${emsg}\n`);
      if (CONNECTION_ERR_RE.test(emsg)) markRemoteDown(emsg);
      await respondWithoutBridge(msg, emsg);
    }
  };

  stdio.onerror = (err) => {
    process.stderr.write(`[stdio-mcp] stdio transport error: ${err.message}\n`);
  };

  // Note: localServer.connect() already started the loopback; StdioServerTransport
  // starts here, after all handlers are wired.
  await stdio.start();

  // Warm up the bridge connection in the background. Failure is fine — the
  // handshake and catalog are served locally, and the retry loop + per-call
  // lazy connects pick the bridge up the moment a browser opens.
  ensureRemote();

  // Shut down cleanly when the AI client closes the stdio pipe.
  process.stdin.on('end', async () => {
    process.stderr.write('[stdio-mcp] stdin closed, shutting down\n');
    stopRetry();
    try { await stdio.close(); } catch (_) {}
    try { if (remote) await remote.close(); } catch (_) {}
    try { await localServer.close(); } catch (_) {}
    process.exit(0);
  });
}

if (BRIDGE_URL) {
  runStdioBridge(BRIDGE_URL).catch((err) => {
    process.stderr.write(`[pinako-mcp stdio bridge] fatal: ${err.message}\n`);
    process.exit(1);
  });
}
