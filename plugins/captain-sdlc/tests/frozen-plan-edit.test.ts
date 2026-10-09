import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { mutationDecision } from "../src/policy.js";
import { LifecycleStore } from "../src/lifecycle.js";

const cwd = path.resolve("test-owned-worktree"), permit = { sessionId: "s", worktreePath: cwd, phase: "implement", intentId: "owned", frozenPlanPaths: ["Docs/Plan.md"] };
function decide(command: string, toolName = "apply_patch", workingDirectory = cwd) {
  return mutationDecision({ toolName, cwd: workingDirectory, sessionId: "s", permit, command });
}
test("frozen plan rejects add, update, delete, and rename destination before mutation", () => {
  for (const operation of ["Add", "Update", "Delete"]) {
    const result = decide(`*** ${operation} File: Docs/Plan.md`);
    assert.equal(result.allow, false);
    assert.match(result.reason!, /frozen.*plan/i);
  }
  assert.match(decide("*** Update File: Docs/new.md\n*** Move to: Docs/Plan.md").reason!, /frozen.*plan/i);
  assert.match(decide("*** Update File: Docs/Plan.md\n*** Move to: Docs/archive.md").reason!, /frozen.*plan/i);
});
test("relative traversal and Windows case variants resolve to the frozen path", () => {
  assert.match(decide("*** Update File: ../Docs/Plan.md", "apply_patch", path.join(cwd, "src")).reason!, /frozen.*plan/i);
  if (process.platform === "win32") assert.match(decide("*** Update File: docs/PLAN.MD").reason!, /frozen.*plan/i);
});
test("unrelated task edits and unbound permits retain normal mutation policy", () => {
  assert.equal(decide(`*** Update File: ${path.join(cwd, "src/feature.ts")}`).allow, true);
  assert.equal(mutationDecision({ toolName: "apply_patch", cwd, sessionId: "s", permit: { ...permit, frozenPlanPaths: undefined }, command: `*** Update File: ${path.join(cwd, "Docs/Plan.md")}` }).allow, true);
});

test("actual LOW hook rejects structured and patch frozen edits but retains unrelated LOW bypass", async () => {
  const data = await mkdtemp(path.join(tmpdir(), "captain-frozen-edit-")), projectRoot = path.join(data, "project"), worktreePath = path.join(projectRoot, ".captain-sdlc/worktrees/task");
  await mkdir(path.join(worktreePath, ".captain-sdlc"), { recursive: true });
  const exec = promisify(execFile), git = (args: string[]) => exec("git", args, { cwd: worktreePath, windowsHide: true });
  await git(["init"]); await git(["config", "user.name", "Captain Test"]); await git(["config", "user.email", "captain@example.invalid"]);
  await writeFile(path.join(worktreePath, ".captain-sdlc/merge-policy.json"), JSON.stringify({ schema_version: 1, strictness: "low" }));
  await mkdir(path.join(worktreePath, "Docs")); await writeFile(path.join(worktreePath, "Docs/Plan.md"), "Frozen scope\n");
  await git(["add", "."]); await git(["commit", "-m", "fixture"]);
  const store = new LifecycleStore(data, async () => ({ exitCode: 0, stdout: "", stderr: "" }));
  await store.markIntent({ intentId: "frozen", sessionId: "s", turnId: "t", projectRoot, prompt: "start" });
  await store.begin({ intentId: "frozen", objective: "bounded", projectRoot, worktreePath, baseHead: (await git(["rev-parse", "HEAD"])).stdout.trim(), branch: "captain/task", commonGitDir: path.join(projectRoot, ".git"), gitDir: path.join(projectRoot, ".git/worktrees/task"), policy: { profile: "feature", visualRequired: false, commands: {}, approvedPlans: [{ path: "Docs/Plan.md", sha256: createHash("sha256").update("Frozen scope\n").digest("hex") }] } });
  async function hook(tool_name: string, tool_input: object, turn_id = "t") {
    return new Promise<any>((resolve, reject) => {
      const child = spawn(process.execPath, [path.resolve(import.meta.dirname, "../scripts/mutation-gate.mjs")], { env: { ...process.env, PLUGIN_DATA: data }, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
      let output = "", errors = ""; child.stdout.on("data", chunk => output += chunk); child.stderr.on("data", chunk => errors += chunk);
      child.on("error", reject); child.on("exit", code => code === 0 ? resolve(output ? JSON.parse(output) : {}) : reject(new Error(errors)));
      child.stdin.end(JSON.stringify({ cwd: worktreePath, session_id: "s", turn_id, tool_name, tool_input }));
    });
  }
  for (const tool of ["Edit", "Write"]) assert.equal((await hook(tool, { file_path: "Docs/Plan.md", content: "new scope" })).hookSpecificOutput?.permissionDecision, "deny");
  for (const patch of ["*** Update File: Docs/Plan.md", "*** Update File: Docs/new.md\n*** Move to: Docs/Plan.md"])
    assert.equal((await hook("apply_patch", { patch })).hookSpecificOutput?.permissionDecision, "deny");
  assert.deepEqual(await hook("Write", { file_path: "Docs/progress.md", content: "progress" }), {});
  assert.deepEqual(await hook("Write", { file_path: "Docs/Plan.md", content: "legacy unbound" }, "unbound"), {});
});
