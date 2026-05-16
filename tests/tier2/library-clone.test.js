import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { runAgent, toolCallsByName } from './helpers/agent-runner.js';
import { connectPinakoMcp, callToolOk, waitFor } from '../helpers/mcp-client.js';
import { resolveTargetBrowser } from '../helpers/browser.js';
import { testLabel } from '../helpers/fixtures.js';

// Tier 2: probes the agent's ability to chain read → write across two
// libraries. The agent has a source library and a destination library
// but does NOT receive the source's node IDs in the prompt; it must
// call get_library on the source first to discover what to clone,
// then call add_to_library with sourceScope/sourceLibraryId/nodeIds
// inferred from that read.
//
// A failure here would mean either:
// - get_library's response shape isn't agent-readable (no clear ids
//   to grab), or
// - add_to_library's description doesn't make the cross-library
//   parameter shape discoverable.

const HAS_OAUTH = !!process.env.CLAUDE_CODE_OAUTH_TOKEN;
const HAS_API_KEY = !!process.env.ANTHROPIC_API_KEY;
const TIER2_RUNNABLE = HAS_OAUTH && !HAS_API_KEY;
const TEST_TIMEOUT_MS = 180_000;

describe.skipIf(!TIER2_RUNNABLE)('Tier 2 agent — library-to-library clone', () => {
  let session;
  let browser;
  let testGroupId;
  let srcLibraryId;
  let dstLibraryId;
  let seededGroupTitle;
  let seededNoteTitle;

  beforeAll(async () => {
    session = await connectPinakoMcp();
    browser = await resolveTargetBrowser(session.client);

    const group = await callToolOk(session.client, 'create_library_group', {
      title: testLabel('tier2-clone-group'),
      browser,
    });
    testGroupId = group.result.createdGroupId;

    const srcLib = await callToolOk(session.client, 'create_library', {
      title: testLabel('tier2-clone-src'),
      browser,
    });
    srcLibraryId = srcLib.result.createdLibraryId;

    const dstLib = await callToolOk(session.client, 'create_library', {
      title: testLabel('tier2-clone-dst'),
      browser,
    });
    dstLibraryId = dstLib.result.createdLibraryId;

    await callToolOk(session.client, 'add_library_to_group', {
      groupId: testGroupId,
      libraryId: srcLibraryId,
      browser,
    });
    await callToolOk(session.client, 'add_library_to_group', {
      groupId: testGroupId,
      libraryId: dstLibraryId,
      browser,
    });

    // Seed the source library with a single distinctive group (a TREE
    // child, not a library-scope note) so we can later assert it appears
    // in the destination after the clone. Deliberately NOT seeding a
    // library-notes entry — add_to_library only operates on tree
    // children, and including notes makes the agent's job ambiguous
    // (the agent has to know to filter them out of get_library's
    // response). That ambiguity is real and worth logging as a finding,
    // but it shouldn't be the source of flakiness for this proof.
    seededGroupTitle = testLabel('tier2-clone-seed-group');
    seededNoteTitle = null; // intentionally unused; preserved for log parity
    await callToolOk(session.client, 'create_group', {
      title: seededGroupTitle,
      scope: 'library',
      libraryId: srcLibraryId,
      browser,
    });
  }, TEST_TIMEOUT_MS);

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
  }, TEST_TIMEOUT_MS);

  it('agent reads source library, then clones its child nodes into destination', async () => {
    const prompt = [
      `Use the Pinako MCP tools to copy content between two Pinako libraries on browser "${browser}".`,
      ``,
      `Source library id: ${srcLibraryId}`,
      `Destination library id: ${dstLibraryId}`,
      ``,
      `Steps:`,
      `1. Read the contents of the source library to find out which child nodes it contains.`,
      `2. Clone every top-level child node from the source library into the destination library, including any descendants. (The destination library should end up containing copies of the source's top-level children.)`,
      ``,
      `When done, reply with one line: DONE clonedCount=<n>`,
    ].join('\n');

    const run = await runAgent({
      prompt,
      allowedTools: [
        'mcp__pinako__get_library',
        'mcp__pinako__add_to_library',
      ],
      maxTurns: 15,
    });

    expect(run.systemInit, 'system init captured').toBeTruthy();
    const pinakoServer = (run.systemInit?.mcpServers ?? []).find(s => s.name === 'pinako');
    expect(pinakoServer?.status).toBe('connected');

    // Diagnostic log up front so description-quality findings surface
    // regardless of pass/fail.
    console.log(
      `tier2 library-clone tool calls: ` +
      run.toolCalls.map(tc => `${tc.name}(${Object.keys(tc.input || {}).join(',')})`).join(' → '),
    );

    const getLibCalls = toolCallsByName(run.toolCalls, 'mcp__pinako__get_library');
    const addCalls = toolCallsByName(run.toolCalls, 'mcp__pinako__add_to_library');
    expect(getLibCalls.length, 'agent read source library at least once').toBeGreaterThanOrEqual(1);
    expect(addCalls.length, 'agent issued at least one add_to_library call').toBeGreaterThanOrEqual(1);

    // The agent should have read from srcLibraryId at least once. Inputs to
    // add_to_library should target dstLibraryId with sourceScope='library'.
    const readFromSrc = getLibCalls.some(c => (c.input?.library_id || c.input?.libraryId) === srcLibraryId);
    expect(readFromSrc, 'get_library was called on the source library').toBe(true);

    const validAdds = addCalls.filter(c =>
      c.input?.libraryId === dstLibraryId &&
      (c.input?.sourceScope === 'library' || c.input?.sourceScope === 'main_tree')
    );
    expect(validAdds.length, 'add_to_library targeted destination with a sourceScope').toBeGreaterThanOrEqual(1);

    const errored = run.toolCalls.filter(tc => tc.resultIsError);
    expect(errored, `no errored tool calls (got: ${errored.map(t => t.name).join(', ')})`).toEqual([]);

    // Verify final state: the destination library contains nodes whose
    // titles match what the source had.
    const dstTitles = await waitFor(async () => {
      const fetched = await callToolOk(session.client, 'get_library', {
        library_id: dstLibraryId,
        mode: 'lite',
        browser,
      });
      const flat = collectTitles(fetched.library?.children ?? []);
      if (flat.includes(seededGroupTitle)) return flat;
      return null;
    }, { label: 'cloned-group-visible-in-dst', timeout: 12_000 });

    expect(dstTitles, 'cloned group landed in destination').toContain(seededGroupTitle);

    console.log(
      `tier2 library-clone: ${run.toolCalls.length} calls, ${run.durationMs}ms, ` +
      `model=${run.systemInit?.model}, cost=${run.totalCostUsd ?? 'n/a'}, ` +
      `finalText="${(run.finalText || '').slice(0, 120)}"`,
    );
  }, TEST_TIMEOUT_MS);
});

function collectTitles(nodes, out = []) {
  for (const n of nodes || []) {
    if (n.title) out.push(n.title);
    if (Array.isArray(n.children)) collectTitles(n.children, out);
  }
  return out;
}
