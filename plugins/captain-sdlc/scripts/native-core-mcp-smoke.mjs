// Cross-repository integration smoke. Build Captain Orchestrator and claude-release
// first, then provide CAPTAIN_ORCHESTRATOR_CLI and CAPTAIN_RELEASE_ENGINE paths.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {cpSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,realpathSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
const cli=process.env.CAPTAIN_ORCHESTRATOR_CLI,engine=process.env.CAPTAIN_RELEASE_ENGINE;
if(!cli||!engine)throw new Error('CAPTAIN_ORCHESTRATOR_CLI and CAPTAIN_RELEASE_ENGINE are required');
const plugin=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const root=mkdtempSync(path.join(realpathSync(tmpdir()),'captain-native-core-mcp-'));
const repo=path.join(root,'repo'),host=path.join(root,'host'),state=path.join(root,'release-state'),data=path.join(root,'sdk-authority');
const hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
const git=(cwd,...args)=>execFileSync('git',args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe'],windowsHide:true}).trim();
const dotnet=realpathSync(execFileSync(process.platform==='win32'?'where.exe':'which',['dotnet'],{encoding:'utf8',windowsHide:true}).trim().split(/\r?\n/)[0]);
let client;
try {
  mkdirSync(repo);mkdirSync(state);cpSync(path.dirname(cli),host,{recursive:true});
  const main=path.join(host,path.basename(cli)),dependencies=readdirSync(host).filter(name=>name!==path.basename(main)).map(name=>({path:path.join(host,name),sha256:hash(path.join(host,name))}));
  const checker={kind:'native',path:main,sha256:hash(main),executable:dotnet,executableSha256:hash(dotnet),dependencies,args:['release','check','--target-branch','dev','--authority-store',state]};
  mkdirSync(path.join(repo,'.captain-sdlc'));
  const policy={schema_version:1,commit:{mode:'branch_driven',conventional:true,require_version_suffix:false,require_task_trailer:true,version_file:'VERSION',version_surfaces:[{path:'VERSION',pattern:'(?m)^(?<version>[0-9]+\\.[0-9]+\\.[0-9]+)\\s*$'}],changelog_files:['CHANGELOG.md']},release:{branches:[{pattern:'captain/*',role:'implementation'},{pattern:'dev',role:'development'}],transitions:[{from:'captain/*',to:'dev'}],intent:{executable:process.execPath,script:path.resolve(engine),script_sha256:hash(engine),stable_baseline:'v1.0.0',contracts:['csharp_public_api'],contracts_exhaustive:true,contracts_exhaustive_reason:'The disposable fixture exports only the analyzed C# API.'}}};
  const codex={profile:'low',visualRequired:false,commands:{build:'node build.cjs',ticket:'node ticket.cjs','feature-smoke':'node ticket.cjs','affected-regression':'node ticket.cjs'},artifactPaths:{build:'artifacts/active/build.txt'},outputRetention:{schema_version:1,roots:{build:['artifacts/active']}},sourceManifestExcludes:['artifacts'],redGate:{expectedExitCodes:[1],outputPattern:'feature missing'},commitPolicyPath:'.captain-sdlc/project-policy.json',releaseIntentChecker:checker};
  writeFileSync(path.join(repo,'.captain-sdlc/project-policy.json'),JSON.stringify(policy));writeFileSync(path.join(repo,'.captain-sdlc/codex-policy.json'),JSON.stringify(codex));
  writeFileSync(path.join(repo,'.gitignore'),'/.captain-sdlc/worktrees/\n/.captain-sdlc/storage-authority/\n/artifacts/\n');
  writeFileSync(path.join(repo,'VERSION'),'1.0.0\n');writeFileSync(path.join(repo,'CHANGELOG.md'),'# Fixture changelog\n');
  writeFileSync(path.join(repo,'Api.cs'),'namespace Fixture { public class Contract { public void Before() {} } }\n');
  writeFileSync(path.join(repo,'ticket.cjs'),"if(!require('fs').existsSync('done.txt')){console.log('feature missing');process.exit(1)}\n");
  writeFileSync(path.join(repo,'build.cjs'),"const f=require('fs');f.mkdirSync('artifacts/active',{recursive:true});f.writeFileSync('artifacts/active/build.txt',f.readFileSync('Api.cs'));\n");
  git(repo,'init','-q','-b','dev');git(repo,'config','user.name','Native fixture');git(repo,'config','user.email','fixture@example.invalid');git(repo,'config','core.autocrlf','false');
  git(repo,'add','.captain-sdlc/project-policy.json','.captain-sdlc/codex-policy.json','.gitignore','VERSION','CHANGELOG.md','Api.cs','ticket.cjs','build.cjs');git(repo,'commit','-qm','chore(fixture): establish trusted base');
  const base=git(repo,'rev-parse','HEAD');git(repo,'tag','-a','v1.0.0','-m','Disposable fixture baseline');
  const env=Object.fromEntries(Object.entries(process.env).filter(([name,value])=>typeof value==='string'&&!/^CAPTAIN_.*(?:KEY|AUTHORITY)|^NODE_OPTIONS$/.test(name)));
  Object.assign(env,{CAPTAIN_PLUGIN_DATA:data,CODEX_PLUGIN_ROOT:plugin,PLUGIN_ROOT:plugin});
  const transport=new StdioClientTransport({command:process.execPath,args:[path.join(plugin,'dist/server.js')],cwd:plugin,stderr:'pipe',env});
  client=new Client({name:'native-core-integration-fixture',version:'1.0.0'});await client.connect(transport);
  const call=async(name,args,expectError=false)=>{
    const result=await client.callTool({name,arguments:args});
    if(Boolean(result.isError)!==expectError)throw new Error(name+': '+JSON.stringify(result));
    const text=result.content.filter(x=>x.type==='text').map(x=>x.text).join('\n');try{return JSON.parse(text);}catch(error){if(expectError)return {error:text};throw error;}
  };
  const issued=await call('captain_issue_intent',{action:'start',project_root:repo,session_id:'native-core-fixture-session',turn_id:'native-core-fixture-turn',task_id:'fixture#native',prompt:'Implement the native fixture API change, commit it and import the pinned dev revision into this task branch.'});
  const id=issued.intent_id,run=await call('captain_begin_implementation',{intent_id:id,project_root:repo,objective:'Implement the native fixture API change',task_id:'fixture#native'});
  const worktree=run.worktreePath;assert.ok(worktree);await call('captain_record_red',{intent_id:id});
  writeFileSync(path.join(worktree,'Api.cs'),'namespace Fixture { public class Contract {} }\n');writeFileSync(path.join(worktree,'done.txt'),'implemented\n');
  await call('captain_run_check',{intent_id:id,scope:'ticket'});
  await call('captain_commit',{intent_id:id,paths:['Api.cs','done.txt'],subject:'fix(api): retire fixture contract method',task_outcome:'Implements',final:true});
  // A concurrent integration must be imported before the worker can prove again.
  writeFileSync(path.join(repo,'concurrent.md'),'Concurrent fixture documentation.\n');git(repo,'add','concurrent.md');git(repo,'commit','-qm','docs(core): record concurrent note');const target=git(repo,'rev-parse','HEAD');
  await call('captain_prove',{intent_id:id},true);
  let status=await call('captain_status',{intent_id:id}),summary=status.evidence.filter(x=>x.scope==='release-intent').at(-1).releaseIntent;
  assert.equal(summary.status,'blocked');assert.match(summary.errors.join(' '),/target|ancestor|import/i);
  await call('captain_prepare_merge',{intent_id:id,commit_oid:target,strategy:'ort'});
  await call('captain_commit',{intent_id:id,paths:['concurrent.md'],subject:'chore(merge): import verified dev revision',task_outcome:'Implements',final:true});
  await call('captain_prove',{intent_id:id},true);
  status=await call('captain_status',{intent_id:id});summary=status.evidence.filter(x=>x.scope==='release-intent').at(-1).releaseIntent;
  assert.equal(summary.status,'needs_human',JSON.stringify(summary));assert.equal(summary.bump,'major');assert.equal(summary.policyBase,base);assert.equal(summary.base,target);
  assert.match(readFileSync(summary.humanReportPath,'utf8'),/Before/);const source=git(worktree,'rev-parse','HEAD');
  const feedback={intent_id:id,choice:'reject-major',actor:'disposable fixture operator',human_feedback:'Fixture consumer impact was reviewed; callers use the documented replacement.',all_findings:true,report_digest:summary.reportDigest,finding_digest:summary.findingDigest,reviewed_revision:source,compatibility_base:target};
  await call('captain_adjudicate_compatibility',feedback);await call('captain_prove',{intent_id:id});
  const repeated=await call('captain_adjudicate_compatibility',feedback);
  assert.equal(repeated.phase,'complete');assert.equal(repeated.status,'green');assert.equal(repeated.evidence.filter(x=>x.kind==='compatibility_feedback').length,1);
  assert.equal(readFileSync(path.join(worktree,'VERSION'),'utf8'),'1.0.0\n');assert.equal(readFileSync(path.join(worktree,'CHANGELOG.md'),'utf8'),'# Fixture changelog\n');assert.equal(git(repo,'rev-parse','HEAD'),target);
  const message=git(worktree,'log','-1','--format=%B');assert.match(message,/Implements: fixture#native/);assert.match(message,/Captain-Run:/);
  const proof={schema_version:1,status:'green',smoke:'native-core-public-mcp',server_sha256:hash(path.join(plugin,'dist/server.js')),host_sha256:hash(main),host_dependencies:dependencies.map(item=>({name:path.basename(item.path),sha256:item.sha256})),dotnet_sha256:checker.executableSha256,engine_sha256:hash(engine),policy_base:base,compatibility_base:target,source_head:source,source_tree:git(worktree,'rev-parse','HEAD^{tree}'),finding_digest:summary.findingDigest,feedback_records:1,outcomes:['unimported concurrent target refused','signed source merge imports target with frozen policy base','unmarked C# API removal enters needs_human','public exact-report feedback passes private stdin authority to real C# host','unchanged feedback is idempotent','shared version and changelog unchanged','task and Captain run footers retained']};
  const output=path.join(plugin,'Temp','automation-scratch','native-core-mcp-smoke.json');mkdirSync(path.dirname(output),{recursive:true});writeFileSync(output,JSON.stringify(proof,null,2)+'\n');console.log(JSON.stringify(proof));
} finally {
  if(client)await client.close();
  assert.ok(path.resolve(root).startsWith(path.resolve(realpathSync(tmpdir()))+path.sep));
  rmSync(root,{recursive:true,force:true});
}
