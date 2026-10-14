/**
 * Lane mapping for paths a framework puts punctuation in, and for imports
 * written through a tsconfig `paths` alias. Both were `no lane` false
 * negatives in a Next.js App Router repo whose tests did name the files:
 *   - `app/(app)/recipes/page.tsx` named in a string (readFileSync) — the
 *     QUOTED literal pattern stopped at `(`, so the literal never matched;
 *   - `app/(app)/recipes/[id]/page.tsx` imported as `@/app/(app)/recipes/[id]/page`
 *     — `@/…` was resolved as a repo path, so it never matched a file.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { buildGraph, testsFor } from '../lib/pregate/import-graph';
import { cleanup, commit, makeFixtureRepo, type FixtureRepo } from './helpers/pregate-fixture';

const repos: FixtureRepo[] = [];
const fixture = () => { const r = makeFixtureRepo(); repos.push(r); return r; };
afterEach(() => { while (repos.length) cleanup(repos.pop()!); });

describe('import graph: route-group / dynamic-segment paths and tsconfig path aliases', () => {
  test('a repo-path literal containing ( ) [ ] maps to the file it names', () => {
    const repo = fixture();
    commit(repo, {
      'app/(app)/recipes/page.tsx': 'export default function P() { return null }\n',
      'app/(app)/recipes/[id]/page.tsx': 'export default function D() { return null }\n',
      'app/[[...slug]]/page.tsx': 'export default function C() { return null }\n',
      'test/pages.test.ts': "import { readFileSync } from 'node:fs';\nfor (const f of ['app/(app)/recipes/page.tsx', 'app/(app)/recipes/[id]/page.tsx', 'app/[[...slug]]/page.tsx']) readFileSync(f, 'utf8');\n",
    });
    const g = buildGraph(repo.work);
    expect(testsFor(g, 'app/(app)/recipes/page.tsx').tests).toEqual(['test/pages.test.ts']);
    expect(testsFor(g, 'app/(app)/recipes/[id]/page.tsx').tests).toEqual(['test/pages.test.ts']);
    expect(testsFor(g, 'app/[[...slug]]/page.tsx').tests).toEqual(['test/pages.test.ts']);
  });

  test('a relative import of a bracketed path already maps (control: the import scanner is not the bug)', () => {
    const repo = fixture();
    commit(repo, {
      'app/(app)/recipes/[id]/page.tsx': 'export default function D() { return null }\n',
      'test/detail.test.tsx': "import D from '../app/(app)/recipes/[id]/page';\nD();\n",
    });
    expect(testsFor(buildGraph(repo.work), 'app/(app)/recipes/[id]/page.tsx').tests).toEqual(['test/detail.test.tsx']);
  });

  test('an import through a tsconfig paths alias (JSONC, with comments and a trailing comma) maps; so does a vi.mock of it', () => {
    const repo = fixture();
    commit(repo, {
      'tsconfig.json': '{\n  // Next.js default\n  "compilerOptions": {\n    "baseUrl": ".",\n    "paths": { "@/*": ["./*"], "~lib/*": ["lib/*"], },\n  },\n}\n',
      'app/(app)/recipes/[id]/page.tsx': 'export default function D() { return null }\n',
      'lib/plan.ts': 'export const plan = 1;\n',
      'lib/mocked.ts': 'export const m = 1;\n',
      'test/detail.test.tsx': "import D from '@/app/(app)/recipes/[id]/page';\nimport { plan } from '~lib/plan';\nvi.mock('@/lib/mocked', () => ({}));\nD(); plan;\n",
    });
    const g = buildGraph(repo.work);
    expect(testsFor(g, 'app/(app)/recipes/[id]/page.tsx').tests).toEqual(['test/detail.test.tsx']);
    expect(testsFor(g, 'lib/plan.ts').tests).toEqual(['test/detail.test.tsx']);
    expect(testsFor(g, 'lib/mocked.ts').tests).toEqual(['test/detail.test.tsx']);
  });

  test('without a tsconfig an @scope/pkg import still resolves to nothing (no new false edges)', () => {
    const repo = fixture();
    commit(repo, {
      'lib/plan.ts': 'export const plan = 1;\n',
      'test/scoped.test.ts': "import { x } from '@scope/plan';\nx;\n",
    });
    expect(testsFor(buildGraph(repo.work), 'lib/plan.ts').tests).toEqual([]);
  });
});
