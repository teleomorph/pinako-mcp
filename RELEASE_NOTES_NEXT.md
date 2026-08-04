# Pinako AI Bridge — next release (draft)

> **Working draft.** Edit at release time, then paste into `gh release create vX.Y.Z --notes-file RELEASE_NOTES_NEXT.md` (or via the GitHub Releases UI). Reset this file to empty after the release ships.

> **Next version:** TBD (last shipped: v1.1.5 on 2026-08-02).

## What's new

- **The Bridge's local endpoint now requires an access token for write access.** Previously any program on your computer could connect to `127.0.0.1:37421` and drive the full tool surface — reading your tabs, libraries, and notes, and changing them. The installer now generates a machine-local token and writes it into each AI app's URL automatically, so a normal install or re-install needs nothing from you.

  **If you upgrade the Bridge without re-running the installer**, your existing AI apps keep working for reads, and write tools return a message asking you to re-run it. Re-running the installer restores full access. Hand-configured clients need the URL from the installer's final screen (or `%APPDATA%\Pinako\mcp-auth-token`) — treat it like a password. `rotate-token` regenerates it and rewrites every detected app's config.

- **The Bridge now refuses browser-originated requests** (any request carrying an `Origin` header, or addressed to a non-loopback hostname), closing a DNS-rebinding path that let a malicious web page reach the local endpoint.

- **The Bridge and its Claude Desktop shim now verify each other.** Before relaying your tab data to whatever process holds port 37421, they require proof it knows the shared token — so a program that squatted the port cannot harvest tree payloads or impersonate the Bridge.

- **Removed the `/debug` HTTP endpoint (security hardening).** It replayed the last 10 MCP requests, including write payloads and session ids, to any local caller. The same diagnostics remain available in `pinako-mcp.log`, which is protected by your user profile's file permissions.
- **Claude Desktop no longer shows "Could not attach to MCP server pinako" when no browser is running.** The `--stdio-mcp` shim now completes the MCP handshake and serves the full tool catalog locally, connects to the Bridge lazily per call, returns a clear "open your browser with the Pinako extension" message on tool calls made while no browser is up, and reconnects automatically (refreshing the client's tool list) the moment the Bridge comes back.
