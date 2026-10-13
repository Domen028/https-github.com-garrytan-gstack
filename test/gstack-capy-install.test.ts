/**
 * bin/gstack-capy-install: the repo-owned Capy installer. Pinned on the order
 * of operations (preflight before ./setup), exit codes (3 before anything is
 * installed), the setup argv it passes (--no-browser unless --with-browser),
 * the lazy-browser SKIP line, the GSTACK_LAUNCH line, the trailer as the
 * last line with the `(requested <ref>; ...)` note, and the Bun recipe (exact
 * archive, SHA-256 verified, only when gstack and the project agree). ./setup,
 * gstack-doctor, gstack-browser-ensure, bun, curl and node are stubs that log
 * their argv; git, jq, unzip and sha256sum are real.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const REPO = path.resolve(import.meta.dir, '..');
const bases: string[] = [];
afterEach(() => { for (const b of bases.splice(0)) fs.rmSync(b, { recursive: true, force: true }); });

const write = (file: string, text: string, mode = 0o644) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, { mode });
};
const script = (file: string, lines: string[]) => write(file, ['#!/usr/bin/env bash', ...lines].join('\n') + '\n', 0o755);
const sh = (cmd: string, cwd?: string) => spawnSync('bash', ['-c', cmd], { cwd, encoding: 'utf8', timeout: 30_000 });

/** PATH without any directory that holds bun, node, curl or jq-less shims; real git/jq/unzip/sha256sum stay reachable. */
function hostPath(base: string, hide: string[]): string {
  return (process.env.PATH ?? '').split(path.delimiter).filter(Boolean).map((dir, i) => {
    if (!hide.some(n => fs.existsSync(path.join(dir, n)))) return dir;
    const shim = path.join(base, `host-${i}`);
    fs.mkdirSync(shim, { recursive: true });
    for (const name of fs.readdirSync(dir)) {
      if (hide.includes(name)) continue;
      try { fs.symlinkSync(path.join(dir, name), path.join(shim, name)); } catch { /* unreadable */ }
    }
    return shim;
  }).join(path.delimiter);
}

function fixture(opts: { bun?: string; jq?: boolean } = {}) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'capy-install-')));
  bases.push(base);
  const root = path.join(base, 'gstack');
  const home = path.join(base, 'home');
  const stub = path.join(base, 'stub');
  const log = path.join(base, 'calls.log');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(stub, { recursive: true });
  for (const rel of ['bin/gstack-capy-install', 'bin/gstack-bun-version.sh', 'bin/gstack-doctor-components.sh', 'bin/gstack-install-verdict.sh']) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.copyFileSync(path.join(REPO, rel), path.join(root, rel));
    fs.chmodSync(path.join(root, rel), fs.statSync(path.join(REPO, rel)).mode);
  }
  write(path.join(root, 'VERSION'), '1.2.3\n');
  script(path.join(root, 'setup'), ['echo "setup $*" >> "$CAPY_LOG"', 'echo "env GSTACK_SKIP_PLAYWRIGHT=${GSTACK_SKIP_PLAYWRIGHT:-} GSTACK_SKIP_FONTS=${GSTACK_SKIP_FONTS:-} bun=$(bun --version)" >> "$CAPY_LOG"', 'exit "${STUB_SETUP_EXIT:-0}"']);
  script(path.join(root, 'bin/gstack-doctor'), [
    'echo "doctor $* GSTACK_EPHEMERAL=${GSTACK_EPHEMERAL:-}" >> "$CAPY_LOG"', 'echo "doctor-cwd $(pwd -P)" >> "$CAPY_LOG"',
    'echo "required: claude codex patch"', 'echo "PASS claude ok"', 'echo "SKIP browser (lazy)"',
    '[ "${STUB_DOCTOR_FAIL:-}" = 1 ] && { echo "FAIL codex — missing; fix: x (COMPONENT_MISSING; d)"; echo "gstack: fail codex"; exit 1; }',
    'echo "gstack: ok $(cat "$(dirname "$0")/../VERSION") for=autoplan"',
  ]);
  script(path.join(root, 'bin/gstack-paths'), ['[ "$1" = --get ] && { echo "${GSTACK_HOME}"; exit 0; }', 'exit 1']);
  script(path.join(root, 'bin/gstack-browser-ensure'), ['echo "browser-ensure $*" >> "$CAPY_LOG"', 'echo "BROWSER_OK node 141.0.1"']);
  sh(`git init -q && git add -A && git -c user.email=t@t -c user.name=t commit -qm init`, root);
  script(path.join(stub, 'bun'), [`[ "$1" = --version ] && { echo "${opts.bun ?? '1.4.2'}"; exit 0; }`, 'exit 0']);
  script(path.join(stub, 'node'), ['[ "$1" = --version ] && { echo v24.18.0; exit 0; }', 'exit 0']);
  script(path.join(stub, 'curl'), ['echo "curl $*" >> "$CAPY_LOG"', 'out=""; while [ $# -gt 0 ]; do [ "$1" = -o ] && out="$2"; shift; done', '[ -n "${STUB_CURL_ZIP:-}" ] && cp "$STUB_CURL_ZIP" "$out" && exit 0', 'exit 22']);
  if (opts.jq !== false) {
    const real = sh('command -v jq').stdout.trim();
    if (real) fs.symlinkSync(real, path.join(stub, 'jq'));
  }
  const env: Record<string, string> = {
    PATH: `${stub}${path.delimiter}${hostPath(base, ['bun', 'node', 'curl', 'jq'])}`,
    HOME: home, GSTACK_HOME: path.join(home, '.gstack-state'), TMPDIR: base, CAPY_LOG: log, BUN_INSTALL: path.join(home, '.bun'),
  };
  const run = (args: string[] = [], extra: Record<string, string> = {}, cwd = home) =>
    spawnSync('bash', [path.join(root, 'bin/gstack-capy-install'), ...args], { cwd, encoding: 'utf8', env: { ...env, ...extra }, timeout: 120_000 });
  return { base, root, home, stub, run, calls: () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : [] };
}

const lastLine = (s: string) => s.trim().split('\n').at(-1);

describe('gstack-capy-install', () => {
  test('default install: preflight, both host setups with --no-browser, lazy browser SKIP, launch line, trailer last, exit 0', () => {
    const f = fixture();
    const r = run(f);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(f.calls().filter(l => l.startsWith('setup '))).toEqual([
      'setup --host claude --no-prefix --no-browser',
      'setup --host codex --model gpt-6-astra --no-browser',
    ]);
    expect(f.calls().filter(l => l.startsWith('env '))).toEqual(Array(2).fill('env GSTACK_SKIP_PLAYWRIGHT= GSTACK_SKIP_FONTS= bun=1.4.2'));
    expect(f.calls().some(l => l.startsWith('browser-ensure'))).toBe(false);
    expect(f.calls().filter(l => l.startsWith('doctor '))).toEqual(['doctor --check --require claude,codex,patch GSTACK_EPHEMERAL=1']);
    expect(f.calls().filter(l => l.startsWith('doctor-cwd '))).toEqual([`doctor-cwd ${f.home}`]);
    expect(r.stdout).toContain('SKIP browser (lazy; gstack-browser-ensure installs on first use)');
    expect(r.stdout).toMatch(/planning-only install: \d+s/);
    expect(r.stdout).toContain(`GSTACK_LAUNCH: GSTACK_SESSION_KIND=unattended GSTACK_STATE_ROOT=${path.join(f.home, '.gstack-state')} GSTACK_EPHEMERAL=1`);
    expect(lastLine(r.stdout)).toBe('gstack: ok 1.2.3 for=autoplan');
    expect(r.stdout).toContain('reusing');
    expect(r.stdout).not.toContain('cloning');
    expect(f.calls().some(l => l.startsWith('curl '))).toBe(false);
  });

  test('--for names the workflow; --with-browser drops --no-browser, runs gstack-browser-ensure and times it separately', () => {
    const f = fixture();
    const r = run(f, ['--for', 'qa', '--with-browser']);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(f.calls().filter(l => l.startsWith('setup '))).toEqual(['setup --host claude --no-prefix', 'setup --host codex --model gpt-6-astra']);
    expect(f.calls().filter(l => l.startsWith('browser-ensure'))).toEqual(['browser-ensure ']);
    expect(f.calls().filter(l => l.startsWith('doctor '))).toEqual(['doctor --check --for qa GSTACK_EPHEMERAL=1']);
    expect(r.stdout).toMatch(/browser bootstrap: \d+s/);
    expect(r.stdout).not.toContain('SKIP browser (lazy; gstack-browser-ensure');
    const g = fixture();
    const req = run(g, ['--with-browser']);
    expect(req.status).toBe(0);
    expect(g.calls().filter(l => l.startsWith('doctor '))).toEqual(['doctor --check --require claude,codex,patch,browse-bundle,browser GSTACK_EPHEMERAL=1']);
  });

  test('a FAIL from the doctor is exit 1 with its trailer last; usage errors exit 2', () => {
    const f = fixture();
    const r = run(f, [], { STUB_DOCTOR_FAIL: '1' });
    expect(r.status).toBe(1);
    expect(lastLine(r.stdout)).toBe('gstack: fail codex');
    expect(r.stdout).toContain('FAIL codex');
    expect(run(f, ['--bogus']).status).toBe(2);
    expect(run(f, ['--for', 'qa', '--require', 'claude']).status).toBe(2);
    expect(run(f, ['--revision']).status).toBe(2);
  });

  test('preflight: a missing tool stops with exit 3 and INSTALL_PREFLIGHT_FAILED before ./setup runs', () => {
    const f = fixture({ jq: false });
    const r = run(f);
    expect(r.status).toBe(3);
    expect(r.stderr).toContain('preflight: jq not found');
    expect(r.stderr).toContain('(INSTALL_PREFLIGHT_FAILED; https://github.com/garrytan/gstack/blob/main/docs/troubleshooting.md#capy-install-preflight-failed)');
    expect(f.calls().some(l => l.startsWith('setup '))).toBe(false);
  });

  test('Bun pin conflict: an exact project pin below the minimum stops with both constraints and installs nothing', () => {
    const f = fixture({ bun: '1.3.14' });
    const project = path.join(f.base, 'project');
    write(path.join(project, 'package.json'), '{ "engines": { "bun": "1.3.14" } }\n');
    sh('git init -q', project);
    const r = run(f, [], {}, project);
    expect(r.status).toBe(3);
    expect(r.stderr).toContain('Bun conflict: gstack needs >=1.4.2');
    expect(r.stderr).toContain(`${project}/package.json pins exactly 1.3.14`);
    expect(r.stderr).toContain('(RUNTIME_PIN_CONFLICT; https://github.com/garrytan/gstack/blob/main/docs/troubleshooting.md#capy-install-runtime-conflict)');
    expect(f.calls().some(l => l.startsWith('curl ') || l.startsWith('setup '))).toBe(false);
    // --project overrides the cwd's repository; a range the minimum satisfies agrees.
    write(path.join(project, 'package.json'), '{ "engines": { "bun": ">=1.4.0" } }\n');
    const agree = run(fixture(), ['--project', project]);
    expect(agree.status, agree.stdout + agree.stderr).toBe(0);
    expect(agree.stdout).toContain('project pin >=1.4.0');
    const conflictRange = run(fixture({ bun: '1.4.2' }), ['--project', (write(path.join(project, 'package.json'), '{ "engines": { "bun": ">=2.0.0" } }\n'), project)]);
    expect(conflictRange.status).toBe(3);
    expect(conflictRange.stderr).toContain('pins >=2.0.0');
  });

  test('an exact project pin above the minimum with a verified archive is the Bun installed; an unverified one stops naming the verified versions', () => {
    const f = fixture({ bun: '1.3.14' });
    const project = path.join(f.base, 'project');
    write(path.join(project, '.bun-version'), '1.4.3\n');
    sh('git init -q', project);
    const zip = path.join(f.base, 'bad.zip');
    fs.mkdirSync(path.join(f.base, 'z/bun-linux-x64'), { recursive: true });
    script(path.join(f.base, 'z/bun-linux-x64/bun'), ['echo 1.4.3']);
    expect(sh(`cd "${f.base}/z" && zip -qr "${zip}" bun-linux-x64`).status).toBe(0);
    const adopted = run(f, ['--project', project], { STUB_CURL_ZIP: zip });
    expect(adopted.stdout).toContain('installing bun 1.4.3 from its release archive');
    expect(adopted.stdout).not.toContain("gstack's minimum 1.4.3");
    expect(f.calls().filter(l => l.startsWith('curl '))).toEqual([expect.stringContaining('https://github.com/oven-sh/bun/releases/download/bun-v1.4.3/bun-linux')]);
    expect(adopted.status).toBe(3);
    expect(adopted.stderr).toContain('SHA-256 mismatch');
    const g = fixture({ bun: '1.3.14' });
    write(path.join(project, '.bun-version'), '1.4.9\n');
    const unverified = run(g, ['--project', project]);
    expect(unverified.status).toBe(3);
    expect(unverified.stderr).toContain(`${project}/.bun-version pins exactly 1.4.9`);
    expect(unverified.stderr).toContain('verified archives: 1.4.2 1.4.3');
    expect(unverified.stderr).toContain('(RUNTIME_PIN_CONFLICT; ');
    expect(g.calls().some(l => l.startsWith('curl ') || l.startsWith('setup '))).toBe(false);
  });

  test('Bun below the minimum: the exact release archive is downloaded and SHA-256 verified; a mismatch installs nothing', () => {
    const f = fixture({ bun: '1.3.14' });
    const zip = path.join(f.base, 'bad.zip');
    fs.mkdirSync(path.join(f.base, 'z/bun-linux-x64'), { recursive: true });
    script(path.join(f.base, 'z/bun-linux-x64/bun'), ['echo 1.4.2']);
    expect(sh(`cd "${f.base}/z" && zip -qr "${zip}" bun-linux-x64`).status).toBe(0);
    const r = run(f, [], { STUB_CURL_ZIP: zip });
    expect(r.status).toBe(3);
    expect(r.stderr).toContain('SHA-256 mismatch');
    expect(r.stderr).toContain('nothing installed');
    expect(f.calls().filter(l => l.startsWith('curl '))).toHaveLength(1);
    expect(f.calls()[0]).toContain('https://github.com/oven-sh/bun/releases/download/bun-v1.4.2/bun-linux-x64');
    expect(fs.existsSync(path.join(f.home, '.bun/bin/bun'))).toBe(false);
    expect(f.calls().some(l => l.startsWith('setup '))).toBe(false);
  });

  test.skipIf(process.platform !== 'linux')('Bun below the minimum: a verified archive installs into BUN_INSTALL and ./setup runs on the new Bun', () => {
    const f = fixture({ bun: '1.3.14' });
    const target = sh('grep -q avx2 /proc/cpuinfo && echo linux-x64 || echo linux-x64-baseline').stdout.trim();
    const zip = path.join(f.base, 'good.zip');
    fs.mkdirSync(path.join(f.base, `z/bun-${target}`), { recursive: true });
    script(path.join(f.base, `z/bun-${target}/bun`), ['echo 1.4.2']);
    expect(sh(`cd "${f.base}/z" && zip -qr "${zip}" bun-${target}`).status).toBe(0);
    const sha = sh(`sha256sum "${zip}" | cut -d' ' -f1`).stdout.trim();
    const versions = path.join(f.root, 'bin/gstack-bun-version.sh');
    fs.writeFileSync(versions, fs.readFileSync(versions, 'utf8').replace(new RegExp(`(\\s*${target}\\) echo )[0-9a-f]{64}`), `$1${sha}`));
    const r = run(f, ['--for', 'autoplan'], { STUB_CURL_ZIP: zip });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain('installing bun 1.4.2 from its release archive');
    expect(r.stdout).toContain(`bun 1.4.2 installed at ${path.join(f.home, '.bun/bin/bun')}`);
    expect(fs.existsSync(path.join(f.home, '.bun/bin/bun'))).toBe(true);
    expect(f.calls().filter(l => l.startsWith('env '))).toEqual(Array(2).fill('env GSTACK_SKIP_PLAYWRIGHT= GSTACK_SKIP_FONTS= bun=1.4.2'));
    expect(lastLine(r.stdout)).toBe('gstack: ok 1.2.3 for=autoplan');
  });

  test('--revision: an existing checkout at another revision is reused, never pulled, and the trailer says so', () => {
    const f = fixture();
    const before = sh('git rev-parse HEAD', f.root).stdout.trim();
    const r = run(f, ['--revision', 'v9.9.9.9']);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(lastLine(r.stdout)).toBe(`gstack: ok 1.2.3 for=autoplan (requested v9.9.9.9; run ${f.root}/bin/gstack-upgrade to move)`);
    expect(sh('git rev-parse HEAD', f.root).stdout.trim()).toBe(before);
    expect(run(f, ['--revision', '1.2.3']).stdout).not.toContain('requested');
    expect(lastLine(run(f, ['--revision', before]).stdout)).toBe('gstack: ok 1.2.3 for=autoplan');
  });

  test('--root clones when the directory is absent and refuses a non-gstack directory', () => {
    const f = fixture();
    const clone = path.join(f.base, 'clone');
    const r = run(f, ['--root', clone], { GSTACK_CAPY_REPO: f.root });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain(`cloning ${f.root} into ${clone}`);
    expect(fs.existsSync(path.join(clone, 'setup'))).toBe(true);
    const occupied = path.join(f.base, 'occupied');
    write(path.join(occupied, 'README.md'), 'x');
    const refused = run(f, ['--root', occupied]);
    expect(refused.status).toBe(3);
    expect(refused.stderr).toContain('is not a gstack checkout');
  });
});

// Field wave lane A (items 3 and 5): the launch line carries the verified Bun
// the trailer certified, an installed Bun is reused, a project's exact CI pin
// is installed alongside a different PATH Bun, ./setup is skipped when this
// HEAD was already set up, and a verdict file records what was certified.
describe('gstack-capy-install: launch PATH, Bun reuse, CI pins, setup skip, verdict', () => {
  const zipBun = (f: ReturnType<typeof fixture>, version: string, runsTs = false) => {
    const target = sh('grep -q avx2 /proc/cpuinfo && echo linux-x64 || echo linux-x64-baseline').stdout.trim();
    const zip = path.join(f.base, `bun-${version}.zip`);
    fs.mkdirSync(path.join(f.base, `z/bun-${target}`), { recursive: true });
    script(path.join(f.base, `z/bun-${target}/bun`), runsTs
      ? [`[ "$1" = --version ] && { echo ${version}; exit 0; }`, `exec "${process.execPath}" "$@"`]
      : [`echo ${version}`]);
    expect(sh(`cd "${f.base}/z" && zip -qr "${zip}" bun-${target}`).status).toBe(0);
    const sha = sh(`sha256sum "${zip}" | cut -d' ' -f1`).stdout.trim();
    const versions = path.join(f.root, 'bin/gstack-bun-version.sh');
    fs.writeFileSync(versions, fs.readFileSync(versions, 'utf8').replace(new RegExp(`(\\s*${target}\\) echo )[0-9a-f]{64}`), `$1${sha}`));
    sh('git add -A && git -c user.email=t@t -c user.name=t commit -qm sha', f.root);
    return zip;
  };
  const verdicts = (f: ReturnType<typeof fixture>) => {
    const dir = path.join(f.home, '.gstack-state/install-verdicts');
    return fs.existsSync(dir) ? fs.readdirSync(dir).map(n => path.join(dir, n)) : [];
  };

  test.skipIf(process.platform !== 'linux')('after installing Bun the launch line carries its PATH; a second run reuses it (one download) and skips setup on the same HEAD', () => {
    const f = fixture({ bun: '1.3.14' });
    const zip = zipBun(f, '1.4.2');
    const bunDir = path.join(f.home, '.bun/bin');
    const first = run(f, ['--for', 'autoplan'], { STUB_CURL_ZIP: zip });
    expect(first.status, first.stdout + first.stderr).toBe(0);
    expect(first.stdout).toContain(`GSTACK_LAUNCH: PATH=${bunDir}:$PATH GSTACK_SESSION_KIND=unattended GSTACK_STATE_ROOT=${path.join(f.home, '.gstack-state')} GSTACK_EPHEMERAL=1 GSTACK_CAPY=1 GSTACK_INSTALL_VERDICT=`);
    expect(first.stdout).toContain(`GSTACK_LAUNCH_PATH: ${bunDir}`);
    const second = run(f, ['--for', 'autoplan'], { STUB_CURL_ZIP: zip });
    expect(second.status, second.stdout + second.stderr).toBe(0);
    expect(second.stdout).toContain(`bun 1.4.2 at ${bunDir}/bun`);
    expect(second.stdout).toContain(`GSTACK_LAUNCH: PATH=${bunDir}:$PATH `);
    expect(f.calls().filter(l => l.startsWith('curl '))).toHaveLength(1);
    expect(f.calls().filter(l => l.startsWith('setup '))).toHaveLength(2);
    expect(second.stdout).toContain('setup skipped');
    expect(lastLine(second.stdout)).toBe('gstack: ok 1.2.3 for=autoplan');
  });

  test('setup runs only on the first of two runs on one HEAD; a new HEAD, a failed doctor or --with-browser runs it again', () => {
    const f = fixture();
    expect(run(f).status).toBe(0);
    expect(run(f).status).toBe(0);
    expect(f.calls().filter(l => l.startsWith('setup '))).toHaveLength(2);
    expect(run(f, [], { STUB_DOCTOR_FAIL: '1' }).status).toBe(1);
    expect(f.calls().filter(l => l.startsWith('setup '))).toHaveLength(4);
    write(path.join(f.root, 'NEW'), 'x\n');
    sh('git add NEW && git -c user.email=t@t -c user.name=t commit -qm next', f.root);
    expect(run(f).status).toBe(0);
    expect(f.calls().filter(l => l.startsWith('setup '))).toHaveLength(6);
    expect(run(f, ['--with-browser']).status).toBe(0);
    expect(f.calls().filter(l => l.startsWith('setup '))).toHaveLength(8);
  });

  test('a setup that fails once leaves the trailer fail and records nothing; the next run sets up again and ends ok', () => {
    const f = fixture();
    const failed = run(f, [], { STUB_SETUP_EXIT: '1' });
    expect(failed.status).toBe(1);
    expect(lastLine(failed.stdout)).toMatch(/^gstack: fail setup/);
    expect(run(f).status).toBe(0);
    expect(f.calls().filter(l => l.startsWith('setup '))).toHaveLength(3);
  });

  test.skipIf(process.platform !== 'linux')('PATH Bun 1.4.3 and a CI pin of 1.4.2: the pinned verified Bun is installed alongside and launched with its PATH', () => {
    const f = fixture({ bun: '1.4.3' });
    script(path.join(f.stub, 'bun'), ['[ "$1" = --version ] && { echo 1.4.3; exit 0; }', `exec "${process.execPath}" "$@"`]);
    for (const rel of ['bin/gstack-runtime-pins.ts', 'lib/runtime-pins.ts']) write(path.join(f.root, rel), fs.readFileSync(path.join(REPO, rel), 'utf8'), 0o755);
    const zip = zipBun(f, '1.4.2', true);
    const project = path.join(f.base, 'project');
    write(path.join(project, 'package.json'), '{ "engines": { "bun": ">=1.4.0" } }\n');
    write(path.join(project, '.github/workflows/ci.yml'), 'jobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: oven-sh/setup-bun@v2\n        with:\n          bun-version: 1.4.2\n');
    const r = run(f, ['--for', 'review', '--project', project], { STUB_CURL_ZIP: zip });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(f.calls().filter(l => l.startsWith('curl '))).toHaveLength(1);
    expect(f.calls().find(l => l.startsWith('curl '))).toContain('bun-v1.4.2/bun-');
    expect(fs.existsSync(path.join(f.home, '.bun/bin/bun'))).toBe(true);
    expect(r.stdout).toContain(`GSTACK_LAUNCH: PATH=${path.join(f.home, '.bun/bin')}:$PATH `);
    const other = fixture({ bun: '1.4.3' });
    script(path.join(other.stub, 'bun'), ['[ "$1" = --version ] && { echo 1.4.3; exit 0; }', `exec "${process.execPath}" "$@"`]);
    for (const rel of ['bin/gstack-runtime-pins.ts', 'lib/runtime-pins.ts']) write(path.join(other.root, rel), fs.readFileSync(path.join(REPO, rel), 'utf8'), 0o755);
    write(path.join(project, '.github/workflows/ci.yml'), 'jobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: oven-sh/setup-bun@v2\n        with:\n          bun-version: 1.4.1\n');
    const conflict = run(other, ['--project', project]);
    expect(conflict.status).toBe(3);
    expect(conflict.stderr).toContain('pins exactly 1.4.1');
    expect(conflict.stderr).toContain('(RUNTIME_PIN_CONFLICT; ');
  });

  test('the verdict file records checkout, HEAD, workflow and trailer, keyed by the checkout; --check certifies without setup or downloads', () => {
    const f = fixture();
    const r = run(f, ['--for', 'autoplan']);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const files = verdicts(f);
    expect(files).toHaveLength(1);
    expect(r.stdout).toContain(`GSTACK_INSTALL_VERDICT=${files[0]}`);
    const v = JSON.parse(fs.readFileSync(files[0], 'utf8'));
    expect(v).toMatchObject({ schema_version: 1, checkout: f.root, head: sh('git rev-parse HEAD', f.root).stdout.trim(), for: 'autoplan', ok: true, trailer: 'gstack: ok 1.2.3 for=autoplan' });
    const setups = f.calls().filter(l => l.startsWith('setup ')).length;
    const c = run(f, ['--check', '--for', 'autoplan']);
    expect(c.status, c.stdout + c.stderr).toBe(0);
    expect(f.calls().filter(l => l.startsWith('setup ')).length).toBe(setups);
    expect(c.stdout).toContain('GSTACK_LAUNCH: ');
    expect(lastLine(c.stdout)).toBe('gstack: ok 1.2.3 for=autoplan');
    const failed = run(f, ['--check', '--for', 'autoplan'], { STUB_DOCTOR_FAIL: '1' });
    expect(failed.status).toBe(1);
    expect(JSON.parse(fs.readFileSync(files[0], 'utf8'))).toMatchObject({ ok: false, trailer: 'gstack: fail codex' });
  });
});

function run(f: ReturnType<typeof fixture>, args: string[] = [], extra: Record<string, string> = {}, cwd?: string) {
  return f.run(args, extra, cwd);
}
