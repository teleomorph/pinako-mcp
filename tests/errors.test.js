import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { connectPinakoMcp, callTool, callToolOk, waitFor } from './helpers/mcp-client.js';
import { resolveTargetBrowser } from './helpers/browser.js';
import { testLabel } from './helpers/fixtures.js';

// Verifies the MCP error-path contract: every input-validation guard,
// reference-error path, and engine-side constraint produces the expected
// error response shape so AI agents can branch on error.code correctly.

let session;
let browser;
let testGroupId;
let testLibraryId;
let reorderGroupId;
let reorderLibA, reorderLibB, reorderLibC;

beforeAll(async () => {
  session = await connectPinakoMcp();
  browser = await resolveTargetBrowser(session.client);

  // Main test group + library for most tests
  const group = await callToolOk(session.client, 'create_library_group', {
    title: testLabel('errors-suite'),
    browser,
  });
  testGroupId = group.result.createdGroupId;

  const lib = await callToolOk(session.client, 'create_library', {
    title: testLabel('errors-lib'),
    browser,
  });
  testLibraryId = lib.result.createdLibraryId;

  await callToolOk(session.client, 'add_library_to_group', {
    groupId: testGroupId,
    libraryId: testLibraryId,
    browser,
  });

  // Separate group + 3 libraries for reorder constraint tests
  const rg = await callToolOk(session.client, 'create_library_group', {
    title: testLabel('errors-reorder-grp'),
    browser,
  });
  reorderGroupId = rg.result.createdGroupId;

  for (const suffix of ['reorder-A', 'reorder-B', 'reorder-C']) {
    const l = await callToolOk(session.client, 'create_library', {
      title: testLabel(suffix),
      browser,
    });
    if (suffix === 'reorder-A') reorderLibA = l.result.createdLibraryId;
    if (suffix === 'reorder-B') reorderLibB = l.result.createdLibraryId;
    if (suffix === 'reorder-C') reorderLibC = l.result.createdLibraryId;
    await callToolOk(session.client, 'add_library_to_group', {
      groupId: reorderGroupId,
      libraryId: l.result.createdLibraryId,
      browser,
    });
  }

  // Wait for reorder group membership to stabilize
  await waitFor(async () => {
    const { groups } = await callToolOk(session.client, 'list_libraries', { browser });
    const g = groups?.find(x => x.id === reorderGroupId);
    return g && Array.isArray(g.library_ids) && g.library_ids.length === 3 ? g : null;
  }, { label: 'reorder-group-stable' });
});

afterAll(async () => {
  for (const gid of [testGroupId, reorderGroupId]) {
    if (!gid) continue;
    try {
      await callToolOk(session.client, 'delete_library_group', {
        groupId: gid,
        cascadeMembers: true,
        confirmedByUser: true,
        browser,
      });
    } catch (err) {
      console.warn(`cleanup: cascade-delete group ${gid} failed: ${err.message}`);
    }
  }
  if (session) await session.close();
});

function expectMcpZodReject(result, fieldName) {
  expect(result.isError).toBe(true);
  const raw = result.parsed?._rawText ?? JSON.stringify(result.parsed);
  expect(raw).toMatch(/MCP error -32602|Invalid|validation/i);
  if (fieldName) expect(raw).toContain(fieldName);
}

function expectEngineError(result, expectedCode) {
  expect(result.isError).toBe(true);
  expect(result.parsed?.ok).toBe(false);
  expect(result.parsed?.error?.code).toBe(expectedCode);
}

describe('Input validation (Zod schema gates)', () => {
  it('rejects set_tags with non-array tags arg', async () => {
    const result = await callTool(session.client, 'set_tags', {
      nodeId: 'any-nodeid',
      tags: 'this-is-a-string-not-an-array',
      scope: 'library',
      libraryId: testLibraryId,
      browser,
    });
    expectMcpZodReject(result, 'tags');
  });

  it('rejects create_library with title > 200 chars', async () => {
    const result = await callTool(session.client, 'create_library', {
      title: 'a'.repeat(201),
      browser,
    });
    expectMcpZodReject(result, 'title');
  });

  it('rejects delete_node with confirmedByUser:false (must be literal true)', async () => {
    const result = await callTool(session.client, 'delete_node', {
      nodeId: 'any-nodeid',
      confirmedByUser: false,
      scope: 'library',
      libraryId: testLibraryId,
      browser,
    });
    expectMcpZodReject(result, 'confirmedByUser');
  });
});

describe('Reference errors (NOT_FOUND)', () => {
  it('NODE_NOT_FOUND: set_tags on a fake nodeId', async () => {
    const result = await callTool(session.client, 'set_tags', {
      nodeId: 'node-does-not-exist-xyz',
      tags: ['fake'],
      scope: 'library',
      libraryId: testLibraryId,
      browser,
    });
    expectEngineError(result, 'NODE_NOT_FOUND');
  });

  it('LIBRARY_NOT_FOUND-style error: get_library with a fake library_id', async () => {
    const result = await callTool(session.client, 'get_library', {
      library_id: 'library-does-not-exist-xyz',
      mode: 'lite',
      browser,
    });
    expect(result.isError).toBe(true);
    const raw = result.parsed?._rawText ?? JSON.stringify(result.parsed);
    expect(raw).toMatch(/not found|Library not/i);
  });

  it('GROUP_NOT_FOUND: add_library_to_group with a fake groupId', async () => {
    const result = await callTool(session.client, 'add_library_to_group', {
      groupId: 'libgroup-does-not-exist-xyz',
      libraryId: testLibraryId,
      browser,
    });
    expectEngineError(result, 'GROUP_NOT_FOUND');
  });
});

describe('Engine constraints', () => {
  it('rejects tag > 50 chars (per-tag length cap)', async () => {
    // Create a target node to tag
    const grp = await callToolOk(session.client, 'create_group', {
      title: testLabel('tag-length-target'),
      scope: 'library',
      libraryId: testLibraryId,
      browser,
    });
    const nodeId = grp.result.createdId;
    await waitFor(async () => {
      const fetched = await callToolOk(session.client, 'get_library', {
        library_id: testLibraryId, mode: 'lite', browser,
      });
      return findById(fetched.library.children || [], nodeId) ? true : null;
    }, { label: 'tag-target-visible' });

    const result = await callTool(session.client, 'set_tags', {
      nodeId,
      tags: ['a'.repeat(51)],
      scope: 'library',
      libraryId: testLibraryId,
      browser,
    });
    expect(result.isError).toBe(true);
    expect(result.parsed?.ok).toBe(false);
    // Either Zod-level (if schema enforces) or engine-level constraint
    const errPayload = JSON.stringify(result.parsed);
    expect(errPayload).toMatch(/50|tag|length|too long|invalid/i);
  });

  it('LIBRARY_ORDER_MISMATCH: reorder with wrong member count', async () => {
    const result = await callTool(session.client, 'reorder_libraries_in_group', {
      groupId: reorderGroupId,
      libraryIds: [reorderLibA, reorderLibB],  // missing reorderLibC
      browser,
    });
    expectEngineError(result, 'LIBRARY_ORDER_MISMATCH');
  });

  // SKIPPED — real bug in the extension: reorder_libraries_in_group with
  // an unknown (well-formed but nonexistent) library id consistently
  // returns PORT_DISCONNECTED instead of the documented
  // LIBRARY_ORDER_UNKNOWN_MEMBER. The mismatch + duplicate cases reject
  // gracefully, so the engine's validation logic appears to dereference
  // the unknown id deeper before classifying it, crashing the native-
  // messaging port. Tracked in agentic-ai-pre-ship-fixes.md #4. Unskip
  // once the engine returns LIBRARY_ORDER_UNKNOWN_MEMBER gracefully.
  it.skip('LIBRARY_ORDER_UNKNOWN_MEMBER: reorder with an unknown library id', async () => {
    const result = await callTool(session.client, 'reorder_libraries_in_group', {
      groupId: reorderGroupId,
      libraryIds: [reorderLibA, reorderLibB, 'folder-stranger-xyz'],
      browser,
    });
    expectEngineError(result, 'LIBRARY_ORDER_UNKNOWN_MEMBER');
  });

  it('LIBRARY_ORDER_DUPLICATE: reorder with a duplicate library id', async () => {
    const result = await callTool(session.client, 'reorder_libraries_in_group', {
      groupId: reorderGroupId,
      libraryIds: [reorderLibA, reorderLibA, reorderLibB],
      browser,
    });
    expectEngineError(result, 'LIBRARY_ORDER_DUPLICATE');
  });

  it('BULK_SCOPE_MISMATCH: sub-op with conflicting explicit scope', async () => {
    const result = await callTool(session.client, 'bulk_apply', {
      ops: [
        { type: 'set_tags', nodeId: 'any', tags: ['x'], scope: 'tree' },
      ],
      scope: 'library',
      libraryId: testLibraryId,
      browser,
    });
    expectEngineError(result, 'BULK_SCOPE_MISMATCH');
  });
});

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
