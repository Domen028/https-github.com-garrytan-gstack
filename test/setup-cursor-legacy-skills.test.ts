/**
 * #3133: a 1.31 setup run from a checkout under ~/.cursor/skills set up
 * unprefixed <skill>/ folders there, each holding a SKILL.md symlink into the
 * checkout. Current setup links gstack-<skill>/ folders and its retired-skill
 * prune looks only at gstack-* names, so the old folders stayed: Cursor loaded
 * every skill twice, or held dangling links once the checkout moved.
 * `./setup --host cursor` now removes them with the Claude flat-name cleanup,
 * which deletes only entries proven to link into gstack (#2119). Controls:
 * user-owned folders stay byte-identical, and an install that fails before
 * its new links exist keeps the old folders.
 */
import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { existsSync, lstatSync, readFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupFixtures, cleanupSeed, fixtureMkdirSync, makeFixture, makeSource, put, runSetup, tree } from './helpers/install-fixture';

afterEach(cleanupFixtures);
afterAll(cleanupSeed);

describe.skipIf(process.platform === 'win32')('setup --host cursor removes 1.31-era unprefixed skill folders (#3133)', () => {
  /** A 1.31 folder: a real directory holding only a SKILL.md symlink to `target`. */
  function legacy(skills: string, name: string, target: string) {
    fixtureMkdirSync(join(skills, name), { recursive: true });
    symlinkSync(target, join(skills, name, 'SKILL.md'));
  }

  test('legacy folders that link into gstack go; user-owned folders stay byte-identical', () => {
    const f = makeFixture();
    const src = makeSource(f, join(f.home, '.claude/skills/gstack'));
    const skills = join(f.home, '.cursor/skills');
    // Resolves into the checkout, so Cursor loads it next to gstack-autoplan/.
    legacy(skills, 'autoplan', join(src, 'autoplan/SKILL.md'));
    // The reporter's shape once the checkout left ~/.cursor/skills/gstack.
    legacy(skills, 'review', join(skills, 'gstack/review/SKILL.md'));
    // 1.31's /connect-chrome alias, a relative directory link.
    symlinkSync('gstack/open-gstack-browser', join(skills, 'connect-chrome'));
    // The user's own: a hand-written skill, one named like a gstack skill, and
    // one whose SKILL.md links outside any gstack path.
    put(join(skills, 'my-skill/SKILL.md'), '---\nname: my-skill\n---\nMine.\n');
    put(join(skills, 'qa/SKILL.md'), '---\nname: qa\n---\nMy own QA checklist.\n');
    put(join(f.dir, 'dotfiles/notes/SKILL.md'), '---\nname: notes\n---\n');
    legacy(skills, 'notes', join(f.dir, 'dotfiles/notes/SKILL.md'));
    const kept = Object.fromEntries(['my-skill', 'qa', 'notes'].map(name => [name, tree(join(skills, name))]));

    const r = runSetup(f, join(src, 'setup'), ['--host', 'cursor']);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(['autoplan', 'review', 'connect-chrome'].filter(name => lstatSync(join(skills, name), { throwIfNoEntry: false }))).toEqual([]);
    for (const [name, before] of Object.entries(kept)) expect(tree(join(skills, name)), name).toEqual(before);
    expect(existsSync(join(skills, 'gstack-autoplan/SKILL.md'))).toBe(true);
    expect(existsSync(join(skills, 'gstack/SKILL.md'))).toBe(true);
  }, 120_000);

  test('control: an install that fails before its new links exist keeps the legacy folders', () => {
    const f = makeFixture();
    const src = makeSource(f, join(f.home, '.claude/skills/gstack'));
    const skills = join(f.home, '.cursor/skills');
    legacy(skills, 'autoplan', join(src, 'autoplan/SKILL.md'));
    // #3084's failure: the Cursor render step exits 0 but renders nothing, so
    // linking fails after the runtime root is in place.
    const bun = join(f.commands, 'bun');
    put(bun, readFileSync(bun, 'utf8').replace('case "$*" in\n', `case "$*" in\n  'run gen:skill-docs --host cursor') exit 0 ;;\n`), 0o755);
    const before = tree(join(skills, 'autoplan'));

    const r = runSetup(f, join(src, 'setup'), ['--host', 'cursor']);
    expect(r.status, r.stdout + r.stderr).toBe(1);
    expect(r.stderr).toContain('.cursor/skills/ generation failed');
    expect(tree(join(skills, 'autoplan'))).toEqual(before);
  }, 120_000);
});
