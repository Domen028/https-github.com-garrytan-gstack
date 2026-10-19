/**
 * Task-memory procedures: what one Claude Code session observably did in a
 * repository, reduced to evidence a later session can reuse.
 *
 *   native journal (main thread only) -> Step[] -> Episode[] -> Verdict -> Procedure
 *
 * Only tool calls with paired native results count. An edit is a successful
 * Edit/Write/MultiEdit/NotebookEdit inside the repository. A check is a
 * recognized test command whose result carries a complete runner summary
 * with a positive pass count and zero failures. A missing exit status,
 * `is_error: false` alone, assistant prose and the Stop event itself prove
 * nothing. Any later change (an edit, a shell command that may write, an
 * unrecognized tool) invalidates every earlier check.
 *
 * Nothing here touches the network. The rendered Markdown carries a redacted
 * goal line, repository-relative paths, literal check commands and runner
 * counts; never file bodies, diffs, tool output or transcript text.
 */
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
  /** A change with no renderable target: a shell write, an unrecognized tool, an edit whose result never arrived. */
  | { kind: 'change' }
  | { kind: 'check'; command: LiteralCheck; outcome: CheckOutcome };

export interface Episode {
  /** Native uuid of the typed prompt that opened the episode. */
  readonly key: string;
  readonly startedAt: string;
  readonly goal: Goal | null;
  readonly steps: readonly Step[];
}

export interface PassedCheck { readonly command: LiteralCheck; readonly outcome: Extract<CheckOutcome, { kind: 'passed' }> }
export interface EditTarget { readonly target: RepoRelPath; readonly tool: EditTool }

export type Verdict =
  | { kind: 'verified'; edits: NonEmpty<EditTarget>; checks: NonEmpty<PassedCheck> }
  | { kind: 'unverified'; reason: 'no-edits' | 'no-passing-check' | 'changed-after-check' | 'failed-check' };

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
/** Tools that cannot change the working tree. Every other tool, MCP tools and subagents included, counts as a change. */
const READ_ONLY_TOOLS: ReadonlySet<string> = new Set(['Read', 'Grep', 'Glob', 'LS', 'WebFetch', 'WebSearch', 'TodoWrite',
  'TodoRead', 'AskUserQuestion', 'ToolSearch', 'ExitPlanMode', 'EnterPlanMode', 'BashOutput', 'ListMcpResourcesTool', 'ReadMcpResourceTool']);
const CHECK_COMMANDS: readonly RegExp[] = [
  /^bun (?:test|run test[\w:-]*)(?:\s|$)/,
  /^(?:npm|pnpm|yarn)(?: run)? test[\w:-]*(?:\s|$)/,
  /^(?:npx |bunx )?(?:vitest|jest)(?:\s|$)/,
  /^(?:python3? -m )?pytest(?:\s|$)/,
  /^cargo test(?:\s|$)/,
];
const READ_ONLY_COMMANDS = /^(?:git (?:status|diff|log|show|branch|rev-parse|add|commit|fetch|remote|blame)|ls|cat|head|tail|wc|grep|rg|pwd|echo|which|type|file|stat|du|df|date|whoami|tree|true|:)(?:\s|$)/;
const ENV_PREFIX = /^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/;

const isNonEmpty = <T>(items: T[]): items is NonEmpty<T> => items.length > 0;

/** Strip `2>&1`, which joins streams without hiding the exit status. */
const joinedStreams = (command: string): string => command.replace(/\s+2>&1(?=\s|$)/g, '');

type ShellKind =
  | { kind: 'read-only' }
  | { kind: 'check'; literal: string }
  | { kind: 'masked-check' }
  | { kind: 'change' };

/**
 * Classify one Bash command. A check counts only as a simple command (or
 * `cd <repo root> && <check>`): pipes, `||`, `;`, redirection, substitution
 * and env prefixes can hide the runner's real status or output, so such a
 * check is masked and proves nothing. Anything not recognized may write.
 */
export function classifyShell(raw: string, repoRoot: string): ShellKind {
  const command = joinedStreams(raw.trim());
  if (!command || /[<>`]|\$\(/.test(command)) return command && CHECK_COMMANDS.some(re => re.test(command)) ? { kind: 'masked-check' } : { kind: 'change' };
  const segments = command.split(/\s*(?:&&|\|\||;|\||\n)\s*/).filter(Boolean);
  const bare = segments.map(s => s.replace(ENV_PREFIX, ''));
  if (bare.every(s => READ_ONLY_COMMANDS.test(s))) return { kind: 'read-only' };
  const cdRoot = segments.length === 2 && /^cd\s+\S+\s*&&/.test(command) && sameDir(segments[0]!.slice(2).trim(), repoRoot);
  const lone = segments.length === 1 ? segments[0]! : cdRoot ? segments[1]! : undefined;
  if (lone !== undefined && !ENV_PREFIX.test(lone) && CHECK_COMMANDS.some(re => re.test(lone))) return { kind: 'check', literal: lone };
  if (bare.some(s => CHECK_COMMANDS.some(re => re.test(s))) && bare.every(s => READ_ONLY_COMMANDS.test(s) || CHECK_COMMANDS.some(re => re.test(s)) || /^cd\s/.test(s)))
    return { kind: 'masked-check' };
  return { kind: 'change' };
}

function sameDir(dir: string, root: string): boolean {
  try { return fs.realpathSync(dir.replace(/^(['"])(.*)\1$/, '$2')) === root; } catch { return false; }
}

/** A literal check safe to store: one line, bounded, no local paths, no redaction finding. */
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

/** Complete runner summaries, one parser per supported runner. Each returns null unless its whole summary is present. */
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

/**
 * What a check's native result proves. A host error is a failure (an
 * interrupt proves nothing either way). Success needs a complete supported
 * summary with at least one passing test and no failure.
 */
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

/** Repository-relative POSIX path of an absolute tool path (symlinks resolved), or null outside the repository. */
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

/** An in-repository path that is safe to render in a Markdown code span. */
const renderable = (rel: string): RepoRelPath | null =>
  /[\x00-\x1f`]/.test(rel) || rel === '.git' || rel.startsWith('.git/') ? null : rel as RepoRelPath;

/** First line of a typed prompt, redacted and capped; null when it carries a credential or an injection pattern. */
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

/**
 * Read the main-thread tool evidence of one native session journal. The
 * journal must sit under `<claude config>/projects/` and pass the shared
 * owned reader's identity checks; sidechains and subagents are excluded.
 */
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
              classifyShell(e.input.command, repoRoot).kind === 'check') checkIds.add(e.toolUseId);
        }
        for (const r of records) if (r.events.some(e => e.kind === 'result' && !e.isError && checkIds.has(e.toolUseId))) wanted.push(r);
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

/** The text of one typed prompt record, re-read by its indexed byte range and checked against its uuid. */
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

/** Pair native uses with their results in completion order. A mutating use with no result yet is a change. */
export function toSteps(events: readonly ClaudeParentPublicEvent[], repoRoot: string,
  promptOf: (prompt: ClaudeParentPublicEvent) => { key: string; text: string | null } | null): Step[] {
  const steps: Step[] = [];
  const pending = new Map<string, { name: string; input: Record<string, unknown> | undefined }>();
  for (const e of events) {
    if (e.kind === 'user_turn') {
      const prompt = promptOf(e);
      if (prompt) steps.push({ kind: 'prompt', key: prompt.key, at: e.timestamp, goal: prompt.text === null ? null : deriveGoal(prompt.text) });
    } else if (e.kind === 'use') {
      if (!READ_ONLY_TOOLS.has(e.name ?? '')) pending.set(e.toolUseId, { name: e.name ?? '', input: e.input });
    } else if (e.kind === 'result') {
      const use = pending.get(e.toolUseId);
      if (!use) continue;
      pending.delete(e.toolUseId);
      const step = resultStep(use, e.isError === true, toolText(e.content), repoRoot);
      if (step) steps.push(step);
    }
  }
  for (const use of pending.values()) if (use.name !== 'Bash' || classifyShell(String(use.input?.command ?? ''), repoRoot).kind === 'change') steps.push({ kind: 'change' });
  return steps;
}

function resultStep(use: { name: string; input: Record<string, unknown> | undefined }, isError: boolean, text: string, repoRoot: string): Step | null {
  if (EDIT_TOOLS.has(use.name)) {
    if (isError) return null;
    const rel = insideRepo(use.input?.file_path, repoRoot);
    if (rel === null) return null;
    const target = renderable(rel);
    return target ? { kind: 'edit', tool: use.name as EditTool, target } : { kind: 'change' };
  }
  if (use.name !== 'Bash') return { kind: 'change' };
  const command = String(use.input?.command ?? '');
  const shell = classifyShell(command, repoRoot);
  if (shell.kind === 'read-only' || shell.kind === 'masked-check') return null;
  if (shell.kind === 'change') return { kind: 'change' };
  const literal = literalCheck(shell.literal);
  const outcome = use.input?.run_in_background === true ? { kind: 'unknown' as const } : checkOutcome(text, isError);
  return literal ? { kind: 'check', command: literal, outcome } : null;
}

/**
 * Split steps into episodes at typed prompts. A prompt opens a new episode
 * when the current one has no edits yet or is already verified; otherwise
 * ("keep going" after a failure) the work continues the same episode.
 */
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

/** Whether an episode's own evidence verifies it: edits, then a passing check after the last change, no unresolved failure. */
export function verdict(steps: readonly Step[]): Verdict {
  const edits: EditTarget[] = [];
  for (const s of steps) if (s.kind === 'edit' && !edits.some(e => e.target === s.target)) edits.push({ target: s.target, tool: s.tool });
  if (!isNonEmpty(edits)) return { kind: 'unverified', reason: 'no-edits' };
  const lastChange = steps.findLastIndex(s => s.kind === 'edit' || s.kind === 'change');
  const final = new Map<LiteralCheck, CheckOutcome>();
  for (const s of steps.slice(lastChange + 1)) if (s.kind === 'check' && s.outcome.kind !== 'unknown') final.set(s.command, s.outcome);
  if ([...final.values()].some(o => o.kind === 'failed')) return { kind: 'unverified', reason: 'failed-check' };
  const checks: PassedCheck[] = [];
  for (const [command, outcome] of final) if (outcome.kind === 'passed') checks.push({ command, outcome });
  if (!isNonEmpty(checks)) {
    const passedEarlier = steps.slice(0, lastChange).some(s => s.kind === 'check' && s.outcome.kind === 'passed');
    return { kind: 'unverified', reason: passedEarlier ? 'changed-after-check' : 'no-passing-check' };
  }
  return { kind: 'verified', edits, checks };
}

const VERBS: Record<EditTool, string> = { Edit: 'Edited', MultiEdit: 'Edited', Write: 'Wrote', NotebookEdit: 'Edited notebook' };

/** Stable Markdown for a verified episode, or null when the rendered document still carries a credential shape. */
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
