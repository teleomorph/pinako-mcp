import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { runAgent, toolCallsByName, tryParseJsonResult } from './helpers/agent-runner.js';
import { connectPinakoMcp } from '../helpers/mcp-client.js';
import { resolveTargetBrowser } from '../helpers/browser.js';

// Tier 2: pure-read test. No setup, no cleanup — the agent reads the
// connected browser's main tree summary and searches for a benign
// term. Probes the agent's ability to synthesize across two read
// tools and report findings.
//
// Assertion is intentionally loose on prose content (LLM-judge
// territory) but strict on tool sequence: both tools must be called
// without errors. If the agent's final text doesn't reference the
// search query, that's logged but not a hard failure — descriptions
// are the surface under test.

const HAS_OAUTH = !!process.env.CLAUDE_CODE_OAUTH_TOKEN;
const HAS_API_KEY = !!process.env.ANTHROPIC_API_KEY;
const TIER2_RUNNABLE = HAS_OAUTH && !HAS_API_KEY;
const TEST_TIMEOUT_MS = 180_000;

const SEARCH_TERM = 'tab';

describe.skipIf(!TIER2_RUNNABLE)('Tier 2 agent — search + summarize (read-only)', () => {
  let session;
  let browser;

  beforeAll(async () => {
    session = await connectPinakoMcp();
    browser = await resolveTargetBrowser(session.client);
  }, TEST_TIMEOUT_MS);

  afterAll(async () => {
    if (session) await session.close();
  }, TEST_TIMEOUT_MS);

  it('agent reads tree summary and searches tabs, then synthesizes a brief', async () => {
    // Specifying browser explicitly avoids the agent burning a turn on
    // list_browsers — and on past runs, hitting list_browsers sometimes
    // led the agent to stop early without calling the actual data tools.
    const prompt = [
      `Use the Pinako MCP tools to analyze the user's open browser state on browser "${browser}".`,
      ``,
      `You MUST call BOTH tools in sequence:`,
      `1. Call get_tree_summary to get counts, depth, top domains, and sample patterns for the main tree.`,
      `2. Call search_tabs with query "${SEARCH_TERM}" to find any open tabs whose title or URL contains that substring.`,
      `3. After BOTH tool calls complete, reply with one paragraph reporting: (a) the top three most-common domains from the summary, and (b) how many tabs matched the search.`,
    ].join('\n');

    const run = await runAgent({
      prompt,
      allowedTools: [
        'mcp__pinako__get_tree_summary',
        'mcp__pinako__search_tabs',
      ],
      maxTurns: 8,
    });

    expect(run.systemInit, 'system init captured').toBeTruthy();
    const pinakoServer = (run.systemInit?.mcpServers ?? []).find(s => s.name === 'pinako');
    expect(pinakoServer?.status).toBe('connected');

    // Diagnostic log: dump the tool-call sequence regardless of pass/fail
    // so description-quality findings are visible.
    console.log(
      `tier2 search-and-summarize tool calls: ` +
      run.toolCalls.map(tc => `${tc.name}(${Object.keys(tc.input || {}).join(',')})`).join(' → '),
    );

    const summaryCalls = toolCallsByName(run.toolCalls, 'mcp__pinako__get_tree_summary');
    const searchCalls = toolCallsByName(run.toolCalls, 'mcp__pinako__search_tabs');
    expect(summaryCalls.length, 'get_tree_summary called').toBeGreaterThanOrEqual(1);
    expect(searchCalls.length, 'search_tabs called').toBeGreaterThanOrEqual(1);

    const errored = run.toolCalls.filter(tc => tc.resultIsError);
    expect(errored, `no errored tool calls (got: ${errored.map(t => t.name).join(', ')})`).toEqual([]);

    // Soft signals: agent's final report should mention numbers and at
    // least one domain string. Not a hard pass/fail — descriptions are
    // the real subject under test here.
    const finalText = run.finalText || '';
    const summaryParsed = tryParseJsonResult(summaryCalls[0].resultText);
    const topDomains = summaryParsed?.topDomains
      ?? summaryParsed?.summary?.topDomains
      ?? summaryParsed?.result?.topDomains
      ?? [];

    console.log(
      `tier2 search-and-summarize: ${run.toolCalls.length} calls, ${run.durationMs}ms, ` +
      `model=${run.systemInit?.model}, cost=${run.totalCostUsd ?? 'n/a'}, ` +
      `topDomains=${JSON.stringify((topDomains || []).slice(0, 3))}, ` +
      `searchQuery="${searchCalls[0].input?.query ?? '?'}", ` +
      `finalText="${finalText.slice(0, 200)}"`,
    );
  }, TEST_TIMEOUT_MS);
});
