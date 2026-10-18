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

| selection for the 92 merged PRs (final squash diff) | mean cases | median cases | mean $ per gate | PRs selecting ≥90% of the gate |
|---|---|---|---|---|
| today's selector | 80 | 108 | 69 | 67 |
| direct dependencies only (no hub files) | 31.5 | 9.5 | 27 | 12 |
| direct + a $12 canary set whenever a hub file changed | | | 33.5 (median 15.6) | |

222 changed files in the window each select ≥90% of the gate by themselves; 643 tracked files do. The coupling is the derived reference walk in scripts/pr-dependencies.ts, which follows every textual mention transitively. Representative chains (`trace`):

- `cso/sections/audit-phases.md > scripts/gen-skill-docs.ts > lib/doctor-components.ts > lib/result-codes.ts` (the build-time generator's whole import closure becomes a runtime input of every case).
- `qa/SKILL.md.tmpl > bin/gstack-upgrade > bin/gstack-capy-install > bin/gstack-doctor-components.sh > bin/gstack-pregate > lib/pregate/workflows.ts > scripts/test-free-shards.ts > ...` (the preamble's bins mention other bins in help text and rare branches).
- `browse/src/terminal-agent.ts > browse/src/server.ts > bin/gstack-config > bin/gstack-models > lib/model-policy-cli.ts > bin/gstack-eval-plan > ...`.
- `test/skill-e2e-cso.test.ts > test/helpers/e2e-helpers.ts > scripts/test-paid-shards.ts > scripts/lib/paid-report.ts > scripts/eval-flake-rank.ts > scripts/test-free-shards.ts > scripts/lib/windows-curation.ts`.

Graph surgery does not fix it. Stopping the walk at gen-skill-docs.ts, at the harness's global set and at the 13 preamble bins together moved the mean from $78.5 to $77.0 (same scale), because the graph is one connected component and another path always remains. The exercised-command map (R4) is the precise fix but is not ready (GSTA-47: activation no earlier than about Oct 31). What does work is a depth limit: a PR tier that selects by a case's direct inputs and leaves the transitive closure to a full gate that runs per merge batch.

**Coverage check on history.** Of the 40 PR-caused red results in the window (bucket b), a direct-only tier selects 29. The 11 it misses are 7 judges (all 24 judges cost $1.44, so the plan always runs them) and 4 e2e results: plan-mode-no-op (#3059, #3017), office-hours-auto-mode (#3077) and design-review-plugin-handoff (#3121). Those four would be caught by the batch full gate. Of 76 outside-red results (flakes and main defects), the direct tier still selects 35, so PRs would see 54% fewer false reds.

## 5. Spend model (dollars a week)

Replayed over GSTA-47's 15.1-day window (91 merged PRs, 65 paid anything). "Gates per PR" counts one ready gate, plus one re-gate per PR-caused red, plus outside reds scaled by the tier's exposure and by #3260's fixes (60% of outside-red spend remains).

| step | $ / week | multiple of $9,950 |
|---|---|---|
| today | 9,950 | 1.0x |
| GSTA-48 in flight: R1 readiness-gated dispatch, R2 reuse across main moves and restamps | ~7,000 | 1.4x |
| + on-demand ready gate (paid gate only when the lane marks the PR ready; 1.58 gates per paying PR) | ~5,050 | 2.0x |
| + direct-dependency PR tier and a full gate per merge batch of 5 ($786) | ~3,400 | 2.9x |
| + per-case receipt reuse keyed on direct inputs (a re-gate reruns about 30% of the tier) | ~2,550 | 3.9x |
| + shared first-request prompt prefix (−4%) | ~2,450 | 4.1x |

Batch size moves the result by about $130 a week per step: a full gate per 4 merges is $983, per 6 merges $655, nightly-only $652. The honest range for the full combination is **3.6x to 4.1x**; it reaches 4x only with the ready-gate discipline and the receipt reuse both working.

## 6. Levers not recommended (with numbers)

- Cheaper judges: $1.15 per gate maximum, about $35 a week after this plan; a calibration panel would cost more than a year of savings.
- Cheaper fixture actors: none exist in the gate.
- Prompt caching "turned on": it is on; the residual is the first-request prefix above.
- Hub graph surgery: −2% measured; superseded by the depth-limited tier.
- Trial counts: 0 behavior cases in the PR gate.
- Model under test (data only; excluded by Garry's rule that it stays as users run it): Fable is 97% of the bill. The same gate on claude-opus-5-5 list prices would cost about $40 at the same token counts.
