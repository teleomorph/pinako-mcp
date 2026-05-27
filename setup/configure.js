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
