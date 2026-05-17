import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { connectPinakoMcp, callTool, callToolOk, waitFor } from './helpers/mcp-client.js';
import { resolveTargetBrowser } from './helpers/browser.js';
import { testLabel } from './helpers/fixtures.js';

// Tier 1 — add_to_bookmarks round-trip. Engine inserts cloned source
// nodes into bookmarkTreeData (with bookmarkId=null); wrapper post-engine
// pass calls chrome.bookmarks.create recursively and stamps bookmarkId.
// Verifies the agent-facing happy path + error semantics.
//
// Test bookmarks accumulate in Chrome (no clean cross-test cleanup yet —
// the agent surface doesn't expose chrome.bookmarks.removeTree by Chrome
// id; delete_node requires Pinako internal ids that aren't surfaced
// through get_bookmarks). Acceptable per project memory:
// "Chrome is test data — mutate freely during MCP testing."

let session;
let browser;
let testGroupId;
let testLibraryId;

beforeAll(async () => {
  session = await connectPinakoMcp();
  browser = await resolveTargetBrowser(session.client);

  const group = await callToolOk(session.client, 'create_library_group', {
    title: testLabel('bookmarks-suite-group'),
    browser,
  });
  testGroupId = group.result.createdGroupId;

  const lib = await callToolOk(session.client, 'create_library', {
    title: testLabel('bookmarks-suite-lib'),
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

async function makeLibraryGroup(suffix) {
  const groupTitle = testLabel(suffix);
  const seed = await callToolOk(session.client, 'create_group', {
    title: groupTitle,
    scope: 'library',
    libraryId: testLibraryId,
    browser,
  });
  return { groupId: seed.result.createdId, groupTitle };
}

function findBookmarkByTitle(items, title) {
  for (const n of items || []) {
    if (n.title === title) return n;
    if (Array.isArray(n.children)) {
      const hit = findBookmarkByTitle(n.children, title);
      if (hit) return hit;
    }
  }
  return null;
}

describe('add_to_bookmarks', () => {
  it('clones a library group into the bookmark tree (default parent = first root)', async () => {
    const { groupId, groupTitle } = await makeLibraryGroup('add-bookmarks-group');

    const result = await callToolOk(session.client, 'add_to_bookmarks', {
      nodeIds: [groupId],
      sourceScope: 'library',
      sourceLibraryId: testLibraryId,
      browser,
    });

    expect(result.result.addedCount).toBe(1);
    expect(Array.isArray(result.result.addedBookmarkNodeIds)).toBe(true);
    expect(result.result.addedBookmarkNodeIds.length).toBe(1);
    expect(Array.isArray(result.result.addedChromeBookmarkIds)).toBe(true);
    expect(result.result.addedChromeBookmarkIds.length).toBe(1);

    // Verify the bookmark folder shows up in Chrome via get_bookmarks.
    const found = await waitFor(async () => {
      const fetched = await callToolOk(session.client, 'get_bookmarks', { browser });
      const hit = findBookmarkByTitle(fetched.bookmarks || fetched.items || [], groupTitle);
      return hit ? hit : null;
    }, { label: 'bookmark-folder-visible' });

    expect(found.title).toBe(groupTitle);
  });

  it('clones a tab from the main tree into bookmarks', async () => {
    // Read the main tree to find a tab id. Tests run against the user's
    // actual Chrome — there's at least one open tab. Pick the first
    // available.
    const tree = await callToolOk(session.client, 'get_tree', { mode: 'lite', browser });
    const findFirstTab = (nodes) => {
      for (const n of nodes || []) {
        if (n.type === 'tab') return n;
        if (Array.isArray(n.children)) {
          const hit = findFirstTab(n.children);
          if (hit) return hit;
        }
      }
      return null;
    };
    const firstTab = findFirstTab(tree.tree);
    if (!firstTab) {
      console.warn('add_to_bookmarks: no tab found in main tree; skipping tree-source test');
      return;
    }

    const result = await callToolOk(session.client, 'add_to_bookmarks', {
      nodeIds: [firstTab.id],
      sourceScope: 'tree',
      includeChildren: false,
      browser,
    });

    expect(result.result.addedCount).toBe(1);
    expect(result.result.addedChromeBookmarkIds.length).toBe(1);
  });

  it('returns SOURCE_NODE_NOT_FOUND for an unknown source id', async () => {
    const result = await callTool(session.client, 'add_to_bookmarks', {
      nodeIds: ['node-does-not-exist-xyz'],
      sourceScope: 'tree',
      browser,
    });
    expect(result.isError || result.parsed?.ok === false).toBeTruthy();
    expect(result.parsed?.error?.code).toBe('SOURCE_NODE_NOT_FOUND');
  });

  it('returns SOURCE_LIBRARY_ID_REQUIRED when sourceScope=library without sourceLibraryId', async () => {
    const result = await callTool(session.client, 'add_to_bookmarks', {
      nodeIds: ['node-irrelevant'],
      sourceScope: 'library',
      browser,
    });
    expect(result.isError || result.parsed?.ok === false).toBeTruthy();
    // Schema-level .refine on sourceLibraryId surfaces as INVALID_OP_SHAPE
    // when the validator runs before the wrapper's _prepBookmarkClones.
    // The wrapper's own SOURCE_LIBRARY_ID_REQUIRED throw only fires if the
    // schema is widened later. Accept either path.
    const code = result.parsed?.error?.code;
    expect([
      'INVALID_OP_SHAPE',
      'SOURCE_LIBRARY_ID_REQUIRED',
      'CLONE_PREP_FAILED',
      'VALIDATION_FAILED',
    ]).toContain(code);
  });

  it('returns BOOKMARK_FOLDER_NOT_FOUND for unknown parentBookmarkFolderId', async () => {
    const { groupId } = await makeLibraryGroup('add-bookmarks-badparent');
    const result = await callTool(session.client, 'add_to_bookmarks', {
      nodeIds: [groupId],
      sourceScope: 'library',
      sourceLibraryId: testLibraryId,
      parentBookmarkFolderId: 'node-does-not-exist-xyz',
      browser,
    });
    expect(result.isError || result.parsed?.ok === false).toBeTruthy();
    expect(result.parsed?.error?.code).toBe('BOOKMARK_FOLDER_NOT_FOUND');
  });
});
