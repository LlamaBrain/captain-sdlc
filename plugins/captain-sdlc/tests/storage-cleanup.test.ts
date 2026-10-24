import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { acquireAuthorizedLease } from "../src/authority.js";
import { MergeWorkflowStore } from "../src/merge-workflow.js";
import { ensureWorktree } from "../src/workspace.js";

const exec = promisify(execFile);
const git = async (cwd: string, ...args: string[]) => (await exec("git", args, { cwd, windowsHide: true })).stdout.trim();
const exists = async (file: string) => access(file).then(() => true, () => false);
const ok = { exitCode: 0, stdout: "pass", stderr: "" };
async function fixture(t: TestContext, managed = true) {
  const container = await mkdtemp(path.join(tmpdir(), "captain-storage-cleanup-"));
  t.after(async () => {
    assert.equal(path.dirname(container), path.resolve(tmpdir()));
    assert.ok(path.basename(container).startsWith("captain-storage-cleanup-"));
    await rm(container, { recursive: true, force: true });
  });
  const target = path.join(container, "project"), data = path.join(container, "authority");
  await mkdir(path.join(target, ".captain-sdlc"), { recursive: true });
  await git(target, "init", "-b", "main");
  await git(target, "config", "user.name", "Captain Test");
  await git(target, "config", "user.email", "captain@example.invalid");
  await git(target, "config", "core.autocrlf", "false");
  await writeFile(path.join(target, ".gitignore"), ".captain-sdlc/worktrees/\nBuilds/\nArtifacts/\n");
  await writeFile(path.join(target, ".captain-sdlc/codex-policy.json"), JSON.stringify({ profile: "low", visualRequired: false,
    commands: { build: "trusted build", ticket: "trusted ticket", "feature-smoke": "trusted smoke", "affected-regression": "trusted affected" }, outputRetention: { schema_version: 1, roots: { build: ["Builds/active"] } },
    artifactPaths: { build: "Artifacts/build.json", smoke: ".captain-proof/optional-smoke.json" },
    commit: { conventional: true, require_version_suffix: false, require_task_trailer: false, version_file: "VERSION", version_surfaces: [], changelog_files: ["CHANGELOG.md"] },
    sourceManifestExcludes: ["Builds", "Artifacts"] }));
  await writeFile(path.join(target, ".captain-sdlc/merge-policy.json"), JSON.stringify({ schema_version: 1, strictness: "low" }));
  await writeFile(path.join(target, "source.txt"), "base\n");
  await git(target, "add", "."); await git(target, "commit", "-m", "baseline");
  const base = await git(target, "rev-parse", "HEAD");
  let source: string;
  if (managed) source = (await (ensureWorktree as any)(target, base, "new-task", undefined, undefined, data)).worktreePath;
  else { source = path.join(target, ".captain-sdlc/worktrees/legacy-task"); await git(target, "worktree", "add", "-b", "legacy", source); }
  await writeFile(path.join(source, "task.txt"), "task\n"); await git(source, "add", "task.txt"); await git(source, "commit", "-m", "feat(test): task");
  const store = new MergeWorkflowStore(data, async (_command, cwd) => {
    await mkdir(path.join(cwd, "Artifacts"), { recursive: true });
    await writeFile(path.join(cwd, "Artifacts/build.json"), JSON.stringify({ result: "passed" }));
    return ok;
  });
  const args = { source_worktree: source, target_worktree: target, target_branch: "main", session_id: "storage-test" };
  return { target, source, data, store, args };
}

test("Merge Back removes only its newly managed completed source and preserves readable proof", async t => {
  const f = await fixture(t);
  await mkdir(path.join(f.source, "Builds/active"), { recursive: true });
  await writeFile(path.join(f.source, "Builds/active/player.exe"), "replaceable payload");
  await mkdir(path.join(f.source, "Artifacts"), { recursive: true });
  await writeFile(path.join(f.source, "Artifacts/build.json"), JSON.stringify({ result: "passed" }));
  const prep = await f.store.prep(f.args), head = await git(f.source, "rev-parse", "HEAD");
  const back: any = await f.store.back({ merge_id: prep.merge_id, session_id: f.args.session_id });
  assert.equal(back.state, "merged");
  assert.equal(await exists(f.source), false);
  assert.deepEqual(back.cleanup.removed_worktrees, [f.source]);
  const archiveNames = await import("node:fs/promises").then(fs => fs.readdir(back.cleanup.evidence_root));
  assert.equal(JSON.parse(await readFile(path.join(back.cleanup.evidence_root, archiveNames[0], "Artifacts/build.json"), "utf8")).result, "passed");
  assert.equal(await git(f.target, "rev-parse", "HEAD"), head);
  assert.equal(await git(f.target, "rev-parse", "refs/heads/captain/new-task"), head);
  assert.equal((await f.store.status({ merge_id: prep.merge_id, session_id: f.args.session_id })).receipt_valid, true);
  assert.equal((await f.store.back({ merge_id: prep.merge_id, session_id: f.args.session_id })).state, "merged");
  await writeFile(path.join(f.target, "later.txt"), "later\n"); await git(f.target, "add", "later.txt"); await git(f.target, "commit", "-m", "fix(test): later");
  assert.equal((await f.store.status({ merge_id: prep.merge_id, session_id: f.args.session_id })).receipt_valid, true);
});

test("legacy unregistered worktrees are excluded from automatic cleanup", async t => {
  const f = await fixture(t, false), prep = await f.store.prep(f.args);
  const back: any = await f.store.back({ merge_id: prep.merge_id, session_id: f.args.session_id });
  assert.equal(back.state, "merged"); assert.equal(await exists(f.source), true);
  assert.ok(back.cleanup.retained_worktrees.some((entry: any) => entry.worktree === f.source && /registered|legacy/i.test(entry.reason)));
});

test("cleanup retains a locked worktree while reporting successful integration", async t => {
  const f = await fixture(t), prep = await f.store.prep(f.args);
  await git(f.target, "worktree", "lock", f.source);
  const back: any = await f.store.back({ merge_id: prep.merge_id, session_id: f.args.session_id });
  assert.equal(back.state, "merged"); assert.equal(await exists(f.source), true);
  assert.ok(back.cleanup.retained_worktrees.some((entry: any) => /lock/i.test(entry.reason)));
  await git(f.target, "worktree", "unlock", f.source);
});

test("a merged child cannot delete an unfinished parent worktree", async t => {
  const f = await fixture(t), parentHead = await git(f.source, "rev-parse", "HEAD");
  const child = (await (ensureWorktree as any)(f.source, parentHead, "child-task", undefined, undefined, f.data, f.source)).worktreePath;
  await writeFile(path.join(child, "child.txt"), "child\n"); await git(child, "add", "child.txt"); await git(child, "commit", "-m", "feat(test): child");
  const common = await git(f.source, "rev-parse", "--path-format=absolute", "--git-common-dir");
  const lease = createHash("sha256").update(`${path.resolve(common)}\0refs/heads/captain/new-task`.toLowerCase()).digest("hex");
  await acquireAuthorizedLease(f.data, lease, { intentId: "unfinished-parent", leaseToken: "active", operation: "implementation" });
  const prep = await f.store.prep({ ...f.args, source_worktree: child });
  const back: any = await f.store.back({ merge_id: prep.merge_id, session_id: f.args.session_id });
  assert.equal(back.state, "merged"); assert.equal(await exists(child), false); assert.equal(await exists(f.source), true);
  assert.ok(back.cleanup.retained_worktrees.some((entry: any) => entry.worktree === f.source));
});

test("completed chain removes its merged checkouts and historical Merge Back stays readable", async t => {
  const f = await fixture(t), parentHead = await git(f.source, "rev-parse", "HEAD");
  const child = (await (ensureWorktree as any)(f.source, parentHead, "child-task", undefined, undefined, f.data, f.source)).worktreePath;
  await writeFile(path.join(child, "child.txt"), "child\n"); await git(child, "add", "child.txt"); await git(child, "commit", "-m", "feat(test): child");
  const first = await f.store.prep({ ...f.args, source_worktree: child, target_worktree: f.source, target_branch: "captain/new-task" });
  assert.equal((await f.store.back({ merge_id: first.merge_id, session_id: f.args.session_id })).state, "merged");
  assert.equal(await exists(child), false); assert.equal(await exists(f.source), true);
  const last = await f.store.prep(f.args);
  const back: any = await f.store.back({ merge_id: last.merge_id, session_id: f.args.session_id });
  assert.equal(await exists(f.source), false);
  assert.deepEqual(new Set(back.cleanup.removed_worktrees), new Set([child, f.source]));
  assert.equal((await f.store.status({ merge_id: first.merge_id, session_id: f.args.session_id })).receipt_valid, true);
  assert.equal((await f.store.back({ merge_id: first.merge_id, session_id: f.args.session_id })).state, "merged");
});
