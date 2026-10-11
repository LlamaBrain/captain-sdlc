import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { writeAuthorized } from "../src/authority.js";
import { recordUserRequest, userRequestStatus, type UserRequestInput } from "../src/user-request.js";

const exec = promisify(execFile);
async function fixture(t: TestContext) {
  const container = await mkdtemp(path.join(tmpdir(), "captain-user-request-"));
  const root = path.join(container, "repo"), data = path.join(container, "data");
  await exec("git", ["init", root], { windowsHide: true });
  const git = (...args: string[]) => exec("git", args, { cwd: root, windowsHide: true });
  await git("config", "user.name", "Captain Test");
  await git("config", "user.email", "captain@example.invalid");
  await writeFile(path.join(root, "file.txt"), "baseline\n");
  await git("add", "file.txt"); await git("commit", "-m", "baseline");
  t.after(async () => {
    assert.equal(path.dirname(container), path.resolve(tmpdir()));
    assert.ok(path.basename(container).startsWith("captain-user-request-"));
    await rm(container, { recursive: true, force: true });
  });
  const base: Omit<UserRequestInput, "prompt"> = {
    projectRoot: root, source: "UserPromptSubmit", sessionId: "session-first",
    turnId: "turn-1", sourceIntentId: "intent-source", intentId: "intent-canonical", taskId: "VERIFY",
  };
  return { root, data, git, base };
}

test("direct task instructions are express approval and preserve exact user wording", async t => {
  const { root, data, base } = await fixture(t);
  for (const [index, prompt] of ["Do the verification", "Fix the churn", "Please implement consent persistence",
    "Can you run the tests?", "I want you to repair the same task"].entries()) {
    const receipt = await recordUserRequest(data, { ...base, intentId: `direct-${index}`, turnId: `turn-${index}`, prompt });
    assert.equal(receipt.decision, "expressed", prompt);
    assert.equal(receipt.basis, "direct_instruction", prompt);
    assert.equal(receipt.originalText, prompt);
    assert.deepEqual(receipt.objectiveLines, [prompt]);
  }
  const status = await userRequestStatus(data, { projectRoot: root, intentId: "direct-4" });
  assert.equal(status.status, "expressed");
  assert.match(status.guidance, /missing.*(not|does not|never)/i);
});

test("multiline full-run goals retain all exact objective lines and a deterministic scope digest", async t => {
  const { root, data, base } = await fixture(t);
  const prompt = "When the commit is done - run a full edittest/playtest/build/smoke-test (do a single full run).\r\nThen list all files that are marked changed and show evidence of system level churn during one of those phases (test/build/smoke).\r\nFinally make it so test/build/smoke sequence produces no visible churn on the repo - and the repo is clean after building.";
  const receipt = await recordUserRequest(data, { ...base, prompt, requestKind: "goal", targetBranch: "main" });
  assert.equal(receipt.decision, "expressed");
  assert.deepEqual(receipt.objectiveLines, prompt.split(/\r?\n/));
  assert.equal(receipt.originalText, prompt);
  assert.match(receipt.scopeSha256, /^[0-9a-f]{64}$/);
  const status = await userRequestStatus(data, { projectRoot: root, intentId: base.intentId });
  assert.deepEqual(status.objectiveLines, receipt.objectiveLines);
  assert.equal(status.originalText, prompt);
  assert.equal(status.scopeSha256, receipt.scopeSha256);
});

test("task binding preserves provenance without inferring authority from a task name", async t => {
  const { root, data, base } = await fixture(t);
  const receipt = await recordUserRequest(data, { ...base, prompt: "Run the tests", source: "client-adapter" });
  assert.equal(receipt.intentId, "intent-canonical");
  assert.equal(receipt.sourceIntentId, "intent-source");
  assert.equal(receipt.sessionId, base.sessionId);
  assert.equal(receipt.turnId, base.turnId);
  assert.equal(receipt.source, "client-adapter");
  assert.equal(receipt.taskId, "VERIFY");
  const unrelated = await userRequestStatus(data, { projectRoot: root, intentId: "same-name-other-intent" });
  assert.equal(unrelated.status, "missing");
  assert.deepEqual(unrelated.receipts, []);
});

test("source turn replay is immutable and idempotent", async t => {
  const { data, base } = await fixture(t);
  const input = { ...base, prompt: "Do the tests", requestKind: "instruction" as const };
  const first = await recordUserRequest(data, input);
  assert.deepEqual(await recordUserRequest(data, input), first);
  assert.equal((await readdir(path.join(data, "user-requests"))).length, 1);
  await assert.rejects(() => recordUserRequest(data, { ...input, prompt: "Merge into main" }), /source|immutable|existing/i);
  await assert.rejects(() => recordUserRequest(data, { ...input, intentId: "foreign-intent" }), /source|immutable|existing/i);
});

test("concurrent identical source replay creates one immutable receipt", async t => {
  const { data, base } = await fixture(t);
  const input = { ...base, prompt: "Fix this task" };
  const results = await Promise.all(Array.from({ length: 5 }, () => recordUserRequest(data, input)));
  for (const receipt of results) assert.deepEqual(receipt, results[0]);
  assert.equal((await readdir(path.join(data, "user-requests"))).length, 1);
});

test("quote, fence, example, and permission discussion are captured without invented consent", async t => {
  const { data, base } = await fixture(t);
  const prompts = [
    '> do it', '"Run the tests"', "'commit it'", "`Fix the churn`",
    "```\nRun all tests\n```", "~~~~\nFix it\n~~~~",
    "Example:\nRun the verification", "For example:\n- Do it",
    "Do not execute this example:\n    commit", "If I say do it, that is approval",
    "It would be useful to run all tests", "Explain how to commit", "What do you think about running tests?",
    "````markdown\n```\nRun tests\n```\n````",
  ];
  for (const [index, prompt] of prompts.entries()) {
    const receipt = await recordUserRequest(data, { ...base, turnId: `quoted-${index}`, prompt });
    assert.equal(receipt.decision, "unclear", prompt);
    assert.equal(receipt.basis, undefined, prompt);
    assert.deepEqual(receipt.objectiveLines, [], prompt);
    assert.equal(receipt.originalText, prompt);
  }
});

test("bare do-it lacks an established objective and remains unclear", async t => {
  const { root, data, base } = await fixture(t);
  const receipt = await recordUserRequest(data, { ...base, prompt: "do it" });
  assert.equal(receipt.decision, "unclear");
  assert.deepEqual(receipt.objectiveLines, []);
  assert.equal((await userRequestStatus(data, { projectRoot: root, intentId: base.intentId })).status, "unclear");
});

test("do-it and ordinary resume preserve the exact original objective across turns and sessions", async t => {
  const { root, data, base } = await fixture(t);
  const original = "Run full verification and snapshot each stage";
  const first = await recordUserRequest(data, { ...base, prompt: original });
  for (const [index, prompt] of ["do it", "continue", "resume the same task"].entries()) {
    const next = await recordUserRequest(data, { ...base, sessionId: "session-next",
      turnId: `resume-${index}`, sourceIntentId: `intent-resume-${index}`, prompt });
    assert.equal(next.decision, "expressed");
    assert.equal(next.basis, "continuation");
    assert.deepEqual(next.objectiveLines, first.objectiveLines);
    assert.equal(next.scopeSha256, first.scopeSha256);
  }
  const status = await userRequestStatus(data, { projectRoot: root, intentId: base.intentId, sessionId: "session-next" });
  assert.equal(status.status, "expressed");
  assert.equal(status.originalText, original);
  assert.deepEqual(status.objectiveLines, [original]);
});

test("explicit approval recollects an established objective without broadening its scope", async t => {
  const { data, base } = await fixture(t);
  const original = await recordUserRequest(data, { ...base, prompt: "Fix the consent replay" });
  const approval = await recordUserRequest(data, { ...base, turnId: "approve", prompt: "I approve. Do it." });
  assert.equal(approval.decision, "expressed");
  assert.equal(approval.basis, "explicit_approval");
  assert.equal(approval.scopeSha256, original.scopeSha256);
  assert.deepEqual(approval.objectiveLines, original.objectiveLines);
});

test("unclear later discussion cannot erase earlier expressed consent", async t => {
  const { root, data, base } = await fixture(t);
  const first = await recordUserRequest(data, { ...base, prompt: "Run the existing verification" });
  await recordUserRequest(data, { ...base, turnId: "discussion", prompt: "What does stale approval mean?" });
  const status = await userRequestStatus(data, { projectRoot: root, intentId: base.intentId });
  assert.equal(status.receipts.length, 2);
  assert.equal(status.status, "expressed");
  assert.deepEqual(status.objectiveLines, first.objectiveLines);
});

test("revocation wins over unclear discussion and generic continuation", async t => {
  const { root, data, base } = await fixture(t);
  await recordUserRequest(data, { ...base, prompt: "Run the full verification" });
  const revoke = await recordUserRequest(data, { ...base, turnId: "revoke", prompt: "Stop this task. I revoke approval." });
  assert.equal(revoke.decision, "revoked");
  await recordUserRequest(data, { ...base, turnId: "later", prompt: "What would happen next?" });
  await recordUserRequest(data, { ...base, turnId: "generic", prompt: "do it" });
  const status = await userRequestStatus(data, { projectRoot: root, intentId: base.intentId });
  assert.equal(status.status, "revoked");
  assert.match(status.reason ?? "", /revoke/i);
});

test("new explicit approval after revocation can restore the same objective", async t => {
  const { root, data, base } = await fixture(t);
  const first = await recordUserRequest(data, { ...base, prompt: "Run the tests" });
  await recordUserRequest(data, { ...base, turnId: "revoke", prompt: "Cancel this task" });
  const approval = await recordUserRequest(data, { ...base, turnId: "approve", prompt: "I approve this task again" });
  assert.equal(approval.decision, "expressed");
  const status = await userRequestStatus(data, { projectRoot: root, intentId: base.intentId });
  assert.equal(status.status, "expressed");
  assert.deepEqual(status.objectiveLines, first.objectiveLines);
});

test("moving scope or target is stale while a session or old timestamp alone is not", async t => {
  const { root, data, base } = await fixture(t);
  const receipt = await recordUserRequest(data, { ...base, prompt: "Run the focused test", targetBranch: "main" });
  // A signed historical fixture proves age alone does not invalidate same-scope consent.
  await writeAuthorized(data, "user-requests", receipt.id, { ...receipt, recordedAt: "2000-01-01T00:00:00Z" });
  const same = await userRequestStatus(data, { projectRoot: root, intentId: base.intentId,
    sessionId: base.sessionId, expectedScopeSha256: receipt.scopeSha256, expectedTargetBranch: "main" });
  assert.equal(same.status, "expressed");
  assert.equal((await userRequestStatus(data, { projectRoot: root, intentId: base.intentId,
    expectedScopeSha256: createHash("sha256").update("broadened scope").digest("hex") })).status, "stale");
  assert.equal((await userRequestStatus(data, { projectRoot: root, intentId: base.intentId,
    expectedTargetBranch: "release" })).status, "stale");
});

test("untargeted task consent does not supply an arbitrary target or operation authority", async t => {
  const { root, data, base } = await fixture(t);
  const receipt = await recordUserRequest(data, { ...base, prompt: "Do the implementation" });
  assert.equal(receipt.targetBranch, undefined);
  assert.equal("operation" in receipt, false);
  assert.equal((await userRequestStatus(data, { projectRoot: root, intentId: base.intentId,
    expectedTargetBranch: "main" })).status, "stale");
  assert.match((await userRequestStatus(data, { projectRoot: root, intentId: base.intentId })).guidance,
    /commit.*merge.*push/i);
});

test("foreign sessions cannot recollect a task without a validated continuation source", async t => {
  const { root, data, base } = await fixture(t);
  await recordUserRequest(data, { ...base, prompt: "Fix the task" });
  const foreign = await userRequestStatus(data, { projectRoot: root, intentId: base.intentId, sessionId: "session-foreign" });
  assert.equal(foreign.status, "missing");
  assert.deepEqual(foreign.receipts, []);
});

test("canonical task evidence follows linked worktrees without crossing repositories", async t => {
  const { root, data, base, git } = await fixture(t), other = await fixture(t);
  await recordUserRequest(data, { ...base, prompt: "Fix the task" });
  const linked = path.join(path.dirname(root), "linked");
  await git("worktree", "add", "-b", "task-work", linked);
  assert.equal((await userRequestStatus(data, { projectRoot: linked, intentId: base.intentId })).status, "expressed");
  assert.equal((await userRequestStatus(data, { projectRoot: other.root, intentId: base.intentId })).status, "missing");
});

test("status is strictly read-only and missing legacy evidence is advisory", async t => {
  const { root, data, base } = await fixture(t);
  const missing = await userRequestStatus(data, { projectRoot: root, intentId: base.intentId });
  assert.equal(missing.status, "missing");
  assert.match(missing.guidance, /conversation|legacy/i);
  await assert.rejects(() => stat(data), { code: "ENOENT" });
  const receipt = await recordUserRequest(data, { ...base, prompt: "Fix the churn" });
  const files = await readdir(data), before = await stat(data);
  const signedPath = path.join(data, "user-requests", `${receipt.id}.json`);
  const signedBefore = await stat(signedPath);
  await userRequestStatus(data, { projectRoot: root, intentId: base.intentId });
  assert.deepEqual(await readdir(data), files);
  assert.equal((await stat(data)).mtimeMs, before.mtimeMs);
  assert.equal((await stat(signedPath)).mtimeMs, signedBefore.mtimeMs);
});

test("altered original wording fails authentication without exposing authority secrets", async t => {
  const { root, data, base } = await fixture(t);
  const receipt = await recordUserRequest(data, { ...base, prompt: "Run tests" });
  const signedPath = path.join(data, "user-requests", `${receipt.id}.json`);
  const envelope = JSON.parse(await readFile(signedPath, "utf8"));
  envelope.payload.originalText = "merge into main";
  await writeFile(signedPath, JSON.stringify(envelope));
  await assert.rejects(() => userRequestStatus(data, { projectRoot: root, intentId: base.intentId }), /authority tag/i);
});

test("recording requires exact source and canonical task selectors", async t => {
  const { data, base } = await fixture(t);
  for (const field of ["sessionId", "turnId", "sourceIntentId", "intentId"] as const) {
    await assert.rejects(() => recordUserRequest(data, { ...base, [field]: "", prompt: "Run tests" }), /source|task|intent|session|turn/i);
  }
});

test("Captain metadata is not consent and blank objective lines remain exact", async t => {
  const { data, base } = await fixture(t);
  const marker = await recordUserRequest(data, { ...base, prompt: "[Captain plan: VERIFY]" });
  assert.equal(marker.decision, "unclear");
  assert.deepEqual(marker.objectiveLines, []);
  const prompt = "[Captain plan: VERIFY]\nRun the test suite\n\nThen snapshot the result";
  const request = await recordUserRequest(data, { ...base, turnId: "actual", prompt });
  assert.equal(request.originalText, prompt);
  assert.deepEqual(request.objectiveLines, ["Run the test suite", "", "Then snapshot the result"]);
});

test("missing legacy receipt lookup does not require Git or create authority state", async t => {
  const { root, data, base } = await fixture(t);
  const nonGitRoot = path.join(path.dirname(root), "nonexistent-legacy-checkout");
  assert.equal((await userRequestStatus(data, { projectRoot: nonGitRoot, intentId: "legacy-intent" })).status, "missing");
  await assert.rejects(() => stat(data), { code: "ENOENT" });
  await recordUserRequest(data, { ...base, prompt: "Fix this task" });
  assert.equal((await userRequestStatus(data, { projectRoot: nonGitRoot, intentId: "legacy-intent" })).status, "missing");
  assert.equal((await userRequestStatus(data, { projectRoot: nonGitRoot, intentId: base.intentId, sessionId: "foreign-session" })).status, "missing");
});

test("bare stop revokes the bound task and cannot become a continuation", async t => {
  const { root, data, base } = await fixture(t);
  await recordUserRequest(data, { ...base, prompt: "Run the tests" });
  await recordUserRequest(data, { ...base, turnId: "stop", prompt: "Stop." });
  const status = await userRequestStatus(data, { projectRoot: root, intentId: base.intentId });
  assert.equal(status.status, "revoked");
});

test("supporting same-task instructions retain the first defining objective and scope", async t => {
  const { root, data, base } = await fixture(t);
  const first = await recordUserRequest(data, { ...base, prompt: "Fix the churn" });
  const later = await recordUserRequest(data, { ...base, turnId: "focused", prompt: "Run focused tests" });
  assert.equal(later.originalText, "Run focused tests");
  assert.equal(later.objectiveOriginalText, first.objectiveOriginalText);
  assert.deepEqual(later.objectiveLines, first.objectiveLines);
  assert.equal(later.scopeSha256, first.scopeSha256);
  const status = await userRequestStatus(data, { projectRoot: root, intentId: base.intentId });
  assert.equal(status.status, "expressed");
  assert.equal(status.originalText, "Fix the churn");
  assert.equal(status.scopeSha256, first.scopeSha256);
});

test("operation-only vetoes do not revoke a broader implementation objective", async t => {
  const { root, data, base } = await fixture(t);
  await recordUserRequest(data, { ...base, prompt: "Fix the churn" });
  for (const [index, prompt] of ["Do not commit", "Don't merge", "Do not push", "Do not publish", "Stop committing"].entries()) {
    await recordUserRequest(data, { ...base, turnId: `operation-${index}`, prompt });
    const status = await userRequestStatus(data, { projectRoot: root, intentId: base.intentId });
    assert.equal(status.status, "expressed", prompt);
    assert.equal(status.originalText, "Fix the churn", prompt);
  }
});

test("a veto revokes a task whose defining objective is solely that operation", async t => {
  const { root, data, base } = await fixture(t);
  for (const [index, [objective, veto]] of [
    ["Commit it", "Do not commit"], ["Merge to main", "Don't merge"],
    ["Push the changes", "Do not push"], ["Do a commit", "Stop committing"],
  ].entries()) {
    const intentId = `operation-intent-${index}`;
    await recordUserRequest(data, { ...base, sourceIntentId: `source-${index}`, intentId, prompt: objective });
    await recordUserRequest(data, { ...base, sourceIntentId: `veto-${index}`, intentId, turnId: "veto", prompt: veto });
    assert.equal((await userRequestStatus(data, { projectRoot: root, intentId })).status, "revoked", objective);
  }
});

test("a changed explicit target is stale by default while the defining scope remains intact", async t => {
  const { root, data, base } = await fixture(t);
  const first = await recordUserRequest(data, { ...base, prompt: "Fix the churn", targetBranch: "main" });
  await recordUserRequest(data, { ...base, turnId: "different-target", prompt: "Run focused tests", targetBranch: "release" });
  const status = await userRequestStatus(data, { projectRoot: root, intentId: base.intentId });
  assert.equal(status.status, "stale");
  assert.equal(status.originalText, "Fix the churn");
  assert.equal(status.scopeSha256, first.scopeSha256);
  await recordUserRequest(data, { ...base, turnId: "generic-followup", prompt: "do it" });
  assert.equal((await userRequestStatus(data, { projectRoot: root, intentId: base.intentId })).status, "stale");
  await recordUserRequest(data, { ...base, turnId: "original-target", prompt: "Run focused tests", targetBranch: "main" });
  assert.equal((await userRequestStatus(data, { projectRoot: root, intentId: base.intentId })).status, "expressed");
});

test("supporting instructions cannot silently restore a revoked task", async t => {
  const { root, data, base } = await fixture(t);
  const first = await recordUserRequest(data, { ...base, prompt: "Fix the churn" });
  await recordUserRequest(data, { ...base, turnId: "cancel", prompt: "Cancel this task" });
  await recordUserRequest(data, { ...base, turnId: "supporting", prompt: "Run focused tests" });
  assert.equal((await userRequestStatus(data, { projectRoot: root, intentId: base.intentId })).status, "revoked");
  await recordUserRequest(data, { ...base, turnId: "again", prompt: "Do this task again" });
  const restored = await userRequestStatus(data, { projectRoot: root, intentId: base.intentId });
  assert.equal(restored.status, "expressed");
  assert.equal(restored.scopeSha256, first.scopeSha256);
});

test("delayed original source publication cannot supersede a later Stop event", async t => {
  const { root, data, base } = await fixture(t);
  await recordUserRequest(data, { ...base, turnId: "stop", prompt: "Stop this task", sourceRecordedAt: "2001-01-01T00:00:00.000Z" });
  const original = await recordUserRequest(data, { ...base, prompt: "Fix the churn", sourceRecordedAt: "2000-01-01T00:00:00.000Z" });
  const status = await userRequestStatus(data, { projectRoot: root, intentId: base.intentId });
  assert.equal(status.status, "revoked");
  assert.equal(status.originalText, "Fix the churn");
  assert.equal(status.scopeSha256, original.scopeSha256);
  assert.deepEqual(status.receipts.map(receipt => receipt.turnId), [base.turnId, "stop"]);
});

test("out-of-order source repair cannot turn a supporting request into restored approval", async t => {
  const { root, data, base } = await fixture(t);
  await recordUserRequest(data, { ...base, turnId: "supporting", prompt: "Run focused tests", sourceRecordedAt: "2002-01-01T00:00:00.000Z" });
  await recordUserRequest(data, { ...base, turnId: "stop", prompt: "Stop this task", sourceRecordedAt: "2001-01-01T00:00:00.000Z" });
  const original = await recordUserRequest(data, { ...base, prompt: "Fix the churn", sourceRecordedAt: "2000-01-01T00:00:00.000Z" });
  const status = await userRequestStatus(data, { projectRoot: root, intentId: base.intentId });
  assert.equal(status.status, "revoked");
  assert.equal(status.originalText, "Fix the churn");
  assert.equal(status.scopeSha256, original.scopeSha256);
});

test("source timestamp provenance is valid and immutable without an age expiry", async t => {
  const { data, base } = await fixture(t);
  await assert.rejects(() => recordUserRequest(data, { ...base, prompt: "Fix the churn", sourceRecordedAt: "not-a-date" }), /timestamp|source.*time/i);
  const input = { ...base, prompt: "Fix the churn", sourceRecordedAt: "2000-01-01T00:00:00.000Z" };
  const first = await recordUserRequest(data, input);
  assert.equal(first.sourceRecordedAt, input.sourceRecordedAt);
  assert.deepEqual(await recordUserRequest(data, input), first);
  await assert.rejects(() => recordUserRequest(data, { ...input, sourceRecordedAt: "2001-01-01T00:00:00.000Z" }), /source|immutable|existing/i);
});

test("task-level revocation wins when an operation restriction appears in the same prompt", async t => {
  const { root, data, base } = await fixture(t);
  await recordUserRequest(data, { ...base, prompt: "Fix the churn" });
  await recordUserRequest(data, { ...base, turnId: "restrictions", prompt: "Do not commit\nStop this task" });
  assert.equal((await userRequestStatus(data, { projectRoot: root, intentId: base.intentId })).status, "revoked");
});

test("delayed historical explicit reapproval cannot override a newer Stop event", async t => {
  const { root, data, base } = await fixture(t);
  const original = await recordUserRequest(data, { ...base, prompt: "Fix the churn", sourceRecordedAt: "2000-01-01T00:00:00.000Z" });
  await recordUserRequest(data, { ...base, turnId: "stop", prompt: "Stop this task", sourceRecordedAt: "2002-01-01T00:00:00.000Z" });
  await recordUserRequest(data, { ...base, turnId: "old-approval", prompt: "I approve this task again", sourceRecordedAt: "2001-01-01T00:00:00.000Z" });
  const status = await userRequestStatus(data, { projectRoot: root, intentId: base.intentId });
  assert.equal(status.status, "revoked");
  assert.equal(status.originalText, original.originalText);
});

test("repairing missing original evidence recollects a later explicit reapproval", async t => {
  const { root, data, base } = await fixture(t);
  await recordUserRequest(data, { ...base, turnId: "stop", prompt: "Stop this task", sourceRecordedAt: "2001-01-01T00:00:00.000Z" });
  await recordUserRequest(data, { ...base, turnId: "approval", prompt: "I approve this task again", sourceRecordedAt: "2002-01-01T00:00:00.000Z" });
  const original = await recordUserRequest(data, { ...base, prompt: "Fix the churn", sourceRecordedAt: "2000-01-01T00:00:00.000Z" });
  const status = await userRequestStatus(data, { projectRoot: root, intentId: base.intentId });
  assert.equal(status.status, "expressed");
  assert.equal(status.originalText, original.originalText);
  assert.equal(status.scopeSha256, original.scopeSha256);
});
