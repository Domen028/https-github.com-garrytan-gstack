/**
 * bin/gstack-upgrade: the deterministic, unattended upgrade every fix line
 * names. Pinned on its machine lines (`gstack-upgrade: current|behind|upgraded`),
 * exit codes (0 ok, 1 behind on --check, 3 refused with nothing changed) and
 * what it refuses: a dirty tracked byte, a diverged local commit, a pinned
 * (detached or off-default) checkout, an unreachable remote. Never stash,
 * never reset: HEAD, file bytes and the reflog are unchanged on refusal.
 * Fixture: a bare remote with commits A (1.0.0) and B (1.0.1), a depth-1
 * file:// clone at A, ./setup and bin/gstack-capy-install stubs that log argv,
 * on the simulated Capy host (test/helpers/capy-host.ts).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { capyHost, type CapyHost } from './helpers/capy-host';

const REPO = path.resolve(import.meta.dir, '..');
const DEPS = [
  'bin/gstack-upgrade', 'bin/gstack-bun-version.sh', 'bin/gstack-paths', 'bin/gstack-state-root.sh',
  'bin/gstack-egress-lib.sh', 'bin/gstack-egress-receipt', 'lib/egress-receipt.ts', 'lib/state-root.ts',
];
const hosts: CapyHost[] = [];
afterEach(() => { for (const h of hosts.splice(0)) h.cleanup(); });

const write = (file: string, text: string, mode = 0o644) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, { mode });
};

function fixture() {
  const host = capyHost({ systemBun: '1.4.2' });
  hosts.push(host);
  const git = (args: string[], cwd: string) => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: host.env, timeout: 30_000 });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  const log = path.join(host.base, 'calls.log');
  const seed = path.join(host.base, 'seed');
  const bare = path.join(host.base, 'remote.git');
  fs.mkdirSync(seed, { recursive: true });
  git(['init', '-q', '-b', 'main'], seed);
  for (const rel of DEPS) {
    if (!fs.existsSync(path.join(REPO, rel))) continue;
    fs.mkdirSync(path.dirname(path.join(seed, rel)), { recursive: true });
    fs.copyFileSync(path.join(REPO, rel), path.join(seed, rel));
    fs.chmodSync(path.join(seed, rel), fs.statSync(path.join(REPO, rel)).mode);
  }
  write(path.join(seed, 'VERSION'), '1.0.0\n');
  write(path.join(seed, 'README.md'), 'gstack fixture\n');
  write(path.join(seed, 'bin/gstack-config'), '#!/usr/bin/env bash\nexit 0\n', 0o755);
  write(path.join(seed, 'setup'), '#!/usr/bin/env bash\necho "setup $*" >> "$UPGRADE_LOG"\nexit "${STUB_SETUP_EXIT:-0}"\n', 0o755);
  git(['add', '-A'], seed);
  git(['commit', '-qm', 'A'], seed);
  const a = git(['rev-parse', 'HEAD'], seed);
  git(['init', '-q', '--bare', '-b', 'main', bare], host.base);
  git(['push', '-q', bare, 'main'], seed);
  const root = path.join(host.base, 'gstack');
  git(['clone', '-q', '--single-branch', '--depth', '1', `file://${bare}`, root], host.base);
  write(path.join(seed, 'VERSION'), '1.0.1\n');
  git(['commit', '-qam', 'B'], seed);
  const b = git(['rev-parse', 'HEAD'], seed);
  git(['push', '-q', bare, 'main'], seed);
  const env = { ...host.env, UPGRADE_LOG: log };
  const run = (args: string[] = [], extra: Record<string, string> = {}) =>
    spawnSync('bash', [path.join(root, 'bin/gstack-upgrade'), ...args], { cwd: host.home, encoding: 'utf8', env: { ...env, ...extra }, timeout: 60_000 });
  return {
    host, root, bare, a, b, run, git: (args: string[]) => git(args, root),
    calls: () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : [],
  };
}

describe('gstack-upgrade', () => {
  test('--check: behind prints both versions and the commit count, exit 1, writes nothing', () => {
    const f = fixture();
    expect(f.git(['rev-parse', '--is-shallow-repository'])).toBe('true');
    const r = f.run(['--check']);
    expect(r.status, r.stdout + r.stderr).toBe(1);
    expect(r.stdout).toContain('gstack-upgrade: behind 1.0.0 -> 1.0.1 (1 commits)');
    expect(f.git(['rev-parse', 'HEAD'])).toBe(f.a);
    expect(f.calls()).toEqual([]);
  });

  test('default: fast-forwards to the remote default branch and runs setup --refresh-registered; --check is then current', () => {
    const f = fixture();
    const r = f.run();
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(f.git(['rev-parse', 'HEAD'])).toBe(f.b);
    expect(r.stdout).toContain('gstack-upgrade: upgraded 1.0.0 -> 1.0.1');
    expect(f.calls()).toEqual(['setup --refresh-registered']);
    const again = f.run(['--check']);
    expect(again.status).toBe(0);
    expect(again.stdout).toContain('gstack-upgrade: current 1.0.1');
  });

  test('a reinstall that fails after the fast-forward exits 1; the next run completes it instead of saying current', () => {
    const f = fixture();
    const failed = f.run([], { STUB_SETUP_EXIT: '1' });
    expect(failed.status).toBe(1);
    expect(f.git(['rev-parse', 'HEAD'])).toBe(f.b);
    expect(failed.stderr).toContain('reinstall failed');
    expect(f.run(['--check']).status).toBe(1);
    const retry = f.run();
    expect(retry.status, retry.stdout + retry.stderr).toBe(0);
    expect(retry.stdout).toContain('reinstall pending from 1.0.0');
    expect(f.calls()).toEqual(['setup --refresh-registered', 'setup --refresh-registered']);
    expect(f.run().stdout).toContain('gstack-upgrade: current 1.0.1');
  });

  test('a Capy install (the installer marker) runs bin/gstack-capy-install instead of setup', () => {
    const f = fixture();
    write(path.join(f.root, 'bin/gstack-capy-install'), '#!/usr/bin/env bash\necho "capy-install $*" >> "$UPGRADE_LOG"\necho "gstack: ok $(cat VERSION) for=autoplan"\n', 0o755);
    write(path.join(f.root, '.git/gstack-capy-install.state'), `head=${f.a}\n`);
    const r = f.run();
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(f.calls()).toEqual(['capy-install']);
    expect(r.stdout.trim().split('\n').at(-1)).toBe('gstack: ok 1.0.1 for=autoplan');
  });

  test('a dirty tracked byte refuses with UPGRADE_REFUSED: exit 3, HEAD, bytes and reflog unchanged', () => {
    const f = fixture();
    fs.writeFileSync(path.join(f.root, 'README.md'), 'local edit\n');
    const reflog = f.git(['reflog']);
    const r = f.run();
    expect(r.status).toBe(3);
    expect(r.stderr).toContain('(UPGRADE_REFUSED)');
    expect(r.stderr).toContain('README.md');
    expect(f.git(['rev-parse', 'HEAD'])).toBe(f.a);
    expect(fs.readFileSync(path.join(f.root, 'README.md'), 'utf8')).toBe('local edit\n');
    expect(f.git(['reflog'])).toBe(reflog);
    expect(f.git(['stash', 'list'])).toBe('');
    expect(f.calls()).toEqual([]);
  });

  test('a diverged local commit refuses with UPGRADE_REFUSED: never stash, never reset', () => {
    const f = fixture();
    fs.writeFileSync(path.join(f.root, 'README.md'), 'local commit\n');
    f.git(['commit', '-qam', 'local']);
    const head = f.git(['rev-parse', 'HEAD']);
    const reflog = f.git(['reflog']);
    const r = f.run();
    expect(r.status).toBe(3);
    expect(r.stderr).toContain('(UPGRADE_REFUSED)');
    expect(f.git(['rev-parse', 'HEAD'])).toBe(head);
    expect(f.git(['reflog'])).toBe(reflog);
    expect(f.calls()).toEqual([]);
  });

  test('a detached (pinned) checkout refuses; an unreachable remote is UPGRADE_FETCH_FAILED (exit 3) for --check and default', () => {
    const f = fixture();
    f.git(['checkout', '-q', '--detach', 'HEAD']);
    const pinned = f.run();
    expect(pinned.status).toBe(3);
    expect(pinned.stderr).toContain('(UPGRADE_REFUSED)');
    expect(pinned.stderr).toContain('detached');
    f.git(['checkout', '-q', 'main']);
    fs.rmSync(f.bare, { recursive: true, force: true });
    for (const args of [['--check'], []]) {
      const offline = f.run(args);
      expect(offline.status).toBe(3);
      expect(offline.stderr).toContain('(UPGRADE_FETCH_FAILED)');
      expect(f.git(['rev-parse', 'HEAD'])).toBe(f.a);
    }
  });

  test('every bin a trailer or fix line names exists in the repo', () => {
    const sources = ['bin/gstack-capy-install', 'bin/gstack-doctor-check.sh', 'bin/gstack-skill-end', 'bin/gstack-upgrade', 'docs/capy-install.md'];
    const named = new Set<string>();
    for (const rel of sources) {
      expect(fs.existsSync(path.join(REPO, rel)), rel).toBe(true);
      const lines = fs.readFileSync(path.join(REPO, rel), 'utf8').split('\n').filter(l => /fix:|\brun |gstack: (ok|fail)/.test(l));
      for (const m of lines.join('\n').matchAll(/(?:bin\/|\brun |\bfix: )(gstack-[a-z0-9-]+(?:\.sh|\.ts)?)\b/g)) named.add(m[1]);
    }
    expect(named.has('gstack-upgrade')).toBe(true);
    const missing = [...named].filter(n => !fs.existsSync(path.join(REPO, 'bin', n)));
    expect(missing).toEqual([]);
  });
});
