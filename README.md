# Pinako AI Bridge

The Model Context Protocol (MCP) bridge that connects [Pinako](https://pinako.pro) — a Chromium extension for tab tree management — to local AI clients including Claude Code, Claude Desktop, Cursor, Windsurf, Cline, Roo Code, Continue.dev, and any HTTP MCP client.

The bridge runs as a small native messaging host on your computer, exposing your Pinako tab tree, libraries, and global notes as **read-only** MCP tools your AI assistant can query.

## Tools exposed

- `get_tree` — current tab tree (groups → windows → tabs)
- `search_tabs` — search tabs by URL, title, tags, or memos
- `list_libraries` — names of saved libraries
- `get_library` — contents of a specific library
- `get_global_notes` — your global notes

All read-only. The bridge cannot create, modify, or delete anything in your Pinako data.

## Install

**Setup guide with screenshots and per-client instructions:** [pinako.pro/docs/ai-connect](https://pinako.pro/docs/ai-connect)

**Downloads:** [pinako.pro/downloads](https://pinako.pro/downloads)

Available installers:

- **Windows** — graphical installer (`.exe`)
- **Linux x64** and **Linux ARM64** — CLI installer

## Requirements

- Pinako extension installed in your browser ([Chrome Web Store](https://chromewebstore.google.com/detail/pinako/clakbccnkfpmpfooiiffomhknnfcodgd))
- Pinako Pro tier 1 or higher — the bridge is gated by subscription

## Build from source

```bash
git clone https://github.com/teleomorph/pinako-mcp.git
cd pinako-mcp
npm install
node setup/build.js --all
```

Outputs land in `dist/`. See `setup/build.js` for build flags (`--all`, `--no-tauri`, `--no-cli`).

The Tauri GUI installer can only be built on the platform it targets (i.e. build the Windows installer on Windows). The CLI installer cross-compiles for all listed platforms from any host.

## Architecture

- `host.js` — MCP server / Chrome native messaging host
- `setup/main.js` — CLI installer (writes the native messaging host JSON, configures supported AI clients)
- `setup/build.js` — multi-stage build (esbuild → pkg → Tauri)
- `installer/src-tauri/` — Rust Tauri GUI installer for Windows

## License

[MIT](LICENSE)
