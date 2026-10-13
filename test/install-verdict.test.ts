/**
 * lib/install-verdict.ts and bin/gstack-install-verdict.sh: the one reader of
 * the install verdict gstack-capy-install writes, shared by gstack-skill-start
 * (Bash) and gstack-autoplan's mutating verbs (TypeScript). Pinned on the
 * admission decision (who must hold a verdict, what a verdict admits), the
 * verdict path keyed by the source checkout's realpath, and the source-root
 * resolution through an installed root's .source-path.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { checkInstallAdmission, installVerdictPath, readInstallVerdict, sourceRoot } from '../lib/install-verdict';

const ROOT = path.resolve(import.meta.dir, '..');
const REAL = fs.realpathSync(ROOT);
const HEAD = execFileSync('git', ['-C', ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 30_000 }).trim();
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'install-verdict-')); dirs.push(d); return d; };
const writeVerdict = (stateRoot: string, over: Record<string, unknown> = {}) => {
  const file = installVerdictPath(REAL, stateRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    schema_version: 1, checkout: REAL, head: HEAD, for: 'autoplan',
    required: ['claude', 'codex', 'patch', 'runtime', 'pins', 'state-root', 'privacy', 'cores', 'revision'],
    pins_planning_only: false, ok: true, trailer: 'gstack: ok 9.9.9.9 for=autoplan', min_revision: 'unknown', launch_path: '', time: '2026-10-12T00:00:00Z', ...over,
  }));
  return file;
};

describe('install verdict (TypeScript)', () => {
  test('the verdict path is keyed by sha256 of the checkout realpath under <state root>/install-verdicts', () => {
    const sr = tmp();
    expect(installVerdictPath(REAL, sr)).toBe(path.join(sr, 'install-verdicts', `${createHash('sha256').update(REAL).digest('hex')}.json`));
    expect(readInstallVerdict(path.join(sr, 'nope.json'))).toBeNull();
    expect(readInstallVerdict(writeVerdict(sr))?.head).toBe(HEAD);
  });

  test('admission: only unattended and Capy-spawned sessions apply; a runtime below the minimum refuses; GSTACK_CAPY=1 needs a matching verdict', () => {
    const sr = tmp();
    const base = { skill: 'autoplan', gstackRoot: ROOT, bunVersion: '1.4.2' };
    expect(checkInstallAdmission({ ...base, env: {} }).applies).toBe(false);
    const unattended = { GSTACK_SESSION_KIND: 'unattended', GSTACK_STATE_ROOT: sr };
    expect(checkInstallAdmission({ ...base, env: unattended })).toMatchObject({ applies: true, refuse: false });
    const oldBun = checkInstallAdmission({ ...base, env: unattended, bunVersion: '1.3.14' });
    expect(oldBun).toMatchObject({ refuse: true, status: 'runtime', code: 'RUNTIME_BELOW_MINIMUM' });
    expect(oldBun.line).toMatch(/^INSTALL: fail runtime — bun 1\.3\.14 .*below the supported minimum 1\.4\.2; fix: .+ \(RUNTIME_BELOW_MINIMUM\)$/);
    const capy = { ...unattended, GSTACK_CAPY: '1' };
    expect(checkInstallAdmission({ ...base, env: capy })).toMatchObject({ refuse: true, status: 'verdict', code: 'INSTALL_UNVERIFIED' });
    writeVerdict(sr);
    expect(checkInstallAdmission({ ...base, env: capy })).toMatchObject({ refuse: false, status: 'ok' });
    expect(checkInstallAdmission({ ...base, skill: 'qa', env: capy })).toMatchObject({ refuse: true, status: 'verdict' });
    writeVerdict(sr, { pins_planning_only: true });
    expect(checkInstallAdmission({ ...base, skill: 'ship', env: capy }).refuse).toBe(true);
    writeVerdict(sr, { head: 'f'.repeat(40) });
    expect(checkInstallAdmission({ ...base, env: capy }).detail).toContain('another HEAD');
    const over = checkInstallAdmission({ ...base, env: { ...capy, GSTACK_ALLOW_UNSUPPORTED_RUNTIME: '1' } });
    expect(over).toMatchObject({ refuse: false, overridden: true });
    expect(checkInstallAdmission({ ...base, env: { GSTACK_SESSION_KIND: 'spawned', GSTACK_CAPY: '1', GSTACK_STATE_ROOT: sr } }).refuse).toBe(true);
    expect(checkInstallAdmission({ ...base, env: { OPENCLAW_SESSION: '1', GSTACK_STATE_ROOT: sr }, bunVersion: '1.3.14' })).toMatchObject({ applies: true, refuse: false, warn: true });
  });
});

describe('source root and support file (one helper, direct and symlinked layouts)', () => {
  const bash = (bin: string, fn: string) => spawnSync('bash', ['-c', `. "${path.join(ROOT, 'bin/gstack-install-verdict.sh')}" && ${fn}`, '_', bin], { encoding: 'utf8', timeout: 30_000 });
  test('a checkout bin resolves to the checkout; an installed root follows .source-path; both read capy/support.env', () => {
    const runtime = tmp();
    fs.symlinkSync(path.join(ROOT, 'bin'), path.join(runtime, 'bin'));
    fs.writeFileSync(path.join(runtime, '.source-path'), `${ROOT}\n`);
    const linked = path.join(tmp(), 'gstack');
    fs.symlinkSync(ROOT, linked);
    for (const bin of [path.join(ROOT, 'bin'), path.join(runtime, 'bin'), path.join(linked, 'bin')]) {
      expect(bash(bin, 'gstack_source_root "$1"').stdout.trim(), bin).toBe(REAL);
      expect(sourceRoot(path.dirname(bin))).toBe(REAL);
      expect(bash(bin, 'gstack_support_env_get "$(gstack_source_root "$1")" GSTACK_MIN_REVISION').stdout.trim()).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
    }
  });
});
