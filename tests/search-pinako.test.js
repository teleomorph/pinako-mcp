import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { connectPinakoMcp, callTool, callToolOk, waitFor } from './helpers/mcp-client.js';
import { resolveTargetBrowser } from './helpers/browser.js';
import { testLabel } from './helpers/fixtures.js';

// Tier 1 coverage for the omnibus search_pinako tool. Seeds known-unique
// markers under a single test library and verifies that each scope returns
// the expected hits with the new {type, scope, nodeId|noteId, sourceLibraryId?,
// matchedFields[], snippet?} shape. Exact-tag semantics get their own case
// with two tags that differ by substring suffix.

let session;
let browser;
let testGroupId;
let testLibraryId;

// Unique-per-run markers so test data never collides with real user content
// or with prior leftover test runs.
const MARKER          = `searchp-${Date.now().toString(36)}`;
const NEEDLE_TITLE    = `${MARKER}-needle-title`;
const NEEDLE_MEMO     = `${MARKER}-needle-memo`;
const NEEDLE_NOTE     = `${MARKER}-needle-note`;
const EXACT_TAG       = `${MARKER}-food`;
const EXACT_TAG_LONG  = `${MARKER}-foodie`;

let seedTitleNodeId;
let seedTagNodeIdShort;
let seedTagNodeIdLong;
let seedNoteId;

beforeAll(async () => {
  session = await connectPinakoMcp();
  browser = await resolveTargetBrowser(session.client);

  const group = await callToolOk(session.client, 'create_library_group', {
    title: testLabel('search-pinako-suite'),
    browser,
  });
  testGroupId = group.result.createdGroupId;

  const lib = await callToolOk(session.client, 'create_library', {
    title: testLabel('search-pinako-lib'),
    browser,
  });
  testLibraryId = lib.result.createdLibraryId;

  await callToolOk(session.client, 'add_library_to_group', {
    groupId: testGroupId,
    libraryId: testLibraryId,
    browser,
  });

  // Seed 1: group whose TITLE contains the unique needle marker. Tests
  // that search_pinako returns non-tab nodes (which the legacy search_tabs
  // would skip).
  const titleNode = await callToolOk(session.client, 'create_group', {
    title: NEEDLE_TITLE,
    scope: 'library',
    libraryId: testLibraryId,
    browser,
  });
  seedTitleNodeId = titleNode.result.createdId;

  // Seed 2: group whose tags contain EXACT_TAG (the "food" analog).
  const tagNode = await callToolOk(session.client, 'create_group', {
    title: testLabel('search-pinako-tag-short'),
    scope: 'library',
    libraryId: testLibraryId,
    browser,
  });
  seedTagNodeIdShort = tagNode.result.createdId;
  await callToolOk(session.client, 'set_tags', {
    nodeId: seedTagNodeIdShort,
    tags: [EXACT_TAG],
    scope: 'library',
    libraryId: testLibraryId,
    browser,
  });

  // Seed 3: group whose tags contain EXACT_TAG_LONG (the "foodie" analog).
  // exact_tag:true must NOT match this when query=EXACT_TAG; exact_tag:false
  // MUST match both.
  const tagNodeLong = await callToolOk(session.client, 'create_group', {
    title: testLabel('search-pinako-tag-long'),
    scope: 'library',
    libraryId: testLibraryId,
    browser,
  });
  seedTagNodeIdLong = tagNodeLong.result.createdId;
  await callToolOk(session.client, 'set_tags', {
    nodeId: seedTagNodeIdLong,
    tags: [EXACT_TAG_LONG],
    scope: 'library',
    libraryId: testLibraryId,
    browser,
  });

  // Seed 4: group with a memo containing NEEDLE_MEMO.
  const memoNode = await callToolOk(session.client, 'create_group', {
    title: testLabel('search-pinako-memo-target'),
    scope: 'library',
    libraryId: testLibraryId,
    browser,
  });
  await callToolOk(session.client, 'set_memo', {
    nodeId: memoNode.result.createdId,
    text: `freeform marker text ${NEEDLE_MEMO} elsewhere`,
    scope: 'library',
    libraryId: testLibraryId,
    browser,
  });

  // Seed 5: note whose content contains NEEDLE_NOTE (HTML-stripped match).
  const note = await callToolOk(session.client, 'create_note', {
    title: testLabel('search-pinako-note'),
    scope: 'library-notes',
    libraryId: testLibraryId,
    content: `<p>preceding context</p><p>marker line: ${NEEDLE_NOTE} appears here</p><p>trailing</p>`,
    browser,
  });
  seedNoteId = note.result.createdNoteId;

  // Wait for cache propagation. The most-recent write was the note; once it
  // is visible via get_library, all earlier seeds are guaranteed visible too.
  await waitFor(async () => {
    const fetched = await callToolOk(session.client, 'get_library', {
      library_id: testLibraryId,
      mode: 'full',
      browser,
    });
    const noteVisible = (fetched.library?.notes || []).some(n => n.id === seedNoteId);
    const titleVisible = findById(fetched.library?.children, seedTitleNodeId);
    return noteVisible && titleVisible ? fetched : null;
  }, { label: 'search-pinako-seeds-visible' });
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
      // eslint-disable-next-line no-console
      console.warn(`cleanup: cascade-delete group ${testGroupId} failed: ${err.message}`);
    }
  }
  if (session) await session.close();
});

function findById(nodes, id) {
  if (!Array.isArray(nodes)) return null;
  for (const n of nodes) {
    if (n && n.id === id) return n;
    if (Array.isArray(n?.children)) {
      const hit = findById(n.children, id);
      if (hit) return hit;
    }
  }
  return null;
}

describe('search_pinako (library scope: non-tab title match)', () => {
  it('finds a group whose title matches the needle and tags matchedFields=["title"]', async () => {
    const result = await callToolOk(session.client, 'search_pinako', {
      query: NEEDLE_TITLE,
      scope: 'library',
      library_id: testLibraryId,
      browser,
    });
    expect(result.scope).toBe('library');
    expect(result.libraryId).toBe(testLibraryId);
    expect(Array.isArray(result.results)).toBe(true);
    const hit = result.results.find(r => r.nodeId === seedTitleNodeId);
    expect(hit, `title-match hit for nodeId ${seedTitleNodeId} should exist`).toBeTruthy();
    expect(hit.type).toBe('group');
    expect(hit.scope).toBe('library');
    expect(hit.sourceLibraryId).toBe(testLibraryId);
    expect(hit.matchedFields).toEqual(['title']);
    expect(hit.title).toBe(NEEDLE_TITLE);
  });
});

describe('search_pinako (libraries-all scope: cross-library tag search)', () => {
  it('with exact_tag:true matches only the exact tag, not substring suffix', async () => {
    const result = await callToolOk(session.client, 'search_pinako', {
      query: EXACT_TAG,
      scope: 'libraries-all',
      match_fields: ['tags'],
      exact_tag: true,
      browser,
    });
    const shortHit = result.results.find(r => r.nodeId === seedTagNodeIdShort);
    const longHit  = result.results.find(r => r.nodeId === seedTagNodeIdLong);
    expect(shortHit, `exact-tag hit for the matching node should exist`).toBeTruthy();
    expect(shortHit.matchedFields).toEqual(['tags']);
    expect(shortHit.sourceLibraryId).toBe(testLibraryId);
    expect(longHit, 'exact-tag mode MUST NOT match the longer-tag node').toBeFalsy();
  });

  it('with exact_tag:false matches both substring siblings', async () => {
    const result = await callToolOk(session.client, 'search_pinako', {
      query: EXACT_TAG,
      scope: 'libraries-all',
      match_fields: ['tags'],
      exact_tag: false,
      browser,
    });
    const shortHit = result.results.find(r => r.nodeId === seedTagNodeIdShort);
    const longHit  = result.results.find(r => r.nodeId === seedTagNodeIdLong);
    expect(shortHit, `fuzzy-tag should match the exact tag node`).toBeTruthy();
    expect(longHit,  `fuzzy-tag should ALSO match the longer-tag node`).toBeTruthy();
  });
});

describe('search_pinako (notes scope: HTML-stripped content match with snippet)', () => {
  it('matches the note by content and returns a snippet around the hit', async () => {
    const result = await callToolOk(session.client, 'search_pinako', {
      query: NEEDLE_NOTE,
      scope: 'notes',
      browser,
    });
    const hit = result.results.find(r => r.noteId === seedNoteId);
    expect(hit, `note-content hit for noteId ${seedNoteId} should exist`).toBeTruthy();
    expect(hit.type).toBe('note');
    expect(hit.scope).toBe('library-notes');
    expect(hit.sourceLibraryId).toBe(testLibraryId);
    expect(hit.matchedFields).toContain('content');
    expect(typeof hit.snippet).toBe('string');
    expect(hit.snippet.toLowerCase()).toContain(NEEDLE_NOTE.toLowerCase());
    // HTML should be stripped (no angle brackets) in the snippet.
    expect(hit.snippet).not.toMatch(/<[a-z][^>]*>/i);
  });
});

describe('search_pinako (memo field match)', () => {
  it('matches a node by memoText when match_fields includes "memo"', async () => {
    const result = await callToolOk(session.client, 'search_pinako', {
      query: NEEDLE_MEMO,
      scope: 'library',
      library_id: testLibraryId,
      match_fields: ['memo'],
      browser,
    });
    const hit = result.results.find(r => r.matchedFields.includes('memo'));
    expect(hit, `memo-match hit for marker ${NEEDLE_MEMO} should exist`).toBeTruthy();
    expect(hit.memoText).toContain(NEEDLE_MEMO);
  });
});

describe('search_pinako (error envelopes)', () => {
  it('returns EMPTY_QUERY for empty string', async () => {
    const result = await callTool(session.client, 'search_pinako', {
      query: '',
      scope: 'tree',
      browser,
    });
    expect(result.isError || result.parsed?.ok === false || result.parsed?.error).toBeTruthy();
    expect(result.parsed?.error?.code).toBe('EMPTY_QUERY');
  });

  it('returns LIBRARY_ID_REQUIRED when scope:"library" but library_id is omitted', async () => {
    const result = await callTool(session.client, 'search_pinako', {
      query: 'irrelevant',
      scope: 'library',
      browser,
    });
    expect(result.parsed?.error?.code).toBe('LIBRARY_ID_REQUIRED');
  });

  it('returns LIBRARY_NOT_FOUND for an unknown library id', async () => {
    const result = await callTool(session.client, 'search_pinako', {
      query: 'irrelevant',
      scope: 'library',
      library_id: 'folder-does-not-exist-xyz',
      browser,
    });
    expect(result.parsed?.error?.code).toBe('LIBRARY_NOT_FOUND');
  });
});
