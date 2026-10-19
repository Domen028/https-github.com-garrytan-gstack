import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { cli, hookCommands, makeHome, makeRepo, readSettings, ROOT, startFakeHydra, type FakeHydra, type Home } from './helpers/task-memory-fixture';

const KEY = 'fixture-key-for-lifecycle-tests';
const FOREIGN = {
  hooks: {
    UserPromptSubmit: [{ hooks: [{ type: 'command', command: '/opt/other-tool/bin/context-hook' }] }],
    Stop: [{ hooks: [{ type: 'command', command: '/opt/other-tool/bin/session-stop-hook' }] }],
    SessionStart: [{ hooks: [{ type: 'command', command: '/opt/other-tool/bin/session-start-hook' }] }],
  },
};
const OWN = (home: Home, rel: string) => path.join(home.claude, 'skills', 'gstack', 'hosts', 'claude', 'hooks', rel);

let fake: FakeHydra;
let home: Home;
let repo: string;

beforeEach(() => {
  fake = startFakeHydra();
  home = makeHome(fake.origin, FOREIGN);
  repo = makeRepo(home, 'app-a', 'https://github.com/example-org/task-memory-fixture-a.git');
});
afterEach(() => { fake.stop(); home.cleanup(); });

const keyFile = () => path.join(home.state, 'task-memory', 'hydradb.key');
const grantFiles = () => { const d = path.join(home.state, 'task-memory', 'repos'); return fs.existsSync(d) ? fs.readdirSync(d) : []; };
const enable = (cwd = repo, ...args: string[]) => cli(home, cwd, ['enable', '--yes', '--key-stdin', ...args], { input: `${KEY}\n` });
const status = async (cwd = repo) => JSON.parse((await cli(home, cwd, ['status', '--json'])).stdout);
const foreignIntact = () => {
  const commands = ['UserPromptSubmit', 'Stop', 'SessionStart'].flatMap(e => hookCommands(home, e));
  for (const c of ['/opt/other-tool/bin/context-hook', '/opt/other-tool/bin/session-stop-hook', '/opt/other-tool/bin/session-start-hook']) expect(commands).toContain(c);
};
const settingsHook = (args: string[], env: Record<string, string> = {}) =>
  Bun.spawnSync([path.join(ROOT, 'bin', 'gstack-settings-hook'), ...args], { env: { ...home.env, ...env }, timeout: 30_000 });

describe('key custody', () => {
  test('a key from stdin lands only in a private file; status reports where, never the value', async () => {
    const r = await enable();
    expect(r.status).toBe(0);
    expect(fs.statSync(keyFile()).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(keyFile())).mode & 0o777).toBe(0o700);
    expect(fs.readFileSync(keyFile(), 'utf8').trim()).toBe(KEY);
    const s = await status();
    expect(s.key).toBe('file');
    expect(JSON.stringify(s)).not.toContain(KEY);
    for (const file of [home.settings, path.join(home.state, 'task-memory', 'repos', grantFiles()[0]!)]) expect(fs.readFileSync(file, 'utf8')).not.toContain(KEY);
    expect(r.stdout + r.stderr).not.toContain(KEY);
    expect(fake.requests[0]!.authorization).toBe(`Bearer ${KEY}`);
    const grants = JSON.parse(Bun.spawnSync(['bun', path.join(ROOT, 'bin', 'gstack-egress'), 'grants', '--json'], { env: home.env, timeout: 30_000 }).stdout.toString());
    expect(grants.find((g: any) => g.grant === 'hydradb-task-memory')).toMatchObject({ granted: true, value: '1 repository' });

    const off = await cli(home, repo, ['disable', '--remove-key']);
    expect(off.status).toBe(0);
    expect(fs.existsSync(keyFile())).toBe(false);
  }, 60_000);

  test('a key file other users can read is refused, by enable and by status', async () => {
    expect((await enable()).status).toBe(0);
    fs.chmodSync(keyFile(), 0o644);
    expect((await status()).key).toBe('insecure');
    const again = await cli(home, repo, ['enable', '--yes']);
    expect(again.status).toBe(1);
    expect(again.stderr).toContain('chmod 600');
  }, 60_000);
});

describe('refusals leave nothing enabled', () => {
  const nothingEnabled = () => {
    expect(grantFiles()).toEqual([]);
    expect(fs.existsSync(keyFile())).toBe(false);
    expect(hookCommands(home, 'Stop')).toEqual(['/opt/other-tool/bin/session-stop-hook']);
    expect(hookCommands(home, 'UserPromptSubmit')).toEqual(['/opt/other-tool/bin/context-hook']);
  };

  test('no consent, no key, an unreachable or a refusing server', async () => {
    const noConsent = await cli(home, repo, ['enable'], { input: '' });
    expect(noConsent.status).toBe(1);
    expect(noConsent.stderr).toContain('--yes');
    const noKey = await cli(home, repo, ['enable', '--yes'], { input: '' });
    expect(noKey.status).toBe(1);
    expect(noKey.stderr).toContain('HYDRA_DB_API_KEY');
    const offline = await cli(home, repo, ['enable', '--yes', '--key-stdin'], { input: `${KEY}\n`, env: { GSTACK_TASK_MEMORY_TEST_ORIGIN: 'http://127.0.0.1:9' } });
    expect(offline.status).toBe(1);
    expect(offline.stderr).toContain('could not reach HydraDB');
    fake.behavior.rejectKey = true;
    const refused = await enable();
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain('refused the key');
    expect(fake.requests.map(r => r.path)).toEqual(['/databases']);
    nothingEnabled();
  }, 60_000);

  test('a repository without a hosted origin has no scope', async () => {
    const local = path.join(home.home, 'work', 'local-only');
    fs.mkdirSync(local, { recursive: true });
    Bun.spawnSync(['git', 'init', '-q'], { cwd: local, env: home.env, timeout: 20_000 });
    const r = await enable(local);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('no origin remote');
    expect(fake.requests).toEqual([]);
    nothingEnabled();
  }, 60_000);
});

describe('teardown', () => {
  test('disable keeps the hooks while another repository holds a grant, then removes only its own', async () => {
    const repoB = makeRepo(home, 'app-b', 'git@github.com:example-org/task-memory-fixture-b.git');
    expect((await enable()).status).toBe(0);
    expect((await enable(repoB)).status).toBe(0);
    expect(hookCommands(home, 'Stop').filter(c => c.endsWith('task-memory-stop-hook'))).toHaveLength(1);
    expect((await status()).otherRepositories).toBe(1);

    const first = await cli(home, repo, ['disable']);
    expect(first.stdout).toContain('hooks: kept, 1 other repository uses them');
    expect(hookCommands(home, 'Stop')).toContain(OWN(home, 'task-memory-stop-hook'));
    expect((await status()).grant).toBeNull();
    expect((await status(repoB)).grant).toMatchObject({ capture: true, recall: true });

    const last = await cli(home, repoB, ['disable']);
    expect(last.stdout).toContain('hooks: removed');
    expect(JSON.stringify(readSettings(home))).not.toContain('task-memory');
    foreignIntact();
    expect((await cli(home, repoB, ['disable'])).stdout).toContain('no grant');
  }, 90_000);

  test('enable re-points a stale hook path; the --no-team sweep keeps the hooks and the uninstall sweep removes them', async () => {
    const stale = '/old/worktree/hosts/claude/hooks/task-memory-stop-hook';
    const seeded = readSettings(home);
    seeded.hooks.Stop.push({ hooks: [{ type: 'command', command: stale }] });
    fs.writeFileSync(home.settings, JSON.stringify(seeded, null, 2));
    expect((await enable()).status).toBe(0);
    expect(hookCommands(home, 'Stop')).toEqual(['/opt/other-tool/bin/session-stop-hook', OWN(home, 'task-memory-stop-hook')]);

    expect(settingsHook(['prune-stale', '--all'], { GSTACK_SWEEP_EXCLUDE_SOURCES: 'gstack-task-memory' }).exitCode).toBe(0);
    expect(hookCommands(home, 'UserPromptSubmit')).toContain(OWN(home, 'task-memory-prompt-hook'));
    expect(settingsHook(['remove-source', '--source', 'gstack-task-memory']).exitCode).toBe(0);
    expect(JSON.stringify(readSettings(home))).not.toContain('task-memory');
    foreignIntact();
  }, 60_000);
});

describe('mode', () => {
  test('fast by default; thinking when set; anything else refused', async () => {
    expect((await cli(home, repo, ['mode'])).stdout.trim()).toBe('fast');
    expect((await cli(home, repo, ['mode', 'thinking'])).status).toBe(0);
    expect((await cli(home, repo, ['mode'])).stdout.trim()).toBe('thinking');
    expect((await cli(home, repo, ['mode', 'deep'])).status).toBe(1);
  }, 30_000);
});
