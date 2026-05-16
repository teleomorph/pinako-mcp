import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { runAgent, toolCallsByName } from './helpers/agent-runner.js';
import { connectPinakoMcp, callToolOk, waitFor } from '../helpers/mcp-client.js';
import { resolveTargetBrowser } from '../helpers/browser.js';
import { testLabel } from '../helpers/fixtures.js';

// Tier 2: probes the agent's discovery of bulk_apply at N=8, which sits
// above the empirically-validated "6 or more" threshold the bulk_apply
// description now teaches (Batch 9.5 sweep:
// tests/tier2/_experiments/bulk-threshold-results.md).
//
// At N=8, calling add_tags 8 times costs more output tokens and takes
// ~2s longer than one bulk_apply with 8 sub-ops, AND the bulk batch
// can be undone in one user click. The description tells the agent
// this; this test asserts the agent acts on it.
//
// If a future model upgrade or description change re-introduces the
// gap (agent picks individual at N=8), the strategy log will show it
// and the assertion below will fail — i.e. this test is now a
// regression guard for the bulk_apply discoverability fix.

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

    // Seed N=8 sibling group nodes — above the "6 or more" threshold the
    // bulk_apply description teaches. At 8 the bulk_apply path is the
    // empirically optimal choice (cheaper, faster, atomic undo).
    targetNodeIds = [];
    for (let i = 0; i < 8; i++) {
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

  it('agent reaches for bulk_apply when tagging 8 nodes (above the N>=6 threshold)', async () => {
    const expectedTag = 'batch-test';

    const targetList = targetNodeIds.map(id => `- ${id}`).join('\n');
    const prompt = [
      `Use the Pinako MCP tools to add the tag "${expectedTag}" to ${targetNodeIds.length} nodes in library "${testLibraryId}" on browser "${browser}".`,
      ``,
      `Target node ids:`,
      targetList,
      ``,
      `Each of the ${targetNodeIds.length} nodes should end up with "${expectedTag}" in its tag list. Pick whichever tool approach you think fits best.`,
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
    const strategy = bulkCalls.length > 0 && addCalls.length === 0 ? 'bulk_apply'
                   : addCalls.length > 0 && bulkCalls.length === 0 ? 'individual'
                   : 'mixed';

    // At N=8 (above the description's "6 or more" threshold), the agent
    // should pick bulk_apply. If a model upgrade or description change
    // re-introduces individual-calling at this N, this assertion catches it.
    expect(
      bulkCalls.length,
      `bulk_apply called at least once (strategy picked: ${strategy})`,
    ).toBeGreaterThanOrEqual(1);

    const errored = run.toolCalls.filter(tc => tc.resultIsError);
    expect(errored, `no errored tool calls (got: ${errored.map(t => t.name).join(', ')})`).toEqual([]);

    // Final state: every target node has the expected tag.
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
    }, { label: `all-${targetNodeIds.length}-nodes-tagged`, timeout: 15_000 });

    expect(taggedNodes.length).toBe(targetNodeIds.length);
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
