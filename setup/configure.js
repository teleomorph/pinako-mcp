/**
 * setup/configure.js
 *
 * Writes Pinako MCP config entries into each AI client's config file.
 * Each client gets a deep-merge: existing config is preserved, only
 * the pinako entry is added/updated.
 */

import fs from 'node:fs';
import path from 'node:path';
import { SERVICE_PATH } from './paths.js';

const MCP_URL = 'http://127.0.0.1:37421/mcp';

// ─── Read-only tool list (auto-approved by default) ──────────────────────────
// Cline / Roo Code / Continue.dev each support an `autoApprove: [...]` array
// in their MCP server config. Tools listed here are pre-approved on install
// — the AI client won't prompt the user before each call. Limited to tools
// that DO NOT modify user data (reads only). Any tool that touches the tab
// tree, libraries, bookmarks, or notes is OMITTED so the user keeps per-call
// confirmation on writes.
//
// User can edit the array post-install to widen or tighten the policy.
// Mirrors the readOnlyHint=true set in pinako-mcp/host.js TOOL_ANNOTATIONS.
//
// Keep in sync with:
//   - pinako-mcp/host.js TOOL_ANNOTATIONS (readOnlyHint=true entries)
//   - pinako-mcp/installer/src-tauri/src/main.rs READ_ONLY_TOOLS
//
// 2026-05-25 (security review): removed 11 Phase 4.5-F auto-organize tool
// names (auto_organize_bookmarks, apply_heuristic_organize, propose_*,
// refine_folder_outliers, resolve_duplicate_landings, get_organize_state,
// get_observations, record_observation, summarize_organize_results,
// complete_organize_sort). Those MCP tools were deleted when auto-organize
// moved to the extension popup; pre-approving deleted-then-recycled names
// would be a latent privesc surface if any name is ever reused with write
// semantics. Also added search_pinako (was always read-only in host.js).
const READ_ONLY_TOOLS = [
  'get_tree',
  'search_tabs',
  'search_pinako',
  'list_libraries',
  'get_library',
  'get_main_tree_notes',
  'get_bookmarks',
  'list_browsers',
  'find_duplicates',
  'get_tree_summary',
  'search_docs',
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return {};
  }
}

function writeJson(filePath, obj) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

// Deep-merge src into dst (one level for mcpServers, not recursive)
function mergeConfig(dst, src) {
  for (const [key, val] of Object.entries(src)) {
    if (val && typeof val === 'object' && !Array.isArray(val) &&
        dst[key] && typeof dst[key] === 'object') {
      dst[key] = { ...dst[key], ...val };
    } else {
      dst[key] = val;
    }
  }
  return dst;
}

// ─── TOML helpers (Codex) ───────────────────────────────────────────────────
// Codex stores MCP servers in ~/.codex/config.toml, not JSON. That file is
// usually hand-maintained (model prefs, plugins, other MCP servers, comments),
// so we do a FORMAT-PRESERVING targeted edit rather than parsing the whole
// file and re-serializing it (which would strip comments and reflow every
// line). We rewrite ONLY the [mcp_servers.pinako] table — and any of its
// sub-tables — leaving every other byte of the user's config untouched.
//
// Codex classifies a server with a `url` field as streamable-HTTP transport
// automatically; no experimental flag is needed (and writing an unrecognized
// flag would break `--strict-config`), so the block is intentionally minimal.

const CODEX_TABLE = 'mcp_servers.pinako';
const TOML_HEADER_RE = /^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*$/;

// Remove the [mcp_servers.pinako] table and any [mcp_servers.pinako.<sub>]
// sub-tables from a TOML string, preserving all other content verbatim.
function stripTomlTable(toml, table) {
  const nl = /\r\n/.test(toml) ? '\r\n' : '\n';
  const out = [];
  let skipping = false;
  for (const line of toml.split(/\r?\n/)) {
    const m = line.match(TOML_HEADER_RE);
    if (m) {
      const name = m[1].trim();
      skipping = name === table || name.startsWith(table + '.');
      if (skipping) continue; // drop the table header itself
    }
    if (skipping) continue;   // drop lines belonging to the skipped table
    out.push(line);
  }
  return out.join(nl);
}

function buildPinakoTomlBlock(nl) {
  return [
    `[${CODEX_TABLE}]`,
    `url = "${MCP_URL}"`,
    'startup_timeout_sec = 20',
  ].join(nl);
}

// ─── Per-client config writers ────────────────────────────────────────────────

const writers = {

  'claude-code'(configPath) {
    const config = readJson(configPath);
    config.mcpServers = config.mcpServers || {};
    config.mcpServers.pinako = { type: 'http', url: MCP_URL };
    writeJson(configPath, config);
  },

  'claude-desktop'(configPath) {
    const config = readJson(configPath);
    config.mcpServers = config.mcpServers || {};
    // Claude Desktop only supports stdio MCP servers (command + args).
    // Use the bundled pinako-mcp-service binary in --stdio-mcp mode as a
    // self-contained stdio↔HTTP bridge — no Node.js dependency on the
    // end user's machine.
    config.mcpServers.pinako = {
      command: SERVICE_PATH,
      args: ['--stdio-mcp', MCP_URL],
    };
    writeJson(configPath, config);
  },

  'cursor'(configPath) {
    const config = readJson(configPath);
    config.mcpServers = config.mcpServers || {};
    config.mcpServers.pinako = { url: MCP_URL };
    writeJson(configPath, config);
  },

  'windsurf'(configPath) {
    const config = readJson(configPath);
    config.mcpServers = config.mcpServers || {};
    config.mcpServers.pinako = { url: MCP_URL };
    writeJson(configPath, config);
  },

  'cline'(configPath) {
    const config = readJson(configPath);
    config.mcpServers = config.mcpServers || {};
    config.mcpServers.pinako = {
      url: MCP_URL,
      disabled: false,
      autoApprove: [...READ_ONLY_TOOLS],
    };
    writeJson(configPath, config);
  },

  'roo-code'(configPath) {
    const config = readJson(configPath);
    config.mcpServers = config.mcpServers || {};
    config.mcpServers.pinako = {
      url: MCP_URL,
      disabled: false,
      autoApprove: [...READ_ONLY_TOOLS],
    };
    writeJson(configPath, config);
  },

  'continue'(configPath) {
    const config = readJson(configPath);
    config.experimental = config.experimental || {};
    config.experimental.modelContextProtocolServers =
      config.experimental.modelContextProtocolServers || [];

    const servers = config.experimental.modelContextProtocolServers;
    // Remove any existing pinako entry to avoid duplicates
    const filtered = servers.filter(s => s?.transport?.url !== MCP_URL);
    filtered.push({ transport: { type: 'streamableHttp', url: MCP_URL } });
    config.experimental.modelContextProtocolServers = filtered;
    writeJson(configPath, config);
  },

  'codex'(configPath) {
    let existing = '';
    try { existing = fs.readFileSync(configPath, 'utf8'); } catch { existing = ''; }
    const nl = /\r\n/.test(existing) ? '\r\n' : '\n';
    // Drop any prior pinako block (idempotent re-install / localhost→127.0.0.1
    // normalization), then append a fresh canonical block at the end.
    const stripped = stripTomlTable(existing, CODEX_TABLE).replace(/\s+$/, '');
    const block = buildPinakoTomlBlock(nl);
    const next = stripped
      ? stripped + nl + nl + block + nl
      : block + nl;
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, next, 'utf8');
  },

};

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Configure a single client by id.
 * Returns { ok: true } or { ok: false, error: string }
 */
export function configureClient(client) {
  const writer = writers[client.id];
  if (!writer) {
    return { ok: false, error: `No writer defined for client: ${client.id}` };
  }
  try {
    writer(client.configPath);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * Configure multiple clients. Returns array of { client, ok, error? }.
 */
export function configureClients(clients) {
  return clients.map(client => ({
    client,
    ...configureClient(client),
  }));
}
