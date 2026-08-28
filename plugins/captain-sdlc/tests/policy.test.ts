import assert from "node:assert/strict";
import test from "node:test";
import { mutationDecision } from "../src/policy.js";

test("denies mutation before a same-turn Captain permit", () => {
  assert.equal(mutationDecision({ toolName: "apply_patch", cwd: "C:/repo", sessionId: "s", permit: null, command: "*** Update File: C:/repo/x.ts" }).allow, false);
});

test("denies permit reuse from another turn and mutation outside owned worktree", () => {
  const permit = { sessionId: "s", worktreePath: "C:/repo/.captain-sdlc/worktrees/x", phase: "implement" };
  assert.equal(mutationDecision({ toolName: "apply_patch", cwd: permit.worktreePath, sessionId: "other", permit, command: "*** Update File: C:/repo/.captain-sdlc/worktrees/x/a.ts" }).allow, false);
  assert.equal(mutationDecision({ toolName: "apply_patch", cwd: permit.worktreePath, sessionId: "s", permit, command: "*** Update File: C:/repo/outside.ts" }).allow, false);
  assert.equal(mutationDecision({ toolName: "apply_patch", cwd: permit.worktreePath, sessionId: "s", permit, command: "*** Update File: C:/repo/.captain-sdlc/worktrees/x/a.ts" }).allow, true);
});

test("read-only tools remain available before Captain begins", () => {
  assert.equal(mutationDecision({ toolName: "view_image", cwd: "C:/repo", sessionId: "s", permit: null }).allow, true);
});

test("audited merge preparation is allowed only for an owned implementation permit", () => {
  const toolName = "mcp__captain-sdlc__captain_prepare_merge", worktreePath = "C:/repo/.captain-sdlc/worktrees/x";
  assert.equal(mutationDecision({ toolName, cwd: worktreePath, sessionId: "s", permit: null }).allow, false);
  assert.equal(mutationDecision({ toolName, cwd: worktreePath, sessionId: "s", intentId: "i", permit: { sessionId: "s", worktreePath, phase: "tdd_red", intentId: "i" } }).allow, false);
  assert.equal(mutationDecision({ toolName, cwd: worktreePath, sessionId: "s", intentId: "other", permit: { sessionId: "s", worktreePath, phase: "implement", intentId: "i" } }).allow, false);
  assert.equal(mutationDecision({ toolName, cwd: worktreePath, sessionId: "s", intentId: "i", permit: { sessionId: "s", worktreePath, phase: "implement", intentId: "i" } }).allow, true);
});

test("governed MCP mutations cannot target a different signed run", () => {
  const worktreePath = "C:/repo/.captain-sdlc/worktrees/x", permit = { sessionId: "s", worktreePath, phase: "implement", intentId: "owned" };
  for (const toolName of ["mcp__captain-sdlc__captain_record_red", "mcp__captain-sdlc__captain_run_check", "mcp__captain-sdlc__captain_prepare_merge", "mcp__captain-sdlc__captain_abort_merge", "mcp__captain-sdlc__captain_commit", "mcp__captain-sdlc__captain_record_commit", "mcp__captain-sdlc__captain_prove"]) {
    assert.equal(mutationDecision({ toolName, cwd: worktreePath, sessionId: "s", intentId: "other", permit }).allow, false, toolName);
  }
});

test("denies production edits before red, unknown tools, and multiline shell bypasses", () => {
  const permit = { sessionId: "s", worktreePath: "C:/repo/.captain-sdlc/worktrees/x", phase: "tdd_red" };
  assert.equal(mutationDecision({ toolName: "apply_patch", cwd: permit.worktreePath, sessionId: "s", permit, command: "*** Update File: C:/repo/.captain-sdlc/worktrees/x/src/a.ts" }).allow, false);
  assert.equal(mutationDecision({ toolName: "apply_patch", cwd: permit.worktreePath, sessionId: "s", permit, command: "*** Add File: C:/repo/.captain-sdlc/worktrees/x/tests/a.test.ts" }).allow, true);
  assert.equal(mutationDecision({ toolName: "mcp__unknown__write_file", cwd: permit.worktreePath, sessionId: "s", permit }).allow, false);
  assert.equal(mutationDecision({ toolName: "Bash", cwd: permit.worktreePath, sessionId: "s", permit: null, command: "git status\necho bad>x" }).allow, false);
});
