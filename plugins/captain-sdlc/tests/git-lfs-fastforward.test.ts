import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import { MergeWorkflowStore } from "../src/merge-workflow.js";
import { applyLfsFastForward, moveWindowsDirectoryNoReplace, prepareLfsFastForward } from "../src/git-lfs-fastforward.js";
import { git as captainGit } from "../src/workspace.js";

const exec = promisify(execFile);
const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null", GIT_TERMINAL_PROMPT: "0" };
for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_CONFIG_COUNT", "GIT_CONFIG_PARAMETERS", "GIT_LFS_SKIP_SMUDGE"]) delete env[key];
const git = async (cwd: string, ...args: string[]) => (await exec("git", args, { cwd, env, windowsHide: true })).stdout.trim();
const oldAsset = Buffer.from(Array.from({ length: 512 }, (_, i) => (i * 11 + 3) % 256));
const newAsset = Buffer.from(Array.from({ length: 512 }, (_, i) => (i * 23 + 5) % 256));
const newFile = Buffer.from("new LFS asset\0\xff", "latin1");
const ok = { exitCode: 0, stdout: "gate", stderr: "" };

async function fixture(t: TestContext, withoutAssets = false, lockable = false) {
  const container = await mkdtemp(path.join(tmpdir(), "captain-lfs-ff-"));
  t.after(async () => { assert.equal(path.dirname(container), path.resolve(tmpdir())); assert.ok(path.basename(container).startsWith("captain-lfs-ff-")); await rm(container, { recursive: true, force: true }); });
  const target = path.join(container, "target"), data = path.join(container, "authority");
  await mkdir(target); await git(target, "init", "-b", "main");
  await git(target, "config", "user.name", "Captain Test"); await git(target, "config", "user.email", "captain@example.invalid");
  await git(target, "config", "core.autocrlf", "false"); await git(target, "lfs", "install", "--local");
  await mkdir(path.join(target, ".captain-sdlc")); await mkdir(path.join(target, "assets"));
  await writeFile(path.join(target, ".captain-sdlc", "codex-policy.json"), JSON.stringify({ profile: "low", visualRequired: false,
    commands: { build: "build", ticket: "ticket", "feature-smoke": "smoke", "affected-regression": "regression" },
    commit: { conventional: true, require_version_suffix: false, require_task_trailer: false, version_file: "VERSION", version_surfaces: [], changelog_files: ["CHANGELOG.md"] } }));
  await writeFile(path.join(target, ".captain-sdlc", "merge-policy.json"), JSON.stringify({ schema_version: 1, strictness: "low" }));
  await writeFile(path.join(target, ".gitignore"), ".captain-sdlc/worktrees/\nassets/ignored.uasset\n");
  await writeFile(path.join(target, ".gitattributes"), `*.uasset filter=lfs diff=lfs merge=lfs -text${lockable ? " lockable" : ""}\n*.txt text eol=lf\n`);
  await writeFile(path.join(target, "VERSION"), "1.0.0\n"); await writeFile(path.join(target, "CHANGELOG.md"), "# Changelog\n");
  if (!withoutAssets) { await writeFile(path.join(target, "assets", "changed.uasset"), oldAsset); await writeFile(path.join(target, "assets", "deleted.uasset"), oldAsset); }
  await writeFile(path.join(target, "normal.txt"), "old\n"); await git(target, "add", "."); await git(target, "commit", "-m", "fixture baseline");
  const oldHead = await git(target, "rev-parse", "HEAD"), source = path.join(target, ".captain-sdlc", "worktrees", "task");
  await git(target, "worktree", "add", "-b", "task", source);
  if (!withoutAssets) {
    if (lockable && process.platform === "win32") for (const name of ["changed.uasset", "deleted.uasset"]) await chmod(path.join(source, "assets", name), 0o666);
    await writeFile(path.join(source, "assets", "changed.uasset"), newAsset); await writeFile(path.join(source, "assets", "added.uasset"), newFile);
    await unlink(path.join(source, "assets", "deleted.uasset")); await git(source, "add", "assets");
  }
  await writeFile(path.join(source, "normal.txt"), "new\n");
  await git(source, "add", "normal.txt"); await git(source, "commit", "-m", "feat(test): update LFS fixture");
  const newHead = await git(source, "rev-parse", "HEAD"), store = new MergeWorkflowStore(data, async () => ok);
  const args = { source_worktree: source, target_worktree: target, target_branch: "main", session_id: "ff-session" };
  return { container, target, source, data, oldHead, newHead, store, args };
}

function interruptOnce(store: MergeWorkflowStore, phase: string) {
  let hit = false;
  (store as any).fastForwardCheckpoint = async (current: string) => { if (!hit && current === phase) { hit = true; throw new Error(`simulated interruption: ${phase}`); } };
  return () => hit;
}

async function nestedFixture(t: TestContext) {
  const f = await fixture(t, true);
  await mkdir(path.join(f.source, "Tools", "Captain"), { recursive: true });
  await mkdir(path.join(f.source, "Game", "Fixtures"), { recursive: true });
  await writeFile(path.join(f.source, "Tools", "Captain", "gate.txt"), "nested gate\n");
  await writeFile(path.join(f.source, "Game", "Fixtures", "fixture.uasset"), newFile);
  await git(f.source, "add", "Tools", "Game"); await git(f.source, "commit", "-m", "feat(test): add nested fixture directories");
  f.newHead = await git(f.source, "rev-parse", "HEAD");
  return f;
}

async function posixExistingParentFixture(t: TestContext, nested = false) {
  const f = await fixture(t, true), relative = nested ? "assets/Outer/Inner" : "assets";
  if (nested) await mkdir(path.join(f.target, ...relative.split("/")), { recursive: true });
  await mkdir(path.join(f.source, ...relative.split("/")), { recursive: true });
  await writeFile(path.join(f.source, ...relative.split("/"), "new.uasset"), newFile);
  await git(f.source, "add", `${relative}/new.uasset`); await git(f.source, "commit", "-m", "feat(test): add asset in existing directory");
  f.newHead = await git(f.source, "rev-parse", "HEAD");
  return f;
}

test("POSIX fast-forward refuses unjournaled new destination directories", { skip: process.platform === "win32" }, async t => {
  const f = await nestedFixture(t);
  await assert.rejects(prepareLfsFastForward(f.target, "main", f.oldHead, f.newHead, captainGit), /directory|parent|unsupported/i);
  await assert.rejects(stat(path.join(f.target, "Tools")), (error: any) => error.code === "ENOENT");
  await assert.rejects(stat(path.join(f.target, "Game")), (error: any) => error.code === "ENOENT");
  assert.equal(await git(f.target, "rev-parse", "HEAD"), f.oldHead);
});

test("POSIX recovery refuses a foreign replacement for an existing destination parent", { skip: process.platform === "win32" }, async t => {
  const f = await posixExistingParentFixture(t), ready = await f.store.prep(f.args); interruptOnce(f.store, "prepared");
  await assert.rejects(f.store.back({ merge_id: ready.merge_id, session_id: f.args.session_id }), /simulated interruption/);
  const original = path.join(f.target, "assets"), preserved = path.join(f.target, "assets-original");
  await rename(original, preserved); await mkdir(original);
  await assert.rejects(new MergeWorkflowStore(f.data, async () => ok).back({ merge_id: ready.merge_id, session_id: f.args.session_id }), /directory|parent|identity|changed|foreign/i);
  assert.deepEqual(await readdir(original), []); assert.deepEqual(await readdir(preserved), []);
  assert.equal(await git(f.target, "rev-parse", "HEAD"), f.oldHead);
});

test("POSIX recovery refuses an ancestor replacement even when its child directory survives", { skip: process.platform === "win32" }, async t => {
  const f = await posixExistingParentFixture(t, true), ready = await f.store.prep(f.args); interruptOnce(f.store, "prepared");
  await assert.rejects(f.store.back({ merge_id: ready.merge_id, session_id: f.args.session_id }), /simulated interruption/);
  const outer = path.join(f.target, "assets", "Outer"), preserved = path.join(f.target, "assets", "Outer-original");
  await rename(outer, preserved); await mkdir(outer); await rename(path.join(preserved, "Inner"), path.join(outer, "Inner"));
  await assert.rejects(new MergeWorkflowStore(f.data, async () => ok).back({ merge_id: ready.merge_id, session_id: f.args.session_id }), /directory|parent|identity|changed|foreign/i);
  assert.deepEqual(await readdir(path.join(outer, "Inner")), []); assert.deepEqual(await readdir(preserved), []);
  assert.equal(await git(f.target, "rev-parse", "HEAD"), f.oldHead);
});

test("POSIX refuses an ancestor identity change after index publication", { skip: process.platform === "win32" }, async t => {
  const f = await posixExistingParentFixture(t, true), ready = await f.store.prep(f.args);
  const outer = path.join(f.target, "assets", "Outer"), preserved = path.join(f.target, "assets", "Outer-original");
  (f.store as any).fastForwardCheckpoint = async (phase: string) => {
    if (phase !== "index") return;
    await rename(outer, preserved); await mkdir(outer); await rename(path.join(preserved, "Inner"), path.join(outer, "Inner"));
  };
  await assert.rejects(f.store.back({ merge_id: ready.merge_id, session_id: f.args.session_id }), /directory|parent|identity|changed|foreign/i);
  assert.deepEqual(await readFile(path.join(outer, "Inner", "new.uasset")), newFile);
  assert.deepEqual(await readdir(preserved), []); assert.equal(await git(f.target, "rev-parse", "HEAD"), f.oldHead);
});

test("POSIX fast-forward still adds LFS files beneath an unchanged existing directory", { skip: process.platform === "win32" }, async t => {
  const f = await posixExistingParentFixture(t), ready = await f.store.prep(f.args);
  const merged = await f.store.back({ merge_id: ready.merge_id, session_id: f.args.session_id });
  assert.equal(merged.state, "merged"); assert.equal(await git(f.target, "rev-parse", "HEAD"), f.newHead);
  assert.deepEqual(await readFile(path.join(f.target, "assets", "new.uasset")), newFile);
});

test("Windows directory rename refuses existing files and directories", { skip: process.platform !== "win32" }, async t => {
  const root = await mkdtemp(path.join(tmpdir(), "captain-dir-rename-"));
  t.after(async () => { assert.ok(path.basename(root).startsWith("captain-dir-rename-")); await rm(root, { recursive: true, force: true }); });
  const staged = path.join(root, "staged"), foreignDirectory = path.join(root, "foreign-dir"), foreignFile = path.join(root, "foreign-file");
  await mkdir(staged); await mkdir(foreignDirectory); await writeFile(foreignFile, "preserve\n");
  await assert.rejects(moveWindowsDirectoryNoReplace(staged, foreignDirectory));
  assert.equal((await stat(foreignDirectory)).isDirectory(), true); assert.deepEqual(await readdir(foreignDirectory), []);
  await assert.rejects(moveWindowsDirectoryNoReplace(staged, foreignFile));
  assert.equal(await readFile(foreignFile, "utf8"), "preserve\n"); assert.equal((await stat(staged)).isDirectory(), true);
});

test("Windows fast-forward creates nested directories with native inherited ACLs", { skip: process.platform !== "win32" }, async t => {
  const native = await nestedFixture(t), actual = await nestedFixture(t);
  await git(native.target, "merge", "--ff-only", native.newHead);
  const plan = await prepareLfsFastForward(actual.target, "main", actual.oldHead, actual.newHead, captainGit);
  await applyLfsFastForward(plan, captainGit, async () => {}, async () => {});
  for (const relative of ["Tools", "Tools/Captain", "Tools/Captain/gate.txt", "Game", "Game/Fixtures", "Game/Fixtures/fixture.uasset"]) {
    assert.equal(await windowsSddl(path.join(actual.target, relative)), await windowsSddl(path.join(native.target, relative)), `${relative} ACL must match native Git inheritance`);
  }
  assert.equal(await readFile(path.join(actual.target, "Tools", "Captain", "gate.txt"), "utf8"), "nested gate\n");
  assert.deepEqual(await readFile(path.join(actual.target, "Game", "Fixtures", "fixture.uasset")), newFile);
  assert.equal(await git(actual.target, "rev-parse", "HEAD"), actual.newHead);
});

for (const phase of ["directory-moved", "directory"] as const) {
  test(`Windows signed fast-forward resumes after ${phase}`, { skip: process.platform !== "win32" }, async t => {
    const f = await nestedFixture(t), ready = await f.store.prep(f.args), hit = interruptOnce(f.store, phase);
    await assert.rejects(f.store.back({ merge_id: ready.merge_id, session_id: f.args.session_id }), /simulated interruption/);
    assert.equal(hit(), true); assert.equal(await git(f.target, "rev-parse", "HEAD"), f.oldHead);
    const resumed = await new MergeWorkflowStore(f.data, async () => ok).back({ merge_id: ready.merge_id, session_id: f.args.session_id });
    assert.equal(resumed.state, "merged"); assert.equal(await git(f.target, "rev-parse", "HEAD"), f.newHead);
    assert.equal(await readFile(path.join(f.target, "Tools", "Captain", "gate.txt"), "utf8"), "nested gate\n");
    assert.deepEqual(await readFile(path.join(f.target, "Game", "Fixtures", "fixture.uasset")), newFile);
  });
}

test("Windows recovery preserves foreign contents added to a published directory", { skip: process.platform !== "win32" }, async t => {
  const f = await nestedFixture(t), ready = await f.store.prep(f.args); interruptOnce(f.store, "directory-moved");
  await assert.rejects(f.store.back({ merge_id: ready.merge_id, session_id: f.args.session_id }), /simulated interruption/);
  const directory = path.join(f.target, "Game"), foreign = path.join(directory, "foreign.txt");
  await writeFile(foreign, "preserve foreign contents\n");
  await assert.rejects(new MergeWorkflowStore(f.data, async () => ok).back({ merge_id: ready.merge_id, session_id: f.args.session_id }), /directory|conflict|changed|diverg|input|foreign/i);
  assert.equal(await readFile(foreign, "utf8"), "preserve foreign contents\n");
  assert.equal(await git(f.target, "rev-parse", "HEAD"), f.oldHead);
});

test("Windows recovery resumes after the second signed directory move", { skip: process.platform !== "win32" }, async t => {
  const f = await nestedFixture(t), ready = await f.store.prep(f.args); let moves = 0;
  (f.store as any).fastForwardCheckpoint = async (phase: string) => { if (phase === "directory-moved" && ++moves === 2) throw new Error("simulated second directory interruption"); };
  await assert.rejects(f.store.back({ merge_id: ready.merge_id, session_id: f.args.session_id }), /simulated second directory interruption/);
  assert.equal(moves, 2); assert.equal(await git(f.target, "rev-parse", "HEAD"), f.oldHead);
  const resumed = await new MergeWorkflowStore(f.data, async () => ok).back({ merge_id: ready.merge_id, session_id: f.args.session_id });
  assert.equal(resumed.state, "merged"); assert.equal(await git(f.target, "rev-parse", "HEAD"), f.newHead);
  assert.equal(await readFile(path.join(f.target, "Tools", "Captain", "gate.txt"), "utf8"), "nested gate\n");
  assert.deepEqual(await readFile(path.join(f.target, "Game", "Fixtures", "fixture.uasset")), newFile);
});

test("Windows recovery refuses a replacement for a published signed directory", { skip: process.platform !== "win32" }, async t => {
  const f = await nestedFixture(t), ready = await f.store.prep(f.args); interruptOnce(f.store, "directory-moved");
  await assert.rejects(f.store.back({ merge_id: ready.merge_id, session_id: f.args.session_id }), /simulated interruption/);
  const original = path.join(f.target, "Game"), preserved = path.join(f.target, "Game-original");
  await rename(original, preserved); await mkdir(original);
  await assert.rejects(new MergeWorkflowStore(f.data, async () => ok).back({ merge_id: ready.merge_id, session_id: f.args.session_id }), /directory|identity|changed|diverg|input|foreign/i);
  assert.equal((await stat(original)).isDirectory(), true); assert.equal((await stat(preserved)).isDirectory(), true);
  assert.equal(await git(f.target, "rev-parse", "HEAD"), f.oldHead);
});

test("Windows refuses a directory identity change after index publication", { skip: process.platform !== "win32" }, async t => {
  const f = await nestedFixture(t), ready = await f.store.prep(f.args);
  const original = path.join(f.target, "Game"), preserved = path.join(f.target, "Game-original");
  (f.store as any).fastForwardCheckpoint = async (phase: string) => {
    if (phase !== "index") return;
    await rename(original, preserved); await mkdir(original); await rename(path.join(preserved, "Fixtures"), path.join(original, "Fixtures"));
  };
  await assert.rejects(f.store.back({ merge_id: ready.merge_id, session_id: f.args.session_id }), /directory|parent|identity|changed|foreign/i);
  assert.deepEqual(await readFile(path.join(original, "Fixtures", "fixture.uasset")), newFile);
  assert.deepEqual(await readdir(preserved), []); assert.equal(await git(f.target, "rev-parse", "HEAD"), f.oldHead);
});

for (const collision of ["empty directory", "nonempty directory", "file"] as const) {
  test(`Windows fast-forward preserves a foreign ${collision} at a planned directory`, { skip: process.platform !== "win32" }, async t => {
    const f = await nestedFixture(t), ready = await f.store.prep(f.args); interruptOnce(f.store, "prepared");
    await assert.rejects(f.store.back({ merge_id: ready.merge_id, session_id: f.args.session_id }), /simulated interruption/);
    const target = path.join(f.target, "Tools"), sentinel = path.join(target, "foreign.txt");
    if (collision === "file") await writeFile(target, "foreign file\n");
    else { await mkdir(target); if (collision === "nonempty directory") await writeFile(sentinel, "foreign contents\n"); }
    await assert.rejects(new MergeWorkflowStore(f.data, async () => ok).back({ merge_id: ready.merge_id, session_id: f.args.session_id }), /directory|conflict|changed|diverg|input|foreign/i);
    if (collision === "file") assert.equal(await readFile(target, "utf8"), "foreign file\n");
    else { assert.equal((await stat(target)).isDirectory(), true); if (collision === "nonempty directory") assert.equal(await readFile(sentinel, "utf8"), "foreign contents\n"); }
    assert.equal(await git(f.target, "rev-parse", "HEAD"), f.oldHead);
  });
}

test("Windows refuses foreign contents in a staged new directory", { skip: process.platform !== "win32" }, async t => {
  const f = await nestedFixture(t), plan = await prepareLfsFastForward(f.target, "main", f.oldHead, f.newHead, captainGit);
  assert.ok(plan.windows_directories?.length);
  const staged = plan.windows_directories![0].staged, foreign = path.join(staged, "foreign.txt");
  await writeFile(foreign, "preserve staged user data\n");
  await assert.rejects(applyLfsFastForward(plan, captainGit, async () => {}, async () => {}), /directory|foreign|user data/i);
  assert.equal(await readFile(foreign, "utf8"), "preserve staged user data\n");
  assert.equal(await git(f.target, "rev-parse", "HEAD"), f.oldHead);
});

test("Windows refuses a changed staged directory ACL before publication", { skip: process.platform !== "win32" }, async t => {
  const f = await nestedFixture(t), plan = await prepareLfsFastForward(f.target, "main", f.oldHead, f.newHead, captainGit);
  assert.ok(plan.windows_directories?.length);
  const staged = plan.windows_directories![0].staged;
  await exec("icacls.exe", [staged, "/grant", "*S-1-1-0:(OI)(CI)R"], { windowsHide: true });
  await assert.rejects(applyLfsFastForward(plan, captainGit, async () => {}, async () => {}), /ACL|changed/i);
  assert.equal((await stat(staged)).isDirectory(), true); assert.equal(await git(f.target, "rev-parse", "HEAD"), f.oldHead);
});

test("Windows refuses a changed staged file ACL before publication", { skip: process.platform !== "win32" }, async t => {
  const f = await nestedFixture(t), plan = await prepareLfsFastForward(f.target, "main", f.oldHead, f.newHead, captainGit);
  const item = plan.changes.find(change => change.path === "Tools/Captain/gate.txt"); assert.ok(item?.staged);
  await exec("icacls.exe", [item!.staged!, "/grant", "*S-1-1-0:R"], { windowsHide: true });
  await assert.rejects(applyLfsFastForward(plan, captainGit, async () => {}, async () => {}), /ACL|changed/i);
  assert.equal(await git(f.target, "rev-parse", "HEAD"), f.oldHead);
});

test("Windows refuses unsupported new-directory inheritance before publication", { skip: process.platform !== "win32" }, async t => {
  const f = await fixture(t, true), sourceDir = path.join(f.source, "assets", "Nested");
  await mkdir(sourceDir, { recursive: true }); await writeFile(path.join(sourceDir, "new.uasset"), newFile);
  await git(f.source, "add", "assets/Nested/new.uasset"); await git(f.source, "commit", "-m", "feat(test): add nested asset");
  const head = await git(f.source, "rev-parse", "HEAD"), parent = path.join(f.target, "assets");
  await exec("icacls.exe", [parent, "/grant", "*S-1-1-0:(OI)(CI)R"], { windowsHide: true });
  await assert.rejects(prepareLfsFastForward(f.target, "main", f.oldHead, head, captainGit), /ACL|inheritance/i);
  await assert.rejects(stat(path.join(parent, "Nested")), (error: any) => error.code === "ENOENT");
  assert.equal(await git(f.target, "rev-parse", "HEAD"), f.oldHead);
});

for (const phase of ["prepared", "file", "backup", "index-lock", "index", "ref"] as const) {
  test(`signed LFS fast-forward resumes after ${phase} interruption`, async t => {
    const f = await fixture(t), ready = await f.store.prep(f.args), interrupted = interruptOnce(f.store, phase);
    await assert.rejects(f.store.back({ merge_id: ready.merge_id, session_id: f.args.session_id }), /simulated interruption/);
    assert.equal(interrupted(), true);
    const resumed = new MergeWorkflowStore(f.data, async () => ok);
    const merged = await resumed.back({ merge_id: ready.merge_id, session_id: f.args.session_id });
    assert.equal(merged.state, "merged"); assert.equal(await git(f.target, "rev-parse", "HEAD"), f.newHead);
    assert.deepEqual(await readFile(path.join(f.target, "assets", "changed.uasset")), newAsset);
    assert.deepEqual(await readFile(path.join(f.target, "assets", "added.uasset")), newFile);
    await assert.rejects(readFile(path.join(f.target, "assets", "deleted.uasset")), (error: any) => error.code === "ENOENT");
    assert.equal(await readFile(path.join(f.target, "normal.txt"), "utf8"), "new\n");
  });
}

test("fast-forward refuses a changed user file on recovery and preserves it", async t => {
  const f = await fixture(t), ready = await f.store.prep(f.args);
  interruptOnce(f.store, "file");
  await assert.rejects(f.store.back({ merge_id: ready.merge_id, session_id: f.args.session_id }), /simulated interruption/);
  const foreign = Buffer.from("foreign user edit");
  await writeFile(path.join(f.target, "assets", "changed.uasset"), foreign);
  const resumed = new MergeWorkflowStore(f.data, async () => ok);
  await assert.rejects(resumed.back({ merge_id: ready.merge_id, session_id: f.args.session_id }), /changed|conflict|diverged|foreign|stale/i);
  assert.deepEqual(await readFile(path.join(f.target, "assets", "changed.uasset")), foreign);
  assert.equal(await git(f.target, "rev-parse", "HEAD"), f.oldHead);
});

test("fast-forward preserves a foreign edit to a newly published file on recovery", async t => {
  const f = await fixture(t), ready = await f.store.prep(f.args);
  interruptOnce(f.store, "file");
  await assert.rejects(f.store.back({ merge_id: ready.merge_id, session_id: f.args.session_id }), /simulated interruption/);
  const file = path.join(f.target, "assets", "added.uasset"), foreign = Buffer.from("foreign addition edit");
  await writeFile(file, foreign);
  const resumed = new MergeWorkflowStore(f.data, async () => ok);
  await assert.rejects(resumed.back({ merge_id: ready.merge_id, session_id: f.args.session_id }), /changed|conflict|diverged|foreign|stale/i);
  assert.deepEqual(await readFile(file), foreign);
  assert.equal(await git(f.target, "rev-parse", "HEAD"), f.oldHead);
});

for (const phase of ["prepared", "index"] as const) {
  test(`fast-forward preserves an unrelated target edit after ${phase} and never advances its ref`, async t => {
    const f = await fixture(t), ready = await f.store.prep(f.args); interruptOnce(f.store, phase);
    await assert.rejects(f.store.back({ merge_id: ready.merge_id, session_id: f.args.session_id }), /simulated interruption/);
    const file = path.join(f.target, "VERSION"), foreign = "foreign target version\n"; await writeFile(file, foreign);
    await assert.rejects(new MergeWorkflowStore(f.data, async () => ok).back({ merge_id: ready.merge_id, session_id: f.args.session_id }), /changed|conflict|diverg|stale|input/i);
    assert.equal(await readFile(file, "utf8"), foreign);
    assert.equal(await git(f.target, "rev-parse", "HEAD"), f.oldHead);
  });
}

test("fast-forward preserves ignored target manifest input edits before advancing its ref", async t => {
  const f = await fixture(t), file = path.join(f.target, "assets", "ignored.uasset");
  await writeFile(file, "initial ignored data\n");
  const ready = await f.store.prep(f.args); interruptOnce(f.store, "prepared");
  await assert.rejects(f.store.back({ merge_id: ready.merge_id, session_id: f.args.session_id }), /simulated interruption/);
  await writeFile(file, "foreign ignored data\n");
  await assert.rejects(new MergeWorkflowStore(f.data, async () => ok).back({ merge_id: ready.merge_id, session_id: f.args.session_id }), /changed|conflict|diverg|stale|input/i);
  assert.equal(await readFile(file, "utf8"), "foreign ignored data\n");
  assert.equal(await git(f.target, "rev-parse", "HEAD"), f.oldHead);
});

for (const side of ["source", "target"] as const) {
  test(`fast-forward refuses a live ${side} edit immediately before ref publication`, async t => {
    const f = await fixture(t), ready = await f.store.prep(f.args);
    const file = path.join(f[side], "VERSION"), foreign = `foreign ${side} edit\n`;
    (f.store as any).fastForwardCheckpoint = async (phase: string) => { if (phase === "index") await writeFile(file, foreign); };
    await assert.rejects(f.store.back({ merge_id: ready.merge_id, session_id: f.args.session_id }), /changed|conflict|diverg|stale|input/i);
    assert.equal(await readFile(file, "utf8"), foreign);
    assert.equal(await git(f.target, "rev-parse", "HEAD"), f.oldHead);
  });
}

test("target edits during transaction preparation are refused before signing", async t => {
  const f = await fixture(t), ready = await f.store.prep(f.args), foreign = Buffer.from("edited while preparing");
  (f.store as any).fastForwardCheckpoint = async (phase: string) => {
    if (phase === "planned") await writeFile(path.join(f.target, "assets", "changed.uasset"), foreign);
  };
  await assert.rejects(f.store.back({ merge_id: ready.merge_id, session_id: f.args.session_id }), /clean|changed|stale|input/i);
  assert.deepEqual(await readFile(path.join(f.target, "assets", "changed.uasset")), foreign);
  assert.equal(await git(f.target, "rev-parse", "HEAD"), f.oldHead);
  const status = await f.store.status({ merge_id: ready.merge_id, session_id: f.args.session_id });
  assert.equal(status.state, "ready");
  assert.equal(status.lfs_fast_forward, undefined);
});

for (const flag of ["--assume-unchanged", "--skip-worktree"] as const) {
  test(`fast-forward preserves a non-LFS user edit hidden by ${flag}`, async t => {
    const f = await fixture(t), ready = await f.store.prep(f.args), foreign = "hidden user change\n";
    await git(f.target, "update-index", flag, "normal.txt");
    await writeFile(path.join(f.target, "normal.txt"), foreign);
    await assert.rejects(f.store.back({ merge_id: ready.merge_id, session_id: f.args.session_id }), /clean|changed|stale|input|assume|skip/i);
    assert.equal(await readFile(path.join(f.target, "normal.txt"), "utf8"), foreign);
    assert.equal(await git(f.target, "rev-parse", "HEAD"), f.oldHead);
  });
}

test("planning independently verifies old non-LFS content against the old Git tree", async t => {
  const f = await fixture(t), foreign = "bad\n"; // Same length as the old tracked file.
  await writeFile(path.join(f.target, "normal.txt"), foreign);
  await assert.rejects(prepareLfsFastForward(f.target, "main", f.oldHead, f.newHead, captainGit), /old Git object|target differs/i);
  assert.equal(await readFile(path.join(f.target, "normal.txt"), "utf8"), foreign);
  assert.equal(await git(f.target, "rev-parse", "HEAD"), f.oldHead);
});

test("standalone fast-forward planning preserves unrelated staged content", async t => {
  const f = await fixture(t), foreign = "unrelated staged version\n";
  await writeFile(path.join(f.target, "VERSION"), foreign);
  await git(f.target, "add", "VERSION");
  const indexPath = path.resolve(f.target, await git(f.target, "rev-parse", "--git-path", "index"));
  const before = await readFile(indexPath);
  await assert.rejects(prepareLfsFastForward(f.target, "main", f.oldHead, f.newHead, captainGit), /index|staged|changed|tree/i);
  assert.equal(await git(f.target, "show", ":VERSION"), foreign.trim());
  assert.deepEqual(await readFile(indexPath), before);
  assert.equal(await git(f.target, "rev-parse", "HEAD"), f.oldHead);
});

test("Windows fast-forward refuses a lockable LFS input before publication", { skip: process.platform !== "win32" }, async t => {
  const f = await fixture(t, false, true), file = path.join(f.target, "assets", "changed.uasset");
  await chmod(file, 0o444);
  assert.equal((await stat(file)).mode & 0o222, 0);
  try {
    await assert.rejects(prepareLfsFastForward(f.target, "main", f.oldHead, f.newHead, captainGit), /lockable/i);
    assert.equal(await git(f.target, "rev-parse", "HEAD"), f.oldHead);
    assert.deepEqual(await readFile(file), oldAsset);
    assert.equal((await stat(file)).mode & 0o222, 0);
  } finally {
    await chmod(file, 0o666);
  }
});

test("fast-forward refuses LFS paths made lockable only in the incoming commit", async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.source, ".gitattributes"), "*.uasset filter=lfs diff=lfs merge=lfs -text lockable\n*.txt text eol=lf\n");
  await git(f.source, "add", ".gitattributes");
  await git(f.source, "commit", "-m", "fix(test): add lockable attribute");
  const incoming = await git(f.source, "rev-parse", "HEAD");
  await assert.rejects(prepareLfsFastForward(f.target, "main", f.oldHead, incoming, captainGit), /lockable/i);
  assert.equal(await git(f.target, "rev-parse", "HEAD"), f.oldHead);
  assert.deepEqual(await readFile(path.join(f.target, "assets", "changed.uasset")), oldAsset);
});

test("Windows non-lockable read-only inputs follow normal Git mode behavior", { skip: process.platform !== "win32" }, async t => {
  const native = await fixture(t), actual = await fixture(t);
  const nativeFile = path.join(native.target, "assets", "changed.uasset"), actualFile = path.join(actual.target, "assets", "changed.uasset");
  await chmod(nativeFile, 0o444); await chmod(actualFile, 0o444);
  let plan: Awaited<ReturnType<typeof prepareLfsFastForward>> | undefined;
  try {
    await git(native.target, "merge", "--ff-only", native.newHead);
    const expectedMode = (await stat(nativeFile)).mode & 0o222;
    plan = await prepareLfsFastForward(actual.target, "main", actual.oldHead, actual.newHead, captainGit);
    await applyLfsFastForward(plan, captainGit, async () => {}, async () => {});
    assert.deepEqual(await readFile(actualFile), newAsset);
    assert.equal((await stat(actualFile)).mode & 0o222, expectedMode);
  } finally {
    for (const file of [nativeFile, actualFile, ...(plan?.changes ?? []).flatMap(change => change.backup ? [change.backup] : [])]) {
      try { await chmod(file, 0o666); } catch (error: any) { if (error.code !== "ENOENT") throw error; }
    }
  }
});

async function windowsSddl(file: string) {
  return (await exec("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "(Get-Acl -LiteralPath $env:CAPTAIN_TEST_FILE).Sddl"], { env: { ...process.env, CAPTAIN_TEST_FILE: file }, windowsHide: true })).stdout.trim();
}
test("Windows fast-forward preserves a custom ACL or refuses before publication", { skip: process.platform !== "win32" }, async t => {
  const f = await fixture(t), file = path.join(f.target, "assets", "changed.uasset");
  const user = `${process.env.USERDOMAIN}\\${process.env.USERNAME}`;
  await exec("icacls.exe", [file, "/inheritance:r", "/grant:r", `${user}:(F)`], { windowsHide: true });
  const original = await windowsSddl(file);
  let plan: Awaited<ReturnType<typeof prepareLfsFastForward>>;
  try { plan = await prepareLfsFastForward(f.target, "main", f.oldHead, f.newHead, captainGit); }
  catch (error) {
    assert.match(String(error), /read.?only|metadata|permission|acl/i);
    assert.equal(await windowsSddl(file), original);
    assert.deepEqual(await readFile(file), oldAsset);
    assert.equal(await git(f.target, "rev-parse", "HEAD"), f.oldHead);
    return;
  }
  await applyLfsFastForward(plan, captainGit, async () => {}, async () => {});
  assert.deepEqual(await readFile(file), newAsset);
  assert.equal(await windowsSddl(file), original, "replacement must retain the original ACL");
});

test("Windows fast-forward uses destination-parent ACL for a newly added asset or refuses", { skip: process.platform !== "win32" }, async t => {
  const f = await fixture(t), reference = path.join(f.target, "assets", "local-reference.tmp"), file = path.join(f.target, "assets", "added.uasset");
  const user = `${process.env.USERDOMAIN}\\${process.env.USERNAME}`;
  await exec("icacls.exe", [path.dirname(reference), "/inheritance:r", "/grant:r", `${user}:(OI)(CI)F`], { windowsHide: true });
  await writeFile(reference, "local comparison\n");
  const inherited = await windowsSddl(reference);
  let plan: Awaited<ReturnType<typeof prepareLfsFastForward>>;
  try { plan = await prepareLfsFastForward(f.target, "main", f.oldHead, f.newHead, captainGit); }
  catch (error) {
    assert.match(String(error), /read.?only|metadata|permission|acl/i);
    await assert.rejects(readFile(file), { code: "ENOENT" });
    assert.equal(await readFile(reference, "utf8"), "local comparison\n");
    assert.equal(await git(f.target, "rev-parse", "HEAD"), f.oldHead);
    return;
  }
  await applyLfsFastForward(plan, captainGit, async () => {}, async () => {});
  assert.deepEqual(await readFile(file), newFile);
  assert.equal(await windowsSddl(file), inherited, "new asset must inherit the destination directory ACL");
});

test("fast-forward rejects an unrelated index change after interruption", async t => {
  const f = await fixture(t), ready = await f.store.prep(f.args);
  interruptOnce(f.store, "index");
  await assert.rejects(f.store.back({ merge_id: ready.merge_id, session_id: f.args.session_id }), /simulated interruption/);
  await git(f.target, "update-index", "--assume-unchanged", "normal.txt");
  const index = path.resolve(f.target, await git(f.target, "rev-parse", "--git-path", "index")), foreign = await readFile(index);
  const resumed = new MergeWorkflowStore(f.data, async () => ok);
  await assert.rejects(resumed.back({ merge_id: ready.merge_id, session_id: f.args.session_id }), /index|changed|diverged|stale/i);
  assert.deepEqual(await readFile(index), foreign); assert.equal(await git(f.target, "rev-parse", "HEAD"), f.oldHead);
});

test("fast-forward refuses an ignored user file that collides with an added LFS path", async t => {
  const f = await fixture(t), file = path.join(f.source, "assets", "ignored.uasset");
  await writeFile(file, newFile); await git(f.source, "add", "-f", "assets/ignored.uasset"); await git(f.source, "commit", "-m", "feat(test): add ignored asset");
  const userFile = path.join(f.target, "assets", "ignored.uasset"), original = Buffer.from("keep this local data");
  await writeFile(userFile, original);
  const ready = await f.store.prep(f.args);
  await assert.rejects(f.store.back({ merge_id: ready.merge_id, session_id: f.args.session_id }), /collision|existing|untracked|ignored/i);
  assert.deepEqual(await readFile(userFile), original); assert.equal(await git(f.target, "rev-parse", "HEAD"), f.oldHead);
  assert.deepEqual(await readFile(path.join(f.target, "assets", "changed.uasset")), oldAsset);
});

test("an LFS-configured repository with no matching files still uses safe fast-forward", async t => {
  const f = await fixture(t, true), ready = await f.store.prep(f.args);
  const merged = await f.store.back({ merge_id: ready.merge_id, session_id: f.args.session_id });
  assert.equal(merged.state, "merged");
  assert.equal(await git(f.target, "rev-parse", "HEAD"), f.newHead);
  assert.equal(await readFile(path.join(f.target, "normal.txt"), "utf8"), "new\n");
});

test("signed readiness becomes stale when a changed LFS object is missing or corrupt", async t => {
  const f = await fixture(t), ready = await f.store.prep(f.args);
  assert.equal(ready.receipt_valid, true);
  const oid = createHash("sha256").update(newAsset).digest("hex"), object = path.join(f.target, ".git", "lfs", "objects", oid.slice(0, 2), oid.slice(2, 4), oid);
  const bytes = await readFile(object);
  await unlink(object);
  assert.equal((await f.store.status({ merge_id: ready.merge_id, session_id: f.args.session_id })).receipt_valid, false);
  await writeFile(object, Buffer.alloc(bytes.length, 0x5a));
  assert.equal((await f.store.status({ merge_id: ready.merge_id, session_id: f.args.session_id })).receipt_valid, false);
  await writeFile(object, bytes);
  assert.equal((await f.store.status({ merge_id: ready.merge_id, session_id: f.args.session_id })).receipt_valid, true);
});

test("a record-only descendant cannot silently replace signed LFS object evidence", async t => {
  const f = await fixture(t), control = path.join(f.source, ".captain-sdlc"), policyPath = path.join(control, "codex-policy.json");
  const policy = JSON.parse(await readFile(policyPath, "utf8"));
  policy.commit.bookkeeping = { path_file: ".captain-sdlc/captain.ignore" };
  await writeFile(policyPath, JSON.stringify(policy));
  await writeFile(path.join(control, "captain.ignore"), "/.captain-sdlc/notebook/\n");
  await mkdir(path.join(control, "notebook"));
  const notes = path.join(control, "notebook", "notes.json");
  await writeFile(notes, '{"one":1}\n');
  const attrs = path.join(f.source, ".gitattributes");
  await writeFile(attrs, (await readFile(attrs, "utf8")) + "/.captain-sdlc/notebook/*.json filter=lfs diff=lfs merge=lfs -text\n");
  await git(f.source, "add", ".captain-sdlc/codex-policy.json", ".captain-sdlc/captain.ignore", ".captain-sdlc/notebook/notes.json", ".gitattributes");
  await git(f.source, "commit", "-m", "feat(test): configure bookkeeping and LFS");
  const ready = await f.store.prep(f.args);
  assert.ok(ready.ready_inputs!.lfs_objects?.some(item => item.oid === createHash("sha256").update('{"one":1}\n').digest("hex")));
  await writeFile(notes, '{"two":2}\n'); await git(f.source, "add", ".captain-sdlc/notebook/notes.json");
  await git(f.source, "commit", "-m", "docs(captain): retain notebook update");
  await assert.rejects(f.store.back({ merge_id: ready.merge_id, session_id: f.args.session_id }), /bookkeeping|stale|input/i);
  assert.equal(await git(f.target, "rev-parse", "HEAD"), f.oldHead);
});

test("signed transaction tampering is rejected before target mutation", async t => {
  const f = await fixture(t), ready = await f.store.prep(f.args);
  interruptOnce(f.store, "prepared");
  await assert.rejects(f.store.back({ merge_id: ready.merge_id, session_id: f.args.session_id }), /simulated interruption/);
  const state = await f.store.status({ merge_id: ready.merge_id, session_id: f.args.session_id });
  const planFile = path.join(f.data, "lfs-fastforward-plans", `${state.lfs_fast_forward!.id}.json`);
  const envelope = JSON.parse(await readFile(planFile, "utf8"));
  envelope.payload.changes[0].path = "other.txt";
  await writeFile(planFile, JSON.stringify(envelope));
  const resumed = new MergeWorkflowStore(f.data, async () => ok);
  await assert.rejects(resumed.back({ merge_id: ready.merge_id, session_id: f.args.session_id }), /tag|signature|invalid|authority/i);
  assert.equal(await git(f.target, "rev-parse", "HEAD"), f.oldHead);
  assert.deepEqual(await readFile(path.join(f.target, "assets", "changed.uasset")), oldAsset);
});

test("a target commit made after transaction preparation is preserved", async t => {
  const f = await fixture(t), ready = await f.store.prep(f.args);
  interruptOnce(f.store, "prepared");
  await assert.rejects(f.store.back({ merge_id: ready.merge_id, session_id: f.args.session_id }), /simulated interruption/);
  await writeFile(path.join(f.target, "normal.txt"), "a user commit\n");
  await git(f.target, "add", "normal.txt"); await git(f.target, "commit", "-m", "fix(test): user target change");
  const foreignHead = await git(f.target, "rev-parse", "HEAD"), resumed = new MergeWorkflowStore(f.data, async () => ok);
  await assert.rejects(resumed.back({ merge_id: ready.merge_id, session_id: f.args.session_id }), /head|changed|diverged|stale|binding/i);
  assert.equal(await git(f.target, "rev-parse", "HEAD"), foreignHead);
  assert.equal(await readFile(path.join(f.target, "normal.txt"), "utf8"), "a user commit\n");
  assert.deepEqual(await readFile(path.join(f.target, "assets", "changed.uasset")), oldAsset);
});

for (const metadata of ["config", "attributes", "exclude"] as const) {
  test(`target ${metadata} edits after preparation are preserved and block recovery`, async t => {
    const f = await fixture(t), ready = await f.store.prep(f.args);
    interruptOnce(f.store, "prepared");
    await assert.rejects(f.store.back({ merge_id: ready.merge_id, session_id: f.args.session_id }), /simulated interruption/);
    let changedFile: string;
    if (metadata === "config") {
      await git(f.target, "config", "core.autocrlf", "true");
      changedFile = path.join(f.target, ".git", "config");
    } else {
      changedFile = path.join(f.target, ".git", "info", metadata);
      await writeFile(changedFile, "# changed by user\n");
    }
    const bytes = await readFile(changedFile), resumed = new MergeWorkflowStore(f.data, async () => ok);
    await assert.rejects(resumed.back({ merge_id: ready.merge_id, session_id: f.args.session_id }), /config|metadata|attributes|exclude|changed|stale/i);
    assert.deepEqual(await readFile(changedFile), bytes); assert.equal(await git(f.target, "rev-parse", "HEAD"), f.oldHead);
    assert.deepEqual(await readFile(path.join(f.target, "assets", "changed.uasset")), oldAsset);
  });
}

test("LFS fast-forward never invokes repository-defined filter commands", async t => {
  const f = await fixture(t), marker = path.join(f.container, "filter-executed"), program = path.join(f.container, "filter.cjs");
  await writeFile(program, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed');process.exit(1);`);
  const command = `"${process.execPath.replaceAll("\\", "/")}" "${program.replaceAll("\\", "/")}"`;
  await git(f.target, "config", "filter.lfs.process", command);
  await git(f.target, "config", "filter.lfs.clean", command);
  await git(f.target, "config", "filter.lfs.smudge", command);
  const ready = await f.store.prep(f.args);
  const merged = await f.store.back({ merge_id: ready.merge_id, session_id: f.args.session_id });
  assert.equal(merged.state, "merged");
  await assert.rejects(readFile(marker), (error: any) => error.code === "ENOENT");
  assert.deepEqual(await readFile(path.join(f.target, "assets", "added.uasset")), newFile);
});

test("fast-forward publishes a self-contained index when the target used a split index", async t => {
  const f = await fixture(t);
  await git(f.target, "update-index", "--split-index");
  assert.notEqual(await git(f.target, "rev-parse", "--shared-index-path"), "");
  const ready = await f.store.prep(f.args);
  const merged = await f.store.back({ merge_id: ready.merge_id, session_id: f.args.session_id });
  assert.equal(merged.state, "merged");
  assert.equal(await git(f.target, "rev-parse", "--shared-index-path"), "");
  assert.equal(await git(f.target, "status", "--porcelain"), "");
  assert.deepEqual(await readFile(path.join(f.target, "assets", "changed.uasset")), newAsset);
});
