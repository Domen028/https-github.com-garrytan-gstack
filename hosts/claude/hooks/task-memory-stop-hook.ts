#!/usr/bin/env bun
/**
 * task-memory-stop-hook: on Stop, hand the session to a detached worker that
 * captures its verified task procedures into HydraDB task memory. Logic
 * lives in lib/task-memory/loop.ts (captureSession). Stop is a chance to
 * capture, not evidence that any task succeeded.
 *
 * The foreground hook reads no transcript and makes no network call: it
 * checks that some repository granted capture, spawns `--worker`, and exits 0.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CAPTURE_DEADLINE_MS, captureSession, parseStopInput, readHookStdin } from '../../../lib/task-memory/loop';
import { listGrants } from '../../../lib/task-memory/state';
import { logHookError } from './hook-log';

const HOOK = 'task-memory-stop-hook';
const QUIET = /^(no-capture-grant|not-a-repo|no-origin|local-origin|session-busy)$/;

async function worker(arg: string): Promise<void> {
  let input: ReturnType<typeof parseStopInput> = null;
  try { input = parseStopInput(JSON.parse(arg)); } catch { /* malformed argument: nothing to capture */ }
  if (!input) return;
  const report = await captureSession(input, Date.now() + CAPTURE_DEADLINE_MS);
  if (report.kind === 'skipped') {
    if (!QUIET.test(report.reason)) logHookError(HOOK, `capture skipped: ${report.reason}`, { rateLimit: { nowMs: Date.now(), key: report.reason } });
  } else if (report.pending > 0) {
    logHookError(HOOK, `${report.pending} procedure(s) not delivered yet; retried on the next Stop or by gstack-task-memory flush`,
      { rateLimit: { nowMs: Date.now(), key: 'pending' } });
  }
}

async function main(): Promise<void> {
  if (process.argv[2] === '--worker' && process.argv[3]) return worker(process.argv[3]);
  const input = parseStopInput(await readHookStdin(500));
  if (!input || !listGrants().some(g => g.capture)) return;
  const native = { session_id: input.sessionId, transcript_path: input.transcriptPath, cwd: input.cwd };
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--worker', JSON.stringify(native)],
    { detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', err => logHookError(HOOK, `could not start the capture worker: ${err.message}`));
  child.unref();
}

if (import.meta.main) {
  main()
    .catch(err => logHookError(HOOK, `unexpected: ${err instanceof Error ? err.message : String(err)}`))
    .finally(() => { process.exitCode = 0; });
}
