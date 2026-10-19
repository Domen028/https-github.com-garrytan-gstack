import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { atomicWriteSync } from '../fs-atomic';
import { repoPolicyTier } from '../gbrain-repo-policy-client';
import { canonicalRemote } from '../remote-identity';
import { resolveStateRoot } from '../state-root';

export type ScopeId = string & { readonly __brand: 'ScopeId' };
export type DocId = string & { readonly __brand: 'DocId' };
export type Capability = 'capture' | 'recall';
export type Mode = 'fast' | 'thinking';

export const DEFAULT_DATABASE = 'gstack_task_memory';
export const API_KEY_ENV = 'HYDRA_DB_API_KEY';

export interface RepoScope {
  readonly id: ScopeId;
  readonly root: string;
  readonly remote: string;
  readonly originUrl: string;
}

export type ScopeResult =
  | { kind: 'ok'; scope: RepoScope }
  | { kind: 'none'; reason: 'not-a-repo' | 'no-origin' | 'local-origin' | 'git-error' };

export interface Grant {
  readonly schema: 1;
  readonly scope: ScopeId;
  readonly remote: string;
  readonly database: string;
  readonly collection: string;
  readonly capture: boolean;
  readonly recall: boolean;
  readonly generation: string;
  readonly grantedAt: string;
}

export type Credential =
  | { kind: 'ok'; key: string; source: 'env' | 'file' }
  | { kind: 'missing' }
  | { kind: 'insecure'; path: string };

export type DeliveryState = 'pending' | 'queued' | 'indexed' | 'retracting' | 'retracted' | 'rejected';

export interface Delivery {
  readonly docId: DocId;
  readonly scope: ScopeId;
  readonly generation: string;
  readonly session: string;
  readonly sha256: string;
  readonly title: string;
  readonly recordedOn: string;
  readonly markdown: string;
  readonly state: DeliveryState;
  readonly updatedAt: string;
}

const DELIVERY_STATES: ReadonlySet<string> = new Set<DeliveryState>(['pending', 'queued', 'indexed', 'retracting', 'retracted', 'rejected']);
const HEX64 = /^[0-9a-f]{64}$/;
const DOC_ID = /^tm_[0-9a-f]{32}$/;
const DATABASE_NAME = /^[a-z0-9_]{1,63}$/;
const GIT_MAX_BUFFER = 64 * 1024;

export const isScopeId = (value: unknown): value is ScopeId => typeof value === 'string' && HEX64.test(value);
export const isDocId = (value: unknown): value is DocId => typeof value === 'string' && DOC_ID.test(value);
export const isDatabaseName = (value: unknown): value is string => typeof value === 'string' && DATABASE_NAME.test(value);

export const stateDir = (env: NodeJS.ProcessEnv = process.env): string => path.join(resolveStateRoot(env), 'task-memory');
const grantPath = (scope: ScopeId) => path.join(stateDir(), 'repos', `${scope}.json`);
const deliveryDir = (scope: ScopeId) => path.join(stateDir(), 'delivery', scope);
export const keyPath = (env: NodeJS.ProcessEnv = process.env) => path.join(stateDir(env), 'hydradb.key');

function privateDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function writePrivate(file: string, data: string): void {
  privateDir(path.dirname(file));
  atomicWriteSync(file, data, { mode: 0o600 });
}

function readJson(file: string): unknown {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

export const collectionFor = (scope: ScopeId): string => `tm_${scope.slice(0, 40)}`;

export function docIdFor(scope: ScopeId, session: string, episodeKey: string): DocId {
  return `tm_${sha256(`${scope}\0${session}\0${episodeKey}`).slice(0, 32)}` as DocId;
}

/** git's environment: English messages and no inherited GIT_* selectors that would point it at another repository. */
function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('GIT_')) env[k] = v;
  return { ...env, LC_ALL: 'C', LANGUAGE: '' };
}

function git(cwd: string, args: string[], timeoutMs: number) {
  return spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: Math.max(1, timeoutMs), env: gitEnv(), maxBuffer: GIT_MAX_BUFFER });
}

export function resolveScope(cwd: string, timeoutMs: number): ScopeResult {
  const top = git(cwd, ['rev-parse', '--show-toplevel'], timeoutMs);
  if (top.error) return { kind: 'none', reason: 'git-error' };
  if (top.status !== 0) return { kind: 'none', reason: /not a git repository/.test(top.stderr ?? '') ? 'not-a-repo' : 'git-error' };
  const origin = git(cwd, ['remote', 'get-url', 'origin'], timeoutMs);
  if (origin.error) return { kind: 'none', reason: 'git-error' };
  const url = (origin.stdout ?? '').trim();
  if (origin.status !== 0 || !url) return { kind: 'none', reason: 'no-origin' };
  const canonical = canonicalRemote(url);
  if (!canonical.hosted || canonical.segments.length < 2) return { kind: 'none', reason: 'local-origin' };
  let root: string;
  try { root = fs.realpathSync((top.stdout ?? '').trim()); } catch { return { kind: 'none', reason: 'git-error' }; }
  return { kind: 'ok', scope: { id: sha256(canonical.canonical) as ScopeId, root, remote: canonical.canonical, originUrl: url } };
}

export function policyAllows(scope: RepoScope, capability: Capability, timeoutMs: number): boolean {
  const policy = repoPolicyTier(scope.originUrl, process.env, timeoutMs);
  if (policy.error || policy.tier === 'deny') return false;
  return !(capability === 'capture' && policy.tier === 'read-only');
}

function parseGrant(value: unknown, scope: ScopeId): Grant | null {
  if (!value || typeof value !== 'object') return null;
  const g = value as Record<string, unknown>;
  if (g.schema !== 1 || g.scope !== scope || typeof g.remote !== 'string' || !isDatabaseName(g.database) ||
      g.collection !== collectionFor(scope) || typeof g.capture !== 'boolean' || typeof g.recall !== 'boolean' ||
      typeof g.generation !== 'string' || !/^[0-9a-f]{32}$/.test(g.generation) ||
      typeof g.grantedAt !== 'string' || !Number.isFinite(Date.parse(g.grantedAt))) return null;
  return { schema: 1, scope, remote: g.remote, database: g.database, collection: g.collection, capture: g.capture,
    recall: g.recall, generation: g.generation, grantedAt: g.grantedAt };
}

export function readGrant(scope: ScopeId): Grant | null {
  return parseGrant(readJson(grantPath(scope)), scope);
}

export function listGrants(): Grant[] {
  let names: string[];
  try { names = fs.readdirSync(path.join(stateDir(), 'repos')); } catch { return []; }
  return names.flatMap(name => {
    const scope = name.replace(/\.json$/, '');
    const grant = isScopeId(scope) ? readGrant(scope) : null;
    return grant ? [grant] : [];
  });
}

export function hasAnyGrant(): boolean {
  try { return fs.readdirSync(path.join(stateDir(), 'repos')).some(n => n.endsWith('.json')); } catch { return false; }
}

export function newGrant(scope: RepoScope, opts: { database: string; capture: boolean; recall: boolean }): Grant {
  return { schema: 1, scope: scope.id, remote: scope.remote, database: opts.database, collection: collectionFor(scope.id),
    capture: opts.capture, recall: opts.recall, generation: randomBytes(16).toString('hex'), grantedAt: new Date().toISOString() };
}

export function saveGrant(grant: Grant): void {
  writePrivate(grantPath(grant.scope), `${JSON.stringify(grant, null, 2)}\n`);
}

export function removeGrant(scope: ScopeId): boolean {
  try { fs.unlinkSync(grantPath(scope)); return true; } catch { return false; }
}

export function grantStillCurrent(held: Grant, capability: Capability): boolean {
  const now = readGrant(held.scope);
  return now !== null && now[capability] && now.generation === held.generation &&
    now.database === held.database && now.collection === held.collection;
}

export function resolveCredential(env: NodeJS.ProcessEnv = process.env): Credential {
  const fromEnv = env[API_KEY_ENV]?.trim();
  if (fromEnv) return { kind: 'ok', key: fromEnv, source: 'env' };
  const file = keyPath(env);
  let stat: fs.Stats;
  try { stat = fs.lstatSync(file); } catch { return { kind: 'missing' }; }
  const owner = process.getuid?.();
  if (!stat.isFile() || (process.platform !== 'win32' && ((stat.mode & 0o077) !== 0 || (owner !== undefined && stat.uid !== owner))))
    return { kind: 'insecure', path: file };
  const key = fs.readFileSync(file, 'utf8').trim();
  return key ? { kind: 'ok', key, source: 'file' } : { kind: 'missing' };
}

export const isPlausibleKey = (key: string): boolean => key.length >= 8 && key.length <= 4096 && !/\s/.test(key);

export function storeCredential(key: string): string {
  const file = keyPath();
  writePrivate(file, `${key}\n`);
  return file;
}

export function removeCredential(): boolean {
  try { fs.unlinkSync(keyPath()); return true; } catch { return false; }
}

export function readMode(): Mode {
  const value = readJson(path.join(stateDir(), 'settings.json')) as { mode?: unknown } | null;
  return value?.mode === 'thinking' ? 'thinking' : 'fast';
}

export function writeMode(mode: Mode): void {
  writePrivate(path.join(stateDir(), 'settings.json'), `${JSON.stringify({ mode })}\n`);
}

function parseDelivery(value: unknown, scope: ScopeId, docId: DocId): Delivery | null {
  if (!value || typeof value !== 'object') return null;
  const d = value as Record<string, unknown>;
  const strings = ['generation', 'session', 'sha256', 'title', 'recordedOn', 'markdown', 'updatedAt'] as const;
  if (d.scope !== scope || d.docId !== docId || !strings.every(k => typeof d[k] === 'string') ||
      typeof d.state !== 'string' || !DELIVERY_STATES.has(d.state)) return null;
  return value as Delivery;
}

export function readDelivery(scope: ScopeId, docId: DocId): Delivery | null {
  return parseDelivery(readJson(path.join(deliveryDir(scope), `${docId}.json`)), scope, docId);
}

export function listDeliveries(scope: ScopeId): Delivery[] {
  let names: string[];
  try { names = fs.readdirSync(deliveryDir(scope)); } catch { return []; }
  return names.flatMap(name => {
    const docId = name.replace(/\.json$/, '');
    const record = isDocId(docId) ? readDelivery(scope, docId) : null;
    return record ? [record] : [];
  });
}

export function writeDelivery(record: Omit<Delivery, 'updatedAt'>): Delivery {
  const full: Delivery = { ...record, updatedAt: new Date().toISOString() };
  writePrivate(path.join(deliveryDir(record.scope), `${record.docId}.json`), `${JSON.stringify(full)}\n`);
  return full;
}

export const contentSha = sha256;

const lockFile = (name: string) => path.join(stateDir(), 'locks', `${name}.lock`);
export const sessionLock = (session: string) => `session-${sha256(session).slice(0, 24)}`;

function tryLock(file: string, ttlMs: number): boolean {
  privateDir(path.dirname(file));
  for (let attempt = 0; attempt < 2; attempt++) {
    try { fs.writeFileSync(file, `${process.pid}\n`, { flag: 'wx', mode: 0o600 }); return true; } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      let fresh = false;
      try { fresh = Date.now() - fs.statSync(file).mtimeMs < ttlMs; } catch {}
      if (fresh) return false;
      try { fs.unlinkSync(file); } catch {}
    }
  }
  return false;
}

function release(file: string): void {
  try { if (fs.readFileSync(file, 'utf8').trim() === String(process.pid)) fs.unlinkSync(file); } catch {}
}

export async function withLock<T>(name: string, opts: { ttlMs: number; waitMs: number }, fn: () => Promise<T> | T): Promise<T | 'busy'> {
  const file = lockFile(name);
  const deadline = Date.now() + opts.waitMs;
  while (!tryLock(file, opts.ttlMs)) {
    if (Date.now() >= deadline) return 'busy';
    await new Promise(r => setTimeout(r, 100));
  }
  try { return await fn(); } finally { release(file); }
}

export const MANAGE_LOCK = 'manage';
