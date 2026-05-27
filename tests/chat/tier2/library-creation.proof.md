# Tier 2 proof — library creation flow

First end-to-end verification that the native-chat Tier 2 path works:
real Anthropic Haiku 4.5 → chat-completion EF → SSE normalization →
tool dispatch against the live Pinako extension → multi-round
continuation → final state assertion → cleanup.

This is the native-chat analog of MCP's
`pinako-mcp/tests/tier2/library-creation.test.js`. Key difference:
no Claude Agent SDK, no MCP transport — we drive the EF directly.

## Why orchestrated instead of vitest

The runner (`helpers/chat-completion-runner.mjs`) is a single-round
Node module. Tool dispatch happens via chrome-devtools-mcp into the
extension SW (same pattern as Tier 1b reads/writes). chrome-devtools-mcp
is a stdio MCP server, not a Node library — vitest can't call it.

For the proof: a human (or the agent running this transcript) is the
loop. Each round:
  1. Node → EF → SSE → `{toolCalls, finalText, usage}`
  2. For each toolCall: chrome-devtools-mcp → SW dispatch → `{ok, ...}`
  3. Build continuation messages
  4. Repeat (or stop if no toolCalls)

Phase 2 of native-chat testing (deferred) wraps this in a
`chrome-remote-interface`-based dispatcher so a single Node process
owns the loop and the test can run unattended (vitest, CI, etc.).

## Prereqs

1. **DebugProfile signed into Pinako** with a Pro tier 1+ Supabase
   account. Verify via the popup: tier chip should show "Pro" or higher.
2. **BYO Anthropic token configured** in DebugProfile (AI Settings →
   Anthropic card → paste an `sk-ant-oat01-...` OAuth token or
   `sk-ant-api...` workspace key).
3. **Pinako popup open** in DebugProfile so the popup-side listener for
   `pinakoExecuteChatTool` is registered.
4. **chrome-devtools-mcp connected** to DebugProfile (the existing
   chrome-devtools-mcp launcher; same setup as Tier 1b harness).
5. **Service worker awake.** Use `list_pages`; if no `sw-*` row, wake it
   by sending any `chrome.runtime.sendMessage` from the popup context.

## Steps (orchestrator)

### 1. Capture credentials

Paste `helpers/capture-credentials.js`'s body into evaluate_script
against the SW. Returns `{jwt, apikey, anthropicToken, tier,
tokenStillFresh, ...}`. Verify `tier >= 1` and `tokenStillFresh`
before proceeding.

If `tokenStillFresh` is false, the JWT will expire mid-test —
re-open the popup (the auth refresh fires on popup open) and
re-capture.

### 2. Setup — create a test library group via Tier 1b dispatch

Use `helpers/dispatch-tool-call.js` (NOT the LLM yet) to create:

```
toolName: 'create_library_group'
toolInput: { title: 'pinako-chat-test-tier2-<stamp>', description: 'Tier 2 proof' }
```

Save the returned `result.createdGroupId` as `testGroupId`.

Test artifact prefix `pinako-chat-test-` matches Tier 1b writes
convention (`README.md` section "Write surface"). Cascade-delete in
step 7 cleans up.

### 3. Build the initial user message

```
prompt = `Create a new Pinako library titled "pinako-chat-test-lib-${stamp}",
add it to the library group with id "${testGroupId}", then create a note
inside that library titled "pinako-chat-test-note-${stamp}" with HTML
content "<p>Tier 2 proof note body.</p>". When all three steps succeed,
reply with one line: DONE library=<libraryId> note=<noteId>`
```

Wrapping the prompt to test for tool sequence + final marker line. The
DONE-line convention is inherited from MCP Tier 2's proof prompt; it
gives the assertion path a clean signal that the agent thinks it
succeeded.

### 4. Build the EF request body

```js
const conversation = [{ role: 'user', content: prompt }];
const reqArgs = {
  ef: { url: 'https://skhzrroqdoekyzgmcdhz.supabase.co/functions/v1/chat-completion',
        jwt, apikey },
  model: 'anthropic-haiku-4-5',
  byoAnthropicToken: anthropicToken,
  systemPrompt: <PinakoChatSystemPrompt.PROMPT — capture via evaluate_script
                 against the popup, OR import the module directly via fs.readFile
                 + regex extract>,
  treeContext: <JSON.stringify of the lite skeleton — capture via popup eval>,
  currentDateTime: new Date().toISOString(),
  messages: conversation,
  requestId: <uuid>,
  browserId: 'chrome',
  browserBrand: 'Chrome',
};
```

### 5. Round loop (caps at maxTurns=8)

For each round:
- Call `postChatRound(reqArgs)` (Node, via Bash or programmatically)
- If `result.error`: stop, surface the error
- If `result.budgetExhausted`: stop, log
- If `result.toolCalls.length === 0`: terminal round, capture
  `result.finalText`, break
- Otherwise: for each `tc` in `result.toolCalls`:
    - `parseToolInputSafe(tc.argumentsRaw)` → input
    - Dispatch via chrome-devtools-mcp evaluate_script(SW) calling
      `dispatchChatTool({requestId: reqArgs.requestId, toolCallId: tc.id,
                         toolName: tc.name, toolInput: input.value})`
    - Save result keyed by `tc.id`
- `reqArgs.messages = buildContinuationMessages(reqArgs.messages, result, resultsMap)`
- `reqArgs.requestId = same` (chat.js reuses across rounds — see
  `dispatchChatRequest` at chat.js:1820)
- Loop

### 6. Assertions

After the loop terminates:

- **No tool errors.** Every dispatched tool should have `ok:true`.
  Surface any that didn't.
- **Expected tool sequence.** Should include at least
  `create_library` + (one of) `add_library_to_group` + `create_note`.
  Tolerate ordering variance and extra tool calls (Haiku 4.5 may
  fetch list_libraries first to find the group).
- **Final state.** Dispatch `get_library` via Tier 1b pattern with the
  created libraryId; assert title matches, note exists with correct
  title.
- **Group membership.** Dispatch `list_libraries`; find the test
  group; assert the new library id is in its member list.
- **Final marker.** `result.finalText` should contain `DONE library=`
  and `note=`. Surfaces missing-marker as a warning (not a hard
  failure — text formatting can drift).

### 7. Cleanup

Dispatch `delete_library_group` with `groupId: testGroupId,
cascadeMembers: true, confirmedByUser: true` via Tier 1b pattern.

If cleanup fails: surface the orphan group id loudly so the user can
manually delete it via the library panel.

## What this test proves (and doesn't)

**Proves:**
- EF accepts the Tier 2 wire shape (JWT + apikey + byoAnthropicToken)
- EF's Anthropic provider branch + tool_call_delta normalization works
  for the multi-round case
- chat.js's continuation contract (assistant turn with tool_calls +
  tool turns in tool_calls index order) is correctly reconstructed
  outside chat.js
- The 43-tool catalog is correctly described enough that Haiku 4.5
  picks `create_library` + `create_note` reliably
- Tool dispatch broadcast → chatToolResult round-trip works under
  agent-driven control (Tier 1b proved this under synthetic input)

**Does NOT prove (deferred to wider Tier 2 corpus):**
- Provider fan-out (Gemini, OpenRouter, OpenAI direct)
- Destructive-op approval card under real agent control (sessionAutoApprove
  vs gated path — Tier 1.5 covered the UI; Tier 2 destructive needs a
  separate fixture)
- bulk_apply atomic-batch under real agent control
- Cost guard scenarios (budget exhaustion, tier 1 quota, high reasoning
  effort gate)
- Description-quality drift across providers (Tier 3 territory)

## Findings routing

Per `feedback_native-chat-findings-routing.md` (memory, updated
2026-05-23): ship-blocking findings → `ai-todo.md` (P0 band);
non-blocking native-chat-surface findings → `ai-todo.md` (P1/P2/P3
band by severity); trivial fixes inline (commit is the record);
op-behavior questions → ask in chat. Test-assertion bugs are fixed in
place with no log entry. Do NOT use `agentic-ai-mcp-changes.md`. The
former `native-chat-test-findings.md` and `agentic-ai-followups.md` /
`agentic-ai-pre-ship-fixes.md` were retired 2026-05-23 (the latter is
preserved at `docs-archive/agentic-ai-pre-ship-fixes.md` with slim
summaries in `ai-resolved.md`).

## Cost expectation

Single proof run: ~3-5 rounds, ~$0.05-0.15 of computed Haiku 4.5 cost
(reported in `result.usage` if Anthropic populates it; with OAuth via
Max plan it draws from the carve-out, not API credits — verify via the
dashboard after the first run).

## Files

- `helpers/chat-completion-runner.mjs` — Node EF round driver
- `helpers/capture-credentials.js` — paste-into-SW credential fetcher
- `helpers/dispatch-tool-call.js` — paste-into-SW dispatch fn (Tier 1b
  shape with caller-supplied requestId+toolCallId)
- `tier2/library-creation.proof.md` — this runbook
