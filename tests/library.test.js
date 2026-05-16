import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { connectPinakoMcp, callToolOk, waitFor } from './helpers/mcp-client.js';
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

function collectTitles(nodes, out = []) {
  for (const n of nodes || []) {
    if (n.title) out.push(n.title);
    if (Array.isArray(n.children)) collectTitles(n.children, out);
  }
  return out;
}
