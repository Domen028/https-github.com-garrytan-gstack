/**
 * eval-cli-run.ts — the subscription (CLI-metered) eval driver behind
 * `gstack-eval-plan cli-run`.
 *
 * Incident 2026-10-13: a hand-written driver queued 1,164 `claude -p` calls in
 * an executor, ignored return codes and stderr, and kept firing for minutes
 * after the seat's five-hour window ran out. This module is the replacement:
 *
 *   - a pull-based pool of exactly `workers` loops (a job starts only when a
 *     slot is free; nothing is queued eagerly);
 *   - the first quota or rate-limit result (or exit 75, the batch helper's
 *     tripped circuit) stops the run: no new job starts, every unstarted job is
 *     recorded `cancelled`, a quota is never retried;
 *   - the child env drops the API billing routes, so a quota stop can never
 *     turn into an API-billed call;
 *   - one JSONL record per job, so a rerun after the window resets resumes.
 *
 * Full runs go through an external batch helper (`claude-batch`, overridable by
 * GSTACK_CLAUDE_BATCH) that pins one seat and owns a durable circuit; the gate
 * helpers below resolve it, build its argv and run its preflight. Detection
 * never keys on `rateLimitType` (it is often null on a rejected call).
 */
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** Exit code for a quota stop; the batch helper uses the same value for its open circuit. */
export const EXIT_QUOTA_STOP = 75;

/** Env names that route `claude` to API billing instead of the subscription seat. */
export const API_BILLING_ENV = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY'] as const;

/** Flags the driver owns; a job's `args` may not set them. */
export const RESERVED_CLAUDE_FLAGS = ['-p', '--print', '--output-format', '--input-format'] as const;

export const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export const SMOKE_MAX_JOBS = 10;
export const SMOKE_MAX_WORKERS = 2;
export const BATCH_CLASSES = ['standard', 'fable'] as const;
export type BatchClass = typeof BATCH_CLASSES[number];

const QUOTA_TEXT = /hit your (?:\w+[- ])?limit|usage limit|session limit|rate[_ -]?limit|\b429\b/i;
const TAIL_BYTES = 2048;

export type CliKind = 'ok' | 'quota' | 'error';
export interface CliClassification { kind: CliKind; detail: string; result?: string }

export interface CliJob { id: string; prompt: string; args?: string[] }
export type CliJobStatus = 'ok' | 'error' | 'quota' | 'cancelled';
export interface CliJobRecord {
  id: string;
  status: CliJobStatus | 'skipped';
  rc: number | null;
  attempts: number;
  result?: string;
  detail?: string;
  stdout_tail?: string;
  stderr_tail?: string;
}

export interface CliRunOptions {
  jobs: CliJob[];
  out: string;
  workers: number;
  retries: number;
  timeoutMs: number;
  env: NodeJS.ProcessEnv;
  /** Default `claude`, resolved on the child env's PATH (the batch helper's enforcing wrapper sits there). */
  claudeBin?: string;
}

export type CliRunStatus = 'complete' | 'quota_stopped' | 'failed';
export interface CliRunSummary {
  status: CliRunStatus;
  ok: number;
  error: number;
  quota: number;
  cancelled: number;
  skipped: number;
  max_in_flight: number;
  workers: number;
  removed_env: string[];
  quota_detail?: string;
  /** One record per input job, in input order (skipped ones included). */
  jobs: CliJobRecord[];
}

// ---------------------------------------------------------------------------
// Classifier
// ---------------------------------------------------------------------------

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Parsed objects from `--output-format json` (one value) or stream-json (JSONL, non-JSON lines ignored). */
function parseObjects(stdout: string): Obj[] {
  const text = stdout.trim();
  if (!text) return [];
  try {
    const one: unknown = JSON.parse(text);
    return (Array.isArray(one) ? one : [one]).filter(isObj);
  } catch {
    // Not one JSON value: fall through to JSONL.
  }
  const out: Obj[] = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try {
      const v: unknown = JSON.parse(t);
      if (isObj(v)) out.push(v);
    } catch {
      // A non-JSON line inside stream output (a warning, a partial write) is ignored on purpose.
    }
  }
  return out;
}

/** The structured quota signal on one object, or null. Never reads `rateLimitType`. */
function structuredQuota(o: Obj): string | null {
  for (const node of [o, o.message]) {
    if (!isObj(node)) continue;
    if (node.error === 'rate_limit') return 'error=rate_limit';
    if (node.apiErrorStatus === 429 || node.api_error_status === 429) return 'api_error_status=429';
    if (isObj(node.quotaLimits) && node.quotaLimits.status === 'rejected') return 'quotaLimits.status=rejected';
  }
  return null;
}

const firstLine = (s: string) => s.trim().split('\n')[0]?.slice(0, 200) ?? '';

/**
 * Classify one `claude -p --output-format json` call. `quota` ends the run;
 * `error` may be retried; `ok` carries the result text. Text matching only
 * applies to a failed call, so an answer that mentions "rate limit" stays `ok`.
 */
export function classifyClaudeResult(rc: number | null, stdout: string, stderr: string, opts: { timedOut?: boolean } = {}): CliClassification {
  if (rc === EXIT_QUOTA_STOP) return { kind: 'quota', detail: `circuit_open (exit ${EXIT_QUOTA_STOP})` };
  const objects = parseObjects(stdout);
  for (const o of objects) {
    const hit = structuredQuota(o);
    if (hit) return { kind: 'quota', detail: `structured quota signal (${hit})` };
  }
  const result = [...objects].reverse().find(o => o.type === 'result');
  const isError = result?.is_error === true;
  const resultText = typeof result?.result === 'string' ? result.result : '';
  if (isError && QUOTA_TEXT.test(resultText)) return { kind: 'quota', detail: `result text: ${firstLine(resultText)}` };
  if (rc !== 0 || isError) {
    const both = `${stdout}\n${stderr}`;
    const m = QUOTA_TEXT.exec(both);
    if (m) return { kind: 'quota', detail: `quota text: ${m[0]}` };
  }
  if (opts.timedOut) return { kind: 'error', detail: 'timeout' };
  if (rc === null) return { kind: 'error', detail: 'killed by a signal' };
  if (rc !== 0) return { kind: 'error', detail: `exit ${rc}${stderr.trim() ? `: ${firstLine(stderr)}` : ''}` };
  if (isError) return { kind: 'error', detail: `is_error: ${firstLine(resultText)}` };
  if (!result) return { kind: 'error', detail: 'unparseable output' };
  return { kind: 'ok', detail: 'ok', result: resultText };
}

// ---------------------------------------------------------------------------
// Jobs file
// ---------------------------------------------------------------------------

/** Parse and validate a jobs JSONL file's text; every problem is listed with its line number. */
export function parseJobs(text: string): { jobs: CliJob[]; errors: string[] } {
  const jobs: CliJob[] = []; const errors: string[] = []; const seen = new Set<string>();
  text.split('\n').forEach((line, i) => {
    if (!line.trim()) return;
    const where = `line ${i + 1}`;
    let v: unknown;
    try { v = JSON.parse(line); } catch { errors.push(`${where}: not JSON`); return; }
    if (!isObj(v)) { errors.push(`${where}: not a JSON object`); return; }
    const { id, prompt, args } = v;
    if (typeof id !== 'string' || !JOB_ID.test(id)) { errors.push(`${where}: id must match ${JOB_ID.source}`); return; }
    if (seen.has(id)) { errors.push(`${where}: duplicate id ${id}`); return; }
    seen.add(id);
    if (typeof prompt !== 'string' || !prompt.length) { errors.push(`${where}: ${id} needs a non-empty prompt string`); return; }
    if (args !== undefined && (!Array.isArray(args) || !args.every(a => typeof a === 'string'))) { errors.push(`${where}: ${id} args must be an array of strings`); return; }
    const reserved = (args as string[] | undefined)?.find(a => RESERVED_CLAUDE_FLAGS.some(f => a === f || a.startsWith(`${f}=`)));
    if (reserved) { errors.push(`${where}: ${id} args may not set ${reserved} (the driver owns -p, --print, --output-format, --input-format)`); return; }
    jobs.push(args ? { id, prompt, args: args as string[] } : { id, prompt });
  });
  if (!jobs.length && !errors.length) errors.push('no jobs');
  return { jobs, errors };
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

/** Copy of `env` without the API billing routes, plus the names removed (never the values). */
export function scrubBillingEnv(env: NodeJS.ProcessEnv): { env: NodeJS.ProcessEnv; removed: string[] } {
  const out = { ...env };
  const removed: string[] = [];
  for (const name of API_BILLING_ENV) if (name in out) { delete out[name]; removed.push(name); }
  return { env: out, removed };
}

/** Resolve a command name on the given env's PATH, or an executable absolute path. */
export function resolveCommand(name: string, env: NodeJS.ProcessEnv): string | null {
  if (path.isAbsolute(name)) {
    try { fs.accessSync(name, fs.constants.X_OK); return fs.statSync(name).isFile() ? name : null; } catch { return null; }
  }
  return Bun.which(name, { PATH: env.PATH ?? env.Path ?? '' });
}

/** Ids whose latest record in an earlier run's cli-run.jsonl is `ok`. */
export function completedIds(jsonl: string): Set<string> {
  const latest = new Map<string, string>();
  if (!fs.existsSync(jsonl)) return new Set();
  for (const line of fs.readFileSync(jsonl, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const r: unknown = JSON.parse(line);
      if (isObj(r) && typeof r.id === 'string' && typeof r.status === 'string') latest.set(r.id, r.status);
    } catch {
      // An interrupted append leaves a partial tail line; that job simply reruns.
    }
  }
  return new Set([...latest].filter(([, s]) => s === 'ok').map(([id]) => id));
}

interface CallResult { rc: number | null; stdout: string; stderr: string; timedOut: boolean }

/** One `claude -p --output-format json` child: async spawn, prompt on stdin, killed only at its timeout. */
function callClaude(bin: string, job: CliJob, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<CallResult> {
  return new Promise(resolve => {
    const child = spawn(bin, ['-p', '--output-format', 'json', ...(job.args ?? [])], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = ''; let timedOut = false; let settled = false;
    const done = (r: CallResult) => { if (!settled) { settled = true; clearTimeout(timer); clearTimeout(killer); resolve(r); } };
    let killer: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      killer = setTimeout(() => child.kill('SIGKILL'), 5_000);
    }, timeoutMs);
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    // A child that exits before reading stdin raises EPIPE here; its exit code tells the story.
    child.stdin.on('error', () => {});
    child.on('error', e => done({ rc: null, stdout, stderr: `${stderr}${e.message}`, timedOut }));
    child.on('close', code => done({ rc: code, stdout, stderr, timedOut }));
    child.stdin.end(job.prompt);
  });
}

const tail = (s: string) => (s.length > TAIL_BYTES ? s.slice(-TAIL_BYTES) : s);

/**
 * Run the jobs through a bounded pool. Stops at the first quota; never
 * retries one; records every job in `<out>/cli-run.jsonl` and writes
 * `<out>/cli-run-summary.json`.
 */
export async function runCliBatch(opts: CliRunOptions): Promise<CliRunSummary> {
  fs.mkdirSync(opts.out, { recursive: true });
  const jsonl = path.join(opts.out, 'cli-run.jsonl');
  const { env, removed } = scrubBillingEnv(opts.env);
  const bin = resolveCommand(opts.claudeBin ?? 'claude', env);
  if (!bin) throw new Error(`${opts.claudeBin ?? 'claude'} is not on PATH; cli-run needs the claude CLI`);
  const done = completedIds(jsonl);
  const records = new Map<string, CliJobRecord>();
  for (const j of opts.jobs) if (done.has(j.id)) records.set(j.id, { id: j.id, status: 'skipped', rc: null, attempts: 0 });
  const pending = opts.jobs.filter(j => !done.has(j.id));
  const retries = Math.max(0, Math.min(2, Math.floor(opts.retries)));
  const workers = Math.max(1, Math.floor(opts.workers));
  let next = 0; let stopped = false; let inFlight = 0; let maxInFlight = 0; let quotaDetail: string | undefined;
  const finish = (r: CliJobRecord) => { records.set(r.id, r); fs.appendFileSync(jsonl, JSON.stringify(r) + '\n'); };

  const worker = async () => {
    while (!stopped && next < pending.length) {
      const job = pending[next++]!;
      let attempts = 0; let call: CallResult; let c: CliClassification;
      for (;;) {
        attempts++;
        inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
        call = await callClaude(bin, job, env, opts.timeoutMs);
        inFlight--;
        c = classifyClaudeResult(call.rc, call.stdout, call.stderr, { timedOut: call.timedOut });
        if (c.kind === 'quota' && !stopped) { stopped = true; quotaDetail = `${job.id}: ${c.detail}`; }
        if (c.kind === 'error' && attempts <= retries && !stopped) continue;
        break;
      }
      finish(c.kind === 'ok'
        ? { id: job.id, status: 'ok', rc: call.rc, attempts, result: c.result }
        : { id: job.id, status: c.kind, rc: call.rc, attempts, detail: c.detail, stdout_tail: tail(call.stdout), stderr_tail: tail(call.stderr) });
    }
  };
  await Promise.all(Array.from({ length: Math.min(workers, pending.length) }, worker));
  for (const job of pending.slice(next)) finish({ id: job.id, status: 'cancelled', rc: null, attempts: 0, detail: 'not started: the run stopped at a quota' });

  const jobs = opts.jobs.map(j => records.get(j.id)!);
  const count = (s: CliJobRecord['status']) => jobs.filter(r => r.status === s).length;
  const summary: CliRunSummary = {
    status: stopped ? 'quota_stopped' : count('error') ? 'failed' : 'complete',
    ok: count('ok'), error: count('error'), quota: count('quota'), cancelled: count('cancelled'), skipped: count('skipped'),
    max_in_flight: maxInFlight, workers, removed_env: removed,
    ...(quotaDetail ? { quota_detail: quotaDetail } : {}),
    jobs,
  };
  fs.writeFileSync(path.join(opts.out, 'cli-run-summary.json'), JSON.stringify(summary, null, 2) + '\n');
  return summary;
}

export interface CliRunContext { batch: string; scope: string; summaryFile: string }

/** Grep-able lines: one EVAL_CLI_JOB per job, then EVAL_CLI_RUN. */
export function renderCliRun(s: CliRunSummary, ctx: CliRunContext): string {
  const lines = s.jobs.map(r => `EVAL_CLI_JOB: id=${r.id} status=${r.status} attempts=${r.attempts}${r.rc !== null && r.status !== 'skipped' ? ` rc=${r.rc}` : ''}${r.detail && r.status !== 'cancelled' ? ` detail=${JSON.stringify(r.detail)}` : ''}`);
  if (s.removed_env.length) lines.push(`EVAL_CLI_ENV: removed=${s.removed_env.join(',')}`);
  lines.push(`EVAL_CLI_RUN: status=${s.status} ok=${s.ok} error=${s.error} quota=${s.quota} cancelled=${s.cancelled} skipped=${s.skipped} max_in_flight=${s.max_in_flight} workers=${s.workers} batch=${ctx.batch} scope=${ctx.scope} out=${ctx.summaryFile}`);
  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Batch gate (the external seat-pinning helper)
// ---------------------------------------------------------------------------

export const DEFAULT_BATCH_HELPER = 'claude-batch';
export const DEFAULT_BATCH_MARKER = 'MERIT_CLAUDE_BATCH_ID';
/** Set on the re-exec'd driver so a helper that never sets the marker cannot loop. */
export const WRAPPED_ENV = 'GSTACK_EVAL_CLI_WRAPPED';

/** The helper command (GSTACK_CLAUDE_BATCH, default claude-batch) resolved on PATH, or null. Availability only; nothing runs. */
export function resolveBatchHelper(env: NodeJS.ProcessEnv): { name: string; path: string | null } {
  const name = env.GSTACK_CLAUDE_BATCH?.trim() || DEFAULT_BATCH_HELPER;
  return { name, path: resolveCommand(name, env) };
}

/** The env var whose presence says this process runs inside a batch (GSTACK_CLAUDE_BATCH_MARKER, default MERIT_CLAUDE_BATCH_ID). */
export function batchMarkerName(env: NodeJS.ProcessEnv): string {
  return env.GSTACK_CLAUDE_BATCH_MARKER?.trim() || DEFAULT_BATCH_MARKER;
}

/** argv that re-runs this cli-run invocation under the helper: `<helper> run --repo <root> --class <class> -- <bun> <script> cli-run <args>`. */
export function batchArgv(helper: string, repoRoot: string, cls: BatchClass, execPath: string, script: string, args: string[]): string[] {
  return [helper, 'run', '--repo', repoRoot, '--class', cls, '--', execPath, script, 'cli-run', ...args];
}

/** `<helper> preflight` inside the wrapped driver (no model call). rc 0 means the marker names the active batch and PATH claude is the enforcing wrapper. */
export function batchPreflight(helper: string, env: NodeJS.ProcessEnv): { ok: boolean; rc: number | null; stderr_tail: string } {
  const r = spawnSync(helper, ['preflight'], { env, encoding: 'utf8', timeout: 30_000 });
  const stderr = `${r.stderr ?? ''}${r.error ? r.error.message : ''}`;
  return { ok: r.status === 0, rc: r.status, stderr_tail: tail(stderr).trim() };
}

/** Run argv with inherited stdio; resolves with its exit code (75 stays 75). */
export function runInherited(argv: string[], env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise(resolve => {
    const child = spawn(argv[0]!, argv.slice(1), { env, stdio: 'inherit' });
    child.on('error', e => { process.stderr.write(`${argv[0]}: ${e.message}\n`); resolve(1); });
    child.on('close', (code, signal) => resolve(code ?? (signal ? 128 + (signal === 'SIGINT' ? 2 : 15) : 1)));
  });
}
