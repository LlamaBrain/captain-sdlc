import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, unlink, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { LifecycleStore, effectiveGateDisclosure, proofScopes } from "../src/lifecycle.js";
import { loadPolicy } from "../src/workspace.js";

const content = "# Approved\n\nOne acceptance criterion.\n";
async function fixture(bound = true, hitlChecks?: any[]) {
  const root = await mkdtemp(path.join(tmpdir(), "scope-freeze-")), data = await mkdtemp(path.join(tmpdir(), "scope-data-"));
  const worktreePath = path.join(root, ".captain-sdlc", "worktrees", "scope");
  await mkdir(worktreePath, { recursive: true }); await writeFile(path.join(worktreePath, "Plan.md"), content);
  let calls = 0;
  const store = new LifecycleStore(data, async () => { calls++; return { exitCode: 1, stdout: "expected", stderr: "" }; });
  await store.markIntent({ intentId: "scope", sessionId: "s", turnId: "t", projectRoot: root, prompt: "implement" });
  const policy = { ...(hitlChecks ? { hitlChecks } : {}), profile: "feature" as const, visualRequired: false, commands: { ticket: "ticket" }, redGate: { expectedExitCodes: [1], outputPattern: "expected" }, ...(bound ? { approvedPlans: [{ path: "Plan.md", sha256: createHash("sha256").update(content).digest("hex") }] } : {}) };
  await store.begin({ intentId: "scope", objective: "one criterion", projectRoot: root, worktreePath, baseHead: "a".repeat(40), branch: "captain/scope", commonGitDir: path.join(root, ".git"), gitDir: path.join(root, ".git", "worktrees", "scope"), policy });
  return { store, root, worktreePath, calls: () => calls };
}
test("changed or deleted approved plans stop execution before the red command", async () => {
  for (const deletion of [false, true]) {
    const f = await fixture(); const file = path.join(f.worktreePath, "Plan.md");
    if (deletion) await unlink(file); else await writeFile(file, content + "Added gate\n");
    await assert.rejects(f.store.recordRed("scope"), /frozen approved plan/i); assert.equal(f.calls(), 0);
  }
});
test("scope checks apply before checks, commit reservation, recorded commit and proof", async () => {
  const f = await fixture(); await f.store.recordRed("scope"); await writeFile(path.join(f.worktreePath, "Plan.md"), content + "New requirement\n");
  for (const action of [() => f.store.runCheck("scope", "ticket"), () => f.store.acquireWorktreeMutation("scope", "commit", {}), () => f.store.reserveCommitOperation("scope", { paths: ["Plan.md"], subject: "fix: scope", final: true }), () => f.store.recordCommit("scope", {} as any), () => f.store.prove("scope")]) await assert.rejects(action, /frozen approved plan/i);
  assert.equal(f.calls(), 1);
});
test("active owner is preserved and paused ownership can resume in the same dirty worktree", async () => {
  const f = await fixture(); await f.store.markIntent({ intentId: "other", sessionId: "other", turnId: "t2", projectRoot: f.root, prompt: "resume", resumeOf: "scope" });
  await assert.rejects(f.store.resume("other"), /owner must pause/);
  await writeFile(path.join(f.worktreePath, "work-in-progress.txt"), "preserved");
  await f.store.pause("scope", { summary: "handoff", nextSteps: ["finish original criterion"] });
  const run = await f.store.resume("other"); assert.equal(run.worktreePath, f.worktreePath); assert.equal(run.sessionId, "other");
  assert.equal(await readFile(path.join(f.worktreePath, "work-in-progress.txt"), "utf8"), "preserved");
});
test("gate disclosure uses the executed scopes and honestly reports legacy binding", async () => {
  const f = await fixture(), run = await f.store.status("scope"), disclosure = effectiveGateDisclosure(run);
  assert.equal(disclosure.scopeBinding, "frozen"); assert.deepEqual(disclosure.gates.map(gate => gate.scope), ["build", "ticket", "feature-smoke", "affected-regression"]); assert.deepEqual(proofScopes({ profile: "low", visualRequired: false }), ["build"]); assert.deepEqual(proofScopes({ profile: "pre-release", visualRequired: true }), ["build", "ticket", "feature-smoke", "affected-regression", "super-smoke", "visual"]); assert.equal(disclosure.phaseAcceptance, "not inferred from proof status");
  const legacy = await fixture(false); assert.equal(effectiveGateDisclosure(await legacy.store.status("scope")).scopeBinding, "unbound");
});
test("starting accepts selected plan approval; paused remains working and green completion completes it", async () => {
  const f = await fixture(), run = await f.store.status("scope");
  assert.equal(effectiveGateDisclosure(run).planState, "working"); assert.equal(effectiveGateDisclosure(run).approvalAccepted, true);
  await f.store.pause("scope", { summary: "pause", nextSteps: ["finish"] }); assert.equal(effectiveGateDisclosure(await f.store.status("scope")).planState, "working");
  assert.equal(effectiveGateDisclosure({ ...run, phase: "complete", status: "green" }).planState, "completed");
  const legacy = await fixture(false); const unbound = effectiveGateDisclosure(await legacy.store.status("scope")); assert.equal(unbound.planState, "unbound"); assert.equal(unbound.approvalAccepted, false);
});
test("resume rejects scope expansion before granting a new turn", async () => {
  const f = await fixture(); await f.store.markIntent({ intentId: "resume", sessionId: "s", turnId: "t2", projectRoot: f.root, prompt: "resume", resumeOf: "scope" });
  await writeFile(path.join(f.worktreePath, "Plan.md"), content + "New scope\n"); await assert.rejects(f.store.resume("resume"), /frozen approved plan/i);
});
test("external followups and CRLF checkout do not alter frozen scope; legacy runs work", async () => {
  const f = await fixture(); await writeFile(path.join(f.worktreePath, "Plan.md"), content.replaceAll("\n", "\r\n")); await writeFile(path.join(f.worktreePath, "followups.md"), "Human closeout only\n");
  assert.equal((await f.store.recordRed("scope")).phase, "implement");
  const legacy = await fixture(false); await writeFile(path.join(legacy.worktreePath, "Plan.md"), "legacy"); assert.equal((await legacy.store.recordRed("scope")).phase, "implement");
});
test("pause keeps progress in signed handoff; frozen plan migration is prohibited", async () => {
  const f = await fixture(); await f.store.recordRed("scope"); await assert.rejects(f.store.migratePlanState("scope", ["Plan.md"]), /frozen approved plan/i);
  await f.store.pause("scope", { summary: "paused", nextSteps: ["finish original criterion"], planPath: "Plan.md" }); assert.equal(await readFile(path.join(f.worktreePath, "Plan.md"), "utf8"), content);
});
test("trusted base binds plan even when worktree policy and plan have changed", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "scope-git-")); const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args], { cwd: root, windowsHide: true }).toString().trim();
  git("init"); await mkdir(path.join(root, ".captain-sdlc")); await writeFile(path.join(root, "Plan.md"), content);
  await writeFile(path.join(root, ".captain-sdlc", "codex-policy.json"), JSON.stringify({ profile: "feature", visualRequired: false, commands: { build: "build", ticket: "ticket", "feature-smoke": "smoke", "affected-regression": "affected" }, approvedPlanPaths: ["Plan.md"] })); git("add", "."); git("commit", "-m", "base"); const head = git("rev-parse", "HEAD");
  await writeFile(path.join(root, "Plan.md"), "changed"); const policy = await loadPolicy(root, head);
  assert.deepEqual((policy as any).approvedPlans, [{ path: "Plan.md", sha256: createHash("sha256").update(content).digest("hex") }]);
});

test("trusted policy refuses unsafe approved plan paths", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "scope-unsafe-")); const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args], { cwd: root, windowsHide: true }).toString().trim();
  git("init"); await mkdir(path.join(root, ".captain-sdlc"));
  await writeFile(path.join(root, ".captain-sdlc", "codex-policy.json"), JSON.stringify({ profile: "feature", visualRequired: false, commands: { build: "build", ticket: "ticket", "feature-smoke": "smoke", "affected-regression": "affected" }, approvedPlanPaths: ["../outside.md"] }));
  git("add", "."); git("commit", "-m", "unsafe config"); await assert.rejects(loadPolicy(root, git("rev-parse", "HEAD")), /approved plan/);
});
test("explicitly selected plans bind trusted base without a policy edit and union with configured plans", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "scope-selected-")); const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args], { cwd: root, windowsHide: true }).toString().trim();
  git("init"); await mkdir(path.join(root, ".captain-sdlc")); await writeFile(path.join(root, "Plan.md"), content); await writeFile(path.join(root, "Other.md"), "# Other\n");
  const config = { profile: "feature", visualRequired: false, commands: { build: "build", ticket: "ticket", "feature-smoke": "smoke", "affected-regression": "affected" } };
  await writeFile(path.join(root, ".captain-sdlc", "codex-policy.json"), JSON.stringify(config)); git("add", "."); git("commit", "-m", "base");
  await assert.rejects(loadPolicy(root, git("rev-parse", "HEAD"), undefined, [{ id: "unbound", criterionId: "AC1", setup: "scene", action: "place", expected: "visible", evidence: "image" }]), /HITL checks require an approved plan/);
  const policy = await loadPolicy(root, git("rev-parse", "HEAD"), ["Plan.md"]); assert.deepEqual(policy.approvedPlans, [{ path: "Plan.md", sha256: createHash("sha256").update(content).digest("hex") }]);
  await writeFile(path.join(root, ".captain-sdlc", "codex-policy.json"), JSON.stringify({ ...config, approvedPlanPaths: ["Plan.md"] })); git("add", "."); git("commit", "-m", "configured");
  const union = await loadPolicy(root, git("rev-parse", "HEAD"), ["Plan.md", "Other.md"]); assert.deepEqual(union.approvedPlans?.map(plan => plan.path), ["Other.md", "Plan.md"]);
  const checks = [{ id: "visual", criterionId: "AC1", setup: "scene", action: "place", expected: "visible", evidence: "screenshot" }];
  await writeFile(path.join(root, ".captain-sdlc", "codex-policy.json"), JSON.stringify({ ...config, approvedPlanPaths: ["Plan.md"], hitlChecks: checks })); git("add", "."); git("commit", "-m", "freeze review goals");
  const reviewHead = git("rev-parse", "HEAD"); const frozen = await loadPolicy(root, reviewHead, ["Plan.md"], checks); assert.deepEqual(frozen.hitlChecks, checks);
  await assert.rejects(loadPolicy(root, reviewHead, ["Plan.md"], [{ ...checks[0], expected: "added requirement" }]), /conflicting frozen HITL/);
  await assert.rejects(loadPolicy(root, reviewHead, ["Plan.md"], [{ ...checks[0], evidence: "" }]), /evidence goals/);
});

const reviewChecks = [{ id: "visual-1", criterionId: "AC1", setup: "Open the approved scene", action: "Place one room", expected: "Room is visible", evidence: "screenshot path" }];
test("legacy green proof stays pending and requires resuming HITL before review", async () => {
  const f = await fixture(true, reviewChecks);
  await assert.rejects(f.store.recordPlanReview("scope", { decision: "accept", humanFeedback: "Looks right" }), /green proof/);
  const run = await f.store.status("scope"); await (f.store as any).update({ ...run, phase: "complete", status: "green" });
  assert.equal(effectiveGateDisclosure(await f.store.status("scope")).planState, "hitl");
  await assert.rejects(f.store.recordPlanReview("scope", { decision: "accept", humanFeedback: " " }), /human feedback/);
  await assert.rejects(f.store.recordPlanReview("scope", { decision: "needs_changes", humanFeedback: "The original room criterion is not met" }), /resume legacy pending review/);
  await assert.rejects(f.store.recordPlanReview("scope", { decision: "accept", humanFeedback: "I inspected AC1 and accept its visible result" }), /resume legacy pending review/);
  assert.equal(effectiveGateDisclosure(await f.store.status("scope")).planState, "hitl");
  assert.deepEqual(effectiveGateDisclosure(await f.store.status("scope")).hitlChecks, reviewChecks);
  const ordinary = await fixture(); const plain = await ordinary.store.status("scope"); await (ordinary.store as any).update({ ...plain, phase: "complete", status: "green" });
  await assert.rejects(ordinary.store.recordPlanReview("scope", { decision: "accept", humanFeedback: "accept" }), /declared HITL/);
});
