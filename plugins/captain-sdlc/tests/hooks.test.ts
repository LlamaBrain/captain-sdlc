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
import { repositoryUsesLowStrictness } from "../scripts/governed-repository.mjs";
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
    const executable = process.platform === "win32" && process.env.CAPTAIN_TEST_WINDOWS_LAUNCHER === "1" ? path.join(root, "bin", "captain-hook.exe") : process.execPath;
    const child = spawn(executable, [path.join(root, "scripts", script)], { env: { ...process.env, PLUGIN_DATA: data }, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = ""; child.stdout.on("data", chunk => stdout += chunk); child.stderr.on("data", chunk => stderr += chunk);
    child.on("error", reject); child.on("exit", code => code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`hook exited ${code}: ${stderr}`)));
    child.stdin.end(JSON.stringify(input));
  });
}

async function hookControl(action: "on" | "off" | "status", data: string) {
  const result = await exec(process.execPath, [path.join(root, "scripts", "hook-control.mjs"), action], { env: { ...process.env, PLUGIN_DATA: data } });
  return JSON.parse(result.stdout);
}

test("runtime hook control bypasses every Captain hook until restored", async () => {
  const data = await mkdtemp(path.join(tmpdir(), "captain-hook-"));
  assert.equal((await hookControl("off", data)).enabled, false);
  assert.equal((await hook("user-prompt.mjs", { session_id: "s", turn_id: "t", cwd: "C:/repo", prompt: "implement x\n[Captain plan: X]" }, data)).stdout, "");
  assert.equal((await hookControl("on", data)).enabled, true);
  const result = await hook("user-prompt.mjs", { session_id: "s", turn_id: "t2", cwd: "C:/repo", prompt: "implement x\n[Captain plan: X]" }, data);
  assert.match(result.stdout, /captain_begin_implementation/);
});

test("low merge strictness bypasses intent, mutation, and completion hooks", async () => {
  const data = await mkdtemp(path.join(tmpdir(), "captain-hook-")), repo = await mkdtemp(path.join(tmpdir(), "captain-low-strict-"));
  await exec("git", ["init"], { cwd: repo }); await exec("git", ["config", "user.name", "Captain Test"], { cwd: repo }); await exec("git", ["config", "user.email", "captain@example.invalid"], { cwd: repo });
  await mkdir(path.join(repo, ".captain-sdlc")); await writeFile(path.join(repo, ".captain-sdlc", "merge-policy.json"), JSON.stringify({ schema_version: 1, strictness: "low" })); await exec("git", ["add", "."], { cwd: repo }); await exec("git", ["commit", "-m", "baseline"], { cwd: repo });
  assert.equal(await repositoryUsesLowStrictness(repo), true);
  assert.equal((await hook("user-prompt.mjs", { session_id: "s", turn_id: "t", cwd: repo, prompt: "implement x" }, data)).stdout, "");
  assert.equal((await hook("mutation-gate.mjs", { session_id: "s", turn_id: "t", cwd: repo, tool_name: "apply_patch", tool_input: { command: `*** Update File: ${path.join(repo, "x.ts")}` } }, data)).stdout, "");
  await writeFile(path.join(repo, "x.ts"), "changed\n");
  assert.equal((await hook("completion-gate.mjs", { session_id: "s", turn_id: "t" , cwd: repo }, data)).stdout, "");
});

test("low merge strictness permits a clean turn without claiming task proof", async () => {
  const data = await mkdtemp(path.join(tmpdir(), "captain-hook-")), repo = await mkdtemp(path.join(tmpdir(), "captain-low-strict-empty-"));
  await exec("git", ["init"], { cwd: repo }); await exec("git", ["config", "user.name", "Captain Test"], { cwd: repo }); await exec("git", ["config", "user.email", "captain@example.invalid"], { cwd: repo });
  await mkdir(path.join(repo, ".captain-sdlc")); await writeFile(path.join(repo, ".captain-sdlc", "merge-policy.json"), JSON.stringify({ schema_version: 1, strictness: "low" })); await writeFile(path.join(repo, "baseline.txt"), "baseline\n"); await exec("git", ["add", "."], { cwd: repo }); await exec("git", ["commit", "-m", "baseline"], { cwd: repo });
  await hook("user-prompt.mjs", { session_id: "s", turn_id: "t", cwd: repo, prompt: "implement x\n[Captain plan: X]" }, data);
  const result = await hook("completion-gate.mjs", { session_id: "s", turn_id: "t", cwd: repo }, data);
  assert.equal(result.stdout, "");
});

test("low workflow captures explicit approval and restores it on a later prompt", async () => {
  const data = await mkdtemp(path.join(tmpdir(), "captain-approval-hook-")), repo = await mkdtemp(path.join(tmpdir(), "captain-approval-repo-"));
  await exec("git", ["init"], { cwd: repo }); await exec("git", ["config", "user.name", "Captain Test"], { cwd: repo }); await exec("git", ["config", "user.email", "captain@example.invalid"], { cwd: repo });
  await mkdir(path.join(repo, ".captain-sdlc")); await writeFile(path.join(repo, ".captain-sdlc", "merge-policy.json"), JSON.stringify({ schema_version: 1, strictness: "low" })); await exec("git", ["add", "."], { cwd: repo }); await exec("git", ["commit", "-m", "baseline"], { cwd: repo });
  const approved = await hook("user-prompt.mjs", { session_id: "s", turn_id: "approval", cwd: repo, prompt: "commit it" }, data);
  assert.match(JSON.parse(approved.stdout).hookSpecificOutput.additionalContext, /commit it/);
  const later = await hook("user-prompt.mjs", { session_id: "s", turn_id: "continued", cwd: repo, prompt: "continue" }, data);
  const context = JSON.parse(later.stdout).hookSpecificOutput.additionalContext;
  assert.match(context, /commit it/); assert.match(context, /approval/); assert.match(context, /do not ask for the same approval again/);
  const revoked = await hook("user-prompt.mjs", { session_id: "s", turn_id: "revoked", cwd: repo, prompt: "don't commit" }, data);
  assert.match(JSON.parse(revoked.stdout).hookSpecificOutput.additionalContext, /revoke/);
});

test("prompt hook injects the mandatory MCP entrypoint", async () => {
  const data = await mkdtemp(path.join(tmpdir(), "captain-hook-"));
  const result = await hook("user-prompt.mjs", { session_id: "s", turn_id: "t", cwd: "C:/repo", prompt: "implement inventory\n[Captain plan: INVENTORY]" }, data);
  const output = JSON.parse(result.stdout);
  assert.match(output.hookSpecificOutput.additionalContext, /captain_begin_implementation/);
  assert.match(output.hookSpecificOutput.additionalContext, /intent-[0-9a-f-]+/);
});

test("approval history does not break prompts outside a Git checkout", async () => {
  const data = await mkdtemp(path.join(tmpdir(), "captain-approval-outside-")), repo = await mkdtemp(path.join(tmpdir(), "captain-approval-source-")), outside = await mkdtemp(path.join(tmpdir(), "captain-not-a-repo-"));
  await exec("git", ["init"], { cwd: repo });
  await hook("user-prompt.mjs", { session_id: "s", turn_id: "approval", cwd: repo, prompt: "commit it" }, data);
  const result = await hook("user-prompt.mjs", { session_id: "s", turn_id: "outside", cwd: outside, prompt: "hello" }, data);
  assert.equal(result.stdout, "");
  const unbound = await hook("user-prompt.mjs", { session_id: "s", turn_id: "unbound", cwd: outside, prompt: "commit it" }, data);
  assert.doesNotMatch(unbound.stdout, /CAPTAIN USER AUTHORIZATION/);
});

test("hooks defer to the normal workflow when committed HEAD has no Captain policy", async () => {
  const data = await mkdtemp(path.join(tmpdir(), "captain-hook-")), repo = await mkdtemp(path.join(tmpdir(), "captain-ungoverned-"));
  await exec("git", ["init"], { cwd: repo }); await exec("git", ["config", "user.name", "Captain Test"], { cwd: repo }); await exec("git", ["config", "user.email", "captain@example.invalid"], { cwd: repo });
  await writeFile(path.join(repo, "baseline.txt"), "baseline"); await exec("git", ["add", "."], { cwd: repo }); await exec("git", ["commit", "-m", "baseline"], { cwd: repo });
  const prompt = await hook("user-prompt.mjs", { session_id: "s", turn_id: "t", cwd: repo, prompt: "continue the merges" }, data);
  assert.equal(prompt.stdout, "");
  const mutation = await hook("mutation-gate.mjs", { session_id: "s", turn_id: "t", cwd: repo, tool_name: "apply_patch", tool_input: { patch: `*** Update File: ${path.join(repo, "baseline.txt")}` } }, data);
  assert.equal(mutation.stdout, "");
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
  await writeFile(path.join(repo, "baseline.txt"), "baseline"); await mkdir(path.join(repo, ".captain-sdlc")); await writeFile(path.join(repo, ".captain-sdlc", "codex-policy.json"), "{}"); await exec("git", ["add", "."], { cwd: repo }); await exec("git", ["commit", "-m", "baseline"], { cwd: repo }); await exec("git", ["branch", "colony/spike"], { cwd: repo });
  const oid = (await exec("git", ["rev-parse", "refs/heads/colony/spike"], { cwd: repo })).stdout.trim();
  const result = await hook("user-prompt.mjs", { session_id: "s", turn_id: "t", cwd: repo, prompt: "integrate everything\n[Captain plan: COLONY]\n[Captain target: COLONY/SPIKE]" }, data), output = JSON.parse(result.stdout);
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
  const result = await hook("completion-gate.mjs", { session_id: "s", turn_id: "t", cwd: projectRoot }, data);
  assert.equal(JSON.parse(result.stdout).decision, "block");
});

test("stop hook blocks an implementation intent that never began", async () => {
  const data = await mkdtemp(path.join(tmpdir(), "captain-hook-"));
  await hook("user-prompt.mjs", { session_id: "s", turn_id: "t", cwd: "C:/repo", prompt: "implement x\n[Captain plan: X]" }, data);
  const result = await hook("completion-gate.mjs", { session_id: "s", turn_id: "t", cwd: "C:/repo" }, data);
  assert.equal(JSON.parse(result.stdout).decision, "block");
});

test("prompt hook self-heals a stale active pointer to a green run", async () => {
  const data = await mkdtemp(path.join(tmpdir(), "captain-hook-"));
  await writeAuthorized(data, "active", "s", { intentId: "completed" });
  const completed = { schemaVersion: 1, revision: 0, runId: "run", operationToken: "operation", intentId: "completed", sessionId: "s", turnId: "prior", objective: "done", projectRoot: "C:/repo", worktreePath: "C:/repo/.captain-sdlc/worktrees/done", baseHead: "a".repeat(40), branch: "captain/done", commonGitDir: "C:/repo/.git", gitDir: "C:/repo/.git/worktrees/done", profile: "feature", visualRequired: false, startedAt: new Date().toISOString(), phase: "complete", status: "green", policy: hookPolicy, evidence: [] }; await writeAuthorized(data, "run-revisions", "completed-0", completed); await writeAuthorized(data, "run-watermarks", "completed-0", { schemaVersion: 1, intentId: "completed", runId: "run", revision: 0, runSha256: createHash("sha256").update(JSON.stringify(completed)).digest("hex") });
  const result = await hook("user-prompt.mjs", { session_id: "s", turn_id: "next", cwd: "C:/repo", prompt: "implement y\n[Captain plan: Y]" }, data), output = JSON.parse(result.stdout);
  assert.match(output.hookSpecificOutput.additionalContext, /captain_begin_implementation/);
  assert.doesNotMatch(output.hookSpecificOutput.additionalContext, /captain_resume_implementation/);
  assert.equal((await readAuthorized<any>(data, "active", "s")).intentId, "completed");
});

test("prompt hook derives the active run from authenticated latest revisions", async () => {
  const data = await mkdtemp(path.join(tmpdir(), "captain-hook-")), projectRoot = await mkdtemp(path.join(tmpdir(), "captain-hook-root-")), worktree = path.join(projectRoot, ".captain-sdlc", "worktrees", "active"); await seedActive(data, projectRoot, worktree, "active", "s", "prior"); await writeAuthorized(data, "active", "s", { intentId: "forged-stale-projection" });
  const result = await hook("user-prompt.mjs", { session_id: "s", turn_id: "next", cwd: projectRoot, prompt: "continue the implementation" }, data), output = JSON.parse(result.stdout); assert.match(output.hookSpecificOutput.additionalContext, /captain_resume_implementation/); assert.match(output.hookSpecificOutput.additionalContext, /active/);
});

test("prompt hook mints a cross-session token for an explicit signed resume directive", async () => {
  const data = await mkdtemp(path.join(tmpdir(), "captain-hook-")), projectRoot = await mkdtemp(path.join(tmpdir(), "captain-handoff-root-")), intentId = "intent-12345678-1234-1234-1234-123456789abc", worktree = path.join(projectRoot, ".captain-sdlc", "worktrees", "handoff");
  await seedActive(data, projectRoot, worktree, intentId, "agent-a", "prior");
  const result = await hook("user-prompt.mjs", { session_id: "agent-b", turn_id: "resume-turn", cwd: projectRoot, prompt: `[Captain resume: ${intentId}]` }, data), output = JSON.parse(result.stdout), resumeIntentId = /resume_intent_id=(intent-[0-9a-f-]+)/.exec(output.hookSpecificOutput.additionalContext)![1], intent = await readAuthorized<any>(data, "intents", resumeIntentId);
  assert.match(output.hookSpecificOutput.additionalContext, /captain_resume_implementation/);
  assert.equal(intent.resumeOf, intentId);
  assert.equal(intent.projectRoot, projectRoot);
  assert.equal(intent.sessionId, "agent-b");
});

test("forged permit state is rejected", async () => {
  const data = await mkdtemp(path.join(tmpdir(), "captain-hook-")), projectRoot = await mkdtemp(path.join(tmpdir(), "captain-hook-root-")), worktree = path.join(projectRoot, ".captain-sdlc", "worktrees", "safe"); await seedActive(data, projectRoot, worktree);
  const permitPath = path.join(data, "permits", "s-t.json"), envelope = JSON.parse(await readFile(permitPath, "utf8")); envelope.payload.worktreePath = "C:/forged"; await writeFile(permitPath, JSON.stringify(envelope));
  const result = await hook("mutation-gate.mjs", { session_id: "s", turn_id: "t", cwd: "C:/forged", tool_name: "apply_patch", tool_input: { command: "*** Update File: C:/forged/a.ts" } }, data);
  assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision, "deny");
});
