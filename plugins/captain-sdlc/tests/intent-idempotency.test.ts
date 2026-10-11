import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { LifecycleStore } from "../src/lifecycle.js";
import { captainIssueIntent } from "../src/server.js";
import { git } from "../src/workspace.js";

test("issuance retries retain the original token and pinned branch after HEAD advances", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "captain-issue-")), data = await mkdtemp(path.join(tmpdir(), "captain-issue-state-"));
  await git(["init", "-b", "main"], root);
  const commit = () => git(["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-m", "advance"], root);
  await commit(); const head = await git(["rev-parse", "HEAD"], root);
  const store = new LifecycleStore(data, async () => ({ exitCode: 0, stdout: "", stderr: "" }));
  const args = { session_id: "session", turn_id: "turn", project_root: root, prompt: "implement the task", target_branch: "main", action: "start" as const };
  const first = await captainIssueIntent(store, args); await commit();
  const again = await captainIssueIntent(new LifecycleStore(data, async () => ({ exitCode: 0, stdout: "", stderr: "" })), args);
  assert.deepEqual(again, first); assert.equal((await store.validateIntent(first.intent_id, root)).targetOid, head);
  await assert.rejects(() => captainIssueIntent(store, { ...args, task_id: "different" }), /issuance.*request|request.*issuance/);
});

test("concurrent retries converge and recovery after authorization failure preserves one token", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "captain-issue-")), data = await mkdtemp(path.join(tmpdir(), "captain-issue-state-"));
  const store = new LifecycleStore(data, async () => ({ exitCode: 0, stdout: "", stderr: "" }));
  await git(["init", "-b", "main"], root);
  const args = { session_id: "s", turn_id: "t", project_root: root, prompt: "implement task", action: "start" as const };
  const original = store.recordUserAuthorization.bind(store); let captured: string | undefined;
  store.recordUserAuthorization = async input => { captured = input.intentId; throw new Error("response interrupted"); };
  await assert.rejects(() => captainIssueIntent(store, args), /interrupted/);
  store.recordUserAuthorization = original;
  const results = await Promise.all(Array.from({ length: 4 }, () => captainIssueIntent(store, args)));
  assert.ok(results.every(result => result.intent_id === captured));
  const intent = await store.validateIntent(results[0].intent_id, root);
  await store.markIntent({ ...intent, consumed: true });
  assert.deepEqual(await captainIssueIntent(store, args), results[0]);
  await assert.rejects(() => store.validateIntent(results[0].intent_id, root), /consumed/);
  const cold = await Promise.all(Array.from({ length: 4 }, () => captainIssueIntent(store, { ...args, turn_id: "new" })));
  assert.ok(cold.every(result => result.intent_id === cold[0].intent_id));
  assert.notEqual(cold[0].intent_id, results[0].intent_id);
});
