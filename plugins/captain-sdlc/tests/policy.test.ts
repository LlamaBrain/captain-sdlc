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

test("denies production edits before red, unknown tools, and multiline shell bypasses", () => {
  const permit = { sessionId: "s", worktreePath: "C:/repo/.captain-sdlc/worktrees/x", phase: "tdd_red" };
  assert.equal(mutationDecision({ toolName: "apply_patch", cwd: permit.worktreePath, sessionId: "s", permit, command: "*** Update File: C:/repo/.captain-sdlc/worktrees/x/src/a.ts" }).allow, false);
  assert.equal(mutationDecision({ toolName: "apply_patch", cwd: permit.worktreePath, sessionId: "s", permit, command: "*** Add File: C:/repo/.captain-sdlc/worktrees/x/tests/a.test.ts" }).allow, true);
  assert.equal(mutationDecision({ toolName: "mcp__unknown__write_file", cwd: permit.worktreePath, sessionId: "s", permit }).allow, false);
  assert.equal(mutationDecision({ toolName: "Bash", cwd: permit.worktreePath, sessionId: "s", permit: null, command: "git status\necho bad>x" }).allow, false);
});
