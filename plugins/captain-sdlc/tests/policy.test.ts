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
  assert.equal(mutationDecision({ toolName: "exec_command", cwd: "C:/repo", sessionId: "s", permit: null, command: "Get-Content -Raw 'C:\\repo\\SKILL.md'" }).allow, true);
});

test("authorization lookup is read-only before and during a governed run", () => {
  for (const toolName of ["mcp__captain-sdlc__captain_user_authorization_status", "mcp__captain_sdlc__captain_user_authorization_status", "tools.captain-sdlc__captain_user_authorization_status"]) {
    for (const permit of [null, { sessionId: "s", worktreePath: "C:/repo", phase: "tdd_red" }]) {
      assert.equal(mutationDecision({ toolName, cwd: "C:/repo", sessionId: "s", permit }).allow, true, toolName);
    }
  }
  assert.equal(mutationDecision({ toolName: "mcp__captain-sdlc__captain_user_authorization_status_write", cwd: "C:/repo", sessionId: "s", permit: null }).allow, false);
});

test("standalone Merge Prep and Back use audited entry paths without reopening implementation", () => {
  for (const namespace of ["mcp__captain-sdlc__", "mcp__captain_sdlc__", "tools.captain-sdlc__", "captain-sdlc__"]) {
    for (const operation of ["merge_prep", "merge_back", "merge_begin", "merge_finish"]) {
      const toolName = `${namespace}captain_${operation}`;
      for (const permit of [null, { sessionId: "s", worktreePath: "C:/repo/owned", phase: "complete", intentId: "completed-task" }]) {
        assert.equal(mutationDecision({ toolName, cwd: "C:/repo/owned", sessionId: "s", permit }).allow, true, toolName);
      }
    }
  }
  assert.equal(mutationDecision({ toolName: "mcp__captain-sdlc__captain_merge_back_force", cwd: "C:/repo/owned", sessionId: "s", permit: null }).allow, false);
  for (const operation of ["merge_begin_force", "merge_finish_force"]) {
    assert.equal(mutationDecision({ toolName: `mcp__captain_sdlc__captain_${operation}`, cwd: "C:/repo/owned", sessionId: "s", permit: null }).allow, false);
  }
});

test("standalone merge status is read-only without an implementation permit", () => {
  for (const toolName of ["mcp__captain-sdlc__captain_merge_status", "mcp__captain_sdlc__captain_merge_status", "tools.captain-sdlc__captain_merge_status"]) {
    for (const permit of [null, { sessionId: "s", worktreePath: "C:/repo/owned", phase: "complete", intentId: "completed-task" }]) {
      assert.equal(mutationDecision({ toolName, cwd: "C:/repo/owned", sessionId: "s", permit }).allow, true, toolName);
    }
  }
  assert.equal(mutationDecision({ toolName: "mcp__captain-sdlc__captain_merge_status_write", cwd: "C:/repo/owned", sessionId: "s", permit: null }).allow, false);
});

test("exact merge lease recovery enters its server checks without reopening implementation", () => {
  for (const namespace of ["mcp__captain-sdlc__", "mcp__captain_sdlc__", "tools.captain-sdlc__", "captain-sdlc__"]) {
    const toolName = `${namespace}captain_recover_merge_lease`;
    for (const permit of [null, { sessionId: "s", worktreePath: "C:/repo/owned", phase: "complete", intentId: "completed-task" }]) {
      assert.equal(mutationDecision({ toolName, cwd: "C:/repo/owned", sessionId: "s", permit }).allow, true, toolName);
    }
    for (const suffix of ["_force", "_write"]) {
      assert.equal(mutationDecision({ toolName: `${toolName}${suffix}`, cwd: "C:/repo/owned", sessionId: "s", permit: null }).allow, false);
    }
  }
  assert.equal(mutationDecision({ toolName: "mcp__unknown__captain_recover_merge_lease", cwd: "C:/repo/owned", sessionId: "s", permit: null }).allow, false);
  assert.equal(mutationDecision({ toolName: "mcp__captain-sdlc__captain_abort_merge", cwd: "C:/repo/owned", sessionId: "s", permit: null }).allow, false);
});

test("denies direct or nested Git metadata mutation paths", () => {
  const worktreePath = "C:/repo/.captain-sdlc/worktrees/x", permit = { sessionId: "s", worktreePath, phase: "implement" };
  for (const target of [`${worktreePath}/.git`, `${worktreePath}/.git/config`, `${worktreePath}/src/.git/hooks/x`]) assert.equal(mutationDecision({ toolName: "apply_patch", cwd: worktreePath, sessionId: "s", permit, command: `*** Update File: ${target}` }).allow, false, target);
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

test("final commit recovery can enter during prove while other commit requests remain server-gated", () => {
  const worktreePath = "C:/repo/.captain-sdlc/worktrees/x", permit = { sessionId: "s", worktreePath, phase: "prove", intentId: "owned" };
  assert.equal(mutationDecision({ toolName: "mcp__captain-sdlc__captain_commit", cwd: worktreePath, sessionId: "s", intentId: "owned", permit }).allow, true);
  assert.equal(mutationDecision({ toolName: "mcp__captain-sdlc__captain_commit", cwd: worktreePath, sessionId: "s", intentId: "other", permit }).allow, false);
  assert.equal(mutationDecision({ toolName: "mcp__captain-sdlc__captain_prepare_merge", cwd: worktreePath, sessionId: "s", intentId: "owned", permit }).allow, false);
});

test("denies production edits before red, unknown tools, and multiline shell bypasses", () => {
  const permit = { sessionId: "s", worktreePath: "C:/repo/.captain-sdlc/worktrees/x", phase: "tdd_red" };
  assert.equal(mutationDecision({ toolName: "apply_patch", cwd: permit.worktreePath, sessionId: "s", permit, command: "*** Update File: C:/repo/.captain-sdlc/worktrees/x/src/a.ts" }).allow, false);
  assert.equal(mutationDecision({ toolName: "apply_patch", cwd: permit.worktreePath, sessionId: "s", permit, command: "*** Add File: C:/repo/.captain-sdlc/worktrees/x/tests/a.test.ts" }).allow, true);
  assert.equal(mutationDecision({ toolName: "mcp__unknown__write_file", cwd: permit.worktreePath, sessionId: "s", permit }).allow, false);
  assert.equal(mutationDecision({ toolName: "Bash", cwd: permit.worktreePath, sessionId: "s", permit: null, command: "git status\necho bad>x" }).allow, false);
});

test("durable user request lookup is exactly read-only under normalized Captain tool names", () => {
  const permits = [null, { sessionId: "s", worktreePath: "C:/repo", phase: "tdd_red" },
    { sessionId: "other", worktreePath: "C:/repo", phase: "complete" }];
  for (const namespace of ["mcp__captain-sdlc__", "mcp__captain_sdlc__", "tools.captain-sdlc__", "tools.captain_sdlc__", "captain-sdlc__", "captain_sdlc__"]) {
    const toolName = namespace + "captain_user_request_status";
    for (const permit of permits) assert.equal(
      mutationDecision({ toolName, cwd: "C:/repo", sessionId: "s", permit }).allow, true, toolName);
    for (const suffix of ["_write", "_force", "_record"]) assert.equal(
      mutationDecision({ toolName: toolName + suffix, cwd: "C:/repo", sessionId: "s", permit: null }).allow, false);
  }
  for (const toolName of ["mcp__unknown__captain_user_request_status", "captain_user_request_status",
    "mcp__captain-sdlc__captain_record_user_request", "mcp__captain-sdlc__captain_user_request"]) {
    assert.equal(mutationDecision({ toolName, cwd: "C:/repo", sessionId: "s", permit: null }).allow, false, toolName);
  }
});
