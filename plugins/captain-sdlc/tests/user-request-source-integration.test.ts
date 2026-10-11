import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { LifecycleStore } from "../src/lifecycle.js";
import { captainIssueIntent } from "../src/server.js";
import { recordUserRequestSource } from "../src/user-request-source.js";
import { git } from "../src/workspace.js";
async function fixture(){
 const base=await mkdtemp(path.join(tmpdir(),"captain-human-source-")),root=path.join(base,"repo"),data=path.join(base,"authority");
 await mkdir(root);await git(["init","-b","main"],root);await writeFile(path.join(root,"file.txt"),"baseline");await git(["add","."],root);await git(["-c","user.name=Fixture","-c","user.email=captain@example.invalid","commit","-m","fixture"],root);
 return{root,data,store:new LifecycleStore(data,async()=>({exitCode:0,stdout:"",stderr:""}))};
}
test("adapter automatically recollects same-turn original source rather than a paraphrase",async()=>{
 const f=await fixture(),prompt="Run the full test/build/smoke sequence once and remove visible repository churn.";
 const source=await recordUserRequestSource(f.data,{projectRoot:f.root,sessionId:"s",turnId:"t",prompt,source:"UserPromptSubmit",requestKind:"goal"});
 const args={session_id:"s",turn_id:"t",project_root:f.root,prompt:"investigate",action:"start" as const};
 const issued=await captainIssueIntent(f.store,args);
 assert.equal(issued.user_request.originalText,prompt);
 assert.equal(issued.user_request.status,"expressed");
 assert.equal(issued.user_request.receipts[0].source,"UserPromptSubmit");
 assert.equal(issued.user_request.receipts[0].sourceRecordedAt,source.recordedAt);
 assert.deepEqual(await captainIssueIntent(f.store,args),issued);
});
test("explicit source handle cannot bind another source caller or turn",async()=>{
 const f=await fixture();
 const source=await recordUserRequestSource(f.data,{projectRoot:f.root,sessionId:"s",turnId:"t",prompt:"Fix the churn",source:"UserPromptSubmit"});
 await assert.rejects(()=>captainIssueIntent(f.store,{session_id:"other",turn_id:"t",project_root:f.root,prompt:"do it",source_request_id:source.id,action:"start"}),/source|selectors/);
 const issued=await captainIssueIntent(f.store,{session_id:"s",turn_id:"t",project_root:f.root,prompt:"paraphrase",source_request_id:source.id,action:"start"});
 assert.equal(issued.user_request.originalText,"Fix the churn");
});
