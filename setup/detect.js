/**
 * setup/detect.js
 *
 * Detects installed AI clients that support MCP on the current machine.
 * Returns an array of client descriptors, each with: id, label, configPath, found.
 */

import fs from 'node:fs';
import path from 'node:path';
import { HOME, APPDATA } from './paths.js';
import { inspect } from './connections.js';

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

// ─── Connections ─────────────────────────────────────────────────────────────

function listDir(dir) {
  try { return fs.readdirSync(dir); } catch { return []; }
}

/**
 * Claude Desktop's settings files that are in use, the one it reads first.
 * Windows: since 3.1623 (2026-10-20) everything but the Microsoft Store version
 * lives in %LOCALAPPDATA%\\Claude-Data\\<package family>, and each home it moved
 * out of holds a `.user-data-left.*` marker (and may hold a dead settings file).
 * Before that: the package's own folder when there is one, else %APPDATA%\\Claude.
 */
export function claudeDesktopFiles(client) {
  const classic = client.configPath;
  if (process.platform !== 'win32') return [classic];
  const local = process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local');
  const named = (dir, rest) => listDir(dir).filter(n => /^claude_/i.test(n)).map(n => path.join(dir, n, ...rest));
  const inUse = (dir) => pathExists(dir) && !listDir(dir).some(n => n.startsWith('.user-data-left'));
  const settings = (dirs) => dirs.filter(inUse).map(d => path.join(d, 'claude_desktop_config.json'));
  const moved = settings(named(path.join(local, 'Claude-Data'), []));
  if (moved.length) return moved;
  const store = settings(named(path.join(local, 'Packages'), ['LocalCache', 'Roaming', 'Claude']));
  return [...store, ...(inUse(path.dirname(classic)) || !store.length ? [classic] : [])];
}

/**
 * Every settings file that may hold our entry for this client, in the order the
 * app prefers them. With `first`, only the first one that exists is what the app
 * reads; the others are older homes of the same settings.
 */
export function clientFiles(client) {
  const file = (p, kind = client.id) => ({ path: p, kind });
  switch (client.id) {
    case 'claude-desktop':
      return { files: claudeDesktopFiles(client).map(p => file(p)), first: true };
    case 'antigravity':
      return { files: [file(client.configPath), file(path.join(HOME, '.gemini', 'antigravity', 'mcp_config.json'))], first: true };
    case 'continue':
      // Continue ignores the old config.json once it has a config.yaml.
      return {
        files: [file(client.configPath), ...(pathExists(path.join(HOME, '.continue', 'config.yaml')) ? []
          : [file(path.join(HOME, '.continue', 'config.json'), 'continue-json')])],
        first: true,
      };
    case 'cline':
      return {
        files: [file(client.configPath), file(path.join(HOME, '.cline', 'data', 'settings', 'cline_mcp_settings.json'))],
        first: false,
      };
    case 'vscode': {
      // `code --add-mcp` writes the ACTIVE profile, which may be a named one.
      const profiles = path.join(path.dirname(client.configPath), 'profiles');
      return {
        files: [file(client.configPath), ...listDir(profiles).map(n => file(path.join(profiles, n, 'mcp.json')))],
        first: false,
      };
    }
    default:
      return { files: [file(client.configPath)], first: false };
  }
}

/** The text of a settings file: null when there is none, and an error when it cannot be read. */
export function readSettings(filePath) {
  let buf;
  try {
    buf = fs.readFileSync(filePath);
  } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return null;
    throw new Error(`${filePath} could not be read (${e.code || e.message})`);
  }
  const text = buf.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(buf)) throw new Error(`${filePath} is not plain text`);
  return text;
}

/** { status: 'yes' | 'no' | 'unreadable', next, exists } for one file. */
export function inspectFile({ path: p, kind }, target = null) {
  try {
    const text = readSettings(p);
    if (text === null) return { status: 'no', next: null, exists: false };
    return { ...inspect(kind, text, target), exists: true };
  } catch {
    return { status: 'unreadable', next: null, exists: true };
  }
}

/** The files of one client that it reads, each with its status, and the app's own standing. */
export function inspectClient(client, target = null) {
  const { files, first } = clientFiles(client);
  let live = files.map(f => ({ ...f, ...inspectFile(f, target) })).filter(f => f.exists);
  if (first) live = live.slice(0, 1);
  const unreadable = live.some(f => f.status === 'unreadable');
  const connected = live.some(f => f.status === 'yes') ? 'yes' : unreadable ? 'unreadable' : 'no';
  return { live, connected, unreadable };
}

/**
 * Returns CLIENTS array with `found: boolean` and `connected` ('yes' | 'no' |
 * 'unreadable') added to each entry.
 */
export function detectClients() {
  return CLIENTS.map(client => ({
    ...client,
    found: pathExists(client.detectPath)
      || (client.id === 'claude-desktop' && claudeDesktopFiles(client).some(p => pathExists(path.dirname(p)))),
    connected: inspectClient(client).connected,
  }));
}

/**
 * Returns only the clients that were found on this machine.
 */
export function detectFoundClients() {
  return detectClients().filter(c => c.found);
}
