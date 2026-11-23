/**
 * setup/replace-binary.js
 *
 * Put a new service binary where an old one may be running, then stop the old
 * one. The GUI installer does the same in installer/src-tauri/src/replace.rs,
 * which says why: a running program cannot be overwritten (Windows EBUSY, Linux
 * ETXTBSY) but it can be renamed. Anything that starts from the path after the
 * swap gets the new one, and only then are the old processes stopped.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const RENAME_TRIES = 15;
const DELETE_TRIES = 10;
const PAUSE_MS = 200;

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// A virus scanner can hold a fresh 90 MB file for a moment.
function renameRetry(from, to) {
  for (let i = 1; ; i++) {
    try { fs.renameSync(from, to); return; } catch (e) {
      if (i >= RENAME_TRIES || e.code === 'ENOENT') throw e;
      sleep(PAUSE_MS);
    }
  }
}

// Files an earlier run renamed out of the way: <name>.old-<digits>, nothing else.
const oldCopies = (file) => numbered(file, '.old-');

function numbered(file, suffix) {
  const dir = path.dirname(file);
  const prefix = path.basename(file) + suffix;
  let names = [];
  try { names = fs.readdirSync(dir); } catch (_) {}
  return names.filter((n) => n.startsWith(prefix) && /^\d+$/.test(n.slice(prefix.length))).map((n) => path.join(dir, n));
}

/** Best effort: one still running stays, and the next install takes it. */
export function deleteOldCopies(file) {
  for (const old of oldCopies(file)) {
    for (let i = 1; i <= DELETE_TRIES; i++) {
      try { fs.unlinkSync(old); break; } catch (_) { if (i < DELETE_TRIES) sleep(PAUSE_MS); }
    }
  }
}

// An installer closed between the two renames leaves no file at `file` and the
// working one under its old name: put the newest of those back.
function recover(file) {
  if (fs.existsSync(file)) return;
  const stamp = (p) => Number(p.slice(p.lastIndexOf('-') + 1));
  const newest = oldCopies(file).sort((a, b) => stamp(b) - stamp(a))[0];
  if (newest) { try { renameRetry(newest, file); } catch (_) {} }
}

// New files an interrupted run never moved in. Only stale ones: a second
// installer open right now may still be writing its own.
function deleteStaleNew(file) {
  for (const p of numbered(file, '.new-')) {
    try { if (Date.now() - fs.statSync(p).mtimeMs > 3600_000) fs.unlinkSync(p); } catch (_) {}
  }
}

/** Write `bytes` at `file`. When this throws, the file that was there is still there. */
export function replaceBinary(file, bytes) {
  recover(file);
  deleteStaleNew(file);
  // Its own name each time, and never one that exists: two installers open at
  // once must not write into the same file.
  const fresh = `${file}.new-${process.pid}${Date.now()}`;
  const dropFresh = () => { try { fs.unlinkSync(fresh); } catch (_) {} };
  try {
    const fd = fs.openSync(fresh, 'wx', 0o755);
    try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    if (process.platform !== 'win32') fs.chmodSync(fresh, 0o755);
  } catch (e) { dropFresh(); throw e; }

  const aside = `${file}.old-${Date.now()}`;
  const hadOld = fs.existsSync(file);
  if (hadOld) {
    try { renameRetry(file, aside); } catch (e) { dropFresh(); throw e; }
  }
  try { renameRetry(fresh, file); } catch (e) {
    if (hadOld) {
      try { renameRetry(aside, file); } catch (e2) { e.message += `; could not put the old file back: ${e2.message}`; }
    }
    dropFresh();
    throw e;
  }
}

/** True for `file` itself and for a copy of it renamed out of the way. */
export function isOurs(candidate, file, platform = process.platform) {
  const norm = (s) => {
    const t = s.replace(/^\\\\\?\\/, '').replace(/ \(deleted\)$/, '');
    return platform === 'win32' ? t.replace(/\//g, '\\').toLowerCase() : t;
  };
  // The system reports the real path; ours may go through a link (a moved
  // profile, a linked home folder).
  let real = file;
  try { real = fs.realpathSync(file); } catch (_) {}
  const c = norm(candidate);
  return [file, real].some((f) => {
    const ours = norm(f);
    return c.startsWith(ours) && /^(\.old-\d+)?$/.test(c.slice(ours.length));
  });
}

// null = the list could not be read, so nobody can say what is running.
function ourPids(file) {
  const out = [];
  if (process.platform === 'linux') {
    let names = [];
    try { names = fs.readdirSync('/proc').filter((n) => /^\d+$/.test(n)); } catch (_) { return null; }
    for (const n of names) {
      try { if (isOurs(fs.readlinkSync(`/proc/${n}/exe`), file)) out.push(Number(n)); } catch (_) {}
    }
    return out;
  }
  // Windows: name and path are asked for by PowerShell. macOS: ps gives the
  // full path as comm. One "<pid> <path>" line each.
  const r = process.platform === 'win32'
    ? spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        "[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path } | ForEach-Object { \"$($_.Id) $($_.Path)\" }"],
      { encoding: 'utf8', timeout: 30_000, windowsHide: true })
    : spawnSync('ps', ['-axo', 'pid=,comm='], { encoding: 'utf8', timeout: 30_000 });
  if (!r || r.error || !String(r.stdout || '').trim()) return null;
  for (const line of String(r.stdout).split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(.+?)\s*$/.exec(line);
    if (m && isOurs(m[2], file)) out.push(Number(m[1]));
  }
  return out;
}

const running = (pid) => {
  try { process.kill(pid, 0); } catch (e) { return e.code === 'EPERM'; }
  // A finished child its parent has not collected yet still answers on Linux.
  if (process.platform === 'linux') {
    try { if (/^\d+ \(.*\) Z/s.test(fs.readFileSync(`/proc/${pid}/stat`, 'utf8'))) return false; } catch (_) { return false; }
  }
  return true;
};

/**
 * Stop every process running from `file` (or a renamed-aside copy of it) and
 * wait for each to end. Never by name alone: a copy running from another folder
 * is not ours to stop. Returns false when one of them is still running.
 */
export function stopProcesses(file) {
  let pids = ourPids(file);
  if (!pids) return false;
  pids = pids.filter((p) => p !== process.pid);
  for (const signal of ['SIGTERM', 'SIGKILL']) {
    for (const p of pids) { try { process.kill(p, signal); } catch (_) {} }
    for (let i = 0; i < 25 && pids.length; i++) {
      pids = pids.filter(running);
      if (pids.length) sleep(100);
    }
    if (!pids.length) return true;
  }
  return false;
}
