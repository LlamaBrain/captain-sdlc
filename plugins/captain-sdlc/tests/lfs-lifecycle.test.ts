import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import { MergeWorkflowStore } from "../src/merge-workflow.js";
import { ensureWorktree, repositoryIdentity, sourceState } from "../src/workspace.js";

const exec = promisify(execFile);
const fixtureEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null", GIT_TERMINAL_PROMPT: "0" };
for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_CONFIG_COUNT", "GIT_CONFIG_PARAMETERS", "GIT_LFS_SKIP_SMUDGE"]) delete fixtureEnv[name];
const git = async (cwd: string, ...args: string[]) => (await exec("git", args, { cwd, env: fixtureEnv, windowsHide: true })).stdout.trim();
const ok = { exitCode: 0, stdout: "fixture gate passed", stderr: "" };
const original = Buffer.from(Array.from({ length: 1024 }, (_, i) => (i * 31 + 17) % 256));
const changed = Buffer.from(Array.from({ length: 1024 }, (_, i) => (i * 11 + 23) % 256));
const added = Buffer.from("another real binary asset\0\xff", "latin1");
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

async function fixture(t: TestContext) {
  const container = await mkdtemp(path.join(tmpdir(), "captain-lfs-lifecycle-"));
  t.after(async () => {
    assert.equal(path.dirname(container), path.resolve(tmpdir()));
    assert.ok(path.basename(container).startsWith("captain-lfs-lifecycle-"));
    await rm(container, { recursive: true, force: true });
  });
  const target = path.join(container, "target"), data = path.join(container, "authority");
  await mkdir(target);
  await git(target, "init", "-b", "main");
  await git(target, "config", "user.name", "Captain Test");
  await git(target, "config", "user.email", "captain@example.invalid");
  await git(target, "config", "core.autocrlf", "false");
  await git(target, "lfs", "install", "--local");
  await mkdir(path.join(target, ".captain-sdlc"));
  await writeFile(path.join(target, ".captain-sdlc", "codex-policy.json"), JSON.stringify({
    profile: "low", visualRequired: false,
    commands: { build: "trusted build", ticket: "trusted ticket", "feature-smoke": "trusted smoke", "affected-regression": "trusted regression" },
    commit: { conventional: true, require_version_suffix: false, require_task_trailer: false, version_file: "VERSION", version_surfaces: [], changelog_files: ["CHANGELOG.md"] }
  }));
  await writeFile(path.join(target, ".captain-sdlc", "merge-policy.json"), JSON.stringify({ schema_version: 1, strictness: "standard" }));
  await writeFile(path.join(target, ".gitignore"), ".captain-sdlc/worktrees/\n");
  await writeFile(path.join(target, ".gitattributes"), "*.uasset filter=lfs diff=lfs merge=lfs -text\n");
  await writeFile(path.join(target, "VERSION"), "1.0.0\n");
  await writeFile(path.join(target, "CHANGELOG.md"), "# Changelog\n");
  await writeFile(path.join(target, "fixture.uasset"), original);
  await git(target, "add", ".");
  await git(target, "commit", "-m", "fixture baseline");
  const pointer = await git(target, "show", "HEAD:fixture.uasset");
  assert.match(pointer, /^version https:\/\/git-lfs\.github\.com\/spec\/v1\n/);
  assert.match(pointer, new RegExp(`oid sha256:${sha256(original)}`));
  assert.match(pointer, new RegExp(`size ${original.length}`));
  assert.deepEqual(await readFile(path.join(target, "fixture.uasset")), original);
  return { target, data, head: await git(target, "rev-parse", "HEAD") };
}

async function linkedSource(target: string) {
  const source = path.join(target, ".captain-sdlc", "worktrees", "task");
  await git(target, "worktree", "add", "-b", "task", source);
  assert.deepEqual(await readFile(path.join(source, "fixture.uasset")), original);
  return source;
}

test("Captain creates a clean linked worktree with the actual hydrated Git LFS asset", async t => {
  const f = await fixture(t);
  const identity = await repositoryIdentity(f.target);
  assert.equal(identity.baseHead, f.head);
  const task = await ensureWorktree(f.target, identity.baseHead, "lfs-hydration", undefined, identity.commonGitDir, f.data);
  assert.deepEqual(await readFile(path.join(task.worktreePath, "fixture.uasset")), original);
  assert.equal((await sourceState(task.worktreePath)).status, "");
});

test("source inspection detects changed and newly added hydrated assets", async t => {
  const f = await fixture(t);
  const source = await linkedSource(f.target);
  const before = await sourceState(source);
  assert.equal(before.status, "");
  await writeFile(path.join(source, "fixture.uasset"), changed);
  const modified = await sourceState(source);
  assert.match(modified.status, /fixture\.uasset/);
  assert.notEqual(modified.manifest, before.manifest);
  await writeFile(path.join(source, "added.uasset"), added);
  const withNew = await sourceState(source);
  assert.match(withNew.status, /added\.uasset/);
  assert.notEqual(withNew.manifest, modified.manifest);
});

test("signed prep and fast-forward preserve modified and new LFS assets", async t => {
  const f = await fixture(t);
  const source = await linkedSource(f.target);
  await writeFile(path.join(source, "fixture.uasset"), changed);
  await writeFile(path.join(source, "added.uasset"), added);
  await git(source, "add", "fixture.uasset", "added.uasset");
  await git(source, "commit", "-m", "feat(test): change real LFS assets");
  const store = new MergeWorkflowStore(f.data, async () => ok);
  const args = { source_worktree: source, target_worktree: f.target, target_branch: "main", session_id: "lfs-session" };
  const prep = await store.prep(args);
  assert.equal(prep.state, "ready");
  assert.equal(prep.receipt_valid, true);
  assert.equal(await git(f.target, "rev-parse", "HEAD"), f.head);
  const merged = await store.back({ merge_id: prep.merge_id, session_id: args.session_id });
  assert.equal(merged.state, "merged");
  assert.deepEqual(await readFile(path.join(f.target, "fixture.uasset")), changed);
  assert.deepEqual(await readFile(path.join(f.target, "added.uasset")), added);
  assert.equal((await sourceState(f.target)).status, "");
});

test("signed readiness is invalidated when hydrated LFS bytes change", async t => {
  const f = await fixture(t);
  const source = await linkedSource(f.target);
  await writeFile(path.join(source, "task.txt"), "task\n");
  await git(source, "add", "task.txt");
  await git(source, "commit", "-m", "fix(test): fixture task");
  const store = new MergeWorkflowStore(f.data, async () => ok);
  const args = { source_worktree: source, target_worktree: f.target, target_branch: "main", session_id: "lfs-session" };
  const ready = await store.prep(args);
  assert.equal(ready.receipt_valid, true);
  await writeFile(path.join(source, "fixture.uasset"), changed);
  const stale = await store.status({ merge_id: ready.merge_id, session_id: args.session_id });
  assert.equal(stale.receipt_valid, false);
});

test("malformed committed LFS pointer cannot produce a task worktree", async t => {
  const f = await fixture(t);
  await repositoryIdentity(f.target); // Verify ordinary LFS attributes are supported before testing corruption.
  const bad = path.join(f.target, "bad-pointer.txt");
  await writeFile(bad, "version https://git-lfs.github.com/spec/v1\noid sha256:not-a-hash\nsize 1024\n");
  const oid = await git(f.target, "hash-object", "-w", "--no-filters", "bad-pointer.txt");
  await git(f.target, "update-index", "--cacheinfo", `100644,${oid},fixture.uasset`);
  await unlink(bad);
  await git(f.target, "commit", "-m", "fixture malformed pointer");
  const badHead = await git(f.target, "rev-parse", "HEAD");
  await assert.rejects(ensureWorktree(f.target, badHead, "bad-lfs-pointer", undefined, undefined, f.data), /lfs|pointer|integrity|digest|hash/i);
});

test("a corrupt local LFS object cannot be accepted as hydrated content", async t => {
  const f = await fixture(t);
  const identity = await repositoryIdentity(f.target);
  const oid = sha256(original);
  const object = path.join(f.target, ".git", "lfs", "objects", oid.slice(0, 2), oid.slice(2, 4), oid);
  await writeFile(object, Buffer.alloc(original.length, 0x5a));
  let created: Awaited<ReturnType<typeof ensureWorktree>>;
  try {
    created = await ensureWorktree(f.target, identity.baseHead, "corrupt-lfs-object", undefined, identity.commonGitDir, f.data);
  } catch (error) {
    assert.match(String(error), /lfs|object|integrity|digest|hash|checksum/i);
    return;
  }
  assert.deepEqual(await readFile(path.join(created.worktreePath, "fixture.uasset")), original, "recovery may succeed only with the verified original bytes");
});
