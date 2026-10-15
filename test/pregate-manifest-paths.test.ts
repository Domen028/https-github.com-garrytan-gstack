/**
 * Item 8 (manifest-parser half of #3176): a lane's selection manifest prints
 * framework route paths (`app/(shop)/[id]/page.test.ts`, `@modal`, `$id`)
 * and the parser keeps them whole. Cutting them down to `page.test.ts`
 * dropped the test from its platform lane, so its remote receipt obligation
 * vanished and the test ran locally instead.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { manifestTestPaths } from '../lib/pregate/lane-selection';
import { BASE_PREGATE, cleanup, commit, makeFixtureRepo, runBin, type FixtureRepo } from './helpers/pregate-fixture';

const repos: FixtureRepo[] = [];
afterEach(() => { while (repos.length) cleanup(repos.pop()!); });

describe('manifestTestPaths', () => {
  test('framework route segments stay intact', () => {
    const out = [
      'app/(shop)/[id]/page.test.ts',
      'app/@modal/(.)photo/[...slug]/page.spec.tsx',
      'app/routes/$userId/route.test.ts',
      'src/routes/[[lang]]/+page.test.ts',
      '  test/plain.test.ts  ',
    ].join('\n');
    expect(manifestTestPaths(out)).toEqual([
      'app/(shop)/[id]/page.test.ts',
      'app/@modal/(.)photo/[...slug]/page.spec.tsx',
      'app/routes/$userId/route.test.ts',
      'src/routes/[[lang]]/+page.test.ts',
      'test/plain.test.ts',
    ]);
  });

  test('paths inside JSON, quotes, listings and grep-style lines are found; prose is not', () => {
    const out = [
      'Discovered 12 test files.',
      '["app/(shop)/[id]/a.test.ts", "test/b.test.ts"]',
      '  ./test/c.test.ts:12',
      '(test/d.test.ts)',
      'shard 2: tests/test_e.py',
      'app/(group)/f.test.ts,',
    ].join('\n');
    expect(manifestTestPaths(out)).toEqual(['app/(shop)/[id]/a.test.ts', 'test/b.test.ts', 'test/c.test.ts', 'test/d.test.ts', 'tests/test_e.py', 'app/(group)/f.test.ts']);
  });

  test('the test-file rule is the import graph\'s own (one definition of a test file)', () => {
    expect(manifestTestPaths('pkg/x_test.go\nlib/y_spec.rb\nlib/not-a-test.ts')).toEqual(['pkg/x_test.go', 'lib/y_spec.rb']);
  });
});

describe('lanes: a bracketed route test in a platform-only lane keeps its remote receipt obligation', () => {
  test('the manifest path selects the Windows lane, not a local run', () => {
    const repo = makeFixtureRepo();
    repos.push(repo);
    const route = 'app/(shop)/[id]/page.test.js';
    commit(repo, {
      'scripts/windows-list.js': `console.log('test/windows-paths.test.js');\nconsole.log(${JSON.stringify(route)});\n`,
    });
    repo.git('push', '-q', 'origin', 'feature:main');
    repo.git('fetch', '-q', 'origin');
    commit(repo, { [route]: "const test = require('node:test');\ntest('route', () => {});\n" });
    const r = runBin(repo, 'gstack-pregate', ['--base', 'main', '--allow-repo-commands', '--stage', 'tests', '--explain']);
    expect(r.out).toContain('lane windows.yml/windows-shard: 2 files from manifest `node scripts/windows-list.js`');
    const out = JSON.parse(fs.readFileSync(path.join(repo.work, '.gstack/tmp/pregate.json'), 'utf8'));
    expect(out.requires_remote).toEqual([{ lane: 'windows.yml/windows-shard', platform: 'windows', workflow: 'windows.yml', job: 'windows-shard', tests: [route], receipt: null }]);
    expect(r.out).toContain(`requires-remote windows.yml/windows-shard (windows): 1 test(s) — ${route}`);
    expect(BASE_PREGATE.selection['windows.yml/windows-shard']).toBe('node scripts/windows-list.js');
  });
});
