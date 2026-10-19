import assert from 'node:assert/strict';
import {existsSync,mkdirSync,mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import path from 'node:path';

// Exercise the actual Core CLI and Git ignore engine; never dispatch a worker.
const [repository,assembly]=process.argv.slice(2);
if(!repository||!assembly)throw new Error('Usage: node routing-records-smoke.mjs <repository> <Captain.Core.Cli.dll>');
const root=path.resolve(repository),cli=path.resolve(assembly);
const parent=path.join(root,'plugins','captain-sdlc','Temp','automation-scratch','routing-records');
mkdirSync(parent,{recursive:true});
const evidence=mkdtempSync(path.join(parent,'run-'));
const policy=path.join(root,'.captain-sdlc','routing-policy.json');
const result={schema_version:1,status:'running',repository:root,core_cli:cli,checks:[],created_at:new Date().toISOString()};
const invoke=(command,args)=>{const r=spawnSync(command,args,{cwd:root,encoding:'utf8',windowsHide:true});if(r.error)throw r.error;return r;};
const check=(name,action)=>{action();result.checks.push({name,status:'pass'});};
const hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
try{
 check('routing policy exists',()=>assert.ok(existsSync(policy),'missing repository routing policy'));
 assert.ok(existsSync(cli),'build the actual Captain Core CLI before running this smoke');
 result.policy_sha256=hash(policy);result.core_cli_sha256=hash(cli);
 check('actual Core schema accepts policy',()=>{const r=invoke('dotnet',[cli,'validate','routing-policy',policy]);assert.equal(r.status,0,r.stderr||r.stdout);});
 const task={schema_version:1,task_id:'M30#routing-records#abc123def456',title:'Verify project routing',source:'routing-records-smoke',status:'open',labels:['bridge']};
 const taskFile=path.join(evidence,'task.json');writeFileSync(taskFile,JSON.stringify(task));
 check('bridge-labelled task selects worker without fallback',()=>{const r=invoke('dotnet',[cli,'route',policy,taskFile]);assert.equal(r.status,0,r.stderr);assert.deepEqual(JSON.parse(r.stdout),{route:'bridge',adapter:'worker',defaulted:false});});
 writeFileSync(taskFile,JSON.stringify({...task,labels:['unrelated']}));
 check('unmatched task is rejected without worker dispatch',()=>{const r=invoke('dotnet',[cli,'route',policy,taskFile]);assert.equal(r.status,1,r.stdout);assert.match(r.stderr,/no route matched and no default_route/);});
 const invalid=path.join(evidence,'invalid-policy.json');writeFileSync(invalid,JSON.stringify({...JSON.parse(readFileSync(policy,'utf8')),schema_version:99}));
 check('actual Core rejects unsupported policy schema',()=>{const r=invoke('dotnet',[cli,'validate','routing-policy',invalid]);assert.equal(r.status,1,r.stdout);assert.match(r.stderr+r.stdout,/schema_version/);});
 const ignore=(p)=>{const r=invoke('git',['-c','core.excludesFile='+(process.platform==='win32'?'NUL':'/dev/null'),'check-ignore','--no-index','--quiet','--',p]);assert.ok(r.status===0||r.status===1,r.stderr);return r.status===0;};
 check('human configuration and governed records stay visible',()=>{for(const p of ['queue.json','routing-policy.json','route-config.json','codex-policy.json','project-policy.json','captain.ignore','notebook/notes.json','closeouts/proof.md','handoffs/task.md','handoffs/design.draft.md'])assert.equal(ignore('.captain-sdlc/'+p),false,'must remain visible: '+p);});
 check('generated machine state is ignored',()=>{for(const p of ['worktrees/ticket/task.json','daemon/state.json','runs/run.json','logs/run.log','evidence/proof.json','reviews/review.json','verifications/check.json','metrics/run.json','tasks/ticket/state.json','research/run.json','steer/command.json','trace/event.jsonl','side-store/private.json','steer-inbox.md','flay-state.json','agent.draft.md'])assert.equal(ignore('.captain-sdlc/'+p),true,'must ignore machine state: '+p);});
 result.status='pass';console.log('Routing records smoke: PASS ('+result.checks.length+' checks)');
}catch(error){result.status='fail';result.failure=String(error.message??error);console.error('Routing records smoke: FAIL: '+result.failure);process.exitCode=1;}
finally{writeFileSync(path.join(evidence,'result.json'),JSON.stringify(result,null,2));console.log('Evidence: '+path.join(evidence,'result.json'));}
