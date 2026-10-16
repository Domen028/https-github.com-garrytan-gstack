import {expect,test} from "bun:test";
import {chmodSync,copyFileSync,existsSync,unlinkSync,mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {spawnSync} from "node:child_process";

test("compiled native publishers use installation helpers and respect a held scope from a foreign cwd",()=>{
 const dir=mkdtempSync(join(tmpdir(),"artifact-compiled-")), installation=join(dir,"install"), bin=join(installation,"bin"), state=join(dir,"state"), foreign=join(dir,"foreign");
 try {
  mkdirSync(bin,{recursive:true});mkdirSync(join(installation,"browse","dist"),{recursive:true});mkdirSync(foreign);mkdirSync(state);
  const root=join(import.meta.dir,"..");
  for(const name of ["gstack-artifact-window.py","gstack-artifact-paths.py","gstack-slug","gstack-state-root.sh","gstack-remote-identity.sh"])copyFileSync(join(root,"bin",name),join(bin,name));
  chmodSync(join(bin,"gstack-slug"),0o755);
  const witness=join(bin,"helper-used");
  const windowHelper=join(bin,"gstack-artifact-window.py");
  writeFileSync(windowHelper,"from pathlib import Path; Path(__file__).with_name('helper-used').write_text('owned installation')\n"+readFileSync(windowHelper,"utf8"));
  const probe=join(dir,"probe.ts"), executable=join(installation,"browse","dist",process.platform==="win32"?"probe.exe":"probe");
  writeFileSync(probe,`import {withArtifactPathWrite} from ${JSON.stringify(join(root,"lib/artifact-window.ts"))};import {getCurrentProjectSlug} from ${JSON.stringify(join(root,"browse/src/project-slug.ts"))};import {writeFileSync} from 'node:fs';import {join} from 'node:path';const home=process.argv[2];const slug=getCurrentProjectSlug();withArtifactPathWrite(join(home,'projects',slug,'received.txt'),()=>writeFileSync(join(home,'projects',slug,'received.txt'),'retained native bytes'),home);console.log('native completed');`);
  const build=spawnSync(process.execPath,["build","--compile","--no-compile-autoload-dotenv","--no-compile-autoload-bunfig",probe,"--outfile",executable],{encoding:"utf8",timeout:60000});expect(build.status,build.stderr).toBe(0);
  // A caller-controlled GSTACK_ROOT and fake cwd/bin must never select helpers.
  mkdirSync(join(foreign,"bin"));writeFileSync(join(foreign,"bin","gstack-artifact-window.py"),"raise RuntimeError('foreign helper was executed')");
  const env={...process.env,GSTACK_STATE_ROOT:state,GSTACK_PROJECT_SLUG:"CaseProject",GSTACK_ROOT:foreign};
  const first=spawnSync(executable,[state],{cwd:foreign,env,encoding:"utf8",timeout:10000});expect(first.status,first.stderr).toBe(0);expect(first.stdout).toContain("native completed");
  const file=join(state,"projects","CaseProject","received.txt");expect(readFileSync(file,"utf8")).toBe("retained native bytes");expect(existsSync(witness)).toBe(true);unlinkSync(witness);
  const nodeBundle=join(installation,"browse","dist","probe.mjs");
  const nodeBuild=spawnSync(process.execPath,["build","--target=node",probe,"--outfile",nodeBundle],{encoding:"utf8",timeout:60000});expect(nodeBuild.status,nodeBuild.stderr).toBe(0);
  // Exact environment contract from the official build-node-server.sh: its
  // compatibility header maps each bundled import.meta.dir to browse/src.
  const nodeHeader=`import {fileURLToPath as _ftp} from 'node:url';import {dirname as _dn} from 'node:path';const __browseNodeSrcDir=_dn(_dn(_ftp(import.meta.url)))+'/src';\n`;
  writeFileSync(nodeBundle,nodeHeader+readFileSync(nodeBundle,"utf8").replaceAll('import.meta.dir','__browseNodeSrcDir'));
  const nodeFirst=spawnSync("node",[nodeBundle,state],{cwd:foreign,env,encoding:"utf8",timeout:10000});expect(nodeFirst.status,nodeFirst.stderr).toBe(0);expect(existsSync(witness)).toBe(true);
  if(process.platform!=="win32") {
   const begin=spawnSync("python3",[join(bin,"gstack-artifact-window.py"),"begin",state,"CaseProject"],{encoding:"utf8",timeout:10000});expect(begin.status,begin.stderr).toBe(0);
   const second=spawnSync(executable,[state],{cwd:foreign,env,encoding:"utf8",timeout:10000});expect(second.status).not.toBe(0);expect(second.stderr).toContain("ARTIFACT_WINDOW_HELD");
   const nodeHeld=spawnSync("node",[nodeBundle,state],{cwd:foreign,env,encoding:"utf8",timeout:10000});expect(nodeHeld.status).not.toBe(0);expect(nodeHeld.stderr).toContain("ARTIFACT_WINDOW_HELD");
   expect(readFileSync(file,"utf8")).toBe("retained native bytes");
  }
  expect(existsSync(join(foreign,"projects"))).toBe(false);
 }finally{rmSync(dir,{recursive:true,force:true});}
},90000);
