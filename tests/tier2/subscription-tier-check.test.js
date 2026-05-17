import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { runAgent, toolCallsByName } from './helpers/agent-runner.js';
import { connectPinakoMcp, callToolOk } from '../helpers/mcp-client.js';
import { resolveTargetBrowser } from '../helpers/browser.js';
import { testLabel } from '../helpers/fixtures.js';

// Tier 2: probes Batch 19's directive — the new `list_browsers`
// description tells the agent to check `subscriptionTier` BEFORE a
// planned create_note / set_note_content whose content might exceed
// the per-tier cap, so the user gets a proactive warning rather than
// hitting NOTE_CONTENT_OVER_TIER_LIMIT mid-write.
//
// This test puts the agent in exactly that scenario: it asks for a
// 75K-char note, which exceeds the Free / Pro cap of 50K but fits
// under Pro+ / Premium / Enterprise. The directive language should
// route the agent to call `list_browsers` FIRST so it knows whether
// to warn or proceed.
//
// Assertion shape:
//   - list_browsers must be called at least once.
//   - If create_note IS called, list_browsers must be called BEFORE it
//     (index ordering on the toolCalls array). The reverse order
//     means the agent didn't check tier upfront and the directive
//     in the description leaked.
//   - The agent's final text must mention the tier or the cap in
//     some form (loose check — agent has to surface tier-awareness
//     to the user, not silently proceed).

const HAS_OAUTH = !!process.env.CLAUDE_CODE_OAUTH_TOKEN;
const HAS_API_KEY = !!process.env.ANTHROPIC_API_KEY;
const TIER2_RUNNABLE = HAS_OAUTH && !HAS_API_KEY;
const TEST_TIMEOUT_MS = 180_000;

describe.skipIf(!TIER2_RUNNABLE)('Tier 2 agent — subscriptionTier proactive check (Batch 19 directive)', () => {
  let session;
  let browser;
  let testGroupId;
  let testLibraryId;

  beforeAll(async () => {
    session = await connectPinakoMcp();
    browser = await resolveTargetBrowser(session.client);

    const group = await callToolOk(session.client, 'create_library_group', {
      title: testLabel('tier2-tier-check-group'),
      browser,
    });
    testGroupId = group.result.createdGroupId;

    const lib = await callToolOk(session.client, 'create_library', {
      title: testLabel('tier2-tier-check-lib'),
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
        // eslint-disable-next-line no-console
        console.warn(`cleanup: cascade-delete group ${testGroupId} failed: ${err.message}`);
      }
    }
    if (session) await session.close();
  }, TEST_TIMEOUT_MS);

  it('agent checks subscriptionTier via list_browsers BEFORE attempting a borderline-large create_note', async () => {
    const prompt = [
      `I want to save a long document as a new note in Pinako library "${testLibraryId}" on browser "${browser}".`,
      ``,
      `The document is roughly 75,000 characters of plain text. Before you create the note, please verify whether my Pinako subscription tier supports a note of that size. If it does, proceed with creating an empty note titled "Long Doc Import" and tell me the note id (you do not need to populate the actual 75,000 characters — just confirm tier-fit and create the empty container). If it does not, do NOT create the note — instead tell me which tier I would need and the size cap I'm hitting.`,
    ].join('\n');

    const run = await runAgent({
      prompt,
      allowedTools: [
        'mcp__pinako__list_browsers',
        'mcp__pinako__create_note',
        'mcp__pinako__set_note_content',
      ],
      maxTurns: 8,
    });

    expect(run.systemInit, 'system init captured').toBeTruthy();

    // eslint-disable-next-line no-console
    console.log(
      `tier2 subscriptionTier-check tool calls: ` +
      run.toolCalls.map(tc => `${tc.name}(${Object.keys(tc.input || {}).join(',')})`).join(' → '),
    );

    const errored = run.toolCalls.filter(tc => tc.resultIsError);
    expect(errored, `no errored tool calls (got: ${errored.map(t => t.name).join(', ')})`).toEqual([]);

    const listBrowsersCalls = toolCallsByName(run.toolCalls, 'mcp__pinako__list_browsers');
    expect(
      listBrowsersCalls.length,
      'agent must call list_browsers at least once to read subscriptionTier',
    ).toBeGreaterThanOrEqual(1);

    const firstListBrowsersIdx = run.toolCalls.findIndex(tc => tc.name === 'mcp__pinako__list_browsers');
    const firstCreateNoteIdx   = run.toolCalls.findIndex(tc => tc.name === 'mcp__pinako__create_note');
    if (firstCreateNoteIdx !== -1) {
      expect(
        firstListBrowsersIdx,
        'list_browsers must precede create_note (proactive tier check directive)',
      ).toBeLessThan(firstCreateNoteIdx);
    }

    const text = (run.finalText || '').toLowerCase();
    const mentionsTierOrCap =
      /tier|cap|limit|character|chars|pro\+?\b|premium|enterprise|free/.test(text);
    expect(
      mentionsTierOrCap,
      `agent's final text should surface tier-awareness (got: "${text.slice(0, 200)}…")`,
    ).toBe(true);

    // eslint-disable-next-line no-console
    console.log(
      `tier2 subscriptionTier-check: ${run.toolCalls.length} calls, ${run.durationMs}ms, ` +
      `cost=${run.totalCostUsd ?? 'n/a'}, ` +
      `list_browsers_idx=${firstListBrowsersIdx}, create_note_idx=${firstCreateNoteIdx}, ` +
      `finalText="${(run.finalText || '').slice(0, 200)}"`,
    );
  }, TEST_TIMEOUT_MS);
});
