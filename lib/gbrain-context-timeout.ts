import { readConfigKey } from './state-root';

/** Only semantic context queries need a cloud-sized budget. Local/list calls keep 500ms. */
export function brainQueryTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.GSTACK_BRAIN_TIMEOUT_MS || readConfigKey('brain_query_timeout_ms', env);
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 && value <= 120_000 ? value : 500;
}
