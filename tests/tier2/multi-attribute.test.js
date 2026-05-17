import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { runAgent, toolCallsByName } from './helpers/agent-runner.js';
import { connectPinakoMcp, callToolOk, waitFor } from '../helpers/mcp-client.js';
import { resolveTargetBrowser } from '../helpers/browser.js';
import { testLabel } from '../helpers/fixtures.js';

// Tier 2: probes the agent's ability to compose THREE different
// annotation ops (set_title, set_memo, add_tags) on a single target
// node. Each maps to a distinct tool; the agent must pick the right
// tool for each phrase in the prompt — "rename" → set_title,
// "add a memo" → set_memo, "tag with" → add_tags.
//
// Per the bulk_apply description's "4 or more" rule (Batch 9.6), at 3
// targets we expect individual calls — not bulk_apply — even though
// these are technically three ops on a single node. The agent should
// NOT reach for bulk_apply at N=3.

const HAS_OAUTH = !!process.env.CLAUDE_CODE_OAUTH_TOKEN;
const HAS_API_KEY = !!process.env.ANTHROPIC_API_KEY;
const TIER2_RUNNABLE = HAS_OAUTH && !HAS_API_KEY;
const TEST_TIMEOUT_MS = 180_000;

describe.skipIf(!TIER2_RUNNABLE)('Tier 2 agent — compose 3 annotation ops on one node', () => {
  let session;
  let browser;
  let testGroupId;
  let testLibraryId;
  let targetNodeId;

  beforeAll(async () => {
    session = await connectPinakoMcp();
    browser = await resolveTargetBrowser(session.client);

    const group = await callToolOk(session.client, 'create_library_group', {
      title: testLabel('tier2-multi-attr-group'),
      browser,
    });
    testGroupId = group.result.createdGroupId;

    const lib = await callToolOk(session.client, 'create_library', {
      title: testLabel('tier2-multi-attr-lib'),
      browser,
    });
    testLibraryId = lib.result.createdLibraryId;

    await callToolOk(session.client, 'add_library_to_group', {
      groupId: testGroupId,
      libraryId: testLibraryId,
      browser,
    });

    const seed = await callToolOk(session.client, 'create_group', {
      title: testLabel('tier2-multi-attr-original'),
      scope: 'library',
      libraryId: testLibraryId,
      browser,
    });
    targetNodeId = seed.result.createdId;
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

  it('agent sets title, memo, and tag on the same node — three distinct tools', async () => {
    const newTitle = testLabel('tier2-multi-attr-renamed');
    const memoText = 'follow-up: 2026-Q2 review';
    const tagLabel = 'follow-up';

    const prompt = [
      `Annotate a single node in library "${testLibraryId}" on browser "${browser}".`,
      ``,
      `Target node id: ${targetNodeId}`,
      ``,
      `Make three distinct annotations on this node:`,
      `1. Rename it to: "${newTitle}"`,
      `2. Attach a short memo saying: "${memoText}"`,
      `3. Tag it with: "${tagLabel}"`,
      ``,
      `Use the right Pinako tool for each step.`,
      ``,
      `When done, reply with one line: DONE`,
    ].join('\n');

    const run = await runAgent({
      prompt,
      // bulk_apply is also exposed; the agent should NOT reach for it
      // at 3 calls (below the "4 or more" threshold in the description).
      allowedTools: [
        'mcp__pinako__set_title',
        'mcp__pinako__set_memo',
        'mcp__pinako__add_tags',
        'mcp__pinako__bulk_apply',
      ],
      maxTurns: 10,
    });

    expect(run.systemInit, 'system init captured').toBeTruthy();

    console.log(
      `tier2 multi-attribute tool calls: ` +
      run.toolCalls.map(tc => `${tc.name}(${Object.keys(tc.input || {}).join(',')})`).join(' → '),
    );

    const titleCalls = toolCallsByName(run.toolCalls, 'mcp__pinako__set_title');
    const memoCalls = toolCallsByName(run.toolCalls, 'mcp__pinako__set_memo');
    const tagCalls = toolCallsByName(run.toolCalls, 'mcp__pinako__add_tags');
    const bulkCalls = toolCallsByName(run.toolCalls, 'mcp__pinako__bulk_apply');

    expect(titleCalls.length, 'set_title called').toBeGreaterThanOrEqual(1);
    expect(memoCalls.length, 'set_memo called').toBeGreaterThanOrEqual(1);
    expect(tagCalls.length, 'add_tags called').toBeGreaterThanOrEqual(1);

    // At 3 ops, the bulk_apply threshold (4 or more) says DON'T bulk.
    // The agent should have used 3 individual tool calls. If it reached
    // for bulk_apply, that's a description-quality regression worth
    // flagging here.
    expect(
      bulkCalls.length,
      `agent did NOT use bulk_apply for 3 ops (below "4 or more" threshold). Got bulk=${bulkCalls.length}.`,
    ).toBe(0);

    const errored = run.toolCalls.filter(tc => tc.resultIsError);
    expect(errored, `no errored tool calls (got: ${errored.map(t => t.name).join(', ')})`).toEqual([]);

    // Final state: node has the new title, the memo, and the tag.
    const finalNode = await waitFor(async () => {
      const fetched = await callToolOk(session.client, 'get_library', {
        library_id: testLibraryId,
        mode: 'full',
        browser,
      });
      const node = findNode(fetched.library?.children ?? [], targetNodeId);
      if (!node) return null;
      const hasTitle = node.title === newTitle;
      const hasMemo = (node.memoText || '').includes('follow-up: 2026-Q2 review');
      const hasTag = (node.tags ?? []).includes(tagLabel);
      return (hasTitle && hasMemo && hasTag) ? node : null;
    }, { label: 'node-fully-annotated', timeout: 12_000 });

    expect(finalNode.title).toBe(newTitle);
    expect(finalNode.memoText).toContain('follow-up: 2026-Q2 review');
    expect(finalNode.tags).toContain(tagLabel);

    console.log(
      `tier2 multi-attribute: ${run.toolCalls.length} calls, ${run.durationMs}ms, ` +
      `cost=${run.totalCostUsd ?? 'n/a'}, title="${finalNode.title.slice(0, 40)}", ` +
      `memo="${(finalNode.memoText || '').slice(0, 40)}", tags=${JSON.stringify(finalNode.tags)}`,
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
