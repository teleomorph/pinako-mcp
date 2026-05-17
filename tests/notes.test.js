import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { connectPinakoMcp, callTool, callToolOk, waitFor } from './helpers/mcp-client.js';
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
    title: testLabel('notes-suite'),
    browser,
  });
  testGroupId = group.result.createdGroupId;

  const lib = await callToolOk(session.client, 'create_library', {
    title: testLabel('notes-lib'),
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

async function readLibraryNotes() {
  const fetched = await callToolOk(session.client, 'get_library', {
    library_id: testLibraryId,
    mode: 'full',
    browser,
  });
  return fetched.library.notes || [];
}

describe('create_note + set_note_content (library-notes scope)', () => {
  it('creates a note, replaces content, then appends — round-trip via get_library', async () => {
    const noteTitle = testLabel('note');
    const created = await callToolOk(session.client, 'create_note', {
      title: noteTitle,
      scope: 'library-notes',
      libraryId: testLibraryId,
      content: '<p>initial</p>',
      browser,
    });
    const noteId = created.result.createdNoteId;
    expect(noteId).toMatch(/^note-/);

    const replacedBody = '<p>replaced body</p>';
    await callToolOk(session.client, 'set_note_content', {
      noteId,
      scope: 'library-notes',
      libraryId: testLibraryId,
      mode: 'replace',
      content: replacedBody,
      browser,
    });

    const afterReplace = await waitFor(async () => {
      const notes = await readLibraryNotes();
      const t = notes.find(n => n.id === noteId);
      return t?.content?.includes('replaced body') ? t : null;
    }, { label: 'note-replace-visible' });
    expect(afterReplace.title).toBe(noteTitle);
    expect(afterReplace.content).toContain('replaced body');
    expect(afterReplace.content).not.toContain('initial');

    const appendBody = '<p>appended chunk</p>';
    await callToolOk(session.client, 'set_note_content', {
      noteId,
      scope: 'library-notes',
      libraryId: testLibraryId,
      mode: 'append',
      content: appendBody,
      browser,
    });

    const afterAppend = await waitFor(async () => {
      const notes = await readLibraryNotes();
      const t = notes.find(n => n.id === noteId);
      return t?.content?.includes('appended chunk') ? t : null;
    }, { label: 'note-append-visible' });
    expect(afterAppend.content).toContain('replaced body');
    expect(afterAppend.content).toContain('appended chunk');
    expect(afterAppend.content.indexOf('replaced body')).toBeLessThan(afterAppend.content.indexOf('appended chunk'));
  });
});

describe('delete_note (library-notes scope)', () => {
  it('creates a note, deletes it, verifies it is gone from the library', async () => {
    const noteTitle = testLabel('delete-note-target');
    const created = await callToolOk(session.client, 'create_note', {
      title: noteTitle,
      scope: 'library-notes',
      libraryId: testLibraryId,
      content: '<p>doomed</p>',
      browser,
    });
    const noteId = created.result.createdNoteId;
    expect(noteId).toMatch(/^note-/);

    await callToolOk(session.client, 'delete_note', {
      noteId,
      scope: 'library-notes',
      libraryId: testLibraryId,
      confirmedByUser: true,
      browser,
    });

    await waitFor(async () => {
      const notes = await readLibraryNotes();
      return notes.some(n => n.id === noteId) ? null : notes;
    }, { label: 'note-removed' });

    const after = await readLibraryNotes();
    expect(after.some(n => n.id === noteId), 'note should be gone').toBe(false);
  });

  it('rejects without confirmedByUser (Zod schema gate)', async () => {
    const created = await callToolOk(session.client, 'create_note', {
      title: testLabel('delete-note-noconf'),
      scope: 'library-notes',
      libraryId: testLibraryId,
      browser,
    });
    const noteId = created.result.createdNoteId;

    // Wait for create to propagate to the cache before any read.
    await waitFor(async () => {
      const notes = await readLibraryNotes();
      return notes.some(n => n.id === noteId) ? notes : null;
    }, { label: 'note-visible-before-rejection' });

    const result = await callTool(session.client, 'delete_note', {
      noteId,
      scope: 'library-notes',
      libraryId: testLibraryId,
      browser,
    });
    expect(result.isError).toBe(true);
    const rawText = result.parsed?._rawText ?? JSON.stringify(result.parsed);
    expect(rawText).toMatch(/validation error|Invalid|Required/i);
    expect(rawText).toContain('confirmedByUser');

    // Note should still exist (Zod failed; no engine touch).
    const after = await readLibraryNotes();
    expect(after.some(n => n.id === noteId), 'note should NOT have been deleted').toBe(true);

    // Cleanup with confirmation.
    await callToolOk(session.client, 'delete_note', {
      noteId,
      scope: 'library-notes',
      libraryId: testLibraryId,
      confirmedByUser: true,
      browser,
    });
  });

  it('returns NOTE_NOT_FOUND for unknown note id', async () => {
    const result = await callTool(session.client, 'delete_note', {
      noteId: 'note-does-not-exist-xyz',
      scope: 'library-notes',
      libraryId: testLibraryId,
      confirmedByUser: true,
      browser,
    });
    expect(result.isError || result.parsed?.ok === false).toBeTruthy();
    expect(result.parsed?.error?.code).toBe('NOTE_NOT_FOUND');
  });
});

describe('delete_note (main-tree-notes scope)', () => {
  it('deletes a global note via main-tree-notes scope (wire-normalized to global-notes)', async () => {
    // Use 'main-tree-notes' (the user-facing canonical) on the wire;
    // the bridge normalizes to the legacy 'global-notes' before
    // dispatch.
    const created = await callToolOk(session.client, 'create_note', {
      title: testLabel('global-delete-target'),
      scope: 'main-tree-notes',
      content: '<p>global note doomed</p>',
      browser,
    });
    const noteId = created.result.createdNoteId;
    expect(noteId).toMatch(/^note-/);

    await callToolOk(session.client, 'delete_note', {
      noteId,
      scope: 'main-tree-notes',
      confirmedByUser: true,
      browser,
    });

    await waitFor(async () => {
      const fetched = await callToolOk(session.client, 'get_main_tree_notes', { browser });
      const stillThere = (fetched.notes || []).some(n => n.id === noteId);
      return stillThere ? null : fetched;
    }, { label: 'global-note-removed' });
  });
});

// Mirror of NOTE_CHAR_LIMITS at pinako-mcp/host.js:80. Kept in the test so
// the assertion verifies the cap value the bridge actually enforced rather
// than reading it back out of the same module under test.
const NOTE_CHAR_LIMITS = { 0: 50000, 1: 50000, 2: 150000, 3: 250000, 4: 500000 };

async function readSubscriptionTier() {
  const list = await callToolOk(session.client, 'list_browsers', {});
  const me = list.browsers.find(b => b.browserBrand === browser || b.browserId === browser);
  expect(me, `browser ${browser} found in list_browsers`).toBeTruthy();
  expect(typeof me.subscriptionTier).toBe('number');
  return me.subscriptionTier;
}

describe('NOTE_CONTENT_OVER_TIER_LIMIT (tier-cap enforcement at MCP boundary)', () => {
  it('rejects set_note_content (mode=replace) one char over the tier cap', async () => {
    const tier      = await readSubscriptionTier();
    const tierLimit = NOTE_CHAR_LIMITS[tier];
    expect(tierLimit).toBeGreaterThan(0);

    // Seed a real note so the test exercises the same path agents will
    // hit. The tier-cap check runs at the bridge BEFORE dispatch, so the
    // note's pre-existing content doesn't matter for replace mode — only
    // the new content's length does.
    const created = await callToolOk(session.client, 'create_note', {
      title: testLabel('tier-cap-replace-target'),
      scope: 'library-notes',
      libraryId: testLibraryId,
      content: '<p>seed</p>',
      browser,
    });
    const noteId = created.result.createdNoteId;

    const oversize = 'a'.repeat(tierLimit + 1);
    const result = await callTool(session.client, 'set_note_content', {
      noteId,
      scope: 'library-notes',
      libraryId: testLibraryId,
      mode: 'replace',
      content: oversize,
      browser,
    });
    expect(result.isError || result.parsed?.ok === false).toBeTruthy();
    expect(result.parsed?.error?.code).toBe('NOTE_CONTENT_OVER_TIER_LIMIT');
    expect(result.parsed?.error?.context?.tier).toBe(tier);
    expect(result.parsed?.error?.context?.tierLimit).toBe(tierLimit);
    expect(result.parsed?.error?.context?.inputLength).toBe(tierLimit + 1);
    expect(result.parsed?.error?.context?.mode).toBe('replace');
  });

  it('rejects create_note whose initial content exceeds the tier cap by one char', async () => {
    const tier      = await readSubscriptionTier();
    const tierLimit = NOTE_CHAR_LIMITS[tier];

    const oversize = 'b'.repeat(tierLimit + 1);
    const result = await callTool(session.client, 'create_note', {
      title: testLabel('tier-cap-create-target'),
      scope: 'library-notes',
      libraryId: testLibraryId,
      content: oversize,
      browser,
    });
    expect(result.isError || result.parsed?.ok === false).toBeTruthy();
    expect(result.parsed?.error?.code).toBe('NOTE_CONTENT_OVER_TIER_LIMIT');
    expect(result.parsed?.error?.context?.tier).toBe(tier);
    expect(result.parsed?.error?.context?.tierLimit).toBe(tierLimit);
    expect(result.parsed?.error?.context?.inputLength).toBe(tierLimit + 1);
  });

  it('rejects set_note_content (mode=append) when existing+new would cross the cap', async () => {
    const tier      = await readSubscriptionTier();
    const tierLimit = NOTE_CHAR_LIMITS[tier];

    // Seed at half-cap, append slightly over half-cap+1 so the combined
    // length lands one char above the cap. Exercises the append branch
    // of _checkNoteContentTierAtBridge which reads existing content from
    // cache before comparing.
    const half        = Math.floor(tierLimit / 2);
    const seedContent = 'c'.repeat(half);
    const created = await callToolOk(session.client, 'create_note', {
      title: testLabel('tier-cap-append-target'),
      scope: 'library-notes',
      libraryId: testLibraryId,
      content: seedContent,
      browser,
    });
    const noteId = created.result.createdNoteId;

    // Wait for the create to propagate so the append check sees the
    // seed content in cache.
    await waitFor(async () => {
      const notes = await readLibraryNotes();
      const t = notes.find(n => n.id === noteId);
      return t && t.content && t.content.length >= half ? t : null;
    }, { label: 'tier-cap-seed-visible' });

    const appendChunk = 'd'.repeat(tierLimit - half + 1);
    const result = await callTool(session.client, 'set_note_content', {
      noteId,
      scope: 'library-notes',
      libraryId: testLibraryId,
      mode: 'append',
      content: appendChunk,
      browser,
    });
    expect(result.isError || result.parsed?.ok === false).toBeTruthy();
    expect(result.parsed?.error?.code).toBe('NOTE_CONTENT_OVER_TIER_LIMIT');
    expect(result.parsed?.error?.context?.tier).toBe(tier);
    expect(result.parsed?.error?.context?.tierLimit).toBe(tierLimit);
    expect(result.parsed?.error?.context?.mode).toBe('append');
    expect(result.parsed?.error?.context?.finalLength).toBeGreaterThan(tierLimit);
  });
});
