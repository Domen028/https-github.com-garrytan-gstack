/**
 * Test-only transport for HydraDB task memory. Loaded into the CLI and hook
 * processes a test spawns (BUN_OPTIONS=--preload), it routes requests for
 * the hosted origin to the loopback fake named by
 * GSTACK_TASK_MEMORY_TEST_ORIGIN. The product itself has no endpoint
 * override; only a test's own child processes get this file.
 */
const target = process.env.GSTACK_TASK_MEMORY_TEST_ORIGIN;
if (target) {
  const real = globalThis.fetch;
  const routed = (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    return real(url.origin === 'https://api.hydradb.com' ? `${target}${url.pathname}${url.search}` : input, init);
  };
  globalThis.fetch = Object.assign(routed, real);
}
