import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  cli, makeHome, makeRepo, nativeSession, runRegisteredHook, startFakeHydra, waitFor, waitForWorkers, type FakeHydra, type Home,
} from './helpers/task-memory-fixture';

const KEY = 'fixture-key-for-delivery-tests';
const ORIGIN = 'https://github.com/example-org/task-memory-delivery.git';

let fake: FakeHydra;
let home: Home;
let repo: string;

beforeEach(() => {
  fake = startFakeHydra();
  home = makeHome(fake.origin);
  repo = makeRepo(home, 'app', ORIGIN);
});
afterEach(() => { fake.stop(); home.cleanup(); });

const enable = (...args: string[]) => cli(home, repo, ['enable', '--yes', '--key-stdin', ...args], { input: `${KEY}\n` });
const status = async () => JSON.parse((await cli(home, repo, ['status', '--json'])).stdout);
const procedures = async () => (await status()).deliveries as Record<string, number>;
const sent = (p: string, method = p === '/context' ? 'DELETE' : 'POST') => fake.requests.filter(r => r.path === p && r.method === method);
const stored = () => [...fake.store.values()].flatMap(m => [...m.values()]);
const prompt = (text: string) =>
  runRegisteredHook(home, 'UserPromptSubmit', { session_id: 'next-session', cwd: repo, prompt: text, hook_event_name: 'UserPromptSubmit' });

function verifiedTask(session = nativeSession(home, repo)) {
  session.prompt('Fix the add helper so it handles negative numbers');
  session.edit('src/math.ts', 'a + b', 'Number(a) + Number(b)');
  expect(session.bash('bun test')).toBe(0);
  return session;
}

async function stop(session: ReturnType<typeof nativeSession>) {
  expect((await runRegisteredHook(home, 'Stop', session.stop)).status).toBe(0);
  await waitForWorkers(session.sessionId);
}

function backOffElapsed() {
  const dir = path.join(home.state, 'task-memory', 'delivery');
  for (const scope of fs.readdirSync(dir)) for (const file of fs.readdirSync(path.join(dir, scope))) {
    const at = path.join(dir, scope, file);
    const record = JSON.parse(fs.readFileSync(at, 'utf8'));
    if (record.retry) fs.writeFileSync(at, JSON.stringify({ ...record, retry: { ...record.retry, after: new Date(0).toISOString() } }));
  }
}

describe('failures are retried, not dropped', () => {
  test('a refused key keeps the procedure pending until the key is fixed', async () => {
    expect((await enable()).status).toBe(0);
    fake.behavior.rejectKey = true;
    await stop(verifiedTask());
    expect(await procedures()).toEqual({ pending: 1 });
    expect((await status()).retrying).toEqual({ auth: 1 });
    delete fake.behavior.rejectKey;
    const flushed = await cli(home, repo, ['flush']);
    expect(flushed.status).toBe(0);
    expect(flushed.stdout).toContain('1 accepted');
    expect(await procedures()).toEqual({ searchable: 1 });
  }, 60_000);

  test('a failed indexing run is uploaded again after its back-off, and a malformed payload is not', async () => {
    expect((await enable()).status).toBe(0);
    fake.behavior.failIndexing = true;
    await stop(verifiedTask());
    expect(sent('/context/ingest')).toHaveLength(1);
    expect(await procedures()).toEqual({ pending: 1 });
    expect((await status()).retrying).toEqual({ 'indexing-failed': 1 });
    delete fake.behavior.failIndexing;
    expect((await cli(home, repo, ['flush'])).status).toBe(0);
    expect(sent('/context/ingest')).toHaveLength(2);
    expect(await procedures()).toEqual({ searchable: 1 });

    fake.behavior.ingestStatus = 400;
    await stop(verifiedTask());
    expect(await procedures()).toEqual({ searchable: 1, rejected: 1 });
    const before = sent('/context/ingest').length;
    await cli(home, repo, ['flush']);
    expect(sent('/context/ingest')).toHaveLength(before);
  }, 90_000);

  test('work a session could not deliver goes out on a later Stop from another session', async () => {
    expect((await enable()).status).toBe(0);
    fake.behavior.ingestStatus = 503;
    await stop(verifiedTask());
    delete fake.behavior.ingestStatus;
    const other = nativeSession(home, repo);
    other.prompt('Explain the add helper');
    other.say('It adds two numbers.');
    await stop(other);
    expect(sent('/context/ingest')).toHaveLength(1);
    backOffElapsed();
    await stop(other);
    expect(sent('/context/ingest')).toHaveLength(2);
    expect(await procedures()).toEqual({ searchable: 1 });
  }, 90_000);
});

describe('an upload whose answer was lost', () => {
  test('is checked and deleted after the procedure loses its proof, never assumed absent', async () => {
    expect((await enable()).status).toBe(0);
    fake.behavior.loseIngestResponse = true;
    const session = verifiedTask();
    await stop(session);
    expect(stored()).toHaveLength(1);
    expect(await procedures()).toEqual({ pending: 1 });
    delete fake.behavior.loseIngestResponse;
    session.edit('src/math.ts', 'Number(a) + Number(b)', 'Number(a) + Number(b) + 0');
    await stop(session);
    expect(await procedures()).toEqual({ retracting: 1 });
    expect((await prompt('The add helper breaks on negative numbers again')).stdout).toBe('');

    const flushed = await cli(home, repo, ['flush']);
    expect(flushed.stdout).toContain('1 removed, 0 still outstanding');
    expect(sent('/context')).toHaveLength(1);
    expect(stored()).toEqual([]);
    expect(await procedures()).toEqual({ retracted: 1 });
  }, 90_000);
});

describe('a deletion HydraDB answers with an unexplained error', () => {
  test('is not taken as removed and backs off instead of holding the queue', async () => {
    expect((await enable()).status).toBe(0);
    const session = verifiedTask();
    await stop(session);
    fake.behavior.deleteError = 'Memory not found or deletion failed';
    session.edit('src/math.ts', 'Number(a) + Number(b)', 'Number(a) + Number(b) + 0');
    await stop(session);
    expect(stored()).toHaveLength(1);
    expect(await procedures()).toEqual({ retracting: 1 });
    expect((await status()).retrying).toEqual({ unavailable: 1 });

    delete fake.behavior.deleteError;
    expect((await cli(home, repo, ['flush'])).status).toBe(0);
    expect(stored()).toEqual([]);
    expect(await procedures()).toEqual({ retracted: 1 });
  }, 90_000);
});

describe('searchable is not settled', () => {
  test('an update waits until HydraDB has finished the earlier upload of the same id', async () => {
    expect((await enable()).status).toBe(0);
    const session = verifiedTask();
    await stop(session);
    fake.behavior.holdIndexing = true;
    stored()[0]!.stage = 'graph_creation';
    session.edit('test/math.test.ts', 'adds zero', 'adds zero to a number');
    expect(session.bash('bun test')).toBe(0);
    await stop(session);
    expect(sent('/context/ingest')).toHaveLength(1);
    expect(await procedures()).toEqual({ pending: 1 });
    delete fake.behavior.holdIndexing;
    expect((await cli(home, repo, ['flush'])).status).toBe(0);
    expect(sent('/context/ingest')).toHaveLength(2);
    expect(sent('/context/ingest')[1]!.payload[0].text).toContain('2. Edited `test/math.test.ts`');
    expect(fake.prematureUpserts).toEqual([]);
  }, 90_000);

  test('a deletion HydraDB refuses while indexing stays pending, hides locally, and lands once indexing completes', async () => {
    expect((await enable()).status).toBe(0);
    fake.behavior.holdIndexing = true;
    const session = verifiedTask();
    await stop(session);
    session.edit('src/math.ts', 'Number(a) + Number(b)', 'Number(a) + Number(b) + 0');
    await stop(session);
    expect(await procedures()).toEqual({ retracting: 1 });
    expect(stored()).toHaveLength(1);
    stored()[0]!.stage = 'graph_creation';
    expect((await prompt('The add helper breaks on negative numbers again')).stdout).toBe('');
    expect(sent('/query')).toHaveLength(1);

    delete fake.behavior.holdIndexing;
    expect((await cli(home, repo, ['flush'])).status).toBe(0);
    expect(stored()).toEqual([]);
    expect(await procedures()).toEqual({ retracted: 1 });
  }, 90_000);
});

describe('one delivery owner per repository', () => {
  test('a Stop that arrives while an upload is in flight still withdraws the invalidated procedure', async () => {
    expect((await enable()).status).toBe(0);
    fake.behavior.ingestDelayMs = 3_000;
    const session = verifiedTask();
    const first = runRegisteredHook(home, 'Stop', session.stop);
    await waitFor(() => sent('/context/ingest').length === 1);
    session.edit('src/math.ts', 'Number(a) + Number(b)', 'Number(a) + Number(b) + 0');
    session.say('One more tweak, not tested.');
    expect((await runRegisteredHook(home, 'Stop', session.stop)).status).toBe(0);
    expect((await first).status).toBe(0);
    await waitForWorkers(session.sessionId);
    await waitFor(() => sent('/context').length > 0, 30_000);
    await waitForWorkers(session.sessionId);
    expect(await procedures()).toEqual({ retracted: 1 });
    expect(stored()).toEqual([]);
  }, 90_000);
});

describe('a later grant for the same destination', () => {
  test('cleans up what an earlier grant sent; a grant for another database never touches the old one', async () => {
    expect((await enable()).status).toBe(0);
    const session = verifiedTask();
    await stop(session);
    expect((await enable('--mode', 'thinking')).status).toBe(0);
    session.edit('src/math.ts', 'Number(a) + Number(b)', 'Number(a) + Number(b) + 0');
    await stop(session);
    expect(stored()).toEqual([]);

    const later = verifiedTask();
    await stop(later);
    expect(stored()).toHaveLength(1);
    expect((await enable('--database', 'other_db')).status).toBe(0);
    later.edit('src/math.ts', 'Number(a) + Number(b)', 'Number(a) - -Number(b)');
    const deletions = sent('/context').length;
    await stop(later);
    expect(sent('/context')).toHaveLength(deletions);
    expect(stored()).toHaveLength(1);
  }, 120_000);
});

describe('memory metadata from /context/list', () => {
  test('a listed memory from another scope is not shown', async () => {
    expect((await enable()).status).toBe(0);
    await stop(verifiedTask());
    fake.behavior.chunkMetadata = false;
    stored()[0]!.additional_metadata = { ...stored()[0]!.additional_metadata, tm_scope: 'f'.repeat(64) };
    expect((await prompt('The add helper breaks on negative numbers again')).stdout).toBe('');
    expect(sent('/context/list')).toHaveLength(1);
  }, 60_000);
});
