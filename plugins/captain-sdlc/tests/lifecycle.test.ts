import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { LifecycleStore, type GateRunner, type StateProbe } from "../src/lifecycle.js";
import { ensureAuthorizedLease, readAuthorized, readAuthorizedLease, releaseAuthorizedLease, writeAuthorized } from "../src/authority.js";

const temp = () => mkdtemp(path.join(tmpdir(), "captain-codex-"));
const runner = (codes: Record<string, number>): GateRunner => async (command) => ({ exitCode: codes[command] ?? 0, stdout: command, stderr: "" });
const policy = { profile: "feature" as const, visualRequired: false, commands: { build: "build", ticket: "ticket", "feature-smoke": "smoke", "affected-regression": "affected", "super-smoke": "super", visual: "visual" }, artifactPaths: { build: "build.zip", smoke: "smoke.json", visual: "proof.png" }, redGate: { expectedExitCodes: [1], outputPattern: "ticket" } };
const binding = (root: string, worktree: string, branch = `captain/${path.basename(worktree)}`) => ({ branch, commonGitDir: path.join(root, ".git"), gitDir: path.join(root, ".git", "worktrees", path.basename(worktree)) });
const boundState = (root: string, worktree: string, head: string, tree: string, status = "", branch = `captain/${path.basename(worktree)}`) => ({ head, tree, status, branch, branchHead: head, commonGitDir: path.join(root, ".git"), topLevel: worktree, gitDir: path.join(root, ".git", "worktrees", path.basename(worktree)) });
const probe: StateProbe = async (cwd) => { const root = path.resolve(cwd, "..", "..", ".."); return boundState(root, cwd, "a".repeat(40), "c".repeat(40)); };

test("one-time intent starts one idempotent owned run and rejects changed replay arguments", async () => {
  const root = await temp(); const data = await temp();
  const worktree = path.join(root, ".captain-sdlc", "worktrees", "x");
  const store = new LifecycleStore(data, runner({}), probe);
  await store.markIntent({ intentId: "intent-1", sessionId: "s", turnId: "t", projectRoot: root, prompt: "implement x" });
  const run = await store.begin({ intentId: "intent-1", objective: "implement x", projectRoot: root, worktreePath: worktree, baseHead: "a".repeat(40), ...binding(root, worktree), policy });
  assert.equal(run.phase, "tdd_red");
  assert.deepEqual(await store.begin({ intentId: "intent-1", objective: "implement x", projectRoot: root, worktreePath: run.worktreePath, baseHead: run.baseHead, branch: run.branch, commonGitDir: run.commonGitDir, gitDir: run.gitDir, policy }), run);
  await assert.rejects(() => store.begin({ intentId: "intent-1", objective: "again", projectRoot: root, worktreePath: run.worktreePath, baseHead: run.baseHead, branch: run.branch, commonGitDir: run.commonGitDir, gitDir: run.gitDir, policy }), /signed begin reservation/);
});

test("later turns require a fresh one-time resume intent", async () => {
  const root = await temp(), data = await temp(), store = new LifecycleStore(data, runner({}), probe);
  const worktree = path.join(root, ".captain-sdlc", "worktrees", "x");
  await store.markIntent({ intentId: "start", sessionId: "s", turnId: "t1", projectRoot: root, prompt: "implement x" });
  await store.begin({ intentId: "start", objective: "x", projectRoot: root, worktreePath: worktree, baseHead: "a".repeat(40), ...binding(root, worktree), policy });
  await store.markIntent({ intentId: "resume", sessionId: "s", turnId: "t2", projectRoot: root, prompt: "approved", resumeOf: "start" });
  const resumed = await store.resume("resume"); assert.equal(resumed.turnId, "t2"); assert.ok(await store.permitFor("s", "t2"));
  assert.deepEqual(await store.resume("resume"), resumed);
});

test("resume retries exactly after the intent is consumed but before the resumed run revision", async () => {
  const root = await temp(), data = await temp(), worktree = path.join(root, ".captain-sdlc", "worktrees", "resume"), base = new LifecycleStore(data, runner({}), probe);
  await base.markIntent({ intentId: "resume-start", sessionId: "s", turnId: "t1", projectRoot: root, prompt: "start" }); await base.begin({ intentId: "resume-start", objective: "start", projectRoot: root, worktreePath: worktree, baseHead: "a".repeat(40), ...binding(root, worktree), policy }); await base.markIntent({ intentId: "resume-crash", sessionId: "s", turnId: "t2", projectRoot: root, prompt: "continue", resumeOf: "resume-start" });
  let crashed = false; const interrupted = new LifecycleStore(data, runner({}), probe, { afterResumeReserved: async () => { if (!crashed) { crashed = true; throw new Error("crash after resume reservation"); } } }); await assert.rejects(() => interrupted.resume("resume-crash"), /crash after resume reservation/);
  const recovered = await new LifecycleStore(data, runner({}), probe).resume("resume-crash"); assert.equal(recovered.turnId, "t2"); assert.ok(await base.permitFor("s", "t2")); assert.equal((await new LifecycleStore(data, runner({}), probe).resume("resume-crash")).revision, recovered.revision);
});

test("requires a failing ticket test before implementation", async () => {
  const root = await temp(); const data = await temp(); const store = new LifecycleStore(data, runner({ ticket: 0 }), probe);
  const worktree = path.join(root, ".captain-sdlc", "worktrees", "x");
  await store.markIntent({ intentId: "i", sessionId: "s", turnId: "t", projectRoot: root, prompt: "fix x" });
  await store.begin({ intentId: "i", objective: "fix x", projectRoot: root, worktreePath: worktree, baseHead: "a".repeat(40), ...binding(root, worktree), policy });
  await assert.rejects(() => store.recordRed("i", "ticket"), /expected failing test result/);
});

test("targeted runs reject a detached or switched branch before the red gate", async () => {
  const root = await temp(), data = await temp(), worktree = path.join(root, ".captain-sdlc", "worktrees", "x"), common = path.join(root, ".git");
  const wrongBranchProbe: StateProbe = async () => ({ ...boundState(root, worktree, "a".repeat(40), "c".repeat(40), "", "other/branch") });
  const store = new LifecycleStore(data, runner({ ticket: 1 }), wrongBranchProbe);
  await store.markIntent({ intentId: "targeted", sessionId: "s", turnId: "t", projectRoot: root, prompt: "integrate", targetBranch: "colony/spike", targetOid: "a".repeat(40) });
  const lease = await store.acquireTargetLease("targeted", common, "colony/spike", "a".repeat(40));
  await store.begin({ intentId: "targeted", objective: "integrate", projectRoot: root, worktreePath: worktree, baseHead: "a".repeat(40), targetBranch: "colony/spike", ...binding(root, worktree, "colony/spike"), ...lease, policy });
  await assert.rejects(() => store.recordRed("targeted", "ticket"), /branch binding/);
});

test("ordinary Captain runs also reject a switched owned branch", async () => {
  const root = await temp(), data = await temp(), common = path.join(root, ".git"), wrongBranchProbe: StateProbe = async () => ({ head: "a".repeat(40), tree: "c".repeat(40), status: "", branch: "primary", branchHead: "a".repeat(40), commonGitDir: common, topLevel: path.join(root, ".captain-sdlc", "worktrees", "x"), gitDir: path.join(common, "worktrees", "x") });
  const store = new LifecycleStore(data, runner({ ticket: 1 }), wrongBranchProbe);
  await store.markIntent({ intentId: "ordinary", sessionId: "s", turnId: "t", projectRoot: root, prompt: "implement" });
  await store.begin({ intentId: "ordinary", objective: "implement", projectRoot: root, worktreePath: path.join(root, ".captain-sdlc", "worktrees", "x"), baseHead: "a".repeat(40), branch: "captain/ordinary", commonGitDir: common, gitDir: path.join(common, "worktrees", "x"), policy });
  await assert.rejects(() => store.recordRed("ordinary", "ticket"), /worktree branch binding/);
});

test("target branch lease admits one intent and rejects a concurrent owner", async () => {
  const data = await temp(), first = new LifecycleStore(data, runner({}), probe), second = new LifecycleStore(data, runner({}), probe), common = path.join(await temp(), ".git");
  const lease = await first.acquireTargetLease("first", common, "colony/spike", "a".repeat(40)); assert.match(lease.leaseId, /^[a-f0-9]{64}$/); assert.match(lease.leaseToken, /^[0-9a-f-]{36}$/);
  await assert.rejects(() => second.acquireTargetLease("first", common, "colony/spike", "a".repeat(40)), /leased/);
  await assert.rejects(() => second.acquireTargetLease("second", common, "colony/spike", "a".repeat(40)), /leased/);
  await assert.rejects(() => first.releaseTargetLease(lease.leaseId, "first", "wrong-token"), /generation/);
  await first.releaseTargetLease(lease.leaseId, "first", lease.leaseToken);
  const successor = await second.acquireTargetLease("second", common, "colony/spike", "a".repeat(40)); assert.equal(successor.leaseId, lease.leaseId);
  await assert.rejects(() => first.releaseTargetLease(lease.leaseId, "first", lease.leaseToken), /generation/); await assert.rejects(() => first.acquireTargetLease("third", common, "colony/spike", "a".repeat(40)), /leased/); await second.releaseTargetLease(successor.leaseId, "second", successor.leaseToken);
});

test("authority refuses a malformed signing key instead of silently replacing it", async () => { const data = await temp(); await writeFile(path.join(data, "authority.key"), "AA=="); await assert.rejects(() => ensureAuthorizedLease(data, "lease", { intentId: "i", leaseToken: "t" }), /exactly 32 bytes/); });

test("lease watermark rejects exact removal of the authenticated journal tail", async () => { const data = await temp(), leaseId = "watermarked"; await ensureAuthorizedLease(data, leaseId, { intentId: "first", leaseToken: "one" }); await releaseAuthorizedLease(data, leaseId, "first", "one"); await ensureAuthorizedLease(data, leaseId, { intentId: "second", leaseToken: "two" }); const names = (await readdir(path.join(data, "lease-revisions"))).filter(name => name.startsWith(`${leaseId}-`)).sort((left, right) => Number(left.slice(leaseId.length + 1, -5)) - Number(right.slice(leaseId.length + 1, -5))), tail = names.at(-1)!; await unlink(path.join(data, "lease-revisions", tail)); await assert.rejects(() => readAuthorizedLease(data, leaseId), /watermark/); });

test("intermediate phase history must extend the previously recorded phase head", async () => {
  let probedHead = "a".repeat(40), probedTree = "c".repeat(40);
  const root = await temp(), data = await temp(), worktree = path.join(root, ".captain-sdlc", "worktrees", "x");
  const phaseProbe: StateProbe = async () => boundState(root, worktree, probedHead, probedTree);
  const store = new LifecycleStore(data, runner({ ticket: 1 }), phaseProbe);
  await store.markIntent({ intentId: "history", sessionId: "s", turnId: "t", projectRoot: root, prompt: "integrate" });
  await store.begin({ intentId: "history", objective: "integrate", projectRoot: root, worktreePath: worktree, baseHead: "a".repeat(40), ...binding(root, worktree), policy }); await store.recordRed("history", "ticket");
  probedHead = "b".repeat(40);
  const first = { head: probedHead, tree: probedTree, commitCount: 1, clean: true, subject: "chore(x): first (v1.0.1)", versionChanged: true, changelogChanged: true, preparedMergesValid: true, phaseCommitsValid: true, previousPhaseRetained: true };
  await store.recordCommit("history", first, false); probedHead = "d".repeat(40); probedTree = "e".repeat(40);
  await assert.rejects(() => store.recordCommit("history", { ...first, head: probedHead, tree: probedTree, commitCount: 1, previousPhaseHead: first.head, previousPhaseRetained: false }, true), /extend the preceding phase/);
});

test("a signed prepared commit can resume at its exact CAS candidate and finalize", async () => {
  let head = "a".repeat(40); const root = await temp(), data = await temp(), worktree = path.join(root, ".captain-sdlc", "worktrees", "x"), commitProbe: StateProbe = async () => boundState(root, worktree, head, "c".repeat(40));
  const store = new LifecycleStore(data, runner({ ticket: 1 }), commitProbe);
  await store.markIntent({ intentId: "recover", sessionId: "s", turnId: "t1", projectRoot: root, prompt: "integrate" });
  await store.begin({ intentId: "recover", objective: "integrate", projectRoot: root, worktreePath: worktree, baseHead: head, ...binding(root, worktree), policy }); await store.recordRed("recover", "ticket");
  const candidate = "b".repeat(40), request = { paths: ["VERSION"], subject: "fix(x): recover (v1.0.1)", final: false };
  const operation = await store.acquireCommitOperation("recover", request); await store.recordPreparedCommit("recover", { preCommitHead: head, candidate, tree: "c".repeat(40), ...request }, operation); head = candidate;
  await store.markIntent({ intentId: "recover-resume", sessionId: "s", turnId: "t2", projectRoot: root, prompt: "continue", resumeOf: "recover" }); assert.equal((await store.resume("recover-resume")).turnId, "t2");
  await store.recordCommit("recover", { head, tree: "c".repeat(40), commitCount: 1, clean: true, subject: "fix(x): recover (v1.0.1)", versionChanged: true, changelogChanged: true, preparedMergesValid: true, phaseCommitsValid: true, previousPhaseRetained: true }, false);
  assert.equal((await store.status("recover")).preparedCommit, undefined); assert.equal((await store.status("recover")).commitOperation, undefined);
});

test("commit operation restart reconciles reservation-before-lease and stale post-release lease", async () => {
  const root = await temp(), data = await temp(), worktree = path.join(root, ".captain-sdlc", "worktrees", "x"), store = new LifecycleStore(data, runner({ ticket: 1 }), probe), request = { paths: ["VERSION"], subject: "fix(x): reserve (v1.0.1)", final: false };
  await store.markIntent({ intentId: "operation-restart", sessionId: "s", turnId: "t", projectRoot: root, prompt: "commit" });
  await store.begin({ intentId: "operation-restart", objective: "commit", projectRoot: root, worktreePath: worktree, baseHead: "a".repeat(40), ...binding(root, worktree), policy }); await store.recordRed("operation-restart", "ticket");
  const reserved = await store.reserveCommitOperation("operation-restart", request); assert.equal(reserved.stage, "reserved");
  const restarted = new LifecycleStore(data, runner({}), probe), authorized = await restarted.acquireCommitOperation("operation-restart", request); assert.equal(authorized.stage, "authorized"); assert.equal(authorized.leaseToken, reserved.leaseToken);
  await assert.rejects(() => restarted.acquireCommitOperation("operation-restart", { ...request, subject: "fix(x): different (v1.0.2)" }), /already active/);
  await restarted.discardCommitOperation("operation-restart", authorized);
  await ensureAuthorizedLease(data, authorized.leaseId, { intentId: "operation-restart", leaseToken: authorized.leaseToken, runId: (await restarted.status("operation-restart")).runId, requestSha256: authorized.requestSha256, operation: "prepared-commit" });
  const replacement = await restarted.acquireCommitOperation("operation-restart", { ...request, subject: "fix(x): next (v1.0.2)" }); assert.equal(replacement.stage, "authorized"); assert.notEqual(replacement.leaseToken, authorized.leaseToken);
  await restarted.discardCommitOperation("operation-restart", replacement);
});

test("stale lifecycle updates cannot overwrite a reserved commit operation", async () => {
  let ticketCalls = 0, checkStarted!: () => void, releaseCheck!: () => void;
  const started = new Promise<void>(resolve => { checkStarted = resolve; }), release = new Promise<void>(resolve => { releaseCheck = resolve; });
  const root = await temp(), data = await temp(), worktree = path.join(root, ".captain-sdlc", "worktrees", "x"), store = new LifecycleStore(data, async command => { if (ticketCalls++ === 0) return { exitCode: 1, stdout: command, stderr: "" }; checkStarted(); await release; return { exitCode: 0, stdout: command, stderr: "" }; }, probe);
  await store.markIntent({ intentId: "stale-update", sessionId: "s", turnId: "t", projectRoot: root, prompt: "commit" });
  await store.begin({ intentId: "stale-update", objective: "commit", projectRoot: root, worktreePath: worktree, baseHead: "a".repeat(40), ...binding(root, worktree), policy }); await store.recordRed("stale-update", "ticket");
  const staleCheck = store.runCheck("stale-update", "ticket"); await started;
  const operation = await store.acquireCommitOperation("stale-update", { paths: ["VERSION"], subject: "fix(x): serialize (v1.0.1)", final: false }); releaseCheck();
  await assert.rejects(() => staleCheck, /changed concurrently/);
  assert.equal((await store.status("stale-update")).commitOperation?.leaseToken, operation.leaseToken);
  await store.discardCommitOperation("stale-update", operation);
});

test("authoritative run revisions heal crashed and out-of-order projections and watermark tail loss", async () => {
  const root = await temp(), data = await temp(), worktree = path.join(root, ".captain-sdlc", "worktrees", "projection"); let armed = false, crashed = false;
  const store = new LifecycleStore(data, runner({ ticket: 1 }), probe, { afterRunRevision: async () => { if (armed && !crashed) { crashed = true; throw new Error("crash after authoritative revision"); } } }); await store.markIntent({ intentId: "projection", sessionId: "s", turnId: "t", projectRoot: root, prompt: "project" }); await store.begin({ intentId: "projection", objective: "project", projectRoot: root, worktreePath: worktree, baseHead: "a".repeat(40), ...binding(root, worktree), policy });
  const stale = await readAuthorized<any>(data, "runs", "projection"); armed = true; await assert.rejects(() => store.recordRed("projection", "ticket"), /crash after authoritative revision/); const healed = await store.status("projection"); assert.equal(healed.phase, "implement"); assert.equal((await readAuthorized<any>(data, "runs", "projection")).revision, healed.revision);
  await writeAuthorized(data, "runs", "projection", stale); assert.equal((await store.status("projection")).revision, healed.revision); assert.equal((await readAuthorized<any>(data, "runs", "projection")).revision, healed.revision);
  await unlink(path.join(data, "run-revisions", `projection-${healed.revision}.json`)); await assert.rejects(() => store.status("projection"), /watermark/);
});

test("commit gate enforces trusted task trailers and synchronized version surfaces", async () => {
  const root = await temp(), data = await temp(), worktree = path.join(root, ".captain-sdlc", "worktrees", "x");
  let probedHead = "a".repeat(40); const commitProbe: StateProbe = async () => boundState(root, worktree, probedHead, "c".repeat(40));
  const store = new LifecycleStore(data, runner({ ticket: 1 }), commitProbe);
  const governedPolicy = { ...policy, commit: { conventional: true, require_version_suffix: true, require_task_trailer: true, version_file: "VERSION", changelog_files: ["Changelog/SPIKE_COLONY_CHANGELOG.md"], version_surfaces: [{ path: "VERSION", pattern: "(?m)^(?<version>[0-9]+\\.[0-9]+\\.[0-9]+)$" }] } };
  await store.markIntent({ intentId: "governed", sessionId: "s", turnId: "t", projectRoot: root, prompt: "integrate x" });
  await store.begin({ intentId: "governed", taskId: "COLONY-SPIKE", objective: "integrate x", projectRoot: root, worktreePath: worktree, baseHead: "a".repeat(40), ...binding(root, worktree), policy: governedPolicy });
  await store.recordRed("governed", "ticket");
  const baseEvidence = { head: "b".repeat(40), tree: "c".repeat(40), commitCount: 1, clean: true, subject: "feat(x): ship x (v1.2.0)", versionChanged: true, changelogChanged: true, preparedMergesValid: true, phaseCommitsValid: true };
  await assert.rejects(() => store.recordCommit("governed", { ...baseEvidence, taskTrailerValid: false, versionSurfacesValid: true }), /task trailer/);
  await assert.rejects(() => store.recordCommit("governed", { ...baseEvidence, taskTrailerValid: true, versionSurfacesValid: false }), /version surfaces/);
  probedHead = baseEvidence.head;
  const accepted = await store.recordCommit("governed", { ...baseEvidence, taskTrailerValid: true, versionSurfacesValid: true });
  assert.equal(accepted.phase, "prove");
});

test("validated intermediate phase commits keep a multi-merge implementation open", async () => {
  let probedHead = "a".repeat(40), probedTree = "c".repeat(40);
  const root = await temp(), data = await temp(), worktree = path.join(root, ".captain-sdlc", "worktrees", "x");
  const phaseProbe: StateProbe = async () => boundState(root, worktree, probedHead, probedTree);
  const store = new LifecycleStore(data, runner({ ticket: 1 }), phaseProbe);
  await store.markIntent({ intentId: "multi", sessionId: "s", turnId: "t", projectRoot: root, prompt: "integrate branches" });
  await store.begin({ intentId: "multi", objective: "integrate branches", projectRoot: root, worktreePath: worktree, baseHead: "a".repeat(40), ...binding(root, worktree), policy });
  await store.recordRed("multi", "ticket");
  const first = { head: "b".repeat(40), tree: "c".repeat(40), commitCount: 1, clean: true, subject: "chore(integration): record first branch (v1.0.1)", versionChanged: true, changelogChanged: true, preparedMergesValid: true, phaseCommitsValid: true };
  probedHead = first.head;
  const continued = await store.recordCommit("multi", first, false); assert.equal(continued.phase, "implement"); assert.equal(continued.committedState?.head, first.head);
  const prepared = { preMergeHead: first.head, targetOid: "d".repeat(40), strategy: "ours" as const };
  assert.equal((await store.recordPreparedMerge("multi", prepared)).phase, "implement");
  const final = { ...first, head: "e".repeat(40), tree: "f".repeat(40), commitCount: 2, subject: "chore(integration): record second branch (v1.0.2)", previousPhaseHead: first.head, previousPhaseRetained: true };
  probedHead = final.head; probedTree = final.tree;
  assert.equal((await store.recordCommit("multi", final, true)).phase, "prove");
});

test("merge authorization is signed and the resulting second parent must match", async () => {
  const root = await temp(), data = await temp(), worktree = path.join(root, ".captain-sdlc", "worktrees", "x"), store = new LifecycleStore(data, runner({ ticket: 1 }), probe);
  await store.markIntent({ intentId: "merge", sessionId: "s", turnId: "t", projectRoot: root, prompt: "merge x" });
  await store.begin({ intentId: "merge", objective: "merge x", projectRoot: root, worktreePath: worktree, baseHead: "a".repeat(40), ...binding(root, worktree), policy });
  await store.recordRed("merge", "ticket");
  const prepared = { preMergeHead: "a".repeat(40), targetOid: "d".repeat(40), strategy: "ort" as const };
  const signed = await store.recordPreparedMerge("merge", prepared); assert.deepEqual(signed.preparedMerges, [prepared]);
  const evidence = { head: "b".repeat(40), tree: "c".repeat(40), commitCount: 1, clean: true, subject: "feat(x): ship x (v1.2.0)", versionChanged: true, changelogChanged: true, phaseCommitsValid: true, preparedMergesValid: false };
  await assert.rejects(() => store.recordCommit("merge", evidence), /prepared merge/);
});

test("feature completion requires green ticket, new smoke, affected regression, build and visual when required", async () => {
  const root = await temp(); const data = await temp();
  const worktree = path.join(root, ".captain-sdlc", "worktrees", "x"); await mkdir(worktree, { recursive: true });
  let probedHead = "a".repeat(40); const completionProbe: StateProbe = async () => boundState(root, worktree, probedHead, "c".repeat(40));
  let ticketRuns = 0;
  const store = new LifecycleStore(data, async (command, cwd) => { if (command === "build") await writeFile(path.join(cwd, "build.zip"), `build-${Date.now()}`); if (command === "smoke") await writeFile(path.join(cwd, "smoke.json"), `{"at":${Date.now()}}`); if (command === "visual") await writeFile(path.join(cwd, "proof.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64")); return { exitCode: command === "ticket" && ticketRuns++ === 0 ? 1 : 0, stdout: command, stderr: "" }; }, completionProbe);
  await store.markIntent({ intentId: "i", sessionId: "s", turnId: "t", projectRoot: root, prompt: "implement x" });
  await store.begin({ intentId: "i", objective: "x", projectRoot: root, worktreePath: worktree, baseHead: "a".repeat(40), ...binding(root, worktree), policy: { ...policy, visualRequired: true } });
  await store.recordRed("i", "ticket");
  probedHead = "b".repeat(40);
  await store.recordCommit("i", { head: "b".repeat(40), tree: "c".repeat(40), commitCount: 1, clean: true, subject: "feat(x): ship x (v1.2.0)", versionChanged: true, changelogChanged: true, preparedMergesValid: true, phaseCommitsValid: true });
  const run = await store.prove("i");
  assert.equal(run.status, "green"); assert.equal(run.phase, "complete");
  const nextWorktree = path.join(root, ".captain-sdlc", "worktrees", "next"); await store.markIntent({ intentId: "next", sessionId: "s", turnId: "t2", projectRoot: root, prompt: "implement next" });
  const next = await store.begin({ intentId: "next", objective: "next", projectRoot: root, worktreePath: nextWorktree, baseHead: probedHead, ...binding(root, nextWorktree), policy }); assert.equal(next.phase, "tdd_red"); assert.equal(next.sessionId, "s");
});

test("a new begin reconciles green completion that crashed before target and session lease release", async () => {
  const root = await temp(), data = await temp(), firstWorktree = path.join(root, ".captain-sdlc", "worktrees", "first"), secondWorktree = path.join(root, ".captain-sdlc", "worktrees", "second"), commonGitDir = path.join(root, ".git"), branch = "colony/spike"; await mkdir(firstWorktree, { recursive: true });
  let head = "a".repeat(40), ticketRuns = 0, crashed = false; const targetProbe: StateProbe = async cwd => boundState(root, cwd, head, "c".repeat(40), "", branch);
  const store = new LifecycleStore(data, async (command, cwd) => { if (command === "build") await writeFile(path.join(cwd, "build.zip"), `build-${Date.now()}`); if (command === "smoke") await writeFile(path.join(cwd, "smoke.json"), `{"at":${Date.now()}}`); return { exitCode: command === "ticket" && ticketRuns++ === 0 ? 1 : 0, stdout: command, stderr: "" }; }, targetProbe, { afterRunCompleted: async () => { if (!crashed) { crashed = true; throw new Error("crash before completed lease release"); } } });
  await store.markIntent({ intentId: "first", sessionId: "shared", turnId: "t1", projectRoot: root, prompt: "integrate", targetBranch: branch, targetOid: head }); const targetLease = await store.acquireTargetLease("first", commonGitDir, branch, head);
  await store.begin({ intentId: "first", objective: "integrate", projectRoot: root, worktreePath: firstWorktree, baseHead: head, targetBranch: branch, branch, commonGitDir, gitDir: path.join(commonGitDir, "worktrees", "first"), ...targetLease, policy }); await store.recordRed("first", "ticket");
  const request = { paths: ["VERSION"], subject: "fix(integration): complete target (v1.0.1)", final: true }, operation = await store.acquireCommitOperation("first", request), candidate = "b".repeat(40); await store.recordPreparedCommit("first", { preCommitHead: head, candidate, tree: "c".repeat(40), ...request }, operation); head = candidate;
  await store.recordCommit("first", { head, tree: "c".repeat(40), commitCount: 1, clean: true, subject: request.subject, versionChanged: true, changelogChanged: true, preparedMergesValid: true, phaseCommitsValid: true }, true); await writeFile(path.join(firstWorktree, "build.zip"), "old"); await writeFile(path.join(firstWorktree, "smoke.json"), "old");
  await assert.rejects(() => store.prove("first"), /crash before completed lease release/); const abandoned = await store.status("first"); assert.equal(abandoned.phase, "complete"); assert.ok(abandoned.leaseId); assert.ok(abandoned.sessionLeaseId);
  await store.markIntent({ intentId: "second", sessionId: "shared", turnId: "t2", projectRoot: root, prompt: "integrate again", targetBranch: branch, targetOid: head }); const begin = await store.reserveBegin({ intentId: "second", objective: "integrate again", projectRoot: root }), repository = await store.checkpointBeginRepository(begin, { projectRoot: root, baseHead: head, commonGitDir }, policy), replacement = (await store.ensureBeginTargetLease(begin, repository))!;
  const restarted = await store.begin({ intentId: "second", objective: "integrate again", projectRoot: root, worktreePath: secondWorktree, baseHead: head, targetBranch: branch, branch, commonGitDir, gitDir: path.join(commonGitDir, "worktrees", "second"), ...replacement, policy }); assert.equal(restarted.phase, "tdd_red"); assert.equal(restarted.sessionId, "shared"); assert.notEqual(restarted.leaseToken, abandoned.leaseToken);
});

test("pre-release refuses completion without super-smoke", async () => {
  const root = await temp(); const data = await temp(); const worktree = path.join(root, ".captain-sdlc", "worktrees", "release"); await mkdir(worktree, { recursive: true });
  let probedHead = "a".repeat(40); const releaseProbe: StateProbe = async () => boundState(root, worktree, probedHead, "c".repeat(40));
  const store = new LifecycleStore(data, runner({ ticket: 1 }), releaseProbe);
  await store.markIntent({ intentId: "i", sessionId: "s", turnId: "t", projectRoot: root, prompt: "build release" });
  await store.begin({ intentId: "i", objective: "release", projectRoot: root, worktreePath: worktree, baseHead: "a".repeat(40), ...binding(root, worktree), policy: { profile: "pre-release", visualRequired: false, commands: { build: "build", ticket: "ticket", "feature-smoke": "smoke", "affected-regression": "affected" }, artifactPaths: { build: "build.zip", smoke: "smoke.json" }, redGate: { expectedExitCodes: [1], outputPattern: "ticket" } } });
  await store.recordRed("i", "ticket");
  probedHead = "b".repeat(40);
  await store.recordCommit("i", { head: "b".repeat(40), tree: "c".repeat(40), commitCount: 1, clean: true, subject: "feat(release): release (v1.2.0)", versionChanged: true, changelogChanged: true, preparedMergesValid: true, phaseCommitsValid: true });
  await writeFile(path.join(worktree, "build.zip"), "build"); await writeFile(path.join(worktree, "smoke.json"), "{}");
  await assert.rejects(() => store.prove("i"), /super-smoke/);
});

test("proof fails when a proof command mutates the committed source state", async () => {
  const root = await temp(), data = await temp(), worktree = path.join(root, ".captain-sdlc", "worktrees", "x"); await mkdir(worktree, { recursive: true });
  let ticketRuns = 0, probes = 0, probedHead = "a".repeat(40);
  const changingProbe: StateProbe = async () => boundState(root, worktree, probedHead, "c".repeat(40), probes++ < 3 ? "" : " M src/x.ts");
  const store = new LifecycleStore(data, async command => ({ exitCode: command === "ticket" && ticketRuns++ === 0 ? 1 : 0, stdout: command, stderr: "" }), changingProbe);
  await store.markIntent({ intentId: "i", sessionId: "s", turnId: "t", projectRoot: root, prompt: "implement x" });
  await store.begin({ intentId: "i", objective: "x", projectRoot: root, worktreePath: worktree, baseHead: "a".repeat(40), ...binding(root, worktree), policy }); await store.recordRed("i", "ticket");
  probedHead = "b".repeat(40);
  await store.recordCommit("i", { head: "b".repeat(40), tree: "c".repeat(40), commitCount: 1, clean: true, subject: "feat(x): ship x (v1.2.0)", versionChanged: true, changelogChanged: true, preparedMergesValid: true, phaseCommitsValid: true });
  await writeFile(path.join(worktree, "build.zip"), "build"); await writeFile(path.join(worktree, "smoke.json"), "{}");
  await assert.rejects(() => store.prove("i"), /source state diverged/);
});
