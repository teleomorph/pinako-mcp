import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { runAgent, toolCallsByName } from './helpers/agent-runner.js';
import { connectPinakoMcp, callToolOk, waitFor } from '../helpers/mcp-client.js';
import { resolveTargetBrowser } from '../helpers/browser.js';
import { testLabel } from '../helpers/fixtures.js';

// Tier 2: probes the agent's discovery of bulk_apply. Given a prompt
// that asks for the same op applied to N targets, does the agent reach
// for bulk_apply (one atomic undoable unit) or hammer with N individual
// calls? The bulk_apply description explicitly pitches itself for
// "multi-step reorganizations" — this test sees whether that language
// is enough for Haiku 4.5 to pick it.
//
// IMPORTANT: this test is *informational*, not prescriptive. Either
// strategy completes the task correctly; the failing case would be
// agent fails to update all 3 nodes. The tool-call sequence is logged
// so we can observe which approach the agent picked over time.

const HAS_OAUTH = !!process.env.CLAUDE_CODE_OAUTH_TOKEN;
const HAS_API_KEY = !!process.env.ANTHROPIC_API_KEY;
const TIER2_RUNNABLE = HAS_OAUTH && !HAS_API_KEY;
const TEST_TIMEOUT_MS = 180_000;

describe.skipIf(!TIER2_RUNNABLE)('Tier 2 agent — bulk apply (batching intuition)', () => {
  let session;
  let browser;
  let testGroupId;
  let testLibraryId;
  let targetNodeIds;

  beforeAll(async () => {
    session = await connectPinakoMcp();
    browser = await resolveTargetBrowser(session.client);

    const group = await callToolOk(session.client, 'create_library_group', {
      title: testLabel('tier2-bulk-group'),
      browser,
    });
    testGroupId = group.result.createdGroupId;

    const lib = await callToolOk(session.client, 'create_library', {
      title: testLabel('tier2-bulk-lib'),
      browser,
    });
    testLibraryId = lib.result.createdLibraryId;

    await callToolOk(session.client, 'add_library_to_group', {
      groupId: testGroupId,
      libraryId: testLibraryId,
      browser,
    });

    // Seed three sibling group nodes inside the library; each will be the
    // target of a tag mutation.
    targetNodeIds = [];
    for (let i = 0; i < 3; i++) {
      const g = await callToolOk(session.client, 'create_group', {
        title: testLabel(`tier2-bulk-target-${i}`),
        scope: 'library',
        libraryId: testLibraryId,
        browser,
      });
      targetNodeIds.push(g.result.createdId);
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

  it('agent tags all three target nodes — either via bulk_apply or N add_tags calls', async () => {
    const expectedTag = 'batch-test';

    const prompt = [
      `Use the Pinako MCP tools to add the tag "${expectedTag}" to THREE nodes in library "${testLibraryId}" on browser "${browser}".`,
      ``,
      `Target node ids:`,
      `- ${targetNodeIds[0]}`,
      `- ${targetNodeIds[1]}`,
      `- ${targetNodeIds[2]}`,
      ``,
      `Each of the three nodes should end up with "${expectedTag}" in its tag list. Pick whichever tool approach you think fits best.`,
      ``,
      `When done, reply with one line: DONE tagged=<n>`,
    ].join('\n');

    const run = await runAgent({
      prompt,
      // Both options are exposed; the test observes which the agent picks.
      allowedTools: [
        'mcp__pinako__add_tags',
        'mcp__pinako__bulk_apply',
      ],
      maxTurns: 10,
    });

    expect(run.systemInit, 'system init captured').toBeTruthy();

    console.log(
      `tier2 bulk-apply tool calls: ` +
      run.toolCalls.map(tc => `${tc.name}(${Object.keys(tc.input || {}).join(',')})`).join(' → '),
    );

    const bulkCalls = toolCallsByName(run.toolCalls, 'mcp__pinako__bulk_apply');
    const addCalls = toolCallsByName(run.toolCalls, 'mcp__pinako__add_tags');
    const strategy = bulkCalls.length > 0 ? 'bulk_apply' : 'individual';

    // At least one of the two approaches must have been used.
    expect(
      bulkCalls.length + addCalls.length,
      'agent used either bulk_apply or add_tags (or both)',
    ).toBeGreaterThanOrEqual(1);

    const errored = run.toolCalls.filter(tc => tc.resultIsError);
    expect(errored, `no errored tool calls (got: ${errored.map(t => t.name).join(', ')})`).toEqual([]);

    // Final state: all three nodes have the expected tag.
    const taggedNodes = await waitFor(async () => {
      const fetched = await callToolOk(session.client, 'get_library', {
        library_id: testLibraryId,
        mode: 'full',
        browser,
      });
      const allNodes = collectAll(fetched.library?.children ?? []);
      const hits = targetNodeIds.map(id =>
        allNodes.find(n => n.id === id),
      );
      if (hits.some(n => !n)) return null;
      if (hits.every(n => (n.tags ?? []).includes(expectedTag))) return hits;
      return null;
    }, { label: 'all-3-nodes-tagged', timeout: 12_000 });

    expect(taggedNodes.length).toBe(3);
    for (const node of taggedNodes) {
      expect(node.tags).toContain(expectedTag);
    }

    console.log(
      `tier2 bulk-apply: strategy=${strategy} (bulk=${bulkCalls.length}, individual=${addCalls.length}), ` +
      `${run.toolCalls.length} total calls, ${run.durationMs}ms, ` +
      `cost=${run.totalCostUsd ?? 'n/a'}, finalText="${(run.finalText || '').slice(0, 120)}"`,
    );
  }, TEST_TIMEOUT_MS);
});

function collectAll(nodes, out = []) {
  for (const n of nodes || []) {
    out.push(n);
    if (Array.isArray(n.children)) collectAll(n.children, out);
  }
  return out;
}
