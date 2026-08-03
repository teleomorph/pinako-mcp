/**
 * setup/detect.js
 *
 * Detects installed AI clients that support MCP on the current machine.
 * Returns an array of client descriptors, each with: id, label, configPath, found.
 */

import fs from 'node:fs';
import path from 'node:path';
import { HOME, APPDATA } from './paths.js';

// ─── Home-dir resolution for clients with env overrides ──────────────────────

// Grok Build and Kimi Code honor a home-override env var; use it when set.
const GROK_HOME = process.env.GROK_HOME || path.join(HOME, '.grok');
const KIMI_CODE_HOME = process.env.KIMI_CODE_HOME || path.join(HOME, '.kimi-code');
const OPENCLAW_HOME = process.env.OPENCLAW_STATE_DIR || path.join(HOME, '.openclaw');

// Hermes: HERMES_HOME wins; the native Windows installer uses
// %LOCALAPPDATA%\hermes rather than the POSIX ~/.hermes, so probe both and
// prefer whichever exists (LOCALAPPDATA first — it's the Windows default).
function resolveHermesHome() {
  if (process.env.HERMES_HOME) return process.env.HERMES_HOME;
  const candidates = [];
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    candidates.push(path.join(process.env.LOCALAPPDATA, 'hermes'));
  }
  candidates.push(path.join(HOME, '.hermes'));
  return candidates.find(p => { try { fs.accessSync(p); return true; } catch { return false; } })
    || candidates[0];
}
const HERMES_HOME = resolveHermesHome();

// ─── Client definitions ───────────────────────────────────────────────────────

export const CLIENTS = [
  {
    id: 'claude-code',
    label: 'Claude Code',
    // MCP servers live in ~/.claude.json (local + user scope), NOT in
    // ~/.claude/settings.json — that file only holds approval flags for
    // .mcp.json servers. The writer prefers `claude mcp add --scope user` and
    // only merges this file directly when the CLI isn't on PATH.
    configPath: path.join(HOME, '.claude.json'),
    detectPath: path.join(HOME, '.claude'),
    detectType: 'dir',
    note: null,
  },
  {
    id: 'claude-desktop',
    label: 'Claude Desktop',
    configPath: path.join(APPDATA, 'Claude', 'claude_desktop_config.json'),
    detectPath: path.join(APPDATA, 'Claude'),
    detectType: 'dir',
    note: null,
  },
  {
    id: 'cursor',
    label: 'Cursor',
    configPath: path.join(HOME, '.cursor', 'mcp.json'),
    detectPath: path.join(HOME, '.cursor'),
    detectType: 'dir',
    note: null,
  },
  {
    id: 'windsurf',
    label: 'Windsurf',
    configPath: path.join(HOME, '.codeium', 'windsurf', 'mcp_config.json'),
    detectPath: path.join(HOME, '.codeium', 'windsurf'),
    detectType: 'dir',
    note: null,
  },
  {
    id: 'antigravity',
    label: 'Antigravity',
    // Google's agent IDE, built by the former Windsurf team. Global MCP config
    // lives at ~/.gemini/config/mcp_config.json (NOT .codeium, and no longer
    // the per-tool ~/.gemini/antigravity path — current builds migrate that
    // forward). HTTP entries use `serverUrl`, not `url` — see configure.js.
    // Detection stays on the data dir: ~/.gemini/config is shared with the
    // Gemini CLI, so it would false-positive without Antigravity installed.
    configPath: path.join(HOME, '.gemini', 'config', 'mcp_config.json'),
    detectPath: path.join(HOME, '.gemini', 'antigravity'),
    detectType: 'dir',
    note: null,
  },
  {
    id: 'gemini-cli',
    label: 'Gemini CLI',
    // Google retired the consumer service 2026-06-18 (Antigravity CLI is the
    // successor), but enterprise-licensed / API-key installs still work and
    // the config format is frozen: settings.json `mcpServers` with `httpUrl`
    // for streamable HTTP. Antigravity's mcp_config.json does NOT serve this
    // CLI — separate file, incompatible key. Detect on the settings FILE,
    // not ~/.gemini (that dir also exists for Antigravity-only machines).
    configPath: path.join(HOME, '.gemini', 'settings.json'),
    detectPath: path.join(HOME, '.gemini', 'settings.json'),
    detectType: 'file',
    note: 'Consumer service retired June 2026; enterprise/API-key installs still work',
  },
  {
    id: 'cline',
    label: 'Cline (VS Code extension)',
    // Extension id is still saoudrizwan.claude-dev (the Cline rename never
    // changed the marketplace identifier). Cline 4.1.x A/B-tests two bundles
    // that read different paths — the writer covers both this globalStorage
    // file and the ~/.cline shared file (see CLINE_SHARED_SETTINGS_PATH).
    configPath: path.join(
      APPDATA, 'Code', 'User', 'globalStorage',
      'saoudrizwan.claude-dev', 'settings', 'cline_mcp_settings.json'
    ),
    detectPath: path.join(
      APPDATA, 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev'
    ),
    detectType: 'dir',
    note: null,
  },
  {
    id: 'roo-code',
    label: 'Roo Code (VS Code extension)',
    configPath: path.join(
      APPDATA, 'Code', 'User', 'globalStorage',
      'rooveterinaryinc.roo-cline', 'settings', 'mcp_settings.json'
    ),
    detectPath: path.join(
      APPDATA, 'Code', 'User', 'globalStorage', 'rooveterinaryinc.roo-cline'
    ),
    detectType: 'dir',
    note: 'Discontinued upstream (May 2026); Zoo Code is the successor',
  },
  {
    id: 'zoo-code',
    label: 'Zoo Code (VS Code extension)',
    // Community successor fork of Roo Code (official handoff, active).
    // Identical settings shape; its migration only renames files inside its
    // own settings dir — it does NOT import Roo's, so we write it directly.
    configPath: path.join(
      APPDATA, 'Code', 'User', 'globalStorage',
      'zoocodeorganization.zoo-code', 'settings', 'mcp_settings.json'
    ),
    detectPath: path.join(
      APPDATA, 'Code', 'User', 'globalStorage', 'zoocodeorganization.zoo-code'
    ),
    detectType: 'dir',
    note: null,
  },
  {
    id: 'vscode',
    label: 'VS Code (Copilot agent mode)',
    // Native MCP, GA since v1.102. Dedicated per-profile mcp.json with a
    // top-level `servers` key (NOT `mcpServers`); HTTP entries are
    // {type: 'http', url}. The writer prefers `code --add-mcp` (targets the
    // ACTIVE profile) and merges this default-profile file as fallback.
    configPath: path.join(APPDATA, 'Code', 'User', 'mcp.json'),
    detectPath: path.join(APPDATA, 'Code', 'User'),
    detectType: 'dir',
    note: 'Requires VS Code 1.102+ with Copilot chat enabled',
  },
  {
    id: 'continue',
    label: 'Continue.dev',
    // Continue is frozen (acquired by Cursor; final 2.0.0 release, repo
    // read-only) but the extensions still work. We write a standalone MCP
    // block file the IDE extensions auto-discover — NOT the legacy
    // config.json experimental key, which is unreachable whenever
    // config.yaml exists (auto-generated on first launch, and it wins).
    // Known limit: the `cn` CLI doesn't scan mcpServers/ (issue #12254,
    // wontfix). Block-file schema requires name/version/schema headers.
    configPath: path.join(HOME, '.continue', 'mcpServers', 'pinako.yaml'),
    detectPath: path.join(HOME, '.continue'),
    detectType: 'dir',
    note: 'Discontinued upstream (acquired by Cursor); existing installs still work',
  },
  {
    id: 'codex',
    label: 'ChatGPT-Codex (app / CLI / IDE)',
    configPath: path.join(HOME, '.codex', 'config.toml'),
    detectPath: path.join(HOME, '.codex'),
    detectType: 'dir',
    // OpenAI merged the Codex desktop app into the ChatGPT branding
    // (2026-07-09); ~/.codex/config.toml is unchanged and still drives the
    // desktop app, the Codex CLI, and the IDE extension. On Windows the
    // desktop app may clear third-party MCP entries when it launches (OpenAI
    // issue #24718, still open) — the CLI and IDE keep the entry, so re-run
    // this installer if the app drops it.
    note: 'Shared by the ChatGPT-Codex desktop app, Codex CLI, and IDE extension. The Windows app may clear the entry on launch (OpenAI bug #24718) — re-run to restore.',
  },
  {
    id: 'grok',
    label: 'Grok Build',
    // xAI's CLI coding agent. Same [mcp_servers.<name>] TOML shape as Codex;
    // HTTP servers use a bare `url` key. GROK_HOME overrides ~/.grok. Grok
    // also compat-scans ~/.claude.json and ~/.cursor/mcp.json, but a native
    // config.toml entry takes precedence, so we write one explicitly.
    configPath: path.join(GROK_HOME, 'config.toml'),
    detectPath: GROK_HOME,
    detectType: 'dir',
    note: null,
  },
  {
    id: 'kimi-code',
    label: 'Kimi Code',
    // Moonshot AI's terminal coding agent (formerly Kimi CLI — which used
    // ~/.kimi; the rebrand moved to ~/.kimi-code, KIMI_CODE_HOME overrides).
    // Dedicated mcp.json, Claude-Desktop-compatible mcpServers map; an entry
    // with a bare `url` and no `transport` is treated as streamable HTTP.
    configPath: path.join(KIMI_CODE_HOME, 'mcp.json'),
    detectPath: KIMI_CODE_HOME,
    detectType: 'dir',
    note: null,
  },
  {
    id: 'openclaw',
    label: 'OpenClaw',
    // Multi-channel gateway agent. MCP servers live under `mcp.servers` in
    // the MAIN openclaw.json (not a dedicated MCP file) — transport must be
    // explicit ("streamable-http" is not inferred from `url`), and the
    // gateway reads config at startup. OPENCLAW_STATE_DIR overrides the root.
    configPath: path.join(OPENCLAW_HOME, 'openclaw.json'),
    detectPath: OPENCLAW_HOME,
    detectType: 'dir',
    note: 'Restart the OpenClaw gateway after install to pick up the new server',
  },
  {
    id: 'hermes',
    label: 'Hermes',
    // NousResearch hermes-agent. YAML config with a top-level `mcp_servers`
    // map; a bare `url` defaults to streamable HTTP. HERMES_HOME wins; the
    // native Windows installer uses %LOCALAPPDATA%\hermes, POSIX ~/.hermes.
    configPath: path.join(HERMES_HOME, 'config.yaml'),
    detectPath: HERMES_HOME,
    detectType: 'dir',
    note: null,
  },
];

// ─── Detection ────────────────────────────────────────────────────────────────

function pathExists(p) {
  try { fs.accessSync(p); return true; } catch { return false; }
}

/**
 * Returns CLIENTS array with `found: boolean` added to each entry.
 */
export function detectClients() {
  return CLIENTS.map(client => ({
    ...client,
    found: pathExists(client.detectPath),
  }));
}

/**
 * Returns only the clients that were found on this machine.
 */
export function detectFoundClients() {
  return detectClients().filter(c => c.found);
}
