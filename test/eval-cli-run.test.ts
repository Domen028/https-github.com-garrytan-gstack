/**
 * `gstack-eval-plan cli-run` (lib/eval-cli-run.ts): the subscription eval
 * driver's quota stop, bounded pool, billing-env scrub, resume and batch gate.
 *
 * Incident 2026-10-13: a hand-written driver kept firing `claude -p` for
 * minutes after the seat's window ran out (389 rejected calls). These cases
 * drive the real bin against a fake `claude` placed first on a minimal PATH;
 * no real claude, no network. The fake logs every invocation (start/end, pid,
 * ms timestamp, which billing env it saw) and keeps its own in-flight counter
 * under a mkdir lock, so peak concurrency is observed outside the runner.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { batchArgv, classifyClaudeResult, parseJobs } from '../lib/eval-cli-run';
import { between, expectMentions, expectTokens } from './helpers/prompt-structure';

const ROOT = path.resolve(import.meta.dir, '..');
const BIN = path.join(ROOT, 'bin', 'gstack-eval-plan');
const BUN = process.execPath;

const dirs: string[] = [];
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true }); });

type Behavior = { kind: 'ok' | 'quota_json' | 'quota_result' | 'rc75' | 'err' | 'err_once' | 'garbage'; sleep?: number; text?: string };
interface Control { default: Behavior; by_prompt?: Record<string, Behavior> }
interface Call { ev: 'start' | 'end'; prompt: string; pid: number; t: number; argv?: string[]; billing?: string[]; marker?: string | null }

const TRANSCRIPT_QUOTA = {
  type: 'assistant',
  message: { model: '<synthetic>', content: [{ type: 'text', text: "You've hit your session limit · resets 12pm (America/Los_Angeles)" }] },
  quotaLimits: { status: 'rejected', resetsAt: 1791918000, rateLimitType: 'five_hour' },
  error: 'rate_limit', isApiErrorMessage: true, apiErrorStatus: 429, entrypoint: 'sdk-cli',
};

/** The fake `claude`: reads the prompt on stdin, looks up its behavior in control.json. */
const FAKE_CLAUDE = (dir: string) => `#!${BUN}
const fs = require('node:fs'); const path = require('node:path');
const DIR = ${JSON.stringify(dir)};
const LOG = path.join(DIR, 'calls.jsonl');
const prompt = fs.readFileSync(0, 'utf8');
const ctl = JSON.parse(fs.readFileSync(path.join(DIR, 'control.json'), 'utf8'));
const b = (ctl.by_prompt && ctl.by_prompt[prompt]) || ctl.default;
const prior = fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').split('\\n').filter(l => l && JSON.parse(l).ev === 'start' && JSON.parse(l).prompt === prompt).length : 0;
const billing = ${JSON.stringify(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY'])}.filter(n => n in process.env);
const log = (ev, extra) => fs.appendFileSync(LOG, JSON.stringify({ ev, prompt, pid: process.pid, t: Date.now(), ...extra }) + '\\n');
const locked = fn => { const lock = path.join(DIR, 'lock'); for (;;) { try { fs.mkdirSync(lock); break; } catch { Bun.sleepSync(1); } } try { fn(); } finally { fs.rmdirSync(lock); } };
const read = f => { try { return Number(fs.readFileSync(path.join(DIR, f), 'utf8')); } catch { return 0; } };
log('start', { argv: process.argv.slice(2), billing, marker: process.env.MERIT_CLAUDE_BATCH_ID ?? null });
locked(() => { const n = read('inflight') + 1; fs.writeFileSync(path.join(DIR, 'inflight'), String(n)); if (n > read('peak')) fs.writeFileSync(path.join(DIR, 'peak'), String(n)); });
await Bun.sleep(b.sleep || 0);
locked(() => fs.writeFileSync(path.join(DIR, 'inflight'), String(read('inflight') - 1)));
const kind = b.kind === 'err_once' ? (prior === 0 ? 'err' : 'ok') : b.kind;
log('end', { kind });
const ok = text => JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: text });
if (kind === 'ok') { process.stdout.write(ok(b.text || 'answer:' + prompt)); process.exit(0); }
if (kind === 'quota_json') { process.stdout.write(${JSON.stringify(JSON.stringify(TRANSCRIPT_QUOTA))} + '\\n' + JSON.stringify({ type: 'result', is_error: true, result: 'API Error' }) + '\\n'); process.exit(1); }
if (kind === 'quota_result') { process.stdout.write(JSON.stringify({ type: 'result', is_error: true, result: "You've hit your session limit · resets 12pm" })); process.exit(1); }
if (kind === 'rc75') process.exit(75);
if (kind === 'garbage') { process.stdout.write('not json at all'); process.exit(0); }
process.stderr.write('boom: internal error\\n'); process.exit(1);
`;

/** The fake batch helper: logs argv; `run ... -- <cmd>` exports the marker (unless told not to) and runs cmd; `preflight` passes only inside a batch. */
const FAKE_HELPER = (dir: string) => `#!${BUN}
const fs = require('node:fs'); const path = require('node:path');
const DIR = ${JSON.stringify(dir)};
const ctl = JSON.parse(fs.readFileSync(path.join(DIR, 'helper.json'), 'utf8'));
const argv = process.argv.slice(2);
const billing = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY'].filter(n => n in process.env);
fs.appendFileSync(path.join(DIR, 'helper.jsonl'), JSON.stringify({ argv, t: Date.now(), marker: process.env.MERIT_CLAUDE_BATCH_ID ?? null, billing }) + '\\n');
if (argv[0] === 'preflight') {
  if (!process.env.MERIT_CLAUDE_BATCH_ID) { process.stderr.write('not inside a batch\\n'); process.exit(1); }
  if (ctl.preflight_rc) { process.stderr.write('batch b1 circuit is open\\n'); process.exit(ctl.preflight_rc); }
  process.exit(0);
}
if (argv[0] === 'run') {
  const cmd = argv.slice(argv.indexOf('--') + 1);
  const env = { ...process.env };
  if (ctl.set_marker !== false) env.MERIT_CLAUDE_BATCH_ID = 'b1';
  const child = Bun.spawn(cmd, { env, stdio: ['inherit', 'inherit', 'inherit'] });
  const code = await child.exited;
  process.exit(code);
}
process.exit(2);
`;

interface Fixture {
  dir: string; bin: string; out: string; jobs: string; cwd: string;
  control(c: Control): void; helper(c: { preflight_rc?: number; set_marker?: boolean }): string;
  writeJobs(ids: string[]): void; calls(): Call[]; helperCalls(): Array<{ argv: string[]; t: number; marker: string | null; billing: string[] }>; peak(): number;
  env(extra?: Record<string, string>): Record<string, string>;
}

function fixture(): Fixture {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-cli-run-')));
  dirs.push(dir);
  const bin = path.join(dir, 'bin');
  const cwd = path.join(dir, 'cwd');
  fs.mkdirSync(bin); fs.mkdirSync(cwd);
  fs.writeFileSync(path.join(bin, 'claude'), FAKE_CLAUDE(dir), { mode: 0o755 });
  const f: Fixture = {
    dir, bin, cwd, out: path.join(dir, 'out'), jobs: path.join(dir, 'jobs.jsonl'),
    control: c => fs.writeFileSync(path.join(dir, 'control.json'), JSON.stringify(c)),
    helper: c => {
      const hdir = path.join(dir, 'helper-bin');
      fs.mkdirSync(hdir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'helper.json'), JSON.stringify(c));
      fs.writeFileSync(path.join(hdir, 'claude-batch'), FAKE_HELPER(dir), { mode: 0o755 });
      return path.join(hdir, 'claude-batch');
    },
    writeJobs: ids => fs.writeFileSync(path.join(dir, 'jobs.jsonl'), ids.map(id => JSON.stringify({ id, prompt: id })).join('\n') + '\n'),
    calls: () => { const p = path.join(dir, 'calls.jsonl'); return fs.existsSync(p) ? fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : []; },
    helperCalls: () => { const p = path.join(dir, 'helper.jsonl'); return fs.existsSync(p) ? fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : []; },
    peak: () => Number(fs.readFileSync(path.join(dir, 'peak'), 'utf8')),
    // Minimal PATH: the fake first, then bun and the system tools. No real claude or claude-batch is reachable.
    env: (extra = {}) => ({ PATH: [bin, path.dirname(BUN), '/usr/bin', '/bin'].join(path.delimiter), HOME: dir, TMPDIR: os.tmpdir(), GSTACK_CLAUDE_BATCH: path.join(dir, 'no-such-helper'), ...extra }),
  };
  f.control({ default: { kind: 'ok' } });
  return f;
}

/** Env for a run already inside a batch: the marker set and the fake helper's preflight passing. */
const inBatch = (f: Fixture, extra: Record<string, string> = {}) => f.env({ GSTACK_CLAUDE_BATCH: f.helper({}), MERIT_CLAUDE_BATCH_ID: 'b1', ...extra });

function run(f: Fixture, args: string[], env: Record<string, string>) {
  const r = spawnSync(BUN, [BIN, 'cli-run', '--jobs', f.jobs, '--out', f.out, ...args], { cwd: f.cwd, env, encoding: 'utf8', timeout: 60_000 });
  const records = fs.existsSync(path.join(f.out, 'cli-run.jsonl')) ? fs.readFileSync(path.join(f.out, 'cli-run.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)) : [];
  const summary = fs.existsSync(path.join(f.out, 'cli-run-summary.json')) ? JSON.parse(fs.readFileSync(path.join(f.out, 'cli-run-summary.json'), 'utf8')) : null;
  return { rc: r.status, stdout: r.stdout, stderr: r.stderr, records, summary };
}

const ids = (n: number) => Array.from({ length: n }, (_, i) => `job-${String(i + 1).padStart(2, '0')}`);
const starts = (f: Fixture) => f.calls().filter(c => c.ev === 'start');

describe('classifyClaudeResult', () => {
  test('quota signals: transcript record, null rateLimitType, is_error result text, exit 75, text on a failed call', () => {
    const rec = JSON.stringify(TRANSCRIPT_QUOTA);
    expect(classifyClaudeResult(1, rec, '').kind).toBe('quota');
    expect(classifyClaudeResult(0, rec, '').kind).toBe('quota');
    expect(classifyClaudeResult(1, JSON.stringify({ ...TRANSCRIPT_QUOTA, quotaLimits: { ...TRANSCRIPT_QUOTA.quotaLimits, rateLimitType: null } }), '').kind).toBe('quota');
    expect(classifyClaudeResult(1, JSON.stringify({ type: 'assistant', error: 'rate_limit', quotaLimits: { rateLimitType: null } }), '').kind).toBe('quota');
    expect(classifyClaudeResult(1, JSON.stringify({ type: 'assistant', message: { apiErrorStatus: 429 } }), '').kind).toBe('quota');
    expect(classifyClaudeResult(1, `warning: something\n${rec}\n{"type":"result","is_error":true,"result":"x"}`, '').kind).toBe('quota');
    expect(classifyClaudeResult(1, JSON.stringify({ type: 'result', is_error: true, result: "You've hit your session limit · resets 12pm" }), '')).toMatchObject({ kind: 'quota' });
    expect(classifyClaudeResult(75, '', '')).toEqual({ kind: 'quota', detail: 'circuit_open (exit 75)' });
    expect(classifyClaudeResult(1, "You've hit your session limit", '').kind).toBe('quota');
    expect(classifyClaudeResult(1, '', 'Error: 429 Too Many Requests').kind).toBe('quota');
  });

  test('a structured signal counts on stderr and in a stream-json rate_limit_event, even at exit 0', () => {
    const rejected = JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType: null } });
    const done = JSON.stringify({ type: 'result', is_error: false, result: 'partial' });
    expect(classifyClaudeResult(0, `${rejected}\n${done}`, '')).toMatchObject({ kind: 'quota' });
    expect(classifyClaudeResult(1, '', JSON.stringify({ quotaLimits: { status: 'rejected' } }))).toMatchObject({ kind: 'quota' });
    expect(classifyClaudeResult(0, done, JSON.stringify({ error: 'rate_limit' }))).toMatchObject({ kind: 'quota' });
    // A warning is not a stop: the call finished.
    const warning = JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning' } });
    expect(classifyClaudeResult(0, `${warning}\n${done}`, '')).toEqual({ kind: 'ok', detail: 'ok', result: 'partial' });
  });

  test('an answer that mentions "rate limit" is ok; garbage and generic failures are errors, never quota', () => {
    expect(classifyClaudeResult(0, JSON.stringify({ type: 'result', is_error: false, result: 'Add a rate limit of 429 per hour; users hit your usage limit page.' }), '')).toEqual({ kind: 'ok', detail: 'ok', result: 'Add a rate limit of 429 per hour; users hit your usage limit page.' });
    expect(classifyClaudeResult(0, 'not json at all', '')).toEqual({ kind: 'error', detail: 'unparseable output' });
    expect(classifyClaudeResult(0, JSON.stringify({ hello: 1 }), '')).toEqual({ kind: 'error', detail: 'unparseable output' });
    expect(classifyClaudeResult(1, '', 'boom: internal error')).toMatchObject({ kind: 'error' });
    expect(classifyClaudeResult(0, JSON.stringify({ type: 'result', is_error: true, result: 'tool failed' }), '').kind).toBe('error');
    expect(classifyClaudeResult(null, '', '', { timedOut: true })).toEqual({ kind: 'error', detail: 'timeout' });
  });
});

describe('parseJobs', () => {
  test('ids are unique and well-formed; args may not set the driver-owned flags', () => {
    expect(parseJobs('{"id":"a","prompt":"x","args":["--model","m"]}\n\n{"id":"b","prompt":"y"}\n').jobs.map(j => j.id)).toEqual(['a', 'b']);
    for (const bad of ['{"id":"a","prompt":"x"}\n{"id":"a","prompt":"y"}', '{"id":"-a","prompt":"x"}', '{"id":"a b","prompt":"x"}', 'nope', '{"id":"a"}']) expect(parseJobs(bad).errors.length).toBeGreaterThan(0);
    for (const flag of ['-p', '--print', '--output-format', '--output-format=text', '--input-format']) expect(parseJobs(JSON.stringify({ id: 'a', prompt: 'x', args: [flag] })).errors[0]).toContain(flag);
  });
});

describe('cli-run quota stop', () => {
  // Jobs 1-6 return at once, job 7 sleeps 300 ms, job 8 hits the quota while job 7 is still running.
  const stopCase = (kind: Behavior['kind']) => {
    const f = fixture();
    const all = ids(20);
    f.writeJobs(all);
    f.control({ default: { kind: 'ok' }, by_prompt: { 'job-07': { kind: 'ok', sleep: 300 }, 'job-08': { kind } } });
    const r = run(f, ['--class', 'standard', '--workers', '2', '--retries', '2'], inBatch(f));
    expect(r.rc).toBe(75);
    expect(r.stderr).toContain('(EVAL_QUOTA_STOP)');
    const s = starts(f);
    expect(s.filter(c => c.prompt === 'job-08').length).toBe(1);
    const quotaReturned = f.calls().find(c => c.ev === 'end' && c.prompt === 'job-08')!.t;
    expect(s.filter(c => c.t > quotaReturned).map(c => c.prompt)).toEqual([]);
    expect(s.length).toBeLessThanOrEqual(8 + 2);
    const started = new Set(s.map(c => c.prompt));
    const byId = new Map(r.records.map(x => [x.id, x]));
    for (const id of all) {
      if (!started.has(id)) expect(byId.get(id)?.status).toBe('cancelled');
    }
    expect(byId.get('job-08')).toMatchObject({ status: 'quota', attempts: 1 });
    expect(byId.get('job-07')?.status).toBe('ok');
    expect(r.summary).toMatchObject({ status: 'quota_stopped', quota: 1 });
    expect(r.summary.cancelled).toBe(all.length - started.size);
    expect(r.stdout).toMatch(/^EVAL_CLI_RUN: status=quota_stopped .*cancelled=12 /m);
    return f;
  };

  test('a structured quota stops the run: exit 75, the quota job runs once despite --retries 2, nothing starts after it, the rest are cancelled', () => {
    stopCase('quota_json');
  });

  test('a child exit 75 (the batch helper circuit is open) stops the run the same way', () => {
    stopCase('rc75');
  });
});

describe('cli-run pool and retries', () => {
  test('in-flight children never exceed --workers', () => {
    const f = fixture();
    f.writeJobs(ids(12));
    f.control({ default: { kind: 'ok', sleep: 300 } });
    const r = run(f, ['--class', 'standard', '--workers', '3'], inBatch(f));
    expect(r.rc).toBe(0);
    expect(f.peak()).toBe(3);
    expect(r.summary.max_in_flight).toBeLessThanOrEqual(3);
    expect(r.summary).toMatchObject({ status: 'complete', ok: 12, workers: 3 });
    expect(starts(f)[0]!.argv!.slice(0, 3)).toEqual(['-p', '--output-format', 'json']);
  });

  test('--retries applies to non-quota errors only', () => {
    const f = fixture();
    f.writeJobs(['flaky', 'broken', 'fine']);
    f.control({ default: { kind: 'ok' }, by_prompt: { flaky: { kind: 'err_once' }, broken: { kind: 'err' } } });
    const r = run(f, ['--class', 'standard', '--workers', '1', '--retries', '1'], inBatch(f));
    expect(r.rc).toBe(1);
    const count = (p: string) => starts(f).filter(c => c.prompt === p).length;
    expect([count('flaky'), count('broken'), count('fine')]).toEqual([2, 2, 1]);
    const byId = new Map(r.records.map(x => [x.id, x]));
    expect(byId.get('flaky')).toMatchObject({ status: 'ok', attempts: 2 });
    expect(byId.get('broken')).toMatchObject({ status: 'error', attempts: 2, rc: 1 });
    expect(byId.get('broken').stderr_tail).toContain('boom');
    expect(r.summary.status).toBe('failed');
  });

  test('the API billing routes never reach the child, and the value is never printed', () => {
    const f = fixture();
    f.writeJobs(ids(2));
    const value = 'gstack-test-billing-value-41b7';
    const all = { ANTHROPIC_API_KEY: value, ANTHROPIC_AUTH_TOKEN: value, CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CODE_USE_VERTEX: '1', CLAUDE_CODE_USE_FOUNDRY: '1' };
    const r = run(f, ['--class', 'standard', '--workers', '1', '--json'], inBatch(f, all));
    expect(r.rc).toBe(0);
    for (const c of starts(f)) expect(c.billing).toEqual([]);
    for (const c of f.helperCalls()) expect(c.billing).toEqual([]);
    expect(r.summary.removed_env.sort()).toEqual(Object.keys(all).sort());
    const files = fs.readdirSync(f.out).map(n => fs.readFileSync(path.join(f.out, n), 'utf8'));
    for (const text of [r.stdout, r.stderr, ...files]) expect(text).not.toContain(value);
  });

  test('a rerun resumes: ids whose latest record is ok are skipped', () => {
    const f = fixture();
    f.writeJobs(ids(6));
    f.control({ default: { kind: 'ok' }, by_prompt: { 'job-03': { kind: 'quota_result' } } });
    const first = run(f, ['--class', 'standard', '--workers', '1'], inBatch(f));
    expect(first.rc).toBe(75);
    expect(first.summary).toMatchObject({ ok: 2, quota: 1, cancelled: 3 });
    fs.rmSync(path.join(f.dir, 'calls.jsonl'));
    f.control({ default: { kind: 'ok' } });
    const second = run(f, ['--class', 'standard', '--workers', '1'], inBatch(f));
    expect(second.rc).toBe(0);
    expect(starts(f).map(c => c.prompt)).toEqual(['job-03', 'job-04', 'job-05', 'job-06']);
    expect(second.summary).toMatchObject({ status: 'complete', ok: 4, skipped: 2 });
    expect(second.stdout).toContain('EVAL_CLI_JOB: id=job-01 status=skipped attempts=0');
  });

  test('a rerun with a changed prompt or args reruns that job; results are private', () => {
    const f = fixture();
    const write = (model: string) => fs.writeFileSync(f.jobs, ['job-01', 'job-02'].map(id => JSON.stringify({ id, prompt: id, args: ['--model', id === 'job-02' ? model : 'a'] })).join('\n') + '\n');
    write('a');
    expect(run(f, ['--class', 'standard', '--workers', '1'], inBatch(f)).rc).toBe(0);
    fs.rmSync(path.join(f.dir, 'calls.jsonl'));
    write('b');
    const second = run(f, ['--class', 'standard', '--workers', '1'], inBatch(f));
    expect(second.summary).toMatchObject({ status: 'complete', ok: 1, skipped: 1 });
    expect(starts(f).map(c => [c.prompt, c.argv!.at(-1)])).toEqual([['job-02', 'b']]);
    expect(fs.statSync(f.out).mode & 0o777).toBe(0o700);
    for (const n of fs.readdirSync(f.out)) expect(fs.statSync(path.join(f.out, n)).mode & 0o777).toBe(0o600);
  });
});

describe('cli-run batch gate', () => {
  test('batchArgv wraps the whole driver', () => {
    expect(batchArgv('/h/claude-batch', '/repo', 'fable', '/bun', '/g/bin/gstack-eval-plan', ['--jobs', '/j'])).toEqual(
      ['/h/claude-batch', 'run', '--repo', '/repo', '--class', 'fable', '--', '/bun', '/g/bin/gstack-eval-plan', 'cli-run', '--jobs', '/j']);
  });

  test('full scope with no helper refuses before any claude call (EVAL_BATCH_HELPER_MISSING, exit 3)', () => {
    const f = fixture();
    f.writeJobs(ids(3));
    for (const env of [f.env(), (() => { const e = f.env(); delete (e as Record<string, string | undefined>).GSTACK_CLAUDE_BATCH; return e; })()]) {
      const r = run(f, ['--class', 'standard'], env);
      expect(r.rc).toBe(3);
      expect(r.stderr).toContain('(EVAL_BATCH_HELPER_MISSING)');
    }
    expect(f.calls()).toEqual([]);
    expect(f.helperCalls()).toEqual([]);
  });

  test('inside a batch, a failing preflight refuses before any claude call (EVAL_BATCH_PREFLIGHT_FAILED, exit 3)', () => {
    const f = fixture();
    f.writeJobs(ids(3));
    const r = run(f, ['--class', 'standard'], f.env({ GSTACK_CLAUDE_BATCH: f.helper({ preflight_rc: 1 }), MERIT_CLAUDE_BATCH_ID: 'b1' }));
    expect(r.rc).toBe(3);
    expect(r.stderr).toContain('(EVAL_BATCH_PREFLIGHT_FAILED)');
    expect(r.stderr).toContain('circuit is open');
    expect(f.calls()).toEqual([]);
  });

  test('full scope re-runs itself under the helper; preflight runs once, inside; a quota inside exits 75 through the helper', () => {
    const f = fixture();
    f.writeJobs(ids(4));
    f.control({ default: { kind: 'ok' }, by_prompt: { 'job-03': { kind: 'quota_json' } } });
    const helper = f.helper({});
    const r = run(f, ['--class', 'fable', '--workers', '1'], f.env({ GSTACK_CLAUDE_BATCH: helper, ANTHROPIC_API_KEY: 'sk-test-helper', CLAUDE_CODE_USE_VERTEX: '1' }));
    expect(r.rc).toBe(75);
    const h = f.helperCalls();
    expect(h.map(c => c.argv[0])).toEqual(['run', 'preflight']);
    // The helper and its preflight never see an API billing route, so nothing downstream can fall back to the API.
    expect(h.map(c => c.billing)).toEqual([[], []]);
    expect(starts(f).every(c => c.billing!.length === 0)).toBe(true);
    expect(h[0]!.argv).toEqual(['run', '--repo', f.cwd, '--class', 'fable', '--', BUN, BIN, 'cli-run', '--jobs', f.jobs, '--out', f.out, '--class', 'fable', '--workers', '1']);
    expect(h[0]!.marker).toBeNull();
    expect(h[1]!.marker).toBe('b1');
    const s = starts(f);
    expect(s.length).toBe(3);
    expect(s.every(c => c.marker === 'b1' && c.t >= h[1]!.t)).toBe(true);
    expect(r.stdout).toContain(`EVAL_BATCH: b1 helper=${helper} scope=full`);
    expect(r.stderr).toContain('(EVAL_QUOTA_STOP)');
  });

  test('a helper whose run never sets the marker is refused without a loop', () => {
    const f = fixture();
    f.writeJobs(ids(2));
    const r = run(f, ['--class', 'standard'], f.env({ GSTACK_CLAUDE_BATCH: f.helper({ set_marker: false }) }));
    expect(r.rc).toBe(3);
    expect(r.stderr).toContain('(EVAL_BATCH_PREFLIGHT_FAILED)');
    expect(f.helperCalls().map(c => c.argv[0])).toEqual(['run']);
    expect(f.calls()).toEqual([]);
  });

  test('full scope needs --class (usage)', () => {
    const f = fixture();
    f.writeJobs(ids(2));
    expect(run(f, [], f.env()).rc).toBe(2);
    expect(f.calls()).toEqual([]);
  });

  test('smoke scope needs no helper, refuses more than 10 jobs, and clamps workers to 2', () => {
    const f = fixture();
    f.writeJobs(ids(11));
    const big = run(f, ['--scope', 'smoke'], f.env());
    expect(big.rc).toBe(2);
    expect(f.calls()).toEqual([]);
    f.writeJobs(ids(6));
    f.control({ default: { kind: 'ok', sleep: 200 } });
    const r = run(f, ['--scope', 'smoke', '--workers', '5'], f.env());
    expect(r.rc).toBe(0);
    expect(r.stdout).toContain('EVAL_BATCH: none scope=smoke');
    expect(r.summary).toMatchObject({ status: 'complete', ok: 6, workers: 2 });
    expect(f.peak()).toBeLessThanOrEqual(2);
    expect(f.helperCalls()).toEqual([]);
  });

  test('the quota stop applies in smoke scope too', () => {
    const f = fixture();
    f.writeJobs(ids(5));
    f.control({ default: { kind: 'ok' }, by_prompt: { 'job-02': { kind: 'quota_result' } } });
    const r = run(f, ['--scope', 'smoke', '--workers', '1'], f.env());
    expect(r.rc).toBe(75);
    expect(starts(f).map(c => c.prompt)).toEqual(['job-01', 'job-02']);
    expect(r.summary).toMatchObject({ status: 'quota_stopped', cancelled: 3 });
  });
});

describe('/eval-plan skill template', () => {
  const tmpl = fs.readFileSync(path.join(ROOT, 'eval-plan', 'SKILL.md.tmpl'), 'utf8');

  test('subscription runs route through cli-run, and the quota rule forbids retry, API key and fallback', () => {
    expectTokens(tmpl, ['gstack-eval-plan cli-run', 'EVAL_QUOTA_STOP', 'EVAL_BATCH_HELPER_MISSING'], 'eval-plan/SKILL.md.tmpl');
    expectMentions(between(tmpl, '## Boundaries', '## Step 1'), [['quota', 'no retry', 'api key', 'fallback']], 'eval-plan Boundaries');
    expectTokens(between(tmpl, '## Step 3', '## Step 4'), ['cli-run --jobs <jobs.jsonl> --out <outdir> --scope smoke'], 'eval-plan Step 3');
    // The API-funded route is unchanged: those attempts keep the project's own command.
    expectMentions(between(tmpl, '## Step 3', '## Step 4'), [['api-funded', "project's own command"]], 'eval-plan Step 3');
    expectTokens(between(tmpl, '## Step 4', '## Tier 3'), ['--scope full --class <standard|fable>', 'status=quota_stopped'], 'eval-plan Step 4');
  });
});
