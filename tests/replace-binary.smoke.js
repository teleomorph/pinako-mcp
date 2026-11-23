// The installers replace a RUNNING service (setup/replace-binary.js), and the
// wizard never claims success after a failure. Temp folders only.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { replaceBinary, deleteOldCopies, stopProcesses, isOurs } from '../setup/replace-binary.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pinako-replace-js-'));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const listing = (d) => fs.readdirSync(d).sort();
const exe = process.platform === 'win32' ? '.exe' : '';

// Fresh, then over an idle file.
const a = path.join(dir, 'a');
fs.mkdirSync(a);
const plain = path.join(a, `svc${exe}`);
replaceBinary(plain, Buffer.from('one'));
replaceBinary(plain, Buffer.from('two'));
assert.equal(fs.readFileSync(plain, 'utf8'), 'two');
deleteOldCopies(plain);
assert.deepEqual(listing(a), [`svc${exe}`]);

// A failure before the swap keeps the old file.
fs.mkdirSync(`${plain}.new`);
assert.throws(() => replaceBinary(plain, Buffer.from('three')));
assert.equal(fs.readFileSync(plain, 'utf8'), 'two');
fs.rmdirSync(`${plain}.new`);

// A failure of the second rename puts the old file back.
const realRename = fs.renameSync;
fs.renameSync = (from, to) => {
  if (String(from).endsWith('.new')) { const e = new Error('pretend'); e.code = 'ENOENT'; throw e; }
  return realRename(from, to);
};
try { assert.throws(() => replaceBinary(plain, Buffer.from('four')), /pretend/); } finally { fs.renameSync = realRename; }
assert.equal(fs.readFileSync(plain, 'utf8'), 'two');
assert.deepEqual(listing(a), [`svc${exe}`]);

// Only our own leftovers are swept.
for (const n of ['.old-123', '.old-', '.old-12x', '.bak']) fs.writeFileSync(plain + n, 'x');
deleteOldCopies(plain);
assert.deepEqual(listing(a), [`svc${exe}`, `svc${exe}.bak`, `svc${exe}.old-`, `svc${exe}.old-12x`].sort());

// Whose process it is.
assert.ok(isOurs('C:\\A\\SVC.EXE', 'c:\\a\\svc.exe', 'win32'));
assert.ok(isOurs('C:\\A\\svc.exe.old-9', 'C:\\A\\svc.exe', 'win32'));
assert.ok(!isOurs('C:\\B\\svc.exe', 'C:\\A\\svc.exe', 'win32'));
assert.ok(isOurs('/a/svc.old-9 (deleted)', '/a/svc', 'linux'));
assert.ok(!isOurs('/a/svc.bak', '/a/svc', 'linux'));
assert.ok(!isOurs('/a/SVC', '/a/svc', 'linux'));

// Over a running program: it is replaced, it keeps running until it is
// stopped, and a copy with another name is left alone.
const b = path.join(dir, 'b');
fs.mkdirSync(b);
const live = path.join(b, `svc${exe}`), other = path.join(b, `other${exe}`);
for (const f of [live, other]) { fs.copyFileSync(process.execPath, f); fs.chmodSync(f, 0o755); }
const stay = ['-e', 'setInterval(()=>{},1000)'];
const ours = spawn(live, stay, { stdio: 'ignore' }), theirs = spawn(other, stay, { stdio: 'ignore' });
await wait(1500);
try {
  replaceBinary(live, Buffer.from('new one'));
  assert.equal(fs.readFileSync(live, 'utf8'), 'new one');
  await wait(100);
  assert.equal(ours.exitCode, null, 'the swap itself stopped it');
  assert.equal(stopProcesses(live), true);
  await wait(500);
  assert.ok(ours.exitCode !== null || ours.signalCode !== null, 'still running');
  assert.ok(theirs.exitCode === null && theirs.signalCode === null, 'stopped a program that is not ours');
  deleteOldCopies(live);
  assert.deepEqual(listing(b), [`other${exe}`, `svc${exe}`]);
} finally { ours.kill('SIGKILL'); theirs.kill('SIGKILL'); }

// The wizard: run it with a failing install and look at the screen it stops on.
const el = {};
const node = (id) => (el[id] ||= {
  id, textContent: '', hidden: true, innerHTML: '', className: '', disabled: false, style: {}, children: [],
  classList: { set: new Set(), add(c) { this.set.add(c); }, remove(c) { this.set.delete(c); }, toggle(c, on) { on ? this.set.add(c) : this.set.delete(c); } },
  appendChild(c) { this.children.push(c); },
});
let calls = [], result = null;
const document = {
  getElementById: node, querySelector: (s) => node(s), querySelectorAll: () => [],
  createElement: () => node(`made${Object.keys(el).length}`), addEventListener() {},
};
const invoke = async (name) => {
  calls.push(name);
  if (name === 'install') { if (result instanceof Error) throw result.cause; return result; }
  if (name === 'mcp_url') return { url: 'http://127.0.0.1:37421/mcp', tokenless: false };
  return [];
};
const src = fs.readFileSync(path.join(here, '../installer/src/wizard.js'), 'utf8');
const wizard = new Function('window', 'document', 'navigator', `${src}; return { runInstall, next, back, get step() { return step; } };`)(
  { __TAURI__: { core: { invoke } } }, document, { userAgent: '' });
const tell = 'The AI Bridge was not updated. Your current version is still in place. Try again after your next system reboot, or close your browsers and AI apps, then press Try again.';

result = new Error('x', { cause: { message: 'os error 32', had_previous: true } });
await wizard.runInstall();
await wait(1200);
assert.equal(wizard.step, 2, 'a failed install moved on');
assert.ok(!calls.includes('mcp_url'));
assert.equal(node('install-failed-text').textContent, tell);
assert.equal(node('install-failed-details').textContent, 'os error 32');
assert.equal(node('install-failed').hidden, false);
assert.equal(node('btn-next').textContent, 'Try again');
assert.equal(node('btn-back').textContent, 'Close');
// A first install has no current version to speak of.
result = new Error('x', { cause: { message: 'disk full', had_previous: false } });
await wizard.next();
assert.doesNotMatch(node('install-failed-text').textContent, /current version/);
// Close closes.
calls = [];
await wizard.back();
assert.deepEqual(calls, ['quit']);
// Try again, this time it works: the failure is gone and the done screen comes.
result = ['✓  Installed Pinako MCP service'];
await wizard.next();
assert.equal(node('install-failed').hidden, true);
await wait(1200);
assert.equal(wizard.step, 3);
assert.equal(node('btn-back').textContent, 'Back');

fs.rmSync(dir, { recursive: true, force: true });
console.log('replace-binary: all checks passed');
