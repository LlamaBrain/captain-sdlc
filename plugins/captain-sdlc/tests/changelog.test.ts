import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, symlink, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const exec = promisify(execFile);
const helper = fileURLToPath(new URL('../skills/changelog/scripts/changelog.mjs', import.meta.url));
const git = async (cwd:string,...args:string[]) => (await exec('git',args,{cwd,windowsHide:true})).stdout.trim();
const cli = async (...args:string[]) => (await exec(process.execPath,[helper,...args],{windowsHide:true})).stdout.trim();
async function fixture() {
 const root=await mkdtemp(path.join(tmpdir(),'captain-changes-'));const repo=path.join(root,'repo with spaces');await mkdir(repo);
 await git(repo,'init','-b','dev');await git(repo,'config','user.name','Test');await git(repo,'config','user.email','test@example.invalid');await git(repo,'config','core.autocrlf','false');
 await writeFile(path.join(repo,'base.txt'),'base\n');await git(repo,'add','base.txt');await git(repo,'commit','-m','chore: base');
 const base=await git(repo,'rev-parse','HEAD');await git(repo,'switch','-c','feature');return {root,repo,base};
}
async function commit(repo:string,name:string,message:string){await writeFile(path.join(repo,name),name);await git(repo,'add',name);await git(repo,'commit','-m',message);return git(repo,'rev-parse','HEAD');}
async function collect(repo:string,base:string,id='task-one',subject='Add technical actions'){await cli('collect','--repo',repo,'--target',base,'--project','test-project','--id',id,'--subject',subject);return path.join(repo,'changes.md');}
function metadata(text:string){return JSON.parse(text.match(/<!-- captain-changes:v1 -->\n```json\n([\s\S]*?)\n```/)![1]);}
async function compose(files:string[],...args:string[]){return cli('compose',...files.flatMap(f=>['--input',f]),...args);}

test('collect pins unique Git history and developer details without altering refs or index',async()=>{
 const {repo,base}=await fixture();const oid=await commit(repo,'feature.txt','feat(api): add typed work orders\n\nPreserve wall section IDs.\n\nChangelog-Note: Add typed work orders and stable section IDs.');
 const refs=await git(repo,'show-ref'),index=await git(repo,'write-tree');const file=await collect(repo,base);const text=await readFile(file,'utf8');const data=metadata(text);
 assert.equal(data.target_head,base);assert.equal(data.source_head,oid);assert.equal(data.audience,'developer');assert.equal(data.entries.length,1);assert.equal(data.entries[0].oid,oid);assert.equal(data.entries[0].category,'Added');assert.match(text,/stable section IDs/);
 assert.equal(await git(repo,'show-ref'),refs);assert.equal(await git(repo,'write-tree'),index);await collect(repo,base);assert.equal(await readFile(file,'utf8'),text);
});

test('collect excludes target-only history after target import and records structural merges',async()=>{
 const {repo,base}=await fixture();const own=await commit(repo,'feature.txt','fix: retain component identity');await git(repo,'switch','dev');const target=await commit(repo,'target.txt','feat: target-only tooling');await git(repo,'switch','feature');await git(repo,'merge','--no-ff','dev','-m','Merge dev into feature');
 const data=metadata(await readFile(await collect(repo,target),'utf8'));assert.deepEqual(data.entries.map((e:any)=>e.oid),[own]);assert.equal(data.omitted.length,1);assert.equal(data.omitted[0].reason,'structural-merge');assert.equal(data.merge_base,target);assert.notEqual(base,target);
});

test('invalid Conventional Commits fail without creating a draft or skipping bad commits',async()=>{
 const {repo,base}=await fixture();await commit(repo,'bad.txt','unclassified changes');await assert.rejects(collect(repo,base),/Conventional Commit/);await assert.rejects(readFile(path.join(repo,'changes.md')),/ENOENT/);
});

test('compose deduplicates overlapping fragments by project and full commit OID',async()=>{
 const {repo,base,root}=await fixture();const shared=await commit(repo,'one.txt','feat: add wall sections');const a=await collect(repo,base);const first=path.join(root,'first.md');await writeFile(first,await readFile(a));await unlink(a);await commit(repo,'two.txt','fix: preserve junction ownership');await collect(repo,base,'task-two');
 const output=await compose([a,first]);assert.equal(output.split(shared).length-1,1);assert.match(output,/### Added/);assert.match(output,/### Fixed/);assert.equal(await compose([first,a,a]),output);
});

test('composition refuses conflicting curation for a shared commit and cross-project input',async()=>{
 const {repo,base,root}=await fixture();await commit(repo,'one.txt','fix: retain endpoint');const a=await collect(repo,base);const b=path.join(root,'other.md');const text=await readFile(a,'utf8');await writeFile(b,text.replace('"project": "test-project"','"project": "other-project"'));await cli('render','--input',b,'--write');await assert.rejects(compose([a,b]),/project/);
 await writeFile(b,text.replace('"summary": "retain endpoint"','"summary": "Different technical claim"'));await cli('render','--input',b,'--write');await assert.rejects(compose([a,b]),/conflicting/);
});

test('breaking aliases and custom KAC categories retain migration context and determine highest bump',async()=>{
 const {repo,base}=await fixture();await commit(repo,'one.txt','refactor(api): remove old DTO\n\nBREAKING-CHANGE: Replace LegacyOrder with WorkIntent.\nChangelog-Category: Removed');const a=await collect(repo,base);const output=await compose([a],'--base-version','1.2.3','--version','2.0.0','--date','2026-10-19');assert.match(output,/## \[2\.0\.0\] - 2026-10-19/);assert.match(output,/### Removed/);assert.match(output,/Replace LegacyOrder with WorkIntent/);await assert.rejects(compose([a],'--base-version','1.2.3','--version','1.3.0','--date','2026-10-19'),/major/);
});

test('SemVer, prerelease, date and release argument validation is strict',async()=>{
 const {repo,base}=await fixture();await commit(repo,'one.txt','feat: add connector selection');const a=await collect(repo,base);
 for(const version of ['01.3.0','1.3','1.3.0-01','v1.3.0']) await assert.rejects(compose([a],'--base-version','1.2.3','--version',version,'--date','2026-10-19'),/SemVer/);
 await assert.rejects(compose([a],'--base-version','1.2.3','--version','1.2.4','--date','2026-10-19'),/minor/);await assert.rejects(compose([a],'--version','1.3.0'),/base-version|date/);await assert.rejects(compose([a],'--base-version','1.2.3','--version','1.3.0','--date','2026-02-30'),/date/);
 assert.match(await compose([a],'--base-version','1.2.3+build.7','--version','1.3.0-rc.1+sha.abc','--date','2026-10-19'),/1\.3\.0-rc\.1\+sha\.abc/);
});

test('maintenance commits have no implicit standard SemVer bump, with explicit repository patch policy',async()=>{
 const {repo,base}=await fixture();await commit(repo,'one.txt','docs(api): describe construction invariants');const a=await collect(repo,base);assert.match(await compose([a]),/Recommended bump: none/);assert.match(await compose([a],'--maintenance-bump','patch'),/Recommended bump: patch/);
});

test('draft refresh refuses to overwrite foreign content or erase manual curation',async()=>{
 const {repo,base}=await fixture();await commit(repo,'one.txt','fix: retain wall sections');const a=await collect(repo,base);const original=await readFile(a,'utf8');await writeFile(a,original.replace('"summary": "retain wall sections"','"summary": "Curated wall identity fix"'));await cli('render','--input',a,'--write');await collect(repo,base);assert.match(await readFile(a,'utf8'),/Curated wall identity fix/);await writeFile(a,'human-owned notes\n');await assert.rejects(collect(repo,base),/artifact|overwrite/);assert.equal(await readFile(a,'utf8'),'human-owned notes\n');
});

test('archive uses date, subject and stable ID, preserves contents and never overwrites a collision',async()=>{
 const {repo,base}=await fixture();await commit(repo,'one.txt','feat: add wall sections');const a=await collect(repo,base,'walls-42','Wall sections / junctions');const text=await readFile(a,'utf8');const result=JSON.parse(await cli('archive','--repo',repo,'--input',a,'--date','2026-10-19'));assert.match(result.path.replaceAll('\\','/'),/changelog\/changes\/2026-10-19-wall-sections-junctions-[a-f0-9]{12}\.md$/);assert.equal(await readFile(result.path,'utf8'),text);assert.equal((JSON.parse(await cli('archive','--repo',repo,'--input',a,'--date','2026-10-19'))).path,result.path);await writeFile(result.path,'preserve me');await assert.rejects(cli('archive','--repo',repo,'--input',a,'--date','2026-10-19'),/collision/);assert.equal(await readFile(result.path,'utf8'),'preserve me');
});

test('archive retiring the draft removes only the verified task draft and keeps unrelated files',async()=>{
 const {repo,base}=await fixture();await commit(repo,'one.txt','fix: retain intent');const a=await collect(repo,base);await writeFile(path.join(repo,'other.md'),'keep');const result=JSON.parse(await cli('archive','--repo',repo,'--input',a,'--date','2026-10-19','--retire-draft'));await assert.rejects(readFile(a),/ENOENT/);assert.ok(await readFile(result.path,'utf8'));assert.equal(await readFile(path.join(repo,'other.md'),'utf8'),'keep');
});

test('malformed categories, broken artifact provenance and body/metadata drift are rejected',async()=>{
 const {repo,base,root}=await fixture();await commit(repo,'one.txt','fix: retain intent\n\nChangelog-Category: Whatever');await assert.rejects(collect(repo,base),/category/);
 const f=await fixture();await commit(f.repo,'a.txt','fix: proper message');const a=await collect(f.repo,f.base);const original=await readFile(a,'utf8');const other=path.join(root,'broken.md');await writeFile(other,original.replace('"oid": "','"oid": "bogus'));await assert.rejects(compose([other]),/OID|oid|provenance/);await writeFile(other,original.replace('### Fixed','### Added'));await assert.rejects(compose([other]),/render|metadata|drift/);
});

test('linked-worktree output stays in that checkout and archive rejects reparse escape',async()=>{
 const {repo,base,root}=await fixture();const linked=path.join(root,'linked tree');await git(repo,'worktree','add','-b','linked',linked);await commit(linked,'a.txt','fix: linked task');const a=await collect(linked,base);assert.equal(path.dirname(a),linked);await assert.rejects(readFile(path.join(repo,'changes.md')),/ENOENT/);
 const outside=path.join(root,'outside');await mkdir(outside);await symlink(outside,path.join(linked,'changelog'),process.platform==='win32'?'junction':'dir');await assert.rejects(cli('archive','--repo',linked,'--input',a,'--date','2026-10-19'),/symlink|reparse|outside/);assert.deepEqual(await import('node:fs/promises').then(fs=>fs.readdir(outside)),[]);
});

test('Git-verified composition rejects dropped commits, forged omissions and altered merge base',async()=>{
 const {repo,base,root}=await fixture();await commit(repo,'one.txt','feat: add intent');await commit(repo,'two.txt','fix: retain parent');const file=await collect(repo,base);const original=await readFile(file,'utf8');const data=metadata(original);const broken=path.join(root,'altered.md');
 for(const mutate of [(d:any)=>d.entries.pop(),(d:any)=>{d.merge_base=d.source_head;},(d:any)=>{const e=d.entries.pop();d.omitted.push({oid:e.oid,reason:'artifact-only'});}]) {
  const d=structuredClone(data);mutate(d);await writeFile(broken,original.replace(/(<!-- captain-changes:v1 -->\n```json\n)[\s\S]*?(\n```)/,(_m,a,b)=>a+JSON.stringify(d,null,2)+b));await cli('render','--input',broken,'--write');await assert.rejects(compose([broken],'--repo',repo),/provenance/);
 }
});

test('archive refuses stale source history and a fragment from another repository',async()=>{
 const a=await fixture();await commit(a.repo,'one.txt','feat: add section');const file=await collect(a.repo,a.base);const b=await fixture();await assert.rejects(cli('archive','--repo',b.repo,'--input',file,'--date','2026-10-19'),/source changed|provenance/);await commit(a.repo,'two.txt','fix: preserve junction');await assert.rejects(cli('archive','--repo',a.repo,'--input',file,'--date','2026-10-19'),/source changed/);
});

test('valid repeated trailers and breaking aliases retain every migration detail',async()=>{
 const {repo,base}=await fixture();await commit(repo,'one.txt','refactor(api): replace DTO\n\nBREAKING CHANGE: Use WorkIntent.\nBREAKING-CHANGE: Pass an assembly ID.\nCo-authored-by: One <one@example.invalid>\nCo-authored-by: Two <two@example.invalid>');const file=await collect(repo,base);const output=await compose([file],'--repo',repo);assert.match(output,/Use WorkIntent\. Pass an assembly ID\./);assert.match(output,/Recommended bump: major/);
});

test('nonstandard breaking separator is rejected and excluded breaking entries still affect SemVer',async()=>{
 const a=await fixture();await commit(a.repo,'one.txt','refactor: replace order\n\nBREAKING CHANGE #Replace DTO');await assert.rejects(collect(a.repo,a.base),/colon-space/);
 const b=await fixture();await commit(b.repo,'two.txt','refactor!: replace order\n\nChangelog-Exclude: true');const file=await collect(b.repo,b.base);const output=await compose([file]);assert.match(output,/Recommended bump: major/);assert.match(output,/No developer-facing entries/);
});

test('archive preserves CRLF bytes and can safely retire the same Windows draft',async()=>{
 const {repo,base}=await fixture();await commit(repo,'one.txt','fix: preserve identity');const file=await collect(repo,base);const crlf=(await readFile(file,'utf8')).replaceAll('\n','\r\n');await writeFile(file,crlf);const result=JSON.parse(await cli('archive','--repo',repo,'--input',file,'--date','2026-10-19','--retire-draft'));assert.equal(await readFile(result.path,'utf8'),crlf);await assert.rejects(readFile(file),/ENOENT/);
});

test('already released inputs are excluded explicitly without deleting artifacts',async()=>{
 const {repo,base,root}=await fixture();const first=await commit(repo,'one.txt','feat: add section');const file=await collect(repo,base);const prior=path.join(root,'released.md');await writeFile(prior,await readFile(file));await commit(repo,'two.txt','fix: retain endpoint');await collect(repo,base);const output=await compose([file],'--repo',repo,'--exclude-input',prior);assert.ok(!output.includes(first));assert.match(output,/### Fixed/);assert.ok(await readFile(prior,'utf8'));
});
