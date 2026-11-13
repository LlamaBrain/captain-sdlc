import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createHash, createHmac } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cp, lstat, mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as authority from "../src/authority.js";
import { assertReleaseIntentChecker, releaseIntentCommand } from "../src/release-intent.js";
import { LifecycleStore, type ProjectPolicy } from "../src/lifecycle.js";
import { git, loadPolicy } from "../src/workspace.js";

const context = { base:"a".repeat(40), head:"b".repeat(40), tree:"c".repeat(40) };
const roots:string[] = [];
const sha = async (file:string) => createHash("sha256").update(await readFile(file)).digest("hex");
const temporary = async () => { const root=await mkdtemp(path.join(tmpdir(),"captain-native-checker-"));roots.push(root);return root; };
let compilation:Promise<{host:string,dotnet:string}> | undefined;
async function compile() {
  compilation ??= (async()=>{
    const root=await temporary(), output=path.join(root,"compiled"), intermediate=path.join(root,"obj")+path.sep;
    const found=execFileSync(process.platform==="win32"?"where.exe":"which",["dotnet"],{encoding:"utf8",windowsHide:true}).trim().split(/\r?\n/)[0];
    const dotnet=await realpath(found);
    const project=fileURLToPath(new URL("./fixtures/NativeReleaseChecker/NativeReleaseChecker.csproj",import.meta.url));
    execFileSync(dotnet,["build",project,"--nologo","-v:q","-c","Release","-o",output,"-p:BaseIntermediateOutputPath="+intermediate],{encoding:"utf8",windowsHide:true,stdio:["ignore","pipe","pipe"]});
    return {host:output,dotnet};
  })();
  return compilation;
}
async function fixture(mode="ready") {
  const compiled=await compile(),root=await temporary(),host=path.join(root,"host"),repo=path.join(root,"repo"),store=path.join(root,"reports"),data=path.join(root,"sdk-authority");
  await cp(compiled.host,host,{recursive:true});await mkdir(repo);await mkdir(store);
  await writeFile(path.join(host,"integrity.txt"),"pinned dependency\n");
  await writeFile(path.join(store,"fixture-options.json"),JSON.stringify({mode}));
  const dll=path.join(host,"NativeReleaseChecker.dll"), dependencies=[];
  for(const name of await readdir(host))if(name!==path.basename(dll))dependencies.push({path:path.join(host,name),sha256:await sha(path.join(host,name))});
  const checker:any={kind:"native",path:dll,sha256:await sha(dll),executable:compiled.dotnet,executableSha256:await sha(compiled.dotnet),dependencies,args:["release","check","--target-branch","dev","--authority-store",store]};
  return {root,host,repo,store,data,checker};
}
const runNative=()=>{const run=(authority as any).runAuthorizedNativeReleaseIntentChecker;assert.equal(typeof run,"function","trusted parent native operation must exist");return run;};
after(async()=>{for(const root of roots.reverse()){assert.ok(path.resolve(root).startsWith(path.resolve(tmpdir())+path.sep));await rm(root,{recursive:true,force:true});}});

test("native checker receives signed context and parent authority only through private stdin",async()=>{
  const run=runNative(),f=await fixture();
  const previous=process.env.CAPTAIN_SEQUENCE_AUTH_KEY,hook=process.env.DOTNET_STARTUP_HOOKS;
  process.env.CAPTAIN_SEQUENCE_AUTH_KEY="must-not-leak";process.env.DOTNET_STARTUP_HOOKS=path.join(f.root,"untrusted.dll");
  try {
    const result=await run(f.data,f.checker,f.repo,[f.repo],context);
    assert.equal(result.exitCode,0);assert.equal(result.summary.status,"ready");
    assert.equal(result.summary.base,context.base);assert.equal(result.summary.head,context.head);assert.equal(result.summary.tree,context.tree);
    assert.equal(result.summary.coverage[0].status,"unavailable");assert.match(result.summary.coverage[0].reason,/no native contract analyzer/);
    const key=Buffer.from((await readFile(path.join(f.data,"authority.key"),"utf8")).trim(),"base64");
    assert.equal((await readFile(path.join(f.store,"authority-proof.txt"),"utf8")).trim(),createHmac("sha256",key).update(context.base).digest("hex").toUpperCase());
    assert.ok(!JSON.stringify(result).includes(key.toString("base64")));assert.ok(!releaseIntentCommand(f.checker).includes(key.toString("base64")));
  } finally {if(previous===undefined)delete process.env.CAPTAIN_SEQUENCE_AUTH_KEY;else process.env.CAPTAIN_SEQUENCE_AUTH_KEY=previous;if(hook===undefined)delete process.env.DOTNET_STARTUP_HOOKS;else process.env.DOTNET_STARTUP_HOOKS=hook;}
});

test("native policy preserves its executable and complete dependency pins from the trusted base",async()=>{
  const f=await fixture();await mkdir(path.join(f.repo,".captain-sdlc"));
  const policy={profile:"low",visualRequired:false,commands:{build:"node -e 0",ticket:"node -e 0","feature-smoke":"node -e 0","affected-regression":"node -e 0"},releaseIntentChecker:f.checker,commit:{mode:"branch_driven",conventional:true,require_version_suffix:false,version_file:"VERSION",version_surfaces:[{path:"VERSION",pattern:"^(?<version>[0-9]+\\.[0-9]+\\.[0-9]+)$"}],changelog_files:["CHANGELOG.md"]}};
  await writeFile(path.join(f.repo,".captain-sdlc/codex-policy.json"),JSON.stringify(policy));await writeFile(path.join(f.repo,"VERSION"),"1.0.0");await writeFile(path.join(f.repo,"CHANGELOG.md"),"# Changelog\n");
  await git(["init","-b","feat/native"],f.repo);await git(["config","user.name","Fixture"],f.repo);await git(["config","user.email","fixture@example.invalid"],f.repo);await git(["add","."],f.repo);await git(["commit","-m","chore: fixture"],f.repo);
  const loaded=await loadPolicy(f.repo,await git(["rev-parse","HEAD"],f.repo));
  assert.deepEqual(loaded.releaseIntentChecker,f.checker);
});

test("native trust rejects scripts, executable substitution, new dependencies and argument overrides before opening authority",async()=>{
  const run=runNative(),f=await fixture(),script=path.join(f.root,"script.mjs");await writeFile(script,"process.stdin.on('data',()=>process.exit(0));");
  await assert.rejects(run(f.data,{...f.checker,path:script,sha256:await sha(script)},f.repo,[f.repo],context),/managed|assembly|DLL/i);
  await assert.rejects(assertReleaseIntentChecker({...f.checker,executable:process.execPath,executableSha256:await sha(process.execPath)},[f.repo]),/dotnet|native/i);
  await assert.rejects(assertReleaseIntentChecker({...f.checker,args:[...f.checker.args,"--project-root",f.repo]},[f.repo]),/argument|context/i);
  await writeFile(path.join(f.host,"untracked.dll"),"injected");
  await assert.rejects(run(f.data,f.checker,f.repo,[f.repo],context),/file set|dependenc|integrity/i);
  await assert.rejects(lstat(path.join(f.data,"authority.key")),/ENOENT/);
});

for(const mode of ["stale","wrong_policy","bad_digest","leak","mutate"])test("native checker fails closed for "+mode,async()=>{
  const run=runNative(),f=await fixture(mode);
  await assert.rejects(run(f.data,f.checker,f.repo,[f.repo],context),/context|revision|digest|authority|integrity/i);
});

async function governed(mode="major") {
  const f=await fixture(mode),worktree=path.join(f.repo,".captain-sdlc","worktrees","native"),intent="native";
  await mkdir(worktree,{recursive:true});await writeFile(path.join(worktree,"build.txt"),"prior build");
  let head=context.base;
  const binding={branch:"captain/native",commonGitDir:path.join(f.repo,".git"),gitDir:path.join(f.repo,".git","worktrees","native")};
  const probe=async()=>({head,tree:context.tree,status:"",branchHead:head,topLevel:worktree,...binding});
  const runner=async(command:string)=>{if(command==="build")await writeFile(path.join(worktree,"build.txt"),"verified build");return {exitCode:command==="ticket"?1:0,stdout:command,stderr:""};};
  const policy:ProjectPolicy={profile:"low",visualRequired:false,commands:{build:"build",ticket:"ticket","release-intent":releaseIntentCommand(f.checker)},artifactPaths:{build:"build.txt"},redGate:{expectedExitCodes:[1],outputPattern:"ticket"},releaseIntentChecker:f.checker,commit:{mode:"branch_driven",conventional:true,require_version_suffix:false,version_file:"VERSION",changelog_files:["CHANGELOG.md"]}};
  const store=new LifecycleStore(f.data,runner,probe);
  await store.markIntent({intentId:intent,sessionId:"session",turnId:"turn",projectRoot:f.repo,prompt:"implement native compatibility test"});
  await store.begin({intentId:intent,objective:"implement native compatibility test",projectRoot:f.repo,worktreePath:worktree,baseHead:context.base,...binding,policy});
  await store.recordRed(intent,"ticket");head=context.head;
  await store.recordCommit(intent,{head,tree:context.tree,firstParent:context.base,commitCount:1,clean:true,subject:"feat(core)!: retire contract",versionChanged:false,changelogChanged:false,versionSurfacesValid:true,preparedMergesValid:true,phaseCommitsValid:true,previousPhaseRetained:true});
  return {...f,store,intent,setHead:(value:string)=>{head=value;}};
}

test("native major proof retains exact missing coverage and adjudication reuses unchanged human feedback",async()=>{
  assert.equal(typeof (LifecycleStore.prototype as any).adjudicateCompatibility,"function");
  const f=await governed();await assert.rejects(f.store.prove(f.intent),/release-intent.*failed/);
  let run=await f.store.status(f.intent);const proof=run.evidence.filter(x=>x.scope==="release-intent").at(-1) as any;
  assert.equal(proof.releaseIntent.status,"needs_human");assert.equal(proof.releaseIntent.coverage[0].status,"unavailable");
  const input={choice:"reject-major",actor:"fixture human",humanFeedback:"Fixture consumer compatibility was reviewed.",allFindings:true,reportDigest:proof.releaseIntent.reportDigest,findingDigest:proof.releaseIntent.findingDigest,reviewedRevision:context.head,compatibilityBase:context.base};
  run=await (f.store as any).adjudicateCompatibility(f.intent,input);
  assert.ok(run.evidence.some((x:any)=>x.kind==="compatibility_feedback"&&x.humanFeedback===input.humanFeedback));
  const accepted=await f.store.prove(f.intent);assert.equal(accepted.status,"green");
  const same=await (f.store as any).adjudicateCompatibility(f.intent,input);
  assert.equal(same.evidence.filter((x:any)=>x.kind==="compatibility_feedback").length,1);
});

test("native adjudication rejects empty feedback and a stale reviewed revision",async()=>{
  assert.equal(typeof (LifecycleStore.prototype as any).adjudicateCompatibility,"function");
  const f=await governed();await assert.rejects(f.store.prove(f.intent));
  const run=await f.store.status(f.intent),proof=run.evidence.filter(x=>x.scope==="release-intent").at(-1) as any;
  const input={choice:"confirm-major",actor:"fixture human",humanFeedback:"Reviewed concrete contract migration.",allFindings:true,reportDigest:proof.releaseIntent.reportDigest,findingDigest:proof.releaseIntent.findingDigest,reviewedRevision:context.head,compatibilityBase:context.base};
  await assert.rejects((f.store as any).adjudicateCompatibility(f.intent,{...input,humanFeedback:""}),/actual human|feedback/i);
  f.setHead("e".repeat(40));
  await assert.rejects((f.store as any).adjudicateCompatibility(f.intent,input),/source|revision|committed|binding/i);
});

test("public MCP advertises bounded compatibility adjudication and rejects unbound decisions",async()=>{
  const {Client}=await import("@modelcontextprotocol/sdk/client/index.js");
  const {StdioClientTransport}=await import("@modelcontextprotocol/sdk/client/stdio.js");
  const root=await temporary(),pluginRoot=fileURLToPath(new URL("..",import.meta.url));
  const env=Object.fromEntries(Object.entries(process.env).filter(([name,value])=>typeof value==="string"&&!/^CAPTAIN_.*KEY|^NODE_OPTIONS$/.test(name))) as Record<string,string>;
  Object.assign(env,{CAPTAIN_PLUGIN_DATA:path.join(root,"mcp-data"),CODEX_PLUGIN_ROOT:pluginRoot,PLUGIN_ROOT:pluginRoot});
  const transport=new StdioClientTransport({command:process.execPath,args:["--import","tsx","src/server.ts"],cwd:pluginRoot,stderr:"pipe",env});
  const client=new Client({name:"native-adjudication-fixture",version:"1.0.0"});
  try {
    await client.connect(transport);
    const tool=(await client.listTools()).tools.find(tool=>tool.name==="captain_adjudicate_compatibility");
    assert.ok(tool,"actual public MCP must expose compatibility adjudication");
    const result=await client.callTool({name:tool.name,arguments:{intent_id:"missing-fixture-run",choice:"reject-major",actor:"fixture human",human_feedback:"Fixture feedback",all_findings:true,report_digest:"1".repeat(64),finding_digest:"2".repeat(64),reviewed_revision:context.head,compatibility_base:context.base}});
    assert.equal(result.isError,true,"unbound run cannot manufacture a compatibility decision");
  } finally {await client.close();}
});

for(const choice of ["confirm-major","revise"] as const)test("native compatibility "+choice+" preserves the decision and exact report binding",async()=>{
  const f=await governed();await assert.rejects(f.store.prove(f.intent));
  const before=await f.store.status(f.intent),proof=before.evidence.filter(x=>x.scope==="release-intent").at(-1) as any;
  const input={choice,actor:"fixture human",humanFeedback:choice==="revise"?"Revise the implementation to preserve the supported contract.":"Confirm the documented major migration.",allFindings:true,reportDigest:proof.releaseIntent.reportDigest,findingDigest:proof.releaseIntent.findingDigest,reviewedRevision:context.head,compatibilityBase:context.base};
  await assert.rejects((f.store as any).adjudicateCompatibility(f.intent,{...input,findingDigest:"0".repeat(64)}),/latest exact needs_human report/);
  const recorded=await (f.store as any).adjudicateCompatibility(f.intent,input);
  assert.equal(recorded.evidence.filter((x:any)=>x.kind==="compatibility_feedback").length,1);
  if(choice==="revise") {assert.equal(recorded.phase,"implement");assert.equal(recorded.status,"red");await assert.rejects(f.store.prove(f.intent));}
  else assert.equal((await f.store.prove(f.intent)).status,"green");
});

test("native target comparison may advance while its captured policy base remains pinned",async()=>{
  const run=runNative(),f=await fixture("advanced");
  const result=await run(f.data,f.checker,f.repo,[f.repo],context);
  assert.equal(result.summary.policyBase,context.base);assert.equal(result.summary.base,"d".repeat(40));assert.equal(result.summary.head,context.head);
});

test("native early blocked response retains errors without fabricating coverage analysis",async()=>{
  const run=runNative(),f=await fixture("blocked");
  const result=await run(f.data,f.checker,f.repo,[f.repo],context);
  assert.equal(result.exitCode,1);assert.equal(result.summary.status,"blocked");assert.deepEqual(result.summary.coverage,[]);assert.ok(result.summary.errors.length);
});
