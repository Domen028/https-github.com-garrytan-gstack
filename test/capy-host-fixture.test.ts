/**
 * The shared simulated Capy host (test/helpers/capy-host.ts) has the field
 * shape: the PATH Bun reports 1.3.14, no codex resolves, the verified Bun in
 * $HOME/.bun/bin is off PATH, and the launch PATH puts it first.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import { capyHost, type CapyHost } from './helpers/capy-host';

const hosts: CapyHost[] = [];
afterEach(() => { for (const h of hosts.splice(0)) h.cleanup(); });
const sh = (h: CapyHost, cmd: string, pathOverride?: string) =>
  spawnSync('bash', ['-c', cmd], { cwd: h.home, encoding: 'utf8', env: { ...h.env, ...(pathOverride ? { PATH: pathOverride } : {}) } });

describe('simulated Capy host', () => {
  test('PATH Bun is 1.3.14, codex is absent, the verified Bun is only on the launch PATH', () => {
    const h = capyHost({ verifiedBun: '1.4.2' }); hosts.push(h);
    expect(sh(h, 'bun --version').stdout.trim()).toBe('1.3.14');
    expect(sh(h, 'command -v codex || echo none').stdout.trim()).toBe('none');
    expect(sh(h, 'command -v bun').stdout.trim()).toBe(`${h.systemBin}/bun`);
    expect(sh(h, 'bun --version', h.launchPath).stdout.trim()).toBe('1.4.2');
    expect(sh(h, 'bun -e "console.log(1+1)"').stdout.trim()).toBe('2');
  });
});
