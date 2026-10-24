import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { acquireAuthorizedLease, putAuthorizedOnceExact, readAuthorizedLease, readAuthorizedLeaseSnapshotReadOnly, releaseAuthorizedLease } from "../src/authority.js";
import { cleanupRegisteredWorktrees, readWorktreeCleanupCompletion } from "../src/worktree-cleanup.js";
import { readWorktreeRegistration, storageRegistrationId } from "../src/worktree-storage.js";
import { ensureWorktree } from "../src/workspace.js";
const exec = promisify(execFile);
const git = async (cwd: string, ...args: string[]) => (await exec("git", args, { cwd, windowsHide: true })).stdout.trim();
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const exists = (file: string) => access(file).then(() => true, () => false);

async function fixture(t: TestContext, report = false) {
  const container = await mkdtemp(path.join(tmpdir(), "captain-cleanup-safety-")), target = path.join(container, "project"), data = path.join(container, "authority");
  t.after(async () => { assert.equal(path.dirname(container), path.resolve(tmpdir())); assert.ok(path.basename(container).startsWith("captain-cleanup-safety-")); await rm(container, { recursive: true, force: true }); });
  await mkdir(target); await git(target, "init", "-b", "main"); await git(target, "config", "core.autocrlf", "false");
  await git(target, "config", "user.name", "Captain Test"); await git(target, "config", "user.email", "captain@example.invalid");
  await writeFile(path.join(target, ".gitignore"), ".captain-sdlc/worktrees/\nBuilds/\nArtifacts/\n.proof/\n.env\nout/\noutput/\ntarget/\npublish/\ngenerated/\n/ Builds/\n"); await writeFile(path.join(target, "source.txt"), "base\n");
  await git(target, "add", "."); await git(target, "commit", "-m", "baseline");
  const created = await ensureWorktree(target, await git(target, "rev-parse", "HEAD"), "candidate", undefined, undefined, data), source = created.worktreePath;
  await writeFile(path.join(source, "task.txt"), "task\n"); await git(source, "add", "task.txt"); await git(source, "commit", "-m", "task change");
  await git(target, "merge", "--ff-only", created.branch);
  const registration = (await readWorktreeRegistration(data, created.commonGitDir, source))!, head = await git(source, "rev-parse", "HEAD");
  assert.ok(registration);
  if (report) { await mkdir(path.join(source, "Artifacts")); await writeFile(path.join(source, "Artifacts/report.json"), "{\"passed\":true}\n"); }
  const candidate = { registration, head, evidencePaths: report ? ["Artifacts/report.json"] : [] }, id = hash(`${storageRegistrationId(created.commonGitDir, source)}\0${head}`);
  return { container, target, data, source, registration, head, candidate, id, archive: path.join(data, "worktree-evidence", id, "Artifacts/report.json"), completion: path.join(data, "worktree-cleanup-completions", id + ".json") };
}

for (const kind of ["tracked", "untracked"] as const) test(`cleanup preserves ${kind} dirty work`, async t => {
  const f = await fixture(t), file = path.join(f.source, kind === "tracked" ? "source.txt" : "untracked.txt");
  await writeFile(file, "preserve this change\n");
  const result = await cleanupRegisteredWorktrees(f.data, f.target, [f.candidate]);
  assert.deepEqual(result.removed_worktrees, []); assert.match(result.retained_worktrees[0].reason, /clean|dirty|untracked/i);
  assert.equal(await readFile(file, "utf8"), "preserve this change\n");
});

test("cleanup preserves unknown ignored user files", async t => {
  const f = await fixture(t), file = path.join(f.source, ".env"); await writeFile(file, "LOCAL_ONLY=preserve\n");
  const result = await cleanupRegisteredWorktrees(f.data, f.target, [f.candidate]);
  assert.deepEqual(result.removed_worktrees, []); assert.match(result.retained_worktrees[0].reason, /ignored|preserv/i);
  assert.equal(await readFile(file, "utf8"), "LOCAL_ONLY=preserve\n");
});

test("ignored paths with leading whitespace cannot alias a generated directory", async t => {
  const f = await fixture(t), directory = path.join(f.source, " Builds");
  await mkdir(directory); const file = path.join(directory, "private.txt");
  await writeFile(file, "preserve exact filename\n");
  assert.equal(await git(f.source, "status", "--porcelain"), "");
  const result = await cleanupRegisteredWorktrees(f.data, f.target, [f.candidate]);
  assert.deepEqual(result.removed_worktrees, []);
  assert.equal(await readFile(file, "utf8"), "preserve exact filename\n");
});

test("cleanup retires only explicit generic output roots and preserves unclassified siblings", async t => {
  const f = await fixture(t);
  for (const name of ["out", "output", "target", "publish", "generated"]) {
    await mkdir(path.join(f.source, name, "active"), { recursive: true });
    await writeFile(path.join(f.source, name, "active/payload.bin"), "disposable generic payload");
  }
  const privateFile = path.join(f.source, "target", "private.txt");
  await writeFile(privateFile, "preserve unclassified ignored data\n");
  const selected = { ...f.candidate, outputRoots: ["out/active", "output/active", "target/active", "publish/active", "generated/active"] };
  const retained = await cleanupRegisteredWorktrees(f.data, f.target, [selected]);
  assert.deepEqual(retained.removed_worktrees, []);
  assert.equal(await readFile(privateFile, "utf8"), "preserve unclassified ignored data\n");
  await unlink(privateFile);
  const result = await cleanupRegisteredWorktrees(f.data, f.target, [selected]);
  assert.deepEqual(result.removed_worktrees, [f.source]);
  assert.deepEqual(result.retained_worktrees, []);
});

test("selected proof inside a custom ignored directory preserves unrelated siblings", async t => {
  const f = await fixture(t), directory = path.join(f.source, ".proof");
  await mkdir(directory); await writeFile(path.join(directory, "report.json"), "{\"passed\":true}\n");
  await writeFile(path.join(directory, "private.txt"), "keep unrelated notes\n");
  const selected = { ...f.candidate, evidencePaths: [".proof/report.json"] };
  const retained = await cleanupRegisteredWorktrees(f.data, f.target, [selected]);
  assert.deepEqual(retained.removed_worktrees, []);
  assert.equal(await readFile(path.join(directory, "private.txt"), "utf8"), "keep unrelated notes\n");
  await unlink(path.join(directory, "private.txt"));
  const cleaned = await cleanupRegisteredWorktrees(f.data, f.target, [selected]);
  assert.deepEqual(cleaned.removed_worktrees, [f.source]);
  assert.equal(await readFile(path.join(f.data, "worktree-evidence", f.id, ".proof/report.json"), "utf8"), "{\"passed\":true}\n");
});

test("cleanup refuses mixed-case nested Git metadata inside ignored generated output", async t => {
  const f = await fixture(t), nested = path.join(f.source, "Builds", "cache", ".GIT"); await mkdir(nested, { recursive: true }); await writeFile(path.join(nested, "HEAD"), "ref: refs/heads/private\n");
  const result = await cleanupRegisteredWorktrees(f.data, f.target, [f.candidate]);
  assert.deepEqual(result.removed_worktrees, []); assert.match(result.retained_worktrees[0].reason, /nested.*repository/i);
  assert.equal(await readFile(path.join(nested, "HEAD"), "utf8"), "ref: refs/heads/private\n");
});

test("cleanup refuses a generated-directory junction to another checkout or directory", async t => {
  const f = await fixture(t), outside = path.join(f.container, "outside"), linked = path.join(f.source, "Builds", "linked");
  await mkdir(outside); await writeFile(path.join(outside, "retain.txt"), "outside\n"); await mkdir(path.dirname(linked), { recursive: true });
  try { await symlink(outside, linked, process.platform === "win32" ? "junction" : "dir"); }
  catch (error: any) { if (["EPERM", "EACCES"].includes(error.code)) { t.skip("This host cannot create a junction/symlink fixture"); return; } throw error; }
  const result = await cleanupRegisteredWorktrees(f.data, f.target, [f.candidate]);
  assert.deepEqual(result.removed_worktrees, []); assert.match(result.retained_worktrees[0].reason, /reparse|symlink/i);
  assert.equal(await readFile(path.join(outside, "retain.txt"), "utf8"), "outside\n");
});

test("cleanup refuses a missing explicitly requested report before deleting the checkout", async t => {
  const f = await fixture(t), result = await cleanupRegisteredWorktrees(f.data, f.target, [{ ...f.candidate, evidencePaths: ["Artifacts/missing.json"] }]);
  assert.deepEqual(result.removed_worktrees, []); assert.match(result.retained_worktrees[0].reason, /missing|ENOENT|report/i);
  assert.equal(await exists(f.source), true); assert.equal(await exists(f.completion), false);
});

test("cleanup archive tampering invalidates its signed completion", async t => {
  const f = await fixture(t, true), result = await cleanupRegisteredWorktrees(f.data, f.target, [f.candidate]);
  assert.deepEqual(result.removed_worktrees, [f.source]); await writeFile(f.archive, "tampered\n");
  await assert.rejects(() => readWorktreeCleanupCompletion(f.data, f.registration, f.head), /archive.*changed/i);
});

test("missing-checkout retry completes only after authenticating its retained archive", async t => {
  const f = await fixture(t, true), first = await cleanupRegisteredWorktrees(f.data, f.target, [f.candidate]);
  assert.deepEqual(first.removed_worktrees, [f.source]); await unlink(f.completion);
  const recovered = await cleanupRegisteredWorktrees(f.data, f.target, [f.candidate]);
  assert.deepEqual(recovered.removed_worktrees, [f.source]); assert.ok(await readWorktreeCleanupCompletion(f.data, f.registration, f.head));
  await unlink(f.completion); await writeFile(f.archive, "corrupted after interruption\n");
  const invalid = await cleanupRegisteredWorktrees(f.data, f.target, [f.candidate]);
  assert.deepEqual(invalid.removed_worktrees, []); assert.match(invalid.retained_worktrees[0].reason, /archive.*changed/i);
  assert.equal(await exists(f.completion), false, "an invalid archive cannot publish a terminal receipt");
});

async function stoppedPid() {
  const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore", windowsHide: true });
  const pid = child.pid!; await once(child, "exit"); return pid;
}
for (const live of [false, true]) test(`cleanup ${live ? "preserves an active" : "recovers its positively stopped"} exact journal-owned lease`, async t => {
  const f = await fixture(t), pid = live ? process.pid : await stoppedPid();
  const leaseId = hash(`${path.resolve(f.registration.common_git_dir)}\0refs/heads/${f.registration.branch}`.toLowerCase());
  await putAuthorizedOnceExact(f.data, "worktree-cleanup-attempts", f.id, { schema_version: 1, cleanup_id: f.id, registration: f.registration, head: f.head });
  await acquireAuthorizedLease(f.data, leaseId, { intentId: f.id, leaseToken: "interrupted-generation", operation: "worktree-cleanup", ownerPid: pid, ownerHost: hostname() });
  const result = await cleanupRegisteredWorktrees(f.data, f.target, [f.candidate]);
  if (live) {
    assert.deepEqual(result.removed_worktrees, []); assert.match(result.retained_worktrees[0].reason, /active|stopped/i);
    assert.equal((await readAuthorizedLease(f.data, leaseId)).leaseToken, "interrupted-generation");
    await releaseAuthorizedLease(f.data, leaseId, f.id, "interrupted-generation");
  } else {
    assert.deepEqual(result.removed_worktrees, [f.source]);
    const state = await readAuthorizedLeaseSnapshotReadOnly(f.data, leaseId); assert.equal(state?.state, "released"); assert.notEqual(state?.payload.leaseToken, "interrupted-generation");
  }
});

for (const ownership of ["reserved", "attempt"] as const) test(`cleanup preserves unfinished Begin ${ownership} before a Run exists`, async t => {
  const f = await fixture(t), intentId = f.registration.intent_id;
  if (ownership === "reserved") await putAuthorizedOnceExact(f.data, "begin-operations", intentId, { schemaVersion: 1, intentId, operationToken: "unfinished-operation", leaseToken: "unfinished-begin", runId: "unfinished-run", startedAt: "2026-10-24T00:00:00.000Z", sessionId: "unfinished-session", turnId: "begin", projectRoot: f.target, objective: "unfinished setup" });
  else await acquireAuthorizedLease(f.data, `begin-attempt-${hash(intentId)}`, { intentId, leaseToken: "active-begin-attempt", operation: "begin-attempt" });
  const result = await cleanupRegisteredWorktrees(f.data, f.target, [f.candidate]);
  assert.deepEqual(result.removed_worktrees, []); assert.match(result.retained_worktrees[0].reason, /Begin|creation attempt/i); assert.equal(await exists(f.source), true);
});

test("retry cannot manufacture the missing cleanup journal needed to recover a stopped lease", async t => {
  const f = await fixture(t), pid = await stoppedPid(), leaseId = hash(`${path.resolve(f.registration.common_git_dir)}\0refs/heads/${f.registration.branch}`.toLowerCase());
  await acquireAuthorizedLease(f.data, leaseId, { intentId: f.id, leaseToken: "without-original-journal", operation: "worktree-cleanup", ownerPid: pid, ownerHost: hostname() });
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await cleanupRegisteredWorktrees(f.data, f.target, [f.candidate]);
    assert.deepEqual(result.removed_worktrees, []); assert.equal(await exists(f.source), true);
    assert.equal((await readAuthorizedLease(f.data, leaseId)).leaseToken, "without-original-journal");
  }
  await releaseAuthorizedLease(f.data, leaseId, f.id, "without-original-journal");
});

test("cleanup waits for a green run's interrupted session ownership release", async t => {
  const f = await fixture(t), intentId = f.registration.intent_id, sessionId = "terminal-session", leaseId = hash(`session-active\0${sessionId}`), token = "terminal-held";
  const run = { schemaVersion: 1, revision: 0, runId: "terminal-run", operationToken: token, intentId, sessionId, turnId: "terminal", objective: "completed task awaiting ownership release", projectRoot: f.target, worktreePath: f.source, baseHead: f.registration.base_head, branch: f.registration.branch, commonGitDir: f.registration.common_git_dir, gitDir: f.registration.git_dir, sessionLeaseId: leaseId, sessionLeaseToken: token, profile: "low", visualRequired: false, startedAt: "2026-10-24T00:00:00.000Z", phase: "complete", status: "green", policy: { profile: "low", visualRequired: false, commands: { build: "build" } }, evidence: [] };
  await putAuthorizedOnceExact(f.data, "run-revisions", `${intentId}-0`, run);
  await acquireAuthorizedLease(f.data, leaseId, { intentId, leaseToken: token, operationToken: token, runId: run.runId, sessionId, operation: "session-active" });
  const held = await cleanupRegisteredWorktrees(f.data, f.target, [f.candidate]);
  assert.deepEqual(held.removed_worktrees, []); assert.match(held.retained_worktrees[0].reason, /session|ownership|authority/i);
  assert.equal(await exists(f.source), true); assert.equal((await readAuthorizedLease(f.data, leaseId)).leaseToken, token);
  await releaseAuthorizedLease(f.data, leaseId, intentId, token);
  assert.deepEqual((await cleanupRegisteredWorktrees(f.data, f.target, [f.candidate])).removed_worktrees, [f.source]);
});

test("cleanup preserves clean checkouts with an unfinished merge or an index lock", async t => {
  const f = await fixture(t);
  for (const marker of ["MERGE_HEAD", "index.lock"]) {
    const file = path.join(f.registration.git_dir, marker); await writeFile(file, marker === "MERGE_HEAD" ? f.head + "\n" : "");
    assert.equal(await git(f.source, "status", "--porcelain"), "", "pending Git metadata can coexist with clean tracked and untracked files");
    const result = await cleanupRegisteredWorktrees(f.data, f.target, [f.candidate]);
    assert.deepEqual(result.removed_worktrees, []); assert.match(result.retained_worktrees[0].reason, /Git|merge|lock|operation/i);
    assert.equal(await exists(f.source), true); assert.equal(await exists(file), true);
    await unlink(file);
  }
  assert.deepEqual((await cleanupRegisteredWorktrees(f.data, f.target, [f.candidate])).removed_worktrees, [f.source]);
});
