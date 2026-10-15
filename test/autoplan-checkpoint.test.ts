/**
 * Durable checkpoint (next-wave B12): with GSTACK_AUTOPLAN_CHECKPOINT_DIR set,
 * a run at rest is copied, hash-listed, to <dir>/<run>/; journal paths are
 * run-relative, so `resume --from` restores the run on a new directory (even
 * with the owner's plan file gone), takes ownership, and the run answers and
 * exports a directory `gstack-artifact validate` accepts. A tampered,
 * escaping or misplaced restore writes nothing.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ROOT, autoplan, env, journal, readRun, resultOf, review, runPhase, startSmallRun } from './helpers/autoplan-run-fixture';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'autoplan-checkpoint-'));
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));
const validate = (out: string) => spawnSync('bun', [path.join(ROOT, 'bin', 'gstack-artifact'), 'validate', path.join(out, 'run.json')], { cwd: ROOT, encoding: 'utf8', timeout: 60_000 });

function checkpointed(name: string): { dir: string; out: string; cp: string; run: string; e: Record<string, string> } {
  const dir = path.join(TMP, name);
  const cpRoot = path.join(dir, 'drive');
  const e = env({ GSTACK_AUTOPLAN_CHECKPOINT_DIR: cpRoot });
  const out = startSmallRun(dir);
  runPhase(out, 'ceo');
  const next = autoplan(['next', '--out', out], { env: e });
  expect(next.stderr).not.toContain('CHECKPOINT:');
  for (const voice of ['native', 'outside'] as const) review(path.join(out, `eng-${voice}-prompt.md`));
  const run = readRun(out);
  expect(autoplan(['submit', '--out', out, '--phase', 'eng', '--voice', 'native', '--result', resultOf(out, 'eng', 'native'), '--model', 'anthropic/claude-opus-4-7'], { env: e }).status).toBe(0);
  const gated = autoplan(['submit', '--out', out, '--phase', 'eng', '--voice', 'outside', '--result', resultOf(out, 'eng', 'outside'), '--model', 'openai/gpt-6-astra'], { env: e });
  expect(gated.stdout).toContain('status=gate_pending');
  const cp = path.join(cpRoot, run.run);
  expect(gated.stderr).toMatch(new RegExp(`^CHECKPOINT: ${cp.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} status=gate_pending gate_rev=1 files=\\d+$`, 'm'));
  return { dir, out, cp, run: run.run, e };
}

describe('checkpoint and restore', () => {
  test('write at gate_pending, delete the run and the plan file, restore, resume, answer and export: validate passes', () => {
    const c = checkpointed('roundtrip');
    const manifest = JSON.parse(fs.readFileSync(path.join(c.cp, 'checkpoint.json'), 'utf8'));
    expect(manifest).toMatchObject({ schema_version: 1, run: c.run, status: 'gate_pending', gate_rev: 1 });
    expect(Object.keys(manifest.files)).toEqual(expect.arrayContaining(['run.json', 'attempts.jsonl', 'gate.json', 'decisions.jsonl']));
    expect(Object.keys(manifest.files)).not.toContain('run.lock');
    expect(fs.readFileSync(path.join(c.cp, 'restore.md'), 'utf8')).toContain(`gstack-autoplan resume --out <new run dir> --from ${c.cp}`);
    for (const r of journal(c.out)) for (const k of ['prompt', 'result', 'staging']) if (typeof r[k] === 'string') expect(path.isAbsolute(r[k])).toBe(false);
    fs.rmSync(c.out, { recursive: true, force: true });
    fs.rmSync(path.join(c.dir, 'plan.md'));
    const moved = path.join(c.dir, 'elsewhere', 'run');
    const resumed = autoplan(['resume', '--out', moved, '--from', c.cp], { env: c.e });
    expect(resumed.status, resumed.stderr).toBe(0);
    expect(resumed.stdout).toMatch(new RegExp(`^RESTORED: run=${c.run} from=.* status=gate_pending gate_rev=1 files=\\d+ `, 'm'));
    expect(resumed.stdout).toMatch(/^PLAN_INPUT: .*plan\.md is missing; restored the checkpoint copy to .*elsewhere\/run\/plan-input\/plan\.md$/m);
    expect(resumed.stdout).toContain(`GSTACK_RESULT: skill=autoplan status=gate_pending run=${moved}`);
    expect(journal(moved).find(r => r.event === 'restored')).toMatchObject({ host: os.hostname() });
    const state = readRun(moved);
    expect(state.plan_input).toBe(path.join(moved, 'plan-input', 'plan.md'));
    expect(state.active_plan).toBe(path.join(moved, 'plan-active.md'));
    const answered = autoplan(['answer', '--out', moved, '--gate-rev', '1', '--reply', 'as-is', '--by', 'human'], { env: c.e });
    expect(answered.status, answered.stderr).toBe(0);
    expect(answered.stdout).toContain('status=complete');
    expect(answered.stderr).toMatch(/^CHECKPOINT: .* status=complete gate_rev=1 /m);
    expect(autoplan(['export', '--out', moved]).status).toBe(0);
    const v = validate(moved);
    expect(v.status, v.stdout + v.stderr).toBe(0);
  });

  test('a tampered file, an escaping path and a non-empty target are refused and write nothing', () => {
    const c = checkpointed('refusals');
    const nonEmpty = path.join(c.dir, 'busy');
    fs.mkdirSync(nonEmpty, { recursive: true });
    fs.writeFileSync(path.join(nonEmpty, 'keep.txt'), 'x');
    const busy = autoplan(['resume', '--out', nonEmpty, '--from', c.cp]);
    expect(busy.status).toBe(3);
    expect(busy.stderr).toMatch(/\(CHECKPOINT_TARGET_EXISTS\)/);
    expect(fs.readdirSync(nonEmpty)).toEqual(['keep.txt']);
    fs.appendFileSync(path.join(c.cp, 'run', 'gate.json'), ' ');
    const target = path.join(c.dir, 'restored');
    const tampered = autoplan(['resume', '--out', target, '--from', c.cp]);
    expect(tampered.status).toBe(3);
    expect(tampered.stderr).toMatch(/gate\.json does not match its sha256.*\(CHECKPOINT_INVALID\)/);
    expect(fs.existsSync(target)).toBe(false);
    const m = JSON.parse(fs.readFileSync(path.join(c.cp, 'checkpoint.json'), 'utf8'));
    fs.writeFileSync(path.join(c.cp, 'checkpoint.json'), JSON.stringify({ ...m, files: { ...m.files, '../../escape.md': m.files['run.json'] } }));
    const escaping = autoplan(['resume', '--out', target, '--from', c.cp]);
    expect(escaping.status).toBe(3);
    expect(escaping.stderr).toMatch(/escapes the checkpoint.*\(CHECKPOINT_INVALID\)/);
    expect(fs.existsSync(target)).toBe(false);
  });
});
