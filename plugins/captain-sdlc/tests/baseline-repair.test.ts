import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { LifecycleStore, effectiveGateDisclosure, type SourceState } from "../src/lifecycle.js";
import { mutationDecision } from "../src/policy.js";
import { readAuthorized, writeAuthorized } from "../src/authority.js";

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "captain-baseline-"));
  const data = await mkdtemp(path.join(tmpdir(), "captain-baseline-data-"));
  const worktree = path.join(root, ".captain-sdlc", "worktrees", "owned");
  const baseHead = "a".repeat(40);
  let state: SourceState = { head: baseHead, tree: "b".repeat(40), status: "", branch: "captain/owned", branchHead: baseHead, commonGitDir: path.join(root, ".git"), gitDir: path.join(root, ".git", "worktrees", "owned"), topLevel: worktree };
  const calls: string[] = [];
  const store = new LifecycleStore(data, async command => { calls.push(command); return { exitCode: 1, stdout: "expected missing behavior", stderr: "" }; }, async () => ({ ...state }));
  await store.markIntent({ intentId: "owned", sessionId: "original", turnId: "start", projectRoot: root, prompt: "Implement feature" });
  const policy = { profile: "low" as const, visualRequired: false, commands: { ticket: "ticket", build: "build" }, artifactPaths: { build: "build.zip" }, redGate: { expectedExitCodes: [1], outputPattern: "expected missing behavior" }, hitlChecks: [{ id: "browser", criterionId: "P6", setup: "Show browser", action: "Select colony", expected: "Show its saves", evidence: "closure.md" }] };
  await store.begin({ intentId: "owned", objective: "Implement feature", projectRoot: root, worktreePath: worktree, baseHead, branch: state.branch!, commonGitDir: state.commonGitDir!, gitDir: state.gitDir!, policy });
  return { store, calls, root, data, state: () => state, change: (next: Partial<SourceState>) => { state = { ...state, ...next }; }, resumeIntent: async () => store.markIntent({ intentId: "continue", sessionId: "next", turnId: "continue", projectRoot: root, prompt: "Continue", resumeOf: "owned" }) };
}

test("resume uses the signed pause HEAD without inventing commit or proof evidence", async () => {
  const f = await fixture(), advanced = "c".repeat(40);
  f.change({ head: advanced, branchHead: advanced, tree: "d".repeat(40), status: " M feature.cs" });
  const handoff = await f.store.pause("owned", { summary: "Authorized commits and dirty task edits retained", nextSteps: ["Continue focused proof"] });
  f.change({ status: " M feature.cs\n?? more-tests.cs" });
  await f.resumeIntent();
  const resumed = await f.store.resume("continue");
  assert.equal(resumed.worktreePath, handoff.worktreePath);
  assert.equal(resumed.phase, "tdd_red");
  assert.equal(resumed.status, "running");
  assert.equal(resumed.committedState, undefined);
  assert.equal(resumed.evidence.some(item => item.kind === "proof_passed" || item.kind === "commit"), false);
  assert.deepEqual(await f.store.resume("continue"), resumed);
  await f.store.recordRed("owned", "ticket");
  assert.deepEqual(f.calls, ["ticket"]);
});

test("resume rejects a HEAD changed after the signed pause", async () => {
  const f = await fixture(), pausedHead = "c".repeat(40), foreignHead = "e".repeat(40);
  f.change({ head: pausedHead, branchHead: pausedHead });
  await f.store.pause("owned", { summary: "Retain task", nextSteps: ["Continue"] });
  f.change({ head: foreignHead, branchHead: foreignHead });
  await f.resumeIntent();
  await assert.rejects(() => f.store.resume("continue"), /binding diverged/);
  assert.equal((await f.store.status("owned")).status, "paused");
});

test("pause cannot authorize a foreign worktree binding", async () => {
  const f = await fixture();
  f.change({ branch: "other/task" });
  await assert.rejects(() => f.store.pause("owned", { summary: "Wrong branch", nextSteps: ["Continue"] }), /binding diverged/);
  assert.equal((await f.store.status("owned")).status, "running");
});

test("human acceptance is captured before proof without running gates or completing the run", async () => {
  const f = await fixture();
  const feedback = "I just did a HITL test. Seems to pass. Retired bool as well.";
  const run = await f.store.recordHitlFeedback("owned", { decision: "accept", humanFeedback: feedback, checkIds: ["browser"], evidenceReferences: ["closure.md#human-hitl-feedback"] });
  assert.equal(run.phase, "tdd_red");
  assert.equal(run.status, "running");
  assert.deepEqual(f.calls, []);
  assert.equal(run.committedState, undefined);
  assert.equal(run.evidence.some(item => item.kind === "proof_passed" || item.kind === "plan_review"), false);
  assert.equal(effectiveGateDisclosure(run).humanReview?.decision, "accept");
  assert.match(effectiveGateDisclosure(run).phaseAcceptance, /accepted/);
  assert.deepEqual(await f.store.recordHitlFeedback("owned", { decision: "accept", humanFeedback: feedback, checkIds: ["browser"], evidenceReferences: ["closure.md#human-hitl-feedback"] }), run);
  await assert.rejects(() => f.store.recordPlanReview("owned", { decision: "accept", humanFeedback: feedback }), /green proof/);
});

test("failed checks retain earlier human feedback and exact source provenance", async () => {
  const f = await fixture();
  await f.store.recordRed("owned", "ticket");
  const reviewed = await f.store.recordHitlFeedback("owned", { decision: "accept", humanFeedback: "We passed the HITL and stuff.", checkIds: ["browser"], evidenceReferences: ["closure.md"] });
  f.change({ status: " M bookkeeping.md" });
  const failed = await f.store.runCheck("owned", "ticket");
  assert.equal(failed.evidence.at(-1)?.exitCode, 1);
  assert.deepEqual(effectiveGateDisclosure(failed).humanReview, effectiveGateDisclosure(reviewed).humanReview);
  assert.equal(effectiveGateDisclosure(failed).humanReview?.recordedSource?.status, "");
  assert.equal(failed.phase, "implement");
});

test("feedback rejects undeclared checks and paused ownership, and rejection stays incomplete", async () => {
  const f = await fixture();
  await assert.rejects(() => f.store.recordHitlFeedback("owned", { decision: "accept", humanFeedback: "Passed", checkIds: ["foreign"], evidenceReferences: [] }), /declared HITL/);
  const rejected = await f.store.recordHitlFeedback("owned", { decision: "needs_changes", humanFeedback: "Button is clipped", checkIds: ["browser"], evidenceReferences: [] });
  assert.notEqual(rejected.phase, "complete");
  assert.notEqual(rejected.status, "green");
  await f.store.pause("owned", { summary: "Handoff", nextSteps: ["Repair clipping"] });
  await assert.rejects(() => f.store.recordHitlFeedback("owned", { decision: "accept", humanFeedback: "Passed", checkIds: ["browser"], evidenceReferences: [] }), /resume|ownership/);
});

test("feedback is an owned audited operation in every active phase", () => {
  for (const phase of ["tdd_red", "implement", "prove", "hitl"]) {
    const input = { toolName: "mcp__captain-sdlc__captain_record_hitl_feedback", cwd: process.cwd(), sessionId: "s", intentId: "owned", permit: { sessionId: "s", worktreePath: process.cwd(), phase, intentId: "owned" } };
    assert.equal(mutationDecision(input).allow, true);
    assert.equal(mutationDecision({ ...input, intentId: "foreign" }).allow, false);
    assert.equal(mutationDecision({ ...input, sessionId: "foreign" }).allow, false);
    assert.equal(mutationDecision({ ...input, permit: null }).allow, false);
  }
});

test("resume rejects signed handoffs belonging to a stale revision or foreign run", async () => {
  for (const change of [{ revision: 1 }, { runId: "foreign" }, { intentId: "foreign" }, { worktreePath: "foreign" }]) {
    const f = await fixture(), advanced = "c".repeat(40);
    f.change({ head: advanced, branchHead: advanced });
    const handoff = await f.store.pause("owned", { summary: "Retained task", nextSteps: ["Continue"] });
    await writeAuthorized(f.data, "pause-handoffs", `owned-${handoff.revision}`, { ...handoff, ...change });
    await f.resumeIntent();
    await assert.rejects(() => f.store.resume("continue"), /handoff binding diverged/);
  }
});

test("resume never uses an older snapshot when the current signed handoff is absent", async () => {
  const f = await fixture(), advanced = "c".repeat(40);
  f.change({ head: advanced, branchHead: advanced });
  const handoff = await f.store.pause("owned", { summary: "Retained task", nextSteps: ["Continue"] });
  const run = await f.store.status("owned");
  await (f.store as any).update({ ...run, evidence: [...run.evidence, { kind: "bookkeeping" }] });
  assert.ok(await readAuthorized(f.data, "pause-handoffs", `owned-${handoff.revision}`));
  await f.resumeIntent();
  await assert.rejects(() => f.store.resume("continue"), /binding diverged/);
});

test("a crash after the signed resume revision retries with a valid active permit", async () => {
  const f = await fixture(), advanced = "c".repeat(40);
  f.change({ head: advanced, branchHead: advanced });
  await f.store.pause("owned", { summary: "Keep advanced task", nextSteps: ["Continue"] });
  await f.resumeIntent();
  let crashed = false;
  const interrupted = new LifecycleStore(f.data, async () => ({ exitCode: 0, stdout: "", stderr: "" }), async () => f.state(), { afterRunRevision: async run => { if (!crashed && run.turnId === "continue") { crashed = true; throw new Error("crash after signed resume"); } } });
  await assert.rejects(() => interrupted.resume("continue"), /crash after signed resume/);
  const resumed = await f.store.resume("continue");
  assert.equal(resumed.status, "running");
  assert.equal(resumed.continuityState?.head, advanced);
  assert.ok(await f.store.permitFor("next", "continue"));
});

test("a matching pause snapshot never bypasses an interrupted prepared commit", async () => {
  const f = await fixture(), advanced = "c".repeat(40);
  const run = await f.store.status("owned");
  await (f.store as any).update({ ...run, preparedCommit: { preCommitHead: run.baseHead, candidate: "d".repeat(40) } });
  f.change({ head: advanced, branchHead: advanced });
  await f.store.pause("owned", { summary: "Diagnose advanced HEAD", nextSteps: ["Verify prepared ancestry"] });
  await f.resumeIntent();
  await assert.rejects(() => f.store.resume("continue"), /binding diverged/);
});

test("a failed automated proof retains accepted human feedback and stays red", async () => {
  const f = await fixture();
  await f.store.recordRed("owned", "ticket");
  const advanced = "c".repeat(40);
  f.change({ head: advanced, branchHead: advanced });
  await f.store.recordCommit("owned", { head: advanced, tree: f.state().tree, commitCount: 1, clean: true, subject: "feat: browser (v1.1.0)", versionChanged: true, changelogChanged: true, preparedMergesValid: true, phaseCommitsValid: true });
  await f.store.recordHitlFeedback("owned", { decision: "accept", humanFeedback: "We passed the HITL and stuff.", checkIds: ["browser"], evidenceReferences: ["closure.md"] });
  await assert.rejects(() => f.store.prove("owned"), /build proof failed/);
  const failed = await f.store.status("owned");
  assert.equal(failed.status, "red");
  assert.equal(failed.phase, "implement");
  assert.equal(effectiveGateDisclosure(failed).humanReview?.decision, "accept");
});

test("review disclosure tracks partial decisions and later rejection in evidence order", async () => {
  const f = await fixture(), run = await f.store.status("owned");
  const otherCheck = { ...run.policy.hitlChecks![0], id: "retired" };
  const reviewed = { ...run, policy: { ...run.policy, hitlChecks: [...run.policy.hitlChecks!, otherCheck] }, evidence: [
    { kind: "hitl_feedback", decision: "accept", checkIds: ["browser"] },
    { kind: "hitl_feedback", decision: "accept", checkIds: ["retired"] }
  ] };
  assert.deepEqual(effectiveGateDisclosure(reviewed).humanReviewStatus.acceptedCheckIds, ["browser", "retired"]);
  const partial = effectiveGateDisclosure({ ...reviewed, evidence: reviewed.evidence.slice(0, 1) });
  assert.deepEqual(partial.humanReviewStatus.unreviewedCheckIds, ["retired"]);
  const rejected = effectiveGateDisclosure({ ...reviewed, evidence: [...reviewed.evidence, { kind: "plan_review", decision: "needs_changes", checkIds: ["browser", "retired"] }] });
  assert.deepEqual(rejected.humanReviewStatus.acceptedCheckIds, []);
  assert.deepEqual(rejected.humanReviewStatus.needsChangesCheckIds, ["browser", "retired"]);
  assert.match(rejected.phaseAcceptance, /requested changes/);
});
