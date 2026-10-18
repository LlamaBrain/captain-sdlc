#!/usr/bin/env node
/** Local, read-only ancestry inventory. Never fetches, checks out, or edits Git state. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const execute = promisify(execFile);
const gitOptions = { windowsHide: true, maxBuffer: 32 * 1024 * 1024, env: { ...Object.fromEntries(Object.entries(process.env).filter(([name])=>!/^GIT_/i.test(name))), GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1' } };
async function git(repo, ...args) {
 try { return (await execute('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-C', repo, ...args], gitOptions)).stdout; }
 catch (error) { throw new Error(`Git ${args[0]} failed: ${String(error.stderr || error.message).trim()}`); }
}
async function exists(filename) {try {await access(filename);return true;}catch(error){if(error.code==='ENOENT')return false;throw error;}}
async function refs(repo) {
 const output=await git(repo,'for-each-ref','--format=%(refname)%00%(objectname)','refs/heads/');
 return output.trim().split(/\r?\n/).filter(Boolean).map(line=>{const [ref,oid]=line.split('\0');return {ref,name:ref.slice('refs/heads/'.length),oid};});
}
async function targetOid(repo, target) {return (await git(repo,'rev-parse','--verify','--end-of-options',`${target}^{commit}`)).trim();}
function parseWorktrees(output) {
 const result=[];let record;
 for(const token of output.split('\0')) {
  if(!token){if(record){result.push(record);record=undefined;}continue;}
  const at=token.indexOf(' '), key=at<0?token:token.slice(0,at),value=at<0?'':token.slice(at+1);
  if(key==='worktree')record={path:value,head:null,branch:null,detached:false};
  else if(record && key==='HEAD')record.head=value;
  else if(record && key==='branch')record.branch=value;
  else if(record && key==='detached')record.detached=true;
  else if(record && ['locked','prunable','bare'].includes(key))record[key]=value||true;
 }
 if(record)result.push(record);return result;
}
async function inspectWorktrees(repo, pinnedTarget) {
 const list=parseWorktrees(await git(repo,'worktree','list','--porcelain','-z'));
 const inspect = async entry=>{
  try {
   const [status, gitdir]=await Promise.all([git(entry.path,'status','--porcelain=v1','-z','--untracked-files=all'),git(entry.path,'rev-parse','--absolute-git-dir')]);
   const operations=['MERGE_HEAD','CHERRY_PICK_HEAD','REVERT_HEAD','REBASE_HEAD','rebase-apply','rebase-merge','sequencer','BISECT_LOG'];
   const found=await Promise.all(operations.map(async op=>await exists(path.join(gitdir.trim(),op))?op:null));
   let integrated;
   try {await execute('git',['--no-optional-locks','-c','core.fsmonitor=false','-C',repo,'merge-base','--is-ancestor',entry.head,pinnedTarget],gitOptions);integrated=true;}
   catch(error) {if(error.code===1)integrated=false;else throw error;}
   const reachable=(await git(repo,'for-each-ref',`--contains=${entry.head}`,'--format=%(refname)','refs/heads/')).trim().length>0;
   return {...entry,integrated,head_reachable_from_local_branch:reachable,status_porcelain:status,dirty:status.length>0,unfinished_operations:found.filter(Boolean)};
  } catch(error) {return {...entry,integrated:null,head_reachable_from_local_branch:null,status_porcelain:null,dirty:null,unfinished_operations:null,inspection_error:error.message};}
 };
 const result=new Array(list.length);let cursor=0;
 await Promise.all(Array.from({length:Math.min(4,list.length)},async()=>{
  while(cursor<list.length){const index=cursor++;result[index]=await inspect(list[index]);}
 }));
 return result;
}
export async function auditPendingWork(repo,target) {
 if(!repo || !target)throw new Error('Both --repo <path> and explicit --target <ref> are required.');
 const requested=path.resolve(repo);
 const [root,common,bare]=await Promise.all([git(requested,'rev-parse','--show-toplevel'),git(requested,'rev-parse','--path-format=absolute','--git-common-dir'),git(requested,'rev-parse','--is-bare-repository')]);
 if(bare.trim()==='true')throw new Error('A worktree repository is required.');
 const rootPath=root.trim(), commonDir=common.trim();const pinnedTarget=await targetOid(rootPath,target);
 const initialRefs=await refs(rootPath);const firstWorktrees=await inspectWorktrees(rootPath,pinnedTarget);
 const integrated=new Set((await git(rootPath,'for-each-ref',`--merged=${pinnedTarget}`,'--format=%(refname)','refs/heads/')).trim().split(/\r?\n/).filter(Boolean));
 const counts=new Map();
 const branches=[];
 for(const branch of initialRefs) {
  if(!counts.has(branch.oid)) {
   const [ahead,behind]=(await git(rootPath,'rev-list','--left-right','--count',`${branch.oid}...${pinnedTarget}`)).trim().split(/\s+/).map(Number);
   counts.set(branch.oid,{ahead,behind});
  }
  branches.push({...branch,integrated:integrated.has(branch.ref),...counts.get(branch.oid)});
 }
 const pending=branches.filter(branch=>!branch.integrated), byOid=new Map();
 for(const branch of pending){if(!byOid.has(branch.oid))byOid.set(branch.oid,[]);byOid.get(branch.oid).push(branch.name);}
 const ancestorSets=new Map();
 // Read only pinned object IDs. Later branch movement cannot change this snapshot's graph.
 for(const oid of byOid.keys()) {
  const candidateOids=new Set((await git(rootPath,'rev-list',oid,'--not',pinnedTarget)).trim().split(/\r?\n/));
  ancestorSets.set(oid,new Set([...byOid.keys()].filter(other=>other!==oid && candidateOids.has(other))));
 }
 const maximal=[...byOid.keys()].filter(oid=>![...ancestorSets.values()].some(set=>set.has(oid)));
 const pendingGroups=maximal.map(oid=>({tip_oid:oid,tip_branches:byOid.get(oid).sort(),ancestors:[...ancestorSets.get(oid)].map(parent=>({oid:parent,branches:byOid.get(parent).sort()})).sort((a,b)=>a.branches[0].localeCompare(b.branches[0]))})).sort((a,b)=>a.tip_branches[0].localeCompare(b.tip_branches[0]));
 const changed=[];let finalRefs,finalTarget;
 try{finalRefs=await refs(rootPath);finalTarget=await targetOid(rootPath,target);}catch(error){changed.push({ref:target,error:error.message});}
 if(finalRefs) {
  const start=new Map(initialRefs.map(branch=>[branch.ref,branch.oid])),end=new Map(finalRefs.map(branch=>[branch.ref,branch.oid]));
  for(const ref of new Set([...start.keys(),...end.keys()]))if(start.get(ref)!==end.get(ref))changed.push({ref,before:start.get(ref)||null,after:end.get(ref)||null});
 }
 if(finalTarget && pinnedTarget!==finalTarget)changed.push({ref:target,before:pinnedTarget,after:finalTarget});
 const lastWorktrees=await inspectWorktrees(rootPath,pinnedTarget);const worktreeChanged=JSON.stringify(firstWorktrees)!==JSON.stringify(lastWorktrees);
 const inspectionIncomplete=firstWorktrees.some(w=>w.inspection_error)||lastWorktrees.some(w=>w.inspection_error);
 return {schema_version:1,ok:true,repository:{requested_root:requested,worktree_root:rootPath,primary_worktree:firstWorktrees[0]?.path||null,common_git_dir:commonDir},target:{ref:target,oid:pinnedTarget},branches,integrated_branches:branches.filter(branch=>branch.integrated),pending_groups:pendingGroups,worktrees:firstWorktrees,snapshot:{stale:changed.length>0||worktreeChanged,changed_refs:changed,worktree_state_changed:worktreeChanged,inspection_incomplete:Boolean(inspectionIncomplete)},limitations:['Local refs only; no fetch performed.','Ancestry proves integration; squash/cherry-pick equivalence is not treated as integration.','Snapshot checks detect observed changes; concurrent changes that return to the original state cannot be excluded.']};
}
async function main() {
 const options={};const args=process.argv.slice(2);
 for(let i=0;i<args.length;i+=2){if(!['--repo','--target'].includes(args[i])||!args[i+1]||options[args[i]])throw new Error('Usage: node git-pending-work.mjs --repo <path> --target <explicit-ref>');options[args[i]]=args[i+1];}
 const result=await auditPendingWork(options['--repo'],options['--target']);process.stdout.write(JSON.stringify(result,null,2)+'\n');
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{process.stdout.write(JSON.stringify({schema_version:1,ok:false,error:error.message})+'\n');process.exitCode=1;});
