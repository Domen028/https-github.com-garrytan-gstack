import {expect,test} from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {createFilePermissionRecorder,recordFilePermission,currentFilePermissionEpoch} from './helpers/plan-count-file-permission';
import {readPlanCountTranscript} from './helpers/plan-count-transcript';
import {createPlanCountPermissionGuard} from './helpers/claude-pty-runner';
import captured from './fixtures/plan-ceo-floor-toolonly-create.json';

// CI 39161502626 slice 6: the parent ran four tools, then its first Write asked to
// create the owned working plan before any assistant text or question existed.
function fixture(){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'gstack-toolonly-'));const cwd=path.join(root,'owned'),config=path.join(root,'config');fs.mkdirSync(cwd);
 const expected=path.join(cwd,captured.basename),sid=captured.sessionId,id=captured.pendingId.slice(sid.length+1);
 const journal=path.join(config,'projects','owned',sid+'.jsonl');fs.mkdirSync(path.dirname(journal),{recursive:true});
 const startedAt=Date.now()-1000;const recorder=createFilePermissionRecorder(cwd,config,expected)!;
 const native=(role:string,content:any[],session=sid)=>({cwd,sessionId:session,isSidechain:false,timestamp:new Date().toISOString(),message:{role,content}});
 const tools=(session=sid)=>captured.publicTools.map(event=>event.kind==='use'
  ? native('assistant',[{type:'tool_use',id:event.toolUseId,name:event.name,input:event.name==='Read'?{file_path:path.join(cwd,'PLAN.md')}:{command:'true'}}],session)
  : native('user',[{type:'tool_result',tool_use_id:event.toolUseId,content:'ok'}],session));
 const write=(rows:any[],file=journal)=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,rows.map(r=>JSON.stringify(r)).join('\n')+'\n');};
 write(tools());
 recordFilePermission(JSON.stringify({hook_event_name:'PreToolUse',tool_name:'Write',session_id:sid,tool_use_id:id,cwd,transcript_path:journal,
  tool_input:{file_path:expected,content:captured.writeContent}}),recorder.file,cwd,config,expected);
 const read=(screen=captured.screen)=>currentFilePermissionEpoch(recorder.file,expected,cwd,config,startedAt,readPlanCountTranscript(config,cwd),screen);
 return {root,cwd,config,sid,id,journal,native,tools,write,read,close(){recorder.dispose();fs.rmSync(root,{recursive:true,force:true});}};
}

test('a tool-only parent session authenticates its captured owned Create once',()=>{
 const f=fixture();try{
  expect(captured.recorded).toMatchObject({outcome:'timeout',transcriptCalls:0,transcriptAssistantMessages:0});
  const transcript=readPlanCountTranscript(f.config,f.cwd);
  expect(transcript).toMatchObject({status:'ready',calls:[],assistantMessages:[]});
  expect(f.read()?.pendingId).toBe(captured.pendingId);
  const guard=createPlanCountPermissionGuard();
  expect(guard(captured.screen,'',f.read())).toBe('grant');
  expect(guard(captured.screen,'',f.read())).toBe('handled');
 }finally{f.close();}
});

test('tool-only identity still requires exactly one parent session that owns the pending Write',()=>{
 const f=fixture();try{
  const foreign='11111111-2222-4333-8444-555555555555',foreignJournal=path.join(f.config,'projects','owned',foreign+'.jsonl');
  f.write(f.tools(foreign),foreignJournal);
  expect(f.read()).toBeNull();
  f.write([]);
  expect(f.read()).toBeNull();
  fs.rmSync(foreignJournal);
  expect(f.read()).toBeNull();
  f.write([...f.tools(),f.native('assistant',[{type:'tool_use',id:'other-write',name:'Write',input:{file_path:path.join(f.cwd,'other.md'),content:'x'}}])]);
  expect(f.read()).toBeNull();
 }finally{f.close();}
});

test('a tool-only session gets no credit for a changed preview or a foreign create prompt',()=>{
 const f=fixture();try{
  expect(f.read(captured.screen.replace('Validate first (recommended)','Validate later (recommended)'))).toBeNull();
  expect(f.read(captured.screen.replaceAll(captured.basename,'foreign-plan.md'))).toBeUndefined();
 }finally{f.close();}
});
