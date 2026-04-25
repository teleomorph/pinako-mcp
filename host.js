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

// ─── In-memory cache ─────────────────────────────────────────────────────────
let cachedData = null; // { tree, libraries, globalNotes, updatedAt }
let extensionConnected = false;
let shutdownTimer = null;
let forwardToExisting = null; // set on EADDRINUSE — forward data to old instance then exit

// ─── Native Messaging write ───────────────────────────────────────────────────
// Chrome NM protocol: 4-byte LE length prefix + UTF-8 JSON body.
// Write to stdout only. Never use console.log() — it corrupts stdout.
function nmWrite(obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  process.stdout.write(Buffer.concat([header, body]));
}

// ─── Native Messaging async read ─────────────────────────────────────────────
// Reads Chrome NM messages from stdin asynchronously so the event loop
// (and HTTP server) stays responsive between messages.
let stdinBuf = Buffer.alloc(0);

function handleNmMessage(msg) {
  if (msg.type === 'treeUpdate' || msg.type === 'treeResponse') {
    if (forwardToExisting) {
      // EADDRINUSE path: forward data to old instance and exit
      forwardToExisting(msg.data);
      return;
    }
    if (shutdownTimer) {
      clearTimeout(shutdownTimer);
      shutdownTimer = null;
    }
    extensionConnected = true;
    cachedData = {
      tree:        msg.data.tree        || [],
      libraries:   msg.data.libraries   || [],
      globalNotes: msg.data.globalNotes || [],
      updatedAt:   Date.now(),
    };
    process.stderr.write(`[pinako-mcp] Tree updated: ${cachedData.tree.length} windows.\n`);
  }
}

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

function getTree(includeGhost = true) {
  if (!cachedData) return null;
  const tree = cachedData.tree.map(sanitizeNode);
  // Always strip incognito nodes — incognito data must never leave the local device
  function filterNodes(nodes) {
    return nodes
      .filter(n => !n.incognito)
      .filter(n => includeGhost || n.type !== 'tab' || n.chromeId !== null)
      .map(n => ({ ...n, children: n.children ? filterNodes(n.children) : [] }));
  }
  return filterNodes(tree);
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

For complete documentation, see: https://pinako.pro/docs/ai-connect`;

function createMcpServer() {
  const srv = new McpServer(
    { name: 'pinako', version: '1.0.0' },
    { instructions: SERVER_INSTRUCTIONS }
  );

  srv.registerTool(
    'get_tree',
    {
      description:
        'Returns the full tab tree (Windows → Groups → Tabs) from the Pinako extension. ' +
        'Each node includes: id, type, title, url, favIconUrl, chromeId (null = ghost/closed tab), ' +
        'openedDate, memoText, tags, notes, collapsed, and children.',
      inputSchema: {
        include_ghost_tabs: z.boolean().optional().describe('Include closed/ghost tabs (chromeId=null). Default true.'),
      },
    },
    async ({ include_ghost_tabs = true }) => {
      if (!cachedData) return { content: [{ type: 'text', text: 'No data yet — open the Pinako extension first.' }], isError: true };
      return { content: [{ type: 'text', text: JSON.stringify({ tree: getTree(include_ghost_tabs), updatedAt: cachedData.updatedAt }) }] };
    }
  );

  srv.registerTool(
    'search_tabs',
    {
      description: 'Searches all tabs for a query. Matches title, URL, memo text, and tags. Returns matching tab nodes.',
      inputSchema: {
        query: z.string().describe('Search query (case-insensitive)'),
        include_ghost_tabs: z.boolean().optional().describe('Include closed/ghost tabs. Default true.'),
      },
    },
    async ({ query, include_ghost_tabs = true }) => {
      if (!cachedData) return { content: [{ type: 'text', text: 'No data yet — open the Pinako extension first.' }], isError: true };
      const results = searchInTree(cachedData.tree, query, include_ghost_tabs);
      return { content: [{ type: 'text', text: JSON.stringify({ results, count: results.length }) }] };
    }
  );

  srv.registerTool(
    'list_libraries',
    {
      description: 'Lists all Pinako libraries (saved tab collections). Returns id, title, description, tab count, and library-level notes.',
    },
    async () => {
      if (!cachedData) return { content: [{ type: 'text', text: 'No data yet — open the Pinako extension first.' }], isError: true };
      const libs = (cachedData.libraries || []).map(lib => ({
        id: lib.id, title: lib.title, description: lib.description || '',
        tabCount: countTabsInLibrary(lib.children || []), notes: lib.notes || [],
      }));
      return { content: [{ type: 'text', text: JSON.stringify({ libraries: libs }) }] };
    }
  );

  srv.registerTool(
    'get_library',
    {
      description: 'Returns the full contents of a Pinako library: folders, tabs, memos, tags, notes.',
      inputSchema: { library_id: z.string().describe('Library id from list_libraries') },
    },
    async ({ library_id }) => {
      if (!cachedData) return { content: [{ type: 'text', text: 'No data yet — open the Pinako extension first.' }], isError: true };
      const lib = (cachedData.libraries || []).find(l => l.id === library_id);
      if (!lib) return { content: [{ type: 'text', text: `Library not found: ${library_id}` }], isError: true };
      return { content: [{ type: 'text', text: JSON.stringify(sanitizeNode(lib)) }] };
    }
  );

  srv.registerTool(
    'get_global_notes',
    { description: 'Returns global notes — rich text documents not attached to any specific tab or library.' },
    async () => {
      if (!cachedData) return { content: [{ type: 'text', text: 'No data yet — open the Pinako extension first.' }], isError: true };
      return { content: [{ type: 'text', text: JSON.stringify({ globalNotes: cachedData.globalNotes || [] }) }] };
    }
  );

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
    res.end(JSON.stringify({ ok: true, extensionConnected, dataAge: cachedData ? Date.now() - cachedData.updatedAt : null }));
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
        const { data } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (data) {
          cachedData = { tree: data.tree || [], libraries: data.libraries || [], globalNotes: data.globalNotes || [], updatedAt: Date.now() };
          extensionConnected = true;
          if (shutdownTimer) { clearTimeout(shutdownTimer); shutdownTimer = null; }
          process.stderr.write(`[pinako-mcp] Cache refreshed via /update.\n`);
        }
        res.writeHead(200); res.end();
      } catch { res.writeHead(400); res.end(); }
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

httpServer.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    process.stderr.write(`[pinako-mcp] Port ${MCP_PORT} in use — relaying to existing instance.\n`);
    forwardToExisting = (data) => {
      const body = JSON.stringify({ data });
      const r = http.request(
        { hostname: '127.0.0.1', port: MCP_PORT, path: '/update', method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
        () => { process.stderr.write('[pinako-mcp] Relayed tree update.\n'); }
      );
      r.on('error', (err) => { process.stderr.write(`[pinako-mcp] Relay error: ${err.message}\n`); });
      r.write(body); r.end();
    };
    nmWrite({ type: 'getTree' });
  } else {
    process.stderr.write(`[pinako-mcp] HTTP error: ${e.message}\n`);
    process.exit(1);
  }
});

httpServer.listen(MCP_PORT, '127.0.0.1', () => {
  extensionConnected = true;
  process.stderr.write(`[pinako-mcp] Listening on http://127.0.0.1:${MCP_PORT}/mcp\n`);
  nmWrite({ type: 'getTree' });
});
