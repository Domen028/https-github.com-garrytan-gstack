/**
 * pregate check `lanes` (tier 1, tests stage): the touched files map to test
 * files (lib/pregate/lane-selection.ts); the local ones run under
 * `set -o pipefail` with the exit code and the runner's own summary judged
 * (zero tests ran is a failure, exit 0 or not); platform lanes this machine
 * cannot run become persisted `requires-remote` obligations. A touched file
 * with no lane is `FAIL lanes — <file> has no test lane`, never a pass.
 * Incidents: p0-4-pipe-hidden-failure (`false | tail` read as green),
 * p0-4-windows-lane-unrun (a Windows-only change merged with its lane unrun).
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { baseInputs, sha256 } from '../context';
import { selectLanes, type Selection } from '../lane-selection';
import { launchRuntime } from '../runtime';
import { adapterFor, readRange, supervise, type Counter, type Supervised } from '../supervise';
import { matchesAny } from '../../ship-policy';
import type { CheckDef, CheckResult, PregateContext, RemoteObligation } from '../types';

/** The test command with `{files}`; detected from the repo when the config does not name one. */
export function detectRunner(ctx: PregateContext, files: readonly string[]): string | null {
  if (ctx.config.runner) return ctx.config.runner;
  const has = (f: string) => fs.existsSync(path.join(ctx.repoRoot, f));
  let pkg: { devDependencies?: Record<string, string>; dependencies?: Record<string, string>; scripts?: Record<string, string> } = {};
  try { pkg = JSON.parse(fs.readFileSync(path.join(ctx.repoRoot, 'package.json'), 'utf8')); } catch { /* no package.json */ }
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  if (has('bunfig.toml') || has('bun.lock') || has('bun.lockb')) return 'bun test {files}';
  if (deps.vitest) return 'npx vitest run {files}';
  if (deps.jest) return 'npx jest {files}';
  if (files.every(f => /\.py$/.test(f)) && files.length) return 'python3 -m pytest {files}';
  if (files.every(f => /\.[cm]?js$/.test(f)) && files.length) return 'node --test {files}';
  if (files.every(f => /\.[cm]?[jt]sx?$/.test(f)) && files.length && Bun.which('bun')) return 'bun test {files}';
  return null;
}

export interface RunnerSummary { ran: number | null; failed: number | null }

/** The runner's own summary line: bun, node --test, vitest, jest, pytest. null when not recognised. */
export function parseSummary(output: string): RunnerSummary {
  let m: RegExpExecArray | null;
  if ((m = /^\s*(?:#|ℹ)\s*tests\s+(\d+)/m.exec(output))) return { ran: Number(m[1]), failed: Number(/^\s*(?:#|ℹ)\s*fail\s+(\d+)/m.exec(output)?.[1] ?? 0) };
  if ((m = /Ran\s+(\d+)\s+tests?\s+across/m.exec(output))) return { ran: Number(m[1]), failed: Number(/^\s*(\d+)\s+fail\b/m.exec(output)?.[1] ?? 0) };
  if ((m = /^\s*(\d+)\s+pass\s*$/m.exec(output))) return { ran: Number(m[1]) + Number(/^\s*(\d+)\s+fail\s*$/m.exec(output)?.[1] ?? 0), failed: Number(/^\s*(\d+)\s+fail\s*$/m.exec(output)?.[1] ?? 0) };
  if ((m = /Tests:\s+(?:(\d+)\s+failed,\s+)?(?:(\d+)\s+passed,\s+)?(\d+)\s+total/.exec(output))) return { ran: Number(m[3]), failed: Number(m[1] ?? 0) };
  if ((m = /Tests\s+(?:(\d+)\s+failed\s*\|\s*)?(\d+)\s+passed/.exec(output))) return { ran: Number(m[2]) + Number(m[1] ?? 0), failed: Number(m[1] ?? 0) };
  if (/no tests ran/.test(output) || /No tests found/i.test(output)) return { ran: 0, failed: 0 };
  if ((m = /(?:(\d+)\s+failed,?\s*)?(\d+)\s+passed/.exec(output))) return { ran: Number(m[2]) + Number(m[1] ?? 0), failed: Number(m[1] ?? 0) };
  return { ran: null, failed: null };
}

interface LocalRun { exit: number | null; outcome: Supervised['outcome']; ran: number | null; failed: number | null; tail: string[]; command: string; files: string[]; lastFile: string | null; ms: number }

const quote = (f: string) => `'${f.replace(/'/g, `'\\''`)}'`;

async function runOnce(ctx: PregateContext, env: NodeJS.ProcessEnv, runner: string, files: string[], log: string, counter: Counter): Promise<LocalRun> {
  const command = runner.replace('{files}', files.map(quote).join(' '));
  const r = await supervise({ command, cwd: ctx.repoRoot, env: { ...env, CI: env.CI ?? '1' }, log, deadline: Date.now() + ctx.timeoutMs, stallMs: ctx.stallTimeoutMs, label: `lanes (${files.length === 1 ? files[0] : `${files.length} files`})`, files, adapter: adapterFor(runner), counter, progress: ctx.progress });
  const output = readRange(log, r.start, r.end);
  const summary = parseSummary(output);
  return { exit: r.exit, outcome: r.outcome, ...summary, tail: output.trim().split('\n').slice(-25), command, files, lastFile: r.lastFile, ms: r.ms };
}

/**
 * Unit files in one runner process, then each serial-pattern file in its
 * own (a serial file shares process-wide state: a module mock, an env
 * mutation). `--timeout` bounds each runner process; the stall timeout
 * catches a silent one. A stalled or timed-out group is killed and the next
 * one runs. The first unfinished, then the first non-zero run decides the
 * exit; counts add up only when every run reported a summary.
 */
async function runLocal(ctx: PregateContext, env: NodeJS.ProcessEnv, runner: string, files: string[]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-pregate-lanes-'));
  const log = path.join(dir, 'lanes.log');
  fs.writeFileSync(log, '');
  const serial = files.filter(f => matchesAny(ctx.config.serial_patterns, f));
  const unit = files.filter(f => !serial.includes(f));
  const counter: Counter = { done: 0, total: files.length };
  const runs: LocalRun[] = [];
  for (const group of [...(unit.length ? [unit] : []), ...serial.map(f => [f])]) {
    runs.push(await runOnce(ctx, env, runner, group, log, counter));
  }
  const bad = runs.find(r => r.exit === null) ?? runs.find(r => r.exit !== 0);
  const sum = (k: 'ran' | 'failed') => (runs.some(r => r[k] === null) ? null : runs.reduce((n, r) => n + (r[k] as number), 0));
  return { runs, bad, exit: bad ? bad.exit : 0, ran: sum('ran'), failed: sum('failed'), log, tail: (bad ?? runs[runs.length - 1]!).tail, command: runs.map(r => r.command).join(' && '), serial: serial.length };
}

/** Why the local lane did not finish: a stall, a runner process past --timeout or a launch failure, with the last file started. */
function unfinished(ctx: PregateContext, r: Awaited<ReturnType<typeof runLocal>>, total: number): Pick<CheckResult, 'code' | 'detail' | 'fix'> {
  const stalled = r.runs.filter(x => x.outcome === 'stalled');
  const timedOut = r.runs.filter(x => x.outcome === 'timeout');
  const rest = r.failed ? `; ${r.failed} failed` : '';
  if (stalled.length) {
    return { code: 'PREGATE_STALLED', detail: `no test output for ${ctx.stallTimeoutMs / 1000} s; process group killed; last file started: ${stalled.map(x => x.lastFile ?? `(none reported; ${x.files.length} file(s))`).join(', ')}${rest}`, fix: `read ${r.log} for the stalled file; fix the hang, or raise --stall-timeout (stall_timeout_s in .gstack/pregate.json; 0 disables) for a test that is quiet for longer` };
  }
  if (!timedOut.length) return { code: 'PREGATE_INCOMPLETE', detail: `the runner could not be launched (${total} files${rest})`, fix: 'read the lane log, fix the runner command, then rerun gstack-pregate --stage tests' };
  return { code: 'PREGATE_INCOMPLETE', detail: `a runner process timed out after ${ctx.timeoutMs} ms (--timeout applies to each runner process; ${total} files; last file started: ${timedOut.map(x => x.lastFile ?? `(none reported; ${x.files.length} file(s))`).join(', ')}${rest})`, fix: 'raise --timeout or split the selection; a timed-out lane never passes' };
}

function describe(sel: Selection): string[] {
  const lines = sel.noLane.map(f => `FAIL lanes — ${f} has no test lane`);
  for (const r of sel.remote) lines.push(`requires-remote ${r.lane} (${r.platform}): ${r.tests.length} test(s) — ${r.tests.slice(0, 8).join(' ')}${r.tests.length > 8 ? ' …' : ''}`);
  lines.push(`Tiers ran: ${sel.tiersRan.join(' ') || '(none)'}; requires-remote: ${[...new Set(sel.remote.map(r => r.platform))].join(' ') || 'none'}`);
  return lines;
}

export const SMALL_MACHINE_CORES = 8;
const GSTACK_ROOT = path.resolve(import.meta.dir, '..', '..', '..');

/**
 * The small-machine obligation: the repo's declared `remote_gate`, else the
 * configured test backend running this selection through gstack's Ubicloud
 * runner (that command prints no PREGATE_REMOTE line, so only `clear` with a
 * run URL discharges it).
 */
function remoteObligation(ctx: PregateContext, sel: Selection): RemoteObligation {
  const declared = ctx.config.remote_gate;
  const runner = detectRunner(ctx, sel.localTests);
  const command = declared ?? `${GSTACK_ROOT}/scripts/ubicloud/ubi-runner.sh run --src ${quote(ctx.repoRoot)} -- ${quote(runner ? runner.replace('{files}', sel.localTests.map(quote).join(' ')) : '<test runner> <selected files>')}`;
  const [workflow, job] = declared ? ['pregate.json', 'remote_gate'] : ['test_backend', ctx.testBackend];
  return { lane: `${workflow}/${job}`, platform: 'remote', workflow, job, tests: sel.localTests, receipt: null, command };
}

/**
 * `--remote`: run the declared remote gate now, under the spend cap. The
 * gate gets PREGATE_TREE, PREGATE_FILES_FILE and PREGATE_SPEND_CAP_USD and
 * must print `PREGATE_REMOTE: tree=<tree> tests=<n> failed=<n> [spent=<usd>]`;
 * the obligation clears only when that tree is the tested tree, tests > 0,
 * failed = 0 and the gate exited 0. Anything else leaves it uncleared and
 * the check incomplete.
 */
async function runRemote(ctx: PregateContext, sel: Selection, base: CheckResult): Promise<CheckResult> {
  const lines = base.lines ?? [];
  if (!ctx.config.remote_gate) return { ...base, status: 'incomplete', code: 'PREGATE_INCOMPLETE', detail: `--remote runs only a declared remote gate; ${ctx.configLabel} has no remote_gate`, fix: 'declare remote_gate (a command that prints PREGATE_REMOTE: tree=… tests=… failed=…) in .gstack/pregate.json on the base branch, or run the tests locally without --remote' };
  const obligation = remoteObligation(ctx, sel);
  const cap = ctx.remote!.spendCapUsd;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-pregate-remote-'));
  const log = path.join(dir, 'remote.log');
  const filesFile = path.join(dir, 'files.txt');
  fs.writeFileSync(log, '');
  fs.writeFileSync(filesFile, sel.localTests.join('\n') + '\n');
  const r = await supervise({ command: obligation.command!, cwd: ctx.repoRoot, env: { ...ctx.env, PREGATE_TREE: ctx.wtree, PREGATE_FILES_FILE: filesFile, PREGATE_SPEND_CAP_USD: String(cap) }, log, deadline: Date.now() + ctx.timeoutMs, stallMs: ctx.stallTimeoutMs, label: `remote gate ${obligation.lane}`, progress: ctx.progress });
  const output = readRange(log, r.start, r.end);
  const reported = [...output.matchAll(/^PREGATE_REMOTE: tree=(\S+) tests=(\d+) failed=(\d+)(?: spent=(\d+(?:\.\d+)?))?\s*$/gm)].pop();
  const spent = reported?.[4];
  const spend = `spend: spent ${spent ? `$${spent}` : '$0'}, reserved $0, unknown ${spent ? '$0' : `$${cap} (no spent= reported; counted at the cap)`} (cap $${cap})`;
  ctx.progress(`PREGATE_REMOTE_SPEND: ${spend.slice('spend: '.length)}`);
  const runLines = [...lines, `remote gate: ${obligation.command}`, `log: ${log}`, spend, ...output.trim().split('\n').slice(-15).map(l => `  ${l}`)];
  const inputs = { ...base.inputs, command: sha256(obligation.command!) };
  const why = r.outcome !== 'exited' ? `the remote gate did not finish (${r.outcome === 'stalled' ? `no output for ${ctx.stallTimeoutMs / 1000} s` : r.outcome})`
    : !reported ? `the remote gate exited ${r.exit} without a PREGATE_REMOTE: line`
    : reported[1] !== ctx.wtree ? `the remote gate tested tree ${reported[1]!.slice(0, 12)}, not ${ctx.wtree.slice(0, 12)}`
    : Number(reported[2]) === 0 ? 'the remote gate reported 0 tests'
    : Number(reported[3]) > 0 ? `the remote gate reported ${reported[3]} failed of ${reported[2]}`
    : r.exit !== 0 ? `the remote gate exited ${r.exit}`
    : null;
  if (why) return { ...base, inputs, lines: runLines, status: 'incomplete', remote: [...sel.remote, obligation], code: r.outcome === 'stalled' ? 'PREGATE_STALLED' : 'PREGATE_INCOMPLETE', detail: `${why}; requires-remote ${obligation.lane} stays uncleared`, fix: `read ${log}; the obligation clears only on PREGATE_REMOTE: tree=${ctx.wtree.slice(0, 12)}… tests>0 failed=0 with exit 0` };
  const cleared = { ...obligation, receipt: `remote-gate tree=${ctx.wtree.slice(0, 12)} tests=${reported![2]}`, cleared_by: `gstack-pregate --remote ${new Date().toISOString()}` };
  return { ...base, inputs, lines: runLines, status: 'requires-remote', remote: [...sel.remote, cleared], detail: `remote gate ${obligation.lane}: ${reported![2]} tests, 0 failed on tree ${ctx.wtree.slice(0, 12)}; ${spend}` };
}

async function run(ctx: PregateContext): Promise<CheckResult> {
  const sel = selectLanes(ctx);
  ctx.explain.push(...sel.provenance);
  for (const [lane, set] of Object.entries(sel.laneSets)) ctx.explain.push(`lane ${lane}: ${set === '?' ? 'file set unknown' : `${set.length} files`}`);
  const inputs = baseInputs(ctx, { selection: sha256(sel.tests.join('\n')), localTests: sha256(sel.localTests.join('\n')), remote: sha256(sel.remote.map(r => `${r.lane}:${r.tests.join(',')}`).join('\n')) });
  const lines = describe(sel);
  const base: CheckResult = { id: 'lanes', stage: 'tests', status: 'pass', inputs, lines, remote: sel.remote };
  if (sel.noLane.length) {
    return { ...base, status: 'fail', code: 'PREGATE_NO_LANE', detail: `${sel.noLane.length} touched file(s) with no test lane: ${sel.noLane.join(' ')}`, fix: 'add a test that names the file, or declare its lane (or []) under dependencies in .gstack/pregate.json' };
  }
  if (sel.tests.length === 0) return { ...base, detail: ctx.touched.length ? 'nothing touched selects a test' : 'no touched files' };
  if (ctx.remote && sel.localTests.length) return runRemote(ctx, sel, base);
  const smallMachine = ctx.cores < SMALL_MACHINE_CORES && sel.localTests.length > 0 && (ctx.config.remote_gate || ctx.testBackend !== 'local');
  if (smallMachine) {
    const obligation = remoteObligation(ctx, sel);
    return { ...base, status: 'requires-remote', remote: [...sel.remote, obligation], lines: [...lines, `requires-remote ${obligation.lane}: ${ctx.cores} cores (under ${SMALL_MACHINE_CORES}); ${sel.localTests.length} local test file(s) recorded for the remote gate, not run here`, `run: ${obligation.command}`], detail: `${sel.localTests.length} local test file(s) recorded as requires-remote ${obligation.lane} (${ctx.cores} cores, under ${SMALL_MACHINE_CORES}); run it, then gstack-pregate clear --remote ${obligation.lane} --run-url <url>, or gstack-pregate --remote --spend-cap <usd> --allow-repo-commands` };
  }
  if (!ctx.allowRepoCommands) return { ...base, status: 'incomplete', code: 'REPO_COMMANDS_NOT_ALLOWED', detail: `${sel.localTests.length} local test file(s) selected but not run (pass --allow-repo-commands)`, fix: 'rerun with --allow-repo-commands (what /ship passes)' };
  if (sel.localTests.length === 0) return { ...base, status: sel.remote.length ? 'requires-remote' : 'pass', detail: `no local lane; ${sel.remote.length} requires-remote obligation(s)` };
  const runner = detectRunner(ctx, sel.localTests);
  if (!runner) return { ...base, status: 'incomplete', code: 'PREGATE_INCOMPLETE', detail: `no test runner detected for ${sel.localTests.length} selected file(s)`, fix: 'declare `runner` (with {files}) in .gstack/pregate.json' };
  const runtime = launchRuntime(ctx.repoRoot, ctx.env);
  const r = await runLocal(ctx, runtime.env, runner, sel.localTests);
  const runLines = [...lines, `runtime: ${runtime.label}`, `progress: ${adapterFor(runner) ?? 'none (no progress adapter for this runner; serial files and heartbeats only)'}`, `ran: ${r.command.length > 200 ? `${r.command.slice(0, 200)}…` : r.command}`, `log: ${r.log}`, ...r.tail.map(l => `  ${l}`)];
  const withRun = { ...base, lines: runLines, inputs: { ...inputs, command: sha256(r.command), runtime: runtime.label } };
  if (r.exit === null) return { ...withRun, status: 'incomplete', ...unfinished(ctx, r, sel.localTests.length) };
  if (r.exit !== 0) return { ...withRun, status: 'fail', code: 'PREGATE_LANE_FAILED', detail: `local lane exited ${r.exit} (${r.failed ?? '?'} failed of ${r.ran ?? '?'} ran; ${sel.localTests.length} files; pipefail)`, fix: `read ${r.log}, fix the in-branch failure, rerun gstack-pregate --stage tests` };
  if (r.ran === 0) return { ...withRun, status: 'fail', code: 'PREGATE_LANE_FAILED', detail: `ZERO-RUN: the runner reported 0 tests for ${sel.localTests.length} selected file(s)`, fix: 'a bad selector, a missing file or a skipped describe; exit 0 is not a pass' };
  const detail = `${r.ran ?? 'count unavailable'} tests ran in ${sel.localTests.length} file(s)${r.serial ? ` (${r.serial} serial)` : ''}, exit 0${sel.remote.length ? `; ${sel.remote.length} requires-remote obligation(s)` : ''}`;
  return { ...withRun, status: sel.remote.length ? 'requires-remote' : 'pass', detail };
}

export const lanesCheck: CheckDef = { id: 'lanes', stage: 'tests', tier: 1, downgradable: true, needsRepoCommands: true, run };
