import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// Public MCP only: fresh Git repositories and isolated authority per fixture.
// Optional argv[5] runs an additional upgrade/recovery fixture using an old server.
const pluginRoot = path.resolve(process.argv[2] || path.join(import.meta.dirname, ".."));
const evidenceRoot = path.resolve(process.argv[3] || path.join(pluginRoot, ".captain-proof"));
const scratchRoot = path.resolve(process.argv[4] || path.join(tmpdir(), "cml"));
const legacyRoot = process.argv[5] ? path.resolve(process.argv[5]) : undefined;
const exec = promisify(execFile);
const git = async (cwd, ...args) => (await exec("git", args, { cwd, windowsHide: true })).stdout.trim();
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const requiredApi = "captain_reconcile_merge_implementation";
const session = "merge-lifecycle-public-fixture";
const taskId = "merge-lifecycle-fixture";
await mkdir(scratchRoot, { recursive: true });
await mkdir(evidenceRoot, { recursive: true });
const runtimeIdentity = async root => ({
  plugin_root: root,
  plugin_version: JSON.parse(await readFile(path.join(root, "package.json"), "utf8")).version,
  server_sha256: sha(await readFile(path.join(root, "dist", "server.js"))),
});
const runtime = await runtimeIdentity(pluginRoot);
const scenarios = [];
let currentFixture;

async function connect(root, authority) {
  const client = new Client({ name: "captain-merge-lifecycle-smoke", version: "1" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(root, "dist", "server.js")], cwd: root,
    env: { ...process.env, CAPTAIN_PLUGIN_DATA: authority, CODEX_PLUGIN_ROOT: root, PLUGIN_ROOT: root },
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", chunk => { stderr += chunk.toString(); });
  try { await client.connect(transport); }
  catch (error) { await client.close(); throw new Error(String(error) + "\n" + stderr); }
  assert.equal(client.getServerVersion()?.version, (await runtimeIdentity(root)).plugin_version);
  return {
    client,
    async call(name, args, expectError = false) {
      const reply = await client.callTool({ name, arguments: args }, undefined, { timeout: 600000 });
      if (expectError) { assert.equal(reply.isError, true, "Expected rejection: " + name); return reply; }
      assert.notEqual(reply.isError, true, name + ": " + JSON.stringify(reply));
      return reply.structuredContent ?? JSON.parse(reply.content.find(item => item.type === "text").text);
    },
    close: () => client.close(),
  };
}

async function seedProject(target) {
  await mkdir(path.join(target, ".captain-sdlc", "notebook"), { recursive: true });
  await git(target, "init", "-b", "main");
  await git(target, "config", "core.autocrlf", "false");
  await git(target, "config", "core.longpaths", "true");
  await git(target, "config", "user.name", "Captain Public MCP Fixture");
  await git(target, "config", "user.email", "captain@example.invalid");
  await writeFile(path.join(target, ".gitignore"), "Temp/\n.captain-sdlc/worktrees/\n");
  await writeFile(path.join(target, ".captain-sdlc", "codex-policy.json"), JSON.stringify({
    profile: "low", visualRequired: false,
    commands: { build: "node fixture-gate.cjs", ticket: "node fixture-ticket.cjs", "feature-smoke": "node fixture-ticket.cjs", "affected-regression": "node fixture-ticket.cjs" },
    redGate: { expectedExitCodes: [1], outputPattern: "ASSERT fixture task missing" },
    sourceManifestExcludes: ["Temp"],
    commit: { conventional: true, require_version_suffix: true, require_task_trailer: true,
      version_file: "VERSION", version_surfaces: [{ path: "VERSION", pattern: "(?m)^(?<version>[0-9]+\\.[0-9]+\\.[0-9]+)\\s*$" }],
      changelog_files: ["CHANGELOG.md"], bookkeeping: { path_file: ".captain-sdlc/captain.ignore" } },
  }));
  await writeFile(path.join(target, ".captain-sdlc", "merge-policy.json"), JSON.stringify({ schema_version: 1, strictness: "low" }));
  await writeFile(path.join(target, ".captain-sdlc", "captain.ignore"), "/.captain-sdlc/notebook/\n");
  await writeFile(path.join(target, ".captain-sdlc", "notebook", "notes.json"), "{}\n");
  await writeFile(path.join(target, "VERSION"), "1.0.0\n");
  await writeFile(path.join(target, "CHANGELOG.md"), "Fixture baseline v1.0.0\n");
  await writeFile(path.join(target, "fixture-ticket.cjs"), "const fs=require('node:fs');if(!fs.existsSync('task.txt')){console.error('ASSERT fixture task missing');process.exit(1)}console.log('fixture task passes');\n");
  await writeFile(path.join(target, "fixture-gate.cjs"), "const fs=require('node:fs');fs.mkdirSync('Temp',{recursive:true});fs.appendFileSync('Temp/gates.log','build\\n');console.log('fixture development build');\n");
  await git(target, "add", ".");
  await git(target, "commit", "-m", "chore(test): initialize public MCP fixture (v1.0.0)");
}

async function expectReconcileReject(api, args, runBefore) {
  await api.call(requiredApi, args, true);
  const after = await api.call("captain_status", { intent_id: runBefore.intentId });
  assert.equal(after.revision, runBefore.revision, "Rejected reconciliation cannot mutate implementation authority");
  assert.deepEqual(after.committedState, runBefore.committedState);
}

async function exercise({ legacy = false } = {}) {
  const root = await mkdtemp(path.join(scratchRoot, legacy ? "legacy " : "ordinary "));
  currentFixture = root;
  const target = path.join(root, "target with spaces");
  const authority = path.join(root, "isolated authority with spaces");
  await seedProject(target);
  let api = await connect(legacy ? legacyRoot : pluginRoot, authority);
  let source, intentId, prepared;
  const gates = async () => (await readFile(path.join(source, "Temp", "gates.log"), "utf8")).trim().split(/\r?\n/).filter(Boolean).length;
  try {
    const issued = await api.call("captain_issue_intent", { session_id: session, turn_id: "implement", project_root: target,
      prompt: "Implement the fixture, commit, prepare target integration, and retain the existing implementation run.", task_id: taskId, action: "start" });
    intentId = issued.intent_id;
    const begun = await api.call("captain_begin_implementation", { intent_id: intentId, objective: "Public merge lifecycle regression fixture", project_root: target, task_id: taskId });
    source = begun.worktreePath;
    assert.ok(source.includes(" "), "Fixture worktree must exercise paths with spaces");
    const red = await api.call("captain_record_red", { intent_id: intentId });
    assert.equal(red.phase, "implement");
    assert.ok(red.evidence.some(item => item.kind === "tdd_red" && item.exitCode === 1));
    await writeFile(path.join(source, "task.txt"), "real task implementation\n");
    await writeFile(path.join(source, "VERSION"), "1.0.1\n");
    await writeFile(path.join(source, "CHANGELOG.md"), "Fixture baseline v1.0.0\nSource implementation v1.0.1\n");
    const phaseCommit = await api.call("captain_commit", { intent_id: intentId, paths: ["task.txt", "VERSION", "CHANGELOG.md"],
      subject: "fix(test): implement merge lifecycle fixture (v1.0.1)", task_outcome: "Implements", final: false });
    assert.equal(phaseCommit.phase, "implement");
    const previousPhase = await git(source, "rev-parse", "HEAD");
    assert.equal(phaseCommit.committedState.head, previousPhase);
    // Independently advanced target is a real Git branch, never an authority rewrite.
    await writeFile(path.join(target, "target.txt"), "independent target implementation\n");
    await writeFile(path.join(target, "VERSION"), "1.0.1\n");
    await writeFile(path.join(target, "CHANGELOG.md"), "Fixture baseline v1.0.0\nTarget implementation v1.0.1\n");
    await git(target, "add", "target.txt", "VERSION", "CHANGELOG.md");
    await git(target, "commit", "-m", "fix(test): advance independent target (v1.0.1)", "-m", "Implements: target-fixture");
    const pinnedTarget = await git(target, "rev-parse", "HEAD");
    const prepArgs = { source_worktree: source, target_worktree: target, target_branch: "main", session_id: session };
    const pending = await api.call("captain_merge_prep", prepArgs);
    assert.ok(["needs_resolution", "needs_commit"].includes(pending.state), JSON.stringify(pending));
    assert.equal(await git(source, "rev-parse", "MERGE_HEAD"), pinnedTarget);
    await writeFile(path.join(source, "VERSION"), "1.0.2\n");
    await writeFile(path.join(source, "CHANGELOG.md"), "Fixture baseline v1.0.0\nSource implementation v1.0.1\nTarget implementation v1.0.1\nPrepared integration v1.0.2\n");
    prepared = await api.call("captain_merge_prep", { ...prepArgs, merge_id: pending.merge_id,
      commit: { paths: ["target.txt", "VERSION", "CHANGELOG.md"], subject: "chore(merge): prepare independent target (v1.0.2)", task_outcome: "Implements", task_id: taskId } });
    assert.equal(prepared.state, "ready");
    assert.equal(prepared.receipt_valid, true);
    assert.equal(prepared.captain_green, false);
    const candidate = await git(source, "rev-parse", "HEAD");
    assert.equal(prepared.ready_inputs.source.head, candidate);
    assert.deepEqual((await git(source, "rev-list", "--parents", "-n", "1", candidate)).split(" "), [candidate, previousPhase, pinnedTarget]);
    assert.equal(await git(target, "rev-parse", "HEAD"), pinnedTarget, "Prep retains target stop boundary");
    assert.equal(await gates(), 1);
    let before = await api.call("captain_status", { intent_id: intentId });
    if (legacy) {
      assert.equal(before.committedState.head, previousPhase, "Legacy server reproduces stale implementation ledger");
      await api.close();
      await git(target, "merge", "--ff-only", candidate);
      api = await connect(pluginRoot, authority);
    } else {
      assert.equal(before.committedState.head, candidate, "Prep automatically associates its exact commit with active implementation");
      assert.equal(before.phase, "implement");
      assert.equal(before.status, "running");
    }
    const recoverArgs = { merge_id: prepared.merge_id, session_id: session, intent_id: intentId };
    const associated = await api.call(requiredApi, recoverArgs);
    assert.equal(associated.merge_id, prepared.merge_id);
    assert.equal(associated.captain_green, false);
    const implementation = associated.implementation;
    assert.equal(implementation.intentId, intentId);
    assert.equal(implementation.runId, begun.runId);
    assert.equal(implementation.worktreePath, source);
    assert.equal(implementation.committedState.head, candidate);
    assert.equal(implementation.phase, "implement");
    assert.equal(implementation.status, "running");
    const again = await api.call(requiredApi, recoverArgs);
    assert.equal(again.implementation.revision, implementation.revision, "Exact recovery is idempotent");
    await expectReconcileReject(api, { ...recoverArgs, session_id: "foreign-fixture-session" }, implementation);
    // A genuinely issued unrelated intent is rejected, without fabricating signed authority.
    const foreign = await api.call("captain_issue_intent", { session_id: "foreign-fixture-session", turn_id: "foreign", project_root: target,
      prompt: "Create an unrelated fixture intent for a negative ownership check.", task_id: "foreign-fixture", action: "start" });
    await expectReconcileReject(api, { ...recoverArgs, intent_id: foreign.intent_id }, implementation);
    assert.equal(await gates(), 1, "Reconciliation never reruns Prep gates");
    if (legacy) {
      const merged = await api.call("captain_merge_back", { merge_id: prepared.merge_id, session_id: session });
      assert.equal(merged.state, "merged");
      assert.equal(merged.captain_green, false);
      assert.equal(await git(target, "rev-parse", "HEAD"), candidate);
      assert.equal(await gates(), 1, "Already completed raw FF recovers without gates");
    }
    const recordPath = ".captain-sdlc/notebook/notes.json";
    await writeFile(path.join(source, recordPath), JSON.stringify({ fixture: "retain ordinary phase continuation", merge_id: prepared.merge_id }) + "\n");
    const continued = await api.call("captain_commit", { intent_id: intentId, paths: [recordPath], subject: "docs(captain): retain merge lifecycle proof", task_outcome: "Implements", final: false });
    const descendant = await git(source, "rev-parse", "HEAD");
    assert.equal(continued.committedState.head, descendant);
    assert.equal(continued.phase, "implement");
    assert.notEqual(descendant, candidate);
    assert.equal(await git(source, "rev-parse", "HEAD^"), candidate, "Ordinary next commit retains imported merge as first parent");
    let finalPrep = prepared;
    if (!legacy) {
      finalPrep = await api.call("captain_merge_prep", { ...prepArgs, merge_id: prepared.merge_id });
      assert.equal(finalPrep.state, "ready");
      assert.equal(finalPrep.captain_green, false);
      assert.equal(finalPrep.ready_inputs.source.head, candidate, "Gate evidence remains at actual tested revision");
      assert.equal(finalPrep.integration_inputs.source.head, descendant, "Bookkeeping descendant associates without relabeling gate proof");
      assert.equal(await gates(), 1, "Record-only descendant cannot repeat gates");
      const merged = await api.call("captain_merge_back", { merge_id: finalPrep.merge_id, session_id: session });
      assert.equal(merged.state, "merged");
      assert.equal(merged.captain_green, false);
      assert.equal(await git(target, "rev-parse", "HEAD"), descendant);
      assert.equal((await api.call("captain_merge_back", { merge_id: finalPrep.merge_id, session_id: session })).state, "merged");
    }
    assert.equal(await gates(), 1);
    assert.equal(await git(source, "status", "--porcelain"), "");
    assert.equal(await git(target, "status", "--porcelain"), "");
    const end = await api.call("captain_status", { intent_id: intentId });
    assert.equal(end.phase, "implement", "Merge readiness does not manufacture implementation completion");
    assert.equal(end.committedState.head, descendant);
    return { mode: legacy ? "legacy-upgrade-after-manual-ff" : "automatic-association-and-continuation", fixture: root,
      setup_runtime: await runtimeIdentity(legacy ? legacyRoot : pluginRoot), runtime,
      intent_id: intentId, run_id: begun.runId, merge_id: prepared.merge_id,
      previous_phase_head: previousPhase, pinned_target_head: pinnedTarget, prepared_source_head: candidate,
      continued_source_head: descendant, final_target_head: await git(target, "rev-parse", "HEAD"),
      gates_run: await gates(), proof_revision: prepared.ready_inputs.source.head, phase: end.phase,
      public_only_authority_setup: true, idempotent_reconciliation: true, foreign_session_rejected: true,
      foreign_intent_rejected: true, ordinary_next_phase_commit: true, captain_green: false };
  } finally { await api.close(); }
}

try {
  // Fail immediately against an unchanged baseline that lacks the public protocol.
  const probeRoot = await mkdtemp(path.join(scratchRoot, "protocol probe "));
  const probe = await connect(pluginRoot, path.join(probeRoot, "authority"));
  try {
    assert.ok((await probe.client.listTools()).tools.some(tool => tool.name === requiredApi), "missing public protocol " + requiredApi);
  } finally { await probe.close(); }
  scenarios.push(await exercise());
  if (legacyRoot) scenarios.push(await exercise({ legacy: true }));
  const proof = { schema_version: 1, smoke: "mcp-merge-lifecycle", status: "green", created_at: new Date().toISOString(),
    ...runtime, scenarios, captain_green: false };
  await writeFile(path.join(evidenceRoot, "merge-lifecycle-mcp-smoke.json"), JSON.stringify(proof, null, 2) + "\n");
  console.log("Captain public MCP merge lifecycle: green (" + scenarios.length + " fixtures)");
} catch (error) {
  const proof = { schema_version: 1, smoke: "mcp-merge-lifecycle", status: "red", created_at: new Date().toISOString(),
    ...runtime, scenarios, failed_fixture: currentFixture, error: error.stack || String(error), captain_green: false };
  await writeFile(path.join(evidenceRoot, "merge-lifecycle-mcp-smoke.json"), JSON.stringify(proof, null, 2) + "\n");
  throw error;
}
