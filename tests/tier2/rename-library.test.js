import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { runAgent, toolCallsByName } from './helpers/agent-runner.js';
import { connectPinakoMcp, callToolOk, waitFor } from '../helpers/mcp-client.js';
import { resolveTargetBrowser } from '../helpers/browser.js';
import { testLabel } from '../helpers/fixtures.js';

// Tier 2: probes the agent's ability to pick `set_library_title` (not
// `set_title`) when asked to rename a LIBRARY. set_title rejects the library
// CONTAINER (type 'library') with INVALID_TARGET — the only correct path for
// library renames is set_library_title. (In-library FOLDER nodes, type
// 'library-folder', ARE renamable via set_title; this test is about the
// container.) The test gives the agent BOTH tools so it must actually
// discriminate; calling set_title here would surface as an errored tool call.
//
// Regression guard for the gap Sonnet flagged in the Tier 2 Haiku-vs-
// Sonnet comparison ("vague-cleanup" scenario): Sonnet correctly
// noticed no dedicated rename existed pre-fix; this test ensures the
// post-fix description steers the agent to set_library_title naturally.

const HAS_OAUTH = !!process.env.CLAUDE_CODE_OAUTH_TOKEN;
const HAS_API_KEY = !!process.env.ANTHROPIC_API_KEY;
const TIER2_RUNNABLE = HAS_OAUTH && !HAS_API_KEY;
const TEST_TIMEOUT_MS = 180_000;

describe.skipIf(!TIER2_RUNNABLE)('Tier 2 agent — rename library (set_library_title discoverability)', () => {
  let session;
  let browser;
  let testGroupId;
  let testLibraryId;
  let originalTitle;

  beforeAll(async () => {
    session = await connectPinakoMcp();
    browser = await resolveTargetBrowser(session.client);

    const group = await callToolOk(session.client, 'create_library_group', {
      title: testLabel('tier2-rename-lib-group'),
      browser,
    });
    testGroupId = group.result.createdGroupId;

    originalTitle = testLabel('tier2-rename-lib-original');
    const lib = await callToolOk(session.client, 'create_library', {
      title: originalTitle,
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

  it('agent picks set_library_title (not set_title) for "rename library" verb', async () => {
    const newTitle = testLabel('tier2-rename-lib-renamed');

    const prompt = [
      `Use the Pinako MCP tools to rename a LIBRARY (not a node inside the library — the library itself) on browser "${browser}".`,
      ``,
      `Library id: ${testLibraryId}`,
      `Current title: "${originalTitle}"`,
      `New title: "${newTitle}"`,
      ``,
      `When done, reply with one line: DONE`,
    ].join('\n');

    const run = await runAgent({
      prompt,
      allowedTools: [
        'mcp__pinako__set_title',
        'mcp__pinako__set_library_title',
      ],
      maxTurns: 6,
    });

    expect(run.systemInit, 'system init captured').toBeTruthy();

    console.log(
      `tier2 rename-library tool calls: ` +
      run.toolCalls.map(tc => `${tc.name}(${Object.keys(tc.input || {}).join(',')})`).join(' → '),
    );

    const libRenames = toolCallsByName(run.toolCalls, 'mcp__pinako__set_library_title');
    expect(libRenames.length, 'set_library_title called').toBeGreaterThanOrEqual(1);

    // Stronger: agent should not have leaned on set_title at all. set_title
    // on the library container fails with INVALID_TARGET; routing through it
    // would either error or hit the wrong target. Either is a regression.
    const wrongToolCalls = toolCallsByName(run.toolCalls, 'mcp__pinako__set_title');
    expect(wrongToolCalls.length, 'set_title NOT called (use set_library_title instead)').toBe(0);

    const errored = run.toolCalls.filter(tc => tc.resultIsError);
    expect(errored, `no errored tool calls (got: ${errored.map(t => t.name).join(', ')})`).toEqual([]);

    const renamed = await waitFor(async () => {
      const fetched = await callToolOk(session.client, 'get_library', {
        library_id: testLibraryId,
        mode: 'lite',
        browser,
      });
      return fetched.library?.title === newTitle ? fetched.library : null;
    }, { label: 'library-renamed', timeout: 12_000 });

    expect(renamed.title).toBe(newTitle);
    expect(renamed.title).not.toBe(originalTitle);

    console.log(
      `tier2 rename-library: ${run.toolCalls.length} calls, ${run.durationMs}ms, ` +
      `cost=${run.totalCostUsd ?? 'n/a'}, finalTitle="${renamed.title}"`,
    );
  }, TEST_TIMEOUT_MS);
});
