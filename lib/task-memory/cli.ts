/**
 * gstack-task-memory: enable | disable | status | mode | flush for HydraDB
 * task memory, run from inside the repository it applies to.
 *
 * enable asks for consent per capability, takes the API key from
 * HYDRA_DB_API_KEY, the existing key file, `--key-stdin` or a hidden prompt
 * (never argv), provisions the database, registers both hooks at the stable
 * install, and writes the repository's grant last, so a failed step never
 * leaves consent in force. disable revokes this repository's grant first and
 * removes the hooks only when no other repository still holds one.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { repoPolicyTier } from '../gbrain-repo-policy-client';
import { resolveStateRoot } from '../state-root';
import { ensureDatabase, SINK } from './hydradb';
import { flushRepository } from './loop';
import {
  DEFAULT_DATABASE, MANAGE_LOCK, API_KEY_ENV, isDatabaseName, isPlausibleKey, listDeliveries, listGrants, newGrant, policyAllows,
  readGrant, readMode, removeCredential, removeGrant, resolveCredential, resolveScope, saveGrant, storeCredential, withLock, writeMode,
  type Capability, type Mode, type RepoScope,
} from './state';

const ROOT = path.resolve(import.meta.dir, '..', '..');
const SOURCE = 'gstack-task-memory';
const HOOKS = [
  { event: 'UserPromptSubmit', rel: 'hosts/claude/hooks/task-memory-prompt-hook', timeout: '8' },
  { event: 'Stop', rel: 'hosts/claude/hooks/task-memory-stop-hook', timeout: '10' },
] as const;
const DATABASE_WAIT_MS = 60_000;

const USAGE = `Usage: gstack-task-memory <command>

  enable [--capture] [--recall] [--yes] [--key-stdin] [--database <name>] [--mode fast|thinking]
           Turn task memory on for this repository. Without --capture or --recall, both.
  disable [--remove-key]
           Turn it off for this repository; hooks go when no repository uses them.
  status [--json]
           Local state only: grant, key presence, mode, hooks, deliveries.
  mode [fast|thinking]
           Show or set the recall retrieval mode (default fast).
  flush    Retry this repository's undelivered procedures now.

The API key comes from ${API_KEY_ENV}, the stored key file, --key-stdin or a hidden prompt.`;

interface Io { out: (s: string) => void; err: (s: string) => void }
const io: Io = { out: s => process.stdout.write(`${s}\n`), err: s => process.stderr.write(`gstack-task-memory: ${s}\n`) };

class Refusal extends Error {}
function refuse(message: string): never { throw new Refusal(message); }

function flag(args: string[], name: string): boolean {
  const i = args.indexOf(name);
  if (i >= 0) args.splice(i, 1);
  return i >= 0;
}

function option(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const value = args[i + 1];
  if (value === undefined || value.startsWith('--')) refuse(`${name} needs a value`);
  args.splice(i, 2);
  return value;
}

function scopeHere(): RepoScope {
  const resolved = resolveScope(process.cwd(), 5_000);
  if (resolved.kind === 'ok') return resolved.scope;
  const why = { 'not-a-repo': 'this directory is not inside a git repository', 'no-origin': 'this repository has no origin remote',
    'local-origin': 'the origin remote is a local path, which has no stable identity', 'git-error': 'git could not read this repository' };
  return refuse(`${why[resolved.reason]}; task memory needs a hosted origin to scope procedures to one repository`);
}

/** The stable install hooks are registered at (bin/gstack-claude-root.sh), never this tree's own path. */
function canonicalRoot(): string {
  const r = spawnSync('bash', ['-c', '. "$1" && gstack_canonical_claude_root', '_', path.join(ROOT, 'bin', 'gstack-claude-root.sh')],
    { encoding: 'utf8', timeout: 5_000 });
  const root = (r.stdout ?? '').trim();
  return r.status === 0 && root ? root : refuse('could not resolve the stable gstack install (bin/gstack-claude-root.sh)');
}

function settingsHook(root: string, args: string[]) {
  const own = path.join(root, 'bin', 'gstack-settings-hook');
  const bin = fs.existsSync(own) ? own : path.join(ROOT, 'bin', 'gstack-settings-hook');
  return spawnSync(bin, args, { encoding: 'utf8', timeout: 30_000 });
}

/** The stable install must carry these hooks at this version, or the registered command would run other code. */
function compatibleInstall(root: string): void {
  for (const hook of HOOKS) {
    if (!fs.existsSync(path.join(root, hook.rel)) || !fs.existsSync(path.join(root, `${hook.rel}.ts`)))
      refuse(`the stable install at ${root} has no ${path.basename(hook.rel)}; run ./setup (or /gstack-upgrade) first`);
  }
  const read = (p: string) => { try { return fs.readFileSync(p, 'utf8').trim(); } catch { return ''; } };
  const here = read(path.join(ROOT, 'VERSION')), there = read(path.join(root, 'VERSION'));
  if (here && here !== there) refuse(`the stable install at ${root} is version '${there || 'unknown'}' but this tree is '${here}'; run ./setup first`);
}

function hookState(root: string): Record<string, 'registered' | 'missing' | 'unreadable'> {
  const out: Record<string, 'registered' | 'missing' | 'unreadable'> = {};
  for (const hook of HOOKS) {
    const r = settingsHook(root, ['list-items', '--event', hook.event, '--owned-by', SOURCE]);
    out[hook.event] = r.status !== 0 ? 'unreadable' : (r.stdout ?? '').trim() ? 'registered' : 'missing';
  }
  return out;
}

async function ask(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try { return /^y(es)?$/i.test((await rl.question(question)).trim()); } finally { rl.close(); }
}

function hiddenInput(question: string): Promise<string> {
  process.stderr.write(question);
  const stdin = process.stdin;
  stdin.setRawMode(true);
  stdin.resume();
  let value = '';
  return new Promise(resolve => {
    const done = (result: string) => { stdin.off('data', onData); stdin.setRawMode(false); stdin.pause(); process.stderr.write('\n'); resolve(result); };
    const onData = (buf: Buffer) => {
      for (const ch of buf.toString('utf8')) {
        if (ch === '\r' || ch === '\n') return done(value);
        if (ch === '\u0003') return done('');
        value = ch === '\u007f' ? value.slice(0, -1) : value + ch;
      }
    };
    stdin.on('data', onData);
  });
}

function disclosure(scope: RepoScope, database: string, collection: string, wanted: readonly Capability[]): string {
  return [
    `HydraDB task memory for ${scope.remote}`,
    `  destination: https://api.hydradb.com, database ${database}, collection ${collection}`,
    ...(wanted.includes('capture') ? [
      '  capture: after a Claude Code turn in this repository, each task whose edits were followed by a passing test',
      '           run is sent as a short procedure: a redacted goal line from your prompt (160 chars at most),',
      '           repository-relative paths of the edited files, and the test commands with their pass counts.',
      '           Never transcripts, file contents, diffs, tool output or credentials.',
    ] : []),
    ...(wanted.includes('recall') ? [
      '  recall:  each prompt in this repository is sent as a search query (code blocks removed, redacted,',
      '           512 chars at most). Matching procedures are shown to the agent as untrusted reference;',
      '           their commands are never run for you.',
    ] : []),
    `Every request is receipted first: gstack-egress list --sink ${SINK}`,
  ].join('\n');
}

async function enable(args: string[]): Promise<number> {
  const capture = flag(args, '--capture'), recallOnly = flag(args, '--recall');
  const yes = flag(args, '--yes'), keyStdin = flag(args, '--key-stdin');
  const database = option(args, '--database') ?? DEFAULT_DATABASE;
  const mode = option(args, '--mode');
  if (args.length) refuse(`unknown argument: ${args[0]}`);
  if (!isDatabaseName(database)) refuse('--database takes lowercase letters, digits and underscores (63 at most)');
  if (mode !== undefined && mode !== 'fast' && mode !== 'thinking') refuse('--mode takes fast or thinking');
  if (keyStdin && !yes) refuse('--key-stdin reads the key from stdin, so consent must come from --yes');
  const requested: Capability[] = capture || recallOnly ? [...(capture ? ['capture' as const] : []), ...(recallOnly ? ['recall' as const] : [])] : ['capture', 'recall'];
  const scope = scopeHere();
  const allowed = requested.filter(c => policyAllows(scope, c, 10_000));
  for (const c of requested.filter(c => !allowed.includes(c))) io.err(`${c} is blocked by this repository's trust policy (gstack-gbrain-repo-policy)`);
  if (!allowed.length) return refuse('nothing left to enable');
  const root = canonicalRoot();
  compatibleInstall(root);

  const grant = newGrant(scope, { database, capture: false, recall: false });
  io.out(disclosure(scope, database, grant.collection, allowed));
  const granted: Capability[] = [];
  for (const c of allowed) {
    if (yes) granted.push(c);
    else if (!process.stdin.isTTY) refuse('consent needs an interactive terminal, or --yes');
    else if (await ask(`Allow ${c}? [y/N] `)) granted.push(c);
  }
  if (!granted.length) { io.out('Nothing enabled.'); return 1; }

  const existing = resolveCredential();
  if (existing.kind === 'insecure') refuse(`${existing.path} is readable by other users or not a regular file; fix its permissions (chmod 600) or remove it`);
  let entered: string | null = null;
  if (existing.kind === 'missing') {
    entered = keyStdin ? (await Bun.stdin.text()).trim()
      : process.stdin.isTTY ? (await hiddenInput('HydraDB API key (input hidden): ')).trim()
      : refuse(`no API key: set ${API_KEY_ENV}, or pass it on stdin with --key-stdin --yes`);
    if (!isPlausibleKey(entered)) refuse('that does not look like an API key');
  }
  const key = existing.kind === 'ok' ? existing.key : entered!;

  const final = { ...grant, capture: granted.includes('capture'), recall: granted.includes('recall') };
  const send = { key, capability: final.capture ? 'capture' as const : 'recall' as const, grant: final, stillAllowed: () => true };
  const provisioned = await ensureDatabase(send, database, DATABASE_WAIT_MS);
  if (provisioned.kind === 'http') refuse(provisioned.status === 401 || provisioned.status === 403
    ? `HydraDB refused the key (HTTP ${provisioned.status}); nothing was enabled` : `HydraDB answered HTTP ${provisioned.status}; nothing was enabled`);
  if (provisioned.kind !== 'ok') refuse(`could not reach HydraDB (${provisioned.reason}); nothing was enabled`);

  const result = await withLock(MANAGE_LOCK, { ttlMs: 30_000, waitMs: 5_000 }, () => {
    if (entered) io.out(`key: stored in ${storeCredential(entered)} (mode 0600)`);
    for (const hook of HOOKS) {
      const r = settingsHook(root, ['ensure-event', '--event', hook.event, '--command', path.join(root, hook.rel), '--source', SOURCE, '--timeout', hook.timeout]);
      if (r.status === 0) continue;
      if (!listGrants().length) settingsHook(root, ['remove-source', '--source', SOURCE]);
      refuse(`could not register the ${hook.event} hook: ${(r.stderr || r.stdout || '').trim().split('\n')[0]}; nothing was enabled`);
    }
    if (mode) writeMode(mode as Mode);
    saveGrant(final);
    return 0;
  });
  if (result === 'busy') refuse('another gstack-task-memory command is running; try again');
  io.out(`enabled: ${granted.join(' and ')} for ${scope.remote}${provisioned.value === 'provisioning' ? ' (database still provisioning; capture retries until it is ready)' : ''}`);
  io.out(`mode: ${readMode()}. Check with: gstack-task-memory status. Turn off with: gstack-task-memory disable`);
  return 0;
}

async function disable(args: string[]): Promise<number> {
  const removeKey = flag(args, '--remove-key');
  if (args.length) refuse(`unknown argument: ${args[0]}`);
  const scope = scopeHere();
  const result = await withLock(MANAGE_LOCK, { ttlMs: 30_000, waitMs: 5_000 }, () => {
    io.out(removeGrant(scope.id) ? `revoked: capture and recall for ${scope.remote}` : `no grant for ${scope.remote}`);
    const others = listGrants().length;
    if (others) io.out(`hooks: kept, ${others} other repositor${others === 1 ? 'y uses' : 'ies use'} them`);
    else {
      const r = settingsHook(canonicalRoot(), ['remove-source', '--source', SOURCE]);
      if (r.status !== 0) refuse(`grant revoked, but the hooks could not be removed: ${(r.stderr || r.stdout || '').trim().split('\n')[0]}`);
      io.out('hooks: removed');
    }
    if (removeKey) io.out(removeCredential() ? 'key: stored key file removed' : 'key: no stored key file');
    return 0;
  });
  if (result === 'busy') refuse('another gstack-task-memory command is running; try again');
  io.out('Procedures already stored in HydraDB stay there.');
  return 0;
}

function recentErrors(): string[] {
  try {
    return fs.readFileSync(path.join(resolveStateRoot(), 'hook-errors.log'), 'utf8').split('\n').filter(l => / task-memory-(prompt|stop)-hook: /.test(l)).slice(-3);
  } catch { return []; }
}

function status(args: string[]): number {
  const json = flag(args, '--json');
  if (args.length) refuse(`unknown argument: ${args[0]}`);
  const resolved = resolveScope(process.cwd(), 5_000);
  const scope = resolved.kind === 'ok' ? resolved.scope : null;
  const grant = scope ? readGrant(scope.id) : null;
  const credential = resolveCredential();
  const deliveries = scope ? listDeliveries(scope.id) : [];
  const counts: Record<string, number> = {};
  for (const d of deliveries) {
    const k = grant && d.generation === grant.generation ? d.state : 'stale';
    counts[k] = (counts[k] ?? 0) + 1;
  }
  const report = {
    repository: scope ? { remote: scope.remote, scope: scope.id } : { unavailable: resolved.kind === 'none' ? resolved.reason : 'unknown' },
    trust: scope ? repoPolicyTier(scope.originUrl, process.env, 10_000).tier : null,
    grant: grant ? { capture: grant.capture, recall: grant.recall, database: grant.database, collection: grant.collection,
      generation: grant.generation.slice(0, 12), grantedAt: grant.grantedAt } : null,
    otherRepositories: listGrants().filter(g => g.scope !== scope?.id).length,
    key: credential.kind === 'ok' ? credential.source : credential.kind,
    mode: readMode(),
    hooks: hookState(canonicalRoot()),
    deliveries: counts,
    recentErrors: recentErrors(),
  };
  if (json) { io.out(JSON.stringify(report, null, 2)); return 0; }
  io.out(`repository: ${scope ? scope.remote : `none (${report.repository.unavailable})`}`);
  io.out(`grant: ${grant ? `capture ${grant.capture ? 'on' : 'off'}, recall ${grant.recall ? 'on' : 'off'} (database ${grant.database}, since ${grant.grantedAt})` : 'none'}`);
  if (report.trust && report.trust !== 'none') io.out(`trust policy: ${report.trust}`);
  io.out(`key: ${{ env: `from ${API_KEY_ENV}`, file: 'stored key file', missing: 'missing', insecure: 'key file has loose permissions (refused)' }[report.key]}`);
  io.out(`mode: ${report.mode}`);
  io.out(`hooks: ${Object.entries(report.hooks).map(([e, s]) => `${e} ${s}`).join(', ')}`);
  io.out(`deliveries: ${Object.entries(counts).map(([s, n]) => `${n} ${s}`).join(', ') || 'none'} (queued is accepted but not yet searchable)`);
  if (report.otherRepositories) io.out(`other repositories with a grant: ${report.otherRepositories}`);
  for (const line of report.recentErrors) io.out(`recent: ${line}`);
  return 0;
}

async function setMode(args: string[]): Promise<number> {
  const value = args.shift();
  if (args.length) refuse(`unknown argument: ${args[0]}`);
  if (value === undefined) { io.out(readMode()); return 0; }
  if (value !== 'fast' && value !== 'thinking') refuse('mode takes fast or thinking');
  const r = await withLock(MANAGE_LOCK, { ttlMs: 30_000, waitMs: 5_000 }, () => writeMode(value as Mode));
  if (r === 'busy') refuse('another gstack-task-memory command is running; try again');
  io.out(`mode: ${value}`);
  return 0;
}

async function flush(args: string[]): Promise<number> {
  if (args.length) refuse(`unknown argument: ${args[0]}`);
  const report = await flushRepository(process.cwd(), Date.now() + 120_000);
  if (report.kind === 'skipped') refuse(`nothing flushed: ${report.reason}`);
  if (report.kind === 'done') io.out(`flush: ${report.queued} queued, ${report.indexed} now searchable, ${report.retracted} retracted, ${report.pending} still pending`);
  return report.kind === 'done' && report.pending === 0 ? 0 : 1;
}

export async function main(argv: string[]): Promise<number> {
  const [command, ...args] = argv;
  try {
    switch (command) {
      case 'enable': return await enable(args);
      case 'disable': return await disable(args);
      case 'status': return status(args);
      case 'mode': return await setMode(args);
      case 'flush': return await flush(args);
      case 'help': case '--help': case '-h': io.out(USAGE); return 0;
      default: io.err(USAGE); return 1;
    }
  } catch (err) {
    if (err instanceof Refusal) { io.err(err.message); return 1; }
    throw err;
  }
}
