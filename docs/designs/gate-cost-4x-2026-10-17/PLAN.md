<!-- gstack-autoplan-scope: --no-ui --developer-tool -->
# Cut the paid PR gate bill about 4x (October 17, 2026)

## Implementation plan

### Context

Owner request (Garry, 2026-10-17): "is there any way we can reduce cost like 4x". Paid PR gates (E2E Evals, evals.yml: 108 rule cases and 24 judges, $93 recorded per full gate) cost about $9,950 a week (GSTA-47, reports/paid-gate-spend-2026-10.md). Garry pre-approved the direction the same day ("Do it all") for five levers: (1) PRs run only diff-relevant cases plus a full gate per merge batch or nightly on main; (2) a merge train with bisection on red; (3) decoupling the shared preamble so small edits stop selecting every case; (4) cheaper judges and fixture actors, proven by calibration, with the model under test unchanged; (5) prompt caching. Trial counts and case kinds are out of scope (data only). Coordinator: GStack Minder (GSTA-36) owns merges and routes file conflicts; PRs go READY unstamped (CREW.md 6).

Base: origin/main `fd13cf2` (v1.91.133.0). In flight and not touched by this plan: GSTA-48 (R1 readiness-gated dispatch, R2/R2a verdict reuse across main moves and restamps, and the receipt-store restore fix; it owns `.github/workflows/evals*.yml` and `scripts/gate-reuse.ts` until it merges). Any lane here that edits those files waits for GSTA-48's PR and is routed through GStack Minder first.

Measurement: docs/designs/gate-cost-4x-2026-10-17/MEASUREMENT.md (nine full gates' transcripts, a replay of all 92 merged PRs through today's selector, and the spend model). The findings that shape the plan:

1. **97% of a gate is the model under test (Fable 5.1).** Judges are $1.44 per gate, Claude Code's side calls $0.09, and there are no LLM fixture actors. Lever 4 is worth at most about $35 a week and is dropped.
2. **Prompt caching already works**: 89% of input tokens are cache reads, and in-session misses waste 1.9% of cache writes. The remaining cacheable share is each session's first request ($11 per gate written, of which an estimated $3 to $5 could be shared). Lever 5 is small and goes last, behind a measurement.
3. **The coupling is a transitive textual walk, not one preamble file.** 643 tracked files each select ≥90% of the gate through `scripts/pr-dependencies.ts`'s reference closure (skill text names a bin, the bin's help text names another bin, the build-time generator's whole import closure counts as a runtime input). Cutting the three biggest hubs (generator, harness, 13 preamble bins) moved the replay by 2%: another path always remains. A depth limit works: selecting by each case's direct inputs drops the mean merged PR from 80 cases ($69) to 31.5 cases ($27), median 9.5 cases.
4. **Frequency is the bigger lever.** After GSTA-48, a paying PR still runs about 2.4 full-gate equivalents; a ready-only gate with repair re-gates is 1.58.

Thesis: **every merged commit is still covered by the full gate, but a PR pays only for what it directly touches, only when it is ready, and only once per unchanged case.**

### Spend target and path

| step | $ / week | multiple |
|---|---|---|
| today | 9,950 | 1.0x |
| GSTA-48 (R1, R2) | ~7,000 | 1.4x |
| L1 ready-only paid gate | ~5,050 | 2.0x |
| L2 batch full gate on main + L3 direct-dependency PR tier | ~3,400 | 2.9x |
| L4 per-case reuse keyed on direct inputs | ~2,550 | 3.9x |
| L5 shared session prefix | ~2,450 | 4.1x |

Honest range 3.6x to 4.1x. Re-measured with GSTA-47's scripts after each landing and reported to GStack Minder against the $2,500 target.

### Release promises

- **P1. No commit reaches main's released state without the full gate.** Lowering PR coverage is paired with a full gate per merge batch that runs before the batch's PRs merge (L2), and a nightly full gate on main whenever something merged outside a batch.
- **P2. A PR's paid gate selects every case whose direct inputs the PR changed**, plus all 24 judges, plus a fixed canary set when a transitive-only or full-gate file changed. Every miss the batch gate finds is attributed and becomes a selection fix.
- **P3. A green per-case verdict is reused only when that case's direct inputs are byte-identical** and the batch gate still runs it.
- **P4. Nothing about how the model under test runs changes**: same model, effort, prompts, skills and assertions.
- **P5. Progress is measured, not asserted**: each lane's PR body states its replayed saving, and GStack Minder gets a re-measurement after each landing.

### Premise table

| premise | claim | receipt | verdict |
|---|---|---|---|
| P-a | a full gate records $90.93 to $94.70 | report-verdict of the nine runs in MEASUREMENT.md | true |
| P-b | Fable is 97.1% of recorded gate cost | `modelUsage` in every `result` event; fit reproduces lib/pricing.ts | true |
| P-c | judges cost $0.06 each, 24 per gate | eval JSON `skill-llm-eval` rows | true |
| P-d | PR gate has 0 behavior cases | trial-outcomes kinds: 108 rule, 24 judge; report "deferred: 138 broad behaviors" | true |
| P-e | 643 files reach ≥90% of cases | `derivedDependencies` on fd13cf2 | true |
| P-f | direct-only tier catches 29 of 40 PR-caused red results; 7 of the 11 misses are judges | per-run.csv bucket b vs replayed selection | true |
| P-g | receipt reuse fired on 3.9% of shards | GSTA-47 Q2.1 | true |
| P-h | the store never restores (Ubicloud cache vs GitHub cache) | GSTA-48 report 2026-10-18 03:54Z | reported, unverified here |
| P-i | unrecorded PTY cases cost about $12.9 per gate | session-seconds x measured $/s | estimate |
| P-j | 4.1x is reachable | spend model in MEASUREMENT.md §5 | estimate |

unverified=1, estimates=2

### Lanes (ordered by dollars saved per unit of risk)

**L1. Ready-only paid gate on PRs (~$1,950 a week; no coverage change).** Every merged head keeps the same selection; only the trigger changes. The paid lane starts on a PR head when GSTA-48's readiness conditions hold (free tests green, quiet window) AND the PR carries the `paid-gate` label. `/ship` and `gstack-ship-receipt` add the label when the lane declares READY; GStack Minder's slot call adds it too. Removing the label on a new push is not required: a newer head with the label simply gates when ready. Drafts never gate. Lanes keep using focused local paid cases (CREW.md 14) for iteration. Files: `.github/workflows/evals.yml` trigger and readiness job (GSTA-48 owns it: ship after its PR merges, or GSTA-48 folds it into R1; GStack Minder routes), `ship/SKILL.md.tmpl` label step, `lib/ship-receipt.ts`. Tests: workflow-shape test that an unlabeled PR head skips the paid slices with a visible "not requested" summary and a neutral check; that a labeled head runs; that the required-check name is unchanged so branch protection still requires a verdict before merge.

**L2. Batch full gate (+$650 to $980 a week; the safety net L3 needs).** `bin/gstack-train` (logic in `lib/train.ts`) for GStack Minder: `gstack-train build --prs 3301,3302,...` creates `train/<n>` by merging main and each READY PR in slot order (stops at the first conflict and names it), dispatches the full gate (`evals_all`) on the train head, and records `train.json` (PR heads, train tree, run id). `gstack-train verdict` reads the run: green means each listed head is mergeable as-is under R2's reuse rules (same own-diff), so GStack Minder merges them in order with no further paid gate. Red: `gstack-train bisect` reruns only the red cases (focused, `EVALS_ONLY`) on main alone and on main plus each PR prefix, and prints which PR introduced each red or that it is red on main (outside cause). At most 5 PRs per train (replay: about $786 a week). If anything merged outside a train in the last 24 hours, a nightly scheduled job runs the full gate on main HEAD; a red opens or updates one tracking issue and freezes merges that touch the red cases' inputs until a revert or fix-forward lands (GStack Minder's rule, written into CREW.md by GStack Minder). Files: new `lib/train.ts`, `bin/gstack-train`, new `.github/workflows/evals-nightly-main.yml` (routed through GStack Minder because it matches `evals*.yml`), docs/troubleshooting.md anchors, result codes `TRAIN_CONFLICT`, `TRAIN_RED`, `TRAIN_STALE`. Tests: train build on a fixture repo with a conflict and with a clean stack; verdict parsing of a recorded green and red report-verdict; bisect attribution on a synthetic red that one PR causes and one that main causes; a stale train (main moved after build) refuses `verdict` with `TRAIN_STALE`.

**L3. Direct-dependency PR tier (~$2,430 a week gross; ~$1,650 net of L2's cost).** A third selection mode `direct` in `scripts/lib/paid-select.ts` and `scripts/test-pr-profile.ts`, computed from `scripts/pr-dependencies.ts` with a depth rule: a case's direct inputs are its declared touchfiles; its owning test file and that file's static `test/helpers`/`test/fixtures` import closure (excluding the harness global set, which stays a global touchfile); the template, sections and generated SKILL.md of every skill the case invokes; every bin named in that skill's own non-preamble text or the test file, with those bins' static code-import closure; nothing reached only through another bin's text or through the build-time generator. A changed file that reaches a case only transitively, or a full-gate file (`setup`, `bun.lock`, Dockerfile.ci, the preamble resolvers, `scripts/gen-skill-docs.ts`), adds the canary set instead of every case. The canary set is a reviewed list in `test/helpers/touchfiles-data.ts` of about 10 cheap cases that cover the preamble, plan mode and the bins every skill runs (hermetic-canary, skillmd-setup-discovery, context-save-writes-file, ship-triage, tpa-absent-linux, plan-mode-no-op, office-hours-auto-mode, design-review-plugin-handoff and two more chosen from replay), about $12. All 24 judges always run ($1.44). Rollout: shadow first. Every PR gate computes and prints both selections (`coverage.direct` in the manifest summary) for 7 days or 10 batch gates, whichever is later; activation needs zero e2e cases that the batch gate found red, that a PR caused, and that the direct tier would have dropped. The replay over the window is a precondition too: 0 dropped e2e PR-caused reds once the canary set is in place. GStack Minder flips one flag (`.gstack/pr-tier.json`: `{"mode":"direct"}`); flipping it back restores today's selection. Tests: unit tests of the depth rule on fixture graphs (a bin's help text naming another bin does not propagate; a static import does; generator code does not reach a case, the generated SKILL.md does); the four historical misses selected; a preamble-resolver edit selects the canary set and all judges, not every case; the full-fallback list still forces the canary set; map-diff selection for touchfiles-data.ts unchanged.

**L4. Per-case receipt reuse keyed on direct inputs (~$850 a week; needs GSTA-48's store fix).** Today's per-shard receipts hash inputs that include the hub, so any change invalidates every receipt. Key each case's receipt on its L3 direct-input digest plus the harness global set, the case's own test file and HARNESS_VERSION. A re-gate on the same PR reruns only cases whose key changed and cases that were not green, and reports the rest as reused with the source run and head. Never reused: a case whose last result was red, partial or cancelled; any case when a full-gate file changed; judges (they are cheap). The batch gate (L2) never reuses (`evals_all` disables receipts), so every transitive input is still exercised before merge. Files: `scripts/e2e-shard-reuse.ts`, `scripts/eval-input-cache.ts` (routed through GStack Minder in case GSTA-48 owns them), tests with negative controls for each never-reused class.

**L5. Shared session prefix (~$100 a week; measured before built).** A preregistered panel (under $10, `bin/gstack-eval-plan` prereg) runs 6 short Fable sessions in two working-directory layouts and reads first-request `cache_read_input_tokens`. Build only if the shared prefix grows by at least 3k tokens per session: run each paid session from a fixed path through a per-session mount namespace (`unshare` bind mount, Linux CI only) and warm the shared prefix once per slice before parallel sessions start. Files: `test/helpers/hermetic-env.ts` (a global touchfile: one full gate when it lands). Abandon with a written reason otherwise.

### Not built (data only)

- Cheaper judges and fixture actors: at most $1.15 per gate; no LLM actors exist.
- Trial counts and case kinds: the PR gate runs no behavior cases.
- R4 (exercised-command map): stays in shadow under GSTA-45's criteria; once active it can replace L3's depth rule with observed commands.
- Model under test: Fable is 97% of the bill; Opus 5.5 at the same tokens would be about $40 a gate. Excluded by Garry's rule.

### Gate-integrity edits

L1 (when the paid gate runs), L2 (merge authority moves to the batch verdict), L3 (PR selection), L4 (verdict reuse). Each PR body lists its gate edits; /review lists them; all fall inside Garry's 2026-10-17 approval. Nothing lowers a threshold, changes a case's assertions, changes trials or kinds, or retries a paid case to change a verdict.

### Risks

- **A defect a PR causes in a transitively reached case is caught at the batch gate, not on the PR.** Replay: 4 of 33 e2e PR-caused reds, each covered by the canary set. Cost when it happens: one bisect (red cases only, a few dollars) and a train rebuild ($93 plus latency).
- **An outside red (flake or main defect) now blocks a whole train.** Bisect classifies it against main alone; a red on main alone follows the existing exception path through GStack Minder. Fewer outside reds reach PRs (the tier selects 46% of them).
- **Ready-only gating delays feedback.** Lanes lose the paid gate as a test loop; focused local paid runs replace it (CREW.md 14 already requires that).
- **The savings depend on discipline and on GSTA-48's store fix.** Without L4 the plan lands near 2.9x.

### Validation

Per AGENTS.md "Validation discipline": focused unit tests per lane during repair; `bun test test/parity-suite.test.ts` for the ship template edit; the SKILL.md size guard before any paid gate; one full `bun run test` (remote pregate, CREW.md 13) per PR on a frozen tree. Paid validation: each lane's own PR gate (pre-approved). L5's panel is preregistered and capped at $10; total paid calibration for this plan stays under $50 of the $300 approved.

### Binding decisions

- Garry, 2026-10-17: "Do it all" for levers 1 to 5; trial counts and kinds are data only; calibration panels up to $300 total, each preregistered.
- GStack Minder routes every edit to `.github/workflows/evals*.yml` and reuse logic through GSTA-48.
- Autoplan budget: at most 3 review rounds, then accepted-with-findings deferred to the build.

## Review record

(Filled in by the /autoplan run.)
