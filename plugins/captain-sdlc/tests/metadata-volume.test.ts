import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { MergeWorkflowStore } from "../src/merge-workflow.js";

const exec = promisify(execFile);
const git = async (root: string, ...args: string[]) => exec("git", args, { cwd: root, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });

test("excluded generated files do not overflow the metadata listing", { skip: process.platform === "win32", timeout: 180000 }, async t => {
  const root = await mkdtemp(path.join(tmpdir(), "captain-metadata-volume-"));
  t.after(async () => {
    assert.equal(path.dirname(root), path.resolve(tmpdir()));
    assert.ok(path.basename(root).startsWith("captain-metadata-volume-"));
    await rm(root, { recursive: true, force: true });
  });
  const target = path.join(root, "target"), source = path.join(root, "source");
  await mkdir(target); await git(target, "init", "-b", "main");
  await git(target, "config", "user.name", "Captain Test"); await git(target, "config", "user.email", "captain@example.invalid");
  await mkdir(path.join(target, ".captain-sdlc"));
  await writeFile(path.join(target, ".captain-sdlc", "codex-policy.json"), JSON.stringify({
    profile: "low", visualRequired: false, commands: { build: "fixture", ticket: "fixture", "feature-smoke": "fixture", "affected-regression": "fixture" },
    sourceManifestExcludes: ["Temp"], commit: { conventional: true, require_version_suffix: false, require_task_trailer: false, version_file: "VERSION", version_surfaces: [], changelog_files: ["CHANGELOG.md"] }
  }));
  await writeFile(path.join(target, ".gitignore"), "Temp/\n");
  await writeFile(path.join(target, "VERSION"), "1.0.0\n"); await writeFile(path.join(target, "CHANGELOG.md"), "fixture\n");
  await git(target, "add", "."); await git(target, "commit", "-m", "fixture");
  await git(target, "worktree", "add", "-b", "task", source);
  await writeFile(path.join(source, "task.txt"), "task\n"); await git(source, "add", "task.txt"); await git(source, "commit", "-m", "task");
  const generated = path.join(source, "Temp", "a".repeat(80), "b".repeat(80));
  await mkdir(generated, { recursive: true });
  const count = 30000, padding = "x".repeat(185);
  for (let offset = 0; offset < count; offset += 100) {
    await Promise.all(Array.from({ length: Math.min(100, count - offset) }, (_, i) => writeFile(path.join(generated, `${offset + i}-${padding}.tmp`), "")));
  }
  const listedBytes = await new Promise<number>((resolve, reject) => {
    const child = spawn("git", ["ls-files", "--others", "-z"], { cwd: source, windowsHide: true });
    let bytes = 0; child.stdout.on("data", chunk => { bytes += chunk.length; });
    child.on("error", reject); child.on("close", code => code === 0 ? resolve(bytes) : reject(new Error(`git listing failed: ${code}`)));
  });
  assert.ok(listedBytes > 10 * 1024 * 1024, `fixture must exceed the prior Git output limit: ${listedBytes}`);
  const store = new MergeWorkflowStore(path.join(root, "authority"), async () => ({ exitCode: 0, stdout: "", stderr: "" }));
  const ready = await store.prep({ source_worktree: source, target_worktree: target, target_branch: "main", session_id: "metadata-volume" });
  assert.equal(ready.state, "ready"); assert.equal(ready.receipt_valid, true);
});
