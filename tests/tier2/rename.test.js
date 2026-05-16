import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { runAgent, toolCallsByName } from './helpers/agent-runner.js';
import { connectPinakoMcp, callToolOk, waitFor } from '../helpers/mcp-client.js';
import { resolveTargetBrowser } from '../helpers/browser.js';
import { testLabel } from '../helpers/fixtures.js';

// Tier 2: probes the agent's ability to find `set_title` for a "rename"
// verb. The description is one sentence; the prompt uses plain English
// ("rename"). Failure modes worth distinguishing: (a) agent picks a
// different tool (unlikely with only set_title allowed), (b) agent
// fails to find any tool and gives up, (c) agent calls set_title but
// with wrong scope/libraryId for the library-scope case.

const HAS_OAUTH = !!process.env.CLAUDE_CODE_OAUTH_TOKEN;
const HAS_API_KEY = !!process.env.ANTHROPIC_API_KEY;
const TIER2_RUNNABLE = HAS_OAUTH && !HAS_API_KEY;
const TEST_TIMEOUT_MS = 180_000;

describe.skipIf(!TIER2_RUNNABLE)('Tier 2 agent — rename (set_title discoverability)', () => {
  let session;
  let browser;
  let testGroupId;
  let testLibraryId;
  let targetNodeId;
  let originalTitle;

  beforeAll(async () => {
    session = await connectPinakoMcp();
    browser = await resolveTargetBrowser(session.client);

    const group = await callToolOk(session.client, 'create_library_group', {
      title: testLabel('tier2-rename-group'),
      browser,
    });
    testGroupId = group.result.createdGroupId;

    const lib = await callToolOk(session.client, 'create_library', {
      title: testLabel('tier2-rename-lib'),
      browser,
    });
    testLibraryId = lib.result.createdLibraryId;

    await callToolOk(session.client, 'add_library_to_group', {
      groupId: testGroupId,
      libraryId: testLibraryId,
      browser,
    });

    originalTitle = testLabel('tier2-rename-target-original');
    const seed = await callToolOk(session.client, 'create_group', {
      title: originalTitle,
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

  it('agent renames a node when asked using everyday "rename" language', async () => {
    const newTitle = testLabel('tier2-rename-target-renamed');

    const prompt = [
      `Use the Pinako MCP tools to rename a node in library "${testLibraryId}" on browser "${browser}".`,
      ``,
      `Target node id: ${targetNodeId}`,
      `New title: "${newTitle}"`,
      ``,
      `When done, reply with one line: DONE`,
    ].join('\n');

    const run = await runAgent({
      prompt,
      allowedTools: [
        'mcp__pinako__set_title',
      ],
      maxTurns: 6,
    });

    expect(run.systemInit, 'system init captured').toBeTruthy();

    console.log(
      `tier2 rename tool calls: ` +
      run.toolCalls.map(tc => `${tc.name}(${Object.keys(tc.input || {}).join(',')})`).join(' → '),
    );

    const titleCalls = toolCallsByName(run.toolCalls, 'mcp__pinako__set_title');
    expect(titleCalls.length, 'set_title called').toBeGreaterThanOrEqual(1);

    const errored = run.toolCalls.filter(tc => tc.resultIsError);
    expect(errored, `no errored tool calls (got: ${errored.map(t => t.name).join(', ')})`).toEqual([]);

    // Verify the rename actually took effect (scope: 'library' + libraryId
    // are required for library-scope renames; the agent must include
    // those, not just nodeId).
    const renamed = await waitFor(async () => {
      const fetched = await callToolOk(session.client, 'get_library', {
        library_id: testLibraryId,
        mode: 'lite',
        browser,
      });
      const node = findNode(fetched.library?.children ?? [], targetNodeId);
      if (!node) return null;
      return node.title === newTitle ? node : null;
    }, { label: 'node-renamed', timeout: 12_000 });

    expect(renamed.title).toBe(newTitle);
    expect(renamed.title).not.toBe(originalTitle);

    console.log(
      `tier2 rename: ${run.toolCalls.length} calls, ${run.durationMs}ms, ` +
      `cost=${run.totalCostUsd ?? 'n/a'}, finalTitle="${renamed.title}"`,
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
