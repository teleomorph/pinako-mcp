import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { connectPinakoMcp, callToolOk, waitFor } from './helpers/mcp-client.js';
import { resolveTargetBrowser } from './helpers/browser.js';
import { testLabel } from './helpers/fixtures.js';

let session;
let browser;
let testGroupId;
let testLibraryId;

beforeAll(async () => {
  session = await connectPinakoMcp();
  browser = await resolveTargetBrowser(session.client);

  const group = await callToolOk(session.client, 'create_library_group', {
    title: testLabel('tags-suite'),
    browser,
  });
  testGroupId = group.result.createdGroupId;

  const lib = await callToolOk(session.client, 'create_library', {
    title: testLabel('tags-lib'),
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

async function findNodeInLibrary(nodeId) {
  const fetched = await callToolOk(session.client, 'get_library', {
    library_id: testLibraryId,
    mode: 'full',
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

describe('set_tags / add_tags / remove_tags (library scope)', () => {
  it('sets, appends, and removes tags on a node, round-trips via get_library', async () => {
    const groupNode = await callToolOk(session.client, 'create_group', {
      title: testLabel('tag-target'),
      scope: 'library',
      libraryId: testLibraryId,
      browser,
    });
    const nodeId = groupNode.result.createdId;
    expect(nodeId).toBeTruthy();

    await callToolOk(session.client, 'set_tags', {
      nodeId,
      tags: ['alpha', 'beta'],
      scope: 'library',
      libraryId: testLibraryId,
      browser,
    });
    let n = await waitFor(async () => {
      const node = await findNodeInLibrary(nodeId);
      return arraysEqual(node?.tags?.slice().sort(), ['alpha', 'beta']) ? node : null;
    }, { label: 'set_tags-applied' });
    expect(n.tags.slice().sort()).toEqual(['alpha', 'beta']);

    await callToolOk(session.client, 'add_tags', {
      nodeId,
      tags: ['gamma', 'alpha'],
      scope: 'library',
      libraryId: testLibraryId,
      browser,
    });
    n = await waitFor(async () => {
      const node = await findNodeInLibrary(nodeId);
      return arraysEqual(node?.tags?.slice().sort(), ['alpha', 'beta', 'gamma']) ? node : null;
    }, { label: 'add_tags-applied' });
    expect(n.tags.slice().sort()).toEqual(['alpha', 'beta', 'gamma']);

    await callToolOk(session.client, 'remove_tags', {
      nodeId,
      tags: ['beta', 'nonexistent'],
      scope: 'library',
      libraryId: testLibraryId,
      browser,
    });
    n = await waitFor(async () => {
      const node = await findNodeInLibrary(nodeId);
      return arraysEqual(node?.tags?.slice().sort(), ['alpha', 'gamma']) ? node : null;
    }, { label: 'remove_tags-applied' });
    expect(n.tags.slice().sort()).toEqual(['alpha', 'gamma']);

    await callToolOk(session.client, 'set_tags', {
      nodeId,
      tags: [],
      scope: 'library',
      libraryId: testLibraryId,
      browser,
    });
    n = await waitFor(async () => {
      const node = await findNodeInLibrary(nodeId);
      return (node?.tags?.length ?? 0) === 0 ? node : null;
    }, { label: 'set_tags-clear' });
    expect(n.tags ?? []).toEqual([]);
  });
});

function arraysEqual(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}
