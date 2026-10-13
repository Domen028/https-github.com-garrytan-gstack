/**
 * pregate/runtime — the Bun a repo command runs under (field wave CD1, the
 * TypeScript side of `gstack_bun_launch_dir` in bin/gstack-bun-version.sh).
 * On a Capy cloud host the image's Bun is first on PATH and older than both
 * gstack's minimum and most project pins, while the verified Bun the
 * installer left in `$BUN_INSTALL/bin` or `~/.bun/bin` is off PATH; the same
 * tree then passes or fails its lanes depending on the shell. The launch dir
 * is the first of those two holding a Bun that satisfies gstack's own
 * `engines.bun` and the project's `engines.bun`; when there is one, the
 * lanes runner and every guard run with it first on PATH.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { satisfies } from '../runtime-pins';

const GSTACK_PACKAGE = path.resolve(import.meta.dir, '..', '..', 'package.json');

function enginesBun(file: string): string | null {
  try { const v = JSON.parse(fs.readFileSync(file, 'utf8'))?.engines?.bun; return typeof v === 'string' && v.trim() ? v.trim() : null; } catch { return null; }
}

export interface LaunchRuntime { dir: string | null; version: string | null; env: NodeJS.ProcessEnv; label: string }

/** The launch dir and the env with it first on PATH; the env is unchanged when no candidate qualifies. */
export function launchRuntime(repoRoot: string, env: NodeJS.ProcessEnv): LaunchRuntime {
  const pins = [enginesBun(GSTACK_PACKAGE), enginesBun(path.join(repoRoot, 'package.json'))].filter((p): p is string => !!p);
  const candidates = [env.BUN_INSTALL ? path.join(env.BUN_INSTALL, 'bin') : null, env.HOME ? path.join(env.HOME, '.bun', 'bin') : null].filter((d): d is string => !!d);
  for (const dir of [...new Set(candidates)]) {
    const bun = path.join(dir, 'bun');
    try { fs.accessSync(bun, fs.constants.X_OK); } catch { continue; }
    const r = spawnSync(bun, ['--version'], { encoding: 'utf8', timeout: 15_000, env });
    const version = r.status === 0 ? (r.stdout ?? '').trim() : '';
    if (!version || pins.some(pin => satisfies(version, pin) !== true)) continue;
    return { dir, version, env: { ...env, PATH: [dir, env.PATH ?? ''].filter(Boolean).join(path.delimiter) }, label: `bun ${version} from ${dir}` };
  }
  return { dir: null, version: null, env, label: 'PATH (no verified Bun in $BUN_INSTALL/bin or ~/.bun/bin)' };
}
