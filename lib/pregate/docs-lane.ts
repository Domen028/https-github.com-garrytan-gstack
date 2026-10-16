/**
 * pregate docs/no-tests — Markdown no test depends on is an empty lane.
 *
 * A repo with no `.gstack/pregate.json` used to fail `lanes` on a tracked
 * `.work` plan, a redproof note, or any other Markdown file (`PREGATE_NO_LANE`).
 * Those files document a change; they are not test subjects. `isDocsEmptyLane`
 * is that class. `lane-selection` consults it only when the import graph
 * mapped nothing (`testsFor`: imports, repo-path literals including `join()`,
 * the bin convention, declarations), so a test that reads the file — a
 * fixture or a doc — still runs. Source code and anything under a test
 * directory never qualify, including when `empty_lanes` globs match them.
 * Unmapped code stays `PREGATE_NO_LANE`.
 */
import { SOURCE_EXT } from './import-graph';
import { matchesAny } from '../ship-policy';

const TEST_TREE = /(?:^|\/)(?:test|tests|spec|__tests__)(?:\/|$)/i;
const MARKDOWN = /\.(?:md|markdown)$/i;
/** Prose names, with or without `.md` (LICENSE has no extension). */
const PROSE_NAME = /^(?:README|CHANGELOG|CONTRIBUTING|AGENTS|CLAUDE|ETHOS|LICENSE|LICENCE|COPYING|NOTICE)(?:\.md)?$/i;

function isMarkdown(rel: string): boolean {
  return MARKDOWN.test(rel);
}

function isTestTree(rel: string): boolean {
  return TEST_TREE.test(rel);
}

/** Code the empty-lane class must not swallow. Extensionless `bin/` entrypoints count; `bin/README.md` does not. */
function isSourceCode(rel: string): boolean {
  if (SOURCE_EXT.test(rel)) return true;
  const base = rel.split('/').pop() ?? rel;
  if (rel.startsWith('bin/') && !isMarkdown(rel) && !PROSE_NAME.test(base)) return true;
  return false;
}

function isBuiltinDocsPath(rel: string): boolean {
  const base = rel.split('/').pop() ?? rel;
  if (PROSE_NAME.test(base)) return true;
  // Any Markdown file. Name and directory do not matter: `planet.md` and
  // `prompts/system.md` qualify the same way a `.work` plan does. A test
  // that reads the file is handled by the caller, before this check.
  return isMarkdown(rel);
}

/**
 * True when `rel` is documentation that needs no test lane.
 * `extraGlobs` are the repo's `empty_lanes` (`.gstack/pregate.json` on the
 * base branch). They add paths; they cannot classify source code or a file
 * under a test directory. Callers apply this only after the import graph
 * found no test.
 */
export function isDocsEmptyLane(rel: string, extraGlobs: readonly string[] = []): boolean {
  const norm = rel.replace(/\\/g, '/').replace(/^\.\//, '');
  if (!norm || isTestTree(norm) || isSourceCode(norm)) return false;
  if (extraGlobs.length > 0 && matchesAny(extraGlobs, norm)) return true;
  return isBuiltinDocsPath(norm);
}
