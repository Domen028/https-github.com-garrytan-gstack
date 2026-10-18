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
  });
});

describe('gstack-pregate with a user-owned policy', () => {
  // Value: protects=with no base copy the user file is the policy and its `local` lanes run here, while an unnamed platform lane stays
  //   requires-remote; fails_when=the user fallback or the `local` branch in selectLanes is dropped; why_new=both are new;
  //   seam=none; no_claim=a real CI host (lanes are judged by the fixture's workflows)
  test('the user file is read when the base has none, and a local lane runs here instead of requires-remote', () => {
    const { userPolicy, run } = setup();
    expect(run().out).toContain('(no .gstack/pregate.json)');

    writePolicy(userPolicy, { local: ['free-tests.yml/unit'] });
    const partial = run();
    expect(partial.out).toContain(`policy user ${userPolicy}`);
    expect(partial.out).toContain('requires-remote windows.yml/windows-shard (windows)');
    expect(partial.out).not.toContain('requires-remote free-tests.yml/unit');

    writePolicy(userPolicy, { local: LOCAL_ALL });
    const all = run(['--explain']);
    expect(all.status).toBe(EXIT.ok);
    expect(all.out).toContain('Tiers ran: unit; requires-remote: none');
    expect(all.out).toContain('lane windows.yml/windows-shard: windows lane satisfied locally (pregate.json local)');
    expect(all.out).toMatch(/^tests {6}lanes {5}pass /m);
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
  }, 60_000);
});
