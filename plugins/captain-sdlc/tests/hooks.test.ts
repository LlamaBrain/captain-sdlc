import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { writeAuthorized } from "../src/authority.js";
const root = path.resolve(import.meta.dirname, "..");
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

test("mutation hook blocks before permit and allows the same turn in the owned worktree", async () => {
  const data = await mkdtemp(path.join(tmpdir(), "captain-hook-"));
  const denied = await hook("mutation-gate.mjs", { session_id: "s", turn_id: "t", cwd: "C:/repo", tool_name: "apply_patch", tool_input: { command: "*** Update File: C:/repo/x.ts" } }, data);
  assert.equal(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecision, "deny");
  await writeAuthorized(data, "permits", "s-t", { sessionId: "s", turnId: "t", worktreePath: "C:/repo/.captain-sdlc/worktrees/x", phase: "implement", intentId: "i" });
  const allowed = await hook("mutation-gate.mjs", { session_id: "s", turn_id: "t", cwd: "C:/repo/.captain-sdlc/worktrees/x", tool_name: "apply_patch", tool_input: { command: "*** Update File: C:/repo/.captain-sdlc/worktrees/x/a.ts" } }, data);
  assert.equal(allowed.stdout, "");
});

test("stop hook continues an incomplete governed turn", async () => {
  const data = await mkdtemp(path.join(tmpdir(), "captain-hook-"));
  await writeAuthorized(data, "permits", "s-t", { intentId: "i" });
  await writeAuthorized(data, "runs", "i", { phase: "prove", status: "running" });
  const result = await hook("completion-gate.mjs", { session_id: "s", turn_id: "t" }, data);
  assert.equal(JSON.parse(result.stdout).decision, "block");
});

test("stop hook blocks an implementation intent that never began", async () => {
  const data = await mkdtemp(path.join(tmpdir(), "captain-hook-"));
  await hook("user-prompt.mjs", { session_id: "s", turn_id: "t", cwd: "C:/repo", prompt: "implement x" }, data);
  const result = await hook("completion-gate.mjs", { session_id: "s", turn_id: "t" }, data);
  assert.equal(JSON.parse(result.stdout).decision, "block");
});

test("forged permit state is rejected", async () => {
  const data = await mkdtemp(path.join(tmpdir(), "captain-hook-")); await writeAuthorized(data, "permits", "s-t", { sessionId: "s", turnId: "t", worktreePath: "C:/safe", phase: "implement" });
  const permitPath = path.join(data, "permits", "s-t.json"), envelope = JSON.parse(await readFile(permitPath, "utf8")); envelope.payload.worktreePath = "C:/forged"; await writeFile(permitPath, JSON.stringify(envelope));
  const result = await hook("mutation-gate.mjs", { session_id: "s", turn_id: "t", cwd: "C:/forged", tool_name: "apply_patch", tool_input: { command: "*** Update File: C:/forged/a.ts" } }, data);
  assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision, "deny");
});
