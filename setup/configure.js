/**
 * setup/configure.js
 *
 * Writes Pinako MCP config entries into each AI client's config file.
 * Each client gets a deep-merge: existing config is preserved, only
 * the pinako entry is added/updated.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { HOME, SERVICE_PATH } from './paths.js';

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

// readJson() above deliberately swallows parse errors and returns {} — safe for
// the small per-client MCP config files we own outright (a 0-byte or corrupt
// mcp.json should just be replaced). It is NOT safe for a large stateful file
// the client owns, where {} would silently destroy the user's data. Use this
// instead there: missing → null (create it), unparseable → throw (leave it be).
function readJsonStrict(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
  if (!raw.trim()) return null;
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`${filePath} exists but is not valid JSON (${e.message}) — refusing to overwrite it`);
  }
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

// ─── Claude Code helpers ─────────────────────────────────────────────────────
// Claude Code stores MCP servers in ~/.claude.json (both `local` and `user`
// scope) or in a project-root .mcp.json. It does NOT read them from
// ~/.claude/settings.json — that file only carries *approval* flags
// (enabledMcpjsonServers / disabledMcpjsonServers) for servers defined
// elsewhere. We wrote settings.json up to 2026-07-23, so every install since
// the bridge shipped registered a server Claude Code silently ignored.
// Re-installs now clean that stale key up as well as writing the real one.
//
// Preferred path is the documented CLI (`claude mcp add --scope user`): it owns
// the file's schema and locking, and ~/.claude.json is a large live file Claude
// Code writes to constantly. Direct merge is the fallback for machines where
// the launcher isn't on PATH.

const CLAUDE_JSON_PATH = path.join(HOME, '.claude.json');
const CLAUDE_SETTINGS_PATH = path.join(HOME, '.claude', 'settings.json');

// Windows resolves the `claude.cmd` npm shim only via cmd — Node refuses to
// spawn .cmd directly, and `shell: true` would emit a DEP0190 warning into the
// installer's output. Going through `cmd /c` explicitly avoids both.
function runClaudeCli(args) {
  const win = process.platform === 'win32';
  const res = win
    ? spawnSync('cmd', ['/c', 'claude', ...args], { stdio: 'ignore', timeout: 60_000 })
    : spawnSync('claude', args, { stdio: 'ignore', timeout: 60_000 });
  return res.status === 0;
}

function addViaClaudeCli() {
  // `claude mcp add` errors when the name is taken, so drop any prior entry
  // first. A missing entry makes remove fail harmlessly — ignore its status.
  runClaudeCli(['mcp', 'remove', 'pinako', '--scope', 'user']);
  return runClaudeCli(['mcp', 'add', '--scope', 'user', '--transport', 'http', 'pinako', MCP_URL]);
}

function addViaClaudeJsonMerge() {
  const config = readJsonStrict(CLAUDE_JSON_PATH) || {};
  config.mcpServers = config.mcpServers || {};
  config.mcpServers.pinako = { type: 'http', url: MCP_URL };
  writeJson(CLAUDE_JSON_PATH, config);
}

// Remove the entry earlier installers wrote to the file Claude Code ignores, so
// a stale 127.0.0.1 record can't shadow the real one in a user's mental model.
function pruneStaleClaudeSettingsEntry() {
  let config;
  try {
    config = readJsonStrict(CLAUDE_SETTINGS_PATH);
  } catch {
    return; // unparseable settings.json is the user's business, not ours
  }
  if (!config?.mcpServers?.pinako) return;
  delete config.mcpServers.pinako;
  if (Object.keys(config.mcpServers).length === 0) delete config.mcpServers;
  writeJson(CLAUDE_SETTINGS_PATH, config);
}

// ─── Antigravity helpers ─────────────────────────────────────────────────────
// Antigravity reads `~/.gemini/config/mcp_config.json` (global) or a workspace
// `.agents/mcp_config.json`. It used to read a per-tool
// `~/.gemini/antigravity/mcp_config.json`; current builds migrate that forward
// and drop a `.migrated` marker beside the new file. HTTP entries use the
// `serverUrl` key — `url` and `httpUrl` are explicitly unsupported.

const ANTIGRAVITY_LEGACY_PATH =
  path.join(HOME, '.gemini', 'antigravity', 'mcp_config.json');

function writeAntigravityConfig(configPath) {
  const config = readJson(configPath);
  config.mcpServers = config.mcpServers || {};
  config.mcpServers.pinako = { serverUrl: MCP_URL };
  writeJson(configPath, config);
}

// ─── Per-client config writers ────────────────────────────────────────────────

const writers = {

  'claude-code'() {
    // configPath is ignored: which file we touch depends on whether the CLI is
    // available, and we clean a second file either way.
    if (!addViaClaudeCli()) addViaClaudeJsonMerge();
    pruneStaleClaudeSettingsEntry();
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

  'antigravity'(configPath) {
    writeAntigravityConfig(configPath);
    // Refresh the pre-migration per-tool path too, but only when it already
    // exists — creating it on a current build would leave an orphan file that
    // nothing reads and that contradicts the live config.
    if (configPath !== ANTIGRAVITY_LEGACY_PATH && fs.existsSync(ANTIGRAVITY_LEGACY_PATH)) {
      writeAntigravityConfig(ANTIGRAVITY_LEGACY_PATH);
    }
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
