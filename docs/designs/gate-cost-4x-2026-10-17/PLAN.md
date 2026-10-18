<!-- gstack-autoplan-scope: --no-ui --developer-tool -->
# Cut the paid PR gate bill about 4x (October 17, 2026), revision 2: train-first

## Implementation plan

### Context

This is plan revision 2. Revision 1 (a mandatory narrowed PR tier, per-case reuse and a batch full gate) was reviewed by six voices (CEO, DX, Eng; Claude Opus 5.5 native, GPT-6.1 Sol outside): 71 findings, 3 Critical (one defect, raised three times), 33 High. The gate (rev 1, answered under GStack Minder's standing instruction) accepted the outside CEO voice's user challenge d2: **train-first**. This revision folds every finding in; the Review record lists how.

Owner request (Garry, 2026-10-17): "is there any way we can reduce cost like 4x". Paid PR gates (E2E Evals, evals.yml: 108 rule cases and 24 judges, $93 recorded per full gate) cost about $9,950 a week, $236 per merged PR (GSTA-47). Garry pre-approved five levers the same day ("Do it all"): (1) PRs run only diff-relevant cases, plus a full gate per merge batch or nightly on main; (2) a merge train with bisection on red; (3) decoupling the shared preamble; (4) cheaper judges and fixture actors with the model under test unchanged; (5) prompt caching. Trial counts and case kinds are data only. GStack Minder (GSTA-36) owns every merge and routes file conflicts; lanes send READY unstamped (CREW.md 6).

Base: origin/main `fd13cf2` (v1.91.133.0). In flight: GSTA-48 (R1 readiness-gated dispatch, R2/R2a reuse of a green verdict when only main moved or the stamp changed, and the receipt-store restore fix). It owns `.github/workflows/evals*.yml` and `scripts/gate-reuse.ts`. Every lane here that edits those files starts after GSTA-48's PR merges and is routed through GStack Minder; this plan consumes R2's "same own-diff" rule only through its merged interface.

Measurement: MEASUREMENT.md beside this file. What shaped revision 2:

1. **97% of a gate is the model under test (Fable 5.1).** Judges cost $1.44 a gate, there are no LLM fixture actors, and caching is already on (89% of input tokens are cache reads). Levers 4 and 5 are worth about $35 and $100 a week.
2. **Narrowing the PR selection saves less than revision 1 claimed.** Revision 1's 61% came from a proxy (hub files deleted from the diff). Exact free replays over the 92 merged PRs, on the $106 full-gate scale (today $78.5 per PR): R4's exercised-map shadow $63.1 (−20%); declared touchfiles only, with preamble-only SKILL.md changes and transitive-only files sent to a canary set, $47.9 (−39%, median $21.6, 36 cases). Preamble PRs regenerate every SKILL.md, so the preamble is a genuine input of every case unless a hunk classifier proves a change is confined to the shared block.
3. **Frequency is the lever.** After GSTA-48 a paying PR still runs about 2.4 full-gate equivalents. A full gate per train of five PRs, plus one screening run per PR, is about 0.3 full gates plus one $42 screen.
4. **E2E Evals is not a required status check today.** The only required check on main is `free-tests` (ruleset free-tests-required); the paid verdict is enforced by GStack Minder's merge procedure. The plan therefore enforces the full-gate requirement in `gstack-ship-queue verify` and offers a required-status hardening as Garry's GitHub-UI action.

Thesis: **every merge is covered by a full gate run on the exact tree it produces, each PR pays once for what it directly touches, and nothing is retried to change a verdict.**

### Target

Primary: paid-gate dollars per merged PR, from $236 to about $59; weekly dollars and merge volume reported beside it (about $2,500 at 42 merges a week). Re-measured by GStack Minder after each landing with GSTA-47's scripts plus `scripts/gate-cost-replay.ts` (lane T0).

| step | $ per merged PR | $ / week at 42 merges | multiple |
|---|---|---|---|
| today | 236 | 9,950 | 1.0x |
| GSTA-48 (R1, R2) | ~166 | ~7,000 | 1.4x |
| T1+T2: screen once at READY ($42 recorded mean x 1.3 for repair re-screens, 71% of PRs pay) and full gate per train of 5 (1.45 gates per train with reds and rebuilds, plus bisects) | ~69 | ~2,900 | 3.4x |
| T3: outside-red rate per full gate down to 10% (quarantine and flake repairs), trains of 6 | ~62 | ~2,600 | 3.8x |
| T5: shared session prefix, if its measurement passes (−4%) | ~60 | ~2,500 | 4.0x |

Honest range: **3.3x to 4.0x**. The swing factors are the outside-red rate on full gates (30% before #3260, an estimated 15% now; every red train costs a rebuild) and train size. 4x needs both T3 conditions.

### Release promises

- **P1. Every merge is covered by a full gate before it merges.** A train's full gate runs on the exact tree the queue produces (main plus each PR in slot order); GStack Minder merges only PRs whose train is green and stops if main's tree after a merge differs from the tested prefix tree (modulo stamps). An urgent fix is a one-PR train. Prefix trees T1..Tk-1 exist on main only for the minutes between a train's merges; that is the same integration exposure R2 already accepts.
- **P2. Each PR runs its diff-relevant cases once before it joins a train** (lever 1), with all 24 judges and a canary set when it changes a transitive-only or full-gate file.
- **P3. Nothing is retried to change a verdict.** A red train stays red. Bisect is diagnosis; only a changed train (a PR dropped, or a repair merged) gates again.
- **P4. The model under test runs exactly as today**: same model, effort, prompts, skills, assertions, trials and kinds.
- **P5. Savings are measured per merged PR from committed scripts,** never asserted.

### Premise table

| premise | claim | receipt | verdict |
|---|---|---|---|
| P-a | a full gate records $90.93 to $94.70 | report-verdict of the nine runs in MEASUREMENT.md | true |
| P-b | Fable is 97.1% of recorded gate cost | `modelUsage` in every `result` event; fit reproduces lib/pricing.ts | true |
| P-c | the PR gate has 0 behavior cases | trial-outcomes kinds: 108 rule, 24 judge | true |
| P-d | touchfile-only screening averages $47.9 per merged PR ($106 scale) | .context/gatecost-l3.ts replay over 92 PRs (becomes lane T0's script) | true (replay) |
| P-e | R4 shadow selection averages $63.1 | gatecost-shadow.ts replay | true (replay) |
| P-f | only `free-tests` is a required status on main | `gh api repos/garrytan/gstack/rulesets/20890096` | true |
| P-g | outside reds hit 30% of near-full gates before #3260 | per-run.csv: 54 of 182 | true |
| P-h | outside-red rate after #3260 is about 15% | GSTA-47: #3260 removed causes of about half the outside-red spend | estimate |
| P-i | screened PRs reach a train red 6% of the time | 4 of 65 paying PRs had a PR-caused red the screen would not select | estimate (replay of failing heads pending in T0) |
| P-j | GSTA-48's store never restored | GSTA-48 report 2026-10-18 03:54Z | reported; no lane here depends on it |

### Lanes

**T0. Measurement as code (free; first).** `scripts/gate-cost-replay.ts` (logic in `lib/gate-cost.ts`): given a list of PR numbers or a date window and recorded run ids, prints per-PR selection cost under today's selector, R4 shadow and the T2 screening rule, the per-model and token-class breakdown of a gate, and $ per merged PR. It reuses `computePaidCaseSelection` and reads costs from downloaded report artifacts (`gh`, read-only, cached). It also replays every PR-caused red on its failing head (not the merged squash) against the T2 rule, the result that settles P-i, with the canary set fixed by T2's structural rule before the replay runs (no tuning on the replay). Tests: fixture artifacts in `test/fixtures/gate-cost/`, free.

**T1. Merge trains in the shared queue (lever 2).** Subcommands of `gstack-ship-queue` in `lib/ship-queue-train.ts` (exit table 0/1/2/3, `GSTACK_RESULT: skill=ship-queue`, codes in `lib/result-codes-release.ts` with docs/troubleshooting.md anchors):

- `train build --prs 3301@<sha>,3302@<sha> [--dry-run]`: refuses a PR whose head repository is not the base repository (`QUEUE_TRAIN_UNTRUSTED`: fork work stays on the trusted-branch path) or whose head moved from the pinned SHA (`QUEUE_TRAIN_MOVED`); requires each PR's READY receipt and a passing T2 screen at that head (`QUEUE_TRAIN_UNSCREENED`). Builds in a temporary worktree from origin/main, merging unstamped heads in slot order; records prefix trees T0..Tk modulo stamps. A conflict prints `QUEUE_TRAIN_CONFLICT: train <n> stopped at #<pr> (conflicts: <files>) after merging #<a>,#<b>; nothing dispatched, no branch pushed; fix: gstack-ship-queue train build --prs <list without pr>`. `--dry-run` prints trees and the estimated cost and spends nothing. Writes `train.json` (pinned heads, trees, nonce) before pushing `train/<nonce>` and dispatching `evals.yml` (`evals_all`) through `scripts/eval-bg.ts`'s nonce, so an unknown dispatch is reconciled by `train status` (finds the run by nonce) and never re-dispatched blindly (`QUEUE_TRAIN_DISPATCH_UNKNOWN`).
- `train verdict --train <n>`: maps every paid-report class. Green only for a complete gate (108 rule cases and 24 judges executed, no unbound, partial or cancelled shard) on the recorded train tree; then posts a `gstack/full-gate` success commit status on each included PR head and on the train head, naming the run and train tree. Pending: `QUEUE_TRAIN_PENDING` (exit 3). INFRA or INCOMPLETE: `QUEUE_TRAIN_INCOMPLETE`, never green; recovery names the single re-dispatch EVAL_POLICY.infraRedispatch allows and requires reporting both runs. Red: `QUEUE_TRAIN_RED` with the red cases.
- `train bisect --train <n> --spend-cap <usd> [--dry-run]`: one `evals.yml` dispatch with a validated `cases` input (ids checked against gate ids; added by the T1b workflow change) and a matrix over the recorded prefix trees, running only the red cases. Each prefix result is recorded so a rerun resumes rather than repeats. Outcomes: `ATTRIBUTED #<pr>` (drop it and build a new train), `RED_ON_MAIN` (red at T0: a main defect, fix forward first), `QUEUE_TRAIN_UNATTRIBUTED` (no prefix reproduces: the train stays red and GStack Minder routes it through the flaky-drop, CASE_QUARANTINE and exception rules; no unchanged retry). Bisect results never turn a train green.
- `verify` (existing) accepts a green train record: each merge requires `gstack/full-gate` success for that head on a train whose prefix tree equals main's tree after the merge modulo stamps (`gstack-tree-receipt`); a mismatch refuses (`QUEUE_TRAIN_TREE_MISMATCH`) and the next merge stops. GStack Minder stamps each PR at merge with `gstack-restamp` (stamp-at-merge), so the verdict carries over to the stamped head without a new gate.
- Branch lifecycle: `train/<nonce>` branches are deleted after the train merges or is superseded (`train prune`).

**T1b. Workflow surface (routed through GStack Minder after GSTA-48 merges).** `evals.yml`: (a) a validated `cases` dispatch input for bisect; (b) PR pushes stop starting paid slices: a `pull_request` run prints the screening selection and cost for free, and paid screening runs only from `gstack-ship-queue ready --screen` (a `workflow_dispatch` bound to the PR head SHA through eval-bg's nonce), so no label trigger and no concurrency-cancel interaction exist; (c) the free summary's first line says how to request the screen. A new `evals-main-backstop.yml` runs the full gate on main HEAD only when main's tree modulo stamps carries no `gstack/full-gate` success (a merge outside the queue); a red writes a freeze record (red cases, their input files, run, issue) that `verify` reads (`QUEUE_FROZEN: #<pr> touches <file> (red case <id> on main, run <id>); fix: land the revert or fix-forward`). Optional hardening for Garry (GitHub UI, through GStack Minder): add `gstack/full-gate` as a required status on main.

**T2. Screening selection (levers 1 and 3).** One closure function in `scripts/pr-dependencies.ts` with an edge-policy parameter, shared by R4's shadow block and the screen (no second engine): the screen's edges are a case's declared touchfiles, its test file's static helper closure, and the harness global set; generated SKILL.md changes select by hunk: a hunk inside a resolver-generated shared region (the preamble blocks `gen-skill-docs` emits, identified by markers it already writes or adds) counts as a preamble change; any other hunk, or an unparseable diff, selects that skill's cases directly. Preamble changes and files that reach cases only through the transitive reference walk add the canary set; full-gate files (`setup`, `bun.lock`, Dockerfile.ci, evals.yml, build.sh, gen-skill-docs.ts) add the canary set and must merge through a train like everything else. The canary set is defined by a structural rule, not by history: one case per preamble-dependent surface (skill start and plan mode for PTY and claude -p hosts, the AskUserQuestion format, the bins every skill runs, the hermetic sentinels), reviewed in `test/helpers/touchfiles-data.ts`; T0 then reports its leave-one-out miss rate on history. All 24 judges always run. Configuration: a validated `pr_screen` key in `.gstack/ship-policy.json`, always read from the base revision; an invalid value falls back to today's selection and prints `PR_SCREEN_CONFIG_INVALID`. Every selection prints one provenance line per changed file. `evals-broad` forces today's selection for one PR. Tests: the hunk classifier (preamble-only, mixed, unparseable), canary on transitive-only and full-gate files, base-revision config read, invalid config fallback, provenance lines, and that the full-gate path is unchanged.

**T3. Outside-red reduction (needed for 4x).** Not new machinery: GStack Minder applies the existing CASE_QUARANTINE rules and routes each `QUEUE_TRAIN_UNATTRIBUTED` case to a repair lane. T0 reports the outside-red rate per full gate weekly.

**T5. Shared session prefix (lever 5; measure, then decide).** A preregistered panel (`bin/gstack-eval-plan` prereg, cap $10) runs 6 short Fable sessions in two layouts and reads first-request `cache_read_input_tokens`. Build only if the shared prefix grows by at least 3k tokens per session, and then list it as a gate-integrity edit: a fixed session path changes the working directory text in the model's system prompt. Preflight `unshare`; on failure, run sessions unchanged and print `SESSION_PREFIX_UNAVAILABLE`. Otherwise record the measured number and stop.

### Not built (data only)

- Per-case receipt reuse (revision 1's L4): dropped. Its key would need the full runtime identity of today's shard receipts, durable invalidation of older passes, and GSTA-48's store fix; after train-first it saves under $300 a week.
- Cheaper judges and fixture actors: at most $1.15 per gate; no LLM actors exist.
- Trial counts and case kinds: the PR gate runs no behavior cases.
- R4 activation: unchanged criteria (GSTA-45). T2 shares its engine, so activation later swaps the edge policy.
- Model under test: Fable is 97% of the bill; Opus 5.5 at the same tokens would be about $40 a gate. Excluded by Garry's rule.
- GitHub merge queue: its bisection reruns the full $93 gate per sub-batch, while T1 bisects on red cases only, and GStack Minder keeps merge authority and stamping.

### Gate-integrity edits

T1 (merge authority moves from per-PR gates to the train verdict), T1b (PR pushes no longer start paid slices), T2 (PR screening selection), T5 if built (session working directory). Each PR body lists its gate edits; /review lists them. All fall inside Garry's 2026-10-17 approval. Nothing lowers a threshold, changes assertions, trials or kinds, or retries a paid case to change a verdict.

### Risks

- **A red train delays up to five PRs.** Expected 30% to 45% of trains go red (outside reds plus screen misses); each costs a bisect (a few dollars) and a rebuild ($93 and about 45 minutes). Smaller trains cut latency and raise cost.
- **An unattributed red has no automatic exit**, by design (P3). GStack Minder routes it; expected about one a week at a 15% outside-red rate.
- **Screen misses surface at the train, not on the PR**: 4 of 65 paying PRs in the window.
- **Cost can shift to lanes' local paid runs on the same key.** Lanes report local paid spend (host spend as unknown); T0's per-merged-PR number includes eval-bg runs it can see.
- **Prefix exposure**: between a train's merges, main holds trees whose own full gate did not run, for minutes.

### Order and dependencies

T0 first (free). T2 and T1 next in parallel (disjoint files; T2 owns pr-dependencies.ts, paid-select.ts, test-pr-profile.ts, touchfiles-data.ts; T1 owns lib/ship-queue*.ts, bin/gstack-ship-queue, docs/ship-policy.md). T1b after GSTA-48 merges, through GStack Minder. T5's panel any time; T3 is GStack Minder's routine. Trains go live when T1, T1b and T2 have merged; until then nothing changes for lanes.

### Validation

AGENTS.md "Validation discipline": focused unit tests per lane; train fixture repos outside the checkout with a proven seed identity; subprocess timeouts that pass `test/spawnsync-timeout-tripwire.test.ts`; new modules added to the module-size ratchet; `bun test test/parity-suite.test.ts` for template edits; the SKILL.md size guard before any paid gate; one full `bun run test` (remote pregate, CREW.md 13) per PR on a frozen tree. Paid validation: each lane's own PR gate (pre-approved) and, before trains go live, one dry-run train of two already-merged PR heads rebuilt on their original base (one $93 gate). T5's panel is preregistered and capped at $10.

### Binding decisions

- Garry, 2026-10-17: "Do it all" for levers 1 to 5; trial counts and kinds are data only; calibration panels up to $300 total, each preregistered.
- Gate rev 1 (2026-10-18): d2b, train-first, answered under GStack Minder's standing instruction to take recommendations inside the five levers.
- GStack Minder routes every edit to `.github/workflows/evals*.yml` and reuse logic through GSTA-48.
- Autoplan budget: at most 3 review rounds, then accepted-with-findings deferred to the build.

## Review record

Round 1 (revision 1): CEO 20 findings (native 14, outside 6), DX 26 (16, 10), Eng 25 (13, 12). Handled in revision 2:

- Neutral "not requested" check satisfying protection (DX F1, Eng-outside F11, CEO F5): T1b removes PR-level paid triggering; `verify` requires `gstack/full-gate`; E2E Evals was never a required status (P-f).
- Nightly fallback contradicting P1 (CEO F4, CEO-outside F1, Eng-outside F6): every merge goes through a train; the backstop only covers merges outside the queue and freezes on red.
- Flaky reds in trains (CEO F6): P3, `QUEUE_TRAIN_UNATTRIBUTED`, routed to existing rules.
- Proxy measurement (CEO F2, Eng F1, Eng-outside F1, CEO-outside F3): exact replays (P-d, P-e); T0 commits the replay; the target table uses replayed numbers and a range.
- Canary chosen from misses (CEO F3, CEO-outside F4): structural rule, leave-one-out reported by T0.
- Preamble fan-out through regenerated SKILL.md (Eng F2, Eng-outside F2): hunk classifier.
- Second closure engine and R4 overlap (CEO F1, Eng F10): one engine with an edge policy; gate d1 kept direction.
- Second queue CLI (DX F2): `gstack-ship-queue train`.
- Dispatch, verdict, bisect, conflict recovery (DX F3-F6, DX-outside F2-F5, Eng-outside F9): nonce-first dispatch, full class mapping, spend-capped resumable bisect, conflict line.
- Fork secrets and moved heads (Eng F3, Eng-outside F10): same-repository only, pinned SHAs.
- Label-event cancellation (Eng F4) and label trigger shape (DX F12, F10): no label trigger.
- L4 identity and invalidation (Eng F5, Eng-outside F4, F5): L4 dropped.
- EVALS_ONLY does not exist (Eng F6, Eng-outside F8): validated `cases` input in T1b.
- Tree after squash (Eng F7, Eng-outside F7, CEO F11): prefix trees compared modulo stamps; stamp-at-merge.
- Backstop durability and freeze enforcement (Eng F8, DX F7, DX-outside F9): tree-keyed backstop, freeze record read by verify.
- Config, naming, provenance, escape hatches, docs (DX F8-F15): `pr_screen` in ship-policy read from base; provenance lines; `evals-broad`; docs/ship-policy.md "Run a merge train" and TESTING_INTERNALS updates in T1 and T2.
- Cost model gaps (CEO F7-F10, CEO-outside F5): red trains, rebuilds and bisects priced; target per merged PR; local spend reported; range 3.3x-4.0x.
- Merge queue alternative (CEO F12): Not built section.
- L5 integrity and fallback (CEO F14, DX F16, DX-outside F8, Eng-outside F12): T5 measured first, gate-integrity edit if built, fail-closed preflight.
- Skill-read cost (CEO F13): recorded as a separate initiative for GStack Minder; out of scope here.
- Ship-receipt side effect (Eng F12) and train branch lifecycle (Eng F13): no label write; `train prune`.
