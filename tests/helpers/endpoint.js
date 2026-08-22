/**
 * tests/helpers/endpoint.js — resolve the MCP endpoint for test harnesses.
 *
 * Single source of truth for BOTH harnesses (tests/helpers/mcp-client.js and
 * tests/tier2/helpers/agent-runner.js). Write tools are refused on a tokenless
 * connection (ai-todo #67), so a harness pointed at the bare URL fails every
 * write assertion with AUTH_REQUIRED — which is exactly what happened to the
 * tier2 harness when only the main one was updated.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BASE = 'http://127.0.0.1:37421/mcp';

/** The Pinako data dir, mirroring setup/paths.js and host.js. */
export function pinakoDir() {
  switch (process.platform) {
    case 'win32':
      return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Pinako');
    case 'darwin':
      return path.join(os.homedir(), 'Library', 'Application Support', 'Pinako');
    case 'linux':
      return path.join(os.homedir(), '.local', 'share', 'pinako');
    default:
      return path.join(os.homedir(), '.pinako');
  }
}

/** The local access token, or null when the installer has never run. */
export function readAccessToken() {
  try {
    const t = fs.readFileSync(path.join(pinakoDir(), 'mcp-auth-token'), 'utf8').trim();
    return /^[0-9a-f]{32,128}$/i.test(t) ? t : null;
  } catch (_) {
    return null;
  }
}

/**
 * The endpoint tests should use. PINAKO_MCP_ENDPOINT wins (point at another
 * bridge or token); otherwise the token is read from disk so `npm test` works
 * unchanged on a machine where the installer has run.
 */
export function mcpEndpoint() {
  if (process.env.PINAKO_MCP_ENDPOINT) return process.env.PINAKO_MCP_ENDPOINT;
  const token = readAccessToken();
  return token ? `${BASE}?token=${token}` : BASE;
}
