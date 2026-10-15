/**
 * setup.ps1: the Windows entry point checks Git for Windows, Bun and Node.js,
 * then runs ./setup in Git Bash with every argument passed as its own argv
 * entry, never pasted into shell source. The behavioral cases copy the script
 * next to a stub ./setup that prints its argv and run it under pwsh, and
 * under Windows PowerShell 5.1's legacy native-argument passing: pwsh with
 * $PSNativeCommandArgumentPassing = 'Legacy' here, powershell.exe on Windows
 * (#3130: the 5.1 legacy mode stripped the double quotes inside the bash -c
 * script, and bash failed with "unexpected EOF").
 */
import { describe, test, expect, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';

const SCRIPT = path.resolve(import.meta.dir, '..', 'setup.ps1');
const SOURCE = fs.readFileSync(SCRIPT, 'utf-8');
const PWSH = Bun.which('pwsh');
const BASH = Bun.which('bash');

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function stubCheckout(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-ps1-'));
  dirs.push(dir);
  fs.copyFileSync(SCRIPT, path.join(dir, 'setup.ps1'));
  fs.writeFileSync(path.join(dir, 'setup'), '#!/usr/bin/env bash\nprintf \'cwd=%s\\n\' "$PWD"\nfor a in "$@"; do printf \'arg=[%s]\\n\' "$a"; done\nexit 7\n', { mode: 0o755 });
  return dir;
}

const IS_WIN = process.platform === 'win32';
/** Windows PowerShell 5.1 itself on Windows; elsewhere pwsh in Legacy argument mode. */
function runPs1Legacy(dir: string, args: string[], env: Record<string, string | undefined> = {}) {
  let cmd: string;
  let argv: string[];
  if (IS_WIN) {
    cmd = 'powershell.exe';
    argv = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(dir, 'setup.ps1'), ...args];
  } else {
    fs.writeFileSync(path.join(dir, 'legacy.ps1'), "$PSNativeCommandArgumentPassing = 'Legacy'\n& (Join-Path $PSScriptRoot 'setup.ps1') @args\nexit $LASTEXITCODE\n");
    cmd = PWSH!;
    argv = ['-NoProfile', '-NonInteractive', '-File', path.join(dir, 'legacy.ps1'), ...args];
  }
  const r = spawnSync(cmd, argv, {
    cwd: os.tmpdir(),
    encoding: 'utf-8',
    env: { ...process.env, ...(IS_WIN ? {} : { GSTACK_GIT_BASH: BASH! }), ...env },
    timeout: 60_000,
  });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

function runPs1(dir: string, args: string[], env: Record<string, string | undefined> = {}) {
  const r = spawnSync(PWSH!, ['-NoProfile', '-NonInteractive', '-File', path.join(dir, 'setup.ps1'), ...args], {
    cwd: os.tmpdir(),
    encoding: 'utf-8',
    env: { ...process.env, ...(process.platform === 'win32' ? {} : { GSTACK_GIT_BASH: BASH! }), ...env },
    timeout: 60_000,
  });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

describe('setup.ps1', () => {
  test('passes arguments NUL-separated through a private file to a constant bash script', () => {
    expect(SOURCE).toContain(`& $bash -c 'set -f; IFS=; mapfile -d '''' -t argv < $1; rm -f -- $1; exec ./setup \${argv[@]}' setup $argFile`);
    const script = SOURCE.match(/& \$bash -c '((?:[^']|'')*)' setup \$argFile/)![1]!;
    expect(script).not.toContain('"');
    expect(SOURCE).toContain('foreach ($arg in $args) { $writer.Write([string]$arg); $writer.Write([char]0) }');
    expect(SOURCE).not.toMatch(/-join|Invoke-Expression|\biex\b|git-bash\.exe/);
    expect([...SOURCE].every((c) => c.charCodeAt(0) < 128)).toBe(true);
  });

  test.skipIf(!PWSH || !BASH)('forwards every argument literally from the script directory and keeps the exit code', () => {
    const dir = stubCheckout();
    const args = ['--host', 'codex', 'two words', '$(touch PWNED)', "it's", '"quoted"', ';echo injected', '`whoami`'];
    const { code, out } = runPs1(dir, args);
    expect(code).toBe(7);
    const lines = out.split(/\r?\n/);
    expect(lines.filter((l) => l.startsWith('arg=['))).toEqual(args.map((a) => `arg=[${a}]`));
    expect(lines.find((l) => l.startsWith('cwd='))).toContain(path.basename(dir));
    expect(out).not.toContain('injected\n');
    expect(fs.existsSync(path.join(dir, 'PWNED'))).toBe(false);
    expect(fs.existsSync(path.join(os.tmpdir(), 'PWNED'))).toBe(false);
  });

  test.skipIf(!PWSH || !BASH || process.platform === 'win32')('a missing prerequisite names its winget command and runs nothing', () => {
    const dir = stubCheckout();
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-ps1-bin-'));
    dirs.push(bin);
    for (const tool of ['git', 'node']) {
      const real = Bun.which(tool);
      if (real) fs.symlinkSync(real, path.join(bin, tool));
    }
    const { code, out } = runPs1(dir, ['--host', 'codex'], { PATH: bin });
    expect(code).toBe(1);
    expect(out).toContain('Bun: winget install --id Oven-sh.Bun -e');
    expect(out).not.toContain('Git for Windows:');
    expect(out).not.toContain('arg=[');
  });

  // Arguments Node cannot hand to powershell.exe intact are left out on Windows:
  // there the command line is parsed before setup.ps1 sees it.
  const ADVERSARIAL = ['--host', 'codex', 'two words', '$(touch PWNED)', "it's", ';echo injected', '`whoami`', '*',
    ...(IS_WIN ? [] : ['"quoted"', 'a\\"b\\'])];

  test.skipIf((!PWSH && !IS_WIN) || !BASH)('Windows PowerShell 5.1 (legacy argument passing): forwards every argument literally, with a space in TMPDIR', () => {
    const dir = stubCheckout();
    const tmp = path.join(dir, 'temp with space');
    fs.mkdirSync(tmp);
    const { code, out } = runPs1Legacy(dir, ADVERSARIAL, { TMPDIR: tmp, TEMP: tmp, TMP: tmp });
    expect(out).not.toContain('unexpected EOF');
    expect(code, out).toBe(7);
    expect(out.split(/\r?\n/).filter((l) => l.startsWith('arg=['))).toEqual(ADVERSARIAL.map((a) => `arg=[${a}]`));
    expect(out).not.toContain('injected\n');
    expect(fs.existsSync(path.join(dir, 'PWNED'))).toBe(false);
    expect(fs.existsSync(path.join(os.tmpdir(), 'PWNED'))).toBe(false);
    expect(fs.readdirSync(tmp)).toEqual([]);
  });

  test.skipIf((!PWSH && !IS_WIN) || !BASH)('an empty argument is refused before anything runs', () => {
    const dir = stubCheckout();
    for (const run of [runPs1Legacy, ...(PWSH ? [runPs1] : [])]) {
      const { code, out } = run(dir, ['--host', '', 'codex']);
      expect(code, out).toBe(2);
      expect(out).toContain('setup.ps1: argument 2 is empty; setup takes no empty arguments. Nothing was installed or changed. (SETUP_PS1_EMPTY_ARGUMENT; https://github.com/garrytan/gstack/blob/main/docs/troubleshooting.md#setup-ps1-empty-argument)');
      expect(out).not.toContain('arg=[');
    }
  });
});
