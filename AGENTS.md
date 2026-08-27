# Guidance for AI coding agents

This repo is the **Pinako AI Bridge** - the local MCP (Model Context Protocol)
server that connects [Pinako](https://pinako.pro), a browser tab / session /
bookmark organizer, to desktop AI clients (Claude Code, Claude Desktop, Cursor,
ChatGPT-Codex, VS Code, and any HTTP MCP client).

## If you're here to USE Pinako (not develop this repo)

You probably don't need this codebase at all:

- **Local bridge already installed?** Connect your MCP client to
  `http://127.0.0.1:37421/mcp` (the installer appends a machine-local access
  token to the configured URL; without it the surface is read-only).
- **No install:** use the hosted Remote MCP Connector at
  `https://connect.pinako.pro/mcp` (OAuth sign-in).
- Tool list with descriptions: https://pinako.pro/.well-known/mcp/server-card.json
- Setup + troubleshooting: https://pinako.pro/docs/mcp-setup/
  (markdown: https://pinako.pro/docs/mcp-setup/index.md)
- Product overview for agents: https://pinako.pro/llms.txt

## If you're developing in this repo

- **Layout:** `host.js` is the native-messaging host + HTTP MCP server;
  `install.js` / `setup/` handle client auto-configuration; `installer/` is the
  Tauri Windows installer; `src/` holds shared modules; `tests/` runs on
  vitest (`npx vitest run`).
- **The extension is the source of truth for tool behavior.** The bridge
  relays tool calls to the Pinako extension over native messaging; it does not
  reimplement tree logic. Tool schemas here must stay in parity with the
  extension's chat tools and the hosted connector (the "tool-surface parity"
  rule: a tool added or changed on one surface must land on all of them).
- **Writes are guarded.** Destructive operations return `CONFIRMATION_REQUIRED`
  until explicitly confirmed; `bulk_apply` batches up to 250 sub-ops as one
  undoable step. Keep those invariants - clients depend on the structured
  `{ok, error}` result shape.
- **Don't bump versions or publish.** Releases are cut from the private
  product repo's release ritual (build → tag → GitHub Release). Leave
  `package.json` version, tags, and `RELEASE_NOTES_NEXT.md` to the maintainer
  unless asked.
- Docs for the product live at https://pinako.pro/docs/ (markdown twin:
  https://pinako.pro/docs/index.md) - prefer reading those over guessing
  product behavior from this repo's code.
