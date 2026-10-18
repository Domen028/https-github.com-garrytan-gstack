# Paid PR gate cost: where one full gate's money goes (2026-10-17)

Thread GSTA-49. Free, read-only measurement over recorded artifacts. Base: main fd13cf2 (v1.91.133.0).

## Data

- Nine complete full gates (108 rule cases + 24 judges each) from 2026-10-17/18: runs 39055436252, 39069323673, 39079802260, 39082422480, 39083793205, 39085410841, 39086339074, 39087248425, 39088415319. Every paid-slice artifact (eval JSON with the full stream-json transcript and the CLI's `result` event), session ledgers, trial outcomes and report verdicts. Recorded cost per gate: $90.93 to $94.70 (mean $93.14).
- Selection replay: every one of the 92 squash-merged PR commits on main since 2026-10-03, run through today's selector (`computePaidCaseSelection`, profile pr) on fd13cf2, plus GSTA-47's per-run CSV (505 runs) for spend weights.
- Prices: lib/pricing.ts. A least-squares fit over 93 Fable sessions' `modelUsage.costUSD` reproduces $10 input, $50 output, $0.25 cache read and $12.50 cache write per million tokens exactly.

## 1. Who the money goes to

| spender | $ per gate | share |
|---|---|---|
| Model under test, claude-fable-5-1 (claude -p and Agent SDK sessions) | 90.46 | 97.1% |
| plan-review-report's pinned claude-opus-4-7 session (also model under test) | 1.13 | 1.2% |
| 24 LLM judges (skill-llm-eval, $0.06 each, 3 samples) | 1.44 | 1.5% |
| Claude Code's own Haiku calls, opus-4-8 side calls | 0.09 | 0.1% |
| **recorded total** | **93.14** | |
| Not recorded: 8 PTY cases, review-gate-integrity, diagram-triplet, auq-format-gate (1,371 s of sessions) | ~12.9 (estimated at the measured $0.0094 per session-second) | |

There are no LLM fixture actors in the gate: every fixture actor is scripted. Judges and side models together are 2.8% of a gate. **Cheaper judges or actors can save at most about $1.15 per gate (Sonnet 5.5 judges), about $35 a week after the rest of this plan.**

## 2. Token classes (Fable, per gate)

| class | tokens | $ | share of gate |
|---|---|---|---|
| cache writes (5-minute TTL, 1.25x input) | 3.66M | 45.73 | 49% |
| output (includes 225k thinking tokens, $11.25) | 0.74M | 37.15 | 40% |
| cache reads | 29.4M | 7.35 | 8% |
| uncached input | 23k | 0.23 | 0.2% |

**Prompt caching is already on and working.** 89% of input tokens are cache reads; without caching the same input would cost $331 per gate instead of $53. Inside sessions, cache misses (TTL expiry, prefix changes) re-write only 1.9% of cache-write tokens ($0.87 per gate). The cache-write bill is new content entering the context once: tool results (mostly the agent reading gstack skill files: SKILL.md, review-army.md, checklist.md, release-body.md, plan-completion.md...) and the session's first request.

The one cacheable share not yet shared: each session's first request writes a median 7.8k tokens ($11.03 per gate, 24% of cache writes) after reading an 8.7k-token prefix (tools and the static system prompt) that other sessions already cached. 13 of 93 sessions read 0 tokens on their first request (they started before any sibling had written the shared prefix). The written part is the per-session system prompt (working directory, date, git status) plus the skill listing and the case prompt. A byte-identical session environment could share part of it: **estimated $3 to $5 per gate (3 to 5%), to be measured before building.**

Output and thinking are how the model under test behaves for users, so they are not a lever. Trimming what the agent reads is trimming gstack's skill files themselves (a product change, out of scope here).

## 3. Per case and per trial

Every PR-gate case is kind `rule` with one trial; the 138 `behavior` cases are deferred out of the PR gate already ("deferred: 138 broad behaviors"). Judges are kind `judge` with 3 samples ($0.06 per judge in total). **Trial-count policy (EVAL_POLICY panel n=3, k=2) does not touch PR-gate spend**; it only prices the weekly census.

Top 20 cases (48% of a gate; full list in per-case.csv):

| # | case | $ | runner |
|---|---|---|---|
| 1 | shared-libs-review-revalidation | 5.02 | Agent SDK, 4 sessions |
| 2 | shared-libs-review-path-eligibility | 4.00 | Agent SDK, 3 sessions |
| 3 | ship-docsync-store | 3.62 | claude -p |
| 4 | ship-docsync-completion | 3.61 | claude -p |
| 5 | ship-docsync-current | 3.36 | claude -p |
| 6 | shared-libs-review-index-flags | 2.62 | Agent SDK, 2 sessions |
| 7 | shared-libs-review-prior-coverage | 2.60 | Agent SDK, 2 sessions |
| 8 | shared-libs-review-lifecycle | 2.44 | Agent SDK, 2 sessions |
| 9 | ship-exploratory-late-input | 2.31 | claude -p |
| 10 | plan-ceo-finding-floor | ~2.27 (est.) | PTY |
| 11 | plan-design-with-ui-scope | ~2.18 (est.) | PTY |
| 12 | ship-docsync-failure | 2.03 | claude -p |
| 13 | ship-exploratory-plan-checks | 2.00 | claude -p |
| 14 | review-exploratory-small-cli | 1.97 | claude -p |
| 15 | ship-exploratory-small-cli | 1.94 | claude -p |
| 16 | ship-exploratory-unavailable | 1.87 | claude -p |
| 17 | plan-mode-no-op | ~1.84 (est.) | PTY, 6 sessions |
| 18 | plan-devex-finding-floor | ~1.74 (est.) | PTY |
| 19 | document-release | 1.72 | claude -p |
| 20 | land-and-deploy-workflow | 1.71 | claude -p |

By file: ship-docsync $19.4, qa-callers $10.1, shared-libs-paths $9.2, shared-libs $8.8, deploy $5.5. Per-case cost is stable: the largest spread across nine gates is ±12%.

## 4. How many cases a PR's diff really touches

Replays of the 92 squash-merged PRs since 2026-10-03 through selectors on fd13cf2, on the $106 full-gate scale (recorded $93 plus the estimated unrecorded PTY cost):

| selection | mean $ per merged PR | median $ | mean cases | PRs selecting ≥90% of the gate |
|---|---|---|---|---|
| today's selector | 78.5 | 106.0 | 80 | 67 |
| R4 exercised-map shadow (already computed on every PR) | 63.1 | 103.0 | 64 | n/a |
| declared touchfiles + harness globals only; SKILL.md files whose changed lines are shared by ≥60% of the changed SKILL.md files count as a preamble change; preamble, resolver and full-gate files add a $12 canary set; judges always (`.context/gatecost-l3.ts`, a heuristic stand-in for a hunk classifier) | 47.9 | 21.6 | 36 | 23 |
| proxy used in revision 1 (hub files deleted from the diff) | 30.9 | 13.4 | 31.5 | 12 |

The proxy overstated the saving; the plan uses the exact replays.

643 tracked files each select ≥90% of the gate through scripts/pr-dependencies.ts's transitive reference walk. Representative chains (`trace`): `cso/sections/audit-phases.md > scripts/gen-skill-docs.ts > lib/doctor-components.ts > lib/result-codes.ts`; `qa/SKILL.md.tmpl > bin/gstack-upgrade > bin/gstack-capy-install > bin/gstack-doctor-components.sh > bin/gstack-pregate > lib/pregate/workflows.ts > scripts/test-free-shards.ts`; `browse/src/terminal-agent.ts > browse/src/server.ts > bin/gstack-config > bin/gstack-models > ...`. Stopping the walk at the generator, the harness global set and the 13 preamble bins moved the mean 2%: the graph is one connected component. Preamble edits also regenerate every SKILL.md, so the preamble is a genuine input of every case unless a change is proven to be confined to the shared block.

PR-caused reds in the window (bucket b, 40 case results): the touchfile-only rule selects 29 on the merged diff; the 11 it misses are 7 judges (always run) and 4 e2e results (plan-mode-no-op on #3059 and #3017, office-hours-auto-mode on #3077, design-review-plugin-handoff on #3121). Of 76 outside-red results, it selects 35.

## 5. Spend model

One cohort: the 92 merged PRs (72 select any paid case today), 15.1 days, scaled to a week. Screening cost is the replayed touchfile-rule cost per paid-relevant PR, ×1.3 for repair re-screens. A train's full gate is $93.14; a red train costs a bisect (about $6) and a rebuild. Screened PRs cause a train red 6% of the time, unscreened 25% (assumption); outside reds 10% to 15% per full gate after #3260.

| policy | $ / week | multiple of $9,950 | trains that go red |
|---|---|---|---|
| GSTA-48 only (R1, R2) | ~7,000 | 1.4x | n/a |
| every PR screened once, trains of 5 | ~3,060 to 3,100 | 3.2x | 34% to 38% |
| every PR screened once, trains of 6 | ~2,940 to 2,970 | 3.4x | 38% to 41% |
| half the PRs screened, trains of 5 | ~2,160 to 2,200 | 4.5x | 61% to 63% |
| no paid screening, trains of 5 | ~1,190 to 1,230 | 8x | ~80% |

## 6. Levers not recommended (with numbers)

- Cheaper judges: $1.15 per gate maximum, about $35 a week after this plan; a calibration panel would cost more than a year of savings.
- Cheaper fixture actors: none exist in the gate.
- Prompt caching "turned on": it is on; the residual is the first-request prefix above.
- Hub graph surgery: −2% measured; superseded by the depth-limited tier.
- Trial counts: 0 behavior cases in the PR gate.
- Model under test (data only; excluded by Garry's rule that it stays as users run it): Fable is 97% of the bill. The same gate on claude-opus-5-5 list prices would cost about $40 at the same token counts.
