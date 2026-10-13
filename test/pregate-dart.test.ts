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
import { laneFileSet } from '../lib/pregate/lane-selection';
import type { Lane } from '../lib/pregate/workflows';
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

function sleepCommand(sleepS: number | Record<string, number>): string {
  if (typeof sleepS === 'number') return `sleep ${sleepS}`;
  const { '*': other = 0, ...named } = sleepS;
  return `case "$(basename "$PWD")" in ${Object.entries(named).map(([dir, n]) => `${dir}) sleep ${n};;`).join(' ')} *) sleep ${other};; esac`;
}

/** A `dart` and `flutter` on PATH that report its cwd and passes every file it is given, after `sleepS` seconds (per package directory name when an object). */
function dartShim(repo: FixtureRepo, sleepS: number | Record<string, number> = 0): { PATH: string } {
  const dir = path.join(repo.root, 'shim');
  fs.mkdirSync(dir, { recursive: true });
  for (const tool of ['dart', 'flutter']) fs.writeFileSync(path.join(dir, tool), `#!/usr/bin/env bash\nshift\n${sleepCommand(sleepS)}\necho "ran in $(basename "$PWD"): $*"\necho "00:01 +$#: All tests passed!"\n`, { mode: 0o755 });
  return { PATH: `${dir}:${process.env.PATH ?? ''}` };
}

describe('Dart import graph', () => {
  test('_test.dart is a test; package:, relative, conditional, export and part directives all map; dart: and unknown packages do not', () => {
    const repo = dartRepo();
    const g = buildGraph(repo.work);
    expect(isTestFile('test/ui/drawer_widget_test.dart')).toBe(true);
    expect(isTestFile('lib/widgets/drawer.dart')).toBe(false);
    // Value: protects=device-only Flutter tests (integration_test/, test_driver/) are never auto-selected for a local `flutter test`;
    //   fails_when=the exclusion is dropped and touching lib/ launches the app or fails with no device; why_new=no integration test file was classified;
    //   seam=none; no_claim=a device run
    for (const f of ['integration_test/app_test.dart', 'packages/core/integration_test/core_test.dart', 'test_driver/app_test.dart']) expect(isTestFile(f)).toBe(false);
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
    const ctx = { repoRoot: repo.work, config: DEFAULT_CONFIG, env: dartShim(repo) } as unknown as PregateContext;
    expect(planRuns(ctx, ['packages/core/test/core_test.dart', 'test/ui/drawer_widget_test.dart'])).toEqual([
      { runner: 'dart test {files}', cwd: '', files: ['test/ui/drawer_widget_test.dart'] },
      { runner: 'dart test {files}', cwd: 'packages/core', files: ['test/core_test.dart'] },
    ]);
    // Value: protects=non-Dart files beside Dart ones go to the detected runner, and a file no runner claims makes the plan null (incomplete);
    //   fails_when=the rest group is dropped or an unclaimed file is silently skipped; why_new=only all-Dart lists were planned;
    //   seam=none; no_claim=the runners themselves (plan only)
    expect(planRuns(ctx, ['test/ui/drawer_widget_test.dart', 'test/util.test.js'])).toEqual([
      { runner: 'dart test {files}', cwd: '', files: ['test/ui/drawer_widget_test.dart'] },
      { runner: 'node --test {files}', cwd: '', files: ['test/util.test.js'] },
    ]);
    expect(planRuns(ctx, ['test/ui/drawer_widget_test.dart', 'spec/drawer_spec.rb'])).toEqual({ unclaimed: ['spec/drawer_spec.rb'], missing: [] });
    // Value: protects=a machine without the Dart SDK gets an incomplete lane naming the missing tool, never a test failure (exit 127);
    //   fails_when=the PATH check is dropped and the runner is planned anyway; why_new=every earlier plan had the SDK on PATH;
    //   seam=none; no_claim=a real SDK install (an empty PATH stands in for a machine without one)
    const noSdk = { ...ctx, env: { PATH: path.join(repo.root, 'empty-path') } } as PregateContext;
    expect(planRuns(noSdk, ['packages/core/test/core_test.dart', 'test/ui/drawer_widget_test.dart'])).toEqual({ unclaimed: ['test/ui/drawer_widget_test.dart', 'packages/core/test/core_test.dart'], missing: ['dart'] });
    write(repo.work, 'pubspec.yaml', 'name: app\ndependencies:\n  flutter:\n    sdk: flutter\n');
    expect(planRuns(ctx, ['test/ui/drawer_widget_test.dart'])).toMatchObject([{ runner: 'flutter test {files}' }]);
    const declared = { ...ctx, config: { ...DEFAULT_CONFIG, runner: 'bash scripts/test.sh {files}' } } as PregateContext;
    expect(planRuns(declared, ['packages/core/test/core_test.dart', 'test/ui/drawer_widget_test.dart'])).toEqual([
      { runner: 'bash scripts/test.sh {files}', cwd: '', files: ['packages/core/test/core_test.dart', 'test/ui/drawer_widget_test.dart'] },
    ]);
  });

  test('a workflow run step names its _test.dart files; Dart root manifests are not strays', () => {
    const lanes = parseWorkflow('t.yml', 'jobs:\n  dart:\n    runs-on: ubuntu-24.04\n    steps:\n      - run: fvm flutter test test/ui/drawer_widget_test.dart packages/core/test/core_test.dart\n');
    expect(lanes[0]!.testFiles).toEqual(['test/ui/drawer_widget_test.dart', 'packages/core/test/core_test.dart']);
    // Value: protects=a CI job that runs only flutter/dart test is a test lane (requires-remote off its platform, clearable by local);
    //   fails_when=flutter test / dart test drop out of TEST_COMMAND and the job silently stops being a lane; why_new=fixtures used bun lanes only;
    //   seam=none; no_claim=a real workflow run
    expect(lanes[0]!.runsTests).toBe(true);
    const win = parseWorkflow('w.yml', 'jobs:\n  dart:\n    runs-on: windows-latest\n    steps:\n      - run: dart test\n', 'darwin');
    expect(win[0]).toMatchObject({ tier: 'platform', runsTests: true });
    for (const f of ['pubspec.yaml', 'pubspec.lock', 'analysis_options.yaml', 'dart_test.yaml']) expect(ROOT_OK.test(f)).toBe(true);
    expect(ROOT_OK.test('scratch.dart')).toBe(false);
    // Value: protects=a selection manifest's *_test.dart lines join the lane's file set; fails_when=the manifest regex drops _test.dart;
    //   why_new=manifests were only tested with .test.js lists; seam=none; no_claim=a real planner (printf stands in)
    const ctx = { repoRoot: process.cwd(), allowRepoCommands: true, timeoutMs: 30_000, env: process.env, explain: [],
      config: { ...DEFAULT_CONFIG, selection: { 't.yml/dart': "printf 'packages/core/test/core_test.dart\\n  shard: test/ui/drawer_widget_test.dart\\nlib/theme.dart\\n'" } } } as unknown as PregateContext;
    expect(laneFileSet(ctx, { id: 't.yml/dart', testFiles: [] } as unknown as Lane)).toEqual(['packages/core/test/core_test.dart', 'test/ui/drawer_widget_test.dart']);
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

    // Value: protects=an invalid user policy refuses and names its path, never runs on defaults; fails_when=user-file errors are ignored or unlabelled;
    //   why_new=only valid user files were tested; seam=none; no_claim=none beyond protects
    fs.mkdirSync(path.dirname(userPolicy), { recursive: true });
    fs.writeFileSync(userPolicy, JSON.stringify({ local: ['not-a-lane'] }));
    const invalid = run();
    expect(invalid.status).toBe(EXIT.refused);
    expect(invalid.err).toContain('PREGATE_CONFIG_INVALID');
    expect(invalid.err).toContain(`user ${userPolicy}`);
    // Value: protects=sealed in the user file is refused, since the pre-push guard never reads it (it would look active and do nothing);
    //   fails_when=the user loader accepts sealed/price_file silently; why_new=only lane ids were validated; seam=none; no_claim=the sealed guard itself
    fs.writeFileSync(userPolicy, JSON.stringify({ sealed: { paths: ['evals/**'] } }));
    const sealed = run();
    expect(sealed.status).toBe(EXIT.refused);
    expect(sealed.err).toContain('covers gstack-pregate run only; sealed');
    expect(sealed.err).toContain('edit that file directly');

    // A local lane runs here; a lane not named stays an obligation.
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

    // Value: protects=--policy-from head reads only the working-tree pin, never the user file; fails_when=the policyFrom guard on the user fallback is dropped;
    //   why_new=only base mode was tested with a user file; seam=none; no_claim=none beyond protects
    const head = runBin(repo, 'gstack-pregate', ['--base', 'main', '--allow-repo-commands', '--stage', 'tests', '--policy-from', 'head'], env);
    expect(head.out).not.toContain('policy user');
    expect(head.out).toContain('(no .gstack/pregate.json)');

    // A base copy is reviewed policy: it wins, and the user file is not read.
    commit(repo, { '.gstack/pregate.json': JSON.stringify(BASE_PREGATE) + '\n' });
    repo.git('push', '-q', 'origin', 'HEAD:main');
    repo.git('fetch', '-q', 'origin');
    commit(repo, { 'packages/core/lib/core.dart': 'int one() => 3;\n' });
    const based = run();
    expect(based.out).toContain('origin/main@');
    expect(based.out).not.toContain('policy user');
  }, 30_000);

  // Value: protects=serial_patterns match repo-relative paths, so a serial file inside a Dart sub-package runs alone from that package root;
  //   fails_when=the pattern is matched against the cwd-relative path and the file joins the unit run; why_new=pregate-guards covers root JS serial files only;
  //   seam=none; no_claim=a real dart runner (PATH shim reports cwd and argv)
  test('a serial file inside a Dart sub-package runs in its own process from that package root', () => {
    const repo = dartRepo(null);
    const env = { ...dartShim(repo), GSTACK_PROJECT_SLUG: 'dartserial' };
    const userPolicy = path.join(repo.home, 'projects', 'dartserial', 'pregate.json');
    fs.mkdirSync(path.dirname(userPolicy), { recursive: true });
    fs.writeFileSync(userPolicy, JSON.stringify({ local: ['free-tests.yml/unit', 'windows.yml/windows-shard'], serial_patterns: ['packages/core/test/slow_test.dart'] }));
    commit(repo, {
      'packages/core/test/slow_test.dart': "import 'package:core/core.dart';\nvoid main() {}\n",
      'packages/core/lib/core.dart': 'int one() => 2;\n',
    });
    const r = runBin(repo, 'gstack-pregate', ['--base', 'main', '--allow-repo-commands', '--stage', 'tests'], env);
    expect(r.status).toBe(EXIT.ok);
    expect(r.out).toMatch(/^tests {6}lanes {5}pass .*3 tests ran in 3 file\(s\) \(1 serial\), exit 0/m);
    const log = fs.readFileSync(/log: (\S+)/.exec(r.out)![1]!, 'utf8');
    expect(log).toContain('ran in core: test/core_test.dart\n');
    expect(log).toContain('ran in core: test/slow_test.dart\n');
  }, 30_000);

  // Value: protects=every run group shares one --timeout deadline, so the sum of runs never exceeds it and a late group is cut off (incomplete);
  //   fails_when=each group gets the full --timeout again (a 2-package repo could run 2x the budget and pass); why_new=no multi-group timeout test;
  //   seam=none; no_claim=exact timing (root run sleeps 1 s, core 5 s, deadline 5.5 s: load can only shrink core's budget, never cut the root run)
  test('run groups share the --timeout deadline: a later package past it is incomplete, never a pass', () => {
    const repo = dartRepo(null);
    const env = { ...dartShim(repo, { core: 5, '*': 1 }), GSTACK_PROJECT_SLUG: 'dartdeadline' };
    const userPolicy = path.join(repo.home, 'projects', 'dartdeadline', 'pregate.json');
    fs.mkdirSync(path.dirname(userPolicy), { recursive: true });
    fs.writeFileSync(userPolicy, JSON.stringify({ local: ['free-tests.yml/unit', 'windows.yml/windows-shard'] }));
    commit(repo, { 'packages/core/lib/core.dart': 'int one() => 2;\n' });
    const r = runBin(repo, 'gstack-pregate', ['--base', 'main', '--allow-repo-commands', '--stage', 'tests', '--timeout', '5.5'], env);
    expect(r.status).not.toBe(EXIT.ok);
    expect(r.out).toMatch(/^tests {6}lanes {5}incomplete .*local lane timed out/m);
    const log = fs.readFileSync(/log: (\S+)/.exec(r.out)![1]!, 'utf8');
    expect(log).toMatch(/ran in \S+: test\/ui\/drawer_widget_test\.dart/);
    expect(log).not.toContain('ran in core:');
  }, 30_000);

  // Value: protects=a repo pinning its SDK (.fvmrc) runs Dart tests through fvm when fvm is on PATH, and without it when fvm is absent;
  //   fails_when=the fvm prefix or the .fvmrc check is dropped, or fvm is required when absent; why_new=no test had a pin file;
  //   seam=none; no_claim=a real fvm or Dart SDK (PATH holds only shims and the tools pregate spawns)
  test('an .fvmrc pin routes the Dart runner through fvm only when fvm is on PATH', () => {
    const repo = dartRepo(null);
    dartShim(repo);
    const bin = path.join(repo.root, 'shim');
    // The host PATH minus any real fvm/dart/flutter: every other tool pregate and git spawn stays reachable.
    for (const dir of (process.env.PATH ?? '').split(':')) {
      let names: string[] = [];
      try { names = fs.readdirSync(dir); } catch { continue; }
      for (const name of names) if (!['fvm', 'dart', 'flutter'].includes(name) && !fs.lstatSync(path.join(bin, name), { throwIfNoEntry: false })) fs.symlinkSync(path.join(dir, name), path.join(bin, name));
    }
    const userPolicy = path.join(repo.home, 'projects', 'dartfvm', 'pregate.json');
    fs.mkdirSync(path.dirname(userPolicy), { recursive: true });
    fs.writeFileSync(userPolicy, JSON.stringify({ local: ['free-tests.yml/unit', 'windows.yml/windows-shard'] }));
    commit(repo, { '.fvmrc': '{"flutter":"3.24.0"}\n' });
    repo.git('push', '-q', 'origin', 'HEAD:main');
    repo.git('fetch', '-q', 'origin');
    commit(repo, { 'packages/core/lib/core.dart': 'int one() => 2;\n' });
    const run = () => runBin(repo, 'gstack-pregate', ['--base', 'main', '--allow-repo-commands', '--stage', 'tests'], { PATH: bin, GSTACK_PROJECT_SLUG: 'dartfvm' });

    const bare = run();
    expect(bare.out).toMatch(/^tests {6}lanes {5}pass /m);
    expect(bare.out).toMatch(/lanes: ran: dart test /);

    fs.writeFileSync(path.join(bin, 'fvm'), '#!/bin/sh\necho "via fvm"\nexec "$@"\n', { mode: 0o755 });
    const pinned = run();
    expect(pinned.out).toMatch(/^tests {6}lanes {5}pass /m);
    expect(pinned.out).toMatch(/lanes: ran: fvm dart test /);
    expect(fs.readFileSync(/log: (\S+)/.exec(pinned.out)![1]!, 'utf8')).toContain('via fvm');
  }, 30_000);
});
