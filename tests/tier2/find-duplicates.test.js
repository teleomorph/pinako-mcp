import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { runAgent, toolCallsByName, tryParseJsonResult } from './helpers/agent-runner.js';
import { connectPinakoMcp } from '../helpers/mcp-client.js';
import { resolveTargetBrowser } from '../helpers/browser.js';

// Tier 2: probes the agent's interaction with `find_duplicates` —
// a read-only structured-data tool that returns `duplicateSets[]`
// ordered by frequency. The agent must:
//   1. Pick find_duplicates from the prompt verb ("find duplicates").
//   2. Pass scope='tree' from the prompt context ("open tab tree").
//   3. Read the response, sort/count, and report in prose.
//
// The agent should NOT ask "Move to folder or delete?" in this test —
// the prompt explicitly says "do not propose any action; just report."
// That's a slight subversion of find_duplicates' description (which
// has an AGENT FLOW section pointing at bulk_apply for cleanup); the
// test sees whether Haiku honors the "just report" instruction or
// pattern-matches on the description and offers options anyway.

const HAS_OAUTH = !!process.env.CLAUDE_CODE_OAUTH_TOKEN;
const HAS_API_KEY = !!process.env.ANTHROPIC_API_KEY;
const TIER2_RUNNABLE = HAS_OAUTH && !HAS_API_KEY;
const TEST_TIMEOUT_MS = 180_000;

describe.skipIf(!TIER2_RUNNABLE)('Tier 2 agent — find_duplicates (read-only summarization)', () => {
  let session;
  let browser;

  beforeAll(async () => {
    session = await connectPinakoMcp();
    browser = await resolveTargetBrowser(session.client);
  }, TEST_TIMEOUT_MS);

  afterAll(async () => {
    if (session) await session.close();
  }, TEST_TIMEOUT_MS);

  it('agent calls find_duplicates on the tree and reports a summary', async () => {
    const prompt = [
      `Use the Pinako MCP tools to find URL duplicates in the open tab tree on browser "${browser}".`,
      ``,
      `Just report a brief summary: the TOTAL number of duplicate sets, and (if any exist) the top 3 most-duplicated URLs by frequency, with their counts. Do not propose any action — I only want to see the data.`,
    ].join('\n');

    const run = await runAgent({
      prompt,
      allowedTools: [
        'mcp__pinako__find_duplicates',
      ],
      maxTurns: 6,
    });

    expect(run.systemInit, 'system init captured').toBeTruthy();

    console.log(
      `tier2 find-duplicates tool calls: ` +
      run.toolCalls.map(tc =>
        `${tc.name}(${Object.entries(tc.input || {}).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(',')})`
      ).join(' → '),
    );

    const dupCalls = toolCallsByName(run.toolCalls, 'mcp__pinako__find_duplicates');
    expect(dupCalls.length, 'find_duplicates called at least once').toBeGreaterThanOrEqual(1);

    // The agent must specify scope (required field) and should pick "tree"
    // from the prompt's "open tab tree" wording.
    const treeScopeCalls = dupCalls.filter(c => c.input?.scope === 'tree');
    expect(
      treeScopeCalls.length,
      `find_duplicates called with scope="tree" (agent picked: ${dupCalls.map(c => c.input?.scope).join(', ')})`,
    ).toBeGreaterThanOrEqual(1);

    const errored = run.toolCalls.filter(tc => tc.resultIsError);
    expect(errored, `no errored tool calls (got: ${errored.map(t => t.name).join(', ')})`).toEqual([]);

    // Inspect the tool's response shape — it should have duplicateSets +
    // count fields. We don't assert on specific values (the user's tree
    // varies), just the shape.
    const firstParsed = tryParseJsonResult(treeScopeCalls[0].resultText);
    expect(firstParsed, 'find_duplicates response parses as JSON').toBeTruthy();
    expect(
      Array.isArray(firstParsed.duplicateSets),
      'response has duplicateSets array',
    ).toBe(true);

    const setsCount = firstParsed.duplicateSets.length;
    const totalInstances = firstParsed.totalDuplicateInstances ?? 0;

    // Final-text quality: the agent should mention SOME number in its
    // summary. Loose assertion — not LLM-judge territory, just a
    // sanity signal that the agent didn't ignore the data.
    const text = run.finalText || '';
    const hasNumber = /\d/.test(text);
    expect(hasNumber, `finalText mentions at least one number (got: "${text.slice(0, 100)}…")`).toBe(true);

    console.log(
      `tier2 find-duplicates: ${run.toolCalls.length} calls, ${run.durationMs}ms, ` +
      `cost=${run.totalCostUsd ?? 'n/a'}, ` +
      `duplicateSets=${setsCount}, totalDuplicateInstances=${totalInstances}, ` +
      `finalText="${text.slice(0, 160)}"`,
    );
  }, TEST_TIMEOUT_MS);
});
