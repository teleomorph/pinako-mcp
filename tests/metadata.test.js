import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { connectPinakoMcp, callToolOk, waitFor } from './helpers/mcp-client.js';
import { resolveTargetBrowser } from './helpers/browser.js';
import { testLabel } from './helpers/fixtures.js';

// Verifies the per-node metadata setters: set_memo, set_star_color,
// set_row_color, set_title. All operate within a library scope using
// a group node as the test target.

let session;
let browser;
let testGroupId;
let testLibraryId;

beforeAll(async () => {
  session = await connectPinakoMcp();
  browser = await resolveTargetBrowser(session.client);

  const group = await callToolOk(session.client, 'create_library_group', {
    title: testLabel('metadata-suite'),
    browser,
  });
  testGroupId = group.result.createdGroupId;

  const lib = await callToolOk(session.client, 'create_library', {
    title: testLabel('metadata-lib'),
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

async function makeGroup(suffix) {
  const grp = await callToolOk(session.client, 'create_group', {
    title: testLabel(suffix),
    scope: 'library',
    libraryId: testLibraryId,
    browser,
  });
  const nodeId = grp.result.createdId;
  await waitFor(async () => {
    const n = await findNodeInLibrary(nodeId);
    return n ? n : null;
  }, { label: `make-group-visible-${suffix}` });
  return nodeId;
}

async function findNodeInLibrary(nodeId) {
  const fetched = await callToolOk(session.client, 'get_library', {
    library_id: testLibraryId,
    mode: 'full',
    browser,
  });
  return findById(fetched.library.children || [], nodeId);
}

function findById(nodes, id) {
  for (const n of nodes) {
    if (n.id === id) return n;
    if (Array.isArray(n.children)) {
      const hit = findById(n.children, id);
      if (hit) return hit;
    }
  }
  return null;
}

describe('set_memo', () => {
  it('sets memoText and clears it on empty string', async () => {
    const nodeId = await makeGroup('memo-target');
    const memo = 'This is a test memo with some content.';
    await callToolOk(session.client, 'set_memo', {
      nodeId,
      text: memo,
      scope: 'library',
      libraryId: testLibraryId,
      browser,
    });

    const withMemo = await waitFor(async () => {
      const n = await findNodeInLibrary(nodeId);
      return n?.memoText === memo ? n : null;
    }, { label: 'set_memo-applied' });
    expect(withMemo.memoText).toBe(memo);

    await callToolOk(session.client, 'set_memo', {
      nodeId,
      text: '',
      scope: 'library',
      libraryId: testLibraryId,
      browser,
    });
    const cleared = await waitFor(async () => {
      const n = await findNodeInLibrary(nodeId);
      return (n && (n.memoText === '' || n.memoText == null)) ? n : null;
    }, { label: 'set_memo-cleared' });
    expect(cleared.memoText == null || cleared.memoText === '').toBe(true);
  });
});

describe('set_star_color', () => {
  it('sets starColor by name and clears on null', async () => {
    const nodeId = await makeGroup('star-target');
    await callToolOk(session.client, 'set_star_color', {
      nodeId,
      color: 'blue',
      scope: 'library',
      libraryId: testLibraryId,
      browser,
    });
    const colored = await waitFor(async () => {
      const n = await findNodeInLibrary(nodeId);
      return n?.starColor ? n : null;
    }, { label: 'set_star_color-applied' });
    expect(colored.starColor).toBeTruthy();

    await callToolOk(session.client, 'set_star_color', {
      nodeId,
      color: null,
      scope: 'library',
      libraryId: testLibraryId,
      browser,
    });
    const cleared = await waitFor(async () => {
      const n = await findNodeInLibrary(nodeId);
      return n && !n.starColor ? n : null;
    }, { label: 'set_star_color-cleared' });
    expect(cleared.starColor).toBeFalsy();
  });
});

describe('set_row_color', () => {
  it('sets rowColor on a group node and resets to accent2 on null', async () => {
    const nodeId = await makeGroup('row-target');
    await callToolOk(session.client, 'set_row_color', {
      nodeId,
      rowColor: 'purple',
      scope: 'library',
      libraryId: testLibraryId,
      browser,
    });
    const colored = await waitFor(async () => {
      const n = await findNodeInLibrary(nodeId);
      return n?.rowColor && n.rowColor !== 'accent2' ? n : null;
    }, { label: 'set_row_color-applied' });
    expect(colored.rowColor).toBeTruthy();
    expect(colored.rowColor).not.toBe('accent2');

    await callToolOk(session.client, 'set_row_color', {
      nodeId,
      rowColor: null,
      scope: 'library',
      libraryId: testLibraryId,
      browser,
    });
    const reset = await waitFor(async () => {
      const n = await findNodeInLibrary(nodeId);
      return n?.rowColor === 'accent2' ? n : null;
    }, { label: 'set_row_color-reset' });
    expect(reset.rowColor).toBe('accent2');
  });
});

describe('set_title', () => {
  it('renames a node and persists customTitle flag', async () => {
    const nodeId = await makeGroup('title-target');
    const newTitle = testLabel('renamed');
    await callToolOk(session.client, 'set_title', {
      nodeId,
      title: newTitle,
      scope: 'library',
      libraryId: testLibraryId,
      browser,
    });

    const renamed = await waitFor(async () => {
      const n = await findNodeInLibrary(nodeId);
      return n?.title === newTitle ? n : null;
    }, { label: 'set_title-applied' });
    expect(renamed.title).toBe(newTitle);
    expect(renamed.customTitle).toBe(true);
  });
});
