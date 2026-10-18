import assert from 'node:assert/strict';
import test from 'node:test';
import childProcess, { execFile } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const exec = promisify(execFile);
const helper = fileURLToPath(new URL('../skills/pending-work/scripts/git-pending-work.mjs', import.meta.url));
const git = async (cwd:string,...args:string[]) => (await exec('git',args,{cwd,windowsHide:true})).stdout.trim();
async function fixture() {
 const root=await mkdtemp(path.join(tmpdir(),'cpw-')); const repo=path.join(root,'repo with spaces'); await mkdir(repo);
 await git(repo,'init','-b','main'); await git(repo,'config','user.name','Test'); await git(repo,'config','user.email','test@example.invalid'); await git(repo,'config','core.autocrlf','false');
 await writeFile(path.join(repo,'base.txt'),'base\n'); await git(repo,'add','.'); await git(repo,'commit','-m','base'); return {repo,root};
}
async function commit(repo:string,name:string) {await writeFile(path.join(repo,name),name+'\n');await git(repo,'add',name);await git(repo,'commit','-m',name);return git(repo,'rev-parse','HEAD');}
async function audit(repo:string,target='main') {return JSON.parse((await exec(process.execPath,[helper,'--repo',repo,'--target',target],{windowsHide:true})).stdout);}
test('ancestry suppresses merged descendants and groups pending chains, siblings and equal aliases',async()=>{
 const {repo}=await fixture(); const base=await git(repo,'rev-parse','HEAD');
 await git(repo,'switch','-c','merged-parent');await commit(repo,'merged-parent.txt');await git(repo,'switch','-c','merged-child');await commit(repo,'merged-child.txt');await git(repo,'switch','main');await git(repo,'merge','--no-ff','merged-child','-m','integrate');
 await git(repo,'switch','-c','pending-parent');const parent=await commit(repo,'parent.txt');await git(repo,'switch','-c','pending-tip');const tip=await commit(repo,'tip.txt');await git(repo,'branch','tip-alias');
 await git(repo,'switch','-c','sibling',parent);const sibling=await commit(repo,'sibling.txt');await git(repo,'switch','main');await git(repo,'branch','old-base',base);
 const before=await git(repo,'show-ref');const log=await git(repo,'reflog','--all');const result=await audit(repo);
 assert.equal(result.target.oid,await git(repo,'rev-parse','main'));assert.equal(result.snapshot.stale,false);
 assert.deepEqual(result.integrated_branches.map((b:any)=>b.name).sort(),['main','merged-child','merged-parent','old-base']);
 assert.equal(result.pending_groups.length,2);const a=result.pending_groups.find((g:any)=>g.tip_oid===tip);const b=result.pending_groups.find((g:any)=>g.tip_oid===sibling);
 assert.deepEqual(a.tip_branches,['pending-tip','tip-alias']);assert.deepEqual(a.ancestors,[{oid:parent,branches:['pending-parent']}]);assert.deepEqual(b.ancestors,[{oid:parent,branches:['pending-parent']}]);
 assert.equal(result.branches.find((b:any)=>b.name==='pending-tip').ahead,2); assert.equal(result.branches.find((b:any)=>b.name==='pending-tip').behind,0);
 assert.equal(await git(repo,'show-ref'),before);assert.equal(await git(repo,'reflog','--all'),log);assert.equal(await git(repo,'status','--porcelain'),'');
});
test('inspects dirty detached worktrees and unfinished operations from linked checkout',async()=>{
 const {repo,root}=await fixture();const linked=path.join(root,'detached');await git(repo,'worktree','add','--detach',linked,'main');await writeFile(path.join(linked,'untracked.txt'),'keep');
 const gitdir=await git(linked,'rev-parse','--absolute-git-dir');await writeFile(path.join(gitdir,'MERGE_HEAD'),await git(repo,'rev-parse','HEAD'));
 const result=await audit(linked);const wt=result.worktrees.find((w:any)=>w.path.replaceAll('\\','/')===linked.replaceAll('\\','/'));
 assert.equal(wt.integrated,true);assert.equal(wt.head_reachable_from_local_branch,true);assert.equal(wt.detached,true);assert.equal(wt.branch,null);assert.equal(wt.dirty,true);assert.match(wt.status_porcelain,/untracked.txt/);assert.ok(wt.unfinished_operations.includes('MERGE_HEAD'));assert.equal(await readFile(path.join(linked,'untracked.txt'),'utf8'),'keep');
 assert.equal(result.repository.primary_worktree.replaceAll('\\','/'),repo.replaceAll('\\','/'));
});
test('requires an explicit existing target and reports errors without claiming clean',async()=>{
 const {repo}=await fixture(); for(const args of [['--repo',repo],['--repo',repo,'--target','does-not-exist']]) {
  let error:any;try{await exec(process.execPath,[helper,...args],{windowsHide:true});}catch(e){error=e;}
  assert.ok(error);const output=JSON.parse(error.stdout);assert.equal(output.ok,false);assert.ok(output.error);assert.equal(output.pending_groups,undefined);
 }
});
test('squashed equivalent content remains pending by ancestry',async()=>{
 const {repo}=await fixture();await git(repo,'switch','-c','squashed-feature');await commit(repo,'feature.txt');await git(repo,'switch','main');await git(repo,'merge','--squash','squashed-feature');await git(repo,'commit','-m','squash');
 const result=await audit(repo);assert.equal(result.branches.find((b:any)=>b.name==='squashed-feature').integrated,false);assert.deepEqual(result.pending_groups[0].tip_branches,['squashed-feature']);
});

test('clean detached unique work is visible and missing linked paths are not called clean',async()=>{
 const {repo,root}=await fixture();const linked=path.join(root,'unique');await git(repo,'worktree','add','--detach',linked,'main');const head=await commit(linked,'unique.txt');
 const result=await audit(repo);const wt=result.worktrees.find((w:any)=>w.head===head);
 assert.equal(wt.detached,true);assert.equal(wt.dirty,false);assert.equal(wt.integrated,false);assert.equal(wt.head_reachable_from_local_branch,false);
 await rename(linked,linked+'-moved');const after=await audit(repo);const missing=after.worktrees.find((w:any)=>w.head===head);
 assert.ok(missing.inspection_error);assert.equal(missing.dirty,null);assert.equal(missing.integrated,null);assert.equal(after.snapshot.inspection_incomplete,true);
});
test('concurrent branch movement is marked stale rather than silently returned as current',async()=>{
 const {repo}=await fixture();const original=childProcess.execFile;let changed=false;
 // Delegate reads to real Git, then add a ref immediately after the pinned refs read.
 childProcess.execFile=((file:any,args:any[],options:any,callback:any)=>{
  return (original as any)(file,args,options,(error:any,stdout:any,stderr:any)=>{
   if(!error && !changed && args.includes('for-each-ref') && args.includes('--format=%(refname)%00%(objectname)')) {
    changed=true;(original as any)('git',['-C',repo,'branch','arrived-during-audit','main'],{windowsHide:true},(mutationError:any)=>callback(mutationError,stdout,stderr));
   } else callback(error,stdout,stderr);
  });
 }) as typeof childProcess.execFile;
 Object.defineProperty(childProcess.execFile,promisify.custom,{value:(file:any,args:any[],options:any)=>new Promise((resolve,reject)=>{
  childProcess.execFile(file,args,options,(error:any,stdout:any,stderr:any)=>error?reject(error):resolve({stdout,stderr}));
 })});
 syncBuiltinESMExports();
 try {
  const module=await import(new URL('../skills/pending-work/scripts/git-pending-work.mjs?snapshot-test',import.meta.url).href);
  const result=await module.auditPendingWork(repo,'main');
  assert.equal(changed,true);assert.equal(result.snapshot.stale,true);
  assert.ok(result.snapshot.changed_refs.some((entry:any)=>entry.ref==='refs/heads/arrived-during-audit' && entry.before===null));
 } finally {childProcess.execFile=original;syncBuiltinESMExports();}
});
test('inherited Git redirection cannot replace the explicitly requested repository',async()=>{
 const wanted=await fixture(),foreign=await fixture();await git(foreign.repo,'branch','foreign-only');
 const result=JSON.parse((await exec(process.execPath,[helper,'--repo',wanted.repo,'--target','main'],{windowsHide:true,env:{...process.env,GIT_DIR:path.join(foreign.repo,'.git'),GIT_COMMON_DIR:path.join(foreign.repo,'.git'),GIT_WORK_TREE:foreign.repo,GIT_INDEX_FILE:path.join(foreign.repo,'.git','index')}})).stdout);
 assert.equal(result.repository.worktree_root.replaceAll('\\','/'),wanted.repo.replaceAll('\\','/'));
 assert.deepEqual(result.branches.map((branch:any)=>branch.name),['main']);assert.equal(result.snapshot.stale,false);
});
test('registered leftover directory without its Git pointer is not inspected as the enclosing repository',async()=>{
 const {repo}=await fixture();const linked=path.join(repo,'retained-artifacts');await git(repo,'worktree','add','-b','retained-task',linked,'main');
 await rename(path.join(linked,'.git'),path.join(linked,'.git.saved'));await writeFile(path.join(linked,'evidence.txt'),'retained evidence');
 const before=await git(repo,'status','--porcelain');const result=await audit(repo);const wt=result.worktrees.find((entry:any)=>entry.branch==='refs/heads/retained-task');
 assert.ok(wt.inspection_error);assert.match(wt.inspection_error,/identity|root|checkout/i);assert.equal(wt.dirty,null);assert.equal(wt.status_porcelain,null);assert.equal(wt.unfinished_operations,null);assert.equal(result.snapshot.inspection_incomplete,true);
 assert.equal(await git(repo,'status','--porcelain'),before);assert.equal(await readFile(path.join(linked,'evidence.txt'),'utf8'),'retained evidence');
});

test('a registered checkout redirected to a foreign Git directory is reported unknown',async()=>{
 const {repo}=await fixture(),foreign=await fixture();const linked=path.join(repo,'redirected-worktree');await git(repo,'worktree','add','-b','retained-task',linked,'main');
 await rename(path.join(linked,'.git'),path.join(linked,'.git.saved'));await writeFile(path.join(linked,'.git'),'gitdir: '+path.join(foreign.repo,'.git')+'\n');
 const result=await audit(repo);const wt=result.worktrees.find((entry:any)=>entry.branch==='refs/heads/retained-task');
 assert.ok(wt.inspection_error);assert.match(wt.inspection_error,/identity mismatch/);assert.equal(wt.dirty,null);assert.equal(wt.integrated,null);assert.equal(wt.head_reachable_from_local_branch,null);assert.equal(result.snapshot.inspection_incomplete,true);
});
