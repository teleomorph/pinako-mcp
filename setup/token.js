/**
 * setup/token.js
 *
 * The machine-local access token for the bridge's HTTP MCP endpoint
 * (ai-todo #67). One secret, three readers:
 *
 *   - host.js          — validates it on /mcp and /edit, and answers the
 *                        port-squat challenge with an HMAC over it.
 *   - configure.js     — bakes it into the URL written to each AI client.
 *   - main.js          — creates it at install time; rotates it on demand.
 *
 * host.js deliberately does NOT import this module (it is bundled standalone
 * by esbuild + pkg, like its log-path logic) — it reimplements the same two
 * rules: same path, same 64-hex-char format.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { PINAKO_DIR } from './paths.js';

export const TOKEN_PATH = path.join(PINAKO_DIR, 'mcp-auth-token');

const TOKEN_RE = /^[0-9a-f]{32,128}$/i;

/** Read the existing token, or null if absent/malformed. */
export function readToken() {
  try {
    const raw = fs.readFileSync(TOKEN_PATH, 'utf8').trim();
    return TOKEN_RE.test(raw) ? raw : null;
  } catch (_) {
    return null;
  }
}

/**
 * Read the token, creating it if it doesn't exist yet.
 * Returns null only when the filesystem refuses — callers fall back to a
 * tokenless URL, which still works (read-only) rather than failing the install.
 */
export function readOrCreateToken() {
  const existing = readToken();
  if (existing) return existing;
  // Distinguish absent from malformed — see the matching comment in host.js.
  // A file that exists but fails TOKEN_RE can never be replaced under 'wx',
  // so the old code returned null forever and every install silently wrote
  // tokenless (read-only) URLs with no way to recover.
  let malformed = false;
  try { fs.accessSync(TOKEN_PATH); malformed = true; } catch (_) { /* absent */ }
  const fresh = crypto.randomBytes(32).toString('hex');
  try {
    fs.mkdirSync(PINAKO_DIR, { recursive: true });
    // 'wx' for the absent case keeps the creation race safe; 'w' for the
    // malformed case, where there is nothing valid to protect.
    fs.writeFileSync(TOKEN_PATH, fresh + '\n', {
      encoding: 'utf8', mode: 0o600, flag: malformed ? 'w' : 'wx',
    });
    if (process.platform !== 'win32') { try { fs.chmodSync(TOKEN_PATH, 0o600); } catch (_) {} }
    return fresh;
  } catch (err) {
    if (err && err.code === 'EEXIST') return readToken();
    return null;
  }
}

/** Replace the token with a fresh one. Returns the new value, or null. */
export function rotateToken() {
  const fresh = crypto.randomBytes(32).toString('hex');
  try {
    fs.mkdirSync(PINAKO_DIR, { recursive: true });
    fs.writeFileSync(TOKEN_PATH, fresh + '\n', { encoding: 'utf8', mode: 0o600 });
    if (process.platform !== 'win32') { try { fs.chmodSync(TOKEN_PATH, 0o600); } catch (_) {} }
    return fresh;
  } catch (_) {
    return null;
  }
}

/**
 * The URL written into every AI client's config.
 *
 * The token rides as a query parameter because a bare `url` string is the ONE
 * field all supported client configs carry uniformly — several of them (the
 * TOML and YAML shapes especially) have no way to express a custom header.
 * host.js also accepts `Authorization: Bearer` for hand-configured clients.
 */
export function buildMcpUrl(token = undefined) {
  const base = 'http://127.0.0.1:37421/mcp';
  // Escape hatch for the install path where the service binary could NOT be
  // replaced (Linux ETXTBSY on a running Bridge). The surviving binary predates
  // the token and 404s a tokened URL, so writing one would break every client
  // outright rather than leaving it read-only. Bare URL keeps it working.
  if (process.env.PINAKO_FORCE_BARE_MCP_URL === '1') return base;
  const t = token === undefined ? readOrCreateToken() : token;
  return t ? `${base}?token=${t}` : base;
}
