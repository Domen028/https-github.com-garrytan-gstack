/**
 * autoplan-revise — `gstack-autoplan revise` (plan B1c with the B-core
 * amendments): the run reviews a revised plan in the same run directory.
 * Drift is the Implementation-plan hash (the snapshot sha reviewers bound
 * to), not file bytes: every opened phase whose reviewed hash differs from
 * the revision is reopened (open attempts superseded), plus Eng, whose prompt
 * carries the earlier phases' consensus; phases the revised plan newly puts in
 * scope are added (never removed). Accepted gate changes are discharged only
 * when named: `--incorporates <ids>` binds each id to the old and new hashes
 * and refuses an unchanged plan; `--withdraw <id>` is the owner's journaled
 * decision to drop one. Archives keep `.r<rev>` names with `.v<k>` only on
 * collision. One recoverable transaction: the staged plan and state are
 * written and `revise_intent` journaled before anything moves; `resume`
 * (recoverRevise) completes an interrupted revise from the stage.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { exportRun } from './autoplan-export';
import { applyRenames, planReopen } from './autoplan-gate';
import { normalizeRevision, reviewHash, scaffold } from './autoplan-plan-text';
import { PHASES, detectScope, extractHeading, phaseOrder, type Phase, type ScopeFlags } from './autoplan-prompts';
import { FILES, RunError, journal, now, pendingAmendments, readJournal, readState, writeState, type RunState } from './autoplan-state';

export interface ReviseOptions { out: string; plan?: string; incorporates?: string[]; withdraw?: string[]; cwd: string }
export interface ReviseResult { state: RunState; reopened: Phase[]; lines: string[] }

const amendmentLine = (state: RunState) => `AMENDMENTS: pending=${pendingAmendments(state).map(a => a.decision).join(',') || 'none'}`;

/** The revised plan's text as the run reviews it (cut to the run's heading; scaffolded when the run was). */
function revisionText(state: RunState, file: string): string {
  if (!fs.existsSync(file)) throw new RunError('PLAN_SECTIONS_INVALID', `${file}: not found`, 3);
  let text = fs.readFileSync(file, 'utf8');
  if (state.plan_heading) {
    const section = extractHeading(text, state.plan_heading);
    if (section === undefined) throw new RunError('PLAN_SECTIONS_INVALID', `${file}: heading ${JSON.stringify(state.plan_heading)} not found`, 3);
    text = section;
  }
  const diag = scaffold(text);
  if (diag.problem && !(state.scaffolded && diag.text)) throw new RunError('PLAN_SECTIONS_INVALID', `${file}: ${diag.problem}`, 3);
  return diag.text ?? text;
}

function settleAmendments(state: RunState, ids: string[], status: 'incorporated' | 'withdrawn', at: string, extra: Record<string, unknown> = {}): Array<Record<string, unknown>> {
  return ids.map(id => {
    const a = pendingAmendments(state).find(x => x.decision === id)!;
    a.status = status; a.settled_at = at;
    Object.assign(a, extra);
    return { event: status === 'incorporated' ? 'amendment_incorporated' : 'amendment_withdrawn', decision: id, ...extra };
  });
}

export function reviseRun(o: ReviseOptions): ReviseResult {
  const out = path.resolve(o.out);
  const state = readState(out);
  if (['complete', 'incomplete', 'refused'].includes(state.status)) throw new RunError('PHASE_NOT_AWAITING', `run is ${state.status}; revise works on a running or gated run`, 3);
  const pending = pendingAmendments(state).map(a => a.decision);
  for (const id of [...(o.incorporates ?? []), ...(o.withdraw ?? [])]) {
    if (!pending.includes(id)) throw new RunError('PLAN_AMEND_PENDING', `${id} is not a pending amendment (pending: ${pending.join(', ') || 'none'})`, 3);
  }
  const at = now();
  if (!o.plan) {
    for (const row of settleAmendments(state, o.withdraw ?? [], 'withdrawn', at, { by: 'owner' })) journal(out, row);
    writeState(state);
    return { state, reopened: [], lines: [amendmentLine(state)] };
  }
  const file = path.resolve(o.plan);
  const text = revisionText(state, file);
  let newHash: string;
  try { newHash = reviewHash(text); } catch (e: any) { throw new RunError('PLAN_SECTIONS_INVALID', `${file}: ${e.message}`, 3); }
  const oldHash = reviewHash(fs.readFileSync(state.active_plan, 'utf8'));
  if (o.incorporates?.length && newHash === oldHash) {
    throw new RunError('PLAN_AMEND_PENDING', `the Implementation plan did not change (${oldHash.slice(0, 12)}); incorporating ${o.incorporates.join(', ')} needs the edit in ${file}`, 3);
  }
  const k = (state.plan_revision ?? 0) + 1;
  const staging = path.join(out, `.revise-v${k}`);
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  fs.writeFileSync(path.join(staging, FILES.active), normalizeRevision(text, state.restore));
  fs.writeFileSync(path.join(staging, FILES.source), text);

  const flags = (state.scope_flags ?? { ui: state.scope.source === 'flags' ? state.scope.ui : undefined, developerTool: state.scope.developer_tool, agentPrimary: state.scope.agent_primary }) as ScopeFlags;
  const detected = detectScope(path.join(staging, FILES.active), o.cwd, flags);
  const order = PHASES.filter(p => state.phase_order.includes(p) || phaseOrder(detected).includes(p));
  const added = order.filter(p => !state.phase_order.includes(p));
  const opened = state.phase_order.filter(p => state.phases[p]?.snapshot);
  const changed = opened.filter(p => state.phases[p]!.snapshot !== newHash);
  const reopen = state.phase_order.filter(p => changed.includes(p) || (p === 'eng' && opened.includes('eng') && changed.length > 0));
  const atGate = state.status === 'gate_pending' ? state.gate_rev : undefined;
  const incorporated = o.incorporates ?? [];
  journal(out, { event: 'revise_intent', k, staging, plan: file, old_plan_sha256: oldHash, new_plan_sha256: newHash, at_gate_rev: atGate ?? null, incorporates: incorporated, withdraw: o.withdraw ?? [] });

  const renames = reopen.length ? planReopen(state, reopen, state.gate_rev ?? 0, `revise v${k}`) : [];
  for (const p of added) state.phases[p] = {};
  state.phase_order = order; state.required_phases = order;
  state.scope = { ...detected, ui: detected.ui || state.scope.ui, dx: detected.dx || state.scope.dx };
  if (reopen.length || added.length) state.status = 'running';
  state.plan_input = file; state.plan_source = path.join(out, `plan-source.v${k}.md`); state.plan_revision = k;
  delete state.plan_reality;
  const settled = [...settleAmendments(state, incorporated, 'incorporated', at, { old_plan_sha256: oldHash, new_plan_sha256: newHash }), ...settleAmendments(state, o.withdraw ?? [], 'withdrawn', at, { by: 'owner' })];
  const committed = { event: 'plan_revised', k, plan: file, old_plan_sha256: oldHash, new_plan_sha256: newHash, reopened: reopen, added, at_gate_rev: atGate ?? null };
  fs.writeFileSync(path.join(staging, FILES.run), JSON.stringify({ state, renames, committed, settled }, null, 2) + '\n');
  publish(state, staging, renames, committed, settled);
  return { state, reopened: reopen, lines: [`REVISED: plan=${newHash.slice(0, 12)} reopened=${reopen.join(',') || 'none'}${added.length ? ` added=${added.join(',')}` : ''}`, amendmentLine(state)] };
}

/** The commit half of the transaction; recoverRevise replays it from the stage. Every step is idempotent. */
function publish(state: RunState, staging: string, renames: Array<[string, string]>, committed: Record<string, unknown>, settled: Array<Record<string, unknown>>): void {
  applyRenames(state.out, renames);
  if (process.env.GSTACK_AUTOPLAN_FAULT === 'revise-after-archive') throw new Error('fault injected: revise interrupted after archiving (GSTACK_AUTOPLAN_FAULT, tests only)');
  const stagedActive = path.join(staging, FILES.active);
  if (fs.existsSync(stagedActive)) fs.renameSync(stagedActive, state.active_plan);
  const stagedSource = path.join(staging, FILES.source);
  if (fs.existsSync(stagedSource)) fs.renameSync(stagedSource, state.plan_source);
  exportRun(state);
  writeState(state);
  journal(state.out, committed);
  for (const row of settled) journal(state.out, row);
  fs.rmSync(staging, { recursive: true, force: true });
}

/** `resume`: complete a revise whose intent is journaled without its commit, or record it abandoned when nothing was staged. */
export function recoverRevise(out: string): string[] {
  const rows = readJournal(out);
  const intent = rows.filter(r => r.event === 'revise_intent').pop();
  if (!intent || rows.some(r => (r.event === 'plan_revised' || r.event === 'revise_abandoned') && r.k === intent.k)) return [];
  const stagedRun = path.join(intent.staging, FILES.run);
  if (!fs.existsSync(stagedRun)) {
    journal(out, { event: 'revise_abandoned', k: intent.k });
    fs.rmSync(intent.staging, { recursive: true, force: true });
    return [`REVISE_RECOVERED: v${intent.k} abandoned (nothing was published)`];
  }
  const stage = JSON.parse(fs.readFileSync(stagedRun, 'utf8')) as { state: RunState; renames: Array<[string, string]>; committed: Record<string, unknown>; settled: Array<Record<string, unknown>> };
  fs.writeFileSync(path.join(out, FILES.run), JSON.stringify(stage.state, null, 2) + '\n');
  const state = readState(out);
  publish(state, intent.staging, stage.renames, { ...stage.committed, recovered: true }, stage.settled);
  return [`REVISE_RECOVERED: v${intent.k} completed (reopened=${(stage.committed.reopened as string[]).join(',') || 'none'})`];
}
