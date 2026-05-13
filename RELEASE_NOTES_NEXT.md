# Pinako AI Bridge — next release (draft)

> **Working draft.** Edit at release time, then paste into `gh release create vX.Y.Z --notes-file RELEASE_NOTES_NEXT.md` (or via the GitHub Releases UI). Reset this file to empty after the release ships.

> **Suggested version:** v1.3.0. The tool rename below is a breaking change for clients that hardcoded the old tool name or scope value. AI clients re-discover tools per session and will pick up the new names automatically; only hand-written scripts or test harnesses pinned to `get_global_notes` / `scope: 'global-notes'` need updating. Bump to v2.0.0 instead if you want a louder semver signal.

## What's new

### Multi-browser routing: sticky default + focus-shift re-prompt
The MCP server instructions now teach AI clients to behave like a human collaborator when you have Pinako running in multiple browsers:

- **Sticky default.** Once you've named a browser (either explicitly or by answering the ambiguity prompt), the AI reuses that browser for every subsequent call without re-asking.
- **Focus-shift re-prompt.** If a different browser's `updatedAt` becomes more recent than the sticky choice's, the AI asks once whether to switch, stay, or do both — then adopts your answer as the new default.
- **Explicit overrides** ("do it in Chrome instead", "in both browsers") win for that call; durable phrasing updates the default.

Previously the AI would either silently merge across browsers or re-ask which browser every single call. Both were wrong — this matches what you'd expect from a teammate.

### Terminology: "main tree notes" replaces "global notes" (breaking)
The MCP-facing terminology for the user's top-level notebook (notes attached to the main tab tree, not to a library) is now **main tree notes**. "Global notes" was internal codebase jargon that leaked into the agent surface; this rename keeps the AI's user-facing language aligned with the rest of the product.

What changed at the MCP boundary:

| Surface | Before | After |
|---|---|---|
| Tool name | `get_global_notes` | `get_main_tree_notes` |
| Response field | `globalNotes` | `mainTreeNotes` |
| Resource URI | `pinako://globalNotes` | `pinako://mainTreeNotes` |
| Scope value (`create_note`, `set_note_content`, `bulk_apply`) | `'global-notes'` | `'main-tree-notes'` |

**Breaking change.** Clients that hardcode the old names will get tool-not-found / unknown-scope errors. AI clients (Claude Code, Claude Desktop, Cursor, etc.) re-discover tools per session and pick up the new names automatically — no action needed for normal use. Custom scripts pinning the old names need updating.

The extension's internal wire format still uses `'global-notes'` for backward compatibility; the bridge translates at its boundary.

## Downloads (this release)

- **Linux x86_64** — `pinako-ai-bridge-cli-linux-x64`
- **Linux ARM64** — `pinako-ai-bridge-cli-linux-arm64`

The Windows GUI installer (`.exe`) is hosted at [pinako.pro/downloads](https://pinako.pro/downloads).

## Install

```bash
chmod +x pinako-ai-bridge-cli-linux-x64
./pinako-ai-bridge-cli-linux-x64
```

The installer auto-detects supported AI clients (Claude Code, Claude Desktop, Cursor, Windsurf, Cline, Roo Code, Continue.dev) and writes their MCP configs.

Setup guide: [pinako.pro/docs/ai-connect](https://pinako.pro/docs/ai-connect)
