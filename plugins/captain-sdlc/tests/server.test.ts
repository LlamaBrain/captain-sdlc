import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { LifecycleStore, type StateProbe } from "../src/lifecycle.js";
import { captainAbortMerge, captainBegin, captainCommit, captainIssueIntent, captainPrepareMerge, captainResume, type CaptainBeginStage } from "../src/server.js";
import { writeAuthorized } from "../src/authority.js";

const temp = () => mkdtemp(path.join(tmpdir(), "captain-commit-"));
const policy = { profile: "feature" as const, visualRequired: false, commands: { ticket: "ticket" }, redGate: { expectedExitCodes: [1], outputPattern: "ticket" } };

test("resume reconciles an advanced signed candidate before consuming the resume intent", async () => {
  const candidate = "b".repeat(40), head = "e".repeat(40), tree = "c".repeat(40), subject = "fix(x): prepared (v1.0.1)";
  const run = { intentId: "old", worktreePath: "worktree", branch: "captain/old", commonGitDir: "git", gitDir: "linked", baseHead: "a".repeat(40), policy, preparedMerges: [], preparedCommit: { preCommitHead: "a".repeat(40), candidate, tree, subject } };
  const calls: string[] = [];
  const store = { resumeTarget: async () => run, recoverAdvancedPreparedCommit: async () => { calls.push("recover"); }, resume: async () => { calls.push("resume"); return run; } } as unknown as LifecycleStore;
  const evidence = { head, tree: "d".repeat(40), commitCount: 2, clean: false, subject: "fix(x): later (v1.0.2)", versionChanged: true, changelogChanged: true, phaseCommitsValid: true, preparedMergesValid: true, previousPhaseRetained: true };
  await captainResume(store, "resume-id", {
    assertWorktreeBinding: async () => ({ head }),
    git: async (args: string[]) => args[0] === "rev-list" ? `${candidate}\n${head}` : args[1]?.includes("^{tree}") ? tree : subject,
    commitEvidence: async () => evidence
  } as any);
  assert.deepEqual(calls, ["recover", "resume"]);
});

test("client-neutral intent issuance creates one signed begin or resume instruction", async () => {
  const root = await temp(), data = await temp(), store = new LifecycleStore(data, async () => ({ exitCode: 0, stdout: "", stderr: "" }));
  const begun = await captainIssueIntent(store, { session_id: "opencode-session", turn_id: "turn-1", project_root: root, prompt: "implement handoff" });
  assert.match(begun.intent_id, /^intent-/); assert.match(begun.begin_instruction!, /captain_begin_implementation/);
  assert.equal((await store.validateIntent(begun.intent_id, root)).sessionId, "opencode-session");
  await store.markIntent({ intentId: "done", sessionId: "s", turnId: "t", projectRoot: root, prompt: "done" });
  await assert.rejects(() => captainIssueIntent(store, { session_id: "s", turn_id: "t2", project_root: root, prompt: "resume", resume_of: "done" }), /ENOENT|not found/);
});

test("distinct concurrent captain_commit is excluded and the signed CAS interruption recovers", async () => {
  const root = await temp(), data = await temp(), worktree = path.join(root, ".captain-sdlc", "worktrees", "commit");
  const commonGitDir = path.join(root, ".git"), gitDir = path.join(commonGitDir, "worktrees", "commit"), branch = "captain/commit";
  await mkdir(worktree, { recursive: true });
  let head = "a".repeat(40), tree = "c".repeat(40);
  const probe: StateProbe = async () => ({ head, tree, status: "", branch, branchHead: head, commonGitDir, topLevel: worktree, gitDir });
  const store = new LifecycleStore(data, async command => ({ exitCode: command === "ticket" ? 1 : 0, stdout: command, stderr: "" }), probe);
  await store.markIntent({ intentId: "commit", sessionId: "s", turnId: "t", projectRoot: root, prompt: "commit" });
  await store.begin({ intentId: "commit", objective: "commit", projectRoot: root, worktreePath: worktree, baseHead: head, branch, commonGitDir, gitDir, policy });
  await store.recordRed("commit", "ticket");

  const candidate = "b".repeat(40), firstRequest = { intent_id: "commit", paths: ["VERSION"], subject: "fix(commit): recover CAS (v1.0.1)", final: true };
  let authorizeStarted!: () => void, interruptCas!: () => void, atomicCalls = 0;
  const authorized = new Promise<void>(resolve => { authorizeStarted = resolve; });
  const continueAfterAuthorization = new Promise<void>(resolve => { interruptCas = resolve; });
  const dependencies = {
    assertWorktreeBinding: async () => ({ branch, commonGitDir, gitDir, topLevel: worktree, head }),
    commitAtomic: async (...args: any[]) => {
      atomicCalls++;
      const authorize = args[11] as (prepared: { preCommitHead: string; candidate: string; tree: string }) => Promise<void>;
      await authorize({ preCommitHead: head, candidate, tree });
      authorizeStarted();
      await continueAfterAuthorization;
      head = candidate;
      throw new Error("simulated interruption after compare-and-swap");
    },
    reconcilePreparedCommit: async () => undefined,
    commitEvidence: async () => ({ head, tree, commitCount: 1, clean: true, subject: firstRequest.subject, versionChanged: true, changelogChanged: true, preparedMergesValid: true, phaseCommitsValid: true })
  };

  const interrupted = captainCommit(store, firstRequest, dependencies);
  await authorized;
  await assert.rejects(() => captainCommit(store, { ...firstRequest, subject: "fix(commit): race (v1.0.2)" }, dependencies), /commit operation|exact approved commit request/);
  interruptCas();
  await assert.rejects(() => interrupted, /compare-and-swap/);
  assert.equal((await store.status("commit")).preparedCommit?.candidate, candidate);

  const recovered = await captainCommit(store, firstRequest, dependencies);
  assert.equal(recovered.phase, "prove");
  assert.equal(recovered.preparedCommit, undefined);
  assert.equal(recovered.commitOperation, undefined);
  assert.equal(atomicCalls, 1);
  const repeated = await captainCommit(store, firstRequest, dependencies); assert.equal(repeated.revision, recovered.revision); assert.equal(repeated.committedState?.head, recovered.committedState?.head);
  assert.equal(atomicCalls, 1);
});

test("captain_commit applies the already signed candidate when recovery starts at pre-HEAD", async () => {
  const root = await temp(), data = await temp(), worktree = path.join(root, ".captain-sdlc", "worktrees", "commit"), commonGitDir = path.join(root, ".git"), gitDir = path.join(commonGitDir, "worktrees", "commit"), branch = "captain/commit";
  await mkdir(worktree, { recursive: true }); let head = "a".repeat(40), tree = "c".repeat(40), atomicCalls = 0, applyCalls = 0;
  const store = new LifecycleStore(data, async command => ({ exitCode: command === "ticket" ? 1 : 0, stdout: command, stderr: "" }), async () => ({ head, tree, status: "", branch, branchHead: head, commonGitDir, topLevel: worktree, gitDir }));
  await store.markIntent({ intentId: "pre-head", sessionId: "s", turnId: "t", projectRoot: root, prompt: "commit" });
  await store.begin({ intentId: "pre-head", objective: "commit", projectRoot: root, worktreePath: worktree, baseHead: head, branch, commonGitDir, gitDir, policy }); await store.recordRed("pre-head", "ticket");
  const candidate = "b".repeat(40), request = { intent_id: "pre-head", paths: ["VERSION"], subject: "fix(commit): apply signed candidate (v1.0.1)", final: true };
  const dependencies = {
    assertWorktreeBinding: async () => ({ branch, commonGitDir, gitDir, topLevel: worktree, head }),
    commitAtomic: async (...args: any[]) => { atomicCalls++; const authorize = args[11] as (prepared: { preCommitHead: string; candidate: string; tree: string }) => Promise<void>; await authorize({ preCommitHead: head, candidate, tree }); throw new Error("crash before ref compare-and-swap"); },
    applyPreparedCommit: async () => { applyCalls++; head = candidate; },
    reconcilePreparedCommit: async () => undefined,
    commitEvidence: async () => ({ head, tree, commitCount: 1, clean: true, subject: request.subject, versionChanged: true, changelogChanged: true, preparedMergesValid: true, phaseCommitsValid: true })
  };
  await assert.rejects(() => captainCommit(store, request, dependencies), /before ref compare-and-swap/);
  const recovered = await captainCommit(store, request, dependencies);
  assert.equal(recovered.phase, "prove"); assert.equal(atomicCalls, 1); assert.equal(applyCalls, 1);
});

test("captain_commit exact retry finalizes a terminal commit after a crash before lease release", async () => {
  const root = await temp(), data = await temp(), worktree = path.join(root, ".captain-sdlc", "worktrees", "terminal"), commonGitDir = path.join(root, ".git"), gitDir = path.join(commonGitDir, "worktrees", "terminal"), branch = "captain/terminal";
  await mkdir(worktree, { recursive: true }); let head = "a".repeat(40), atomicCalls = 0, crashed = false; const tree = "c".repeat(40), candidate = "b".repeat(40), probe: StateProbe = async () => ({ head, tree, status: "", branch, branchHead: head, commonGitDir, topLevel: worktree, gitDir });
  const first = new LifecycleStore(data, async command => ({ exitCode: command === "ticket" ? 1 : 0, stdout: command, stderr: "" }), probe, { afterTerminalCommit: async () => { if (!crashed) { crashed = true; throw new Error("crash before terminal lease release"); } } });
  await first.markIntent({ intentId: "terminal", sessionId: "s", turnId: "t", projectRoot: root, prompt: "commit" }); await first.begin({ intentId: "terminal", objective: "commit", projectRoot: root, worktreePath: worktree, baseHead: head, branch, commonGitDir, gitDir, policy }); await first.recordRed("terminal", "ticket");
  const request = { intent_id: "terminal", paths: ["VERSION"], subject: "fix(commit): terminal recovery (v1.0.1)", final: true }, dependencies = {
    assertWorktreeBinding: async () => ({ branch, commonGitDir, gitDir, topLevel: worktree, head }), applyPreparedCommit: async () => undefined, reconcilePreparedCommit: async () => undefined,
    commitAtomic: async (...args: any[]) => { atomicCalls++; const authorize = args[11]; await authorize({ preCommitHead: head, candidate, tree }); const validate = args[14]; await validate({ preCommitHead: head, candidate, tree }); head = candidate; },
    commitEvidence: async () => ({ head, tree, commitCount: 1, clean: true, subject: request.subject, versionChanged: true, changelogChanged: true, preparedMergesValid: true, phaseCommitsValid: true })
  };
  await assert.rejects(() => captainCommit(first, request, dependencies), /crash before terminal lease release/); assert.equal((await first.status("terminal")).terminalCommit?.candidate, candidate);
  const recovered = await captainCommit(new LifecycleStore(data, async () => ({ exitCode: 0, stdout: "", stderr: "" }), probe), request, dependencies); assert.equal(recovered.phase, "prove"); assert.equal(recovered.terminalCommit, undefined); assert.equal(atomicCalls, 1);
});

test("abort cannot revoke a merge paused after authority validation and Git launch", async () => {
  const root = await temp(), data = await temp(), worktree = path.join(root, ".captain-sdlc", "worktrees", "merge"), commonGitDir = path.join(root, ".git"), gitDir = path.join(commonGitDir, "worktrees", "merge"), branch = "captain/merge", head = "a".repeat(40), target = "b".repeat(40);
  await mkdir(worktree, { recursive: true }); const store = new LifecycleStore(data, async command => ({ exitCode: command === "ticket" ? 1 : 0, stdout: command, stderr: "" }), async () => ({ head, tree: "c".repeat(40), status: "", branch, branchHead: head, commonGitDir, topLevel: worktree, gitDir }));
  await store.markIntent({ intentId: "merge-race", sessionId: "s", turnId: "t", projectRoot: root, prompt: "merge" }); await store.begin({ intentId: "merge-race", objective: "merge", projectRoot: root, worktreePath: worktree, baseHead: head, branch, commonGitDir, gitDir, policy }); await store.recordRed("merge-race", "ticket");
  let launched!: () => void, resume!: () => void, gitMutations = 0, aborts = 0; const started = new Promise<void>(resolve => { launched = resolve; }), paused = new Promise<void>(resolve => { resume = resolve; });
  const dependencies = {
    assertWorktreeBinding: async () => ({ branch, commonGitDir, gitDir, topLevel: worktree, head }), reconcilePreparedMerge: async () => undefined, preparedMergeState: async () => "clean" as const,
    prepareMerge: async (...args: any[]) => { const authorize = args[3], validate = args[11], operationToken = args[10], prepared = { preMergeHead: head, targetOid: target, strategy: "ort" as const, operationToken }; await authorize(prepared); await validate(prepared); launched(); await paused; gitMutations++; return { status: "ready" as const }; },
    abortMerge: async (_worktree: string, prepared: any, validate: any) => { await validate(prepared); aborts++; }
  };
  const preparing = captainPrepareMerge(store, { intent_id: "merge-race", commit_oid: target, strategy: "ort" }, dependencies as any); await started;
  await assert.rejects(() => captainAbortMerge(store, { intent_id: "merge-race" }, dependencies as any), /clean pre-merge recovery/); resume(); await preparing;
  assert.equal(aborts, 0); assert.equal(gitMutations, 1);
});

test("clean pre-merge crash recovery resumes only the exact signed prepare generation", async () => {
  const root = await temp(), data = await temp(), worktree = path.join(root, ".captain-sdlc", "worktrees", "merge"), commonGitDir = path.join(root, ".git"), gitDir = path.join(commonGitDir, "worktrees", "merge"), branch = "captain/merge", head = "a".repeat(40), target = "b".repeat(40); await mkdir(worktree, { recursive: true }); const store = new LifecycleStore(data, async command => ({ exitCode: command === "ticket" ? 1 : 0, stdout: command, stderr: "" }), async () => ({ head, tree: "c".repeat(40), status: "", branch, branchHead: head, commonGitDir, topLevel: worktree, gitDir })); await store.markIntent({ intentId: "merge-restart", sessionId: "s", turnId: "t", projectRoot: root, prompt: "merge" }); await store.begin({ intentId: "merge-restart", objective: "merge", projectRoot: root, worktreePath: worktree, baseHead: head, branch, commonGitDir, gitDir, policy }); await store.recordRed("merge-restart", "ticket");
  let crash = true, gitMutations = 0; const dependencies = { assertWorktreeBinding: async () => ({ branch, commonGitDir, gitDir, topLevel: worktree, head }), reconcilePreparedMerge: async () => undefined, preparedMergeState: async () => "clean" as const, abortMerge: async () => undefined, prepareMerge: async (...args: any[]) => { const authorize = args[3], validate = args[11], operationToken = args[10], prepared = { preMergeHead: head, targetOid: target, strategy: "ort" as const, operationToken }; await authorize(prepared); await validate(prepared); if (crash) { crash = false; throw new Error("crash after Git launch before MERGE_HEAD"); } gitMutations++; return { status: "ready" as const }; } };
  await assert.rejects(() => captainPrepareMerge(store, { intent_id: "merge-restart", commit_oid: target, strategy: "ort" }, dependencies as any), /crash after Git launch/); await assert.rejects(() => captainPrepareMerge(store, { intent_id: "merge-restart", commit_oid: target, strategy: "ours" }, dependencies as any), /mutation|active/); await captainPrepareMerge(store, { intent_id: "merge-restart", commit_oid: target, strategy: "ort" }, dependencies as any); assert.equal(gitMutations, 1); assert.equal((await store.status("merge-restart")).preparedMerges?.length, 1); assert.equal((await store.status("merge-restart")).mutationOperation, undefined);
});

test("a completed prepared merge releases its fence and can later be aborted with a new generation", async () => {
  const root = await temp(), data = await temp(), worktree = path.join(root, ".captain-sdlc", "worktrees", "merge"), commonGitDir = path.join(root, ".git"), gitDir = path.join(commonGitDir, "worktrees", "merge"), branch = "captain/merge", head = "a".repeat(40), target = "b".repeat(40);
  await mkdir(worktree, { recursive: true }); const store = new LifecycleStore(data, async command => ({ exitCode: command === "ticket" ? 1 : 0, stdout: command, stderr: "" }), async () => ({ head, tree: "c".repeat(40), status: "", branch, branchHead: head, commonGitDir, topLevel: worktree, gitDir }));
  await store.markIntent({ intentId: "merge-abort", sessionId: "s", turnId: "t", projectRoot: root, prompt: "merge" }); await store.begin({ intentId: "merge-abort", objective: "merge", projectRoot: root, worktreePath: worktree, baseHead: head, branch, commonGitDir, gitDir, policy }); await store.recordRed("merge-abort", "ticket");
  let prepareToken = "", abortToken = ""; const dependencies = {
    assertWorktreeBinding: async () => ({ branch, commonGitDir, gitDir, topLevel: worktree, head }), reconcilePreparedMerge: async () => undefined, preparedMergeState: async () => "pinned" as const,
    prepareMerge: async (...args: any[]) => { const authorize = args[3], validate = args[11], operationToken = args[10], prepared = { preMergeHead: head, targetOid: target, strategy: "ort" as const, operationToken }; prepareToken = operationToken; await authorize(prepared); await validate(prepared); return { status: "ready" as const }; },
    abortMerge: async (_worktree: string, prepared: any, validate: any) => { abortToken = (await store.status("merge-abort")).mutationOperation!.leaseToken; await validate(prepared); }
  };
  await captainPrepareMerge(store, { intent_id: "merge-abort", commit_oid: target, strategy: "ort" }, dependencies as any); assert.equal((await store.status("merge-abort")).mutationOperation, undefined);
  await captainAbortMerge(store, { intent_id: "merge-abort" }, dependencies as any); assert.notEqual(abortToken, prepareToken); assert.equal((await store.status("merge-abort")).preparedMerges?.length, 0);
});

const beginPolicy = { profile: "feature" as const, profiles: ["feature" as const], visualRequired: false, commands: { ticket: "ticket" }, redGate: { expectedExitCodes: [1], outputPattern: "ticket" } };
const beginDependencies = (root: string, worktree: string, afterStage?: (stage: CaptainBeginStage) => Promise<void>) => {
  const commonGitDir = path.join(root, ".git"), gitDir = path.join(commonGitDir, "worktrees", "begin"), baseHead = "a".repeat(40), branch = "colony/spike";
  return {
    repositoryIdentity: async () => ({ projectRoot: root, baseHead, commonGitDir }),
    loadPolicy: async () => beginPolicy,
    ensureWorktree: async () => ({ projectRoot: root, worktreePath: worktree, baseHead, targetBranch: branch, branch, commonGitDir, gitDir }),
    afterStage
  };
};

for (const crashStage of ["reservation", "lease-acquired", "worktree-created", "run", "permit", "active"] as CaptainBeginStage[]) test(`captain_begin restarts exactly after ${crashStage}`, async () => {
  const root = await temp(), data = await temp(), worktree = path.join(root, ".captain-sdlc", "worktrees", "begin"), args = { intent_id: "begin", objective: "integrate", project_root: root, task_id: "COLONY" };
  await mkdir(worktree, { recursive: true });
  const first = new LifecycleStore(data, async () => ({ exitCode: 0, stdout: "", stderr: "" }));
  await first.markIntent({ intentId: "begin", sessionId: "s", turnId: "t", projectRoot: root, prompt: "integrate", targetBranch: "colony/spike", targetOid: "a".repeat(40) });
  let failed = false;
  await assert.rejects(() => captainBegin(first, args, beginDependencies(root, worktree, async stage => { if (!failed && stage === crashStage) { failed = true; throw new Error(`crash after ${stage}`); } })), new RegExp(`crash after ${crashStage}`));
  const reservation = await first.beginOperationFor("begin");
  const restarted = new LifecycleStore(data, async () => ({ exitCode: 0, stdout: "", stderr: "" }));
  const run = await captainBegin(restarted, args, beginDependencies(root, worktree));
  assert.equal(run.runId, reservation.runId);
  assert.equal(run.startedAt, reservation.startedAt);
  assert.deepEqual(await restarted.status("begin"), run);
  assert.equal((await restarted.beginOperationFor("begin")).operationToken, reservation.operationToken);
});

test("concurrent exact captain_begin calls converge on one signed run", async () => {
  const root = await temp(), data = await temp(), worktree = path.join(root, ".captain-sdlc", "worktrees", "begin"), args = { intent_id: "same", objective: "integrate", project_root: root };
  await mkdir(worktree, { recursive: true });
  const first = new LifecycleStore(data, async () => ({ exitCode: 0, stdout: "", stderr: "" })), second = new LifecycleStore(data, async () => ({ exitCode: 0, stdout: "", stderr: "" }));
  await first.markIntent({ intentId: "same", sessionId: "s", turnId: "t", projectRoot: root, prompt: "integrate", targetBranch: "colony/spike", targetOid: "a".repeat(40) });
  const [left, right] = await Promise.all([captainBegin(first, args, beginDependencies(root, worktree)), captainBegin(second, args, beginDependencies(root, worktree))]);
  assert.deepEqual(left, right);
  assert.equal(left.runId, (await first.beginOperationFor("same")).runId);
});

test("exact captain_begin retry after lifecycle progress returns the authoritative revision", async () => {
  const root = await temp(), data = await temp(), worktree = path.join(root, ".captain-sdlc", "worktrees", "begin"), args = { intent_id: "progressed", objective: "integrate", project_root: root };
  await mkdir(worktree, { recursive: true }); const store = new LifecycleStore(data, async command => ({ exitCode: command === "ticket" ? 1 : 0, stdout: command, stderr: "" }));
  await store.markIntent({ intentId: "progressed", sessionId: "s", turnId: "t", projectRoot: root, prompt: "integrate", targetBranch: "colony/spike", targetOid: "a".repeat(40) });
  await captainBegin(store, args, beginDependencies(root, worktree)); const progressed = await store.recordRed("progressed", "ticket"), retried = await captainBegin(new LifecycleStore(data, async () => ({ exitCode: 0, stdout: "", stderr: "" })), args, beginDependencies(root, worktree));
  assert.equal(retried.phase, "implement"); assert.equal(retried.revision, progressed.revision); assert.deepEqual(retried, progressed);
});

test("an incomplete prior-turn begin activates only a signed current-turn permit on retry", async () => {
  const root = await temp(), data = await temp(), worktree = path.join(root, ".captain-sdlc", "worktrees", "begin"), args = { intent_id: "later", objective: "integrate", project_root: root }; await mkdir(worktree, { recursive: true }); const store = new LifecycleStore(data, async () => ({ exitCode: 0, stdout: "", stderr: "" }));
  await store.markIntent({ intentId: "later", sessionId: "s", turnId: "prior", projectRoot: root, prompt: "integrate", targetBranch: "colony/spike", targetOid: "a".repeat(40) }); await assert.rejects(() => captainBegin(store, args, beginDependencies(root, worktree, async stage => { if (stage === "reservation") throw new Error("crash on prior turn"); })), /crash on prior turn/);
  const operation = await store.beginOperationFor("later"); await writeAuthorized(data, "begin-turn-resumes", operation.operationToken, { schemaVersion: 1, operationToken: operation.operationToken, intentId: operation.intentId, sessionId: "s", turnId: "current" }); const run = await captainBegin(store, args, beginDependencies(root, worktree));
  assert.equal(run.turnId, "current"); assert.ok(await store.permitFor("s", "current")); assert.equal(await store.permitFor("s", "prior"), null);
});

test("captain_begin rejects changed retry arguments", async () => {
  const root = await temp(), data = await temp(), worktree = path.join(root, ".captain-sdlc", "worktrees", "begin"), args = { intent_id: "drift", objective: "integrate", project_root: root, task_id: "COLONY" };
  await mkdir(worktree, { recursive: true });
  const store = new LifecycleStore(data, async () => ({ exitCode: 0, stdout: "", stderr: "" }));
  await store.markIntent({ intentId: "drift", sessionId: "s", turnId: "t", projectRoot: root, prompt: "integrate", targetBranch: "colony/spike", targetOid: "a".repeat(40) });
  await assert.rejects(() => captainBegin(store, args, beginDependencies(root, worktree, async stage => { if (stage === "reservation") throw new Error("crash after reservation"); })), /crash after reservation/);
  await assert.rejects(() => captainBegin(store, { ...args, objective: "different" }, beginDependencies(root, worktree)), /signed begin reservation/);
  await assert.rejects(() => captainBegin(store, { ...args, task_id: "OTHER" }, beginDependencies(root, worktree)), /signed begin reservation/);
  await assert.rejects(() => captainBegin(store, { ...args, project_root: path.join(root, "other") }, beginDependencies(root, worktree)), /signed begin reservation|project root/);
});

for (const changed of ["sessionId", "turnId", "targetBranch", "targetOid"] as const) test(`captain_begin rejects changed signed intent ${changed}`, async () => {
  const root = await temp(), data = await temp(), args = { intent_id: "intent-drift", objective: "integrate", project_root: root }, original = { intentId: "intent-drift", sessionId: "s", turnId: "t", projectRoot: root, prompt: "integrate", targetBranch: "colony/spike", targetOid: "a".repeat(40) };
  const store = new LifecycleStore(data, async () => ({ exitCode: 0, stdout: "", stderr: "" })); await store.markIntent(original);
  await store.reserveBegin({ intentId: args.intent_id, objective: args.objective, projectRoot: args.project_root });
  const replacements = { sessionId: "other-session", turnId: "other-turn", targetBranch: "other/branch", targetOid: "b".repeat(40) };
  await writeAuthorized(data, "intents", original.intentId, { ...original, [changed]: replacements[changed] });
  await assert.rejects(() => store.reserveBegin({ intentId: args.intent_id, objective: args.objective, projectRoot: args.project_root }), /signed begin reservation/);
});

test("a corrupt authenticated begin checkpoint blocks restart", async () => {
  const root = await temp(), data = await temp(), worktree = path.join(root, ".captain-sdlc", "worktrees", "begin"), args = { intent_id: "corrupt", objective: "integrate", project_root: root };
  await mkdir(worktree, { recursive: true }); const store = new LifecycleStore(data, async () => ({ exitCode: 0, stdout: "", stderr: "" }));
  await store.markIntent({ intentId: "corrupt", sessionId: "s", turnId: "t", projectRoot: root, prompt: "integrate", targetBranch: "colony/spike", targetOid: "a".repeat(40) });
  await assert.rejects(() => captainBegin(store, args, beginDependencies(root, worktree, async stage => { if (stage === "lease-acquired") throw new Error("crash"); })), /crash/);
  const operation = await store.beginOperationFor("corrupt"), checkpointPath = path.join(data, "begin-repositories", `${operation.operationToken}.json`), envelope = JSON.parse(await readFile(checkpointPath, "utf8"));
  envelope.payload.projectRoot = path.join(root, "forged"); await writeFile(checkpointPath, JSON.stringify(envelope));
  await assert.rejects(() => captainBegin(new LifecycleStore(data, async () => ({ exitCode: 0, stdout: "", stderr: "" })), args, beginDependencies(root, worktree)), /authority tag/);
});

test("target lease ownership is generation-exact across begin operations", async () => {
  const root = await temp(), data = await temp(), commonGitDir = path.join(root, ".git"), baseHead = "a".repeat(40), store = new LifecycleStore(data, async () => ({ exitCode: 0, stdout: "", stderr: "" }));
  const firstIntent = { intentId: "owner", sessionId: "s1", turnId: "t1", projectRoot: root, prompt: "integrate", targetBranch: "colony/spike", targetOid: baseHead }, secondIntent = { ...firstIntent, intentId: "other", sessionId: "s2", turnId: "t2" };
  await store.markIntent(firstIntent); await store.markIntent(secondIntent);
  const first = await store.reserveBegin({ intentId: "owner", objective: "integrate", projectRoot: root }), firstRepository = await store.checkpointBeginRepository(first, { projectRoot: root, baseHead, commonGitDir }, beginPolicy), lease = (await store.ensureBeginTargetLease(first, firstRepository))!;
  const second = await store.reserveBegin({ intentId: "other", objective: "integrate", projectRoot: root }), secondRepository = await store.checkpointBeginRepository(second, { projectRoot: root, baseHead, commonGitDir }, beginPolicy);
  await assert.rejects(() => store.ensureBeginTargetLease(second, secondRepository), /leased/);
  await assert.rejects(() => store.releaseTargetLease(lease.leaseId, second.intentId, second.leaseToken), /generation/);
  await store.releaseTargetLease(lease.leaseId, first.intentId, first.leaseToken);
  assert.equal((await store.ensureBeginTargetLease(second, secondRepository))?.leaseId, lease.leaseId);
});
