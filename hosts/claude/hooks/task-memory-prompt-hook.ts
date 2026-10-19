#!/usr/bin/env bun
/**
 * task-memory-prompt-hook: on UserPromptSubmit, add past task procedures of
 * this repository from HydraDB task memory as untrusted reference context.
 * Logic lives in lib/task-memory/loop.ts (recallForPrompt).
 *
 * ALWAYS exits 0 with one hookSpecificOutput JSON or nothing. A missing
 * grant, key or network, a timeout or an API error costs the prompt nothing;
 * failures go to hook-errors.log, rate-limited.
 */
import { parsePromptInput, readHookStdin, recallForPrompt } from '../../../lib/task-memory/loop';
import { logHookError } from './hook-log';

const HOOK = 'task-memory-prompt-hook';
/** Under the registered 8 s hook timeout, whatever the retrieval mode. */
const HARD_EXIT_MS = 6_000;

const QUIET = /^(no-grant|trivial-or-sensitive-prompt|no-recall-grant|not-a-repo|no-origin|local-origin|no-relevant-procedure)$/;

async function main(): Promise<void> {
  const startedAt = Date.now();
  const input = parsePromptInput(await readHookStdin(500));
  if (!input) return;
  const report = await recallForPrompt(input, startedAt);
  if (report.kind === 'context') {
    const out = JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: report.markdown } });
    await new Promise<void>(resolve => process.stdout.write(out, () => resolve()));
  } else if (!QUIET.test(report.reason)) {
    logHookError(HOOK, `recall skipped: ${report.reason}`, { rateLimit: { nowMs: Date.now(), key: report.reason } });
  }
}

if (import.meta.main) {
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.on(sig, () => process.exit(0));
  setTimeout(() => process.exit(0), HARD_EXIT_MS).unref();
  main()
    .catch(err => logHookError(HOOK, `unexpected: ${err instanceof Error ? err.message : String(err)}`))
    .finally(() => process.exit(0));
}
