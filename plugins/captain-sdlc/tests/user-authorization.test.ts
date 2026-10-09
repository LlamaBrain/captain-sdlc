import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { parseUserAuthorizations, recordUserAuthorizations, userAuthorizationStatus } from "../src/user-authorization.js";
import { LifecycleStore } from "../src/lifecycle.js";
import { captainIssueIntent } from "../src/server.js";

const exec = promisify(execFile);
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "captain-user-approval-"));
  const data = await mkdtemp(path.join(tmpdir(), "captain-user-approval-data-"));
  const git = (...args: string[]) => exec("git", args, { cwd: root });
  await git("init"); await git("config", "user.name", "Captain Test"); await git("config", "user.email", "captain@example.invalid");
  await writeFile(path.join(root, "file.txt"), "base\n"); await git("add", "file.txt"); await git("commit", "-m", "baseline");
  return { root, data, git };
}

test("plain commit and target-specific merge instructions are explicit authorization", () => {
  for (const text of ["commit", "Commit it", "Approve commit", "please commit the changes", "go ahead and commit it!"]) {
    assert.deepEqual(parseUserAuthorizations(text), [{ operation: "commit", decision: "approve", quote: text }]);
  }
  assert.deepEqual(parseUserAuthorizations("merge to spike/colony"), [{ operation: "merge", decision: "approve", targetBranch: "spike/colony", quote: "merge to spike/colony" }]);
});

test("Merge Back captures the instruction and only an explicitly named target", () => {
  for (const text of ["Merge Back", "merge-back", "please Merge Back!", "Approve Merge Back", "authorize the merge-back"]) {
    assert.deepEqual(parseUserAuthorizations(text), [{ operation: "merge", decision: "approve", quote: text }], text);
  }
  for (const text of ["merge back into spike/colony", "merge back to spike/colony", "merge-back into spike/colony", "approve the merge back to spike/colony"]) {
    assert.deepEqual(parseUserAuthorizations(text), [{ operation: "merge", decision: "approve", targetBranch: "spike/colony", quote: text }], text);
  }
  for (const text of ["do not merge back", "don't merge-back", "cancel Merge Back", "stop merge back", "revoke merge-back"]) {
    assert.deepEqual(parseUserAuthorizations(text), [{ operation: "merge", decision: "revoke", quote: text }], text);
  }
  assert.deepEqual(parseUserAuthorizations("revoke merge back into main"), [{ operation: "merge", decision: "revoke", targetBranch: "main", quote: "revoke merge back into main" }]);
});

test("Merge Finish aliases Back while preserving the original instruction and named target", () => {
  for (const text of ["Merge Finish", "merge-finish", "please merge finish!", "Approve Merge Finish", "authorize the merge-finish", "go ahead and merge finish"]) {
    assert.deepEqual(parseUserAuthorizations(text), [{ operation: "merge", decision: "approve", quote: text }], text);
  }
  for (const text of ["merge finish into spike/colony", "merge finish to spike/colony", "merge-finish into spike/colony", "approve the merge finish to spike/colony"]) {
    assert.deepEqual(parseUserAuthorizations(text), [{ operation: "merge", decision: "approve", targetBranch: "spike/colony", quote: text }], text);
  }
});

test("Merge Finish revocations follow the existing Back grammar", () => {
  for (const text of ["do not merge finish", "don't merge-finish", "cancel Merge Finish", "stop merge finish", "revoke merge-finish"]) {
    assert.deepEqual(parseUserAuthorizations(text), [{ operation: "merge", decision: "revoke", quote: text }], text);
  }
  for (const text of ["do not merge finish into main", "revoke merge-finish to main"]) {
    assert.deepEqual(parseUserAuthorizations(text), [{ operation: "merge", decision: "revoke", targetBranch: "main", quote: text }], text);
  }
});

test("Merge Begin never grants Back or Finish authority", () => {
  for (const text of ["Merge Begin", "merge-begin", "merge begin into main", "merge begin to main", "approve merge begin into main", "authorize the merge-begin", "do not merge begin into main", "revoke merge begin"]) {
    assert.deepEqual(parseUserAuthorizations(text), [], text);
  }
});

test("Finish quotes, fences, and discussion cannot become integration authority", () => {
  for (const text of ["> Merge Finish", "\"merge-finish\"", "'merge finish'", "`Merge Finish`", "    merge finish to main", "```\nMerge Finish\n```", "~~~~\nmerge-finish to main\n~~~~", "Explain Merge Finish", "merge finish?", "merge finish and push", "merge finish to main; git push"]) {
    assert.deepEqual(parseUserAuthorizations(text), [], text);
  }
});

test("Merge Prep, quoted examples, and discussion never grant Merge Back", () => {
  for (const text of ["Merge Prep", "merge-prep", "merge prep into main", "approve merge prep into main", "do not merge prep into main", "> Merge Back", "\"merge-back\"", "`Merge Back`", "    merge back to main", "```\nMerge Back\n```", "~~~~\nmerge-back to main\n~~~~", "Explain Merge Back", "merge back?", "merge back and push", "merge back to main; git push"]) {
    assert.deepEqual(parseUserAuthorizations(text), [], text);
  }
});

test("discussion, quotes, questions, and unrelated operations do not become approval", () => {
  for (const text of ["If I say commit that is authorization", "One idea is the words 'commit it'", "> commit it", "\"commit it\"", "Can you explain commit?", "commit and push", "merge to main; git push", "```\ncommit it\n```", "do it"]) {
    assert.deepEqual(parseUserAuthorizations(text), [], text);
  }
  assert.equal(parseUserAuthorizations("don't commit")[0].decision, "revoke");
  assert.equal(parseUserAuthorizations("do not merge to main")[0].decision, "revoke");
});

test("indented examples and nested shorter fences cannot become approval", () => {
  for (const prompt of ["Do not execute this example:\n    commit", "Example:\n\tcommit", "Example:\n\n \tcommit", "Example:\n\n   \tcommit", "````markdown\n```\ncommit\n```\n````", "~~~~\n~~~\nmerge to main\n~~~\n~~~~"]) {
    assert.deepEqual(parseUserAuthorizations(prompt), [], prompt);
  }
  assert.equal(parseUserAuthorizations("````\ncommit\n`````\ncommit it")[0]?.quote, "commit it");
});

test("repeated revocation in one turn retains its final source order and replay identity", async () => {
  const { root, data } = await fixture();
  const input = { projectRoot: root, sessionId: "s", turnId: "one-turn", source: "UserPromptSubmit" as const, prompt: "do not commit\ncommit\ndo not commit" };
  const first = await recordUserAuthorizations(data, input);
  assert.deepEqual(await recordUserAuthorizations(data, input), first);
  const status = await userAuthorizationStatus(data, { projectRoot: root, sessionId: "s" });
  assert.deepEqual(status.receipts.map(receipt => receipt.decision), ["revoke", "approve", "revoke"]);
  assert.equal(new Set(status.receipts.map(receipt => receipt.id)).size, 3);
});

test("approval persists across turns with original wording and isolated repository scope", async () => {
  const { root, data } = await fixture(), other = await fixture();
  const input = { projectRoot: root, sessionId: "session", turnId: "turn-1", intentId: "intent-food", source: "UserPromptSubmit" as const, prompt: "commit it" };
  const first = await recordUserAuthorizations(data, input);
  assert.equal(first[0].quote, "commit it");
  assert.deepEqual(await recordUserAuthorizations(data, input), first);
  assert.deepEqual(await recordUserAuthorizations(data, { ...input, turnId: "turn-2", prompt: "continue" }), []);
  const status = await userAuthorizationStatus(data, { projectRoot: root, intentId: "intent-food" });
  assert.equal(status.receipts.length, 1); assert.equal(status.receipts[0].turnId, "turn-1");
  assert.equal(status.receipts[0].decision, "approve");
  assert.deepEqual((await userAuthorizationStatus(data, { projectRoot: other.root, intentId: "intent-food" })).receipts, []);
  assert.deepEqual((await userAuthorizationStatus(data, { projectRoot: root, intentId: "intent-other" })).receipts, []);
});

test("merge approval stays bound to the named target and revocation stays visible", async () => {
  const { root, data } = await fixture();
  const base = { projectRoot: root, sessionId: "s", source: "UserPromptSubmit" as const };
  await recordUserAuthorizations(data, { ...base, turnId: "1", prompt: "merge to spike/colony" });
  assert.equal((await userAuthorizationStatus(data, { projectRoot: root, sessionId: "s", operation: "merge", targetBranch: "spike/colony" })).receipts.length, 1);
  assert.equal((await userAuthorizationStatus(data, { projectRoot: root, sessionId: "s", operation: "merge", targetBranch: "main" })).receipts.length, 0);
  assert.equal((await userAuthorizationStatus(data, { projectRoot: root, sessionId: "s", operation: "commit" })).receipts.length, 0);
  await recordUserAuthorizations(data, { ...base, turnId: "2", prompt: "do not merge to spike/colony" });
  const status = await userAuthorizationStatus(data, { projectRoot: root, sessionId: "s", operation: "merge", targetBranch: "spike/colony" });
  assert.equal(status.receipts.length, 2); assert.equal(status.receipts.at(-1)?.decision, "revoke");
});

test("untargeted Back is recorded evidence without granting an arbitrary target", async () => {
  const { root, data } = await fixture();
  const base = { projectRoot: root, sessionId: "s", intentId: "merge-task", source: "UserPromptSubmit" as const };
  await recordUserAuthorizations(data, { ...base, turnId: "1", prompt: "Merge Back" });
  const status = await userAuthorizationStatus(data, { projectRoot: root, sessionId: "s", operation: "merge" });
  assert.equal(status.receipts.length, 1);
  assert.equal(status.receipts[0].quote, "Merge Back");
  assert.equal(status.receipts[0].targetBranch, undefined);
  assert.equal((await userAuthorizationStatus(data, { projectRoot: root, sessionId: "s", operation: "merge", targetBranch: "main" })).receipts.length, 0);
  assert.equal((await userAuthorizationStatus(data, { projectRoot: root, sessionId: "other", operation: "merge" })).receipts.length, 0);
  assert.equal((await userAuthorizationStatus(data, { projectRoot: root, intentId: "other", operation: "merge" })).receipts.length, 0);
  await recordUserAuthorizations(data, { ...base, turnId: "2", prompt: "merge prep into main" });
  await recordUserAuthorizations(data, { ...base, turnId: "3", prompt: "merge back into main" });
  await recordUserAuthorizations(data, { ...base, turnId: "4", prompt: "do not merge back into main" });
  const target = await userAuthorizationStatus(data, { projectRoot: root, intentId: "merge-task", operation: "merge", targetBranch: "main" });
  assert.deepEqual(target.receipts.map(receipt => receipt.decision), ["approve", "revoke"]);
  assert.equal((await userAuthorizationStatus(data, { projectRoot: root, intentId: "merge-task", operation: "merge", targetBranch: "other" })).receipts.length, 0);
});

test("Finish receipts retain existing session, intent, and target scope", async () => {
  const { root, data } = await fixture();
  const base = { projectRoot: root, sessionId: "s", intentId: "alias-task", source: "UserPromptSubmit" as const };
  assert.deepEqual(await recordUserAuthorizations(data, { ...base, turnId: "begin", prompt: "merge begin into main" }), []);
  const [untargeted] = await recordUserAuthorizations(data, { ...base, turnId: "finish", prompt: "Merge Finish" });
  assert.equal(untargeted.quote, "Merge Finish");
  assert.equal(untargeted.targetBranch, undefined);
  assert.equal((await userAuthorizationStatus(data, { projectRoot: root, sessionId: "s", operation: "merge", targetBranch: "main" })).receipts.length, 0);
  await recordUserAuthorizations(data, { ...base, turnId: "target", prompt: "merge-finish into main" });
  await recordUserAuthorizations(data, { ...base, turnId: "revoke", prompt: "revoke merge finish to main" });
  const target = await userAuthorizationStatus(data, { projectRoot: root, intentId: "alias-task", operation: "merge", targetBranch: "main" });
  assert.deepEqual(target.receipts.map(receipt => receipt.decision), ["approve", "revoke"]);
  assert.equal((await userAuthorizationStatus(data, { projectRoot: root, sessionId: "other", operation: "merge" })).receipts.length, 0);
  assert.equal((await userAuthorizationStatus(data, { projectRoot: root, intentId: "other", operation: "merge" })).receipts.length, 0);
  assert.equal((await userAuthorizationStatus(data, { projectRoot: root, intentId: "alias-task", operation: "merge", targetBranch: "other" })).receipts.length, 0);
});

test("approval follows a governed task across worktrees but not another branch implicitly", async () => {
  const { root, data, git } = await fixture();
  await recordUserAuthorizations(data, { projectRoot: root, sessionId: "s", turnId: "1", intentId: "food", source: "UserPromptSubmit", prompt: "commit" });
  const linked = path.join(await mkdtemp(path.join(tmpdir(), "captain-approval-linked-")), "worktree");
  await git("worktree", "add", "-b", "food-work", linked);
  assert.equal((await userAuthorizationStatus(data, { projectRoot: linked, intentId: "food" })).receipts.length, 1);
  assert.equal((await userAuthorizationStatus(data, { projectRoot: linked, sessionId: "s" })).receipts.length, 0);
});

test("altered user wording fails signed receipt validation", async () => {
  const { root, data } = await fixture();
  const [receipt] = await recordUserAuthorizations(data, { projectRoot: root, sessionId: "s", turnId: "1", source: "UserPromptSubmit", prompt: "commit" });
  const file = path.join(data, "user-authorizations", `${receipt.id}.json`);
  const envelope = JSON.parse(await readFile(file, "utf8")); envelope.payload.quote = "merge to main";
  await writeFile(file, JSON.stringify(envelope));
  await assert.rejects(() => userAuthorizationStatus(data, { projectRoot: root, sessionId: "s" }), /authority tag is invalid/);
});

test("client intent adapter preserves the approval's provenance and task", async () => {
  const { root, data } = await fixture();
  const store = new LifecycleStore(data, async () => ({ exitCode: 0, stdout: "", stderr: "" }));
  const intent = await captainIssueIntent(store, { session_id: "s", turn_id: "user-turn", project_root: root, prompt: "commit it", task_id: "FOOD" });
  const status = await store.userAuthorizations({ projectRoot: root, intentId: intent.intent_id });
  assert.equal(status.receipts.length, 1);
  assert.equal(status.receipts[0].source, "client-adapter");
  assert.equal(status.receipts[0].taskId, "FOOD");
  assert.equal(status.receipts[0].turnId, "user-turn");
});
