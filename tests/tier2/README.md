# pinako-mcp Tier 2 tests

LLM-driven workflow tests. The harness drives a real Claude agent loop via
the Claude Agent SDK against the live host.js MCP endpoint, then asserts on
both the tool sequence the agent picked AND the resulting state via Tier 1
read tools.

Tier 1 (`tests/*.test.js`) verifies "the protocol works." Tier 2 verifies
"the agent makes the right tool choices."

## Prereqs

### 1. OAuth token from your Max plan

Generate once interactively (cannot be automated — requires browser auth):

```
claude setup-token
```

Save the printed `sk-ant-oat01-...` token somewhere safe. You pass it via
the `CLAUDE_CODE_OAUTH_TOKEN` env var when running tests. The Agent SDK
uses this token to bill against your Max plan quota instead of API credits.

> **Calendar note (2026-06-15):** after that date, Agent SDK runs draw
> from a separate "Agent SDK credit" pool on the Max plan — still no API
> charges, but capped independently from interactive Claude usage. If
> today is past that date, ensure the credit pool is provisioned on your
> account.

### 2. `ANTHROPIC_API_KEY` MUST NOT be set in your shell

The SDK prefers `ANTHROPIC_API_KEY` over the OAuth token, which would
route to API billing. The harness fails loudly if both are set; you can
also verify manually:

```powershell
echo $env:ANTHROPIC_API_KEY   # PowerShell — should print blank
```

If it has a value, unset it:

```powershell
Remove-Item Env:ANTHROPIC_API_KEY
```

### 3. Pinako extension popup open in main Chrome

Same prereq as Tier 1. The MCP write tools dispatch through native
messaging to the extension, so the popup must be running. Harness
defaults to `PINAKO_TEST_BROWSER=Chrome`; main Chrome holds test data
and is the safe-to-mutate target.

### 4. host.js running

Confirm with `Get-Process node` and look for `pinako-mcp/host.js`, or
`curl http://127.0.0.1:37421/mcp` for a 4xx (normal for non-handshake GET).

## Run

```powershell
$env:CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-oat01-..."
npx vitest run tests/tier2/
```

Or from the project root:

```powershell
$env:CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-oat01-..."
cd pinako-mcp
npx vitest run tests/tier2/
```

The proof test takes ~30-90s end-to-end (agent latency + ~1-2s cache
propagation lag per write). Per-test timeout is 180s.

## Defaults

- **Model:** `claude-haiku-4-5-20251001` — fast and cheap for multi-tool
  chains. Escalate to Sonnet only if a specific test needs frontier
  reasoning that Haiku can't handle.
- **MCP endpoint:** `http://127.0.0.1:37421/mcp` (streamable HTTP). Override
  per-call via `runAgent({mcpUrl})`.
- **Permission mode:** `bypassPermissions` — auto-approves every tool call
  so the loop doesn't hang waiting for confirmation.
- **`allowedTools`:** the SDK uses this for *auto-approval*, NOT for surface
  restriction. With `bypassPermissions` set, the agent can call any MCP
  tool the connected server exposes regardless of what's in the list. We
  pass it for documentation value (what each test expects the agent to
  use) and as belt-and-suspenders, but tests should not assume tools
  *outside* the list are unavailable. Empirically observed in the
  search-and-summarize test where the agent called `list_browsers` despite
  it being absent from `allowedTools`.

## Pattern: add a new Tier 2 test

1. Pick a workflow you want to verify the agent can execute (e.g.
   "rename a node," "find duplicates and tag them," "import bookmarks
   into a new library").

2. Build setup with the Tier 1 client (direct MCP calls) — create a
   `library_group` to scope artifacts and cascade-delete in `afterAll`.

3. Write a clear, numbered prompt. Pass `browser`, any required ids, and
   exact titles. Tier 2 prompts should test agent *tool choice*, not
   creative interpretation — keep them unambiguous.

4. Set `allowedTools` to the minimum Pinako tools you expect — this is
   documentation, not enforcement. Built-in Read/Write/Bash don't appear
   because no `executable: 'sdk'` tools are enabled by default; the
   agent's tool set is just the MCP server's catalog. If a test needs to
   forbid specific MCP tools, use `disallowedTools` instead.

5. Assert on:
   - `run.systemInit.mcpServers` contains `pinako` with `status: 'connected'`
   - `run.toolCalls` includes the expected tool names (using
     `toolCallsByName`)
   - `tc.resultIsError === false` for every call
   - Final state via Tier 1 reads, wrapped in `waitFor` to handle the
     ~1-2s cache propagation lag

6. Set `TEST_TIMEOUT_MS` to ~180s per test. Agent runs are slow.

## Helpers

`helpers/agent-runner.js`:
- `runAgent({prompt, allowedTools, model?, maxTurns?, systemPrompt?})`
  → `{transcript, toolCalls, finalText, durationMs, systemInit, usage,
  totalCostUsd, subtype}`
- `toolCallsByName(toolCalls, name)` — filter to one tool
- `tryParseJsonResult(text)` — parse a tool's response text without throwing
- Auth guard rejects runs if `CLAUDE_CODE_OAUTH_TOKEN` is missing or if
  `ANTHROPIC_API_KEY` is also set (avoids accidental API billing).

Tier 1 helpers are reused from `../helpers/`:
- `connectPinakoMcp()` for setup/assertion MCP client
- `callToolOk()` for setup/assertion writes/reads
- `waitFor()` for cache-propagation polling
- `resolveTargetBrowser()` for browser name
- `testLabel()` for `pinako-mcp-test-` prefixed titles

## Pitfalls (from real Tier 2 experience)

- **The agent is non-deterministic.** Haiku 4.5 may pick a different
  tool order on different runs even with the same prompt. If a prompt
  is ambiguous about which tools to call (e.g. "analyze the open
  tabs" could be either `get_tree_summary` or `search_tabs`), expect
  flakes. Either spell out the tool sequence in the prompt, or soften
  assertions to accept the alternatives.
- **Specify the browser explicitly in prompts.** Otherwise the agent
  may burn a turn on `list_browsers` and sometimes stops short of
  the actual task. The harness already resolves `browser` in
  `beforeAll`; thread it into the prompt.
- **Library children vs library notes.** `get_library` returns BOTH
  in its response (`children[]` for tree nodes, `notes[]` for
  library-scope notes). `add_to_library` only accepts tree nodes; if
  the agent passes note ids in `nodeIds`, the bridge returns
  `SOURCE_NODE_NOT_FOUND`. Real description-quality gap; until
  resolved, design tests that don't put the agent in this position.
- **Diagnostic log before assertions.** When a tier 2 test fails,
  the most useful info is what the agent *actually* did. Add a
  `console.log` dumping `run.toolCalls` before any `expect`s, so
  every run produces a tool-sequence record.

## Known gaps

- No multi-browser fan-out — single `PINAKO_TEST_BROWSER` target per run.
- No LLM-judge eval — assertions are deterministic (tool name + final
  state). Quality grading of agent reasoning is out of scope.
- Tool-cap / tier-aware tests deferred until `list_browsers` exposes
  `subscriptionTier` (see `docs-archive/agentic-ai-pre-ship-fixes.md` #5
  — now shipped; summary in `ai-resolved.md`).

## Cost / quota

The proof test runs at ~$0.15-0.20 of *computed* cost per Haiku 4.5 run
(reported by `run.totalCostUsd`). That number is what the call would
cost on the API; on Max plan OAuth the request still routes through
the bearer token and draws from Max plan quota, not API credits.

How to confirm you're on Max plan:

1. `ANTHROPIC_API_KEY` is unset (the harness blocks the run otherwise).
2. `CLAUDE_CODE_OAUTH_TOKEN` is set.
3. Cross-check on your Max plan dashboard — quota should decrement,
   API usage should not.

After 2026-06-15, Agent SDK runs draw from a separate "Agent SDK
credit" pool. Same OAuth flow, different quota bucket — confirm the
bucket is provisioned on your account before the cutover if you plan
to run Tier 2 regularly.
