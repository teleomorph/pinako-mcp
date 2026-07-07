# Pinako AI Bridge — next release (draft)

> **Working draft.** Edit at release time, then paste into `gh release create vX.Y.Z --notes-file RELEASE_NOTES_NEXT.md` (or via the GitHub Releases UI). Reset this file to empty after the release ships.

> **Next version:** v1.1.3 (last shipped: v1.1.2 on 2026-06-03).

## What's new

- **Modernized the packaged runtime.** The service binary, CLI installers, and GUI installer now embed **Node 24 LTS** (previously Node 18). The build pipeline moved from the archived `vercel/pkg` to its maintained fork **`@yao-pkg/pkg`** — the old packager is no longer maintained and is capped at Node 18. No feature changes; all five platform targets (Windows x64, macOS x64/arm64, Linux x64/arm64) build as before.
- **New `--diag` flag** on the service binary: prints runtime diagnostics (embedded Node version, packaged mode, core-module availability) and exits. Useful for verifying an installed build.
