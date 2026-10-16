/**
 * Reviewer test for #3177 (fixes #3161): a .bats file in a nested directory is
 * selected and run end to end through bin/gstack-pregate, both when it is
 * touched itself (no declaration) and through a declared dependency, and a
 * failing nested bats run is a lane failure with the bats counts.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { EXIT } from '../lib/headless-artifacts';
import { BASE_PREGATE, cleanup, commit, makeFixtureRepo, runBin, type FixtureRepo } from './helpers/pregate-fixture';

const NESTED = 'tests/integration/cli/deep.bats';
const repos: FixtureRepo[] = [];
afterEach(() => { while (repos.length) cleanup(repos.pop()!); });

function batsRepo(dependencies: Record<string, string[]> = {}): FixtureRepo {
  const repo = makeFixtureRepo({
    pregate: { ...BASE_PREGATE, runner: 'bats {files}', dependencies: { ...BASE_PREGATE.dependencies, ...dependencies } },
    baseFiles: { 'scripts/deep.sh': '#!/bin/sh\necho deep\n', [NESTED]: '@test "deep" { run bash scripts/deep.sh; [ "$output" = deep ]; }\n' },
  });
  repos.push(repo);
  return repo;
}

/** A `bats` on PATH that records its argv and prints `tap`, exiting `exit`. */
function stubBats(repo: FixtureRepo, tap: string, exit = 0): { env: Record<string, string>; argv: string } {
  const dir = path.join(repo.root, 'bin-stub');
  const argv = path.join(repo.root, 'bats-argv.txt');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'bats'), `#!/bin/sh\nprintf '%s\\n' "$@" > '${argv}'\nprintf '%s\\n' '${tap}'\nexit ${exit}\n`, { mode: 0o755 });
  return { env: { PATH: `${dir}${path.delimiter}${process.env.PATH ?? ''}` }, argv };
}

const lanes = (repo: FixtureRepo) => JSON.parse(fs.readFileSync(path.join(repo.work, '.gstack/tmp/pregate.json'), 'utf8')).checks.find((c: any) => c.id === 'lanes');
const run = (repo: FixtureRepo, env: Record<string, string>) => runBin(repo, 'gstack-pregate', ['--base', 'main', '--allow-repo-commands', '--stage', 'tests', '--explain'], env);

describe('nested .bats files end to end (#3161, reviewer test for #3177)', () => {
  test('a touched nested .bats file selects itself with no declaration and runs under the bats runner', () => {
    const repo = batsRepo();
    commit(repo, { [NESTED]: '@test "deep" { run bash scripts/deep.sh; [ "$output" = deep ]; }\n@test "deeper" { true; }\n' });
    const stub = stubBats(repo, '1..2\nok 1 deep\nok 2 deeper');
    const r = run(repo, stub.env);
    expect(r.err).not.toContain('PREGATE_NO_LANE');
    expect(r.status).toBe(EXIT.ok);
    expect(r.out).toContain(`${NESTED} (itself a test)`);
    expect(r.out).toContain(`ran: bats '${NESTED}'`);
    expect(fs.readFileSync(stub.argv, 'utf8').trim()).toBe(NESTED);
    expect(lanes(repo).detail).toMatch(/^2 tests ran in 1 file\(s\)/);
  });

  test('a declared dependency on a nested .bats file selects it; a failing run reports the bats counts', () => {
    const repo = batsRepo({ 'scripts/**': [NESTED] });
    commit(repo, { 'scripts/deep.sh': '#!/bin/sh\necho deeper\n' });
    const stub = stubBats(repo, '1..2\nok 1 a\nnot ok 2 deep', 1);
    const r = run(repo, stub.env);
    expect(r.err).not.toContain('PREGATE_NO_LANE');
    expect(r.status).toBe(EXIT.fail);
    expect(r.out).toContain(`${NESTED} ← scripts/deep.sh (declared)`);
    expect(fs.readFileSync(stub.argv, 'utf8').trim()).toBe(NESTED);
    expect(lanes(repo)).toMatchObject({ status: 'fail', code: 'PREGATE_LANE_FAILED' });
    expect(lanes(repo).detail).toContain('1 failed of 2 ran');
  });
});
