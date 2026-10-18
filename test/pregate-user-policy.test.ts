/**
 * The user-owned pregate policy and `local` lanes. A repo that keeps `.gstack/`
 * out of git declares its policy at `<GSTACK_HOME>/projects/<slug>/pregate.json`;
 * the base branch's copy always wins, and `--policy-from head` never reads the
 * user file. A platform lane named in `local` runs here instead of becoming
 * requires-remote. Every assertion holds on any host platform: each lane the
 * fixture selects is either named in `local` or asserted only by label.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { EXIT } from '../lib/headless-artifacts';
import { loadConfigFromUser, validateConfig } from '../lib/pregate/config';
import { buildContext, sha256 } from '../lib/pregate/context';
import { runPregate } from '../lib/pregate/index';
import { BASE_PREGATE, cleanup, commit, makeFixtureRepo, runBin, type FixtureRepo } from './helpers/pregate-fixture';

const repos: FixtureRepo[] = [];
afterEach(() => { while (repos.length) cleanup(repos.pop()!); });

const SLUG = 'userpolicy';
const LOCAL_ALL = ['free-tests.yml/unit', 'windows.yml/windows-shard'];

/** A fixture whose base carries no `.gstack/pregate.json`, a feature commit touching lib/util.js, and the user-file path for its slug. */
function setup(): { repo: FixtureRepo; userPolicy: string; run: (extra?: string[]) => ReturnType<typeof runBin> } {
  const repo = makeFixtureRepo({ pregate: null });
  repos.push(repo);
  commit(repo, { 'lib/util.js': 'exports.add = (a, b) => b + a;\n' });
  const userPolicy = path.join(repo.home, 'projects', SLUG, 'pregate.json');
  fs.mkdirSync(path.dirname(userPolicy), { recursive: true });
  const run = (extra: string[] = []) => runBin(repo, 'gstack-pregate', ['--base', 'main', '--allow-repo-commands', '--stage', 'tests', ...extra], { GSTACK_PROJECT_SLUG: SLUG });
  return { repo, userPolicy, run };
}
const writePolicy = (file: string, policy: Record<string, unknown>) => fs.writeFileSync(file, JSON.stringify({ runner: 'node --test {files}', ...policy }));

describe('pregate.json local', () => {
  // Value: protects=`local` accepts only <workflow file>/<job id> lane ids, shared with selection keys; fails_when=a bare job name or a
  //   string is accepted and silently matches no lane; why_new=the key is new; seam=none; no_claim=none beyond protects
  test('takes <workflow>/<job> ids only', () => {
    expect(validateConfig({ local: ['test.yml/unit'] })).toEqual([]);
    expect(validateConfig({ local: ['unit'] }).map(e => e.path)).toEqual(['local[0]']);
    expect(validateConfig({ local: 'test.yml/unit' }).map(e => e.path)).toEqual(['local']);
    expect(validateConfig({ local: [7] }).map(e => e.path)).toEqual(['local']);
    expect(validateConfig({ selection: { unit: 'true' } }).map(e => e.path)).toEqual(['selection["unit"]']);
  });
});

describe('loadConfigFromUser', () => {
  // Value: protects=a missing user file falls back (null) while any other read error refuses at the file's path, never defaults;
  //   fails_when=every read error is treated as absent and the user's guards silently vanish; why_new=the loader is new; seam=none;
  //   no_claim=EACCES specifically (a directory stands in for an unreadable file)
  test('ENOENT is null; an unreadable file refuses at its path', () => {
    const { userPolicy } = setup();
    expect(loadConfigFromUser(userPolicy)).toBeNull();
    fs.mkdirSync(userPolicy);
    const load = loadConfigFromUser(userPolicy);
    expect(load && 'errors' in load ? load.errors.map(e => [e.code, e.path]) : null).toEqual([['PREGATE_CONFIG_INVALID', userPolicy]]);
    expect(load && 'kind' in load ? [load.kind, load.label] : null).toEqual(['user', `user ${userPolicy}`]);
    // Malformed JSON reaches the sealed/price_file probe too; it must still come back as a refusal, never a throw.
    fs.rmSync(userPolicy, { recursive: true });
    fs.writeFileSync(userPolicy, '{"local": [');
    const bad = loadConfigFromUser(userPolicy);
    expect(bad && 'errors' in bad ? bad.errors.map(e => e.message.startsWith('not valid JSON')) : null).toEqual([true]);
    // The JSON error names this file, not the repo copy parseConfig assumes.
    expect(bad && 'errors' in bad ? bad.errors.map(e => e.path) : null).toEqual([userPolicy]);
  });
});

describe('gstack-pregate with a user-owned policy', () => {
  // Value: protects=with no base copy the user file is the policy and its `local` lanes run here, while an unnamed platform lane stays
  //   requires-remote; fails_when=the user fallback or the `local` branch in selectLanes is dropped; why_new=both are new;
  //   seam=none; no_claim=a real CI host (lanes are judged by the fixture's workflows)
  test('the user file is read when the base has none, and a local lane runs here instead of requires-remote', () => {
    const { repo, userPolicy, run } = setup();
    expect(run().out).toContain('(no .gstack/pregate.json)');

    writePolicy(userPolicy, { local: ['free-tests.yml/unit'] });
    const partial = run();
    expect(partial.out).toContain(`policy user ${userPolicy}`);
    expect(partial.out).toContain('requires-remote windows.yml/windows-shard (windows)');
    expect(partial.out).not.toContain('requires-remote free-tests.yml/unit');

    writePolicy(userPolicy, { local: LOCAL_ALL });
    const all = run(['--explain']);
    expect(all.status).toBe(EXIT.ok);
    // The record pins the user file's bytes, since no commit does.
    const lanes = JSON.parse(fs.readFileSync(path.join(repo.work, '.gstack/tmp/pregate.json'), 'utf8')).checks.find((c: { id: string }) => c.id === 'lanes');
    expect(lanes.inputs.policy).toBe(sha256(fs.readFileSync(userPolicy, 'utf8')));
    expect(all.out).toContain('Tiers ran: unit; requires-remote: none');
    expect(all.out).toContain('lane windows.yml/windows-shard: windows lane satisfied locally (pregate.json local)');
    expect(all.out).toMatch(/^tests {6}lanes {5}pass /m);
  }, 60_000);

  // Value: protects=a fix that says where to declare policy names the user file when it is the active policy, since an edit to the
  //   repo's .gstack/pregate.json is never read on a base that carries none; fails_when=the fix hardcodes .gstack/pregate.json;
  //   why_new=the user source is new; seam=none; no_claim=every fix string (strays, runner, remote_gate share ctx.configFile)
  test('the no-lane fix names the user file when it is the active policy', () => {
    const { repo, userPolicy, run } = setup();
    writePolicy(userPolicy, { local: LOCAL_ALL });
    commit(repo, { 'lib/orphan.js': 'exports.lonely = () => 2;\n' });
    expect(run().status).not.toBe(EXIT.ok);
    const lanes = JSON.parse(fs.readFileSync(path.join(repo.work, '.gstack/tmp/pregate.json'), 'utf8')).checks.find((c: { id: string }) => c.id === 'lanes');
    expect(lanes.code).toBe('PREGATE_NO_LANE');
    expect(lanes.fix).toContain(`under dependencies — or empty_lanes for other documentation — in ${userPolicy}`);
  }, 60_000);

  // Value: protects=an invalid, sealed-bearing or unreadable user file refuses with PREGATE_CONFIG_INVALID naming the file, with a fix
  //   that points at the file rather than the base branch; fails_when=user-file errors run on defaults, or sealed/price_file are accepted
  //   and look active while nothing reads them; why_new=the user source is new; seam=none; no_claim=the sealed guard itself
  test('an invalid, sealed or unreadable user file refuses and names the file', () => {
    const { userPolicy, run } = setup();
    writePolicy(userPolicy, { local: ['not-a-lane'] });
    const invalid = run();
    expect(invalid.status).toBe(EXIT.refused);
    expect(invalid.err).toContain('PREGATE_CONFIG_INVALID');
    expect(invalid.err).toContain(`user ${userPolicy}`);
    expect(invalid.err).toContain(`fix: edit ${userPolicy} directly`);
    expect(invalid.err).not.toContain('.gstack/pregate.json has');

    for (const [key, value] of [['sealed', { paths: ['evals/**'] }], ['price_file', 'evals/calls.json']] as const) {
      writePolicy(userPolicy, { [key]: value });
      const r = run();
      expect(r.status).toBe(EXIT.refused);
      expect(r.err).toContain(`covers gstack-pregate run only; ${key}`);
    }
    // A null price_file is the documented default, not a policy, so it is accepted.
    writePolicy(userPolicy, { price_file: null, local: LOCAL_ALL });
    expect(run().err).not.toContain('PREGATE_CONFIG_INVALID');

    fs.rmSync(userPolicy);
    fs.mkdirSync(userPolicy);
    const unreadable = run();
    expect(unreadable.status).toBe(EXIT.refused);
    expect(unreadable.err).toContain('cannot read the user-owned policy');
  }, 60_000);

  // Value: protects=the user file is consulted only for --policy-from base with no base copy: head mode and a committed base copy never
  //   read it; fails_when=either guard on the fallback is dropped and an unreviewed user file overrides reviewed policy; why_new=the
  //   fallback is new; seam=none; no_claim=none beyond protects
  test('--policy-from head and a base copy never read the user file', () => {
    const { repo, userPolicy, run } = setup();
    writePolicy(userPolicy, { local: ['not-a-lane'] });

    const head = run(['--policy-from', 'head']);
    expect(head.err).not.toContain('PREGATE_CONFIG_INVALID');
    expect(head.out).not.toContain('policy user');

    commit(repo, { '.gstack/pregate.json': JSON.stringify(BASE_PREGATE) + '\n' });
    repo.git('push', '-q', 'origin', 'HEAD:main');
    repo.git('fetch', '-q', 'origin');
    commit(repo, { 'lib/util.js': 'exports.add = (a, b) => a + b + 0;\n' });
    const based = run();
    expect(based.err).not.toContain('PREGATE_CONFIG_INVALID');
    expect(based.out).toContain('origin/main@');
    expect(based.out).not.toContain('policy user');
    // A base copy is pinned by inputs.base; no user digest is recorded.
    const lanes = JSON.parse(fs.readFileSync(path.join(repo.work, '.gstack/tmp/pregate.json'), 'utf8')).checks.find((c: { id: string }) => c.id === 'lanes');
    expect(lanes.inputs.base).toContain('origin/main@');
    expect('policy' in lanes.inputs).toBe(false);
  }, 60_000);

  // Value: protects=the --remote refusal for a policy with no remote_gate tells the user where to declare it: the repo copy "on the
  //   base branch", the user file by its path (never "on the base branch", which the user file is not on); fails_when=the
  //   configFile ternary is dropped or inverted and the user is sent to edit a file nothing reads; why_new=no test reaches the
  //   no-remote_gate branch and the user source is new; seam=none (userConfigPath and remote are existing buildContext options);
  //   no_claim=the remote gate run itself
  test('--remote with no remote_gate names the file to declare it in', async () => {
    const lanesFix = async (repo: FixtureRepo, userConfigPath?: string) => {
      const loaded = buildContext({ repoRoot: repo.work, base: 'main', policyFrom: 'base', allowRepoCommands: true, env: { ...process.env, ...repo.env }, progress: () => {}, cores: 16, testBackend: 'local', remote: { spendCapUsd: 1 }, userConfigPath });
      if (!('ctx' in loaded)) throw new Error('fixture context refused');
      const lanes = (await runPregate(loaded.ctx, { stage: 'tests' })).checks.find(c => c.id === 'lanes')!;
      expect([lanes.status, lanes.code]).toEqual(['incomplete', 'PREGATE_INCOMPLETE']);
      return lanes.fix!;
    };
    const { repo, userPolicy } = setup();
    writePolicy(userPolicy, { local: LOCAL_ALL });
    const user = await lanesFix(repo, userPolicy);
    expect(user).toContain(`in ${userPolicy}, or run the tests locally`);
    expect(user).not.toContain('on the base branch');

    const based = makeFixtureRepo({ pregate: { ...BASE_PREGATE, local: LOCAL_ALL } });
    repos.push(based);
    commit(based, { 'lib/util.js': 'exports.add = (a, b) => b + a;\n' });
    expect(await lanesFix(based)).toContain('in .gstack/pregate.json on the base branch, or run the tests locally');
  }, 60_000);

  // Value: protects=the strays fail fix, the strays warn fix and the PREGATE_STALLED fix each name the user file when it is the active
  //   policy, so the user edits the file that is read; fails_when=any of the three reverts to a hardcoded .gstack/pregate.json, which a
  //   base carrying none never reads; why_new=existing strays and stall tests assert detail and lines, never the fix, and only with a
  //   repo copy; seam=none; no_claim=the stall timing itself (pregate-supervise covers it)
  test('strays (fail and warn) and stall fixes name the user file', () => {
    const { repo, userPolicy, run } = setup();
    writePolicy(userPolicy, { local: LOCAL_ALL });
    const check = (id: string) => JSON.parse(fs.readFileSync(path.join(repo.work, '.gstack/tmp/pregate.json'), 'utf8')).checks.find((c: { id: string }) => c.id === id);
    const strays = (files: Record<string, string | null>) => {
      commit(repo, files);
      runBin(repo, 'gstack-pregate', ['--base', 'main', '--stage', 'preflight', '--only', 'strays'], { GSTACK_PROJECT_SLUG: SLUG });
      return check('strays');
    };

    const fail = strays({ 'notes.txt': 'x\n', 'newtop/thing.js': 'module.exports = 1;\n' });
    expect([fail.status, fail.code]).toEqual(['fail', 'PREGATE_STRAYS']);
    expect(fail.fix).toContain(`goes in ${userPolicy} strays.allow`);

    const warn = strays({ 'notes.txt': null });
    expect([warn.status, warn.code]).toEqual(['warn', 'PREGATE_STRAYS']);
    expect(warn.fix).toContain(`allow it in ${userPolicy} strays.allow`);

    commit(repo, { 'newtop/thing.js': null, 'test/hang.test.js': 'setInterval(() => {}, 1000);\n' });
    run(['--stall-timeout', '2']);
    const stalled = check('lanes');
    expect(stalled.code).toBe('PREGATE_STALLED');
    expect(stalled.fix).toContain(`stall_timeout_s in ${userPolicy}; 0 disables`);
  }, 60_000);

  // Value: protects=a user path inside the checkout (GSTACK_HOME under the repo, or a relative state root when HOME is unset) is
  //   never read, so a PR cannot commit its own "user" policy; fails_when=userConfigRejection is dropped and the in-repo file
  //   becomes the policy; why_new=the trust check is new; seam=none (userConfigPath is an existing buildContext option);
  //   no_claim=a symlinked state root (realish covers it, untested here)
  test('a user path inside the repository or relative is ignored, with an explain line', () => {
    const { repo } = setup();
    const inside = path.join(repo.work, '.gstack', 'projects', 'x', 'pregate.json');
    fs.mkdirSync(path.dirname(inside), { recursive: true });
    fs.writeFileSync(inside, JSON.stringify({ local: ['not-a-lane'] }));
    for (const [file, why] of [[inside, 'inside the repository'], [path.join('.gstack', 'projects', 'x', 'pregate.json'), 'not an absolute path']] as const) {
      const loaded = buildContext({ repoRoot: repo.work, base: 'main', policyFrom: 'base', allowRepoCommands: false, env: { ...process.env, ...repo.env }, progress: () => {}, cores: 16, testBackend: 'local', userConfigPath: file });
      if (!('ctx' in loaded)) throw new Error(`refused: ${loaded.refused.message}`);
      expect(loaded.ctx.configLabel).not.toStartWith('user ');
      expect(loaded.ctx.explain).toContain(`user policy: ${file} ignored (${why}${why === 'inside the repository' ? '; a PR could supply it' : ''})`);
    }
  }, 60_000);

  // Value: protects=--explain says when the user file was looked for and absent, and names a `local` id that matches no platform lane;
  //   fails_when=either line is dropped and a typo'd slug or lane id silently does nothing; why_new=both lines are new; seam=none;
  //   no_claim=the line wording beyond its path and id
  test('--explain names an absent user file and a local id that matches no platform lane', () => {
    const { userPolicy, run } = setup();
    expect(run(['--explain']).out).toContain(`user policy: ${userPolicy} (absent)`);
    writePolicy(userPolicy, { local: [...LOCAL_ALL, 'ci.yml/nope'] });
    const r = run(['--explain']);
    expect(r.out).toContain('local: ci.yml/nope matches no platform lane; ignored');
    expect(r.out).not.toContain('local: free-tests.yml/unit matches');
  }, 60_000);

  // Value: protects=with no GSTACK_PROJECT_SLUG the bin finds the user file under the slug gstack-slug resolves for the repo;
  //   fails_when=the bin computes the slug some other way (a different cwd or state root) and the documented path is never read;
  //   why_new=every other test pins GSTACK_PROJECT_SLUG; seam=none; no_claim=slug rules themselves (state-root tests cover them)
  test('the default slug path is the one gstack-slug prints', () => {
    const { repo } = setup();
    const noSlug = { GSTACK_PROJECT_SLUG: '' };
    const slug = /^SLUG=(.+)$/m.exec(runBin(repo, 'gstack-slug', [], noSlug).out)?.[1];
    expect(slug).toBeTruthy();
    const userPolicy = path.join(repo.home, 'projects', slug!, 'pregate.json');
    fs.mkdirSync(path.dirname(userPolicy), { recursive: true });
    writePolicy(userPolicy, { local: LOCAL_ALL });
    expect(runBin(repo, 'gstack-pregate', ['--base', 'main', '--allow-repo-commands', '--stage', 'tests'], noSlug).out).toContain(`policy user ${userPolicy}`);
  }, 60_000);
});
