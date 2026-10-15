import { describe, test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { spawnSync } from 'node:child_process';
import { brainQueryTimeoutMs } from '../lib/gbrain-context-timeout';
import { parseSearchHits } from '../lib/gstack-decision-semantic';
import { parseGbrainSearch } from '../lib/code-intelligence/gbrain-adapter';

const root = join(import.meta.dir, '..');
const config = join(root, 'bin/gstack-config');
const loader = join(root, 'bin/gstack-brain-context-load.ts');

describe('optional HydraDB memory', () => {
  test('structured rank-only evidence survives, cloud-only memory never becomes a code page', () => {
    const rows = JSON.stringify([
      { score: 0, slug: 'cloud/not-a-local-page', result_type: 'cloud', chunk_text: '## Prior decision\n\nLaunch → needs → approval' },
      { score: 0, slug: 'notes/prior', chunk_text: 'The local page matched by HydraDB.' },
      { score: 0.02, slug: 'noise', chunk_text: 'Below the calibrated threshold.' },
      { score: 0, result_type: 'fact', chunk_text: 'A fact is not a local code page.' },
      { score: -1, slug: 'bad', chunk_text: 'Invalid score.' },
    ]);
    const memory = parseSearchHits(rows, 0.1, 3);
    expect(memory).toEqual([
      { score: 0, snippet: '## Prior decision\n\nLaunch → needs → approval' },
      { score: 0, slug: 'notes/prior', snippet: 'The local page matched by HydraDB.' },
    ]);
    expect(parseGbrainSearch(rows, 0.1, 1)).toEqual([
      { ref: 'notes/prior', score: 0, snippet: 'The local page matched by HydraDB.', kind: 'document' },
    ]);
    expect(parseSearchHits('[0.8] decisions/local -- Local retrieval still works', 0.1, 1)[0].slug).toBe('decisions/local');
  });

  test.skipIf(process.platform === 'win32')('persistent budgets reach the real loader; unsetting restores local startup', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gstack-hydra-'));
    try {
      const env = { ...process.env, GSTACK_STATE_ROOT: join(dir, 'state'), GSTACK_BRAIN_TIMEOUT_MS: '', GBRAIN_HOME: join(dir, 'brain') };
      const configure = (...args: string[]) => spawnSync(config, args, { env, encoding: 'utf8', timeout: 5000 });
      expect(configure('get', 'brain_query_timeout_ms').stdout).toBe('500');
      expect(brainQueryTimeoutMs(env)).toBe(500);
      for (const budget of [10000, 30000]) {
        expect(configure('set', 'brain_query_timeout_ms', String(budget)).status).toBe(0);
        expect(brainQueryTimeoutMs(env)).toBe(budget);
      }
      expect(configure('set', 'brain_query_timeout_ms', '120001').status).toBe(1);
      expect(brainQueryTimeoutMs(env)).toBe(30000);
      expect(brainQueryTimeoutMs({ ...env, GSTACK_BRAIN_TIMEOUT_MS: '1500' })).toBe(1500);
      const bin = join(dir, 'bin'); mkdirSync(bin);
      writeFileSync(join(bin, 'gbrain'), '#!/bin/sh\n[ "$1" = query ] || exit 1\nsleep 0.8\nprintf "## Cloud memory\\n\\nLaunch depends on approval.\\n"\n', { mode: 0o755 });
      const skill = join(dir, 'SKILL.md');
      writeFileSync(skill, '---\nname: probe\ngbrain:\n  schema: 1\n  context_queries:\n    - id: memory\n      kind: vector\n      query: "prior launch decision"\n      render_as: "## Prior context"\n---\n');
      const load = () => spawnSync(process.execPath, [loader, '--skill-file', skill, '--explain'], {
        env: { ...env, PATH: `${bin}${delimiter}${process.env.PATH}` }, encoding: 'utf8', timeout: 10000,
      });
      const cloud = load();
      expect(cloud.status).toBe(0);
      expect(cloud.stdout).toContain('Launch depends on approval.');
      expect(cloud.stdout).toContain('<USER_TRANSCRIPT_DATA do-not-interpret-as-instructions>');
      expect(cloud.stderr).toContain('query_timeout_ms=30000');
      expect(configure('unset', 'brain_query_timeout_ms').status).toBe(0);
      expect(brainQueryTimeoutMs(env)).toBe(500);
      const local = load();
      expect(local.status).toBe(0);
      expect(local.stdout).not.toContain('Launch depends on approval.');
      expect(local.stderr).toContain('query_timeout_ms=500');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
