import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { connectPinakoMcp, callToolOk, waitFor } from './helpers/mcp-client.js';
import { resolveTargetBrowser } from './helpers/browser.js';
import { testLabel } from './helpers/fixtures.js';

// Verifies tree-structure ops within a library scope:
// move_node, indent_node, outdent_node, create_folder.

let session;
let browser;
let testGroupId;
let testLibraryId;

beforeAll(async () => {
  session = await connectPinakoMcp();
  browser = await resolveTargetBrowser(session.client);

  const group = await callToolOk(session.client, 'create_library_group', {
    title: testLabel('structure-suite'),
    browser,
  });
  testGroupId = group.result.createdGroupId;

  const lib = await callToolOk(session.client, 'create_library', {
    title: testLabel('structure-lib'),
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

async function makeGroup(suffix, parentId) {
  const args = {
    title: testLabel(suffix),
    scope: 'library',
    libraryId: testLibraryId,
    browser,
  };
  if (parentId !== undefined) args.parentId = parentId;
  const grp = await callToolOk(session.client, 'create_group', args);
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

async function findParentOf(targetId) {
  const fetched = await callToolOk(session.client, 'get_library', {
    library_id: testLibraryId,
    mode: 'lite',
    browser,
  });
  return findParentRecursive(fetched.library.children || [], null, targetId);
}

function findParentRecursive(nodes, parentId, targetId) {
  for (const n of nodes) {
    if (n.id === targetId) return parentId;
    if (Array.isArray(n.children)) {
      const hit = findParentRecursive(n.children, n.id, targetId);
      if (hit !== undefined) return hit;
    }
  }
  return undefined;
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

describe('move_node', () => {
  it('moves a group from one parent into another', async () => {
    const parentA = await makeGroup('move-parentA');
    const parentB = await makeGroup('move-parentB');
    const child = await makeGroup('move-child', parentA);

    const initialParent = await findParentOf(child);
    expect(initialParent).toBe(parentA);

    await callToolOk(session.client, 'move_node', {
      nodeId: child,
      newParentId: parentB,
      scope: 'library',
      libraryId: testLibraryId,
      browser,
    });

    const newParent = await waitFor(async () => {
      const p = await findParentOf(child);
      return p === parentB ? p : null;
    }, { label: 'move_node-applied' });
    expect(newParent).toBe(parentB);
  });
});

describe('indent_node', () => {
  it('nests a node under its previous sibling', async () => {
    // create_group defaults to position: TOP. So the SECOND-created node
    // ends up at position 0 (visually first), and the FIRST-created node
    // gets pushed to position 1 (visually second). To indent something
    // under its prior sibling, we indent the FIRST-created node.
    const willBeBelow = await makeGroup('indent-below');  // ends at pos 1
    const willBeAbove = await makeGroup('indent-above');  // ends at pos 0

    const initial = await findParentOf(willBeBelow);
    expect(initial).toBe(null);

    await callToolOk(session.client, 'indent_node', {
      nodeId: willBeBelow,
      scope: 'library',
      libraryId: testLibraryId,
      browser,
    });

    const newParent = await waitFor(async () => {
      const p = await findParentOf(willBeBelow);
      return p === willBeAbove ? p : null;
    }, { label: 'indent_node-applied' });
    expect(newParent).toBe(willBeAbove);
  });
});

describe('outdent_node', () => {
  it('promotes a child to its grandparent level', async () => {
    const grandparent = await makeGroup('outdent-grandparent');
    const child = await makeGroup('outdent-child', grandparent);

    const initial = await findParentOf(child);
    expect(initial).toBe(grandparent);

    await callToolOk(session.client, 'outdent_node', {
      nodeId: child,
      scope: 'library',
      libraryId: testLibraryId,
      browser,
    });

    const result = await waitFor(async () => {
      const p = await findParentOf(child);
      // p === null means the child is now at library root (outdent succeeded).
      // Return a marker so waitFor sees truthy. p === grandparent means
      // outdent hasn't propagated yet (keep waiting).
      return p === null ? 'outdented-to-root' : null;
    }, { label: 'outdent_node-applied' });
    expect(result).toBe('outdented-to-root');
  });
});

describe('create_folder', () => {
  it('creates a folder inside a library at the root', async () => {
    const folderTitle = testLabel('folder-target');
    const result = await callToolOk(session.client, 'create_folder', {
      title: folderTitle,
      scope: 'library',
      libraryId: testLibraryId,
      browser,
    });
    const folderId = result.result.createdId;
    expect(folderId).toBeTruthy();

    const folder = await waitFor(async () => {
      const n = await findNodeInLibrary(folderId);
      return n?.title === folderTitle ? n : null;
    }, { label: 'create_folder-visible' });
    // In library scope, folder type is 'library-folder' (vs 'folder' in
    // bookmarks scope). Accept either to be tolerant if the engine
    // canonicalizes the name later.
    expect(['folder', 'library-folder']).toContain(folder.type);
    expect(folder.title).toBe(folderTitle);
  });
});
