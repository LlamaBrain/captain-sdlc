import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { acquireAuthorizedLease, releaseAuthorizedLease, writeAuthorized } from "../src/authority.js";

const exec = promisify(execFile);
const runGit = async (cwd: string, ...args: string[]) => (await exec("git", args, { cwd, windowsHide: true })).stdout.trim();
async function put(root: string, relative: string, content: string) { await mkdir(path.dirname(path.join(root, relative)), { recursive: true }); await writeFile(path.join(root, relative), content); }
async function fixture(t: TestContext, optedIn = true) {
  const root = await mkdtemp(path.join(tmpdir(), "captain-finalization-")), dataRoot = path.join(root, "authority");
  t.after(async () => { assert.equal(path.dirname(root), path.resolve(tmpdir())); assert.ok(path.basename(root).startsWith("captain-finalization-")); await rm(root, { recursive: true, force: true }); });
  await runGit(root, "init", "-b", "main"); await runGit(root, "config", "user.name", "Captain Test"); await runGit(root, "config", "user.email", "captain@example.invalid"); await runGit(root, "config", "core.autocrlf", "false");
  await put(root, ".gitignore", "/authority/\n");
  await put(root, ".captain-sdlc/codex-policy.json", JSON.stringify({ profile: "low", visualRequired: false, commands: { build: "build", ticket: "ticket", "feature-smoke": "smoke", "affected-regression": "affected" }, commit: { conventional: true, require_version_suffix: true, require_task_trailer: true, version_file: "VERSION", version_surfaces: [{ path: "VERSION", pattern: "(?m)^(?<version>[0-9]+\\.[0-9]+\\.[0-9]+)\\s*$" }], changelog_files: ["CHANGELOG.md"], ...(optedIn ? { bookkeeping: { path_file: ".captain-sdlc/captain.ignore" } } : {}) } }));
  await put(root, ".captain-sdlc/captain.ignore", "/.captain-sdlc/notebook/\n/.captain-sdlc/handoffs/\n/Churn/\n");
  await put(root, ".captain-sdlc/notebook/notes.json", "{\"notes\":[]}\n"); await put(root, "VERSION", "1.0.0\n"); await put(root, "CHANGELOG.md", "# Changelog\n"); await put(root, "code.ts", "export const value = 1;\n");
  await runGit(root, "add", "."); await runGit(root, "commit", "-m", "baseline");
  const head = await runGit(root, "rev-parse", "HEAD");
  const modulePath = "../src/bookkeeping-finalization.js", module = await import(modulePath);
  assert.equal(typeof module.BookkeepingFinalizationStore, "function", "supported finalization store must exist");
  return { root, dataRoot, head, Store: module.BookkeepingFinalizationStore as any };
}
function request(root: string, disposition: "commit" | "stash" = "commit", finalization_id?: string) { return { worktree: root, session_id: "session-a", task_id: "TASK", paths: [".captain-sdlc/notebook/notes.json", "Churn/incident.md"], subject: "docs(captain): retain finalization records", disposition, ...(finalization_id ? { finalization_id } : {}) }; }
async function dirty(root: string) { await put(root, ".captain-sdlc/notebook/notes.json", "{\"notes\":[\"preserved\"]}\n"); await put(root, "Churn/incident.md", "Observed merge bookkeeping churn.\n"); }

test("supported bookkeeping commit signs exact independent receipt without product version churn", async t => {
  const f = await fixture(t); await dirty(f.root);
  const completed = { intentId: "old-task", phase: "complete", status: "green", worktreePath: f.root, proof: "unchanged" };
  await writeAuthorized(f.dataRoot, "runs", "old-task", completed); const oldBytes = await readFile(path.join(f.dataRoot, "runs/old-task.json"));
  const store = new f.Store(f.dataRoot), receipt = await store.finalize(request(f.root));
  assert.equal(receipt.state, "committed"); assert.equal(receipt.before.head, f.head); assert.equal(receipt.after.head, await runGit(f.root, "rev-parse", "HEAD")); assert.notEqual(receipt.after.head, f.head);
  assert.equal(receipt.commit_oid, receipt.after.head); assert.equal(receipt.before.branch, "main"); assert.equal(receipt.after.branch, "main");
  assert.equal(await runGit(f.root, "status", "--porcelain"), ""); assert.equal(await readFile(path.join(f.root, "VERSION"), "utf8"), "1.0.0\n"); assert.equal(await readFile(path.join(f.root, "CHANGELOG.md"), "utf8"), "# Changelog\n");
  assert.match(await runGit(f.root, "show", "-s", "--format=%B", "HEAD"), /Completes: TASK/); assert.equal(receipt.snapshot.length, 2); assert.match(receipt.policy.commit.bookkeeping.sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(await readFile(path.join(f.dataRoot, "runs/old-task.json")), oldBytes, "original completed lifecycle/proof is immutable");
  assert.equal((await store.status({ finalization_id: receipt.finalization_id, session_id: "session-a", worktree: f.root })).state, "committed");
});

test("supported stash parks allowed tracked and untracked records and retains exact immutable stash", async t => {
  const f = await fixture(t); await dirty(f.root); const content = await readFile(path.join(f.root, "Churn/incident.md"), "utf8");
  const store = new f.Store(f.dataRoot), receipt = await store.finalize(request(f.root, "stash"));
  assert.equal(receipt.state, "stashed"); assert.equal(receipt.before.head, f.head); assert.equal(receipt.after.head, f.head); assert.match(receipt.stash_oid, /^[0-9a-f]{40,64}$/); assert.equal(await runGit(f.root, "rev-parse", "refs/stash"), receipt.stash_oid); assert.equal(await runGit(f.root, "status", "--porcelain"), "");
  assert.equal(await runGit(f.root, "show", `${receipt.stash_oid}^3:Churn/incident.md`), content.trim()); assert.match(await runGit(f.root, "show", "-s", "--format=%s", receipt.stash_oid), new RegExp(receipt.finalization_id));
  const retry = await store.finalize(request(f.root, "stash", receipt.finalization_id)); assert.equal(retry.stash_oid, receipt.stash_oid); assert.equal((await runGit(f.root, "stash", "list")).split("\n").length, 1);
});

test("finalization refuses mixed dirty work and out-of-selection index before mutation", async t => {
  const f = await fixture(t); await dirty(f.root); await put(f.root, "code.ts", "export const value = 2;\n");
  const store = new f.Store(f.dataRoot); await assert.rejects(() => store.finalize(request(f.root)), /bookkeeping|dirty|selection|path/i); assert.equal(await runGit(f.root, "rev-parse", "HEAD"), f.head);
  await runGit(f.root, "add", "code.ts"); await assert.rejects(() => store.finalize(request(f.root, "stash")), /bookkeeping|dirty|selection|path/i); assert.equal(await runGit(f.root, "diff", "--cached", "--name-only"), "code.ts");
});

test("finalization refuses absent opt-in, forbidden subject, and changed ignore policy", async t => {
  const f = await fixture(t, false); await dirty(f.root); await assert.rejects(() => new f.Store(f.dataRoot).finalize(request(f.root)), /bookkeeping|opt|policy/i);
  const opted = await fixture(t); await dirty(opted.root); const store = new opted.Store(opted.dataRoot);
  await assert.rejects(() => store.finalize({ ...request(opted.root), subject: "fix(captain): retain records" }), /subject|bookkeeping/i);
  await put(opted.root, ".captain-sdlc/captain.ignore", "**\n"); await assert.rejects(() => store.finalize(request(opted.root)), /bookkeeping|dirty|path|selection/i); assert.equal(await runGit(opted.root, "rev-parse", "HEAD"), opted.head);
});

test("finalization refuses foreign active branch lease without releasing or editing it", async t => {
  const f = await fixture(t); await dirty(f.root); const common = await runGit(f.root, "rev-parse", "--path-format=absolute", "--git-common-dir"), leaseId = createHash("sha256").update(`${path.resolve(common)}\0refs/heads/main`.toLowerCase()).digest("hex");
  await acquireAuthorizedLease(f.dataRoot, leaseId, { intentId: "foreign-intent", leaseToken: "foreign-generation", sessionId: "foreign-session", commonGitDir: common, targetBranch: "main" });
  const bytes = await readFile(path.join(f.dataRoot, "lease-revisions", `${leaseId}-0.json`));
  await assert.rejects(() => new f.Store(f.dataRoot).finalize(request(f.root)), /lease|owner|active/i); assert.equal(await runGit(f.root, "rev-parse", "HEAD"), f.head); assert.deepEqual(await readFile(path.join(f.dataRoot, "lease-revisions", `${leaseId}-0.json`)), bytes);
});

test("finalization exact-id retry is idempotent and session or changed request cannot adopt it", async t => {
  const f = await fixture(t); await dirty(f.root); const store = new f.Store(f.dataRoot), receipt = await store.finalize(request(f.root, "commit", "finalization-fixed")), committed = receipt.after.head;
  const retry = await store.finalize(request(f.root, "commit", "finalization-fixed")); assert.equal(retry.after.head, committed); assert.equal(await runGit(f.root, "rev-list", "--count", `${f.head}..HEAD`), "1");
  await assert.rejects(() => store.finalize({ ...request(f.root, "commit", "finalization-fixed"), subject: "docs(captain): changed request" }), /request|match|binding/i);
  await assert.rejects(() => store.status({ finalization_id: receipt.finalization_id, session_id: "session-b" }), /session|owner/i);
});

test("commit interruption after ref update recovers same signed candidate without duplicate commit", async t => {
  const f = await fixture(t); await dirty(f.root); let interrupted = false;
  const failing = new f.Store(f.dataRoot, { afterCommitRefUpdate: async () => { if (!interrupted) { interrupted = true; throw new Error("injected interruption"); } } });
  await assert.rejects(() => failing.finalize(request(f.root, "commit", "finalization-interrupted")), /injected interruption/);
  const candidate = await runGit(f.root, "rev-parse", "HEAD"); assert.notEqual(candidate, f.head);
  const recovered = await new f.Store(f.dataRoot).finalize(request(f.root, "commit", "finalization-interrupted")); assert.equal(recovered.state, "committed"); assert.equal(recovered.after.head, candidate); assert.equal(await runGit(f.root, "rev-list", "--count", `${f.head}..HEAD`), "1"); assert.equal(await runGit(f.root, "status", "--porcelain"), "");
});

test("stash interruption recovers immutable marker and never creates duplicate parked data", async t => {
  const f = await fixture(t); await dirty(f.root);
  const failing = new f.Store(f.dataRoot, { afterStash: async () => { throw new Error("injected stash interruption"); } });
  await assert.rejects(() => failing.finalize(request(f.root, "stash", "finalization-stash-interrupted")), /injected stash interruption/); const parked = await runGit(f.root, "rev-parse", "refs/stash");
  const recovered = await new f.Store(f.dataRoot).finalize(request(f.root, "stash", "finalization-stash-interrupted")); assert.equal(recovered.stash_oid, parked); assert.equal((await runGit(f.root, "stash", "list")).split("\n").length, 1);
});

test("internal recorded binding refuses another branch at identical HEAD before mutation", async t => {
  const f = await fixture(t); await dirty(f.root);
  const expected_binding = { branch: "main", commonGitDir: await runGit(f.root, "rev-parse", "--path-format=absolute", "--git-common-dir"), gitDir: await runGit(f.root, "rev-parse", "--path-format=absolute", "--git-dir"), topLevel: f.root };
  await runGit(f.root, "switch", "-c", "other-at-same-head");
  await assert.rejects(() => new f.Store(f.dataRoot).finalize(request(f.root), { expected_head: f.head, expected_binding }), /branch|binding/);
  assert.equal(await runGit(f.root, "rev-parse", "HEAD"), f.head); assert.equal(await runGit(f.root, "symbolic-ref", "--short", "HEAD"), "other-at-same-head");
});

test("read-only started probe distinguishes absent finalization from missing signed checkpoints", async t => {
  const f = await fixture(t), store = new f.Store(f.dataRoot), selector = { finalization_id: "finalization-probe", session_id: "session-a", worktree: f.root };
  assert.equal(await store.hasStarted(selector), false); await assert.rejects(() => readFile(path.join(f.dataRoot, "authority.key")), { code: "ENOENT" });
  await dirty(f.root); const result = await store.finalize(request(f.root, "commit", selector.finalization_id)); assert.equal(await store.hasStarted(selector), true);
  await unlink(path.join(f.dataRoot, "bookkeeping-watermarks", `${selector.finalization_id}-${result.revision}.json`));
  await assert.rejects(() => store.hasStarted(selector), /ENOENT|watermark|checkpoint/); await assert.rejects(() => store.finalize(request(f.root, "commit", selector.finalization_id)), /ENOENT|watermark|checkpoint/);
});

test("standalone finalization refuses an active lifecycle owner even in its caller session", async t => {
  const f = await fixture(t); await dirty(f.root);
  await writeAuthorized(f.dataRoot, "runs", "active-owner", { intentId: "active-owner", sessionId: "session-a", phase: "implement", status: "running", worktreePath: f.root });
  await assert.rejects(() => new f.Store(f.dataRoot).finalize(request(f.root)), /active.*owner|captain_commit/); assert.equal(await runGit(f.root, "rev-parse", "HEAD"), f.head);
});

test("stash uses the same bounded text and index-mode ceiling as commit proof", async t => {
  for (const content of ["x".repeat(1024 * 1024 + 1), "invalid\x01control\n", "binary\0data\n"]) {
    const f = await fixture(t); await dirty(f.root); await put(f.root, ".captain-sdlc/notebook/notes.json", content);
    await assert.rejects(() => new f.Store(f.dataRoot).finalize(request(f.root, "stash")), /text|bound|binary/); assert.equal(await runGit(f.root, "stash", "list"), ""); assert.equal(await runGit(f.root, "rev-parse", "HEAD"), f.head);
  }
  const f = await fixture(t); await dirty(f.root); await runGit(f.root, "add", ".captain-sdlc/notebook/notes.json"); await runGit(f.root, "update-index", "--chmod=+x", ".captain-sdlc/notebook/notes.json");
  await assert.rejects(() => new f.Store(f.dataRoot).finalize(request(f.root, "stash")), /mode|execut/); assert.equal(await runGit(f.root, "stash", "list"), "");
});

test("stash retains staged-only bookkeeping content through its exact index snapshot", async t => {
  const f = await fixture(t); await dirty(f.root); await runGit(f.root, "add", ".captain-sdlc/notebook/notes.json");
  await put(f.root, ".captain-sdlc/notebook/notes.json", "{\"notes\":[]}\n");
  const receipt = await new f.Store(f.dataRoot).finalize(request(f.root, "stash"));
  assert.equal(receipt.state, "stashed"); assert.equal(await runGit(f.root, "show", `${receipt.stash_oid}^2:.captain-sdlc/notebook/notes.json`), "{\"notes\":[\"preserved\"]}"); assert.equal(await runGit(f.root, "status", "--porcelain"), "");
});

test("started probe preserves held pre-journal operation ownership and permits released preflight replacement", async t => {
  const f = await fixture(t), store = new f.Store(f.dataRoot), finalization_id = "finalization-prejournal", selector = { finalization_id, session_id: "session-a", worktree: f.root }, leaseId = createHash("sha256").update(`bookkeeping-operation\0${finalization_id}`).digest("hex");
  await acquireAuthorizedLease(f.dataRoot, leaseId, { intentId: finalization_id, leaseToken: "operation-token", sessionId: "session-a", operation: "bookkeeping-attempt", ownerPid: process.pid, ownerHost: "fixture-host" });
  assert.equal(await store.hasStarted(selector), true, "a held authenticated operation already protects the immutable request before its first journal");
  await assert.rejects(() => store.hasStarted({ ...selector, session_id: "session-b" }), /session|owner/);
  await releaseAuthorizedLease(f.dataRoot, leaseId, finalization_id, "operation-token");
  assert.equal(await store.hasStarted(selector), false, "a released preflight rejection has no mutation journal to retain");
  await acquireAuthorizedLease(f.dataRoot, leaseId, { intentId: "foreign-finalization", leaseToken: "foreign-token", sessionId: "session-a", operation: "bookkeeping-attempt", ownerPid: process.pid, ownerHost: "fixture-host" });
  await assert.rejects(() => store.hasStarted(selector), /owner|binding|operation/);
});
