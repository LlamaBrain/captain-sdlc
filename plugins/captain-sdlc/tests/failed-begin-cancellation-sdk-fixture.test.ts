import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const pluginRoot = path.resolve(process.env.CAPTAIN_TEST_PLUGIN_ROOT ?? path.resolve(import.meta.dirname, ".."));
const requireFromPlugin = createRequire(path.join(pluginRoot, "package.json"));
const sdkImport = async specifier => import(pathToFileURL(requireFromPlugin.resolve(specifier)).href);
const [{ Client }, { StdioClientTransport }] = await Promise.all([
  sdkImport("@modelcontextprotocol/sdk/client/index.js"),
  sdkImport("@modelcontextprotocol/sdk/client/stdio.js"),
]);
const git = async (cwd, ...args) =>
  (await exec("git", ["--no-optional-locks", ...args], { cwd, windowsHide: true })).stdout.trim();

async function snapshotTree(root, { excludeBeginAttemptHistory = false } = {}) {
  const result = {};
  async function visit(directory, prefix = "") {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch (error) { if (error.code === "ENOENT") return; throw error; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (excludeBeginAttemptHistory &&
          (prefix === "lease-revisions" || prefix === "lease-watermarks") &&
          /^begin-attempt-[0-9a-f]{64}-[0-9]+\.json$/i.test(entry.name)) continue;
      const name = prefix ? prefix + "/" + entry.name : entry.name;
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(full, name);
      else if (entry.isFile()) {
        const bytes = await readFile(full);
        result[name] = bytes.length + ":" + createHash("sha256").update(bytes).digest("hex");
      } else throw new Error("unexpected fixture entry: " + name);
    }
  }
  await visit(root);
  return result;
}

async function createFixture(targetAlreadyCheckedOut) {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "captain-failed-begin-retirement-"));
  const projectRoot = path.join(fixtureRoot, "project");
  const dataRoot = path.join(fixtureRoot, "authority");
  const targetBranch = "feature/retire-failed-begin";
  await mkdir(path.join(projectRoot, ".captain-sdlc"), { recursive: true });
  await git(projectRoot, "init", "-b", "main");
  await git(projectRoot, "config", "core.autocrlf", "false");
  await git(projectRoot, "config", "user.name", "Captain Begin Retirement Fixture");
  await git(projectRoot, "config", "user.email", "captain-retirement@example.invalid");
  await writeFile(path.join(projectRoot, ".captain-sdlc", "codex-policy.json"), JSON.stringify({
    profile: "low",
    visualRequired: false,
    commands: {
      build: "node fixture-gate.cjs",
      ticket: "node fixture-gate.cjs",
      "feature-smoke": "node fixture-gate.cjs",
      "affected-regression": "node fixture-gate.cjs",
    },
  }));
  await writeFile(path.join(projectRoot, "fixture-gate.cjs"), "process.exit(0);\n");
  await writeFile(path.join(projectRoot, "README.md"), "failed Begin retirement fixture\n");
  await git(projectRoot, "add", ".");
  await git(projectRoot, "commit", "-m", "fixture baseline");
  if (targetAlreadyCheckedOut) await git(projectRoot, "checkout", "-b", targetBranch);
  else await git(projectRoot, "branch", targetBranch);
  return { fixtureRoot, projectRoot, dataRoot, targetBranch };
}

async function openClient(dataRoot) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(pluginRoot, "dist", "server.js")],
    env: { ...process.env, CAPTAIN_PLUGIN_DATA: dataRoot },
    cwd: pluginRoot,
    stderr: "pipe",
  });
  const client = new Client({ name: "captain-failed-begin-retirement-fixture", version: "1" });
  await client.connect(transport);
  return client;
}

function textOf(reply) {
  return reply.content?.find(item => item.type === "text")?.text ?? "";
}

async function issue(client, projectRoot, targetBranch) {
  const sessionId = "retirement-session-" + process.pid + "-" + Date.now();
  const taskId = "failed-begin-retirement-fixture";
  const reply = await client.callTool({
    name: "captain_issue_intent",
    arguments: {
      session_id: sessionId,
      turn_id: "turn-" + Date.now(),
      project_root: projectRoot,
      prompt: "Start the authorized fixture task on the selected target branch.",
      task_id: taskId,
      target_branch: targetBranch,
      action: "start",
    },
  });
  assert.notEqual(reply.isError, true, JSON.stringify(reply));
  assert.equal(typeof reply.structuredContent?.intent_id, "string");
  return { sessionId, taskId, intentId: reply.structuredContent.intent_id };
}

function cancellationArgs({ intentId, sessionId, projectRoot, targetWorktree, targetBranch, diagnostic }) {
  assert.equal(diagnostic.diagnosis, "inspected");
  assert.equal(diagnostic.session_match, "same");
  assert.equal(diagnostic.target_lease.state, "held");
  assert.ok(Number.isSafeInteger(diagnostic.target_lease.revision));
  assert.match(diagnostic.target_lease.resource_generation, /^[0-9a-f]{64}$/i);
  return {
    intent_id: intentId,
    session_id: sessionId,
    project_root: projectRoot,
    target_worktree: targetWorktree,
    target_branch: targetBranch,
    expected_lease_revision: diagnostic.target_lease.revision,
    resource_generation: diagnostic.target_lease.resource_generation,
    confirm_owner_stopped: true,
  };
}

async function diagnose(client, args) {
  const reply = await client.callTool({ name: "captain_begin_diagnose", arguments: args });
  assert.notEqual(reply.isError, true, JSON.stringify(reply));
  return reply.structuredContent;
}

async function assertCancellationToolPublished(client) {
  const listed = await client.listTools();
  const tool = listed.tools?.find(candidate => candidate.name === "captain_cancel_failed_begin");
  assert.ok(tool, "the public server must publish captain_cancel_failed_begin");
  assert.ok(tool.inputSchema?.properties?.expected_lease_revision, "the published schema must bind the expected lease revision");
  assert.ok(tool.inputSchema?.properties?.resource_generation, "the published schema must bind the resource generation");
  assert.ok(tool.inputSchema?.properties?.confirm_owner_stopped, "the published schema must require explicit owner confirmation");
}

test("public cancellation releases only the exact terminal pre-workspace Begin and fences retries", async () => {
  const fixture = await createFixture(true);
  const client = await openClient(fixture.dataRoot);
  try {
    await assertCancellationToolPublished(client);
    const issued = await issue(client, fixture.projectRoot, fixture.targetBranch);
    const gitBefore = await snapshotTree(path.join(fixture.projectRoot, ".git"));
    const branchBefore = await git(fixture.projectRoot, "rev-parse", "refs/heads/" + fixture.targetBranch);
    const failed = await client.callTool({
      name: "captain_begin_implementation",
      arguments: {
        intent_id: issued.intentId,
        objective: "Create a real signed pre-workspace failed Begin",
        project_root: fixture.projectRoot,
        task_id: issued.taskId,
      },
    });
    assert.equal(failed.isError, true, JSON.stringify(failed));
    assert.match(textOf(failed), /target branch is checked out outside the canonical worktree container/i);

    const targetWorktree = fixture.projectRoot;
    const diagnosticArgs = {
      intent_id: issued.intentId,
      session_id: issued.sessionId,
      project_root: fixture.projectRoot,
      target_worktree: targetWorktree,
      target_branch: fixture.targetBranch,
    };
    const diagnostic = await diagnose(client, diagnosticArgs);
    assert.equal(diagnostic.stage, "lease_checkpointed");
    assert.deepEqual(diagnostic.later_state, {
      workspace: false,
      run: false,
      active: false,
      activated: false,
      permit: false,
      canonical_path_exists: false,
      canonical_worktree_registered: false,
      pending_git_operation: false,
    });
    assert.equal(diagnostic.observed_branch_checkout_outside_canonical, true);
    assert.deepEqual(await snapshotTree(path.join(fixture.projectRoot, ".git")), gitBefore);

    const args = cancellationArgs({ ...fixture, ...issued, targetWorktree, diagnostic });
    const authorityBeforeRefusals = await snapshotTree(fixture.dataRoot);
    const staleRevision = await client.callTool({
      name: "captain_cancel_failed_begin",
      arguments: { ...args, expected_lease_revision: args.expected_lease_revision + 1 },
    });
    assert.equal(staleRevision.isError, true, "a stale lease revision must be refused");
    const wrongGeneration = await client.callTool({
      name: "captain_cancel_failed_begin",
      arguments: { ...args, resource_generation: "f".repeat(64) },
    });
    assert.equal(wrongGeneration.isError, true, "a mismatched lease generation must be refused");
    const wrongSession = await client.callTool({
      name: "captain_cancel_failed_begin",
      arguments: { ...args, session_id: "foreign-caller-session" },
    });
    assert.equal(wrongSession.isError, true, "a foreign session must not retire the reservation");
    assert.deepEqual(await snapshotTree(fixture.dataRoot), authorityBeforeRefusals);
    assert.deepEqual(await snapshotTree(path.join(fixture.projectRoot, ".git")), gitBefore);

    const cancelled = await client.callTool({ name: "captain_cancel_failed_begin", arguments: args });
    assert.notEqual(cancelled.isError, true, JSON.stringify(cancelled));
    assert.deepEqual(cancelled.structuredContent, {
      intent_id: issued.intentId,
      state: "cancelled",
      cancelled: true,
    });
    const responseText = JSON.stringify(cancelled);
    assert.equal(responseText.includes(issued.sessionId), false);
    assert.doesNotMatch(responseText, /leaseToken|operationToken|sessionLeaseToken/i);

    const afterCancel = await diagnose(client, diagnosticArgs);
    assert.equal(afterCancel.target_lease.state, "released");
    const releasedRevision = afterCancel.target_lease.revision;
    assert.ok(Number.isSafeInteger(releasedRevision));
    const authorityAfterCancel = await snapshotTree(fixture.dataRoot, { excludeBeginAttemptHistory: true });

    const repeated = await client.callTool({ name: "captain_cancel_failed_begin", arguments: args });
    assert.notEqual(repeated.isError, true, JSON.stringify(repeated));
    assert.deepEqual(repeated.structuredContent, cancelled.structuredContent);
    assert.deepEqual(await snapshotTree(fixture.dataRoot, { excludeBeginAttemptHistory: true }), authorityAfterCancel, "same-selector repeat is idempotent apart from its signed begin-attempt gate history");
    assert.equal((await diagnose(client, diagnosticArgs)).target_lease.revision, releasedRevision);

    const retry = await client.callTool({
      name: "captain_begin_implementation",
      arguments: {
        intent_id: issued.intentId,
        objective: "Create a real signed pre-workspace failed Begin",
        project_root: fixture.projectRoot,
        task_id: issued.taskId,
      },
    });
    assert.equal(retry.isError, true, "a cancelled Begin reservation must not be reacquired");
    assert.deepEqual(await snapshotTree(fixture.dataRoot, { excludeBeginAttemptHistory: true }), authorityAfterCancel);
    assert.deepEqual(await snapshotTree(path.join(fixture.projectRoot, ".git")), gitBefore);
    assert.equal(await git(fixture.projectRoot, "rev-parse", "refs/heads/" + fixture.targetBranch), branchBefore);
    assert.deepEqual(
      await snapshotTree(path.join(fixture.projectRoot, ".captain-sdlc", "worktrees")),
      {},
      "retirement and retry must not create a canonical worktree",
    );
  } finally {
    await client.close();
    assert.equal(path.dirname(fixture.fixtureRoot), path.resolve(os.tmpdir()));
    assert.ok(path.basename(fixture.fixtureRoot).startsWith("captain-failed-begin-retirement-"));
    await rm(fixture.fixtureRoot, { recursive: true, force: true });
  }
});

test("public cancellation refuses an already progressed Begin without changing it", async () => {
  const fixture = await createFixture(false);
  const client = await openClient(fixture.dataRoot);
  try {
    await assertCancellationToolPublished(client);
    const issued = await issue(client, fixture.projectRoot, fixture.targetBranch);
    const begun = await client.callTool({
      name: "captain_begin_implementation",
      arguments: {
        intent_id: issued.intentId,
        objective: "Create a real signed progressed Begin",
        project_root: fixture.projectRoot,
        task_id: issued.taskId,
      },
    });
    assert.notEqual(begun.isError, true, JSON.stringify(begun));
    const targetWorktree = fixture.projectRoot;
    const diagnosticArgs = {
      intent_id: issued.intentId,
      session_id: issued.sessionId,
      project_root: fixture.projectRoot,
      target_worktree: targetWorktree,
      target_branch: fixture.targetBranch,
    };
    const diagnostic = await diagnose(client, diagnosticArgs);
    assert.equal(diagnostic.diagnosis, "inspected");
    assert.ok(["workspace_checkpointed", "run_checkpointed", "active_checkpointed", "activated", "permit_published"].includes(diagnostic.stage));
    assert.equal(diagnostic.target_lease.state, "held");
    assert.ok(diagnostic.later_state.workspace || diagnostic.later_state.run || diagnostic.later_state.active);

    const args = cancellationArgs({ ...fixture, ...issued, targetWorktree, diagnostic });
    const authorityBefore = await snapshotTree(fixture.dataRoot);
    const gitBefore = await snapshotTree(path.join(fixture.projectRoot, ".git"));
    const refused = await client.callTool({ name: "captain_cancel_failed_begin", arguments: args });
    assert.equal(refused.isError, true, "a progressed Begin must never be retired");
    assert.match(textOf(refused), /progress|workspace|run|active|permit|checkpoint/i,
      "the refusal must come from the progressed-state guard, not a missing or unknown tool");
    assert.doesNotMatch(textOf(refused), /unknown tool|tool not found|unrecognized tool/i);
    assert.deepEqual(await snapshotTree(fixture.dataRoot), authorityBefore);
    assert.deepEqual(await snapshotTree(path.join(fixture.projectRoot, ".git")), gitBefore);
    const after = await diagnose(client, diagnosticArgs);
    assert.equal(after.target_lease.state, "held");
    assert.deepEqual(after.later_state, diagnostic.later_state);
  } finally {
    await client.close();
    assert.equal(path.dirname(fixture.fixtureRoot), path.resolve(os.tmpdir()));
    assert.ok(path.basename(fixture.fixtureRoot).startsWith("captain-failed-begin-retirement-"));
    await rm(fixture.fixtureRoot, { recursive: true, force: true });
  }
});

