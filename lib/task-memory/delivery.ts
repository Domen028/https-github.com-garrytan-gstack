import { createHash } from 'node:crypto';
import { indexing, ingest, remove, type Destination, type HydraResult, type IndexingState, type Send } from './hydradb';
import {
  deliveryLock, listAdmissions, listDeliveries, withLock, writeDelivery,
  type Admission, type Delivery, type DocId, type Grant, type Problem, type ProcedureBody, type ScopeId,
} from './state';

export interface DeliveryContext { readonly grant: Grant; readonly scope: ScopeId; readonly send: Send; readonly dest: Destination }

export interface DeliveryReport { accepted: number; searchable: number; removed: number; outstanding: number }

type Work =
  | { kind: 'upsert'; docId: DocId; body: ProcedureBody; prior: Delivery | null }
  | { kind: 'delete'; docId: DocId; prior: Delivery }
  | { kind: 'watch'; docId: DocId; prior: Delivery };

const MAX_BATCH = 20;
const INDEX_WAIT_MS = 20_000;
const POLL_MS = 2_000;
const LOCK_TTL_MS = 120_000;
const BACKOFF_MS = { first: 60_000, max: 3_600_000 };

const remaining = (deadline: number) => deadline - Date.now();
const held = (d: Delivery | null) => d?.remote.kind === 'held' ? d.remote : null;

/**
 * What each id still needs. Uploads come only from the current grant's
 * admissions, so work admitted under an earlier grant is never resent. A
 * withdrawal removes whatever this machine put in the same destination,
 * whichever grant sent it.
 */
export function plan(admissions: readonly Admission[], deliveries: readonly Delivery[], ctx: Pick<DeliveryContext, 'grant' | 'dest'>,
  opts: { force: boolean; now: number }): Work[] {
  const byId = new Map(deliveries.map(d => [d.docId, d]));
  const work: Work[] = [];
  for (const a of admissions) {
    const prior = byId.get(a.docId) ?? null;
    if (prior && (prior.database !== ctx.dest.database || prior.collection !== ctx.dest.collection)) continue;
    const backedOff = !opts.force && prior?.retry != null && Date.parse(prior.retry.after) > opts.now;
    const remote = held(prior);
    if (a.procedure === null) {
      if (remote && !backedOff) work.push({ kind: 'delete', docId: a.docId, prior: prior! });
    } else if (a.generation === ctx.grant.generation) {
      const same = remote?.sha256 === a.procedure.sha256;
      if (same && remote!.index === 'processing') work.push({ kind: 'watch', docId: a.docId, prior: prior! });
      else if ((!same || remote!.index === 'failed') && prior?.rejected?.sha256 !== a.procedure.sha256 && !backedOff)
        work.push({ kind: 'upsert', docId: a.docId, body: a.procedure, prior });
    }
  }
  return work;
}

/** A content fingerprint of capture's admissions: it changes whenever a capture writes one. */
function fingerprint(scope: ScopeId): string {
  const lines = listAdmissions(scope).map(a => `${a.docId} ${a.generation} ${a.procedure?.sha256 ?? '-'}`).sort();
  return createHash('sha256').update(lines.join('\n')).digest('hex');
}

function problemOf(r: Exclude<HydraResult<unknown>, { kind: 'ok' }>): Problem | { rejected: number } | 'stop' {
  if (r.kind === 'refused') return r.reason === 'consent' ? 'stop' : r.reason === 'redaction' ? { rejected: 0 } : 'unavailable';
  if (r.kind === 'network' || r.retryable) return 'unavailable';
  if (r.status === 401 || r.status === 403) return 'auth';
  if (r.status === 404) return 'destination';
  return { rejected: r.status };
}

function record(ctx: DeliveryContext, docId: DocId, prior: Delivery | null, change: Partial<Pick<Delivery, 'remote' | 'rejected' | 'retry'>>): Delivery {
  return writeDelivery({
    docId, scope: ctx.scope, database: ctx.dest.database, collection: ctx.dest.collection,
    remote: prior?.remote ?? { kind: 'none' }, rejected: prior?.rejected ?? null, retry: prior?.retry ?? null, ...change,
  });
}

function failed(ctx: DeliveryContext, w: Work, problem: Problem | { rejected: number }, sha: string | null): void {
  if (typeof problem === 'object') { record(ctx, w.docId, w.prior, { rejected: { sha256: sha ?? '', status: problem.rejected }, retry: null }); return; }
  const attempts = (w.prior?.retry?.attempts ?? 0) + 1;
  const after = new Date(Date.now() + Math.min(BACKOFF_MS.max, BACKOFF_MS.first * 2 ** (attempts - 1))).toISOString();
  record(ctx, w.docId, w.prior, { retry: { attempts, after, problem } });
}

/** Folds HydraDB's view of an id into its record; returns the record now on disk. */
function observe(ctx: DeliveryContext, w: Work, state: IndexingState | undefined): Delivery | null {
  const remote = held(w.prior);
  if (state === undefined) return w.prior;
  if (state === 'absent') return remote ? record(ctx, w.docId, w.prior, { remote: { kind: 'none' } }) : w.prior;
  if (remote?.index === state) return w.prior;
  const next = record(ctx, w.docId, w.prior, { remote: { kind: 'held', sha256: remote?.sha256 ?? '', index: state } });
  if (state === 'failed') failed(ctx, { ...w, prior: next }, 'indexing-failed', null);
  return next;
}

/** One reconciliation pass over at most MAX_BATCH ids. Returns true while HydraDB is still processing something this run waits on. */
async function pass(ctx: DeliveryContext, work: readonly Work[], deadline: number, report: DeliveryReport): Promise<boolean> {
  const batch = work.slice(0, MAX_BATCH);
  const states = await indexing(ctx.send, ctx.dest, batch.map(w => w.docId), Math.min(10_000, remaining(deadline)));
  if (states.kind !== 'ok') {
    const problem = problemOf(states);
    if (problem !== 'stop' && typeof problem !== 'object') for (const w of batch) if (w.kind !== 'watch') failed(ctx, w, problem, null);
    return false;
  }
  let waiting = false;
  const upserts: Extract<Work, { kind: 'upsert' }>[] = [], deletes: Work[] = [];
  for (const w of batch) {
    const state = states.value.get(w.docId);
    const now = observe(ctx, w, state);
    const ready = state === 'absent' || state === 'settled' || state === 'failed';
    if (w.kind === 'watch') {
      if (state === 'searchable' || state === 'settled') report.searchable++;
      else waiting ||= state === 'processing';
    } else if (w.kind === 'delete') {
      if (state === 'absent') report.removed++;
      else if (ready) deletes.push({ ...w, prior: now ?? w.prior });
      else waiting = true;
    } else if (ready) upserts.push({ ...w, prior: now });
    else waiting = true;
  }
  if (upserts.length) {
    const sent = await ingest(ctx.send, ctx.dest, ctx.scope, upserts.map(w => ({ docId: w.docId, title: w.body.title, markdown: w.body.markdown,
      recordedOn: w.body.recordedOn })), Math.min(30_000, remaining(deadline)));
    for (const w of upserts) {
      const verdict = sent.kind === 'ok' ? sent.value.get(w.docId) : undefined;
      if (verdict === 'accepted') {
        record(ctx, w.docId, w.prior, { remote: { kind: 'held', sha256: w.body.sha256, index: 'processing' }, retry: null, rejected: null });
        report.accepted++;
        waiting = true;
      } else {
        const problem = sent.kind === 'ok' ? (verdict === 'refused' ? 'refused' : 'unavailable') : problemOf(sent);
        if (problem !== 'stop') failed(ctx, w, problem, w.body.sha256);
      }
    }
  }
  if (deletes.length) {
    const removed = await remove(ctx.send, ctx.dest, deletes.map(w => w.docId), Math.min(15_000, remaining(deadline)));
    for (const w of deletes) {
      const verdict = removed.kind === 'ok' ? removed.value.get(w.docId) : undefined;
      if (verdict === 'deleted') { record(ctx, w.docId, w.prior, { remote: { kind: 'none' }, retry: null }); report.removed++; }
      else if (verdict === 'busy') waiting = true;
      else {
        const problem = removed.kind === 'ok' ? 'unavailable' : problemOf(removed);
        if (problem !== 'stop') failed(ctx, w, typeof problem === 'object' ? 'refused' : problem, null);
      }
    }
  }
  return waiting || work.length > batch.length;
}

/**
 * The repository's single delivery owner. It re-reads capture's admissions
 * after every pass and again after releasing its lock, so a Stop that found
 * the owner busy is still delivered by it. HydraDB processing is awaited
 * for at most INDEX_WAIT_MS; what is left waits for the next Stop or flush.
 * Returns 'busy' when another process owns delivery and `waitMs` ran out.
 */
export async function deliverRepository(ctx: DeliveryContext, deadline: number, opts: { force: boolean; waitMs: number }): Promise<DeliveryReport | 'busy'> {
  const report: DeliveryReport = { accepted: 0, searchable: 0, removed: 0, outstanding: 0 };
  const until = Math.min(deadline - 1_000, Date.now() + INDEX_WAIT_MS);
  for (let first = true; ; first = false) {
    let seen = '';
    const owned = await withLock(deliveryLock(ctx.scope), { ttlMs: LOCK_TTL_MS, waitMs: first ? opts.waitMs : 0 }, async () => {
      for (;;) {
        seen = fingerprint(ctx.scope);
        const work = plan(listAdmissions(ctx.scope), listDeliveries(ctx.scope), ctx, { force: opts.force, now: Date.now() });
        const waiting = work.length > 0 && remaining(deadline) > 2_000 && await pass(ctx, work, deadline, report);
        if (fingerprint(ctx.scope) !== seen && remaining(deadline) > 5_000) continue;
        if (!waiting || Date.now() + POLL_MS >= until) return;
        await new Promise(r => setTimeout(r, POLL_MS));
      }
    });
    if (owned === 'busy') { if (first) return 'busy'; break; }
    if (fingerprint(ctx.scope) === seen || remaining(deadline) <= 5_000) break;
  }
  report.outstanding = plan(listAdmissions(ctx.scope), listDeliveries(ctx.scope), ctx, { force: true, now: Date.now() })
    .filter(w => w.kind !== 'watch').length;
  return report;
}

export type Standing = 'pending' | 'processing' | 'searchable' | 'indexed' | 'rejected' | 'retracting' | 'retracted' | 'stale';

const INDEXED: Record<'processing' | 'searchable' | 'settled', Standing> = { processing: 'processing', searchable: 'searchable', settled: 'indexed' };

/** One procedure's standing for `status`, from local records only. */
export function standing(a: Admission, d: Delivery | null, grant: Grant | null): Standing {
  const remote = held(d);
  if (a.procedure === null) return remote ? 'retracting' : 'retracted';
  if (remote?.sha256 === a.procedure.sha256 && remote.index !== 'failed') return INDEXED[remote.index];
  if (!grant || a.generation !== grant.generation) return 'stale';
  return d?.rejected?.sha256 === a.procedure.sha256 ? 'rejected' : 'pending';
}
