/**
 * C8 `lanes` for a Dart/Flutter repo: `package:` directives resolve through
 * every tracked pubspec.yaml, `_test.dart` files are tests, each package's
 * tests run from its own root, and the runner's `+N -M:` verdict is judged.
 * A repo that keeps `.gstack/` out of git declares its policy at
 * `<GSTACK_HOME>/projects/<slug>/pregate.json`, and `local` lanes run here
 * instead of becoming requires-remote. Every assertion holds on any host
 * platform: the fixture's lanes are named in `local` or not selected.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { EXIT } from '../lib/headless-artifacts';
import { parseSummary, planRuns } from '../lib/pregate/checks/lanes';
import { ROOT_OK } from '../lib/pregate/checks/strays';
import { DEFAULT_CONFIG, validateConfig } from '../lib/pregate/config';
import { buildGraph, isTestFile, testsFor } from '../lib/pregate/import-graph';
import type { PregateContext } from '../lib/pregate/types';
import { parseWorkflow } from '../lib/pregate/workflows';
import { BASE_PREGATE, cleanup, commit, makeFixtureRepo, runBin, write, type FixtureRepo } from './helpers/pregate-fixture';

const repos: FixtureRepo[] = [];
afterEach(() => { while (repos.length) cleanup(repos.pop()!); });

const DART_FILES: Record<string, string> = {
  'pubspec.yaml': 'name: app\ndependencies:\n  core:\n    path: packages/core\n',
  'lib/theme.dart': "const double gap = 8;\n",
  'lib/widgets/drawer.dart': "import 'package:app/theme.dart';\nimport 'package:core/core.dart' if (dart.library.io) 'package:core/core_io.dart';\nimport 'dart:math';\npart 'drawer_parts.dart';\n",
  'lib/widgets/drawer_parts.dart': "part of 'drawer.dart';\n",
  'lib/widgets/widgets.dart': "export 'drawer.dart';\n",
  'test/ui/drawer_widget_test.dart': "import 'package:app/widgets/widgets.dart';\nimport 'package:flutter_test/flutter_test.dart';\nvoid main() {}\n",
  'test/helpers/pump.dart': "import '../../lib/theme.dart';\n",
  'packages/core/pubspec.yaml': 'name: core\n',
  'packages/core/lib/core.dart': "int one() => 1;\n",
  'packages/core/lib/core_io.dart': "int one() => 1;\n",
  'packages/core/test/core_test.dart': "import 'package:core/core.dart';\nvoid main() {}\n",
};

function dartRepo(pregate: Record<string, unknown> | null = null): FixtureRepo {
  const repo = makeFixtureRepo({ pregate });
  repos.push(repo);
  commit(repo, DART_FILES, 'dart');
  repo.git('push', '-q', 'origin', 'HEAD:main');
  repo.git('fetch', '-q', 'origin');
  return repo;
}

/** A `dart` on PATH that reports its cwd and passes every file it is given. */
function dartShim(repo: FixtureRepo): { PATH: string } {
  const dir = path.join(repo.root, 'shim');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'dart'), '#!/usr/bin/env bash\nshift\necho "ran in $(basename "$PWD"): $*"\necho "00:01 +$#: All tests passed!"\n', { mode: 0o755 });
  return { PATH: `${dir}:${process.env.PATH ?? ''}` };
}

describe('Dart import graph', () => {
  test('_test.dart is a test; package:, relative, conditional, export and part directives all map; dart: and unknown packages do not', () => {
    const repo = dartRepo();
    const g = buildGraph(repo.work);
    expect(isTestFile('test/ui/drawer_widget_test.dart')).toBe(true);
    expect(isTestFile('lib/widgets/drawer.dart')).toBe(false);
    expect(testsFor(g, 'lib/theme.dart').tests).toEqual(['test/ui/drawer_widget_test.dart']);
    expect(testsFor(g, 'lib/widgets/drawer_parts.dart').tests).toEqual(['test/ui/drawer_widget_test.dart']);
    expect(testsFor(g, 'packages/core/lib/core.dart').tests).toEqual(['packages/core/test/core_test.dart', 'test/ui/drawer_widget_test.dart']);
    expect(testsFor(g, 'packages/core/lib/core_io.dart').tests).toEqual(['test/ui/drawer_widget_test.dart']);
    expect(testsFor(g, 'test/ui/drawer_widget_test.dart').tests).toEqual(['test/ui/drawer_widget_test.dart']);
  });
});

describe('Dart runner and summary (pure)', () => {
  test('flutter/dart verdict lines: the last one counts, skips are not runs, No tests ran is zero', () => {
    expect(parseSummary('00:01 +3: loading\n00:04 +12 ~1: All tests passed!')).toEqual({ ran: 12, failed: 0 });
    expect(parseSummary('00:02 +5 -1: a test [E]\n00:03 +7 ~2 -2: Some tests failed.')).toEqual({ ran: 9, failed: 2 });
    expect(parseSummary('No tests ran.')).toEqual({ ran: 0, failed: 0 });
  });

  test('without a declared runner, Dart tests group by package root; a declared runner takes every file', () => {
    const repo = dartRepo();
    const ctx = { repoRoot: repo.work, config: DEFAULT_CONFIG } as unknown as PregateContext;
    expect(planRuns(ctx, ['packages/core/test/core_test.dart', 'test/ui/drawer_widget_test.dart'])).toEqual([
      { runner: 'dart test {files}', cwd: '', files: ['test/ui/drawer_widget_test.dart'] },
      { runner: 'dart test {files}', cwd: 'packages/core', files: ['test/core_test.dart'] },
    ]);
    write(repo.work, 'pubspec.yaml', 'name: app\ndependencies:\n  flutter:\n    sdk: flutter\n');
    expect(planRuns(ctx, ['test/ui/drawer_widget_test.dart'])![0]!.runner).toBe('flutter test {files}');
    const declared = { ...ctx, config: { ...DEFAULT_CONFIG, runner: 'bash scripts/test.sh {files}' } } as PregateContext;
    expect(planRuns(declared, ['packages/core/test/core_test.dart', 'test/ui/drawer_widget_test.dart'])).toEqual([
      { runner: 'bash scripts/test.sh {files}', cwd: '', files: ['packages/core/test/core_test.dart', 'test/ui/drawer_widget_test.dart'] },
    ]);
  });

  test('a workflow run step names its _test.dart files; Dart root manifests are not strays', () => {
    const lanes = parseWorkflow('t.yml', 'jobs:\n  dart:\n    runs-on: ubuntu-24.04\n    steps:\n      - run: fvm flutter test test/ui/drawer_widget_test.dart packages/core/test/core_test.dart\n');
    expect(lanes[0]!.testFiles).toEqual(['test/ui/drawer_widget_test.dart', 'packages/core/test/core_test.dart']);
    for (const f of ['pubspec.yaml', 'pubspec.lock', 'analysis_options.yaml', 'dart_test.yaml']) expect(ROOT_OK.test(f)).toBe(true);
    expect(ROOT_OK.test('scratch.dart')).toBe(false);
  });

  test('config: local takes <workflow>/<job> ids only', () => {
    expect(validateConfig({ local: ['test.yml/flutter'] })).toEqual([]);
    expect(validateConfig({ local: ['flutter'] }).map(e => e.path)).toEqual(['local[0]']);
    expect(validateConfig({ local: 'test.yml/flutter' }).map(e => e.path)).toEqual(['local']);
  });
});

describe('gstack-pregate on a Dart repo with no committed policy', () => {
  test('the user-owned policy is read when the base has none; local lanes run here; the base copy wins when present', () => {
    const repo = dartRepo(null);
    const env = { ...dartShim(repo), GSTACK_PROJECT_SLUG: 'dartfix' };
    const userPolicy = path.join(repo.home, 'projects', 'dartfix', 'pregate.json');
    commit(repo, { 'packages/core/lib/core.dart': 'int one() => 2;\n' });
    const run = () => runBin(repo, 'gstack-pregate', ['--base', 'main', '--allow-repo-commands', '--stage', 'tests'], env);

    // No policy anywhere: every lane is the host's call, so only the label is asserted.
    expect(run().out).toContain('(no .gstack/pregate.json)');

    // A local lane runs here; a lane not named stays an obligation.
    fs.mkdirSync(path.dirname(userPolicy), { recursive: true });
    fs.writeFileSync(userPolicy, JSON.stringify({ local: ['free-tests.yml/unit'] }));
    const partial = run();
    expect(partial.out).toContain(`policy user ${userPolicy}`);
    expect(partial.out).toContain('requires-remote windows.yml/windows-shard (windows)');
    expect(partial.out).not.toContain('requires-remote free-tests.yml/unit');

    fs.writeFileSync(userPolicy, JSON.stringify({ local: ['free-tests.yml/unit', 'windows.yml/windows-shard'] }));
    const all = run();
    expect(all.status).toBe(EXIT.ok);
    expect(all.out).toContain('Tiers ran: unit; requires-remote: none');
    expect(all.out).toMatch(/^tests {6}lanes {5}pass .*2 tests ran in 2 file\(s\), exit 0/m);
    const log = fs.readFileSync(/log: (\S+)/.exec(all.out)![1]!, 'utf8');
    expect(log).toContain('ran in core: test/core_test.dart');
    expect(log).toMatch(/ran in \S+: test\/ui\/drawer_widget_test\.dart/);

    // A base copy is reviewed policy: it wins, and the user file is not read.
    commit(repo, { '.gstack/pregate.json': JSON.stringify(BASE_PREGATE) + '\n' });
    repo.git('push', '-q', 'origin', 'HEAD:main');
    repo.git('fetch', '-q', 'origin');
    commit(repo, { 'packages/core/lib/core.dart': 'int one() => 3;\n' });
    const based = run();
    expect(based.out).toContain('origin/main@');
    expect(based.out).not.toContain('policy user');
  }, 30_000);
});
