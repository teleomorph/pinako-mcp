import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { connectPinakoMcp, callTool, callToolOk, waitFor } from './helpers/mcp-client.js';
import { resolveTargetBrowser } from './helpers/browser.js';
import { testLabel } from './helpers/fixtures.js';

// Verifies bulk_apply composition semantics:
//   - inherits scope/libraryId from outer to sub-ops that omit them
//   - applies all sub-ops atomically when valid
//   - reports subOpIndex on failure
//   - rolls back the whole batch on any sub-op failure (mutative draft pattern)

let session;
let browser;
let testGroupId;
let testLibraryId;

beforeAll(async () => {
  session = await connectPinakoMcp();
  browser = await resolveTargetBrowser(session.client);

  const group = await callToolOk(session.client, 'create_library_group', {
    title: testLabel('bulk-suite'),
    browser,
  });
  testGroupId = group.result.createdGroupId;

  const lib = await callToolOk(session.client, 'create_library', {
    title: testLabel('bulk-lib'),
    browser,
  });
  testLibraryId = lib.result.createdLibraryId;

  await callToolOk(session.client, 'add_library_to_group', {
    groupId: testGroupId,
    libraryId: testLibraryId,
    browser,
  });
});

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
});

async function makeGroup(suffix) {
  const grp = await callToolOk(session.client, 'create_group', {
    title: testLabel(suffix),
    scope: 'library',
    libraryId: testLibraryId,
    browser,
  });
  const nodeId = grp.result.createdId;
  await waitFor(async () => {
    const n = await findNodeInLibrary(nodeId);
    return n ? n : null;
  }, { label: `make-group-visible-${suffix}` });
  return nodeId;
}

async function findNodeInLibrary(nodeId) {
  const fetched = await callToolOk(session.client, 'get_library', {
    library_id: testLibraryId,
    mode: 'lite',
    browser,
  });
  return findById(fetched.library.children || [], nodeId);
}

function findById(nodes, id) {
  for (const n of nodes) {
    if (n.id === id) return n;
    if (Array.isArray(n.children)) {
      const hit = findById(n.children, id);
      if (hit) return hit;
    }
  }
  return null;
}

describe('bulk_apply composition', () => {
  it('applies multiple sub-ops with outer scope inheritance', async () => {
    const targetNodeId = await makeGroup('bulk-target');
    const newTitle = testLabel('bulk-renamed');

    await callToolOk(session.client, 'bulk_apply', {
      ops: [
        { type: 'set_title', nodeId: targetNodeId, title: newTitle },
        { type: 'set_tags', nodeId: targetNodeId, tags: ['bulk-a', 'bulk-b'] },
      ],
      scope: 'library',
      libraryId: testLibraryId,
      browser,
    });

    const node = await waitFor(async () => {
      const n = await findNodeInLibrary(targetNodeId);
      if (!n) return null;
      const titleMatches = n.title === newTitle;
      const tagsMatch = arraysEqual((n.tags || []).slice().sort(), ['bulk-a', 'bulk-b']);
      return (titleMatches && tagsMatch) ? n : null;
    }, { label: 'bulk-both-effects-applied' });

    expect(node.title).toBe(newTitle);
    expect((node.tags || []).slice().sort()).toEqual(['bulk-a', 'bulk-b']);
  });

  it('reports subOpIndex on failure and rolls back prior sub-ops', async () => {
    const targetNodeId = await makeGroup('bulk-rollback');
    const originalNode = await findNodeInLibrary(targetNodeId);
    const originalTitle = originalNode.title;
    const wouldBeTitle = testLabel('bulk-should-not-stick');

    const result = await callTool(session.client, 'bulk_apply', {
      ops: [
        { type: 'set_title', nodeId: targetNodeId, title: wouldBeTitle },
        { type: 'set_tags', nodeId: 'node-does-not-exist', tags: ['will-fail'] },
      ],
      scope: 'library',
      libraryId: testLibraryId,
      browser,
    });

    expect(result.isError).toBe(true);
    expect(result.parsed?.ok).toBe(false);
    // NB: sub-op runtime failures use `error.context.index` (not `subOpIndex`,
    // which is used only by the bridge-boundary CONFIRMATION_REQUIRED check).
    // SERVER_INSTRUCTIONS doc says `subOpIndex` for both — API inconsistency
    // tracked in agentic-ai-followups.md.
    expect(result.parsed?.error?.context?.index).toBe(1);
    expect(result.parsed?.error?.context?.subError?.code).toBe('NODE_NOT_FOUND');
    expect(result.parsed?.error?.message).toContain('Sub-op 1');

    await new Promise(r => setTimeout(r, 1500));
    const after = await findNodeInLibrary(targetNodeId);
    expect(after.title).toBe(originalTitle);
    expect(after.title).not.toBe(wouldBeTitle);
  });
});

function arraysEqual(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}
