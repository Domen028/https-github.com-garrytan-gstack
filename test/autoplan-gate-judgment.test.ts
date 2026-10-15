/**
 * Gate judgment (plan B2a/B2b, items 8 and 10, with the B-core amendments):
 * findings carry `changes`; a user challenge both voices raised on a confirmed
 * finding with the same `changes` and both remedies recommends `b`, rendering
 * both remedies verbatim and the basis; anything weaker keeps `a` with its
 * basis. Reopen and APPLY key on the chosen option's `changes_plan`; accepted
 * changes are pending amendments that `next` refuses past (PLAN_AMEND_PENDING)
 * until `revise --incorporates` binds them to a changed plan or `--withdraw`
 * drops them. `all as-is` keeps every direction; `all` leaves an item
 * recommended `b` pending (the owner's own token changes their direction;
 * field gate rev 1, d3) and the GATE_PENDING line names the tokens. Partial
 * replies resolve
 * against persisted decisions. On reruns a challenge without `changes` is an
 * agent decision that reopens nothing, rerun prompts carry the decided items,
 * and answered items from phases that did not rerun carry forward.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ROOT, SMALL_PLAN } from './helpers/autoplan-run-fixture';
import { capyRunner, phaseVia, readJsonl, readRunJson, writePlan } from './helpers/autoplan-capy';

const r = capyRunner();
afterAll(() => r.cleanup());
let n = 0;
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const AGREE = {
  native: [{ id: 'F1', severity: 'High', title: 'Ship the backoff behind a flag first', user_challenge: true, changes: 'scope', fix: 'gate the change behind RETRY_BACKOFF=1' }],
  outside: [{ id: 'O1', severity: 'High', title: 'Ship the backoff behind a flag first', user_challenge: true, changes: 'scope', fix: 'add a kill switch flag for the new schedule' }],
};
const DISAGREE = {
  native: [{ id: 'F1', severity: 'Critical', title: 'Persist attempts in a separate table', file: 'lib/worker.ts', line: 10, user_challenge: true, changes: 'scope', fix: 'new table' }],
  outside: [{ id: 'O1', severity: 'Low', title: 'Persist attempts in a separate table', file: 'lib/worker.ts', line: 11, user_challenge: true, changes: 'scope', fix: 'keep the column' }],
};
const MISMATCH = {
  native: [{ id: 'F1', severity: 'Medium', title: 'Drop the jitter requirement', user_challenge: true, changes: 'scope', fix: 'remove jitter' }],
  outside: [{ id: 'O1', severity: 'Medium', title: 'Drop the jitter requirement', user_challenge: true, changes: 'cost', fix: 'remove jitter' }],
};
function gated(ceo: { native?: unknown[]; outside?: unknown[] }, eng: { native?: unknown[]; outside?: unknown[] }): { out: string; dir: string; plan: string; run: string } {
  const dir = path.join(r.host.base, `gj${++n}`);
  const plan = writePlan(dir);
  const out = path.join(dir, 'run');
  expect(r.ap(['next', '--out', out, '--plan', plan, '--no-ui']).status).toBe(0);
  phaseVia(r, out, 'ceo', ceo);
  expect(phaseVia(r, out, 'eng', eng).outside.stdout).toContain('status=gate_pending');
  return { out, dir, plan, run: readRunJson(out).run };
}
const gate = (out: string) => JSON.parse(fs.readFileSync(path.join(out, 'gate.json'), 'utf8'));
const decisions = (out: string) => readJsonl(path.join(out, 'decisions.jsonl'));
const answer = (out: string, rev: number, reply: string, json = false) => r.ap(['answer', '--by', 'human', '--out', out, '--gate-rev', String(rev), '--reply', reply, ...(json ? ['--json'] : [])]);
const v = (dir: string, text: string) => { const f = path.join(dir, `v${++n}.md`); fs.writeFileSync(f, text); return f; };

describe('changes and user-challenge defaults', () => {
  test('`changes` reaches findings.jsonl, the schema and decisions; an unknown value is refused', () => {
    const g = gated(AGREE, {});
    expect(readJsonl(path.join(g.out, 'ceo-native.md.findings.jsonl'))[0]).toMatchObject({ changes: 'scope', user_challenge: true });
    const schema = spawnSync('bun', [path.join(ROOT, 'bin', 'gstack-artifact'), 'schema', 'findings'], { cwd: ROOT, encoding: 'utf8', timeout: 60_000 });
    expect(JSON.parse(schema.stdout).properties.changes).toEqual({ enum: ['scope', 'cost', 'direction'] });
    expect(decisions(g.out).find(d => d.label === 'UC1')).toMatchObject({ changes: 'scope', recommended: 'b', recommended_basis: 'both voices; remedies shown' });
    const dir = path.join(r.host.base, 'badchanges');
    const out = path.join(dir, 'run');
    expect(r.ap(['next', '--out', out, '--plan', writePlan(dir), '--no-ui']).status).toBe(0);
    expect(r.review(path.join(out, 'ceo-native-prompt.md'), { FIXTURE_FINDINGS: JSON.stringify([{ severity: 'Low', title: 'x', user_challenge: true, changes: 'packaging' }]) }).status).toBe(0);
    const bad = r.ap(['submit', '--out', out, '--phase', 'ceo', '--voice', 'native', '--result', path.join(out, 'ceo-native.md'), '--model', 'anthropic/claude-opus-5-5']);
    expect(bad.status).toBe(1);
    expect(bad.stderr).toMatch(/changes "packaging" is not one of scope\|cost\|direction.*\(RESULT_FINDINGS_MISSING\)$/m);
  });

  test('agreeing voices recommend b with both remedies verbatim; disagreement and mismatched changes keep a with the basis', () => {
    const g = gated({ native: [...AGREE.native, ...MISMATCH.native.map(f => ({ ...f, id: 'F2' }))], outside: [...AGREE.outside, ...MISMATCH.outside.map(f => ({ ...f, id: 'O2' }))] }, DISAGREE);
    const items = gate(g.out).items;
    const agree = items.find((i: any) => i.title.startsWith('Ship the backoff'));
    expect(agree).toMatchObject({ kind: 'approval', recommended: 'b', recommended_basis: 'both voices; remedies shown' });
    expect(agree.options.find((o: any) => o.key === 'b')).toMatchObject({ changes_plan: true });
    expect(agree.options.find((o: any) => o.key === 'b').text).toContain('native: gate the change behind RETRY_BACKOFF=1; outside: add a kill switch flag for the new schedule');
    expect(agree.options.find((o: any) => o.key === 'a').changes_plan).toBe(false);
    expect(items.find((i: any) => i.title.startsWith('Drop the jitter'))).toMatchObject({ recommended: 'a', recommended_basis: 'plan direction; voices name different changes' });
    expect(items.find((i: any) => i.title.startsWith('Persist attempts'))).toMatchObject({ recommended: 'a', recommended_basis: 'plan direction; voices disagree' });
    const render = spawnSync('bun', [path.join(ROOT, 'bin', 'gstack-gate'), 'render', path.join(g.out, 'gate.json')], { cwd: ROOT, encoding: 'utf8', timeout: 60_000 });
    expect(render.stdout).toMatch(new RegExp(`\\[${agree.id}\\] .*recommended: b \\(both voices; remedies shown\\)`));
    expect(render.stdout).toMatch(/recommended: a \(plan direction; voices disagree\)/);
    const p1 = items.find((i: any) => i.id === 'p1');
    expect(p1.options.find((o: any) => o.key === p1.recommended).text).toContain(`${agree.id}b`);
  });

  test('a parent reconcile override naming one shared proposal renders that proposal as option b', () => {
    const dir = path.join(r.host.base, 'shared');
    const out = path.join(dir, 'run');
    expect(r.ap(['next', '--out', out, '--plan', writePlan(dir), '--no-ui']).status).toBe(0);
    r.review(path.join(out, 'ceo-native-prompt.md'), { FIXTURE_FINDINGS: JSON.stringify(AGREE.native) });
    r.review(path.join(out, 'ceo-outside-prompt.md'), { FIXTURE_FINDINGS: JSON.stringify(AGREE.outside) });
    const run = readRunJson(out);
    expect(r.ap(['submit', '--out', out, '--phase', 'ceo', '--voice', 'native', '--result', path.join(out, 'ceo-native.md'), '--model', 'anthropic/claude-opus-5-5']).status).toBe(0);
    const overrides = path.join(dir, 'reconcile.jsonl');
    fs.writeFileSync(overrides, JSON.stringify({ outside_id: `${run.run}-ceo-outside-1`, native_id: `${run.run}-ceo-native-1`, disposition: 'confirmed', resolution: 'same change', proposal: 'ship behind RETRY_BACKOFF=1, default off' }) + '\n');
    expect(r.ap(['submit', '--out', out, '--phase', 'ceo', '--voice', 'outside', '--result', path.join(out, 'ceo-outside.md'), '--model', 'openai/gpt-6.1-sol', '--reconcile', overrides]).status).toBe(0);
    phaseVia(r, out, 'eng', {});
    const uc = gate(out).items.find((i: any) => i.title.startsWith('Ship the backoff'));
    expect(uc).toMatchObject({ recommended: 'b', recommended_basis: 'both voices; shared proposal' });
    expect(uc.options.find((o: any) => o.key === 'b').text).toContain('ship behind RETRY_BACKOFF=1, default off');
  });
});

describe('accepted changes are amendments', () => {
  test('`all` leaves the agreeing change pending; its own token accepts it: APPLY, REOPENED, NEXT revise; next refuses until revise --incorporates binds it', () => {
    const g = gated(AGREE, {});
    const held = answer(g.out, 1, 'all');
    expect(held.status, held.stderr).toBe(0);
    expect(held.stdout).toMatch(/^GATE_PENDING: uc1 unanswered \(reply with uc1a\|uc1b; all does not answer items recommended b\)$/m);
    expect(held.stdout).not.toMatch(/^APPLY:/m);
    expect(decisions(g.out).find(d => d.label === 'UC1')).toMatchObject({ status: 'pending' });
    const res = answer(g.out, 1, 'uc1b');
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toMatch(new RegExp(`^APPLY: ${esc(g.run)}-uc1 Ship the backoff behind a flag first .* -> accept the change both reviewers recommend`, 'm'));
    expect(res.stdout).toMatch(/^REOPENED: ceo,eng \(Eng last\) reason=uc1b$/m);
    expect(res.stdout).toMatch(new RegExp(`^NEXT: gstack-autoplan revise --out ${esc(g.out)} --plan ${esc(g.plan)} --incorporates ${esc(g.run)}-uc1$`, 'm'));
    expect(res.stdout).not.toMatch(/^NEXT: gstack-autoplan next/m);
    expect(readRunJson(g.out).amendments).toEqual([expect.objectContaining({ decision: `${g.run}-uc1`, status: 'pending' })]);
    const blocked = r.ap(['next', '--out', g.out]);
    expect(blocked.status).toBe(3);
    expect(blocked.stderr).toMatch(new RegExp(`${esc(g.run)}-uc1.*\\(PLAN_AMEND_PENDING\\)$`, 'm'));
    const runFile = path.join(g.out, 'run.json');
    const saved = fs.readFileSync(runFile, 'utf8');
    fs.writeFileSync(runFile, JSON.stringify({ ...JSON.parse(saved), status: 'complete' }, null, 2) + '\n');
    const exported = r.ap(['export', '--out', g.out]);
    expect(exported.status).toBe(3);
    expect(exported.stderr).toMatch(new RegExp(`${esc(g.run)}-uc1.*\\(PLAN_AMEND_PENDING\\)$`, 'm'));
    fs.writeFileSync(runFile, saved);
    const unrelated = r.ap(['revise', '--out', g.out, '--plan', v(g.dir, SMALL_PLAN.replace('cap 30 s', 'cap 45 s'))]);
    expect(unrelated.status, unrelated.stderr).toBe(0);
    expect(unrelated.stdout).toMatch(new RegExp(`^AMENDMENTS: pending=${esc(g.run)}-uc1$`, 'm'));
    expect(r.ap(['next', '--out', g.out]).status).toBe(3);
    const unchanged = r.ap(['revise', '--out', g.out, '--plan', v(g.dir, SMALL_PLAN.replace('cap 30 s', 'cap 45 s')), '--incorporates', `${g.run}-uc1`]);
    expect(unchanged.status).toBe(3);
    expect(unchanged.stderr).toMatch(/did not change.*\(PLAN_AMEND_PENDING\)$/m);
    const bound = r.ap(['revise', '--out', g.out, '--plan', v(g.dir, SMALL_PLAN.replace('cap 30 s', 'cap 45 s, behind RETRY_BACKOFF=1')), '--incorporates', `${g.run}-uc1`]);
    expect(bound.status, bound.stderr).toBe(0);
    expect(bound.stdout).toMatch(/^AMENDMENTS: pending=none$/m);
    const j = readJsonl(path.join(g.out, 'attempts.jsonl')).find(e => e.event === 'amendment_incorporated');
    expect(j).toMatchObject({ decision: `${g.run}-uc1` });
    expect(j.old_plan_sha256).not.toBe(j.new_plan_sha256);
    expect(r.ap(['next', '--out', g.out]).status).toBe(0);
  });

  test('`all as-is` keeps every direction; --withdraw is a journaled owner decision', () => {
    const g = gated(AGREE, {});
    const asIs = answer(g.out, 1, 'all as-is');
    expect(asIs.status, asIs.stderr).toBe(0);
    expect(asIs.stdout).toMatch(/^APPROVED: gate_rev=1 as-is$/m);
    expect(asIs.stdout).not.toMatch(/^APPLY:/m);
    expect(decisions(g.out).find(d => d.label === 'UC1')).toMatchObject({ chosen: 'a', status: 'overridden' });
    const w = gated(AGREE, {});
    expect(answer(w.out, 1, 'all except uc1b').stdout).toMatch(/^APPLY:/m);
    const withdraw = r.ap(['revise', '--out', w.out, '--withdraw', `${w.run}-uc1`]);
    expect(withdraw.status, withdraw.stderr).toBe(0);
    expect(readJsonl(path.join(w.out, 'attempts.jsonl')).find(e => e.event === 'amendment_withdrawn')).toMatchObject({ decision: `${w.run}-uc1` });
    expect(r.ap(['next', '--out', w.out]).status).toBe(0);
  });
});

describe('partial replies resolve against persisted decisions', () => {
  test('a later `all` never overwrites an earlier override, and p1 alone with approvals unanswered keeps the gate', () => {
    const g = gated({}, {});
    const p1only = answer(g.out, 1, 'p1a', true);
    expect(JSON.parse(p1only.stdout)).toMatchObject({ status: 'gate_pending', outcome: 'gate_pending', pending: ['uc1', 'uc2'] });
    const first = answer(g.out, 1, 'uc1b', true);
    expect(JSON.parse(first.stdout)).toMatchObject({ outcome: 'gate_pending', pending: ['uc2'] });
    const second = answer(g.out, 1, 'all', true);
    expect(JSON.parse(second.stdout)).toMatchObject({ outcome: 'reopened', reopened: ['ceo', 'eng'] });
    expect(decisions(g.out).find(d => d.label === 'UC1')).toMatchObject({ chosen: 'b', status: 'overridden' });
  });

  test('validate rejects a complete run with a pending approval', () => {
    const g = gated({}, {});
    expect(answer(g.out, 1, 'all').stdout).toContain('status=complete');
    const file = path.join(g.out, 'decisions.jsonl');
    fs.writeFileSync(file, decisions(g.out).map(d => JSON.stringify(d.label === 'UC2' ? { ...d, status: 'pending', chosen: null } : d)).join('\n') + '\n');
    r.ap(['export', '--out', g.out]);
    const res = r.validate(g.out);
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/UC2.*\(ARTIFACT_GATE_UNSETTLED\)$/m);
  });
});

describe('reruns', () => {
  test('rerun prompts carry the decided items, a ceo item answered at rev 1 carries forward, and a rerun challenge without `changes` reopens nothing', () => {
    const g = gated({}, AGREE);
    const res = answer(g.out, 1, 'uc1a uc2b p1a');
    expect(res.stdout).toMatch(/^REOPENED: eng \(Eng last\) reason=uc2b$/m);
    expect(r.ap(['revise', '--out', g.out, '--withdraw', `${g.run}-uc2`]).status).toBe(0);
    const eng = phaseVia(r, g.out, 'eng', {
      native: [{ id: 'F9', severity: 'Low', title: 'Name the PR branch per lane', user_challenge: true }],
      outside: [{ id: 'O9', severity: 'Medium', title: 'Price the retry storage before shipping', user_challenge: true, changes: 'cost' }],
    });
    const prompt = fs.readFileSync(path.join(g.out, 'eng-native-prompt.md'), 'utf8');
    expect(prompt).toContain('DECIDED AT THE GATE');
    expect(prompt).toMatch(/uc2b .*Ship the backoff behind a flag first/);
    expect(prompt).toMatch(/uc1a /);
    expect(eng.outside.stdout).toContain('status=gate_pending');
    const rev2 = decisions(g.out).filter(d => d.gate_rev === 2);
    expect(rev2.find(d => d.label === 'UC1')).toMatchObject({ status: 'approved', chosen: 'a', carried_from: `${g.run}-uc1` });
    const items = gate(g.out).items;
    const demoted = items.find((i: any) => i.title.startsWith('Name the PR branch'));
    expect(demoted).toMatchObject({ kind: 'auto', reopens: false });
    expect(items.find((i: any) => i.title.startsWith('Price the retry storage'))).toMatchObject({ kind: 'auto' });
    expect(items.find((i: any) => i.title.startsWith('Price the retry storage')).reopens).not.toBe(false);
    const done = answer(g.out, 2, `${demoted.id}b p1a`, true);
    expect(JSON.parse(done.stdout)).toMatchObject({ outcome: 'complete', reopened: [] });
    expect(decisions(g.out).find(d => d.gate_rev === 2 && d.label === demoted.id.toUpperCase())).toMatchObject({ chosen: 'b', source: 'agent' });
  });
});
