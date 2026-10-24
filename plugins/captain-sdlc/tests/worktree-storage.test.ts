import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { ensureWorktree, repositoryIdentity } from "../src/workspace.js";
import { putAuthorizedOnceExact } from "../src/authority.js";
import { LifecycleStore } from "../src/lifecycle.js";
import { captainBegin } from "../src/server.js";
const exec = promisify(execFile);
const git = async (cwd: string, ...args: string[]) => (await exec("git", args, { cwd, windowsHide: true })).stdout.trim();
const storage = () => import(new URL("../src/worktree-storage.js", import.meta.url).href);

async function fixture(t: TestContext) {
  const container = await mkdtemp(path.join(tmpdir(), "captain-storage-")), root = path.join(container, "primary"), data = path.join(container, "authority");
  t.after(async () => { assert.equal(path.dirname(container), path.resolve(tmpdir())); assert.ok(path.basename(container).startsWith("captain-storage-")); await rm(container, { recursive: true, force: true }); });
  await mkdir(root); await git(root, "init", "-b", "main"); await git(root, "config", "core.autocrlf", "false");
  await git(root, "config", "user.name", "Captain Test"); await git(root, "config", "user.email", "captain@example.invalid");
  await writeFile(path.join(root, ".gitignore"), ".captain-sdlc/worktrees/\n"); await writeFile(path.join(root, "source.txt"), "source\n");
  await git(root, "add", "."); await git(root, "commit", "-m", "fixture baseline");
  return { container, root, data, head: await git(root, "rev-parse", "HEAD"), common: path.resolve(await git(root, "rev-parse", "--path-format=absolute", "--git-common-dir")) };
}

test("a task started from a linked checkout retains that HEAD and uses the primary worktree container", async t => {
  const f = await fixture(t), first = await ensureWorktree(f.root, f.head, "first");
  await writeFile(path.join(first.worktreePath, "task.txt"), "task\n"); await git(first.worktreePath, "add", "task.txt"); await git(first.worktreePath, "commit", "-m", "task change");
  const taskHead = await git(first.worktreePath, "rev-parse", "HEAD"), identified = await repositoryIdentity(first.worktreePath);
  assert.equal(identified.projectRoot, first.worktreePath); assert.equal((identified as any).primaryProjectRoot, f.root); assert.equal(identified.baseHead, taskHead);
  const second = await ensureWorktree(first.worktreePath, taskHead, "second");
  assert.equal(second.worktreePath, path.join(f.root, ".captain-sdlc", "worktrees", "second"));
  assert.equal(await readFile(path.join(second.worktreePath, "task.txt"), "utf8"), "task\n");
});

test("only newly created worktrees receive signed automatic cleanup registration", async t => {
  const f = await fixture(t), fresh = await (ensureWorktree as any)(f.root, f.head, "fresh", undefined, f.common, f.data), api = await storage();
  const registration = await api.readWorktreeRegistration(f.data, f.common, fresh.worktreePath);
  assert.deepEqual(registration, { schema_version: 1, intent_id: "fresh", project_root: f.root, common_git_dir: f.common, worktree_path: fresh.worktreePath, branch: fresh.branch, git_dir: fresh.gitDir, base_head: f.head });
  const repeated = await (ensureWorktree as any)(f.root, f.head, "fresh", undefined, f.common, f.data);
  assert.equal(repeated.worktreePath, fresh.worktreePath); assert.deepEqual(await api.readWorktreeRegistration(f.data, f.common, fresh.worktreePath), registration);
  const legacy = await ensureWorktree(f.root, f.head, "legacy");
  await (ensureWorktree as any)(f.root, f.head, "legacy", undefined, f.common, f.data);
  assert.equal(await api.readWorktreeRegistration(f.data, f.common, legacy.worktreePath), undefined);
});

test("creation journal restores automatic cleanup registration after interruption without adopting unrelated work", async t => {
  const f = await fixture(t), api = await storage(), worktree = path.join(f.root, ".captain-sdlc", "worktrees", "interrupted");
  const creation = { schema_version: 1, intent_id: "interrupted", project_root: f.root, common_git_dir: f.common, worktree_path: worktree, branch: "captain/interrupted", base_head: f.head };
  await api.reserveWorktreeCreation(f.data, creation);
  await git(f.root, "worktree", "add", worktree, "-b", creation.branch, f.head);
  const recovered = await (ensureWorktree as any)(f.root, f.head, "interrupted", undefined, f.common, f.data);
  const registration = await api.readWorktreeRegistration(f.data, f.common, worktree);
  assert.equal(registration.git_dir, recovered.gitDir);
  await assert.rejects(() => api.reserveWorktreeCreation(f.data, { ...creation, branch: "captain/replacement" }), /checkpoint|registration|creation/i);
});

test("successor creation links only an exact registered parent HEAD", async t => {
  const f = await fixture(t), parent = await (ensureWorktree as any)(f.root, f.head, "parent", undefined, f.common, f.data), api = await storage();
  const child = await (ensureWorktree as any)(f.root, f.head, "child", undefined, f.common, f.data, parent.worktreePath);
  const registration = await api.readWorktreeRegistration(f.data, f.common, child.worktreePath);
  assert.deepEqual(registration.parent_worktree, { registration_id: api.storageRegistrationId(f.common, parent.worktreePath), worktree_path: parent.worktreePath, branch: parent.branch, git_dir: parent.gitDir, head: f.head });
  await writeFile(path.join(parent.worktreePath, "advance.txt"), "advanced\n"); await git(parent.worktreePath, "add", "advance.txt"); await git(parent.worktreePath, "commit", "-m", "advance parent");
  await assert.rejects(() => (ensureWorktree as any)(f.root, f.head, "stale-child", undefined, f.common, f.data, parent.worktreePath), /parent|HEAD|head/);
});

test("pre-add retry preserves its signed parent snapshot after the parent advances", async t => {
  const f = await fixture(t), parent = await ensureWorktree(f.root, f.head, "retry-parent", undefined, f.common, f.data), api = await storage();
  const worktree = path.join(f.root, ".captain-sdlc", "worktrees", "retry-child");
  const creation = { schema_version: 1, intent_id: "retry-child", project_root: f.root, common_git_dir: f.common, worktree_path: worktree, branch: "captain/retry-child", base_head: f.head,
    parent_worktree: { registration_id: api.storageRegistrationId(f.common, parent.worktreePath), worktree_path: parent.worktreePath, branch: parent.branch, git_dir: parent.gitDir, head: f.head } };
  await api.reserveWorktreeCreation(f.data, creation);
  await writeFile(path.join(parent.worktreePath, "later.txt"), "later parent\n"); await git(parent.worktreePath, "add", "later.txt"); await git(parent.worktreePath, "commit", "-m", "advance parent after reservation");
  const child = await ensureWorktree(f.root, f.head, "retry-child", undefined, f.common, f.data, parent.worktreePath);
  assert.equal(child.baseHead, f.head); assert.equal(await git(child.worktreePath, "rev-parse", "HEAD"), f.head);
  assert.deepEqual((await api.readWorktreeRegistration(f.data, f.common, worktree)).parent_worktree, creation.parent_worktree);
});

test("registry refuses tampered signatures rather than treating them as legacy worktrees", async t => {
  const f = await fixture(t), fresh = await (ensureWorktree as any)(f.root, f.head, "signed", undefined, f.common, f.data), api = await storage();
  const id = api.storageRegistrationId(f.common, fresh.worktreePath), file = path.join(f.data, "worktree-registrations", id + ".json");
  const value = JSON.parse(await readFile(file, "utf8")); value.payload.worktree_path = f.root;
  await writeFile(file, JSON.stringify(value));
  await assert.rejects(() => api.readWorktreeRegistration(f.data, f.common, fresh.worktreePath), /authority|tag|registration/);
});

test("creation registration refuses existing paths and destinations outside the primary container", async t => {
  const f = await fixture(t), api = await storage(), worktree = path.join(f.root, ".captain-sdlc", "worktrees", "registered");
  const creation = { schema_version: 1, intent_id: "registered", project_root: f.root, common_git_dir: f.common, worktree_path: worktree, branch: "captain/registered", base_head: f.head };
  await assert.rejects(() => api.reserveWorktreeCreation(f.data, { ...creation, worktree_path: f.root }), /canonical|container|worktree/i);
  await mkdir(worktree, { recursive: true }); await writeFile(path.join(worktree, "personal.txt"), "retain\n");
  await assert.rejects(() => api.reserveWorktreeCreation(f.data, creation), /already exists|existing/i);
  assert.equal(await readFile(path.join(worktree, "personal.txt"), "utf8"), "retain\n");
});

test("completed child status retains its user request after its invocation parent is removed", async t => {
  const f = await fixture(t), parent = await (ensureWorktree as any)(f.root, f.head, "status-parent", undefined, f.common, f.data);
  const child = await (ensureWorktree as any)(parent.worktreePath, f.head, "status-child", undefined, f.common, f.data, parent.worktreePath);
  const store = new LifecycleStore(f.data, async () => ({ exitCode: 0, stdout: "", stderr: "" }));
  await store.recordUserRequest({ projectRoot: parent.worktreePath, sessionId: "storage-status", turnId: "child", sourceIntentId: "status-child", intentId: "status-child", source: "client-adapter", prompt: "Implement the bounded child task" });
  const run = { schemaVersion: 1, revision: 0, runId: "status-child-run", operationToken: "status-child-operation", intentId: "status-child", sessionId: "storage-status", turnId: "child", objective: "bounded child task", projectRoot: parent.worktreePath, worktreePath: child.worktreePath, baseHead: f.head, branch: child.branch, commonGitDir: f.common, gitDir: child.gitDir, profile: "low", visualRequired: false, startedAt: "2026-10-24T00:00:00.000Z", phase: "complete", status: "green", policy: { profile: "low", visualRequired: false, commands: { build: "build" } }, evidence: [] };
  await putAuthorizedOnceExact(f.data, "run-revisions", "status-child-0", run);
  assert.equal((await store.status("status-child")).user_request?.status, "expressed");
  await git(f.root, "worktree", "remove", parent.worktreePath);
  const status = await store.status("status-child");
  assert.equal(status.user_request?.status, "expressed"); assert.equal(status.projectRoot, parent.worktreePath);
});

test("Begin from a registered linked checkout preserves signed invocation identity and checkpoints the primary container", async t => {
  const f = await fixture(t), parent = await (ensureWorktree as any)(f.root, f.head, "begin-parent", undefined, f.common, f.data);
  const store = new LifecycleStore(f.data, async () => ({ exitCode: 0, stdout: "", stderr: "" }));
  await store.markIntent({ intentId: "begin-child", sessionId: "storage-begin", turnId: "child", projectRoot: parent.worktreePath, prompt: "Implement the child" });
  const run = await captainBegin(store, { intent_id: "begin-child", project_root: parent.worktreePath, objective: "bounded child" }, { repositoryIdentity, ensureWorktree, storageDataRoot: f.data, loadPolicy: async () => ({ profile: "low", visualRequired: false, commands: { build: "build", ticket: "ticket" } }) });
  assert.equal(run.projectRoot, parent.worktreePath); assert.equal(run.worktreePath, path.join(f.root, ".captain-sdlc", "worktrees", "begin-child"));
  const registration = await (await storage()).readWorktreeRegistration(f.data, f.common, run.worktreePath);
  assert.equal(registration.project_root, f.root); assert.equal(registration.parent_worktree.worktree_path, parent.worktreePath);
});
