## What's new

- **AI clients can now move an item from one Library into another in a single step.** The new `move_node_to_library` tool takes a node and everything nested under it out of one Library and puts it into another. Both Libraries change together, so the item is never sitting in two Libraries or in neither, and one undo puts it back. Previously an AI client could only move things around inside a single Library, so a cross-Library move meant copying and then deleting.

Housekeeping: added an `AGENTS.md` entry point for AI coding agents working on this repo, removed an unused helper, and brought `package-lock.json` back in sync with the released version.
