import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { connectPinakoMcp, callTool, callToolOk, waitFor } from './helpers/mcp-client.js';
import { resolveTargetBrowser } from './helpers/browser.js';
import { testLabel } from './helpers/fixtures.js';

let session;
let browser;
let testGroupId;

beforeAll(async () => {
  session = await connectPinakoMcp();
  browser = await resolveTargetBrowser(session.client);
  const group = await callToolOk(session.client, 'create_library_group', {
    title: testLabel('library-suite'),
    browser,
  });
  testGroupId = group.result.createdGroupId;
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

async function makeLibraryInGroup(suffix) {
  const title = testLabel(suffix);
  const created = await callToolOk(session.client, 'create_library', { title, browser });
  const libraryId = created.result.createdLibraryId;
  await callToolOk(session.client, 'add_library_to_group', {
    groupId: testGroupId,
    libraryId,
    browser,
  });
  return { libraryId, title, seedNoteId: created.result.createdNoteId };
}

describe('create_library', () => {
  it('creates a library, attaches a seed note, round-trips via get_library', async () => {
    const { libraryId, title, seedNoteId } = await makeLibraryInGroup('create');
    expect(libraryId).toMatch(/^folder-/);
    expect(seedNoteId).toMatch(/^note-/);

    const fetched = await callToolOk(session.client, 'get_library', {
      library_id: libraryId,
      mode: 'lite',
      browser,
    });
    expect(fetched.library.id).toBe(libraryId);
    expect(fetched.library.title).toBe(title);
    expect(fetched.library.notes.some(n => n.id === seedNoteId)).toBe(true);
  });
});

describe('add_to_library', () => {
  it('clones a node from one library into another via sourceScope=library', async () => {
    const src = await makeLibraryInGroup('add-src');
    const dst = await makeLibraryInGroup('add-dst');

    const sourceGroupTitle = testLabel('add-src-group');
    const sourceGroup = await callToolOk(session.client, 'create_group', {
      title: sourceGroupTitle,
      scope: 'library',
      libraryId: src.libraryId,
      browser,
    });
    const sourceNodeId = sourceGroup.result.createdId;
    expect(sourceNodeId).toBeTruthy();

    const added = await callToolOk(session.client, 'add_to_library', {
      nodeIds: [sourceNodeId],
      libraryId: dst.libraryId,
      sourceScope: 'library',
      sourceLibraryId: src.libraryId,
      includeChildren: true,
      browser,
    });
    expect(added.result.addedCount).toBeGreaterThanOrEqual(1);
    expect(added.result.addedNodeIds.length).toBeGreaterThanOrEqual(1);

    const titles = await waitFor(async () => {
      const fetched = await callToolOk(session.client, 'get_library', {
        library_id: dst.libraryId,
        mode: 'lite',
        browser,
      });
      const flat = collectTitles(fetched.library.children);
      return flat.includes(sourceGroupTitle) ? flat : null;
    }, { label: 'cloned-group-visible-in-dst' });
    expect(titles).toContain(sourceGroupTitle);
  });
});

describe('set_library_title', () => {
  it('renames a library and round-trips via get_library', async () => {
    const { libraryId } = await makeLibraryInGroup('rename-orig');
    const newTitle = testLabel('rename-new');

    await callToolOk(session.client, 'set_library_title', {
      libraryId,
      title: newTitle,
      browser,
    });

    const renamed = await waitFor(async () => {
      const fetched = await callToolOk(session.client, 'get_library', {
        library_id: libraryId,
        mode: 'lite',
        browser,
      });
      return fetched.library?.title === newTitle ? fetched.library : null;
    }, { label: 'set_library_title-applied' });
    expect(renamed.title).toBe(newTitle);
  });

  it('returns LIBRARY_NOT_FOUND for unknown library id', async () => {
    const result = await session.client.callTool({
      name: 'set_library_title',
      arguments: { libraryId: 'folder-does-not-exist-xyz', title: 'irrelevant', browser },
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(false);
    expect(parsed.error?.code).toBe('LIBRARY_NOT_FOUND');
  });
});

describe('set_library_description', () => {
  it('sets a description and then clears it on empty string', async () => {
    const { libraryId } = await makeLibraryInGroup('desc');
    const description = 'A test description for the library.';

    await callToolOk(session.client, 'set_library_description', {
      libraryId,
      description,
      browser,
    });

    const withDesc = await waitFor(async () => {
      const fetched = await callToolOk(session.client, 'get_library', {
        library_id: libraryId,
        mode: 'lite',
        browser,
      });
      return fetched.library?.description === description ? fetched.library : null;
    }, { label: 'set_library_description-applied' });
    expect(withDesc.description).toBe(description);

    await callToolOk(session.client, 'set_library_description', {
      libraryId,
      description: '',
      browser,
    });

    const cleared = await waitFor(async () => {
      const fetched = await callToolOk(session.client, 'get_library', {
        library_id: libraryId,
        mode: 'lite',
        browser,
      });
      const d = fetched.library?.description;
      return (d === '' || d == null) ? fetched.library : null;
    }, { label: 'set_library_description-cleared' });
    expect(cleared.description == null || cleared.description === '').toBe(true);
  });
});

describe('delete_library', () => {
  it('deletes a grouped library: gone from list_libraries, gone from group membership', async () => {
    const { libraryId } = await makeLibraryInGroup('delete-grouped');

    await callToolOk(session.client, 'delete_library', {
      libraryId,
      confirmedByUser: true,
      browser,
    });

    const gone = await waitFor(async () => {
      const fetched = await callToolOk(session.client, 'list_libraries', { browser });
      const stillThere = (fetched.libraries || []).some(l => l.id === libraryId);
      return stillThere ? null : fetched;
    }, { label: 'library-removed-from-list' });

    const goneGroup = (gone.groups || []).find(g => g.id === testGroupId);
    expect(goneGroup?.libraryIds || [], `library ${libraryId} should be stripped from its group's libraryIds`).not.toContain(libraryId);
  });

  it('rejects without confirmedByUser (Zod schema gate)', async () => {
    const { libraryId } = await makeLibraryInGroup('delete-noconf');

    const result = await callTool(session.client, 'delete_library', {
      libraryId,
      browser,
    });
    expect(result.isError).toBe(true);
    const rawText = result.parsed?._rawText ?? JSON.stringify(result.parsed);
    expect(rawText).toMatch(/validation error|Invalid|Required/i);
    expect(rawText).toContain('confirmedByUser');

    // Cleanup: actually delete the library this test created so the
    // shared testGroupId doesn't leak it past afterAll.
    await callToolOk(session.client, 'delete_library', {
      libraryId,
      confirmedByUser: true,
      browser,
    });
  });

  it('rejects confirmedByUser:false (engine .refine gate)', async () => {
    const { libraryId } = await makeLibraryInGroup('delete-confalse');

    const result = await callTool(session.client, 'delete_library', {
      libraryId,
      confirmedByUser: false,
      browser,
    });
    expect(result.isError || result.parsed?.ok === false, 'should reject').toBeTruthy();
    const rawText = result.parsed?._rawText ?? JSON.stringify(result.parsed);
    expect(rawText).toContain('confirmedByUser');

    // Cleanup.
    await callToolOk(session.client, 'delete_library', {
      libraryId,
      confirmedByUser: true,
      browser,
    });
  });

  it('returns LIBRARY_NOT_FOUND for unknown library id', async () => {
    const result = await callTool(session.client, 'delete_library', {
      libraryId: 'folder-does-not-exist-xyz',
      confirmedByUser: true,
      browser,
    });
    expect(result.isError || result.parsed?.ok === false).toBeTruthy();
    expect(result.parsed?.error?.code).toBe('LIBRARY_NOT_FOUND');
  });
});

function collectTitles(nodes, out = []) {
  for (const n of nodes || []) {
    if (n.title) out.push(n.title);
    if (Array.isArray(n.children)) collectTitles(n.children, out);
  }
  return out;
}
