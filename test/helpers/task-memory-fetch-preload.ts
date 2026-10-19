const target = process.env.GSTACK_TASK_MEMORY_TEST_ORIGIN;
if (target) {
  const real = globalThis.fetch;
  const routed = (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    return real(url.origin === 'https://api.hydradb.com' ? `${target}${url.pathname}${url.search}` : input, init);
  };
  globalThis.fetch = Object.assign(routed, real);
}
