/**
 * setup/detect.js
 *
 * Detects installed AI clients that support MCP on the current machine.
 * Returns an array of client descriptors, each with: id, label, configPath, found.
 */

import fs from 'node:fs';
import path from 'node:path';
import { HOME, APPDATA } from './paths.js';

// ─── Client definitions ───────────────────────────────────────────────────────

export const CLIENTS = [
  {
    id: 'claude-code',
    label: 'Claude Code',
    configPath: path.join(HOME, '.claude', 'settings.json'),
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
    id: 'cline',
    label: 'Cline (VS Code extension)',
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
    note: null,
  },
  {
    id: 'continue',
    label: 'Continue.dev',
    configPath: path.join(HOME, '.continue', 'config.json'),
    detectPath: path.join(HOME, '.continue'),
    detectType: 'dir',
    note: 'HTTP transport support requires Continue.dev v0.9.210+',
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
