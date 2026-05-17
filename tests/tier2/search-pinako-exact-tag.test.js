import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { runAgent, toolCallsByName } from './helpers/agent-runner.js';
import { connectPinakoMcp, callToolOk } from '../helpers/mcp-client.js';
import { resolveTargetBrowser } from '../helpers/browser.js';
import { testLabel } from '../helpers/fixtures.js';

// Tier 2: probes Batch 21's exact_tag directive on the new
// search_pinako omnibus search tool. The user-flagged regression was
// that tag matching defaults to fuzzy substring (e.g. "food" matches
// "football", "foodie"). The new tool exposes exact_tag:true with a
// directive in the description that the agent MUST pass it when the
// user names a specific tag and false-positives would be wrong.
//
// Setup: a single library with two nodes — one tagged with a unique
// EXACT marker, the other tagged with the same marker plus a suffix
// (the substring-collision case). The agent is asked to find nodes
// tagged exactly with the short marker.
//
// Assertions:
//   - search_pinako called (NOT search_tabs — that's the old tool
//     which can't disambiguate).
//   - exact_tag === true on at least one search_pinako call.
//   - The agent reports the short-tag node and NOT the long-tag node.

const HAS_OAUTH = !!process.env.CLAUDE_CODE_OAUTH_TOKEN;
const HAS_API_KEY = !!process.env.ANTHROPIC_API_KEY;
const TIER2_RUNNABLE = HAS_OAUTH && !HAS_API_KEY;
const TEST_TIMEOUT_MS = 180_000;

describe.skipIf(!TIER2_RUNNABLE)('Tier 2 agent — search_pinako exact_tag (Batch 21 directive)', () => {
  let session;
  let browser;
  let testGroupId;
  let testLibraryId;
  let exactTagNodeId;
  let suffixTagNodeId;

  // Unique marker prevents collision with any real user tag data.
  const MARKER          = `t2etag-${Date.now().toString(36)}`;
  const EXACT_TAG       = `${MARKER}-food`;
  const EXACT_TAG_LONG  = `${MARKER}-foodie`;

  beforeAll(async () => {
    session = await connectPinakoMcp();
    browser = await resolveTargetBrowser(session.client);

    const group = await callToolOk(session.client, 'create_library_group', {
      title: testLabel('tier2-exact-tag-group'),
      browser,
    });
    testGroupId = group.result.createdGroupId;

    const lib = await callToolOk(session.client, 'create_library', {
      title: testLabel('tier2-exact-tag-lib'),
      browser,
    });
    testLibraryId = lib.result.createdLibraryId;

    await callToolOk(session.client, 'add_library_to_group', {
      groupId: testGroupId,
      libraryId: testLibraryId,
      browser,
    });

    const exactNode = await callToolOk(session.client, 'create_group', {
      title: testLabel('exact-tag-target'),
      scope: 'library',
      libraryId: testLibraryId,
      browser,
    });
    exactTagNodeId = exactNode.result.createdId;
    await callToolOk(session.client, 'set_tags', {
      nodeId: exactTagNodeId,
      tags: [EXACT_TAG],
      scope: 'library',
      libraryId: testLibraryId,
      browser,
    });

    const suffixNode = await callToolOk(session.client, 'create_group', {
      title: testLabel('suffix-tag-target'),
      scope: 'library',
      libraryId: testLibraryId,
      browser,
    });
    suffixTagNodeId = suffixNode.result.createdId;
    await callToolOk(session.client, 'set_tags', {
      nodeId: suffixTagNodeId,
      tags: [EXACT_TAG_LONG],
      scope: 'library',
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

  it('agent uses search_pinako with exact_tag:true when the user names a specific tag', async () => {
    const prompt = [
      `In Pinako library "${testLibraryId}" on browser "${browser}" there are nodes tagged with various tags.`,
      ``,
      `Find every node tagged with EXACTLY "${EXACT_TAG}" — not tags that merely start with or contain that string, only the exact tag. There is also a similar but distinct tag in this library ("${EXACT_TAG_LONG}") that must NOT be included in your results.`,
      ``,
      `Reply in the form:`,
      ``,
      `EXACT_TAG_MATCHES:`,
      `- <node id 1>`,
      `- ...`,
      ``,
      `Report nothing else.`,
    ].join('\n');

    const run = await runAgent({
      prompt,
      allowedTools: [
        'mcp__pinako__search_pinako',
        'mcp__pinako__search_tabs',
        'mcp__pinako__get_library',
        'mcp__pinako__list_libraries',
      ],
      maxTurns: 8,
    });

    expect(run.systemInit, 'system init captured').toBeTruthy();

    // eslint-disable-next-line no-console
    console.log(
      `tier2 exact_tag tool calls: ` +
      run.toolCalls.map(tc =>
        `${tc.name}(${Object.entries(tc.input || {}).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(',')})`,
      ).join(' → '),
    );

    const errored = run.toolCalls.filter(tc => tc.resultIsError);
    expect(errored, `no errored tool calls (got: ${errored.map(t => t.name).join(', ')})`).toEqual([]);

    const searchPinakoCalls = toolCallsByName(run.toolCalls, 'mcp__pinako__search_pinako');
    expect(
      searchPinakoCalls.length,
      'agent must call search_pinako at least once (NOT search_tabs, which can\'t disambiguate exact-tag from substring)',
    ).toBeGreaterThanOrEqual(1);

    const exactTagCalls = searchPinakoCalls.filter(c => c.input?.exact_tag === true);
    expect(
      exactTagCalls.length,
      `search_pinako called with exact_tag:true (agent's calls: ${JSON.stringify(searchPinakoCalls.map(c => ({ scope: c.input?.scope, exact_tag: c.input?.exact_tag, query: c.input?.query })))})`,
    ).toBeGreaterThanOrEqual(1);

    // Parse the agent's final text — id pattern matches folder-* / node-*
    // / group-* etc.
    const text = run.finalText || '';
    const idPattern = /\b(folder-\d+-\d+|note-\d+-[a-z0-9]+|node-\d+-[a-z0-9]+|group-\d+-[a-z0-9]+)\b/g;
    const listedIds = new Set(text.match(idPattern) || []);

    expect(
      listedIds.has(exactTagNodeId),
      `exact-tag node ${exactTagNodeId} should be listed. Got: ${JSON.stringify([...listedIds])}`,
    ).toBe(true);
    expect(
      listedIds.has(suffixTagNodeId),
      `suffix-tag node ${suffixTagNodeId} MUST NOT be listed (exact_tag should have excluded it). Got: ${JSON.stringify([...listedIds])}`,
    ).toBe(false);

    // eslint-disable-next-line no-console
    console.log(
      `tier2 exact_tag: ${run.toolCalls.length} calls, ${run.durationMs}ms, ` +
      `cost=${run.totalCostUsd ?? 'n/a'}, ` +
      `exact_tag_calls=${exactTagCalls.length}, ` +
      `listed_ids=${JSON.stringify([...listedIds])}, ` +
      `finalText="${text.slice(0, 200)}"`,
    );
  }, TEST_TIMEOUT_MS);
});
