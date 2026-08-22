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
import { HOME, APPDATA, SERVICE_PATH } from './paths.js';
import { buildMcpUrl } from './token.js';

// ai-todo #67: the URL carries the machine-local access token.
//
// Resolved at the START OF EACH configure run, NOT at module load. It was a
// module-level const, which broke `rotate-token` — whose entire job is to
// regenerate the secret and rewrite every client. main.js imports this module
// (capturing the OLD token), then rotates, then calls configureClients, which
// wrote the captured value back into all 16 configs. Revocation reported
// success while leaving every client holding a token the bridge now rejects
// with a hard 401: strictly worse than not revoking at all.
//
// Still resolved ONCE PER RUN rather than per writer, so a rotation racing a
// configure pass cannot split the client table across two different tokens.
// Falls back to the bare URL if the token file can't be created — that client
// still works, read-only, instead of failing the install outright.
let MCP_URL = buildMcpUrl();

/** Re-read the token so this run writes whatever is currently on disk. */
function refreshMcpUrl() {
  MCP_URL = buildMcpUrl();
  return MCP_URL;
}

// ─── Read-only tool list (auto-approved by default) ──────────────────────────
// Cline supports an `autoApprove: [...]` array in its MCP server config;
// Roo Code and Zoo Code spell the same concept `alwaysAllow: [...]`. Tools
// listed here are pre-approved on install — the AI client won't prompt the
// user before each call. Limited to tools that DO NOT modify user data
// (reads only). Any tool that touches the tab tree, libraries, bookmarks,
// or notes is OMITTED so the user keeps per-call confirmation on writes.
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

// Atomic write: several clients (Cline notably) watch their config file with
// chokidar and can observe — and act on — a half-written file. Temp file in
// the same directory + rename is atomic on every platform we ship.
function writeJson(filePath, obj) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = filePath + '.pinako-tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, filePath);
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

// ─── TOML helpers (Codex + Grok Build) ──────────────────────────────────────
// Codex (~/.codex/config.toml) and Grok Build (~/.grok/config.toml) both store
// MCP servers as [mcp_servers.<name>] TOML tables. Those files are usually
// hand-maintained (model prefs, plugins, other MCP servers, comments), so we
// do a FORMAT-PRESERVING targeted edit rather than parsing the whole file and
// re-serializing it (which would strip comments and reflow every line). We
// rewrite ONLY the [mcp_servers.pinako] table — and any of its sub-tables —
// leaving every other byte of the user's config untouched.
//
// Both classify a server with a `url` field as streamable-HTTP transport
// automatically; no extra flag is needed (and writing an unrecognized key
// would break Codex's `--strict-config`), so the blocks stay minimal.

const PINAKO_TABLE = 'mcp_servers.pinako';
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

// Drop any prior pinako table (idempotent re-install), then append a fresh
// canonical block with the given body lines at the end of the file.
function upsertPinakoTomlTable(configPath, bodyLines) {
  let existing = '';
  try { existing = fs.readFileSync(configPath, 'utf8'); } catch { existing = ''; }
  const nl = /\r\n/.test(existing) ? '\r\n' : '\n';
  const stripped = stripTomlTable(existing, PINAKO_TABLE).replace(/\s+$/, '');
  const block = [`[${PINAKO_TABLE}]`, ...bodyLines].join(nl);
  const next = stripped
    ? stripped + nl + nl + block + nl
    : block + nl;
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, next, 'utf8');
}

// ─── YAML helper (Hermes) ───────────────────────────────────────────────────
// Hermes config is a large user-owned YAML we must not re-serialize (comments,
// anchors, _config_version). Textual surgery instead, three recognized cases:
//   - no `mcp_servers:` key → append a fresh block at EOF (the common case);
//   - `mcp_servers:` / `mcp_servers: {}` line → replace any existing pinako
//     child, insert ours first, matching the block's existing child indent;
//   - anything else (flow-style with content) → refuse with a manual hint
//     rather than risk corrupting the file.
// YAML forbids tabs in indentation, so space-math on indents is safe.
function upsertHermesYaml(configPath) {
  let text = '';
  try { text = fs.readFileSync(configPath, 'utf8'); } catch { text = ''; }
  const nl = /\r\n/.test(text) ? '\r\n' : '\n';
  const lines = text ? text.split(/\r?\n/) : [];

  const idx = lines.findIndex(l => /^mcp_servers:\s*(\{\s*\}\s*)?(#.*)?$/.test(l));
  if (idx === -1) {
    if (lines.some(l => /^mcp_servers:/.test(l))) {
      throw new Error(
        'config.yaml declares mcp_servers in a format this installer does not edit — ' +
        `add this entry manually: mcp_servers: { pinako: { url: "${MCP_URL}" } }`);
    }
    const block = ['mcp_servers:', '  pinako:', `    url: "${MCP_URL}"`, '    enabled: true'];
    const base = text.replace(/\s+$/, '');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(
      configPath,
      (base ? base + nl + nl : '') + block.join(nl) + nl,
      'utf8');
    return;
  }

  // Normalize `mcp_servers: {}` into an open block we can put children under.
  if (/\{/.test(lines[idx])) lines[idx] = 'mcp_servers:';

  // The block runs until the next non-blank line at column 0.
  let end = idx + 1;
  while (end < lines.length && !(/^\S/.test(lines[end]))) end++;
  const blockLines = lines.slice(idx + 1, end);

  // Siblings must share indentation — reuse the block's existing child indent.
  const firstChild = blockLines.find(l => l.trim() !== '');
  const indent = firstChild ? firstChild.match(/^(\s*)/)[1] : '  ';

  // Drop any existing pinako child (its header + every deeper line).
  const kept = [];
  let skipping = false;
  for (const l of blockLines) {
    if (new RegExp(`^${indent}pinako:\\s*(#.*)?$`).test(l)) { skipping = true; continue; }
    if (skipping) {
      if (l.trim() === '' || l.match(/^(\s*)/)[1].length > indent.length) continue;
      skipping = false;
    }
    kept.push(l);
  }

  const child = [
    `${indent}pinako:`,
    `${indent}${indent || '  '}url: "${MCP_URL}"`,
    `${indent}${indent || '  '}enabled: true`,
  ];
  const next = [
    ...lines.slice(0, idx + 1),
    ...child,
    ...kept,
    ...lines.slice(end),
  ].join(nl).replace(/\s+$/, '') + nl;
  fs.writeFileSync(configPath, next, 'utf8');
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

// ─── VS Code helpers ─────────────────────────────────────────────────────────

const VSCODE_MCP_PATH = path.join(APPDATA, 'Code', 'User', 'mcp.json');

// Cline's next/SDK bundle, CLI, and JetBrains plugin share this file
// (CLINE_MCP_SETTINGS_PATH / CLINE_DATA_DIR env overrides honored upstream;
// we write the default since the installer configures default installs).
const CLINE_SHARED_SETTINGS_PATH = path.join(
  HOME, '.cline', 'data', 'settings', 'cline_mcp_settings.json'
);

// `code --add-mcp '<json>'` upserts into the active profile's mcp.json.
// Same .cmd-shim spawn rules as the claude CLI.
function addViaVscodeCli() {
  const entry = JSON.stringify({ name: 'pinako', type: 'http', url: MCP_URL });
  const win = process.platform === 'win32';
  const res = win
    ? spawnSync('cmd', ['/c', 'code', '--add-mcp', entry], { stdio: 'ignore', timeout: 60_000 })
    : spawnSync('code', ['--add-mcp', entry], { stdio: 'ignore', timeout: 60_000 });
  return res.status === 0;
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
    // `type` is load-bearing: omitting it selects Cline's legacy SSE
    // transport (kept as the schema default for back-compat), which is the
    // wrong protocol for our streamable-HTTP endpoint. Value is camelCase.
    //
    // Cline 4.1.x A/B-tests two bundles per window that read DIFFERENT
    // paths: legacy → the globalStorage file (configPath), next/SDK → the
    // ~/.cline shared file (also read by the Cline CLI and JetBrains). The
    // flag is remote and can flip on any reload, so write both.
    const entry = {
      type: 'streamableHttp',
      url: MCP_URL,
      disabled: false,
      autoApprove: [...READ_ONLY_TOOLS],
    };
    for (const p of [configPath, CLINE_SHARED_SETTINGS_PATH]) {
      const config = readJson(p);
      config.mcpServers = config.mcpServers || {};
      config.mcpServers.pinako = { ...entry };
      writeJson(p, config);
    }
  },

  'roo-code'(configPath) {
    // Roo requires an explicit hyphenated `type` for URL servers (it throws
    // otherwise) and its auto-approve field is `alwaysAllow`, NOT Cline's
    // `autoApprove`. Product discontinued 2026-05-15; this keeps existing
    // installs working. Zoo Code (below) is the active successor fork with
    // the identical schema.
    const config = readJson(configPath);
    config.mcpServers = config.mcpServers || {};
    config.mcpServers.pinako = {
      type: 'streamable-http',
      url: MCP_URL,
      disabled: false,
      alwaysAllow: [...READ_ONLY_TOOLS],
    };
    writeJson(configPath, config);
  },

  'zoo-code'(configPath) {
    // Community successor to Roo Code (official handoff); Roo-style schema.
    const config = readJson(configPath);
    config.mcpServers = config.mcpServers || {};
    config.mcpServers.pinako = {
      type: 'streamable-http',
      url: MCP_URL,
      disabled: false,
      alwaysAllow: [...READ_ONLY_TOOLS],
    };
    writeJson(configPath, config);
  },

  'continue'(configPath) {
    // Standalone MCP block file at ~/.continue/mcpServers/pinako.yaml. The
    // IDE extensions scan that folder; we own this file outright so a plain
    // overwrite is idempotent and can never clobber the user's config.yaml.
    // (The previous writer targeted config.json's experimental key, which
    // Continue ignores once config.yaml exists — a silent no-op in practice.)
    const yaml = [
      'name: Pinako',
      'version: 0.0.1',
      'schema: v1',
      'mcpServers:',
      '  - name: Pinako',
      '    type: streamable-http',
      `    url: ${MCP_URL}`,
      '',
    ].join('\n');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, yaml, 'utf8');
  },

  'codex'(configPath) {
    upsertPinakoTomlTable(configPath, [`url = "${MCP_URL}"`, 'startup_timeout_sec = 20']);
  },

  'grok'(configPath) {
    // Same [mcp_servers.pinako] shape as Codex; `enabled = true` matches the
    // bundled docs' convention for url-form servers.
    upsertPinakoTomlTable(configPath, [`url = "${MCP_URL}"`, 'enabled = true']);
  },

  'kimi-code'(configPath) {
    // Dedicated mcp.json (Claude-Desktop-compatible shape); a bare `url`
    // with no `transport` key is treated as streamable HTTP.
    const config = readJson(configPath);
    config.mcpServers = config.mcpServers || {};
    config.mcpServers.pinako = { url: MCP_URL };
    writeJson(configPath, config);
  },

  'openclaw'(configPath) {
    // openclaw.json is the MAIN gateway config (channels, auth, plugins,
    // agents) — strict read so a corrupt file is refused, never replaced by
    // {}. Unlike Kimi/Hermes, the transport is NOT inferred from `url`;
    // "streamable-http" must be explicit. Gateway reads config at startup —
    // the client note tells the user to restart it.
    const config = readJsonStrict(configPath) || {};
    config.mcp = config.mcp || {};
    config.mcp.servers = config.mcp.servers || {};
    config.mcp.servers.pinako = {
      url: MCP_URL,
      transport: 'streamable-http',
      enabled: true,
    };
    writeJson(configPath, config);
  },

  'hermes'(configPath) {
    upsertHermesYaml(configPath);
  },

  'vscode'() {
    // Prefer `code --add-mcp`: it writes to the ACTIVE profile (a file
    // written to User/mcp.json is invisible to users running a named
    // profile) and lets VS Code own its JSONC parsing. Live-verified: VS
    // Code writes {servers: {pinako: {type: 'http', url}}} — note the
    // top-level key is `servers`, not `mcpServers`. Fallback merges the
    // default profile's mcp.json directly.
    if (!addViaVscodeCli()) {
      const config = readJsonStrict(VSCODE_MCP_PATH) || {};
      config.servers = config.servers || {};
      config.servers.pinako = { type: 'http', url: MCP_URL };
      writeJson(VSCODE_MCP_PATH, config);
    }
  },

  'gemini-cli'(configPath) {
    // ~/.gemini/settings.json is Gemini CLI's main settings file (auth,
    // prefs) — strict read so a corrupt file is refused. Streamable HTTP
    // uses the `httpUrl` key (`url` means SSE here, and Antigravity's
    // `serverUrl` file is a different product that does not serve this CLI).
    const config = readJsonStrict(configPath) || {};
    config.mcpServers = config.mcpServers || {};
    config.mcpServers.pinako = { httpUrl: MCP_URL };
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
  // #67: pick up a token rotated after this module was imported. Cheap (one
  // small read) and it makes a single-client configure correct on its own,
  // not just when it happens to go through configureClients.
  refreshMcpUrl();
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
  // Resolve once for the whole batch so every client in one run gets the same
  // token even if a rotation lands mid-loop.
  refreshMcpUrl();
  const batchUrl = MCP_URL;
  return clients.map(client => {
    MCP_URL = batchUrl;
    const writer = writers[client.id];
    if (!writer) return { client, ok: false, error: `No writer defined for client: ${client.id}` };
    try { writer(client.configPath); return { client, ok: true }; }
    catch (e) { return { client, ok: false, error: e.message }; }
  });
}
