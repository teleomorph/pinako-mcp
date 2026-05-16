import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { connectPinakoMcp, callToolOk, waitFor } from './helpers/mcp-client.js';
import { resolveTargetBrowser } from './helpers/browser.js';
import { testLabel } from './helpers/fixtures.js';

// Verifies the paginated read paths on the 5 tools that support them:
// get_library, get_tree, get_main_tree_notes, get_bookmarks, list_libraries.
// Each paginated response has shape:
//   {items: [...], nextCursor: string|null, totalItems: number, cursorFound?}
// Pagination bypasses the per-tier read-size guard automatically.
//
// For get_library we control the data (5 created groups) so we can test
// cursor walking strictly. For the user-data-dependent tools we verify
// shape conformance only.

let session;
let browser;
let testGroupId;
let testLibraryId;
const KNOWN_GROUP_COUNT = 5;

beforeAll(async () => {
  session = await connectPinakoMcp();
  browser = await resolveTargetBrowser(session.client);

  const group = await callToolOk(session.client, 'create_library_group', {
    title: testLabel('pagination-suite'),
    browser,
  });
  testGroupId = group.result.createdGroupId;

  const lib = await callToolOk(session.client, 'create_library', {
    title: testLabel('pagination-lib'),
    browser,
  });
  testLibraryId = lib.result.createdLibraryId;

  await callToolOk(session.client, 'add_library_to_group', {
    groupId: testGroupId,
    libraryId: testLibraryId,
    browser,
  });

  // Seed the library with KNOWN_GROUP_COUNT groups so pagination has
  // deterministic content to walk through.
  for (let i = 0; i < KNOWN_GROUP_COUNT; i++) {
    await callToolOk(session.client, 'create_group', {
      title: testLabel(`pg-group-${i}`),
      scope: 'library',
      libraryId: testLibraryId,
      browser,
    });
  }

  // Wait for all KNOWN_GROUP_COUNT children to be visible
  await waitFor(async () => {
    const fetched = await callToolOk(session.client, 'get_library', {
      library_id: testLibraryId,
      mode: 'lite',
      browser,
    });
    return (fetched.library.children || []).length >= KNOWN_GROUP_COUNT ? fetched : null;
  }, { label: 'seed-groups-visible', timeout: 12_000 });
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

describe('get_library pagination', () => {
  it('returns paginated response shape when limit is set', async () => {
    const result = await callToolOk(session.client, 'get_library', {
      library_id: testLibraryId,
      mode: 'lite',
      limit: 2,
      browser,
    });
    expect(result.browser).toBeTruthy();
    expect(result.scope).toBe('library');
    expect(result.libraryId).toBe(testLibraryId);
    expect(Array.isArray(result.items)).toBe(true);
    expect(result.items.length).toBeLessThanOrEqual(2);
    expect(typeof result.totalItems).toBe('number');
    expect(result.totalItems).toBeGreaterThanOrEqual(KNOWN_GROUP_COUNT);
    expect(result.library).toHaveProperty('id', testLibraryId);
    expect(result.library).toHaveProperty('title');
  });

  it('walks every page until nextCursor is null with no item repeats', async () => {
    const allItemIds = [];
    let cursor = undefined;
    let pageCount = 0;
    const MAX_PAGES = 20;

    while (pageCount < MAX_PAGES) {
      const args = {
        library_id: testLibraryId,
        mode: 'lite',
        limit: 2,
        browser,
      };
      if (cursor !== undefined) args.after = cursor;
      const result = await callToolOk(session.client, 'get_library', args);

      expect(Array.isArray(result.items)).toBe(true);
      for (const item of result.items) {
        expect(allItemIds, `duplicate item id ${item.id} across pages`).not.toContain(item.id);
        allItemIds.push(item.id);
      }
      pageCount++;
      if (!result.nextCursor) break;
      cursor = result.nextCursor;
    }
    expect(allItemIds.length).toBeGreaterThanOrEqual(KNOWN_GROUP_COUNT);
    expect(pageCount).toBeLessThan(MAX_PAGES);
  });
});

describe('get_tree pagination', () => {
  it('returns flat items + parentId when limit is set', async () => {
    const result = await callToolOk(session.client, 'get_tree', {
      limit: 5,
      browser,
    });
    expect(result.browser).toBeTruthy();
    expect(Array.isArray(result.items)).toBe(true);
    expect(result.items.length).toBeLessThanOrEqual(5);
    expect(typeof result.totalItems).toBe('number');
    if (result.items.length > 0) {
      const item = result.items[0];
      expect(item).toHaveProperty('id');
    }
  });
});

describe('get_main_tree_notes pagination', () => {
  it('returns paginated response shape when limit is set', async () => {
    const result = await callToolOk(session.client, 'get_main_tree_notes', {
      limit: 5,
      browser,
    });
    expect(result.browser).toBeTruthy();
    expect(result.scope).toBe('main-tree-notes');
    expect(Array.isArray(result.items)).toBe(true);
    expect(result.items.length).toBeLessThanOrEqual(5);
    expect(typeof result.totalItems).toBe('number');
  });
});

describe('get_bookmarks pagination', () => {
  it('returns flat DFS items when limit is set', async () => {
    const result = await callToolOk(session.client, 'get_bookmarks', {
      limit: 10,
      browser,
    });
    expect(result.browser).toBeTruthy();
    expect(result.scope).toBe('bookmarks');
    expect(Array.isArray(result.items)).toBe(true);
    expect(result.items.length).toBeLessThanOrEqual(10);
    expect(typeof result.totalItems).toBe('number');
    if (result.items.length > 0) {
      const item = result.items[0];
      expect(item).toHaveProperty('id');
      expect(item).toHaveProperty('title');
    }
  });
});

describe('list_libraries pagination', () => {
  it('returns paginated libraries + groups + panel_order metadata', async () => {
    const result = await callToolOk(session.client, 'list_libraries', {
      limit: 2,
      browser,
    });
    expect(result.browser).toBeTruthy();
    expect(Array.isArray(result.items)).toBe(true);
    expect(result.items.length).toBeLessThanOrEqual(2);
    expect(typeof result.totalItems).toBe('number');
    // Metadata always returned in full alongside paginated libraries
    expect(Array.isArray(result.groups)).toBe(true);
    expect(Array.isArray(result.panel_order)).toBe(true);
  });
});
