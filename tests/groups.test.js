import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { connectPinakoMcp, callToolOk, waitFor } from './helpers/mcp-client.js';
import { resolveTargetBrowser } from './helpers/browser.js';
import { testLabel } from './helpers/fixtures.js';

// Verifies the library-group ops not covered by other suites:
// set_library_group_title, set_library_group_description,
// remove_library_from_group, reorder_libraries_in_group.

let session;
let browser;
const trackedGroupIds = [];

beforeAll(async () => {
  session = await connectPinakoMcp();
  browser = await resolveTargetBrowser(session.client);
});

afterAll(async () => {
  for (const groupId of trackedGroupIds) {
    try {
      await callToolOk(session.client, 'delete_library_group', {
        groupId,
        cascadeMembers: true,
        confirmedByUser: true,
        browser,
      });
    } catch (err) {
      console.warn(`cleanup: cascade-delete group ${groupId} failed: ${err.message}`);
    }
  }
  if (session) await session.close();
});

async function makeGroup(suffix) {
  const g = await callToolOk(session.client, 'create_library_group', {
    title: testLabel(suffix),
    browser,
  });
  const groupId = g.result.createdGroupId;
  trackedGroupIds.push(groupId);
  return groupId;
}

async function makeLibrary(suffix) {
  const lib = await callToolOk(session.client, 'create_library', {
    title: testLabel(suffix),
    browser,
  });
  return lib.result.createdLibraryId;
}

async function fetchGroup(groupId) {
  const response = await callToolOk(session.client, 'list_libraries', { browser });
  const groups = response.groups || [];
  return groups.find(g => g.id === groupId) || null;
}

describe('set_library_group_title', () => {
  it('renames a library group', async () => {
    const groupId = await makeGroup('grp-rename-orig');
    const newTitle = testLabel('grp-renamed');

    await callToolOk(session.client, 'set_library_group_title', {
      groupId,
      title: newTitle,
      browser,
    });

    const renamed = await waitFor(async () => {
      const g = await fetchGroup(groupId);
      return g?.title === newTitle ? g : null;
    }, { label: 'set_library_group_title-applied' });
    expect(renamed.title).toBe(newTitle);
  });
});

describe('set_library_group_description', () => {
  it('sets a description and then clears it on empty string', async () => {
    const groupId = await makeGroup('grp-desc');
    const description = 'A test description for the group.';

    await callToolOk(session.client, 'set_library_group_description', {
      groupId,
      description,
      browser,
    });
    const withDesc = await waitFor(async () => {
      const g = await fetchGroup(groupId);
      return g?.description === description ? g : null;
    }, { label: 'set_library_group_description-applied' });
    expect(withDesc.description).toBe(description);

    await callToolOk(session.client, 'set_library_group_description', {
      groupId,
      description: '',
      browser,
    });
    const cleared = await waitFor(async () => {
      const g = await fetchGroup(groupId);
      return g && (g.description === '' || g.description == null) ? g : null;
    }, { label: 'set_library_group_description-cleared' });
    expect(cleared.description == null || cleared.description === '').toBe(true);
  });
});

describe('remove_library_from_group', () => {
  it('detaches a library; library survives standalone', async () => {
    const groupId = await makeGroup('grp-remove');
    const libraryId = await makeLibrary('grp-remove-lib');

    await callToolOk(session.client, 'add_library_to_group', {
      groupId,
      libraryId,
      browser,
    });
    await waitFor(async () => {
      const g = await fetchGroup(groupId);
      return Array.isArray(g?.library_ids) && g.library_ids.includes(libraryId) ? g : null;
    }, { label: 'add_library-visible' });

    await callToolOk(session.client, 'remove_library_from_group', {
      groupId,
      libraryId,
      browser,
    });

    const after = await waitFor(async () => {
      const g = await fetchGroup(groupId);
      return g && (!Array.isArray(g.library_ids) || !g.library_ids.includes(libraryId)) ? g : null;
    }, { label: 'remove_library-applied' });
    expect(after.library_ids || []).not.toContain(libraryId);

    const libStillExists = await callToolOk(session.client, 'get_library', {
      library_id: libraryId,
      mode: 'lite',
      browser,
    });
    expect(libStillExists.library.id).toBe(libraryId);
  });
});

describe('reorder_libraries_in_group', () => {
  it('changes the order of member libraries when given the full set in new order', async () => {
    const groupId = await makeGroup('grp-reorder');
    const libA = await makeLibrary('reorder-A');
    const libB = await makeLibrary('reorder-B');
    const libC = await makeLibrary('reorder-C');

    for (const libId of [libA, libB, libC]) {
      await callToolOk(session.client, 'add_library_to_group', {
        groupId,
        libraryId: libId,
        browser,
      });
    }

    await waitFor(async () => {
      const g = await fetchGroup(groupId);
      return g && Array.isArray(g.library_ids) && g.library_ids.length === 3 ? g : null;
    }, { label: 'reorder-membership-stable' });

    // NB: input arg is camelCase `libraryIds` per the tool schema, but the
    // list_libraries response field is snake_case `library_ids`. Asymmetric.
    const newOrder = [libC, libA, libB];
    await callToolOk(session.client, 'reorder_libraries_in_group', {
      groupId,
      libraryIds: newOrder,
      browser,
    });

    const reordered = await waitFor(async () => {
      const g = await fetchGroup(groupId);
      const ids = g?.library_ids || [];
      return ids.length === 3 && ids[0] === libC && ids[1] === libA && ids[2] === libB ? g : null;
    }, { label: 'reorder_libraries-applied' });
    expect(reordered.library_ids).toEqual(newOrder);
  });
});
