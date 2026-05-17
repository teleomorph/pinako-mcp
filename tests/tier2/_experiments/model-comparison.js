// Haiku 4.5 vs Sonnet 4.6 — same prompts, side-by-side comparison.
//
// Runs three scenarios through each model and writes a markdown
// report at tests/tier2/_experiments/model-comparison-results.md.
// Scenarios are chosen to surface quality differences:
//
//   1. vague-cleanup       — open-ended "clean it up" prompt with no
//                            specific target. Tests: does the model
//                            propose a structure, ask for clarification,
//                            or take blind action? Different models
//                            handle ambiguity very differently.
//   2. research-setup      — explicit multi-step task: create 3 topic
//                            groups + 3 memos. Tests: tool sequencing
//                            efficiency. Sonnet typically wastes fewer
//                            turns than Haiku on structured work.
//   3. ambiguous-rename    — explicit single op but the input ("Old
//                            Random Title 1278") gives zero semantic
//                            signal. Tests: does the model make up a
//                            title, ask for context, or use a neutral
//                            placeholder?
//
// Captures per run: tool calls (count + names), wall-clock duration,
// computed cost, final text, errored-call count. No pass/fail
// assertions — quality is a human-read judgment on the report.

import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { runAgent } from '../helpers/agent-runner.js';
import { connectPinakoMcp, callToolOk } from '../../helpers/mcp-client.js';
import { resolveTargetBrowser } from '../../helpers/browser.js';
import { testLabel } from '../../helpers/fixtures.js';

if (!process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.ANTHROPIC_API_KEY) {
  console.error('Auth env wrong — set CLAUDE_CODE_OAUTH_TOKEN, unset ANTHROPIC_API_KEY.');
  process.exit(1);
}

const MODELS = [
  { key: 'haiku-4.5',  id: 'claude-haiku-4-5-20251001' },
  { key: 'sonnet-4.6', id: 'claude-sonnet-4-6' },
];

// ─── Scenario definitions ────────────────────────────────────────────────────

const SCENARIOS = [
  {
    key: 'vague-cleanup',
    label: 'Vague "clean it up" prompt with no specific target',
    async setup(session, browser) {
      const group = await callToolOk(session.client, 'create_library_group', {
        title: testLabel('exp-vague-group'), browser,
      });
      const lib = await callToolOk(session.client, 'create_library', {
        title: testLabel('exp-vague-lib'), browser,
      });
      await callToolOk(session.client, 'add_library_to_group', {
        groupId: group.result.createdGroupId,
        libraryId: lib.result.createdLibraryId,
        browser,
      });
      const nodeIds = [];
      const randomTitles = [
        'untitled-2024-09',
        'misc notes from october',
        'project x scratchpad',
        'reading list draft 2',
        'tabs to revisit',
        'old bookmarks',
      ];
      for (const t of randomTitles) {
        const g = await callToolOk(session.client, 'create_group', {
          title: testLabel(`exp-vague-${t.replace(/\s+/g, '-')}`),
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
    },
    prompt(ctx, browser) {
      return [
        `I have a messy Pinako library that needs some organization love.`,
        ``,
        `Library id: ${ctx.libraryId}`,
        `Browser: ${browser}`,
        ``,
        `Can you help me clean it up? Do what you think is reasonable to make it more organized. You have ${ctx.nodeIds.length} loosely-named group nodes inside.`,
      ].join('\n');
    },
    allowedTools: [
      'mcp__pinako__get_library',
      'mcp__pinako__set_title',
      'mcp__pinako__set_memo',
      'mcp__pinako__add_tags',
      'mcp__pinako__create_group',
      'mcp__pinako__move_node',
      'mcp__pinako__bulk_apply',
    ],
    maxTurns: 30,
  },

  {
    key: 'research-setup',
    label: 'Multi-step: create 3 topic groups, each with a memo',
    async setup(session, browser) {
      const group = await callToolOk(session.client, 'create_library_group', {
        title: testLabel('exp-research-group'), browser,
      });
      const lib = await callToolOk(session.client, 'create_library', {
        title: testLabel('exp-research-lib'), browser,
      });
      await callToolOk(session.client, 'add_library_to_group', {
        groupId: group.result.createdGroupId,
        libraryId: lib.result.createdLibraryId,
        browser,
      });
      return {
        groupId: group.result.createdGroupId,
        libraryId: lib.result.createdLibraryId,
      };
    },
    prompt(ctx, browser) {
      return [
        `Set up a Research library structure in library id "${ctx.libraryId}" on browser "${browser}".`,
        ``,
        `Create three topic groups, one each for:`,
        `- "climate science"`,
        `- "AI safety"`,
        `- "gut microbiome"`,
        ``,
        `For each group, also attach a short plain-text memo (2-3 sentences) describing what the topic covers so future-me knows what kind of content belongs in each.`,
        ``,
        `When done, reply with: DONE`,
      ].join('\n');
    },
    allowedTools: [
      'mcp__pinako__create_group',
      'mcp__pinako__set_memo',
      'mcp__pinako__bulk_apply',
    ],
    maxTurns: 20,
  },

  {
    key: 'ambiguous-rename',
    label: 'Underspecified rename — make a meaningless title "more descriptive"',
    async setup(session, browser) {
      const group = await callToolOk(session.client, 'create_library_group', {
        title: testLabel('exp-rename-group'), browser,
      });
      const lib = await callToolOk(session.client, 'create_library', {
        title: testLabel('exp-rename-lib'), browser,
      });
      await callToolOk(session.client, 'add_library_to_group', {
        groupId: group.result.createdGroupId,
        libraryId: lib.result.createdLibraryId,
        browser,
      });
      // Use literal title (no test prefix variation) so the prompt below
      // can reference it verbatim.
      const seedTitle = 'Old Random Title 1278';
      const seed = await callToolOk(session.client, 'create_group', {
        title: seedTitle,
        scope: 'library',
        libraryId: lib.result.createdLibraryId,
        browser,
      });
      return {
        groupId: group.result.createdGroupId,
        libraryId: lib.result.createdLibraryId,
        nodeId: seed.result.createdId,
        originalTitle: seedTitle,
      };
    },
    prompt(ctx, browser) {
      return [
        `In Pinako library "${ctx.libraryId}" on browser "${browser}", there is a node with the title "${ctx.originalTitle}".`,
        ``,
        `Node id: ${ctx.nodeId}`,
        ``,
        `Make this title more descriptive. We don't have any other context about what's inside the node — assume only what the original title suggests.`,
      ].join('\n');
    },
    allowedTools: [
      'mcp__pinako__set_title',
      'mcp__pinako__get_library',
    ],
    maxTurns: 8,
  },
];

// ─── Runner ──────────────────────────────────────────────────────────────────

async function cleanup(session, browser, groupId) {
  if (!groupId) return;
  try {
    await callToolOk(session.client, 'delete_library_group', {
      groupId, cascadeMembers: true, confirmedByUser: true, browser,
    });
  } catch (err) {
    console.warn(`  cleanup failed: ${err.message}`);
  }
}

async function runOne(session, browser, scenario, model) {
  console.log(`\n--- ${scenario.key} / ${model.key} ---`);
  const setup = await scenario.setup(session, browser);
  try {
    const prompt = scenario.prompt(setup, browser);
    const run = await runAgent({
      prompt,
      model: model.id,
      allowedTools: scenario.allowedTools,
      maxTurns: scenario.maxTurns,
    });
    const callNames = run.toolCalls.map(tc => tc.name.replace('mcp__pinako__', ''));
    const erroredCount = run.toolCalls.filter(c => c.resultIsError).length;
    console.log(
      `  calls=${run.toolCalls.length} (errored=${erroredCount}) ` +
      `time=${run.durationMs}ms cost=$${run.totalCostUsd?.toFixed(4) ?? 'n/a'}`,
    );
    return {
      scenario: scenario.key,
      label: scenario.label,
      model: model.key,
      modelId: model.id,
      success: true,
      calls: run.toolCalls.length,
      callNames,
      erroredCount,
      cost: run.totalCostUsd,
      durationMs: run.durationMs,
      inputTokens: run.usage?.input_tokens,
      outputTokens: run.usage?.output_tokens,
      finalText: run.finalText || '',
    };
  } catch (err) {
    console.error(`  FAIL: ${err.message}`);
    return {
      scenario: scenario.key,
      label: scenario.label,
      model: model.key,
      modelId: model.id,
      success: false,
      error: err.message,
    };
  } finally {
    await cleanup(session, browser, setup.groupId);
  }
}

// ─── Report ──────────────────────────────────────────────────────────────────

function buildReport(results, browser) {
  const lines = [];
  lines.push('# Haiku 4.5 vs Sonnet 4.6 — model quality comparison');
  lines.push('');
  lines.push(`- Generated: ${new Date().toISOString()}`);
  lines.push(`- Browser: ${browser}`);
  lines.push(`- Models tested:`);
  for (const m of MODELS) lines.push(`  - ${m.key} (\`${m.id}\`)`);
  lines.push('');
  lines.push(`Each scenario runs once per model. No assertions; quality is a human-read judgment on the comparisons below.`);
  lines.push('');
  lines.push('Session quota note: Anthropic reset weekly limits on 2026-05-15; this comparison ran inside the expanded window before the next reset. API cost was not a constraint.');
  lines.push('');

  for (const scenario of SCENARIOS) {
    lines.push(`## Scenario: ${scenario.key}`);
    lines.push('');
    lines.push(`**Goal:** ${scenario.label}`);
    lines.push('');

    const rows = results.filter(r => r.scenario === scenario.key);
    if (rows.some(r => !r.success)) {
      lines.push('### Errors');
      lines.push('');
      for (const r of rows.filter(r => !r.success)) {
        lines.push(`- ${r.model}: ${r.error}`);
      }
      lines.push('');
    }

    const okRows = rows.filter(r => r.success);
    if (okRows.length === 0) continue;

    // Side-by-side metric table.
    lines.push('### Metrics');
    lines.push('');
    lines.push('| Metric | ' + okRows.map(r => r.model).join(' | ') + ' |');
    lines.push('|---|' + okRows.map(() => '---').join('|') + '|');
    lines.push('| Calls | ' + okRows.map(r => `${r.calls} (errored: ${r.erroredCount})`).join(' | ') + ' |');
    lines.push('| Wall-clock | ' + okRows.map(r => `${r.durationMs}ms`).join(' | ') + ' |');
    lines.push('| Cost (computed) | ' + okRows.map(r => `$${r.cost?.toFixed(4) ?? 'n/a'}`).join(' | ') + ' |');
    lines.push('| Input tokens (last turn) | ' + okRows.map(r => r.inputTokens ?? '?').join(' | ') + ' |');
    lines.push('| Output tokens (last turn) | ' + okRows.map(r => r.outputTokens ?? '?').join(' | ') + ' |');
    lines.push('| Tool sequence | ' + okRows.map(r => r.callNames.join(' → ') || '(no calls)').join(' | ') + ' |');
    lines.push('');

    // Final-text comparison.
    lines.push('### Final response (prose)');
    lines.push('');
    for (const r of okRows) {
      lines.push(`**${r.model}:**`);
      lines.push('');
      lines.push('> ' + (r.finalText.slice(0, 1500).replace(/\n/g, '\n> ') || '_(no text)_'));
      lines.push('');
    }
  }

  lines.push('## Takeaway');
  lines.push('');
  lines.push('_(filled in by hand after reviewing the comparisons above. Suggested signals: tool-call efficiency, prose quality, behavior under ambiguity, recovery from errors.)_');
  lines.push('');

  return lines.join('\n');
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`Haiku vs Sonnet comparison`);
  console.log(`Models: ${MODELS.map(m => m.key).join(', ')}`);
  console.log(`Scenarios: ${SCENARIOS.map(s => s.key).join(', ')}`);
  console.log(`Total runs: ${SCENARIOS.length * MODELS.length}`);

  const session = await connectPinakoMcp();
  const browser = await resolveTargetBrowser(session.client);
  console.log(`Connected; targeting browser: ${browser}\n`);

  const results = [];
  for (const scenario of SCENARIOS) {
    for (const model of MODELS) {
      results.push(await runOne(session, browser, scenario, model));
    }
  }
  await session.close();

  const report = buildReport(results, browser);
  const thisFile = fileURLToPath(import.meta.url);
  const reportPath = path.join(path.dirname(thisFile), 'model-comparison-results.md');
  await writeFile(reportPath, report, 'utf8');
  console.log(`\nReport written to: ${reportPath}\n`);
  console.log(report);
}

main().catch(err => {
  console.error('Experiment crashed:', err);
  process.exit(1);
});
