# pinako-mcp tests

End-to-end MCP round-trip tests. The harness opens a real `@modelcontextprotocol/sdk`
client against the live host.js HTTP endpoint at `http://127.0.0.1:37421/mcp`,
calls write tools, then verifies via the matching read tools.

This is Tier 1 of the testing plan: deterministic protocol-level tests, no LLM
in the loop. Tier 2 (LLM-driven workflow tests via Claude Code Max) is planned
separately.

## Prereqs

1. **Pinako extension running in a browser** with an active native-messaging
   connection to host.js. The harness defaults to targeting Chrome (the
   `PINAKO_TEST_BROWSER` env var, defaults to `"Chrome"`); main Chrome holds
   test data, so it is the safe target. Override with
   `PINAKO_TEST_BROWSER=Brave` etc. if you want a different connected install.
2. **host.js running.** Confirm with `Get-Process node` and look for
   `pinako-mcp/host.js` in the command line, or `curl http://127.0.0.1:37421/mcp`
   for a 4xx (which is normal for a non-handshake GET).
3. **Node 18+** and the deps installed (`npm install` in this folder).

## Run

```
npm test           # one-shot
npm run test:watch # vitest watch mode
```

Tests run sequentially in a single fork (see `vitest.config.js`) to avoid races
on the shared MCP server cache.

## Cleanup pattern

Pinako does NOT expose an MCP `delete_library` tool today, so each test file
wraps its libraries in a single test group and cascade-deletes the group in
`afterAll`:

```
create_library_group → push groupId
  create_library → add_library_to_group
  ... test body ...
afterAll: delete_library_group({groupId, cascadeMembers: true, confirmedByUser: true})
```

If a test crashes before `afterAll` runs (or `delete_library_group` itself
fails), artifacts persist under the `pinako-mcp-test-` title prefix. Sweep
them manually via the Pinako UI or by running the suite again.

## Cache-propagation timing

MCP write tools return `ok` as soon as host.js dispatches the edit to the
extension over native messaging. The extension applies the edit and pushes
updated state back to host.js ~1-2s later (per the server's `FRESHNESS_HINT`).
Reads that immediately follow a write may see stale data.

Use `waitFor(predicate, { timeout, label })` from
`helpers/mcp-client.js` to poll the read until the expected condition holds.
Default timeout 8s, interval 200ms.

```js
const tagged = await waitFor(async () => {
  const node = await findNodeInLibrary(nodeId);
  return node?.tags?.includes('alpha') ? node : null;
}, { label: 'set_tags-applied' });
```

Creates and additions are visible immediately by id lookup (the bridge knows
the id it returned). Modifications to existing entities (tags, note content,
titles) require the poll.

## What's covered

| Tool | File | Notes |
|------|------|-------|
| `create_library` | `library.test.js` | + seed-note assertion via `get_library` |
| `add_to_library` | `library.test.js` | library-to-library clone via `sourceScope: 'library'` |
| `create_note` | `notes.test.js` | library-notes scope |
| `set_note_content` | `notes.test.js` | replace + append modes |
| `set_tags` / `add_tags` / `remove_tags` | `tagging.test.js` | library-scope tagging on a group node |

## Known limitations

- **No `delete_library` / `delete_note` MCP tools.** Tests can't directly
  remove the library or main-tree notes they create. Cleanup relies on the
  group-cascade pattern above for library-scoped artifacts. Main-tree notes
  and main-tree node mutations are deliberately not tested here to avoid
  accumulating orphans.
- **Single-browser scope.** Tests target one connected browser at a time
  (`PINAKO_TEST_BROWSER`). Multi-browser routing is exercised by the
  `browser` arg but the harness doesn't fan out across browsers.
- **No visual verification.** This tier asserts via Pinako's own read tools.
  For UI-level checks (panel rendering, tree refresh, sync indicator),
  chrome-devtools-mcp on main Chrome is the appropriate tool — that pattern
  is Tier 1.5, not yet scaffolded.

## Adding a test

1. Pick a write tool whose effect is observable via a read tool.
2. Create the test file in `tests/` (`*.test.js`).
3. Use `beforeAll` to open a session, resolve the browser, and create a
   test group + library.
4. Use `afterAll` to cascade-delete the group.
5. For modifications to existing entities, wrap the read in `waitFor`.
6. Run with `npm test`; iterate on response shapes if needed
   (write tools return `{ok, result: {...}, op, scope, libraryId, ...}` —
   the per-op result lives under `.result`).
