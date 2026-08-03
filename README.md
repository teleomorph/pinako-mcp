# Pinako AI Bridge

**Connect your browser tabs and libraries to Claude Desktop, Cursor, and everything else your AI can reach.**

The Model Context Protocol (MCP) bridge that connects [Pinako](https://pinako.pro) — a Chromium extension for tab tree management — to local AI clients including Claude Code, Claude Desktop, Cursor, ChatGPT-Codex, VS Code (Copilot agent mode), Antigravity, Grok Build, Kimi Code, OpenClaw, Hermes, Cline, Zoo Code, and any HTTP MCP client. Legacy installs of Windsurf, Roo Code, Continue.dev, and Gemini CLI are also configured when present.

The bridge runs as a small native messaging host on your computer and exposes your Pinako tab tree, libraries, library groups, Main Notes, and browser bookmarks as MCP tools. It is a full **read and write** surface: your AI assistant can both query your browser state and reorganize it — move and nest tabs, create libraries, groups, and folders, edit titles, tags, memos, colors, and notes, find and remove duplicates, and apply large batched edits as a single undoable step.

Because the bridge runs inside desktop AI clients like Claude Desktop, Cursor, and Codex, the same assistant can move information between Pinako and the other tools, files, and services it connects to. For example:

- "Copy this research library's notes into a Google Doc."
- "Build a spreadsheet from the tabs in my Competitors library."
- "Visit the URLs in my Reading library and write up a summary."
- "Organize my open tabs into libraries by topic, then tag the work ones."
- "Find and remove my duplicate bookmarks."

> Writes go through the same tier gating, confirmation, and undo machinery as the extension's own UI. Destructive operations (deletes, bookmark reorders) return a `CONFIRMATION_REQUIRED` result until the caller explicitly confirms, and a `bulk_apply` batch applies atomically as one undo step. Every write returns a structured `{ok, error}` result so clients can branch on the error code.

## Tools

Read and write MCP tools. Full per-tool reference with parameters: [pinako.pro/docs/ai-connect](https://pinako.pro/docs/ai-connect).

**Read** — query the tree, libraries, notes, and bookmarks, and search

`get_tree`, `get_tree_summary`, `search_tabs`, `search_pinako`, `search_docs`, `list_libraries`, `get_library`, `get_main_tree_notes`, `get_bookmarks`, `list_browsers`, `find_duplicates`

**Tree structure** — move, nest, group, and remove nodes

`move_node`, `indent_node`, `outdent_node`, `create_group`, `create_folder`, `ghost_node`, `delete_node`, `delete_live_node`, `bulk_apply` (up to 250 atomic sub-ops, undoable as one step)

**Node metadata** — titles, tags, memos, colors

`set_title`, `set_tags`, `add_tags`, `remove_tags`, `set_memo`, `set_star_color`, `set_row_color`

**Libraries and library groups** — create, edit, delete, and arrange

`create_library`, `add_to_library`, `set_library_title`, `set_library_description`, `delete_library`, `create_library_group`, `set_library_group_title`, `set_library_group_description`, `delete_library_group`, `add_library_to_group`, `remove_library_from_group`, `reorder_library_panel`, `reorder_libraries_in_group`

**Notes** — create and edit Main Notes and library notes

`create_note`, `set_note_content`, `delete_note`

**Bookmarks** — write to the browser bookmark tree

`add_to_bookmarks` (bookmark reads use `get_bookmarks`; dedup uses `find_duplicates`)

The read tools are safe to auto-approve. Write tools are individually annotated (idempotent, non-idempotent, or destructive) so MCP clients can gate them appropriately.

## Install

**Setup guide with screenshots and per-client instructions:** [pinako.pro/docs/ai-connect](https://pinako.pro/docs/ai-connect)

**Downloads:** [pinako.pro/downloads](https://pinako.pro/downloads)

Available installers:

- **Windows** — graphical installer (`.exe`)
- **Linux x64** and **Linux ARM64** — CLI installer

## Requirements

- Pinako extension installed in your browser ([Chrome Web Store](https://chromewebstore.google.com/detail/pinako/clakbccnkfpmpfooiiffomhknnfcodgd))
- An active Pinako subscription (Pro or higher) — the bridge is gated by subscription

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
