/**
 * tests/auth-67-rotate.smoke.js — token rotation actually re-keys clients
 *
 * Standalone: `node tests/auth-67-rotate.smoke.js`. No browser, no bridge.
 *
 * The defect this pins: configure.js used to compute the client URL at MODULE
 * LOAD. setup/main.js imports it, THEN rotates, THEN configures — so every
 * client was rewritten with the pre-rotation token while the command printed
 * success. Revoking a leaked credential left all 16 clients holding a token
 * the bridge rejects with a hard 401, which is worse than not revoking.
 *
 * The import order below deliberately mirrors main.js: import first, rotate
 * second, configure third. A regression would make this test fail.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pinako-rot67-'));
process.env.APPDATA = DATA_DIR;
process.env.HOME = DATA_DIR;
process.env.USERPROFILE = DATA_DIR;

// Import in main.js's order: configure.js is loaded BEFORE any rotation.
const { configureClient, configureClients } = await import('../setup/configure.js');
const { readOrCreateToken, rotateToken, readToken } = await import('../setup/token.js');

let passed = 0, failed = 0;
function check(label, cond) {
  if (cond) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${label}`); }
  else      { failed++; console.log(`  \x1b[31m✗\x1b[0m ${label}`); }
}

const before = readOrCreateToken();
check('token exists before rotation', /^[0-9a-f]{64}$/.test(before || ''));

// Write a client config with the pre-rotation token so we can prove it changes.
const cursorPath = path.join(DATA_DIR, 'cursor-mcp.json');
configureClient({ id: 'cursor', configPath: cursorPath });
check('pre-rotation config carries the original token',
  fs.readFileSync(cursorPath, 'utf8').includes(before));

// ── Rotate, then reconfigure, exactly as rotate-token does ──
const after = rotateToken();
check('rotation produced a different token', !!after && after !== before);
check('rotation persisted to disk', readToken() === after);

configureClients([
  { id: 'cursor',   configPath: cursorPath },
  { id: 'kimi-code', configPath: path.join(DATA_DIR, 'kimi-mcp.json') },
  { id: 'codex',    configPath: path.join(DATA_DIR, 'codex-config.toml') },
]);

const all = fs.readdirSync(DATA_DIR, { recursive: true })
  .map(f => path.join(DATA_DIR, String(f)))
  .filter(f => { try { return fs.statSync(f).isFile(); } catch { return false; } })
  .filter(f => !f.endsWith('mcp-auth-token'))
  .map(f => fs.readFileSync(f, 'utf8'))
  .join('\n');

check('configs carry the NEW token after rotation', all.includes(after));
check('configs no longer carry the revoked token', !all.includes(before));

// ── A malformed token file must self-heal, not wedge forever ──
// 'wx' can never replace an existing file, so a truncated write used to make
// readOrCreateToken return null permanently: every client configured
// read-only with no recovery path the user could discover.
console.log('\n  Malformed token recovery');
const { TOKEN_PATH } = await import('../setup/token.js');
fs.writeFileSync(TOKEN_PATH, 'not-a-token\n', 'utf8');
check('malformed file reads as absent', readToken() === null);
const healed = readOrCreateToken();
check('a fresh token is generated over the bad file', /^[0-9a-f]{64}$/.test(healed || ''));
check('the bad bytes are gone from disk', readToken() === healed);
check('recovery does not reuse the revoked token', healed !== after && healed !== before);

fs.rmSync(DATA_DIR, { recursive: true, force: true });
console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
