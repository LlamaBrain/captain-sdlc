import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { acquireAuthorizedLease, putAuthorizedOnceExact, readAuthorizedLeaseSnapshotReadOnly, readAuthorizedReadOnly, releaseAuthorizedLease, writeAuthorized } from "../src/authority.js";
import { LifecycleStore } from "../src/lifecycle.js";

const exec = promisify(execFile);
const git = async (cwd: string, ...args: string[]) => (await exec("git", ["--no-optional-locks", ...args], { cwd, windowsHide: true })).stdout.trim();
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const oldIntent = "intent-orphan-fixture";
async function fixture(t: TestContext, legacyStorage = false) {
  const container = await mkdtemp(path.join(tmpdir(), "captain-orphan-lease-"));
  t.after(async () => { assert.ok(path.basename(container).startsWith("captain-orphan-lease-")); await rm(container, { recursive: true, force: true }); });
  const target = path.join(container, "target"), data = path.join(container, "authority");
  await mkdir(target); await git(target, "init", "-b", "main");
  await git(target, "config", "core.autocrlf", "false"); await git(target, "config", "user.name", "Fixture"); await git(target, "config", "user.email", "fixture@example.invalid");
  await writeFile(path.join(target, "product.txt"), "base\n"); await git(target, "add", "."); await git(target, "commit", "-m", "base");
  const commonGitDir = path.resolve(await git(target, "rev-parse", "--path-format=absolute", "--git-common-dir"));
  const leaseId = createHash("sha256").update(`${commonGitDir}\0refs/heads/main`.toLowerCase()).digest("hex");
  const payload = { intentId: oldIntent, leaseToken: "private-fixture-token", commonGitDir, targetBranch: "main", targetOid: await git(target, "rev-parse", "HEAD") };
  if (legacyStorage) await writeAuthorized(data, "leases", leaseId, payload);
  else await acquireAuthorizedLease(data, leaseId, payload);
  const { BranchLeaseRecoveryStore } = await import("../src/branch-lease-recovery.js");
  const args = { project_root: target, target_worktree: target, target_branch: "main", session_id: "session-current" };
  return { container, target, data, commonGitDir, leaseId, payload, args, store: new BranchLeaseRecoveryStore(data), BranchLeaseRecoveryStore };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function tree(root: string) {
  const result: Record<string, string> = {};
  async function walk(directory: string, relative = "") {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(path.join(directory, entry.name), name);
      else result[name] = createHash("sha256").update(await readFile(path.join(directory, entry.name))).digest("hex");
    }
  }
  await walk(root); return result;
}
async function recovery(f: Fixture) {
  const diagnosis = await f.store.diagnose(f.args);
  assert.equal(diagnosis.eligible, true);
  assert.ok(diagnosis.recovery);
  return { ...diagnosis.recovery.args, reason: "User directed recovery of this stranded reservation", user_authorization: "Unblock it. Sounds like you need a new lease or ability to refresh/repossess lease." };
}

test("orphan diagnosis is read-only and returns exact opaque selectors without private owner data", async t => {
  const f = await fixture(t), before = await tree(f.container), diagnosis = await f.store.diagnose(f.args);
  assert.deepEqual(await tree(f.container), before);
  assert.equal(diagnosis.read_only, true); assert.equal(diagnosis.eligible, true); assert.equal(diagnosis.reason, "unclaimed_legacy_branch_reservation");
  assert.equal(diagnosis.lease.intent_id, oldIntent); assert.equal(diagnosis.lease.revision, 0);
  assert.equal(diagnosis.recovery?.next_tool, "captain_repossess_branch_lease");
  assert.equal(diagnosis.recovery?.args.expected_head, await git(f.target, "rev-parse", "HEAD"));
  assert.doesNotMatch(JSON.stringify(diagnosis), /private-fixture-token|leaseToken|authority.key/);
});

for (const legacyStorage of [false, true]) test(`orphan release preserves dirty Git/index/raw files with ${legacyStorage ? "legacy storage" : "revisioned storage"}`, async t => {
  const f = await fixture(t, legacyStorage);
  await writeFile(path.join(f.target, "product.txt"), "staged user work\n"); await git(f.target, "add", "product.txt");
  await writeFile(path.join(f.target, "product.txt"), "unstaged user work\n"); await writeFile(path.join(f.target, "loose.txt"), "untracked kept\n");
  const before = await tree(f.target), args = await recovery(f), receipt = await f.store.repossess(args);
  assert.equal(receipt.state, "released"); assert.equal(receipt.old_intent_id, oldIntent);
  assert.deepEqual(await tree(f.target), before);
  assert.equal((await readAuthorizedLeaseSnapshotReadOnly(f.data, f.leaseId))?.state, "released");
  const after = await tree(f.data); assert.deepEqual(await f.store.repossess(args), receipt); assert.deepEqual(await tree(f.data), after);
  assert.doesNotMatch(JSON.stringify(receipt), /private-fixture-token|leaseToken/);
});

test("stale opaque selector or changed target HEAD refuses without authority mutation", async t => {
  const f = await fixture(t), args = await recovery(f), before = await tree(f.data);
  await assert.rejects(f.store.repossess({ ...args, resource_generation: "f".repeat(64) }), /generation|selector/);
  assert.deepEqual(await tree(f.data), before);
  await writeFile(path.join(f.target, "product.txt"), "new committed head\n"); await git(f.target, "commit", "-am", "external advance");
  await assert.rejects(f.store.repossess(args), /HEAD|head|binding/);
  assert.deepEqual(await tree(f.data), before);
});

test("ABA replacement with reused private token cannot be released by old recovery", async t => {
  const f = await fixture(t), args = await recovery(f);
  await releaseAuthorizedLease(f.data, f.leaseId, oldIntent, f.payload.leaseToken); await acquireAuthorizedLease(f.data, f.leaseId, f.payload);
  const before = await tree(f.data); await assert.rejects(f.store.repossess(args), /generation|selector/);
  assert.deepEqual(await tree(f.data), before); assert.equal((await readAuthorizedLeaseSnapshotReadOnly(f.data, f.leaseId))?.state, "held");
});

test("known live or foreign lease ownership refuses even with explicit human direction", async t => {
  const f = await fixture(t);
  await releaseAuthorizedLease(f.data, f.leaseId, oldIntent, f.payload.leaseToken);
  await acquireAuthorizedLease(f.data, f.leaseId, { ...f.payload, sessionId: "other-session", ownerPid: process.pid, ownerHost: "owner-host", operation: "integration-branch" });
  const before = await tree(f.container), diagnosis = await f.store.diagnose(f.args);
  assert.equal(diagnosis.eligible, false); assert.equal(diagnosis.reason, "owner_metadata_present");
  assert.equal(diagnosis.recovery, undefined); assert.deepEqual(await tree(f.container), before);
});

for (const [bucket, value] of [
  ["intents", { intentId: oldIntent, sessionId: "old-session", projectRoot: "fixture" }],
  ["begin-operations", { schemaVersion: 1, intentId: oldIntent, operationToken: "old-operation" }],
  ["runs", { intentId: oldIntent, phase: "implement", status: "running" }],
  ["active", { intentId: oldIntent, operationToken: "private-operation" }],
] as const) test(`surviving signed ${bucket} progress is protected`, async t => {
  const f = await fixture(t); await putAuthorizedOnceExact(f.data, bucket, bucket === "active" ? "old-session" : oldIntent, value);
  const before = await tree(f.container), diagnosis = await f.store.diagnose(f.args);
  assert.equal(diagnosis.eligible, false); assert.equal(diagnosis.reason, "surviving_authority"); assert.equal(diagnosis.recovery, undefined);
  assert.deepEqual(await tree(f.container), before); assert.doesNotMatch(JSON.stringify(diagnosis), /private-operation|old-session/);
});

test("surviving old task worktree or branch refuses adoption", async t => {
  const f = await fixture(t), task = path.join(f.container, "old-worktree");
  await git(f.target, "worktree", "add", "-b", `captain/${oldIntent}`, task);
  const diagnosis = await f.store.diagnose(f.args); assert.equal(diagnosis.eligible, false); assert.equal(diagnosis.reason, "surviving_task_workspace");
});

test("unfinished target Git operation and regressed signed lease tail fail closed", async t => {
  const f = await fixture(t), mergeHead = path.join(f.commonGitDir, "MERGE_HEAD"); await writeFile(mergeHead, await git(f.target, "rev-parse", "HEAD"));
  await assert.rejects(f.store.diagnose(f.args), /unfinished Git/); await unlink(mergeHead);
  await releaseAuthorizedLease(f.data, f.leaseId, oldIntent, f.payload.leaseToken);
  await unlink(path.join(f.data, "lease-revisions", `${f.leaseId}-1.json`));
  await assert.rejects(f.store.diagnose(f.args), /tail regressed|watermark/);
});

test("missing-tail run evidence cannot be mistaken for orphan absence", async t => {
  const f = await fixture(t); await putAuthorizedOnceExact(f.data, "run-watermarks", `${oldIntent}-2`, { intentId: oldIntent, runId: "old-run", revision: 2, runSha256: "a".repeat(64) });
  await assert.rejects(f.store.diagnose(f.args), /tail regressed|missing|watermark/);
});

test("repossessed intent is fenced from later Begin reservation even if issuance returns", async t => {
  const f = await fixture(t); await f.store.repossess(await recovery(f));
  const lifecycle = new LifecycleStore(f.data, async () => ({ exitCode: 0, stdout: "", stderr: "" }));
  await lifecycle.markIntent({ intentId: oldIntent, sessionId: "old-session", turnId: "old-turn", projectRoot: f.target, prompt: "old request" });
  await assert.rejects(lifecycle.reserveBegin({ intentId: oldIntent, objective: "old request", projectRoot: f.target }), /repossessed|revoked/);
});

test("explicit authorization is necessary and stale replay protects a replacement lease", async t => {
  const f = await fixture(t), args = await recovery(f), before = await tree(f.data);
  await assert.rejects(f.store.repossess({ ...args, user_authorization: "" }), /authorization/); assert.deepEqual(await tree(f.data), before);
  await f.store.repossess(args); await acquireAuthorizedLease(f.data, f.leaseId, { intentId: "intent-new-owner", leaseToken: "new-private-token" });
  const after = await tree(f.data); await assert.rejects(f.store.repossess(args), /generation|owner/); assert.deepEqual(await tree(f.data), after);
});

test("post-tombstone progress and replacement races leave the branch reservation held", async t => {
  const f = await fixture(t), args = await recovery(f);
  const store = new f.BranchLeaseRecoveryStore(f.data, { afterTombstone: async () => {
    await putAuthorizedOnceExact(f.data, "begin-operations", oldIntent, { intentId: oldIntent, operationToken: "race-operation" });
  } });
  await assert.rejects(store.repossess(args), /surviving_authority/);
  assert.equal((await readAuthorizedLeaseSnapshotReadOnly(f.data, f.leaseId))?.state, "held");
  const lifecycle = new LifecycleStore(f.data, async () => ({ exitCode: 0, stdout: "", stderr: "" }));
  await assert.rejects(lifecycle.reserveBegin({ intentId: oldIntent, objective: "old request", projectRoot: f.target }), /repossessed|revoked/);
});

test("held old Begin attempt gate is protected and diagnosis never releases it", async t => {
  const f = await fixture(t), gate = `begin-attempt-${createHash("sha256").update(oldIntent).digest("hex")}`;
  await acquireAuthorizedLease(f.data, gate, { intentId: oldIntent, leaseToken: "live-attempt-private-token", operation: "begin-attempt" });
  const before = await tree(f.container), diagnosis = await f.store.diagnose(f.args);
  assert.equal(diagnosis.eligible, false); assert.equal(diagnosis.reason, "surviving_authority"); assert.deepEqual(await tree(f.container), before);
});

test("signed orphan release can be followed by ordinary Merge Prep without a new worktree", async t => {
  const f = await fixture(t), source = path.join(f.container, "retained-source");
  await mkdir(path.join(f.target, ".captain-sdlc"));
  await writeFile(path.join(f.target, ".captain-sdlc", "codex-policy.json"), JSON.stringify({ profile: "low", visualRequired: false, commands: { build: "build fixture", ticket: "ticket fixture", "feature-smoke": "smoke fixture", "affected-regression": "affected fixture", "super-smoke": "strict fixture" } }));
  await writeFile(path.join(f.target, ".captain-sdlc", "merge-policy.json"), JSON.stringify({ schema_version: 1, strictness: "low" }));
  await git(f.target, "add", "."); await git(f.target, "commit", "-m", "fixture policy");
  await git(f.target, "worktree", "add", "-b", "retained-task", source);
  const listing = await git(f.target, "worktree", "list", "--porcelain");
  await f.store.repossess(await recovery(f));
  const { MergeWorkflowStore } = await import("../src/merge-workflow.js");
  const store = new MergeWorkflowStore(f.data, async () => ({ exitCode: 0, stdout: "pass", stderr: "" }));
  const ready = await store.prep({ source_worktree: source, target_worktree: f.target, target_branch: "main", session_id: "session-current" });
  assert.equal(ready.state, "ready"); assert.equal(ready.source_worktree, source); assert.equal(ready.target_worktree, f.target);
  assert.equal(await git(f.target, "worktree", "list", "--porcelain"), listing);
});

test("raw legacy lease requires authenticated resource binding and rejects signed filename replay", async t => {
  const f = await fixture(t, true);
  for (const payload of [{ intentId: oldIntent, leaseToken: "private-fixture-token" }, { ...f.payload, targetBranch: "wrong-branch" }, { ...f.payload, commonGitDir: path.join(f.container, "another-repository") }, { ...f.payload, targetOid: "f".repeat(40) }]) {
    await writeAuthorized(f.data, "leases", f.leaseId, payload);
    const before = await tree(f.container), diagnosis = await f.store.diagnose(f.args);
    assert.equal(diagnosis.eligible, false); assert.match(diagnosis.reason, /binding|unbound_legacy/); assert.deepEqual(await tree(f.container), before);
  }
});

test("issuance receipt alone protects an issued intent and another active task protects target", async t => {
  const f = await fixture(t);
  await putAuthorizedOnceExact(f.data, "intent-issuance", "issuance-fixture", { request: { sessionId: "original-private-session" }, intent: { intentId: oldIntent } });
  assert.equal((await f.store.diagnose(f.args)).reason, "surviving_authority");
  await unlink(path.join(f.data, "intent-issuance", "issuance-fixture.json"));
  await putAuthorizedOnceExact(f.data, "runs", "intent-other-task", { intentId: "intent-other-task", phase: "implement", status: "running", worktreePath: f.target, branch: "main", commonGitDir: f.commonGitDir });
  const result = await f.store.diagnose(f.args); assert.equal(result.eligible, false); assert.equal(result.reason, "active_worktree_owner");
  assert.doesNotMatch(JSON.stringify(result), /original-private-session|intent-other-task/);
});

test("repossession preserves dirt and staged index in the retained source checkout too", async t => {
  const f = await fixture(t), source = path.join(f.container, "retained-source");
  await git(f.target, "worktree", "add", "-b", "retained-task", source);
  await writeFile(path.join(source, "product.txt"), "source staged\n"); await git(source, "add", "product.txt");
  await writeFile(path.join(source, "product.txt"), "source unstaged\n"); await writeFile(path.join(source, "source-loose.txt"), "source loose\n");
  const before = await tree(source), index = await readFile(await git(source, "rev-parse", "--path-format=absolute", "--git-path", "index"));
  await f.store.repossess(await recovery(f));
  assert.deepEqual(await tree(source), before); assert.deepEqual(await readFile(await git(source, "rev-parse", "--path-format=absolute", "--git-path", "index")), index);
});

for (const stage of ["afterGuard", "afterTombstone", "afterLegacyRevision", "afterLegacyMigration", "afterRelease"] as const) test(`interrupted ${stage} is replayed with the identical signed selection`, async t => {
  const f = await fixture(t, stage.startsWith("afterLegacy")), args = await recovery(f), before = await tree(f.target);
  const failing = new f.BranchLeaseRecoveryStore(f.data, { [stage]: async () => { throw new Error("injected interruption"); } });
  await assert.rejects(failing.repossess(args), /injected interruption/);
  if (stage !== "afterLegacyRevision") assert.equal((await readAuthorizedLeaseSnapshotReadOnly(f.data, f.leaseId))?.state, stage === "afterRelease" ? "released" : "held");
  const diagnosed = await f.store.diagnose(f.args); assert.equal(diagnosed.eligible, true); assert.equal(diagnosed.reason, "repossession_interrupted");
  assert.equal((await f.store.repossess(args)).state, "released"); assert.deepEqual(await tree(f.target), before);
});

test("a repossession marker cannot be deleted behind its signed watermark", async t => {
  const f = await fixture(t), args = await recovery(f); await f.store.repossess(args);
  await unlink(path.join(f.data, "branch-lease-repossessions", `${oldIntent}.json`));
  const lifecycle = new LifecycleStore(f.data, async () => ({ exitCode: 0, stdout: "", stderr: "" }));
  await assert.rejects(lifecycle.reserveBegin({ intentId: oldIntent, objective: "old request", projectRoot: f.target }), /regressed|invalid/);
  await assert.rejects(f.store.repossess(args), /regressed|watermark/);
});

test("a paused task's planned target is not itself target-checkout ownership", async t => {
  const f = await fixture(t), source = path.join(f.container, "another-retained-task");
  await git(f.target, "worktree", "add", "-b", "another-retained-task", source);
  await putAuthorizedOnceExact(f.data, "runs", "intent-other-paused", { intentId: "intent-other-paused", phase: "implement", status: "paused", worktreePath: source, branch: "another-retained-task", targetBranch: "main", commonGitDir: f.commonGitDir });
  const before = await tree(source), diagnosed = await f.store.diagnose(f.args); assert.equal(diagnosed.eligible, true);
  await f.store.repossess(await recovery(f)); assert.deepEqual(await tree(source), before);
});

test("a completed actual merge ledger permits later orphan recovery without changing retained checkouts", async t => {
  const f = await fixture(t), source = path.join(f.container, "completed-source");
  await releaseAuthorizedLease(f.data, f.leaseId, oldIntent, f.payload.leaseToken);
  await mkdir(path.join(f.target, ".captain-sdlc"));
  await writeFile(path.join(f.target, ".captain-sdlc", "codex-policy.json"), JSON.stringify({ profile: "low", visualRequired: false, commands: { build: "build fixture", ticket: "ticket fixture", "feature-smoke": "smoke fixture", "affected-regression": "affected fixture", "super-smoke": "strict fixture" } }));
  await writeFile(path.join(f.target, ".captain-sdlc", "merge-policy.json"), JSON.stringify({ schema_version: 1, strictness: "low" }));
  await git(f.target, "add", "."); await git(f.target, "commit", "-m", "fixture policy");
  await git(f.target, "worktree", "add", "-b", "completed-task", source);
  const { MergeWorkflowStore } = await import("../src/merge-workflow.js");
  const merge = new MergeWorkflowStore(f.data, async () => ({ exitCode: 0, stdout: "pass", stderr: "" }));
  const ready = await merge.prep({ source_worktree: source, target_worktree: f.target, target_branch: "main", session_id: "fixture-completed-session" });
  const complete = await merge.back({ merge_id: ready.merge_id, session_id: "fixture-completed-session" }); assert.equal(complete.state, "merged");
  await acquireAuthorizedLease(f.data, f.leaseId, f.payload);
  const before = await tree(f.target), diagnosed = await f.store.diagnose(f.args); assert.equal(diagnosed.eligible, true);
  await f.store.repossess(await recovery(f)); assert.deepEqual(await tree(f.target), before);
});

test("historical workspace and permit checkpoints follow a completed run's ownership", async t => {
  const f = await fixture(t), other = "intent-completed-other";
  await putAuthorizedOnceExact(f.data, "runs", other, { intentId: other, runId: "completed-run", operationToken: "completed-op", phase: "complete", status: "green", worktreePath: f.target, branch: "main", commonGitDir: f.commonGitDir });
  await putAuthorizedOnceExact(f.data, "begin-workspaces", "completed-op", { operationToken: "completed-op", worktreePath: f.target, branch: "main", commonGitDir: f.commonGitDir });
  await putAuthorizedOnceExact(f.data, "permits", "completed-permit", { intentId: other, runId: "completed-run", worktreePath: f.target });
  assert.equal((await f.store.diagnose(f.args)).eligible, true);
});

test("pre-marker hard-crash guard replays only its signed selection after local owner stopped", async t => {
  const f = await fixture(t), args = await recovery(f);
  const failing = new f.BranchLeaseRecoveryStore(f.data, { afterGuard: async () => { throw new Error("pre-marker interruption"); } });
  await assert.rejects(failing.repossess(args), /pre-marker interruption/);
  const journal = await readAuthorizedReadOnly<any>(f.data, "branch-lease-repossession-selections", oldIntent);
  const child = spawn(process.execPath, ["-e", "process.exit(0)"], { windowsHide: true, stdio: "ignore" }); const pid = child.pid; await once(child, "exit"); assert.ok(pid);
  const gate = `begin-attempt-${createHash("sha256").update(oldIntent).digest("hex")}`;
  const payload = { intentId: oldIntent, leaseToken: "synthetic-interrupted-guard", operation: "branch-repossession-attempt", sessionId: args.session_id, recoveryId: journal.recovery_id, resourceGeneration: args.resource_generation, ownerHost: hostname(), ownerPid: pid };
  await acquireAuthorizedLease(f.data, gate, payload);
  const before = await tree(f.container), diagnosis = await f.store.diagnose(f.args); assert.equal(diagnosis.eligible, true); assert.deepEqual(await tree(f.container), before);
  assert.equal((await f.store.repossess(args)).state, "released");
});

test("live or foreign correlated recovery guards refuse the same signed replay", async t => {
  const f = await fixture(t), args = await recovery(f);
  await assert.rejects(new f.BranchLeaseRecoveryStore(f.data, { afterGuard: async () => { throw new Error("interruption"); } }).repossess(args), /interruption/);
  const journal = await readAuthorizedReadOnly<any>(f.data, "branch-lease-repossession-selections", oldIntent);
  const gate = `begin-attempt-${createHash("sha256").update(oldIntent).digest("hex")}`;
  for (const ownerHost of [hostname(), "foreign-host"]) {
    const payload = { intentId: oldIntent, leaseToken: `synthetic-${ownerHost}`, operation: "branch-repossession-attempt", sessionId: args.session_id, recoveryId: journal.recovery_id, resourceGeneration: args.resource_generation, ownerHost, ownerPid: process.pid };
    await acquireAuthorizedLease(f.data, gate, payload);
    const before = await tree(f.container); assert.equal((await f.store.diagnose(f.args)).eligible, false);
    await assert.rejects(f.store.repossess(args), /surviving_authority|active|ambiguous/); assert.deepEqual(await tree(f.container), before);
    await releaseAuthorizedLease(f.data, gate, oldIntent, payload.leaseToken);
  }
});

test("unclaimed producer operationToken is a reference, while linked token-only checkpoints remain protected", async t => {
  const f = await fixture(t), operationToken = "legacy-operation-fixture";
  await releaseAuthorizedLease(f.data, f.leaseId, oldIntent, f.payload.leaseToken);
  await acquireAuthorizedLease(f.data, f.leaseId, { ...f.payload, operationToken });
  const initial = await f.store.diagnose(f.args); assert.equal(initial.eligible, true); assert.ok(initial.lease.payload_fields?.includes("operationToken"));
  assert.doesNotMatch(JSON.stringify(initial), /legacy-operation-fixture/);
  await putAuthorizedOnceExact(f.data, "begin-repositories", operationToken, { schemaVersion: 1, operationToken, projectRoot: f.target, commonGitDir: f.commonGitDir });
  const before = await tree(f.container), blocked = await f.store.diagnose(f.args); assert.equal(blocked.eligible, false); assert.equal(blocked.reason, "surviving_authority"); assert.deepEqual(await tree(f.container), before);
});

test("pending public diagnosis retains the exact prior reason and human instruction for replay", async t => {
  const f = await fixture(t), args = { ...await recovery(f), reason: "Specific original incident reason", user_authorization: "Original user's complete instruction" };
  await assert.rejects(new f.BranchLeaseRecoveryStore(f.data, { afterGuard: async () => { throw new Error("interruption"); } }).repossess(args), /interruption/);
  const result = await f.store.diagnose(f.args); assert.equal(result.eligible, true); assert.deepEqual(result.recovery?.args, args);
  assert.equal((await f.store.repossess(result.recovery!.args as typeof args)).state, "released");
});

test("surviving authority provenance routes only the original caller to supported Begin diagnosis", async t => {
  const f = await fixture(t), originalRoot = path.join(f.container, "retained-issued-root"), operationToken = "provenance-private-operation";
  await git(f.target, "worktree", "add", "-b", "retained-issued-task", originalRoot);
  await releaseAuthorizedLease(f.data, f.leaseId, oldIntent, f.payload.leaseToken); await acquireAuthorizedLease(f.data, f.leaseId, { ...f.payload, operationToken });
  await putAuthorizedOnceExact(f.data, "intents", oldIntent, { intentId: oldIntent, sessionId: f.args.session_id, projectRoot: originalRoot, targetBranch: "main", targetOid: f.payload.targetOid });
  await putAuthorizedOnceExact(f.data, "begin-operations", oldIntent, { schemaVersion: 1, intentId: oldIntent, sessionId: f.args.session_id, projectRoot: originalRoot, targetBranch: "main", operationToken });
  await putAuthorizedOnceExact(f.data, "begin-repositories", operationToken, { operationToken, projectRoot: originalRoot, commonGitDir: f.commonGitDir });
  const before = await tree(f.container), result = await f.store.diagnose(f.args);
  assert.equal(result.eligible, false); assert.equal(result.reason, "surviving_authority");
  assert.deepEqual(result.authority?.matched_buckets, ["begin-operations", "begin-repositories", "intents"]);
  assert.equal(result.authority?.session_match, "same"); assert.equal(result.authority?.recorded_root_matches_repository, true);
  assert.deepEqual(result.authority?.args, { intent_id: oldIntent, session_id: f.args.session_id, project_root: originalRoot, target_worktree: originalRoot, target_branch: "main" });
  assert.doesNotMatch(JSON.stringify(result), /provenance-private-operation|leaseToken/); assert.deepEqual(await tree(f.container), before);
  const foreign = await f.store.diagnose({ ...f.args, session_id: "another-caller" }); assert.equal(foreign.authority?.session_match, "other"); assert.equal(foreign.authority?.args, undefined);
  assert.doesNotMatch(JSON.stringify(foreign), /session-current|provenance-private-operation|retained-issued-root/);
});

test("completed release evidence prevents initial-tail rollback being treated as a resumable migration", async t => {
  const f = await fixture(t, true), args = await recovery(f); await f.store.repossess(args);
  await unlink(path.join(f.data, "lease-revisions", `${f.leaseId}-1.json`)); await unlink(path.join(f.data, "lease-watermarks", `${f.leaseId}-1.json`)); await unlink(path.join(f.data, "lease-watermarks", `${f.leaseId}-0.json`));
  const before = await tree(f.container); await assert.rejects(f.store.diagnose(f.args), /ENOENT|watermark|tail|result/); await assert.rejects(f.store.repossess(args), /ENOENT|watermark|tail|result/); assert.deepEqual(await tree(f.container), before);
});

async function failedBeginFixture(t: TestContext, distinctOriginalRoot = false) {
  const f = await fixture(t); await releaseAuthorizedLease(f.data, f.leaseId, oldIntent, f.payload.leaseToken);
  const { captainIssueIntent, captainBegin } = await import("../src/server.js");
  const workspace = await import("../src/workspace.js");
  const lifecycle = new LifecycleStore(f.data, async () => ({ exitCode: 0, stdout: "", stderr: "" }));
  const issuedRoot = distinctOriginalRoot ? path.join(f.container, "original-private-issued-root") : f.target;
  if (distinctOriginalRoot) await git(f.target, "worktree", "add", "-b", "original-issued-root-task", issuedRoot);
  const issued = await captainIssueIntent(lifecycle, { session_id: "original-private-session", turn_id: "original-private-turn", project_root: issuedRoot, prompt: "Original bounded task", action: "start", target_branch: "main" });
  await assert.rejects(captainBegin(lifecycle, { intent_id: issued.intent_id, objective: "Original bounded task", project_root: issuedRoot }, { repositoryIdentity: workspace.repositoryIdentity, ensureWorktree: workspace.ensureWorktree, loadPolicy: async () => ({ profile: "low", visualRequired: false, commands: { build: "fixture build", ticket: "fixture ticket" } }) }), /outside the canonical worktree/);
  return { ...f, intent: issued.intent_id, lifecycle };
}
async function failedRecovery(f: Awaited<ReturnType<typeof failedBeginFixture>>) {
  const diagnosis = await (f.store as any).diagnoseFailedBegin(f.args); assert.equal(diagnosis.eligible, true);
  return { ...diagnosis.recovery.args, reason: "Explicitly revoke only the unstarted reservation", user_authorization: "Unblock it. Retain the same worktree." };
}

test("operator diagnosis verifies a different-session terminal pre-workspace Begin without claiming stop", async t => {
  const f = await failedBeginFixture(t), before = await tree(f.container), diagnosis = await (f.store as any).diagnoseFailedBegin(f.args);
  assert.equal(diagnosis.eligible, true); assert.equal(diagnosis.verified_pre_workspace, true); assert.equal(diagnosis.original_session_match, "other");
  assert.equal(diagnosis.recovery.next_tool, "captain_repossess_failed_begin"); assert.deepEqual(await tree(f.container), before);
  assert.doesNotMatch(JSON.stringify(diagnosis), /original-private-session|original-private-turn|leaseToken|confirm_owner_stopped/);
  assert.equal((await f.store.diagnose(f.args)).eligible, false, "strict orphan eligibility remains unchanged");
});

test("explicit operator revocation publishes older-runtime Begin retirement and preserves both existing checkouts", async t => {
  const f = await failedBeginFixture(t), source = path.join(f.container, "retained-source"); await git(f.target, "worktree", "add", "-b", "retained-task", source);
  await writeFile(path.join(f.target, "product.txt"), "target staged\n"); await git(f.target, "add", "product.txt"); await writeFile(path.join(f.target, "product.txt"), "target loose\n");
  await writeFile(path.join(source, "product.txt"), "source loose\n"); await writeFile(path.join(source, "source-note.md"), "keep this\n");
  const beforeTarget = await tree(f.target), beforeSource = await tree(source), args = await failedRecovery(f);
  const receipt = await (f.store as any).repossessFailedBegin(args); assert.equal(receipt.state, "revoked"); assert.equal(receipt.old_intent_id, f.intent);
  assert.deepEqual(await tree(f.target), beforeTarget); assert.deepEqual(await tree(source), beforeSource);
  assert.ok(await f.lifecycle.beginCancellationFor(f.intent)); await assert.rejects(f.lifecycle.reserveBegin({ intentId: f.intent, projectRoot: f.target, objective: "Original bounded task" }), /cancelled|revoked/);
  assert.equal((await readAuthorizedLeaseSnapshotReadOnly(f.data, f.leaseId))?.state, "released");
  const after = await tree(f.data); assert.deepEqual(await (f.store as any).repossessFailedBegin(args), receipt); assert.deepEqual(await tree(f.data), after);
  assert.doesNotMatch(JSON.stringify(receipt), /original-private-session|original-private-turn|leaseToken|confirm_owner_stopped/);
});

for (const progressed of ["workspace", "active-attempt"] as const) test(`operator cannot revoke a ${progressed} original Begin`, async t => {
  const f = await failedBeginFixture(t), args = await failedRecovery(f);
  if (progressed === "workspace") await mkdir(path.join(f.target, ".captain-sdlc", "worktrees", f.intent), { recursive: true });
  else await acquireAuthorizedLease(f.data, `begin-attempt-${createHash("sha256").update(f.intent).digest("hex")}`, { intentId: f.intent, leaseToken: "active-private-attempt", operation: "begin-attempt" });
  const before = await tree(f.container); assert.equal((await (f.store as any).diagnoseFailedBegin(f.args)).eligible, false);
  await assert.rejects((f.store as any).repossessFailedBegin(args), /refused|progress|active|ambiguous/); assert.deepEqual(await tree(f.container), before);
});

for (const stage of ["afterTombstone", "afterRelease"] as const) test(`operator revocation resumes ${stage} with its original authority and selectors`, async t => {
  const f = await failedBeginFixture(t), args = await failedRecovery(f), before = await tree(f.target);
  await assert.rejects((new f.BranchLeaseRecoveryStore(f.data, { [stage]: async () => { throw new Error("operator interruption"); } }) as any).repossessFailedBegin(args), /operator interruption/);
  const diagnosis = await (f.store as any).diagnoseFailedBegin(f.args); assert.equal(diagnosis.eligible, true); assert.deepEqual(diagnosis.recovery.args, args);
  assert.equal((await (f.store as any).repossessFailedBegin(args)).state, "revoked"); assert.deepEqual(await tree(f.target), before);
});

test("operator revocation protects another held mutation lease on the actual target", async t => {
  const f = await failedBeginFixture(t), args = await failedRecovery(f);
  await acquireAuthorizedLease(f.data, "foreign-target-fence", { intentId: "intent-other-owner", leaseToken: "foreign-private-token", operation: "worktree-mutation", worktreePath: f.target });
  const before = await tree(f.container); assert.equal((await (f.store as any).diagnoseFailedBegin(f.args)).eligible, false);
  await assert.rejects((f.store as any).repossessFailedBegin(args), /refused|progress/); assert.deepEqual(await tree(f.container), before);
});

test("operator revokes a terminal unstarted reservation after legitimate target advance with original graph intact", async t => {
  const f = await failedBeginFixture(t), original = await f.lifecycle.readBeginCancellationEvidence(f.intent);
  await writeFile(path.join(f.target, "product.txt"), "legitimate committed advance\n"); await git(f.target, "commit", "-am", "advance target");
  const currentHead = await git(f.target, "rev-parse", "HEAD"); assert.notEqual(currentHead, original.operation.targetOid);
  const before = await tree(f.target), diagnosis = await (f.store as any).diagnoseFailedBegin(f.args);
  assert.equal(diagnosis.eligible, true); assert.equal(diagnosis.original_state.target_ref_matches, false);
  assert.equal(diagnosis.recovery.args.expected_head, currentHead);
  const receipt = await (f.store as any).repossessFailedBegin(await failedRecovery(f)); assert.equal(receipt.state, "revoked");
  assert.deepEqual(await tree(f.target), before); assert.equal(await git(f.target, "rev-parse", "HEAD"), currentHead);
  const after = await f.lifecycle.readBeginCancellationEvidence(f.intent);
  assert.deepEqual([after.intent, after.operation, after.repository, after.lease, after.consumed], [original.intent, original.operation, original.repository, original.lease, original.consumed]);
});

test("advanced-target operator selection refuses a further target move before revocation", async t => {
  const f = await failedBeginFixture(t);
  await writeFile(path.join(f.target, "product.txt"), "first committed advance\n"); await git(f.target, "commit", "-am", "first target advance");
  const args = await failedRecovery(f);
  await writeFile(path.join(f.target, "product.txt"), "second committed advance\n"); await git(f.target, "commit", "-am", "second target advance");
  const before = await tree(f.data); await assert.rejects((f.store as any).repossessFailedBegin(args), /binding|generation/); assert.deepEqual(await tree(f.data), before);
});

for (const footprint of ["ref", "primary-path", "registered-path"] as const) test(`operator preserves a ${footprint} old workspace footprint at the corrected primary root`, async t => {
  const f = await failedBeginFixture(t, true), args = await failedRecovery(f);
  if (footprint === "ref") await git(f.target, "branch", `captain/${f.intent}`);
  else if (footprint === "primary-path") await mkdir(path.join(f.target, ".captain-sdlc", "worktrees", f.intent), { recursive: true });
  else await git(f.target, "worktree", "add", "-b", "retained-partial-old-task", path.join(f.container, f.intent));
  const before = await tree(f.container), diagnosis = await (f.store as any).diagnoseFailedBegin(f.args); assert.equal(diagnosis.eligible, false);
  await assert.rejects((f.store as any).repossessFailedBegin(args), /refused|progress|workspace/); assert.deepEqual(await tree(f.container), before);
  assert.doesNotMatch(JSON.stringify(diagnosis), /original-private-issued-root|original-private-session|leaseToken/);
});

test("session-activity diagnostics identify an unrelated completed resumed source task without leaking selectors", async t => {
  const f = await failedBeginFixture(t), source = path.join(f.container, "unrelated-source"); await git(f.target, "worktree", "add", "-b", "source-other", source);
  const other = "intent-completed-unrelated", session = "original-private-session", activation = "complete-activation-fixture", baseOperation = "base-operation-fixture", runId = "completed-run";
  await putAuthorizedOnceExact(f.data, "begin-operations", other, { schemaVersion: 1, intentId: other, sessionId: session, operationToken: baseOperation, runId });
  await putAuthorizedOnceExact(f.data, "runs", other, { schemaVersion: 1, intentId: other, sessionId: session, operationToken: baseOperation, activationToken: activation, runId, phase: "complete", status: "green", worktreePath: source, branch: "source-other", targetBranch: "main", commonGitDir: f.commonGitDir });
  await putAuthorizedOnceExact(f.data, "active", session, { intentId: "none", complete: true, operationToken: activation });
  const sessionId = createHash("sha256").update(`session-active\0${session}`).digest("hex"), payload = { intentId: other, leaseToken: activation, operation: "session-active", operationToken: activation, sessionId: session, runId };
  await acquireAuthorizedLease(f.data, sessionId, payload); await releaseAuthorizedLease(f.data, sessionId, other, activation);
  const before = await tree(f.container), diagnosis = await (f.store as any).diagnoseFailedBegin(f.args), activity = diagnosis.original_state.session_activity;
  assert.equal(activity.active_projection_claims_original, false); assert.equal(activity.session_lease_state, "released"); assert.equal(activity.correlated_run_verified, true); assert.equal(activity.correlated_run_phase, "complete"); assert.equal(activity.correlated_run_status, "green"); assert.equal(activity.correlated_run_owns_actual_target, false);
  assert.equal(diagnosis.original_state.later_state.active, true); assert.deepEqual(await tree(f.container), before);
  assert.doesNotMatch(JSON.stringify(diagnosis), /complete-activation-fixture|base-operation-fixture|intent-completed-unrelated|completed-run|original-private-session/);
});

test("session-activity diagnostics keep matching original active ownership refused", async t => {
  const f = await failedBeginFixture(t), evidence = await f.lifecycle.readBeginCancellationEvidence(f.intent), session = "original-private-session", operation = evidence.operation.operationToken;
  const id = createHash("sha256").update(`session-active\0${session}`).digest("hex");
  await putAuthorizedOnceExact(f.data, "active", session, { schemaVersion: 1, intentId: f.intent, operationToken: operation, runId: evidence.operation.runId, sessionId: session, leaseId: id, leaseToken: operation });
  await acquireAuthorizedLease(f.data, id, { intentId: f.intent, leaseToken: operation, operationToken: operation, runId: evidence.operation.runId, sessionId: session, operation: "session-active" });
  const before = await tree(f.container), diagnosis = await (f.store as any).diagnoseFailedBegin(f.args), activity = diagnosis.original_state.session_activity;
  assert.equal(diagnosis.eligible, false); assert.equal(activity.active_projection_claims_original, true); assert.equal(activity.session_lease_claims_original, true); assert.equal(activity.session_lease_state, "held"); assert.deepEqual(await tree(f.container), before);
});

async function unrelatedPausedFixture(t: TestContext, variant = "paused") {
  const f = await failedBeginFixture(t), source = path.join(f.container, "paused-unrelated-source");
  await git(f.target, "worktree", "add", "-b", "paused-other", source);
  const other = "intent-paused-unrelated", session = "original-private-session", operation = "paused-private-operation", runId = "paused-private-run";
  const original = await f.lifecycle.readBeginCancellationEvidence(f.intent);
  const activation = variant === "original-operation" ? original.operation.operationToken : operation;
  const correlatedRunId = variant === "original-run" ? original.operation.runId : runId;
  const sessionId = createHash("sha256").update(`session-active\0${session}`).digest("hex");
  await putAuthorizedOnceExact(f.data, "begin-operations", other, { schemaVersion: 1, intentId: other, sessionId: session, operationToken: activation, runId: correlatedRunId });
  await putAuthorizedOnceExact(f.data, "runs", other, { schemaVersion: 1, intentId: other, sessionId: session, operationToken: activation, runId: correlatedRunId, phase: "tdd_red", status: variant === "running" ? "running" : "paused", worktreePath: variant === "target-owner" ? f.target : source, branch: variant === "target-owner" ? "main" : "paused-other", targetBranch: "main", commonGitDir: f.commonGitDir });
  await putAuthorizedOnceExact(f.data, "pause-handoffs", other, { intentId: other, sessionId: session, runId: correlatedRunId, worktreePath: source, nextAction: "Keep the unrelated task paused" });
  const projection = { schemaVersion: 1, intentId: other, operationToken: activation, runId: variant === "uncorrelated" ? "unmatched-private-run" : correlatedRunId, sessionId: session, leaseId: sessionId, leaseToken: activation };
  await putAuthorizedOnceExact(f.data, "active", session, variant === "malformed" ? { ...projection, ambiguous: true } : projection);
  await acquireAuthorizedLease(f.data, sessionId, { intentId: other, leaseToken: activation, operationToken: activation, runId: correlatedRunId, sessionId: session, operation: "session-active" });
  if (variant !== "held-session") await releaseAuthorizedLease(f.data, sessionId, other, activation);
  await writeFile(path.join(source, "product.txt"), "paused source staged\n"); await git(source, "add", "product.txt");
  await writeFile(path.join(source, "product.txt"), "paused source loose\n"); await writeFile(path.join(source, "paused-note.md"), "preserve unrelated task\n");
  return { ...f, source };
}

test("operator recovery coexists with an unrelated authenticated paused source task and preserves all its state", async t => {
  const f = await unrelatedPausedFixture(t), beforeTarget = await tree(f.target), beforeSource = await tree(f.source), beforeAuthority = await tree(f.data);
  const diagnosis = await (f.store as any).diagnoseFailedBegin(f.args);
  assert.equal(diagnosis.eligible, true); assert.equal(diagnosis.original_state.later_state.active, true);
  assert.equal(diagnosis.original_state.completed_session_tombstone_verified, false);
  assert.equal(diagnosis.original_state.completed_session_owner_verified, false, "legacy paused evidence grants no completed-owner exception");
  assert.equal(diagnosis.original_state.unrelated_paused_session_projection_verified, true);
  assert.equal(diagnosis.original_state.session_activity.correlated_run_status, "paused");
  assert.equal((await f.store.diagnose(f.args)).eligible, false, "strict orphan eligibility does not change");
  assert.deepEqual(await tree(f.data), beforeAuthority);
  const receipt = await (f.store as any).repossessFailedBegin(await failedRecovery(f)); assert.equal(receipt.state, "revoked");
  assert.deepEqual(await tree(f.target), beforeTarget); assert.deepEqual(await tree(f.source), beforeSource);
  const afterAuthority = await tree(f.data);
  for (const [name, hash] of Object.entries(beforeAuthority)) {
    if (!name.includes(f.leaseId)) assert.equal(afterAuthority[name], hash, `preserved signed original or unrelated authority ${name}`);
  }
  assert.doesNotMatch(JSON.stringify(diagnosis), /intent-paused-unrelated|paused-private-operation|paused-private-run|original-private-session|paused-unrelated-source/);
});

for (const variant of ["running", "held-session", "target-owner", "uncorrelated", "malformed", "original-operation", "original-run"] as const) test(`paused-session coexistence refuses ${variant} ownership`, async t => {
  const other = await unrelatedPausedFixture(t, variant);
  const lease = await readAuthorizedLeaseSnapshotReadOnly<any>(other.data, other.leaseId);
  const selected = { ...other.args, old_intent_id: other.intent, expected_lease_revision: lease!.revision, expected_head: await git(other.target, "rev-parse", "HEAD"), resource_generation: digest({ leaseId: other.leaseId, revision: lease!.revision, state: "held", payload: lease!.payload }), reason: "Explicitly revoke only the unstarted reservation", user_authorization: "Unblock it. Retain the same worktree." };
  const before = await tree(other.container), diagnosis = await (other.store as any).diagnoseFailedBegin(other.args);
  assert.equal(diagnosis.eligible, false); assert.equal(diagnosis.original_state.later_state.active, true);
  await assert.rejects((other.store as any).repossessFailedBegin(selected), /refused|progress|active/); assert.deepEqual(await tree(other.container), before);
});

test("target-owner diagnostics identify a planned target on a source checkpoint without exposing private selectors", async t => {
  const f = await unrelatedPausedFixture(t);
  await putAuthorizedOnceExact(f.data, "begin-workspaces", "paused-private-operation", { schemaVersion: 1, operationToken: "paused-private-operation", projectRoot: f.target, worktreePath: f.source, branch: "paused-other", targetBranch: "main", commonGitDir: f.commonGitDir, gitDir: path.join(f.target, ".git", "worktrees", "paused-unrelated-source"), baseHead: await git(f.source, "rev-parse", "HEAD") });
  const before = await tree(f.container), diagnosis = await (f.store as any).diagnoseFailedBegin(f.args);
  assert.equal(diagnosis.eligible, false); assert.equal(diagnosis.reason, "active_target_lifecycle_owner");
  const candidate = diagnosis.original_state.active_target_candidates.find((entry: any) => entry.bucket === "begin-workspaces"); assert.ok(candidate);
  assert.equal(candidate.actual_worktree_matches, false); assert.equal(candidate.actual_branch_matches, false); assert.equal(candidate.planned_target_branch_matches, true);
  assert.equal(candidate.original_intent_reference, false); assert.equal(candidate.original_operation_reference, false); assert.equal(candidate.original_run_reference, false);
  assert.equal(candidate.correlated_latest_run_verified, true); assert.equal(candidate.correlated_run_phase, "tdd_red"); assert.equal(candidate.correlated_run_status, "paused"); assert.equal(candidate.correlated_run_owns_actual_target, false);
  assert.deepEqual(await tree(f.container), before);
  assert.doesNotMatch(JSON.stringify(diagnosis), /intent-paused-unrelated|paused-private-operation|paused-private-run|original-private-session|paused-unrelated-source/);
});

test("target-owner diagnostics identify real checkout ownership with authenticated current run", async t => {
  const f = await unrelatedPausedFixture(t);
  const intent = "intent-private-target-owner";
  await putAuthorizedOnceExact(f.data, "runs", intent, { schemaVersion: 1, intentId: intent, runId: "private-target-run", operationToken: "private-target-operation", phase: "implement", status: "running", worktreePath: f.target, branch: "main", commonGitDir: f.commonGitDir });
  const before = await tree(f.container), diagnosis = await (f.store as any).diagnoseFailedBegin(f.args);
  assert.equal(diagnosis.eligible, false); assert.equal(diagnosis.reason, "active_target_lifecycle_owner");
  const candidate = diagnosis.original_state.active_target_candidates.find((entry: any) => entry.bucket === "runs"); assert.ok(candidate);
  assert.equal(candidate.actual_worktree_matches, true); assert.equal(candidate.actual_branch_matches, true); assert.equal(candidate.planned_target_branch_matches, false);
  assert.equal(candidate.correlated_latest_run_verified, true); assert.equal(candidate.correlated_run_owns_actual_target, true); assert.equal(candidate.correlated_run_status, "running");
  assert.deepEqual(await tree(f.container), before); assert.doesNotMatch(JSON.stringify(diagnosis), /intent-private-target-owner|private-target-run|private-target-operation/);
});

async function retainedMergeFixture(t: TestContext, state: "ready" | "failed", staleTarget = false) {
  const f = await failedBeginFixture(t), oldLease = await readAuthorizedLeaseSnapshotReadOnly<any>(f.data, f.leaseId), source = path.join(f.container, "retained-merge-source");
  await releaseAuthorizedLease(f.data, f.leaseId, f.intent, oldLease!.payload.leaseToken);
  await mkdir(path.join(f.target, ".captain-sdlc"), { recursive: true });
  await writeFile(path.join(f.target, ".captain-sdlc", "codex-policy.json"), JSON.stringify({ profile: "low", visualRequired: false, commands: { build: "build fixture", ticket: "ticket fixture", "feature-smoke": "smoke fixture", "affected-regression": "affected fixture", "super-smoke": "strict fixture" } }));
  await writeFile(path.join(f.target, ".captain-sdlc", "merge-policy.json"), JSON.stringify({ schema_version: 1, strictness: "low" }));
  await git(f.target, "add", "."); await git(f.target, "commit", "-m", "fixture merge policy"); await git(f.target, "worktree", "add", "-b", "retained-merge-task", source);
  const { MergeWorkflowStore } = await import("../src/merge-workflow.js");
  const merge = new MergeWorkflowStore(f.data, async () => ({ exitCode: state === "failed" ? 1 : 0, stdout: "fixture", stderr: "" }));
  const session = "private-retained-merge-session", historicalTarget = staleTarget ? path.join(f.container, "old-merge-target") : f.target;
  if (staleTarget) { await git(f.target, "checkout", "-b", "historical-primary"); await git(f.target, "worktree", "add", historicalTarget, "main"); }
  let id: string;
  try { id = (await merge.prep({ source_worktree: source, target_worktree: historicalTarget, target_branch: "main", session_id: session })).merge_id; }
  catch (error: any) { assert.equal(state, "failed"); id = error.merge_id; }
  assert.ok(id!); const record = await merge.status({ merge_id: id!, session_id: session }); assert.equal(record.state, state);
  if (staleTarget) { const moved = path.join(f.container, "moved-retained-target"); await git(f.target, "worktree", "move", historicalTarget, moved); await git(moved, "checkout", "-b", "retained-old-target"); await git(f.target, "checkout", "main"); }
  await acquireAuthorizedLease(f.data, f.leaseId, oldLease!.payload);
  return { ...f, source, mergeId: id!, mergeSession: session, record };
}

for (const variant of ["ready", "failed", "stale-source", "held-operation"] as const) test(`merge-owner diagnostics report ${variant} proof and resource state without changing eligibility`, async t => {
  const f = await retainedMergeFixture(t, variant === "failed" ? "failed" : "ready");
  if (variant === "stale-source") { await writeFile(path.join(f.source, "product.txt"), "later source commit\n"); await git(f.source, "commit", "-am", "advance unrelated source"); }
  if (variant === "held-operation") await acquireAuthorizedLease(f.data, createHash("sha256").update(`merge-operation\0${f.mergeId}`).digest("hex"), { intentId: f.mergeId, leaseToken: "private-held-merge-token", sessionId: f.mergeSession, operation: "integration", ownerPid: process.pid, ownerHost: hostname() });
  const before = await tree(f.container), diagnosis = await (f.store as any).diagnoseFailedBegin(f.args);
  assert.equal(diagnosis.eligible, variant === "failed");
  const candidates = diagnosis.original_state.target_lifecycle_candidates ?? diagnosis.original_state.active_target_candidates;
  const candidate = candidates.find((entry: any) => entry.bucket === "merge-revisions"); assert.ok(candidate);
  assert.equal(candidate.merge.state, variant === "failed" ? "failed" : "ready");
  assert.equal(candidate.merge.operation_lease.state, variant === "held-operation" ? "held" : "released");
  assert.equal(candidate.merge.operation_lease.record_owner_matches, true); assert.equal(candidate.merge.operation_lease.revisioned, true);
  if (variant === "held-operation") assert.equal(candidate.merge.operation_lease.owner_state, "live");
  assert.equal(candidate.merge.source_binding.saved_binding_matches_current, true); assert.equal(candidate.merge.source_binding.saved_head_matches_current, variant !== "stale-source");
  assert.equal(candidate.merge.target_binding.saved_binding_matches_current, true); assert.equal(candidate.merge.target_binding.saved_head_matches_current, true);
  assert.equal(candidate.merge.source_resource.state, "released"); assert.equal(candidate.merge.source_resource.held_integration_resource, false);
  assert.equal(candidate.merge.target_resource.state, "held"); assert.equal(candidate.merge.target_resource.held_by_original_begin, true); assert.equal(candidate.merge.target_resource.held_by_this_merge, false);
  assert.deepEqual(await tree(f.container), before);
  assert.doesNotMatch(JSON.stringify(diagnosis), new RegExp(`${f.mergeId}|private-retained-merge-session|private-held-merge-token|retained-merge-source`));
});

async function idleFailedMergeFixture(t: TestContext) {
  const f = await retainedMergeFixture(t, "failed", true);
  await writeFile(path.join(f.source, "product.txt"), "source advanced independently\n"); await git(f.source, "commit", "-am", "advance retained source");
  const sourceId = createHash("sha256").update(`${f.commonGitDir}\0refs/heads/retained-merge-task`.toLowerCase()).digest("hex");
  await acquireAuthorizedLease(f.data, sourceId, { intentId: "intent-private-other-source-owner", leaseToken: "private-source-owner-token", commonGitDir: f.commonGitDir, targetBranch: "retained-merge-task", targetOid: await git(f.source, "rev-parse", "HEAD") });
  return { ...f, sourceId };
}

async function supersededMergeFixture(t: TestContext, state: "ready" | "preparing", finalization = false, side: "source" | "target" = "target") {
  const f = await retainedMergeFixture(t, "ready");
  const previous = await readAuthorizedReadOnly<any>(f.data, "merge-revisions", `${f.mergeId}-${f.record.revision}`);
  const next: any = { ...previous, revision: previous.revision + 1, previous_sha256: digest(previous), state };
  let receipt: any;
  if (finalization) {
    const binding = side === "source" ? f.record.source_binding : f.record.target_binding;
    const selection = { paths: ["Churn/retained.md"], subject: "docs(captain): retain completed records", task_id: "retained-task", disposition: "stash", finalization_id: "finalization-retained-records" };
    const normalized = { worktree: side === "source" ? f.source : f.target, session_id: f.mergeSession, task_id: selection.task_id, paths: selection.paths, subject: selection.subject, disposition: selection.disposition };
    receipt = { schema_version: 1, finalization_id: selection.finalization_id, revision: 0, ...normalized, state: "stashed", request_sha256: digest(normalized), before: binding, after: binding, policy: f.record.captured_policy, policy_sha256: digest(f.record.captured_policy), lease_specs: [], stash_oid: f.record.target_binding.head };
    await putAuthorizedOnceExact(f.data, "bookkeeping-revisions", `${receipt.finalization_id}-0`, receipt);
    await putAuthorizedOnceExact(f.data, "bookkeeping-watermarks", `${receipt.finalization_id}-0`, { finalization_id: receipt.finalization_id, revision: 0, sha256: digest(receipt) });
    next.finalization_requests = { [side]: { selection, expected_head: binding.head } };
    next.finalizations = [receipt];
  }
  await putAuthorizedOnceExact(f.data, "merge-revisions", `${f.mergeId}-${next.revision}`, next);
  await putAuthorizedOnceExact(f.data, "merge-watermarks", `${f.mergeId}-${next.revision}`, { merge_id: f.mergeId, revision: next.revision, sha256: digest(next) });
  await writeFile(path.join(f.target, "later-target.txt"), "target advanced after the dormant prep\n");
  await git(f.target, "add", "later-target.txt"); await git(f.target, "commit", "-m", "advance target beyond dormant receipt");
  return { ...f, record: next, receipt };
}

for (const state of ["ready", "preparing"] as const) test(`superseded released ${state} receipt does not own the current target`, async t => {
  const f = await supersededMergeFixture(t, state), beforeSource = await tree(f.source), beforeTarget = await tree(f.target), beforeAuthority = await tree(f.data);
  const diagnosis = await f.store.diagnoseFailedBegin(f.args);
  assert.equal(diagnosis.eligible, true, JSON.stringify(diagnosis));
  assert.equal((diagnosis.original_state as any).idle_superseded_merge_records_verified, 1);
  assert.equal((await f.store.repossessFailedBegin(await failedRecovery(f))).state, "revoked");
  assert.deepEqual(await tree(f.source), beforeSource); assert.deepEqual(await tree(f.target), beforeTarget);
  const after = await tree(f.data);
  for (const [name, value] of Object.entries(beforeAuthority)) if (/^(merge-|bookkeeping-)/.test(name)) assert.equal(after[name], value, `preserved dormant receipt ${name}`);
});

test("superseded ready receipt preserves unmerged source commit, staged, loose and untracked work", async t => {
  const f = await supersededMergeFixture(t, "ready");
  await writeFile(path.join(f.source, "unmerged-product.txt"), "source-only product\n");
  await git(f.source, "add", "unmerged-product.txt"); await git(f.source, "commit", "-m", "retain unmerged source product");
  const sourceHead = await git(f.source, "rev-parse", "HEAD");
  await assert.rejects(git(f.target, "merge-base", "--is-ancestor", sourceHead, "HEAD"));
  await writeFile(path.join(f.source, "product.txt"), "staged source\n"); await git(f.source, "add", "product.txt");
  await writeFile(path.join(f.source, "product.txt"), "loose source\n");
  await writeFile(path.join(f.source, "untracked.txt"), "retained loose file\n");
  const source = await tree(f.source), target = await tree(f.target), registry = await git(f.target, "worktree", "list", "--porcelain"), index = await git(f.source, "ls-files", "--stage");
  assert.equal((await f.store.diagnoseFailedBegin(f.args)).eligible, true);
  assert.equal((await f.store.repossessFailedBegin(await failedRecovery(f))).state, "revoked");
  assert.equal(await git(f.source, "rev-parse", "HEAD"), sourceHead); assert.equal(await git(f.source, "ls-files", "--stage"), index);
  assert.deepEqual(await tree(f.source), source); assert.deepEqual(await tree(f.target), target);
  assert.equal(await git(f.target, "worktree", "list", "--porcelain"), registry);
});

test("superseded ready receipt with authenticated completed bookkeeping permits exact Begin retirement", async t => {
  const f = await supersededMergeFixture(t, "ready", true), before = await tree(f.container);
  const diagnosis = await f.store.diagnoseFailedBegin(f.args);
  assert.equal(diagnosis.eligible, true); assert.deepEqual(await tree(f.container), before);
  assert.equal((await f.store.repossessFailedBegin(await failedRecovery(f))).state, "revoked");
});

for (const variant of ["equal-target", "divergent-target", "held-operation", "pending-git", "null-requests", "null-receipts", "missing-bookkeeping", "mismatched-bookkeeping", "pending-bookkeeping", "stale-embedded-bookkeeping", "held-bookkeeping-operation", "held-bookkeeping-source-resource"] as const) test(`superseded merge recovery refuses ${variant}`, async t => {
  const withBookkeeping = variant.includes("bookkeeping"), f = await supersededMergeFixture(t, "ready", withBookkeeping, variant === "held-bookkeeping-source-resource" ? "source" : "target");
  if (variant === "null-requests" || variant === "null-receipts") {
    const next = { ...f.record, revision: f.record.revision + 1, previous_sha256: digest(f.record), [variant === "null-requests" ? "finalization_requests" : "finalizations"]: null };
    await putAuthorizedOnceExact(f.data, "merge-revisions", `${f.mergeId}-${next.revision}`, next);
    await putAuthorizedOnceExact(f.data, "merge-watermarks", `${f.mergeId}-${next.revision}`, { merge_id: f.mergeId, revision: next.revision, sha256: digest(next) });
  }
  if (variant === "equal-target") await git(f.target, "reset", "--hard", f.record.target_binding.head);
  if (variant === "divergent-target") { await git(f.target, "checkout", "--orphan", "divergent-target"); await git(f.target, "commit", "-m", "divergent target"); await git(f.target, "branch", "-M", "main"); }
  if (variant === "held-operation") await acquireAuthorizedLease(f.data, createHash("sha256").update(`merge-operation\0${f.mergeId}`).digest("hex"), { intentId: f.mergeId, leaseToken: "private-current-operation", sessionId: f.mergeSession, operation: "integration", ownerPid: process.pid, ownerHost: hostname() });
  if (variant === "pending-git") await writeFile(path.join(f.commonGitDir, "MERGE_HEAD"), f.record.source_binding.head + "\n");
  if (variant === "missing-bookkeeping") { await unlink(path.join(f.data, "bookkeeping-revisions", `${f.receipt.finalization_id}-0.json`)); await unlink(path.join(f.data, "bookkeeping-watermarks", `${f.receipt.finalization_id}-0.json`)); }
  if (["mismatched-bookkeeping", "pending-bookkeeping", "stale-embedded-bookkeeping"].includes(variant)) {
    const receipt = { ...f.receipt, state: variant === "pending-bookkeeping" ? "pending" : "stashed", request_sha256: variant === "mismatched-bookkeeping" ? "wrong-request" : f.receipt.request_sha256 };
    await writeAuthorized(f.data, "bookkeeping-revisions", `${receipt.finalization_id}-0`, receipt);
    await writeAuthorized(f.data, "bookkeeping-watermarks", `${receipt.finalization_id}-0`, { finalization_id: receipt.finalization_id, revision: 0, sha256: digest(receipt) });
    if (variant === "stale-embedded-bookkeeping") {
      receipt.evidence = [{ kind: "terminal-evidence-changed" }];
      await writeAuthorized(f.data, "bookkeeping-revisions", `${receipt.finalization_id}-0`, receipt);
      await writeAuthorized(f.data, "bookkeeping-watermarks", `${receipt.finalization_id}-0`, { finalization_id: receipt.finalization_id, revision: 0, sha256: digest(receipt) });
    } else {
      const next = { ...f.record, revision: f.record.revision + 1, previous_sha256: digest(f.record), finalizations: [receipt] };
      await putAuthorizedOnceExact(f.data, "merge-revisions", `${f.mergeId}-${next.revision}`, next);
      await putAuthorizedOnceExact(f.data, "merge-watermarks", `${f.mergeId}-${next.revision}`, { merge_id: f.mergeId, revision: next.revision, sha256: digest(next) });
    }
  }
  if (variant === "held-bookkeeping-operation" || variant === "held-bookkeeping-source-resource") await acquireAuthorizedLease(f.data, createHash("sha256").update((variant === "held-bookkeeping-operation" ? `bookkeeping-operation\0${f.receipt.finalization_id}` : `bookkeeping-worktree\0${path.resolve(f.receipt.before.commonGitDir)}\0${path.resolve(f.receipt.before.gitDir)}`.toLowerCase())).digest("hex"), { intentId: f.receipt.finalization_id, leaseToken: "private-bookkeeping-resource", operation: "bookkeeping", sessionId: f.mergeSession, ownerPid: process.pid, ownerHost: hostname() });
  const before = await tree(f.container);
  if (variant === "pending-git") await assert.rejects(() => f.store.diagnoseFailedBegin(f.args), /unfinished Git operation/);
  else assert.equal((await f.store.diagnoseFailedBegin(f.args)).eligible, false);
  assert.deepEqual(await tree(f.container), before);
});

test("idle failed merge receipts preserve stale saved target binding and another source owner while permitting exact Begin retirement", async t => {
  const f = await idleFailedMergeFixture(t);
  await writeFile(path.join(f.source, "product.txt"), "unrelated source staged\n"); await git(f.source, "add", "product.txt"); await writeFile(path.join(f.source, "product.txt"), "unrelated source loose\n");
  await writeFile(path.join(f.source, "loose-task-note.md"), "retained unrelated note\n");
  const beforeTarget = await tree(f.target), beforeSource = await tree(f.source), beforeAuthority = await tree(f.data), registry = await git(f.target, "worktree", "list", "--porcelain");
  const diagnosis = await (f.store as any).diagnoseFailedBegin(f.args); assert.equal(diagnosis.eligible, true);
  assert.equal(diagnosis.original_state.idle_failed_merge_records_verified, 1);
  const candidate = diagnosis.original_state.target_lifecycle_candidates.find((entry: any) => entry.bucket === "merge-revisions");
  assert.equal(candidate.exclusive_target_owner, false); assert.equal(candidate.merge.target_binding.read_verified, false); assert.equal(candidate.merge.source_binding.saved_head_matches_current, false);
  assert.equal(candidate.merge.source_resource.state, "held"); assert.equal(candidate.merge.source_resource.held_by_this_merge, false); assert.equal(candidate.merge.source_resource.held_integration_resource, false);
  assert.deepEqual(await tree(f.data), beforeAuthority);
  assert.equal((await (f.store as any).repossessFailedBegin(await failedRecovery(f))).state, "revoked");
  assert.deepEqual(await tree(f.target), beforeTarget); assert.deepEqual(await tree(f.source), beforeSource); assert.equal(await git(f.target, "worktree", "list", "--porcelain"), registry);
  const after = await tree(f.data); for (const [name, hash] of Object.entries(beforeAuthority)) if (!name.includes(f.leaseId)) assert.equal(after[name], hash, `preserved failed merge or other source authority ${name}`);
});

for (const variant of ["held-operation", "held-source-resource", "held-worktree-resource", "detached-merge-resource", "unknown-source-operation", "unknown-source-metadata", "source-pending-git", "target-pending-git", "missing-watermark", "unknown-state", "prepared-merge"] as const) test(`idle failed merge interpretation refuses ${variant}`, async t => {
  const f = await idleFailedMergeFixture(t), lease = await readAuthorizedLeaseSnapshotReadOnly<any>(f.data, f.leaseId);
  const args = { ...f.args, old_intent_id: f.intent, expected_lease_revision: lease!.revision, expected_head: await git(f.target, "rev-parse", "HEAD"), resource_generation: digest({ leaseId: f.leaseId, revision: lease!.revision, state: "held", payload: lease!.payload }), reason: "Retire only the terminal reservation", user_authorization: "Unblock it. Retain the same worktree." };
  if (variant === "held-operation") await acquireAuthorizedLease(f.data, createHash("sha256").update(`merge-operation\0${f.mergeId}`).digest("hex"), { intentId: f.mergeId, leaseToken: "private-live-operation", sessionId: f.mergeSession, operation: "integration", ownerPid: process.pid, ownerHost: hostname() });
  else if (variant === "held-source-resource") { await releaseAuthorizedLease(f.data, f.sourceId, "intent-private-other-source-owner", "private-source-owner-token"); await acquireAuthorizedLease(f.data, f.sourceId, { intentId: f.mergeId, leaseToken: "private-held-source", sessionId: f.mergeSession, operation: "integration-branch", commonGitDir: f.commonGitDir, targetBranch: "retained-merge-task" }); }
  else if (variant === "held-worktree-resource") {
    await putAuthorizedOnceExact(f.data, "runs", "intent-private-correlated-source", { schemaVersion: 1, intentId: "intent-private-correlated-source", runId: "private-correlated-source-run", operationToken: "private-source-operation", phase: "implement", status: "paused", worktreePath: f.source, branch: "retained-merge-task", commonGitDir: f.commonGitDir });
    await acquireAuthorizedLease(f.data, createHash("sha256").update("worktree-mutation\0private-correlated-source-run").digest("hex"), { intentId: f.mergeId, leaseToken: "private-held-worktree", sessionId: f.mergeSession, operation: "integration-worktree" });
  } else if (variant === "detached-merge-resource") {
    await acquireAuthorizedLease(f.data, "private-detached-merge-resource", { intentId: f.mergeId, leaseToken: "private-detached-merge-token", sessionId: f.mergeSession, operation: "integration-worktree" });
  } else if (variant === "unknown-source-operation" || variant === "unknown-source-metadata") {
    const source = await readAuthorizedLeaseSnapshotReadOnly<any>(f.data, f.sourceId);
    await releaseAuthorizedLease(f.data, f.sourceId, source!.payload.intentId, source!.payload.leaseToken);
    await acquireAuthorizedLease(f.data, f.sourceId, { ...source!.payload, ...(variant === "unknown-source-operation" ? { operation: "unrecognized" } : { sessionId: "unknown-private-source-session" }) });
  } else if (variant === "source-pending-git" || variant === "target-pending-git") {
    const root = variant === "source-pending-git" ? f.source : f.target; await writeFile(path.resolve(root, await git(root, "rev-parse", "--git-path", "MERGE_HEAD")), `${await git(root, "rev-parse", "HEAD")}\n`);
  } else if (variant === "missing-watermark") await unlink(path.join(f.data, "merge-watermarks", `${f.mergeId}-${f.record.revision}.json`));
  else {
    const previous = await readAuthorizedReadOnly<any>(f.data, "merge-revisions", `${f.mergeId}-${f.record.revision}`);
    const next = { ...previous, revision: previous.revision + 1, previous_sha256: digest(previous), ...(variant === "unknown-state" ? { state: "unrecognized" } : { prepared_merge: { targetOid: f.record.target_binding.head, preMergeHead: f.record.source_binding.head } }) };
    await putAuthorizedOnceExact(f.data, "merge-revisions", `${f.mergeId}-${next.revision}`, next); await putAuthorizedOnceExact(f.data, "merge-watermarks", `${f.mergeId}-${next.revision}`, { merge_id: f.mergeId, revision: next.revision, sha256: digest(next) });
  }
  const before = await tree(f.container);
  if (variant === "target-pending-git") await assert.rejects((f.store as any).diagnoseFailedBegin(f.args), /unfinished Git/);
  else assert.equal((await (f.store as any).diagnoseFailedBegin(f.args)).eligible, false);
  await assert.rejects((f.store as any).repossessFailedBegin(args), /refused|unfinished|progress|active/); assert.deepEqual(await tree(f.container), before);
});

async function canonicalRetainedFailedBeginFixture(t: TestContext) {
  const f = await fixture(t);
  await releaseAuthorizedLease(f.data, f.leaseId, oldIntent, f.payload.leaseToken);
  const primary = f.target, target = path.join(primary, ".captain-sdlc", "worktrees", "intent-retained-completed"), branch = "retained-completed-task";
  await git(primary, "worktree", "add", "-b", branch, target);
  await writeFile(path.join(target, "diagnostic-notes.md"), "retain diagnostic notes\n");
  const { captainIssueIntent, captainBegin } = await import("../src/server.js"), workspace = await import("../src/workspace.js");
  const lifecycle = new LifecycleStore(f.data, async () => ({ exitCode: 0, stdout: "", stderr: "" }));
  const issued = await captainIssueIntent(lifecycle, { session_id: "original-private-session", turn_id: "canonical-dirty-begin", project_root: primary, prompt: "Continue the retained task", action: "start", target_branch: branch });
  await assert.rejects(captainBegin(lifecycle, { intent_id: issued.intent_id, objective: "Continue the retained task", project_root: primary }, {
    repositoryIdentity: workspace.repositoryIdentity, ensureWorktree: workspace.ensureWorktree,
    loadPolicy: async () => ({ profile: "low", visualRequired: false, commands: { build: "fixture build", ticket: "fixture ticket" } }),
  }), /worktree must be clean/);
  const evidence = await lifecycle.readBeginCancellationEvidence(issued.intent_id);
  return { ...f, primary, target, lifecycle, intent: issued.intent_id, leaseId: evidence.lease.leaseId!,
    args: { ...f.args, project_root: primary, target_worktree: target, target_branch: branch } };
}
async function completedOwnerProjection(f: Awaited<ReturnType<typeof failedBeginFixture>> | Awaited<ReturnType<typeof canonicalRetainedFailedBeginFixture>>, variant = "complete") {
  const priorIntent = "intent-completed-retained-owner", session = "original-private-session", base = "completed-base-operation", activation = "completed-resumed-activation", runId = "completed-retained-run";
  const sessionLeaseId = createHash("sha256").update(`session-active\0${session}`).digest("hex");
  await putAuthorizedOnceExact(f.data, "begin-operations", priorIntent, { schemaVersion: 1, intentId: priorIntent, sessionId: session, operationToken: base, runId });
  const run: any = { schemaVersion: 1, revision: 0, intentId: priorIntent, sessionId: session, operationToken: base, activationToken: activation, runId, phase: "complete", status: "green", worktreePath: f.target, branch: f.args.target_branch, projectRoot: f.args.project_root, commonGitDir: f.commonGitDir, evidence: [], policy: { profile: "low", commands: {}, visualRequired: false } };
  if (variant === "pending-commit") run.preparedCommit = { candidate: "pending" };
  if (variant === "pending-mutation") run.mutationOperation = { stage: "pending" };
  if (variant === "pending-review") run.policy.hitlChecks = [{ id: "human-review" }];
  await putAuthorizedOnceExact(f.data, "runs", priorIntent, run);
  await putAuthorizedOnceExact(f.data, "run-revisions", `${priorIntent}-0`, run);
  await putAuthorizedOnceExact(f.data, "run-watermarks", `${priorIntent}-0`, { schemaVersion: 1, intentId: priorIntent, runId, revision: 0, runSha256: digest(run) });
  if (variant === "latest-running") {
    const current = { ...run, revision: 1, previousRevisionSha256: digest(run), phase: "implement", status: "running" };
    await putAuthorizedOnceExact(f.data, "run-revisions", `${priorIntent}-1`, current);
    await putAuthorizedOnceExact(f.data, "run-watermarks", `${priorIntent}-1`, { schemaVersion: 1, intentId: priorIntent, runId, revision: 1, runSha256: digest(current), previousRevisionSha256: digest(run) });
  }
  const projection = { schemaVersion: 1, intentId: priorIntent, operationToken: activation, runId, sessionId: session, leaseId: sessionLeaseId, leaseToken: activation };
  await putAuthorizedOnceExact(f.data, "active", session, variant === "malformed" ? { ...projection, extra: true } : variant === "wrong-projection-token" ? { ...projection, leaseToken: "wrong-token" } : projection);
  await acquireAuthorizedLease(f.data, sessionLeaseId, { intentId: priorIntent, leaseToken: activation, operationToken: activation, runId, sessionId: session, operation: "session-active" });
  if (variant !== "held-session") await releaseAuthorizedLease(f.data, sessionLeaseId, priorIntent, activation);
  return { priorIntent, session, projection };
}
test("completed retained task-owner projection permits failed-Begin retirement without changing prior authority", async t => {
  const f = await failedBeginFixture(t), prior = await completedOwnerProjection(f), before = await tree(f.container);
  const diagnosis = await (f.store as any).diagnoseFailedBegin(f.args);
  assert.equal(diagnosis.eligible, true, JSON.stringify(diagnosis));
  assert.deepEqual(await tree(f.container), before, "diagnosis stays read-only");
  const priorBefore = await readAuthorizedReadOnly(f.data, "active", prior.session);
  assert.equal((await (f.store as any).repossessFailedBegin(await failedRecovery(f))).state, "revoked");
  assert.deepEqual(await readAuthorizedReadOnly(f.data, "active", prior.session), priorBefore);
});
test("failed Begin on an existing registered canonical target authenticates primary and checkout separately", async t => {
  const f = await canonicalRetainedFailedBeginFixture(t), { createBeginDiagnosticAdapter } = await import("../src/begin-diagnostic-adapter.js"), before = await tree(f.container);
  const diagnosis = await createBeginDiagnosticAdapter(f.data)({ ...f.args, intent_id: f.intent, session_id: "original-private-session" });
  assert.equal(diagnosis.diagnosis, "inspected"); assert.equal(diagnosis.project_root_matches, true);
  assert.equal(diagnosis.target_worktree_matches, true, JSON.stringify(diagnosis));
  assert.equal(diagnosis.stage, "lease_checkpointed"); assert.equal(diagnosis.observed_branch_checkout_outside_canonical, false);
  assert.deepEqual(await tree(f.container), before);
});
test("operator retires only the dirty canonical target's new reservation and preserves its completed owner", async t => {
  const f = await canonicalRetainedFailedBeginFixture(t), prior = await completedOwnerProjection(f), beforeTarget = await tree(f.target);
  const diagnosis = await (f.store as any).diagnoseFailedBegin(f.args);
  assert.equal(diagnosis.eligible, true, JSON.stringify(diagnosis));
  const receipt = await (f.store as any).repossessFailedBegin({ ...diagnosis.recovery.args, reason: "Retire only the verified failed Begin", user_authorization: "Repair Captain and continue" });
  assert.equal(receipt.state, "revoked"); assert.deepEqual(await tree(f.target), beforeTarget);
  assert.deepEqual(await readAuthorizedReadOnly(f.data, "active", prior.session), prior.projection);
  assert.equal((await readAuthorizedLeaseSnapshotReadOnly(f.data, f.leaseId))?.state, "released");
});
for (const variant of ["held-session", "pending-commit", "pending-mutation", "pending-review", "latest-running", "malformed", "wrong-projection-token"]) test(`completed task-owner recovery refuses ${variant}`, async t => {
  const f = await failedBeginFixture(t); await completedOwnerProjection(f, variant);
  const before = await tree(f.container), diagnosis = await (f.store as any).diagnoseFailedBegin(f.args);
  assert.equal(diagnosis.eligible, false); assert.deepEqual(await tree(f.container), before);
});


async function completedHistoryFixture(t: TestContext) {
  const f = await supersededMergeFixture(t, "ready", true, "source"), history: any[] = [];
  for (const [index, side] of (["source", "target"] as const).entries()) {
    const binding = side === "source" ? f.record.source_binding : f.record.target_binding;
    const normalized = { worktree: side === "source" ? f.source : f.target, session_id: f.mergeSession, task_id: "historical-records", paths: ["Churn/history.md"], subject: "docs(captain): retain historical records", disposition: side === "source" ? "commit" : "stash" };
    const receipt: any = { ...f.receipt, ...normalized, finalization_id: "historical-finalization-" + index, request_sha256: digest(normalized), before: binding, after: binding, state: side === "source" ? "committed" : "stashed" };
    if (side === "source") { delete receipt.stash_oid; receipt.commit_oid = binding.head; }
    await putAuthorizedOnceExact(f.data, "bookkeeping-revisions", receipt.finalization_id + "-0", receipt);
    await putAuthorizedOnceExact(f.data, "bookkeeping-watermarks", receipt.finalization_id + "-0", { finalization_id: receipt.finalization_id, revision: 0, sha256: digest(receipt) });
    history.push(receipt);
  }
  const record = { ...f.record, revision: f.record.revision + 1, previous_sha256: digest(f.record), finalizations: [...history, f.receipt] };
  await putAuthorizedOnceExact(f.data, "merge-revisions", f.mergeId + "-" + record.revision, record);
  await putAuthorizedOnceExact(f.data, "merge-watermarks", f.mergeId + "-" + record.revision, { merge_id: f.mergeId, revision: record.revision, sha256: digest(record) });
  return { ...f, record, history };
}

test("completed bookkeeping history permits recovery with three receipts and one current source request", async t => {
  const f = await completedHistoryFixture(t), source = await tree(f.source), target = await tree(f.target), records = await tree(f.data);
  const result = await f.store.diagnoseFailedBegin(f.args);
  assert.equal(result.eligible, true, JSON.stringify(result));
  assert.equal((await f.store.repossessFailedBegin(await failedRecovery(f))).state, "revoked");
  assert.deepEqual(await tree(f.source), source); assert.deepEqual(await tree(f.target), target);
  const after = await tree(f.data);
  for (const [name, value] of Object.entries(records)) if (/^(merge-|bookkeeping-)/.test(name)) assert.equal(after[name], value);
});

for (const variant of ["nonterminal-history", "stale-history", "foreign-session", "foreign-worktree", "foreign-binding", "foreign-policy", "duplicate-id", "missing-current", "wrong-current-head", "held-history-operation", "held-history-worktree-resource"] as const) test("completed bookkeeping history refuses " + variant, async t => {
  const f = await completedHistoryFixture(t), receipt: any = structuredClone(f.history[0]);
  let embedded = [...f.record.finalizations], requests = f.record.finalization_requests;
  if (variant === "nonterminal-history") receipt.state = "pending";
  if (variant === "stale-history") receipt.evidence = [{ kind: "later-terminal-evidence" }];
  if (variant === "foreign-session") receipt.session_id = "foreign-history-session";
  if (variant === "foreign-worktree") receipt.worktree = f.container;
  if (variant === "foreign-binding") receipt.before.branch = "foreign-history-branch";
  if (variant === "foreign-policy") { receipt.policy = { ...receipt.policy, foreign: true }; receipt.policy_sha256 = digest(receipt.policy); }
  if (["nonterminal-history", "stale-history", "foreign-session", "foreign-worktree", "foreign-binding", "foreign-policy"].includes(variant)) {
    await writeAuthorized(f.data, "bookkeeping-revisions", receipt.finalization_id + "-0", receipt);
    await writeAuthorized(f.data, "bookkeeping-watermarks", receipt.finalization_id + "-0", { finalization_id: receipt.finalization_id, revision: 0, sha256: digest(receipt) });
    if (variant !== "stale-history") embedded[0] = receipt;
  }
  if (variant === "duplicate-id") embedded.push(f.history[0]);
  if (variant === "missing-current") embedded = f.history;
  if (variant === "wrong-current-head") requests = { source: { ...requests.source, expected_head: await git(f.target, "rev-parse", "HEAD") } };
  if (variant.startsWith("held-history")) {
    const id = variant === "held-history-operation" ? createHash("sha256").update("bookkeeping-operation\0" + receipt.finalization_id).digest("hex") : createHash("sha256").update(("bookkeeping-worktree\0" + path.resolve(receipt.before.commonGitDir) + "\0" + path.resolve(receipt.before.gitDir)).toLowerCase()).digest("hex");
    await acquireAuthorizedLease(f.data, id, { intentId: receipt.finalization_id, leaseToken: "private-history-resource", operation: "bookkeeping", sessionId: f.mergeSession, ownerPid: process.pid, ownerHost: hostname() });
  }
  const record = { ...f.record, revision: f.record.revision + 1, previous_sha256: digest(f.record), finalizations: embedded, finalization_requests: requests };
  await putAuthorizedOnceExact(f.data, "merge-revisions", f.mergeId + "-" + record.revision, record);
  await putAuthorizedOnceExact(f.data, "merge-watermarks", f.mergeId + "-" + record.revision, { merge_id: f.mergeId, revision: record.revision, sha256: digest(record) });
  const before = await tree(f.container);
  assert.equal((await f.store.diagnoseFailedBegin(f.args)).eligible, false);
  assert.deepEqual(await tree(f.container), before);
});
