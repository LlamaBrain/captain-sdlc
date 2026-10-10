import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { LifecycleStore } from "../src/lifecycle.js";
import { captainBegin, captainIssueIntent } from "../src/server.js";
import { git } from "../src/workspace.js";

const temp = () => mkdtemp(path.join(tmpdir(), "captain-adapter-"));
const request = (root: string) => ({ session_id: "s", turn_id: "t", project_root: root, prompt: "continue the approved task" });
function mockStore(runs: any[]) {
  const intents: any[] = [];
  return { intents, store: { issueIdempotentIntent: async (_request: unknown, factory: () => Promise<any>) => { const intent = await factory(); intents.push(intent); return intent; }, doctor: async () => ({ activeRuns: runs }), status: async (id: string) => runs.find(run => run.intentId === id), sessionInterruptionStatus: async () => ({ owner: { state: "legacy" }, canRecover: false }), markIntent: async (intent: any) => { intents.push(intent); }, recordUserAuthorization: async () => {} } as unknown as LifecycleStore };
}
test("adapter pins the requested target branch rather than checkout HEAD", async () => {
  const root = await temp(), data = await temp();
  await git(["init", "-b", "main"], root);
  await git(["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-m", "base"], root);
  await git(["branch", "spike/colony"], root);
  const target = await git(["rev-parse", "HEAD"], root);
  await git(["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-m", "later"], root);
  const store = new LifecycleStore(data, async () => ({ exitCode: 0, stdout: "", stderr: "" }));
  for (const args of [{ prompt: "fix lifecycle\n[Captain target: spike/colony]" }, { target_branch: "spike/colony" }]) {
    const result = await captainIssueIntent(store, { ...request(root), turn_id: JSON.stringify(args), ...args });
    const intent = await store.validateIntent(result.intent_id, root);
    assert.equal(intent.targetBranch, "spike/colony"); assert.equal(intent.targetOid, target);
  }
});
test("adapter rejects conflicting target and start/resume selectors", async () => {
  const { store } = mockStore([]), root = await temp();
  await assert.rejects(() => captainIssueIntent(store, { ...request(root), target_branch: "other", prompt: "[Captain target: spike/colony]" }), /conflict/);
  await assert.rejects(() => captainIssueIntent(store, { ...request(root), target_branch: "bad\nbranch" }), /invalid/);
  await assert.rejects(() => captainIssueIntent(store, { ...request(root), action: "start", resume_of: "old" }), /conflict/);
});
test("task resume resolves a unique unfinished run without a magic phrase", async () => {
  const root = await temp(), { store, intents } = mockStore([{ intentId: "old", taskId: "P2", projectRoot: root, status: "paused", sessionId: "previous", worktreePath: path.join(root, "prior") }]);
  const result = await captainIssueIntent(store, { ...request(root), task_id: "P2", action: "resume" });
  assert.match(result.resume_instruction!, /captain_resume_implementation/); assert.equal(intents[0].resumeOf, "old");
});
test("ambiguous tasks and another session's active work are never silently adopted", async () => {
  const root = await temp(), run = { intentId: "old", taskId: "P2", projectRoot: root, status: "paused", sessionId: "previous" };
  await assert.rejects(() => captainIssueIntent(mockStore([run, { ...run, intentId: "other" }]).store, { ...request(root), task_id: "P2" }), /ambiguous/);
  await assert.rejects(() => captainIssueIntent(mockStore([{ ...run, status: "running" }]).store, { ...request(root), resume_of: "old" }), /active.*session/);
  await assert.rejects(() => captainIssueIntent(mockStore([]).store, { ...request(root), action: "resume", task_id: "missing" }), /no unfinished/);
});
test("adapter resumes a paused task in the original signed worktree", async () => {
  const root = await temp(), data = await temp(), worktreePath = path.join(root, ".captain-sdlc", "worktrees", "existing"), head = "a".repeat(40);
  const binding = { branch: "spike/colony", commonGitDir: path.join(root, ".git"), gitDir: path.join(root, ".git", "worktrees", "existing") };
  let currentPath = worktreePath;
  const store = new LifecycleStore(data, async () => ({ exitCode: 0, stdout: "", stderr: "" }), async () => ({ head, tree: "b".repeat(40), status: "", ...binding, topLevel: currentPath, branchHead: head }));
  await store.markIntent({ intentId: "prior", sessionId: "previous", turnId: "old", projectRoot: root, prompt: "implement P2" });
  const before = await store.begin({ intentId: "prior", objective: "implement P2", taskId: "P2", projectRoot: root, worktreePath, baseHead: head, ...binding, policy: { profile: "feature", visualRequired: false, commands: {} } });
  await store.pause("prior", { summary: "paused at checkpoint", nextSteps: ["continue existing task"] });
  const issued = await captainIssueIntent(store, { ...request(root), task_id: "P2", action: "resume", target_branch: "spike/colony" });
  const after = await store.resume(issued.intent_id);
  assert.equal(after.runId, before.runId); assert.equal(after.worktreePath, worktreePath); assert.equal(after.branch, "spike/colony"); assert.equal(after.sessionId, "s");
  currentPath = path.join(root, "different-worktree");
  const next = await captainIssueIntent(store, { ...request(root), turn_id: "next", task_id: "P2", action: "resume" });
  await assert.rejects(() => store.resume(next.intent_id), /worktree.*binding/);
});
test("starting a selected plan freezes it without manual policy configuration and rejects changed retries", async () => {
  const root = await temp(), data = await temp();
  await git(["init", "-b", "main"], root);
  await mkdir(path.join(root, ".captain-sdlc"));
  await writeFile(path.join(root, ".captain-sdlc", "codex-policy.json"), JSON.stringify({ profile: "feature", visualRequired: false, commands: { build: "build", ticket: "ticket", "feature-smoke": "smoke", "affected-regression": "regression" } }));
  await writeFile(path.join(root, "PLAN.md"), "# Draft\nAcceptance: deliver the agreed behavior\n");
  await writeFile(path.join(root, "OTHER.md"), "# Another plan\n");
  await git(["add", "."], root);
  await git(["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "draft plans"], root);
  const store = new LifecycleStore(data, async () => ({ exitCode: 0, stdout: "", stderr: "" }));
  const issued = await captainIssueIntent(store, { ...request(root), action: "start" });
  const hitlChecks = [{ id: "review-1", criterionId: "AC1", setup: "Open the delivered view", action: "Inspect the approved behavior", expected: "The accepted criterion is satisfied", evidence: "closeout.md" }];
  const args = { intent_id: issued.intent_id, objective: "start this plan", project_root: root, plan_paths: ["PLAN.md"], hitl_checks: hitlChecks };
  const run = await captainBegin(store, args);
  assert.equal(run.policy.approvedPlans?.[0].path, "PLAN.md");
  assert.deepEqual(run.policy.hitlChecks, hitlChecks);
  assert.equal((await captainBegin(store, args)).runId, run.runId);
  await assert.rejects(() => captainBegin(store, { ...args, plan_paths: ["OTHER.md"] }), /plan.*selection|policy/);
  await assert.rejects(() => captainBegin(store, { ...args, plan_paths: undefined }), /HITL checks require an approved plan selected at begin/);
  await assert.rejects(() => captainBegin(store, { ...args, hitl_checks: [] }), /frozen.*check|policy/);
});
