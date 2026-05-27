# pinako-mcp/tests/chat — native chat dispatch tests

Tests for the **native AI chat surface** that ships in the Pinako extension
popup (Phase 4.4-B, on the `agentic-ai` branch). The chat surface dispatches
tool calls intra-extension via `chrome.runtime.sendMessage` rather than over
HTTP/MCP, so the standard MCP `Client` harness in `tests/` and `tests/tier2/`
does not apply.

This directory holds Phase 1 of the native-chat testing scaffold. Full
design context: [`../../../native-chat-testing-protocol.md`](../../../native-chat-testing-protocol.md).

## Tiers covered here

| Tier  | Layer | LLM | Chrome | Status |
|-------|-------|-----|--------|--------|
| 0     | Engine handlers (Mutative-free) | no  | no  | `Pinako/tests/mutation-engine.smoke.js` — 190 checks |
| 1a    | Dispatcher helpers (unit, mock globals) | no  | no  | deferred (requires pinako.js extraction or vm-context refactor) |
| **1b reads** | **Dispatcher IPC contract — reads** | **no** | **yes** | **`dispatch-tier1b-reads.js` — 15/15 passing** |
| **1b writes** | **Dispatcher IPC contract — writes (library-scoped)** | **no** | **yes** | **`dispatch-tier1b-writes.js` — 10/10 passing** |
| **1b shape opts** | **Composable lite-shape opt-in mechanics** | **no** | **yes** | **`dispatch-tier1b-reads-shape-opts.js` — 8/8 passing** |
| **1.5** | **Approval card UX (chat panel, ?test=1 hook)** | **no** | **yes** | **`dispatch-tier1.5-approval.js` — 18/18 passing** |
| **2 (proof)** | **LLM-driven — Haiku 4.5 via BYO Anthropic OAuth** | **yes** | **yes** | **`tier2/library-creation.proof.md` — passed 2026-05-19, re-verified 2026-05-20** |
| **2 (corpus)** | **LLM-driven — Haiku 4.5, 9-prompt corpus** | **yes** | **yes** | **`tier2/corpus-2026-05-20.md` — 6 validated (C1-C4, C7, C9) + 2 skeleton (C6, C8) + 1 skipped (C5, seeding gap)** |
| 2 (provider fan-out) | LLM-driven cross-provider | yes | mixed | deferred — `ai-todo.md#27` |

## Dispatch contract (validated 2026-05-19)

The chat panel (`chat.js`) → service worker → main popup (`pinako.js`) → broadcast back:

```
chat.js                          background.js (SW)              pinako.js (popup)
  |                                  |                                |
  |-- chatExecuteTool ------------>  |                                |
  |                                  |-- pinakoExecuteChatTool -----> |
  |                                  |                                | dispatches to
  |                                  |                                | _executeChatTool*
  |                                  |                                | or mutateTreeForAgent
  |                                  |                                |
  | <----------------------------- chatToolResult (broadcast) -----<- |
```

**Key constraint:** `chrome.runtime.sendMessage` does NOT deliver back to the
sender. Tests therefore cannot run inside the popup — they must send from the
SW (or any other extension page) so the popup's broadcast reaches the listener.
The bundle below runs from the SW.

Message shape:
- Input: `{action: 'pinakoExecuteChatTool', requestId, toolCallId, toolName, toolInput}`
- Output: broadcast `{action: 'chatToolResult', requestId, toolCallId, result}`

`result` is `{ok: true, ...}` on success or `{ok: false, error: {code, message}}` on failure.

## Prereqs

1. **Pinako extension installed** in the target Chrome instance. The bundle
   works against the DebugProfile (unpacked dev install id `cimkjmekadkdndcomocggdjlfaiedjcp`)
   or the Web Store install (`clakbccnkfpmpfooiiffomhknnfcodgd`) — `chrome.runtime`
   messaging is identical.
2. **Popup open** so the popup-side listener for `pinakoExecuteChatTool` is registered.
3. **Service worker awake.** MV3 SWs are killed after ~30s idle. Before each
   run, ensure a SW row is listed; if not, ping it from the popup with any
   `chrome.runtime.sendMessage` (the bundle below assumes a live SW).

## How to run via chrome-devtools-mcp

1. `mcp__chrome-devtools__list_pages` — confirm a `chrome-extension://*/pinako.html`
   page exists. If not: `mcp__chrome-devtools__trigger_extension_action` with
   the extension id.
2. If no Service Worker row: `mcp__chrome-devtools__select_page` to the popup,
   then `evaluate_script` with `chrome.runtime.sendMessage({action:'__wake_sw'}).catch(()=>{})`.
   Re-list pages to get the new `sw-*` id.
3. `mcp__chrome-devtools__evaluate_script` with `serviceWorkerId: '<sw-id>'`
   and the contents of `dispatch-tier1b-reads.js` wrapped as:
   ```js
   async () => {
     // ... paste the full file body here, then:
     return await runTier1bReads();
   }
   ```
   Returns `{passed, failed, results}` where `results[]` is `{name, ok, sample?, error?}`.

A reference run on the DebugProfile (2026-05-19, 489 tree nodes, 362 libraries):
- **15 passed / 0 failed** across get_tree, get_tree_summary, list_libraries,
  get_main_tree_notes, get_bookmarks, search_tabs, find_duplicates (positive + INVALID_SCOPE),
  search_pinako (4 variants), get_library negative, search_docs, UNKNOWN_TOOL.

## What this tier catches

- IPC contract regressions (SW → popup → broadcast).
- Envelope shape drift (e.g. response keys, error codes).
- Tool routing in the switch at `pinako.js:56277` (Phase 4.4-B commit 1).
- Dispatcher error handling (`UNKNOWN_TOOL`, exception → `TOOL_EXEC_ERROR`).

## What this tier does NOT catch

- Tool-description quality (Tier 2; needs an LLM driving choices).
- Approval card UX flow (Tier 1.5; needs the chat panel UI running and synthetic destructive dispatches).
- Multi-round agent orchestration in chat.js (Tier 2 Path B).
- Provider-side SSE normalization in the chat-completion EF (Tier 2).

## Surface mapped on first run (verified envelope shapes)

| Tool                       | Success keys                                    | Failure codes seen |
|----------------------------|-------------------------------------------------|--------------------|
| `get_tree`                 | `ok, tree[], count`                             | -                  |
| `get_tree_summary`         | `ok, counts.{nodes,url_bearing_nodes}, depth.max, topDomains[], sampleTitles[]` | -                  |
| `list_libraries`           | `ok, libraries[]`                               | -                  |
| `get_library`              | `ok, library{children[],notes[]}` (success)     | `LIBRARY_NOT_FOUND` |
| `get_main_tree_notes`      | `ok, scope, mainTreeNotes[], count`             | -                  |
| `get_bookmarks`            | `ok, count, ...`                                | -                  |
| `search_tabs`              | `ok, results[], count`                          | -                  |
| `find_duplicates`          | `ok, ...`                                       | `INVALID_SCOPE`    |
| `search_pinako`            | `ok, results[], count, truncated`               | `EMPTY_QUERY`, `LIBRARY_ID_REQUIRED`, `LIBRARY_NOT_FOUND` |
| `search_docs`              | `ok, results[], count`                          | -                  |
| (unknown tool)             | -                                               | `UNKNOWN_TOOL`     |

`find_duplicates` requires `scope` (one of `tree | bookmarks | library | cross-scope`);
empty input rejects. `get_main_tree_notes` returns its array under `mainTreeNotes`,
not `notes` — distinct from the MCP tool's `main_tree_notes_response` shape.

## Write surface (dispatch-tier1b-writes.js)

Exercises `_executeChatToolWrite` (pinako.js:17969), which is a 15-line wrapper:
`{type: toolName, ...input}` → `mutateTreeForAgent(op, undefined, 'chat')` →
shape errors. Engine handlers do all real work and are Tier-0-covered; this tier
proves the dispatch wrapper itself is wired correctly.

**Scope: library-scoped writes only.** The bundle creates a `pinako-chat-test-*`
library_group + library + note, runs writes against them, then cascade-deletes
the group. No main-tree mutations against real user data.

| Test                                              | Behavior proven |
|---------------------------------------------------|-----------------|
| Setup chain: `create_library_group` → `create_library` → `add_library_to_group` | wrapper routes create ops, engine meta (`createdGroupId`, `createdLibraryId`) returns through envelope |
| `set_library_title` + read-back via `list_libraries` | rename persists, `_executeChatToolListLibraries` sees the new title |
| `set_library_description` | description mutates cleanly |
| `create_note` (`scope:'library-notes'`) | `createdNoteId` returned |
| `set_note_content` mode=`replace` + read-back via `get_library` `include_note_content:true` | content persists; lite-shape default strips it (see contract notes below) |
| `delete_library` without `confirmedByUser` | engine `.refine()` gate rejects with `INVALID_OP_SHAPE`; library survives |
| `bulk_apply` 2 library sub-ops | atomic composite ok; engine `subResults` shows per-op pass |
| Cleanup: `delete_library_group` `cascadeMembers:true, confirmedByUser:true` | cascadedLibraryIds populated; no orphans |

### Engine contracts to know when authoring more write tests

- **`get_library` returns notes WITHOUT `content`** unless `include_note_content: true`
  is passed (pinako.js:17682, 17692-17694). Lite shape — notes can be up to 500K
  chars at Enterprise tier. Always pass the flag in verification reads.
- **`get_main_tree_notes` defaults to `include_content: true`** (the *opposite*
  default). Asymmetric per pinako.js:17702 ("user is likely asking ABOUT the
  notes"). Codified, not a bug.
- **`bulk_apply` at library scope needs BOTH envelope fields:** `scope: 'library-list'`
  AND `libraryId: <single library id>`. Sub-op `libraryId`s must all match the
  envelope's `libraryId`. One library per bulk; rejects with
  `BULK_SCOPE_MISMATCH` (no scope) or `BULK_LIBRARY_MISMATCH` (no/wrong libraryId).
- **Destructive ops are gated at the engine schema layer** (Zod `.refine()`),
  not at the wrapper. Skipping `confirmedByUser:true` surfaces as
  `INVALID_OP_SHAPE` with the field path in `issues[].path`. The wrapper
  faithfully proxies the Zod error through to the chat envelope.

## Composable shape opts surface (dispatch-tier1b-reads-shape-opts.js)

Added 2026-05-20 to cover the `_extractShapeOptsForChat` helper introduced
in commit `0301be8` and the ghost-filter recursion fix in `f147a88`.
Mirrors MCP's identical surface (`e3c61bd`). Three chat read tools accept
the opts: `get_tree`, `get_library`, and `list_libraries` (the last only
when `include_tabs:true`).

The lite-node shape was previously fixed; it's now composable per-field:

| Opt | Default | Effect when overridden |
|-----|---------|------------------------|
| `minimal`                   | `false` | when `true`, strips ALL optional fields → `{id, type, title, url, ghost, children}` only |
| `include_opened_date`       | `true`  | drop `openedDate` |
| `include_tags`              | `true`  | drop `tags[]` |
| `include_memos`             | `true`  | drop `memoText` |
| `include_lineage`           | `true`  | drop `parentWindow` / `parentGroup` / `collapsed` |
| `include_chrome_tab_groups` | `true`  | drop `chromeGroupId` / `chromeGroupTitle` / `chromeGroupColor` on tab nodes (Pinako Group nodes always returned regardless) |
| `include_star_color`        | `true`  | drop `starColor` |
| `include_row_color`         | `true`  | drop `rowColor` |
| `include_custom_title`      | `true`  | drop `customTitle` |
| `include_favicons`          | `false` | when `true`, include `favIconUrl` on tab nodes that have one |
| `include_ghost_tabs`        | `true`  | when `false`, filter ghost tabs **at any depth** (per `f147a88` fix) |

| Test                                              | Behavior proven |
|---------------------------------------------------|-----------------|
| `get_tree({minimal:true})` | every node has only `{id, type, title, url, ghost, children}` keys — strict basics-set; 0 violators |
| `get_tree({include_tags:false})` | tags absent on previously-tagged node + no `tags` key anywhere in the tree |
| `get_tree({include_memos:false})` | `memoText` absent on previously-memoed node + zero leaks |
| `get_tree({include_lineage:false})` | `collapsed` / `parentWindow` / `parentGroup` absent everywhere |
| `get_tree({include_star_color:false})` | `starColor` absent on previously-starred node + zero leaks |
| `get_tree({include_favicons:true})` | default has zero `favIconUrl`s; opt-in surfaces at least one |
| `get_tree({include_ghost_tabs:false})` | zero ghost tabs at any depth (regression-verification for `f147a88` chat ghost-filter recursion fix) |
| `get_library({minimal:true})` | library children's keys are strict subset of basics-set |

Per-turn `getChatContext` handler at `Pinako/pinako.js` now routes through
the shared `_liteNodeForChat` helper with `{truncate:true,
include_star_color:false, include_row_color:false, include_custom_title:false}`
(see commits `0301be8` and `e00b5e1`). Pre-2026-05-19, the per-turn handler
had an inline `liteNode` builder; now it's a config of the shared helper —
same shape, less duplication.

### Tests deliberately NOT in this bundle

- **`include_chrome_tab_groups:false`** behavior — DebugProfile state had
  no live tabs with chrome tab group membership at test time. The opt
  is wired (verified in code) but the test would skip without test data.
  Future: build a fixture chain that adds a tab to a Chrome tab group,
  then assert the strip.

## Approval card UX surface (dispatch-tier1.5-approval.js)

The chat panel renders an inline approval card whenever the model emits a
destructive tool call (or a `bulk_apply` containing destructive sub-ops).
The card is the *user-side* safety gate; the Zod engine gate is defense-
in-depth behind it. Phase 4.4-B commits 4 + 5 own this code.

Activated via a tiny `?test=1`-gated hook at the end of `Pinako/chat.js`
that exposes the IIFE's internals on `window.__chatTest`. The hook is
inert in normal opens; the runtime check is one URLSearchParams call.

| Test                                                          | Behavior proven |
|---------------------------------------------------------------|-----------------|
| `isToolCallDestructive` flags `delete_library`, `delete_node`, `delete_note`, `delete_live_node` | DESTRUCTIVE_TOOL_NAMES set matches the canonical destructive surface |
| `isToolCallDestructive('delete_library_group', {cascadeMembers: true|false})` | cascade gate is the toggle: non-cascade is NOT destructive (members disperse into panelOrder) |
| `isToolCallDestructive('set_title', ...)` | non-destructive ops return false |
| `isToolCallDestructive('bulk_apply', ...)` with no destructive sub-ops | false |
| `isToolCallDestructive('bulk_apply', ...)` with a destructive sub-op | true (recursive defense-in-depth at chat.js:129-136; dormant in practice — partition logic catches bulk_apply earlier) |
| `_buildApprovedInputsByParent` top-level | `confirmedByUser:true` injected at root; original parsed input NOT mutated (deep-clone) |
| `_buildApprovedInputsByParent` bulk_apply with destructive sub-op | `confirmedByUser:true` ONLY on the sub-op; envelope unmodified; original deep-clone preserved |
| `_buildApprovedInputsByParent` bulk_apply multi-destructive | each destructive sub-op flagged independently; non-destructive sub-ops untouched |
| `_renderApprovalCard` single destructive op | DOM has `.chat-approval-card.awaiting`, Approve button, Deny button, auto-approve checkbox, lists tool name |
| `_renderApprovalCard` bulk_apply multi-destructive | ONE consolidated card with ONE Approve + ONE Deny + lists every destructive sub-op |
| Approve click | dispatches `chatExecuteTool` with `toolInput.confirmedByUser:true`; card → `.approved` |
| Deny click | synthesizes `USER_DENIED` into `activeRequest.pendingResults`; card → `.denied`; no continuation fires when `pendingResults.size < toolCalls.length` |
| Auto-approve checkbox + Approve | `sessionAutoApprove` flips to true |
| Auto-approve checkbox + Deny | `sessionAutoApprove` stays false (intentional per chat.js comment: denying suggests user isn't ready to grant blanket trust) |

### The `?test=1` hook

Added at the tail of `Pinako/chat.js`'s IIFE. Inert in normal opens; the only
runtime cost is a single `URLSearchParams.has('test')` check at init. Exposes:
- State accessors: `getActiveRequest` / `setActiveRequest` /
  `getSessionAutoApprove` / `setSessionAutoApprove` / `getConversation`
- Helpers: `isToolCallDestructive`, `_parseToolInputSafe`,
  `_handleRoundEndWithTools`, `_renderToolCallCard`, `_renderApprovalCard`,
  `_buildApprovedInputsByParent`, `_dispatchToolCall`
- DOM: `els`

The frozen object guarantees the test surface can't be mutated by anything
on the page (defense against test cross-contamination across check blocks).

## Tier 2 (helpers/ + tier2/)

LLM-driven multi-round agent tests. Drives a real Anthropic / Grok / Gemini
model through the chat-completion EF, dispatches the model's tool calls
against the live extension via chrome-devtools-mcp, asserts on tool
sequence + final state. Native-chat analog of MCP's `tests/tier2/` but
without the Claude Agent SDK — the EF is the entry point and provider fan-
out is the whole point.

### Architecture

Three pieces, separable so each can be re-used or replaced independently:

| Piece | Role |
|-------|------|
| `helpers/chat-completion-runner.mjs` | Node module + CLI. ONE EF round per call: POST → SSE parse → returns `{finalText, toolCalls, usage, error?}`. Single-round by design so the caller owns the multi-round loop (tool dispatch is intrinsically out-of-process, faking it inside would just hide the seam). |
| `helpers/capture-credentials.js` | Paste-into-SW JS snippet via `evaluate_script`. Reads JWT + apikey + BYO tokens from `chrome.storage.local`. Returns tier + JWT expiry so the orchestrator can fail fast on stale/missing creds. |
| `helpers/dispatch-tool-call.js` | Paste-into-SW JS snippet. Tier 1b's send-and-wait pattern with caller-supplied `requestId` + `toolCallId` so the orchestrator can pass the model's actual ids through verbatim — that matters for asserting on the assistant turn ↔ tool result pairing. |

### Tier 2 round flow

Each round of an agent-driven test does:

1. **Node** → POST `chatMessage` to chat-completion EF with the current
   conversation, JWT, BYO token, treeContext, model.
2. **EF** streams SSE; `postChatRound` accumulates `tool_call_delta`
   envelopes by index into `[{id,name,argumentsRaw}]`, captures text and
   usage, terminates on `done`.
3. **Node** returns `{finalText, toolCalls, usage}` to the orchestrator.
4. **Orchestrator** (today: human or Claude) for each toolCall: dispatch via
   chrome-devtools-mcp `evaluate_script` calling `dispatchChatTool({...})`
   in the SW context; capture the `chatToolResult` envelope.
5. **Orchestrator** builds the next round's `messages` via
   `buildContinuationMessages(prev, roundResult, toolResultsById)` — mirrors
   chat.js's `_handleChatToolResult` shape (assistant turn with tool_calls,
   tool turns in index order).
6. Loop until `toolCalls.length === 0` or maxTurns hit.

The Phase 2 (deferred) upgrade is a `chrome-remote-interface`-based
dispatcher inside the runner so the whole loop runs in one Node process
unattended (vitest, CI, etc.). For now manual orchestration via this
transcript / chrome-devtools-mcp is the working pattern — see
[`tier2/library-creation.proof.md`](tier2/library-creation.proof.md) for
the step-by-step.

### What the 2026-05-19 proof established

First end-to-end run of `tier2/library-creation.proof.md`:

- **3 rounds, ~6.9s total LLM wall time.** Round 1: `create_library` (1 call,
  2.8s). Round 2: `add_library_to_group` + `create_note` in parallel (2 calls,
  2.6s). Round 3: terminal DONE marker, no tool calls, 1.5s.
- **Token usage:** ~75K input + ~380 output tokens across all 3 rounds.
  Computed cost ~$0.08 Haiku 4.5 (Anthropic doesn't populate `costUsdTicks`;
  computed manually).
- **Anthropic OAuth via the EF Bearer proxy works** for the
  `sk-ant-oat01-...` token, against `claude-haiku-4-5-20251001`. The
  closed-as-not-planned issue on `anthropics/claude-code#37205` may not
  reflect current behavior for proxied requests, or there's a carve-out for
  single-developer use. Verify on each session — Anthropic policy is moving.
- **Tool-call accumulation contract holds.** Round 2 emitted 42
  `tool_call_delta` envelopes for 2 tool calls (~21 deltas per call);
  accumulator by `delta.index` produced clean tool inputs.
- **Multi-call round dispatch works.** Round 2's two parallel calls
  dispatched cleanly via `Promise.all` from one `evaluate_script` — engine
  serialized them under the hood.
- **All three final-state assertions passed:** library exists with title,
  note exists in library with title, library is member of test group.
  Cleanup cascade-deleted the test group; `cascadedLibraryIds` returned the
  agent-created library id.
- **One finding logged:** Haiku 4.5 entity-escapes HTML content args
  (`<p>` → `&lt;p&gt;`) — fix shipped in `d22d751`; tracked in
  `docs-archive/agentic-ai-pre-ship-fixes.md#12` (archived 2026-05-23;
  summary in `ai-resolved.md`).

### Adding a new Tier 2 test

1. Drop a markdown runbook under `tier2/<scenario>.proof.md` that documents
   the prompt, expected tool sequence, assertions, and cleanup. The runbook
   IS the test until Phase 2 automates it.
2. Use `helpers/chat-completion-runner.mjs` for each round via the
   `--stdin-json` CLI or `import { postChatRound }`.
3. Use `helpers/dispatch-tool-call.js` (or inline a copy of the
   dispatch pattern) via `evaluate_script` for each tool call. Pass through
   the model's actual `tc.id` as `toolCallId`.
4. Use `helpers/capture-credentials.js` once per session to grab JWT + BYO
   token. Refresh if `secondsUntilExpiry < 300`.
5. Wrap test artifacts in a `pinako-chat-test-` prefix and a library group;
   cascade-delete on completion (same convention as Tier 1b writes).
6. After running, route non-trivial findings per the four paths in
   `feedback_native-chat-findings-routing.md` memory: fix inline /
   ship-block → `ai-todo.md` (P0 band) / non-blocking → `ai-todo.md`
   (P1/P2/P3 band by severity) / ask in chat. (The former
   `native-chat-test-findings.md`, `agentic-ai-pre-ship-fixes.md`, and
   `agentic-ai-followups.md` were retired 2026-05-23; the pre-ship
   archive lives at `docs-archive/agentic-ai-pre-ship-fixes.md`.)

### Cost expectation per Tier 2 proof run

~$0.05-0.15 of computed Haiku 4.5 cost on a 3-round task. Against Max OAuth
quota, draws from the carve-out (no API charges through ~2026-06-15 per the
protocol's research log; confirm on the dashboard if running daily).

## Follow-ups (not in scope for Phase 1)

- Write-tool dispatch tests. Requires the test-artifact prefix cleanup pattern
  (cascade-delete via `delete_library_group` or direct `delete_library`),
  matching the MCP Tier 1 convention.
- Bulk_apply dispatch tests with the inline approval card mediation (Tier 1.5).
- Programmatic SW wake helper (instead of the manual ping-from-popup step).
- Vitest wrapper that drives chrome-devtools-mcp programmatically (would
  enable CI). Out of scope for Phase 1 per the protocol.

## Related

- [`../README.md`](../README.md) — Tier 1 (MCP, HTTP transport).
- [`../tier2/README.md`](../tier2/README.md) — Tier 2 MCP (Claude Agent SDK + OAuth).
- [`../../../native-chat-testing-protocol.md`](../../../native-chat-testing-protocol.md) — full design doc, invocation protocol, deferred work.
- [`../../../agentic-ai-reference.md`](../../../agentic-ai-reference.md) — engine smoke-test pattern (Tier 0), MCP testing workflow.
