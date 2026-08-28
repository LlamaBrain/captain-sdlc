import assert from "node:assert/strict";
import test from "node:test";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { readAuthorized, writeAuthorized } from "../src/authority.js";
import { LifecycleStore } from "../src/lifecycle.js";
const exec = promisify(execFile);
const root = path.resolve(import.meta.dirname, "..");
const hookPolicy = { profile: "feature" as const, visualRequired: false, commands: { ticket: "ticket" }, redGate: { expectedExitCodes: [1], outputPattern: "ticket" } };
async function seedActive(data: string, projectRoot: string, worktreePath: string, intentId = "i", sessionId = "s", turnId = "t") {
  const commonGitDir = path.join(projectRoot, ".git"), gitDir = path.join(commonGitDir, "worktrees", path.basename(worktreePath)), branch = `captain/${path.basename(worktreePath)}`, head = "a".repeat(40); await mkdir(worktreePath, { recursive: true });
  const store = new LifecycleStore(data, async command => ({ exitCode: command === "ticket" ? 1 : 0, stdout: command, stderr: "" }), async () => ({ head, tree: "c".repeat(40), status: "", branch, branchHead: head, commonGitDir, topLevel: worktreePath, gitDir }));
  await store.markIntent({ intentId, sessionId, turnId, projectRoot, prompt: "implement" }); await store.begin({ intentId, objective: "implement", projectRoot, worktreePath, baseHead: head, branch, commonGitDir, gitDir, policy: hookPolicy }); await store.recordRed(intentId, "ticket"); return store;
}
async function hook(script: string, input: object, data: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, "scripts", script)], { env: { ...process.env, PLUGIN_DATA: data }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = ""; child.stdout.on("data", chunk => stdout += chunk); child.stderr.on("data", chunk => stderr += chunk);
    child.on("error", reject); child.on("exit", code => code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`hook exited ${code}: ${stderr}`)));
    child.stdin.end(JSON.stringify(input));
  });
}

test("prompt hook injects the mandatory MCP entrypoint", async () => {
  const data = await mkdtemp(path.join(tmpdir(), "captain-hook-"));
  const result = await hook("user-prompt.mjs", { session_id: "s", turn_id: "t", cwd: "C:/repo", prompt: "implement inventory" }, data);
  const output = JSON.parse(result.stdout);
  assert.match(output.hookSpecificOutput.additionalContext, /captain_begin_implementation/);
  assert.match(output.hookSpecificOutput.additionalContext, /intent-[0-9a-f-]+/);
});

test("prompt hook retries the unique incomplete begin instead of minting a competing intent", async () => {
  const data = await mkdtemp(path.join(tmpdir(), "captain-hook-")), operation = { schemaVersion: 1, intentId: "intent-existing", operationToken: "operation-token", leaseToken: "lease-token", runId: "codex-run", startedAt: new Date().toISOString(), sessionId: "s", turnId: "prior", projectRoot: "C:/repo", objective: "implement inventory" };
  await writeAuthorized(data, "begin-operations", operation.intentId, operation);
  const result = await hook("user-prompt.mjs", { session_id: "s", turn_id: "next", cwd: "C:/repo", prompt: "continue" }, data), output = JSON.parse(result.stdout);
  assert.match(output.hookSpecificOutput.additionalContext, /captain_begin_implementation/);
  assert.match(output.hookSpecificOutput.additionalContext, /intent_id=intent-existing/);
  assert.match(output.hookSpecificOutput.additionalContext, /Do not mint or use a competing intent/);
  assert.equal((await readAuthorized<any>(data, "begin-turn-resumes", operation.operationToken)).turnId, "next");
});

test("prompt hook binds an explicit target branch and full oid into the signed intent", async () => {
  const data = await mkdtemp(path.join(tmpdir(), "captain-hook-")), repo = await mkdtemp(path.join(tmpdir(), "captain-target-"));
  await exec("git", ["init"], { cwd: repo }); await exec("git", ["config", "user.name", "Captain Test"], { cwd: repo }); await exec("git", ["config", "user.email", "captain@example.invalid"], { cwd: repo });
  await writeFile(path.join(repo, "baseline.txt"), "baseline"); await exec("git", ["add", "."], { cwd: repo }); await exec("git", ["commit", "-m", "baseline"], { cwd: repo }); await exec("git", ["branch", "colony/spike"], { cwd: repo });
  const oid = (await exec("git", ["rev-parse", "refs/heads/colony/spike"], { cwd: repo })).stdout.trim();
  const result = await hook("user-prompt.mjs", { session_id: "s", turn_id: "t", cwd: repo, prompt: "integrate everything\n[Captain target: COLONY/SPIKE]" }, data), output = JSON.parse(result.stdout);
  const intentId = /intent-[0-9a-f-]+/.exec(output.hookSpecificOutput.additionalContext)![0], intent = await readAuthorized<any>(data, "intents", intentId);
  assert.equal(intent.targetBranch, "colony/spike"); assert.equal(intent.targetOid, oid); assert.equal(intent.projectRoot, path.resolve(repo));
});

test("mutation hook blocks before permit and allows the same turn in the owned worktree", async () => {
  const data = await mkdtemp(path.join(tmpdir(), "captain-hook-")), projectRoot = await mkdtemp(path.join(tmpdir(), "captain-owned-root-")), worktreePath = path.join(projectRoot, ".captain-sdlc", "worktrees", "owned");
  const denied = await hook("mutation-gate.mjs", { session_id: "s", turn_id: "t", cwd: "C:/repo", tool_name: "apply_patch", tool_input: { command: "*** Update File: C:/repo/x.ts" } }, data);
  assert.equal(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecision, "deny");
  await seedActive(data, projectRoot, worktreePath);
  const allowed = await hook("mutation-gate.mjs", { session_id: "s", turn_id: "t", cwd: worktreePath, tool_name: "apply_patch", tool_input: { command: `*** Update File: ${path.join(worktreePath, "a.ts")}` } }, data);
  assert.equal(allowed.stdout, "");
});

test("mutation hook rejects a signed permit whose run revision is historical", async () => {
  const data = await mkdtemp(path.join(tmpdir(), "captain-hook-")), projectRoot = await mkdtemp(path.join(tmpdir(), "captain-owned-root-")), worktreePath = path.join(projectRoot, ".captain-sdlc", "worktrees", "stale"), store = await seedActive(data, projectRoot, worktreePath, "stale"); const historical = await readAuthorized<any>(data, "permits", "s-t");
  await store.runCheck("stale", "ticket"); await writeAuthorized(data, "permits", "s-t", historical); const result = await hook("mutation-gate.mjs", { session_id: "s", turn_id: "t", cwd: worktreePath, tool_name: "apply_patch", tool_input: { command: `*** Update File: ${path.join(worktreePath, "a.ts")}` } }, data);
  assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision, "deny");
});

test("mutation hook admits terminal final-commit recovery from authoritative prove phase", async () => {
  const data = await mkdtemp(path.join(tmpdir(), "captain-hook-")), projectRoot = await mkdtemp(path.join(tmpdir(), "captain-owned-root-")), worktreePath = path.join(projectRoot, ".captain-sdlc", "worktrees", "terminal"), store = await seedActive(data, projectRoot, worktreePath, "terminal");
  const current = await store.status("terminal"), terminal = { ...current, revision: current.revision + 1, previousRevisionSha256: createHash("sha256").update(JSON.stringify(current)).digest("hex"), phase: "prove", terminalCommit: { requestSha256: "b".repeat(64), commitLeaseId: "lease", commitLeaseToken: "token", candidate: "d".repeat(40), outcome: "committed", final: true, commit: { head: "d".repeat(40), commitCount: 1, clean: true, subject: "fix(x): recover (v1.0.1)", versionChanged: true, changelogChanged: true } } };
  await writeAuthorized(data, "run-revisions", `terminal-${terminal.revision}`, terminal);
  await writeAuthorized(data, "run-watermarks", `terminal-${terminal.revision}`, { schemaVersion: 1, intentId: "terminal", runId: terminal.runId, revision: terminal.revision, runSha256: createHash("sha256").update(JSON.stringify(terminal)).digest("hex"), previousRevisionSha256: terminal.previousRevisionSha256 });
  const permit = await readAuthorized<any>(data, "permits", "s-t"); await writeAuthorized(data, "permits", "s-t", { ...permit, phase: "prove", runRevision: terminal.revision });
  const result = await hook("mutation-gate.mjs", { session_id: "s", turn_id: "t", cwd: worktreePath, tool_name: "mcp__captain-sdlc__captain_commit", tool_input: { intent_id: "terminal", paths: ["VERSION"], subject: "fix(x): recover (v1.0.1)", final: true } }, data);
  assert.equal(result.stdout, "");
});

test("mutation hook rejects an existing target symlink and a junction ancestor", async () => {
  const data = await mkdtemp(path.join(tmpdir(), "captain-hook-")), projectRoot = await mkdtemp(path.join(tmpdir(), "captain-hook-root-")), repo = path.join(projectRoot, ".captain-sdlc", "worktrees", "repo"), outside = await mkdtemp(path.join(tmpdir(), "captain-hook-outside-"));
  await seedActive(data, projectRoot, repo);
  await writeFile(path.join(outside, "outside.txt"), "outside"); await symlink(outside, path.join(repo, "junction"), "junction");
  let result = await hook("mutation-gate.mjs", { session_id: "s", turn_id: "t", cwd: repo, tool_name: "apply_patch", tool_input: { patch: `*** Delete File: ${path.join(repo, "junction")}` } }, data);
  assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision, "deny");
  const caseVariantRoot = process.platform === "win32" ? repo.toUpperCase() : repo;
  result = await hook("mutation-gate.mjs", { session_id: "s", turn_id: "t", cwd: repo, tool_name: "apply_patch", tool_input: { patch: `*** Update File: ${path.join(caseVariantRoot, "junction", "outside.txt")}` } }, data);
  assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision, "deny");
});

test("stop hook continues an incomplete governed turn", async () => {
  const data = await mkdtemp(path.join(tmpdir(), "captain-hook-")), projectRoot = await mkdtemp(path.join(tmpdir(), "captain-hook-root-")), worktree = path.join(projectRoot, ".captain-sdlc", "worktrees", "stop"); await seedActive(data, projectRoot, worktree);
  const result = await hook("completion-gate.mjs", { session_id: "s", turn_id: "t" }, data);
  assert.equal(JSON.parse(result.stdout).decision, "block");
});

test("stop hook blocks an implementation intent that never began", async () => {
  const data = await mkdtemp(path.join(tmpdir(), "captain-hook-"));
  await hook("user-prompt.mjs", { session_id: "s", turn_id: "t", cwd: "C:/repo", prompt: "implement x" }, data);
  const result = await hook("completion-gate.mjs", { session_id: "s", turn_id: "t" }, data);
  assert.equal(JSON.parse(result.stdout).decision, "block");
});

test("prompt hook self-heals a stale active pointer to a green run", async () => {
  const data = await mkdtemp(path.join(tmpdir(), "captain-hook-"));
  await writeAuthorized(data, "active", "s", { intentId: "completed" });
  const completed = { schemaVersion: 1, revision: 0, runId: "run", operationToken: "operation", intentId: "completed", sessionId: "s", turnId: "prior", objective: "done", projectRoot: "C:/repo", worktreePath: "C:/repo/.captain-sdlc/worktrees/done", baseHead: "a".repeat(40), branch: "captain/done", commonGitDir: "C:/repo/.git", gitDir: "C:/repo/.git/worktrees/done", profile: "feature", visualRequired: false, startedAt: new Date().toISOString(), phase: "complete", status: "green", policy: hookPolicy, evidence: [] }; await writeAuthorized(data, "run-revisions", "completed-0", completed); await writeAuthorized(data, "run-watermarks", "completed-0", { schemaVersion: 1, intentId: "completed", runId: "run", revision: 0, runSha256: createHash("sha256").update(JSON.stringify(completed)).digest("hex") });
  const result = await hook("user-prompt.mjs", { session_id: "s", turn_id: "next", cwd: "C:/repo", prompt: "implement y" }, data), output = JSON.parse(result.stdout);
  assert.match(output.hookSpecificOutput.additionalContext, /captain_begin_implementation/);
  assert.doesNotMatch(output.hookSpecificOutput.additionalContext, /captain_resume_implementation/);
  assert.equal((await readAuthorized<any>(data, "active", "s")).intentId, "completed");
});

test("prompt hook derives the active run from authenticated latest revisions", async () => {
  const data = await mkdtemp(path.join(tmpdir(), "captain-hook-")), projectRoot = await mkdtemp(path.join(tmpdir(), "captain-hook-root-")), worktree = path.join(projectRoot, ".captain-sdlc", "worktrees", "active"); await seedActive(data, projectRoot, worktree, "active", "s", "prior"); await writeAuthorized(data, "active", "s", { intentId: "forged-stale-projection" });
  const result = await hook("user-prompt.mjs", { session_id: "s", turn_id: "next", cwd: projectRoot, prompt: "continue the implementation" }, data), output = JSON.parse(result.stdout); assert.match(output.hookSpecificOutput.additionalContext, /captain_resume_implementation/); assert.match(output.hookSpecificOutput.additionalContext, /active/);
});

test("forged permit state is rejected", async () => {
  const data = await mkdtemp(path.join(tmpdir(), "captain-hook-")), projectRoot = await mkdtemp(path.join(tmpdir(), "captain-hook-root-")), worktree = path.join(projectRoot, ".captain-sdlc", "worktrees", "safe"); await seedActive(data, projectRoot, worktree);
  const permitPath = path.join(data, "permits", "s-t.json"), envelope = JSON.parse(await readFile(permitPath, "utf8")); envelope.payload.worktreePath = "C:/forged"; await writeFile(permitPath, JSON.stringify(envelope));
  const result = await hook("mutation-gate.mjs", { session_id: "s", turn_id: "t", cwd: "C:/forged", tool_name: "apply_patch", tool_input: { command: "*** Update File: C:/forged/a.ts" } }, data);
  assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision, "deny");
});
