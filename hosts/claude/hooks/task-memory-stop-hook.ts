#!/usr/bin/env bun
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CAPTURE_DEADLINE_MS, captureSession, parseStopInput, readHookStdin } from '../../../lib/task-memory/loop';
import { listGrants } from '../../../lib/task-memory/state';
import { logHookError } from './hook-log';

const HOOK = 'task-memory-stop-hook';
const QUIET = /^(no-capture-grant|not-a-repo|no-origin|local-origin)$/;

async function worker(arg: string): Promise<void> {
  let input: ReturnType<typeof parseStopInput> = null;
  try { input = parseStopInput(JSON.parse(arg)); } catch {}
  if (!input) return;
  const report = await captureSession(input, Date.now() + CAPTURE_DEADLINE_MS);
  if (report.kind === 'skipped') {
    if (!QUIET.test(report.reason)) logHookError(HOOK, `capture skipped: ${report.reason}`, { rateLimit: { nowMs: Date.now(), key: report.reason } });
  } else if (report.kind === 'done' && report.outstanding > 0) {
    logHookError(HOOK, `${report.outstanding} procedure change(s) not delivered yet; retried on a later Stop in this repository or by gstack-task-memory flush`,
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
