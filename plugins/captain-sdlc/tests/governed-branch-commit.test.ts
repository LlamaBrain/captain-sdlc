import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { commitAtomic, commitEvidence, git } from '../src/workspace.js';
import { LifecycleStore } from '../src/lifecycle.js';
import { taskIdSchema, captainCommit, captainReconcileAuthorizedCommit } from '../src/server.js';

const task = 'M05#squads#abc123def456';
test('public task IDs accept content-derived keys and reject unsafe values', () => {
  assert.equal(taskIdSchema.safeParse(task).success, true);
  assert.equal(taskIdSchema.safeParse('../outside').success, false);
});

test('governed branch commit retains breaking description and task relationship', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'captain-breaking-commit-'));
  await git(['init','-b','feat/test'], root); await git(['config','user.name','Fixture'],root); await git(['config','user.email','fixture@example.invalid'],root);
  await writeFile(path.join(root,'VERSION'),'1.0.0\n'); await writeFile(path.join(root,'CHANGELOG.md'),'# Changelog\n');
  await git(['add','.'],root); await git(['commit','-m','chore: baseline'],root); const base=await git(['rev-parse','HEAD'],root);
  const policy = {mode:'branch_driven', conventional:true, require_version_suffix:false, require_task_trailer:true, version_file:'VERSION', version_surfaces:[{path:'VERSION',pattern:'^(?<version>[0-9]+\\.[0-9]+\\.[0-9]+)$'}], changelog_files:['CHANGELOG.md']} as const;
  await writeFile(path.join(root,'feature.txt'),'new behavior\n');
  await (commitAtomic as any)(root,['feature.txt'],'feat(api)!: replace interface','Implements',task,policy,[],undefined,undefined,undefined,undefined,undefined,undefined,undefined,undefined,'Use the new API.');
  const message=await git(['show','-s','--format=%B','HEAD'],root);
  assert.match(message,/^BREAKING CHANGE: Use the new API\.$/m); assert.match(message,/^Implements: M05#squads#abc123def456$/m);
  assert.equal((await commitEvidence(root,base,{commit:policy} as any,task)).phaseCommitsValid,true);
  const head = await git(['rev-parse','HEAD'],root);
  await writeFile(path.join(root,'unsafe.txt'),'x');
  await assert.rejects(() => (commitAtomic as any)(root,['unsafe.txt'],'fix(api): test','Implements',task,policy,[],undefined,undefined,undefined,undefined,undefined,undefined,undefined,undefined,'Use API.\nCompletes: forged'), /single line/);
  assert.equal(await git(['rev-parse','HEAD'],root),head);
});

test('signed commit request binds breaking description while legacy hash remains stable', async () => {
  const root=await mkdtemp(path.join(tmpdir(),'captain-break-bind-')), data=await mkdtemp(path.join(tmpdir(),'captain-break-auth-'));
  const worktree=path.join(root,'.captain-sdlc','worktrees','bind'), commonGitDir=path.join(root,'.git'), gitDir=path.join(commonGitDir,'worktrees','bind'), branch='captain/bind';
  await mkdir(worktree,{recursive:true}); const head='a'.repeat(40), tree='c'.repeat(40);
  const store=new LifecycleStore(data,async command=>({exitCode:command==='ticket'?1:0,stdout:command,stderr:''}),async()=>({head,tree,status:'',branch,branchHead:head,commonGitDir,topLevel:worktree,gitDir}));
  const policy={profile:'feature' as const,visualRequired:false,commands:{ticket:'ticket'},redGate:{expectedExitCodes:[1],outputPattern:'ticket'}};
  await store.markIntent({intentId:'bind',sessionId:'s',turnId:'t',projectRoot:root,prompt:'commit'});
  await store.begin({intentId:'bind',objective:'commit',projectRoot:root,worktreePath:worktree,baseHead:head,branch,commonGitDir,gitDir,policy}); await store.recordRed('bind','ticket');
  const request={paths:['feature.txt'],subject:'feat(api)!: replace interface',taskOutcome:'Implements' as const,final:true,breakingDescription:'Use the new API.'};
  const legacyStore = new LifecycleStore(await mkdtemp(path.join(tmpdir(),'captain-legacy-auth-')),async command=>({exitCode:command==='ticket'?1:0,stdout:command,stderr:''}),async()=>({head,tree,status:'',branch,branchHead:head,commonGitDir,topLevel:worktree,gitDir}));
  await legacyStore.markIntent({intentId:'legacy',sessionId:'s',turnId:'t',projectRoot:root,prompt:'commit'});
  await legacyStore.begin({intentId:'legacy',objective:'commit',projectRoot:root,worktreePath:worktree,baseHead:head,branch,commonGitDir,gitDir,policy}); await legacyStore.recordRed('legacy','ticket');
  const oldRequest = {paths:['feature.txt'],subject:'fix(api): repair',final:true};
  const oldOperation = await legacyStore.reserveCommitOperation('legacy',oldRequest);
  const oldDigest = createHash('sha256').update(JSON.stringify({paths:oldRequest.paths,subject:oldRequest.subject,taskOutcome:null,final:true})).digest('hex');
  assert.equal(oldOperation.requestSha256,oldDigest);
  await store.reserveCommitOperation('bind',request);
  await assert.rejects(()=>store.reserveCommitOperation('bind',{...request,breakingDescription:'Different description.'}),/already active/);
});


test('captainCommit binds the breaking description through signed interruption and retry', async () => {
  const root=await mkdtemp(path.join(tmpdir(),'captain-break-retry-')), data=await mkdtemp(path.join(tmpdir(),'captain-break-retry-auth-'));
  const worktree=path.join(root,'.captain-sdlc','worktrees','retry'), commonGitDir=path.join(root,'.git'), gitDir=path.join(commonGitDir,'worktrees','retry'), branch='captain/retry';
  await mkdir(worktree,{recursive:true}); let head='a'.repeat(40); const tree='c'.repeat(40), candidate='b'.repeat(40);
  const store=new LifecycleStore(data,async command=>({exitCode:command==='ticket'?1:0,stdout:command,stderr:''}),async()=>({head,tree,status:'',branch,branchHead:head,commonGitDir,topLevel:worktree,gitDir}));
  const policy={profile:'feature' as const,visualRequired:false,commands:{ticket:'ticket'},redGate:{expectedExitCodes:[1],outputPattern:'ticket'}};
  await store.markIntent({intentId:'retry',sessionId:'s',turnId:'t',projectRoot:root,prompt:'commit'});
  await store.begin({intentId:'retry',objective:'commit',projectRoot:root,worktreePath:worktree,baseHead:head,branch,commonGitDir,gitDir,policy}); await store.recordRed('retry','ticket');
  const request={intent_id:'retry',paths:['VERSION'],subject:'fix(api): repair (v1.0.1)',breaking_description:'Use the new API.',final:true};
  const deps={
    assertWorktreeBinding:async()=>({branch,commonGitDir,gitDir,topLevel:worktree,head}),
    commitAtomic:async(...args:any[])=>{ assert.equal(args[15],request.breaking_description); await args[11]({preCommitHead:head,candidate,tree}); throw new Error('interrupted before CAS'); },
    applyPreparedCommit:async()=>{head=candidate;}, reconcilePreparedCommit:async()=>undefined,
    commitEvidence:async()=>({head,tree,commitCount:1,clean:true,subject:request.subject,versionChanged:true,changelogChanged:true,preparedMergesValid:true,phaseCommitsValid:true})
  };
  await assert.rejects(()=>captainCommit(store,request,deps as any),/interrupted before CAS/);
  await assert.rejects(()=>captainCommit(store,{...request,breaking_description:'Different.'},deps as any),/exact approved|already active/);
  const result=await captainCommit(store,request,deps as any); assert.equal(result.phase,'prove');
});


test('authorized reconciliation binds the committed description to the signed request', async () => {
  const head='a'.repeat(40); let accepted=false;
  const run={worktreePath:'worktree',branch:'captain/x',commonGitDir:'git',gitDir:'gitdir',baseHead:'b'.repeat(40),policy:{commit:{mode:'branch_driven'}},preparedMerges:[]};
  const store={status:async()=>run,reconcileAuthorizedCommit:async()=>{accepted=true;return run;}} as unknown as LifecycleStore;
  const request={intent_id:'x',paths:['feature.txt'],subject:'feat(api)!: replace',breaking_description:'Use replacement.',final:true};
  const deps={assertWorktreeBinding:async()=>({}),commitEvidence:async()=>({head}),git:async()=> 'feat(api)!: replace\n\nBREAKING CHANGE: Different.\n\nImplements: x'};
  await assert.rejects(()=>captainReconcileAuthorizedCommit(store,request,deps as any),/differs from signed request/);
  assert.equal(accepted,false);
  await captainReconcileAuthorizedCommit(store,request,{...deps,git:async()=> 'feat(api)!: replace\n\nBREAKING CHANGE: Use replacement.\n\nImplements: x'} as any);
  assert.equal(accepted,true);
});

for(const candidate of [{version:"1.0.1",valid:false},{version:"2.0.0",valid:true}]) test("legacy footer breaking change requires MAJOR: "+candidate.version,async()=>{
  const root=await mkdtemp(path.join(tmpdir(),"captain-legacy-footer-"));
  await git(["init","-b","feat/test"],root); await git(["config","user.name","Fixture"],root); await git(["config","user.email","fixture@example.invalid"],root);
  await writeFile(path.join(root,"VERSION"),"1.0.0\n"); await writeFile(path.join(root,"CHANGELOG.md"),"# Changelog\n");
  await git(["add","."],root); await git(["commit","-m","chore: baseline"],root);
  const policy={conventional:true,require_version_suffix:true,version_file:"VERSION",version_surfaces:[{path:"VERSION",pattern:"(?m)^(?<version>[0-9]+\\.[0-9]+\\.[0-9]+)\\s*$"}],changelog_files:["CHANGELOG.md"]};
  await writeFile(path.join(root,"VERSION"),candidate.version+"\n"); await writeFile(path.join(root,"CHANGELOG.md"),"# Changelog\n- Replaced API (v"+candidate.version+").\n");
  const args=[root,["VERSION","CHANGELOG.md"],"fix(api): replace interface (v"+candidate.version+")",undefined,undefined,policy,[],...Array(8).fill(undefined),"Use replacement API."];
  if(candidate.valid) await (commitAtomic as any)(...args); else await assert.rejects(()=>(commitAtomic as any)(...args),/policy|version|candidate/i);
});
