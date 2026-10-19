/**
 * The shared read-only grammar (GSTA-49): accepted pure reads, a negative
 * control for every rejected class, and free replays of the captured Opus
 * slips through the opted-in docsync observer.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fixtureDocs } from './helpers/docsync-fixture';
import { docsCommandAllowed, docsNativeInterface, docsToolFailures } from './helpers/docsync-observer';
import { readOnlyCommandAllowed, readOnlyCommandRejection, readOnlyInterfaceText, READ_TOOLS, STDIN_TOOLS } from './helpers/read-only-commands';
import type { SkillTestResult } from './helpers/session-runner';

let base: string;
let root: string;
let outside: string;
const scope = () => ({ root, deny: (file: string) => path.basename(file) === 'credentials.json' });

beforeAll(() => {
  if (process.platform === 'win32') return;
  base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'ro-grammar-'));
  root = path.join(base, 'root');
  outside = path.join(base, 'outside');
  for (const [file, text] of Object.entries({
    'qa-only/SKILL.md': '# QA only\nstep one\nstep two\n',
    'qa-only/sections/report.md': 'report\n',
    'qa/sections/browser-setup.md': 'setup\n',
    'qa/templates/report.md': 'template\n',
    'docs/guide.md': 'b\na\nb\n',
    'private/credentials.json': '{"token":"secret"}\n',
  })) {
    fs.mkdirSync(path.join(root, path.dirname(file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  }
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'outside\n');
  fs.symlinkSync(outside, path.join(root, 'escape'));
  fs.symlinkSync(path.join(root, 'docs/guide.md'), path.join(root, 'guide-link.md'));
});
afterAll(() => { if (base) fs.rmSync(base, { recursive: true, force: true }); });

// Paid fixtures run on Linux; the grammar resolves POSIX paths only, so on Windows it accepts nothing.
test.if(process.platform === 'win32')('the grammar fails closed on Windows', () => {
  const root = fs.realpathSync(os.tmpdir());
  for (const command of ['pwd', 'ls', 'wc -l x']) expect(readOnlyCommandAllowed(command, { root })).toBe(false);
});

function tree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of fs.readdirSync(dir, { recursive: true }).map(String).sort()) {
    const file = path.join(dir, name);
    const entry = fs.lstatSync(file);
    out[name] = entry.isFile() ? fs.readFileSync(file, 'base64') : entry.isSymbolicLink() ? 'link:' + fs.readlinkSync(file) : 'dir';
  }
  return out;
}

const ACCEPTED = [
  'pwd', 'ls', 'ls -la docs', 'ls -la qa-only/*', 'ls qa-only qa-only/sections qa/sections qa/templates', 'ls -R qa',
  'wc -l docs/guide.md', 'wc -l qa-only/SKILL.md qa-only/sections/*.md', 'head -n 2 docs/guide.md', 'head -2 qa-only/SKILL.md',
  'tail -n +2 docs/guide.md', 'cat -n docs/guide.md', 'cat guide-link.md', 'stat docs/guide.md', 'stat -c %s docs/guide.md',
  'file docs/guide.md', 'du -sh qa', 'du -d 1 .', 'find . -name "*.md" -type f', "find qa -maxdepth 2 -name '*.md' -print",
  'find . -path ./private -prune -o -type f -print', 'grep -n step qa-only/SKILL.md', 'rg -n step qa-only', 'grep -rn template qa',
  'grep -n -i "step\\|report" qa-only/SKILL.md', 'grep -c -e step -e report qa-only/SKILL.md', 'sort docs/guide.md',
  'sort -u docs/guide.md', 'uniq -c docs/guide.md', 'cut -c1-3 docs/guide.md', 'nl -ba docs/guide.md', 'sha256sum docs/guide.md',
  'md5sum docs/guide.md qa-only/SKILL.md', 'sha1sum docs/guide.md', 'sha512sum --tag docs/guide.md', 'ls qa | sha256sum', 'readlink -f guide-link.md', 'realpath docs/guide.md',
  'cat docs/guide.md | sort | uniq -c', 'ls qa | wc -l', 'grep -rn step qa-only | head -5', 'find qa -type f | sort',
  'wc -l qa-only/SKILL.md; ls qa-only', 'ls docs && wc -l docs/guide.md', 'ls missing || ls docs', 'cd qa && ls sections',
  'cd qa-only; wc -l SKILL.md', 'ls docs;',
];

describe.skipIf(process.platform === 'win32')('accepted pure local reads', () => {
  test('every listed tool has at least one accepted form', () => {
    for (const tool of Object.keys(READ_TOOLS)) expect(ACCEPTED.some(command => command.split(/[;&|]+\s*/).some(part => part.trim().split(' ')[0] === tool)), tool).toBe(true);
  });

  test.each(ACCEPTED)('accepts and executes without changing either tree: %s', command => {
    expect(readOnlyCommandRejection(command, scope())).toBeUndefined();
    const before = [tree(root), tree(outside)];
    const run = spawnSync('bash', ['-c', command], { cwd: root, encoding: 'utf8', timeout: 10000 });
    expect(run.error).toBeUndefined();
    expect([tree(root), tree(outside)]).toEqual(before);
  });

  test('the declared interface text names every tool and the pipe targets', () => {
    const text = readOnlyInterfaceText(root);
    for (const tool of [...Object.keys(READ_TOOLS), ...STDIN_TOOLS]) expect(text).toContain(tool);
    expect(text).toContain(root);
  });
});

// One negative control per rejected class; the reason pins which rule fired.
const REJECTED: Array<[string, string, RegExp]> = [
  ['write', 'rm docs/guide.md', /unlisted tool: rm/],
  ['write', 'touch docs/new.md', /unlisted tool: touch/],
  ['write', 'sort -o docs/sorted.md docs/guide.md', /unsupported sort option: -o/],
  ['write', 'uniq docs/guide.md docs/out.md', /at most 1 operand/],
  ['write', 'find . -name "*.md" -delete', /unsupported find primary: -delete/],
  ['write', "find . -exec rm '{}' ';'", /unsupported find primary: -exec/],
  ['write', "find . -ok cat '{}' ';'", /unsupported find primary: -ok/],
  ['write', 'find . -fprint list.txt', /unsupported find primary: -fprint/],
  ['write', 'find . -fprintf list.txt %p', /unsupported find primary: -fprintf/],
  ['redirect', 'cat docs/guide.md > copy.md', /redirect/],
  ['redirect', 'cat docs/guide.md >> copy.md', /redirect/],
  ['redirect', 'ls docs 2>/dev/null', /redirect/],
  ['redirect', 'wc -l < docs/guide.md', /redirect/],
  ['writing pipe', 'cat docs/guide.md | tee copy.md', /unlisted tool: tee/],
  ['writing pipe', 'ls | xargs rm', /unlisted tool: xargs/],
  ['writing pipe', 'cat docs/guide.md | sh', /unlisted tool: sh/],
  ['writing pipe', 'cat docs/guide.md | sort -o copy.md', /unsupported sort option: -o/],
  ['writing pipe', 'ls | find . -delete', /find cannot read a pipe/],
  ['substitution', 'cat $(ls docs)', /substitution or variable/],
  ['substitution', 'cat "$(touch x)"', /substitution or variable/],
  ['substitution', 'cat ' + '\x60' + 'ls' + '\x60', /substitution or variable/],
  ['substitution', 'cat <(ls)', /redirect/],
  ['variable', 'ls $HOME', /substitution or variable/],
  ['network', 'curl https://example.com', /unlisted tool: curl/],
  ['network', 'wget -q https://example.com', /unlisted tool: wget/],
  ['network', 'nc example.com 80', /unlisted tool: nc/],
  ['network', 'git fetch origin', /unlisted tool: git/],
  ['cd out of root', 'cd /tmp && ls', /cd outside root/],
  ['cd out of root', 'cd .. && ls', /cd outside root/],
  ['cd out of root', 'cd escape && cat secret.txt', /cd outside root/],
  ['cd out of root', 'cd ~ && ls', /tilde/],
  ['cd out of root', 'cd - && ls', /cd needs exactly one literal directory/],
  ['path escape: ..', 'cat ../outside/secret.txt', /path outside root/],
  ['path escape: ..', 'cat docs/../../outside/secret.txt', /path outside root/],
  ['path escape: ..', 'grep -rn outside ..', /path outside root/],
  ['path escape: symlink', 'cat escape/secret.txt', /path outside root/],
  ['path escape: symlink', 'ls escape/*', /glob outside root/],
  ['path escape: symlink', 'wc -l escape', /path outside root/],
  ['path escape: absolute', 'cat /etc/passwd', /path outside root/],
  ['path escape: absolute', 'ls /*', /glob outside root/],
  ['path escape: absolute', 'find / -name passwd', /path outside root/],
  ['path escape: option value', 'grep -f /etc/passwd docs/guide.md', /path outside root/],
  ['path escape: option value', 'find docs -newer /etc/passwd', /path outside root/],
  ['denied path', 'cat private/credentials.json', /denied path/],
  ['denied path', 'grep -rn token .', /recursive search reaches a denied path/],
  ['denied path', 'ls private/*', /denied path/],
  ['symlink following', 'grep -R step .', /unsupported grep option: -R/],
  ['symlink following', 'find -L . -name x', /unsupported find primary: -L/],
  ['symlink following', 'du -L .', /unsupported du option: -L/],
  ['external program', 'rg --pre cat step', /unsupported rg option: --pre/],
  ['external program', 'rg -z step', /unsupported rg option: -z/],
  ['sudo', 'sudo cat docs/guide.md', /unlisted tool: sudo/],
  ['unlisted tool', 'python3 -c "print(1)"', /unlisted tool: python3/],
  ['unlisted tool', 'sed -n 1p docs/guide.md', /unlisted tool: sed/],
  ['unlisted tool', 'awk 1 docs/guide.md', /unlisted tool: awk/],
  ['unlisted tool', 'echo hi', /unlisted tool: echo/],
  ['unlisted tool', 'env cat docs/guide.md', /unlisted tool: env/],
  ['unlisted tool', '/bin/cat docs/guide.md', /unlisted tool/],
  ['shell syntax', 'ls &', /background job/],
  ['shell syntax', 'ls\nrm docs/guide.md', /multi-line/],
  ['shell syntax', 'cat docs/{guide,other}.md', /brace expansion/],
  ['shell syntax', '(ls)', /subshell/],
  ['shell syntax', 'tail -f docs/guide.md', /unsupported tail option: -f/],
];

describe.skipIf(process.platform === 'win32')('rejected classes stay rejected', () => {
  test.each(REJECTED)('%s: %s', (_, command, reason) => {
    expect(readOnlyCommandRejection(command, scope())).toMatch(reason);
    expect(readOnlyCommandAllowed(command, scope())).toBe(false);
  });

  test('every class the brief names has a control', () => {
    const classes = new Set(REJECTED.map(([kind]) => kind.replace(/:.*/, '')));
    for (const kind of ['write', 'redirect', 'writing pipe', 'substitution', 'network', 'cd out of root', 'path escape', 'sudo', 'unlisted tool'])
      expect(classes.has(kind), kind).toBe(true);
  });
});

function nativeResult(commands: string[]): SkillTestResult {
  return { toolCalls: commands.map(command => ({ tool: 'Bash', input: { command }, output: '' })) } as unknown as SkillTestResult;
}

// Captured Opus slips. Fixture paths are templated; {home} is the docsync fixture home.
const DOCSYNC_SLIPS = [
  // PR #3275 gate 39173752116, slice 13, ship-docsync-missing-asset: its whole Bash stream.
  ['wc -l {home}/.claude/skills/gstack/ship/SKILL.md',
    'ls -la {home}/.claude/skills/gstack/document-release/sections {home}'],
  // TM1 effort study at e616a75, ship-docsync-missing-asset t10 (high effort): its Bash stream before the actor call.
  ['ls -la {home} {home}/.claude/skills/gstack {home}/.claude/skills/gstack/ship',
    'ls -la {home}/.claude/skills/gstack/ship/sections {home}/.claude/skills/gstack/document-release {home}/.claude/skills/gstack/document-release/*'],
];
// TM1 focused qa-only-no-fix at e03bfeb: the first Bash call; {dir} is the qa-only fixture root.
const QA_ONLY_SLIP = 'wc -l {dir}/qa-only/SKILL.md; ls {dir}/qa-only {dir}/qa-only/sections {dir}/qa/sections {dir}/qa/templates';

describe.skipIf(process.platform === 'win32')('free replays of the captured slips', () => {
  let fixture: ReturnType<typeof fixtureDocs>;
  beforeAll(() => { fixture = fixtureDocs('current'); });
  afterAll(() => fixture?.clean());

  test.each(DOCSYNC_SLIPS.map((stream, index) => [index, stream] as const))('docsync stream %i now passes the observer with no command failure', (_, stream) => {
    const commands = stream.map(command => command.replaceAll('{home}', fixture.home));
    expect(docsToolFailures(nativeResult(commands), fixture, [], true)).toEqual([]);
    for (const command of commands) expect(docsCommandAllowed(command, fixture), command).toBe(true);
  });

  test('the docsync interface declares the grammar over the fixture home', () => {
    expect(docsNativeInterface(fixture)).toContain(readOnlyInterfaceText(fixture.home));
  });

  test('docsync keeps its git interface and denies credentials and actor state', () => {
    for (const command of [
      'git status; ls', 'cd repo && git fetch', 'git log | head -5',
      'wc -l ' + path.join(fixture.home, 'cc/.claude.json'),
      'grep -rn apiKey ' + fixture.home,
      'head ' + path.join(fixture.home, 'actor-state.json'),
      'wc -l /etc/passwd',
      'wc -l ' + path.join(fixture.home, '.claude/skills/gstack/ship/SKILL.md') + ' > ' + path.join(fixture.repo, 'count.txt'),
    ]) expect(docsCommandAllowed(command, fixture), command).toBe(false);
  });

  test('the qa-only slip is a pure read inside its fixture root', () => {
    expect(readOnlyCommandRejection(QA_ONLY_SLIP.replaceAll('{dir}', root), scope())).toBeUndefined();
    expect(readOnlyCommandRejection(QA_ONLY_SLIP.replaceAll('{dir}', root) + ' > ' + path.join(root, 'out.txt'), scope())).toMatch(/redirect/);
  });
});
