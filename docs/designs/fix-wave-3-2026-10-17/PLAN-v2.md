<!-- gstack-autoplan-scope: --no-ui --developer-tool -->
# Fix wave 3 (October 17, 2026): PR eval cost (W2) and paid-gate reliability round 2 (W3)

## Implementation plan

### Context

This is plan revision 2. Revision 1 was reviewed by six voices (CEO, DX, Eng; Claude Opus 5.5 native, GPT-6.1 Sol outside): 67 findings, 1 Critical, 8 user challenges. Gate rev 1 recommendations folded in here: d3b (split the W2 PR into A1, A2, A3), d4b (the exercised-path map ships in shadow mode), d5b/d8b (keep superseded/open semantics; the repair is a rerun requirement), d6b/d7b (a tested keyless pregate path before `remote_gate` is declared); d1a and d2a keep the direction. Every other finding is a build obligation, folded into the item it names.

Owner request: Garry approved GSTA-41's triage on 2026-10-17 with "Accept all recommendations", which includes "Autoplan W2 and W3 together now" (reports/triage-2026-10-17.md in the GStack Minder drive). Coordinator: GStack Minder (GSTA-36) owns the merge queue, version slots and every merge; this wave opens PRs and sends READY reports unstamped. Builder: GSTA-45.

Base: origin/main (v1.91.125.0 at revision time). Live owners this wave must not collide with: GSTA-46 (W5: lib/pregate/import-graph.ts, lib/pregate/checks/lanes.ts, lib/regen.ts, test/pregate-selection.test.ts, test/helpers/pregate-fixture.ts), GSTA-33 (W4, #3253: the duration-record workflow, windows-free-tests.yml, scripts/test-pr-profile.ts, docs; it does not touch scripts/test-free-shards.ts, per GStack Minder), GSTA-44 (#3220 brain-sync). A1 and A2 also edit scripts/test-pr-profile.ts, so whichever of #3253 and A1 lands second merges main. Out of scope: W4, W5, W6-W9.

Evidence base. Read-only investigations on 521fd42 (no paid spend):
- **W2:** 225 evals.yml pull_request runs with a paid-plan manifest over 10 days (2026-10-07 to 2026-10-17), every manifest, trial-outcomes artifact and verdict line, each run's changed files replayed through today's selector (`computePaidCaseSelection`), counterfactual replays of each fix, and a prototype exercised-path map built from 541 PR runs' recorded commands.
- **W3:** every red verdict in PR gate runs since #3231 (`bun run eval:pass-rates --reds --workflow evals.yml --runs 60`): 21 reds in 17 runs (38969924945 to 39011101113), plus two reds GStack Minder forwarded from #3252. Each rejected tool call was replayed through the real detector on main.

Thesis: **spend the PR gate's money only where a diff can change the outcome, and make a red verdict mean the diff broke something.**

### Release promises

- **P1. Paid selection never under-selects what it can see, and narrowing is earned with evidence.** The shebang blind spot closes now; the exercised-path map runs in shadow, so map drift is measured (MAP_GAP, census) before any narrowing is activated by a later decision. The cost metric tracks dollars and cases per run, not the fallback label.
- **P2. A gstack contributor on a small machine can finish pregate,** with or without a Ubicloud key: under 8 cores the local tier goes to a declared remote gate that runs on Ubicloud when a key exists and as parallel local shards when it does not, and prints a receipt bound to the tree it actually tested.
- **P3. Every open red cause found in the window is fixed at its cause or kept as a named negative control.** No threshold, trial count, case kind or quarantine changes.
- **P4. `/ship` slot allocation does not wait on serial GitHub calls,** and a fetch that times out says so.

### Premise table

| premise | claim | receipt | verdict |
|---|---|---|---|
| P-a | 42.5% of PR runs fall back to full selection | test:health 7d 68/160 at triage, 75/177 on 2026-10-17; 10-day replay 95/225 recorded, 91/225 under today's selector | true |
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

Verified by source: `selectPrProfile`, `FREE_ONLY_PR_FILES`, `PR_FULL_GATE_FILES`, `DERIVABLE_PREFIXES` (scripts/test-pr-profile.ts); `SELECTION_DATA_MODULES`, `refs` (:178), the global walk (:242), `targetsOf` (:250) (scripts/pr-dependencies.ts); `remote_gate`, the `PREGATE_REMOTE:` contract, `PREGATE_TREE`/`PREGATE_FILES_FILE`/`PREGATE_SPEND_CAP_USD`, exported `parseRemoteReport`/`remoteReportProblem` (lib/pregate/checks/lanes.ts:142-155, read-only here); `ubi-runner.sh run --src --setup --env --pull` and scripts/ubicloud/test-free.sh; `test-free-shards.ts` flags (no file-subset flag today; mode conflicts at :597-601); `gstack-docs-candidate` top-level `--help` only (:91) and `compare` schema check (:123). New surfaces are named as new.

### Binding decisions

- Every merge is GStack Minder's; READY reports go unstamped; never stamp before a slot call (CREW.md 6).
- No threshold, trial count, case kind or quarantine changes (EVAL_POLICY; AGENTS.md Validation discipline step 6). A detector change keeps or adds negative controls. Each PR body carries a gate-edit table (file, old vs new acceptance, negative control) and a `## Behavior changes` list.
- Do not edit files GSTA-46 (W5) owns; lib/pregate/** is read-only in this wave.
- Paid PR gates are pre-approved (Garry, 2026-10-15).
- Activating the exercised-path map (changing what a PR selects) is a later decision with its shadow data, not part of this wave.

### Numbers

- W2 replay: today 91/225 full-fallback (40.4%), mean 79.6 gate cases per run. Sound classification fixes alone: 36/225 full-fallback (16.0%) but no spend change, because those runs land in dependents mode, which still selects about 105 cases.
- Exercised-path map, replayed over the 225 runs: applied to every changed file it misses **0 of the 47 recorded gate reds** and cuts predicted spend **6.5%**; on the recorded basis ($6,811 trial-sum per 10 days, $101.66 per merged PR) that is about $440-600 per 10 days. Applied only to unmapped files it cuts 15% but **misses 5 reds** (rejected). Making free-fixtures-data.ts non-global without the map misses 3 #3231 reds, so that change waits for map activation.
- The floor: 46 files (32 bin, 11 lib, 3 other) reach 100-106 of 108 cases under any sound map, because every generated SKILL.md runs the preamble bins (gstack-skill-start alone closes over 73 files). Below that needs a cheaper contract for preamble-hub diffs (deferred ask D1).
- W3: of the 17 red runs, 4 are already green on main (38969924945, 38974669950, 38981523623, 38988927989; 6 reds fixed). W3 fixes the cause in 7 more (38973329985, 38986120559, 38990111230, 38993076767, 39002269281, 39004466422, 39011101113) and the detector misread in 38980005793. Still red after W3: 38976253774 (U, undetermined hang), 38980005793 (T, timeout tail), 38983306684 and 38984977679 (D3 model misses), 39006896632 (Q3 model miss), and 39001107574 (C) unless the W3-9 hardening changes behaviour: 4 + 7 + 6 = 17.

### Wave items

#### W2-A1: selection correctness and safe classification (PR A1; edits global touchfiles, so a full ~$93 gate)

**A1-1. Close the shebang blind spot.** In scripts/pr-dependencies.ts, strip a leading `#!` line before `scanImports` at all three sites (`refs` :178, the global walk :242, `targetsOf` :250) and treat bun/node-shebang extensionless files as code. Any other scan error keeps failing closed (selects everything) at all three sites. This broadens selection: 34 files flip from no-consumer to consumed; test/helpers/bootstrap-retention.ts joins the global set through scripts/test-paid-shards.ts. Free tests: `lib/fs-utils.ts` selects the cases of bin/gstack-redact-prepush; a shebang fixture's import is found; an injected non-shebang scan error still selects everything.

**A1-2. Safe classification fixes** (none narrows a case a diff can reach; they change labels and fallback reasons).
- FREE_ONLY_PR_FILES gains .github/dependabot.yml, .osv-scanner.toml, setup.ps1, .gitlab-ci.yml, .github/ISSUE_TEMPLATE/**, .gstack/ship-policy.example.json, each with its one-line reason (readers: osv-scanner.yml and free tests; windows-setup-e2e.yml; free gstack-doctor.test.ts:363). test/paid-free-boundary.test.ts:117 swaps its sample unknown file to one that stays unmapped.
- capy/ joins REPO_PATH and DERIVABLE_PREFIXES, so capy/support.env derives to bin/gstack-install-verdict.sh and bin/gstack-doctor-check.sh.
- A full-gate file is never also labelled "real unknown dependency" (fixes wrong fix text for evals.yml, test-setup.ts, .gitattributes).
- Not in A1: `setup` stays a full-gate file (its real executors include bin/gstack-upgrade:131, bin/gstack-capy-install:404-405 and bin/dev-setup:93, which today's matcher cannot see, and moving it saves no money); free-fixtures-data.ts stays global until map activation; generator inputs stay full (D2).

**A1-3. Measure what the money follows.** scripts/test-health-report.ts adds `pr-cases-per-run` (mean selected gate cases and judges per PR run) and `pr-known-cost-per-run` beside `pr-fallback-rate`, and the summary leads with cost per merged PR. The fallback text in docs/TESTING_INTERNALS.md#pr-paid-lane-fallback is corrected (it says bin/ and lib/ changes take the full gate because they are unmapped; they are derived).

**A1-4. Lockfile decision: keep package.json and bun.lock full.** No narrowing is built: no run fell back on them alone, dependabot never reaches the paid lane, and every runtime package's importer reaches all cases. Documented in docs/TESTING_INTERNALS.md#pr-paid-lane-fallback with the evidence.

#### W2-A2: exercised-path map in shadow mode (PR A2, stacked on A1; full gate)

**A2-1. The map.** A new generated, committed `test/helpers/exercised-commands.json` holds per gate case the union of commands observed in recorded trials, with `generatedAt`, `observedThrough`, the source run ids and per-case observation counts. It is registered as a SELECTION_DATA_MODULE with map-diff selection like touchfiles-data.ts (a refresh selects only cases whose set changed, failing closed on error), so a refresh never pays the full gate. Refreshes are union-only: an observation never removes an edge, and missing or empty artifacts never erase consumers; removal is a reviewed edit.

**A2-2. The consumer function** (scripts/pr-dependencies.ts, new `exercisedConsumers`), the union of: (1) direct touchfile matches; (2) the case's test file and helper import closure; (3) executable shell in the case's loaded skill (template and generated SKILL.md) and in bin/, lib/, scripts/: command-position `gstack-*` names and repo paths, `.`/`source` edges, `./setup` / `$ROOT/setup` exec edges, quoted path literals, path.join pairs, data-file paths, `bun run` scripts, compiled outfiles (`browse/dist/browse`, `design/dist/design`, `make-pdf/dist/pdf`, `$B`, `$D`, find-browse) mapped to their source trees, and shard perTest attribution; comments, echo/printf/die messages, case patterns, bare `VAR=gstack-x` strings and slash-command skill names are not edges, but command substitutions and executable or expanding heredocs are kept, and unparsed shell keeps its conservative edges; (4) observed bins from A2-1. The edge classes are ported from the measured prototype (exercised.ts), and a parity test pins that the shipped function equals or is a reviewed superset of the prototype's map at a pinned commit. PR_FULL_GATE_FILES and GLOBAL_TOUCHFILES stay full, and the closure stops at them.

**A2-3. Shadow, not selection.** `selectPrProfile` keeps today's selection. The paid-plan manifest gains a `shadow` block: the cases the map would select, the cases it would drop, the per-file provenance ("selects N cases: touchfile (…), import (…), skill bash via bin/gstack-x (…), observed (…)") and the predicted cost difference; the plan's coverage summary prints one line of it. test:health reports the shadow saving and shadow misses (a red on a case the shadow would have dropped) per week.

**A2-4. Gap detection.** The paid report job runs the same bin matcher over each executed case's commands and emits `MAP_GAP <case> <bin>` against static-plus-observed consumers (never the observed set alone) as its own non-blocking job result, separate from case verdicts and from the INFRA/INCOMPLETE re-dispatch rule, with the doc anchor docs/TESTING_INTERNALS.md#exercised-path-map. The weekly gate census emits the union-refreshed map as an artifact (built from its own artifacts, no REST downloads: the prototype hit the installation's 403 artifact limit) and prints the refresh command (`bun run test:exercised-map --from-run <id>`), which opens the refresh as an ordinary PR. In shadow mode the census reports gaps and the six PTY cases that record no commands; it does not block. PTY command capture is a named prerequisite for activation, not part of this wave.

Free tests: a synthetic fixture tree with one case per edge class (including the stripped-message negatives and the kept command substitution), the five variant-c miss shapes as negative controls, union-only refresh (disjoint branches, empty artifacts), map-diff selection of a refresh, and shadow output that never changes `e2e`/`judges`. The 47-red 0-miss replay is a pinned PR-body receipt reproducible by script at the PR commit, not a free test (historical file lists rot on renames).

#### W2-A3: small-machine pregate and next-version (PR A3; disjoint from A1/A2)

**A3-1. `scripts/ubicloud/pregate-remote.sh` (new) and `--files-from` (scripts/test-free-shards.ts).**
- Inputs: `PREGATE_FILES_FILE`, `PREGATE_TREE`, `PREGATE_SPEND_CAP_USD` from `gstack-pregate --stage tests --remote`. Run bare (as pregate's `run:` line shows), it exits 2 before any work with "PREGATE_FILES_FILE is not set; run: gstack-pregate --stage tests --remote --spend-cap <usd> --allow-repo-commands".
- Before any upload it recomputes the tree with bin/gstack-wtree; on mismatch it prints both tree prefixes, "nothing uploaded, nothing spent" and the rerun command, and exits 3.
- **Keyed path (UBICLOUD_API_KEY set):** refuses before VM create when the worst case (wall timeout × the price of the size actually used, honouring UBI_SIZE) exceeds the cap, printing estimate and cap; wraps scripts/ubicloud/test-free.sh (setup-free-suite.sh, xvfb-run, GSTACK_EXPECT_BINARIES=1, the free retry policy) with `--files-from` and a wall timeout derived from the cap; recomputes gstack-wtree on the VM after unpack and refuses on mismatch; verifies the planned set equals the file list (digest) before running; prints `PREGATE_REMOTE: tree=<VM tree> tests=<n> failed=<n> spent=<usd>` from minutes used. Infra failures (create, setup, SSH drop) exit 4 with the ubi-runner message, the VM name and its `down` line or teardown confirmation, the log path and spent= for minutes billed; one retry after a quota message, then stop. Phase timings (create, setup, run) are logged; the target is 10 minutes from `--remote` to a cleared obligation.
- **Keyless path:** runs the same files locally through `test-free-shards.ts --files-from` in parallel shards, prints "no UBICLOUD_API_KEY: running N files locally in parallel shards", and the same honest `PREGATE_REMOTE:` line for the tree tested (recomputed before and after; a moved tree fails), with `spent=0`.
- `--files-from <path>`: one repo-relative path per line, blank lines ignored; rejects before planning unknown paths (first 5 plus a count, "not in the free planned set", fix: use paths from `--list`), an empty list and malformed lines; conflicts with `--quick`, `--windows-only`, `--list` and the `--ci-*` modes like the parser's existing conflicts.
- .gstack/pregate.json declares `"remote_gate": "bash scripts/ubicloud/pregate-remote.sh"` in the same PR (effective once on main). docs/pregate.md#remote-gate gets a gstack example and CONTRIBUTING.md "Which command do I run?" a small-machine pregate row with keyed and keyless commands. The READY report carries a one-paragraph crew rule for GStack Minder's CREW.md.
- Free tests: the output contract against a stub ubi-runner through the exported `parseRemoteReport`/`remoteReportProblem`; bare run, tree mismatch before and after, zero tests, failures, cap refusal with no VM created, create/setup failure; `--files-from` exact planning and every rejection message; the keyless path on a two-file list. One real Ubicloud run of the 798-file selection is recorded in the PR body.

**A3-2. Concurrent next-version fetches.** bin/gstack-next-version's workers use async `spawn` bounded at GH_API_CONCURRENCY, each with its 15 s timeout. Results and warnings are sorted by PR number. A timeout keeps its cause: "PR #N: VERSION fetch timed out after 15 s; claim unknown, the slot may collide; rerun, then ask the coordinator", and the JSON gains `unknown_claims`; the fork/path hint stays for not-found failures only. Free tests with a delayed fake `gh` on PATH: 8 PRs at 0.5 s finish in under 2 s with the same claims as before; a randomized-delay run is deterministic; a timed-out fetch prints the timeout text and counts in `unknown_claims`.

#### W3: paid-gate reliability, round 2 (PR B; prompt and fixture edits select many cases; ~$93 gate plus focused cases)

Each item names the cause class: (1) fixture/detector defect, (2) skill or prompt defect, (4) genuine model miss.

**W3-1. Docsync fault actor uses the production candidate protocol (1; 38990111230; 79 of 198 docsync captures).** test/helpers/docsync-fault-actor.ts `prepare` (:81-110) writes `docsCandidate()` records that the installed `gstack-docs-candidate compare` rejects (bin/gstack-docs-candidate:123), while ship/sections/documentation.md:70 requires running compare. Migrate prepare, dispatch observations, inspect, seeded prompt comparisons and legacy checks together to the production schema and hash representation: prepare runs the installed `snapshot` under a bounded timeout and prints its exact argv so the post-child rerun is literal, publishes state only after a valid candidate exists, and never overwrites a saved attempt. Free tests: the full adapter sequence (prepare, installed compare, inspect) for unchanged inputs, a doc edit, an index change and a deletion; a snapshot failure before and after candidate creation.

**W3-2. gstack-docs-candidate help and errors (1).** `snapshot --help` and `compare --help` print usage and exit 0 before any side effect; test/helpers/docsync-observer.ts:272-274 admits `<candidate> (snapshot|compare) --help` with nothing else. The compare reject names the path, the missing or wrong fields (schema_version, base, hashes) and the fix (`gstack-docs-candidate snapshot --out <path> --audit-id <id> --mode edit --base <rev>`), keeping exit 1. Free regression: the captured 38990111230 ndjson (redacted) replays to `[]`; `snapshot --help --out x.json`, `compare --help x.json` and an in-repo `--out` stay rejected; corpus rows pinning the old reject text are updated.

**W3-3. Docsync model misses become negative controls (4; 38983306684, 38984977679).** The captured Bash `grep -n -i …` and `cat …; cat …` join the docsync detector corpus as `refuse` rows. No detector change.

**W3-4. qa-callers prompt stops teaching helper syntax (2; 38973329985, 38993076767).** test/helpers/qa-callers-fixture.ts:700 hands over full capture/checkpoint syntax but only "Materialize is supported…"; both reds skipped qa/sections/exploratory.md and system-functional.md then ran a bare `materialize`, while all 83 passing sessions read both. The prompt declares only fixture bindings (evidence tool path, reports dir, deadline file, `--public` approved, `--timeout-ms 10000` for plan probes) and points to the section for the forms. The read requirement stays. Free tests: the two captured transcripts still fail `validateCallerEvidence`; the prompt contains no `gstack-qa-evidence capture` grammar.

**W3-5. State-machine scope in the generated scope block (2; 39002269281).** scripts/resolvers/review-army.ts:75 names `gstack-state-matrix detect --base <base>` in prose and small diffs keep only State Machines (:66), so agents run an undeclared command. The block (:27) gains `source <(… gstack-state-matrix detect --base <base> 2>/dev/null)` with its exit status checked: on failure it prints `SCOPE_STATE_MACHINE=unknown` and the State Machines specialist is included conservatively, with the detector's stderr kept. :75 reads "if SCOPE_STATE_MACHINE is true or unknown (printed by the scope block)", and its "pipe output to `check -`" step becomes a declared block form. Regenerate. test/review-workflow-clarity.test.ts pins both; a free test runs the block with a failing detector stub and sees `unknown`; the captured standalone call stays outside the caller interface.

**W3-6. Webhook fix runs re-verify the repaired invariant within the budget (2; 38986120559).** Stage 2 of the fix-run prompt (test/helpers/qa-functional-eval.ts:33) asks only for original, happy, cancel and dependency, while the verifier (qa-functional-evidence.ts:224) re-runs all 8 scenarios. The prompt states the budget split up front: at most 5 pre-repair captures, then after the final source edit every scenario of the repaired invariant (duplicate, partial, concurrent-ab, concurrent-ba) plus happy, cancel and dependency, 12 in total; if the allowance cannot establish the defect, report incomplete. `QA_WEBHOOK_REQUIRED_SCENARIOS` is unchanged (no verdict tightening); the post-repair list feeds the probe nudge instead. Free tests: the captured status-only repair applied to a fresh fixture fails `verifyQANativeRegression` on partial; an effect-based repair passes; a pre-repair-only scenario set plus a complete post-repair set exercise the nudge.

**W3-7. Lettered consent options when Aside is absent (2; 39011101113).** scripts/resolvers/third-party-actions.ts:54 fixes letters only for the detected case, and the agent numbered 1/2/3. The absent branch offers "B) gstack's own visible browser, C) manual instructions, D) defer (omit A)". Regenerate. Free test: the contract letters the absent branch; the captured numbered answer is a documented fail example. The test's assertion is unchanged.

**W3-8. Tier-1 reality rows are never n/a (2; 39004466422).** The agent wrote `REALITY: deferred-asks n/a …`, `gstack-plan-reality check` returned verdict=repair, and the repair loop ran past the 300 s capture. scripts/resolvers/plan-reality.ts:59 says tier-1 rows are never n/a and, with no linked issue, deferred-asks is `pass` with a receipt showing none. Regenerate. Free test: the captured line through `check` (pinned message) and a skill-text assertion.

**W3-9. Exploratory stop rule ties to the per-rule probes (2 hardening of a 4; 38983306684, 39001107574).** Neither cli-report red probed a non-digit amount; 32 of the other 34 CLI sessions did, and qa/sections/system-functional.md:33 already requires one probe per input rule. The shared owner, scripts/resolvers/qa.ts, states one rule for both exploratory templates: before stopping, each documented input rule has its own capture breaking only that rule; at the 12-probe cap, uncovered rules go into limits. Regenerate both host outputs. Text assertion that the final rule is single and coherent; behaviour is proven by the paid cases.

**W3-10. Shim-dom detector resolves literal assignments (1; 38980005793).** test/skill-e2e-design.test.ts:1248 looks for the literal `dom/run1`, but the agent ran the generated block's `"$_REPORT/dom/$_RUN"` with `_RUN="run1"` assigned in the same command. The check resolves that command's own literal `_RUN=`/`_REPORT=` assignments before matching. Free regression: the captured command passes; `scan --changed` and a scan over another directory still fail.

**W3-11. PTY harness keeps the last non-empty screen (diagnostic; 38976253774).** autoplan-guard-pty stalled at 489 s (normal 71-93 s) with empty journal and screen dumps. test/helpers/pty/ keeps the last non-empty `visibleText()` for the failure dump. No verdict change.

**W3-12. Explicit timeout for test/autoplan-answer-invalidation.test.ts.** Each test gets an explicit 30 s timeout (measured 4.1 s for the eng-only test on 4 cores; 7.8-9.4 s per file).

**W3-13. Close the stale createQAFunctionalFixture TODO** (already fixed by 0bf9d50) in TODOS.md, with the citation.

**W3-14. Superseded captures are rerun before completion (2; 39053431488 on #3252).** qa-functional-webhook-fix failed "missing exact sanitized evidence" because the agent labelled a pre-repair duplicate capture `superseded` and never reran it; the product (qa/sections/exploratory.md:88, lib/qa-evidence.ts:346-348) keeps such a row open, the detector (qa-functional-evidence.ts:160-166) requires a rerun, and the fixture prompt's schema never mentions superseded. The production semantics stay: the fixture prompt adds "after your final repair, rerun every pre-repair capture your verdict relies on; a superseded row stays open until its command reran on the repaired source", and scripts/resolvers/qa.ts adds the same completion step for fix runs (rerun superseded captures, or report them as an open remainder), including snapshotless clients. The detector and its negative test (test/qa-functional-evidence.test.ts:376-380) are unchanged. Free tests: the captured pre-repair duplicate labelled superseded and not rerun fails (negative control); the prompt states the rule.

**W3-15. Windows budget for test/review-army-budget.test.ts (free; windows-free-tests run 39053431430, shard 5).** The nested `bun test` finished in 5.58 s and exited 1 because Bun's default 5 s hook timeout fired on the real Red Team `beforeAll` (8 git spawns plus skill-section copies, test/skill-e2e-review-army.test.ts:643-667), slow on windows-latest (Windows seed 4,143 ms for the file vs 1,879 ms on Linux). The nested argv at :57 and :137 gains `--timeout 30000`; spawn timeouts move to 40 s and outer test timeouts to 45 s, including the consensus test that has none. Free check: the nested script with an injected 6 s `beforeAll` still prints the expected lifecycle; the Windows proof is the PR's windows-free-tests run.

Not repaired, kept visible: Q3 webhook-report (4; the two denied `cat` calls become negative controls in the qa-functional observer tests) and T qa-quick (one 300 s timeout against passing runs of 164-272 s; trimming what Quick tier loads is a product call, filed in TODOS).

### Deferred asks

- **D1. Preamble-hub diffs.** 46 hub files reach the whole gate under any sound map. A cheaper contract (a free contract suite for the preamble bins plus a 2-3 case paid canary for hub-only diffs) trades PR-time coverage for cost; Garry's call after A1-3's metrics and A2's shadow data. Recommendation: later.
- **D2. Generator-input narrowing** (resolvers/index.ts, preamble/**, gen-skill-docs.ts through committed outputs; 29 runs leave full-fallback on replay, mostly into dependents-all). Waits until every host output a paid case loads is shown committed and freshness-gated.
- **D3. Map activation** (A2 selects instead of shadowing; free-fixtures-data.ts leaves the global set with it). Needs PTY command capture for the six blind cases, two weeks of shadow data with zero shadow misses, and Garry's call on the measured saving.
- **D4. Run-count levers** (225 paid runs for 68 PRs; #3226 ran 13 full gates): readiness-gated or reuse-across-push dispatch, analysed read-only next wave.
- **D5. Red attribution in the paid report** (does the diff reach a red case directly, or only through a hub or the fallback). Report-only; next wave.
- **D6. Nested child output pollutes free-runner failure attribution** (scripts/lib/shard-engine.ts); filed in TODOS.

### Validation

Per AGENTS.md Validation discipline: one current failure list in `.context/fix-wave-3.md`; focused free tests per item during repair; then the cheap checks (typecheck, `bun test test/parity-suite.test.ts`, the SKILL.md size guard per CREW.md 11, skill-docs freshness, `test/spawnsync-timeout-tripwire.test.ts`, credential scanning); then the selected quality judges for changed prompts, reusing unchanged passing judge evidence by prompt-input identity; then PR B's focused paid cases once each at their EVAL_POLICY kind (ship-docsync-stale-after, ship-docsync-missing-asset, ship-exploratory-small-cli, ship-exploratory-plan-checks, qa-functional-webhook-fix, tpa-absent-linux, plan-mode-no-op, qa-functional-cli-report, design-review-detector-shim-dom); then each PR's gate; then `bun run test` once per PR on the frozen tree via Ubicloud. Paid evals never retry; a red is diagnosed from its transcript against the diff. Executed, reused and remaining required cases are reconciled before READY.

### Delivery shape

Four PRs, opened with Capy's PR tool, READY unstamped to GStack Minder:
- **A1:** scripts/pr-dependencies.ts (shebang), scripts/test-pr-profile.ts (classification), scripts/test-health-report.ts, docs/TESTING_INTERNALS.md, their tests.
- **A2 (stacked on A1):** scripts/pr-dependencies.ts (`exercisedConsumers`), scripts/test-pr-profile.ts (shadow block), test/helpers/exercised-commands.json, its refresh script and package script, scripts/lib/paid-report.ts (MAP_GAP), the census job in .github/workflows/evals-periodic.yml, test:health shadow lines, docs/TESTING_INTERNALS.md#exercised-path-map, their tests.
- **A3:** scripts/ubicloud/pregate-remote.sh, scripts/test-free-shards.ts (`--files-from` only), .gstack/pregate.json, bin/gstack-next-version, docs/pregate.md (example only), CONTRIBUTING.md (one row), their tests.
- **B (W3):** test/helpers/docsync-fault-actor.ts, docsync-fault-eval.ts, docsync-fixture.ts, docsync-observer.ts, bin/gstack-docs-candidate, test/helpers/qa-callers-fixture.ts, scripts/resolvers/review-army.ts, third-party-actions.ts, plan-reality.ts, qa.ts, test/helpers/qa-functional-eval.ts, test/qa-functional-evidence.test.ts, test/skill-e2e-design.test.ts, test/helpers/pty/*, test/autoplan-answer-invalidation.test.ts, test/review-army-budget.test.ts, detector corpora, regenerated SKILL.md and sections.
- Shared: TODOS.md (separate hunks) and docs/TESTING_INTERNALS.md (A1 and A2, stacked). Whichever lands second merges main. Only B regenerates skills.
- A3 changes every sub-8-core lane's pregate once merged; its READY report carries the crew rule and its PR body lists it under Behavior changes.

### Out of scope

W4 (seed recorder), W5 (pregate lanes, lib/pregate/**), W6-W9, map activation (D3), generator-input narrowing (D2), a lockfile narrowing rule, and any change to EVAL_POLICY, case kinds, trials, thresholds or quarantine.

## Review record

Revision 1, autoplan run run1-20261017181219 (CEO, DX, Eng; Claude Opus 5.5 native, GPT-6.1 Sol outside): CEO 13 + 3 findings, DX 16 + 9 (1 Critical: the scope detector's output used without its exit status, now W3-5), Eng 15 + 11. Gate rev 1 recommendations d3b, d4b, d5b, d6b, d7b, d8b changed this revision; d1a and d2a kept the direction. All other findings are build obligations folded into the items above.
