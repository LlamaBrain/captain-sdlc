import assert from "node:assert/strict";
import test from "node:test";
import { mutationDecision } from "../src/policy.js";

test("documentation classification remains a phase and intent bound governed operation", () => {
  const input = { toolName: "mcp__captain_sdlc__captain_prepare_documentation", cwd: "C:/project", sessionId: "s", intentId: "docs",
    permit: { sessionId: "s", worktreePath: "C:/project/task", phase: "tdd_red", intentId: "docs" } };
  assert.equal(mutationDecision(input).allow, true);
  assert.equal(mutationDecision({ ...input, permit: { ...input.permit, phase: "implement" } }).allow, true, "the same guarded public operation can replay idempotently");
  assert.equal(mutationDecision({ ...input, intentId: "foreign" }).allow, false);
  assert.equal(mutationDecision({ ...input, permit: null }).allow, false);
  assert.equal(mutationDecision({ ...input, permit: { ...input.permit, phase: "complete" } }).allow, false);
});
