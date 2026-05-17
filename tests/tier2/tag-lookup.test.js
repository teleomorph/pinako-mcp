import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { runAgent } from './helpers/agent-runner.js';
import { connectPinakoMcp, callToolOk } from '../helpers/mcp-client.js';
import { resolveTargetBrowser } from '../helpers/browser.js';
import { testLabel } from '../helpers/fixtures.js';

// Tier 2: probes how cleanly the agent can answer "find all nodes
// tagged X" with the current toolset. There is NO dedicated
// search_by_tags tool. search_tabs does a literal substring match
// across title/URL/memo/tags (main tree only). For libraries the only
// path is list_libraries(include_tabs:true) or get_library and a
// client-side filter on each node's tags array.
//
// What this test reveals:
//   - Does the agent find an efficient path? (e.g. one search_tabs
//     call + filter the results' tags, or one get_library call +
//     filter, depending on scope)
//   - Or does it grind through multiple awkward calls?
//   - How accurately does it identify the tag-bearing nodes?
//
// Setup: a library with 5 nodes, 3 of which carry the target tag.
// The agent is asked to list ONLY the tagged ones by id.

const HAS_OAUTH = !!process.env.CLAUDE_CODE_OAUTH_TOKEN;
const HAS_API_KEY = !!process.env.ANTHROPIC_API_KEY;
const TIER2_RUNNABLE = HAS_OAUTH && !HAS_API_KEY;
const TEST_TIMEOUT_MS = 180_000;

describe.skipIf(!TIER2_RUNNABLE)('Tier 2 agent — tag-based lookup ("find all nodes tagged X")', () => {
  let session;
  let browser;
  let testGroupId;
  let testLibraryId;
  let taggedNodeIds; // the 3 we expect the agent to find
  let untaggedNodeIds; // the 2 it should NOT include

  beforeAll(async () => {
    session = await connectPinakoMcp();
    browser = await resolveTargetBrowser(session.client);

    const group = await callToolOk(session.client, 'create_library_group', {
      title: testLabel('tier2-tag-lookup-group'),
      browser,
    });
    testGroupId = group.result.createdGroupId;

    const lib = await callToolOk(session.client, 'create_library', {
      title: testLabel('tier2-tag-lookup-lib'),
      browser,
    });
    testLibraryId = lib.result.createdLibraryId;

    await callToolOk(session.client, 'add_library_to_group', {
      groupId: testGroupId,
      libraryId: testLibraryId,
      browser,
    });

    // Create 5 nodes; tag 3 with 'priority-lookup-target'.
    taggedNodeIds = [];
    untaggedNodeIds = [];
    for (let i = 0; i < 3; i++) {
      const g = await callToolOk(session.client, 'create_group', {
        title: testLabel(`tier2-tag-lookup-tagged-${i}`),
        scope: 'library',
        libraryId: testLibraryId,
        browser,
      });
      taggedNodeIds.push(g.result.createdId);
      await callToolOk(session.client, 'add_tags', {
        nodeId: g.result.createdId,
        tags: ['priority-lookup-target'],
        scope: 'library',
        libraryId: testLibraryId,
        browser,
      });
    }
    for (let i = 0; i < 2; i++) {
      const g = await callToolOk(session.client, 'create_group', {
        title: testLabel(`tier2-tag-lookup-untagged-${i}`),
        scope: 'library',
        libraryId: testLibraryId,
        browser,
      });
      untaggedNodeIds.push(g.result.createdId);
    }
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

  it('agent identifies the 3 nodes tagged "priority-lookup-target" out of 5 total', async () => {
    const prompt = [
      `In Pinako library "${testLibraryId}" on browser "${browser}" there are 5 group nodes. Some of them are tagged "priority-lookup-target" and some are not.`,
      ``,
      `Find the nodes that ARE tagged with "priority-lookup-target" and reply with their ids, one per line, in the form:`,
      ``,
      `TAGGED:`,
      `- <node id 1>`,
      `- <node id 2>`,
      `- ...`,
      ``,
      `Do NOT list nodes that lack that tag. Report nothing else.`,
    ].join('\n');

    const run = await runAgent({
      prompt,
      // Give the agent reasonable read tools; it has to pick its own
      // path. search_tabs is included to see if the agent tries it
      // (it shouldn't — search_tabs is main-tree-only).
      allowedTools: [
        'mcp__pinako__get_library',
        'mcp__pinako__list_libraries',
        'mcp__pinako__search_tabs',
      ],
      maxTurns: 10,
    });

    expect(run.systemInit, 'system init captured').toBeTruthy();

    console.log(
      `tier2 tag-lookup tool calls: ` +
      run.toolCalls.map(tc => `${tc.name}(${Object.keys(tc.input || {}).join(',')})`).join(' → '),
    );

    const errored = run.toolCalls.filter(tc => tc.resultIsError);
    expect(errored, `no errored tool calls (got: ${errored.map(t => t.name).join(', ')})`).toEqual([]);

    // Parse the agent's final response — extract node ids it listed
    // under TAGGED:. Loose match — id patterns are stable
    // (folder-/note-/node-).
    const text = run.finalText || '';
    const idPattern = /\b(folder-\d+-\d+|note-\d+-[a-z0-9]+|node-\d+-[a-z0-9]+)\b/g;
    const listedIds = new Set(text.match(idPattern) || []);

    // The agent should list ALL 3 tagged ids.
    const allTaggedListed = taggedNodeIds.every(id => listedIds.has(id));
    expect(
      allTaggedListed,
      `all 3 tagged nodes listed. expected: ${JSON.stringify(taggedNodeIds)}, listed: ${JSON.stringify([...listedIds])}`,
    ).toBe(true);

    // The agent should NOT list either of the untagged ids.
    const noUntaggedListed = untaggedNodeIds.every(id => !listedIds.has(id));
    expect(
      noUntaggedListed,
      `no untagged nodes listed. untagged ids: ${JSON.stringify(untaggedNodeIds)}, listed: ${JSON.stringify([...listedIds])}`,
    ).toBe(true);

    // Tooling-efficiency observation — log the path the agent picked.
    const pathSummary = run.toolCalls.map(tc => tc.name.replace('mcp__pinako__', '')).join(' → ');
    console.log(
      `tier2 tag-lookup: ${run.toolCalls.length} calls, ${run.durationMs}ms, ` +
      `cost=${run.totalCostUsd ?? 'n/a'}, path="${pathSummary}", ` +
      `listed_ids=${JSON.stringify([...listedIds])}`,
    );
  }, TEST_TIMEOUT_MS);
});
