import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { runAgent, toolCallsByName, tryParseJsonResult } from './helpers/agent-runner.js';
import { connectPinakoMcp, callToolOk, waitFor } from '../helpers/mcp-client.js';
import { resolveTargetBrowser } from '../helpers/browser.js';
import { testLabel } from '../helpers/fixtures.js';

// Tier 2 proof test: drive a real LLM agent through a multi-step Pinako MCP
// task and assert on (a) the tool sequence the agent picked and (b) the
// resulting state via the same Tier 1 read tools.
//
// Why this test exists: it's the first end-to-end verification that the
// Agent SDK + OAuth + MCP HTTP transport + transcript capture path works.
// Future Tier 2 tests fan out to many scenarios; this one just proves the
// rails are connected.

const HAS_OAUTH = !!process.env.CLAUDE_CODE_OAUTH_TOKEN;
const HAS_API_KEY = !!process.env.ANTHROPIC_API_KEY;
const TIER2_RUNNABLE = HAS_OAUTH && !HAS_API_KEY;
const TEST_TIMEOUT_MS = 180_000;

if (!TIER2_RUNNABLE) {
  // Loud warning during default `npm test` so the user understands the skip.
  // Most Tier 1 noise is silent.
  // eslint-disable-next-line no-console
  console.warn(
    HAS_API_KEY
      ? 'Tier 2 skipped: ANTHROPIC_API_KEY is set. Unset it to run Tier 2 on Max plan OAuth.'
      : 'Tier 2 skipped: CLAUDE_CODE_OAUTH_TOKEN not set. See tests/tier2/README.md.',
  );
}

describe.skipIf(!TIER2_RUNNABLE)('Tier 2 agent — library creation flow', () => {
  let session;
  let browser;
  let testGroupId;

  beforeAll(async () => {
    session = await connectPinakoMcp();
    browser = await resolveTargetBrowser(session.client);
    const group = await callToolOk(session.client, 'create_library_group', {
      title: testLabel('tier2-library-creation-group'),
      browser,
    });
    testGroupId = group.result.createdGroupId;
  }, TEST_TIMEOUT_MS);

  afterAll(async () => {
    if (testGroupId) {
      try {
        await callToolOk(session.client, 'delete_library_group', {
          groupId: testGroupId,
          cascadeMembers: true,
          confirmedByUser: true,
          browser,
        });
      } catch (err) {
        console.warn(`cleanup: cascade-delete group ${testGroupId} failed: ${err.message}`);
      }
    }
    if (session) await session.close();
  }, TEST_TIMEOUT_MS);

  it('agent creates a library, adds it to a group, then attaches a note', async () => {
    const libraryTitle = testLabel('tier2-agent-lib');
    const noteTitle = testLabel('tier2-agent-note');
    const noteContent = '<p>tier2 placeholder body</p>';

    const prompt = [
      `You are testing the Pinako MCP integration. Use only the Pinako MCP tools to complete the following steps on browser "${browser}":`,
      ``,
      `1. Create a new Pinako library titled "${libraryTitle}".`,
      `2. Add that newly created library to the existing library group with id "${testGroupId}".`,
      `3. Create a note inside the new library with title "${noteTitle}" and HTML content "${noteContent}".`,
      ``,
      `When all three steps succeed, reply with one line in the form: DONE library=<libraryId> note=<noteId>`,
    ].join('\n');

    const run = await runAgent({
      prompt,
      allowedTools: [
        'mcp__pinako__create_library',
        'mcp__pinako__add_library_to_group',
        'mcp__pinako__create_note',
      ],
      maxTurns: 12,
    });

    // The SDK should have loaded the MCP server and at least one Pinako tool.
    expect(run.systemInit, 'system init message captured').toBeTruthy();
    const pinakoServer = (run.systemInit?.mcpServers ?? []).find(s => s.name === 'pinako');
    expect(pinakoServer?.status, 'pinako MCP server connected').toBe('connected');

    // The agent should have called the three write tools at least once each.
    const createLibCalls = toolCallsByName(run.toolCalls, 'mcp__pinako__create_library');
    const addToGroupCalls = toolCallsByName(run.toolCalls, 'mcp__pinako__add_library_to_group');
    const createNoteCalls = toolCallsByName(run.toolCalls, 'mcp__pinako__create_note');

    expect(createLibCalls.length, 'create_library called').toBeGreaterThanOrEqual(1);
    expect(addToGroupCalls.length, 'add_library_to_group called').toBeGreaterThanOrEqual(1);
    expect(createNoteCalls.length, 'create_note called').toBeGreaterThanOrEqual(1);

    // No tool call should have errored. If one did, surface it so the failure
    // mode is obvious.
    const errored = run.toolCalls.filter(tc => tc.resultIsError);
    expect(errored, `no errored tool calls (got: ${errored.map(t => t.name).join(', ')})`).toEqual([]);

    // Recover the agent-created library id from the create_library response.
    const createLibParsed = tryParseJsonResult(createLibCalls[0].resultText);
    const agentLibraryId = createLibParsed?.result?.createdLibraryId;
    expect(agentLibraryId, 'createdLibraryId returned to agent').toMatch(/^folder-/);

    // Recover the agent-created note id from the create_note response.
    const createNoteParsed = tryParseJsonResult(createNoteCalls[0].resultText);
    const agentNoteId = createNoteParsed?.result?.createdNoteId;
    expect(agentNoteId, 'createdNoteId returned to agent').toMatch(/^note-/);

    // Verify final state via direct MCP read. The library should exist with
    // the right title, be a member of the test group, and contain the note.
    const library = await waitFor(async () => {
      const fetched = await callToolOk(session.client, 'get_library', {
        library_id: agentLibraryId,
        mode: 'lite',
        browser,
      });
      const lib = fetched.library;
      if (!lib) return null;
      if (lib.title !== libraryTitle) return null;
      const noteHit = (lib.notes ?? []).find(n => n.id === agentNoteId);
      return noteHit ? { lib, note: noteHit } : null;
    }, { label: 'agent-library-and-note-visible' });

    expect(library.lib.title).toBe(libraryTitle);
    expect(library.note.title).toBe(noteTitle);

    // Sanity check: the library is actually inside the test group.
    const groups = await callToolOk(session.client, 'list_libraries', { browser });
    const targetGroup = (groups.groups ?? []).find(g => g.id === testGroupId);
    expect(targetGroup, 'test group still exists in list_libraries').toBeTruthy();
    const memberIds = targetGroup.library_ids ?? targetGroup.libraryIds ?? [];
    expect(memberIds, 'agent library is a member of the test group').toContain(agentLibraryId);

    // Final sanity log so the run report shows the agent did real work and
    // the billing path is the Max plan, not the API.
    const cost = run.totalCostUsd;
    const inputTokens = run.usage?.input_tokens ?? '?';
    const outputTokens = run.usage?.output_tokens ?? '?';
    console.log(
      `tier2 agent run: ${run.toolCalls.length} tool calls, ${run.durationMs}ms, ` +
      `model=${run.systemInit?.model}, in=${inputTokens} out=${outputTokens}, ` +
      `total_cost_usd=${cost ?? 'n/a'}, finalText="${(run.finalText || '').slice(0, 120)}"`,
    );
  }, TEST_TIMEOUT_MS);
});
