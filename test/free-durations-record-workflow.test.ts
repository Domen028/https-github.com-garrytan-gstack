/**
 * Static pins and a functional check for the weekly duration-seed recorder
 * (.github/workflows/free-durations-record.yml): Linux on the free-suite
 * runner, Windows through the record_durations path, and one bot seed PR only
 * when a seed's file set drifts.
 */
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = path.resolve(import.meta.dir, '..');
const load = (file: string) => Bun.YAML.parse(readFileSync(path.join(root, '.github/workflows', file), 'utf8')) as any;
const recorder = load('free-durations-record.yml');
const freeTests = load('free-tests.yml');
const proposeStep = recorder.jobs.propose.steps.find((step: any) => step.name === 'Open or refresh the seed PR when either seed\'s file set changed');
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

test('the recorder runs weekly before test-health and on dispatch, read-only except the propose job', () => {
  expect(recorder.on.schedule).toEqual([{ cron: '0 4 * * 1' }]);
  expect(Object.keys(recorder.on).sort()).toEqual(['schedule', 'workflow_dispatch']);
  expect(Object.keys(recorder.on.workflow_dispatch.inputs)).toEqual(['open_pr']);
  expect(load('test-health.yml').on.schedule[0].cron).toBe('0 10 * * 1');
  expect(recorder.permissions).toEqual({ contents: 'read' });
  expect(recorder.concurrency['cancel-in-progress']).toBe(false);
  expect(recorder.jobs.linux.permissions).toBeUndefined();
  expect(recorder.jobs.propose.permissions).toEqual({ contents: 'write', 'pull-requests': 'write', actions: 'write' });
});

test('Linux records on the free-suite runner, turns red on any red file, and uploads only a complete recording', () => {
  const linux = recorder.jobs.linux;
  expect(linux['runs-on']).toBe(freeTests.jobs['free-suite']['runs-on']);
  const runs = linux.steps.map((step: any) => step.run).filter(Boolean).join('\n');
  expect(runs).toContain('bash scripts/ubicloud/setup-free-suite.sh');
  const record = linux.steps.find((step: any) => step.name === 'Time every free file alone');
  expect(record.run).toBe('set -o pipefail\nxvfb-run -a bun run test:free --record-durations 2>&1 | tee "$RUNNER_TEMP/record.log"\n');
  expect(record['continue-on-error']).toBeUndefined();
  const keep = linux.steps.find((step: any) => step.id === 'seed');
  expect(keep.if).toBe("always() && steps.record.outcome != 'skipped'");
  expect(keep.run).toContain('grep -q \'wrote [0-9]* durations to\' "$RUNNER_TEMP/record.log" || {');
  expect(linux.steps.at(-1).if).toBe("always() && steps.seed.outcome == 'success'");
  expect(linux.steps.at(-1).with).toMatchObject({ name: 'free-test-durations', path: '${{ runner.temp }}/seed/' });
});

test('Windows records through the windows-free-tests record_durations path, and propose needs both complete recordings', () => {
  expect(recorder.jobs.windows).toEqual({ uses: './.github/workflows/windows-free-tests.yml', with: { record_durations: true } });
  expect(recorder.jobs.propose.needs).toEqual(['linux', 'windows']);
  expect(recorder.jobs.propose.if).toBe('${{ !cancelled() }}');
  const downloads = recorder.jobs.propose.steps.filter((step: any) => step.uses?.startsWith('actions/download-artifact@'));
  expect(downloads.map((step: any) => step.with.name)).toEqual(['free-test-durations', 'free-test-durations-windows']);
  expect(downloads.every((step: any) => step['continue-on-error'] === undefined)).toBe(true);
});

test('both recorders list exactly the files the recorder reported red, and more than 5 on either OS proposes nothing', () => {
  const windowsRecord = load('windows-free-tests.yml').jobs['windows-record-durations'].steps.find((step: any) => step.id === 'seed').run as string;
  const linuxRecord = recorder.jobs.linux.steps.find((step: any) => step.id === 'seed').run as string;
  const extract = (run: string) => run.split('\n').find(line => line.startsWith("sed -n '/failed while recording:/"))!;
  expect(extract(linuxRecord).replace('seed/record-failures.txt', 'record-failures.txt')).toBe(extract(windowsRecord));
  const dir = mkdtempSync(path.join(os.tmpdir(), 'seed-failures-'));
  dirs.push(dir);
  const list = (log: string) => {
    writeFileSync(path.join(dir, 'record.log'), log);
    const result = spawnSync('bash', ['-c', `set -euo pipefail\n${extract(windowsRecord)}\ncat "$RUNNER_TEMP/record-failures.txt"`], { encoding: 'utf8', timeout: 10_000, env: { ...process.env, RUNNER_TEMP: dir } });
    expect(result.status, result.stderr).toBe(0);
    return result.stdout;
  };
  const red = '  ✗ test/a.test.ts — suite > case\r\n[test:free] wrote 3 durations to scripts\\free-test-durations.json\r\n[test:free] WARNING: 2 file(s) failed while recording:\r\n  ✗ test/a.test.ts\r\n  ✗ browse/test/b.test.ts\r\n';
  expect(list(red)).toBe('test/a.test.ts\nbrowse/test/b.test.ts\n');
  expect(list('  ✗ test/a.test.ts — suite > flaky then fixed\n[test:free] wrote 3 durations to scripts/free-test-durations.json\n')).toBe('');
  const script: string = proposeStep.run;
  expect(script).toContain('if [ "$linux_failed" -gt 5 ] || [ "$windows_failed" -gt 5 ]; then');
  expect(script.indexOf('-gt 5 ]')).toBeLessThan(script.indexOf('drift() {'));
  expect(script).toContain('Files that failed while recording (durations kept; this PR\'s own free checks decide): $failed_line');
});

test('the propose step touches only the two seeds, never the allowlist, on one bot branch', () => {
  const script: string = proposeStep.run;
  expect(script).toContain('git add scripts/free-test-durations.json scripts/free-test-durations-windows.json\n');
  expect(script).not.toContain('free-test-seed-allowlist.json');
  expect(script).toContain('branch=bot/free-duration-seeds');
  expect(script).toContain('bun test test/free-seed-ratchet.test.ts');
  expect(script).toContain('gh workflow run free-tests.yml');
  expect(proposeStep.env.OPEN_PR).toBe("${{ github.event_name == 'schedule' || inputs.open_pr }}");
  expect(script.indexOf('if [ "$OPEN_PR" != true ]')).toBeLessThan(script.indexOf('git push'));
  expect(recorder.on.workflow_dispatch.inputs.open_pr).toMatchObject({ type: 'boolean', default: true });
});

test('the drift check counts added and removed files, so an unchanged file set proposes nothing', () => {
  const script: string = proposeStep.run;
  const drift = script.slice(script.indexOf('drift() {'), script.indexOf('\n}', script.indexOf('drift() {')) + 2);
  const dir = mkdtempSync(path.join(os.tmpdir(), 'seed-drift-'));
  dirs.push(dir);
  const seed = (name: string, files: Record<string, number>) => {
    const file = path.join(dir, name);
    writeFileSync(file, JSON.stringify({ version: 1, recordedAt: '2026-10-17T00:00:00.000Z', durations: files }));
    return file;
  };
  const committed = seed('committed.json', { 'test/a.test.ts': 100, 'test/b.test.ts': 200 });
  const run = (recorded: string) => spawnSync('bash', ['-c', `${drift}\ndrift "$1" "$2"`, 'drift', committed, recorded], { encoding: 'utf8', timeout: 10_000 });
  const same = run(seed('same.json', { 'test/a.test.ts': 900, 'test/b.test.ts': 50 }));
  expect(same.status, same.stderr).toBe(0);
  expect(same.stdout.trim()).toBe('"0 0"');
  const drifted = run(seed('drifted.json', { 'test/a.test.ts': 100, 'test/c.test.ts': 1, 'test/d.test.ts': 2 }));
  expect(drifted.status, drifted.stderr).toBe(0);
  expect(drifted.stdout.trim()).toBe('"2 1"');
});
