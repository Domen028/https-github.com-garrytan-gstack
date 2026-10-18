#!/usr/bin/env bun
/**
 * gate-cost-replay — what the paid PR gate costs and what each selection
 * policy would have cost on recent merges (GSTA-49 plan lane T0). Free and
 * read-only: it downloads recorded report artifacts with `gh` into a cache,
 * replays origin/main's first-parent squash merges through the selectors in
 * this checkout, and models merge trains. Logic lives in lib/gate-cost.ts.
 *
 * Usage:
 *   bun run scripts/gate-cost-replay.ts --runs <id,id,...> [--since YYYY-MM-DD --until YYYY-MM-DD | --prs 3201,3202]
 *     [--ref origin/main] [--repo owner/name] [--cache .context/gate-cost-cache] [--window-days N]
 *     [--usd-per-second R]
 *     [--train-size 5] [--reps 400] [--seed 1] [--cases] [--json]
 *
 * --runs names complete full-gate runs (108 rule cases + 24 judges). Bare
 * dates are UTC days; --until is inclusive. Cases without a recorded cost are
 * estimated from their duration (default rate: recorded $ over recorded
 * session-seconds; --usd-per-second pins it). Screening figures are labelled
 * screen-provisional: the preamble detector is a heuristic until T2 lands.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  SCREEN_LABEL, TODAY_WEEKLY_USD, AFTER_GSTA48_WEEKLY_USD, caseCostTable, changedLinesByFile, fullGateUsd, isSkillMd,
  parseEvalReport, parseTrialOutcomes, prSelectionCost, simulateTrains, summarizeGates, summarizeSelector,
  type CaseCostEntry, type GateRecord, type GateSummary, type PrDiff, type PrSelectionCost, type ScreenPolicy,
  type SelectionDeps, type SelectorSummary, type TrainModelResult,
} from '../lib/gate-cost';
import { GH_HISTORY, downloadRunArtifacts, repoSlug } from './lib/ci-history';
import { computePaidCaseSelection } from './lib/paid-select';
import { packageChangeOnlyVersion } from './test-pr-profile';
import { E2E_TIERS, GLOBAL_TOUCHFILES, LLM_JUDGE_TOUCHFILES, matchGlob } from '../test/helpers/touchfiles';

const ROOT = path.resolve(import.meta.dir, '..');
const DAY_MS = 86_400_000;
const ARTIFACT = /^(paid-slice-\d+|trial-outcomes[A-Za-z0-9_-]*?)-a(\d+)$/;
export const MODEL_POLICIES: ScreenPolicy[] = [
  { kind: 'all' }, { kind: 'random', fraction: 0.8 }, { kind: 'random', fraction: 0.5 },
  { kind: 'cheapest-half' }, { kind: 'expensive-half' }, { kind: 'none' },
];
export const MODEL_OUTSIDE_RED = [0.10, 0.15];

export interface ReplayArgs {
  runs: string[];
  since?: string;
  until?: string;
  prs: number[];
  ref: string;
  repo: string;
  cache: string;
  windowDays?: number;
  usdPerSecond?: number;
  trainSize: number;
  reps: number;
  seed: number;
  cases: boolean;
  json: boolean;
}

export function parseArgs(argv: string[]): ReplayArgs {
  const args: ReplayArgs = { runs: [], prs: [], ref: 'origin/main', repo: '', cache: path.join(ROOT, '.context', 'gate-cost-cache'),
    trainSize: 5, reps: 400, seed: 1, cases: false, json: false };
  const list = (value: string) => value.split(/[\s,]+/).filter(Boolean);
  const positive = (flag: string, value: string) => {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`${flag} needs a positive number, got ${value}`);
    return n;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]!;
    if (flag === '--json') { args.json = true; continue; }
    if (flag === '--cases') { args.cases = true; continue; }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${flag} needs a value`);
    i += 1;
    if (flag === '--runs') args.runs.push(...list(value));
    else if (flag === '--prs') args.prs.push(...list(value).map(pr => Number(pr.replace(/^#/, ''))));
    else if (flag === '--since') args.since = value;
    else if (flag === '--until') args.until = value;
    else if (flag === '--ref') args.ref = value;
    else if (flag === '--repo') args.repo = value;
    else if (flag === '--cache') args.cache = path.resolve(value);
    else if (flag === '--window-days') args.windowDays = positive(flag, value);
    else if (flag === '--usd-per-second') args.usdPerSecond = positive(flag, value);
    else if (flag === '--train-size') args.trainSize = Math.round(positive(flag, value));
    else if (flag === '--reps') args.reps = Math.round(positive(flag, value));
    else if (flag === '--seed') args.seed = Math.round(Number(value));
    else throw new Error(`unknown flag ${flag}`);
  }
  if (args.runs.length === 0) throw new Error('--runs <id,...> is required: the full-gate runs whose recorded costs price every case');
  if (args.runs.some(run => !/^\d+$/.test(run))) throw new Error('--runs takes numeric GitHub Actions run ids');
  if (args.prs.some(pr => !Number.isInteger(pr) || pr <= 0)) throw new Error('--prs takes PR numbers');
  if (args.prs.length && (args.since || args.until)) throw new Error('use either --prs or --since/--until, not both');
  if (!!args.since !== !!args.until) throw new Error('--since and --until go together');
  return args;
}

/** A bare date is a UTC day; `end` makes it inclusive (the next midnight). */
export function parseWindowDate(value: string, end: boolean): Date {
  const bare = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const date = new Date(bare ? `${value}T00:00:00Z` : value);
  if (Number.isNaN(date.getTime())) throw new Error(`not a date: ${value}`);
  return bare && end ? new Date(date.getTime() + DAY_MS) : date;
}

function git(args: string[], timeout = 60_000): string {
  const result = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', timeout, maxBuffer: 256 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`git ${args.slice(0, 3).join(' ')} failed: ${String(result.stderr || result.error || '').trim()}`);
  return result.stdout;
}

// --- Artifacts ---

/** Download a run's paid-slice and trial-outcomes artifacts once; a run with a .complete marker never calls gh again. */
export function fetchRun(runId: string, cacheDir: string, repo: string): string {
  const dir = path.join(cacheDir, runId);
  if (fs.existsSync(path.join(dir, '.complete'))) return dir;
  downloadRunArtifacts({ repo, run: { id: Number(runId) }, cacheDir, match: name => ARTIFACT.test(name), maxBytes: 512 * 1024 * 1024, fetcher: GH_HISTORY });
  fs.writeFileSync(path.join(dir, '.complete'), '');
  return dir;
}

/** One run directory -> GateRecord, reading only each artifact's highest attempt. */
export function readGateRecord(runDir: string, runId = path.basename(runDir)): GateRecord {
  const latest = new Map<string, { name: string; attempt: number }>();
  for (const name of fs.existsSync(runDir) ? fs.readdirSync(runDir) : []) {
    const match = name.match(ARTIFACT);
    if (!match || (latest.get(match[1]!)?.attempt ?? 0) >= Number(match[2])) continue;
    latest.set(match[1]!, { name, attempt: Number(match[2]) });
  }
  const gate: GateRecord = { runId, tests: [], trials: [] };
  for (const { name } of [...latest.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    const artifact = path.join(runDir, name);
    if (name.startsWith('trial-outcomes')) {
      const file = path.join(artifact, 'trial-outcomes.jsonl');
      if (fs.existsSync(file)) gate.trials.push(...parseTrialOutcomes(fs.readFileSync(file, 'utf8')));
      continue;
    }
    const shards = path.join(artifact, 'shards');
    for (const shard of fs.existsSync(shards) ? fs.readdirSync(shards).sort() : []) {
      const shardDir = path.join(shards, shard);
      if (!fs.statSync(shardDir).isDirectory()) continue;
      for (const file of fs.readdirSync(shardDir).sort()) {
        if (!file.endsWith('.json') || file.startsWith('_partial') || file.startsWith('slice-')) continue;
        let report: unknown;
        try { report = JSON.parse(fs.readFileSync(path.join(shardDir, file), 'utf8')); } catch { continue; }
        gate.tests.push(...parseEvalReport(shard, report));
      }
    }
  }
  return gate;
}

// --- Merged PRs ---

export interface MergedPr { pr: number; sha: string; committedAt: string }

/** First-parent squash merges whose subject ends in (#NNN). */
export function parseMergeLog(log: string): MergedPr[] {
  return log.split('\n').filter(Boolean).flatMap(line => {
    const [sha, committedAt, ...subject] = line.split('\t');
    const match = subject.join('\t').match(/\(#(\d+)\)\s*$/);
    return match && sha && committedAt ? [{ pr: Number(match[1]), sha, committedAt }] : [];
  });
}

function mergedPrs(args: ReplayArgs): { prs: MergedPr[]; windowDays: number | null; since?: Date; until?: Date } {
  const format = '--format=%H%x09%cI%x09%s';
  const shallowHint = (since: string) => git(['rev-parse', '--is-shallow-repository']).trim() === 'true'
    ? `; this checkout is shallow: run "git fetch --shallow-since=${since} origin main" and rerun` : '';
  if (args.since && args.until) {
    const since = parseWindowDate(args.since, false), until = parseWindowDate(args.until, true);
    const oldest = git(['log', '--first-parent', '--format=%cI', args.ref]).trim().split('\n').pop() ?? '';
    const hint = shallowHint(since.toISOString().slice(0, 10));
    if (hint && new Date(oldest) > since) throw new Error(`history before ${oldest} is missing${hint}`);
    const prs = parseMergeLog(git(['log', '--first-parent', `--since=${since.toISOString()}`, `--until=${until.toISOString()}`, format, args.ref])).reverse();
    return { prs, windowDays: args.windowDays ?? (until.getTime() - since.getTime()) / DAY_MS, since, until };
  }
  if (args.prs.length === 0) return { prs: [], windowDays: null };
  const all = new Map(parseMergeLog(git(['log', '--first-parent', format, args.ref])).map(pr => [pr.pr, pr]));
  const missing = args.prs.filter(pr => !all.has(pr));
  if (missing.length) throw new Error(`no squash merge of #${missing.join(', #')} on ${args.ref}'s first-parent history${shallowHint('2026-01-01')}`);
  return { prs: args.prs.map(pr => all.get(pr)!), windowDays: args.windowDays ?? null };
}

function prDiff(merge: MergedPr): PrDiff {
  const files = git(['diff', '--name-only', '--no-renames', `${merge.sha}^`, merge.sha]).split('\n').filter(Boolean);
  let packageVersionOnly = false;
  if (files.includes('package.json')) {
    const show = (rev: string) => spawnSync('git', ['show', `${rev}:package.json`], { cwd: ROOT, encoding: 'utf8', timeout: 30_000 });
    const before = show(`${merge.sha}^`), after = show(merge.sha);
    packageVersionOnly = before.status === 0 && after.status === 0 && packageChangeOnlyVersion(before.stdout, after.stdout);
  }
  const skillMds = files.filter(isSkillMd);
  const skillMdChangedLines = skillMds.length >= 10
    ? changedLinesByFile(git(['diff', '-U0', '--no-renames', `${merge.sha}^`, merge.sha, '--', ...skillMds], 120_000)) : {};
  return { pr: merge.pr, sha: merge.sha.slice(0, 8), files, packageVersionOnly, skillMdChangedLines };
}

/** The selectors in this checkout: today's PR profile (with R4's shadow) and the plain touchfile selection. */
export function checkoutSelectionDeps(rootDir = ROOT): SelectionDeps {
  const gateCases = Object.keys(E2E_TIERS).filter(id => E2E_TIERS[id] === 'gate');
  const judgeCases = Object.keys(LLM_JUDGE_TOUCHFILES);
  return {
    gateCases, judgeCases,
    today(files, packageVersionOnly) {
      try {
        const result = computePaidCaseSelection({ profile: 'pr', env: {}, rootDir, changedFiles: files, packageVersionOnly });
        return { e2e: result.selection.e2e ?? gateCases, judges: result.selection.judges ?? judgeCases,
          shadowE2e: result.coverage?.shadow?.e2e ?? null, mode: result.coverage?.mode ?? 'pr' };
      } catch {
        return { e2e: gateCases, judges: judgeCases, shadowE2e: null, mode: 'needs-full' };
      }
    },
    touchfiles(files) {
      const result = computePaidCaseSelection({ profile: 'full', env: {}, rootDir, changedFiles: files });
      return { e2e: result.selection.e2e ?? gateCases, global: files.some(file => GLOBAL_TOUCHFILES.some(pattern => matchGlob(file, pattern))) };
    },
  };
}

// --- Report ---

export interface ReplayReport {
  repo: string;
  ref: string;
  head: string;
  runs: Array<{ runId: string; tests: number; trials: number; recordedUsd: number }>;
  gate: GateSummary;
  fullScaleUsd: number;
  usdPerSecond: number;
  cases: CaseCostEntry[];
  window: { since: string; until: string } | null;
  windowDays: number | null;
  prs: PrSelectionCost[];
  selection: { today: SelectorSummary; shadow: SelectorSummary; screenProvisional: SelectorSummary } | null;
  model: { screenScale: number; fullGateUsd: number; trainSize: number; reps: number; seed: number; rows: TrainModelResult[] } | null;
}

export function buildReport(args: ReplayArgs, gates: GateRecord[], merges: ReturnType<typeof mergedPrs>, deps: SelectionDeps,
  diffs: (merge: MergedPr) => PrDiff = prDiff): Omit<ReplayReport, 'repo' | 'ref' | 'head'> {
  const table = caseCostTable(gates, { usdPerSecond: args.usdPerSecond });
  const gate = summarizeGates(gates);
  const fullScaleUsd = fullGateUsd(deps, table);
  const prs = merges.prs.map(merge => prSelectionCost(diffs(merge), deps, table));
  const selection = prs.length ? {
    today: summarizeSelector(prs.map(row => row.today), fullScaleUsd),
    shadow: summarizeSelector(prs.map(row => row.shadow), fullScaleUsd),
    screenProvisional: summarizeSelector(prs.map(row => row.screenProvisional), fullScaleUsd),
  } : null;
  const screenScale = fullScaleUsd ? gate.recordedUsd.mean / fullScaleUsd : 0;
  const model = prs.length && merges.windowDays ? {
    screenScale, fullGateUsd: gate.recordedUsd.mean, trainSize: args.trainSize, reps: args.reps, seed: args.seed,
    rows: MODEL_POLICIES.flatMap(policy => MODEL_OUTSIDE_RED.map(outsideRed => simulateTrains({
      prs: prs.map(row => ({ paidRelevant: row.today.usd > 0, screenUsd: row.screenProvisional.usd * screenScale })),
      policy, outsideRed, windowDays: merges.windowDays!, trainSize: args.trainSize, fullGateUsd: gate.recordedUsd.mean, reps: args.reps, seed: args.seed,
    }))),
  } : null;
  return {
    runs: gates.map(g => ({ runId: g.runId, tests: g.tests.length, trials: g.trials.length, recordedUsd: g.tests.reduce((sum, t) => sum + t.costUsd, 0) })),
    gate, fullScaleUsd, usdPerSecond: table.usdPerSecond, cases: Object.values(table.cases).sort((a, b) => b.costUsd - a.costUsd),
    window: merges.since && merges.until ? { since: merges.since.toISOString(), until: merges.until.toISOString() } : null,
    windowDays: merges.windowDays, prs, selection, model,
  };
}

const usd = (value: number) => value.toFixed(2);
const pct = (value: number, total: number) => (total ? `${(100 * value / total).toFixed(1)}%` : '-');
const mtok = (tokens: number) => (tokens >= 1e6 ? `${(tokens / 1e6).toFixed(2)}M` : `${Math.round(tokens / 1e3)}k`);
const pad = (cells: Array<string | number>, widths: number[]) => cells.map((cell, i) => String(cell).padEnd(widths[i] ?? 0)).join('  ').trimEnd();

export function formatReport(report: ReplayReport, options: { cases?: boolean } = {}): string {
  const out: string[] = [];
  const { gate } = report;
  const gateUsd = gate.recordedUsd.mean;
  out.push(`gate-cost replay: ${report.repo} at ${report.head.slice(0, 8)} (selectors from this checkout)`, '');
  out.push(`Gates: ${report.runs.length} run(s), recorded $ per gate mean ${usd(gateUsd)} (min ${usd(gate.recordedUsd.min)}, max ${usd(gate.recordedUsd.max)})`);
  for (const run of report.runs) out.push(`  run ${run.runId}: ${run.trials} trials, ${run.tests} cost entries, $${usd(run.recordedUsd)}`);
  out.push('', 'Recorded $ per gate by model:');
  for (const [model, value] of Object.entries(gate.byModel).sort((a, b) => b[1] - a[1])) out.push(`  ${pad([model, usd(value), pct(value, gateUsd)], [34, 8])}`);
  out.push('', 'Token classes per gate (lib/pricing.ts prices; cache writes at 1.25x input; share of the recorded gate):');
  const classes = Object.values(gate.tokenClasses);
  const sum = (pick: (c: (typeof classes)[number]) => number) => classes.reduce((total, c) => total + pick(c), 0);
  const thinking = sum(c => c.output.thinkingTokens);
  for (const [label, key] of [['cache write', 'cacheWrite'], [`output (incl. ${mtok(thinking)} thinking)`, 'output'], ['cache read', 'cacheRead'], ['uncached input', 'uncachedInput']] as const) {
    const value = sum(c => c[key].usd);
    out.push(`  ${pad([label, mtok(sum(c => c[key].tokens)), usd(value), pct(value, gateUsd)], [34, 8, 8])}`);
  }
  for (const [model, c] of Object.entries(gate.tokenClasses)) {
    out.push(`  ${model}: ${c.priced ? `priced $${usd(c.pricedUsd)} vs recorded $${usd(c.recordedUsd)}` : `no lib/pricing.ts row, recorded $${usd(c.recordedUsd)} unpriced`}`);
  }
  const estimated = report.cases.filter(c => c.estimated);
  const estimatedUsd = estimated.reduce((total, c) => total + c.costUsd, 0);
  out.push('', `Cases: ${report.cases.length}; ${estimated.length} without recorded cost, estimated at $${report.usdPerSecond.toFixed(4)} per session-second: ~${usd(estimatedUsd)} per gate`);
  for (const c of estimated) out.push(`  ${pad([c.caseId, `~${usd(c.costUsd)} (est.)`, `${Math.round(c.meanDurationMs / 1000)} s`, c.runner ?? '-'], [40, 14, 7])}`);
  out.push(`Full-gate scale: $${usd(report.fullScaleUsd)} per gate (recorded case means plus estimates)`);
  if (options.cases) {
    out.push('', 'Per-case mean cost:');
    for (const c of report.cases) out.push(`  ${pad([c.caseId, (c.estimated ? '~' : '') + usd(c.costUsd), c.kind, c.runner ?? '-', c.estimated ? 'estimated' : `${c.recordedGates} gate(s)`], [50, 8, 6, 10])}`);
  }
  if (!report.prs.length) return out.join('\n');
  const label = SCREEN_LABEL;
  out.push('', `Per merged PR ($ on the $${usd(report.fullScaleUsd)} full-gate scale; cases are gate e2e cases, judges extra):`);
  out.push(`  ${pad(['PR', 'sha', 'files', 'today $ (cases)', 'R4 shadow $ (cases)', `${label} $ (cases)`], [6, 8, 5, 16, 20])}`);
  for (const row of report.prs) {
    const cell = (s: { usd: number; cases: number }) => `${usd(s.usd)} (${s.cases})`;
    out.push(`  ${pad([`#${row.pr}`, row.sha, row.files, cell(row.today), cell(row.shadow), cell(row.screenProvisional) + (row.screenProvisional.canary ? ' +canary' : '')], [6, 8, 5, 16, 20])}`);
  }
  const s = report.selection!;
  out.push('', `Selection over ${report.prs.length} merged PRs (one cohort: every merged PR counts, zeros included)${report.window ? `, ${report.window.since} to ${report.window.until}` : ''}:`);
  out.push(`  ${pad(['selector', '$ / merged PR', 'median $', 'mean cases', 'PRs >= 90% of gate'], [20, 13, 9, 10])}`);
  for (const [name, row] of [['today', s.today], ['R4 shadow', s.shadow], [label, s.screenProvisional]] as const) {
    out.push(`  ${pad([name, usd(row.meanUsd), usd(row.medianUsd), row.meanCases.toFixed(1), row.nearFull], [20, 13, 9, 10])}`);
  }
  out.push(`  ${label}: its preamble detector is a line-commonality heuristic, not T2's hunk classifier; heuristic until T2 lands.`);
  if (!report.model) {
    out.push('', 'Train model: skipped (needs a window: --since/--until, or --window-days with --prs).');
    return out.join('\n');
  }
  const m = report.model;
  const perWeek = report.prs.length * 7 / report.windowDays!;
  out.push('', `Train model (seeded Monte Carlo, ${m.reps} reps, seed ${m.seed}; trains of ${m.trainSize}; full gate $${usd(m.fullGateUsd)}, bisect $6, repair re-screens x1.3,`,
    `  red rates screened 6% / unscreened 25%; ${label} screen costs scaled by ${m.screenScale.toFixed(4)} to the recorded gate;`,
    `  window ${report.windowDays!.toFixed(1)} days, ${perWeek.toFixed(1)} merged PRs a week; multiples against $${TODAY_WEEKLY_USD} and $${AFTER_GSTA48_WEEKLY_USD} a week):`);
  const widths = [15, 5, 7, 6, 7, 7, 22, 9, 9, 9, 8, 9, 10];
  out.push(`  ${pad(['policy', 'o', '$/week', '$/PR', 'x9950', 'x8400', `${label} $/w`, 'trains/w', 'gates/w', 'bisect/w', 'rebld/w', 'stalls/w', 'first-red'], widths)}  attempt-red`);
  for (const r of m.rows) {
    out.push(`  ${pad([r.policy, r.outsideRed.toFixed(2), Math.round(r.weeklyUsd), r.perMergedPrUsd.toFixed(1), r.multipleVsToday.toFixed(2), r.multipleVsAfterGsta48.toFixed(2),
      Math.round(r.screenWeeklyUsd), r.initialTrainsWeekly.toFixed(2), r.gateAttemptsWeekly.toFixed(2), r.bisectsWeekly.toFixed(2), r.rebuildOnceWeekly.toFixed(2),
      r.stallsWeekly.toFixed(2), pct(r.firstCandidateRedShare, 1)], widths)}  ${pct(r.attemptRedShare, 1)}`);
  }
  return out.join('\n');
}

export function main(argv: string[]): number {
  let args: ReplayArgs;
  try { args = parseArgs(argv); } catch (error) {
    console.error(`gate-cost-replay: ${(error as Error).message}`);
    return 2;
  }
  try {
    const repo = args.repo || repoSlug(ROOT);
    fs.mkdirSync(args.cache, { recursive: true });
    const gates = args.runs.map(run => readGateRecord(fetchRun(run, args.cache, repo), run));
    const empty = gates.filter(g => g.trials.length === 0);
    if (empty.length) throw new Error(`run(s) ${empty.map(g => g.runId).join(', ')} have no trial outcomes (expired artifacts, or not a paid gate run)`);
    const merges = mergedPrs(args);
    const report: ReplayReport = { repo, ref: args.ref, head: git(['rev-parse', args.ref]).trim(), ...buildReport(args, gates, merges, checkoutSelectionDeps()) };
    console.log(args.json ? JSON.stringify(report, null, 2) : formatReport(report, { cases: args.cases }));
    return 0;
  } catch (error) {
    console.error(`gate-cost-replay: ${(error as Error).message}`);
    return 1;
  }
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
