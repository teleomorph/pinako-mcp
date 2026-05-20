import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { connectPinakoMcp, callToolOk, waitFor } from './helpers/mcp-client.js';
import { resolveTargetBrowser } from './helpers/browser.js';
import { testLabel } from './helpers/fixtures.js';

// Verifies the read-tool response shapes end-to-end.
// No setup mutations needed — these tools just read cached browser data.

let session;
let browser;

beforeAll(async () => {
  session = await connectPinakoMcp();
  browser = await resolveTargetBrowser(session.client);
});

afterAll(async () => {
  if (session) await session.close();
});

describe('get_tree', () => {
  it('returns lite mode by default with browser + scope + tree', async () => {
    const result = await callToolOk(session.client, 'get_tree', { browser });
    expect(result.browser).toBeTruthy();
    expect(result.scope).toBe('tree');
    expect(result.mode).toBe('lite');
    expect(Array.isArray(result.tree)).toBe(true);
  });

  it('returns minimal mode when requested', async () => {
    const result = await callToolOk(session.client, 'get_tree', {
      mode: 'minimal',
      browser,
    });
    expect(result.mode).toBe('minimal');
    // Minimal mode flattens — items don't have `children` arrays
    if (result.tree.length > 0) {
      expect(result.tree[0]).not.toHaveProperty('children');
    }
  });
});

describe('search_tabs', () => {
  it('returns results array + count for a literal substring query', async () => {
    const result = await callToolOk(session.client, 'search_tabs', {
      query: 'a',
      browser,
    });
    expect(result.browser).toBeTruthy();
    expect(result.mode).toBeTruthy();
    expect(Array.isArray(result.results)).toBe(true);
    expect(typeof result.count).toBe('number');
    expect(result.count).toBe(result.results.length);
  });

  it('returns empty results for an unlikely-to-match query', async () => {
    const result = await callToolOk(session.client, 'search_tabs', {
      query: 'xqzzpinakotestneversubstring123',
      browser,
    });
    expect(result.count).toBe(0);
    expect(result.results).toEqual([]);
  });
});

describe('get_bookmarks', () => {
  it('returns bookmarks tree with bookmarks array', async () => {
    const result = await callToolOk(session.client, 'get_bookmarks', {
      browser,
    });
    expect(result.browser).toBeTruthy();
    expect(result.browserId).toBeTruthy();
    expect(Array.isArray(result.bookmarks)).toBe(true);
    expect(typeof result.updatedAt).toBe('number');
  });
});

describe('find_duplicates', () => {
  it('returns duplicateSets + counts for bookmarks scope', async () => {
    const result = await callToolOk(session.client, 'find_duplicates', {
      scope: 'bookmarks',
      browser,
    });
    expect(result.browser).toBeTruthy();
    expect(result.scope).toBe('bookmarks');
    expect(Array.isArray(result.duplicateSets)).toBe(true);
    expect(typeof result.totalDuplicateInstances).toBe('number');
    expect(typeof result.uniqueDuplicateUrls).toBe('number');
    expect(typeof result.totalScannedWithUrl).toBe('number');
    expect(result.cached).toBe(true);
    expect(typeof result.cachedAt).toBe('number');
  });
});

describe('get_tree_summary', () => {
  it('returns structural summary (counts, depth, topDomains, samplePatterns)', async () => {
    const result = await callToolOk(session.client, 'get_tree_summary', { browser });
    expect(result.browser).toBeTruthy();
    expect(result.scope).toBe('tree');
    expect(result.counts).toBeTruthy();
    expect(typeof result.counts.nodes).toBe('number');
    expect(typeof result.counts.url_bearing_nodes).toBe('number');
    expect(result.depth).toBeTruthy();
    expect(typeof result.depth.max).toBe('number');
    expect(Array.isArray(result.topDomains)).toBe(true);
    expect(Array.isArray(result.samplePatterns)).toBe(true);
    expect(Array.isArray(result.sampleTitles)).toBe(true);
  });
});

describe('search_docs', () => {
  it('returns ranked guide sections for a known term', async () => {
    const result = await callToolOk(session.client, 'search_docs', {
      query: 'library',
      browser,
    });
    expect(result.browser).toBeTruthy();
    expect(result.query).toBe('library');
    expect(Array.isArray(result.results)).toBe(true);
    expect(typeof result.count).toBe('number');
    expect(result.count).toBe(result.results.length);
    if (result.count > 0) {
      const first = result.results[0];
      expect(first).toHaveProperty('title');
      expect(first).toHaveProperty('source');
    }
  });
});

describe('list_browsers', () => {
  it('returns the connected browsers with subscriptionTier on each entry', async () => {
    const result = await callToolOk(session.client, 'list_browsers', {});
    expect(Array.isArray(result.browsers)).toBe(true);
    expect(typeof result.count).toBe('number');
    expect(result.count).toBe(result.browsers.length);
    expect(result.browsers.length).toBeGreaterThan(0);
    for (const b of result.browsers) {
      expect(typeof b.browserBrand).toBe('string');
      expect(typeof b.browserId).toBe('string');
      expect(typeof b.subscriptionTier).toBe('number');
      expect(Number.isInteger(b.subscriptionTier)).toBe(true);
      expect(b.subscriptionTier).toBeGreaterThanOrEqual(0);
      expect(b.subscriptionTier).toBeLessThanOrEqual(4);
    }
  });
});

function findFirstUrlNode(nodes) {
  if (!Array.isArray(nodes)) return null;
  for (const n of nodes) {
    if (n && typeof n.url === 'string' && /^https?:\/\//i.test(n.url)) return n;
    if (Array.isArray(n?.children)) {
      const hit = findFirstUrlNode(n.children);
      if (hit) return hit;
    }
  }
  return null;
}

function findUrlInChildren(children, url) {
  if (!Array.isArray(children)) return null;
  for (const n of children) {
    if (n && n.url === url) return n;
    if (Array.isArray(n?.children)) {
      const hit = findUrlInChildren(n.children, url);
      if (hit) return hit;
    }
  }
  return null;
}

describe('find_duplicates (cross-scope)', () => {
  let seededUrl     = null;
  let seededTabId   = null;
  let testLibraryA  = null;
  let testLibraryB  = null;

  beforeAll(async () => {
    // Seed deterministic cross-scope duplicates: find any live tab, clone
    // it into two test libraries via add_to_library. After this setup the
    // tab's URL has one instance in tree (the original) plus one in each
    // of the two test libraries, so cross-scope dedup must find a set of
    // count >= 3 with two library instances when crossScopes includes
    // "libraries". Skips gracefully if the install has no live tabs.
    const tree = await callToolOk(session.client, 'get_tree', { browser });
    const tab = findFirstUrlNode(tree.tree);
    if (!tab) {
      // eslint-disable-next-line no-console
      console.warn('find_duplicates (cross-scope) tests will SKIP — no live URL-bearing tabs to seed duplicates with');
      return;
    }
    seededUrl   = tab.url;
    seededTabId = tab.id;

    const libA = await callToolOk(session.client, 'create_library', {
      title: testLabel('cross-scope-A'),
      browser,
    });
    testLibraryA = libA.result.createdLibraryId;

    const libB = await callToolOk(session.client, 'create_library', {
      title: testLabel('cross-scope-B'),
      browser,
    });
    testLibraryB = libB.result.createdLibraryId;

    await callToolOk(session.client, 'add_to_library', {
      libraryId:       testLibraryA,
      nodeIds:         [seededTabId],
      sourceScope:     'tree',
      includeChildren: false,
      browser,
    });
    await callToolOk(session.client, 'add_to_library', {
      libraryId:       testLibraryB,
      nodeIds:         [seededTabId],
      sourceScope:     'tree',
      includeChildren: false,
      browser,
    });

    await waitFor(async () => {
      const a = await callToolOk(session.client, 'get_library', { library_id: testLibraryA, mode: 'full', browser });
      const b = await callToolOk(session.client, 'get_library', { library_id: testLibraryB, mode: 'full', browser });
      return findUrlInChildren(a.library.children, seededUrl)
          && findUrlInChildren(b.library.children, seededUrl) ? true : null;
    }, { label: 'cross-scope-seed-visible' });
  });

  afterAll(async () => {
    if (testLibraryA) {
      try {
        await callToolOk(session.client, 'delete_library', { libraryId: testLibraryA, confirmedByUser: true, browser });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(`cleanup: delete library A failed: ${err.message}`);
      }
    }
    if (testLibraryB) {
      try {
        await callToolOk(session.client, 'delete_library', { libraryId: testLibraryB, confirmedByUser: true, browser });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(`cleanup: delete library B failed: ${err.message}`);
      }
    }
  });

  it('returns the default ["tree","bookmarks","libraries"] crossScopes when omitted', async () => {
    const result = await callToolOk(session.client, 'find_duplicates', {
      scope: 'cross-scope',
      browser,
    });
    expect(result.scope).toBe('cross-scope');
    expect(result.crossScopes).toEqual(['tree', 'bookmarks', 'libraries']);
    expect(Array.isArray(result.duplicateSets)).toBe(true);
  });

  it('finds URL duplicates across libraries with crossScopes:["libraries"] and tags each instance with sourceScope/sourceLibraryId', async () => {
    if (!seededUrl) {
      // eslint-disable-next-line no-console
      console.warn('skipping libraries-only cross-scope assertion — setup skipped');
      return;
    }

    const result = await callToolOk(session.client, 'find_duplicates', {
      scope: 'cross-scope',
      crossScopes: ['libraries'],
      browser,
    });
    expect(result.scope).toBe('cross-scope');
    expect(result.crossScopes).toEqual(['libraries']);
    expect(Array.isArray(result.duplicateSets)).toBe(true);

    const seededSet = result.duplicateSets.find(s => s.url === seededUrl);
    expect(seededSet, `cross-scope duplicate set for URL ${seededUrl} should exist`).toBeTruthy();
    expect(seededSet.count).toBeGreaterThanOrEqual(2);

    // Shape: cross-scope adds sourceScopes[] + sourceLibraryIds[] parallel
    // to nodeIds[] / parentPaths[].
    expect(Array.isArray(seededSet.sourceScopes)).toBe(true);
    expect(Array.isArray(seededSet.sourceLibraryIds)).toBe(true);
    expect(seededSet.sourceScopes.length).toBe(seededSet.nodeIds.length);
    expect(seededSet.sourceLibraryIds.length).toBe(seededSet.nodeIds.length);

    // All instances when scope is libraries-only should report sourceScope=library.
    const allLibrary = seededSet.sourceScopes.every(s => s === 'library');
    expect(allLibrary, 'every sourceScope should be "library" with crossScopes=["libraries"]').toBe(true);

    // Both test library ids must appear among the sourceLibraryIds.
    expect(seededSet.sourceLibraryIds.includes(testLibraryA)).toBe(true);
    expect(seededSet.sourceLibraryIds.includes(testLibraryB)).toBe(true);
  });

  it('includes the tree-side instance when crossScopes:["tree","libraries"] (full cross-scope coverage)', async () => {
    if (!seededUrl) return;

    const result = await callToolOk(session.client, 'find_duplicates', {
      scope: 'cross-scope',
      crossScopes: ['tree', 'libraries'],
      browser,
    });
    expect(result.crossScopes).toEqual(['tree', 'libraries']);

    const seededSet = result.duplicateSets.find(s => s.url === seededUrl);
    expect(seededSet, 'tree+libraries duplicate set should still exist').toBeTruthy();
    // Tree instance + both library instances = 3 minimum.
    expect(seededSet.count).toBeGreaterThanOrEqual(3);
    expect(seededSet.sourceScopes.includes('tree')).toBe(true);
    expect(seededSet.sourceScopes.filter(s => s === 'library').length).toBeGreaterThanOrEqual(2);
    // Tree instance's sourceLibraryId is null.
    const treeIdx = seededSet.sourceScopes.indexOf('tree');
    expect(seededSet.sourceLibraryIds[treeIdx]).toBeNull();
  });
});
