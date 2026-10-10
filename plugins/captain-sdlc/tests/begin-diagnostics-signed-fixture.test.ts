import assert from "node:assert/strict";
import test from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const pluginRoot = path.resolve(process.env.CAPTAIN_TEST_PLUGIN_ROOT ?? path.resolve(import.meta.dirname, ".."));
const importPlugin = relative => import(pathToFileURL(path.join(pluginRoot, relative)).href);

function git(cwd, ...args) {
  return execFileSync("git", ["--no-optional-locks", "-C", cwd, ...args], {
    encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

async function snapshotTree(root) {
  const rows = [];
  async function visit(current, relative = "") {
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(full, name);
      else if (entry.isFile()) {
        const bytes = await readFile(full);
        rows.push([name, bytes.length, createHash("sha256").update(bytes).digest("hex")]);
      } else throw new Error(`unexpected fixture filesystem entry: ${name}`);
    }
  }
  await visit(root);
  return JSON.stringify(rows);
}

test("actual signed Begin producer leaves a read-only diagnosable pre-workspace lease", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "captain-begin-signed-fixture-"));
  const projectRoot = path.join(base, "project");
  const dataRoot = path.join(base, "authority");
  await mkdir(projectRoot, { recursive: true });
  try {
    git(projectRoot, "init", "--initial-branch=main");
    git(projectRoot, "config", "user.name", "Captain fixture");
    git(projectRoot, "config", "user.email", "captain-fixture@example.invalid");
    await writeFile(path.join(projectRoot, "README.md"), "read-only Begin diagnostic fixture\n");
    git(projectRoot, "add", "README.md");
    git(projectRoot, "commit", "-m", "fixture root");
    const targetBranch = "feature/diagnostic-fixture";
    git(projectRoot, "checkout", "-b", targetBranch);
    const [{ LifecycleStore }, serverApi, workspace, adapterModule] = await Promise.all([
      importPlugin("src/lifecycle.ts"),
      importPlugin("src/server.ts"),
      importPlugin("src/workspace.ts"),
      importPlugin("src/begin-diagnostic-adapter.ts"),
    ]);
    const store = new LifecycleStore(dataRoot, async () => ({ exitCode: 0, stdout: "", stderr: "" }));
    const sessionId = `fixture-session-${randomUUID()}`;
    const turnId = `fixture-turn-${randomUUID()}`;
    const taskId = `fixture-task-${randomUUID()}`;
    const prompt = "Inspect a deliberately interrupted Begin without changing authority or Git.";
    const issued = await serverApi.captainIssueIntent(store, {
      session_id: sessionId, turn_id: turnId, project_root: projectRoot,
      prompt, task_id: taskId, target_branch: targetBranch, action: "start",
    });
    const policy = { profile: "low", visualRequired: false, commands: { build: "true" } };
    await assert.rejects(serverApi.captainBegin(store, {
      intent_id: issued.intent_id,
      objective: "diagnostic fixture",
      project_root: projectRoot,
      task_id: taskId,
    }, {
      repositoryIdentity: workspace.repositoryIdentity,
      loadPolicy: async () => policy,
      ensureWorktree: workspace.ensureWorktree,
    }), /target branch is checked out outside the canonical worktree container/i);

    const authorityBefore = await snapshotTree(dataRoot);
    const gitBefore = await snapshotTree(path.join(projectRoot, ".git"));
    const diagnose = adapterModule.createBeginDiagnosticAdapter(dataRoot);
    const result = await diagnose({
      intent_id: issued.intent_id,
      session_id: sessionId,
      project_root: projectRoot,
      target_worktree: projectRoot,
      target_branch: targetBranch,
    });

    assert.equal(result.read_only, true);
    assert.equal(result.diagnosis, "inspected");
    assert.equal(result.session_match, "same");
    assert.equal(result.issuance, "verified");
    assert.equal(result.reservation, "verified");
    assert.equal(result.repository_checkpoint, "verified");
    assert.equal(result.lease_checkpoint, "verified");
    assert.equal(result.stage, "lease_checkpointed");
    assert.equal(result.target_lease.state, "held");
    assert.equal(result.target_lease.owner, "legacy");
    assert.equal(result.target_lease.bindings_match, true);
    assert.equal(result.recovery_disposition, "refused_legacy_owner_unproven");
    assert.equal(result.observed_branch_checkout_outside_canonical, true);
    assert.equal(await snapshotTree(dataRoot), authorityBefore, "diagnosis must not mutate authenticated authority bytes");
    assert.equal(await snapshotTree(path.join(projectRoot, ".git")), gitBefore, "diagnosis must not mutate Git bytes");
  } finally {
    assert.equal(path.dirname(base), path.resolve(os.tmpdir()));
    assert.ok(path.basename(base).startsWith("captain-begin-signed-fixture-"));
    await rm(base, { recursive: true, force: true });
  }
});

test("adapter fails closed instead of treating a missing authority key as missing signed records", async () => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "captain-begin-no-key-"));
  try {
    const adapterModule = await importPlugin("src/begin-diagnostic-adapter.ts");
    const diagnose = adapterModule.createBeginDiagnosticAdapter(dataRoot);
    await assert.rejects(diagnose({
      intent_id: "intent-no-key",
      session_id: "session",
      project_root: dataRoot,
      target_worktree: dataRoot,
      target_branch: "main",
    }), error => error.code === "EAUTHORITYKEY");
    assert.deepEqual(await readdir(dataRoot), [], "failed read-only preflight must not bootstrap an authority directory");
  } finally {
    assert.equal(path.dirname(dataRoot), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dataRoot).startsWith("captain-begin-no-key-"));
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("actual signed active and permit checkpoints with the producer's no-turnId shape are recognized", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "captain-begin-active-fixture-"));
  const projectRoot = path.join(base, "project");
  const dataRoot = path.join(base, "authority");
  await mkdir(projectRoot, { recursive: true });
  try {
    git(projectRoot, "init", "--initial-branch=main");
    git(projectRoot, "config", "user.name", "Captain fixture");
    git(projectRoot, "config", "user.email", "captain-fixture@example.invalid");
    await writeFile(path.join(projectRoot, "README.md"), "active checkpoint fixture\n");
    git(projectRoot, "add", "README.md");
    git(projectRoot, "commit", "-m", "fixture root");
    const targetBranch = "feature/diagnostic-active";
    git(projectRoot, "checkout", "-b", targetBranch);
    const [{ LifecycleStore }, serverApi, workspace, adapterModule] = await Promise.all([
      importPlugin("src/lifecycle.ts"),
      importPlugin("src/server.ts"),
      importPlugin("src/workspace.ts"),
      importPlugin("src/begin-diagnostic-adapter.ts"),
    ]);
    const store = new LifecycleStore(dataRoot, async () => ({ exitCode: 0, stdout: "", stderr: "" }));
    const sessionId = `fixture-session-${randomUUID()}`;
    const turnId = `fixture-turn-${randomUUID()}`;
    const taskId = `fixture-task-${randomUUID()}`;
    const issued = await serverApi.captainIssueIntent(store, {
      session_id: sessionId, turn_id: turnId, project_root: projectRoot,
      prompt: "Verify the active signed Begin stage.", task_id: taskId,
      target_branch: targetBranch, action: "start",
    });
    const policy = { profile: "low", visualRequired: false, commands: { build: "true" } };
    const beginResult = await serverApi.captainBegin(store, {
      intent_id: issued.intent_id, objective: "active fixture", project_root: projectRoot, task_id: taskId,
    }, {
      repositoryIdentity: workspace.repositoryIdentity,
      loadPolicy: async () => policy,
      ensureWorktree: async (root, baseHead, intentId, branch, commonGitDir) => {
        const safe = intentId.replace(/[^A-Za-z0-9_-]/g, "");
        return {
          projectRoot: path.resolve(root),
          worktreePath: path.join(root, ".captain-sdlc", "worktrees", safe),
          baseHead,
          targetBranch: branch,
          branch,
          commonGitDir: path.resolve(commonGitDir),
          gitDir: path.join(commonGitDir, "worktrees", safe),
        };
      },
    });
    assert.equal(beginResult.intentId, issued.intent_id);
    assert.equal(beginResult.status, "running");

    const authorityBefore = await snapshotTree(dataRoot);
    const gitBefore = await snapshotTree(path.join(projectRoot, ".git"));
    const diagnose = adapterModule.createBeginDiagnosticAdapter(dataRoot);
    const result = await diagnose({
      intent_id: issued.intent_id,
      session_id: sessionId,
      project_root: projectRoot,
      target_worktree: projectRoot,
      target_branch: targetBranch,
    });
    assert.equal(result.diagnosis, "inspected", JSON.stringify(result));
    assert.equal(result.stage, "permit_published");
    assert.equal(result.later_state.run, true);
    assert.equal(result.later_state.active, true);
    assert.equal(result.later_state.activated, true);
    assert.equal(result.later_state.permit, true);
    assert.equal(result.recovery_disposition, "refused_later_or_ambiguous_state");
    assert.deepEqual(await snapshotTree(dataRoot), authorityBefore);
    assert.deepEqual(await snapshotTree(path.join(projectRoot, ".git")), gitBefore);
  } finally {
    assert.equal(path.dirname(base), path.resolve(os.tmpdir()));
    assert.ok(path.basename(base).startsWith("captain-begin-active-fixture-"));
    await rm(base, { recursive: true, force: true });
  }
});
