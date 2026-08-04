# Pinako AI Bridge — next release (draft)

> **Working draft.** Edit at release time, then paste into `gh release create vX.Y.Z --notes-file RELEASE_NOTES_NEXT.md` (or via the GitHub Releases UI). Reset this file to empty after the release ships.

> **Next version:** TBD (last shipped: v1.1.5 on 2026-08-02).

## What's new

- **Claude Desktop no longer shows "Could not attach to MCP server pinako" when no browser is running.** The `--stdio-mcp` shim now completes the MCP handshake and serves the full tool catalog locally, connects to the Bridge lazily per call, returns a clear "open your browser with the Pinako extension" message on tool calls made while no browser is up, and reconnects automatically (refreshing the client's tool list) the moment the Bridge comes back.
