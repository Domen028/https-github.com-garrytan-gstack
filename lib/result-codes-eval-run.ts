/**
 * Result codes for the subscription eval driver (`gstack-eval-plan cli-run`,
 * lib/eval-cli-run.ts): the quota stop and the batch-helper gate. Kept beside
 * lib/result-codes.ts (which spreads this table into RESULT_CODES) so the owner
 * module stays within the module-size ratchet; the same rules apply: one
 * stable docs/troubleshooting.md anchor, a summary and a fix clause each.
 */
import type { ResultCode } from './result-codes';

export const EVAL_RUN_RESULT_CODES = {
  EVAL_QUOTA_STOP: {
    anchor: 'eval-quota-stop',
    summary: 'a `claude -p` call hit the subscription quota or a rate limit (or the batch helper’s circuit is open), so cli-run started nothing more and cancelled the unstarted jobs',
    fix: 'wait for the reset, then rerun the same command (it resumes); never switch seats, never set an API key, never split the run to slip past',
  },
  EVAL_BATCH_HELPER_MISSING: {
    anchor: 'eval-batch-helper-missing',
    summary: 'a full cli-run (or one inside a batch marker) needs the seat-pinning batch helper, and it is not installed or not on PATH',
    fix: 'install the helper or point GSTACK_CLAUDE_BATCH at it; for a short check use `--scope smoke` (at most 10 jobs); never hand-roll a loop instead',
  },
  EVAL_BATCH_PREFLIGHT_FAILED: {
    anchor: 'eval-batch-preflight-failed',
    summary: 'the batch helper’s preflight refused (or its `run` never set the batch marker), so no claude call was made',
    fix: 'read the helper’s stderr tail on the line; fix the batch (stopped circuit, wrong seat, PATH claude not the enforcing wrapper) and rerun',
  },
} as const satisfies Record<string, ResultCode>;
