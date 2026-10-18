/**
 * Restamp-only gate reuse (R2a, GSTA-48): a gate edit, so every refusal is a
 * negative control. Real git fixtures (a bare origin, the base-ref receipt
 * checkout) and scripted gh responses: no network, no API spend.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  BINDING_FILE, CANDIDATE_FILE, REUSE_FILE, buildBinding, confirmReuse, findReusableGate, parseReuse, reuseReport, selectionFingerprint,
  type GateBinding, type GateReuse,
} from '../scripts/gate-reuse';
import type { GhRunner, WorkflowRun } from '../scripts/recover-receipts';
import type { PaidRunManifest } from '../scripts/lib/paid-plan';

const ROOT = path.resolve(import.meta.dir, '..');
const REPO = 'garrytan/gstack';
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-reuse-'));
afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }));

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', '-c', 'commit.gpgsign=false', ...args],
    { cwd, encoding: 'utf8', timeout: 30_000 });
  if (r.status !== 0) throw new Error('git ' + args.join(' ') + ': ' + r.stderr);
  return r.stdout.trim();
}

const changelog = (sections: string[]) => ['# Changelog', '', ...sections, '## [1.0.0.0] - 2026-10-01', '', '- base release', ''].join('\n');
const files = (version: string, over: Record<string, string> = {}): Record<string, string> => ({
  VERSION: version + '\n',
  'package.json': JSON.stringify({ name: 'fixture', version, scripts: { test: 'bun test' } }, null, 2) + '\n',
  'agents-digest/gstack-AGENTS.md': '# gstack digest v' + version + ' — regenerate after upgrading\n\nbody\n',
  'src/feature.ts': 'export const feature = 1;\n',
  ...over,
});

let origin: string;
let receipt: string;
const sha: Record<string, string> = {};

function commit(work: string, branch: string, from: string, content: Record<string, string>, message: string): string {
  if (from) git(work, 'checkout', '-q', '-B', branch, from);
  else git(work, 'checkout', '-q', '--orphan', branch);
  for (const [rel, text] of Object.entries(content)) {
    fs.mkdirSync(path.dirname(path.join(work, rel)), { recursive: true });
    fs.writeFileSync(path.join(work, rel), text);
  }
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', message);
  git(work, 'push', '-q', 'origin', branch);
  return git(work, 'rev-parse', 'HEAD');
}

beforeAll(() => {
  origin = path.join(scratch, 'origin.git');
  git(scratch, 'init', '-q', '--bare', origin);
  git(origin, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
  const work = path.join(scratch, 'work');
  git(scratch, 'clone', '-q', origin, work);
  const policy = fs.readFileSync(path.join(ROOT, '.gstack/ship-policy.json'), 'utf8');
  sha.base = commit(work, 'main', '', { ...files('1.0.0.0', { 'src/feature.ts': 'export const feature = 0;\n' }), 'CHANGELOG.md': changelog([]),
    '.gstack/ship-policy.json': policy }, 'base');
  const entry = ['## [1.0.1.0] - 2026-10-02', '', '- the feature', ''];
  sha.gated = commit(work, 'feature', sha.base, { ...files('1.0.1.0'), 'CHANGELOG.md': changelog(entry) }, 'feature, tentative stamp');
  sha.restamp = commit(work, 'restamp', sha.gated, { ...files('1.0.2.0'), 'CHANGELOG.md': changelog(['## [1.0.2.0] - 2026-10-03', '', '- the feature', '']) }, 'restamp');
  sha.code = commit(work, 'code', sha.restamp, { 'src/feature.ts': 'export const feature = 2;\n' }, 'restamp plus a code byte');
  sha.entry = commit(work, 'entry', sha.gated, { ...files('1.0.2.0'), 'CHANGELOG.md': changelog(['## [1.0.2.0] - 2026-10-03', '', '- the feature, reworded', '']) }, 'restamp plus entry text');
  sha.lock = commit(work, 'lock', sha.gated, { 'bun.lock': '{\n  "lockfileVersion": 1\n}\n' }, 'a non-stamp file beside the stamp');
  const lock = (version: string) => '{\n  "lockfileVersion": 1,\n  "workspaces": {\n    "": {\n      "name": "fixture",\n      "version": "' + version + '",\n    },\n  },\n}\n';
  sha.gatedLock = commit(work, 'gated-lock', sha.gated, { 'bun.lock': lock('1.0.1.0') }, 'a lockfile carrying the root version');
  sha.lockStamp = commit(work, 'lock-stamp', sha.gatedLock, { ...files('1.0.2.0'), 'CHANGELOG.md': changelog(['## [1.0.2.0] - 2026-10-03', '', '- the feature', '']),
    'bun.lock': lock('1.0.2.0') }, 'restamp that also moves the lockfile root version');
  sha.moved = commit(work, 'main', sha.base, { 'README.md': 'main moved\n' }, 'main moves');
  receipt = path.join(scratch, 'receipt');
  git(scratch, 'clone', '-q', '--depth=1', 'file://' + origin, receipt);
  git(receipt, 'fetch', '-q', '--depth=1', 'origin', sha.base);
  git(receipt, 'checkout', '-q', '--detach', sha.base);
});

const binding = (over: Partial<GateBinding> = {}): GateBinding => ({ schema: 1, repository: REPO, pr: 42, run_id: 300, run_attempt: 1,
  head_sha: sha.gated!, base_sha: sha.base!, profile: 'pr', reconcile_exit: 0, verdict: 'GREEN', selection_sha256: 'f'.repeat(64), ...over });
const run = (id: number, head: string, conclusion: string | null = 'success', over: Partial<WorkflowRun> = {}): WorkflowRun => ({
  id, status: 'completed', conclusion, event: 'pull_request', head_sha: head, run_attempt: 1, head_repository: { full_name: REPO },
  pull_requests: [{ number: 42 }], ...over });

/** gh: the run list, each run's artifact list, and downloads that write the scripted binding (or raw text). */
function fakeGh(runs: WorkflowRun[], bindings: Record<number, GateBinding | string>, failList = ''): GhRunner {
  return (args) => {
    const ok = (body: unknown) => ({ status: 0, stdout: JSON.stringify(body), stderr: '' });
    if (args.some(a => a.endsWith('/workflows/evals.yml/runs'))) return failList ? { status: 1, stdout: '', stderr: failList } : ok({ workflow_runs: runs });
    const listed = args.find(a => /\/runs\/\d+\/artifacts$/.test(a));
    if (listed) {
      const id = Number(/runs\/(\d+)\//.exec(listed)![1]);
      return ok({ artifacts: id in bindings ? [{ name: 'gate-binding-a1', expired: false }, { name: 'paid-plan', expired: false }] : [{ name: 'paid-plan', expired: false }] });
    }
    if (args[0] === 'run' && args[1] === 'download') {
      const dir = args[args.indexOf('-D') + 1]!;
      fs.mkdirSync(dir, { recursive: true });
      const b = bindings[Number(args[2])]!;
      fs.writeFileSync(path.join(dir, BINDING_FILE), typeof b === 'string' ? b : JSON.stringify(b));
      return { status: 0, stdout: '', stderr: '' };
    }
    return { status: 1, stdout: '', stderr: 'unexpected gh ' + args.join(' ') };
  };
}

let outCount = 0;
function find(head: string, runs: WorkflowRun[], bindings: Record<number, GateBinding | string>, over: { baseSha?: string; failList?: string } = {}) {
  const out = path.join(scratch, 'out-' + ++outCount);
  const result = findReusableGate({ repo: REPO, pr: 42, headRepo: REPO, branch: 'feature', selfRunId: 500, headSha: head,
    baseSha: over.baseSha ?? sha.base!, repoRoot: receipt, out, gh: fakeGh(runs, bindings, over.failList) });
  return { ...result, out, text: result.lines.join('\n') };
}

describe('find: the positive case', () => {
  test('a restamp of a GREEN head on the same base yields a candidate with the receipt', () => {
    const { candidate, out, text } = find(sha.restamp!, [run(300, sha.gated!)], { 300: binding() });
    expect(text).toContain('TREE: same-modulo-stamps');
    expect(candidate).not.toBeNull();
    expect(candidate!.stamp_files.sort()).toEqual(['CHANGELOG.md', 'VERSION', 'agents-digest/gstack-AGENTS.md', 'package.json']);
    expect(candidate!).toMatchObject({ reused_run_id: 300, gated_head: sha.gated, current_head: sha.restamp, base_sha: sha.base,
      old_version: '1.0.1.0', new_version: '1.0.2.0', selection_sha256: 'f'.repeat(64) });
    expect(candidate!.receipt_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(parseReuse(JSON.parse(fs.readFileSync(path.join(out, CANDIDATE_FILE), 'utf8')))).toEqual(candidate);
  });

  test('cancelled or skipped runs that bound nothing are passed over to the newest executed gate', () => {
    const { candidate } = find(sha.restamp!, [run(320, sha.gated!, 'cancelled'), run(310, sha.gated!, 'success'), run(300, sha.gated!)], { 300: binding() });
    expect(candidate?.reused_run_id).toBe(300);
  });
});

describe('find: negative controls (each forces the full gate)', () => {
  const refused = (r: { candidate: GateReuse | null; out: string; text: string }, reason: string | RegExp) => {
    expect(r.candidate).toBeNull();
    expect(fs.existsSync(path.join(r.out, CANDIDATE_FILE))).toBe(false);
    if (typeof reason === 'string') expect(r.text).toContain(reason);
    else expect(r.text).toMatch(reason);
    expect(r.text).toContain('the full gate runs');
  };

  test('a non-stamp byte change', () => {
    refused(find(sha.code!, [run(300, sha.gated!)], { 300: binding() }), 'differs from the gated head beyond stamps: src/feature.ts');
  });

  test('CHANGELOG entry text, not only its heading', () => {
    refused(find(sha.entry!, [run(300, sha.gated!)], { 300: binding() }), 'beyond stamps: CHANGELOG.md');
  });

  test('a file outside the stamp set', () => {
    refused(find(sha.lock!, [run(300, sha.gated!)], { 300: binding() }), 'bun.lock');
    // The receipt calls a lockfile root-version bump a stamp; R2a's stamp set is narrower and still refuses it.
    refused(find(sha.lockStamp!, [run(300, sha.gatedLock!)], { 300: binding({ head_sha: sha.gatedLock }) }),
      'stamp-classified files outside the version file, package.json, CHANGELOG and release outputs: bun.lock');
  });

  test('a different base: main moved between the gate and this run', () => {
    refused(find(sha.restamp!, [run(300, sha.gated!)], { 300: binding() }, { baseSha: sha.moved }), 'main moved');
  });

  test('a missing receipt: no executed gate bound a verdict', () => {
    refused(find(sha.restamp!, [run(300, sha.gated!)], {}), 'no earlier executed gate on this PR bound a verdict');
    refused(find(sha.restamp!, [], {}), 'no earlier executed gate');
  });

  test('a missing receipt: a malformed or mismatched binding', () => {
    refused(find(sha.restamp!, [run(300, sha.gated!)], { 300: '{"schema":1' }), 'missing or malformed');
    refused(find(sha.restamp!, [run(300, sha.gated!)], { 300: binding({ run_id: 299 }) }), 'does not match the run it came from');
    refused(find(sha.restamp!, [run(300, sha.restamp!)], { 300: binding() }), 'does not match the run it came from');
  });

  test('a missing receipt: the gated head cannot be fetched, so no tree receipt exists', () => {
    const ghost = 'e'.repeat(40);
    refused(find(sha.restamp!, [run(300, ghost)], { 300: binding({ head_sha: ghost }) }), /cannot fetch|no tree receipt/);
  });

  test('a red, partial or failed gate, and a newer red that blocks an older green', () => {
    refused(find(sha.restamp!, [run(300, sha.gated!)], { 300: binding({ verdict: 'RED' }) }), 'is RED');
    refused(find(sha.restamp!, [run(300, sha.gated!)], { 300: binding({ reconcile_exit: 1 }) }), 'reconcile exit 1');
    refused(find(sha.restamp!, [run(300, sha.gated!, 'failure')], { 300: binding() }), 'conclusion failure');
    refused(find(sha.restamp!, [run(301, sha.gated!), run(300, sha.gated!)], { 301: binding({ run_id: 301, verdict: 'RED' }), 300: binding() }), 'run 301');
  });

  test('a full-profile binding, the same head, another PR, and a gh outage', () => {
    refused(find(sha.restamp!, [run(300, sha.gated!)], { 300: binding({ profile: 'full' }) }), 'not the PR gate');
    refused(find(sha.gated!, [run(300, sha.gated!)], { 300: binding() }), 'gated this same head');
    refused(find(sha.restamp!, [run(300, sha.gated!, 'success', { pull_requests: [{ number: 7 }] })], { 300: binding() }), 'no earlier executed gate');
    refused(find(sha.restamp!, [run(300, sha.gated!)], { 300: binding() }, { failList: 'HTTP 403: Resource not accessible' }), 'not authorized');
  });
});

const manifest = (over: Partial<PaidRunManifest> = {}): PaidRunManifest => ({ version: 1, tier: 'gate', evalsAll: false, sliceCount: 2,
  selectionReason: 'diff', profile: 'pr', selection: { e2e: ['case-a'], judges: [] }, prCoverage: { mode: 'pr' } as PaidRunManifest['prCoverage'],
  entries: [
    { file: 'test/a.test.ts', slice: 1, status: 'planned', estimatedMs: 1000 },
    { file: 'test/b.test.ts#case-b~t1', slice: 2, status: 'planned', trial: { kind: 'behavior', panel: { n: 3, k: 2 }, quarantined: false } },
    { file: 'test/c.test.ts', slice: 0, status: 'skipped-by-diff', reason: 'no input changed' },
  ], ...over } as PaidRunManifest);

describe('selection fingerprint and confirm', () => {
  test('slice packing and estimates do not change the fingerprint; cases, statuses and trial plans do', () => {
    const fp = selectionFingerprint(manifest());
    const repacked = manifest();
    repacked.entries = [...repacked.entries].reverse().map(e => ({ ...e, slice: e.slice ? 3 - e.slice : 0, estimatedMs: 5, reason: 'other' }));
    expect(selectionFingerprint(repacked)).toBe(fp);
    const extra = manifest();
    extra.entries = [...extra.entries, { file: 'test/d.test.ts', slice: 1, status: 'planned' }];
    const quarantined = manifest();
    quarantined.entries = quarantined.entries.map(e => e.trial ? { ...e, trial: { ...e.trial, quarantined: true } } : e);
    const skipped = manifest();
    skipped.entries = skipped.entries.map(e => e.file === 'test/a.test.ts' ? { ...e, status: 'skipped-by-diff' as const } : e);
    for (const changed of [extra, quarantined, skipped, manifest({ selection: { e2e: ['case-a', 'case-z'], judges: [] } }), manifest({ evalsAll: true })]) {
      expect(selectionFingerprint(changed)).not.toBe(fp);
    }
  });

  test('confirm reuses only when the candidate exists and the selection is identical', () => {
    const { out } = find(sha.restamp!, [run(300, sha.gated!)], { 300: binding({ selection_sha256: selectionFingerprint(manifest()) }) });
    const same = confirmReuse(out, manifest());
    expect(same.reuse?.reused_run_id).toBe(300);
    expect(same.reason).toContain('same selection');
    const extra = manifest();
    extra.entries = [...extra.entries, { file: 'test/d.test.ts', slice: 1, status: 'planned' }];
    expect(confirmReuse(out, extra).reuse).toBeNull();
    expect(confirmReuse(out, extra).reason).toContain('differs from the reused gate');
    expect(confirmReuse(out, null).reuse).toBeNull();
    expect(confirmReuse(path.join(scratch, 'no-candidate'), manifest()).reuse).toBeNull();
    const forged = path.join(scratch, 'forged');
    fs.mkdirSync(forged, { recursive: true });
    fs.writeFileSync(path.join(forged, CANDIDATE_FILE), JSON.stringify({ ...JSON.parse(fs.readFileSync(path.join(out, CANDIDATE_FILE), 'utf8')), stamp_files: [] }));
    expect(confirmReuse(forged, manifest()).reuse).toBeNull();
  });
});

describe('bind and report', () => {
  const reportDir = (name: string, withReuse = false) => {
    const dir = path.join(scratch, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest()));
    fs.writeFileSync(path.join(dir, 'collector-outcomes.json'), JSON.stringify({ verdict: { verdict: 'GREEN' } }));
    if (withReuse) fs.writeFileSync(path.join(dir, REUSE_FILE), '{}');
    return dir;
  };
  const bindArgs = { repository: REPO, pr: 42, runId: 300, runAttempt: 1, headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40), profile: 'pr', reconcileExit: 0 };

  test('an executed run binds its verdict, reconcile exit and selection; a reused run binds nothing', () => {
    const { binding: bound } = buildBinding({ ...bindArgs, reportDir: reportDir('bind-ok') });
    expect(bound).toMatchObject({ verdict: 'GREEN', reconcile_exit: 0, selection_sha256: selectionFingerprint(manifest()) });
    expect(buildBinding({ ...bindArgs, reportDir: reportDir('bind-reused', true) }).binding).toBeNull();
    const empty = path.join(scratch, 'bind-empty');
    fs.mkdirSync(empty, { recursive: true });
    expect(buildBinding({ ...bindArgs, reportDir: empty }).binding).toBeNull();
  });

  test('the CLI binds a missing reconcile exit as -1, never as a pass', () => {
    const out = path.join(scratch, 'bind-cli');
    const r = spawnSync(process.execPath, ['run', path.join(ROOT, 'scripts/gate-reuse.ts'), 'bind', reportDir('bind-cli-report'), '--out', out,
      '--repo', REPO, '--pr', '42', '--run-id', '300', '--run-attempt', '1', '--head-sha', 'a'.repeat(40), '--base-sha', 'b'.repeat(40),
      '--profile', 'pr', '--reconcile-exit', ''], { encoding: 'utf8', timeout: 30_000 });
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(fs.readFileSync(path.join(out, BINDING_FILE), 'utf8')).reconcile_exit).toBe(-1);
  });

  test('report prints the reused verdict with its receipt, and fails closed without a valid record', () => {
    const { out } = find(sha.restamp!, [run(300, sha.gated!)], { 300: binding() });
    const reuse = parseReuse(JSON.parse(fs.readFileSync(path.join(out, CANDIDATE_FILE), 'utf8')))!;
    const text = reuseReport(reuse, REPO);
    expect(text).toContain('GATE REUSED (R2a, restamp-only)');
    expect(text).toContain('TREE: same-modulo-stamps receipt=' + reuse.receipt_sha256);
    expect(text).toContain('https://github.com/garrytan/gstack/actions/runs/300');
    const bad = spawnSync(process.execPath, ['run', path.join(ROOT, 'scripts/gate-reuse.ts'), 'report', path.join(scratch, 'missing.json'), '--repo', REPO],
      { encoding: 'utf8', timeout: 30_000 });
    expect(bad.status).toBe(1);
  });
});

describe.skipIf(!Bun.which('jq') || !Bun.which('bash'))('the PR comment for a reused verdict', () => {
  test('runs no repository code and names the reused run and receipt; without reconcile exit 0 it never says PASS (reused)', () => {
    const workflow = Bun.YAML.parse(fs.readFileSync(path.join(ROOT, '.github/workflows/evals.yml'), 'utf8')) as any;
    const script = (workflow.jobs['slices-comment'].steps.find((s: any) => s.name === 'Post PR comment').run as string);
    const root = path.join(scratch, 'comment');
    const paidDir = path.join(root, 'paid-report');
    const binDir = path.join(root, 'bin');
    fs.mkdirSync(paidDir, { recursive: true });
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(path.join(binDir, 'gh'), '#!/bin/sh\ncase "$*" in *--jq*) exit 0;; esac\nfor arg do case "$arg" in body=*) printf "%s\\n" "${arg#body=}";; esac; done\n');
    fs.chmodSync(path.join(binDir, 'gh'), 0o755);
    fs.writeFileSync(path.join(binDir, 'bc'), '#!/bin/sh\nread -r expression\nprintf "0\\n"\n');
    fs.chmodSync(path.join(binDir, 'bc'), 0o755);
    const { out } = find(sha.restamp!, [run(300, sha.gated!)], { 300: binding() });
    fs.copyFileSync(path.join(out, CANDIDATE_FILE), path.join(paidDir, REUSE_FILE));
    fs.writeFileSync(path.join(paidDir, 'manifest.json'), JSON.stringify({ profile: 'pr', selection: { e2e: [], judges: [] } }));
    const body = script.replaceAll('/tmp/paid-report', paidDir).replaceAll('/tmp/verdict', path.join(root, 'verdict'))
      .replaceAll('$' + '{{ github.repository }}', REPO).replaceAll('$' + '{{ github.event.pull_request.number }}', '42');
    const exec = (reconcile: string) => spawnSync('bash', ['-e', '-c', body], { cwd: root, encoding: 'utf8', timeout: 10_000,
      env: { ...process.env, PATH: binDir + ':' + process.env.PATH, RECONCILE_EXIT: reconcile, GITHUB_REPOSITORY: REPO } });
    const reused = exec('0');
    expect(reused.status, reused.stderr).toBe(0);
    expect(reused.stdout).toContain('## E2E Evals: ✅ PASS (reused: restamp-only, R2a)');
    expect(reused.stdout).toContain('TREE: same-modulo-stamps receipt=');
    expect(reused.stdout).toContain('actions/runs/300');
    const failed = exec('1');
    expect(failed.status, failed.stderr).toBe(0);
    expect(failed.stdout).not.toContain('PASS (reused');
    expect(failed.stdout).toContain('❌ FAIL');
  });
});
