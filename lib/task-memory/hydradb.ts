/**
 * Every request, in order: re-check that the caller's grant is still the
 * current one for this destination, scan the exact body bytes for credential
 * shapes, write an egress receipt (fail-closed: no receipt, no send), then
 * send with redirects refused and a deadline. The API key travels only in
 * the Authorization header.
 */
import { randomBytes } from 'node:crypto';
import { buildString } from '@hydradb/sdk/helpers';
import { sha256Hex, writeOutcome, writeReceipt } from '../egress-receipt';
import { scan } from '../redact-engine';
import { isDocId, type Capability, type DocId, type Grant, type Mode, type ScopeId } from './state';

export const HYDRADB_ORIGIN = 'https://api.hydradb.com';
export const SINK = 'hydradb-task-memory';
export const SCHEMA = 1;

export interface Send {
  readonly key: string;
  readonly capability: Capability;
  readonly grant: Pick<Grant, 'generation'>;
  readonly stillAllowed: () => boolean;
}

export interface Destination { readonly database: string; readonly collection: string }

export type HydraResult<T> =
  | { kind: 'ok'; value: T }
  | { kind: 'refused'; reason: 'consent' | 'receipt' | 'redaction' }
  | { kind: 'http'; status: number; retryable: boolean }
  | { kind: 'network'; reason: 'timeout' | 'unreachable' | 'malformed' };

export interface MemoryItem {
  readonly docId: DocId;
  readonly title: string;
  readonly markdown: string;
  readonly recordedOn: string;
}

export type IndexingState = 'queued' | 'processing' | 'searchable' | 'failed' | 'unknown';

export interface RecalledProcedure {
  readonly docId: DocId;
  readonly chunkUuid: string;
  readonly title: string;
  readonly text: string;
  readonly score: number | null;
  readonly recordedOn: string | null;
}

type Wire = Record<string, unknown>;
const object = (v: unknown): v is Wire => v !== null && typeof v === 'object' && !Array.isArray(v);
const array = (v: unknown): Wire[] => Array.isArray(v) ? v.filter(object) : [];
const text = (v: unknown): string | null => typeof v === 'string' ? v : null;

interface Body { readonly bytes: Uint8Array<ArrayBuffer>; readonly contentType: string }

const utf8 = (s: string) => new TextEncoder().encode(s);

const json = (value: unknown): Body => ({ bytes: utf8(JSON.stringify(value)), contentType: 'application/json' });

function multipart(fields: Record<string, string>): Body {
  const boundary = `gstack-task-memory-${randomBytes(12).toString('hex')}`;
  const parts = Object.entries(fields).map(([name, value]) =>
    `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`);
  return { bytes: utf8(`${parts.join('')}--${boundary}--\r\n`), contentType: `multipart/form-data; boundary=${boundary}` };
}

const retryableStatus = (status: number, code: unknown) => status === 429 || status >= 500 || (status === 422 && code === 'TENANT_INFRA_NOT_READY');

async function request(send: Send, method: string, route: string, payloadClass: string, timeoutMs: number,
  body?: Body): Promise<HydraResult<unknown>> {
  if (!send.stillAllowed()) return { kind: 'refused', reason: 'consent' };
  if (body) {
    const found = scan(new TextDecoder().decode(body.bytes), { repoVisibility: 'unknown', maxBytes: 4 * 1024 * 1024 });
    if (found.oversize || found.counts.HIGH > 0) return { kind: 'refused', reason: 'redaction' };
  }
  let receipt: string;
  try {
    receipt = writeReceipt({
      sink: SINK, host: new URL(HYDRADB_ORIGIN).host, payloadClass, bytes: body?.bytes.length ?? 0,
      sha256: body ? sha256Hex(body.bytes) : null, consent: `${send.capability} grant ${send.grant.generation.slice(0, 12)}`,
      lockBudgetMs: Math.min(1000, Math.max(50, timeoutMs / 4)),
    }).id;
  } catch {
    return { kind: 'refused', reason: 'receipt' };
  }
  const outcome = await dispatch(send.key, method, route, timeoutMs, body);
  try { writeOutcome({ receipt, status: outcome.kind === 'ok' ? 'ok' : outcome.kind === 'http' ? outcome.status : outcome.kind, lockBudgetMs: 200 }); } catch {}
  return outcome;
}

async function dispatch(key: string, method: string, route: string, timeoutMs: number, body?: Body): Promise<HydraResult<unknown>> {
  let res: Response;
  try {
    res = await fetch(`${HYDRADB_ORIGIN}${route}`, {
      method, redirect: 'manual', signal: AbortSignal.timeout(Math.max(1, timeoutMs)),
      headers: { authorization: `Bearer ${key}`, 'api-version': '2', ...(body ? { 'content-type': body.contentType } : {}) },
      ...(body ? { body: body.bytes } : {}),
    });
  } catch (err) {
    return { kind: 'network', reason: (err as Error)?.name === 'TimeoutError' ? 'timeout' : 'unreachable' };
  }
  if (res.status >= 300 && res.status < 400) return { kind: 'http', status: res.status, retryable: false };
  let envelope: unknown;
  try { envelope = await res.json(); } catch { envelope = null; }
  const error = object(envelope) && object(envelope.error) ? envelope.error : undefined;
  if (!res.ok) return { kind: 'http', status: res.status, retryable: retryableStatus(res.status, error?.code) };
  if (!object(envelope) || !('data' in envelope)) return { kind: 'network', reason: 'malformed' };
  return { kind: 'ok', value: envelope.data };
}

const map = <A, B>(r: HydraResult<A>, f: (a: A) => B): HydraResult<B> => r.kind === 'ok' ? { kind: 'ok', value: f(r.value) } : r;

export async function ensureDatabase(send: Send, database: string, waitMs: number): Promise<HydraResult<'ready' | 'provisioning'>> {
  const created = await request(send, 'POST', '/databases', 'database-create', 15_000, json({ database }));
  if (created.kind === 'http' && created.status !== 409) return created;
  if (created.kind !== 'ok' && created.kind !== 'http') return created;
  const deadline = Date.now() + waitMs;
  for (;;) {
    const status = await request(send, 'GET', `/databases/status?database=${encodeURIComponent(database)}`, 'database-status', 10_000);
    if (status.kind !== 'ok') return status;
    const infra = object(status.value) && object(status.value.infra) ? status.value.infra : {};
    if (infra.ready_for_ingestion === true) return { kind: 'ok', value: 'ready' };
    if (Date.now() + 2_000 >= deadline) return { kind: 'ok', value: 'provisioning' };
    await new Promise(r => setTimeout(r, 2_000));
  }
}

export async function ingest(send: Send, dest: Destination, scope: ScopeId, items: readonly MemoryItem[], timeoutMs: number): Promise<HydraResult<Set<DocId>>> {
  const memories = items.map(item => ({
    id: item.docId, title: item.title, text: item.markdown, is_markdown: true, infer: false,
    additional_metadata: { tm_schema: SCHEMA, tm_scope: scope, tm_recorded: item.recordedOn },
  }));
  const body = multipart({ type: 'memory', database: dest.database, collection: dest.collection, upsert: 'true', memories: JSON.stringify(memories) });
  const result = await request(send, 'POST', '/context/ingest', 'task-procedure-markdown', timeoutMs, body);
  return map(result, data => new Set(array(object(data) ? data.results : undefined)
    .filter(r => isDocId(r.id) && !r.error && ['queued', 'processing', 'graph_creation', 'completed'].includes(String(r.status)))
    .map(r => r.id as DocId)));
}

/** Indexing state per id; `searchable` from graph_creation on. A scope miss (FILE_NOT_FOUND) reads as unknown, never failed. */
export async function indexing(send: Send, dest: Destination, ids: readonly DocId[], timeoutMs: number): Promise<HydraResult<Map<DocId, IndexingState>>> {
  const query = new URLSearchParams({ database: dest.database, collection: dest.collection, ids: ids.join(',') });
  const result = await request(send, 'GET', `/context/status?${query}`, 'procedure-ids', timeoutMs);
  return map(result, data => {
    const out = new Map<DocId, IndexingState>();
    for (const s of array(object(data) ? data.statuses : undefined)) {
      if (!isDocId(s.id)) continue;
      const state = String(s.indexing_status);
      out.set(s.id, state === 'graph_creation' || state === 'completed' ? 'searchable'
        : state === 'queued' || state === 'processing' ? state
        : (state === 'errored' || state === 'failed') && s.error_code !== 'FILE_NOT_FOUND' ? 'failed' : 'unknown');
    }
    return out;
  });
}

export async function remove(send: Send, dest: Destination, ids: readonly DocId[], timeoutMs: number): Promise<HydraResult<Set<DocId>>> {
  const result = await request(send, 'DELETE', '/context', 'procedure-ids', timeoutMs,
    json({ database: dest.database, collection: dest.collection, type: 'memory', ids }));
  return map(result, data => new Set(array(object(data) ? data.results : undefined)
    .filter(r => isDocId(r.id) && (r.deleted === true || /not found|does not exist/i.test(String(r.error ?? ''))))
    .map(r => r.id as DocId)));
}

const metadataOf = (v: unknown): Wire | null => object(v) ? v : null;

function scoped(metadata: Wire | null, scope: ScopeId): boolean {
  return metadata !== null && metadata.tm_scope === scope && Number(metadata.tm_schema) === SCHEMA;
}

export async function recall(send: Send, dest: Destination, scope: ScopeId, query: string, mode: Mode, excluded: ReadonlySet<DocId>,
  deadline: number): Promise<HydraResult<RecalledProcedure[]>> {
  const result = await request(send, 'POST', '/query', 'prompt-derived-query', deadline - Date.now(), json({
    database: dest.database, collection: dest.collection, query, type: 'memory', mode, query_by: 'hybrid', max_results: 5, graph_context: false,
  }));
  if (result.kind !== 'ok') return result;
  const data = object(result.value) ? result.value : {};
  const chunks = array(data.chunks).filter(c => isDocId(c.id) && !excluded.has(c.id) && text(c.chunk_content));
  const metadata = new Map<string, Wire | null>();
  for (const s of array(data.sources)) if (typeof s.id === 'string') metadata.set(s.id, metadataOf(s.additional_metadata));
  for (const c of chunks) if (metadataOf(c.additional_metadata)) metadata.set(String(c.id), metadataOf(c.additional_metadata));
  const missing = [...new Set(chunks.map(c => String(c.id)).filter(id => !metadata.get(id)))];
  if (missing.length && deadline - Date.now() > 200) {
    const listed = await request(send, 'POST', '/context/list', 'procedure-ids', deadline - Date.now(),
      json({ database: dest.database, collection: dest.collection, type: 'memory', ids: missing, page_size: missing.length }));
    if (listed.kind === 'ok' && object(listed.value)) {
      for (const s of [...array(listed.value.sources), ...array(listed.value.memories)])
        if (typeof s.id === 'string') metadata.set(s.id, metadataOf(s.additional_metadata));
    }
  }
  return {
    kind: 'ok',
    value: chunks.filter(c => scoped(metadata.get(String(c.id)) ?? null, scope)).map(c => {
      const meta = metadata.get(String(c.id))!;
      return {
        docId: c.id as DocId, chunkUuid: text(c.chunk_uuid) ?? String(c.id), title: text(c.source_title) ?? 'Task procedure',
        text: text(c.chunk_content)!, score: typeof c.relevancy_score === 'number' ? c.relevancy_score : null,
        recordedOn: typeof meta.tm_recorded === 'string' ? meta.tm_recorded : null,
      };
    }),
  };
}

export function renderRecalled(items: readonly RecalledProcedure[]): string {
  return buildString({
    chunks: items.map(item => ({
      id: item.docId, chunkUuid: item.chunkUuid, sourceTitle: item.title, chunkContent: item.text,
      ...(item.score === null ? {} : { relevancyScore: item.score }),
      ...(item.recordedOn ? { additionalMetadata: { recorded: item.recordedOn } } : {}),
    })),
  });
}
