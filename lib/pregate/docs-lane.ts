/**
 * pregate docs/no-tests — planning and evidence Markdown is an empty lane.
 *
 * A repo with no `.gstack/pregate.json` used to fail `lanes` on a tracked
 * `.work` plan or a redproof note (`PREGATE_NO_LANE`). Those files document
 * a change; they are not test subjects. `isDocsEmptyLane` is that class.
 * `lane-selection` consults it only when nothing else maps the file, so a
 * test that names the file still runs. Source code and anything under a
 * test directory never qualify, including when `empty_lanes` globs match
 * them. Unmapped code stays `PREGATE_NO_LANE`.
 */
import { SOURCE_EXT } from './import-graph';
import { matchesAny } from '../ship-policy';

const TEST_TREE = /(?:^|\/)(?:test|tests|spec|__tests__)(?:\/|$)/i;
const MARKDOWN = /\.(?:md|markdown)$/i;
/** Root-level prose names, with or without `.md`. */
const PROSE_NAME = /^(?:README|CHANGELOG|CONTRIBUTING|AGENTS|CLAUDE|ETHOS|LICENSE|LICENCE|COPYING|NOTICE)(?:\.md)?$/i;
/** A documentation tree. `doc` does not match `docstring`; `.work` is the plan workspace. */
const DOC_DIR = /(?:^|\/)(?:\.work|docs|doc|documentation|plans|evidence|redproof)(?:\/|$)/i;
/**
 * A planning or evidence basename: `plan.md`, `implementation-plan.md`,
 * `planning.md`, `redproof.md`, `red-proof.md`, `evidence.md`.
 * `planet.md` and `explanation.md` do not match.
 */
const EVIDENCE_NAME = /(?:^|[^a-z0-9])(?:planning|plans|plan|red-?proofs?|evidence)(?:[^a-z0-9]|$)/i;

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
  if (!isMarkdown(rel)) return false;
  if (DOC_DIR.test(rel)) return true;
  return EVIDENCE_NAME.test(base);
}

/**
 * True when `rel` is documentation or evidence that needs no test lane.
 * `extraGlobs` are the repo's `empty_lanes` (`.gstack/pregate.json` on the
 * base branch). They add paths; they cannot classify source code or a file
 * under a test directory.
 */
export function isDocsEmptyLane(rel: string, extraGlobs: readonly string[] = []): boolean {
  const norm = rel.replace(/\\/g, '/').replace(/^\.\//, '');
  if (!norm || isTestTree(norm) || isSourceCode(norm)) return false;
  if (extraGlobs.length > 0 && matchesAny(extraGlobs, norm)) return true;
  return isBuiltinDocsPath(norm);
}
