#!/usr/bin/env node
/**
 * pinako-mcp/install.js
 *
 * DEPRECATED — Use setup/main.js instead (cross-platform CLI installer).
 * This file is the legacy Windows-only installer kept for reference.
 *
 * Registers pinako-mcp as a Chrome Native Messaging host on Windows.
 * Usage: node install.js <chrome-extension-id>
 *
 * What it does:
 *  1. Writes the native host manifest to %APPDATA%\Pinako\pinako-native-host.json
 *  2. Adds the registry key Chrome reads to find it:
 *     HKCU\Software\Google\Chrome\NativeMessagingHosts\com.pinako.mcp
 *  3. Prints the Claude Desktop config snippet
 */

import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Args ────────────────────────────────────────────────────────────────────
const extensionId = process.argv[2];
if (!extensionId || !/^[a-z]{32}$/.test(extensionId)) {
  console.error(
    'Usage: node install.js <chrome-extension-id>\n' +
    '\n' +
    'Find your extension ID:\n' +
    '  1. Open Chrome → chrome://extensions\n' +
    '  2. Enable Developer Mode (top-right toggle)\n' +
    '  3. Find Pinako — the ID is a 32-character string like "abcdefghijklmnopqrstuvwxyzabcdef"\n'
  );
  process.exit(1);
}

if (os.platform() !== 'win32') {
  console.error('This installer currently supports Windows only.');
  process.exit(1);
}

// ─── Paths ───────────────────────────────────────────────────────────────────
const hostScript  = resolve(__dirname, 'host.js');
const appDataDir  = join(process.env.APPDATA || os.homedir(), 'Pinako');
const manifestPath = join(appDataDir, 'pinako-native-host.json');

// Locate node.exe
const nodePath = process.execPath.replace(/\\/g, '\\\\');

// The "path" in the manifest must be the executable Chrome will run.
// We wrap host.js in a small .cmd shim so Chrome can launch it directly
// (Chrome requires the path to be an executable, not a .js file on Windows).
const shimPath = join(appDataDir, 'pinako-mcp-host.cmd').replace(/\\/g, '\\\\');
const shimPathRaw = join(appDataDir, 'pinako-mcp-host.cmd');

// ─── Write shim ──────────────────────────────────────────────────────────────
mkdirSync(appDataDir, { recursive: true });

writeFileSync(
  shimPathRaw,
  `@echo off\n"${process.execPath}" "${hostScript}"\n`
);
console.log(`Wrote launcher shim: ${shimPathRaw}`);

// ─── Write native host manifest ───────────────────────────────────────────────
const manifest = {
  name: 'com.pinako.mcp',
  description: 'Pinako MCP Bridge — exposes Pinako tab tree to AI clients via HTTP MCP',
  path: shimPath,
  type: 'stdio',
  allowed_origins: [
    `chrome-extension://${extensionId}/`,
  ],
};

writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
console.log(`Wrote native host manifest: ${manifestPath}`);

// ─── Write registry key ───────────────────────────────────────────────────────
const regKey = 'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.pinako.mcp';
const regCmd = `REG ADD "${regKey}" /ve /t REG_SZ /d "${manifestPath.replace(/\\/g, '\\\\')}" /f`;

try {
  execSync(regCmd, { stdio: 'pipe' });
  console.log(`Registered registry key: ${regKey}`);
} catch (e) {
  console.error('Failed to write registry key. Try running as administrator, or add it manually:');
  console.error(`  ${regCmd}`);
  process.exit(1);
}

// ─── Success ──────────────────────────────────────────────────────────────────
console.log('\n✓ Installation complete!\n');

console.log('─── Add to Claude Desktop config ────────────────────────────────────────────');
console.log('File: %APPDATA%\\Claude\\claude_desktop_config.json\n');
console.log(JSON.stringify({
  mcpServers: {
    pinako: {
      url: 'http://localhost:37421/mcp',
    },
  },
}, null, 2));
console.log('\n─────────────────────────────────────────────────────────────────────────────');
console.log('\nThen restart Claude Desktop. The Pinako MCP server starts automatically');
console.log('when the Pinako extension connects (it runs in the background via Chrome).\n');
console.log('Health check: http://localhost:37421/health');
