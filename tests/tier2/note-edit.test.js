import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { runAgent, toolCallsByName, tryParseJsonResult } from './helpers/agent-runner.js';
import { connectPinakoMcp, callToolOk, waitFor } from '../helpers/mcp-client.js';
import { resolveTargetBrowser } from '../helpers/browser.js';
import { testLabel } from '../helpers/fixtures.js';

// Tier 2: probes the agent's ability to infer the `mode` parameter for
// set_note_content (replace vs append). The prompt tells the agent
// what should happen logically ("replace the content with X, then add Y
// on a new line"); the agent must translate that into `mode: 'replace'`
// then `mode: 'append'`. A failure here would mean the tool description
// for set_note_content doesn't make the mode parameter discoverable.

const HAS_OAUTH = !!process.env.CLAUDE_CODE_OAUTH_TOKEN;
const HAS_API_KEY = !!process.env.ANTHROPIC_API_KEY;
const TIER2_RUNNABLE = HAS_OAUTH && !HAS_API_KEY;
const TEST_TIMEOUT_MS = 180_000;

describe.skipIf(!TIER2_RUNNABLE)('Tier 2 agent — note edit flow', () => {
  let session;
  let browser;
  let testGroupId;
  let testLibraryId;

  beforeAll(async () => {
    session = await connectPinakoMcp();
    browser = await resolveTargetBrowser(session.client);

    const group = await callToolOk(session.client, 'create_library_group', {
      title: testLabel('tier2-note-edit-group'),
      browser,
    });
    testGroupId = group.result.createdGroupId;

    const lib = await callToolOk(session.client, 'create_library', {
      title: testLabel('tier2-note-edit-lib'),
      browser,
    });
    testLibraryId = lib.result.createdLibraryId;

    await callToolOk(session.client, 'add_library_to_group', {
      groupId: testGroupId,
      libraryId: testLibraryId,
      browser,
    });
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

  it('agent creates a note, replaces its content, then appends a chunk', async () => {
    const noteTitle = testLabel('tier2-edit-note');
    const initialContent = '<p>initial draft</p>';
    const replacementContent = '<p>fully revised body</p>';
    const appendChunk = '<p>postscript</p>';

    const prompt = [
      `Use the Pinako MCP tools to manage a note in library "${testLibraryId}" on browser "${browser}".`,
      ``,
      `1. Create a new note titled "${noteTitle}" with this initial HTML content: ${initialContent}`,
      `2. Replace the note's content with this HTML: ${replacementContent}`,
      `3. Append this HTML on the end of the note: ${appendChunk}`,
      ``,
      `When done, reply with one line: DONE note=<noteId>`,
    ].join('\n');

    const run = await runAgent({
      prompt,
      allowedTools: [
        'mcp__pinako__create_note',
        'mcp__pinako__set_note_content',
      ],
      maxTurns: 12,
    });

    expect(run.systemInit, 'system init captured').toBeTruthy();
    const pinakoServer = (run.systemInit?.mcpServers ?? []).find(s => s.name === 'pinako');
    expect(pinakoServer?.status).toBe('connected');

    const createCalls = toolCallsByName(run.toolCalls, 'mcp__pinako__create_note');
    const setContentCalls = toolCallsByName(run.toolCalls, 'mcp__pinako__set_note_content');
    expect(createCalls.length, 'create_note called once').toBe(1);
    expect(setContentCalls.length, 'set_note_content called twice (replace + append)').toBe(2);

    // The agent must have picked the right modes for each set_note_content
    // call. The first should be a replace (or default which is replace),
    // the second should be an append. If the agent got these wrong the
    // final content would be a mess.
    const errored = run.toolCalls.filter(tc => tc.resultIsError);
    expect(errored, `no errored tool calls (got: ${errored.map(t => t.name).join(', ')})`).toEqual([]);

    const noteId = tryParseJsonResult(createCalls[0].resultText)?.result?.createdNoteId;
    expect(noteId, 'noteId captured').toMatch(/^note-/);

    // Verify final state: the note's content reflects the replace-then-append
    // sequence (revised body should appear before the postscript, and the
    // initial draft should be gone entirely).
    const finalNote = await waitFor(async () => {
      const fetched = await callToolOk(session.client, 'get_library', {
        library_id: testLibraryId,
        mode: 'full',
        browser,
      });
      const note = (fetched.library?.notes ?? []).find(n => n.id === noteId);
      if (!note?.content) return null;
      const c = note.content;
      if (!c.includes('postscript')) return null;
      if (!c.includes('fully revised body')) return null;
      return note;
    }, { label: 'note-fully-edited', timeout: 12_000 });

    expect(finalNote.content).toContain('fully revised body');
    expect(finalNote.content).toContain('postscript');
    expect(finalNote.content).not.toContain('initial draft');
    expect(
      finalNote.content.indexOf('fully revised body'),
      'revised body precedes postscript (append order preserved)',
    ).toBeLessThan(finalNote.content.indexOf('postscript'));

    console.log(
      `tier2 note-edit: ${run.toolCalls.length} calls, ${run.durationMs}ms, ` +
      `model=${run.systemInit?.model}, cost=${run.totalCostUsd ?? 'n/a'}, ` +
      `finalText="${(run.finalText || '').slice(0, 120)}"`,
    );
  }, TEST_TIMEOUT_MS);
});
