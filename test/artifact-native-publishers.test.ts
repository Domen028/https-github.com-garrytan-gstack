import {expect, test} from 'bun:test';
import {spawnSync} from 'node:child_process';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {render, renderWithAside, renderWithBrowse} from '../lib/aside-render';
import {generate} from '../make-pdf/src/orchestrator';
import {renderPdf} from '../make-pdf/src/asideClient';
import {printWithTocPages} from '../make-pdf/src/toc-pages';
import {main as designMain} from '../bin/gstack-design-md';
import {amendImplementation, initializePlan, prepareMethodology, createSnapshot, prepareAmendedInput, preparePhaseClose} from '../bin/gstack-autoplan-snapshot';
import {writeSkill} from '../browse/src/domain-skills';
import {withArtifactPathsWrite} from '../lib/artifact-window';
const helper=join(import.meta.dir,'../bin/gstack-artifact-window.py');
const check=process.platform==='win32'?test.skip:test;
function invoke(root:string,action:string,slug:string,...args:string[]) {
 const p=spawnSync('python3',[helper,action,root,slug,...args],{encoding:'utf8',timeout:10000});
 expect(p.status,p.stderr).toBe(0); return JSON.parse(p.stdout);
}
async function fixture(run:(root:string)=>unknown) {
 const root=mkdtempSync(join(tmpdir(),'artifact-native-'));const prior=process.env.GSTACK_STATE_ROOT;process.env.GSTACK_STATE_ROOT=root;
 try {await run(root);} finally {if(prior===undefined)delete process.env.GSTACK_STATE_ROOT;else process.env.GSTACK_STATE_ROOT=prior;rmSync(root,{recursive:true,force:true});}
}
check('direct native publishers refuse before input read, rendering, backup, or plan mutation',()=>fixture(async root=>{
 const dir=join(root,'projects','Project');mkdirSync(dir,{recursive:true});
 const file=join(dir,'DESIGN.md');writeFileSync(file,'retained original bytes');
 const held=invoke(root,'begin','Project');let renders=0;
 const spec={file:join(root,'missing.html'),steps:[{kind:'pdf' as const,out:join(dir,'out.pdf')}]};
 for(const op of [()=>render(spec),()=>renderWithAside(spec),()=>renderWithBrowse(spec,null),
   ()=>generate({input:join(root,'missing.md'),output:join(dir,'out.pdf')}),
   ()=>renderPdf('html',{output:join(dir,'out.pdf')},async()=>{renders++;throw new Error('should not render');}),
   ()=>printWithTocPages('no toc',join(dir,'out.pdf'),async()=>{renders++;})]) {
  await expect(op()).rejects.toThrow('ARTIFACT_WINDOW_HELD');
 }
 for(const op of [()=>designMain(['convert',file,'--write']),()=>designMain(['mark','legacy-keep',file]),
  ()=>amendImplementation('ceo',file,'missing'),()=>initializePlan('missing',file,join(dir,'restore.md')),
  ()=>prepareMethodology('ceo','missing',file),()=>createSnapshot('ceo','missing',file,'missing'),
  ()=>prepareAmendedInput('ceo',file,'missing',file,'missing'),()=>preparePhaseClose('ceo',file,'missing',file,'missing')]) {
  expect(op).toThrow('ARTIFACT_WINDOW_HELD');
 }
 expect(renders).toBe(0);expect(readFileSync(file,'utf8')).toBe('retained original bytes');
 expect(existsSync(file+'.legacy.bak')).toBe(false);expect(existsSync(join(dir,'out.pdf'))).toBe(false);
 invoke(root,'end','Project','--id',held.id);
}));
check('a second destination held prevents writes to the first destination',()=>fixture(async root=>{
 const a=join(root,'projects','A','a'),b=join(root,'projects','B','b');
 mkdirSync(join(root,'projects','A'),{recursive:true});mkdirSync(join(root,'projects','B'),{recursive:true});
 const held=invoke(root,'begin','B');let called=false;
 expect(()=>withArtifactPathsWrite([a,b],()=>{called=true;writeFileSync(a,'partial');})).toThrow('ARTIFACT_WINDOW_HELD');
 expect(called).toBe(false);expect(existsSync(a)).toBe(false);
 await expect(renderWithBrowse({file:'missing',steps:[{kind:'pdf',out:a},{kind:'pdf',out:b}]},null)).rejects.toThrow('ARTIFACT_WINDOW_HELD');
 expect(()=>initializePlan('missing',a,b)).toThrow('ARTIFACT_WINDOW_HELD');
 const first=invoke(root,'begin','A');expect(first.state).toBe('exclusive');invoke(root,'end','A','--id',first.id);
 invoke(root,'end','B','--id',held.id);
}));
check('all destination leases survive asynchronous nested work until settlement',()=>fixture(async root=>{
 const a=join(root,'projects','A','out'),b=join(root,'projects','B','out');
 let done!:()=>void;const wait=new Promise<void>(resolve=>{done=resolve;});
 const work=withArtifactPathsWrite([a,b],async()=>withArtifactPathsWrite([a],async()=>wait));
 const ha=invoke(root,'begin','A'),hb=invoke(root,'begin','B');expect(ha.state).toBe('draining');expect(hb.state).toBe('draining');
 done();await work;
 expect(invoke(root,'status','A','--id',ha.id).state).toBe('exclusive');expect(invoke(root,'status','B','--id',hb.id).state).toBe('exclusive');
 invoke(root,'end','A','--id',ha.id);invoke(root,'end','B','--id',hb.id);
}));

check('an admitted async publisher may enter nested direct APIs after maintenance begins draining',()=>fixture(async root=>{
 const file=join(root,'projects','Project','doc.pdf');let proceed!:()=>void;
 const gate=new Promise<void>(resolve=>{proceed=resolve;});let rendered=0;
 const work=withArtifactPathsWrite([file],async()=>{
  await gate;
  return renderPdf('retained html',{output:file},async()=>{rendered++;return {ok:true,outputs:[],evals:{},stdout:'',engine:'browse'};});
 });
 const held=invoke(root,'begin','Project');expect(held.state).toBe('draining');
 proceed();expect(await work).toBe('browse');expect(rendered).toBe(1);
 expect(invoke(root,'status','Project','--id',held.id).state).toBe('exclusive');
 invoke(root,'end','Project','--id',held.id);
}));

check('admitted domain skill RMW finishes its second identity check while draining',()=>fixture(async root=>{
 const pending=writeSkill({host:'example.com',body:'retained skill',projectSlug:'Project',source:'human',classifierScore:0});
 const held=invoke(root,'begin','Project');expect(held.state).toBe('draining');
 expect((await pending).body).toBe('retained skill');
 expect(readFileSync(join(root,'projects','Project','learnings.jsonl'),'utf8')).toContain('retained skill');
 expect(invoke(root,'status','Project','--id',held.id).state).toBe('exclusive');
 invoke(root,'end','Project','--id',held.id);
}));

check('design publication admits the consumed source as well as every destination',()=>fixture(root=>{
 const source=join(root,'projects','Held','staged.png');mkdirSync(join(root,'projects','Held'),{recursive:true});writeFileSync(source,'received paid bytes');
 const held=invoke(root,'begin','Held');
 for(const destination of [join(root,'outside.png'),join(root,'projects','Other','published.png')]) {
  const result=spawnSync('sh',[join(import.meta.dir,'../bin/gstack-design-claim'),source,destination],{env:process.env,encoding:'utf8',timeout:10000});
  expect(result.status).toBe(1);expect(result.stderr).toContain('ARTIFACT_WINDOW_HELD');expect(existsSync(destination)).toBe(false);expect(readFileSync(source,'utf8')).toBe('received paid bytes');
 }
 expect(invoke(root,'status','Held','--id',held.id).state).toBe('exclusive');
 invoke(root,'end','Held','--id',held.id);
}));
