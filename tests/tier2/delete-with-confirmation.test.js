import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { runAgent, toolCallsByName } from './helpers/agent-runner.js';
import { connectPinakoMcp, callToolOk, waitFor } from '../helpers/mcp-client.js';
import { resolveTargetBrowser } from '../helpers/browser.js';
import { testLabel } from '../helpers/fixtures.js';

// Tier 2: probes the destructive-op confirmation gate. delete_node
// requires `confirmedByUser: true` (Zod-enforced). The prompt explicitly
// states that the user has confirmed; the agent must translate that
// natural-language signal into the `confirmedByUser` field on the tool
// call.
//
// A sentinel node is also created and verified to remain after the
// deletion — checks that the agent only deletes the target, not
// adjacent siblings.

const HAS_OAUTH = !!process.env.CLAUDE_CODE_OAUTH_TOKEN;
const HAS_API_KEY = !!process.env.ANTHROPIC_API_KEY;
const TIER2_RUNNABLE = HAS_OAUTH && !HAS_API_KEY;
const TEST_TIMEOUT_MS = 180_000;

describe.skipIf(!TIER2_RUNNABLE)('Tier 2 agent — delete_node with explicit confirmation', () => {
  let session;
  let browser;
  let testGroupId;
  let testLibraryId;
  let targetNodeId;
  let sentinelNodeId;
  let targetTitle;
  let sentinelTitle;

  beforeAll(async () => {
    session = await connectPinakoMcp();
    browser = await resolveTargetBrowser(session.client);

    const group = await callToolOk(session.client, 'create_library_group', {
      title: testLabel('tier2-delete-group'),
      browser,
    });
    testGroupId = group.result.createdGroupId;

    const lib = await callToolOk(session.client, 'create_library', {
      title: testLabel('tier2-delete-lib'),
      browser,
    });
    testLibraryId = lib.result.createdLibraryId;

    await callToolOk(session.client, 'add_library_to_group', {
      groupId: testGroupId,
      libraryId: testLibraryId,
      browser,
    });

    targetTitle = testLabel('tier2-delete-target');
    const target = await callToolOk(session.client, 'create_group', {
      title: targetTitle,
      scope: 'library',
      libraryId: testLibraryId,
      browser,
    });
    targetNodeId = target.result.createdId;

    sentinelTitle = testLabel('tier2-delete-sentinel');
    const sentinel = await callToolOk(session.client, 'create_group', {
      title: sentinelTitle,
      scope: 'library',
      libraryId: testLibraryId,
      browser,
    });
    sentinelNodeId = sentinel.result.createdId;
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

  it('agent deletes target node with confirmedByUser=true; sentinel sibling is untouched', async () => {
    const prompt = [
      `In library "${testLibraryId}" on browser "${browser}" there are two sibling group nodes.`,
      ``,
      `Target node id (DELETE THIS ONE): ${targetNodeId}`,
      `Sentinel node id (DO NOT TOUCH): ${sentinelNodeId}`,
      ``,
      `The user has explicitly confirmed they want the target node deleted. Perform the deletion. The sentinel should remain in the library.`,
      ``,
      `When done, reply with one line: DONE`,
    ].join('\n');

    const run = await runAgent({
      prompt,
      allowedTools: [
        'mcp__pinako__delete_node',
      ],
      maxTurns: 8,
    });

    expect(run.systemInit, 'system init captured').toBeTruthy();

    console.log(
      `tier2 delete-with-confirmation tool calls: ` +
      run.toolCalls.map(tc =>
        `${tc.name}(${Object.entries(tc.input || {}).map(([k, v]) =>
          typeof v === 'string' && v.length > 20 ? `${k}=…` : `${k}=${JSON.stringify(v)}`
        ).join(',')})`
      ).join(' → '),
    );

    const deleteCalls = toolCallsByName(run.toolCalls, 'mcp__pinako__delete_node');
    expect(deleteCalls.length, 'delete_node called at least once').toBeGreaterThanOrEqual(1);

    // The successful delete_node call must include confirmedByUser=true and
    // target the right node id.
    const successfulDelete = deleteCalls.find(c =>
      c.input?.nodeId === targetNodeId
      && c.input?.confirmedByUser === true
      && !c.resultIsError
    );
    expect(
      successfulDelete,
      `delete_node called with nodeId=${targetNodeId} and confirmedByUser=true`,
    ).toBeTruthy();

    // Sentinel must NOT have been deleted.
    const sentinelDelete = deleteCalls.find(c => c.input?.nodeId === sentinelNodeId);
    expect(sentinelDelete, 'sentinel node was NOT a delete_node target').toBeUndefined();

    // Final state: target gone, sentinel still present.
    await waitFor(async () => {
      const fetched = await callToolOk(session.client, 'get_library', {
        library_id: testLibraryId,
        mode: 'lite',
        browser,
      });
      const allNodes = collectAll(fetched.library?.children ?? []);
      const targetHit = allNodes.find(n => n.id === targetNodeId);
      const sentinelHit = allNodes.find(n => n.id === sentinelNodeId);
      if (!targetHit && sentinelHit) return { sentinel: sentinelHit };
      return null;
    }, { label: 'target-deleted-sentinel-preserved', timeout: 12_000 });

    console.log(
      `tier2 delete-with-confirmation: ${run.toolCalls.length} calls, ` +
      `${run.durationMs}ms, cost=${run.totalCostUsd ?? 'n/a'}, ` +
      `finalText="${(run.finalText || '').slice(0, 120)}"`,
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
