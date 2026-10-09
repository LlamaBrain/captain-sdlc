import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { acquireAuthorizedLease } from "../dist/authority.js";

// A fresh MCP process and real Git pair exercise the packaged transport and stop boundary.
// Only disposable fixture repositories are integrated; production repositories are untouched.
const pluginRoot = path.resolve(process.argv[2] || path.join(import.meta.dirname, ".."));
const evidenceRoot = path.resolve(process.argv[3] || path.join(pluginRoot, ".captain-proof"));
const scratchRoot = path.resolve(process.argv[4] || path.join(pluginRoot, "Temp", "automation-scratch", "merge-mcp"));
await mkdir(scratchRoot, { recursive: true });
const run = await mkdtemp(path.join(scratchRoot, "run-"));
const target = path.join(run, "target with spaces"), source = path.join(run, "source with spaces");
const exec = promisify(execFile);
const git = async (cwd, ...args) => (await exec("git", args, { cwd, windowsHide: true })).stdout.trim();
await mkdir(target);
await git(target, "init", "-b", "main");
await git(target, "config", "core.autocrlf", "false");
await git(target, "config", "core.longpaths", "true");
await git(target, "config", "user.name", "Captain MCP Fixture");
await git(target, "config", "user.email", "captain@example.invalid");
await mkdir(path.join(target, ".captain-sdlc"));
await writeFile(path.join(target, ".captain-sdlc", "codex-policy.json"), JSON.stringify({
  profile: "low", visualRequired: false,
  commands: { build: "node fixture-gate.cjs", ticket: "node fixture-gate.cjs", "feature-smoke": "node fixture-gate.cjs", "affected-regression": "node fixture-gate.cjs" },
  sourceManifestExcludes: ["Temp"],
  commit: { conventional: true, require_version_suffix: false, require_task_trailer: false, version_file: "VERSION", version_surfaces: [], changelog_files: ["CHANGELOG.md"] }
}));
await writeFile(path.join(target, ".captain-sdlc", "merge-policy.json"), JSON.stringify({ schema_version: 1, strictness: "low" }));
await writeFile(path.join(target, ".gitignore"), "Temp/\n");
await writeFile(path.join(target, "VERSION"), "1.0.0\n");
await writeFile(path.join(target, "CHANGELOG.md"), "fixture baseline\n");
await writeFile(path.join(target, "fixture-gate.cjs"), "const fs=require('node:fs');fs.mkdirSync('Temp',{recursive:true});fs.appendFileSync('Temp/gates.log','build\\n');\n");
await git(target, "add", ".");
await git(target, "commit", "-m", "chore(test): fixture baseline");
await git(target, "worktree", "add", "-b", "task", source);
await writeFile(path.join(source, "task.txt"), "prepared task\n");
await git(source, "add", "task.txt");
await git(source, "commit", "-m", "fix(test): prepared task");
const originalTarget = await git(target, "rev-parse", "HEAD");
const env = { ...process.env, CAPTAIN_PLUGIN_DATA: path.join(run, "authority") };
const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(pluginRoot, "dist", "server.js")], env, cwd: pluginRoot });
const client = new Client({ name: "captain-two-step-merge-smoke", version: "1" });
const session_id = "merge-mcp-fixture-session";
async function call(name, args, expectError = false) {
  const reply = await client.callTool({ name, arguments: args });
  if (expectError) { assert.equal(reply.isError, true); return reply; }
  assert.notEqual(reply.isError, true, JSON.stringify(reply));
  return reply.structuredContent ?? JSON.parse(reply.content.find(item => item.type === "text").text);
}
try {
  await client.connect(transport);
  const listed = (await client.listTools()).tools;
  const tools = listed.map(tool => tool.name);
  for (const name of ["captain_merge_prep", "captain_merge_begin", "captain_merge_back", "captain_merge_finish", "captain_merge_status", "captain_recover_merge_lease", "captain_prepare_merge", "captain_abort_merge", "captain_commit"]) assert.ok(tools.includes(name), `missing ${name}`);
  for (const [canonical, alias] of [["captain_merge_prep", "captain_merge_begin"], ["captain_merge_back", "captain_merge_finish"]]) {
    assert.deepEqual(listed.find(tool => tool.name === alias).inputSchema, listed.find(tool => tool.name === canonical).inputSchema, `${alias} shares canonical schema`);
  }
  await call("captain_merge_finish", { merge_id: "never-prepared", session_id }, true);
  await call("captain_merge_back", { merge_id: "never-prepared", session_id }, true);
  const args = { source_worktree: source, target_worktree: target, target_branch: "main", session_id };
  const ready = await call("captain_merge_prep", args);
  assert.equal(ready.state, "ready");
  assert.equal(ready.receipt_valid, true);
  assert.equal(ready.captain_green, false);
  assert.equal(await git(target, "rev-parse", "HEAD"), originalTarget);
  const status = await call("captain_merge_status", { merge_id: ready.merge_id, session_id });
  assert.equal(status.receipt_valid, true);
  const leaseId = createHash("sha256").update(`merge-operation\0${ready.merge_id}`).digest("hex"), leaseToken = randomUUID();
  await acquireAuthorizedLease(env.CAPTAIN_PLUGIN_DATA, leaseId, { intentId: ready.merge_id, leaseToken, sessionId: session_id, operation: "integration" });
  const recovery = { merge_id: ready.merge_id, session_id, source_worktree: source, target_worktree: target, target_branch: "main", expected_revision: ready.revision, expected_lease_token: leaseToken };
  await call("captain_recover_merge_lease", { ...recovery, confirm_owner_stopped: false }, true);
  assert.equal((await call("captain_merge_status", { merge_id: ready.merge_id, session_id })).receipt_valid, true);
  const released = await call("captain_recover_merge_lease", { ...recovery, confirm_owner_stopped: true });
  assert.equal(released.released, true);
  const recoveredReady = await call("captain_merge_prep", { ...args, merge_id: ready.merge_id });
  assert.equal(recoveredReady.state, "ready"); assert.equal(recoveredReady.revision, ready.revision);
  await call("captain_merge_back", { merge_id: ready.merge_id, session_id: "another-session" }, true);
  await call("captain_merge_finish", { merge_id: ready.merge_id, session_id: "another-session" }, true);
  const merged = await call("captain_merge_finish", { merge_id: ready.merge_id, session_id });
  assert.equal(merged.state, "merged");
  assert.equal(await git(target, "rev-parse", "HEAD"), await git(source, "rev-parse", "HEAD"));
  assert.equal((await call("captain_merge_back", { merge_id: ready.merge_id, session_id })).state, "merged");
  assert.equal((await call("captain_merge_finish", { merge_id: ready.merge_id, session_id })).state, "merged");
  assert.equal(await readFile(path.join(source, "Temp", "gates.log"), "utf8"), "build\n");
  // The same entrypoint also pulls a newly divergent target and resumes its audited source commit.
  await writeFile(path.join(source, "task.txt"), "later task\n");
  await git(source, "add", "task.txt");
  await git(source, "commit", "-m", "fix(test): later source");
  await writeFile(path.join(target, "target.txt"), "later target\n");
  await git(target, "add", "target.txt");
  await git(target, "commit", "-m", "fix(test): later target");
  const pinnedTarget = await git(target, "rev-parse", "HEAD");
  const pending = await call("captain_merge_begin", args);
  assert.equal(pending.state, "needs_commit");
  assert.equal(await git(source, "rev-parse", "MERGE_HEAD"), pinnedTarget);
  await call("captain_merge_back", { merge_id: pending.merge_id, session_id }, true);
  await call("captain_merge_finish", { merge_id: pending.merge_id, session_id }, true);
  await writeFile(path.join(source, "VERSION"), "1.0.1\n");
  await writeFile(path.join(source, "CHANGELOG.md"), "fixture baseline\nprepared target merge\n");
  const resumed = await call("captain_merge_prep", { ...args, merge_id: pending.merge_id, commit: { paths: ["target.txt", "VERSION", "CHANGELOG.md"], subject: "chore(merge): prepare target" } });
  assert.equal(resumed.state, "ready");
  assert.equal(await git(target, "rev-parse", "HEAD"), pinnedTarget);
  assert.equal(await readFile(path.join(source, "Temp", "gates.log"), "utf8"), "build\nbuild\n");
  const secondMerged = await call("captain_merge_back", { merge_id: resumed.merge_id, session_id });
  assert.equal(secondMerged.state, "merged");
  assert.equal((await call("captain_merge_finish", { merge_id: resumed.merge_id, session_id })).state, "merged");
  assert.equal(await git(target, "rev-parse", "HEAD"), resumed.ready_inputs.source.head);
  assert.equal(await readFile(path.join(source, "Temp", "gates.log"), "utf8"), "build\nbuild\n");
  await mkdir(evidenceRoot, { recursive: true });
  const proof = { schema_version: 1, smoke: "mcp-merge-aliases", status: "green", created_at: new Date().toISOString(), plugin_root: pluginRoot, fixture: run, advertised_tools: tools.filter(name => /merge|commit/.test(name)), merge_ids: [ready.merge_id, resumed.merge_id], original_target: originalTarget, first_integrated_head: merged.integrated_head, second_prep_target_unchanged: pinnedTarget, second_integrated_head: secondMerged.integrated_head, alias_schema_equal: true, gates_run: 2, captain_green: false };
  await writeFile(path.join(evidenceRoot, "merge-mcp-smoke.json"), JSON.stringify(proof, null, 2) + "\n");
  process.stdout.write(`Captain MCP Merge Prep/Back: green (${pluginRoot})\n`);
} finally { await client.close(); }
