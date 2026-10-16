import { afterEach, beforeEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const root = path.resolve(import.meta.dir, '..');
const bin = path.join(root, 'bin');
let home: string;
function run(cmd: string, args: string[], env: Record<string, string> = {}, input?: string) {
  return spawnSync(cmd, args, { cwd: home, encoding: 'utf8', input, timeout: 15000,
    env: { ...process.env, HOME: home, GSTACK_HOME: home, GSTACK_PROJECT_SLUG: 'CaseProject', ...env } });
}
function git(...args: string[]) {
  const r = run('git', args); if (r.status) throw new Error(r.stderr); return r.stdout;
}
function guard(mode = 'outgoing', slug?: string) {
  return run('python3', [path.join(bin, 'gstack-artifact-paths.py'), mode, home, ...(slug ? [slug] : [])]);
}
function tracked(names: string[]) {
  const blob = git('hash-object', '-w', '--stdin');
  // Git on macOS otherwise composes the fixture's decomposed input before
  // it reaches the index, so the test would not exercise raw Git path bytes.
  for (const name of names) git('-c', 'core.precomposeUnicode=false', 'update-index', '--add', '--cacheinfo', `100644,${blob.trim()},${name}`);
}
beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-case-')));
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

test('ordinary learnings writer refuses alternate case before appending bytes', () => {
  fs.mkdirSync(path.join(home, 'projects/CaseProject'), { recursive: true });
  const file = path.join(home, 'projects/CaseProject/learnings.jsonl');
  const original = '{"key":"old","type":"pitfall"}\n'; fs.writeFileSync(file, original);
  const r = run('bash', [path.join(bin, 'gstack-learnings-log'), JSON.stringify({skill:'review',type:'pitfall',key:'new',insight:'preserve original',confidence:9,source:'observed'})], {GSTACK_PROJECT_SLUG:'caseproject'});
  expect(r.status).not.toBe(0); expect(r.stderr).toContain('ARTIFACT_CASE_COLLISION');
  expect(fs.readFileSync(file, 'utf8')).toBe(original);
  expect(fs.readdirSync(path.join(home,'projects'))).toEqual(['CaseProject']);
});
test('Bash slug refuses two tracked aliases even when physical spelling is unique', () => {
  tracked(['projects/CaseProject/a.md', 'projects/caseproject/b.md']);
  const before = fs.readFileSync(path.join(home,'.git/index'));
  const r = run('bash', [path.join(bin,'gstack-slug'),'--get','SLUG']);
  expect(r.status).not.toBe(0); expect(r.stderr).toContain('ARTIFACT_CASE_COLLISION');
  expect(fs.readFileSync(path.join(home,'.git/index'))).toEqual(before);
});
test('native TS slug refuses the same collision without a caller fallback', () => {
  tracked(['projects/CaseProject/a.md', 'projects/caseproject/b.md']);
  const r = run(process.execPath, ['-e', `import {slugFromEnvironment} from ${JSON.stringify(path.join(root,'lib/bin-context.ts'))}; console.log(slugFromEnvironment());`]);
  expect(r.status).not.toBe(0); expect(r.stderr).toContain('ARTIFACT_CASE_COLLISION');
});
test('normal exact project spelling stays usable and does not rewrite index/config', () => {
  tracked(['projects/CaseProject/a.md']);
  const before = fs.readFileSync(path.join(home,'.git/index'));
  const config = fs.readFileSync(path.join(home,'.git/config'));
  expect(guard('slug','CaseProject').status).toBe(0); expect(guard().status).toBe(0);
  expect(fs.readFileSync(path.join(home,'.git/index'))).toEqual(before);
  expect(fs.readFileSync(path.join(home,'.git/config'))).toEqual(config);
});
test('different leaf names under case-colliding directories are rejected', () => {
  tracked(['projects/CaseProject/designs/a.md','projects/caseproject/designs/b.md']);
  const r = guard(); expect(r.status).toBe(3); expect(r.stderr).toContain('projects/caseproject');
});
test('NFC and decomposed names collide conservatively', () => {
  tracked(['projects/demo/caf\u00e9/a.md','projects/demo/cafe\u0301/b.md']);
  expect(guard().status).toBe(3);
});
test('Unicode casefold catches sharp-s variants', () => {
  tracked(['projects/demo/Stra\u00dfe/a.md','projects/demo/STRASSE/b.md']);
  expect(guard().status).toBe(3);
});
test('ordinary drain keeps the queue and index when an existing tree collides', () => {
  tracked(['projects/CaseProject/a.md','projects/caseproject/b.md']);
  git('commit','-qm','ambiguous fixture');
  run(path.join(bin,'gstack-config'),['set','artifacts_sync_mode','artifacts-only']);
  fs.mkdirSync(path.join(home,'.brain-queue.d'),{recursive:true});
  const queued = path.join(home,'.brain-queue.d','1-fixture.json');
  fs.writeFileSync(queued,JSON.stringify({path:'projects/CaseProject/a.md',ts:new Date().toISOString()})+'\n');
  const index = fs.readFileSync(path.join(home,'.git/index')); const head=git('rev-parse','HEAD');
  const r=run('bash',[path.join(bin,'gstack-brain-sync'),'--once']);
  expect(r.stderr).toContain('ARTIFACT_CASE_COLLISION'); expect(fs.existsSync(queued)).toBe(true);
  expect(git('rev-parse','HEAD')).toBe(head); expect(fs.readFileSync(path.join(home,'.git/index'))).toEqual(index);
});
test('outgoing HEAD is checked even when the index was manually made unique', () => {
  tracked(['projects/CaseProject/a.md','projects/caseproject/b.md']); git('commit','-qm','collision');
  git('update-index','--force-remove','projects/caseproject/b.md');
  expect(guard('index').status).toBe(0); expect(guard('outgoing').status).toBe(3);
});
test('project symlink is refused before writing through it', () => {
  fs.mkdirSync(path.join(home,'projects')); fs.mkdirSync(path.join(home,'target'));
  fs.symlinkSync(path.join(home,'target'),path.join(home,'projects/CaseProject'));
  expect(guard('slug','CaseProject').status).toBe(3); expect(fs.readdirSync(path.join(home,'target'))).toEqual([]);
});
test('literal newlines and pathspec characters are parsed as raw NUL paths', () => {
  tracked(['projects/demo/line\nbreak[1].md']); expect(guard().status).toBe(0);
});
test('a new empty repository is valid', () => {
  expect(guard().status).toBe(0); expect(guard('slug','CaseProject').status).toBe(0);
});
test('unknown Git state refuses rather than reporting no collisions', () => {
  fs.writeFileSync(path.join(home,'.git/index'),'invalid index');
  const r=guard(); expect(r.status).toBe(3); expect(r.stderr).toContain('ARTIFACT_GIT_READ_FAILED');
});
test('valid same-case ordinary writes preserve old bytes and append exactly once each', () => {
  fs.mkdirSync(path.join(home,'projects/CaseProject'),{recursive:true});
  const file=path.join(home,'projects/CaseProject/learnings.jsonl');
  const old='{"key":"original","type":"pitfall"}\n'; fs.writeFileSync(file,old);
  for (const id of ['first','second']) {
    const r=run('bash',[path.join(bin,'gstack-learnings-log'),JSON.stringify({skill:'review',type:'pitfall',key:id,insight:'fixture',confidence:9,source:'observed'})]);
    expect(r.status).toBe(0);
  }
  const text=fs.readFileSync(file,'utf8'); expect(text.startsWith(old)).toBe(true);
  expect(text.trimEnd().split('\n').map(x=>JSON.parse(x).key)).toEqual(['original','first','second']);
});
test('invalid UTF8 in an index is rejected explicitly without changing it', () => {
  const blob=git('hash-object','-w','--stdin').trim();
  const bytes=Buffer.concat([Buffer.from(`100644 ${blob}\tprojects/demo/`),Buffer.from([255]),Buffer.from('.md\0')]);
  const r=spawnSync('git',['-c','core.precomposeUnicode=false','update-index','-z','--index-info'],{cwd:home,input:bytes});
  expect(r.status).toBe(0); const before=fs.readFileSync(path.join(home,'.git/index'));
  const result=guard(); expect(result.status).toBe(3); expect(result.stderr).toContain('ARTIFACT_PATH_ENCODING');
  expect(fs.readFileSync(path.join(home,'.git/index'))).toEqual(before);
});
test('real decision writer propagates refusal and never creates an unknown bucket', () => {
  tracked(['projects/CaseProject/a.md','projects/caseproject/b.md']);
  const r=run(path.join(bin,'gstack-decision-log'),[JSON.stringify({decision:'fixture',rationale:'fixture',scope:'branch',source:'skill',confidence:8})]);
  expect(r.status).not.toBe(0); expect(r.stderr).toContain('ARTIFACT_CASE_COLLISION');
  expect(fs.existsSync(path.join(home,'projects/unknown'))).toBe(false);
  expect(fs.existsSync(path.join(home,'projects/CaseProject/decisions.jsonl'))).toBe(false);
});
test('TS refusal does not upgrade an old slug cache before checking identity', () => {
  tracked(['projects/CaseProject/a.md','projects/caseproject/b.md']);
  const cache=path.join(home,'slug-cache',home.replaceAll('/','_'));
  fs.mkdirSync(path.dirname(cache)); fs.writeFileSync(cache,'CaseProject');
  const r=run(process.execPath,['-e',`import {slugFromEnvironment} from ${JSON.stringify(path.join(root,'lib/bin-context.ts'))}; slugFromEnvironment();`],{GSTACK_PROJECT_SLUG:''});
  expect(r.status).not.toBe(0); expect(fs.readFileSync(cache,'utf8')).toBe('CaseProject');
});
test('post-stage guard rejects a requested alias that Git did not stage exactly', () => {
  tracked(['projects/CaseProject/a.md']);
  const requested=path.join(home,'requested.txt'); fs.writeFileSync(requested,'projects/caseproject/a.md\n');
  const r=run('python3',[path.join(bin,'gstack-artifact-paths.py'),'staged',home,requested]);
  expect(r.status).toBe(3); expect(r.stderr).toContain('ARTIFACT_STAGED_PATH_MISMATCH');
});
test('LF-delimited staged requests preserve Unicode separator characters inside names', () => {
  const names=[String.fromCharCode(0x2028),String.fromCharCode(0x85),'\v','\f'].map(c=>`projects/CaseProject/ceo-plans/alpha${c}beta.md`);
  tracked(names);
  const requested=path.join(home,'requested.txt'); fs.writeFileSync(requested,names.join('\n')+'\n');
  const r=run('python3',[path.join(bin,'gstack-artifact-paths.py'),'staged',home,requested]);
  expect(r.status).toBe(0);
});
test('two individually valid branches can merge into a forbidden outgoing tree', () => {
  fs.writeFileSync(path.join(home,'base.md'),'base'); git('add','base.md'); git('commit','-qm','base');
  git('branch','other');
  tracked(['projects/CaseProject/a.md']); git('commit','-qm','upper branch'); expect(guard().status).toBe(0);
  git('checkout','-q','other'); tracked(['projects/caseproject/b.md']); git('commit','-qm','lower branch'); expect(guard().status).toBe(0);
  git('merge','--no-edit','main'); expect(guard().status).toBe(3);
});
test('ordinary rejected-push merge keeps its queue and never sends the combined collision', () => {
  const remote=path.join(home,'remote.git'), other=path.join(home,'other');
  git('init','--bare','-q','-b','main',remote);
  fs.writeFileSync(path.join(home,'base.md'),'base'); git('add','base.md'); git('commit','-qm','base');
  git('remote','add','origin',remote); git('push','-qu','origin','main');
  git('clone','-q',remote,other);
  const otherGit=(...args: string[])=>git('-C',other,...args);
  otherGit('config','user.name','Fixture'); otherGit('config','user.email','fixture@example.invalid');
  const lower='projects/caseproject/ceo-plans/b.md', upper='projects/CaseProject/ceo-plans/a.md';
  fs.mkdirSync(path.dirname(path.join(other,lower)),{recursive:true}); fs.writeFileSync(path.join(other,lower),'remote plan');
  otherGit('add',lower); otherGit('commit','-qm','other device'); otherGit('push','-q');
  const remoteHead=otherGit('rev-parse','HEAD');
  expect(run(path.join(bin,'gstack-config'),['set','artifacts_sync_mode','artifacts-only']).status).toBe(0);
  fs.writeFileSync(path.join(home,'.brain-allowlist'),'projects/*/ceo-plans/*.md\n');
  fs.writeFileSync(path.join(home,'.brain-privacy-map.json'),JSON.stringify([{pattern:'projects/*/ceo-plans/*.md',class:'artifact'}]));
  fs.mkdirSync(path.dirname(path.join(home,upper)),{recursive:true}); fs.writeFileSync(path.join(home,upper),'local plan');
  expect(run(path.join(bin,'gstack-brain-enqueue'),[upper]).status).toBe(0);
  const queue=path.join(home,'.brain-queue.d'); const queued=fs.readdirSync(queue).filter(x=>x.endsWith('.json'));
  expect(queued.length).toBe(1);
  const r=run('bash',[path.join(bin,'gstack-brain-sync'),'--once']);
  if(r.status!==1) throw new Error(JSON.stringify({status:r.status,stderr:r.stderr,stdout:r.stdout,sync:fs.existsSync(path.join(home,'.brain-sync-status.json'))?fs.readFileSync(path.join(home,'.brain-sync-status.json'),'utf8'):null}));
  expect(r.status).toBe(1); expect(r.stderr).toContain('ARTIFACT_CASE_COLLISION');
  expect(git('--git-dir='+remote,'rev-parse','main')).toBe(remoteHead);
  expect(fs.readdirSync(queue).filter(x=>x.endsWith('.json'))).toEqual(queued);
  expect(fs.readFileSync(path.join(home,upper),'utf8')).toBe('local plan');
  expect(guard().status).toBe(3);
}, 30000);

// v37: checks and the first physical directory creation are one critical
// section, shared with the existing artifact Git writer lock.
test('first project creation with competing case spellings admits one identity', async () => {
  const spellings = Array.from({length: 8}, (_, i) => i % 2 ? 'caseproject' : 'CaseProject');
  const calls = spellings.map(slug => Bun.spawn(['python3', path.join(bin,'gstack-artifact-paths.py'), 'claim', home, slug], {
    cwd: home, env: {...process.env, HOME:home, GSTACK_HOME:home}, stdout:'pipe', stderr:'pipe',
  }));
  const results = await Promise.all(calls.map(async (p,i) => ({slug:spellings[i], code:await p.exited, error:await new Response(p.stderr).text()})));
  const accepted = results.filter(r=>r.code===0); expect(accepted.length).toBe(4);
  expect(new Set(accepted.map(r=>r.slug)).size).toBe(1);
  expect(results.filter(r=>r.code!==0).every(r=>r.error.includes('ARTIFACT_CASE_COLLISION'))).toBe(true);
  expect(fs.readdirSync(path.join(home,'projects'))).toEqual([accepted[0].slug!]);
  expect(fs.existsSync(path.join(home,'.brain-sync.lock.d'))).toBe(false);
});
test('ambiguous stale ownership is preserved rather than reclaimed', () => {
  const lock=path.join(home,'.brain-sync.lock.d'); fs.mkdirSync(lock);
  fs.writeFileSync(path.join(lock,'pid'),'999999999\n'); fs.writeFileSync(path.join(lock,'owner'),'preserve-me\n');
  const r=run('bash',['-c', 'source "$1"; gstack_brain_lock_acquire "$2" try', 'fixture',path.join(bin,'gstack-brain-lock.sh'),home]);
  expect(r.status).not.toBe(0); expect(fs.readFileSync(path.join(lock,'owner'),'utf8')).toBe('preserve-me\n');
});
test('Git routing variables cannot redirect a path inspection', () => {
  tracked(['projects/CaseProject/a.md','projects/caseproject/b.md']);
  const other=path.join(home,'other'); fs.mkdirSync(other); run('git',['init','-q',other]);
  const r=run('python3',[path.join(bin,'gstack-artifact-paths.py'),'index',home],{GIT_DIR:path.join(other,'.git'),GIT_INDEX_FILE:path.join(other,'.git/index'),GIT_WORK_TREE:other});
  expect(r.status).toBe(3); expect(r.stderr).toContain('ARTIFACT_CASE_COLLISION');
});
for (const caller of ['gstack-timeline-log','gstack-review-log','gstack-question-log','gstack-question-preference','gstack-distill-apply','gstack-distill-free-text']) {
  test(`${caller} propagates the guard even with an inherited SLUG`, () => {
    fs.mkdirSync(path.join(home,'projects/CaseProject'),{recursive:true});
    const r=run('bash',[path.join(bin,caller),'{}'],{GSTACK_PROJECT_SLUG:'caseproject',SLUG:'inherited-poison'});
    expect(r.status).not.toBe(0); expect(r.stderr).toContain('ARTIFACT_CASE_COLLISION');
    expect(fs.readdirSync(path.join(home,'projects'))).toEqual(['CaseProject']);
  });
}
test('daemon explicit identity is not exempt from the shared project guard', () => {
  fs.mkdirSync(path.join(home,'projects/CaseProject'),{recursive:true});
  const r=run(process.execPath,['-e',`import {getCurrentProjectSlug} from ${JSON.stringify(path.join(root,'browse/src/project-slug.ts'))}; console.log(getCurrentProjectSlug());`],{GSTACK_PROJECT_SLUG:'caseproject'});
  expect(r.status).not.toBe(0); expect(r.stderr).toContain('ARTIFACT_CASE_COLLISION');
  expect(fs.readdirSync(path.join(home,'projects'))).toEqual(['CaseProject']);
});

test('untracked Projects root refuses before creating a project identity', () => {
  fs.mkdirSync(path.join(home,'Projects'));
  const r=guard('claim','CaseProject');
  expect(r.status).toBe(3); expect(r.stderr).toContain('ARTIFACT_CASE_COLLISION');
  expect(fs.readdirSync(path.join(home,'Projects'))).toEqual([]);
});

test('inherited owner token cannot concurrently create the first bucket', async () => {
 const lock=path.join(home,'.brain-sync.lock.d'),token='parent-owned-test-token';fs.mkdirSync(lock);
 fs.writeFileSync(path.join(lock,'pid'),String(process.pid));fs.writeFileSync(path.join(lock,'owner'),token);
 const runs=['CaseProject','caseproject'].map(slug=>Bun.spawn(['python3',path.join(bin,'gstack-artifact-paths.py'),'claim',home,slug],{env:{...process.env,GSTACK_BRAIN_LOCK_TOKEN:token},stdout:'pipe',stderr:'pipe'}));
 const codes=await Promise.all(runs.map(p=>p.exited));expect(codes).toEqual([3,3]);expect(fs.existsSync(path.join(home,'projects'))).toBe(false);
 fs.mkdirSync(path.join(home,'projects/CaseProject'),{recursive:true});
 expect(run('python3',[path.join(bin,'gstack-artifact-paths.py'),'claim',home,'CaseProject'],{GSTACK_BRAIN_LOCK_TOKEN:token}).status).toBe(0);
 expect(fs.readFileSync(path.join(lock,'owner'),'utf8')).toBe(token);
});
test('a matching stale token does not bypass unknown-owner refusal', () => {
 const lock=path.join(home,'.brain-sync.lock.d'),token='dead-owner-token';fs.mkdirSync(lock);
 fs.writeFileSync(path.join(lock,'pid'),'999999999');fs.writeFileSync(path.join(lock,'owner'),token);
 const r=run('python3',[path.join(bin,'gstack-artifact-paths.py'),'claim',home,'CaseProject'],{GSTACK_BRAIN_LOCK_TOKEN:token});
 expect(r.status).toBe(3);expect(r.stderr).toContain('ARTIFACT_IDENTITY_OWNER_UNVERIFIED');expect(fs.existsSync(path.join(home,'projects'))).toBe(false);
});
