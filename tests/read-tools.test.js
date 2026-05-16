import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { connectPinakoMcp, callToolOk } from './helpers/mcp-client.js';
import { resolveTargetBrowser } from './helpers/browser.js';

// Verifies the read-tool response shapes end-to-end.
// No setup mutations needed — these tools just read cached browser data.
// Tests pass acknowledge_size:true where the tree might trigger the
// per-tier read-size guard (bookmarks especially); the guard-warning
// shape is exercised separately by pagination.test.js.

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
    const result = await callToolOk(session.client, 'get_tree', { browser, acknowledge_size: true });
    expect(result.browser).toBeTruthy();
    expect(result.scope).toBe('tree');
    expect(result.mode).toBe('lite');
    expect(Array.isArray(result.tree)).toBe(true);
  });

  it('returns minimal mode when requested', async () => {
    const result = await callToolOk(session.client, 'get_tree', {
      mode: 'minimal',
      browser,
      acknowledge_size: true,
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
      acknowledge_size: true,
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
