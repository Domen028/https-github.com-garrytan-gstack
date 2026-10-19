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
 *
 * `isInertNoTests` is the second empty-lane class (#3267): files no test
 * runner loads — binary and media assets, stylesheets, and editor, lint and
 * hook configuration in dotfiles. It applies under the same rule (only when
 * nothing maps the file to a test) and never to code, the test tree, CI
 * workflows, the pin files, or the dotfiles that change how a runtime or a
 * test runner behaves (version pins, env files, babel/swc/mocha/coverage).
 */
import { SOURCE_EXT } from './import-graph';
import { matchesAny } from '../ship-policy';

const TEST_TREE = /(?:^|\/)(?:test|tests|spec|__tests__)(?:\/|$)/i;
const MARKDOWN = /\.(?:md|markdown|rst|adoc|asciidoc)$/i;
/** Prose names, with or without `.md` (LICENSE has no extension). */
const PROSE_NAME = /^(?:README|CHANGELOG|CONTRIBUTING|AGENTS|CLAUDE|ETHOS|LICENSE|LICENCE|COPYING|NOTICE)(?:\.md)?$/i;
/** Licence text under any name a vendored asset ships it with: `roboto-LICENSE.txt`, `LICENSE-MIT`, `COPYING.LESSER`, `licenses/apache.txt`. */
const LICENCE_TEXT = /(?:^|[-_.])(?:LICEN[CS]E|COPYING|COPYRIGHT|NOTICE)(?:[-_.][\w-]*)?(?:\.(?:txt|md))?$|^(?:licen[cs]es?|LICENSES)\/(?:.*\/)?[^/]+\.(?:txt|md)$/i;
const ASSET = /\.(?:png|jpe?g|gif|webp|avif|bmp|ico|icns|tiff?|svg|heic|woff2?|ttf|otf|eot|mp3|mp4|m4a|wav|ogg|oga|webm|mov|flac|pdf|psd|css|scss|sass|less)$/i;
/** Dot-directories whose contents CI, the runtime or pregate itself reads. */
const RUNTIME_DOT_DIR = /^\.(?:github\/(?:workflows|actions)|gstack|cargo|fvm|dart_tool|mvn|gradle|yarn|config|circleci|buildkite|storybook)(?:\/|$)/i;
/** Dotfiles that change how a runtime, package manager or test runner behaves. */
const RUNTIME_DOTFILE = /^\.(?:env(?:\..*)?|nvmrc|node-version|python-version|ruby-version|tool-versions|bun-version|fvmrc|npmrc|yarnrc(?:\.yml)?|babelrc(?:\..*)?|swcrc|mocharc(?:\..*)?|c8rc(?:\..*)?|nycrc(?:\..*)?|coveragerc|gitmodules|pnp\..*|gitlab-ci\.yml|travis\.yml)$/i;

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
  if (PROSE_NAME.test(base) || LICENCE_TEXT.test(base) || LICENCE_TEXT.test(rel)) return true;
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

/** Dotfile tool configuration: a root dotfile, or anything under a top-level dot-directory, that no runtime or runner reads. */
function isToolConfig(rel: string): boolean {
  const base = rel.split('/').pop() ?? rel;
  if (!rel.startsWith('.') || RUNTIME_DOT_DIR.test(rel) || RUNTIME_DOTFILE.test(base)) return false;
  return rel.includes('/') || base.startsWith('.');
}

/**
 * True when `rel` is a file no test runner loads (#3267): a binary or media
 * asset, a stylesheet, or dotfile tool configuration. Callers apply this only
 * after the import graph found no test, so an asset a test imports or names
 * still selects that test.
 */
export function isInertNoTests(rel: string): boolean {
  const norm = rel.replace(/\\/g, '/').replace(/^\.\//, '');
  if (!norm || isTestTree(norm) || isSourceCode(norm)) return false;
  return ASSET.test(norm) || isToolConfig(norm);
}
