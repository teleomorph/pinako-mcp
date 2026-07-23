# Pinako AI Bridge — next release (draft)

> **Working draft.** Edit at release time, then paste into `gh release create vX.Y.Z --notes-file RELEASE_NOTES_NEXT.md` (or via the GitHub Releases UI). Reset this file to empty after the release ships.

> **Next version:** v1.1.3 (last shipped: v1.1.2 on 2026-06-03).

## What's new

- **Fixed: Claude Code was never actually configured.** The installer wrote its MCP entry to `~/.claude/settings.json`, which Claude Code does not read for MCP servers (that file only holds approval flags). Every install since the bridge shipped registered a server Claude Code silently ignored. The installer now registers Pinako through `claude mcp add --scope user`, falling back to a direct write to `~/.claude.json` when the Claude Code CLI isn't on your PATH, and it clears the stale entry from `settings.json`. **If you use Claude Code, re-run the installer** to get a working connection.
- **Fixed: Antigravity configuration went to the wrong path.** Antigravity moved its global MCP config to `~/.gemini/config/mcp_config.json`; the installer was still writing the older per-tool location, so Pinako never appeared. Existing installs that still have the old file get both refreshed. Re-run the installer if you use Antigravity.
- **Modernized the packaged runtime.** The service binary, CLI installers, and GUI installer now embed **Node 24 LTS** (previously Node 18). The build pipeline moved from the archived `vercel/pkg` to its maintained fork **`@yao-pkg/pkg`** — the old packager is no longer maintained and is capped at Node 18. No feature changes; all five platform targets (Windows x64, macOS x64/arm64, Linux x64/arm64) build as before.
- **New `--diag` flag** on the service binary: prints runtime diagnostics (embedded Node version, packaged mode, core-module availability) and exits. Useful for verifying an installed build.
