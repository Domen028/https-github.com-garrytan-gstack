import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runBashScript } from './helpers/bash-script';

// C3 (#333): host runtime roots hold real SKILL.md copies. setup records each
// copy's hash under the state root; an edited copy is saved to a uniquely
// named backup before the tree is replaced, and a failed backup stops the
// replacement.
const setup = fs.readFileSync(path.resolve(import.meta.dir, '../setup'), 'utf8');
const fn = (name: string) => {
  const start = setup.indexOf(`\n${name}() {`);
  const end = setup.indexOf('\n}\n', start);
  if (start < 0 || end < 0) throw new Error(`missing setup helper: ${name}`);
  return setup.slice(start + 1, end + 2);
};
const helpers = ['_copy_skill_md', '_skill_copy_hash', '_skill_copy_unmodified', '_preserve_skill_copy_edits', '_record_skill_copies', '_activate_runtime_root'].map(fn).join('\n');

const tmps: string[] = [];
afterEach(() => { for (const t of tmps.splice(0)) { fs.chmodSync(t, 0o755); fs.rmSync(t, { recursive: true, force: true }); } });

function run(tmp: string, body: string) {
  return runBashScript([
    'set -e', 'log() { echo "$@"; }', `GSTACK_STATE_ROOT="${tmp}/state"`, '_SKILL_COPIES_FILE="$GSTACK_STATE_ROOT/skill-copies.tsv"',
    helpers,
    // A runtime root build: router plus one nested copy, from $SRC.
    'build() { mkdir -p "$2/gstack-upgrade"; _copy_skill_md "$SRC/router.md" "$2/SKILL.md"; [ -f "$SRC/upgrade.md" ] && _copy_skill_md "$SRC/upgrade.md" "$2/gstack-upgrade/SKILL.md"; return 0; }',
    `SRC="${tmp}/src"; ROOT="${tmp}/home/.codex/skills/gstack"`,
    body,
  ].join('\n'), { timeout: 30_000 });
}

describe.skipIf(process.platform === 'win32')('setup: real-file SKILL.md copies (C3)', () => {
  test('copies, refreshes, saves hand edits uniquely, and reports removals', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-skill-copies-'));
    tmps.push(tmp);
    fs.mkdirSync(path.join(tmp, 'src'));
    fs.writeFileSync(path.join(tmp, 'src/router.md'), 'router v1\n');
    fs.writeFileSync(path.join(tmp, 'src/upgrade.md'), 'upgrade v1\n');
    const root = path.join(tmp, 'home/.codex/skills/gstack');

    let r = run(tmp, '_activate_runtime_root build "$SRC" "$ROOT"');
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain(`refreshed SKILL.md copies in ${root}: SKILL.md gstack-upgrade/SKILL.md`);
    expect(fs.lstatSync(path.join(root, 'SKILL.md')).isSymbolicLink()).toBe(false);

    // An unedited copy is refreshed with no backup.
    fs.writeFileSync(path.join(tmp, 'src/router.md'), 'router v2\n');
    r = run(tmp, '_activate_runtime_root build "$SRC" "$ROOT"');
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).not.toContain('saved your edited');
    expect(fs.readFileSync(path.join(root, 'SKILL.md'), 'utf8')).toBe('router v2\n');

    // Two runs with hand edits keep two separate backups.
    const backups: string[] = [];
    for (const note of ['edit one', 'edit two']) {
      fs.appendFileSync(path.join(root, 'SKILL.md'), `${note}\n`);
      r = run(tmp, '_activate_runtime_root build "$SRC" "$ROOT"');
      expect(r.status, r.stderr).toBe(0);
      const m = r.stdout.match(/saved your edited (\S+) to (\S+) /);
      expect(m, r.stdout).not.toBeNull();
      expect(m![1]).toBe(path.join(root, 'SKILL.md'));
      expect(m![2].startsWith(path.join(tmp, 'state/backups/skill-copies/'))).toBe(true);
      expect(fs.readFileSync(m![2], 'utf8')).toBe(`router v2\n${note}\n`);
      backups.push(m![2]);
      expect(fs.readFileSync(path.join(root, 'SKILL.md'), 'utf8')).toBe('router v2\n');
    }
    expect(new Set(backups).size).toBe(2);
    expect(fs.readFileSync(backups[0], 'utf8')).toBe('router v2\nedit one\n');

    // A copy setup no longer writes is reported as removed.
    fs.rmSync(path.join(tmp, 'src/upgrade.md'));
    r = run(tmp, '_activate_runtime_root build "$SRC" "$ROOT"');
    expect(r.stdout).toContain(`removed SKILL.md copies from ${root}: gstack-upgrade/SKILL.md`);
  });

  test('a backup that cannot be written keeps the old tree', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-skill-copies-'));
    tmps.push(tmp);
    fs.mkdirSync(path.join(tmp, 'src'));
    fs.writeFileSync(path.join(tmp, 'src/router.md'), 'router v1\n');
    const root = path.join(tmp, 'home/.codex/skills/gstack');
    expect(run(tmp, '_activate_runtime_root build "$SRC" "$ROOT"').status).toBe(0);
    fs.appendFileSync(path.join(root, 'SKILL.md'), 'mine\n');
    fs.mkdirSync(path.join(tmp, 'state/backups'), { recursive: true });
    fs.chmodSync(path.join(tmp, 'state/backups'), 0o555);
    try {
      const r = run(tmp, '_activate_runtime_root build "$SRC" "$ROOT" || echo "rc=$?"');
      expect(r.stdout).toContain('rc=1');
      expect(r.stderr).toContain('could not back up an edited SKILL.md copy');
      expect(fs.readFileSync(path.join(root, 'SKILL.md'), 'utf8')).toBe('router v1\nmine\n');
    } finally {
      fs.chmodSync(path.join(tmp, 'state/backups'), 0o755);
    }
  });
});

// #3084: activation moves the old runtime root aside and deletes it, so a root
// that is, or contains, the checkout setup runs from is refused before anything
// moves. A symlinked root only loses the link.
describe.skipIf(process.platform === 'win32')('setup: a runtime root that holds the checkout (#3084)', () => {
  /** A checkout's top-level entries, for "nothing changed" checks. */
  function makeCheckout(dir: string) {
    fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
    for (const name of ['setup', 'VERSION', 'router.md']) fs.writeFileSync(path.join(dir, name), `${name}\n`);
    return () => Object.fromEntries(fs.readdirSync(dir).sort().map(n => {
      const p = path.join(dir, n);
      return [n, fs.statSync(p).isDirectory() ? 'dir' : fs.readFileSync(p, 'utf8')];
    }));
  }

  test('a root that is, or contains, the checkout is refused and the checkout is unchanged', () => {
    // [layout, checkout path under the root, bash that respells ROOT]
    for (const [layout, under, respell] of [
      ['root is the checkout', '', ''],
      ['root contains the checkout', '/checkout', ''],
      ['root is the checkout, named through a linked parent', '', 'ln -s "$T/home" "$T/alias"; ROOT="$T/alias/.cursor/skills/gstack"'],
    ]) {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-skill-copies-'));
      tmps.push(tmp);
      const root = path.join(tmp, 'home/.cursor/skills/gstack');
      const snapshot = makeCheckout(root + under);
      const before = snapshot();
      const r = run(tmp, `T="${tmp}"; SRC="${root}${under}"; ROOT="${root}"; ${respell}\n_activate_runtime_root build "$SRC" "$ROOT" || echo "rc=$?"`);
      expect(r.stdout, layout).toContain('rc=1');
      expect(r.stderr, layout).toContain('refusing to replace');
      expect(snapshot(), layout).toEqual(before);
    }
  });

  test('a symlinked root is replaced and the checkout it pointed at survives', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-skill-copies-'));
    tmps.push(tmp);
    const snapshot = makeCheckout(path.join(tmp, 'src'));
    const before = snapshot();
    const root = path.join(tmp, 'home/.cursor/skills/gstack');
    fs.mkdirSync(path.dirname(root), { recursive: true });
    fs.symlinkSync(path.join(tmp, 'src'), root);
    const r = run(tmp, `ROOT="${root}"; _activate_runtime_root build "$SRC" "$ROOT"`);
    expect(r.status, r.stderr).toBe(0);
    expect(fs.lstatSync(root).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(path.join(root, 'SKILL.md'), 'utf8')).toBe('router.md\n');
    expect(snapshot()).toEqual(before);
  });
});
