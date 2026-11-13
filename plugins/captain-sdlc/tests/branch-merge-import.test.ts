import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import { commitEvidence, git } from "../src/workspace.js";
const ready=Promise.resolve();
async function dispose(root: string) { assert.equal(path.dirname(root),path.resolve(tmpdir())); assert.ok(path.basename(root).startsWith('captain-import-review-')); await rm(root,{recursive:true,force:true}); }
const task='TASK-1';
const commit={mode:'branch_driven',conventional:true,require_version_suffix:false,require_task_trailer:true,version_file:'VERSION',version_surfaces:[{path:'VERSION',pattern:'^(?<version>[0-9]+\\.[0-9]+\\.[0-9]+)$'},{path:'package.json',pattern:'"version"\\s*:\\s*"(?<version>[0-9]+\\.[0-9]+\\.[0-9]+)"',json_pointers:['/version','/mirror']}],changelog_files:['CHANGELOG.md']};
const policy={profile:'feature',visualRequired:false,commands:{},commit};
async function fixture(forge='') {
 await ready;
 const root=await mkdtemp(path.join(tmpdir(),'captain-import-review-'));
 await git(['init','-b','feature'],root);await git(['config','user.name','Fixture'],root);await git(['config','user.email','fixture@example.invalid'],root);
 await writeFile(path.join(root,'VERSION'),'1.0.0\n');await writeFile(path.join(root,'CHANGELOG.md'),'# Changelog\n');await writeFile(path.join(root,'package.json'),'{"version":"1.0.0","mirror":"1.0.0"}\n');await git(['add','.'],root);await git(['commit','-m','chore: initial'],root);const base=await git(['rev-parse','HEAD'],root);
 await git(['checkout','-b','target'],root);await writeFile(path.join(root,'VERSION'),'1.1.0\n');await writeFile(path.join(root,'CHANGELOG.md'),'# Changelog\n\n## v1.1.0\n');await writeFile(path.join(root,'package.json'),'{"version":"1.1.0","mirror":"1.1.0"}\n');await git(['add','.'],root);await git(['commit','-m','chore(release): promote'],root);const target=await git(['rev-parse','HEAD'],root);
 await git(['checkout','feature'],root);await writeFile(path.join(root,'feature.txt'),'feature');await git(['add','.'],root);await git(['commit','-m','fix: feature\n\nImplements: '+task],root);const before=await git(['rev-parse','HEAD'],root);
 await git(['merge','--no-ff','--no-commit','target'],root);
 if(forge==='version')await writeFile(path.join(root,'VERSION'),'9.9.9\n');
 if(forge==='mirror')await writeFile(path.join(root,'package.json'),'{"version":"1.1.0","mirror":"9.9.9"}\n');
 if(forge==='partial')await writeFile(path.join(root,'package.json'),'{"version":"1.1.0","mirror":"1.0.0"}\n');
 if(forge==='changelog')await writeFile(path.join(root,'CHANGELOG.md'),'# Changelog\n\n## forged\n');
 if(forge==='omit_changelog')await writeFile(path.join(root,'CHANGELOG.md'),'# Changelog\n');
 if(forge==='omit_versions'){await writeFile(path.join(root,'VERSION'),'1.0.0\n');await writeFile(path.join(root,'package.json'),'{"version":"1.0.0","mirror":"1.0.0"}\n');}
 await git(['add','.'],root);await git(['commit','-m','chore: reconcile target\n\nImplements: '+task],root);
 return {root,base,target,before,prepared:[{preMergeHead:before,targetOid:target,strategy:'ort'}]};
}
test('signed merge imports exact incoming version and changelog',async()=>{const f=await fixture();try{const ev=await commitEvidence(f.root,f.base,policy,task,f.prepared);assert.equal(ev.phaseCommitsValid,true);assert.equal(ev.preparedMergesValid,true);}finally{await dispose(f.root);}});
test('without exact prepared merge import is refused',async()=>{const f=await fixture();try{const ev=await commitEvidence(f.root,f.base,policy,task,[]);assert.equal(ev.phaseCommitsValid,false);assert.equal(ev.preparedMergesValid,false);}finally{await dispose(f.root);}});
for(const kind of ['version','mirror','partial','changelog','omit_changelog','omit_versions']) test('signed import refuses forged '+kind,async()=>{const f=await fixture(kind);try{const ev=await commitEvidence(f.root,f.base,policy,task,f.prepared);assert.equal(ev.phaseCommitsValid,false);}finally{await dispose(f.root);}});
