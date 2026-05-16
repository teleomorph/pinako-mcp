import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { runAgent, toolCallsByName } from './helpers/agent-runner.js';
import { connectPinakoMcp, callToolOk, waitFor } from '../helpers/mcp-client.js';
import { resolveTargetBrowser } from '../helpers/browser.js';
import { testLabel } from '../helpers/fixtures.js';

// Tier 2: probes the agent's discrimination of two per-node annotation
// surfaces. set_memo writes a short plain-text annotation (max 2500
// chars, stored as node.memoText); add_tags appends label strings to
// node.tags. The descriptions explicitly point at each other ("for
// richer rich-text documents use create_note...") but the prompt here
// uses everyday phrasing — "note" and "label" — to see if Haiku 4.5
// picks the right tool for each.
//
// Failure modes worth distinguishing: (a) agent uses set_memo for the
// label too (treats both as plain text), (b) agent uses add_tags for
// the memo content (treats both as labels), (c) errored call.

const HAS_OAUTH = !!process.env.CLAUDE_CODE_OAUTH_TOKEN;
const HAS_API_KEY = !!process.env.ANTHROPIC_API_KEY;
const TIER2_RUNNABLE = HAS_OAUTH && !HAS_API_KEY;
const TEST_TIMEOUT_MS = 180_000;

describe.skipIf(!TIER2_RUNNABLE)('Tier 2 agent — memo + tags (per-node annotation surfaces)', () => {
  let session;
  let browser;
  let testGroupId;
  let testLibraryId;
  let targetNodeId;

  beforeAll(async () => {
    session = await connectPinakoMcp();
    browser = await resolveTargetBrowser(session.client);

    const group = await callToolOk(session.client, 'create_library_group', {
      title: testLabel('tier2-memo-group'),
      browser,
    });
    testGroupId = group.result.createdGroupId;

    const lib = await callToolOk(session.client, 'create_library', {
      title: testLabel('tier2-memo-lib'),
      browser,
    });
    testLibraryId = lib.result.createdLibraryId;

    await callToolOk(session.client, 'add_library_to_group', {
      groupId: testGroupId,
      libraryId: testLibraryId,
      browser,
    });

    const seed = await callToolOk(session.client, 'create_group', {
      title: testLabel('tier2-memo-target'),
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

  it('agent adds a short note (memo) AND a category label (tag) on the same node', async () => {
    const memoText = 'reviewed 2026, ready to archive';
    const tagLabel = 'reviewed';

    const prompt = [
      `Use the Pinako MCP tools to annotate a node in library "${testLibraryId}" on browser "${browser}".`,
      ``,
      `Target node id: ${targetNodeId}`,
      ``,
      `Make TWO distinct annotations on this node:`,
      `1. Attach a short plain-text note to it that says exactly: "${memoText}"`,
      `2. Categorize it with the label "${tagLabel}"`,
      ``,
      `Each annotation should land on the node correctly using whichever Pinako tool fits its purpose.`,
      ``,
      `When done, reply with one line: DONE`,
    ].join('\n');

    const run = await runAgent({
      prompt,
      allowedTools: [
        'mcp__pinako__set_memo',
        'mcp__pinako__add_tags',
      ],
      maxTurns: 10,
    });

    expect(run.systemInit, 'system init captured').toBeTruthy();

    console.log(
      `tier2 memo-and-tags tool calls: ` +
      run.toolCalls.map(tc => `${tc.name}(${Object.keys(tc.input || {}).join(',')})`).join(' → '),
    );

    const memoCalls = toolCallsByName(run.toolCalls, 'mcp__pinako__set_memo');
    const tagCalls = toolCallsByName(run.toolCalls, 'mcp__pinako__add_tags');

    expect(memoCalls.length, 'set_memo called for the plain-text note').toBeGreaterThanOrEqual(1);
    expect(tagCalls.length, 'add_tags called for the category label').toBeGreaterThanOrEqual(1);

    const errored = run.toolCalls.filter(tc => tc.resultIsError);
    expect(errored, `no errored tool calls (got: ${errored.map(t => t.name).join(', ')})`).toEqual([]);

    // Final state: node has both memo and tag.
    const finalNode = await waitFor(async () => {
      const fetched = await callToolOk(session.client, 'get_library', {
        library_id: testLibraryId,
        mode: 'full',
        browser,
      });
      const node = findNode(fetched.library?.children ?? [], targetNodeId);
      if (!node) return null;
      const hasMemo = (node.memoText || '').includes('reviewed 2026');
      const hasTag = (node.tags ?? []).includes(tagLabel);
      return (hasMemo && hasTag) ? node : null;
    }, { label: 'node-has-memo-and-tag', timeout: 12_000 });

    expect(finalNode.memoText).toContain('reviewed 2026');
    expect(finalNode.tags).toContain(tagLabel);

    console.log(
      `tier2 memo-and-tags: ${run.toolCalls.length} calls, ${run.durationMs}ms, ` +
      `cost=${run.totalCostUsd ?? 'n/a'}, memo="${(finalNode.memoText || '').slice(0, 60)}", ` +
      `tags=${JSON.stringify(finalNode.tags)}`,
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
