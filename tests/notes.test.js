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
