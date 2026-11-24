// An update keeps the user's connections: what is connected is refreshed, what
// is not stays out, and what cannot be read is left alone and said so.
// Standalone: node tests/connections.smoke.js. Temp folders only.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pinako-conn-'));
Object.assign(process.env, {
  HOME: dir, USERPROFILE: dir, APPDATA: path.join(dir, 'roaming'), LOCALAPPDATA: path.join(dir, 'local'),
  PATH: '', Path: '', // neither the claude nor the code command: files only
});
for (const v of ['GROK_HOME', 'KIMI_CODE_HOME', 'OPENCLAW_STATE_DIR', 'HERMES_HOME']) delete process.env[v];

// ── The shared cases (the Rust side runs the same ones) ──
const { inspect } = await import('../setup/connections.js');
const shared = JSON.parse(fs.readFileSync(path.join(here, 'connections-cases.json'), 'utf8'));
for (const c of shared.cases) {
  const text = typeof c.text === 'string' ? c.text : JSON.stringify(c.text);
  const got = inspect(c.kind, text, shared.target);
  assert.equal(got.status, c.status, c.name);
  assert.equal(inspect(c.kind, text).status, c.status, `${c.name}: status alone`);
  if (c.next === null || typeof c.next === 'string') assert.equal(got.next, c.next, c.name);
  else assert.deepEqual(JSON.parse(got.next), c.next, c.name);
}

// ── A whole update, on disk ──
const { detectClients, CLIENTS } = await import('../setup/detect.js');
const { refreshClients, configureClient } = await import('../setup/configure.js');
const { readOrCreateToken, TOKEN_PATH } = await import('../setup/token.js');
const { APPDATA } = await import('../setup/paths.js');
assert.ok(TOKEN_PATH.startsWith(dir), 'not in the temp folder');
const token = readOrCreateToken();
const put = (p, v) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, typeof v === 'string' ? v : JSON.stringify(v));
  return p;
};
const of = (id) => CLIENTS.find(c => c.id === id);
const old = 'http://127.0.0.1:37421/mcp';
const cursor = put(of('cursor').configPath, { mcpServers: { pinako: { url: old } } });
const windsurf = put(of('windsurf').configPath, { mcpServers: { other: { url: 'http://x' } } });
const kimi = put(of('kimi-code').configPath, `{ "mcpServers": { "Pinako": { "url": "${old}" }, } }`);
const codex = put(of('codex').configPath, `[mcp_servers.Pinako]\nurl = "${old}"\nenabled = false\n`);
fs.mkdirSync(path.join(dir, '.grok'));
const claude = put(of('claude-code').configPath, { big: 'BIG', mcpServers: { Pinako: { type: 'http', url: old } } });
fs.writeFileSync(claude, fs.readFileSync(claude, 'utf8').replace('"BIG"', '9007199254740993'));
// An address with shell characters never reaches a command line; its file is edited.
const oddUrl = `${old}?token=OLD&x=1`;
const oldClaude = put(path.join(dir, '.claude', 'settings.json'), { keep: 1, mcpServers: { pinako: { type: 'http', url: old } } });
const profile = put(path.join(APPDATA, 'Code', 'User', 'profiles', 'abc', 'mcp.json'), { servers: { Pinako: { type: 'http', url: old } } });
// The store app's own file is the one it reads; the older home holds a leftover.
const desk = of('claude-desktop');
const deskOld = put(desk.configPath, { mcpServers: { Pinako: { command: 'pinako-mcp-service.exe', args: ['--stdio-mcp', old] } } });
const storeDir = path.join(dir, 'local', 'Packages', 'Claude_x', 'LocalCache', 'Roaming', 'Claude');
if (process.platform === 'win32') put(path.join(storeDir, 'claude_desktop_config.json'), { mcpServers: {} });
put(path.join(dir, '.gemini', 'antigravity', 'mcp_config.json'), { mcpServers: { pinako: { serverUrl: old } } });

const standing = () => Object.fromEntries(detectClients().map(c => [c.id, c.connected]));
const before = standing();
assert.equal(before.cursor, 'yes');
assert.equal(before.windsurf, 'no');
assert.equal(before['kimi-code'], 'unreadable');
assert.equal(before.codex, 'yes');
assert.equal(before.grok, 'no');
assert.equal(before.vscode, 'yes');
assert.equal(before.antigravity, 'yes');
assert.equal(before['claude-code'], 'yes');
if (process.platform === 'win32') assert.equal(before['claude-desktop'], 'no');

const kept = [windsurf, kimi].map(p => [p, fs.readFileSync(p, 'utf8')]);
const report = Object.fromEntries(refreshClients().map(r => [r.client.id, r.status]));
assert.equal(report.cursor, 'current');
assert.equal(report['kimi-code'], 'unreadable');
assert.equal(report['claude-code'], 'current');
assert.ok(!('windsurf' in report) && !('grok' in report) && !('gemini-cli' in report));
for (const [p, text] of kept) assert.equal(fs.readFileSync(p, 'utf8'), text, p);
assert.ok(!fs.existsSync(path.join(dir, '.grok', 'config.toml')), 'connected an app that was left out');
assert.ok(!fs.existsSync(of('antigravity').configPath), 'made a settings file that was not there');
for (const p of [cursor, codex, claude, profile]) assert.ok(fs.readFileSync(p, 'utf8').includes(token), p);
assert.match(fs.readFileSync(codex, 'utf8'), /enabled = false/);
assert.match(fs.readFileSync(claude, 'utf8'), /"big": 9007199254740993,/);
// The file Claude Code never read is no connection: left as it is.
assert.ok(!fs.readFileSync(oldClaude, 'utf8').includes(token));
// A leftover in an older home of an app that is not connected gets no key.
if (process.platform === 'win32') assert.ok(!fs.readFileSync(deskOld, 'utf8').includes(token));
// A second update has nothing to write.
const stamps = [cursor, codex, claude, profile].map(p => fs.statSync(p).mtimeMs);
refreshClients();
assert.deepEqual([cursor, codex, claude, profile].map(p => fs.statSync(p).mtimeMs), stamps);

// Claude Desktop moved out of both old homes: only its new one counts.
if (process.platform === 'win32') {
  // A store app with no settings of its own reads the classic file: no new one
  // may appear in front of it.
  fs.rmSync(path.join(storeDir, 'claude_desktop_config.json'));
  const classicBefore = fs.readFileSync(deskOld, 'utf8');
  assert.equal(configureClient(desk).ok, true);
  assert.ok(!fs.existsSync(path.join(storeDir, 'claude_desktop_config.json')));
  fs.writeFileSync(deskOld, classicBefore);
  put(path.join(storeDir, '.user-data-left.claude_x'), '');
  put(path.join(path.dirname(deskOld), '.user-data-left.claude_x'), '');
  const moved = put(path.join(dir, 'local', 'Claude-Data', 'claude_x', 'claude_desktop_config.json'), { keep: 1 });
  assert.equal(standing()['claude-desktop'], 'no');
  const dead = fs.readFileSync(deskOld, 'utf8');
  put(deskOld, dead.replace(token, 'OLD'));
  assert.ok(!refreshClients().some(r => r.client.id === 'claude-desktop'));
  assert.equal(configureClient(desk).ok, true);
  assert.equal(standing()['claude-desktop'], 'yes');
  assert.equal(JSON.parse(fs.readFileSync(moved, 'utf8')).keep, 1);
  assert.ok(fs.readFileSync(moved, 'utf8').includes(token));
  assert.ok(!fs.readFileSync(deskOld, 'utf8').includes(token), 'wrote to a home the app left');
}

put(claude, { mcpServers: { Pinako: { type: 'http', url: oddUrl } } });
refreshClients();
assert.equal(JSON.parse(fs.readFileSync(claude, 'utf8')).mcpServers.Pinako.url, `${old}?token=${token}&x=1`);

// No access key: a working entry is not traded for one without it.
fs.rmSync(TOKEN_PATH);
fs.mkdirSync(TOKEN_PATH);
assert.equal(refreshClients().find(r => r.client.id === 'cursor').status, 'nokey');
assert.ok(fs.readFileSync(cursor, 'utf8').includes(token));
fs.rmdirSync(TOKEN_PATH);

// A servers map on one line cannot take a table: refused, not broken.
fs.writeFileSync(codex, 'mcp_servers = { other = { url = "http://x" } }\n');
assert.equal(configureClient(of('codex')).ok, false);

// Connecting never replaces settings it cannot read.
assert.equal(configureClient(of('kimi-code')).ok, false);
assert.equal(fs.readFileSync(kimi, 'utf8'), kept[1][1]);
const bytes = Buffer.from([0x61, 0xff, 0x0a]);
fs.writeFileSync(path.join(dir, '.grok', 'config.toml'), bytes);
assert.equal(configureClient(of('grok')).ok, false);
assert.ok(fs.readFileSync(path.join(dir, '.grok', 'config.toml')).equals(bytes));

// ── The wizard ──
const wait = (ms) => new Promise(r => setTimeout(r, ms));
function open(detected) {
  const el = {};
  const make = (id) => ({
    id, textContent: '', hidden: true, innerHTML: '', className: '', disabled: false, style: {}, children: [],
    classList: {
      set: new Set(), add(c) { this.set.add(c); }, remove(c) { this.set.delete(c); },
      toggle(c, on) { if (on) this.set.add(c); else this.set.delete(c); },
    },
    appendChild(c) { this.children.push(c); },
  });
  const node = (id) => (el[id] ||= make(id));
  const calls = [];
  const invoke = async (name, args) => {
    calls.push([name, args]);
    if (name === 'detect_clients') return detected;
    if (name === 'install') return ['✓  one', '⚠  Kimi Code was left as it was: its settings could not be read.'];
    if (name === 'connect') return ['✓  Configured Grok Build'];
    return { url: old, tokenless: false };
  };
  // Ticking is what the list's own markup says.
  const getElementById = (id) => {
    if (!id.startsWith('chk-')) return node(id);
    const row = node('app-list').children.map(c => c.innerHTML).find(h => h.includes(`id="${id}"`));
    return row ? (el[id] ||= { checked: / checked>/.test(row) }) : null;
  };
  const document = {
    getElementById, querySelector: (s) => node(s), querySelectorAll: () => [],
    createElement: () => make('made'), addEventListener() {},
  };
  const src = fs.readFileSync(path.join(here, '../installer/src/wizard.js'), 'utf8');
  const w = new Function('window', 'document', 'navigator',
    `${src}; return { init, next, back, connectMore, get step() { return step; } };`)(
    { __TAURI__: { core: { invoke } } }, document, { userAgent: '' });
  return { w, node, calls, tick: (id) => { getElementById(id).checked = true; } };
}
const app = (id, label, connected, detected = true) => ({ id, label, detected, connected, note: null });
const apps = [app('cursor', 'Cursor', 'yes'), app('kimi-code', 'Kimi Code', 'unreadable'), app('grok', 'Grok Build', 'no'),
  app('codex', 'Codex', 'no'), app('hermes', 'Hermes', 'no', false)];

// First install: everything here is ticked, as before.
let t = open({ update: false, clients: apps.map(a => ({ ...a, connected: 'no' })) });
await t.w.init();
await t.w.next();
assert.equal(t.w.step, 1);
assert.equal(t.node('btn-next').textContent, 'Install');
await t.w.next();
assert.deepEqual(t.calls.find(c => c[0] === 'install')[1], { update: false, selectedIds: ['cursor', 'kimi-code', 'grok', 'codex'] });
await wait(1200);
assert.equal(t.w.step, 3);
assert.ok(t.node('btn-back').classList.set.has('hidden'));
assert.equal(t.node('done-title').textContent, '');

// Update: no list, no ticks, straight to it.
t = open({ update: true, clients: apps });
await t.w.init();
assert.equal(t.node('btn-next').textContent, 'Update');
assert.equal(t.node('welcome-connected').textContent, 'Connected AI apps: Cursor.');
assert.equal(t.node('app-list').children.length, 0);
await t.w.next();
assert.deepEqual(t.calls.find(c => c[0] === 'install')[1], { update: true, selectedIds: [] });
await wait(1200);
assert.equal(t.w.step, 3);
assert.equal(t.node('done-title').textContent, 'Update Complete');
assert.equal(t.node('done-notices').hidden, false);
assert.equal(t.node('done-notices').children.length, 1);
assert.ok(!t.node('btn-back').classList.set.has('hidden'));
assert.equal(t.node('btn-back').textContent, 'Connect more apps');
// Connect more: only what is here and not connected, nothing ticked.
await t.w.back();
assert.equal(t.w.step, 1);
assert.equal(t.node('btn-back').textContent, 'Back');
assert.equal(t.node('btn-next').textContent, 'Connect');
const rows = t.node('app-list').children.map(c => c.innerHTML);
assert.equal(rows.length, 2);
assert.ok(rows.every(h => !/ checked>/.test(h)));
await t.w.back();
assert.equal(t.w.step, 3);
t.w.connectMore();
await t.w.next(); // nothing picked: nothing done
assert.ok(!t.calls.some(c => c[0] === 'connect'));
assert.equal(t.w.step, 3);
t.node('app-list').children.length = 0; // a real page replaces the rows
t.w.connectMore();
t.tick('chk-grok');
await t.w.next();
assert.deepEqual(t.calls.find(c => c[0] === 'connect')[1], { selectedIds: ['grok'] });
assert.equal(t.calls.filter(c => c[0] === 'install').length, 1);
await wait(1200);
assert.equal(t.w.step, 3);
await t.w.next();
assert.equal(t.calls.at(-1)[0], 'quit');

fs.rmSync(dir, { recursive: true, force: true });
console.log('connections: all checks passed');
