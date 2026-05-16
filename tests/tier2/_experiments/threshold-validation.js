// Natural-choice validation for the bulk_apply threshold tweak.
//
// After updating the description from "3 or more" to "6 or more", we
// want to confirm the agent now picks:
//   - N=3: individual (below threshold)
//   - N=8: bulk_apply (above threshold)
//
// Both tools available; the agent decides freely based on the
// description. No `disallowedTools` forcing here.

import { runAgent } from '../helpers/agent-runner.js';
import { connectPinakoMcp, callToolOk, waitFor } from '../../helpers/mcp-client.js';
import { resolveTargetBrowser } from '../../helpers/browser.js';
import { testLabel } from '../../helpers/fixtures.js';

const N_VALUES = [3, 8];
const MODEL = 'claude-haiku-4-5-20251001';

if (!process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.ANTHROPIC_API_KEY) {
  console.error('Auth env wrong — set CLAUDE_CODE_OAUTH_TOKEN, unset ANTHROPIC_API_KEY.');
  process.exit(1);
}

async function setupTargets(session, browser, N, label) {
  const group = await callToolOk(session.client, 'create_library_group', {
    title: testLabel(`valid-${label}-group`), browser,
  });
  const lib = await callToolOk(session.client, 'create_library', {
    title: testLabel(`valid-${label}-lib`), browser,
  });
  await callToolOk(session.client, 'add_library_to_group', {
    groupId: group.result.createdGroupId,
    libraryId: lib.result.createdLibraryId,
    browser,
  });
  const nodeIds = [];
  for (let i = 0; i < N; i++) {
    const g = await callToolOk(session.client, 'create_group', {
      title: testLabel(`valid-${label}-tgt-${i}`),
      scope: 'library',
      libraryId: lib.result.createdLibraryId,
      browser,
    });
    nodeIds.push(g.result.createdId);
  }
  return {
    groupId: group.result.createdGroupId,
    libraryId: lib.result.createdLibraryId,
    nodeIds,
  };
}

async function cleanup(session, browser, groupId) {
  try {
    await callToolOk(session.client, 'delete_library_group', {
      groupId, cascadeMembers: true, confirmedByUser: true, browser,
    });
  } catch (err) {
    console.warn(`  cleanup failed: ${err.message}`);
  }
}

async function validateAt(session, browser, N) {
  const label = `n${N}`;
  console.log(`\n--- N=${N} (natural choice, both tools allowed) ---`);
  const setup = await setupTargets(session, browser, N, label);
  try {
    const tag = `valid-${label}`;
    const targets = setup.nodeIds.map(id => `- ${id}`).join('\n');
    const prompt = [
      `Use Pinako MCP tools to add the tag "${tag}" to ${N} nodes in library "${setup.libraryId}" on browser "${browser}".`,
      ``,
      `Target node ids:`,
      targets,
      ``,
      `Each of the ${N} nodes should end up with "${tag}" in its tag list. Pick whichever tool approach fits best.`,
      ``,
      `When done, reply with: DONE tagged=<n>`,
    ].join('\n');

    const run = await runAgent({
      prompt,
      model: MODEL,
      allowedTools: ['mcp__pinako__add_tags', 'mcp__pinako__bulk_apply'],
      maxTurns: Math.max(N * 2 + 10, 25),
    });

    const bulkCalls = run.toolCalls.filter(c => c.name === 'mcp__pinako__bulk_apply').length;
    const indCalls = run.toolCalls.filter(c => c.name === 'mcp__pinako__add_tags').length;
    const strategy = bulkCalls > 0 && indCalls === 0 ? 'bulk'
                   : indCalls > 0 && bulkCalls === 0 ? 'individual'
                   : 'mixed';

    console.log(`  picked: ${strategy} (bulk=${bulkCalls}, ind=${indCalls})`);
    console.log(`  calls=${run.toolCalls.length}, agent=${run.durationMs}ms, cost=$${run.totalCostUsd?.toFixed(4)}`);

    // Just verify all N tagged, ignore strategy assertion here — caller decides.
    await waitFor(async () => {
      const fetched = await callToolOk(session.client, 'get_library', {
        library_id: setup.libraryId, mode: 'full', browser,
      });
      const allNodes = [];
      (function collect(nodes) {
        for (const n of nodes || []) {
          allNodes.push(n);
          if (Array.isArray(n.children)) collect(n.children);
        }
      })(fetched.library?.children ?? []);
      const hits = setup.nodeIds.map(id => allNodes.find(n => n.id === id));
      if (hits.some(n => !n)) return null;
      if (hits.every(n => (n.tags ?? []).includes(tag))) return hits;
      return null;
    }, { label: `tagged-${N}`, timeout: Math.max(N * 2_000, 15_000) });

    return { N, strategy, bulkCalls, indCalls };
  } finally {
    await cleanup(session, browser, setup.groupId);
  }
}

async function main() {
  console.log(`Threshold validation (post-description-tweak)`);
  console.log(`Expecting: N=3 → individual, N=8 → bulk\n`);

  const session = await connectPinakoMcp();
  const browser = await resolveTargetBrowser(session.client);

  const results = [];
  for (const N of N_VALUES) {
    results.push(await validateAt(session, browser, N));
  }
  await session.close();

  console.log(`\n=== Validation summary ===\n`);
  const expected = { 3: 'individual', 8: 'bulk' };
  let allPass = true;
  for (const r of results) {
    const want = expected[r.N];
    const ok = r.strategy === want;
    if (!ok) allPass = false;
    console.log(`  N=${r.N}: expected ${want}, got ${r.strategy} ${ok ? '✓' : '✗'}`);
  }
  console.log(`\n${allPass ? 'PASS' : 'FAIL'}: threshold tweak ${allPass ? 'validated' : 'NOT validated'}.`);
}

main().catch(err => {
  console.error('Validation crashed:', err);
  process.exit(1);
});
