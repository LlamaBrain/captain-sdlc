import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { mutationDecision } from "../src/policy.js";
import { LifecycleStore } from "../src/lifecycle.js";
import { writeAuthorized } from "../src/authority.js";
import { activeRunForSession } from "../scripts/authoritative-state.mjs";

const root = path.resolve(import.meta.dirname, "..");
function decision(operation: string, phase: string, intentId = "owned", sessionId = "s") {
  return mutationDecision({ toolName: `mcp__captain-sdlc__captain_${operation}`, cwd: root,
    sessionId, intentId, permit: { sessionId: "s", worktreePath: root, phase, intentId: "owned" } });
}
test("HITL review requires the owned run and review phase", () => {
  assert.equal(decision("record_plan_review", "hitl").allow, true);
  for (const phase of ["tdd_red", "implement", "prove", "complete"]) assert.equal(decision("record_plan_review", phase).allow, false);
  assert.equal(decision("record_plan_review", "hitl", "other").allow, false);
  assert.equal(decision("record_plan_review", "hitl", "owned", "other").allow, false);
  assert.equal(mutationDecision({ toolName: "apply_patch", cwd: root, sessionId: "s", permit: { sessionId: "s", worktreePath: root, phase: "hitl", intentId: "owned" }, command: `*** Update File: ${path.join(root, "src/example.ts")}` }).allow, false);
});
test("pause is available throughout owned active work and doctor needs no permit", () => {
  for (const phase of ["tdd_red", "implement", "prove", "hitl"]) {
    assert.equal(decision("pause_implementation", phase).allow, true);
    assert.equal(decision("pause_implementation", phase, "other").allow, false);
  }
  assert.equal(decision("pause_implementation", "complete").allow, false);
  assert.equal(mutationDecision({ toolName: "mcp__captain-sdlc__captain_doctor", cwd: root, sessionId: "s", permit: null }).allow, true);
});
async function fixture() {
  const data = await mkdtemp(path.join(tmpdir(), "captain-hitl-hooks-")), worktreePath = path.join(data, ".captain-sdlc/worktrees/worktree");
  await mkdir(worktreePath, { recursive: true });
  const store = new LifecycleStore(data, async () => ({ exitCode: 0, stdout: "", stderr: "" }));
  await store.markIntent({ intentId: "owned", sessionId: "s", turnId: "t", projectRoot: data, prompt: "start" });
  await store.begin({ intentId: "owned", objective: "frozen task", projectRoot: data, worktreePath, baseHead: "a".repeat(40), branch: "captain/worktree", commonGitDir: path.join(data, ".git"), gitDir: path.join(data, ".git/worktrees/worktree"), policy: { profile: "feature", visualRequired: false, commands: {} } });
  return { data, worktreePath, store };
}
async function completionHook(data: string, cwd: string, turnId = "t") {
  return new Promise<any>((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, "scripts/completion-gate.mjs")], { windowsHide: true, env: { ...process.env, PLUGIN_DATA: data }, stdio: ["pipe", "pipe", "pipe"] });
    let output = "", errors = "";
    child.stdout.on("data", chunk => output += chunk); child.stderr.on("data", chunk => errors += chunk);
    child.on("error", reject); child.on("exit", code => code === 0 ? resolve(output ? JSON.parse(output) : {}) : reject(new Error(errors)));
    child.stdin.end(JSON.stringify({ cwd, session_id: "s", turn_id: turnId }));
  });
}
test("Stop yields for declared HITL without claiming task acceptance", async () => {
  const f = await fixture(), run = await f.store.status("owned");
  await (f.store as any).update({ ...run, phase: "hitl", status: "running" });
  const output = await completionHook(f.data, f.worktreePath);
  assert.notEqual(output.decision, "block");
  assert.match(output.systemMessage, /human|HITL/i);
  assert.match(output.systemMessage, /not.*(?:accept|complet)|pending/i);
  await writeAuthorized(f.data, "turns", "s-unknown", { implementationRequired: true });
  assert.equal((await completionHook(f.data, f.worktreePath, "unknown")).decision, "block");
});
test("Stop still blocks unfinished automated proof", async () => {
  const f = await fixture();
  assert.equal((await completionHook(f.data, f.worktreePath)).decision, "block");
});
test("resumed task remains discoverable through its current activation lease", async () => {
  const f = await fixture();
  await f.store.pause("owned", { summary: "handoff", nextSteps: ["continue same task"] });
  await f.store.markIntent({ intentId: "resume", sessionId: "s", turnId: "next", projectRoot: f.data, prompt: "continue", resumeOf: "owned" });
  const resumed = await f.store.resume("resume");
  assert.notEqual(resumed.activationToken, resumed.operationToken);
  assert.equal((await activeRunForSession(f.data, "s"))?.intentId, "owned");
});
