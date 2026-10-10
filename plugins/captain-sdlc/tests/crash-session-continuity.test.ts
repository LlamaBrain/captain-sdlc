import assert from "node:assert/strict";
import test from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { captureClientSessionOwner, probeSessionOwner } from "../src/session-interruption.js";
import { mkdtemp, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { LifecycleStore, type SourceState } from "../src/lifecycle.js";
import { readAuthorizedLeaseSnapshotReadOnly } from "../src/authority.js";
import { captainIssueIntent } from "../src/server.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const expectedFailure = (pattern: RegExp) => (error: unknown) =>
  error instanceof Error && !(error instanceof TypeError) && pattern.test(error.message);
type OwnerState = "live" | "stopped" | "foreign_host" | "unknown" | "legacy";
type RecoveryArgs = {
  intentId: string; sessionId: string; expectedRunRevision: number;
  expectedSessionLeaseRevision: number; resourceGeneration: string;
  summary: string; nextSteps: string[];
};

async function fixture(options: { state?: OwnerState; owner?: boolean; failAfterPause?: boolean } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "captain-crash-session-"));
  const data = await mkdtemp(path.join(tmpdir(), "captain-crash-authority-"));
  const worktree = path.join(root, ".captain-sdlc", "worktrees", "owned-task");
  await mkdir(worktree, { recursive: true });
  await writeFile(path.join(worktree, "unfinished.txt"), "retained task work\n");
  const closeToken = randomUUID();
  const owner = { pid: 424242, host: "verified-local-host", startedAt: "verified-process-start", closeTokenHash: hash(closeToken) };
  let ownerState: OwnerState = options.state ?? "stopped";
  let currentOwner = owner;
  let probes = 0;
  let crashRecorded = false;
  const state: SourceState = {
    head: "a".repeat(40), tree: "b".repeat(40), status: "?? unfinished.txt\n",
    branch: "captain/owned-task", branchHead: "a".repeat(40),
    topLevel: worktree, commonGitDir: path.join(root, ".git"),
    gitDir: path.join(root, ".git", "worktrees", "owned-task"),
  };
  const hooks = {
    afterRunRevision: async (run: { status: string }) => {
      if (options.failAfterPause && run.status === "paused" && !crashRecorded) {
        crashRecorded = true; throw new Error("simulated client recovery crash after signed pause");
      }
    },
    ...(options.owner === false ? {} : { sessionOwner: async () => currentOwner }),
    probeSessionOwner: async (captured: unknown) => {
      assert.ok(JSON.stringify(captured) === JSON.stringify(owner) || JSON.stringify(captured) === JSON.stringify(currentOwner), "probe must receive captured client identity");
      probes++;
      return { state: JSON.stringify(captured) === JSON.stringify(owner) ? ownerState : "live" as OwnerState };
    },
  };
  const store = new LifecycleStore(data,
    async () => ({ exitCode: 1, stdout: "changed behavior absent", stderr: "" }),
    async () => ({ ...state }), hooks as any);
  await store.markIntent({ intentId: "interrupted-task", sessionId: "client-before-close", turnId: "old-turn", projectRoot: root, prompt: "implement this task" });
  await store.begin({
    intentId: "interrupted-task", taskId: "runtime-artifacts", objective: "retain the same interrupted task",
    projectRoot: root, worktreePath: worktree, baseHead: state.head,
    branch: state.branch!, commonGitDir: state.commonGitDir!, gitDir: state.gitDir!,
    policy: { profile: "low", visualRequired: false, commands: { ticket: "focused-red", build: "build" },
      redGate: { expectedExitCodes: [1], outputPattern: "changed behavior absent" } },
  });
  await store.recordRed("interrupted-task");
  async function selectors(): Promise<RecoveryArgs> {
    const run = await store.status("interrupted-task");
    const lease = await readAuthorizedLeaseSnapshotReadOnly<any>(data, run.sessionLeaseId!);
    assert.ok(lease && !lease.legacy && lease.state === "held");
    return {
      intentId: run.intentId, sessionId: run.sessionId, expectedRunRevision: run.revision,
      expectedSessionLeaseRevision: lease.revision!,
      resourceGeneration: hash(JSON.stringify({ leaseId: run.sessionLeaseId, revision: lease.revision, state: "held", payload: lease.payload })),
      summary: "Client session ended during implementation",
      nextSteps: ["Resume the retained task and finish focused proof"],
    };
  }
  return { store, root, data, worktree, state, owner, closeToken, selectors,
    get probes() { return probes; }, setOwnerState(value: OwnerState) { ownerState = value; },
    setClientOwner(value: typeof owner) { currentOwner = value; } };
}

// New APIs are deliberately invoked dynamically so the baseline reaches behavior
// assertions and fails red before their production implementation exists.
const recover = (store: LifecycleStore, args: RecoveryArgs) => (store as any).recoverInterruptedSession(args);
const close = (store: LifecycleStore, args: RecoveryArgs & { ownerToken: string; reason: "closed" | "crashed" }) =>
  (store as any).recordSessionClosed(args);

test("verified crashed client pauses and resumes the exact dirty task with all evidence", async () => {
  const f = await fixture();
  const before = await f.store.status("interrupted-task");
  const handoff = await recover(f.store, await f.selectors());
  const paused = await f.store.status(before.intentId);
  assert.equal(paused.status, "paused");
  assert.equal(paused.phase, before.phase);
  assert.equal(paused.runId, before.runId);
  assert.equal(paused.worktreePath, before.worktreePath);
  assert.equal(paused.branch, before.branch);
  assert.equal(paused.taskId, before.taskId);
  assert.deepEqual(paused.policy, before.policy);
  for (const evidence of before.evidence) assert.ok(paused.evidence.some(item => JSON.stringify(item) === JSON.stringify(evidence)));
  assert.equal(handoff.resumeDirective, `[Captain resume: ${before.intentId}]`);
  assert.equal(handoff.worktreeState.status, "?? unfinished.txt\n");
  assert.equal(await readFile(path.join(f.worktree, "unfinished.txt"), "utf8"), "retained task work\n");
  assert.equal(await f.store.permitFor("client-before-close", "old-turn"), null);
  assert.ok(f.probes > 0);
  await f.store.markIntent({ intentId: "continuation", sessionId: "client-after-reopen", turnId: "new-turn", projectRoot: f.root, prompt: "continue this task", resumeOf: before.intentId });
  const resumed = await f.store.resume("continuation");
  assert.equal(resumed.runId, before.runId);
  assert.equal(resumed.worktreePath, before.worktreePath);
  assert.equal(resumed.branch, before.branch);
  assert.equal(resumed.status, "running");
  assert.ok(await f.store.permitFor("client-after-reopen", "new-turn"));
});

for (const state of ["live", "foreign_host", "unknown"] as const) {
  test(`interruption recovery refuses ${state} client without changing its task or lease`, async () => {
    const f = await fixture({ state });
    const before = await f.store.status("interrupted-task");
    const args = await f.selectors();
    await assert.rejects(async () => recover(f.store, args), expectedFailure(/live|foreign|unknown|stopped|owner/i));
    assert.deepEqual(await f.store.status(before.intentId), before);
    assert.equal((await readAuthorizedLeaseSnapshotReadOnly<any>(f.data, before.sessionLeaseId!))?.state, "held");
    assert.deepEqual(await f.store.handoffs(), []);
  });
}

test("legacy session without client owner identity remains owned until a real close can be verified", async () => {
  const f = await fixture({ owner: false });
  const before = await f.store.status("interrupted-task");
  await assert.rejects(async () => recover(f.store, await f.selectors()), expectedFailure(/legacy|identity|owner|metadata/i));
  assert.equal(f.probes, 0);
  assert.deepEqual(await f.store.status(before.intentId), before);
});

test("stale run, session and lease generation selectors cannot pause a newer owner", async () => {
  const f = await fixture();
  const args = await f.selectors();
  for (const patch of [
    { expectedRunRevision: args.expectedRunRevision - 1 },
    { sessionId: "unrelated-client" },
    { expectedSessionLeaseRevision: args.expectedSessionLeaseRevision + 1 },
    { resourceGeneration: "f".repeat(64) },
  ]) {
    const before = await f.store.status(args.intentId);
    await assert.rejects(async () => recover(f.store, { ...args, ...patch }), expectedFailure(/revision|generation|session|binding|selector/i));
    assert.deepEqual(await f.store.status(args.intentId), before);
  }
});

test("authenticated logical close pauses the session even when its client host process remains live", async () => {
  const f = await fixture({ state: "live" });
  const before = await f.store.status("interrupted-task");
  const handoff = await close(f.store, { ...await f.selectors(), ownerToken: f.closeToken, reason: "closed" });
  assert.equal(handoff.runId, before.runId);
  assert.equal((await f.store.status(before.intentId)).status, "paused");
  assert.equal(await readFile(path.join(f.worktree, "unfinished.txt"), "utf8"), "retained task work\n");
});

test("forged close token and unregistered owner cannot convert a live session into a pause", async () => {
  for (const owner of [true, false]) {
    const f = await fixture({ state: "live", owner });
    const before = await f.store.status("interrupted-task");
    await assert.rejects(async () => close(f.store, { ...await f.selectors(), ownerToken: "forged-token", reason: "closed" }), expectedFailure(/token|capability|identity|owner|metadata|legacy/i));
    assert.deepEqual(await f.store.status(before.intentId), before);
    assert.deepEqual(await f.store.handoffs(), []);
  }
});

test("explicit resume discovers a stopped owner and transfers the retained run without allocating another worktree", async () => {
  const f = await fixture();
  const before = await f.store.status("interrupted-task");
  await f.store.markIntent({ intentId: "reopened-client", sessionId: "new-client", turnId: "fresh-turn", projectRoot: f.root, prompt: "resume the existing task", resumeOf: before.intentId });
  const resumed = await f.store.resume("reopened-client");
  assert.equal(resumed.runId, before.runId);
  assert.equal(resumed.worktreePath, before.worktreePath);
  assert.equal(resumed.branch, before.branch);
  assert.equal(resumed.taskId, before.taskId);
  assert.equal(resumed.phase, before.phase);
  assert.ok(f.probes > 0);
  assert.ok((await f.store.handoffs()).some(item => item.intentId === before.intentId && item.worktreeState?.status === "?? unfinished.txt\n"));
});
test("real OS client identity distinguishes a live process from that exact process after exit", async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });
  await once(child, "spawn");
  const exited = once(child, "exit");
  try {
    const expectedHash = hash("private client capability");
    const owner = await captureClientSessionOwner(child.pid!, expectedHash.toUpperCase());
    assert.equal(owner.closeTokenHash, expectedHash);
    assert.equal((await probeSessionOwner(owner)).state, "live");
    assert.equal((await probeSessionOwner({ ...owner, host: "unrelated-host" })).state, "foreign_host");
    assert.equal((await probeSessionOwner({ ...owner, startedAt: owner.startedAt + "-other-start" })).state, "stopped");
    child.kill();
    await exited;
    assert.equal((await probeSessionOwner(owner)).state, "stopped");
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill(); await exited; }
  }
});

test("OS capture rejects MCP host identity and malformed client ownership", async () => {
  await assert.rejects(() => captureClientSessionOwner(process.pid), /MCP host/);
  await assert.rejects(() => captureClientSessionOwner(-1), /owner PID/);
  assert.equal((await probeSessionOwner({ pid: -1, host: "x", startedAt: "x" })).state, "unknown");
});
async function treeBytes(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  async function walk(directory: string) {
    for (const item of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, item.name);
      if (item.isDirectory()) await walk(file);
      else result[path.relative(root, file)] = `${hash((await readFile(file)).toString("base64"))}:${(await stat(file)).mtimeMs}`;
    }
  }
  await walk(root);
  return result;
}

test("interruption status is genuinely read only and exposes no close capability", async () => {
  const f = await fixture();
  const expectedSelectors = (({ summary, nextSteps, ...selectors }) => selectors)(await f.selectors());
  const before = await treeBytes(f.data);
  const status = await (f.store as any).sessionInterruptionStatus("interrupted-task", "client-before-close");
  assert.equal(status.owner.state, "stopped");
  assert.equal(status.canRecover, true);
  assert.deepEqual(status.selectors, expectedSelectors);
  assert.ok(!JSON.stringify(status).includes(f.closeToken));
  assert.ok(!JSON.stringify(status).includes(f.owner.closeTokenHash));
  assert.deepEqual(await treeBytes(f.data), before);
});

test("exact recovery replay returns its existing signed handoff without another pause revision", async () => {
  const f = await fixture();
  const args = await f.selectors();
  const handoff = await recover(f.store, args);
  const before = await treeBytes(f.data);
  assert.deepEqual(await recover(f.store, args), handoff);
  assert.deepEqual(await treeBytes(f.data), before);
});

test("recovery interrupted after its signed paused revision resumes the same handoff and exact lease release", async () => {
  const f = await fixture({ failAfterPause: true });
  const args = await f.selectors();
  const original = await f.store.status(args.intentId);
  await assert.rejects(async () => recover(f.store, args), /simulated client recovery crash/);
  const handoff = await recover(f.store, args);
  assert.equal(handoff.runId, original.runId);
  assert.equal(handoff.revision, args.expectedRunRevision + 1);
  assert.equal(handoff.worktreeState.status, "?? unfinished.txt\n");
  const paused = await f.store.status(args.intentId);
  assert.equal(paused.status, "paused");
  assert.equal(paused.revision, handoff.revision);
  assert.equal((await readAuthorizedLeaseSnapshotReadOnly<any>(f.data, paused.sessionLeaseId!))?.state, "released");
});
test("reopened client with the same logical session ID rotates owner activation and retains its original task", async () => {
  const f = await fixture();
  const before = await f.store.status("interrupted-task");
  const reopenedOwner = { ...f.owner, pid: f.owner.pid + 1, startedAt: "reopened-client-start" };
  f.setClientOwner(reopenedOwner);
  await f.store.markIntent({ intentId: "same-session-reopen", sessionId: before.sessionId, turnId: "reopened-turn", projectRoot: f.root, prompt: "continue the existing task", resumeOf: before.intentId });
  const resumed = await f.store.resume("same-session-reopen");
  assert.notEqual(resumed.activationToken, before.activationToken);
  assert.equal(resumed.runId, before.runId);
  assert.equal(resumed.worktreePath, before.worktreePath);
  assert.equal(resumed.branch, before.branch);
  assert.equal(resumed.taskId, before.taskId);
  assert.equal(resumed.sessionId, before.sessionId);
  assert.equal(resumed.turnId, "reopened-turn");
  const ownerStatus = await (f.store as any).sessionInterruptionStatus(before.intentId, before.sessionId);
  assert.equal(ownerStatus.owner.pid, reopenedOwner.pid);
  assert.equal(ownerStatus.owner.startedAt, reopenedOwner.startedAt);
  assert.equal(ownerStatus.owner.state, "live");
  await (f.store as any).bindSessionOwner(before.intentId, before.sessionId, reopenedOwner);
});

test("ordinary same-session live continuation retains its lease without an interruption pause", async () => {
  const f = await fixture({ state: "live" });
  const before = await f.store.status("interrupted-task");
  await f.store.markIntent({ intentId: "ordinary-continuation", sessionId: before.sessionId, turnId: "next-turn", projectRoot: f.root, prompt: "continue", resumeOf: before.intentId });
  const resumed = await f.store.resume("ordinary-continuation");
  assert.equal(resumed.activationToken, before.activationToken);
  assert.deepEqual(await f.store.handoffs(), []);
});

test("ordinary resume automatically finishes a signed interruption checkpoint after its client crashed during pause", async () => {
  const f = await fixture({ failAfterPause: true });
  const before = await f.store.status("interrupted-task");
  const args = await f.selectors();
  await assert.rejects(async () => recover(f.store, args), /simulated client recovery crash/);
  await f.store.markIntent({ intentId: "ordinary-reopen-after-pause-crash", sessionId: "new-client", turnId: "new-turn", projectRoot: f.root, prompt: "continue the retained task", resumeOf: before.intentId });
  const resumed = await f.store.resume("ordinary-reopen-after-pause-crash");
  assert.equal(resumed.runId, before.runId);
  assert.equal(resumed.worktreePath, before.worktreePath);
  assert.equal(resumed.branch, before.branch);
  assert.equal(resumed.taskId, before.taskId);
  const handoffs = await f.store.handoffs();
  assert.equal(handoffs.length, 1);
  assert.equal(handoffs[0].resumeDirective, `[Captain resume: ${before.intentId}]`);
  assert.equal(handoffs[0].worktreeState?.status, "?? unfinished.txt\n");
  assert.equal((await readAuthorizedLeaseSnapshotReadOnly<any>(f.data, before.sessionLeaseId!))?.state, "released");
  assert.ok(await f.store.permitFor("new-client", "new-turn"));
});
test("paused task stays discoverable and resumes in another session while a support task retains the reused original session", async () => {
  const f = await fixture();
  const original = await f.store.status("interrupted-task");
  await f.store.pause(original.intentId, { summary: "Authorized support task must run before continuation", nextSteps: ["Resume the same original task after support"] });
  const supportWorktree = path.join(f.root, ".captain-sdlc", "worktrees", "support-task");
  await mkdir(supportWorktree, { recursive: true });
  const supportState = { ...f.state, topLevel: supportWorktree, branch: "captain/support-task", status: "", gitDir: path.join(f.root, ".git", "worktrees", "support-task") };
  const support = new LifecycleStore(f.data, async () => ({ exitCode: 0, stdout: "", stderr: "" }), async () => supportState);
  await support.markIntent({ intentId: "support-task", sessionId: original.sessionId, turnId: "support-turn", projectRoot: f.root, prompt: "implement authorized support" });
  const supportRun = await support.begin({ intentId: "support-task", taskId: "captain-support", objective: "retain live support ownership",
    projectRoot: f.root, worktreePath: supportWorktree, baseHead: supportState.head,
    branch: supportState.branch, commonGitDir: supportState.commonGitDir!, gitDir: supportState.gitDir!, policy: original.policy });
  const supportLease = await readAuthorizedLeaseSnapshotReadOnly<any>(f.data, supportRun.sessionLeaseId!);
  assert.equal(supportLease?.state, "held");
  const pausedStatus = await f.store.status(original.intentId);
  assert.equal(pausedStatus.status, "paused");
  assert.equal(pausedStatus.runId, original.runId);
  assert.equal(await f.store.permitFor(original.sessionId, original.turnId), null);
  const issued = await captainIssueIntent(f.store, { session_id: "new-original-task-session", turn_id: "resumed-turn", project_root: f.root,
    prompt: "continue the original task", task_id: original.taskId, resume_of: original.intentId, action: "resume" });
  const resumed = await f.store.resume(issued.intent_id);
  assert.equal(resumed.runId, original.runId);
  assert.equal(resumed.worktreePath, original.worktreePath);
  assert.equal(resumed.branch, original.branch);
  assert.equal(resumed.status, "running");
  assert.deepEqual(await support.status(supportRun.intentId), supportRun);
  assert.deepEqual(await readAuthorizedLeaseSnapshotReadOnly<any>(f.data, supportRun.sessionLeaseId!), supportLease);
  assert.ok(await support.permitFor(original.sessionId, "support-turn"));
  assert.ok(await f.store.permitFor("new-original-task-session", "resumed-turn"));
  assert.equal(await readFile(path.join(f.worktree, "unfinished.txt"), "utf8"), "retained task work\n");
});