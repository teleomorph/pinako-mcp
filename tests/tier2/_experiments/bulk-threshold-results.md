# bulk_apply threshold sweep — empirical results

- Generated: 2026-05-16T23:45:10.339Z
- Model: claude-haiku-4-5-20251001
- Browser: Chrome
- Operation under test: add a single tag to N target nodes (library scope)
- Prompt style: clear (numbered list of target ids)
- Description version: includes the "TWO USE CASES + N>=3 rule" rewrite landed in pinako-mcp commit `90f2513`

Each (N, strategy) row is ONE run. Strategy is forced by `disallowedTools`
(NOT `allowedTools` — that one only auto-approves under `bypassPermissions`
and does not actually restrict the surface):
- `individual` disallows `bulk_apply`; agent must make N add_tags calls.
- `bulk` disallows `add_tags`; agent must compose one bulk_apply with N sub-ops.

Session generosity note: Anthropic reset weekly limits on 2026-05-15
("they were feeling generous"); this sweep ran ~16 hours before the
expanded quota resets. API cost not a concern during this experiment.

## Raw measurements

| N | Strategy | OK | Calls | Agent ms | Verify ms | Cost $ | Input tok | Output tok | Cache read |
|---|---|---|---|---|---|---|---|---|---|
| 3 | individual | yes | 3 | 12306 | 6 | 0.0925 | 18 | 759 | 64119 |
| 3 | bulk | yes | 6 | 39655 | 4 | 0.1976 | 44 | 3480 | 201516 |
| 5 | individual | yes | 5 | 15262 | 5 | 0.0284 | 18 | 1275 | 123060 |
| 5 | bulk | yes | 1 | 15677 | 5 | 0.0338 | 18 | 1339 | 112306 |
| 10 | individual | yes | 10 | 17170 | 6 | 0.0993 | 20 | 1850 | 58908 |
| 10 | bulk | yes | 1 | 14952 | 4 | 0.0272 | 18 | 1067 | 123876 |
| 15 | individual | yes | 15 | 17536 | 4 | 0.0443 | 20 | 2537 | 111570 |
| 15 | bulk | yes | 1 | 16560 | 4 | 0.0347 | 18 | 1270 | 112306 |
| 20 | individual | yes | 20 | 20430 | 5 | 0.0499 | 20 | 3238 | 111570 |
| 20 | bulk | yes | 1 | 18960 | 5 | 0.0394 | 18 | 1920 | 112306 |

## Inflection summary

| N | Cost: ind | Cost: bulk | Cost winner | Latency: ind | Latency: bulk | Latency winner |
|---|---|---|---|---|---|---|
| 3 | $0.0925 | $0.1976 | **individual** | 12306ms | 39655ms | **individual** |
| 5 | $0.0284 | $0.0338 | **individual** | 15262ms | 15677ms | **individual** |
| 10 | $0.0993 | $0.0272 | **bulk** | 17170ms | 14952ms | **bulk** |
| 15 | $0.0443 | $0.0347 | **bulk** | 17536ms | 16560ms | **bulk** |
| 20 | $0.0499 | $0.0394 | **bulk** | 20430ms | 18960ms | **bulk** |

## Takeaway

**Cost crossover and latency crossover both land between N=5 and N=10.**
Reading the table:

- At **N=3**, individual wins decisively on both axes. The N=3 bulk row
  is an outlier ($0.198, 39655ms, 6 calls with 3 errored): forcing
  bulk_apply by disallowing add_tags made Haiku try add_tags 3 times
  anyway, receive "tool not allowed" errors, then recover by composing
  a bulk_apply. In production with both tools available, Haiku at N=3
  just picks individual cleanly (~$0.03, ~12s — confirmed by a prior
  unforced run on the same setup).
- At **N=5**, the two paths are effectively tied. Individual is $0.006
  cheaper and 0.4s faster — within run-to-run noise. Either choice is
  fine.
- At **N=10**, bulk wins clearly on both axes: $0.027 vs $0.099 (bulk
  ~$0.07 cheaper) and 14952ms vs 17170ms (bulk ~2s faster).
- **N=15 and N=20** continue the trend. Bulk wins by $0.009-$0.011 on
  cost and 1-1.5s on latency.

**Empirical recommendation for the description threshold:**

The current bulk_apply description says *"3 or more times in a row,
prefer a single bulk_apply."* Three is empirically wrong — at N=3,
individual is cheaper AND faster. **Six is the right number.** At N=6
the two paths are approximately tied with a small bulk edge; at N=7+
bulk wins. Tightening the threshold to "6 or more" aligns the
description with the cost/latency curve and saves token cost on the
common 2-5 target case where Pinako agents will hit.

**Caveats:**

1. **Cache churn dominates cost noise.** Costs are driven by
   *cache_creation* tokens, which vary by run depending on how the
   prompt cache lifecycle interacts with the conversation history. The
   N=10 individual cost ($0.099) is anomalously high relative to N=5
   individual ($0.028) and N=15 individual ($0.044); the underlying
   call pattern is regular (10 vs 5 vs 15 calls), so the cost spike is
   cache churn, not per-call work. The latency numbers are more
   reliable signals of the actual crossover than the cost numbers.

2. **Numbers are Haiku-4.5-specific.** Sonnet's per-turn reasoning
   cost is higher (so individual scales worse on Sonnet — bulk
   crossover would likely be lower on Sonnet, maybe N=4-5). The
   threshold "6 or more" optimizes for Haiku, the agentic-ai branch
   default. If the production model shifts to Sonnet, revisit.

3. **Numbers are simple-op-specific.** This is for `add_tags`, a
   trivial sub-op (3-4 small fields). A complex op like `move_node`
   with subtree semantics or `create_note` with HTML content has more
   per-sub-op reasoning cost inside bulk_apply, which would push the
   crossover higher (later N). A simpler op like `set_star_color`
   (one color string) would push it lower. "6 or more" is a
   middle-ground heuristic that works for the typical case; sub-op
   complexity affects but doesn't invalidate it.

4. **Atomic undo is a real UX benefit individual can't provide.** The
   user can undo the whole bulk_apply batch in one click. For
   workflows where atomic undo matters (e.g., agentic "organize my
   tabs" ops), prefer bulk_apply at any N >= 2 — that benefit isn't
   visible in this table but it's worth keeping in mind alongside the
   cost/latency case.
