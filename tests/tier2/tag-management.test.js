import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { runAgent, toolCallsByName } from './helpers/agent-runner.js';
import { connectPinakoMcp, callToolOk, waitFor } from '../helpers/mcp-client.js';
import { resolveTargetBrowser } from '../helpers/browser.js';
import { testLabel } from '../helpers/fixtures.js';

// Tier 2: probes the agent's understanding of additive vs subtractive
// tag operations. The agent has a target node and a sequence of
// instructions: add two tags, then remove one. It must pick
// `add_tags` (not `set_tags`, which would clobber) and then `remove_tags`
// (not `set_tags` with a smaller list). A failure means the descriptions
// for set/add/remove_tags are not discriminating clearly enough.

const HAS_OAUTH = !!process.env.CLAUDE_CODE_OAUTH_TOKEN;
const HAS_API_KEY = !!process.env.ANTHROPIC_API_KEY;
const TIER2_RUNNABLE = HAS_OAUTH && !HAS_API_KEY;
const TEST_TIMEOUT_MS = 180_000;

describe.skipIf(!TIER2_RUNNABLE)('Tier 2 agent — tag management (additive then subtractive)', () => {
  let session;
  let browser;
  let testGroupId;
  let testLibraryId;
  let targetNodeId;

  beforeAll(async () => {
    session = await connectPinakoMcp();
    browser = await resolveTargetBrowser(session.client);

    const group = await callToolOk(session.client, 'create_library_group', {
      title: testLabel('tier2-tag-group'),
      browser,
    });
    testGroupId = group.result.createdGroupId;

    const lib = await callToolOk(session.client, 'create_library', {
      title: testLabel('tier2-tag-lib'),
      browser,
    });
    testLibraryId = lib.result.createdLibraryId;

    await callToolOk(session.client, 'add_library_to_group', {
      groupId: testGroupId,
      libraryId: testLibraryId,
      browser,
    });

    const seedGroup = await callToolOk(session.client, 'create_group', {
      title: testLabel('tier2-tag-target'),
      scope: 'library',
      libraryId: testLibraryId,
      browser,
    });
    targetNodeId = seedGroup.result.createdId;
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

  it('agent adds two tags, then removes one — final tag set has the remaining one', async () => {
    const prompt = [
      `Use the Pinako MCP tools to manage tags on a node in library "${testLibraryId}" on browser "${browser}".`,
      ``,
      `Target node id: ${targetNodeId}`,
      ``,
      `Steps:`,
      `1. Add the tags "alpha" and "beta" to that node. (The node currently has no tags; these should be added, not used to replace.)`,
      `2. Remove the tag "alpha" from the same node. (The tag "beta" should remain.)`,
      ``,
      `When done, reply with one line: DONE`,
    ].join('\n');

    const run = await runAgent({
      prompt,
      allowedTools: [
        'mcp__pinako__add_tags',
        'mcp__pinako__remove_tags',
      ],
      maxTurns: 10,
    });

    expect(run.systemInit, 'system init captured').toBeTruthy();

    const addCalls = toolCallsByName(run.toolCalls, 'mcp__pinako__add_tags');
    const removeCalls = toolCallsByName(run.toolCalls, 'mcp__pinako__remove_tags');
    expect(addCalls.length, 'add_tags called at least once').toBeGreaterThanOrEqual(1);
    expect(removeCalls.length, 'remove_tags called at least once').toBeGreaterThanOrEqual(1);

    const errored = run.toolCalls.filter(tc => tc.resultIsError);
    expect(errored, `no errored tool calls (got: ${errored.map(t => t.name).join(', ')})`).toEqual([]);

    // Final state: tags = ['beta']. Order doesn't matter, presence does.
    const finalTags = await waitFor(async () => {
      const fetched = await callToolOk(session.client, 'get_library', {
        library_id: testLibraryId,
        mode: 'full',
        browser,
      });
      const node = findNode(fetched.library?.children ?? [], targetNodeId);
      if (!node) return null;
      const tags = node.tags ?? [];
      if (tags.includes('beta') && !tags.includes('alpha')) return tags;
      return null;
    }, { label: 'final-tags-beta-only', timeout: 12_000 });

    expect(finalTags).toContain('beta');
    expect(finalTags).not.toContain('alpha');

    console.log(
      `tier2 tag-management: ${run.toolCalls.length} calls, ${run.durationMs}ms, ` +
      `model=${run.systemInit?.model}, cost=${run.totalCostUsd ?? 'n/a'}, ` +
      `finalTags=${JSON.stringify(finalTags)}`,
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
