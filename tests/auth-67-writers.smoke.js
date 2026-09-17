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
import { fileURLToPath } from 'node:url';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pinako-w67-'));
process.env.APPDATA = DATA_DIR;
process.env.HOME = DATA_DIR;
process.env.USERPROFILE = DATA_DIR;

// Imported AFTER the env redirect so PINAKO_DIR resolves into the scratch dir.
const { configureClient } = await import('../setup/configure.js');
const { readToken } = await import('../setup/token.js');
const { CLIENTS } = await import('../setup/detect.js');

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

// 2026-09-17: the config key became "Pinako" (it is what every client shows as
// the server name). Each file is seeded with the pre-rename lowercase entry in
// that client's own shape, so the assertion below proves a re-install migrates
// it rather than leaving a second, stale local entry beside ours.
const LEGACY_URL = 'http://127.0.0.1:37421/mcp?token=legacy';
function legacySeed(id) {
  switch (id) {
    case 'codex': case 'grok':
      return `[mcp_servers.pinako]\nurl = "${LEGACY_URL}"\n`;
    case 'hermes':
      return `mcp_servers:\n  pinako:\n    url: "${LEGACY_URL}"\n    enabled: true\n`;
    case 'continue':
      return ''; // we own that file outright; a plain overwrite
    case 'openclaw':
      return JSON.stringify({ mcp: { servers: { pinako: { url: LEGACY_URL } } } });
    default:
      return JSON.stringify({ mcpServers: { pinako: { url: LEGACY_URL } } });
  }
}
const OLD_KEY = /"pinako"\s*:|\[mcp_servers\.pinako\]|^\s*pinako:/m;
const NEW_KEY = /"Pinako"\s*:|\[mcp_servers\.Pinako\]|^\s*(- name: )?Pinako:?\s*$/m;

console.log(`\n  token: ${TOKEN ? TOKEN.slice(0, 12) + '…' : '(none)'}\n`);
check('installer created a token', /^[0-9a-f]{64}$/.test(TOKEN || ''));

for (const [id, filename] of CASES) {
  const configPath = path.join(DATA_DIR, filename);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, legacySeed(id), 'utf8');
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
  check(`${id}: pre-rename "pinako" entry replaced by "Pinako"`,
    NEW_KEY.test(written) && !OLD_KEY.test(written));
}

// Guards for the NEXT client someone adds: it must join CASES above (so its
// key gets checked), and neither writer source may hard-code the old key.
// The two CLI-first writers are the only sanctioned exceptions to CASES.
const CLI_ONLY = new Set(['claude-code', 'vscode']);
const covered = new Set(CASES.map(([id]) => id));
const uncovered = CLIENTS.map(c => c.id).filter(id => !CLI_ONLY.has(id) && !covered.has(id));
check(`every detect.js client has a writer case here${uncovered.length ? ' (missing: ' + uncovered.join(', ') + ')' : ''}`,
  uncovered.length === 0);
const here = path.dirname(fileURLToPath(import.meta.url));
for (const rel of ['../setup/configure.js', '../installer/src-tauri/src/main.rs']) {
  const src = fs.readFileSync(path.join(here, rel), 'utf8')
    .split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  // The exact spellings every writer used before the rename.
  const hardcoded = /(\.pinako|\["pinako"\])\s*=|\[mcp_servers\.pinako\]|\{indent\}pinako:|'  pinako:'|"pinako", "--scope"|name: 'pinako'|"name": "pinako"/.test(src);
  check(`${path.basename(rel)}: no writer hard-codes the lowercase key`, !hardcoded);
}

fs.rmSync(DATA_DIR, { recursive: true, force: true });
console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
