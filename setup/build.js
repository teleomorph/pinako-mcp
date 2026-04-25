#!/usr/bin/env node
/**
 * setup/build.js
 *
 * Multi-stage build:
 *   1. esbuild  — bundles host.js + all dependencies into a single CJS file.
 *   2. pkg      — wraps the CJS bundle + Node.js runtime into a self-contained binary.
 *   2b. CLI     — builds the CLI installer (setup/main.js) with embedded service binary.
 *   3. Tauri    — compiles installer/src-tauri into the GUI installer.
 *                 The service binary is embedded via include_bytes! in Rust,
 *                 so it must exist in dist/ before this stage runs.
 *
 * Outputs (in dist/):
 *   pinako-mcp-service[.exe]        ← host.js (MCP service / Chrome NM host)
 *   pinako-ai-bridge-setup-*        ← CLI installer (embeds service binary)
 *   pinako-ai-bridge-setup.exe      ← Tauri GUI installer (Windows)
 *
 * Prerequisites for Stage 3:
 *   - Rust toolchain (rustup + cargo): https://rustup.rs
 *   - Run `npm install` inside installer/ once to get @tauri-apps/cli
 *
 * Usage:
 *   node setup/build.js             ← current platform only (default)
 *   node setup/build.js --all       ← all platforms
 *   node setup/build.js --no-tauri  ← skip Tauri step
 *   node setup/build.js --no-cli    ← skip CLI installer step
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT      = path.join(__dirname, '..');
const DIST      = path.join(ROOT, 'dist');
const STAGED    = path.join(DIST, '_staged');
const INSTALLER = path.join(ROOT, 'installer');

const buildAll        = process.argv.includes('--all');
const skipTauri       = process.argv.includes('--no-tauri');
const skipCliInstaller = process.argv.includes('--no-cli');

const TARGETS_DEFAULT = ['node18-win-x64'];
const TARGETS_ALL = [
  'node18-win-x64',
  'node18-macos-x64',
  'node18-macos-arm64',
  'node18-linux-x64',
  'node18-linux-arm64',
];
const TARGETS = buildAll ? TARGETS_ALL : TARGETS_DEFAULT;

const EXE_SUFFIX = {
  'node18-win-x64':       'pinako-mcp-service.exe',
  'node18-macos-x64':     'pinako-mcp-service-mac-x64',
  'node18-macos-arm64':   'pinako-mcp-service-mac-arm64',
  'node18-linux-x64':     'pinako-mcp-service-linux-x64',
  'node18-linux-arm64':   'pinako-mcp-service-linux-arm64',
};

const CLI_INSTALLER_SUFFIX = {
  'node18-win-x64':       'pinako-ai-bridge-cli-win-x64.exe',
  'node18-macos-x64':     'pinako-ai-bridge-cli-mac-x64',
  'node18-macos-arm64':   'pinako-ai-bridge-cli-mac-arm64',
  'node18-linux-x64':     'pinako-ai-bridge-cli-linux-x64',
  'node18-linux-arm64':   'pinako-ai-bridge-cli-linux-arm64',
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function run(cmd, opts = {}) {
  console.log(`  \x1b[2m$ ${cmd}\x1b[0m`);
  execSync(cmd, { stdio: 'inherit', cwd: ROOT, ...opts });
}

function step(msg) {
  console.log(`\n\x1b[1m\x1b[36m${msg}\x1b[0m`);
}

function fileSizeMb(p) {
  return (fs.statSync(p).size / 1024 / 1024).toFixed(1);
}

// ─── Stage 1: esbuild ─────────────────────────────────────────────────────────

function esbuildBundle(entryPoint, outFile) {
  run(
    `npx esbuild "${entryPoint}"` +
    ` --bundle` +
    ` --platform=node` +
    ` --format=cjs` +
    ` --tree-shaking=true` +
    ` --minify` +
    ` --outfile="${outFile}"`
  );
}

// ─── Stage 2: pkg ─────────────────────────────────────────────────────────────

function pkgWrap(bundleFile, target, outFile) {
  run(
    `npx pkg "${bundleFile}"` +
    ` --target ${target}` +
    ` --output "${outFile}"` +
    ` --no-bytecode` +
    ` --public` +
    ` --no-warnings`
  );
}

// ─── Stage 2.5: copy wordmark for Tauri frontend ──────────────────────────────

function copyWordmark() {
  const src  = path.join(ROOT, '..', 'Pinako', 'assets', 'images',
    'Pinako wordmark no padding 1200 alpha outline.png');
  const dest = path.join(INSTALLER, 'src', 'images', 'wordmark.png');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  console.log(`  \x1b[32m✓\x1b[0m  installer/src/images/wordmark.png`);
}

// ─── Stage 3: Tauri installer ─────────────────────────────────────────────────

function buildTauriInstaller() {
  // Ensure installer npm deps are present (@tauri-apps/cli)
  if (!fs.existsSync(path.join(INSTALLER, 'node_modules'))) {
    step('Stage 3a: installing Tauri CLI...');
    run('npm install', { cwd: INSTALLER });
  }

  step('Stage 3: building Tauri installer...');
  run('npx tauri build', { cwd: INSTALLER });

  // Copy the release binary to dist/
  const targetDir = path.join(INSTALLER, 'src-tauri', 'target', 'release');
  let tauriExe, setupOut;

  if (process.platform === 'win32') {
    tauriExe = path.join(targetDir, 'pinako-installer.exe');
    setupOut = path.join(DIST, 'pinako-ai-bridge-setup.exe');
  } else {
    tauriExe = path.join(targetDir, 'pinako-installer');
    const suffix = process.platform === 'linux' ? 'linux' : 'mac';
    setupOut = path.join(DIST, `pinako-ai-bridge-setup-${suffix}`);
  }

  fs.copyFileSync(tauriExe, setupOut);
  // Set executable permission on Linux/macOS
  if (process.platform !== 'win32') {
    fs.chmodSync(setupOut, 0o755);
  }
  console.log(`  \x1b[32m✓\x1b[0m  dist/${path.basename(setupOut)}  (${fileSizeMb(setupOut)} MB)`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function build() {
  step('Pinako AI Bridge — Build');

  fs.mkdirSync(DIST,   { recursive: true });
  fs.mkdirSync(STAGED, { recursive: true });

  // ── Stage 1: bundle host.js with esbuild ──────────────────────────────────
  step('Stage 1: bundling with esbuild...');

  const serviceBundle = path.join(STAGED, 'host.cjs');
  esbuildBundle('host.js', serviceBundle);
  console.log(`  \x1b[32m✓\x1b[0m  host.js → _staged/host.cjs`);

  // ── Stage 2: wrap with pkg (once per target) ──────────────────────────────
  for (const target of TARGETS) {
    step(`Stage 2: packaging service for ${target}...`);
    const name = EXE_SUFFIX[target];
    const out  = path.join(DIST, name);
    pkgWrap(serviceBundle, target, out);
    console.log(`  \x1b[32m✓\x1b[0m  dist/${name}  (${fileSizeMb(out)} MB)`);
  }

  // ── Stage 2b: CLI installer executables ───────────────────────────────────
  // The CLI installer (setup/main.js) embeds the service binary as base64
  // and is itself bundled into a standalone executable via esbuild + pkg.
  if (skipCliInstaller) {
    console.log('\n  \x1b[33m⚠\x1b[0m  --no-cli: skipping CLI installer build.');
  } else {
    for (const target of TARGETS) {
      const serviceName = EXE_SUFFIX[target];
      const serviceBinaryPath = path.join(DIST, serviceName);
      if (!fs.existsSync(serviceBinaryPath)) {
        console.log(`\n  \x1b[33m⚠\x1b[0m  Skipping CLI installer for ${target} (service binary not found)`);
        continue;
      }

      step(`Stage 2b: building CLI installer for ${target}...`);

      // Generate _service-embedded.js with the platform-correct service binary
      const serviceBase64 = fs.readFileSync(serviceBinaryPath).toString('base64');
      const embeddedJs = `export const serviceExeBase64 = '${serviceBase64}';\n`;
      fs.writeFileSync(path.join(__dirname, '_service-embedded.js'), embeddedJs, 'utf8');

      // Bundle setup/main.js with esbuild
      const cliBundle = path.join(STAGED, 'cli-installer.cjs');
      esbuildBundle('setup/main.js', cliBundle);

      // Wrap with pkg
      const cliSuffix = CLI_INSTALLER_SUFFIX[target];
      const cliOut = path.join(DIST, cliSuffix);
      pkgWrap(cliBundle, target, cliOut);
      console.log(`  \x1b[32m✓\x1b[0m  dist/${cliSuffix}  (${fileSizeMb(cliOut)} MB)`);
    }
    // Clean up generated file
    try { fs.unlinkSync(path.join(__dirname, '_service-embedded.js')); } catch {}
  }

  fs.rmSync(STAGED, { recursive: true, force: true });

  // ── Stage 3: Tauri GUI installer ──────────────────────────────────────────
  if (skipTauri) {
    console.log('\n  \x1b[33m⚠\x1b[0m  --no-tauri: skipping Tauri installer build.');
  } else {
    // Tauri can only compile for the current platform
    const hasPlatformTarget =
      (process.platform === 'win32'  && TARGETS.some(t => t.includes('win'))) ||
      (process.platform === 'linux'  && TARGETS.some(t => t.includes('linux'))) ||
      (process.platform === 'darwin' && TARGETS.some(t => t.includes('macos')));

    if (!hasPlatformTarget) {
      console.log('\n  \x1b[33m⚠\x1b[0m  Tauri step skipped (no matching target for current platform).');
    } else {
      copyWordmark();
      buildTauriInstaller();
    }
  }

  step('Done');
  console.log('');
  console.log('  Next steps:');
  console.log('  1. Test on a clean machine:');
  console.log('       Windows: run dist/pinako-ai-bridge-setup.exe');
  console.log('       Linux:   chmod +x dist/pinako-ai-bridge-cli-linux-x64 && ./dist/pinako-ai-bridge-cli-linux-x64');
  console.log('  2. Sign executables before distributing');
  console.log('  3. Upload to pinako.pro/downloads/');
  console.log('');
}

build().catch(e => {
  console.error(`\n\x1b[31mBuild failed: ${e.message}\x1b[0m\n`);
  process.exit(1);
});
