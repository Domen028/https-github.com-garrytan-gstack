/**
 * Version Gate (scripts/compare-pr-version.ts). Hard rule 1 requires VERSION
 * above the base, which dependabot can never satisfy, so a dependabot PR that
 * touches only dependency manifests, lockfiles and dependabot config is exempt.
 * Every other author or file keeps the rule.
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'compare-pr-version.ts');

function gate(env: { PR_VERSION: string; PR_AUTHOR?: string; PR_CHANGED_FILES?: string }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'version-gate-'));
  try {
    const next = path.join(dir, 'next.json');
    fs.writeFileSync(next, JSON.stringify({ version: '1.91.117.0', base_version: '1.91.116.0', claimed: [{ pr: 3236, branch: 'fix-wave-5', version: '1.91.117.0' }] }));
    const run = Bun.spawnSync([process.execPath, 'run', SCRIPT, next, '3227'], {
      env: { PATH: process.env.PATH ?? '', ...env },
      timeout: 30_000,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    return { code: run.exitCode, out: run.stdout.toString() + run.stderr.toString() };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const DEPENDABOT = 'dependabot[bot]';

describe('version gate: dependabot dependency-manifest exemption', () => {
  test('an unbumped VERSION still fails for a human author', () => {
    const result = gate({ PR_VERSION: '1.91.116.0', PR_AUTHOR: 'garrytan', PR_CHANGED_FILES: 'package.json\nbun.lock' });
    expect(result.code).toBe(1);
    expect(result.out).toContain('::error::VERSION not bumped');
  });

  test('a dependabot PR behind main that touches only manifests, lockfiles and dependabot config passes', () => {
    const files = ['package.json', 'bun.lock', 'lib/diagram-render/package.json', 'lib/diagram-render/bun.lock', '.github/dependabot.yml'].join('\n');
    const result = gate({ PR_VERSION: '1.91.106.0', PR_AUTHOR: DEPENDABOT, PR_CHANGED_FILES: files + '\n' });
    expect(result.code).toBe(0);
    expect(result.out).toContain('::notice::PR #3227 is a dependabot dependency update');
    expect(result.out).not.toContain('::error::');
  });

  test('a dependabot PR with any other file keeps hard rule 1', () => {
    for (const other of ['scripts/compare-pr-version.ts', 'VERSION', '.github/workflows/version-gate.yml', 'evil-package.json', 'package.json.bak']) {
      const result = gate({ PR_VERSION: '1.91.116.0', PR_AUTHOR: DEPENDABOT, PR_CHANGED_FILES: `package.json\nbun.lock\n${other}` });
      expect(result.code).toBe(1);
      expect(result.out).toContain('::error::VERSION not bumped');
    }
  });

  test('a missing file list or author keeps hard rule 1', () => {
    expect(gate({ PR_VERSION: '1.91.116.0', PR_AUTHOR: DEPENDABOT, PR_CHANGED_FILES: '' }).code).toBe(1);
    expect(gate({ PR_VERSION: '1.91.116.0', PR_AUTHOR: DEPENDABOT }).code).toBe(1);
    expect(gate({ PR_VERSION: '1.91.116.0', PR_CHANGED_FILES: 'package.json' }).code).toBe(1);
  });

  test('a bumped dependabot VERSION goes through the collision rule as before', () => {
    const result = gate({ PR_VERSION: '1.91.117.0', PR_AUTHOR: DEPENDABOT, PR_CHANGED_FILES: 'package.json' });
    expect(result.code).toBe(1);
    expect(result.out).toContain('::error::VERSION collision');
  });

  test('the workflow passes the PR author and its changed-file list to the gate', () => {
    const workflow = Bun.YAML.parse(fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'version-gate.yml'), 'utf8')) as any;
    const step = workflow.jobs.check.steps.find((s: any) => s.name === 'Compare PR VERSION to next free slot');
    expect(step.env.PR_AUTHOR).toBe('${{ github.event.pull_request.user.login }}');
    expect(step.env.GH_TOKEN).toBe('${{ secrets.GITHUB_TOKEN }}');
    expect(step.run).toContain('pulls/${{ github.event.pull_request.number }}/files');
    expect(step.run).toContain('--paginate');
    expect(step.run).toContain('then PR_CHANGED_FILES=""; fi');
    expect(step.run).toContain('export PR_CHANGED_FILES');
    expect(workflow.jobs.check.permissions).toEqual({ contents: 'read', 'pull-requests': 'read' });
  });
});
