/**
 * Paid-gate verdict reuse for the PR lane (GSTA-48). A gate edit: a head may
 * report the verdict of an earlier full paid gate instead of running one only
 * when every condition below holds; anything else runs the full gate.
 *
 *   bind     (slices-report, every executed pull_request run) records what the
 *            run proved: PR, head, the base its merge commit was built on
 *            (the tested commit's first parent), the reconcile exit, the
 *            report verdict and its plan's selection fingerprint. Reused runs
 *            bind nothing, so reuse never chains off a reuse.
 *   find     (recover-receipts, BASE-REF code, actions: read) takes the newest
 *            earlier completed run of this PR that bound a verdict. It must be
 *            GREEN with reconcile exit 0 and a successful conclusion, ran the
 *            PR profile, and gated a different head. Then one of:
 *              restamp-only (R2a): same base; the tree receipt
 *                (lib/tree-receipt.ts, the base's ship policy) says
 *                `TREE: same-modulo-stamps` and every differing file is a stamp
 *                file (the version file, package.json, the CHANGELOG, the
 *                release outputs).
 *              main-moved (R2): the base moved; the PR's own diff from its
 *                merge-base, excluding stamp files, is byte-identical to the
 *                gated head's (package.json compared without its version,
 *                the CHANGELOG by the PR's own section bodies).
 *            It writes candidate.json.
 *   confirm  (plan-slices, after this run's own plan) requires this head's
 *            selection fingerprint to equal the bound one, so the reused
 *            verdict covers exactly the cases and trial plans this head would
 *            run. It writes gate-reuse.json and `gate_reuse=true`.
 *   report   (slices-report) prints the reused verdict: which run, which head,
 *            and why.
 *
 * Every failure (no binding, a red, partial or cancelled gate, a non-stamp
 * byte, a missing receipt or merge-base, gh or git errors, a selection change)
 * leaves no candidate, and the run executes the full gate. The free suite and
 * every other check run on the new head regardless.
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseChangelog } from '../lib/changelog-check';
import { receiptDigest } from '../lib/ship-queue';
import { isUnavailable, loadPolicyFromBase, type ShipPolicy } from '../lib/ship-policy';
import { buildReceipt } from '../lib/tree-receipt';
import { acceptedRun, ghFailureReason, runGh, type GhRunner, type WorkflowRun } from './recover-receipts';
import type { PaidRunManifest } from './lib/paid-plan';

export const BINDING_FILE = 'gate-binding.json';
export const CANDIDATE_FILE = 'candidate.json';
export const REUSE_FILE = 'gate-reuse.json';
const SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;

export interface GateBinding {
  schema: 1;
  repository: string;
  pr: number;
  run_id: number;
  run_attempt: number;
  head_sha: string;
  /** The tested merge commit's first parent: the main the gate actually ran against. */
  base_sha: string;
  profile: string;
  reconcile_exit: number;
  verdict: string;
  /** Cases accepted manually (unscored); a gate with any is never reused as a clean pass. */
  manual_accepted: number;
  selection_sha256: string;
}

export interface GateReuse {
  schema: 1;
  kind: 'restamp-only' | 'main-moved';
  pr: number;
  reused_run_id: number;
  reused_run_attempt: number;
  gated_head: string;
  current_head: string;
  gated_base: string;
  base_sha: string;
  selection_sha256: string;
  /** One sentence: why this head may carry that verdict. */
  why: string;
  /** restamp-only: the tree receipt. */
  receipt_sha256?: string;
  stamp_files?: string[];
  old_version?: string | null;
  new_version?: string | null;
  /** main-moved: the merge-bases and the identical own-diff signature. */
  gated_merge_base?: string;
  merge_base?: string;
  own_diff_sha256?: string;
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
    || !Number.isSafeInteger(b.reconcile_exit) || typeof b.verdict !== 'string' || !Number.isSafeInteger(b.manual_accepted) || b.manual_accepted < 0 || !SHA256.test(b.selection_sha256 ?? '')) return null;
  return b;
}

export function parseReuse(value: unknown): GateReuse | null {
  const r = value as GateReuse | null;
  if (!r || r.schema !== 1 || !Number.isSafeInteger(r.pr) || !Number.isSafeInteger(r.reused_run_id) || !Number.isSafeInteger(r.reused_run_attempt)
    || !SHA.test(r.gated_head ?? '') || !SHA.test(r.current_head ?? '') || r.gated_head === r.current_head
    || !SHA.test(r.gated_base ?? '') || !SHA.test(r.base_sha ?? '') || !SHA256.test(r.selection_sha256 ?? '') || typeof r.why !== 'string') return null;
  if (r.kind === 'restamp-only') {
    return r.gated_base === r.base_sha && SHA256.test(r.receipt_sha256 ?? '') && Array.isArray(r.stamp_files) && r.stamp_files.length > 0 ? r : null;
  }
  if (r.kind === 'main-moved') {
    return r.gated_base !== r.base_sha && SHA.test(r.gated_merge_base ?? '') && SHA.test(r.merge_base ?? '') && SHA256.test(r.own_diff_sha256 ?? '') ? r : null;
  }
  return null;
}

type Git = (args: string[]) => { ok: boolean; out: string };
const gitIn = (cwd: string): Git => (args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 120_000, maxBuffer: 256 * 1024 * 1024 });
  return r.status === 0 ? { ok: true, out: r.stdout ?? '' } : { ok: false, out: (r.stderr || String(r.error ?? '')).trim() };
};

/** A merge commit's parents from its own object, so a depth-1 checkout can read them. */
export function commitParents(git: Git, commit: string): string[] | null {
  const shown = git(['cat-file', '-p', commit]);
  if (!shown.ok) return null;
  return shown.out.split('\n').filter(line => line.startsWith('parent ')).map(line => line.slice(7).trim());
}

/** The tested commit of a pull_request run is the merge of the head into the base; returns that base. */
export function testedBase(git: Git, tested: string, head: string): { base: string } | { error: string } {
  const parents = commitParents(git, tested);
  if (!parents) return { error: `the tested commit ${tested.slice(0, 12)} is not readable` };
  if (parents.length !== 2 || parents[1] !== head || !SHA.test(parents[0]!)) {
    return { error: `the tested commit ${tested.slice(0, 12)} is not the merge of ${head.slice(0, 12)} into a base` };
  }
  return { base: parents[0]! };
}

/** The files whose differences count as stamps under the base's policy. */
function stampSet(policy: ShipPolicy): { version: string; changelog: string | null; releaseOutputs: string[] } {
  return { version: 'VERSION', changelog: policy.changelog ?? null, releaseOutputs: policy.release_outputs };
}

/**
 * The PR's own diff from its merge-base with stamp files taken out: the full
 * binary patch of every other path (pre-image blob ids included, so a file
 * main also changed under the PR is a difference), package.json without its
 * version, and the CHANGELOG sections the PR added, without their headings.
 */
export function ownDiffSignature(git: Git, mergeBase: string, head: string, stamps: ReturnType<typeof stampSet>): { sha256: string } | { error: string } {
  const excluded = [stamps.version, 'package.json', ...(stamps.changelog ? [stamps.changelog] : []), ...stamps.releaseOutputs];
  const patch = git(['diff', '--no-ext-diff', '--no-renames', '--no-color', '--binary', '--full-index', mergeBase, head, '--', '.',
    ...excluded.map(file => `:(exclude)${file}`)]);
  if (!patch.ok) return { error: `git diff ${mergeBase.slice(0, 12)} ${head.slice(0, 12)} failed (${patch.out.split('\n')[0]})` };
  const blob = (rev: string, file: string) => { const r = git(['show', `${rev}:${file}`]); return r.ok ? r.out : null; };
  const manifest = (text: string | null) => {
    if (text === null) return null;
    try { const parsed = JSON.parse(text); delete parsed.version; return JSON.stringify(parsed); } catch { return text; }
  };
  const [pkgBase, pkgHead] = [manifest(blob(mergeBase, 'package.json')), manifest(blob(head, 'package.json'))];
  const sections = (text: string | null) => text === null ? [] : parseChangelog(text).sections.map(s => s.lines.slice(1).join('\n').replace(/\n+$/, ''));
  const own: string[] = [];
  if (stamps.changelog) {
    const before = sections(blob(mergeBase, stamps.changelog));
    for (const body of sections(blob(head, stamps.changelog))) {
      const i = before.indexOf(body);
      if (i >= 0) before.splice(i, 1);
      else own.push(body);
    }
  }
  const body = { patch: patch.out, package: pkgBase === pkgHead ? null : [pkgBase, pkgHead], changelog: own.sort() };
  return { sha256: createHash('sha256').update(JSON.stringify(body)).digest('hex') };
}

/** slices-report: what this executed run proved, or why it binds nothing. */
export function buildBinding(o: { repository: string; pr: number; runId: number; runAttempt: number; headSha: string; baseSha: string | null;
  profile: string; reconcileExit: number; reportDir: string }): { binding: GateBinding | null; reason: string } {
  if (fs.existsSync(path.join(o.reportDir, REUSE_FILE))) return { binding: null, reason: 'this run reused a verdict; only executed gates bind' };
  if (!o.baseSha) return { binding: null, reason: 'the tested base is unknown' };
  const manifest = readJson<PaidRunManifest>(path.join(o.reportDir, 'manifest.json'));
  if (!manifest?.entries) return { binding: null, reason: 'no readable manifest' };
  const outcomes = readJson<{ verdict?: { verdict?: string }; totals?: { manual_accepted?: number } }>(path.join(o.reportDir, 'collector-outcomes.json'));
  const binding: GateBinding = { schema: 1, repository: o.repository, pr: o.pr, run_id: o.runId, run_attempt: o.runAttempt,
    head_sha: o.headSha, base_sha: o.baseSha, profile: o.profile, reconcile_exit: o.reconcileExit,
    verdict: outcomes?.verdict?.verdict ?? 'MISSING', manual_accepted: outcomes?.totals?.manual_accepted ?? -1, selection_sha256: selectionFingerprint(manifest) };
  return parseBinding(binding)
    ? { binding, reason: `bound ${binding.verdict} at ${binding.head_sha.slice(0, 12)} on base ${binding.base_sha.slice(0, 12)} (reconcile exit ${binding.reconcile_exit})` }
    : { binding: null, reason: 'binding fields are incomplete' };
}

/**
 * A newer completed run with no binding is passed over only when no paid
 * slice of it finished: superseded, readiness-blocked, a reuse, or cancelled
 * before or during its slices. A slice that finished (success, failure,
 * timed out) without a bound verdict blocks reuse of an older GREEN, so a
 * newer red or partial result is never skipped.
 */
export function unboundRunVerdict(gh: GhRunner, repo: string, run: WorkflowRun, timeoutMs: number): string | null {
  const listed = gh(['api', '-X', 'GET', `repos/${repo}/actions/runs/${run.id}/jobs`, '-f', 'filter=latest', '-f', 'per_page=100'], timeoutMs);
  if (listed.status !== 0) return `cannot list run ${run.id}'s jobs (${ghFailureReason(listed.stderr)})`;
  let slices: Array<{ name: string; conclusion: string | null }>;
  try {
    slices = ((JSON.parse(listed.stdout).jobs ?? []) as Array<{ name: string; conclusion: string | null }>)
      .filter(job => job.name === 'eval-slices' || job.name.startsWith('eval-slices '));
  } catch { return `run ${run.id}'s job list is unreadable`; }
  const finished = slices.find(job => job.conclusion !== null && job.conclusion !== 'skipped' && job.conclusion !== 'cancelled');
  return finished
    ? `newer run ${run.id} (${run.head_sha.slice(0, 12)}) finished a paid slice (${finished.conclusion}) but bound no verdict (conclusion ${run.conclusion})`
    : null;
}

export interface FindOptions {
  repo: string;
  pr: number;
  headRepo: string;
  branch: string;
  selfRunId: number;
  headSha: string;
  /** This run's tested merge commit (github.sha); its first parent is the base. */
  testedSha: string;
  /** A base-ref checkout to fetch into and run the receipt in. */
  repoRoot: string;
  out: string;
  budgetMs?: number;
  maxRuns?: number;
  gh?: GhRunner;
  git?: Git;
  now?: () => number;
}

/** Never throws for an expected refusal: no candidate means the full gate runs, with the reason named. */
export function findReusableGate(o: FindOptions): { candidate: GateReuse | null; lines: string[] } {
  const gh = o.gh ?? runGh;
  const git = o.git ?? gitIn(o.repoRoot);
  const now = o.now ?? Date.now;
  const deadline = now() + (o.budgetMs ?? 90_000);
  const left = () => Math.max(1_000, deadline - now());
  const lines: string[] = [];
  const refuse = (reason: string) => { lines.push(`no gate reuse: ${reason}; the full gate runs`); return { candidate: null, lines }; };
  if (!SHA.test(o.headSha) || !SHA.test(o.testedSha)) return refuse('this run has no exact head and tested commit');

  const listed = gh(['api', '-X', 'GET', `repos/${o.repo}/actions/workflows/evals.yml/runs`, '-f', 'event=pull_request', '-f', `branch=${o.branch}`, '-f', 'per_page=50'], left());
  if (listed.status !== 0) return refuse(ghFailureReason(listed.stderr));
  let runs: WorkflowRun[];
  try { runs = (JSON.parse(listed.stdout).workflow_runs ?? []) as WorkflowRun[]; } catch { return refuse('gh returned an unreadable run list'); }
  const scope = { pr: o.pr, headRepo: o.headRepo, selfRunId: o.selfRunId };
  const older = runs.filter(run => acceptedRun(run, scope) && run.id < o.selfRunId)
    .sort((a, b) => b.id - a.id).slice(0, o.maxRuns ?? 10);

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-reuse-'));
  try {
    let found: { run: WorkflowRun; binding: GateBinding | null } | null = null;
    for (const run of older) {
      const names = gh(['api', '-X', 'GET', `repos/${o.repo}/actions/runs/${run.id}/artifacts`, '-f', 'per_page=100'], left());
      if (names.status !== 0) return refuse(`cannot list run ${run.id}'s artifacts (${ghFailureReason(names.stderr)})`);
      let artifact: string | undefined;
      let sliceEvidence: string | undefined;
      try {
        const listedNames = ((JSON.parse(names.stdout).artifacts ?? []) as Array<{ name: string; expired?: boolean }>).map(a => a.name);
        artifact = listedNames.filter(name => /^gate-binding-a\d+$/.test(name)).sort((a, b) => Number(b.slice(14)) - Number(a.slice(14)))[0];
        sliceEvidence = listedNames.find(name => name.startsWith('paid-slice-'));
      } catch { return refuse(`run ${run.id}'s artifact list is unreadable`); }
      if (run.status !== 'completed') return refuse(`newer run ${run.id} (${run.head_sha.slice(0, 12)}) is still ${run.status}`);
      if (!artifact) {
        if (sliceEvidence) return refuse(`newer run ${run.id} (${run.head_sha.slice(0, 12)}) holds paid slice results (${sliceEvidence}) but bound no verdict`);
        const unbound = unboundRunVerdict(gh, o.repo, run, left());
        if (unbound) return refuse(unbound);
        continue;
      }
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
    if (binding.manual_accepted !== 0) {
      return refuse(`run ${run.id}'s GREEN includes ${binding.manual_accepted} manually accepted (unscored) case(s), which reuse would present as a clean pass`);
    }
    if (binding.profile !== 'pr') return refuse(`run ${run.id} ran the ${binding.profile} profile, not the PR gate`);
    if (binding.head_sha === o.headSha) return refuse(`run ${run.id} gated this same head; a re-run executes fresh`);

    const fetched = git(['fetch', '--no-tags', '--depth=1', 'origin', binding.head_sha, o.headSha, o.testedSha]);
    if (!fetched.ok) return refuse(`cannot fetch the gated and current commits (${fetched.out.split('\n')[0]})`);
    const tested = testedBase(git, o.testedSha, o.headSha);
    if ('error' in tested) return refuse(tested.error);
    const baseSha = tested.base;
    const fetchedBase = git(['fetch', '--no-tags', '--depth=1', 'origin', baseSha]);
    const pinned = fetchedBase.ok && git(['update-ref', 'refs/remotes/origin/gate-reuse-base', baseSha]).ok;
    if (!pinned) return refuse(`cannot pin this run's base ${baseSha.slice(0, 12)} for the policy`);
    const policy = loadPolicyFromBase(o.repoRoot, 'gate-reuse-base');
    if (isUnavailable(policy)) return refuse(`the base's ship policy is unavailable (${policy.detail})`);
    if (policy.errors.length) return refuse(`the base's ship policy is invalid (${policy.errors[0]!.message})`);
    const common = { schema: 1 as const, pr: o.pr, reused_run_id: run.id, reused_run_attempt: binding.run_attempt, gated_head: binding.head_sha,
      current_head: o.headSha, gated_base: binding.base_sha, base_sha: baseSha, selection_sha256: binding.selection_sha256 };

    let candidate: GateReuse;
    if (binding.base_sha === baseSha) {
      const receipt = buildReceipt({ repoRoot: o.repoRoot, gated: binding.head_sha, current: o.headSha, policy: policy.policy, policyLabel: policy.source.label });
      if ('error' in receipt) return refuse(`no tree receipt: ${receipt.error}`);
      lines.push(`TREE: ${receipt.tree === 'changed' ? `changed (${receipt.residual.join(', ')})` : 'same-modulo-stamps'} (${binding.head_sha.slice(0, 12)} -> ${o.headSha.slice(0, 12)}, policy ${receipt.policy})`);
      if (receipt.tree !== 'same-modulo-stamps') return refuse(`${o.headSha.slice(0, 12)} differs from the gated head beyond stamps: ${receipt.residual.join(', ')}`);
      const stampFiles = receipt.files.map(file => file.path);
      const stamps = stampSet(policy.policy);
      const allowed = new Set([stamps.version, 'package.json', ...(stamps.changelog ? [stamps.changelog] : []), ...stamps.releaseOutputs]);
      const outside = stampFiles.filter(file => !allowed.has(file));
      if (outside.length) return refuse(`stamp-classified files outside the version file, package.json, CHANGELOG and release outputs: ${outside.join(', ')}`);
      if (!stampFiles.length) return refuse('the heads differ by no stamp file');
      candidate = { ...common, kind: 'restamp-only', receipt_sha256: receiptDigest(receipt), stamp_files: stampFiles,
        old_version: receipt.old_version, new_version: receipt.new_version,
        why: `main has not moved (base ${baseSha.slice(0, 12)}) and ${o.headSha.slice(0, 12)} differs from ${binding.head_sha.slice(0, 12)} only by stamp files (${stampFiles.join(', ')}): TREE same-modulo-stamps` };
    } else {
      const mergeBase = (base: string, head: string) => {
        const r = gh(['api', `repos/${o.repo}/compare/${base}...${head}`, '--jq', '.merge_base_commit.sha'], left());
        const sha = r.stdout.trim();
        return r.status === 0 && SHA.test(sha) ? sha : null;
      };
      const [gatedMb, currentMb] = [mergeBase(binding.base_sha, binding.head_sha), mergeBase(baseSha, o.headSha)];
      if (!gatedMb || !currentMb) return refuse('a merge-base is unavailable, so the own diffs cannot be compared');
      const fetchedMb = git(['fetch', '--no-tags', '--depth=1', 'origin', gatedMb, currentMb]);
      if (!fetchedMb.ok) return refuse(`cannot fetch the merge-bases (${fetchedMb.out.split('\n')[0]})`);
      const stamps = stampSet(policy.policy);
      const [gatedDiff, currentDiff] = [ownDiffSignature(git, gatedMb, binding.head_sha, stamps), ownDiffSignature(git, currentMb, o.headSha, stamps)];
      if ('error' in gatedDiff) return refuse(gatedDiff.error);
      if ('error' in currentDiff) return refuse(currentDiff.error);
      lines.push(`OWN DIFF: ${gatedDiff.sha256 === currentDiff.sha256 ? 'identical' : 'changed'} (${binding.head_sha.slice(0, 12)} from ${gatedMb.slice(0, 12)}: ${gatedDiff.sha256.slice(0, 12)}; ${o.headSha.slice(0, 12)} from ${currentMb.slice(0, 12)}: ${currentDiff.sha256.slice(0, 12)})`);
      if (gatedDiff.sha256 !== currentDiff.sha256) return refuse(`the PR's own diff (excluding stamp files) differs from the gated head's`);
      candidate = { ...common, kind: 'main-moved', gated_merge_base: gatedMb, merge_base: currentMb, own_diff_sha256: currentDiff.sha256,
        why: `main moved (${binding.base_sha.slice(0, 12)} -> ${baseSha.slice(0, 12)}) and the PR's own diff from its merge-base, excluding stamp files, is byte-identical to ${binding.head_sha.slice(0, 12)}'s (sha256 ${currentDiff.sha256.slice(0, 12)})` };
    }
    fs.mkdirSync(o.out, { recursive: true });
    fs.writeFileSync(path.join(o.out, CANDIDATE_FILE), `${JSON.stringify(candidate, null, 2)}\n`);
    lines.push(`${candidate.kind} candidate: run ${run.id} passed the full gate at ${binding.head_sha.slice(0, 12)}; ${candidate.why}; plan-slices confirms the selection`);
    return { candidate, lines };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

/** plan-slices: the reuse holds only when this head's own plan selects exactly what the reused gate ran. */
export function confirmReuse(candidateDir: string, manifest: PaidRunManifest | null): { reuse: GateReuse | null; reason: string } {
  const candidate = parseReuse(readJson(path.join(candidateDir, CANDIDATE_FILE)));
  if (!candidate) return { reuse: null, reason: 'no reuse candidate; the full gate runs' };
  if (!manifest?.entries) return { reuse: null, reason: 'this run has no readable plan; the full gate runs' };
  const fingerprint = selectionFingerprint(manifest);
  if (fingerprint !== candidate.selection_sha256) {
    return { reuse: null, reason: `this head's selection ${fingerprint.slice(0, 12)} differs from the reused gate's ${candidate.selection_sha256.slice(0, 12)}; the full gate runs` };
  }
  return { reuse: candidate, reason: `reusing run ${candidate.reused_run_id}'s GREEN verdict at ${candidate.gated_head.slice(0, 12)} (${candidate.kind}): ${candidate.why}; same selection ${fingerprint.slice(0, 12)}` };
}

export function reuseReport(reuse: GateReuse, repo: string): string {
  const evidence = reuse.kind === 'restamp-only'
    ? [`TREE: same-modulo-stamps receipt=${reuse.receipt_sha256}`, `stamp files: ${reuse.stamp_files!.join(', ')} (${reuse.old_version ?? '-'} -> ${reuse.new_version ?? '-'})`]
    : [`OWN DIFF: identical sha256=${reuse.own_diff_sha256} (merge-base ${reuse.gated_merge_base} -> ${reuse.merge_base}; stamp files excluded)`];
  return [
    `GATE REUSED (${reuse.kind === 'restamp-only' ? 'R2a, restamp-only' : 'R2, main moved'}): no paid case ran on ${reuse.current_head}`,
    `reused verdict: GREEN from run ${reuse.reused_run_id} attempt ${reuse.reused_run_attempt} at ${reuse.gated_head} (https://github.com/${repo}/actions/runs/${reuse.reused_run_id})`,
    `why: ${reuse.why}`,
    `base: ${reuse.gated_base} -> ${reuse.base_sha}`,
    ...evidence,
    `selection: ${reuse.selection_sha256} (identical to the reused gate)`,
    'cost: $0 (no trials executed)',
  ].join('\n');
}

const USAGE = `usage:
  bun run scripts/gate-reuse.ts bind <report dir> --out <dir> --repo <owner/name> --pr <n> --run-id <id> --run-attempt <n>
      --head-sha <sha> --tested-sha <merge sha> --profile <pr|full> --reconcile-exit <n>
  bun run scripts/gate-reuse.ts find --repo <owner/name> --pr <n> --head-repo <owner/name> --branch <head branch> --run-id <id>
      --head-sha <sha> --tested-sha <merge sha> --out <dir> [--budget-seconds 90]
  bun run scripts/gate-reuse.ts confirm <candidate dir> <manifest.json> --out <paid-plan dir> [--github-output <file>]
  bun run scripts/gate-reuse.ts report <gate-reuse.json> --repo <owner/name>
bind and find never fail the run; no candidate means the full gate runs.`;

if (import.meta.main) {
  const [command, ...rest] = process.argv.slice(2);
  const flag = (name: string) => { const i = rest.indexOf(`--${name}`); return i >= 0 ? rest[i + 1] : undefined; };
  const int = (name: string) => Number(flag(name));
  const usage = () => { console.error(USAGE); process.exit(2); };
  if (command === 'bind') {
    const [reportDir, out, repository, headSha, testedSha, profile] = [rest[0], flag('out'), flag('repo'), flag('head-sha'), flag('tested-sha'), flag('profile')];
    if (!reportDir || !out || !repository || !headSha || !testedSha || !profile) usage();
    const git = gitIn(process.cwd());
    if (!commitParents(git, testedSha!)) git(['fetch', '--no-tags', '--depth=1', 'origin', testedSha!]);
    const tested = testedBase(git, testedSha!, headSha!);
    const { binding, reason } = buildBinding({ repository: repository!, pr: int('pr'), runId: int('run-id'), runAttempt: int('run-attempt'),
      headSha: headSha!, baseSha: 'base' in tested ? tested.base : null, profile: profile!,
      reconcileExit: /^\d+$/.test(flag('reconcile-exit') ?? '') ? int('reconcile-exit') : -1, reportDir: reportDir! });
    if (binding) {
      fs.mkdirSync(out!, { recursive: true });
      fs.writeFileSync(path.join(out!, BINDING_FILE), `${JSON.stringify(binding, null, 2)}\n`);
    }
    console.log(`- Gate binding: ${reason}${'error' in tested ? ` (${tested.error})` : ''}`);
  } else if (command === 'find') {
    const [repo, headRepo, branch, headSha, testedSha, out] = [flag('repo'), flag('head-repo'), flag('branch'), flag('head-sha'), flag('tested-sha'), flag('out')];
    if (!repo || !headRepo || !branch || !headSha || !testedSha || !out || !Number.isSafeInteger(int('pr')) || !Number.isSafeInteger(int('run-id'))) usage();
    const { lines } = findReusableGate({ repo: repo!, pr: int('pr'), headRepo: headRepo!, branch: branch!, selfRunId: int('run-id'), headSha: headSha!,
      testedSha: testedSha!, repoRoot: process.cwd(), out: out!, budgetMs: Number(flag('budget-seconds') ?? '90') * 1000 });
    console.log('### Paid-gate verdict reuse (R2a restamp-only, R2 main moved)');
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
    console.log(`- Paid-gate verdict reuse: ${reason}`);
  } else if (command === 'report') {
    const reuse = parseReuse(readJson(rest[0] ?? ''));
    const repo = flag('repo');
    if (!reuse || !repo) { console.error('gate-reuse report: the reuse record is missing or malformed; the gate is not green'); process.exit(1); }
    console.log(reuseReport(reuse!, repo!));
  } else usage();
}
