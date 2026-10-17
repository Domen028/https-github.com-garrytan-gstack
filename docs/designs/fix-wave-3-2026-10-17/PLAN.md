<!-- gstack-autoplan-scope: --no-ui --developer-tool -->
# Fix wave 3 (October 17, 2026): PR eval cost (W2) and paid-gate reliability round 2 (W3)

## Implementation plan

### Context

Owner request: Garry approved GSTA-41's triage on 2026-10-17 with "Accept all recommendations", which includes "Autoplan W2 and W3 together now" (reports/triage-2026-10-17.md in the GStack Minder drive). Coordinator: GStack Minder (GSTA-36) owns the merge queue, version slots and every merge; this wave opens PRs and sends READY reports unstamped. Builder: GSTA-45.

Base: origin/main 521fd42 (v1.91.122.0). Queue above main: #3240 (.123) and #3242 (.124), both GSTA-24, both in lib/cso, cso/ and scripts/cso-eval*. Live owners this wave must not collide with: GSTA-46 (W5: lib/pregate/import-graph.ts, lib/pregate/checks/lanes.ts, lib/regen.ts, test/pregate-selection.test.ts, test/helpers/pregate-fixture.ts), GSTA-33 (W4 duration-seed recorder: scripts/free-test-durations*.json and free-tests.yml), GSTA-44 (#3220 brain-sync). Out of scope: W4, W5, W6-W9.

Evidence base. Two read-only investigations on 521fd42 (no paid spend):
- **W2:** 225 evals.yml pull_request runs with a paid-plan manifest over 10 days (2026-10-07 to 2026-10-17), every manifest, trial-outcomes artifact and verdict line, each run's changed files replayed through today's selector (`computePaidCaseSelection`, the replay tool's entry point), plus counterfactual replays of each proposed fix.
- **W3:** every red verdict in PR gate runs since #3231 (`bun run eval:pass-rates --reds --workflow evals.yml --runs 60`): 21 reds in 17 runs (38969924945 to 39011101113). Each rejected tool call was replayed through the real detector on main.

Thesis: **spend the PR gate's money only where a diff can change the outcome, and make a red verdict mean the diff broke something.**

### Release promises

- **P1. A PR's paid selection follows what its diff can actually reach.** Selection never under-selects (the shebang defect is closed first), and the cost metric tracks dollars and cases per run, not the fallback label.
- **P2. A gstack contributor on a small machine can finish pregate.** Under 8 cores, the local test tier routes to a declared remote gate that prints a tree-bound receipt instead of running for an hour.
- **P3. Every open red cause found in the window is fixed at its cause or kept as a named negative control.** No threshold, trial count, case kind or quarantine changes.
- **P4. `/ship` slot allocation does not wait on serial GitHub calls.**

### Premise table

| premise | claim | receipt | verdict |
|---|---|---|---|
| P-a | 42.5% of PR runs fall back to full selection | test:health 7d 68/160; 10-day replay 95/225 recorded, 91/225 under today's selector | true |
| P-b | touchfile mappings for bin/, lib/, hosts/, make-pdf/ cut the fallback | no file under bin/, lib/, hosts/, make-pdf/, scripts/ or browse/ was an unknown file in any of the 225 runs; the derivation (scripts/pr-dependencies.ts) already places them | **false as stated** |
| P-c | cutting the fallback rate cuts spend | fixing every narrowable trigger takes the rate 40.4% -> 14.2% on replay but predicted spend only -2.5%: every run that leaves full-fallback lands in `dependents`, which selected all 108 gate cases and 24 judges in 100 of 105 such runs | **false** |
| P-d | cost by mode | recorded known cost per run: full-fallback $91.60 (n=61), dependents $80.09 (median $91.06, n=35), pr $14.87 (median $0, n=59); fallback + dependents carry 90.5% of known spend | true |
| P-e | the derived closure reaches almost every case | 91 bin/, 103 lib/, 130 browse/ files reach at least 100 of 108 gate cases; hub edges include remediation prose `/gstack-upgrade` read as a call to bin/gstack-upgrade, string and doc-comment mentions, and real hubs (gstack-config, gstack-skill-start, gstack-pregate) | true |
| P-f | the derivation under-selects shebang files | `Bun.Transpiler.scanImports` throws on a leading `#!` and the error is swallowed; `computePaidCaseSelection(['lib/fs-utils.ts'])` selects 0 cases though bin/gstack-redact-prepush and three other bins import it; 51 extensionless bins and 66 .ts/.js files affected | true (latent; no observed miss) |
| P-g | lockfile-only changes restore every case | bun.lock and package.json are PR_FULL_GATE_FILES; 0 runs in the window fell back on them alone; dependabot runs are skipped by evals.yml (`github.actor != 'dependabot[bot]'`, lines 53/181/253); every runtime package's importer reaches all cases or is global | true; narrowing buys 0 runs |
| P-h | gstack's pregate has no remote gate | .gstack/pregate.json has no `remote_gate`; lanes.ts:207 needs `remote_gate` or a non-local test_backend; GSTA-35's 798-file local lane passed 3,550 s on 4 cores | true |
| P-i | gstack-next-version fetches serially | bin/gstack-next-version:90 `GH_API_CONCURRENCY = 10`, workers call `runCommand` -> `spawnSync` (:111); 8 stubbed PRs at 0.5 s took 4,160 ms (TODOS.md fix-wave-2 entry) | true |
| P-j | createQAFunctionalFixture lacks git maintenance config | test/helpers/qa-functional-fixture.ts:279-280 sets `gc.auto 0` and `maintenance.auto false` since 0bf9d50 (#3190); qa-callers-fixture.ts:594-595 too | **false (already fixed)**; the TODOS entry is stale |
| P-k | the webhook-report red was `bun test` / `git status` | both are declared (qa-functional-observer.ts:301); the two denied calls were `cat package.json probe.ts .gitignore` and `cat src/*.ts test/*.ts` | **false**; genuine model miss |
| P-l | autoplan-answer-invalidation runs near 5 s | the eng-only override test (:168, no explicit timeout) took 4,137 ms on 4 cores; file 7.8-9.4 s | true |

unverified=0

### Already done

Six of the 21 window reds are fixed on main with regressions: ship-docsync-store x2 (f592d67, c71d764), qa-only-no-fix (f592d67), ship-exploratory-plan-checks 38981523623 (f592d67), tpa-absent-linux 38988927989 (73f1394), qa-functional-webhook-fix 38974669950 (0bf9d50, maintenance config). Main already fixed 4 of the 95 recorded fallback runs (#3231 detector-corpora fixtures, #3125 and #3121 .gstack/* classification).

### Surface check

Verified on 521fd42 by source: `selectPrProfile`, `FREE_ONLY_PR_FILES`, `PR_FULL_GATE_FILES`, `DERIVABLE_PREFIXES` (scripts/test-pr-profile.ts); `SELECTION_DATA_MODULES`, `refs`, the global walk (scripts/pr-dependencies.ts); `remote_gate`, `PREGATE_REMOTE:` contract, `PREGATE_TREE`/`PREGATE_FILES_FILE` (lib/pregate/checks/lanes.ts, docs/pregate.md#remote-gate); `ubi-runner.sh run --src --setup --env --pull`; `test-free-shards.ts` flags (no file-subset flag today); `gstack-docs-candidate` top-level `--help` only (:91) and `compare` schema check (:123). New surfaces are named as new.

### Binding decisions

- Every merge is GStack Minder's; READY reports go unstamped; never stamp before a slot call (CREW.md 6).
- No threshold, trial count, case kind or quarantine changes (EVAL_POLICY; AGENTS.md Validation discipline step 6). A detector change must keep or add negative controls.
- Do not edit files GSTA-46 (W5) or GSTA-33 (W4) own; lib/pregate/** stays untouched by this wave.
- Paid PR gates are pre-approved (Garry, 2026-10-15).

### Numbers

- W2 replay: today 91/225 full-fallback (40.4%), mean 79.6 gate cases per run. Sound classification fixes alone (W2-2): 36/225 full-fallback (16.0%) but no spend change, because those runs land in dependents mode that still selects about 105 cases.
- W2-3 measured by replay (541 PR runs of observed commands: 12,127 case records, 235,795 commands): the exercised-path map applied to every changed file replays with **0 misses against all 47 recorded gate reds** and cuts predicted spend **6.5%** (scaled $14,751 -> $13,795 per 10 days, about $35k a year; mean gate cases 79.6 -> 74.5). Applied only to unmapped files, as first drafted, it cuts 15% but **misses 5 reds**, because touchfiles name hub bins for only some of the cases that run them; that variant is rejected. The classification fixes without the map cost slightly more than today and miss 3 reds once free-fixtures-data.ts stops being global, so that one change ships only with the map.
- The floor: 46 files (32 bin, 11 lib, 3 other) still reach 100-106 of 108 cases under any map, because every generated SKILL.md runs the preamble bins (gstack-skill-start alone closes over 73 files). Going below that needs a cheaper contract for preamble-hub diffs, not a finer map (deferred ask D1).
- W3: of 17 red runs in the window, 6 are already green on main; W3 fixes the cause in a further 7 (38973329985, 38986120559, 38990111230, 38993076767's small-cli, 39002269281, 39004466422, 39011101113) and the detector misread in 38980005793's shim-dom; 5 runs stay red: genuine model misses (D3 in 38983306684 and 38984977679, Q3 in 39006896632), one timeout tail (T, 38980005793) and one undetermined hang (U, 38976253774). 39001107574 (C) turns green only if the W3-9 hardening changes behaviour.

### Wave items

#### W2: PR eval cost (one PR, ~$93 full gate; it edits global touchfiles, so every case runs)

**W2-1. Close the shebang under-selection first (correctness).** In scripts/pr-dependencies.ts, strip a leading `#!` line before `scanImports` in `refs`, the global walk and `targetsOf`, and treat bun/node-shebang extensionless files as code. This broadens selection (34 files flip from no-consumer to consumed; test/helpers/bootstrap-retention.ts joins the global set through scripts/test-paid-shards.ts). Free tests: `lib/fs-utils.ts` selects the cases of bin/gstack-redact-prepush; a shebang fixture's import is found; an error other than the shebang still fails closed (selects everything), never silently.

**W2-2. Sound classification fixes (scripts/test-pr-profile.ts, scripts/pr-dependencies.ts).**
- FREE_ONLY_PR_FILES gains .github/dependabot.yml, .osv-scanner.toml, setup.ps1, .gitlab-ci.yml, .github/ISSUE_TEMPLATE/**, .gstack/ship-policy.example.json, each with its one-line reason (readers: osv-scanner.yml and free tests; windows-setup-e2e.yml; free gstack-doctor.test.ts:363). test/paid-free-boundary.test.ts:117 swaps its sample unknown file to one that stays unmapped.
- capy/ joins REPO_PATH and DERIVABLE_PREFIXES, so capy/support.env derives to bin/gstack-install-verdict.sh and bin/gstack-doctor-check.sh.
- test/helpers/free-fixtures-data.ts stops being global by the import walk: it joins the map-diff path that touchfiles-data.ts uses (diff FREE_FIXTURES old vs new, select the cases whose closure holds a reclassified fixture, fail closed on any error). It lands only with W2-3: on replay it otherwise drops three #3231 reds whose cases really run the changed bin/gstack-skill-start and gstack-skill-end.
- `setup` leaves PR_FULL_GATE_FILES and is touchfiled to the cases that execute it (gstack-upgrade-happy-path, skillmd-setup-discovery and the install/overlay fixtures that spawn `join(src, 'setup')`). CI never runs ./setup (evals.yml runs `bun run build` and the register-gstack-skills composite). A new free completeness scanner fails when a paid test or helper spawns `setup` without being in that list.
- Skill-name mentions (`/gstack-x` after whitespace, a quote or a parenthesis) stop counting as bin invocations; path forms (`bin/gstack-x`, `$(dirname "$0")/gstack-x`) still count.
- A full-gate file is never also labelled "real unknown dependency" (cosmetic; fixes wrong fix text for evals.yml, test-setup.ts, .gitattributes).
- Generator inputs (scripts/resolvers/index.ts, gen-skill-docs.ts, preamble.ts, preamble/**) stay in PR_FULL_GATE_FILES in this wave. Selecting them through committed generated output is sound only if every host output a paid case loads is committed and freshness-gated; that is not verified, so it is deferred (TODOS entry with the 29-run replay effect).

**W2-3. Exercised-path consumers for every changed file (the spend lever, about 6.5%).** Today a derived file's consumers are every case whose reference closure reaches it, through prose, strings and slash-command names as well as code. Replace that with the union of: (1) cases whose direct touchfiles match; (2) cases whose test file or helper import closure holds the file; (3) cases whose loaded skill (template and generated SKILL.md) has executable bash blocks naming a bin, compiled binary (`$B`, `$D`, browse/design/make-pdf dist outputs mapped to their source trees) or sourced script whose code closure holds the file, with comments, heredocs, echo/printf/die messages, case patterns and bare `VAR=gstack-x` strings stripped; (4) cases observed invoking such a bin, from a committed, generated `test/helpers/exercised-commands.json`. The union applies to every changed non-global file in pr and dependents modes, never only to unmapped files. PR_FULL_GATE_FILES and GLOBAL_TOUCHFILES stay full, and the closure stops at them.
Guards, because observed sets are a moving lower bound (a typical run shows half its case's union, 23 cases gained a bin in the window's last third, six PTY cases record no commands):
- **Per-run, in the paid report job (non-blocking):** every case's recorded Bash commands go through the same bin matcher; a bin outside the case's recorded set is printed as `MAP_GAP <case> <bin>` in the report and uploaded as an artifact. It never turns a PR red.
- **Periodic census (blocking there):** the scheduled full run rebuilds the observed sets from its own artifacts (no API downloads; the build hit the installation's 403 artifact limit), fails on any `MAP_GAP` and on a PTY case that records zero commands while its skill's bash blocks name bins, and prints the refresh command.
- **Freshness:** selection refuses a map older than 14 days or missing a declared case, and falls back to today's derivation (never to a narrower one), saying so in the plan reasons.
Free tests: the 47 recorded reds replay with 0 misses (captured changed-file lists and case ids as a fixture); the five variant-c misses are negative controls; a stripped prose mention (`/gstack-upgrade` in remediation text) no longer reaches bin/gstack-upgrade while `bin/gstack-x` and `$(dirname "$0")/gstack-x` still do; a stale map falls back.

**W2-4. Measure what the money follows.** scripts/test-health-report.ts adds `pr-cases-per-run` (mean selected gate cases and judges per PR run) and `pr-known-cost-per-run` beside `pr-fallback-rate`; the CEO metric moves to cost per merged PR, which test:health already reports.

**W2-5. Lockfile decision: keep package.json and bun.lock full.** No narrowing is built: no run fell back on them alone, dependabot never reaches the paid lane, and every runtime package's importer reaches all cases. Documented in docs/TESTING_INTERNALS.md#pr-paid-lane-fallback with the evidence, so the next PR that selects 132 on a lockfile change is understood rather than re-litigated.

**W2-6. A remote gate for gstack's own pregate (P2).** New `scripts/ubicloud/pregate-remote.sh`: reads `PREGATE_FILES_FILE` and `PREGATE_TREE`, recomputes the tree with bin/gstack-wtree before upload and refuses on mismatch, runs the selected files on one Ubicloud VM through the free shard runner in parallel (new `--files-from <path>` flag on scripts/test-free-shards.ts, restricting the planned set to those files and nothing else), recomputes the tree after, and prints `PREGATE_REMOTE: tree=<tree> tests=<n> failed=<n> spent=<usd>` (spent from VM minutes at the standard-16 rate). With no `UBICLOUD_API_KEY` it exits non-zero with a clear message and the obligation stays uncleared; it never fakes a pass. .gstack/pregate.json declares `"remote_gate": "bash scripts/ubicloud/pregate-remote.sh"` (takes effect once on main, since pregate reads the base branch's policy). No lib/pregate change. Free tests: `--files-from` plans exactly the listed files and rejects unknown paths; the script's output contract against a stub ubi-runner, including tree mismatch, zero tests and non-zero failures. One real Ubicloud run of the 798-file selection is recorded in the PR body.

**W2-7. Concurrent next-version fetches (P4).** bin/gstack-next-version's workers use async `spawn` (bounded at GH_API_CONCURRENCY, each with its 15 s timeout and the same ok/stdout/stderr result), keeping result order deterministic (sorted by PR number). Free test with a delayed fake `gh` on PATH: 8 PRs at 0.5 s each finish in under 2 s and return the same claims as the serial path; a timed-out fetch yields the same warning as today.

#### W3: paid-gate reliability, round 2 (one PR; prompt and fixture edits select many cases; ~$93 gate plus case panels)

Each item names the cause class from the investigation: (1) fixture/detector defect, (2) skill or prompt defect, (4) genuine model miss.

**W3-1. Docsync fault actor writes real candidates (1; 38990111230 and 79 of 198 docsync captures).** test/helpers/docsync-fault-actor.ts `prepare` (:81-110) writes `docsCandidate()` records that the installed `gstack-docs-candidate compare` rejects as "not a gstack-docs-candidate record" (bin/gstack-docs-candidate:123), while ship/sections/documentation.md:70 requires running compare. `prepare` runs the installed `snapshot` and prints its exact argv so the post-child rerun is literal; docsync-fault-eval.ts reads the helper schema. Free test: actor `prepare` then installed `compare` exits 0 with all-false change flags.

**W3-2. Per-subcommand help in gstack-docs-candidate (1).** `snapshot --help` and `compare --help` print usage and exit 0 before any side effect; test/helpers/docsync-observer.ts:272-274 admits `<candidate> (snapshot|compare) --help` with nothing else. Free regression: the captured 38990111230 ndjson (redacted) replays to `[]`; negative controls `snapshot --help --out x.json`, `compare --help x.json` and an in-repo `--out` stay rejected.

**W3-3. Docsync model misses become negative controls (4; 38983306684, 38984977679).** The captured Bash `grep -n -i …` and `cat …; cat …` join the docsync detector corpus as `refuse` rows. No detector change.

**W3-4. qa-callers prompt stops teaching helper syntax (2; 38973329985, 38993076767).** test/helpers/qa-callers-fixture.ts:700 hands over full capture/checkpoint syntax but only "Materialize is supported…", and both reds skipped qa/sections/exploratory.md and system-functional.md then ran a bare `materialize`; all 83 passing sessions read both sections. The prompt declares only the fixture bindings (evidence tool path, reports dir, deadline file, `--public` approved, `--timeout-ms 10000` for plan probes) and points to the section for the forms. The read requirement stays. Free tests: the two captured transcripts still fail `validateCallerEvidence` (negative control); the prompt contains no `gstack-qa-evidence capture` grammar.

**W3-5. State-machine scope in the generated scope block (2; 39002269281).** #3235 added specialist 9 as inline prose naming `gstack-state-matrix detect --base <base>` (scripts/resolvers/review-army.ts:75), and small diffs skip every specialist except State Machines (:66), so agents run a command the block and the caller interface do not declare. The block (:27) adds `source <(… gstack-state-matrix detect --base <base> 2>/dev/null) || true` before `set | grep '^SCOPE_'`; :75 reads "if SCOPE_STATE_MACHINE=true (printed by the scope block)". Regenerate. test/review-workflow-clarity.test.ts requires SCOPE_STATE_MACHINE from the block; the captured standalone call stays outside the interface.

**W3-6. Webhook fix runs re-verify the whole repaired invariant (2; 38986120559).** The fix-run prompt's stage 2 (test/helpers/qa-functional-eval.ts:33) asks only for the original, happy, cancel and dependency probes, while the verifier (qa-functional-evidence.ts:224) re-runs all 8 scenarios. Stage 2 for webhook re-runs every scenario of the repaired invariant (duplicate, partial, concurrent-ab, concurrent-ba) plus happy, cancel and dependency, inside the 12-probe budget; `QA_WEBHOOK_REQUIRED_SCENARIOS.qa` mirrors it. Free test: the captured status-only repair applied to a fresh fixture fails `verifyQANativeRegression` on partial; an effect-based repair passes.

**W3-7. Lettered consent options when Aside is absent (2; 39011101113).** scripts/resolvers/third-party-actions.ts:54 fixes letters only for the detected case, and the agent numbered 1/2/3. The absent branch offers "B) gstack's own visible browser, C) manual instructions, D) defer (omit A)". Regenerate. Free test: the contract text letters the absent branch; the captured numbered answer is a documented fail example. The test's assertion is unchanged.

**W3-8. Tier-1 reality rows are never n/a (2; 39004466422).** The agent wrote `REALITY: deferred-asks n/a …`, `gstack-plan-reality check` returned verdict=repair, and the repair loop ran past the 300 s capture. scripts/resolvers/plan-reality.ts:59 says tier-1 rows are never n/a, and with no linked issue deferred-asks is `pass` with a receipt showing none. Regenerate. Free test: the captured line through `check` (pinned message) and a skill-text assertion.

**W3-9. Exploratory stop rule ties to the per-rule probes (2 hardening of a 4; 38983306684, 39001107574).** Neither cli-report red probed a non-digit amount; all 32 other CLI sessions did, and qa/sections/system-functional.md:33 already requires one probe per input rule. The exploratory stop rule (qa and qa-only exploratory templates) requires each documented input rule to have its own capture breaking only that rule before stopping. Text assertion only; behaviour is proven by the paid cases.

**W3-10. Shim-dom detector resolves literal assignments (1; 38980005793).** test/skill-e2e-design.test.ts:1248 looks for the literal `dom/run1`, but the agent ran the generated block's `"$_REPORT/dom/$_RUN"` with `_RUN="run1"` assigned in the same command. The check resolves the command's own literal `_RUN=`/`_REPORT=` assignments before matching. This is a gate edit and is listed in the PR body. Free regression: the captured command passes; `scan --changed` and a scan over another directory still fail.

**W3-11. PTY harness keeps the last non-empty screen (diagnostic; 38976253774).** autoplan-guard-pty stalled at 489 s (normal 71-93 s) with empty journal and screen dumps, so the cause is undetermined. test/helpers/pty/ keeps the last non-empty `visibleText()` for the failure dump. No verdict change.

**W3-12. Explicit timeout for test/autoplan-answer-invalidation.test.ts.** Each test in the file gets an explicit per-test timeout sized from measured 4-core durations (30 s), matching the repo's other subprocess-heavy autoplan tests.

**W3-13. Close the stale createQAFunctionalFixture TODO.** TODOS.md's fix-wave-2 entry is already fixed by 0bf9d50; the entry is removed with that citation.

**W3-14. One superseded rule for qa fix runs (2; 39053431488 on #3252).** qa-functional-webhook-fix failed with "missing exact sanitized evidence" because the agent labelled a pre-repair duplicate capture `superseded` without rerunning it. qa/sections/exploratory.md:88 says to classify a capture taken before an input change `superseded`; lib/qa-evidence.ts:346-348 keeps such a row open; the fixture prompt's schema (qa-functional-eval.ts) never mentions superseded, and the detector (qa-functional-evidence.ts:160-166) accepts it only after a rerun, pinned on purpose by test/qa-functional-evidence.test.ts:376-380. Fix where the actor reads it: the fixture prompt states "a capture taken before your repair that you do not rerun keeps the label of what it observed and discloses in limits that it predates the repair; label superseded only a pre-repair capture whose same command you reran on the repaired source"; exploratory.md.tmpl (qa and qa-only) scopes its sentence the same way: rerun, else keep the observed label, with the open-superseded path kept for the helper's older-snapshot case. The detector and its negative test stay unchanged. W3-6's rerun rule also reruns duplicate, which would have closed this row. Free regression: the captured pre-repair duplicate labelled superseded and not rerun fails (negative control); prompt-text assertion for the rule.

**W3-15. Windows budget for test/review-army-budget.test.ts (free; windows-free-tests run 39053431430, shard 5).** The nested `bun test` did not hit its 8 s spawn timeout: it finished in 5.58 s and exited 1 because Bun's default 5 s hook timeout fired on the real Red Team describe's `beforeAll` (8 git spawns plus skill-section copies; test/skill-e2e-review-army.test.ts:643-667), slow on windows-latest (Windows seed 4,143 ms for the file vs 1,879 ms on Linux). The nested argv at :57 and :137 gains `--timeout 30000` (the asserted registrations pass explicit timeouts, so the contract under test is unchanged); spawn timeouts move to 40 s and the outer test timeouts to 45 s, including the consensus test that has none today. Not chosen: a `beforeAll` timeout in the paid e2e file (selects paid cases) or Windows curation (that list is for structural incompatibility). Free check: the nested script with an injected 6 s `beforeAll` still prints the expected lifecycle; the Windows proof is the PR's windows-free-tests run.

Not repaired, kept visible: Q3 webhook-report (4; the two denied `cat` calls become negative controls in the qa-functional observer tests) and T qa-quick (one 300 s timeout with passing runs at 164-272 s; trimming what Quick tier loads is a product call, filed in TODOS).

### Deferred asks

- **D1. Preamble-hub diffs (cost below the floor).** 46 hub files reach the whole gate under any sound map. A cheaper contract (a free contract suite for the preamble bins plus a 2-3 case paid canary for hub-only diffs, the rest deferred to the census) trades PR-time coverage for cost. Not built here; it needs Garry's call on that trade after W2-3's real numbers land. Recommendation: later.
- **D2. Generator-input narrowing** (scripts/resolvers/index.ts, preamble/**, gen-skill-docs.ts selected through committed outputs: 29 runs leave full-fallback on replay, mostly into dependents-all). Deferred until every host output a paid case loads is shown committed and freshness-gated.
- **D3. Nested child output pollutes free-runner failure attribution** (review-army-budget's child `(fail)` line was attributed to its temp script, so the flaky retry was skipped). scripts/lib/shard-engine.ts is outside this wave; filed in TODOS.

### Validation

Per AGENTS.md Validation discipline: one current failure list in `.context/fix-wave-3.md`; focused free tests per item during repair; `bun test test/parity-suite.test.ts`, the SKILL.md size guard (CREW.md 11), skill-docs freshness, `test/spawnsync-timeout-tripwire.test.ts` and credential scanning before any paid run; W3's affected paid cases (ship-docsync-stale-after, ship-exploratory-small-cli, ship-exploratory-plan-checks, qa-functional-webhook-fix, tpa-absent-linux, plan-mode-no-op, qa-functional-cli-report, design-review-detector-shim-dom) run once each at their EVAL_POLICY kind through `bun run eval:bg:pr` before the full gate; then the PR gate; then `bun run test` once on the frozen tree via Ubicloud. Paid evals never retry; a red is diagnosed from its transcript against the diff.

### Delivery shape

Two PRs with disjoint files, opened with Capy's PR tool, READY unstamped to GStack Minder:
- **PR A (W2):** scripts/pr-dependencies.ts, scripts/test-pr-profile.ts, test/helpers/test-selection.ts (map-diff for free-fixtures-data), test/helpers/exercised-commands.json with its refresh script, the MAP_GAP report step (scripts/lib/paid-report.ts, a global touchfile) and the periodic census guard (.github/workflows/evals-periodic.yml), scripts/test-health-report.ts, scripts/ubicloud/pregate-remote.sh, scripts/test-free-shards.ts (`--files-from` only), .gstack/pregate.json, bin/gstack-next-version, their tests, docs/TESTING_INTERNALS.md, its own TODOS.md hunks.
- **PR B (W3):** test/helpers/docsync-fault-actor.ts, docsync-fault-eval.ts, docsync-observer.ts, bin/gstack-docs-candidate, test/helpers/qa-callers-fixture.ts, scripts/resolvers/review-army.ts, third-party-actions.ts, plan-reality.ts, the qa and qa-only exploratory templates, test/helpers/qa-functional-eval.ts, qa-functional-evidence.ts, test/qa-functional-evidence.test.ts, test/skill-e2e-design.test.ts, test/helpers/pty/*, test/autoplan-answer-invalidation.test.ts, test/review-army-budget.test.ts, detector corpora, regenerated SKILL.md and sections, its own TODOS.md hunks.
- Shared file: TODOS.md only, in separate hunks; whichever lands second merges main. PR A touches no skill template, so only PR B regenerates.
- scripts/test-free-shards.ts: confirm with GStack Minder that W4 (GSTA-33) is not editing it; otherwise PR A waits for W4's version.

### Out of scope

W4 (seed recorder), W5 (pregate lanes, lib/pregate/**), W6-W9, generator-input narrowing (deferred with its replay effect), a lockfile narrowing rule, and any change to EVAL_POLICY, case kinds, trials, thresholds or quarantine.

## Review record

