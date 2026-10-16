/**
 * #3197 tripwire: production TypeScript never spawns a gstack shebang bin by
 * path and never spawns a bare `bash`. Windows cannot execute either (no
 * shebangs; a PATH `bash` is often WSL's launcher). Both go through
 * lib/script-invocation.ts (runScriptSync, runBashSync, wtreeFingerprint).
 *
 * KNOWN_SITES lists the call sites outside this fix's ownership, each with
 * the change that removes it. It may only shrink.
 *
 * Second rule: the compiled binaries (`bun build --compile` entries) never
 * reach lib/script-invocation.ts. Inside a compiled binary process.execPath
 * is the binary itself and import.meta.url is a virtual path, so a bin path
 * computed there points at nothing.
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '..');

const SPAWN_BIN_BY_PATH = /\b(?:spawn|spawnSync|execFile|execFileSync)\(\s*(?:path\.)?join\(\s*(?:BIN_DIR|binDir|BIN|bin|binRoot|BIN_ROOT)\b/;
const SPAWN_BARE_BASH = /\b(?:spawn|spawnSync|execFile|execFileSync|execSync)\(\s*['"]bash['"]|Bun\.spawn(?:Sync)?\(\s*\[\s*['"]bash['"]|\[\s*['"]bash['"]\s*,\s*['"]-l?c['"]/;
const COMMENT = /^\s*(?:\/\/|\*|\/\*)/;

const KNOWN_SITES: Record<string, string> = {
  'lib/pregate/checks/guards.ts': 'PR 5 (a #3190 file): repo guard commands move to runBashSync',
  'lib/pregate/checks/lanes.ts': 'PR 5 (a #3190 file): the lane runner moves to runBashSync',
  'lib/evidence-bundle.ts': 'outside this wave: bundle replay commands (bash -lc) move to runBashSync',
  'bin/gstack-brain-context-load.ts': 'outside this wave: the brain context loader moves to runBashSync',
  'bin/gstack-issue-links': 'outside this wave: the gstack-issue-guard spawn moves to runScriptSync',
};

function productionFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = path.posix.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== 'dist') walk(rel); continue; }
      if (rel.endsWith('.ts') && !rel.endsWith('.d.ts')) out.push(rel);
    }
  };
  walk('lib');
  walk('hosts');
  for (const e of fs.readdirSync(path.join(ROOT, 'bin'), { withFileTypes: true })) {
    if (!e.isFile()) continue;
    const rel = `bin/${e.name}`;
    if (rel.endsWith('.ts') || /^#!.*\bbun\b/.test(fs.readFileSync(path.join(ROOT, rel), 'utf8').split('\n')[0] ?? '')) out.push(rel);
  }
  return out.sort();
}

function offendingSites(): Record<string, string[]> {
  const hits: Record<string, string[]> = {};
  for (const rel of productionFiles()) {
    if (rel === 'lib/script-invocation.ts') continue;
    fs.readFileSync(path.join(ROOT, rel), 'utf8').split('\n').forEach((line, i) => {
      if (COMMENT.test(line)) return;
      if (SPAWN_BIN_BY_PATH.test(line) || SPAWN_BARE_BASH.test(line)) (hits[rel] ??= []).push(`${rel}:${i + 1}: ${line.trim().slice(0, 120)}`);
    });
  }
  return hits;
}

describe('#3197: shebang bins and bash go through lib/script-invocation.ts', () => {
  test('no production file spawns a gstack bin by path or a bare bash, outside the known sites', () => {
    const hits = offendingSites();
    const unexpected = Object.entries(hits).filter(([file]) => !(file in KNOWN_SITES)).flatMap(([, lines]) => lines);
    if (unexpected.length) {
      throw new Error(`spawn through lib/script-invocation.ts instead (runScriptSync for a bin, runBashSync for bash -c, wtreeFingerprint for gstack-wtree):\n${unexpected.join('\n')}`);
    }
  });

  test('KNOWN_SITES only shrinks: every entry still has a site to remove', () => {
    const hits = offendingSites();
    const stale = Object.keys(KNOWN_SITES).filter(file => !hits[file]);
    expect(stale).toEqual([]);
  });

  test('the scanner catches both shapes', () => {
    expect(SPAWN_BIN_BY_PATH.test("spawnSync(path.join(BIN_DIR, 'gstack-wtree'), [], { timeout: 1 })")).toBe(true);
    expect(SPAWN_BIN_BY_PATH.test('spawnSync(join(BIN_DIR, "gstack-slug"), { timeout: 1 })')).toBe(true);
    expect(SPAWN_BARE_BASH.test("spawnSync('bash', ['-c', cmd], { timeout: 1 })")).toBe(true);
    expect(SPAWN_BARE_BASH.test('const argv = ["bash", "-c", command];')).toBe(true);
    expect(SPAWN_BARE_BASH.test("spawnSync(process.execPath, [script], { timeout: 1 })")).toBe(false);
  });
});

describe('#3197: compiled binaries never import lib/script-invocation.ts', () => {
  const IMPORT = /(?:^|\n)\s*(?:import|export)\s[^'"]*?from\s*['"](\.{1,2}\/[^'"]+)['"]|import\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g;

  function compiledEntries(): string[] {
    const scripts = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).scripts as Record<string, string>;
    const entries = new Set<string>();
    for (const cmd of Object.values(scripts)) for (const m of cmd.matchAll(/bun build --compile\s+(\S+\.ts)/g)) entries.add(m[1]!);
    return [...entries].sort();
  }

  function reaches(entry: string, target: string): string[] | null {
    const seen = new Set<string>();
    const stack: Array<{ file: string; trail: string[] }> = [{ file: path.join(ROOT, entry), trail: [entry] }];
    while (stack.length) {
      const { file, trail } = stack.pop()!;
      if (seen.has(file)) continue;
      seen.add(file);
      let src: string;
      try { src = fs.readFileSync(file, 'utf8'); } catch { continue; }
      for (const m of src.matchAll(IMPORT)) {
        const spec = m[1] ?? m[2]!;
        const base = path.resolve(path.dirname(file), spec);
        const resolved = [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts')].find(p => fs.existsSync(p) && fs.statSync(p).isFile());
        if (!resolved) continue;
        const rel = path.relative(ROOT, resolved).split(path.sep).join('/');
        if (rel === target) return [...trail, rel];
        stack.push({ file: resolved, trail: [...trail, rel] });
      }
    }
    return null;
  }

  test('package.json declares compiled entries', () => {
    expect(compiledEntries().length).toBeGreaterThan(0);
  });

  for (const entry of compiledEntries()) {
    test(`${entry} does not reach lib/script-invocation.ts`, () => {
      expect(reaches(entry, 'lib/script-invocation.ts')).toBeNull();
    });
  }
});
