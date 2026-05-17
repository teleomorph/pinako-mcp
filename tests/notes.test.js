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
