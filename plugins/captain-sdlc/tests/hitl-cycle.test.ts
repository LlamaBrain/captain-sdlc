import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { LifecycleStore, approvedPlanDigest, effectiveGateDisclosure, type SourceState } from "../src/lifecycle.js";

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "captain-hitl-cycle-"));
  const worktree = path.join(root, ".captain-sdlc", "worktrees", "owned");
  await mkdir(worktree, { recursive: true });
  const plan = "# Bounded plan\n\nAC1: the approved view is readable.\n";
  await writeFile(path.join(worktree, "Plan.md"), plan);
  let red = true, commandCount = 0;
  let source: SourceState = { head: "a".repeat(40), tree: "1".repeat(40), status: "", manifest: "base", branch: "captain/owned", branchHead: "a".repeat(40), commonGitDir: path.join(root, ".git"), topLevel: worktree, gitDir: path.join(root, ".git", "worktrees", "owned") };
  const store = new LifecycleStore(path.join(root, "state"), async command => {
    commandCount++;
    if (red && command === "ticket") return { exitCode: 1, stdout: "expected missing behavior", stderr: "" };
    if (command === "build") await writeFile(path.join(worktree, "build.zip"), source.head);
    if (command === "smoke") await writeFile(path.join(worktree, "smoke.json"), JSON.stringify({ pass: true, head: source.head }));
    return { exitCode: 0, stdout: command, stderr: "" };
  }, async () => ({ ...source }));
  await store.markIntent({ intentId: "owned", sessionId: "agent-a", turnId: "start", projectRoot: root, prompt: "Start this plan" });
  await store.begin({ intentId: "owned", taskId: "BOUNDED", objective: "AC1", projectRoot: root, worktreePath: worktree, baseHead: source.head,
    branch: source.branch!, commonGitDir: source.commonGitDir!, gitDir: source.gitDir!, policy: {
      profile: "feature", visualRequired: false, commands: { build: "build", ticket: "ticket", "feature-smoke": "smoke", "affected-regression": "regression" },
      artifactPaths: { build: "build.zip", smoke: "smoke.json" }, redGate: { expectedExitCodes: [1], outputPattern: "expected missing behavior" },
      approvedPlans: [{ path: "Plan.md", sha256: approvedPlanDigest(plan) }],
      hitlChecks: [{ id: "review-ac1", criterionId: "AC1", setup: "Automated layout checks pass; stage the view", action: "Read the displayed labels", expected: "All AC1 labels are readable without overlap", evidence: "Screenshot plus Michael's decision" }]
    } });
  await store.recordRed("owned"); red = false;
  let commitCount = 0;
  async function commit() {
    const previous = commitCount ? source.head : undefined;
    commitCount++;
    source = { ...source, head: String.fromCharCode(97 + commitCount).repeat(40), branchHead: String.fromCharCode(97 + commitCount).repeat(40), tree: String(commitCount + 1).repeat(40), manifest: `source-${commitCount}`, status: "" };
    return store.recordCommit("owned", { head: source.head, tree: source.tree, commitCount, clean: true, subject: `fix: AC1 (v1.0.${commitCount})`, versionChanged: true, changelogChanged: true, preparedMergesValid: true, phaseCommitsValid: true, previousPhaseHead: previous, previousPhaseRetained: true });
  }
  await commit();
  return { root, worktree, store, plan, commit, calls: () => commandCount, dirty: () => { source.status = " M view.ts"; } };
}

test("provable segment enters discoverable HITL, pauses and resumes its same worktree", async () => {
  const f = await fixture();
  const proved = await f.store.prove("owned");
  assert.equal(proved.phase, "hitl");
  assert.equal(effectiveGateDisclosure(proved).planState, "hitl");
  assert.deepEqual(effectiveGateDisclosure(proved).proofStatus, { phase: "complete", status: "green" });
  assert.ok((await f.store.doctor()).activeRuns.some(run => run.intentId === "owned"));
  const calls = f.calls(); await f.store.prove("owned"); assert.equal(f.calls(), calls, "status retry must not rerun proof while waiting for human review");
  await f.store.pause("owned", { summary: "AC1 automatic proof passed; awaiting grouped human review", nextSteps: ["Michael reads the staged labels against AC1"] });
  await f.store.markIntent({ intentId: "resume", sessionId: "agent-b", turnId: "resume", projectRoot: f.root, prompt: "Continue the review", resumeOf: "owned" });
  const resumed = await f.store.resume("resume");
  assert.equal(resumed.phase, "hitl"); assert.equal(resumed.worktreePath, f.worktree);
  const done = await f.store.recordPlanReview("owned", { decision: "accept", humanFeedback: "I read AC1's labels; they are readable and I accept." });
  assert.equal(effectiveGateDisclosure(done).planState, "completed");
  assert.equal(done.status, "green");
  assert.equal((await f.store.doctor()).activeRuns.length, 0);
});

test("rejected original criterion returns the same task to repair then fresh grouped HITL", async () => {
  const f = await fixture(); const proof = await f.store.prove("owned");
  const repaired = await f.store.recordPlanReview("owned", { decision: "needs_changes", humanFeedback: "AC1 fails: the last label overlaps." });
  assert.equal(repaired.phase, "implement"); assert.equal(repaired.worktreePath, f.worktree);
  assert.equal(repaired.runId, proof.runId);
  await assert.rejects(f.store.recordPlanReview("owned", { decision: "accept", humanFeedback: "Accept" }), /proof|HITL/);
  await f.store.runCheck("owned", "ticket"); await f.commit();
  const reproved = await f.store.prove("owned"); assert.equal(reproved.phase, "hitl");
  assert.equal(reproved.runId, proof.runId); assert.equal(await readFile(path.join(f.worktree, "Plan.md"), "utf8"), f.plan);
  const done = await f.store.recordPlanReview("owned", { decision: "accept", humanFeedback: "AC1 passes after repair; I accept." });
  assert.equal(effectiveGateDisclosure(done).planState, "completed");
  assert.equal(done.evidence.filter(item => item.kind === "plan_review").length, 2);
});

test("human acceptance cannot validate source changed after automatic proof", async () => {
  const f = await fixture(); await f.store.prove("owned"); f.dirty();
  await assert.rejects(f.store.recordPlanReview("owned", { decision: "accept", humanFeedback: "Accept AC1" }), /source state|committed|proof/);
});

test("explicit resume recovers legacy completed-proof HITL without a replacement worktree", async () => {
  const f = await fixture(); const proof = await f.store.prove("owned");
  // Reproduce the old deployed representation and its released ownership.
  await (f.store as any).update({ ...proof, phase: "complete", status: "green" });
  await (f.store as any).finalizeCompletion("owned");
  assert.ok((await f.store.doctor()).activeRuns.some(run => run.intentId === "owned"));
  await f.store.markIntent({ intentId: "legacy-resume", sessionId: "new-agent", turnId: "continue", projectRoot: f.root, prompt: "Continue my review", resumeOf: "owned" });
  const resumed = await f.store.resume("legacy-resume");
  assert.equal(resumed.phase, "hitl"); assert.equal(resumed.runId, proof.runId); assert.equal(resumed.worktreePath, f.worktree);
  const repaired = await f.store.recordPlanReview("owned", { decision: "needs_changes", humanFeedback: "AC1's last label still overlaps" });
  assert.equal(repaired.phase, "implement");
  assert.ok(await f.store.permitFor("new-agent", "continue"));
});
