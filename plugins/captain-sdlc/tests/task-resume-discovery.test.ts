import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { captainIssueIntent } from "../src/server.js";

test("task resume discovery inspects only signed candidates for the selected project and task", async () => {
  const projectRoot = path.resolve("selected-project");
  const matching = { intentId: "retained-task", runId: "same-run", sessionId: "same-session", taskId: "selected-task", projectRoot, status: "paused", branch: "captain/retained-task" };
  const calls: string[] = [];
  const store = {
    issueIdempotentIntent: async (_: unknown, factory: () => unknown) => factory(),
    doctor: async () => ({ activeRuns: [
      { ...matching, intentId: "unrelated-broken-owner", projectRoot: path.resolve("other-project"), taskId: "other-task" }, matching,
    ] }),
    status: async (id: string) => { calls.push(id); if (id !== matching.intentId) throw new Error("unrelated ownership defect"); return matching; },
    recordUserAuthorization: async () => undefined,
    recordUserRequest: async () => undefined,
    userRequestSource: async () => undefined,
    userRequests: async () => ({ status: "missing", receipts: [], objectiveLines: [], guidance: "" }),
  };
  const result = await captainIssueIntent(store as any, { session_id: "same-session", turn_id: "new-turn", project_root: projectRoot, prompt: "Resume this task", task_id: "selected-task", action: "resume" });
  assert.ok(result.resume_instruction);
  assert.ok(calls.every(id => id === matching.intentId));
});
