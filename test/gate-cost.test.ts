import { afterAll, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  PyRandom, SCREEN_LABEL, caseCostTable, changedLinesByFile, gateCostBreakdown, heuristicPreambleOnly, parseEvalReport,
  prSelectionCost, simulateTrains, summarizeGates, summarizeSelector, type GateRecord, type PrDiff, type SelectionDeps,
} from '../lib/gate-cost';
import { buildReport, checkoutSelectionDeps, formatReport, parseArgs, parseMergeLog, parseWindowDate, readGateRecord, type ReplayReport } from '../scripts/gate-cost-replay';

/**
 * A one-run artifact tree, written to a temporary directory: tracked files
 * under test/fixtures would need a FREE_FIXTURES entry, and that registry is
 * a paid-runner input that selects every PR-profile case.
 */
const RUN_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-cost-run-'));
afterAll(() => fs.rmSync(RUN_DIR, { recursive: true, force: true }));
const usage = (inputTokens: number, outputTokens: number, cacheReadInputTokens: number, cacheCreationInputTokens: number, thinkingTokens: number, costUSD: number) =>
  ({ inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens, thinkingTokens, costUSD });
const FIXTURE_FILES: Record<string, unknown> = {
  'paid-slice-1-a1/shards/skill-e2e-demo--case-a/1.0.0-HEAD-e2e-demo.json': { tests: [{
    name: '/case a', tier: 'e2e', duration_ms: 40_500, cost_usd: 0.253, model: 'claude-fable-5-1', transcript: [
      { type: 'assistant' },
      { type: 'result', modelUsage: { 'claude-fable-5-1': usage(100, 2000, 100_000, 10_000, 500, 0.251), 'claude-haiku-4-5-20251001': usage(1000, 100, 0, 0, 0, 0.0015) } },
      { type: 'result', modelUsage: { 'claude-fable-5-1': usage(50, 0, 0, 0, 0, 0.0005) } },
    ] }] },
  'paid-slice-1-a1/shards/skill-e2e-demo--case-a/_partial-e2e.json': { tests: [{ name: '/case a', duration_ms: 40_500, cost_usd: 99 }] },
  'paid-slice-2-a1/shards/skill-llm-eval/1.0.0-HEAD-llm-judge.json': { tests: [{ name: 'demo/SKILL.md judge', tier: 'llm-judge', duration_ms: 20_000, cost_usd: 0.06 }] },
};
for (const [file, body] of Object.entries(FIXTURE_FILES)) {
  fs.mkdirSync(path.dirname(path.join(RUN_DIR, file)), { recursive: true });
  fs.writeFileSync(path.join(RUN_DIR, file), JSON.stringify(body));
}
const trial = (caseId: string, file: string, kind: string, durationMs: number, runner?: string) =>
  JSON.stringify({ schema: 'gstack-trial-outcome/v1', case: caseId, file, kind, duration_ms: durationMs, cost_usd: 0, ...(runner ? { sessions: [{ runner }] } : {}) });
fs.mkdirSync(path.join(RUN_DIR, 'trial-outcomes-pr-a1'));
fs.writeFileSync(path.join(RUN_DIR, 'trial-outcomes-pr-a1', 'trial-outcomes.jsonl'), [
  trial('case-a', 'test/skill-e2e-demo.test.ts', 'rule', 40_000, 'claude-p'),
  trial('case-pty', 'test/skill-e2e-pty-demo.test.ts', 'rule', 100_000, 'pty'),
  'not json',
  trial('demo/SKILL.md judge', 'test/skill-llm-eval.test.ts', 'judge', 20_000),
].join('\n') + '\n');
const run1 = () => readGateRecord(RUN_DIR, '1');

/** GSTA-49's l3.json: 92 merged PRs of 2026-10-03..18, [today's selection cost > 0 ? 1 : 0, screen cost on the 106.0259 full-gate scale]. */
const L3_ROWS: Array<[number, number]> = [
  [0,14.3731], [1,14.0509], [1,14.0509], [1,106.0259], [1,106.0259], [1,106.0259], [1,102.6497], [1,14.0509], [0,14.0509], [1,15.5642],
  [0,15.5642], [0,0], [1,14.2545], [0,14.0509], [0,14.0509], [1,14.0509], [0,14.0509], [1,53.2204], [1,80.5128], [1,48.761],
  [1,47.2944], [1,46.47], [0,15.5642], [1,86.2435], [1,14.0509], [1,50.8781], [1,27.4209], [1,57.6069], [1,106.0259], [1,14.0509],
  [1,106.0259], [1,14.0509], [1,14.0509], [1,14.3731], [1,76.3276], [1,106.0259], [1,14.0509], [1,16.2643], [0,14.0509], [1,92.6175],
  [1,78.0744], [1,14.6998], [1,31.99], [1,14.0509], [1,14.0509], [1,19.9311], [1,59.4491], [1,14.0509], [1,106.0259], [1,22.1538],
  [1,14.0509], [1,78.4857], [1,62.5585], [1,106.0259], [1,14.0509], [1,50.6055], [1,79.9843], [1,79.5795], [1,67.6899], [0,0],
  [1,106.0259], [1,14.0509], [1,14.0509], [1,14.6998], [1,95.9865], [1,14.6998], [0,15.5642], [1,20.58], [0,15.2423], [1,106.0259],
  [1,33.2109], [1,106.0259], [1,106.0259], [0,15.5642], [0,14.0509], [0,15.5642], [1,106.0259], [1,106.0259], [1,106.0259], [0,15.5642],
  [1,106.0259], [0,15.5642], [0,1.5133], [0,15.5642], [1,19.7931], [1,106.0259], [0,15.5642], [1,106.0259], [1,106.0259], [1,21.6093],
  [1,106.0259], [1,106.0259],
];

describe('paid report artifacts', () => {
  test('reads eval reports and trial outcomes, skipping partial reports', () => {
    const gate = run1();
    expect(gate.tests.map(t => [t.name, t.file, t.costUsd])).toEqual([
      ['/case a', 'test/skill-e2e-demo.test.ts', 0.253],
      ['demo/SKILL.md judge', 'test/skill-llm-eval.test.ts', 0.06],
    ]);
    expect(gate.tests[0]!.modelUsage['claude-fable-5-1']).toMatchObject({ inputTokens: 150, outputTokens: 2000, thinkingTokens: 500, costUSD: 0.2515 });
    expect(gate.trials.map(t => [t.caseId, t.kind, t.runner])).toEqual([['case-a', 'rule', 'claude-p'], ['case-pty', 'rule', 'pty'], ['demo/SKILL.md judge', 'judge', null]]);
    expect(parseEvalReport('x', { notTests: [] })).toEqual([]);
  });

  test('aggregates cost by model and token class through lib/pricing.ts', () => {
    const b = gateCostBreakdown(run1());
    expect(b.recordedUsd).toBeCloseTo(0.313, 9);
    expect(b.byModel['claude-fable-5-1']).toBeCloseTo(0.2515, 9);
    expect(b.byModel['claude-haiku-4-5-20251001']).toBeCloseTo(0.0015, 9);
    expect(b.byModel['llm-judge']).toBeCloseTo(0.06, 9);
    const fable = b.tokenClasses['claude-fable-5-1']!;
    expect(fable.cacheWrite.usd).toBeCloseTo(0.125, 9);
    expect(fable.output.usd).toBeCloseTo(0.1, 9);
    expect(fable.output.thinkingTokens).toBe(500);
    expect(fable.cacheRead.usd).toBeCloseTo(0.025, 9);
    expect(fable.uncachedInput.usd).toBeCloseTo(0.0015, 9);
    expect(fable.pricedUsd).toBeCloseTo(fable.recordedUsd, 9);
    expect(b.tokenClasses['claude-haiku-4-5-20251001']!.pricedUsd).toBeCloseTo(0.0015, 9);
    const twice = summarizeGates([run1(), { tests: run1().tests.map(t => ({ ...t, costUsd: t.costUsd * 3 })) }]);
    expect(twice.recordedUsd.min).toBeCloseTo(0.313, 9);
    expect(twice.recordedUsd.mean).toBeCloseTo(0.626, 9);
  });

  test('per-case mean across gates; a case with no recorded cost is estimated from duration and marked', () => {
    const second: GateRecord = { ...run1(), tests: run1().tests.map(t => (t.name === '/case a' ? { ...t, costUsd: 0.453 } : t)) };
    const table = caseCostTable([run1(), second]);
    expect(table.cases['case-a']).toMatchObject({ estimated: false, recordedGates: 2 });
    expect(table.cases['case-a']!.costUsd).toBeCloseTo(0.353, 9);
    expect(table.usdPerSecond).toBeCloseTo((0.253 + 0.453 + 0.12) / 120, 9);
    expect(table.cases['case-pty']).toMatchObject({ estimated: true, recordedGates: 0, runner: 'pty' });
    expect(table.cases['case-pty']!.costUsd).toBeCloseTo(100 * table.usdPerSecond, 9);
    expect(caseCostTable([run1()], { usdPerSecond: 0.01 }).cases['case-pty']!.costUsd).toBeCloseTo(1, 9);
  });
});

const COSTS = { cases: Object.fromEntries([['a', 10], ['b', 5], ['c', 1], ['j1', 0.5], ['j2', 0.5]].map(([id, usd]) => [id, { caseId: id as string, costUsd: usd as number }])), usdPerSecond: 0 } as never;
function fakeDeps(touched: string[][] = []): SelectionDeps {
  return {
    gateCases: ['a', 'b', 'c'], judgeCases: ['j1', 'j2'],
    today: files => ({ e2e: files.some(f => f.endsWith('.tmpl')) ? ['a', 'b'] : [], judges: [], shadowE2e: null, mode: 'pr' }),
    touchfiles: files => { touched.push(files); return { e2e: files.some(f => f.endsWith('.tmpl')) ? ['b'] : [], global: false }; },
  };
}
const diff = (files: string[], extra: Partial<PrDiff> = {}): PrDiff => ({ pr: 1, sha: 'abc', files, packageVersionOnly: false, skillMdChangedLines: {}, ...extra });

describe('selection cost of a merged PR', () => {
  test('a package.json version stamp is neither selected nor a canary trigger; every judge is always in the screen', () => {
    const touched: string[][] = [];
    const stamp = prSelectionCost(diff(['package.json', 'VERSION', 'CHANGELOG.md'], { packageVersionOnly: true }), fakeDeps(touched), COSTS);
    expect(stamp.screenProvisional).toMatchObject({ canary: false, canaryReasons: [], cases: 0, judges: 2, usd: 1 });
    expect(touched).toEqual([['VERSION', 'CHANGELOG.md']]);
    const real = prSelectionCost(diff(['package.json']), fakeDeps(), COSTS);
    expect(real.screenProvisional.canaryReasons).toEqual(['full-gate file package.json']);
    expect(real.screenProvisional.usd).toBe(13);
    expect(prSelectionCost(diff([]), fakeDeps(), COSTS).screenProvisional.usd).toBe(1);
  });

  test('the version stamp also adds no canary through the checkout selectors', () => {
    const row = prSelectionCost(diff(['package.json', 'VERSION', 'CHANGELOG.md'], { packageVersionOnly: true }), checkoutSelectionDeps(), COSTS);
    expect(row.today.cases).toBe(0);
    expect(row.screenProvisional.canary).toBe(false);
  });

  test('transitive-only files and heuristic preamble-only SKILL.md changes add the canary set, capped at the full gate', () => {
    const row = prSelectionCost(diff(['review/SKILL.md.tmpl']), fakeDeps(), COSTS);
    expect(row.today).toEqual({ cases: 2, judges: 0, usd: 15 });
    expect(row.shadow.usd).toBe(15);
    expect(row.screenProvisional).toMatchObject({ cases: 1, usd: 17, canary: true });
    const skills = Array.from({ length: 10 }, (_, i) => `s${i}/SKILL.md`);
    const lines = Object.fromEntries(skills.map((file, i) => [file, ['+shared preamble line', ...(i === 0 ? ['+only here'] : [])]]));
    expect(heuristicPreambleOnly(lines)).toEqual(skills.slice(1));
    expect(heuristicPreambleOnly(Object.fromEntries(Object.entries(lines).slice(0, 9)))).toEqual([]);
    const preamble = prSelectionCost(diff(skills, { skillMdChangedLines: lines }), fakeDeps(), COSTS);
    expect(preamble.screenProvisional.preambleOnly).toHaveLength(9);
    expect(preamble.screenProvisional.canaryReasons[0]).toContain('preamble-only');
    expect(prSelectionCost(diff(['setup', 'scripts/resolvers/x.ts']), { ...fakeDeps(), touchfiles: () => ({ e2e: ['a', 'b', 'c'], global: false }) }, COSTS).screenProvisional.usd).toBe(17);
  });

  test('git -U0 diffs parse into distinct changed lines per file', () => {
    const text = ['diff --git a/x/SKILL.md b/x/SKILL.md', '--- a/x/SKILL.md', '+++ b/x/SKILL.md', '@@ -1 +1 @@', '-old line', '+new line ', '+new line', 'diff --git a/y/SKILL.md b/y/SKILL.md', '+other'].join('\n');
    expect(changedLinesByFile(text)).toEqual({ 'x/SKILL.md': ['-old line', '+new line'], 'y/SKILL.md': ['+other'] });
  });

  test('selector summaries average over every merged PR, zeros included', () => {
    expect(summarizeSelector([{ cases: 0, judges: 0, usd: 0 }, { cases: 2, judges: 0, usd: 10 }, { cases: 4, judges: 0, usd: 20 }], 20))
      .toEqual({ meanUsd: 10, medianUsd: 10, meanCases: 2, nearFull: 1 });
  });
});

describe('merge-train model', () => {
  test('PyRandom reproduces CPython random.Random', () => {
    const r = new PyRandom(1);
    expect([r.random(), r.random()]).toEqual([0.13436424411240122, 0.8474337369372327]);
    const items = Array.from({ length: 10 }, (_, i) => i);
    new PyRandom(1).shuffle(items);
    expect(items).toEqual([6, 8, 9, 7, 5, 3, 0, 4, 1, 2]);
    const s = new PyRandom(1);
    expect(s.sample(Array.from({ length: 100 }, (_, i) => i), 3)).toEqual([17, 72, 97]);
    expect(s.sample(Array.from({ length: 20 }, (_, i) => i), 10)).toEqual([2, 8, 3, 15, 14, 7, 10, 6, 17, 1]);
    expect(new PyRandom(2 ** 40 + 7).random()).toBe(0.6137037779936511);
  });

  const prs = L3_ROWS.map(([relevant, cost]) => ({ paidRelevant: relevant === 1, screenUsd: cost * 93.14 / 106.0259 }));
  const model = (policy: Parameters<typeof simulateTrains>[0]['policy']) => simulateTrains({ prs, policy, windowDays: 15.1, trainSize: 5, outsideRed: 0.15 });

  test('reproduces the measurement sim (trains of 5, o=0.15, 6%/25% red, 400 reps, seed 1)', () => {
    expect(prs).toHaveLength(92);
    const all = model({ kind: 'all' }), half = model({ kind: 'random', fraction: 0.5 }), none = model({ kind: 'none' });
    expect([all, half, none].map(r => Math.round(r.weeklyUsd))).toEqual([3403, 2672, 1986]);
    expect(Math.round(all.screenWeeklyUsd)).toBe(2196);
    expect(none.screenWeeklyUsd).toBe(0);
    expect(all.gateAttemptsWeekly).toBeCloseTo(12.73, 2);
    expect(none.bisectsWeekly).toBeCloseTo(10.27, 2);
    expect(half.rebuildOnceWeekly).toBeCloseTo(1.44, 2);
    expect(half.stallsWeekly).toBeCloseTo(0.22, 2);
    expect(all.firstCandidateRedShare).toBeCloseTo(0.32, 2);
    expect(none.attemptRedShare).toBeCloseTo(0.50, 2);
    expect(all.multipleVsToday).toBeCloseTo(9950 / all.weeklyUsd, 9);
    expect(all.multipleVsAfterGsta48).toBeCloseTo(8400 / all.weeklyUsd, 9);
    expect(all.perMergedPrUsd).toBeCloseTo(all.weeklyUsd / (92 * 7 / 15.1), 9);
  });

  test('cheapest-half screens the cheaper half and is deterministic for a seed', () => {
    const cheap = model({ kind: 'cheapest-half' }), expensive = model({ kind: 'expensive-half' });
    expect(Math.round(cheap.weeklyUsd)).toBe(1996);
    expect(cheap.screenWeeklyUsd).toBeLessThan(expensive.screenWeeklyUsd);
    expect(model({ kind: 'random', fraction: 0.8 })).toEqual(model({ kind: 'random', fraction: 0.8 }));
  });
});

describe('gate-cost-replay CLI', () => {
  test('parses window dates as UTC days with an inclusive end, and merge subjects', () => {
    expect(parseWindowDate('2026-10-03', false).toISOString()).toBe('2026-10-03T00:00:00.000Z');
    expect(parseWindowDate('2026-10-17', true).toISOString()).toBe('2026-10-18T00:00:00.000Z');
    expect(parseMergeLog('a1\t2026-10-17T00:00:00Z\tv1.0 fix: x (#3261)\nb2\t2026-10-17T00:00:00Z\tno pr here\n')).toEqual([{ pr: 3261, sha: 'a1', committedAt: '2026-10-17T00:00:00Z' }]);
    expect(() => parseArgs(['--since', '2026-10-03', '--until', '2026-10-17'])).toThrow('--runs');
    expect(() => parseArgs(['--runs', '1', '--prs', '2', '--since', '2026-10-03', '--until', '2026-10-04'])).toThrow('either');
  });

  test('every printed screening figure is labelled screen-provisional', () => {
    const args = parseArgs(['--runs', '1', '--reps', '5']);
    const merges = { prs: [{ pr: 7, sha: 'abcdef12', committedAt: '' }, { pr: 8, sha: 'bcdef123', committedAt: '' }], windowDays: 7 };
    const deps: SelectionDeps = { ...fakeDeps(), gateCases: ['case-a', 'case-pty'], judgeCases: ['demo/SKILL.md judge'] };
    const files: Record<number, string[]> = { 7: ['x/SKILL.md.tmpl'], 8: ['docs/x.md'] };
    const body = buildReport(args, [run1()], merges, deps, m => diff(files[m.pr]!, { pr: m.pr, sha: m.sha }));
    const report: ReplayReport = { repo: 'o/r', ref: 'origin/main', head: '0123456789', ...body };
    const text = formatReport(report);
    const screenLines = text.split('\n').filter(line => /\bscreen\b/i.test(line));
    expect(screenLines.length).toBeGreaterThan(3);
    for (const line of screenLines) expect(line).toContain(SCREEN_LABEL);
    expect(text).toContain(`${SCREEN_LABEL}: its preamble detector is a line-commonality heuristic`);
    expect(body.model!.rows).toHaveLength(12);
    expect(JSON.stringify(body.prs[0])).toContain('"screenProvisional"');
  });
});
