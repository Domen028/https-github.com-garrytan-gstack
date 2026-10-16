/**
 * Field-wave residuals (gstack fix wave review, gate revs 1–2, 2026-10-12/13):
 *  R1 `all` never flips the owner's stated direction: a user-challenge item
 *     whose recommended option changes the plan stays pending under `all` and
 *     is answered only by its own token; the rendering says which ids `all`
 *     leaves open.
 *  R2 every later phase sees its predecessors' consensus: the DX prompt
 *     carries the CEO consensus, not only the Eng prompt.
 *  R3 lib code spawns the Bun that runs it (`process.execPath`), never `bun`
 *     by PATH name, so the snapshot tool and restamp cannot silently run the
 *     Capy image's 1.3.14 when a parent forgot the launch PATH.
 *  R5 gate answers carry provenance: `answer --by <human|agent:<id>>` is
 *     required in an unattended run and lands on every decision row.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseReply, renderGate, type GateList } from '../lib/gate-list';
import { attemptsOf, autoplan, readRun, review, ROOT, runPhase, startSmallRun } from './helpers/autoplan-run-fixture';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'autoplan-residuals-'));
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

const keep = { key: 'a', text: 'keep your direction', changes_plan: false };
const change = { key: 'b', text: 'accept the change both reviewers recommend', changes_plan: true };
const agreed: GateList = {
  schema_version: 1, run: 'r', gate_rev: 1, items: [
    { id: 'uc1', title: 'both voices agree', options: [keep, change], recommended: 'b', kind: 'approval', phase: 'ceo', recommended_basis: 'both voices; remedies shown' },
    { id: 'uc2', title: 'one voice', options: [keep, change], recommended: 'a', kind: 'approval', phase: 'ceo' },
    { id: 'd1', title: 'auto item', options: [keep, change], recommended: 'a', kind: 'auto', phase: 'ceo' },
    { id: 'p1', title: 'Plan approval', options: [{ key: 'a', text: 'approve as-is' }, { key: 'b', text: 'approve with the overrides above' }], recommended: 'a', kind: 'approval' },
  ],
};
const decisions = (out: string) => fs.readFileSync(path.join(out, 'decisions.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));

/** Both voices challenge the same item with the same `changes` and a remedy each: the gate recommends `b`. */
function agreedRun(name: string): string {
  const out = startSmallRun(path.join(TMP, name));
  const native = JSON.stringify([
    { id: 'F1', severity: 'High', title: 'The install check lies by omission', file: 'bin/gstack-doctor', line: 12, fix: 'print PASS/FAIL per component' },
    { id: 'F3', severity: 'High', title: 'Four lanes share result-codes.ts', file: 'lib/result-codes.ts', line: 1, user_challenge: true, changes: 'direction', fix: 'stack the lanes' }]);
  const outside = JSON.stringify([
    { id: 'O1', severity: 'Critical', title: 'The install check lies by omission', file: 'bin/gstack-doctor', line: 14, fix: 'exit non-zero on any FAIL' },
    { id: 'O3', severity: 'High', title: 'Four lanes share result-codes.ts', file: 'lib/result-codes.ts', line: 1, user_challenge: true, changes: 'direction', fix: 'stack the lanes A then B' }]);
  for (const phase of ['ceo', 'eng']) {
    expect(autoplan(['next', '--out', out]).status).toBe(0);
    review(path.join(out, `${phase}-native-prompt.md`), { FIXTURE_FINDINGS: native });
    review(path.join(out, `${phase}-outside-prompt.md`), { FIXTURE_FINDINGS: outside });
    const ids = attemptsOf(out, phase);
    expect(autoplan(['submit', '--out', out, '--phase', phase, '--voice', 'native', '--result', path.join(out, `${phase}-native.md`), '--model', 'anthropic/claude-opus-4-7', '--attempt', ids.native, '--runner', 'host-subagent']).status).toBe(0);
    expect(autoplan(['submit', '--out', out, '--phase', phase, '--voice', 'outside', '--result', path.join(out, `${phase}-outside.md`), '--model', 'openai/gpt-6-astra', '--attempt', ids.outside, '--runner', 'host-subagent']).status).toBe(0);
  }
  expect(readRun(out).status).toBe('gate_pending');
  return out;
}

describe('R1: `all` never flips the owner\'s stated direction', () => {
  test('an approval item recommended b (changes the plan) stays pending under `all`; its own token answers it', () => {
    const r = parseReply('all', agreed);
    expect(r.valid).toBe(true);
    expect(r.pending).toEqual(['uc1']);
    expect(r.choices.map(c => `${c.id}${c.chosen}`)).toEqual(['uc2a', 'd1a', 'p1a']);
    const explicit = parseReply('all except uc1b', agreed);
    expect(explicit.pending).toEqual([]);
    expect(explicit.choices.find(c => c.id === 'uc1')).toMatchObject({ chosen: 'b', how: 'recommended' });
    const kept = parseReply('all except uc1a', agreed);
    expect(kept.choices.find(c => c.id === 'uc1')).toMatchObject({ chosen: 'a', how: 'override' });
    expect(parseReply('all as-is', agreed).choices.find(c => c.id === 'uc1')).toMatchObject({ chosen: 'a' });
  });

  test('the rendering names the ids `all` leaves open and their exact tokens', () => {
    const text = renderGate(agreed);
    expect(text).toMatch(/`all` does not answer uc1 \(recommended b changes the plan\); reply uc1a or uc1b/);
    expect(text).toMatch(/"choices":\{"uc2":"a","d1":"a","p1":"a"\}/);
  });

  test('end to end: both voices agree, the gate recommends b, and `all` keeps the gate pending on that item', () => {
    const out = agreedRun('agreed');
    const gate = JSON.parse(fs.readFileSync(path.join(out, 'gate.json'), 'utf8')) as GateList;
    const uc = gate.items.filter(i => i.id.startsWith('uc'));
    expect(uc.length).toBeGreaterThan(0);
    expect(uc.every(i => i.recommended === 'b')).toBe(true);
    const all = autoplan(['answer', '--out', out, '--gate-rev', '1', '--reply', 'all', '--by', 'human']);
    expect(all.status, all.stderr).toBe(0);
    expect(all.stdout).toMatch(new RegExp(`GATE_PENDING: ${uc.map(i => i.id).join(', ')} unanswered \\(reply with ${uc.map(i => `${i.id}a|${i.id}b`).join(' ')}; all does not answer items recommended b\\)`));
    expect(readRun(out).status).toBe('gate_pending');
    const rows = decisions(out);
    for (const i of uc) expect(rows.find(r => r.label === i.id.toUpperCase()).status).toBe('pending');
  });
});

describe('R5: gate answers carry provenance', () => {
  test('an unattended answer without --by is refused and writes nothing; --by lands on every answered row', () => {
    const out = agreedRun('provenance');
    const before = fs.readFileSync(path.join(out, 'decisions.jsonl'), 'utf8');
    const bare = autoplan(['answer', '--out', out, '--gate-rev', '1', '--reply', 'all as-is']);
    expect(bare.status).toBe(3);
    expect(bare.stderr).toMatch(/\(ANSWER_BY_REQUIRED\)/);
    expect(fs.readFileSync(path.join(out, 'decisions.jsonl'), 'utf8')).toBe(before);
    const bad = autoplan(['answer', '--out', out, '--gate-rev', '1', '--reply', 'all as-is', '--by', 'me']);
    expect(bad.status).toBe(3);
    expect(bad.stderr).toMatch(/\(ANSWER_BY_REQUIRED\)/);
    const ok = autoplan(['answer', '--out', out, '--gate-rev', '1', '--reply', 'all as-is', '--by', 'agent:GSTA-29']);
    expect(ok.status, ok.stderr).toBe(0);
    const answered = decisions(out).filter(r => r.status !== 'pending');
    expect(answered.length).toBeGreaterThan(0);
    for (const r of answered) expect(r.answered_by).toBe('agent:GSTA-29');
    expect(fs.readFileSync(path.join(out, 'review-record.md'), 'utf8')).toMatch(/answered by agent:GSTA-29/);
  });
});

describe('R2: later phases see their predecessors\' consensus', () => {
  test('the DX prompt carries the CEO consensus block', () => {
    const out = startSmallRun(path.join(TMP, 'dx-consensus'), ['--developer-tool']);
    expect(readRun(out).phase_order).toEqual(['ceo', 'dx', 'eng']);
    runPhase(out, 'ceo');
    expect(autoplan(['next', '--out', out]).status).toBe(0);
    const dx = fs.readFileSync(path.join(out, 'dx-native-prompt.md'), 'utf8');
    expect(dx).toContain('PRIOR-PHASE CONSENSUS');
    expect(dx).toContain('### CEO');
    expect(fs.readFileSync(path.join(out, 'dx-outside-prompt.md'), 'utf8')).toContain('### CEO');
  });
});

describe('R3: lib code spawns the Bun that runs it', () => {
  /** The admission probe measures the Bun a bare `bun` would run (that is its job); nothing else may. */
  const EXEMPT: Record<string, string> = { 'lib/autoplan-admission.ts': 'probes the PATH Bun for the install verdict by design' };
  test('no spawn of `bun` by PATH name under lib/ or bin/*.ts', () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); continue; }
        if (!p.endsWith('.ts') || p.endsWith('.test.ts')) continue;
        const text = fs.readFileSync(p, 'utf8');
        if (EXEMPT[path.relative(ROOT, p)]) continue;
        text.split('\n').forEach((line, i) => { if (/\bspawn(?:Sync)?\(\s*['"]bun['"]/.test(line)) offenders.push(`${path.relative(ROOT, p)}:${i + 1}`); });
      }
    };
    walk(path.join(ROOT, 'lib'));
    for (const e of fs.readdirSync(path.join(ROOT, 'bin'))) if (e.endsWith('.ts')) {
      const p = path.join(ROOT, 'bin', e);
      fs.readFileSync(p, 'utf8').split('\n').forEach((line, i) => { if (/\bspawn(?:Sync)?\(\s*['"]bun['"]/.test(line)) offenders.push(`bin/${e}:${i + 1}`); });
    }
    expect(offenders).toEqual([]);
  });
});
