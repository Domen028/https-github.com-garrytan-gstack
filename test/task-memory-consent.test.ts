import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { egressLedgerPath, resolveEgressHome } from '../lib/egress-receipt';
import { indexing, type Send } from '../lib/task-memory/hydradb';
import { docIdFor, grantStillCurrent, newGrant, saveGrant, stateDir, type ScopeId } from '../lib/task-memory/state';
import { cli, hookCommands, makeHome, makeRepo, nativeSession, runRegisteredHook, startFakeHydra, waitFor, type FakeHydra, type Home } from './helpers/task-memory-fixture';

describe('a grant revoked while a request waits for its receipt', () => {
  const saved = { root: process.env.GSTACK_STATE_ROOT, fetch: globalThis.fetch };
  let root: string;
  let fetched: string[];
  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tm-consent-')));
    process.env.GSTACK_STATE_ROOT = root;
    fetched = [];
    globalThis.fetch = Object.assign(async (input: string | URL | Request) => {
      fetched.push(String(input instanceof Request ? input.url : input));
      return Response.json({ success: true, data: { statuses: [] }, error: null });
    }, saved.fetch);
  });
  afterEach(() => {
    if (saved.root === undefined) delete process.env.GSTACK_STATE_ROOT; else process.env.GSTACK_STATE_ROOT = saved.root;
    globalThis.fetch = saved.fetch;
    fs.rmSync(root, { recursive: true, force: true });
  });

  async function requestWhileLocked(revoke: boolean) {
    const scope = 'a'.repeat(64) as ScopeId;
    const grant = newGrant({ id: scope, root, remote: 'github.com/example-org/x', originUrl: 'https://github.com/example-org/x.git' },
      { database: 'gstack_task_memory', capture: true, recall: true });
    saveGrant(grant);
    const lock = `${egressLedgerPath(resolveEgressHome())}.lock`;
    fs.mkdirSync(lock, { recursive: true });
    const grantFile = path.join(stateDir(), 'repos', `${scope}.json`);
    const other = Bun.spawn(['bun', '-e', `await Bun.sleep(300); ${revoke ? `require('fs').rmSync(${JSON.stringify(grantFile)});` : ''} require('fs').rmdirSync(${JSON.stringify(lock)});`]);
    const send: Send = { key: 'fixture-key', capability: 'capture', grant, stillAllowed: () => grantStillCurrent(grant, 'capture') };
    const result = await indexing(send, { database: grant.database, collection: grant.collection }, [docIdFor(scope, 's', 'e')], 4_000);
    expect(await other.exited).toBe(0);
    return result;
  }

  test('sends nothing once the receipt is written', async () => {
    expect(await requestWhileLocked(true)).toEqual({ kind: 'refused', reason: 'consent' });
    expect(fetched).toEqual([]);
  });

  test('a grant that stays current is sent after the same wait', async () => {
    expect((await requestWhileLocked(false)).kind).toBe('ok');
    expect(fetched).toHaveLength(1);
  });
});

describe('requests need a current grant or enable', () => {
  let fake: FakeHydra;
  let home: Home;
  let repo: string;
  beforeEach(() => {
    fake = startFakeHydra();
    home = makeHome(fake.origin);
    repo = makeRepo(home, 'app', 'https://github.com/example-org/task-memory-consent.git');
  });
  afterEach(() => { fake.stop(); home.cleanup(); });

  test('a prompt whose receipt cannot be written sends no query, and sends one once the ledger is free', async () => {
    expect((await cli(home, repo, ['enable', '--yes', '--key-stdin'], { input: 'fixture-key-for-consent\n' })).status).toBe(0);
    const session = nativeSession(home, repo);
    session.prompt('Fix the add helper so it handles negative numbers');
    const ask = () => runRegisteredHook(home, 'UserPromptSubmit', { session_id: 's', cwd: repo, prompt: 'The add helper breaks on negative numbers', hook_event_name: 'UserPromptSubmit' });
    const lock = path.join(home.state, 'security', 'egress.jsonl.lock');
    fs.mkdirSync(lock, { recursive: true });
    expect((await ask()).status).toBe(0);
    expect(fake.requests.filter(r => r.path === '/query')).toEqual([]);
    fs.rmdirSync(lock);
    await ask();
    expect(fake.requests.filter(r => r.path === '/query')).toHaveLength(1);
  }, 60_000);

  test('a disable that lands while enable waits for the database cancels the enable and stops its requests', async () => {
    fake.behavior.holdDatabase = true;
    const enabling = cli(home, repo, ['enable', '--yes', '--key-stdin'], { input: 'fixture-key-for-consent\n' });
    await waitFor(() => fake.requests.some(r => r.path === '/databases/status'), 30_000);
    const off = await cli(home, repo, ['disable']);
    expect(off.status).toBe(0);
    expect(off.stdout).toContain('cancelled: an enable still provisioning');
    const afterDisable = fake.requests.length;
    delete fake.behavior.holdDatabase;
    const enabled = await enabling;
    expect(enabled.status).toBe(1);
    expect(enabled.stderr).toContain('nothing was enabled');
    expect(fake.requests.length).toBe(afterDisable);
    expect(JSON.parse((await cli(home, repo, ['status', '--json'])).stdout).grant).toBeNull();
    expect(hookCommands(home, 'Stop')).toEqual([]);
    expect(fs.readdirSync(path.join(home.state, 'task-memory', 'repos'))).toEqual([]);
  }, 90_000);
});
