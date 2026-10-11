import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { LifecycleStore } from "../src/lifecycle.js";
import { captainBegin, captainIssueIntent, captainResume } from "../src/server.js";
import { git } from "../src/workspace.js";

const goal = "When the commit is done - run a full edittest/playtest/build/smoke-test (do a single full run).\nThen list all files that are marked changed and show evidence of system level churn during one of those phases (test/build/smoke).\nFinally make it so test/build/smoke sequence produces no visible churn on the repo - and the repo is clean after building.";
async function fixture() {
 const root = await mkdtemp(path.join(tmpdir(), "captain-objective-"));
 const data = await mkdtemp(path.join(tmpdir(), "captain-objective-data-"));
 await git(["init", "-b", "main"], root);
 await mkdir(path.join(root, ".captain-sdlc"));
 await writeFile(path.join(root, ".captain-sdlc/codex-policy.json"), JSON.stringify({profile:"feature",visualRequired:false,commands:{build:"build",ticket:"ticket","feature-smoke":"smoke","affected-regression":"regression"}}));
 await writeFile(path.join(root, "file.txt"), "base\n");
 await git(["add", "."], root);
 await git(["-c","user.name=Captain Test","-c","user.email=captain@example.invalid","commit","-m","fixture"],root);
 const store = new LifecycleStore(data, async () => ({exitCode:0,stdout:"",stderr:""}));
 return {root,data,store};
}
test("original full-run objective and consent are returned at issuance before Begin", async () => {
 const {root,data,store}=await fixture();
 const args={session_id:"s",turn_id:"goal",project_root:root,prompt:goal,task_id:"CHURN",action:"start" as const,request_kind:"goal" as const};
 const issued:any=await captainIssueIntent(store,args);
 assert.equal(issued.user_request?.status,"expressed","expressed goal must be retained and surfaced before recovery");
 assert.equal(issued.user_request.originalText,goal);
 assert.deepEqual(issued.user_request.objectiveLines,goal.split("\n"));
 const replay:any=await captainIssueIntent(store,args);
 assert.deepEqual(replay.user_request,issued.user_request);
 const restarted:any=new LifecycleStore(data,async()=>({exitCode:0,stdout:"",stderr:""}));
 assert.deepEqual(await restarted.userRequests({projectRoot:root,intentId:issued.intent_id}),issued.user_request);
});
test("status, signed pause and resume recollect human wording rather than expanded agent objective",async()=>{
 const {root,store}=await fixture();
 const issued=await captainIssueIntent(store,{session_id:"s",turn_id:"first",project_root:root,prompt:"Fix the churn",task_id:"CHURN",action:"start"});
 const run=await captainBegin(store,{intent_id:issued.intent_id,project_root:root,task_id:"CHURN",objective:"An agent's expanded implementation objective"});
 assert.equal((run as any).user_request.originalText,"Fix the churn");
 assert.equal((await store.status(run.intentId) as any).user_request.status,"expressed");
 const handoff:any=await store.pause(run.intentId,{summary:"Requested bounded handoff",nextSteps:["Continue same implementation"]});
 assert.equal(handoff.user_request.originalText,"Fix the churn");
 const continuation:any=await captainIssueIntent(store,{session_id:"s2",turn_id:"later",project_root:root,prompt:"do it",action:"resume",resume_of:run.intentId,task_id:"CHURN"});
 assert.equal(continuation.user_request.originalText,"Fix the churn");
 assert.equal(continuation.user_request.status,"expressed");
 const resumed:any=await captainResume(store,continuation.intent_id);
 assert.equal(resumed.intentId,run.intentId);
 assert.equal(resumed.user_request.originalText,"Fix the churn");
});
test("public failed-Begin diagnosis includes original request only for verified same caller",async()=>{
 const {root,store}=await fixture();
 const issued=await captainIssueIntent(store,{session_id:"s",turn_id:"failed",project_root:root,prompt:goal,task_id:"CHURN",action:"start"});
 await assert.rejects(()=>captainBegin(store,{intent_id:issued.intent_id,project_root:root,task_id:"CHURN",objective:"Expanded agent objective"},{
  repositoryIdentity:async()=>{throw new Error("fixture stops before workspace");},
  loadPolicy:async()=>{throw new Error("not reached");},
  ensureWorktree:async()=>{throw new Error("not reached");}
 }));
 const diagnostic:any=await store.diagnoseBegin({intent_id:issued.intent_id,session_id:"s",project_root:root,target_worktree:root,target_branch:"main"});
 assert.equal(diagnostic.user_request?.originalText,goal,"failed setup must not lose the user's actual authority");
 const foreign:any=await store.diagnoseBegin({intent_id:issued.intent_id,session_id:"other",project_root:root,target_worktree:root,target_branch:"main"});
 assert.equal(foreign.user_request,undefined);
});
