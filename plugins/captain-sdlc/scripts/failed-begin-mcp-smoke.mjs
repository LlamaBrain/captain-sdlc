import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const root=path.resolve(process.argv[2]??path.join(import.meta.dirname,'..'));
const fixture=await mkdtemp(path.join(tmpdir(),'captain-failed-begin-mcp-'));
const target=path.join(fixture,'retained target'),source=path.join(fixture,'retained task'),dataRoot=path.join(fixture,'authority');
const exec=promisify(execFile),sha=data=>createHash('sha256').update(data).digest('hex');
const git=async(cwd,...args)=>(await exec('git',['--no-optional-locks',...args],{cwd,windowsHide:true})).stdout.trim();
async function tree(root){
 const result={};async function walk(directory,relative=''){
  for(const entry of(await readdir(directory,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){
   const name=relative?`${relative}/${entry.name}`:entry.name;
   if(entry.isDirectory())await walk(path.join(directory,entry.name),name);else result[name]=sha(await readFile(path.join(directory,entry.name)));
  }
 }await walk(root);return result;
}
await mkdir(path.join(target,'.captain-sdlc/notebook'),{recursive:true});
await git(target,'init','-b','main');await git(target,'config','core.autocrlf','false');
await git(target,'config','user.name','Captain Fixture');await git(target,'config','user.email','captain@example.invalid');
await writeFile(path.join(target,'.gitignore'),'Temp/\n.captain-sdlc/worktrees/\n');await writeFile(path.join(target,'product.txt'),'base\n');
await writeFile(path.join(target,'VERSION'),'1.0.0\n');await writeFile(path.join(target,'CHANGELOG.md'),'baseline\n');
await writeFile(path.join(target,'.captain-sdlc/notebook/notes.json'),'{}\n');
await writeFile(path.join(target,'.captain-sdlc/captain.ignore'),'/.captain-sdlc/notebook/notes.json\n');
await writeFile(path.join(target,'.captain-sdlc/codex-policy.json'),JSON.stringify({profile:'low',visualRequired:false,sourceManifestExcludes:['Temp'],
 commands:Object.fromEntries(['build','ticket','feature-smoke','affected-regression'].map(name=>[name,'node gate.cjs'])),
 commit:{conventional:true,require_version_suffix:false,require_task_trailer:true,version_file:'VERSION',version_surfaces:[],changelog_files:['CHANGELOG.md'],bookkeeping:{path_file:'.captain-sdlc/captain.ignore'}}}));
await writeFile(path.join(target,'.captain-sdlc/merge-policy.json'),JSON.stringify({schema_version:1,strictness:'low'}));
await writeFile(path.join(target,'gate.cjs'),"const fs=require('node:fs');fs.mkdirSync('Temp',{recursive:true});const p='Temp/build-count';fs.writeFileSync(p,String(Number(fs.existsSync(p)?fs.readFileSync(p,'utf8'):0)+1));if(fs.existsSync('Temp/fail-build'))throw new Error('Fixture requested bounded build failure');console.log('passed');\n");
await git(target,'add','.');await git(target,'commit','-m','fixture base');await git(target,'worktree','add','-b','retained-task',source);
await writeFile(path.join(source,'product.txt'),'implemented\n');await git(source,'commit','-am','fixture product');
let registry=await git(target,'worktree','list','--porcelain'),targetHead=await git(target,'rev-parse','HEAD');
const client=new Client({name:'captain-failed-begin-smoke',version:'1'});
const transport=new StdioClientTransport({command:process.execPath,args:[path.join(root,'dist/server.js')],cwd:root,
 env:{...process.env,CAPTAIN_PLUGIN_DATA:dataRoot,CODEX_PLUGIN_ROOT:root,PLUGIN_ROOT:root},stderr:'pipe'});
async function call(name,args,expectError=false){
 const response=await client.callTool({name,arguments:args},undefined,{timeout:600000});
 if(expectError){assert.equal(response.isError,true);return response;}
 assert.notEqual(response.isError,true,JSON.stringify(response));return response.structuredContent??JSON.parse(response.content.find(item=>item.type==='text').text);
}
try{
 await client.connect(transport);const names=(await client.listTools()).tools.map(tool=>tool.name);
 assert.ok(names.includes('captain_failed_begin_lease_diagnose'));assert.ok(names.includes('captain_repossess_failed_begin'));
 await mkdir(path.join(source,'Temp'),{recursive:true});await writeFile(path.join(source,'Temp/fail-build'),'fixture-only\n');
 const idleMerge=await call('captain_merge_prep',{source_worktree:source,target_worktree:target,target_branch:'main',session_id:'idle-merge-fixture-owner'});assert.equal(idleMerge.state,'failed');
 await (await import('node:fs/promises')).unlink(path.join(source,'Temp/fail-build'));
 await writeFile(path.join(target,'.captain-sdlc/notebook/notes.json'),'{"dormant":"retained"}\n');
 let dormant=await call('captain_merge_prep',{source_worktree:source,target_worktree:target,target_branch:'main',session_id:'dormant-ready-owner',finalization:{target:{paths:['.captain-sdlc/notebook/notes.json'],task_id:'dormant-records',subject:'docs(captain): retain dormant records',disposition:'stash'}}});
 assert.equal(dormant.state,'ready');assert.equal(dormant.finalizations[0].state,'stashed');
 for(let round=1;round<=2;round++){
  await writeFile(path.join(source,'.captain-sdlc/notebook/notes.json'),JSON.stringify({historical_source_round:round})+'\n');
  dormant=await call('captain_merge_prep',{merge_id:dormant.merge_id,source_worktree:source,target_worktree:target,target_branch:'main',session_id:'dormant-ready-owner',finalization:{source:{paths:['.captain-sdlc/notebook/notes.json'],task_id:'dormant-records',subject:'docs(captain): retain source history',disposition:'commit'}}});
  assert.equal(dormant.state,'ready');
 }
 assert.equal(dormant.finalizations.length,3);
 registry=await git(target,'worktree','list','--porcelain');

 const issued=await call('captain_issue_intent',{project_root:source,target_branch:'main',session_id:'old-fixture-owner',turn_id:'old-turn',prompt:'Repair the fixture product',action:'start',task_id:'old-fixture-task'});
 const oldRequest={project_root:source,intent_id:issued.intent_id,objective:'Repair the fixture product',task_id:'old-fixture-task'};
 const failed=await call('captain_begin_implementation',oldRequest,true);
 assert.match(JSON.stringify(failed),/outside the canonical worktree container/);
 assert.equal(await git(target,'worktree','list','--porcelain'),registry);
 await git(target,'branch','unrelated-base');
 const unrelated=await call('captain_issue_intent',{project_root:target,target_branch:'unrelated-base',session_id:'old-fixture-owner',turn_id:'unrelated-paused-turn',prompt:'Retain an unrelated fixture task for a later human continuation',action:'start',task_id:'unrelated-paused-fixture'});
 const unrelatedRun=await call('captain_begin_implementation',{project_root:target,intent_id:unrelated.intent_id,objective:'Retain an unrelated fixture task for a later human continuation',task_id:'unrelated-paused-fixture'});
 await call('captain_pause_implementation',{intent_id:unrelated.intent_id,summary:'Fixture operator explicitly pauses this separate task while another request is recovered',next_steps:['Wait for fixture operator continuation'],context:'This retained paused task must not be changed by failed-Begin lease recovery'});
 const unrelatedState=await call('captain_status',{intent_id:unrelated.intent_id});
 assert.equal(unrelatedState.status,'paused');
 const unrelatedBefore=await tree(unrelatedRun.worktreePath);
 const originalTargetHead=targetHead;
 await git(target,'commit','--allow-empty','-m','fixture target advances after failed Begin');
 await git(source,'merge','--no-edit','main');
 targetHead=await git(target,'rev-parse','HEAD');assert.notEqual(targetHead,originalTargetHead);
 registry=await git(target,'worktree','list','--porcelain');
 const note='.captain-sdlc/notebook/notes.json';await writeFile(path.join(source,note),'{"source":"kept"}\n');await writeFile(path.join(target,note),'{"target":"kept"}\n');
 const targetBefore=await tree(target),sourceBefore=await tree(source),authorityBefore=await tree(dataRoot);
 const idleStateBefore=await call('captain_merge_status',{merge_id:idleMerge.merge_id,session_id:'idle-merge-fixture-owner'});
 const args={project_root:target,target_worktree:target,target_branch:'main',session_id:'current-operator'};
 const orphan=await call('captain_branch_lease_diagnose',args);assert.equal(orphan.eligible,false);assert.equal(orphan.reason,'surviving_authority');
 const diagnosis=await call('captain_failed_begin_lease_diagnose',args);
 assert.equal(diagnosis.original_state.idle_superseded_merge_records_verified,1);
 assert.equal(diagnosis.eligible,true);assert.equal(diagnosis.verified_pre_workspace,true);assert.equal(diagnosis.original_session_match,'other');assert.equal(diagnosis.recovery.args.expected_head,targetHead);assert.equal(diagnosis.original_state.later_state.active,true);assert.equal(diagnosis.original_state.session_activity.correlated_run_status,'paused');assert.equal(diagnosis.original_state.session_activity.correlated_run_owns_actual_target,false);
 assert.doesNotMatch(JSON.stringify(diagnosis),/old-fixture-owner|"leaseToken"\s*:|"operationToken"\s*:/);assert.deepEqual(await tree(dataRoot),authorityBefore);
 const request={...diagnosis.recovery.args,reason:'Retire the terminal wrong-root Begin reservation without replacing checkouts',user_authorization:'Unblock it. Repossess the lease and keep the same worktree.'};
 await call('captain_repossess_failed_begin',{...request,resource_generation:'f'.repeat(64)},true);assert.deepEqual(await tree(dataRoot),authorityBefore);
 const receipt=await call('captain_repossess_failed_begin',request);assert.equal(receipt.state,'revoked');
 assert.doesNotMatch(JSON.stringify(receipt),/old-fixture-owner|"leaseToken"\s*:|"operationToken"\s*:|confirm_owner_stopped/);
 assert.deepEqual(await tree(target),targetBefore);assert.deepEqual(await tree(source),sourceBefore);
 assert.deepEqual(await call('captain_repossess_failed_begin',request),receipt);
 assert.deepEqual(await tree(unrelatedRun.worktreePath),unrelatedBefore);assert.deepEqual(await call('captain_status',{intent_id:unrelated.intent_id}),unrelatedState);
 const dormantAfter=await call('captain_merge_status',{merge_id:dormant.merge_id,session_id:'dormant-ready-owner'});
 for(const key of ['state','revision','source_binding','target_binding','gates','finalizations'])assert.deepEqual(dormantAfter[key],dormant[key]);
 const idleStateAfter=await call('captain_merge_status',{merge_id:idleMerge.merge_id,session_id:'idle-merge-fixture-owner'});
 for(const key of ['state','revision','source_binding','target_binding','gates'])assert.deepEqual(idleStateAfter[key],idleStateBefore[key]);
 const retry=await call('captain_begin_implementation',oldRequest,true);assert.match(JSON.stringify(retry),/cancelled|repossessed|revoked/);
 assert.deepEqual(await tree(target),targetBefore);assert.deepEqual(await tree(source),sourceBefore);
 const selection={paths:[note],task_id:'kept-records',subject:'docs(captain): retain task records',disposition:'commit'};
 const buildsBeforeRecoveredPrep=Number(await readFile(path.join(source,'Temp/build-count'),'utf8'));
 const ready=await call('captain_merge_prep',{source_worktree:source,target_worktree:target,target_branch:'main',session_id:'current-operator',finalization:{source:selection,target:{...selection,disposition:'stash'}}});
 assert.equal(ready.state,'ready');assert.equal(ready.source_worktree,source);assert.equal(ready.target_worktree,target);
 const identities=value=>value.split(/\r?\n/).filter(line=>!line.startsWith('HEAD ')).join('\n');
 assert.equal(identities(await git(target,'worktree','list','--porcelain')),identities(registry));assert.equal(await git(target,'rev-parse','HEAD'),targetHead);
 assert.equal(Number(await readFile(path.join(source,'Temp/build-count'),'utf8')),buildsBeforeRecoveredPrep+1);
 const stash=ready.finalizations.find(item=>item.state==='stashed');assert.ok(stash?.stash_oid);assert.equal(await git(target,'show',`${stash.stash_oid}:${note}`),'{"target":"kept"}');
 const proofPath=path.join(root,'.captain-proof/smoke.json'),proof=JSON.parse(await readFile(proofPath,'utf8'));
 proof.failed_begin={status:'green',created_at:new Date().toISOString(),server_sha256:sha(await readFile(path.join(root,'dist/server.js'))),fixture,
  outcomes:['superseded ready receipt retains three authenticated bookkeeping generations during exact recovery','actual signed wrong-root Begin fails before any new checkout','orphan path protects surviving records','read-only operator diagnosis verifies original different-session graph after legitimate target advance',
   'exact revocation preserves dirty checkouts, unrelated paused task and idle failed merge while old Begin stays cancelled','same worktree Prep acquires fresh lease, builds once and retains correlated stash']};
 await writeFile(proofPath,JSON.stringify(proof,null,2)+'\n');console.log(JSON.stringify(proof.failed_begin));
}finally{await client.close();}
