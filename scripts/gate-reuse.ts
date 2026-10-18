/**
 * Restamp-only gate reuse for the PR paid lane (R2a, GSTA-48). A gate edit:
 * a head may report the verdict of an earlier full paid gate instead of
 * running one, only when every condition below holds; anything else runs the
 * full gate.
 *
 *   bind     (slices-report, every executed pull_request run) records what the
 *            run proved: PR, head, the base SHA the merge ref was built on,
 *            the reconcile exit, the report verdict and the selection
 *            fingerprint of its manifest. Reused runs bind nothing.
 *   find     (recover-receipts, BASE-REF code, actions: read) takes the newest
 *            earlier completed run of this PR that bound a verdict. It must be
 *            GREEN with reconcile exit 0 and a successful conclusion, on the
 *            same base SHA as this run (main did not move; reuse across a
 *            main move is R2, not this), on a different head, and the tree
 *            receipt (lib/tree-receipt.ts, the base's ship policy) must say
 *            `TREE: same-modulo-stamps` with every differing file one of
 *            the policy's stamp files: the version file, package.json, the
 *            CHANGELOG and the release outputs. It writes candidate.json.
 *   confirm  (plan-slices, after this run's own plan) requires this run's
 *            selection fingerprint to equal the bound one, so the reused
 *            verdict covers exactly the cases and trial plans this head would
 *            run. It writes gate-reuse.json and `reuse=true`.
 *   report   (slices-report) prints the reused verdict and its evidence.
 *
 * Every failure (no binding, a red or partial verdict, a moved base, a
 * non-stamp byte, a missing receipt, gh or git errors, a selection change)
 * leaves no candidate, and the run executes the full gate.
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { receiptDigest } from '../lib/ship-queue';
import { isUnavailable, loadPolicyFromBase } from '../lib/ship-policy';
import { buildReceipt } from '../lib/tree-receipt';
import { acceptedRun, ghFailureReason, runGh, type GhRunner, type WorkflowRun } from './recover-receipts';
import type { PaidRunManifest } from './lib/paid-plan';

export const BINDING_FILE = 'gate-binding.json';
export const CANDIDATE_FILE = 'candidate.json';
export const REUSE_FILE = 'gate-reuse.json';
const SHA = /^[0-9a-f]{40}$/;

export interface GateBinding {
  schema: 1;
  repository: string;
  pr: number;
  run_id: number;
  run_attempt: number;
  head_sha: string;
  base_sha: string;
  profile: string;
  reconcile_exit: number;
  verdict: string;
  selection_sha256: string;
}

export interface GateReuse {
  schema: 1;
  pr: number;
  reused_run_id: number;
  reused_run_attempt: number;
  gated_head: string;
  current_head: string;
  base_sha: string;
  tree: 'same-modulo-stamps';
  receipt_sha256: string;
  stamp_files: string[];
  old_version: string | null;
  new_version: string | null;
  selection_sha256: string;
}

/** The cases, trial plans and verdict-relevant plan fields a run executes; slice packing and receipts are excluded. */
export function selectionFingerprint(manifest: PaidRunManifest): string {
  const entries = manifest.entries
    .map(entry => ({ file: entry.file, status: entry.status, trial: entry.trial ?? null, excludeCases: entry.excludeCases ?? null }))
    .sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  const body = { tier: manifest.tier, evalsAll: manifest.evalsAll, profile: manifest.profile ?? null, selection: manifest.selection ?? null,
    mode: manifest.prCoverage?.mode ?? null, entries };
  return createHash('sha256').update(JSON.stringify(body)).digest('hex');
}

export function readJson<T>(file: string): T | null {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) as T; } catch { return null; }
}

export function parseBinding(value: unknown): GateBinding | null {
  const b = value as GateBinding | null;
  if (!b || b.schema !== 1 || typeof b.repository !== 'string' || !Number.isSafeInteger(b.pr) || !Number.isSafeInteger(b.run_id)
    || !Number.isSafeInteger(b.run_attempt) || !SHA.test(b.head_sha ?? '') || !SHA.test(b.base_sha ?? '') || typeof b.profile !== 'string'
    || !Number.isSafeInteger(b.reconcile_exit) || typeof b.verdict !== 'string' || !/^[0-9a-f]{64}$/.test(b.selection_sha256 ?? '')) return null;
  return b;
}

export function parseReuse(value: unknown): GateReuse | null {
  const r = value as GateReuse | null;
  if (!r || r.schema !== 1 || r.tree !== 'same-modulo-stamps' || !Number.isSafeInteger(r.pr) || !Number.isSafeInteger(r.reused_run_id)
    || !SHA.test(r.gated_head ?? '') || !SHA.test(r.current_head ?? '') || !SHA.test(r.base_sha ?? '') || r.gated_head === r.current_head
    || !/^[0-9a-f]{64}$/.test(r.receipt_sha256 ?? '') || !/^[0-9a-f]{64}$/.test(r.selection_sha256 ?? '')
    || !Array.isArray(r.stamp_files) || r.stamp_files.length === 0) return null;
  return r;
}

/** slices-report: what this executed run proved, or why it binds nothing. */
export function buildBinding(o: { repository: string; pr: number; runId: number; runAttempt: number; headSha: string; baseSha: string;
  profile: string; reconcileExit: number; reportDir: string }): { binding: GateBinding | null; reason: string } {
  if (fs.existsSync(path.join(o.reportDir, REUSE_FILE))) return { binding: null, reason: 'this run reused a verdict; only executed gates bind' };
  const manifest = readJson<PaidRunManifest>(path.join(o.reportDir, 'manifest.json'));
  if (!manifest?.entries) return { binding: null, reason: 'no readable manifest' };
  const outcomes = readJson<{ verdict?: { verdict?: string } }>(path.join(o.reportDir, 'collector-outcomes.json'));
  const binding: GateBinding = { schema: 1, repository: o.repository, pr: o.pr, run_id: o.runId, run_attempt: o.runAttempt,
    head_sha: o.headSha, base_sha: o.baseSha, profile: o.profile, reconcile_exit: o.reconcileExit,
    verdict: outcomes?.verdict?.verdict ?? 'MISSING', selection_sha256: selectionFingerprint(manifest) };
  return parseBinding(binding) ? { binding, reason: `bound ${binding.verdict} (reconcile exit ${binding.reconcile_exit})` } : { binding: null, reason: 'binding fields are incomplete' };
}

export interface FindOptions {
  repo: string;
  pr: number;
  headRepo: string;
  branch: string;
  selfRunId: number;
  headSha: string;
  baseSha: string;
  /** The base-ref checkout the receipt runs in (its HEAD must be baseSha). */
  repoRoot: string;
  out: string;
  budgetMs?: number;
  maxRuns?: number;
  gh?: GhRunner;
  git?: (args: string[]) => { ok: boolean; out: string };
  now?: () => number;
}

const gitIn = (cwd: string) => (args: string[]) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 120_000, maxBuffer: 64 * 1024 * 1024 });
  return { ok: r.status === 0, out: (r.stdout ?? '').trim() || (r.stderr ?? '').trim() };
};

/** Never throws for an expected refusal: no candidate means the full gate runs, with the reason named. */
export function findReusableGate(o: FindOptions): { candidate: GateReuse | null; lines: string[] } {
  const gh = o.gh ?? runGh;
  const git = o.git ?? gitIn(o.repoRoot);
  const now = o.now ?? Date.now;
  const deadline = now() + (o.budgetMs ?? 90_000);
  const left = () => Math.max(1_000, deadline - now());
  const lines: string[] = [];
  const refuse = (reason: string) => { lines.push(`no restamp-only reuse: ${reason}; the full gate runs`); return { candidate: null, lines }; };
  if (!SHA.test(o.headSha) || !SHA.test(o.baseSha)) return refuse('this run has no exact head and base SHA');

  const listed = gh(['api', '-X', 'GET', `repos/${o.repo}/actions/workflows/evals.yml/runs`, '-f', 'event=pull_request', '-f', `branch=${o.branch}`, '-f', 'per_page=50'], left());
  if (listed.status !== 0) return refuse(ghFailureReason(listed.stderr));
  let runs: WorkflowRun[];
  try { runs = (JSON.parse(listed.stdout).workflow_runs ?? []) as WorkflowRun[]; } catch { return refuse('gh returned an unreadable run list'); }
  const scope = { pr: o.pr, headRepo: o.headRepo, selfRunId: o.selfRunId };
  const older = runs.filter(run => acceptedRun(run, scope) && run.id < o.selfRunId && run.status === 'completed')
    .sort((a, b) => b.id - a.id).slice(0, o.maxRuns ?? 10);

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-reuse-'));
  try {
    let found: { run: WorkflowRun; binding: GateBinding | null } | null = null;
    for (const run of older) {
      const names = gh(['api', '-X', 'GET', `repos/${o.repo}/actions/runs/${run.id}/artifacts`, '-f', 'per_page=100'], left());
      if (names.status !== 0) return refuse(`cannot list run ${run.id}'s artifacts (${ghFailureReason(names.stderr)})`);
      let artifact: string | undefined;
      try {
        artifact = (JSON.parse(names.stdout).artifacts ?? [])
          .filter((a: { name: string; expired?: boolean }) => !a.expired && /^gate-binding-a\d+$/.test(a.name))
          .map((a: { name: string }) => a.name).sort((a: string, b: string) => Number(b.slice(14)) - Number(a.slice(14)))[0];
      } catch { return refuse(`run ${run.id}'s artifact list is unreadable`); }
      if (!artifact) continue;
      const dir = path.join(work, String(run.id));
      const got = gh(['run', 'download', String(run.id), '-R', o.repo, '-n', artifact, '-D', dir], left());
      if (got.status !== 0) return refuse(`cannot download ${artifact} of run ${run.id} (${ghFailureReason(got.stderr)})`);
      found = { run, binding: parseBinding(readJson(path.join(dir, BINDING_FILE))) };
      break;
    }
    if (!found) return refuse('no earlier executed gate on this PR bound a verdict');
    const { run, binding } = found;
    if (!binding) return refuse(`run ${run.id}'s gate binding is missing or malformed`);
    if (binding.run_id !== run.id || binding.pr !== o.pr || binding.repository !== o.repo || binding.head_sha !== run.head_sha) {
      return refuse(`run ${run.id}'s gate binding does not match the run it came from`);
    }
    if (run.conclusion !== 'success' || binding.verdict !== 'GREEN' || binding.reconcile_exit !== 0) {
      return refuse(`the newest executed gate (run ${run.id}, ${binding.head_sha.slice(0, 12)}) is ${binding.verdict}, reconcile exit ${binding.reconcile_exit}, conclusion ${run.conclusion}`);
    }
    if (binding.profile !== 'pr') return refuse(`run ${run.id} ran the ${binding.profile} profile, not the PR gate`);
    if (binding.base_sha !== o.baseSha) {
      return refuse(`main moved: run ${run.id} gated on base ${binding.base_sha.slice(0, 12)}, this run's base is ${o.baseSha.slice(0, 12)} (reuse across a main move is R2, which is not enabled)`);
    }
    if (binding.head_sha === o.headSha) return refuse(`run ${run.id} gated this same head; a re-run executes fresh`);

    const head = git(['rev-parse', 'HEAD']);
    if (!head.ok || head.out !== o.baseSha) return refuse(`the receipt checkout is ${head.out.slice(0, 12) || 'unreadable'}, not the base ${o.baseSha.slice(0, 12)}`);
    const fetched = git(['fetch', '--no-tags', '--depth=1', 'origin', binding.head_sha, o.headSha]);
    if (!fetched.ok) return refuse(`cannot fetch ${binding.head_sha.slice(0, 12)} and ${o.headSha.slice(0, 12)} (${fetched.out.split('\n')[0]})`);
    const pinned = git(['update-ref', 'refs/remotes/origin/gate-reuse-base', o.baseSha]);
    if (!pinned.ok) return refuse('cannot pin the base ref for the policy');
    const policy = loadPolicyFromBase(o.repoRoot, 'gate-reuse-base');
    if (isUnavailable(policy)) return refuse(`the base's ship policy is unavailable (${policy.detail})`);
    if (policy.errors.length) return refuse(`the base's ship policy is invalid (${policy.errors[0]!.message})`);
    const receipt = buildReceipt({ repoRoot: o.repoRoot, gated: binding.head_sha, current: o.headSha, policy: policy.policy, policyLabel: policy.source.label });
    if ('error' in receipt) return refuse(`no tree receipt: ${receipt.error}`);
    lines.push(`TREE: ${receipt.tree === 'changed' ? `changed (${receipt.residual.join(', ')})` : 'same-modulo-stamps'} (${binding.head_sha.slice(0, 12)} -> ${o.headSha.slice(0, 12)}, policy ${receipt.policy})`);
    if (receipt.tree !== 'same-modulo-stamps') return refuse(`${o.headSha.slice(0, 12)} differs from the gated head beyond stamps: ${receipt.residual.join(', ')}`);
    const stampFiles = receipt.files.map(file => file.path);
    const allowed = new Set([receipt.files.find(f => f.rule === 'version-file')?.path ?? 'VERSION', 'package.json', policy.policy.changelog ?? '']);
    const outside = stampFiles.filter(file => !allowed.has(file) && !policy.policy.release_outputs.includes(file));
    if (outside.length) return refuse(`stamp-classified files outside the version file, package.json, CHANGELOG and release outputs: ${outside.join(', ')}`);
    if (!stampFiles.length) return refuse('the heads differ by no stamp file');
    const candidate: GateReuse = { schema: 1, pr: o.pr, reused_run_id: run.id, reused_run_attempt: binding.run_attempt,
      gated_head: binding.head_sha, current_head: o.headSha, base_sha: o.baseSha, tree: 'same-modulo-stamps',
      receipt_sha256: receiptDigest(receipt), stamp_files: stampFiles, old_version: receipt.old_version, new_version: receipt.new_version,
      selection_sha256: binding.selection_sha256 };
    fs.mkdirSync(o.out, { recursive: true });
    fs.writeFileSync(path.join(o.out, CANDIDATE_FILE), `${JSON.stringify(candidate, null, 2)}\n`);
    lines.push(`restamp-only candidate: run ${run.id} passed the full gate at ${binding.head_sha.slice(0, 12)} on base ${o.baseSha.slice(0, 12)}; stamp files ${stampFiles.join(', ')}; receipt ${candidate.receipt_sha256}; plan-slices confirms the selection`);
    return { candidate, lines };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

/** plan-slices: the reuse holds only when this head's own plan selects exactly what the reused gate ran. */
export function confirmReuse(candidateDir: string, manifest: PaidRunManifest | null): { reuse: GateReuse | null; reason: string } {
  const candidate = parseReuse(readJson(path.join(candidateDir, CANDIDATE_FILE)));
  if (!candidate) return { reuse: null, reason: 'no restamp-only candidate; the full gate runs' };
  if (!manifest?.entries) return { reuse: null, reason: 'this run has no readable plan; the full gate runs' };
  const fingerprint = selectionFingerprint(manifest);
  if (fingerprint !== candidate.selection_sha256) {
    return { reuse: null, reason: `this head's selection ${fingerprint.slice(0, 12)} differs from the reused gate's ${candidate.selection_sha256.slice(0, 12)}; the full gate runs` };
  }
  return { reuse: candidate, reason: `reusing run ${candidate.reused_run_id}'s GREEN verdict at ${candidate.gated_head.slice(0, 12)}: TREE same-modulo-stamps (${candidate.stamp_files.join(', ')}), same base ${candidate.base_sha.slice(0, 12)}, same selection ${fingerprint.slice(0, 12)}` };
}

export function reuseReport(reuse: GateReuse, repo: string): string {
  return [
    `GATE REUSED (R2a, restamp-only): no paid case ran on ${reuse.current_head}`,
    `reused verdict: GREEN from run ${reuse.reused_run_id} attempt ${reuse.reused_run_attempt} at ${reuse.gated_head} (https://github.com/${repo}/actions/runs/${reuse.reused_run_id})`,
    `base: ${reuse.base_sha} (unchanged since that gate)`,
    `TREE: same-modulo-stamps receipt=${reuse.receipt_sha256}`,
    `stamp files: ${reuse.stamp_files.join(', ')} (${reuse.old_version ?? '-'} -> ${reuse.new_version ?? '-'})`,
    `selection: ${reuse.selection_sha256} (identical to the reused gate)`,
    'cost: $0 (no trials executed)',
  ].join('\n');
}

const USAGE = `usage:
  bun run scripts/gate-reuse.ts bind <report dir> --out <dir> --repo <owner/name> --pr <n> --run-id <id> --run-attempt <n>
      --head-sha <sha> --base-sha <sha> --profile <pr|full> --reconcile-exit <n>
  bun run scripts/gate-reuse.ts find --repo <owner/name> --pr <n> --head-repo <owner/name> --branch <head branch> --run-id <id>
      --head-sha <sha> --base-sha <sha> --out <dir> [--budget-seconds 90]
  bun run scripts/gate-reuse.ts confirm <candidate dir> <manifest.json> --out <paid-plan dir> [--github-output <file>]
  bun run scripts/gate-reuse.ts report <gate-reuse.json> --repo <owner/name>
bind and find never fail the run; no candidate means the full gate runs.`;

if (import.meta.main) {
  const [command, ...rest] = process.argv.slice(2);
  const flag = (name: string) => { const i = rest.indexOf(`--${name}`); return i >= 0 ? rest[i + 1] : undefined; };
  const int = (name: string) => Number(flag(name));
  const usage = () => { console.error(USAGE); process.exit(2); };
  if (command === 'bind') {
    const [reportDir, out, repository, headSha, baseSha, profile] = [rest[0], flag('out'), flag('repo'), flag('head-sha'), flag('base-sha'), flag('profile')];
    if (!reportDir || !out || !repository || !headSha || !baseSha || !profile) usage();
    const { binding, reason } = buildBinding({ repository: repository!, pr: int('pr'), runId: int('run-id'), runAttempt: int('run-attempt'),
      headSha: headSha!, baseSha: baseSha!, profile: profile!, reconcileExit: /^\d+$/.test(flag('reconcile-exit') ?? '') ? int('reconcile-exit') : -1, reportDir: reportDir! });
    if (binding) {
      fs.mkdirSync(out!, { recursive: true });
      fs.writeFileSync(path.join(out!, BINDING_FILE), `${JSON.stringify(binding, null, 2)}\n`);
    }
    console.log(`- Gate binding: ${reason}`);
  } else if (command === 'find') {
    const [repo, headRepo, branch, headSha, baseSha, out] = [flag('repo'), flag('head-repo'), flag('branch'), flag('head-sha'), flag('base-sha'), flag('out')];
    if (!repo || !headRepo || !branch || !headSha || !baseSha || !out || !Number.isSafeInteger(int('pr')) || !Number.isSafeInteger(int('run-id'))) usage();
    const { lines } = findReusableGate({ repo: repo!, pr: int('pr'), headRepo: headRepo!, branch: branch!, selfRunId: int('run-id'), headSha: headSha!,
      baseSha: baseSha!, repoRoot: process.cwd(), out: out!, budgetMs: Number(flag('budget-seconds') ?? '90') * 1000 });
    console.log('### Restamp-only gate reuse (R2a)');
    for (const line of lines) console.log(`- ${line}`);
  } else if (command === 'confirm') {
    const [dir, manifestPath, out] = [rest[0], rest[1], flag('out')];
    if (!dir || !manifestPath || !out) usage();
    const { reuse, reason } = confirmReuse(dir!, readJson<PaidRunManifest>(manifestPath!));
    if (reuse) {
      fs.mkdirSync(out!, { recursive: true });
      fs.writeFileSync(path.join(out!, REUSE_FILE), `${JSON.stringify(reuse, null, 2)}\n`);
    }
    const output = flag('github-output');
    if (output) fs.appendFileSync(output, `gate_reuse=${reuse ? 'true' : 'false'}\n`);
    console.log(`- Restamp-only gate reuse (R2a): ${reason}`);
  } else if (command === 'report') {
    const reuse = parseReuse(readJson(rest[0] ?? ''));
    const repo = flag('repo');
    if (!reuse || !repo) { console.error('gate-reuse report: the reuse record is missing or malformed; the gate is not green'); process.exit(1); }
    console.log(reuseReport(reuse!, repo!));
  } else usage();
}
