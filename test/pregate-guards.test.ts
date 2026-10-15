/**
 * Field wave CD1/CD2 config keys in `.gstack/pregate.json`: the repo's guards
 * (commands a lane must pass before it reports done), the serial-test
 * patterns the lanes check runs in their own process, and the non-executing
 * call-plan command a paid gate is priced from. Validation stays strict:
 * every key is typed, globs are contained, commands are one line.
 */
import { describe, expect, test } from 'bun:test';
import { parseConfig, validateConfig } from '../lib/pregate/config';
import { CHECK_IDS } from '../lib/pregate/index';

const codes = (c: unknown) => validateConfig(c, CHECK_IDS).map(e => `${e.code}:${e.path}`);

describe('pregate config: price_file', () => {
  test('a contained price_file is valid and parsed; an absolute, escaping or non-string one is PREGATE_CONFIG_INVALID', () => {
    expect(codes({ price_file: 'evals/gate-calls.txt' })).toEqual([]);
    expect(parseConfig(JSON.stringify({ price_file: 'evals/gate-calls.txt' })).config.price_file).toBe('evals/gate-calls.txt');
    expect(parseConfig('{}').config.price_file).toBeNull();
    expect(codes({ price_file: '/etc/passwd' })).toEqual(['PREGATE_CONFIG_INVALID:price_file']);
    expect(codes({ price_file: '../x' })).toEqual(['PREGATE_CONFIG_INVALID:price_file']);
    expect(codes({ price_file: 3 })).toEqual(['PREGATE_CONFIG_INVALID:price_file']);
  });
});

// ---------------------------------------------------------------------------
// CD1: guards, unknown flags, the lanes check's Bun and serial files
// ---------------------------------------------------------------------------
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach } from 'bun:test';
import { EXIT } from '../lib/headless-artifacts';
import { capyHost, type CapyHost } from './helpers/capy-host';
import { BASE_PREGATE, cleanup, commit, makeFixtureRepo, runBin, write, type FixtureRepo } from './helpers/pregate-fixture';

const repos: FixtureRepo[] = [];
const hosts: CapyHost[] = [];
afterEach(() => { while (repos.length) cleanup(repos.pop()!); while (hosts.length) hosts.pop()!.cleanup(); });
const readOut = (repo: FixtureRepo) => JSON.parse(fs.readFileSync(path.join(repo.work, '.gstack/tmp/pregate.json'), 'utf8'));
const checkRow = (repo: FixtureRepo, id: string) => readOut(repo).checks.find((c: any) => c.id === id);

const CHECK_SERIAL = [
  "const fs = require('node:fs');",
  "const rows = new Set(fs.readFileSync('scripts/serial-files.tsv', 'utf8').split('\\n').map(l => l.split('\\t')[0]).filter(Boolean));",
  "const missing = fs.readdirSync('test').filter(f => f.endsWith('.serial.test.js')).map(f => `test/${f}`).filter(f => !rows.has(f));",
  "for (const f of missing) console.log(`${f} is a serial test file with no row in scripts/serial-files.tsv.`);",
  'process.exit(missing.length ? 1 : 0);',
].join('\n') + '\n';
const SERIAL_GUARD = { id: 'serial-manifest', when: ['test/**/*.serial.test.js', 'scripts/serial-files.tsv'], command: 'node scripts/check-serial.js', fix: 'add a row for the file to scripts/serial-files.tsv' };
const SERIAL_TEST = "const test = require('node:test');\ntest('serial', () => {});\n";

/** The base branch gains the manifest, its check script and the given pregate config. */
function guardedFixture(pregate: Record<string, unknown>): FixtureRepo {
  const repo = makeFixtureRepo({ pregate });
  repos.push(repo);
  repo.git('checkout', '-q', 'main');
  write(repo.work, 'scripts/check-serial.js', CHECK_SERIAL);
  write(repo.work, 'scripts/serial-files.tsv', 'path\treason\n');
  repo.git('add', '-A');
  repo.git('commit', '-q', '-m', 'serial manifest');
  repo.git('push', '-q', 'origin', 'main');
  repo.git('checkout', '-q', 'feature');
  repo.git('merge', '-q', '--ff-only', 'main');
  return repo;
}
const pregate = (repo: FixtureRepo, args: string[], env: Record<string, string> = {}) => runBin(repo, 'gstack-pregate', ['--base', 'main', ...args], env);

describe('guards (CD1)', () => {
  test('a serial test that lands without its manifest row fails pregate naming the guard and its fix; adding the row clears it', () => {
    const repo = guardedFixture({ ...BASE_PREGATE, guards: [SERIAL_GUARD] });
    commit(repo, { 'test/widget-env.serial.test.js': SERIAL_TEST });
    const r = pregate(repo, ['--allow-repo-commands', '--stage', 'preflight']);
    expect(r.status).toBe(EXIT.fail);
    expect(r.out).toMatch(/^preflight {2}guards {4}fail .*serial-manifest.*\(PREGATE_GUARD_FAILED\)/m);
    expect(r.out).toContain('guards: GUARD: serial-manifest exit=1');
    expect(r.out).toContain('test/widget-env.serial.test.js is a serial test file with no row in scripts/serial-files.tsv.');
    expect(r.out).toContain('guards: fix: serial-manifest: add a row for the file to scripts/serial-files.tsv');
    expect(r.err).toContain('(PREGATE_GUARD_FAILED)');
    commit(repo, { 'scripts/serial-files.tsv': 'path\treason\ntest/widget-env.serial.test.js\tglobal-state\n' });
    const ok = pregate(repo, ['--allow-repo-commands', '--stage', 'preflight']);
    expect(ok.status).toBe(EXIT.ok);
    expect(ok.out).toMatch(/^preflight {2}guards {4}pass .*1 guard\(s\) passed: serial-manifest/m);
  });

  test('without --allow-repo-commands a selected guard is incomplete and lists its command; an unmatched guard does not run', () => {
    const repo = guardedFixture({ ...BASE_PREGATE, guards: [SERIAL_GUARD, { id: 'never', when: ['nothing/**'], command: 'false' }] });
    commit(repo, { 'test/widget-env.serial.test.js': SERIAL_TEST });
    const r = pregate(repo, ['--stage', 'preflight', '--only', 'guards']);
    expect(r.status).toBe(EXIT.fail);
    expect(r.out).toMatch(/^preflight {2}guards {4}incomplete .*\(REPO_COMMANDS_NOT_ALLOWED\)/m);
    expect(r.out).toContain('guards: COMMAND: serial-manifest="node scripts/check-serial.js"');
    expect(r.out).not.toContain('COMMAND: never=');
    expect(r.out).toContain('GSTACK_RESULT: skill=pregate status=incomplete');
  });

  test('each guard runs in its own process with its timeout: a failing guard does not stop the next, a timed-out guard is incomplete, never pass', () => {
    const repo = guardedFixture({ ...BASE_PREGATE, guards: [
      { id: 'first', when: ['lib/**'], command: 'echo first-ran; exit 3' },
      { id: 'second', when: ['lib/**'], command: 'touch ../second-ran' },
      { id: 'slow', when: ['lib/**'], command: 'sleep 20', timeout_s: 1 },
    ] });
    commit(repo, { 'lib/util.js': "exports.add = (a, b) => a + b + 0;\n" });
    const r = pregate(repo, ['--allow-repo-commands', '--stage', 'preflight', '--only', 'guards']);
    expect(r.status).toBe(EXIT.fail);
    expect(fs.existsSync(path.join(repo.root, 'second-ran'))).toBe(true);
    expect(r.out).toContain('guards: GUARD: first exit=3');
    expect(r.out).toContain('guards: GUARD: slow timed out after 1 s');
    const row = checkRow(repo, 'guards');
    expect(row.status).toBe('fail');
    expect(row.detail).toContain('first');
    expect(row.detail).not.toContain('second');
    const slowOnly = guardedFixture({ ...BASE_PREGATE, guards: [{ id: 'slow', when: ['lib/**'], command: 'sleep 20', timeout_s: 1 }] });
    commit(slowOnly, { 'lib/util.js': "exports.add = (a, b) => a + b + 0;\n" });
    expect(pregate(slowOnly, ['--allow-repo-commands', '--stage', 'preflight', '--only', 'guards']).status).toBe(EXIT.fail);
    expect(checkRow(slowOnly, 'guards')).toMatchObject({ status: 'incomplete', code: 'PREGATE_INCOMPLETE' });
  });

  test('guards cannot be downgraded to warn; a guard needs an id, globs and a one-line command', () => {
    expect(codes({ guards: [SERIAL_GUARD] })).toEqual([]);
    expect(codes({ guards: [SERIAL_GUARD], warn: ['guards'] })).toEqual(['PREGATE_CONFIG_INVALID:warn']);
    expect(codes({ guards: [{ id: 'bad id!', when: ['x'], command: 'true' }] })).toEqual(['PREGATE_CONFIG_INVALID:guards[0].id']);
    expect(codes({ guards: [{ id: 'g', when: ['../x'], command: 'true' }] })).toEqual(['PREGATE_CONFIG_INVALID:guards[0].when[0]']);
    expect(codes({ guards: [{ id: 'g', when: ['x'], command: 'a\nb' }] })).toEqual(['PREGATE_CONFIG_INVALID:guards[0].command']);
    expect(codes({ guards: [{ id: 'g', when: ['x'], command: 'true', extra: 1 }] })).toEqual(['PREGATE_CONFIG_INVALID:guards[0].extra']);
    expect(codes({ guards: [{ id: 'g', when: ['x'], command: 'true' }, { id: 'g', when: ['y'], command: 'true' }] })).toEqual(['PREGATE_CONFIG_INVALID:guards[1].id']);
    expect(codes({ serial_patterns: ['**/*.serial.test.*'] })).toEqual([]);
    expect(codes({ serial_patterns: ['/abs/**'] })).toEqual(['PREGATE_CONFIG_INVALID:serial_patterns[0]']);
  });
});

describe('pregate config: sealed (CD4)', () => {
  test('`gstack-pregate validate` accepts a sealed policy and names each bad field', () => {
    expect(codes({ sealed: { paths: ['heldout/**'], transcripts: ['runs/**/transcript*.jsonl'], answer_markers: ['SEALED ANSWER:'], seed_patterns: ['seed=\\d+'], local_paths: true, visibility: 'private' } })).toEqual([]);
    expect(codes({ sealed: { paths: 'heldout/**' } })).toEqual(['PREGATE_CONFIG_INVALID:sealed.paths']);
    expect(codes({ sealed: { seed_patterns: ['('] } })).toEqual(['PREGATE_CONFIG_INVALID:sealed.seed_patterns[0]']);
    expect(codes({ sealed: { visibility: 'internal' } })).toEqual(['PREGATE_CONFIG_INVALID:sealed.visibility']);
    expect(codes({ sealed: { block: true } })).toEqual(['PREGATE_CONFIG_INVALID:sealed.block']);
  });
});

describe('gstack-pregate flags (CD1)', () => {
  test('an unknown flag is usage (exit 2) on every verb instead of a silent normal run', () => {
    const repo = makeFixtureRepo(); repos.push(repo);
    const bogus = runBin(repo, 'gstack-pregate', ['run', '--base', 'main', '--bogus']);
    expect(bogus.status).toBe(EXIT.usage);
    expect(bogus.err).toContain('unknown flag --bogus');
    const sealedFlag = pregate(repo, ['--sealed']);
    expect(sealedFlag.status).toBe(EXIT.usage);
    expect(sealedFlag.err).toContain('gstack-pregate sealed');
    expect(runBin(repo, 'gstack-pregate', ['verify', '--nope']).status).toBe(EXIT.usage);
    expect(fs.existsSync(path.join(repo.work, '.gstack/tmp/pregate.json'))).toBe(false);
  });
});

describe('lanes runtime and serial files (CD1)', () => {
  const recordingRunner = `bash -c 'echo "RUN: $*" >> ../runs.log; echo "bun=$(bun --version)"; node --test "$@"' _ {files}`;

  test('on a Capy-shaped host the lanes runner gets the verified Bun from $HOME/.bun/bin, not the older PATH Bun', () => {
    const host = capyHost({ verifiedBun: '1.4.2' }); hosts.push(host);
    const repo = makeFixtureRepo({ pregate: { ...BASE_PREGATE, runner: recordingRunner } }); repos.push(repo);
    commit(repo, { 'lib/util.js': "exports.add = (a, b) => a + b + 0;\n" });
    const r = pregate(repo, ['--allow-repo-commands', '--stage', 'tests'], host.env);
    expect(r.status).toBe(EXIT.ok);
    expect(r.out).toContain('lanes:   bun=1.4.2');
    expect(r.out).not.toContain('bun=1.3.14');
    expect(r.out).toContain(`lanes: runtime: bun 1.4.2 at ${fs.realpathSync(host.bunInstallBin)}/bun (resolved: `);
  });

  test('serial-pattern test files run in their own process, apart from the unit files', () => {
    const repo = makeFixtureRepo({ pregate: { ...BASE_PREGATE, runner: recordingRunner } }); repos.push(repo);
    commit(repo, { 'lib/util.js': "exports.add = (a, b) => a + b + 0;\n", 'test/widget-env.serial.test.js': "const test = require('node:test');\ntest('serial', () => {});\n" });
    const r = pregate(repo, ['--allow-repo-commands', '--stage', 'tests']);
    expect(r.status).toBe(EXIT.ok);
    const runs = fs.readFileSync(path.join(repo.root, 'runs.log'), 'utf8').trim().split('\n');
    expect(runs).toEqual(['RUN: test/util.test.js', 'RUN: test/widget-env.serial.test.js']);
    expect(r.out).toMatch(/^tests {6}lanes {5}pass .*2 tests ran in 2 file\(s\) \(1 serial\), exit 0/m);
  });
});
