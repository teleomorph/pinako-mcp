// Bulk-apply threshold sweep — empirical cost/latency crossover.
//
// For each N in N_VALUES, runs the agent twice:
//   - allowedTools = [add_tags]   → forced individual, N tool calls
//   - allowedTools = [bulk_apply] → forced bulk, 1 tool call with N sub-ops
//
// Captures: tool calls, wall-clock duration, computed token cost,
// input/output tokens. Cleans up each scenario's library_group via
// cascade-delete.
//
// Operation under test: set_tags equivalent ("add the tag X to N nodes").
// Prompt: clear, numbered list of target node ids.
// Model: Haiku 4.5 (the agentic-ai branch default).
//
// Run from pinako-mcp root with the OAuth token in env:
//   node tests/tier2/_experiments/bulk-threshold-sweep.js
//
// Writes a markdown summary to
//   tests/tier2/_experiments/bulk-threshold-results.md
//
// Skips itself silently if CLAUDE_CODE_OAUTH_TOKEN is not set.

import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { runAgent } from '../helpers/agent-runner.js';
import { connectPinakoMcp, callToolOk, waitFor } from '../../helpers/mcp-client.js';
import { resolveTargetBrowser } from '../../helpers/browser.js';
import { testLabel } from '../../helpers/fixtures.js';

const N_VALUES = [3, 5, 10, 15, 20];
const STRATEGIES = ['individual', 'bulk'];
const MODEL = 'claude-haiku-4-5-20251001';

if (!process.env.CLAUDE_CODE_OAUTH_TOKEN) {
  console.error('CLAUDE_CODE_OAUTH_TOKEN not set — aborting experiment.');
  process.exit(1);
}
if (process.env.ANTHROPIC_API_KEY) {
  console.error('ANTHROPIC_API_KEY is set — would route to API billing. Unset and retry.');
  process.exit(1);
}

async function setupTargets(session, browser, N, label) {
  const group = await callToolOk(session.client, 'create_library_group', {
    title: testLabel(`exp-${label}-group`),
    browser,
  });
  const lib = await callToolOk(session.client, 'create_library', {
    title: testLabel(`exp-${label}-lib`),
    browser,
  });
  await callToolOk(session.client, 'add_library_to_group', {
    groupId: group.result.createdGroupId,
    libraryId: lib.result.createdLibraryId,
    browser,
  });
  const nodeIds = [];
  for (let i = 0; i < N; i++) {
    const g = await callToolOk(session.client, 'create_group', {
      title: testLabel(`exp-${label}-target-${i}`),
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
    console.warn(`  cleanup failed for ${groupId}: ${err.message}`);
  }
}

function collectAll(nodes, out = []) {
  for (const n of nodes || []) {
    out.push(n);
    if (Array.isArray(n.children)) collectAll(n.children, out);
  }
  return out;
}

async function runScenario(session, browser, N, strategy) {
  const label = `${strategy}-n${N}`;
  console.log(`\n--- N=${N}, strategy=${strategy} ---`);
  const setup = await setupTargets(session, browser, N, label);
  console.log(`  setup: ${N} nodes ready in library ${setup.libraryId.slice(0, 20)}…`);

  try {
    const expectedTag = `exp-${label}`;
    const targetList = setup.nodeIds.map(id => `- ${id}`).join('\n');
    const prompt = [
      `Use the Pinako MCP tools to add the tag "${expectedTag}" to ${N} nodes in library "${setup.libraryId}" on browser "${browser}".`,
      ``,
      `Target node ids:`,
      targetList,
      ``,
      `Every one of the ${N} nodes should end up with "${expectedTag}" in its tag list.`,
      ``,
      `When done, reply with one line: DONE tagged=<n>`,
    ].join('\n');

    // Force strategy via disallowedTools — allowedTools is auto-approval
    // only under bypassPermissions, not surface restriction. disallowedTools
    // actually removes the tool from the agent's catalog.
    const disallowedTools = strategy === 'bulk'
      ? ['mcp__pinako__add_tags']
      : ['mcp__pinako__bulk_apply'];

    // Generous turn budget for individual at high N.
    const maxTurns = strategy === 'individual' ? Math.max(N * 2 + 10, 30) : 15;

    const runStart = Date.now();
    const run = await runAgent({ prompt, model: MODEL, disallowedTools, maxTurns });
    const agentMs = Date.now() - runStart;

    // Verify all N nodes ended up tagged. Generous timeout — individual at
    // N=20 has 20 bridge dispatches stacked up.
    const verifyTimeout = Math.max(N * 2_000, 15_000);
    const verifyStart = Date.now();
    let allTagged = false;
    try {
      await waitFor(async () => {
        const fetched = await callToolOk(session.client, 'get_library', {
          library_id: setup.libraryId,
          mode: 'full',
          browser,
        });
        const allNodes = collectAll(fetched.library?.children ?? []);
        const hits = setup.nodeIds.map(id => allNodes.find(n => n.id === id));
        if (hits.some(n => !n)) return null;
        if (hits.every(n => (n.tags ?? []).includes(expectedTag))) return hits;
        return null;
      }, { label: `all-${N}-tagged-${strategy}`, timeout: verifyTimeout });
      allTagged = true;
    } catch (err) {
      console.warn(`  verify timed out: ${err.message}`);
    }
    const verifyMs = Date.now() - verifyStart;

    const bulkCalls = run.toolCalls.filter(c => c.name === 'mcp__pinako__bulk_apply').length;
    const indCalls = run.toolCalls.filter(c => c.name === 'mcp__pinako__add_tags').length;
    const erroredCalls = run.toolCalls.filter(c => c.resultIsError).length;

    const result = {
      N, strategy, success: allTagged,
      totalCalls: run.toolCalls.length,
      bulkCalls, indCalls, erroredCalls,
      agentMs, verifyMs,
      durationMs: run.durationMs,
      cost: run.totalCostUsd,
      inputTokens: run.usage?.input_tokens,
      outputTokens: run.usage?.output_tokens,
      cacheCreationTokens: run.usage?.cache_creation_input_tokens,
      cacheReadTokens: run.usage?.cache_read_input_tokens,
      finalText: (run.finalText || '').slice(0, 120),
    };

    console.log(
      `  → ${allTagged ? 'OK' : 'PARTIAL'} ` +
      `calls=${run.toolCalls.length} (bulk=${bulkCalls}, ind=${indCalls}, err=${erroredCalls}) ` +
      `agent=${agentMs}ms verify=${verifyMs}ms ` +
      `cost=$${result.cost?.toFixed(4) ?? 'n/a'} ` +
      `tokens=${result.inputTokens ?? '?'}in/${result.outputTokens ?? '?'}out`,
    );

    return result;
  } catch (err) {
    console.error(`  FAIL: ${err.message}`);
    return { N, strategy, success: false, error: err.message };
  } finally {
    await cleanup(session, browser, setup.groupId);
  }
}

function buildReport(results, browser) {
  const lines = [];
  lines.push('# bulk_apply threshold sweep — empirical results');
  lines.push('');
  lines.push(`- Generated: ${new Date().toISOString()}`);
  lines.push(`- Model: ${MODEL}`);
  lines.push(`- Browser: ${browser}`);
  lines.push(`- Operation under test: add a single tag to N target nodes (library scope)`);
  lines.push(`- Prompt style: clear (numbered list of target ids)`);
  lines.push(`- Description version: includes the "TWO USE CASES + N>=3 rule" rewrite landed in pinako-mcp commit \`90f2513\``);
  lines.push('');
  lines.push('Each (N, strategy) row is ONE run. Strategy is forced by `allowedTools`:');
  lines.push('- `individual` allows only `add_tags`; agent must make N calls.');
  lines.push('- `bulk` allows only `bulk_apply`; agent composes one ops array of N sub-ops.');
  lines.push('');
  lines.push('## Raw measurements');
  lines.push('');
  lines.push('| N | Strategy | OK | Calls | Agent ms | Verify ms | Cost $ | Input tok | Output tok | Cache read |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|');
  for (const r of results) {
    if (!r.success && r.error) {
      lines.push(`| ${r.N} | ${r.strategy} | FAIL | — | — | — | — | — | — | _${r.error.slice(0, 60)}_ |`);
      continue;
    }
    lines.push(
      `| ${r.N} | ${r.strategy} | ${r.success ? 'yes' : 'partial'} | ${r.totalCalls} ` +
      `| ${r.agentMs} | ${r.verifyMs} | ${r.cost?.toFixed(4) ?? 'n/a'} ` +
      `| ${r.inputTokens ?? '?'} | ${r.outputTokens ?? '?'} | ${r.cacheReadTokens ?? '?'} |`
    );
  }
  lines.push('');

  // Compute inflection points: at each N, individual vs bulk on cost and latency.
  lines.push('## Inflection summary');
  lines.push('');
  lines.push('| N | Cost: ind | Cost: bulk | Cost winner | Latency: ind | Latency: bulk | Latency winner |');
  lines.push('|---|---|---|---|---|---|---|');
  const byN = new Map();
  for (const r of results) {
    if (!r.success || !r.cost) continue;
    if (!byN.has(r.N)) byN.set(r.N, {});
    byN.get(r.N)[r.strategy] = r;
  }
  for (const N of N_VALUES) {
    const pair = byN.get(N);
    if (!pair || !pair.individual || !pair.bulk) {
      lines.push(`| ${N} | — | — | — | — | — | — |`);
      continue;
    }
    const indCost = pair.individual.cost;
    const bulkCost = pair.bulk.cost;
    const indLat = pair.individual.agentMs;
    const bulkLat = pair.bulk.agentMs;
    const costWinner = indCost < bulkCost ? 'individual' : 'bulk';
    const latWinner = indLat < bulkLat ? 'individual' : 'bulk';
    lines.push(
      `| ${N} | $${indCost.toFixed(4)} | $${bulkCost.toFixed(4)} | **${costWinner}** ` +
      `| ${indLat}ms | ${bulkLat}ms | **${latWinner}** |`
    );
  }
  lines.push('');

  // Quick takeaway block — filled in by hand after eyeballing the table.
  lines.push('## Takeaway');
  lines.push('');
  lines.push('_(filled in by hand after reviewing the table above)_');
  lines.push('');

  return lines.join('\n');
}

async function main() {
  console.log(`Starting bulk_apply threshold sweep`);
  console.log(`Model: ${MODEL}`);
  console.log(`N values: ${N_VALUES.join(', ')}`);
  console.log(`Strategies: ${STRATEGIES.join(', ')}`);
  console.log(`Total runs: ${N_VALUES.length * STRATEGIES.length}`);

  const session = await connectPinakoMcp();
  const browser = await resolveTargetBrowser(session.client);
  console.log(`Connected; targeting browser: ${browser}\n`);

  const results = [];
  for (const N of N_VALUES) {
    for (const strategy of STRATEGIES) {
      const r = await runScenario(session, browser, N, strategy);
      results.push(r);
    }
  }
  await session.close();

  const report = buildReport(results, browser);
  const thisFile = fileURLToPath(import.meta.url);
  const reportPath = path.join(path.dirname(thisFile), 'bulk-threshold-results.md');
  await writeFile(reportPath, report, 'utf8');

  console.log(`\n\nReport written to: ${reportPath}`);
  console.log('\n' + report);
}

main().catch(err => {
  console.error('Experiment crashed:', err);
  process.exit(1);
});
