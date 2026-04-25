# Pinako AI Bridge — Installer Plan

## Overview

A downloadable Windows installer (`pinako-ai-bridge-setup.exe`) that:
1. Installs the Pinako MCP background service (Node.js + host.js bundled via `pkg`)
2. Registers the Chrome Native Messaging host (manifest + registry key)
3. Auto-detects installed AI clients and offers to configure each
4. Optionally registers a Windows startup entry so the server runs without Chrome open
5. Shows a "Copy MCP URL" button / final instructions for clients that need manual setup

**MVP approach:** Node.js installer script bundled into a self-contained `.exe` via `pkg`.
Runs in a console window. Non-technical users double-click → follow prompts → done.

**Future:** Wrap with Inno Setup for a proper wizard UI (progress bar, checkboxes, icons).

---

## File Structure

```
pinako-mcp/
  host.js                    ← existing MCP server (bundled into service exe)
  install.js                 ← existing (superseded by setup/native-host.js)
  package.json               ← add: @inquirer/prompts, pkg (devDep)
  installer-plan.md          ← this file
  setup/
    main.js                  ← installer entry point (bundled into setup.exe)
    detect.js                ← AI client detection
    configure.js             ← writes MCP config to each detected client
    native-host.js           ← registers Chrome native messaging host
    startup.js               ← Windows startup registry entry
    build.js                 ← builds both exes via pkg
```

**Build outputs (not committed, built by CI or locally):**
```
dist/
  pinako-mcp-service.exe     ← host.js + Node.js runtime (launched by Chrome NM)
  pinako-ai-bridge-setup.exe ← installer (setup/main.js + Node.js runtime)
```

---

## Phase 1 — Auto-config Clients (first build)

These have well-documented, stable config paths and a simple JSON merge operation.

| Client | Config file (Windows) | Format key | Detection |
|---|---|---|---|
| **Claude Code CLI** | `%USERPROFILE%\.claude\settings.json` | `mcpServers.pinako` with `type:"http"` | `.claude` dir exists |
| **Cursor** | `%USERPROFILE%\.cursor\mcp.json` | `mcpServers.pinako` with `url` | `.cursor` dir exists |
| **Windsurf** | `%USERPROFILE%\.codeium\windsurf\mcp_config.json` | `mcpServers.pinako` with `url` | `.codeium\windsurf` dir exists |
| **Cline** | `%APPDATA%\Code\User\globalStorage\saoudrizwan.claude-dev\settings\cline_mcp_settings.json` | `mcpServers.pinako` | file exists |
| **Roo Code** | `%APPDATA%\Code\User\globalStorage\rooveterinaryinc.roo-cline\settings\mcp_settings.json` | `mcpServers.pinako` | file exists |
| **Continue.dev** | `%USERPROFILE%\.continue\config.json` | nested under `experimental.modelContextProtocolServers` | `.continue` dir exists |

**Not auto-configured in Phase 1 (see docs instead):**
- Claude Desktop — config is stdio-only; HTTP requires mcp-remote bridge or manual setup
- VS Code native Copilot — merging into settings.json is risky; needs careful handling
- Zed — different schema (`context_servers`)
- Amazon Q, Codex CLI, Gemini — needs further research

---

## MCP Config Snippets Per Client

### Claude Code CLI (`~/.claude/settings.json`)
```json
{
  "mcpServers": {
    "pinako": {
      "type": "http",
      "url": "http://localhost:37421/mcp"
    }
  }
}
```
Merge strategy: deep-merge `mcpServers.pinako` into existing file (create file if absent).

### Cursor (`~/.cursor/mcp.json`)
```json
{
  "mcpServers": {
    "pinako": {
      "url": "http://localhost:37421/mcp"
    }
  }
}
```
Merge strategy: same as above.

### Windsurf (`~/.codeium/windsurf/mcp_config.json`)
```json
{
  "mcpServers": {
    "pinako": {
      "url": "http://localhost:37421/mcp"
    }
  }
}
```
Merge strategy: same.

### Cline / Roo Code (globalStorage JSON)
```json
{
  "mcpServers": {
    "pinako": {
      "url": "http://localhost:37421/mcp",
      "disabled": false,
      "autoApprove": []
    }
  }
}
```
Merge strategy: same. These files may not exist yet if user hasn't opened MCP settings in Cline — create them if absent (Cline will pick them up on next launch).

### Continue.dev (`~/.continue/config.json`)
```json
{
  "experimental": {
    "modelContextProtocolServers": [
      {
        "transport": {
          "type": "streamableHttp",
          "url": "http://localhost:37421/mcp"
        }
      }
    ]
  }
}
```
Merge strategy: append to the array if URL not already present; create `experimental.modelContextProtocolServers` path if absent.
⚠️ Continue.dev may use YAML (`config.yaml`) in newer versions — detect which exists and prefer JSON. HTTP transport support needs verification against latest Continue.dev release.

---

## Native Messaging Host Registration

Already implemented in `install.js`. Refactored into `setup/native-host.js`:

1. Detect extension ID — **hardcode Chrome Web Store ID** once published.
   During development, accept as argument or env var `PINAKO_EXT_ID`.
2. Write `%APPDATA%\Pinako\pinako-native-host.json`:
```json
{
  "name": "com.pinako.mcp",
  "description": "Pinako MCP bridge",
  "path": "C:\\Users\\<user>\\AppData\\Roaming\\Pinako\\pinako-mcp-service.exe",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://<EXT_ID>/"]
}
```
3. Write registry key:
`HKCU\Software\Google\Chrome\NativeMessagingHosts\com.pinako.mcp`
→ value = path to `pinako-native-host.json`

---

## Service Executable (`pinako-mcp-service.exe`)

Built from `host.js` using `pkg`:
```
pkg host.js --target node22-win-x64 --output dist/pinako-mcp-service.exe
```

The native host manifest points to this exe. Chrome launches it on-demand via native messaging.

**Startup mode (optional):** A separate registry run entry can launch `pinako-mcp-service.exe`
with a `--standalone` flag (to be added to host.js) that skips native messaging stdin reading
and just runs the HTTP server. This keeps the MCP server alive even when Chrome is closed.

---

## Installer Executable (`pinako-ai-bridge-setup.exe`)

Built from `setup/main.js` using `pkg`:
```
pkg setup/main.js --target node22-win-x64 --output dist/pinako-ai-bridge-setup.exe
```

### Installer flow:

```
╔══════════════════════════════════════════╗
║  Pinako AI Bridge — Setup                ║
║  Connecting your AI apps to Pinako       ║
╚══════════════════════════════════════════╝

Installing Pinako MCP service...    ✓
Registering browser connector...    ✓

Detected AI apps on this computer:
  ✓ Claude Code CLI
  ✓ Cursor
  ✗ Windsurf        (not found)
  ✗ Cline           (not found)
  ✗ Roo Code        (not found)
  ✗ Continue.dev    (not found)

Configure the detected apps? [Y/n]

Configuring Claude Code CLI...      ✓
Configuring Cursor...               ✓

─────────────────────────────────────────
  MCP Server URL: http://localhost:37421/mcp
  (copied to clipboard)
─────────────────────────────────────────

For Claude Desktop and other apps:
  See https://pinako.pro/docs/ai-connect

Done! Open Pinako in Chrome and start asking questions.
Press any key to exit.
```

### Dependencies (`setup/main.js`):
- `@inquirer/prompts` — interactive checkbox prompts (if user wants to deselect)
- `kleur` — terminal colors (tiny, zero deps)
- Node built-ins: `fs`, `path`, `os`, `child_process`, `readline`

---

## Build Script (`setup/build.js`)

Runs both `pkg` invocations and copies outputs to `dist/`:
```
node setup/build.js
```

Requires `pkg` installed: `npm install -g pkg` or as devDependency.

Target triples to support in future:
- `node22-win-x64` — Windows (first build)
- `node22-macos-x64` — Mac Intel
- `node22-macos-arm64` — Mac Apple Silicon
- `node22-linux-x64` — Linux

---

## Phase 2 — Future Enhancements

- [ ] Proper GUI installer via Inno Setup (wizard, progress bar, icons, uninstaller)
- [ ] Mac `.pkg` installer
- [ ] `--standalone` mode in `host.js` (HTTP server without native messaging dependency)
- [ ] Auto-updater (check `pinako.pro/version.json` on startup)
- [ ] VS Code native Copilot auto-config (careful settings.json merge)
- [ ] Zed auto-config
- [ ] Amazon Q, Codex CLI after their MCP config paths are confirmed
- [ ] Uninstaller (remove registry keys, config entries, files)
- [ ] Code-signing the exe (required for no SmartScreen warning on download)

---

## Key File Paths Reference (Windows)

| Item | Path |
|---|---|
| Pinako data dir | `%APPDATA%\Roaming\Pinako\` |
| Service exe | `%APPDATA%\Roaming\Pinako\pinako-mcp-service.exe` |
| Native host manifest | `%APPDATA%\Roaming\Pinako\pinako-native-host.json` |
| Debug log | `%APPDATA%\Roaming\Pinako\pinako-mcp.log` |
| Chrome NM registry key | `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.pinako.mcp` |
| Startup registry key | `HKCU\Software\Microsoft\Windows\CurrentVersion\Run\PinakoMCP` |
| Claude Code config | `%USERPROFILE%\.claude\settings.json` |
| Cursor config | `%USERPROFILE%\.cursor\mcp.json` |
| Windsurf config | `%USERPROFILE%\.codeium\windsurf\mcp_config.json` |
| Cline config | `%APPDATA%\Code\User\globalStorage\saoudrizwan.claude-dev\settings\cline_mcp_settings.json` |
| Roo Code config | `%APPDATA%\Code\User\globalStorage\rooveterinaryinc.roo-cline\settings\mcp_settings.json` |
| Continue.dev config | `%USERPROFILE%\.continue\config.json` |

---

## Extension ID Note

The Chrome NM `allowed_origins` requires the exact extension ID.
- **Development**: variable (changes per Chrome profile load)
- **Production (Chrome Web Store)**: permanent, hardcode in installer
- **Current dev ID**: passed to `node install.js <ID>` manually (see existing install.js)

When the extension is published, update `native-host.js` with the hardcoded production ID.
