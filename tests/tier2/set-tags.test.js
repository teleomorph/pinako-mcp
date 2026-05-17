import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { runAgent, toolCallsByName } from './helpers/agent-runner.js';
import { connectPinakoMcp, callToolOk, waitFor } from '../helpers/mcp-client.js';
import { resolveTargetBrowser } from '../helpers/browser.js';
import { testLabel } from '../helpers/fixtures.js';

// Tier 2: probes set_tags vs add_tags discrimination. The target node
// is pre-seeded with tags ["old-A", "old-B"]; the prompt asks the agent
// to REPLACE them with ["new-X", "new-Y"]. The agent has both tools
// available and must pick set_tags (clobber) rather than add_tags
// (which would leave the old tags in place and just append the new).
//
// If the agent picks add_tags, final tags = [old-A, old-B, new-X, new-Y]
// and the test fails on "old-A NOT in final tags." That's the actual
// production-risk failure: an agent that conflates "set" and "add"
// silently corrupts the user's intent on every replace operation.

const HAS_OAUTH = !!process.env.CLAUDE_CODE_OAUTH_TOKEN;
const HAS_API_KEY = !!process.env.ANTHROPIC_API_KEY;
const TIER2_RUNNABLE = HAS_OAUTH && !HAS_API_KEY;
const TEST_TIMEOUT_MS = 180_000;

describe.skipIf(!TIER2_RUNNABLE)('Tier 2 agent — set_tags vs add_tags discrimination', () => {
  let session;
  let browser;
  let testGroupId;
  let testLibraryId;
  let targetNodeId;

  beforeAll(async () => {
    session = await connectPinakoMcp();
    browser = await resolveTargetBrowser(session.client);

    const group = await callToolOk(session.client, 'create_library_group', {
      title: testLabel('tier2-set-tags-group'),
      browser,
    });
    testGroupId = group.result.createdGroupId;

    const lib = await callToolOk(session.client, 'create_library', {
      title: testLabel('tier2-set-tags-lib'),
      browser,
    });
    testLibraryId = lib.result.createdLibraryId;

    await callToolOk(session.client, 'add_library_to_group', {
      groupId: testGroupId,
      libraryId: testLibraryId,
      browser,
    });

    const seed = await callToolOk(session.client, 'create_group', {
      title: testLabel('tier2-set-tags-target'),
      scope: 'library',
      libraryId: testLibraryId,
      browser,
    });
    targetNodeId = seed.result.createdId;

    // Pre-seed existing tags using add_tags (so we know they exist).
    await callToolOk(session.client, 'add_tags', {
      nodeId: targetNodeId,
      tags: ['old-A', 'old-B'],
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
        console.warn(`cleanup: cascade-delete group ${testGroupId} failed: ${err.message}`);
      }
    }
    if (session) await session.close();
  }, TEST_TIMEOUT_MS);

  it('agent uses set_tags (not add_tags) for "replace the tags" — old tags removed', async () => {
    const prompt = [
      `A node in library "${testLibraryId}" on browser "${browser}" currently has the tags ["old-A", "old-B"].`,
      ``,
      `Target node id: ${targetNodeId}`,
      ``,
      `Replace those tags entirely with the new tags ["new-X", "new-Y"]. After the operation, the node should have ONLY the tags new-X and new-Y; the old tags old-A and old-B should no longer be present.`,
      ``,
      `When done, reply with one line: DONE`,
    ].join('\n');

    const run = await runAgent({
      prompt,
      allowedTools: [
        'mcp__pinako__set_tags',
        'mcp__pinako__add_tags',
      ],
      maxTurns: 8,
    });

    expect(run.systemInit, 'system init captured').toBeTruthy();

    console.log(
      `tier2 set-tags tool calls: ` +
      run.toolCalls.map(tc => `${tc.name}(${Object.keys(tc.input || {}).join(',')})`).join(' → '),
    );

    const setCalls = toolCallsByName(run.toolCalls, 'mcp__pinako__set_tags');
    const addCalls = toolCallsByName(run.toolCalls, 'mcp__pinako__add_tags');

    // The agent should pick set_tags (replace) — not add_tags (additive).
    // We don't strictly forbid add_tags (e.g. agent might call add + remove
    // as a workaround), but set_tags is the correct single-call answer.
    expect(setCalls.length, `set_tags called for "replace" verb`).toBeGreaterThanOrEqual(1);

    const errored = run.toolCalls.filter(tc => tc.resultIsError);
    expect(errored, `no errored tool calls (got: ${errored.map(t => t.name).join(', ')})`).toEqual([]);

    // Final state: node has ONLY new-X and new-Y; old-A and old-B are gone.
    const finalTags = await waitFor(async () => {
      const fetched = await callToolOk(session.client, 'get_library', {
        library_id: testLibraryId,
        mode: 'full',
        browser,
      });
      const node = findNode(fetched.library?.children ?? [], targetNodeId);
      if (!node) return null;
      const tags = node.tags ?? [];
      if (tags.includes('new-X') && tags.includes('new-Y')
          && !tags.includes('old-A') && !tags.includes('old-B')) {
        return tags;
      }
      return null;
    }, { label: 'tags-replaced', timeout: 12_000 });

    expect(finalTags).toContain('new-X');
    expect(finalTags).toContain('new-Y');
    expect(finalTags).not.toContain('old-A');
    expect(finalTags).not.toContain('old-B');

    console.log(
      `tier2 set-tags: ${run.toolCalls.length} calls (set=${setCalls.length}, add=${addCalls.length}), ` +
      `${run.durationMs}ms, cost=${run.totalCostUsd ?? 'n/a'}, finalTags=${JSON.stringify(finalTags)}`,
    );
  }, TEST_TIMEOUT_MS);
});

function findNode(nodes, id) {
  for (const n of nodes || []) {
    if (n.id === id) return n;
    if (Array.isArray(n.children)) {
      const hit = findNode(n.children, id);
      if (hit) return hit;
    }
  }
  return null;
}
