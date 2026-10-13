/**
 * autoplan-gate — phase close and the final gate of the unattended runner
 * (plan B2, B9, B11). `closePhase` reconciles the outside pass against the
 * native one from canonical ids (lib/autoplan-reconcile.ts), writes the
 * consensus record and the timing row, and marks the phase closed.
 * `finishGate` turns disagreements and user challenges into one gate list
 * (lib/gate-list.ts: `d<n>` auto items, `uc<n>` approval items, `p1` the plan
 * approval), writes decisions.jsonl, tasks.jsonl and the exported files, and
 * leaves the run `gate_pending`: unattended never approves. `answerGate`
 * applies one reply atomically (a stale or conflicting reply writes nothing;
 * a partial one records its answers and keeps the gate); a chosen option that
 * changes the plan (`changes_plan`) reopens the dependent phases with Eng last
 * and is recorded as a pending amendment, and only a reply that changes
 * nothing reviewed finalizes `run.json.status`. Rerun gates turn challenges
 * that name no scope, cost or direction into agent decisions, and answers to
 * unchanged proposals from phases that did not rerun carry forward.
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { exportRun } from './autoplan-export';
import { driftLine } from './autoplan-plan-text';
import { consensusRecord, reconcile, renderConsensus, type ConsensusRecord, type ReconciliationOverride, type ReconciliationRow } from './autoplan-reconcile';
import type { Phase } from './autoplan-prompts';
import { FILES, RunError, journal as journalRow, now, readDecisions, voiceRows, writeDecisions, type RunState, type VoiceState } from './autoplan-state';
import { phaseClose } from './autoplan-timing';
import { applyReply, decisionId, decisionRows, keepDirection, parseReply, validateGateList, type GateChoice, type GateItem, type GateList, type GateOption } from './gate-list';
import type { FindingRow } from './headless-artifacts';
import { readJsonl } from './headless-artifacts';
import { closeDraftDirectionsFile, loadBriefInputs } from './owner-brief';
import { settle } from './spend-ledger';

export function loadOverrides(file: string | undefined): ReconciliationOverride[] {
  if (!file) return [];
  const read = readJsonl(file);
  if (read.errors.length) throw new RunError('ARTIFACT_MALFORMED_JSONL', read.errors.map(e => e.message).join('; '));
  return read.rows as unknown as ReconciliationOverride[];
}

function seconds(v: VoiceState | undefined): number | undefined {
  const a = v?.attempts?.find(x => x.state === 'submitted');
  if (!a?.terminal_at) return undefined;
  return Math.max(0, Math.round((Date.parse(a.terminal_at) - Date.parse(a.dispatched_at)) / 1000));
}

/** Reconcile, write `<phase>-consensus.{json,md}`, record timing, mark closed. Override errors throw before any write. */
export function closePhase(state: RunState, phase: Phase, o: { overridesFile?: string }): { consensus: ConsensusRecord } {
  const ps = state.phases[phase]!;
  const native = voiceRows(state, phase, 'native');
  const outside = voiceRows(state, phase, 'outside');
  const rec = reconcile(native, outside, loadOverrides(o.overridesFile));
  if (rec.errors.length) throw new RunError('ARTIFACT_DANGLING_REF', rec.errors.join('; '));
  const consensus = consensusRecord(phase,
    ps.native?.status === 'completed' ? { rows: native, model: ps.native.model } : null,
    ps.outside?.status === 'completed' ? { rows: outside, model: ps.outside.model, provider: ps.outside.provider } : null, rec);
  const md = renderConsensus(consensus, [...native, ...outside]);
  fs.writeFileSync(path.join(state.out, `${phase}-consensus.json`), JSON.stringify(consensus, null, 2) + '\n');
  fs.writeFileSync(path.join(state.out, `${phase}-consensus.md`), md);
  ps.consensus = { confirmed: consensus.confirmed, disagree: consensus.disagree, new: consensus.new, native_only: consensus.native_only, coverage: consensus.coverage };
  ps.closed_at = now();
  const closed = phaseClose(path.join(state.out, 'timing.json'), state.run, phase, { outside_s: seconds(ps.outside), native_s: seconds(ps.native), session_kind: state.session_kind });
  journalRow(state.out, { event: 'phase_closed', phase, consensus: ps.consensus, wall_s: closed.entry.wall_s, analytics: closed.analytics });
  return { consensus };
}

// ---------------------------------------------------------------------------
// the gate list
// ---------------------------------------------------------------------------
const CONTENT_SCOPE: Record<string, string> = { ceo: 'scope', design: 'design', dx: 'dx', eng: 'arch' };
const optionHash = (options: GateOption[]) => createHash('sha256').update(JSON.stringify(options.map(o => [o.key, o.text]))).digest('hex').slice(0, 16);
const KEEP = (text: string): GateOption => ({ key: 'a', text, changes_plan: false });

/**
 * A user challenge both voices raised recommends the change only when the
 * finding reconciled `confirmed`, both name the same `changes` and the
 * remedies are on the record (both voices', or the parent's one shared
 * proposal from a reconcile override); option b shows them verbatim. Anything
 * weaker keeps the plan's direction, and the basis says why.
 */
function challengeDefault(row: ReconciliationRow, n: FindingRow | undefined, o: FindingRow): { recommended: 'a' | 'b'; basis: string; text: string } {
  const nf = n as (FindingRow & { changes?: string }) | undefined, of = o as FindingRow & { changes?: string };
  const remedies = row.proposal ? ` (shared proposal: ${row.proposal})`
    : nf?.resolution || of.resolution ? ` (native: ${nf?.resolution ?? 'no remedy stated'}; outside: ${of.resolution ?? 'no remedy stated'})` : '';
  const text = `accept the change both reviewers recommend${remedies}`;
  const keep = (basis: string) => ({ recommended: 'a' as const, basis: `plan direction; ${basis}`, text });
  if (row.disposition !== 'confirmed') return keep('voices disagree');
  if (!nf?.changes || !of.changes) return keep('no shared changes value');
  if (nf.changes !== of.changes) return keep('voices name different changes');
  if (row.proposal) return { recommended: 'b', basis: 'both voices; shared proposal', text };
  if (!nf.resolution || !of.resolution) return keep('a remedy is missing');
  return { recommended: 'b', basis: 'both voices; remedies shown', text };
}

/** A rerun challenge naming no scope, cost or direction: the agent's own decision, recorded, reopening nothing. */
function agentDecision(id: string, title: string, phase: string, why: string): GateItem {
  return { id, title, kind: 'auto', recommended: 'a', phase, reopens: false, why: `${why}; it names no scope, cost or direction change, so on a rerun it is the agent's decision`,
    cost: 'agent decision; b is recorded, no phase reruns', options: [KEEP('keep your direction'), { key: 'b', text: 'accept the change (agent decision; no phase reruns)', changes_plan: false }] };
}

export function buildGate(state: RunState, gateRev: number): GateList {
  const items: GateItem[] = [];
  let d = 0, uc = 0;
  for (const phase of state.phase_order) {
    const ps = state.phases[phase];
    if (!ps?.closed_at) continue;
    const consensus = JSON.parse(fs.readFileSync(path.join(state.out, `${phase}-consensus.json`), 'utf8')) as ConsensusRecord;
    const native = voiceRows(state, phase, 'native');
    const outside = voiceRows(state, phase, 'outside');
    const byId = new Map([...native, ...outside].map(f => [f.id, f]));
    const reran = gateRev > 1 && state.history.some(h => h.event === 'reopened' && h.phase === phase);
    const origin = (ids: string, options: GateOption[]) => [phase, ids, ps.closed_at, ps.snapshot, optionHash(options)].join('|');
    const push = (item: GateItem, ids: string) => items.push({ ...item, origin: origin(ids, item.options) });
    const challenged = new Set<string>();
    for (const row of consensus.rows) {
      const o = byId.get(row.outside_id)! as FindingRow & { user_challenge?: boolean; changes?: string };
      const n = (row.native_id ? byId.get(row.native_id) : undefined) as (FindingRow & { user_challenge?: boolean; changes?: string }) | undefined;
      const ids = `${row.native_id}+${row.outside_id}`;
      if (o.user_challenge && n?.user_challenge && row.disposition !== 'new') {
        challenged.add(o.id); challenged.add(n.id);
        const title = `${n.title} [${row.native_id} + ${row.outside_id}]`;
        if (reran && !n.changes && !o.changes) { push(agentDecision(`d${++d}`, title, phase, 'both voices recommend changing your stated direction'), ids); continue; }
        const def = challengeDefault(row, n, o);
        push({ id: `uc${++uc}`, title, kind: 'approval', recommended: def.recommended, recommended_basis: def.basis, phase, ...(n.changes ?? o.changes ? { changes: n.changes ?? o.changes } : {}),
          why: `both voices recommend changing your stated direction; blind spot: ${o.title}; cost if wrong: ${o.resolution ?? n.resolution ?? 'unstated'}`,
          options: [KEEP('keep your direction (the plan as reviewed)'), { key: 'b', text: def.text, changes_plan: true }] }, ids);
        continue;
      }
      if (row.disposition === 'disagree') {
        push({ id: `d${++d}`, title: `${n!.title} [${row.native_id} vs ${row.outside_id}]`, kind: 'auto', recommended: 'a', phase,
          why: `voices disagree: ${row.resolution}`, cost: `b reopens ${phase}${phase === 'eng' ? '' : ' and eng'}`,
          options: [{ key: 'a', text: `native position (${row.severity.native})`, changes_plan: false }, { key: 'b', text: `outside position (${row.severity.outside})`, changes_plan: true }] }, ids);
      }
    }
    for (const f of [...native, ...outside] as Array<FindingRow & { user_challenge?: boolean; changes?: string }>) {
      if (!f.user_challenge || challenged.has(f.id)) continue;
      const why = `one voice (${f.voice}) recommends changing your stated direction`;
      if (reran && !f.changes) { push(agentDecision(`d${++d}`, `${f.title} [${f.id}]`, phase, why), f.id); continue; }
      push({ id: `d${++d}`, title: `${f.title} [${f.id}]`, kind: 'auto', recommended: 'a', phase, why, ...(f.changes ? { changes: f.changes } : {}),
        cost: `b reopens ${phase}${phase === 'eng' ? '' : ' and eng'}`, options: [KEEP('keep your direction'), { key: 'b', text: 'accept the change', changes_plan: true }] }, f.id);
    }
  }
  const changes = items.filter(i => i.options.find(o => o.key === i.recommended)?.changes_plan).map(i => `${i.id}${i.recommended}`);
  items.push({ id: 'p1', title: 'Plan approval', kind: 'approval', recommended: changes.length ? 'b' : 'a',
    options: [{ key: 'a', text: 'approve as-is' }, { key: 'b', text: changes.length ? `approve with the recommended changes: ${changes.join(', ')}` : 'approve with the overrides above' },
      { key: 'c', text: 'interrogate (ask questions; stays pending)' },
      { key: 'd', text: `rerun every phase on the current plan, Eng last (to review an edited plan instead: gstack-autoplan revise --out ${state.out} --plan <file>)` }, { key: 'e', text: 'reject' }] });
  const list: GateList = { schema_version: 1, run: state.run, gate_rev: gateRev, items, title: '/autoplan final approval gate' };
  const problems = validateGateList(list);
  if (problems.length) throw new Error(`gate list invalid: ${problems.join('; ')}`);
  return list;
}

/** Every phase closed: write the gate list, decisions, tasks and the exported files; the run ends gate_pending. Unchanged answered proposals carry forward. */
export function finishGate(state: RunState): GateList {
  const gateRev = (state.gate_rev ?? 0) + 1;
  const list = buildGate(state, gateRev);
  const kept = readDecisions(state.out).filter(r => r.gate_rev !== gateRev);
  const answered = new Map(kept.filter(r => r.origin && r.chosen != null && r.status !== 'pending').map(r => [r.origin!, r]));
  for (const item of list.items) {
    const prev = item.origin ? answered.get(item.origin) : undefined;
    if (prev && item.options.some(o => o.key === prev.chosen)) item.carried = { from: prev.carried_from ?? prev.id, chosen: prev.chosen!, gate_rev: prev.gate_rev };
  }
  fs.writeFileSync(path.join(state.out, 'gate.json'), JSON.stringify(list, null, 2) + '\n');
  const rows = decisionRows(list).map(row => {
    const item = list.items.find(i => decisionId(list.run, gateRev, i.id) === row.id)!;
    if (!item.carried) return row;
    const prev = answered.get(item.origin!)!;
    return { ...row, chosen: item.carried.chosen, status: item.carried.chosen === item.recommended ? 'approved' as const : 'overridden' as const,
      answered_at: prev.answered_at, reply: prev.reply, carried_from: item.carried.from, ...(prev.chosen_text ? { chosen_text: prev.chosen_text } : {}) };
  });
  writeDecisions(state.out, [...kept, ...rows]);
  state.gate_rev = gateRev;
  state.status = 'gate_pending';
  state.gate = { rev: gateRev, items: list.items.length, written_at: now() };
  exportRun(state);
  journalRow(state.out, { event: 'gate_written', gate_rev: gateRev, items: list.items.length, carried: list.items.filter(i => i.carried).map(i => i.id) });
  return list;
}

// ---------------------------------------------------------------------------
// answer
// ---------------------------------------------------------------------------
export interface AnswerResult { state: RunState; applied: boolean; pending: string[]; reopened: Phase[]; outcome: 'complete' | 'gate_pending' | 'reopened' | 'rejected'; lines: string[] }

/**
 * Apply one reply. Earlier answers at this revision stand unless named again;
 * the gate stays pending until every approval settles. A chosen option with
 * `changes_plan` is an accepted plan change: it reopens its phase plus Eng,
 * prints `APPLY:` and becomes a pending amendment (`next` refuses until
 * `revise --incorporates` or `--withdraw`).
 */
export function answerGate(state: RunState, gateRev: number, reply: string): AnswerResult {
  const gateFile = path.join(state.out, 'gate.json');
  if (state.status !== 'gate_pending' || !fs.existsSync(gateFile)) throw new RunError('PHASE_NOT_AWAITING', `run is ${state.status}, not gate_pending`, 3);
  const list = JSON.parse(fs.readFileSync(gateFile, 'utf8')) as GateList;
  const rows = readDecisions(state.out);
  const prior = Object.fromEntries(rows.filter(r => r.gate_rev === list.gate_rev && r.chosen != null && r.status !== 'pending' && r.label).map(r => [r.label!.toLowerCase(), r.chosen!]));
  const parsed = parseReply(reply, list, gateRev, prior);
  if (parsed.error === 'GATE_REV_STALE') throw new RunError('GATE_REV_STALE', `reply names gate_rev=${gateRev}, current gate_rev=${list.gate_rev}`, 3);
  if (!parsed.valid) throw new RunError('GATE_REPLY_UNPARSED', parsed.error === 'GATE_EMPTY' ? 'empty reply' : `unparsed: ${parsed.unparsed.join(', ')}`);
  const itemOf = (id: string) => list.items.find(i => i.id === id)!;
  const optionOf = (c: GateChoice) => itemOf(c.id).options.find(o => o.key === c.chosen)!;
  const plan = parsed.choices.find(c => c.id === 'p1');
  const lines: string[] = [];
  const answeredAt = now();
  const record = () => writeDecisions(state.out, applyReply(rows, parsed, answeredAt).map(r => {
    const c = r.gate_rev === list.gate_rev && r.chosen && !r.chosen_text ? itemOf((r.label ?? '').toLowerCase())?.options.find(o => o.key === r.chosen) : undefined;
    return c ? { ...r, chosen_text: c.text } : r;
  }));
  if (!plan || parsed.pending.length) {
    // Approvals unanswered: record what was answered, keep the gate pending; nothing reviewed changes.
    record();
    const pending = parsed.pending.length ? parsed.pending : ['p1'];
    state.gate = { ...(state.gate ?? {}), last_reply: reply, pending };
    lines.push(`GATE_PENDING: ${pending.join(', ')} unanswered (reply with p1a..p1e or all)`);
    return { state, applied: true, pending, reopened: [], outcome: 'gate_pending', lines };
  }
  const proceeds = plan.chosen !== 'c' && plan.chosen !== 'e';
  const carried = (c: GateChoice) => itemOf(c.id).carried?.chosen === c.chosen;
  const changing = proceeds ? parsed.choices.filter(c => c.id !== 'p1' && !carried(c) && itemOf(c.id).reopens !== false && (optionOf(c).changes_plan ?? c.how === 'override')) : [];
  const tokens = (cs: GateChoice[]) => cs.map(c => `${c.id}${c.chosen}`);
  const overrides = parsed.choices.filter(c => c.how === 'override' && c.id !== 'p1');
  const reopenSet = new Set<Phase>();
  if (plan.chosen === 'd') state.phase_order.forEach(p => reopenSet.add(p));
  for (const c of changing) {
    const phase = itemOf(c.id).phase as Phase | undefined;
    if (phase) { reopenSet.add(phase); if (state.phase_order.includes('eng')) reopenSet.add('eng'); }
  }
  record();
  state.gate = { ...(state.gate ?? {}), answered_at: answeredAt, reply, gate_rev: gateRev, plan: plan.chosen, overrides: tokens(overrides) };
  journalRow(state.out, { event: 'answered', gate_rev: gateRev, reply, plan: plan.chosen, overrides: tokens(overrides), changes: tokens(changing), reopen: [...reopenSet] });
  if (plan.chosen === 'c') {
    lines.push(`GATE_PENDING: interrogate recorded; the gate stays at gate_rev=${gateRev}`);
    return { state, applied: true, pending: ['p1'], reopened: [], outcome: 'gate_pending', lines };
  }
  if (plan.chosen === 'e') {
    state.status = 'incomplete';
    (state.deviations ??= []).push(`plan rejected by the owner at gate_rev ${gateRev}`);
    exportRun(state);
    lines.push('REJECTED: run.json.status=incomplete');
    return { state, applied: true, pending: [], reopened: [], outcome: 'rejected', lines };
  }
  for (const c of changing) {
    const decision = decisionId(state.run, gateRev, c.id);
    (state.amendments ??= []).push({ decision, title: itemOf(c.id).title, chosen: c.chosen, text: optionOf(c).text, gate_rev: gateRev, status: 'pending', at: answeredAt });
    journalRow(state.out, { event: 'amendment_pending', decision, gate_rev: gateRev });
    lines.push(`APPLY: ${decision} ${itemOf(c.id).title} -> ${optionOf(c).text}`);
  }
  if (reopenSet.size === 0) {
    state.status = 'complete';
    lines.push(...closeDraftDirections(state, answeredAt.slice(0, 10)));
    exportRun(state);
    const notes = overrides.filter(o => o.chosen !== keepDirection(itemOf(o.id)));
    lines.push(`APPROVED: gate_rev=${gateRev} ${notes.length ? `overrides=${tokens(notes).join(',')} (none change reviewed content)` : 'as-is'}`);
    return { state, applied: true, pending: [], reopened: [], outcome: 'complete', lines };
  }
  const reopened = state.phase_order.filter(p => reopenSet.has(p));
  const reason = plan.chosen === 'd' ? 'revise' : tokens(changing).join(',');
  reopenPhases(state, reopened, gateRev, `gate_rev ${gateRev}: ${reason}`);
  lines.push(`REOPENED: ${reopened.join(',')} (Eng last) reason=${reason}`);
  const drift = driftLine(state, 'PLAN_SOURCE_CHANGED');
  if (drift) lines.push(drift);
  return { state, applied: true, pending: [], reopened, outcome: 'reopened', lines };
}

/** E3 phase-close operation: every `draft direction stands until the owner decides` line in the active plan becomes the decided option and date. */
function closeDraftDirections(state: RunState, date: string): string[] {
  const loaded = loadBriefInputs(state.out);
  if ('error' in loaded) return [];
  const r = closeDraftDirectionsFile(state.active_plan, loaded.inputs, date);
  if (!r.rewrites.length) return [];
  journalRow(state.out, { event: 'draft_directions_closed', rewritten: r.rewrites.length - r.unresolved.length, unresolved: r.unresolved.map(u => u.line) });
  return [`DRAFT_DIRECTIONS: rewritten=${r.rewrites.length - r.unresolved.length} unresolved=${r.unresolved.length}`];
}

/** `<stem>.r<rev><ext>`, or `<stem>.r<rev>.v<k><ext>` when that name is taken: an archive is never overwritten. */
export function archiveName(out: string, name: string, gateRev: number, taken: Set<string>): string {
  const ext = path.extname(name);
  const stem = name.slice(0, -ext.length || undefined);
  for (let k = 1; ; k++) {
    const candidate = `${stem}.r${gateRev}${k > 1 ? `.v${k}` : ''}${ext}`;
    if (!taken.has(candidate) && !fs.existsSync(path.join(out, candidate))) { taken.add(candidate); return candidate; }
  }
}

/**
 * Reset the reopened phases in `state` (history, superseded open attempts,
 * artifacts) and return the archive renames still to perform, so a caller can
 * journal them before touching the directory (revise's transaction).
 */
export function planReopen(state: RunState, phases: Phase[], gateRev: number, reason: string): Array<[string, string]> {
  const taken = new Set<string>();
  const renames: Array<[string, string]> = [];
  const archive = (name: string) => { if (fs.existsSync(path.join(state.out, name))) renames.push([name, archiveName(state.out, name, gateRev, taken)]); };
  for (const phase of phases) {
    const ps = state.phases[phase] ?? {};
    state.history.push({ event: 'reopened', phase, gate_rev: gateRev, reason, at: now(), previous: ps });
    for (const voice of ['native', 'outside'] as const) {
      for (const a of ps[voice]?.attempts ?? []) {
        if (a.state !== 'dispatched' && a.state !== 'execution_unknown') continue;
        a.state = 'superseded'; a.terminal_at = now();
        settle(path.join(state.out, FILES.spend), a.attempt, 'unknown');
        journalRow(state.out, { event: 'superseded', attempt: a.attempt, phase, voice, reason });
      }
      const output = ps[voice]?.output;
      if (output) { archive(`${output}.findings.jsonl`); archive(output); delete state.artifacts[output]; }
      archive(`${phase}-${voice}-prompt.md`);
    }
    archive(`${phase}-consensus.json`); archive(`${phase}-consensus.md`);
    delete state.artifacts[`${phase}-consensus.json`]; delete state.artifacts[`${phase}-consensus.md`];
    state.phases[phase] = {};
    journalRow(state.out, { event: 'reopened', phase, gate_rev: gateRev, reason });
  }
  archive('gate.json');
  delete state.artifacts['gate.json'];
  return renames;
}

/** Perform archive renames; a rename already done (source gone, target present) is skipped, so a recovery can replay the list. */
export function applyRenames(out: string, renames: Array<[string, string]>): void {
  for (const [from, to] of renames) {
    if (fs.existsSync(path.join(out, to))) continue;
    if (fs.existsSync(path.join(out, from))) fs.renameSync(path.join(out, from), path.join(out, to));
  }
}

/** Archive the reopened phases' bound files under their gate revision and reset them; the gate itself is archived too. */
export function reopenPhases(state: RunState, phases: Phase[], gateRev: number, reason: string): void {
  applyRenames(state.out, planReopen(state, phases, gateRev, reason));
  state.status = 'running';
  exportRun(state);
}
