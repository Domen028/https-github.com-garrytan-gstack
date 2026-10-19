import * as fs from 'node:fs';
import * as path from 'node:path';
import { readOwnedClaudePublicTranscript } from '../claude-public-transcript';
import type { IndexedRecord } from '../claude-owned-journal';
import type { ClaudeParentPublicEvent } from '../claude-journal-records';
import { redactFindingSpans, scan } from '../redact-engine';
import { lineLooksInjected } from '../tracker-guard';

export type RepoRelPath = string & { readonly __brand: 'RepoRelPath' };
export type LiteralCheck = string & { readonly __brand: 'LiteralCheck' };
export type Goal = string & { readonly __brand: 'Goal' };
type NonEmpty<T> = [T, ...T[]];

export type EditTool = 'Edit' | 'MultiEdit' | 'Write' | 'NotebookEdit';
export type Runner = 'bun test' | 'pytest' | 'cargo test' | 'vitest' | 'jest';

export type CheckOutcome =
  | { kind: 'passed'; runner: Runner; passed: number; skipped: number }
  | { kind: 'failed' }
  | { kind: 'unknown' };

export type Step =
  | { kind: 'prompt'; key: string; at: string; goal: Goal | null }
  | { kind: 'edit'; tool: EditTool; target: RepoRelPath }
  | { kind: 'change' }
  | { kind: 'check'; key: string; literal: LiteralCheck | null; outcome: CheckOutcome };

export interface Episode {
  readonly key: string;
  readonly startedAt: string;
  readonly goal: Goal | null;
  readonly steps: readonly Step[];
}

export interface PassedCheck { readonly command: LiteralCheck; readonly outcome: Extract<CheckOutcome, { kind: 'passed' }> }
export interface EditTarget { readonly target: RepoRelPath; readonly tool: EditTool }

export type Verdict =
  | { kind: 'verified'; edits: NonEmpty<EditTarget>; checks: NonEmpty<PassedCheck> }
  | { kind: 'unverified'; reason: 'no-edits' | 'no-passing-check' | 'changed-after-check' | 'failed-check' | 'unconfirmed-check' };

export interface Procedure {
  readonly title: string;
  readonly recordedOn: string;
  readonly markdown: string;
}

export const MAX_EDIT_TARGETS = 20;
export const MAX_CHECKS = 6;
const MAX_GOAL_CHARS = 160;
const MAX_COMMAND_CHARS = 200;
const MAX_PROMPT_RECORD_BYTES = 256 * 1024;
const SUMMARY_TAIL_CHARS = 64 * 1024;

const EDIT_TOOLS: ReadonlySet<string> = new Set<EditTool>(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);
/** The task-list tools are in the pinned agent SDK's tool schemas. */
const READ_ONLY_TOOLS: ReadonlySet<string> = new Set(['Read', 'Grep', 'Glob', 'LS', 'WebFetch', 'WebSearch', 'TodoWrite',
  'TodoRead', 'AskUserQuestion', 'ToolSearch', 'ExitPlanMode', 'EnterPlanMode', 'BashOutput', 'ListMcpResourcesTool', 'ReadMcpResourceTool',
  'TaskCreate', 'TaskGet', 'TaskList', 'TaskUpdate', 'TaskOutput']);
const CHECK_COMMANDS: readonly RegExp[] = [
  /^bun (?:test|run test[\w:-]*)(?:\s|$)/,
  /^(?:npm|pnpm|yarn)(?: run)? test[\w:-]*(?:\s|$)/,
  /^(?:npx |bunx )?(?:vitest|jest)(?:\s|$)/,
  /^(?:python3? -m )?pytest(?:\s|$)/,
  /^cargo test(?:\s|$)/,
];
const SNAPSHOT_WRITE = /^(?:-u|--update|--update-snapshots?|--updateSnapshot|--snapshot-update)(?:=|$)/;
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

const isNonEmpty = <T>(items: T[]): items is NonEmpty<T> => items.length > 0;
const anyArgs = () => true;
const GIT_LISTING = new Set(['-a', '-r', '-v', '-vv', '--all', '--remotes', '--verbose', '--list', '--show-current', '--no-color']);
const GIT_READ_ONLY: Record<string, (args: readonly string[]) => boolean> = {
  status: anyArgs, log: anyArgs, show: anyArgs, diff: anyArgs, blame: anyArgs, 'rev-parse': anyArgs, 'ls-files': anyArgs,
  branch: args => args.every(a => GIT_LISTING.has(a)),
  remote: args => args.every(a => a === '-v' || a === '--verbose') || (args[0] === 'get-url' && !args.slice(1).some(a => a.startsWith('-') && a !== '--push' && a !== '--all')),
};
const READ_ONLY_COMMANDS: Record<string, (args: readonly string[]) => boolean> = {
  ls: anyArgs, cat: anyArgs, head: anyArgs, tail: anyArgs, wc: anyArgs, grep: anyArgs, pwd: anyArgs, echo: anyArgs, which: anyArgs,
  type: anyArgs, stat: anyArgs, du: anyArgs, df: anyArgs, whoami: anyArgs, true: anyArgs, ':': anyArgs,
  rg: args => !args.some(a => /^--pre(?:=|$)/.test(a)),
  git: ([sub, ...args]) => sub !== undefined && Object.hasOwn(GIT_READ_ONLY, sub) && !args.some(a => /^--output(?:=|$)/.test(a)) && GIT_READ_ONLY[sub]!(args),
};

interface Shell { readonly segments: string[][]; readonly joins: string[]; readonly hidden: boolean }

export function parseShell(command: string): Shell | null {
  const segments: string[][] = [[]];
  const joins: string[] = [];
  let word: string | null = null;
  let hidden = false;
  const end = () => { if (word !== null) segments.at(-1)!.push(word); word = null; };
  const join = (op: string) => { end(); joins.push(op); segments.push([]); };
  const target = (from: number): [string, number] => {
    let i = from;
    while (command[i] === ' ') i++;
    const start = i;
    while (i < command.length && !/[\s|&;<>()]/.test(command[i]!)) i++;
    return [command.slice(start, i), i - 1];
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (c === "'") {
      const close = command.indexOf("'", i + 1);
      if (close < 0) return null;
      word = (word ?? '') + command.slice(i + 1, close);
      i = close;
    } else if (c === '"') {
      let text = '';
      for (i++; i < command.length && command[i] !== '"'; i++) {
        if (command[i] === '`' || (command[i] === '$' && command[i + 1] === '(')) return null;
        if (command[i] === '\\') i++;
        text += command[i] ?? '';
      }
      if (i >= command.length) return null;
      word = (word ?? '') + text;
    } else if (c === '\\') {
      if (i + 1 >= command.length) return null;
      word = (word ?? '') + command[++i];
    } else if (c === '`' || c === '(' || c === ')' || (c === '$' && command[i + 1] === '(')) {
      return null;
    } else if (c === ' ' || c === '\t') {
      end();
    } else if (c === '>' || c === '<' || (c === '&' && command[i + 1] === '>')) {
      if (word !== null && /^\d$/.test(word)) word = null; else end();
      if (c === '&') i++;
      if (command[i] === '>' && command[i + 1] === '>') i++;
      if (command[i] === '>' && command[i + 1] === '&' && /\d/.test(command[i + 2] ?? '')) { i += 2; continue; }
      const [file, last] = target(i + 1);
      if (!file) return null;
      if (c !== '<') { if (file !== '/dev/null') return null; hidden = true; }
      i = last;
    } else if (c === '|' || c === '&' || c === ';' || c === '\n') {
      const two = command.slice(i, i + 2);
      if (two === '&&' || two === '||' || two === '|&') { join(two === '|&' ? '|' : two); i++; } else if (c === '&') return null;
      else join(c === '\n' ? ';' : c);
    } else {
      word = (word ?? '') + c;
    }
  }
  end();
  return segments.some(s => s.length === 0) ? null : { segments, joins, hidden };
}

type SegmentKind = 'check' | 'cd-root' | 'cd' | 'read-only' | 'change';

function segmentKind(words: readonly string[], repoRoot: string): SegmentKind {
  const [name, ...args] = words;
  if (name === undefined) return 'read-only';
  if (name === 'cd') return args.length > 1 ? 'change' : args[0] !== undefined && sameDir(args[0], repoRoot) ? 'cd-root' : 'cd';
  if (CHECK_COMMANDS.some(re => re.test(words.join(' ')))) return args.some(a => SNAPSHOT_WRITE.test(a)) ? 'change' : 'check';
  return Object.hasOwn(READ_ONLY_COMMANDS, name) && READ_ONLY_COMMANDS[name]!(args) ? 'read-only' : 'change';
}

const shellWord = (w: string) => /^[\w./:=@%+,-]+$/.test(w) ? w : `'${w.replace(/'/g, `'\\''`)}'`;

type ShellKind =
  | { kind: 'read-only' }
  | { kind: 'check'; literal: string }
  | { kind: 'masked-check'; key: string }
  | { kind: 'change' };

export function classifyShell(raw: string, repoRoot: string): ShellKind {
  const command = raw.trim();
  const shell = command ? parseShell(command) : null;
  if (!shell) return { kind: 'change' };
  const parts = shell.segments.map(words => {
    const at = words.findIndex(w => !ASSIGNMENT.test(w));
    const bare = at < 0 ? [] : words.slice(at);
    return { prefixed: at !== 0, words: bare, kind: segmentKind(bare, repoRoot) };
  });
  if (parts.some(p => p.kind === 'change')) return { kind: 'change' };
  if (!parts.some(p => p.kind === 'check')) return { kind: 'read-only' };
  const lone = parts.length === 1 ? parts[0]
    : parts.length === 2 && parts[0]!.kind === 'cd-root' && !parts[0]!.prefixed && shell.joins[0] === '&&' ? parts[1] : undefined;
  if (lone?.kind === 'check' && !lone.prefixed && !shell.hidden) return { kind: 'check', literal: lone.words.map(shellWord).join(' ') };
  return { kind: 'masked-check', key: command };
}

function sameDir(dir: string, root: string): boolean {
  try { return path.isAbsolute(dir) && fs.realpathSync(dir) === root; } catch { return false; }
}

export function literalCheck(literal: string): LiteralCheck | null {
  if (literal.length > MAX_COMMAND_CHARS || /[\r\n\t]/.test(literal)) return null;
  if (literal.split(/\s+/).some(token => /^['"]?(?:\/|~|[A-Za-z]:\\)/.test(token))) return null;
  const found = scan(literal, { repoVisibility: 'unknown' });
  if (found.oversize || found.findings.length > 0) return null;
  return literal as LiteralCheck;
}

interface Summary { runner: Runner; passed: number; failed: number; skipped: number }

const lastMatch = (text: string, re: RegExp): RegExpExecArray | null => {
  let found: RegExpExecArray | null = null;
  for (const m of text.matchAll(re)) found = m as RegExpExecArray;
  return found;
};
const tally = (text: string, words: Record<string, 'passed' | 'failed' | 'skipped'>): Record<'passed' | 'failed' | 'skipped', number> => {
  const out = { passed: 0, failed: 0, skipped: 0 };
  for (const m of text.matchAll(/(\d+) ([a-z]+)/g)) { const k = words[m[2]!]; if (k) out[k] += Number(m[1]); }
  return out;
};

const SUMMARY_PARSERS: ReadonlyArray<(text: string) => Summary | null> = [
  (text) => {
    const ran = lastMatch(text, /^Ran (\d+) tests? across \d+ files?\./gm);
    if (!ran) return null;
    const head = text.slice(0, ran.index);
    const count = (word: string) => Number(lastMatch(head, new RegExp(`^\\s*(\\d+) ${word}\\s*$`, 'gm'))?.[1] ?? NaN);
    const [passed, failed] = [count('pass'), count('fail')];
    const skipped = (Number.isFinite(count('skip')) ? count('skip') : 0) + (Number.isFinite(count('todo')) ? count('todo') : 0);
    if (!Number.isFinite(passed) || !Number.isFinite(failed) || Number(ran[1]) < passed + failed) return null;
    return { runner: 'bun test', passed, failed, skipped };
  },
  (text) => {
    const line = lastMatch(text, /^=+ (.+) in [\d.]+s(?: \([^)]*\))? =+\s*$/gm);
    if (!line) return null;
    const t = tally(line[1]!, { passed: 'passed', failed: 'failed', error: 'failed', errors: 'failed', skipped: 'skipped', xfailed: 'skipped' });
    return { runner: 'pytest', ...t };
  },
  (text) => {
    const lines = [...text.matchAll(/^test result: (ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored;/gm)];
    if (!lines.length) return null;
    const sum = (i: number) => lines.reduce((n, m) => n + Number(m[i]), 0);
    return { runner: 'cargo test', passed: sum(2), failed: sum(3) + lines.filter(m => m[1] === 'FAILED').length, skipped: sum(4) };
  },
  (text) => {
    const line = lastMatch(text, /^\s*Tests\s{2,}(.+)\((\d+)\)\s*$/gm);
    if (!line) return null;
    return { runner: 'vitest', ...tally(line[1]!, { passed: 'passed', failed: 'failed', skipped: 'skipped', todo: 'skipped' }) };
  },
  (text) => {
    const line = lastMatch(text, /^Tests:\s+(.+), (\d+) total\s*$/gm);
    if (!line) return null;
    return { runner: 'jest', ...tally(line[1]!, { passed: 'passed', failed: 'failed', skipped: 'skipped', todo: 'skipped' }) };
  },
];

export function checkOutcome(text: string, isError: boolean): CheckOutcome {
  if (isError) return /interrupted/i.test(text.slice(0, 200)) ? { kind: 'unknown' } : { kind: 'failed' };
  const tail = text.slice(-SUMMARY_TAIL_CHARS);
  for (const parse of SUMMARY_PARSERS) {
    const s = parse(tail);
    if (!s) continue;
    if (s.failed > 0) return { kind: 'failed' };
    return s.passed > 0 ? { kind: 'passed', runner: s.runner, passed: s.passed, skipped: s.skipped } : { kind: 'unknown' };
  }
  return { kind: 'unknown' };
}

export function insideRepo(file: unknown, repoRoot: string): string | null {
  if (typeof file !== 'string' || !path.isAbsolute(file)) return null;
  let dir = path.dirname(path.normalize(file));
  const tail = [path.basename(file)];
  for (;;) {
    try { dir = fs.realpathSync(dir); break; } catch {
      if (path.dirname(dir) === dir) return null;
      tail.unshift(path.basename(dir));
      dir = path.dirname(dir);
    }
  }
  const rel = path.relative(repoRoot, path.join(dir, ...tail));
  return !rel || rel.startsWith('..') || path.isAbsolute(rel) ? null : rel.split(path.sep).join('/');
}

const renderable = (rel: string): RepoRelPath | null =>
  /[\x00-\x1f`]/.test(rel) || rel === '.git' || rel.startsWith('.git/') ? null : rel as RepoRelPath;

export function deriveGoal(prompt: string): Goal | null {
  const line = prompt.split('\n').map(l => l.replace(/\s+/g, ' ').trim()).find(Boolean);
  if (!line || /^[/<]/.test(line)) return null;
  const found = scan(line, { repoVisibility: 'unknown' });
  if (found.oversize || found.counts.HIGH > 0 || lineLooksInjected(line)) return null;
  const masked = redactFindingSpans(line, { repoVisibility: 'unknown' });
  if (masked === null) return null;
  const chars = [...masked.replace(/[`\x00-\x1f\x7f]/g, '')];
  return (chars.length > MAX_GOAL_CHARS ? `${chars.slice(0, MAX_GOAL_CHARS - 1).join('')}…` : chars.join('')) as Goal;
}

export interface NativeSession {
  readonly sessionId: string;
  readonly transcriptPath: string;
  readonly cwd: string;
}

export type SessionRead =
  | { kind: 'ok'; steps: Step[] }
  | { kind: 'unreadable'; reason: string };

const toolText = (content: unknown): string => typeof content === 'string' ? content
  : Array.isArray(content) ? content.map(b => (b && typeof b === 'object' && typeof b.text === 'string' ? b.text : '')).join('\n') : '';

export function readSessionSteps(session: NativeSession, repoRoot: string, claudeConfigDir: string): SessionRead {
  let projects: string, file: string;
  try {
    projects = fs.realpathSync(path.join(claudeConfigDir, 'projects'));
    file = fs.realpathSync(session.transcriptPath);
  } catch { return { kind: 'unreadable', reason: 'transcript-missing' }; }
  if (!file.startsWith(projects + path.sep)) return { kind: 'unreadable', reason: 'transcript-outside-projects' };
  const prompts = new Map<ClaudeParentPublicEvent, IndexedRecord>();
  const checkIds = new Set<string>();
  const read = readOwnedClaudePublicTranscript(file, session.cwd, session.sessionId, {
    policy: {
      indexInput: (name, input) => name === 'Bash' ? { command: input.command, run_in_background: input.run_in_background }
        : EDIT_TOOLS.has(name) ? { file_path: input.file_path ?? input.notebook_path } : undefined,
      select: (records, load) => {
        const wanted: IndexedRecord[] = [];
        for (const r of records) for (const e of r.events) {
          if (e.kind === 'user_turn') prompts.set(e, r);
          if (e.kind === 'use' && e.name === 'Bash' && typeof e.input?.command === 'string' &&
              ['check', 'masked-check'].includes(classifyShell(e.input.command, repoRoot).kind)) checkIds.add(e.toolUseId);
        }
        for (const r of records) if (r.events.some(e => e.kind === 'result' && checkIds.has(e.toolUseId))) wanted.push(r);
        load(wanted);
      },
    },
  });
  if (read.transcript.status !== 'ready') return { kind: 'unreadable', reason: read.transcript.reason ?? read.transcript.status };
  return { kind: 'ok', steps: toSteps(read.events, repoRoot, (e) => {
    const record = prompts.get(e);
    return record?.uuid ? { key: record.uuid, text: promptText(file, record) } : null;
  }) };
}

function promptText(file: string, record: IndexedRecord | undefined): string | null {
  if (!record || record.length > MAX_PROMPT_RECORD_BYTES) return null;
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const bytes = Buffer.alloc(record.length);
    if (fs.readSync(fd, bytes, 0, record.length, record.offset) !== record.length) return null;
    const value = JSON.parse(bytes.toString('utf8'));
    return value?.uuid === record.uuid && typeof value?.message?.content === 'string' ? value.message.content : null;
  } catch { return null; } finally { if (fd !== undefined) fs.closeSync(fd); }
}

type ToolUse = { name: string; input: Record<string, unknown> | undefined };

export function toSteps(events: readonly ClaudeParentPublicEvent[], repoRoot: string,
  promptOf: (prompt: ClaudeParentPublicEvent) => { key: string; text: string | null } | null): Step[] {
  const slots: (Step | null)[] = [];
  const open = new Map<string, { slot: number; use: ToolUse }>();
  for (const e of events) {
    if (e.kind === 'user_turn') {
      const prompt = promptOf(e);
      if (prompt) slots.push({ kind: 'prompt', key: prompt.key, at: e.timestamp, goal: prompt.text === null ? null : deriveGoal(prompt.text) });
    } else if (e.kind === 'use') {
      if (!READ_ONLY_TOOLS.has(e.name ?? '')) open.set(e.toolUseId, { slot: slots.push(null) - 1, use: { name: e.name ?? '', input: e.input } });
    } else if (e.kind === 'result') {
      const pending = open.get(e.toolUseId);
      if (!pending) continue;
      open.delete(e.toolUseId);
      slots[pending.slot] = resultStep(pending.use, { isError: e.isError === true, text: toolText(e.content) }, repoRoot);
    }
  }
  for (const { slot, use } of open.values()) slots[slot] = resultStep(use, null, repoRoot);
  return slots.filter((s): s is Step => s !== null);
}

function resultStep(use: ToolUse, result: { isError: boolean; text: string } | null, repoRoot: string): Step | null {
  if (EDIT_TOOLS.has(use.name)) {
    if (result?.isError) return null;
    if (!result) return { kind: 'change' };
    const rel = insideRepo(use.input?.file_path, repoRoot);
    if (rel === null) return null;
    const target = renderable(rel);
    return target ? { kind: 'edit', tool: use.name as EditTool, target } : { kind: 'change' };
  }
  if (use.name !== 'Bash') return { kind: 'change' };
  const shell = classifyShell(String(use.input?.command ?? ''), repoRoot);
  if (shell.kind === 'read-only') return null;
  if (shell.kind === 'change') return { kind: 'change' };
  const outcome: CheckOutcome = !result || use.input?.run_in_background === true ? { kind: 'unknown' } : checkOutcome(result.text, result.isError);
  return shell.kind === 'check'
    ? { kind: 'check', key: shell.literal, literal: literalCheck(shell.literal), outcome }
    : { kind: 'check', key: shell.key, literal: null, outcome };
}

export function episodes(steps: readonly Step[]): Episode[] {
  const out: Episode[] = [];
  let current: { key: string; startedAt: string; goal: Goal | null; steps: Step[] } | null = null;
  for (const step of steps) {
    if (step.kind === 'prompt') {
      if (!current || !current.steps.some(s => s.kind === 'edit') || verdict(current.steps).kind === 'verified') {
        current = { key: step.key, startedAt: step.at, goal: step.goal, steps: [] };
        out.push(current);
      }
      continue;
    }
    current?.steps.push(step);
  }
  return out;
}

export function verdict(steps: readonly Step[]): Verdict {
  const edits: EditTarget[] = [];
  for (const s of steps) if (s.kind === 'edit' && !edits.some(e => e.target === s.target)) edits.push({ target: s.target, tool: s.tool });
  if (!isNonEmpty(edits)) return { kind: 'unverified', reason: 'no-edits' };
  const lastChange = steps.findLastIndex(s => s.kind === 'edit' || s.kind === 'change');
  const final = new Map<string, Extract<Step, { kind: 'check' }>>();
  for (const s of steps.slice(lastChange + 1)) if (s.kind === 'check') final.set(s.key, s);
  const latest = [...final.values()];
  if (latest.some(s => s.outcome.kind === 'failed')) return { kind: 'unverified', reason: 'failed-check' };
  if (latest.some(s => s.outcome.kind === 'unknown')) return { kind: 'unverified', reason: 'unconfirmed-check' };
  const checks = latest.flatMap(s => s.literal !== null && s.outcome.kind === 'passed' ? [{ command: s.literal, outcome: s.outcome }] : []);
  if (!isNonEmpty(checks)) {
    const passedEarlier = steps.slice(0, lastChange).some(s => s.kind === 'check' && s.outcome.kind === 'passed');
    return { kind: 'unverified', reason: passedEarlier ? 'changed-after-check' : 'no-passing-check' };
  }
  return { kind: 'verified', edits, checks };
}

const VERBS: Record<EditTool, string> = { Edit: 'Edited', MultiEdit: 'Edited', Write: 'Wrote', NotebookEdit: 'Edited notebook' };

export function renderProcedure(episode: Episode, proven: Extract<Verdict, { kind: 'verified' }>): Procedure | null {
  const shown = proven.edits.slice(0, MAX_EDIT_TARGETS);
  const title = episode.goal ?? `Edits to ${shown.map(e => e.target).slice(0, 3).join(', ')}`.slice(0, 120);
  const recordedOn = episode.startedAt.slice(0, 10);
  const lines = [
    `# Task procedure: ${title}`,
    '',
    `Observed history from one earlier session in this repository, recorded ${recordedOn}.`,
    'Each check below passed after the last edit. Nothing here was re-run.',
    '',
    '## Edits, in order',
    ...shown.map((e, i) => `${i + 1}. ${VERBS[e.tool]} \`${e.target}\``),
    ...(proven.edits.length > shown.length ? [`(and ${proven.edits.length - shown.length} more files)`] : []),
    '',
    '## Checks that passed',
    ...proven.checks.slice(0, MAX_CHECKS).map(c =>
      `- \`${c.command}\` (${c.outcome.runner}: ${c.outcome.passed} passed, 0 failed${c.outcome.skipped ? `, ${c.outcome.skipped} skipped` : ''})`),
    '',
  ];
  const markdown = lines.join('\n');
  const found = scan(markdown, { repoVisibility: 'unknown' });
  return found.oversize || found.counts.HIGH > 0 ? null : { title, recordedOn, markdown };
}
