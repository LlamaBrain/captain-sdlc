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

async function snapshotTree(root) {
  const result = {};
  async function visit(directory, prefix = "") {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch (error) { if (error.code === "ENOENT") return; throw error; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(full, name);
      else if (entry.isFile()) {
        const bytes = await readFile(full);
        result[name] = `${bytes.length}:${createHash("sha256").update(bytes).digest("hex")}`;
      } else throw new Error(`unexpected fixture entry: ${name}`);
    }
  }
  await visit(root);
  return result;
}

test("public SDK diagnoses the real signed pre-workspace Begin without writes", async () => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "captain-begin-diagnose-sdk-"));
  const projectRoot = path.join(fixtureRoot, "project");
  const dataRoot = path.join(fixtureRoot, "authority");
  const targetBranch = "feature/diagnostic-holder";
  await mkdir(path.join(projectRoot, ".captain-sdlc"), { recursive: true });
  await git(projectRoot, "init", "-b", "main");
  await git(projectRoot, "config", "core.autocrlf", "false");
  await git(projectRoot, "config", "user.name", "Captain Begin Diagnostic Fixture");
  await git(projectRoot, "config", "user.email", "captain-begin@example.invalid");
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
  await writeFile(path.join(projectRoot, "README.md"), "signed Begin diagnostic fixture\n");
  await git(projectRoot, "add", ".");
  await git(projectRoot, "commit", "-m", "fixture baseline");
  await git(projectRoot, "checkout", "-b", targetBranch);

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(pluginRoot, "dist", "server.js")],
    env: { ...process.env, CAPTAIN_PLUGIN_DATA: dataRoot },
    cwd: pluginRoot,
    stderr: "pipe",
  });
  const client = new Client({ name: "captain-begin-diagnose-signed-fixture", version: "1" });
  try {
    await client.connect(transport);
    const sessionId = `diagnostic-session-${process.pid}`;
    const turnId = `diagnostic-turn-${Date.now()}`;
    const taskId = "begin-diagnostic-fixture";
    const issuedReply = await client.callTool({
      name: "captain_issue_intent",
      arguments: {
        session_id: sessionId,
        turn_id: turnId,
        project_root: projectRoot,
        prompt: "Inspect the signed target lease without releasing it.",
        task_id: taskId,
        target_branch: targetBranch,
        action: "start",
      },
    });
    assert.notEqual(issuedReply.isError, true, JSON.stringify(issuedReply));
    const issued = issuedReply.structuredContent;
    assert.equal(typeof issued?.intent_id, "string");

    const beginReply = await client.callTool({
      name: "captain_begin_implementation",
      arguments: {
        intent_id: issued.intent_id,
        objective: "Create a signed pre-workspace lease fixture",
        project_root: projectRoot,
        task_id: taskId,
      },
    });
    assert.equal(beginReply.isError, true, JSON.stringify(beginReply));
    assert.match(beginReply.content.find(item => item.type === "text")?.text ?? "", /target branch is checked out outside the canonical worktree container/i);

    const tools = (await client.listTools()).tools;
    assert.ok(tools.some(tool => tool.name === "captain_begin_diagnose"), "SDK must publish the read-only diagnostic");
    const authorityBefore = await snapshotTree(dataRoot);
    const gitBefore = await snapshotTree(path.join(projectRoot, ".git"));
    const reply = await client.callTool({
      name: "captain_begin_diagnose",
      arguments: {
        intent_id: issued.intent_id,
        session_id: sessionId,
        project_root: projectRoot,
        target_worktree: projectRoot,
        target_branch: targetBranch,
      },
    });
    assert.notEqual(reply.isError, true, JSON.stringify(reply));
    const value = reply.structuredContent;
    assert.equal(value.read_only, true);
    assert.equal(value.diagnosis, "inspected");
    assert.equal(value.session_match, "same");
    assert.equal(value.issuance, "verified");
    assert.equal(value.reservation, "verified");
    assert.equal(value.repository_checkpoint, "verified");
    assert.equal(value.lease_checkpoint, "verified");
    assert.equal(value.stage, "lease_checkpointed");
    assert.deepEqual(value.target_lease, {
      state: "held",
      owner: "legacy",
      bindings_match: true,
      generation_revisioned: true,
      revision: value.target_lease.revision,
      resource_generation: value.target_lease.resource_generation,
    });
    assert.equal(value.recovery_disposition, "refused_legacy_owner_unproven");
    assert.equal(value.observed_branch_checkout_outside_canonical, true);
    assert.deepEqual(await snapshotTree(dataRoot), authorityBefore, "diagnosis must not write signed authority records or watermarks");
    assert.deepEqual(await snapshotTree(path.join(projectRoot, ".git")), gitBefore, "diagnosis must not mutate Git refs or worktree state");
    const serialized = JSON.stringify(value);
    const { user_request, ...diagnostic } = value;
    assert.equal(JSON.stringify(diagnostic).includes(sessionId), false, "diagnostic fields must not expose the caller's raw session id");
    assert.equal(user_request.receipts.length, 1);
    assert.equal(user_request.receipts[0].sessionId, sessionId);
    assert.equal(user_request.receipts[0].source, "client-adapter");
    assert.equal(user_request.receipts[0].originalText, "Inspect the signed target lease without releasing it.");
    assert.doesNotMatch(serialized, /leaseToken|operationToken|sessionLeaseToken/i);
  } finally {
    await client.close();
    assert.equal(path.dirname(fixtureRoot), path.resolve(os.tmpdir()));
    assert.ok(path.basename(fixtureRoot).startsWith("captain-begin-diagnose-sdk-"));
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});
