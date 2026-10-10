import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { LifecycleStore, type SourceState, type Run } from "../src/lifecycle.js";
import { ensureAuthorizedLease, readAuthorizedLease, releaseAuthorizedLease, writeAuthorized } from "../src/authority.js";

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "captain-proof-repair-"));
  const data = await mkdtemp(path.join(tmpdir(), "captain-proof-repair-authority-"));
  const worktree = path.join(root, ".captain-sdlc", "worktrees", "repair");
  await mkdir(worktree, { recursive: true });
  const policy = { profile: "feature" as const, visualRequired: false, commands: { ticket: "ticket", build: "build", "feature-smoke": "smoke", "affected-regression": "affected" }, artifactPaths: { build: "build.zip", smoke: "smoke.json" }, redGate: { expectedExitCodes: [1], outputPattern: "ticket" } };
  const binding = { branch: "captain/repair", commonGitDir: path.join(root, ".git"), gitDir: path.join(root, ".git", "worktrees", "repair") };
  const state: SourceState = { ...binding, head: "a".repeat(40), branchHead: "a".repeat(40), tree: "c".repeat(40), status: "", manifest: "manifest-before", topLevel: worktree };
  const commands: string[] = [];
  let red = true, sequence = 0, commitCount = 0;
  const controls: { onProbe?: () => Promise<void>; onCommand?: (command: string) => Promise<void> } = {};
  const store = new LifecycleStore(data, async command => {
    commands.push(command);
    await controls.onCommand?.(command);
    if (command === "ticket" && red) { red = false; return { exitCode: 1, stdout: "ticket fails", stderr: "" }; }
    if (command === "build") await writeFile(path.join(worktree, "build.zip"), `build-${++sequence}`);
    if (command === "smoke") await writeFile(path.join(worktree, "smoke.json"), `smoke-${++sequence}`);
    return { exitCode: 0, stdout: command, stderr: "" };
  }, async () => { await controls.onProbe?.(); return { ...state }; });
  await store.markIntent({ intentId: "repair", sessionId: "owner", turnId: "turn-1", projectRoot: root, prompt: "repair proof source" });
  await store.begin({ intentId: "repair", objective: "repair proof source", projectRoot: root, worktreePath: worktree, baseHead: state.head, ...binding, policy });
  await store.recordRed("repair", "ticket");
  async function commit(head: string) {
    const previousPhaseHead = state.head;
    state.head = state.branchHead = head;
    return store.recordCommit("repair", { head, tree: state.tree, commitCount: ++commitCount, previousPhaseHead, previousPhaseRetained: true, clean: true, subject: "fix(captain): repair proof (v1.2.1)", versionChanged: true, changelogChanged: true, preparedMergesValid: true, phaseCommitsValid: true });
  }
  const committed = await commit("b".repeat(40));
  commands.length = 0;
  return { root, data, worktree, policy, state, commands, controls, store, committed, commit };
}

function retained(before: Run, after: Run) {
  for (const key of ["runId", "intentId", "worktreePath", "branch", "sessionId", "policy", "committedState"] as const)
    assert.deepEqual(after[key], before[key], key);
  assert.deepEqual(after.evidence.slice(0, before.evidence.length), before.evidence);
}

for (const change of ["dirty", "manifest"] as const) test(`D1 proof ${change} divergence returns same owned run to implementation before commands`, async () => {
  const f = await fixture();
  if (change === "dirty") f.state.status = " M Assets/Quality.asset";
  else f.state.manifest = "manifest-after";
  await assert.rejects(() => f.store.prove("repair"), /source state diverged/);
  const after = await f.store.status("repair");
  assert.equal(after.phase, "implement"); assert.equal(after.status, "red");
  assert.deepEqual(f.commands, []); retained(f.committed, after);
  assert.equal(after.evidence.at(-1)?.kind, "proof_error");
  assert.equal(after.evidence.at(-1)?.repairRequired, true);
});

test("D1 successful build that changes source returns to implementation and retains build output", async () => {
  const f = await fixture();
  f.controls.onCommand = async command => { if (command === "build") f.state.status = " M Assets/ExportedIds.asset"; };
  await assert.rejects(() => f.store.prove("repair"), /source state diverged/);
  const after = await f.store.status("repair");
  assert.equal(after.phase, "implement"); assert.equal(after.status, "red"); retained(f.committed, after);
  assert.deepEqual(f.commands, ["build"]); assert.equal(f.state.status, " M Assets/ExportedIds.asset");
});

test("D1 repaired source can use existing commit and fresh proof on the retained run", async () => {
  const f = await fixture(); f.state.status = " M Assets/Quality.asset";
  await assert.rejects(() => f.store.prove("repair"), /source state diverged/);
  f.state.status = "";
  const repaired = await f.commit("d".repeat(40));
  assert.equal(repaired.runId, f.committed.runId); assert.equal(repaired.phase, "prove");
  const proved = await f.store.prove("repair");
  assert.equal(proved.phase, "complete"); assert.equal(proved.status, "green");
  assert.equal(proved.runId, f.committed.runId); assert.equal(proved.worktreePath, f.worktree);
});

for (const identity of ["head", "branch", "checkout", "tree"] as const) test(`D2 ${identity} binding divergence never grants implementation`, async () => {
  const f = await fixture(); f.state.status = " M src/x.ts";
  if (identity === "head") f.state.head = f.state.branchHead = "e".repeat(40);
  if (identity === "branch") f.state.branch = "captain/foreign";
  if (identity === "checkout") f.state.topLevel = path.join(f.root, "foreign");
  if (identity === "tree") f.state.tree = "f".repeat(40);
  await assert.rejects(() => f.store.prove("repair"), /binding diverged|committed tree/);
  const after = await f.store.status("repair"); assert.equal(after.phase, "prove"); assert.equal(after.status, "running");
  assert.deepEqual(f.commands, []); assert.notEqual(after.evidence.at(-1)?.repairRequired, true);
});

for (const failure of ["transport", "probe"] as const) test(`D2 ${failure} failure retains prove for retry`, async () => {
  const f = await fixture();
  if (failure === "transport") f.controls.onCommand = async () => { throw new Error("transport timeout"); };
  else f.controls.onProbe = async () => { throw new Error("probe inaccessible"); };
  await assert.rejects(() => f.store.prove("repair"), /transport timeout|probe inaccessible/);
  const after = await f.store.status("repair"); assert.equal(after.phase, "prove"); assert.equal(after.status, "running");
  assert.notEqual(after.evidence.at(-1)?.repairRequired, true);
});

for (const concurrent of ["pause", "resume"] as const) test(`D2 concurrent ${concurrent} is preserved without stale repair transition`, async () => {
  const f = await fixture();
  let protectedRun: Run | undefined;
  f.controls.onProbe = async () => {
    f.controls.onProbe = undefined;
    if (concurrent === "pause") await f.store.pause("repair", { summary: "Pause during source probe", nextSteps: ["Continue retained run"] });
    else { await f.store.markIntent({ intentId: "resume", sessionId: "owner", turnId: "turn-2", projectRoot: f.root, prompt: "continue", resumeOf: "repair" }); await f.store.resume("resume"); }
    protectedRun = await f.store.status("repair");
    f.state.status = " M src/x.ts";
  };
  await assert.rejects(() => f.store.prove("repair"), /source state diverged|changed concurrently/);
  const after = await f.store.status("repair");
  assert.equal(after.phase, "prove"); assert.equal(after.status, concurrent === "pause" ? "paused" : "running");
  if (concurrent === "resume") assert.equal(after.turnId, "turn-2");
  assert.equal(after.revision, protectedRun!.revision); assert.deepEqual(after.evidence, protectedRun!.evidence);
  assert.notEqual(after.evidence.at(-1)?.repairRequired, true);
});

test("D2 released ownership cannot be used to grant source repair", async () => {
  const f = await fixture(); f.state.status = " M src/x.ts";
  await releaseAuthorizedLease(f.data, f.committed.sessionLeaseId!, "repair", f.committed.sessionLeaseToken!);
  await assert.rejects(() => f.store.prove("repair"), /not held|ownership/);
  const after = await f.store.status("repair"); assert.equal(after.phase, "prove");
  assert.equal(after.revision, f.committed.revision); assert.deepEqual(after.evidence, f.committed.evidence);
  assert.notEqual(after.evidence.at(-1)?.repairRequired, true);
});
test("D1 ignored manifest changed by successful build returns to implementation", async () => {
  const f = await fixture();
  f.controls.onCommand = async command => { if (command === "build") f.state.manifest = "manifest-after-build"; };
  await assert.rejects(() => f.store.prove("repair"), /source state diverged/);
  const after = await f.store.status("repair"); assert.equal(after.phase, "implement"); assert.equal(after.status, "red"); retained(f.committed, after);
  assert.deepEqual(f.commands, ["build"]);
});

for (const origin of ["probe", "runner"] as const) test(`D2 generic ${origin} error with divergence message cannot grant implementation`, async () => {
  const f = await fixture();
  const fail = async () => { throw new Error("proof source state diverged from the clean committed tree or ignored-input manifest"); };
  if (origin === "probe") f.controls.onProbe = fail; else f.controls.onCommand = fail;
  await assert.rejects(() => f.store.prove("repair"), /source state diverged/);
  const after = await f.store.status("repair"); assert.equal(after.phase, "prove"); assert.equal(after.status, "running");
  assert.notEqual(after.evidence.at(-1)?.repairRequired, true);
});

test("D2 same payload lease ABA during probe cannot grant implementation", async () => {
  const f = await fixture();
  f.controls.onProbe = async () => {
    f.controls.onProbe = undefined;
    const payload = await readAuthorizedLease<any>(f.data, f.committed.sessionLeaseId!);
    await releaseAuthorizedLease(f.data, f.committed.sessionLeaseId!, "repair", f.committed.sessionLeaseToken!);
    await ensureAuthorizedLease(f.data, f.committed.sessionLeaseId!, payload);
    f.state.status = " M src/x.ts";
  };
  await assert.rejects(() => f.store.prove("repair"), /source state diverged|lease generation|ownership/);
  const after = await f.store.status("repair"); assert.equal(after.phase, "prove"); assert.equal(after.status, "running");
  assert.equal(after.revision, f.committed.revision); assert.deepEqual(after.evidence, f.committed.evidence);
  assert.notEqual(after.evidence.at(-1)?.repairRequired, true);
});

for (const invalid of ["missing-checkpoint", "foreign-active"] as const) test(`D2 ${invalid} activation cannot grant source repair`, async () => {
  const f = await fixture(); f.state.status = " M src/x.ts";
  if (invalid === "missing-checkpoint") await unlink(path.join(f.data, "begin-activated", `${f.committed.operationToken}.json`));
  else await writeAuthorized(f.data, "active", "owner", { operationToken: "foreign" });
  await assert.rejects(() => f.store.prove("repair"), /activation|ownership/);
  const after = await f.store.status("repair"); assert.equal(after.phase, "prove");
  assert.equal(after.revision, f.committed.revision); assert.deepEqual(after.evidence, f.committed.evidence);
});
