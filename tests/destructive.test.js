import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { connectPinakoMcp, callTool, callToolOk, waitFor } from './helpers/mcp-client.js';
import { resolveTargetBrowser } from './helpers/browser.js';
import { testLabel } from './helpers/fixtures.js';

// Verifies the destructive-op confirmation gates. Two layers:
//   1. Top-level: Zod schema requires confirmedByUser:literal(true). Missing
//      it returns an MCP input validation error (-32602).
//   2. bulk_apply sub-ops: schema is z.object({}).passthrough(), so Zod can't
//      validate the sub-op shape. The bridge's _checkConfirmedByUser() catches
//      missing flags and returns CONFIRMATION_REQUIRED with subOpIndex.

let session;
let browser;
let testGroupId;
let testLibraryId;

beforeAll(async () => {
  session = await connectPinakoMcp();
  browser = await resolveTargetBrowser(session.client);

  const group = await callToolOk(session.client, 'create_library_group', {
    title: testLabel('destructive-suite'),
    browser,
  });
  testGroupId = group.result.createdGroupId;

  const lib = await callToolOk(session.client, 'create_library', {
    title: testLabel('destructive-lib'),
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

async function makeGhostTarget(suffix) {
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
  }, { label: `make-ghost-target-visible-${suffix}` });
  return nodeId;
}

async function findNodeInLibrary(nodeId) {
  const fetched = await callToolOk(session.client, 'get_library', {
    library_id: testLibraryId,
    mode: 'lite',
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

describe('delete_node confirmation gate', () => {
  it('rejects without confirmedByUser (Zod schema gate)', async () => {
    const nodeId = await makeGhostTarget('delnode-no-confirm');
    const result = await callTool(session.client, 'delete_node', {
      nodeId,
      scope: 'library',
      libraryId: testLibraryId,
      browser,
    });
    expect(result.isError).toBe(true);
    const rawText = result.parsed?._rawText ?? JSON.stringify(result.parsed);
    expect(rawText).toMatch(/validation error|Invalid|Required/i);
    expect(rawText).toContain('confirmedByUser');
    const stillThere = await findNodeInLibrary(nodeId);
    expect(stillThere, 'node should NOT have been deleted').toBeTruthy();
  });

  it('succeeds with confirmedByUser:true and removes the node', async () => {
    const nodeId = await makeGhostTarget('delnode-confirmed');
    const present = await findNodeInLibrary(nodeId);
    expect(present, 'precondition: node exists before delete').toBeTruthy();

    await callToolOk(session.client, 'delete_node', {
      nodeId,
      confirmedByUser: true,
      scope: 'library',
      libraryId: testLibraryId,
      browser,
    });

    const gone = await waitFor(async () => {
      const n = await findNodeInLibrary(nodeId);
      return n === null ? true : null;
    }, { label: 'delete_node-applied' });
    expect(gone).toBe(true);
  });
});

describe('delete_live_node confirmation gate', () => {
  it('rejects without confirmedByUser (Zod schema gate)', async () => {
    const nodeId = await makeGhostTarget('dellive-no-confirm');
    const result = await callTool(session.client, 'delete_live_node', {
      nodeId,
      scope: 'library',
      libraryId: testLibraryId,
      browser,
    });
    expect(result.isError).toBe(true);
    const rawText = result.parsed?._rawText ?? JSON.stringify(result.parsed);
    expect(rawText).toContain('confirmedByUser');
    const stillThere = await findNodeInLibrary(nodeId);
    expect(stillThere, 'node should NOT have been deleted').toBeTruthy();
  });
});

describe('delete_library_group cascade confirmation gate', () => {
  it('rejects cascadeMembers:true without confirmedByUser', async () => {
    const dummyGroup = await callToolOk(session.client, 'create_library_group', {
      title: testLabel('cascade-no-confirm-grp'),
      browser,
    });
    const dummyGroupId = dummyGroup.result.createdGroupId;

    const dummyLib = await callToolOk(session.client, 'create_library', {
      title: testLabel('cascade-no-confirm-lib'),
      browser,
    });
    await callToolOk(session.client, 'add_library_to_group', {
      groupId: dummyGroupId,
      libraryId: dummyLib.result.createdLibraryId,
      browser,
    });

    try {
      const result = await callTool(session.client, 'delete_library_group', {
        groupId: dummyGroupId,
        cascadeMembers: true,
        browser,
      });
      expect(result.isError).toBe(true);
      const rawText = result.parsed?._rawText ?? JSON.stringify(result.parsed);
      expect(rawText).toContain('confirmedByUser');
    } finally {
      await callToolOk(session.client, 'delete_library_group', {
        groupId: dummyGroupId,
        cascadeMembers: true,
        confirmedByUser: true,
        browser,
      });
    }
  });

  it('allows dissolve (cascadeMembers omitted) without confirmedByUser', async () => {
    const dissolveGroup = await callToolOk(session.client, 'create_library_group', {
      title: testLabel('dissolve-no-confirm'),
      browser,
    });
    await callToolOk(session.client, 'delete_library_group', {
      groupId: dissolveGroup.result.createdGroupId,
      browser,
    });
  });
});

describe('bulk_apply destructive sub-op gate (bridge boundary)', () => {
  it('rejects bulk with destructive sub-op missing confirmedByUser, reports subOpIndex', async () => {
    const nodeId = await makeGhostTarget('bulk-no-confirm');
    const result = await callTool(session.client, 'bulk_apply', {
      ops: [
        { type: 'set_title', nodeId, title: testLabel('bulk-renamed') },
        { type: 'delete_node', nodeId },
      ],
      scope: 'library',
      libraryId: testLibraryId,
      browser,
    });

    expect(result.isError).toBe(true);
    expect(result.parsed?.ok).toBe(false);
    expect(result.parsed?.error?.code).toBe('CONFIRMATION_REQUIRED');
    expect(result.parsed?.error?.context?.subOpIndex).toBe(1);
    expect(result.parsed?.error?.context?.opType).toBe('delete_node');

    const stillThere = await findNodeInLibrary(nodeId);
    expect(stillThere, 'node should NOT have been deleted').toBeTruthy();
  });
});
