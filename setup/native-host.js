/**
 * setup/native-host.js
 *
 * Registers the Pinako Chrome Native Messaging host.
 *
 * Windows: writes manifest JSON + registry key
 * Linux:   writes manifest JSON + symlinks into Chrome/Chromium NM dirs
 * macOS:   writes manifest JSON + symlinks into Chrome/Chromium NM dirs
 *
 * Extension ID:
 *   - Production: hardcode PROD_EXT_ID once published to Chrome Web Store
 *   - Development: pass via PINAKO_EXT_ID env var or --ext-id CLI arg
 *
 * Allow additional extension IDs alongside the primary one (e.g. to keep both
 * a dev unpacked install and the prod CWS install working on the same
 * machine):
 *   - PINAKO_DEV_EXT_ID env var (single extra ID)
 *   - --also-allow=<id> CLI arg (repeatable)
 *
 * Re-installs merge into the existing manifest rather than replacing it, so
 * previously-granted IDs are preserved.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { PINAKO_DIR, SERVICE_PATH, MANIFEST_PATH, NATIVE_HOST_DIRS, PLATFORM } from './paths.js';

// ─── Config ───────────────────────────────────────────────────────────────────

// Hardcode once published to Chrome Web Store.
// Format: 32 lowercase letters, e.g. 'abcdefghijklmnopqrstuvwxyzabcdef'
const PROD_EXT_ID = 'clakbccnkfpmpfooiiffomhknnfcodgd';

const HOST_NAME = 'com.pinako.mcp';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getExtId() {
  // 1. Production hardcode
  if (PROD_EXT_ID) return PROD_EXT_ID;

  // 2. Environment variable (dev installs / CI)
  const envId = process.env.PINAKO_EXT_ID;
  if (envId && /^[a-z]{32}$/.test(envId)) return envId;

  // 3. CLI argument --ext-id=<id>
  const arg = process.argv.find(a => a.startsWith('--ext-id='));
  if (arg) {
    const id = arg.split('=')[1];
    if (/^[a-z]{32}$/.test(id)) return id;
  }

  return null;
}

// Additional extension IDs to keep allowed alongside the primary one.
// Useful when the developer wants both their dev unpacked extension and
// the prod CWS extension to access the host on the same machine.
//   PINAKO_DEV_EXT_ID=<id>            (env var, single ID)
//   --also-allow=<id> [--also-allow=<id> ...]  (CLI, repeatable)
function getExtraExtIds() {
  const ids = new Set();
  const envId = process.env.PINAKO_DEV_EXT_ID;
  if (envId && /^[a-z]{32}$/.test(envId)) ids.add(envId);
  for (const arg of process.argv) {
    if (arg.startsWith('--also-allow=')) {
      const id = arg.split('=')[1];
      if (/^[a-z]{32}$/.test(id)) ids.add(id);
    }
  }
  return [...ids];
}

// Read existing allowed_origins from a previously-written manifest, if any.
// Returns an array of valid chrome-extension URLs (silently drops malformed
// entries). Returns [] when the file is missing or unreadable.
function readExistingAllowedOrigins() {
  try {
    if (!fs.existsSync(MANIFEST_PATH)) return [];
    const raw = fs.readFileSync(MANIFEST_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.allowed_origins)) return [];
    return parsed.allowed_origins.filter(
      o => typeof o === 'string' && /^chrome-extension:\/\/[a-z]{32}\/$/.test(o)
    );
  } catch {
    return [];
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Install the native messaging host.
 * Returns { ok: true } or { ok: false, error: string }
 */
export function installNativeHost() {
  const extId = getExtId();
  if (!extId) {
    return {
      ok: false,
      error:
        'Extension ID not set. Set PINAKO_EXT_ID env var or pass --ext-id=<id>. ' +
        'Once published to Chrome Web Store, hardcode PROD_EXT_ID in native-host.js.',
    };
  }

  try {
    // 1. Ensure Pinako data directory exists
    fs.mkdirSync(PINAKO_DIR, { recursive: true });

    // 2. Compute allowed_origins: primary ID + any extras + previously-allowed
    //    IDs from an existing manifest. Merging (rather than replacing) means
    //    a re-install never silently revokes access from an extension that
    //    was working before — e.g., the developer's dev unpacked install
    //    when running an installer hardcoded to the prod ID.
    const allowed = new Set();
    allowed.add(`chrome-extension://${extId}/`);
    for (const extra of getExtraExtIds()) {
      allowed.add(`chrome-extension://${extra}/`);
    }
    for (const existing of readExistingAllowedOrigins()) {
      allowed.add(existing);
    }

    // 3. Write native host manifest
    const manifest = {
      name: HOST_NAME,
      description: 'Pinako MCP bridge — connects Pinako extension to AI clients',
      path: SERVICE_PATH,
      type: 'stdio',
      allowed_origins: [...allowed],
    };
    fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n', 'utf8');

    // 4. Platform-specific registration
    if (PLATFORM === 'win32') {
      // Windows: registry key pointing to manifest
      const regKey = `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}`;
      execSync(`REG ADD "${regKey}" /ve /t REG_SZ /d "${MANIFEST_PATH}" /f`, {
        stdio: 'pipe',
      });
    } else {
      // Linux/macOS: symlink manifest into each browser's NativeMessagingHosts dir
      const linkName = `${HOST_NAME}.json`; // com.pinako.mcp.json
      for (const nmDir of NATIVE_HOST_DIRS) {
        try {
          fs.mkdirSync(nmDir, { recursive: true });
          const linkPath = path.join(nmDir, linkName);
          // Remove existing symlink/file if present, then create fresh symlink
          try { fs.unlinkSync(linkPath); } catch {}
          fs.symlinkSync(MANIFEST_PATH, linkPath);
        } catch {
          // Non-fatal: Chrome or Chromium may not be installed
        }
      }
    }

    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * Remove the native messaging host registration.
 * Returns { ok: true } or { ok: false, error: string }
 */
export function uninstallNativeHost() {
  try {
    if (PLATFORM === 'win32') {
      const regKey = `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}`;
      execSync(`REG DELETE "${regKey}" /f`, { stdio: 'pipe' });
    } else {
      const linkName = `${HOST_NAME}.json`;
      for (const nmDir of NATIVE_HOST_DIRS) {
        try {
          fs.unlinkSync(path.join(nmDir, linkName));
        } catch {}
      }
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
