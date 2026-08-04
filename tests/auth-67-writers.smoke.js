/**
 * tests/auth-67-writers.smoke.js — every client config carries the token
 *
 * Standalone: `node tests/auth-67-writers.smoke.js`. Writes each client's
 * config into a scratch dir and asserts the tokened URL actually landed in
 * the file, in that client's own schema.
 *
 * Why this exists: the #67 token rides in the URL precisely because a bare
 * `url` string is the one field all 16 client shapes share — but each writer
 * spells it differently (`url`, `serverUrl`, `httpUrl`, TOML `url = "…"`,
 * YAML `url: "…"`, VS Code's `servers` key, Claude Desktop's `--stdio-mcp`
 * argv). A writer that silently drops the query string would leave that
 * client read-only forever, and nothing else would catch it.
 *
 * The two CLI-first writers (claude-code, vscode) shell out to an external
 * binary and are covered by the live install run, not here.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pinako-w67-'));
process.env.APPDATA = DATA_DIR;
process.env.HOME = DATA_DIR;
process.env.USERPROFILE = DATA_DIR;

// Imported AFTER the env redirect so PINAKO_DIR resolves into the scratch dir.
const { configureClient } = await import('../setup/configure.js');
const { readToken } = await import('../setup/token.js');

const TOKEN = readToken();
let passed = 0, failed = 0;

function check(label, cond) {
  if (cond) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${label}`); }
  else      { failed++; console.log(`  \x1b[31m✗\x1b[0m ${label}`); }
}

// id → the file the writer is expected to produce (relative to scratch).
const CASES = [
  ['claude-desktop', 'claude_desktop_config.json'],
  ['cursor',         'cursor-mcp.json'],
  ['windsurf',       'windsurf-mcp.json'],
  ['antigravity',    'antigravity-mcp.json'],
  ['cline',          'cline-settings.json'],
  ['roo-code',       'roo-settings.json'],
  ['zoo-code',       'zoo-settings.json'],
  ['continue',       'continue-config.yaml'],
  ['codex',          'codex-config.toml'],
  ['grok',           'grok-config.toml'],
  ['kimi-code',      'kimi-mcp.json'],
  ['openclaw',       'openclaw.json'],
  ['hermes',         'hermes-config.yaml'],
  ['gemini-cli',     'gemini-settings.json'],
];

console.log(`\n  token: ${TOKEN ? TOKEN.slice(0, 12) + '…' : '(none)'}\n`);
check('installer created a token', /^[0-9a-f]{64}$/.test(TOKEN || ''));

for (const [id, filename] of CASES) {
  const configPath = path.join(DATA_DIR, filename);
  const res = configureClient({ id, configPath });
  if (!res.ok) { check(`${id}: writer ran`, false); console.log(`      ${res.error}`); continue; }

  // Some writers (cline, antigravity, continue) fan out to more than one
  // file; scan everything the run produced so we assert on what it really
  // wrote rather than on the path we guessed.
  const written = fs.readdirSync(DATA_DIR, { recursive: true })
    .map(f => path.join(DATA_DIR, String(f)))
    .filter(f => { try { return fs.statSync(f).isFile(); } catch { return false; } })
    .map(f => fs.readFileSync(f, 'utf8'))
    .join('\n');

  check(`${id}: config contains the token`, written.includes(TOKEN));
  check(`${id}: no tokenless bare /mcp left behind`,
    !/["' =]https?:\/\/127\.0\.0\.1:37421\/mcp["'\s,}]/.test(written));
}

fs.rmSync(DATA_DIR, { recursive: true, force: true });
console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
