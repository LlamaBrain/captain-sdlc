import assert from "node:assert/strict";
import test from "node:test";
import * as server from "../src/server.js";

test("public recovery discovery stays compact and retains the full signed handoff separately", async () => {
  const handoff = { schemaVersion: 1, intentId: "retained", runId: "same-run", revision: 2,
    sessionId: "closed", turnId: "old", projectRoot: "/project", worktreePath: "/project/task",
    branch: "captain/retained", taskId: "task", objective: "finish original work", phase: "implement", status: "paused",
    summary: "paused", nextSteps: ["finish original criterion"], blockers: [], completedSteps: ["red"],
    context: "retained diagnosis", resumeDirective: "[Captain resume: retained]",
    worktreeState: { head: "a".repeat(40), tree: "b".repeat(40), status: "?? task.txt", manifest: "x".repeat(6 * 1024 * 1024) },
    evidence: [{ kind: "tdd_red", exitCode: 1, detail: "y".repeat(6 * 1024 * 1024) }] };
  const activeRuns = [{ intentId: "retained", projectRoot: "/project", taskId: "task", status: "paused" }];
  const source = { pausedHandoffs: [handoff], activeRuns };
  const discover = (server as any).captainDoctor ?? ((store: any) => store.doctor());
  const result = await discover({ doctor: async () => source });
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 10000, "discovery must fit ordinary MCP message buffers");
  const summary = result.pausedHandoffs[0];
  for (const key of ["intentId", "runId", "revision", "worktreePath", "branch", "taskId", "objective", "summary", "nextSteps", "blockers", "completedSteps", "context", "resumeDirective"]) {
    assert.deepEqual(summary[key], (handoff as any)[key], key);
  }
  assert.equal(summary.handoffId, "retained-2");
  assert.equal(summary.evidenceCount, 1);
  assert.deepEqual(summary.worktreeState, { head: handoff.worktreeState.head, tree: handoff.worktreeState.tree });
  assert.equal(summary.evidence, undefined);
  assert.strictEqual(result.activeRuns, activeRuns);
  assert.strictEqual(source.pausedHandoffs[0], handoff);
  assert.equal(handoff.worktreeState.manifest.length, 6 * 1024 * 1024);
  assert.equal(handoff.evidence[0].detail.length, 6 * 1024 * 1024);
});
