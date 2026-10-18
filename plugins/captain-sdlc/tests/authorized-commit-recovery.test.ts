import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { LifecycleStore } from "../src/lifecycle.js";
import { captainReconcileAuthorizedCommit } from "../src/server.js";
import { git, sourceState } from "../src/workspace.js";

const temp = () => mkdtemp(path.join(tmpdir(), "captain-authorized-recovery-"));
const recoveryPolicy = { profile: "feature" as const, visualRequired: false, commands: { ticket: "ticket" }, redGate: { expectedExitCodes: [1], outputPattern: "ticket" } };
const makeStore = async (targetBranch?: string) => {
  const root = await temp(), data = await temp(), commonGitDir = path.join(root, ".git"), branch = "captain/task";
  await git(["init", "-b", "main"], root);
  await writeFile(path.join(root, "base.txt"), "base\n");
  await git(["add", "base.txt"], root);
  await git(["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "base"], root);
  const baseHead = await git(["rev-parse", "HEAD"], root);
  await git(["branch", branch], root);
  const worktreePath = path.join(root, ".captain-sdlc", "worktrees", "task");
  await mkdir(path.dirname(worktreePath), { recursive: true });
  await git(["worktree", "add", worktreePath, branch], root);
  const gitDir = await git(["rev-parse", "--path-format=absolute", "--git-dir"], worktreePath);
  const probe: StateProbe = async cwd => sourceState(cwd);
  const store = new LifecycleStore(data, async command => ({ exitCode: command === "ticket" ? 1 : 0, stdout: command, stderr: "" }), probe);
  await store.markIntent({ intentId: "task-intent", sessionId: "session", turnId: "turn", projectRoot: root, prompt: "Commit this task after tests pass.", taskId: "TASK-RECOVERY", targetBranch, targetOid: targetBranch ? baseHead : undefined });
  const lease = targetBranch ? await store.acquireTargetLease("task-intent", commonGitDir, targetBranch, baseHead) : {};
  await store.begin({ intentId: "task-intent", objective: "Commit this task after tests pass.", taskId: "TASK-RECOVERY", projectRoot: root, worktreePath, baseHead, branch, commonGitDir, gitDir, ...(targetBranch ? { targetBranch, targetOid: baseHead } : {}), ...lease, policy: recoveryPolicy });
  await store.recordRed("task-intent", "ticket");
  await store.recordUserRequest({ projectRoot: root, sessionId: "session", turnId: "turn", prompt: "Commit this task after tests pass.", source: "client-adapter", sourceRecordedAt: new Date().toISOString(), sourceIntentId: "task-intent", intentId: "task-intent", taskId: "TASK-RECOVERY", targetBranch, requestKind: "instruction" });
  const request = { paths: ["src/fix.ts", "VERSION", "CHANGELOG.md"], subject: "fix(captain): recover authorized commit (v1.0.1)", taskOutcome: "Implements" as const, final: true };
  const operation = await store.acquireCommitOperation("task-intent", request);
  await store.discardCommitOperation("task-intent", operation);
  await mkdir(path.join(worktreePath, "src"), { recursive: true });
  await writeFile(path.join(worktreePath, "src", "fix.ts"), "export const fixed = true;\n");
  await writeFile(path.join(worktreePath, "VERSION"), "1.0.1\n");
  await writeFile(path.join(worktreePath, "CHANGELOG.md"), "# Changelog\n\n## 1.0.1\n- recovery\n");
  await git(["add", ...request.paths], worktreePath);
  await git(["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", request.subject, "-m", "Task: TASK-RECOVERY"], worktreePath);
  const commit = { head: await git(["rev-parse", "HEAD"], worktreePath), tree: await git(["rev-parse", "HEAD^{tree}"], worktreePath), firstParent: baseHead, changedPaths: [...request.paths], commitCount: 1, clean: true, subject: request.subject, versionChanged: true, changelogChanged: true, taskTrailerValid: true, taskTrailerPresent: true, versionSurfacesValid: true, preparedMergesValid: true, phaseCommitsValid: true };
  return { store, request, commit, root, branch };
};

test("authorized commit recovery verifies the owned worktree and forwards the exact request", async () => {
  const run = {
    intentId: "task-intent",
    runId: "task-run",
    sessionId: "session",
    taskId: "TASK-RECOVERY",
    projectRoot: "E:/repo",
    worktreePath: "E:/repo/.captain-sdlc/worktrees/task",
    branch: "captain/task",
    targetBranch: "captain/task",
    commonGitDir: "E:/repo/.git",
    gitDir: "E:/repo/.git/worktrees/task",
    baseHead: "a".repeat(40),
    policy: {},
    preparedMerges: []
  };
  const request = {
    intent_id: run.intentId,
    paths: ["src/fix.ts", "VERSION", "CHANGELOG.md"],
    subject: "fix(captain): recover authorized commit (v1.0.1)",
    task_outcome: "Implements" as const,
    final: true
  };
  const evidence = {
    head: "b".repeat(40),
    tree: "c".repeat(40),
    firstParent: run.baseHead,
    changedPaths: [...request.paths],
    commitCount: 1,
    clean: true,
    subject: request.subject,
    versionChanged: true,
    changelogChanged: true,
    taskTrailerValid: true,
    taskTrailerPresent: true,
    versionSurfacesValid: true,
    preparedMergesValid: true,
    phaseCommitsValid: true
  };
  const calls: unknown[][] = [];
  const store = {
    status: async (intentId: string) => {
      assert.equal(intentId, run.intentId);
      return run;
    },
    reconcileAuthorizedCommit: async (...args: unknown[]) => {
      calls.push(args);
      return { intentId: run.intentId, phase: "prove" };
    }
  } as any;
  const dependencies = {
    assertWorktreeBinding: async (...args: unknown[]) => calls.push(args),
    commitEvidence: async (...args: unknown[]) => {
      assert.deepEqual(args, [run.worktreePath, run.baseHead, run.policy, run.taskId, run.preparedMerges, undefined]);
      return evidence;
    }
  } as any;

  const result = await captainReconcileAuthorizedCommit(store, request, dependencies);

  assert.equal(result.phase, "prove");
  assert.deepEqual(calls.at(-1), [run.intentId, {
    paths: request.paths,
    subject: request.subject,
    taskOutcome: request.task_outcome,
    final: request.final
  }, evidence]);
});

test("reconciles only the exact commit whose signed operation was discarded before candidate preparation", async () => {
  const { store, request, commit } = await makeStore("captain/task");
  const alteredRequest = { ...request, subject: "fix(captain): different authorized request (v1.0.1)" };
  await assert.rejects(() => store.reconcileAuthorizedCommit("task-intent", alteredRequest, { ...commit, subject: alteredRequest.subject }), /no matching signed failed commit operation/);
  await assert.rejects(() => store.reconcileAuthorizedCommit("task-intent", request, { ...commit, commitCount: 2 }), /single-parent task commit/);
  await assert.rejects(() => store.reconcileAuthorizedCommit("task-intent", request, { ...commit, firstParent: "f".repeat(40) }), /single-parent task commit/);
  const accepted = await store.reconcileAuthorizedCommit("task-intent", request, commit);
  assert.equal(accepted.phase, "prove");
  assert.ok(accepted.evidence.some((event: any) => event.kind === "authorized_commit_reconciled" && event.requestSha256));
  await assert.rejects(() => store.reconcileAuthorizedCommit("task-intent", request, commit), /phase|reconciliation/);
});

test("does not reconcile an unprepared merge commit without signed parent evidence", async () => {
  const { store, request, commit } = await makeStore("captain/task");
  await assert.rejects(() => store.reconcileAuthorizedCommit("task-intent", request, { ...commit, preparedMergesValid: false }), /prepared merge/);
});
