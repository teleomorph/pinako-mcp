/**
 * setup/paths.js
 *
 * Centralized platform-aware path resolution.
 * All platform branching for file paths lives here.
 * Other setup modules import constants instead of computing paths inline.
 */

import os from 'node:os';
import path from 'node:path';

export const HOME = os.homedir();
export const PLATFORM = os.platform(); // 'win32', 'linux', 'darwin'

// ── Pinako data directory ────────────────────────────────────────────────────
// Windows: %APPDATA%\Pinako\
// Linux:   ~/.local/share/pinako/
// macOS:   ~/Library/Application Support/Pinako/

function getPinakoDir() {
  switch (PLATFORM) {
    case 'win32': {
      const appdata = process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming');
      return path.join(appdata, 'Pinako');
    }
    case 'linux':
      return path.join(HOME, '.local', 'share', 'pinako');
    case 'darwin':
      return path.join(HOME, 'Library', 'Application Support', 'Pinako');
    default:
      return path.join(HOME, '.pinako');
  }
}

export const PINAKO_DIR = getPinakoDir();

// ── Service binary ───────────────────────────────────────────────────────────

export const SERVICE_BINARY_NAME = PLATFORM === 'win32'
  ? 'pinako-mcp-service.exe'
  : 'pinako-mcp-service';

export const SERVICE_PATH = path.join(PINAKO_DIR, SERVICE_BINARY_NAME);

// ── Log file ─────────────────────────────────────────────────────────────────

export const LOG_PATH = path.join(PINAKO_DIR, 'pinako-mcp.log');

// ── Native host manifest ─────────────────────────────────────────────────────

export const MANIFEST_PATH = path.join(PINAKO_DIR, 'pinako-native-host.json');

// ── Chrome NativeMessagingHosts directories ──────────────────────────────────
// Windows: registered via registry key (no fixed dir needed)
// Linux:   file-based — Chrome and Chromium each have a known dir
// macOS:   ~/Library/Application Support/Google/Chrome/NativeMessagingHosts/

function getNativeHostDirs() {
  switch (PLATFORM) {
    case 'linux':
      return [
        path.join(HOME, '.config', 'google-chrome', 'NativeMessagingHosts'),
        path.join(HOME, '.config', 'chromium', 'NativeMessagingHosts'),
      ];
    case 'darwin':
      return [
        path.join(HOME, 'Library', 'Application Support', 'Google', 'Chrome', 'NativeMessagingHosts'),
        path.join(HOME, 'Library', 'Application Support', 'Chromium', 'NativeMessagingHosts'),
      ];
    default:
      return []; // Windows uses registry
  }
}

export const NATIVE_HOST_DIRS = getNativeHostDirs();

// ── APPDATA equivalent (for VS Code extensions: Cline, Roo Code) ────────────
// Windows: %APPDATA% → C:\Users\<user>\AppData\Roaming
// Linux:   ~/.config
// macOS:   ~/Library/Application Support

function getAppdata() {
  switch (PLATFORM) {
    case 'win32':
      return process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming');
    case 'linux':
      return path.join(HOME, '.config');
    case 'darwin':
      return path.join(HOME, 'Library', 'Application Support');
    default:
      return path.join(HOME, '.config');
  }
}

export const APPDATA = getAppdata();
