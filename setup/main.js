#!/usr/bin/env node
/**
 * setup/main.js — Pinako AI Bridge installer entry point
 *
 * Bundled into pinako-ai-bridge-setup.exe via pkg.
 * Runs in a console window. Non-technical users double-click and follow prompts.
 *
 * Flow:
 *   1. Banner
 *   2. Install service + native host
 *   3. Detect AI clients
 *   4. Prompt user to confirm / deselect
 *   5. Configure selected clients
 *   6. Show summary + copy URL to clipboard
 */

import readline from 'node:readline';
import fs from 'node:fs';
import { execSync } from 'node:child_process';
import { installNativeHost } from './native-host.js';
import { detectClients } from './detect.js';
import { configureClients } from './configure.js';
import { PINAKO_DIR, SERVICE_PATH, PLATFORM } from './paths.js';
// serviceExeBase64 is injected at build time by setup/build.js
// (generates setup/_service-embedded.js before running esbuild)
import { serviceExeBase64 } from './_service-embedded.js';

// ─── Terminal colors (no deps — just ANSI codes) ──────────────────────────────
const c = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  dim:    '\x1b[2m',
  green:  '\x1b[32m',
  red:    '\x1b[31m',
  yellow: '\x1b[33m',
  cyan:   '\x1b[36m',
  white:  '\x1b[37m',
};

const ok  = `${c.green}✓${c.reset}`;
const err = `${c.red}✗${c.reset}`;
const dot = `${c.dim}·${c.reset}`;

function bold(s)   { return `${c.bold}${s}${c.reset}`; }
function dim(s)    { return `${c.dim}${s}${c.reset}`; }
function green(s)  { return `${c.green}${s}${c.reset}`; }
function yellow(s) { return `${c.yellow}${s}${c.reset}`; }
function cyan(s)   { return `${c.cyan}${s}${c.reset}`; }

// ─── Readline helpers ─────────────────────────────────────────────────────────
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

function ask(question) {
  return new Promise(resolve => rl.question(question, resolve));
}

function pressAnyKey() {
  return new Promise(resolve => {
    process.stdin.setRawMode?.(true);
    process.stdin.resume();
    process.stdin.once('data', () => {
      process.stdin.setRawMode?.(false);
      resolve();
    });
  });
}

// ─── Clipboard helper (cross-platform) ───────────────────────────────────────
function copyToClipboard(text) {
  const t = text.trim();
  try {
    if (PLATFORM === 'win32') {
      execSync(`echo ${t} | clip`, { stdio: 'pipe' });
      return true;
    }
    if (PLATFORM === 'darwin') {
      execSync(`echo -n '${t}' | pbcopy`, { stdio: 'pipe' });
      return true;
    }
    // Linux: try xclip, xsel, wl-copy in order
    const cmds = [
      `echo -n '${t}' | xclip -selection clipboard`,
      `echo -n '${t}' | xsel --clipboard --input`,
      `echo -n '${t}' | wl-copy`,
    ];
    for (const cmd of cmds) {
      try {
        execSync(cmd, { stdio: 'pipe', timeout: 2000 });
        return true;
      } catch {}
    }
    return false;
  } catch {
    return false;
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.clear();

  // Banner
  console.log('');
  console.log(bold(cyan('  ╔══════════════════════════════════════════╗')));
  console.log(bold(cyan('  ║') + bold('  Pinako AI Bridge — Setup               ') + bold(cyan('║'))));
  console.log(bold(cyan('  ║') + dim('  Connect your AI apps to Pinako          ') + bold(cyan('║'))));
  console.log(bold(cyan('  ╚══════════════════════════════════════════╝')));
  console.log('');

  // ── Step 1: Extract service binary ──────────────────────────────────────────
  process.stdout.write('  Installing Pinako MCP service...  ');
  try {
    fs.mkdirSync(PINAKO_DIR, { recursive: true });
    fs.writeFileSync(SERVICE_PATH, Buffer.from(serviceExeBase64, 'base64'));
    // On Linux/macOS, make the binary executable
    if (PLATFORM !== 'win32') {
      fs.chmodSync(SERVICE_PATH, 0o755);
    }
    console.log(ok);
  } catch (e) {
    console.log(err);
    console.log(`  ${c.red}Could not write service binary: ${e.message}${c.reset}`);
    console.log(dim(PLATFORM === 'win32'
      ? '  Try running as administrator if the error persists.'
      : '  Try running with sudo if the error persists.'));
    console.log('');
  }

  // ── Step 2: Register native host ──────────────────────────────────────────
  process.stdout.write('  Registering browser connector...  ');
  const nhResult = installNativeHost();
  if (nhResult.ok) {
    console.log(ok);
  } else {
    console.log(err);
    console.log('');
    // Non-fatal if ext ID not set yet (dev build); warn and continue
    if (nhResult.error.includes('Extension ID not set')) {
      console.log(yellow('  ⚠  Extension ID not configured — browser connector skipped.'));
      console.log(dim('     Set PINAKO_EXT_ID or update PROD_EXT_ID in native-host.js.'));
    } else {
      console.log(`  ${c.red}Error: ${nhResult.error}${c.reset}`);
    }
  }

  // ── Step 2: Detect AI clients ─────────────────────────────────────────────
  console.log('');
  console.log(bold('  Detected AI apps on this computer:'));
  console.log('');

  const clients = detectClients();
  const found = clients.filter(c => c.found);
  const notFound = clients.filter(c => !c.found);

  found.forEach(c => {
    const note = c.note ? dim(`  (${c.note})`) : '';
    console.log(`    ${ok}  ${c.label}${note}`);
  });
  notFound.forEach(c => {
    console.log(`    ${dot}  ${dim(c.label + '  (not found)')}`);
  });

  console.log('');

  if (found.length === 0) {
    console.log(yellow('  No supported AI apps found on this machine.'));
    console.log(dim('  Install Claude Code, Claude Desktop, Cursor, Windsurf, Cline, Roo Code, or Continue.dev'));
    console.log(dim('  then re-run this installer.'));
    console.log('');
    await showFinalInstructions();
    await finish();
    return;
  }

  // ── Step 3: Prompt for confirmation ──────────────────────────────────────
  // For MVP: configure all found clients. In future: checkbox per client.
  const answer = await ask(`  Configure all ${found.length} detected app(s)? [Y/n]  `);
  const confirmed = answer.trim().toLowerCase() !== 'n';
  console.log('');

  if (!confirmed) {
    console.log(dim('  Skipped client configuration.'));
    console.log('');
    await showFinalInstructions();
    await finish();
    return;
  }

  // ── Step 4: Configure clients ─────────────────────────────────────────────
  const results = configureClients(found);

  console.log(bold('  Configuring apps:'));
  console.log('');

  let anyFailed = false;
  for (const { client, ok: success, error } of results) {
    if (success) {
      console.log(`    ${ok}  ${client.label}`);
    } else {
      console.log(`    ${err}  ${client.label}  ${c.red}— ${error}${c.reset}`);
      anyFailed = true;
    }
  }

  console.log('');

  if (anyFailed) {
    console.log(yellow('  Some apps could not be configured automatically.'));
    console.log(dim('  You can configure them manually using the URL below.'));
    console.log('');
  }

  // ── Step 5: Final instructions ─────────────────────────────────────────────
  await showFinalInstructions();

  // ── Step 6: Restart prompt ────────────────────────────────────────────────
  if (found.length > 0) {
    console.log(dim('  Restart any configured apps to pick up the new settings.'));
    console.log('');
  }

  await finish();
}

async function showFinalInstructions() {
  const MCP_URL = 'http://localhost:37421/mcp';
  const copied = copyToClipboard(MCP_URL);

  console.log(`  ${bold(cyan('─────────────────────────────────────────────'))}` );
  console.log(`    MCP Server URL: ${bold(green(MCP_URL))}`);
  if (copied) {
    console.log(dim('    (copied to clipboard)'));
  }
  console.log(`  ${bold(cyan('─────────────────────────────────────────────'))}`);
  console.log('');
  console.log(`  For other MCP-capable apps, see:`);
  console.log(`  ${cyan('https://pinako.pro/docs/ai-connect')}`);
  console.log('');
  console.log(`  ${bold('Open Pinako in Chrome first')} — the MCP server starts`);
  console.log(`  automatically when you open the extension.`);
  console.log('');
}

async function finish() {
  rl.close();
  process.stdout.write('  Press any key to exit...');
  // Fallback for environments without raw mode (e.g. some CI)
  try {
    await pressAnyKey();
  } catch {
    await ask('');
  }
  console.log('');
  process.exit(0);
}

main().catch(e => {
  console.error(`\n  ${c.red}Fatal error: ${e.message}${c.reset}\n`);
  process.exit(1);
});
