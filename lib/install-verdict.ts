/**
 * install-verdict — the TypeScript twin of bin/gstack-install-verdict.sh: the
 * one reader of the install verdict gstack-capy-install writes, and the
 * install-admission rule gstack-skill-start (Bash) and gstack-autoplan's
 * mutating verbs share. test/install-verdict.test.ts pins both sides.
 *
 * Verdict file: <state root>/install-verdicts/<sha256(source checkout realpath)>.json,
 * or the path the GSTACK_LAUNCH line names as GSTACK_INSTALL_VERDICT.
 *
 * Admission: applies to unattended and spawned sessions. It refuses (exit 3,
 * `status=refused`) in unattended sessions and explicit
 * GSTACK_SESSION_KIND=spawned sessions with GSTACK_CAPY=1 when the running Bun
 * is below gstack's supported minimum and, with GSTACK_CAPY=1 only, when the
 * verdict is missing, failing, for another checkout or HEAD, or narrower than
 * the workflow. Other spawned sessions only warn.
 * GSTACK_ALLOW_UNSUPPORTED_RUNTIME=1 admits and sets `overridden` (the caller
 * records it as a run deviation).
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PINS_ADVISORY_SKILLS, SKILL_REQUIREMENTS } from './doctor-components';
import type { ResultCodeName } from './result-codes';
import { resolveStateRoot } from './state-root';

export interface InstallVerdict {
  schema_version: 1;
  checkout: string;
  head: string;
  for: string;
  required: string[];
  pins_planning_only: boolean;
  ok: boolean;
  trailer: string;
  min_revision: string;
  launch_path: string;
  time: string;
}

export interface InstallAdmission {
  /** The session kind is one admission covers (unattended or spawned). */
  applies: boolean;
  /** Stop: print `line`, then `GSTACK_RESULT: skill=<s> status=refused run=<dir>`, exit 3. */
  refuse: boolean;
  /** Ambient spawned session: print `line` and continue. */
  warn: boolean;
  /** GSTACK_ALLOW_UNSUPPORTED_RUNTIME=1 admitted a failing check; record `detail` as a deviation. */
  overridden: boolean;
  status: 'ok' | 'runtime' | 'verdict';
  detail: string;
  code?: ResultCodeName;
  /** The `INSTALL: fail|warn …` or `INSTALL_VERDICT: …` line; empty when nothing to say. */
  line: string;
}

type Env = Record<string, string | undefined>;

/** The source checkout behind an install root: its recorded .source-path, else the root itself (realpath). */
export function sourceRoot(gstackRoot: string): string {
  const recorded = path.join(gstackRoot, '.source-path');
  let src = gstackRoot;
  if (fs.existsSync(recorded)) {
    const line = fs.readFileSync(recorded, 'utf8').split('\n')[0].trim();
    if (line && fs.existsSync(line)) src = line;
  }
  return fs.realpathSync(src);
}

export function installVerdictPath(checkout: string, stateRoot: string): string {
  return path.join(stateRoot, 'install-verdicts', `${createHash('sha256').update(checkout).digest('hex')}.json`);
}

export function readInstallVerdict(file: string): InstallVerdict | null {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8'));
    return v && v.schema_version === 1 ? v as InstallVerdict : null;
  } catch {
    return null;
  }
}

const below = (a: string, b: string) => {
  const x = a.split(/[.+-]/).map(Number), y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) < (y[i] || 0);
  return /-/.test(a);
};

function supportedBun(gstackRoot: string): string {
  const text = fs.readFileSync(path.join(gstackRoot, 'bin/gstack-bun-version.sh'), 'utf8');
  return text.match(/^GSTACK_BUN_TESTED="([0-9.]+)"/m)?.[1] ?? '0.0.0';
}

function verdictProblem(skill: string, gstackRoot: string, env: Env): string {
  const src = sourceRoot(gstackRoot);
  const file = env.GSTACK_INSTALL_VERDICT || installVerdictPath(src, resolveStateRoot(env));
  const v = readInstallVerdict(file);
  if (!v) return `no install verdict at ${file} for ${src}`;
  if (!v.ok) return `the install verdict says: ${v.trailer}`;
  if (v.checkout !== src) return `the install verdict is for checkout ${v.checkout}, not ${src}`;
  const head = spawnSync('git', ['-C', src, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout?.trim() ?? '';
  if (!head || v.head !== head) return `the install verdict is for another HEAD (${v.head.slice(0, 12)}; ${src} is at ${head.slice(0, 12)})`;
  if (v.pins_planning_only && !PINS_ADVISORY_SKILLS.includes(skill)) return `the install verdict is planning-only (pins skipped for ${v.for}) and ${skill} runs the repo's tests`;
  const missing = (SKILL_REQUIREMENTS[skill]?.requires ?? []).find(id => !v.required.includes(id));
  return missing ? `the install verdict certified for=${v.for}, which does not cover ${missing} that ${skill} needs` : '';
}

/**
 * The admission decision for `skill` run from the gstack install at
 * `gstackRoot` (the directory holding bin/). `bunVersion` defaults to the Bun
 * running this process; `env` to process.env.
 */
export function checkInstallAdmission(opts: { skill: string; gstackRoot: string; env?: Env; bunVersion?: string }): InstallAdmission {
  const env = opts.env ?? process.env;
  const kind = env.GSTACK_SESSION_KIND === 'unattended' || env.GSTACK_SESSION_KIND === 'spawned' ? env.GSTACK_SESSION_KIND
    : env.OPENCLAW_SESSION ? 'spawned' : 'other';
  const none: InstallAdmission = { applies: false, refuse: false, warn: false, overridden: false, status: 'ok', detail: '', line: '' };
  if (kind === 'other') return none;
  const capy = env.GSTACK_CAPY === '1';
  const hard = kind === 'unattended' || (env.GSTACK_SESSION_KIND === 'spawned' && capy);
  const minimum = supportedBun(opts.gstackRoot);
  const bun = opts.bunVersion ?? process.versions.bun ?? '0.0.0';
  let status: InstallAdmission['status'] = 'ok', detail = '', fix = '', code: ResultCodeName | undefined;
  if (below(bun, minimum)) {
    status = 'runtime'; code = 'RUNTIME_BELOW_MINIMUM';
    detail = `bun ${bun} is below the supported minimum ${minimum}`;
    fix = `run the Capy skill installer (scripts/install.sh --for ${opts.skill}), then launch with its GSTACK_LAUNCH line`;
  } else if (capy) {
    detail = verdictProblem(opts.skill, opts.gstackRoot, env);
    if (detail) {
      status = 'verdict'; code = 'INSTALL_UNVERIFIED';
      fix = `run the Capy skill installer (scripts/install.sh --for ${opts.skill}) on this machine, then launch with the GSTACK_LAUNCH line it prints`;
    }
  }
  const base = { ...none, applies: true, status, detail, code };
  if (status === 'ok') return base;
  if (env.GSTACK_ALLOW_UNSUPPORTED_RUNTIME === '1') return { ...base, overridden: true, line: `INSTALL_VERDICT: overridden (GSTACK_ALLOW_UNSUPPORTED_RUNTIME=1): ${detail}` };
  const line = `INSTALL: ${hard ? 'fail' : 'warn'} ${status} — ${detail}; fix: ${fix} (${code})`;
  return { ...base, refuse: hard, warn: !hard, line };
}
