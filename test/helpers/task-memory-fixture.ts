import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export const ROOT = path.resolve(import.meta.dir, '..', '..');
const PRELOAD = path.join(ROOT, 'test', 'helpers', 'task-memory-fetch-preload.ts');
const CLI = path.join(ROOT, 'bin', 'gstack-task-memory');

export interface FakeRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  authorization: string | null;
  apiVersion: string | null;
  body: string;
  payload: any;
  fields: Record<string, string>;
}

interface StoredMemory { id: string; title: string; text: string; additional_metadata: Record<string, unknown> }

export interface FakeBehavior {
  ingestStatus?: number;
  indexing?: string;
  redirectQuery?: boolean;
  leakAcrossCollections?: boolean;
  chunkMetadata?: boolean;
  delayMs?: number;
  rejectKey?: boolean;
}

export interface FakeHydra {
  origin: string;
  requests: FakeRequest[];
  store: Map<string, Map<string, StoredMemory>>;
  behavior: FakeBehavior;
  stop(): void;
}

const ok = (data: unknown, status = 200) => Response.json({ success: true, data, error: null }, { status });
const fail = (status: number, code: string) => Response.json({ success: false, data: null, error: { code, message: code } }, { status });

export function startFakeHydra(): FakeHydra {
  const requests: FakeRequest[] = [];
  const store = new Map<string, Map<string, StoredMemory>>();
  const behavior: FakeBehavior = {};
  const bucket = (db: string, collection: string) => {
    const key = `${db}/${collection}`;
    if (!store.has(key)) store.set(key, new Map());
    return store.get(key)!;
  };
  const server = Bun.serve({
    port: 0, hostname: '127.0.0.1',
    async fetch(req) {
      const url = new URL(req.url);
      const body = await req.text();
      const contentType = req.headers.get('content-type') ?? '';
      let fields: Record<string, string> = {};
      let payload: any = null;
      if (contentType.startsWith('multipart/form-data')) {
        const form = await new Response(body, { headers: { 'content-type': contentType } }).formData();
        fields = Object.fromEntries([...form.entries()].map(([k, v]) => [k, String(v)]));
        payload = JSON.parse(fields.memories ?? 'null');
      } else if (body) payload = JSON.parse(body);
      requests.push({ method: req.method, path: url.pathname, query: url.searchParams, authorization: req.headers.get('authorization'),
        apiVersion: req.headers.get('api-version'), body, payload, fields });
      if (behavior.delayMs) await Bun.sleep(behavior.delayMs);
      if (behavior.rejectKey) return fail(401, 'UNAUTHORIZED');
      const route = `${req.method} ${url.pathname}`;
      if (route === 'POST /databases') return ok({ database: payload.database });
      if (route === 'GET /databases/status') return ok({ infra: { ready_for_ingestion: true } });
      if (route === 'POST /context/ingest') {
        if (behavior.ingestStatus) return fail(behavior.ingestStatus, 'SERVICE_UNAVAILABLE');
        const items = bucket(fields.database!, fields.collection!);
        for (const m of payload) items.set(m.id, { id: m.id, title: m.title, text: m.text, additional_metadata: m.additional_metadata });
        return ok({ results: payload.map((m: any) => ({ id: m.id, status: 'queued' })), success_count: payload.length, failed_count: 0 });
      }
      if (route === 'GET /context/status') {
        const items = bucket(url.searchParams.get('database')!, url.searchParams.get('collection')!);
        return ok({ statuses: (url.searchParams.get('ids') ?? '').split(',').map(id => items.has(id)
          ? { id, indexing_status: behavior.indexing ?? 'graph_creation' }
          : { id, indexing_status: 'errored', error_code: 'FILE_NOT_FOUND' }) });
      }
      if (route === 'DELETE /context') {
        const items = bucket(payload.database, payload.collection);
        return ok({ results: payload.ids.map((id: string) => items.delete(id) ? { id, deleted: true } : { id, deleted: false, error: 'not found' }) });
      }
      if (route === 'POST /query') {
        if (behavior.redirectQuery) return new Response(null, { status: 302, headers: { location: 'https://elsewhere.example/query' } });
        const pool = behavior.leakAcrossCollections ? [...store.values()].flatMap(m => [...m.values()]) : [...bucket(payload.database, payload.collection).values()];
        return ok({ chunks: pool.map((m, i) => ({ chunk_uuid: `${m.id}_c${i}`, id: m.id, chunk_content: m.text, source_title: m.title,
          relevancy_score: 0.8, ...(behavior.chunkMetadata === false ? {} : { additional_metadata: m.additional_metadata }) })),
          sources: [], graph_context: { query_paths: [], chunk_relations: [] }, llm_prompt: 'SERVER_RENDERED_PROMPT' });
      }
      if (route === 'POST /context/list') {
        const items = bucket(payload.database, payload.collection);
        return ok({ sources: payload.ids.flatMap((id: string) => items.has(id) ? [{ id, title: items.get(id)!.title, additional_metadata: items.get(id)!.additional_metadata }] : []) });
      }
      return fail(404, 'NOT_FOUND');
    },
  });
  return { origin: `http://127.0.0.1:${server.port}`, requests, store, behavior, stop: () => server.stop(true) };
}

export interface Home {
  home: string;
  claude: string;
  settings: string;
  state: string;
  env: Record<string, string>;
  cleanup(): void;
}

export function makeHome(origin: string, seedSettings?: unknown): Home {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tm-home-')));
  const claude = path.join(home, '.claude');
  fs.mkdirSync(path.join(claude, 'skills'), { recursive: true });
  fs.symlinkSync(ROOT, path.join(claude, 'skills', 'gstack'));
  const settings = path.join(claude, 'settings.json');
  if (seedSettings) fs.writeFileSync(settings, JSON.stringify(seedSettings, null, 2));
  const state = path.join(home, '.gstack');
  const legacy = path.join(home, 'legacy-root');
  fs.mkdirSync(legacy);
  fs.writeFileSync(path.join(home, '.gitconfig'), '[user]\n\tname = Fixture\n\temail = fixture@example.com\n[init]\n\tdefaultBranch = main\n');
  const env: Record<string, string> = {
    PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
    HOME: home, CLAUDE_CONFIG_DIR: claude, GSTACK_SETTINGS_FILE: settings,
    GSTACK_HOME: state, GSTACK_STATE_ROOT: state, GSTACK_STATE_DIR: state, GSTACK_TEST_LEGACY_ROOT: legacy,
    BUN_OPTIONS: `--preload ${PRELOAD}`, GSTACK_TASK_MEMORY_TEST_ORIGIN: origin,
    TMPDIR: process.env.TMPDIR ?? '/tmp', LANG: 'C',
  };
  return { home, claude, settings, state, env, cleanup: () => fs.rmSync(home, { recursive: true, force: true }) };
}

export function makeRepo(home: Home, name: string, origin: string): string {
  const repo = path.join(home.home, 'work', name);
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'test'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src', 'math.ts'), 'export const add = (a: number, b: number) => a + b;\n');
  fs.writeFileSync(path.join(repo, 'test', 'math.test.ts'),
    "import { expect, test } from 'bun:test';\nimport { add } from '../src/math';\n" +
    "test('adds', () => { console.log('TOOL_OUTPUT_MARKER'); expect(add(2, 3)).toBe(5); });\ntest('adds zero', () => expect(add(2, 0)).toBe(2));\n");
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name, private: true, scripts: { test: 'echo all good' } }));
  for (const args of [['init', '-q'], ['remote', 'add', 'origin', origin], ['add', '.'], ['commit', '-qm', 'seed']]) {
    const r = spawnSync('git', args, { cwd: repo, env: home.env, encoding: 'utf8', timeout: 20_000 });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  }
  return fs.realpathSync(repo);
}

/**
 * Run a child without blocking this process: the fake HydraDB answers from
 * this event loop, so a synchronous spawn would starve it.
 */
async function run(cmd: string[], opts: { cwd?: string; env: Record<string, string>; input: string; timeoutMs: number }) {
  const started = Date.now();
  const child = Bun.spawn(cmd, { cwd: opts.cwd, env: opts.env, stdin: new Blob([opts.input]), stdout: 'pipe', stderr: 'pipe' });
  const timer = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs);
  const [stdout, stderr, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  clearTimeout(timer);
  return { status, stdout, stderr, ms: Date.now() - started };
}

export function cli(home: Home, cwd: string, args: string[], extra: { input?: string; env?: Record<string, string> } = {}) {
  return run(['bun', CLI, ...args], { cwd, env: { ...home.env, ...extra.env }, input: extra.input ?? '', timeoutMs: 90_000 });
}

export function readSettings(home: Home): any {
  return fs.existsSync(home.settings) ? JSON.parse(fs.readFileSync(home.settings, 'utf8')) : {};
}

export function hookCommands(home: Home, event: string): string[] {
  return (readSettings(home).hooks?.[event] ?? []).flatMap((e: any) => e.hooks.map((h: any) => h.command as string));
}

export function runRegisteredHook(home: Home, event: 'Stop' | 'UserPromptSubmit', stdin: unknown, env: Record<string, string> = {}) {
  const command = hookCommands(home, event).find(c => /task-memory-(stop|prompt)-hook$/.test(c));
  if (!command) throw new Error(`no task-memory ${event} hook registered`);
  return run(['/bin/sh', '-c', command], { env: { ...home.env, ...env }, input: JSON.stringify(stdin), timeoutMs: 30_000 });
}

export async function waitForWorkers(sessionId: string, timeoutMs = 60_000): Promise<void> {
  await Bun.sleep(300);
  await waitFor(() => spawnSync('pgrep', ['-f', '--', `--worker.*${sessionId}`], { timeout: 5_000 }).status === 1, timeoutMs);
}

export async function waitFor(check: () => boolean, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for the condition');
    await Bun.sleep(100);
  }
}

/**
 * A native Claude Code session journal under `<claude>/projects/`. `edit`
 * and `bash` really change and run things in `repo`; the journal records
 * them the way Claude Code does (a failed command's result is is_error with
 * an "Exit code N" first line).
 */
export function nativeSession(home: Home, repo: string) {
  const sessionId = randomUUID();
  const transcript = path.join(home.claude, 'projects', 'fixture-project', `${sessionId}.jsonl`);
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  let parent: string | null = null, tools = 0, messages = 0;
  const append = (type: string, message: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
    const uuid = randomUUID();
    fs.appendFileSync(transcript, `${JSON.stringify({ uuid, parentUuid: parent, cwd: repo, sessionId, isSidechain: false,
      version: '2.1.292', timestamp: new Date().toISOString(), type, message, ...extra })}\n`);
    parent = uuid;
  };
  const use = (name: string, input: Record<string, unknown>) => {
    const id = `toolu_fixture${++tools}`;
    append('assistant', { role: 'assistant', id: `msg_fixture${++messages}`, content: [{ type: 'tool_use', id, name, input }] });
    return id;
  };
  const result = (id: string, content: string, isError: boolean) =>
    append('user', { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] }, { toolUseResult: {} });
  return {
    sessionId, transcript,
    stop: { session_id: sessionId, transcript_path: transcript, cwd: repo, hook_event_name: 'Stop', stop_hook_active: false },
    prompt(text: string) {
      append('user', { role: 'user', content: text }, { origin: { kind: 'human' }, promptSource: 'typed', promptId: randomUUID() });
    },
    edit(file: string, from: string, to: string) {
      const abs = path.join(repo, file);
      const id = use('Edit', { file_path: abs, old_string: from, new_string: to });
      const before = fs.readFileSync(abs, 'utf8');
      fs.writeFileSync(abs, before.replace(from, to));
      result(id, `The file ${abs} has been updated.`, false);
    },
    bash(command: string) {
      const id = use('Bash', { command, description: 'run' });
      const r = spawnSync('bash', ['-c', command], { cwd: repo, env: { PATH: home.env.PATH!, HOME: home.home }, encoding: 'utf8', timeout: 60_000 });
      const output = `${r.stdout ?? ''}${r.stderr ?? ''}`;
      result(id, r.status === 0 ? output : `Exit code ${r.status}\n${output}`, r.status !== 0);
      return r.status;
    },
    say(text: string) {
      append('assistant', { role: 'assistant', id: `msg_fixture${++messages}`, content: [{ type: 'text', text }], stop_reason: 'end_turn' });
    },
  };
}
