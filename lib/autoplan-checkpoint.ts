/**
 * autoplan-checkpoint — an opt-in durable copy of a run directory (next-wave
 * B12). With GSTACK_AUTOPLAN_CHECKPOINT_DIR set, every mutating command that
 * leaves the run at rest (gate_pending, amend_pending, complete, incomplete)
 * publishes `<dir>/<run>/`: `checkpoint.json` (every file's sha256), the run
 * files under `run/`, the owner's plan file under `plan-input/` when it lives
 * outside the run, and `restore.md`, the human index. Publication swaps a
 * fully written sibling in, so a reader sees the old copy or the new one.
 * `restoreCheckpoint` verifies containment and every hash before it publishes
 * the run directory with one rename; the caller then resumes and owns it.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { sha256File } from './headless-artifacts';
import { FILES, RunError, journal, now, readState, type RunState } from './autoplan-state';

const MANIFEST = 'checkpoint.json';
const AT_REST = ['gate_pending', 'amend_pending', 'complete', 'incomplete'];
interface CheckpointManifest {
  schema_version: 1; run: string; status: string; gate_rev: number; revision: number; at: string; host: string; gstack_version?: string;
  files: Record<string, string>;
  plan_input?: { original: string; file: string; sha256: string };
}

function runFiles(dir: string, rel = ''): string[] {
  return fs.readdirSync(path.join(dir, rel), { withFileTypes: true }).flatMap(e => {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) return /^\.revise-v\d+$/.test(e.name) ? [] : runFiles(dir, r);
    return e.isFile() && r !== FILES.lock && !r.endsWith('.tmp') ? [r] : [];
  });
}

const copy = (from: string, to: string) => { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(from, to); };
const inside = (root: string, p: string) => !path.relative(root, p).startsWith('..') && !path.isAbsolute(path.relative(root, p));

function restoreIndex(m: CheckpointManifest, target: string): string {
  return [`# autoplan checkpoint: ${m.run}`, '',
    `Written ${m.at} on ${m.host} at status=${m.status}, gate_rev=${m.gate_rev}; ${Object.keys(m.files).length} files, each listed with its sha256 in checkpoint.json.`, '',
    'Restore on any machine (the target directory must not hold a run):', '',
    `    gstack-autoplan resume --out <new run dir> --from ${target}`, '',
    'resume verifies every hash, publishes the run directory, takes ownership and prints the next step.',
    ...(m.plan_input ? ['', `The owner's plan file was ${m.plan_input.original}; a copy is in ${m.plan_input.file} and is restored into the run directory when the original is missing.`] : []), ''].join('\n');
}

/** Publish the checkpoint when the env opts in and the run is at rest; returns the CHECKPOINT line, or nothing. */
export function checkpointRun(out: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const root = env.GSTACK_AUTOPLAN_CHECKPOINT_DIR;
  if (!root || !fs.existsSync(path.join(out, FILES.run))) return undefined;
  const state = readState(out);
  if (!AT_REST.includes(state.status)) return undefined;
  const target = path.join(path.resolve(root), state.run);
  const tmp = `${target}.${process.pid}.tmp`;
  fs.rmSync(tmp, { recursive: true, force: true });
  const files: Record<string, string> = {};
  for (const rel of runFiles(state.out)) { copy(path.join(state.out, rel), path.join(tmp, 'run', rel)); files[rel] = sha256File(path.join(tmp, 'run', rel)); }
  const input = state.plan_input && !inside(state.out, state.plan_input) && fs.existsSync(state.plan_input) ? state.plan_input : undefined;
  const planFile = input ? `plan-input/${path.basename(input)}` : undefined;
  if (input) copy(input, path.join(tmp, planFile!));
  const m: CheckpointManifest = { schema_version: 1, run: state.run, status: state.status, gate_rev: state.gate_rev ?? 0, revision: state.revision, at: now(), host: os.hostname(),
    ...(state.gstack_version ? { gstack_version: state.gstack_version } : {}), files, ...(input ? { plan_input: { original: input, file: planFile!, sha256: sha256File(path.join(tmp, planFile!)) } } : {}) };
  fs.writeFileSync(path.join(tmp, 'restore.md'), restoreIndex(m, target));
  fs.writeFileSync(path.join(tmp, MANIFEST), JSON.stringify(m, null, 2) + '\n');
  const old = `${target}.${process.pid}.old`;
  if (fs.existsSync(target)) fs.renameSync(target, old);
  fs.renameSync(tmp, target);
  fs.rmSync(old, { recursive: true, force: true });
  return `CHECKPOINT: ${target} status=${m.status} gate_rev=${m.gate_rev} files=${Object.keys(files).length}`;
}

/** Verify a checkpoint and publish it as the run directory `out`. Nothing is written to `out` unless every hash matches. */
export function restoreCheckpoint(from: string, out: string): string[] {
  const src = path.resolve(from);
  const bad = (detail: string): never => { throw new RunError('CHECKPOINT_INVALID', `${src}: ${detail}`, 3); };
  let m: CheckpointManifest;
  try { m = JSON.parse(fs.readFileSync(path.join(src, MANIFEST), 'utf8')); } catch (e) { return bad(`no readable ${MANIFEST} (${(e as Error).message})`); }
  if (m.schema_version !== 1 || typeof m.run !== 'string' || !m.files || typeof m.files !== 'object' || !m.files[FILES.run]) bad(`${MANIFEST} is not a schema_version 1 checkpoint with run.json listed`);
  const target = path.resolve(out);
  if (fs.existsSync(target) && fs.readdirSync(target).length) throw new RunError('CHECKPOINT_TARGET_EXISTS', `${target} is not empty`, 3);
  const verify = (rel: string, sha: string, base: string) => {
    const file = path.resolve(base, rel);
    if (path.isAbsolute(rel) || rel.split(/[\\/]/).includes('..') || !inside(base, file)) bad(`${rel} escapes the checkpoint`);
    let st: fs.Stats;
    try { st = fs.lstatSync(file); } catch { return bad(`${rel} is listed but missing`); }
    if (!st.isFile()) bad(`${rel} is not a regular file`);
    if (sha256File(file) !== sha) bad(`${rel} does not match its sha256 in ${MANIFEST}`);
    return file;
  };
  const staging = `${target}.restore-${process.pid}`;
  fs.rmSync(staging, { recursive: true, force: true });
  try {
    for (const [rel, sha] of Object.entries(m.files)) copy(verify(rel, sha, path.join(src, 'run')), path.join(staging, rel));
    for (const [rel, sha] of Object.entries(m.files)) verify(rel, sha, staging);
    const lines: string[] = [];
    if (m.plan_input) {
      const copyOf = verify(m.plan_input.file, m.plan_input.sha256, src);
      if (!fs.existsSync(m.plan_input.original)) {
        const restored = path.join(staging, m.plan_input.file);
        copy(copyOf, restored);
        const state = JSON.parse(fs.readFileSync(path.join(staging, FILES.run), 'utf8')) as RunState;
        state.plan_input = path.join(target, m.plan_input.file);
        fs.writeFileSync(path.join(staging, FILES.run), JSON.stringify(state, null, 2) + '\n');
        lines.push(`PLAN_INPUT: ${m.plan_input.original} is missing; restored the checkpoint copy to ${state.plan_input}`);
      } else if (sha256File(m.plan_input.original) !== m.plan_input.sha256) lines.push(`PLAN_INPUT: ${m.plan_input.original} differs from the checkpoint copy; kept the file on disk`);
    }
    if (fs.existsSync(target)) fs.rmdirSync(target);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.renameSync(staging, target);
    const state = readState(target);
    journal(target, { event: 'restored', from: src, checkpoint_at: m.at, checkpoint_host: m.host, host: os.hostname(), files: Object.keys(m.files).length });
    return [`RESTORED: run=${state.run} from=${src} status=${m.status} gate_rev=${m.gate_rev} files=${Object.keys(m.files).length} (written ${m.at} on ${m.host})`, ...lines];
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}
