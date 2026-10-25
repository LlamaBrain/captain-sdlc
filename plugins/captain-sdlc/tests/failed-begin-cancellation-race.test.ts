import assert from "node:assert/strict";
import test from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { execFile, fork } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const pluginRoot = path.resolve(process.env.CAPTAIN_TEST_PLUGIN_ROOT ?? path.resolve(import.meta.dirname, ".."));
const importPlugin = relative => import(pathToFileURL(path.join(pluginRoot, relative)).href);
const [{ LifecycleStore }, serverApi, authority, workspace, adapter] = await Promise.all([
  importPlugin("src/lifecycle.ts"), importPlugin("src/server.ts"),
  importPlugin("src/authority.ts"), importPlugin("src/workspace.ts"),
  importPlugin("src/begin-diagnostic-adapter.ts"),
]);
const exec = promisify(execFile);
const git = async (cwd, ...args) => (await exec("git", ["--no-optional-locks", "-C", cwd, ...args], { windowsHide: true })).stdout.trim();
const policy = { profile: "low", visualRequired: false, commands: { build: "build", ticket: "ticket" }, artifactPaths: { build: "build.zip" }, redGate: { expectedExitCodes: [1], outputPattern: "ticket" } };
const ok = async () => ({ exitCode: 0, stdout: "", stderr: "" });
const beginDependencies = { repositoryIdentity: workspace.repositoryIdentity, loadPolicy: async () => policy, ensureWorktree: workspace.ensureWorktree };
const canonicalFailure = /target branch is checked out outside the canonical worktree container/i;

function cancellation() {
  assert.equal(typeof serverApi.captainCancelFailedBegin, "function", "the public handler and race proof must use the same exported cancellation function");
  return serverApi.captainCancelFailedBegin;
}

async function bounded(promise, milliseconds, message) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error(message), { code: "ETESTTIMEOUT" })), milliseconds); })]); }
  finally { clearTimeout(timer); }
}

const isContention = error => error.code !== "ETESTTIMEOUT" && /active|in.flight|already.*(?:leased|begin)|begin.*(?:gate|progress)/i.test(String(error.message));

async function snapshotTree(root, exclude = () => false) {
  const rows = [];
  async function visit(current, relative = "") {
    let entries;
    try { entries = await readdir(current, { withFileTypes: true }); }
    catch (error) { if (error.code === "ENOENT") return; throw error; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (exclude(name)) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(full, name);
      else if (entry.isFile()) {
        const bytes = await readFile(full);
        rows.push([name, bytes.length, createHash("sha256").update(bytes).digest("hex")]);
      } else throw new Error(`unexpected fixture entry: ${name}`);
    }
  }
  await visit(root);
  return rows;
}

// Successful gate acquisition/release may append its own ephemeral lease history.
// Every other authority byte, including all target-lease revisions, remains compared.
const gateFiles = name => /^(lease-revisions|lease-watermarks)\/begin-attempt-[0-9a-f]{64}-\d+\.json$/.test(name);

async function fixture(targetCheckedOut = true) {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "captain-cancel-race-"));
  const projectRoot = path.join(fixtureRoot, "project"), dataRoot = path.join(fixtureRoot, "authority");
  const targetBranch = "feature/cancel-race";
  await mkdir(projectRoot, { recursive: true });
  await git(projectRoot, "init", "--initial-branch=main");
  await git(projectRoot, "config", "core.autocrlf", "false");
  await git(projectRoot, "config", "user.name", "Captain race fixture");
  await git(projectRoot, "config", "user.email", "captain-race@example.invalid");
  await writeFile(path.join(projectRoot, "README.md"), "isolated signed Begin cancellation fixture\n");
  await writeFile(path.join(projectRoot, ".gitignore"), ".captain-sdlc/\n.captain-proof/\nbuild.zip\n");
  await git(projectRoot, "add", ".");
  await git(projectRoot, "commit", "-m", "fixture baseline");
  if (targetCheckedOut) await git(projectRoot, "checkout", "-b", targetBranch);
  else await git(projectRoot, "branch", targetBranch);
  const store = new LifecycleStore(dataRoot, ok);
  const f = { fixtureRoot, projectRoot, dataRoot, targetBranch, store, sessionId: `session-${randomUUID()}`, taskId: `task-${randomUUID()}` };
  return f;
}

async function dispose(f) {
  assert.equal(path.dirname(f.fixtureRoot), path.resolve(os.tmpdir()));
  assert.ok(path.basename(f.fixtureRoot).startsWith("captain-cancel-race-"));
  await rm(f.fixtureRoot, { recursive: true, force: true });
}

async function issue(f, options = {}) {
  const result = await serverApi.captainIssueIntent(f.store, {
    session_id: f.sessionId, turn_id: `turn-${randomUUID()}`, project_root: f.projectRoot,
    prompt: "Exercise authenticated failed Begin cancellation in an isolated fixture.",
    task_id: f.taskId, action: "start", target_branch: f.targetBranch, ...options,
  });
  return result.intent_id;
}

const beginArgs = (f, intentId) => ({ intent_id: intentId, objective: "race fixture", project_root: f.projectRoot, task_id: f.taskId });
async function failedBegin(f, intentId) {
  await assert.rejects(serverApi.captainBegin(f.store, beginArgs(f, intentId), beginDependencies), canonicalFailure);
}

async function inspect(f, intentId, targetWorktree = f.projectRoot) {
  const args = { intent_id: intentId, session_id: f.sessionId, project_root: f.projectRoot, target_worktree: targetWorktree, target_branch: f.targetBranch };
  const diagnosis = await adapter.createBeginDiagnosticAdapter(f.dataRoot)(args);
  assert.equal(diagnosis.diagnosis, "inspected", JSON.stringify(diagnosis));
  assert.equal(diagnosis.session_match, "same");
  assert.equal(diagnosis.target_lease.state, "held");
  assert.ok(Number.isSafeInteger(diagnosis.target_lease.revision));
  assert.match(diagnosis.target_lease.resource_generation, /^[0-9a-f]{64}$/i);
  return { diagnosis, args: { ...args, expected_lease_revision: diagnosis.target_lease.revision, resource_generation: diagnosis.target_lease.resource_generation, confirm_owner_stopped: true } };
}

async function checkpointState(f, intentId) {
  const operation = await f.store.beginOperationFor(intentId);
  const repository = await authority.readAuthorizedReadOnly(f.dataRoot, "begin-repositories", operation.operationToken);
  const checkpoint = await authority.readAuthorizedReadOnly(f.dataRoot, "begin-leases", operation.operationToken);
  const lease = await authority.readAuthorizedLeaseSnapshotReadOnly(f.dataRoot, checkpoint.leaseId);
  assert.equal(lease.state, "held");
  return { operation, repository, checkpoint, lease };
}

function directBeginInput(f, state) {
  const { operation, repository, checkpoint } = state;
  return { intentId: operation.intentId, objective: operation.objective, taskId: f.taskId,
    projectRoot: f.projectRoot, worktreePath: path.join(f.projectRoot, ".captain-sdlc", "worktrees", operation.intentId),
    baseHead: repository.baseHead, branch: f.targetBranch, targetBranch: f.targetBranch,
    commonGitDir: repository.commonGitDir, gitDir: path.join(repository.commonGitDir, "worktrees", operation.intentId),
    leaseId: checkpoint.leaseId, leaseToken: checkpoint.leaseToken, policy };
}

async function assertNoRun(f, intentId) {
  const names = (await snapshotTree(f.dataRoot)).map(row => row[0]);
  assert.equal(names.some(name => name.startsWith(`run-revisions/${intentId}-`) || name === `runs/${intentId}.json`), false, "refusal must not publish an immutable run or projection");
}

const pausedWorker = String.raw`
import { pathToFileURL } from "node:url";
import path from "node:path";
const input = JSON.parse(process.argv[2]);
const load = relative => import(pathToFileURL(path.join(input.pluginRoot, relative)).href);
const [{ LifecycleStore }, api, workspace] = await Promise.all([load("src/lifecycle.ts"), load("src/server.ts"), load("src/workspace.ts")]);
const store = new LifecycleStore(input.dataRoot, async () => ({ exitCode: 0, stdout: "", stderr: "" }));
try {
  await api.captainBegin(store, input.args, {
    repositoryIdentity: workspace.repositoryIdentity,
    loadPolicy: async () => input.policy,
    ensureWorktree: async (...args) => {
      // The real BeginLease checkpoint is already signed before this seam runs.
      const resume = new Promise(resolve => process.once("message", message => { if (message?.type === "resume") resolve(); }));
      process.send({ type: "paused" });
      await resume;
      return workspace.ensureWorktree(...args);
    },
  });
  process.send({ type: "terminal", resolved: true });
} catch (error) { process.send({ type: "terminal", resolved: false, message: String(error.message) }); }
finally { process.disconnect(); }
`;

async function pauseBeginChild(f, intentId) {
  const worker = path.join(f.fixtureRoot, "paused-begin.mjs");
  await writeFile(worker, pausedWorker);
  const requireFromPlugin = createRequire(path.join(pluginRoot, "package.json"));
  const child = fork(worker, [JSON.stringify({ pluginRoot, dataRoot: f.dataRoot, args: beginArgs(f, intentId), policy })], {
    cwd: pluginRoot, execArgv: ["--import", pathToFileURL(requireFromPlugin.resolve("tsx")).href], windowsHide: true,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let stderr = "", resolvePaused, rejectPaused, resolveTerminal, rejectTerminal;
  child.stderr.on("data", bytes => { stderr += bytes; });
  const paused = new Promise((resolve, reject) => { resolvePaused = resolve; rejectPaused = reject; });
  const terminal = new Promise((resolve, reject) => { resolveTerminal = resolve; rejectTerminal = reject; });
  // A pre-pause worker failure must reject both waiters without an unhandled rejection.
  void terminal.catch(() => {});
  child.on("message", message => { if (message.type === "paused") resolvePaused(); if (message.type === "terminal") resolveTerminal(message); });
  const exited = new Promise(resolve => child.once("exit", (code, signal) => {
    const failure = new Error(`paused Begin worker exited: ${code}/${signal}; ${stderr}`);
    rejectPaused(failure); rejectTerminal(failure); resolve({ code, signal });
  }));
  child.once("error", error => { rejectPaused(error); rejectTerminal(error); });
  return { child, paused, terminal, exited };
}

test("cross-process active Begin denies cancellation and direct-store retry, then permits terminal retirement", { timeout: 30000 }, async () => {
  const cancel = cancellation(), f = await fixture();
  let worker;
  try {
    const intentId = await issue(f);
    worker = await pauseBeginChild(f, intentId);
    await bounded(worker.paused, 15000, "Begin worker did not reach the signed lease checkpoint");
    const { diagnosis, args } = await inspect(f, intentId);
    assert.equal(diagnosis.stage, "lease_checkpointed");
    assert.equal(Object.values(diagnosis.later_state).some(Boolean), false, "refusal must test the shared gate, not an ineligible later stage");
    const before = await snapshotTree(f.dataRoot), gitBefore = await snapshotTree(path.join(f.projectRoot, ".git"));
    const otherStore = new LifecycleStore(f.dataRoot, ok);
    await assert.rejects(bounded(cancel(otherStore, args), 2000, "cancellation queued behind active Begin instead of refusing"), isContention);
    const state = await checkpointState(f, intentId);
    await assert.rejects(bounded(otherStore.begin(directBeginInput(f, state)), 2000, "direct Begin queued behind active Begin instead of refusing"), isContention);
    assert.deepEqual(await snapshotTree(f.dataRoot), before);
    assert.deepEqual(await snapshotTree(path.join(f.projectRoot, ".git")), gitBefore);
    worker.child.send({ type: "resume" });
    const terminal = await bounded(worker.terminal, 15000, "Begin worker did not unwind");
    assert.equal(terminal.resolved, false);
    assert.match(terminal.message, canonicalFailure);
    assert.deepEqual(await bounded(worker.exited, 5000, "Begin child did not terminate"), { code: 0, signal: null });
    const retired = await cancel(otherStore, args);
    assert.equal(retired.cancelled, true);
    assert.equal(retired.state, "cancelled");
    assert.equal((await authority.readAuthorizedLeaseSnapshotReadOnly(f.dataRoot, state.checkpoint.leaseId)).state, "released");
    await assertNoRun(f, intentId);
  } finally {
    if (worker && worker.child.exitCode === null && worker.child.signalCode === null) { worker.child.kill(); await bounded(worker.exited, 5000, "fixture child cleanup failed"); }
    await dispose(f);
  }
});

test("terminal cancellation fences both Begin entrypoints and low-level progress before target reacquisition", { timeout: 30000 }, async () => {
  const cancel = cancellation(), f = await fixture();
  try {
    const intentId = await issue(f); await failedBegin(f, intentId);
    const state = await checkpointState(f, intentId), { args } = await inspect(f, intentId);
    await cancel(f.store, args);
    const released = await authority.readAuthorizedLeaseSnapshotReadOnly(f.dataRoot, state.checkpoint.leaseId);
    const before = await snapshotTree(f.dataRoot, gateFiles), gitBefore = await snapshotTree(path.join(f.projectRoot, ".git"));
    let worktreeCalls = 0;
    await assert.rejects(serverApi.captainBegin(new LifecycleStore(f.dataRoot, ok), beginArgs(f, intentId), {
      ...beginDependencies, ensureWorktree: async (...values) => { worktreeCalls++; return workspace.ensureWorktree(...values); },
    }), /cancel|retir|terminal/i);
    await assert.rejects(new LifecycleStore(f.dataRoot, ok).begin(directBeginInput(f, state)), /cancel|retir|terminal/i);
    await assert.rejects(f.store.ensureBeginTargetLease(state.operation, state.repository), /cancel|retir|terminal/i);
    await assert.rejects(f.store.checkpointBeginWorkspace(state.operation, directBeginInput(f, state)), /cancel|retir|terminal/i);
    assert.equal(worktreeCalls, 0);
    assert.deepEqual(await authority.readAuthorizedLeaseSnapshotReadOnly(f.dataRoot, state.checkpoint.leaseId), released);
    assert.deepEqual(await snapshotTree(f.dataRoot, gateFiles), before);
    assert.deepEqual(await snapshotTree(path.join(f.projectRoot, ".git")), gitBefore);
    await assertNoRun(f, intentId);
  } finally { await dispose(f); }
});

test("ABA retirement refuses a newer held generation even with identical operation and lease tokens", { timeout: 30000 }, async () => {
  const cancel = cancellation(), f = await fixture();
  try {
    const intentId = await issue(f); await failedBegin(f, intentId);
    const { args } = await inspect(f, intentId), state = await checkpointState(f, intentId);
    await authority.releaseAuthorizedLease(f.dataRoot, state.checkpoint.leaseId, intentId, state.lease.payload.leaseToken);
    await authority.acquireAuthorizedLease(f.dataRoot, state.checkpoint.leaseId, state.lease.payload);
    const replacement = await authority.readAuthorizedLeaseSnapshotReadOnly(f.dataRoot, state.checkpoint.leaseId);
    assert.deepEqual(replacement.payload, state.lease.payload, "payload-only ownership checks cannot distinguish this ABA");
    assert.equal(replacement.revision, state.lease.revision + 2);
    const before = await snapshotTree(f.dataRoot), gitBefore = await snapshotTree(path.join(f.projectRoot, ".git"));
    await assert.rejects(cancel(f.store, args));
    assert.deepEqual(await authority.readAuthorizedLeaseSnapshotReadOnly(f.dataRoot, state.checkpoint.leaseId), replacement);
    assert.deepEqual(await snapshotTree(f.dataRoot), before, "stale generation must refuse before terminal marker or gate publication");
    assert.deepEqual(await snapshotTree(path.join(f.projectRoot, ".git")), gitBefore);
  } finally { await dispose(f); }
});

test("run zero revalidates the checkpointed generation after same-token ABA", { timeout: 30000 }, async () => {
  const f = await fixture();
  try {
    const intentId = await issue(f); await failedBegin(f, intentId);
    const state = await checkpointState(f, intentId);
    const input = directBeginInput(f, state);
    await f.store.checkpointBeginWorkspace(state.operation, { projectRoot: input.projectRoot, worktreePath: input.worktreePath, baseHead: input.baseHead, branch: input.branch, targetBranch: input.targetBranch, commonGitDir: input.commonGitDir, gitDir: input.gitDir });
    await authority.releaseAuthorizedLease(f.dataRoot, state.checkpoint.leaseId, intentId, state.lease.payload.leaseToken);
    await authority.acquireAuthorizedLease(f.dataRoot, state.checkpoint.leaseId, state.lease.payload);
    const replacement = await authority.readAuthorizedLeaseSnapshotReadOnly(f.dataRoot, state.checkpoint.leaseId);
    assert.deepEqual(replacement.payload, state.lease.payload);
    assert.equal(replacement.revision, state.lease.revision + 2);
    const before = await snapshotTree(f.dataRoot);
    await assert.rejects(f.store.checkpointBeginRun(state.operation, policy), /lease|generation|revision/i);
    await assertNoRun(f, intentId);
    assert.deepEqual(await snapshotTree(f.dataRoot), before);
  } finally { await dispose(f); }
});

test("repeated cancellation is exact-idempotent and never releases a replacement target owner", { timeout: 30000 }, async () => {
  const cancel = cancellation(), f = await fixture();
  try {
    const intentId = await issue(f); await failedBegin(f, intentId);
    const { args } = await inspect(f, intentId), state = await checkpointState(f, intentId);
    const first = await cancel(f.store, args), beforeRepeat = await snapshotTree(f.dataRoot, gateFiles);
    const repeated = await cancel(new LifecycleStore(f.dataRoot, ok), args);
    assert.deepEqual(repeated, first);
    assert.deepEqual(await snapshotTree(f.dataRoot, gateFiles), beforeRepeat);
    const replacementIntent = await issue(f, { session_id: `replacement-${randomUUID()}`, task_id: `replacement-task-${randomUUID()}` });
    const replacementOperation = await f.store.reserveBegin({ intentId: replacementIntent, objective: "replacement owner", projectRoot: f.projectRoot });
    const identity = await workspace.repositoryIdentity(f.projectRoot, replacementOperation.targetBranch, replacementOperation.targetOid);
    const repository = await f.store.checkpointBeginRepository(replacementOperation, identity, policy);
    await f.store.ensureBeginTargetLease(replacementOperation, repository);
    const replacement = await authority.readAuthorizedLeaseSnapshotReadOnly(f.dataRoot, state.checkpoint.leaseId);
    assert.equal(replacement.state, "held"); assert.equal(replacement.payload.intentId, replacementIntent);
    assert.notEqual(replacement.payload.leaseToken, state.lease.payload.leaseToken);
    const before = await snapshotTree(f.dataRoot, gateFiles);
    for (let repeat = 0; repeat < 2; repeat++) await assert.rejects(cancel(new LifecycleStore(f.dataRoot, ok), args));
    assert.deepEqual(await authority.readAuthorizedLeaseSnapshotReadOnly(f.dataRoot, state.checkpoint.leaseId), replacement);
    assert.deepEqual(await snapshotTree(f.dataRoot, gateFiles), before);
  } finally { await dispose(f); }
});

test("marked cancellation authenticates a foreign selector before publishing any gate lease", { timeout: 30000 }, async () => {
  const cancel = cancellation(), f = await fixture();
  try {
    const intentId = await issue(f); await failedBegin(f, intentId);
    const { args } = await inspect(f, intentId);
    await cancel(f.store, args);
    const before = await snapshotTree(f.dataRoot), gitBefore = await snapshotTree(path.join(f.projectRoot, ".git"));
    await assert.rejects(cancel(new LifecycleStore(f.dataRoot, ok), { ...args, session_id: `foreign-${randomUUID()}` }));
    assert.deepEqual(await snapshotTree(f.dataRoot), before, "foreign selector refusal must precede even benign attempt-gate lease publication");
    assert.deepEqual(await snapshotTree(path.join(f.projectRoot, ".git")), gitBefore);
  } finally { await dispose(f); }
});

test("marked cancellation reauthenticates later signed workspace progress before retrying a failed release", { timeout: 30000 }, async () => {
  const cancel = cancellation(), f = await fixture();
  try {
    const intentId = await issue(f); await failedBegin(f, intentId);
    const { args } = await inspect(f, intentId), state = await checkpointState(f, intentId);
    const release = f.store.releaseBeginTargetLeaseAtGeneration;
    f.store.releaseBeginTargetLeaseAtGeneration = async () => { throw new Error("fixture interruption after terminal marker, before target release"); };
    try { await assert.rejects(cancel(f.store, args), /fixture interruption after terminal marker/); }
    finally { f.store.releaseBeginTargetLeaseAtGeneration = release; }
    const marker = await authority.readAuthorizedReadOnly(f.dataRoot, "begin-cancellations", intentId);
    assert.equal(marker.kind, "failed_begin_cancelled");
    assert.equal(marker.operationToken, state.operation.operationToken);
    assert.deepEqual(await authority.readAuthorizedLeaseSnapshotReadOnly(f.dataRoot, state.checkpoint.leaseId), state.lease, "the injected interruption must leave the original target generation held");
    const input = directBeginInput(f, state);
    // Explicit synthetic legacy-client race: the current checkpoint producer is
    // correctly fenced by the marker. This public fixture authority writer signs
    // the real workspace checkpoint schema an earlier client could have published.
    await authority.putAuthorizedOnceExact(f.dataRoot, "begin-workspaces", state.operation.operationToken, {
      schemaVersion: 1, operationToken: state.operation.operationToken,
      projectRoot: input.projectRoot, worktreePath: input.worktreePath, baseHead: input.baseHead,
      branch: input.branch, targetBranch: input.targetBranch, commonGitDir: input.commonGitDir, gitDir: input.gitDir,
    });
    const { diagnosis } = await inspect(f, intentId);
    assert.equal(diagnosis.stage, "workspace_checkpointed");
    assert.equal(diagnosis.later_state.workspace, true);
    const before = await snapshotTree(f.dataRoot, gateFiles), gitBefore = await snapshotTree(path.join(f.projectRoot, ".git"));
    await assert.rejects(cancel(new LifecycleStore(f.dataRoot, ok), args), /progress|later|ambiguous|workspace/i);
    assert.deepEqual(await authority.readAuthorizedLeaseSnapshotReadOnly(f.dataRoot, state.checkpoint.leaseId), state.lease);
    assert.deepEqual(await snapshotTree(f.dataRoot, gateFiles), before);
    assert.deepEqual(await snapshotTree(path.join(f.projectRoot, ".git")), gitBefore);
    await assertNoRun(f, intentId);
  } finally { await dispose(f); }
});

test("actual progressed Begin run and permit cannot be retired", { timeout: 30000 }, async () => {
  const cancel = cancellation(), f = await fixture(false);
  try {
    const intentId = await issue(f);
    const run = await serverApi.captainBegin(f.store, beginArgs(f, intentId), beginDependencies);
    assert.notEqual(run.worktreePath, f.projectRoot);
    const { diagnosis, args } = await inspect(f, intentId);
    assert.equal(diagnosis.stage, "permit_published");
    for (const key of ["workspace", "run", "active", "activated", "permit"]) assert.equal(diagnosis.later_state[key], true, key);
    const before = await snapshotTree(f.dataRoot), gitBefore = await snapshotTree(path.join(f.projectRoot, ".git"));
    await assert.rejects(cancel(new LifecycleStore(f.dataRoot, ok), args));
    assert.deepEqual(await snapshotTree(f.dataRoot), before);
    assert.deepEqual(await snapshotTree(path.join(f.projectRoot, ".git")), gitBefore);
  } finally { await dispose(f); }
});

test("actual completion's unrelated session tombstone does not block retirement or a fresh Begin", { timeout: 45000 }, async () => {
  const cancel = cancellation(), f = await fixture();
  try {
    const completedIntent = await issue(f, { target_branch: undefined });
    const completionPolicy = { ...policy, artifactPaths: { build: ".captain-proof/build.zip" } };
    const completionStore = new LifecycleStore(f.dataRoot, async (command, cwd) => {
      if (command === "build") {
        // Use the existing generated-proof root; ignored source inputs stay hashed.
        await mkdir(path.join(cwd, ".captain-proof"), { recursive: true });
        await writeFile(path.join(cwd, ".captain-proof", "build.zip"), "fixture build\n");
      }
      return { exitCode: command === "ticket" ? 1 : 0, stdout: command, stderr: "" };
    }, workspace.sourceState);
    const started = await serverApi.captainBegin(completionStore, beginArgs(f, completedIntent), { ...beginDependencies, loadPolicy: async () => completionPolicy });
    await completionStore.recordRed(completedIntent);
    await writeFile(path.join(started.worktreePath, "VERSION"), "1.0.1\n");
    await writeFile(path.join(started.worktreePath, "CHANGELOG.md"), "# 1.0.1\nFixture completion.\n");
    await git(started.worktreePath, "add", "VERSION", "CHANGELOG.md");
    await git(started.worktreePath, "commit", "-m", "test(fixture): complete prior task (v1.0.1)");
    const committed = await workspace.sourceState(started.worktreePath);
    await completionStore.recordCommit(completedIntent, { head: committed.head, tree: committed.tree, commitCount: 1, clean: true, subject: "test(fixture): complete prior task (v1.0.1)", versionChanged: true, changelogChanged: true, preparedMergesValid: true, phaseCommitsValid: true });
    const completed = await completionStore.prove(completedIntent);
    assert.equal(completed.phase, "complete"); assert.equal(completed.status, "green");
    const tombstone = await authority.readAuthorizedReadOnly(f.dataRoot, "active", f.sessionId);
    assert.deepEqual(tombstone, { intentId: "none", complete: true, operationToken: started.operationToken });
    const intentId = await issue(f); await failedBegin(f, intentId);
    const { args } = await inspect(f, intentId);
    const retired = await cancel(f.store, args);
    assert.equal(retired.cancelled, true);
    assert.deepEqual(await authority.readAuthorizedReadOnly(f.dataRoot, "active", f.sessionId), tombstone, "unrelated completed session projection must remain intact");
    const freshBranch = "feature/fresh-after-retirement";
    await git(f.projectRoot, "branch", freshBranch);
    const freshIntent = await issue(f, { target_branch: freshBranch });
    const fresh = await serverApi.captainBegin(f.store, beginArgs(f, freshIntent), beginDependencies);
    assert.equal(fresh.intentId, freshIntent); assert.equal(fresh.sessionId, f.sessionId); assert.equal(fresh.phase, "tdd_red");
    assert.equal((await authority.readAuthorizedReadOnly(f.dataRoot, "active", f.sessionId)).intentId, freshIntent);
    assert.notEqual(fresh.operationToken, started.operationToken);
  } finally { await dispose(f); }
});

test("ordinary Begin calls queue and revalidate changed reservation arguments", { timeout: 30000 }, async () => {
  const f = await fixture();
  let enteredResolve!: () => void, releaseResolve!: () => void;
  const entered = new Promise<void>(resolve => { enteredResolve = resolve; });
  const hold = new Promise<void>(resolve => { releaseResolve = resolve; });
  let firstOutcome: Promise<{ value?: unknown; error?: unknown }> | undefined;
  let secondOutcome: Promise<{ value?: unknown; error?: unknown }> | undefined;
  try {
    const intentId = await issue(f), args = beginArgs(f, intentId);
    const pausedDependencies = {
      ...beginDependencies,
      ensureWorktree: async (...worktreeArgs: any[]) => {
        enteredResolve();
        await hold;
        return workspace.ensureWorktree(...worktreeArgs);
      },
    };
    firstOutcome = serverApi.captainBegin(f.store, args, pausedDependencies).then(
      value => ({ value }), error => ({ error }),
    );
    await bounded(entered, 10000, "first Begin did not reach the signed lease/workspace boundary");

    let secondSettled = false;
    secondOutcome = serverApi.captainBegin(
      new LifecycleStore(f.dataRoot, ok),
      { ...args, objective: "changed objective must be checked after queuing" },
      beginDependencies,
    ).then(value => ({ value }), error => ({ error })).then(result => {
      secondSettled = true;
      return result;
    });
    await new Promise(resolve => setTimeout(resolve, 25));
    const settledBeforeRelease = secondSettled;
    releaseResolve();

    const [first, second] = await Promise.all([firstOutcome, secondOutcome]);
    assert.equal(settledBeforeRelease, false, "the second exact-intent Begin waits for the current local attempt");
    assert.ok(first.error, "the real pre-workspace checkout conflict remains a refusal");
    assert.match(String((first.error as Error).message), canonicalFailure);
    assert.ok(second.error, "changed arguments are not accepted as a second Begin");
    assert.match(String((second.error as Error).message), /signed begin reservation/i,
      "the queued call re-runs reservation validation after the first attempt releases the gate");
  } finally {
    releaseResolve();
    if (firstOutcome) await firstOutcome;
    if (secondOutcome) await secondOutcome;
    await dispose(f);
  }
});

test("queued retries after cancellation re-read the terminal marker", { timeout: 30000 }, async () => {
  const f = await fixture();
  let enteredResolve!: () => void, releaseResolve!: () => void;
  const entered = new Promise<void>(resolve => { enteredResolve = resolve; });
  const hold = new Promise<void>(resolve => { releaseResolve = resolve; });
  let firstOutcome: Promise<{ value?: unknown; error?: unknown }> | undefined;
  let secondOutcome: Promise<{ value?: unknown; error?: unknown }> | undefined;
  try {
    const intentId = await issue(f);
    await failedBegin(f, intentId);
    const state = await checkpointState(f, intentId);
    const { args } = await inspect(f, intentId);
    const retired = await cancellation()(f.store, args);
    assert.equal(retired.cancelled, true);

    const marker = await authority.readAuthorizedReadOnly(f.dataRoot, "begin-cancellations", intentId);
    const releasedLease = await authority.readAuthorizedLeaseSnapshotReadOnly(f.dataRoot, state.checkpoint.leaseId);
    const beforeGit = await snapshotTree(path.join(f.projectRoot, ".git"));
    const firstStore = new LifecycleStore(f.dataRoot, ok);
    const originalBeginCancellationFor = firstStore.beginCancellationFor.bind(firstStore);
    let pausedFirstMarkerRead = false;
    firstStore.beginCancellationFor = async requestedIntentId => {
      if (requestedIntentId === intentId && !pausedFirstMarkerRead) {
        pausedFirstMarkerRead = true;
        enteredResolve();
        await hold;
      }
      return originalBeginCancellationFor(requestedIntentId);
    };

    const beginArgsForIntent = beginArgs(f, intentId);
    firstOutcome = serverApi.captainBegin(firstStore, beginArgsForIntent, beginDependencies).then(
      value => ({ value }), error => ({ error }),
    );
    await bounded(entered, 10000, "first retry did not reach the signed cancellation marker");
    let secondSettled = false;
    secondOutcome = serverApi.captainBegin(
      new LifecycleStore(f.dataRoot, ok),
      beginArgsForIntent,
      beginDependencies,
    ).then(value => ({ value }), error => ({ error })).then(result => {
      secondSettled = true;
      return result;
    });
    await new Promise(resolve => setTimeout(resolve, 25));
    const settledBeforeRelease = secondSettled;
    releaseResolve();

    const [first, second] = await Promise.all([firstOutcome, secondOutcome]);
    assert.equal(settledBeforeRelease, false, "the second retry waits for the first marker check");
    for (const outcome of [first, second]) {
      assert.ok(outcome.error, "a retired Begin cannot be restarted");
      assert.match(String((outcome.error as Error).message), /implementation Begin was cancelled/i);
    }
    assert.deepEqual(await authority.readAuthorizedReadOnly(f.dataRoot, "begin-cancellations", intentId), marker);
    assert.deepEqual(await authority.readAuthorizedLeaseSnapshotReadOnly(f.dataRoot, state.checkpoint.leaseId), releasedLease);
    assert.equal((await f.store.beginOperationFor(intentId)).operationToken, state.operation.operationToken);
    await assertNoRun(f, intentId);
    assert.deepEqual(await snapshotTree(path.join(f.projectRoot, ".git")), beforeGit);
  } finally {
    releaseResolve();
    if (firstOutcome) await firstOutcome;
    if (secondOutcome) await secondOutcome;
    await dispose(f);
  }
});

// Pausing retains the authenticated task-owner projection but releases its session lease.
// It must not turn an unrelated terminal pre-workspace Begin into a progressed task.
test("an unrelated authenticated paused task permits exact failed Begin cancellation and retry", { timeout: 45000 }, async () => {
  const f = await fixture();
  try {
    const priorIntent = await issue(f, { target_branch: undefined });
    const started = await serverApi.captainBegin(f.store, beginArgs(f, priorIntent), beginDependencies);
    await writeFile(path.join(started.worktreePath, "README.md"), "unrelated staged source\n");
    await git(started.worktreePath, "add", "README.md");
    await writeFile(path.join(started.worktreePath, "README.md"), "unrelated loose source\n");
    await writeFile(path.join(started.worktreePath, "paused-note.md"), "keep paused task and evidence\n");
    await f.store.pause(priorIntent, { summary: "Retain unrelated work", nextSteps: ["Resume only this prior task when requested"] });
    const projection = await authority.readAuthorizedReadOnly(f.dataRoot, "active", f.sessionId);
    assert.equal(projection.intentId, priorIntent);
    const intentId = await issue(f); await failedBegin(f, intentId);
    const { args, diagnosis } = await inspect(f, intentId);
    assert.equal(diagnosis.stage, "lease_checkpointed");
    assert.equal(diagnosis.later_state.active, true, "legacy projection presence is not original Begin progress");
    const beforeSource = await snapshotTree(started.worktreePath);
    const beforeGit = await snapshotTree(path.join(f.projectRoot, ".git"));
    const beforeAuthority = await snapshotTree(f.dataRoot);
    const checkpoint = await checkpointState(f, intentId);
    assert.equal((await cancellation()(f.store, args)).cancelled, true);
    assert.equal((await cancellation()(f.store, args)).cancelled, true, "exact same-generation retry remains idempotent");
    assert.equal((await authority.readAuthorizedLeaseSnapshotReadOnly(f.dataRoot, checkpoint.checkpoint.leaseId)).state, "released");
    assert.deepEqual(await authority.readAuthorizedReadOnly(f.dataRoot, "active", f.sessionId), projection);
    assert.equal((await f.store.run(priorIntent)).status, "paused");
    assert.deepEqual(await snapshotTree(started.worktreePath), beforeSource);
    assert.deepEqual(await snapshotTree(path.join(f.projectRoot, ".git")), beforeGit);
    const afterAuthority = new Map((await snapshotTree(f.dataRoot)).map(row => [row[0], row]));
    for (const row of beforeAuthority) {
      if (!row[0].includes(checkpoint.checkpoint.leaseId) && !gateFiles(row[0])) {
        assert.deepEqual(afterAuthority.get(row[0]), row, `preserve original and paused authority ${row[0]}`);
      }
    }
    await assertNoRun(f, intentId);
    await assert.rejects(serverApi.captainBegin(f.store, beginArgs(f, intentId), beginDependencies), /cancelled|retired/i);
  } finally { await dispose(f); }
});

async function legacyPausedCancellationFixture(variant = "paused") {
  const f = await fixture(), intentId = await issue(f);
  await failedBegin(f, intentId);
  const evidence = await f.store.readBeginCancellationEvidence(intentId);
  const source = path.join(f.fixtureRoot, "paused-unrelated-source");
  await git(f.projectRoot, "worktree", "add", "-b", "paused-other", source);
  const priorIntent = `prior-${randomUUID()}`, priorRun = `run-${randomUUID()}`;
  const operation = variant === "original-operation" ? evidence.operation.operationToken : `operation-${randomUUID()}`;
  const runId = variant === "original-run" ? evidence.operation.runId : priorRun;
  const initialOperation = variant === "resumed" ? `original-${randomUUID()}` : operation;
  const leaseId = createHash("sha256").update(`session-active\0${f.sessionId}`).digest("hex");
  await authority.putAuthorizedOnceExact(f.dataRoot, "begin-operations", priorIntent, {
    schemaVersion: 1, intentId: priorIntent, sessionId: variant === "resumed" ? "prior-client-session" : f.sessionId, operationToken: initialOperation, runId,
  });
  await authority.putAuthorizedOnceExact(f.dataRoot, "runs", priorIntent, {
    schemaVersion: 1, intentId: priorIntent, sessionId: variant === "wrong-session" ? "foreign-session" : f.sessionId, operationToken: initialOperation, runId,
    ...(variant === "resumed" ? { activationToken: operation } : {}),
    phase: "tdd_red", status: variant === "running" ? "running" : "paused", projectRoot: f.projectRoot,
    worktreePath: ["target-owner", "target-path-only"].includes(variant) ? f.projectRoot : source,
    branch: ["target-owner", "target-branch-only"].includes(variant) ? f.targetBranch : "paused-other", targetBranch: f.targetBranch,
    commonGitDir: evidence.repository.commonGitDir,
  });
  const projection = { schemaVersion: 1, intentId: priorIntent, operationToken: operation,
    runId: variant === "uncorrelated" ? "unmatched-run" : runId, sessionId: f.sessionId, leaseId, leaseToken: operation };
  await authority.putAuthorizedOnceExact(f.dataRoot, "active", f.sessionId,
    variant === "malformed" ? { ...projection, ambiguous: true } : projection);
  await authority.acquireAuthorizedLease(f.dataRoot, leaseId, {
    intentId: priorIntent, operationToken: operation, runId, sessionId: f.sessionId, leaseToken: operation, operation: "session-active",
  });
  if (variant !== "held-session") await authority.releaseAuthorizedLease(f.dataRoot, leaseId, priorIntent, operation);
  await writeFile(path.join(source, "README.md"), "unrelated staged legacy source\n");
  await git(source, "add", "README.md");
  await writeFile(path.join(source, "README.md"), "unrelated loose legacy source\n");
  await writeFile(path.join(source, "paused-note.md"), "preserve legacy paused task\n");
  return { ...f, intentId, source, projection };
}

test("an authenticated legacy paused projection permits cancellation without a completed-owner claim", { timeout: 45000 }, async () => {
  const f = await legacyPausedCancellationFixture();
  try {
    const { args, diagnosis } = await inspect(f, f.intentId);
    assert.equal(diagnosis.later_state.active, true);
    const evidence = await f.store.readBeginCancellationEvidence(f.intentId);
    assert.equal(evidence.completedSessionTombstone, false);
    assert.equal(evidence.completedSessionOwner, false);
    const beforeSource = await snapshotTree(f.source), beforeGit = await snapshotTree(path.join(f.projectRoot, ".git"));
    const checkpoint = await checkpointState(f, f.intentId);
    const beforeAuthority = await snapshotTree(f.dataRoot);
    assert.equal((await cancellation()(f.store, args)).cancelled, true);
    assert.deepEqual(await snapshotTree(f.source), beforeSource);
    assert.deepEqual(await snapshotTree(path.join(f.projectRoot, ".git")), beforeGit);
    const after = new Map((await snapshotTree(f.dataRoot)).map(row => [row[0], row]));
    for (const row of beforeAuthority) if (!row[0].includes(checkpoint.checkpoint.leaseId) && !gateFiles(row[0])) assert.deepEqual(after.get(row[0]), row);
    assert.deepEqual(await authority.readAuthorizedReadOnly(f.dataRoot, "active", f.sessionId), f.projection);
    await assertNoRun(f, f.intentId);
  } finally { await dispose(f); }
});

for (const variant of ["running", "held-session", "target-owner", "target-path-only", "target-branch-only", "uncorrelated", "malformed", "wrong-session", "original-operation", "original-run"]) {
  test(`failed Begin cancellation refuses unsafe paused-owner variant ${variant} without mutation`, { timeout: 45000 }, async () => {
    const f = await legacyPausedCancellationFixture(variant);
    try {
      const { args } = await inspect(f, f.intentId);
      const beforeAuthority = await snapshotTree(f.dataRoot), beforeSource = await snapshotTree(f.source);
      const beforeGit = await snapshotTree(path.join(f.projectRoot, ".git"));
      await assert.rejects(cancellation()(f.store, args), /progressed|ambiguous|eligibility|binding|invalid|correlat/i);
      assert.deepEqual(await snapshotTree(f.dataRoot), beforeAuthority);
      assert.deepEqual(await snapshotTree(f.source), beforeSource);
      assert.deepEqual(await snapshotTree(path.join(f.projectRoot, ".git")), beforeGit);
      await assertNoRun(f, f.intentId);
    } finally { await dispose(f); }
  });
}

test("a resumed paused owner correlates by its activation without reusing the original Begin session", { timeout: 45000 }, async () => {
  const f = await legacyPausedCancellationFixture("resumed");
  try {
    const { args } = await inspect(f, f.intentId);
    const before = await snapshotTree(f.source);
    assert.equal((await cancellation()(f.store, args)).cancelled, true);
    assert.deepEqual(await authority.readAuthorizedReadOnly(f.dataRoot, "active", f.sessionId), f.projection);
    assert.deepEqual(await snapshotTree(f.source), before);
    await assertNoRun(f, f.intentId);
  } finally { await dispose(f); }
});

test("the cancellation guard rereads a paused owner reacquiring its session inside the attempt gate", { timeout: 45000 }, async () => {
  const f = await legacyPausedCancellationFixture();
  try {
    const { args } = await inspect(f, f.intentId), checkpoint = await checkpointState(f, f.intentId);
    const beforeSource = await snapshotTree(f.source), beforeGit = await snapshotTree(path.join(f.projectRoot, ".git"));
    const session = await authority.readAuthorizedLeaseSnapshotReadOnly(f.dataRoot, f.projection.leaseId);
    const gate = f.store.withBeginAttemptGate.bind(f.store);
    let entered = false, resumedAuthority;
    f.store.withBeginAttemptGate = (intentId, action) => gate(intentId, async () => {
      assert.equal(intentId, f.intentId);
      entered = true;
      await authority.acquireAuthorizedLease(f.dataRoot, f.projection.leaseId, session.payload);
      resumedAuthority = await snapshotTree(f.dataRoot, gateFiles);
      return action();
    });
    await assert.rejects(cancellation()(f.store, args), /progressed|ambiguous|eligibility|binding/i);
    assert.equal(entered, true, "the initial paused evidence must pass so the fresh guard observes the resume");
    assert.deepEqual(await snapshotTree(f.dataRoot, gateFiles), resumedAuthority, "refusal preserves the resumed owner and never writes a cancellation marker");
    assert.deepEqual(await authority.readAuthorizedLeaseSnapshotReadOnly(f.dataRoot, checkpoint.checkpoint.leaseId), checkpoint.lease);
    assert.deepEqual(await snapshotTree(f.source), beforeSource);
    assert.deepEqual(await snapshotTree(path.join(f.projectRoot, ".git")), beforeGit);
    await assertNoRun(f, f.intentId);
  } finally { await dispose(f); }
});
