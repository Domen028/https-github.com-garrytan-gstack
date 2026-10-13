/**
 * autoplan-admission — who may run `gstack-autoplan`'s mutating verbs (plan
 * Lane A amendments as corrected by the amendment verification). On a Capy
 * host (GSTACK_CAPY=1) the install verdict the Capy wrapper writes must say
 * `gstack: ok` for this checkout and HEAD; any unattended or Capy session
 * also needs the PATH Bun at gstack's supported minimum (package.json
 * engines.bun). GSTACK_ALLOW_UNSUPPORTED_RUNTIME=1 admits anyway and the
 * caller records the returned deviation. Interactive sessions are not gated.
 *
 * Integration seam: `readInstallVerdict` below is a local shim of lane A's
 * lib/install-verdict.ts. Replace its body with an import of A's reader; the
 * rest of this module only needs { trailer, head, checkout } back.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { RunError } from './autoplan-state';
import { satisfies } from './runtime-pins';
import { resolveStateRoot } from './state-root';

const ROOT = path.resolve(import.meta.dir, '..');

export interface InstallVerdict { trailer: string; head?: string; checkout?: string }

/** Shim of lane A's reader: JSON, or `key: value` / `key=value` lines. Undefined when the file is absent or unreadable. */
export function readInstallVerdict(file: string): InstallVerdict | undefined {
  let text: string;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return undefined; }
  let fields: Record<string, string> = {};
  try { fields = JSON.parse(text); } catch {
    for (const line of text.split('\n')) { const m = /^\s*([a-z_]+)\s*[:=]\s*(.*)$/.exec(line); if (m) fields[m[1]!] = m[2]!.trim(); }
  }
  return typeof fields.trailer === 'string' ? { trailer: fields.trailer, head: fields.head, checkout: fields.checkout } : undefined;
}

function verdictProblem(env: NodeJS.ProcessEnv): string | undefined {
  const file = env.GSTACK_INSTALL_VERDICT || path.join(resolveStateRoot(env), 'install-verdict');
  const v = readInstallVerdict(file);
  if (!v) return `install verdict ${file} not found or unreadable`;
  if (!/^gstack: ok\b/.test(v.trailer)) return `install verdict says ${JSON.stringify(v.trailer)}`;
  const head = spawnSync('git', ['-C', ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 30_000 }).stdout?.trim();
  if (v.head && head && v.head !== head) return `install verdict is for another HEAD (${v.head.slice(0, 12)}, this checkout is at ${head.slice(0, 12)})`;
  if (v.checkout && v.checkout !== fs.realpathSync(ROOT)) return `install verdict is for another checkout (${v.checkout})`;
  return undefined;
}

function bunProblem(env: NodeJS.ProcessEnv): string | undefined {
  const minimum = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).engines?.bun as string | undefined;
  if (!minimum) return undefined;
  const r = spawnSync('bun', ['--version'], { encoding: 'utf8', timeout: 30_000, env });
  const version = r.stdout?.trim();
  if (!version) return 'no bun on PATH';
  return satisfies(version, minimum) === false ? `PATH runs bun ${version}, below gstack's supported minimum ${minimum}` : undefined;
}

export interface Admission { lines: string[]; deviation?: string }

/** Throws RunError (exit 3) unless the session may write; an override returns the line to print and the deviation to record. */
export function admit(env: NodeJS.ProcessEnv = process.env): Admission {
  const capy = env.GSTACK_CAPY === '1';
  if (!capy && env.GSTACK_SESSION_KIND !== 'unattended') return { lines: [] };
  const verdict = capy ? verdictProblem(env) : undefined;
  const bun = bunProblem(env);
  const problem = verdict ?? bun;
  if (!problem) return { lines: [] };
  if (env.GSTACK_ALLOW_UNSUPPORTED_RUNTIME === '1') {
    return { lines: [`ADMISSION: override GSTACK_ALLOW_UNSUPPORTED_RUNTIME=1 (${problem})`], deviation: `GSTACK_ALLOW_UNSUPPORTED_RUNTIME=1: admitted despite ${problem}` };
  }
  throw new RunError(verdict ? 'INSTALL_VERDICT_FAILED' : 'RUNTIME_BELOW_MINIMUM', problem, 3);
}
