import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { runAgent, toolCallsByName } from './helpers/agent-runner.js';
import { connectPinakoMcp, callToolOk, waitFor } from '../helpers/mcp-client.js';
import { resolveTargetBrowser } from '../helpers/browser.js';
import { testLabel } from '../helpers/fixtures.js';

// Tier 2: probes tree-restructuring within library scope. The library
// has two parent groups (A and B) and a child group (C) initially
// inside A. The prompt asks the agent to move C from A into B.
//
// The agent must pick move_node, pass nodeId=C, newParentId=B (NOT A,
// not null/root), scope='library', libraryId=L. Wrong newParentId or
// missing scope would fail or land the node in the wrong spot.

const HAS_OAUTH = !!process.env.CLAUDE_CODE_OAUTH_TOKEN;
const HAS_API_KEY = !!process.env.ANTHROPIC_API_KEY;
const TIER2_RUNNABLE = HAS_OAUTH && !HAS_API_KEY;
const TEST_TIMEOUT_MS = 180_000;

describe.skipIf(!TIER2_RUNNABLE)('Tier 2 agent — move_node within library', () => {
  let session;
  let browser;
  let testGroupId;
  let testLibraryId;
  let parentAId;
  let parentBId;
  let childId;
  let parentATitle;
  let parentBTitle;
  let childTitle;

  beforeAll(async () => {
    session = await connectPinakoMcp();
    browser = await resolveTargetBrowser(session.client);

    const group = await callToolOk(session.client, 'create_library_group', {
      title: testLabel('tier2-move-group'),
      browser,
    });
    testGroupId = group.result.createdGroupId;

    const lib = await callToolOk(session.client, 'create_library', {
      title: testLabel('tier2-move-lib'),
      browser,
    });
    testLibraryId = lib.result.createdLibraryId;

    await callToolOk(session.client, 'add_library_to_group', {
      groupId: testGroupId,
      libraryId: testLibraryId,
      browser,
    });

    parentATitle = testLabel('tier2-move-parent-A');
    const parentA = await callToolOk(session.client, 'create_group', {
      title: parentATitle,
      scope: 'library',
      libraryId: testLibraryId,
      browser,
    });
    parentAId = parentA.result.createdId;

    parentBTitle = testLabel('tier2-move-parent-B');
    const parentB = await callToolOk(session.client, 'create_group', {
      title: parentBTitle,
      scope: 'library',
      libraryId: testLibraryId,
      browser,
    });
    parentBId = parentB.result.createdId;

    childTitle = testLabel('tier2-move-child');
    const child = await callToolOk(session.client, 'create_group', {
      title: childTitle,
      scope: 'library',
      libraryId: testLibraryId,
      browser,
    });
    childId = child.result.createdId;

    // Park the child inside parent A (so we have a real "move from A to B").
    await callToolOk(session.client, 'move_node', {
      nodeId: childId,
      newParentId: parentAId,
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

  it('agent moves a child node from parent A into parent B', async () => {
    const prompt = [
      `In library "${testLibraryId}" on browser "${browser}" there are two parent groups (A and B), with a child node currently inside A.`,
      ``,
      `Parent A id (source — child is currently here): ${parentAId}`,
      `Parent B id (destination — move the child here): ${parentBId}`,
      `Child node id (to be moved): ${childId}`,
      ``,
      `Move the child from parent A into parent B. After the move, the child should be inside B's children, not A's.`,
      ``,
      `When done, reply with one line: DONE`,
    ].join('\n');

    const run = await runAgent({
      prompt,
      allowedTools: [
        'mcp__pinako__move_node',
      ],
      maxTurns: 8,
    });

    expect(run.systemInit, 'system init captured').toBeTruthy();

    console.log(
      `tier2 move-node tool calls: ` +
      run.toolCalls.map(tc =>
        `${tc.name}(${Object.entries(tc.input || {}).map(([k, v]) =>
          typeof v === 'string' && v.length > 25 ? `${k}=…` : `${k}=${JSON.stringify(v)}`
        ).join(',')})`
      ).join(' → '),
    );

    const moveCalls = toolCallsByName(run.toolCalls, 'mcp__pinako__move_node');
    expect(moveCalls.length, 'move_node called at least once').toBeGreaterThanOrEqual(1);

    // The successful move_node call must target the right child and the
    // right destination parent.
    const correctMove = moveCalls.find(c =>
      c.input?.nodeId === childId
      && c.input?.newParentId === parentBId
      && !c.resultIsError
    );
    expect(
      correctMove,
      `move_node called with nodeId=${childId}, newParentId=${parentBId}`,
    ).toBeTruthy();

    const errored = run.toolCalls.filter(tc => tc.resultIsError);
    expect(errored, `no errored tool calls (got: ${errored.map(t => t.name).join(', ')})`).toEqual([]);

    // Final state: child is inside B, not A.
    await waitFor(async () => {
      const fetched = await callToolOk(session.client, 'get_library', {
        library_id: testLibraryId,
        mode: 'lite',
        browser,
      });
      const parentA = findNode(fetched.library?.children ?? [], parentAId);
      const parentB = findNode(fetched.library?.children ?? [], parentBId);
      if (!parentA || !parentB) return null;
      const inA = (parentA.children ?? []).some(c => c.id === childId);
      const inB = (parentB.children ?? []).some(c => c.id === childId);
      return (inB && !inA) ? { parentA, parentB } : null;
    }, { label: 'child-moved-to-B', timeout: 12_000 });

    console.log(
      `tier2 move-node: ${run.toolCalls.length} calls, ${run.durationMs}ms, ` +
      `cost=${run.totalCostUsd ?? 'n/a'}, finalText="${(run.finalText || '').slice(0, 120)}"`,
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
