import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const pluginRoot = path.resolve(process.argv[2] ?? path.join(import.meta.dirname, ".."));
const version = JSON.parse(await readFile(path.join(pluginRoot, "package.json"), "utf8")).version;
const execute = promisify(execFile);
const git = async (cwd, ...args) => (await execute("git", args, { cwd, windowsHide: true })).stdout.trim();
// Keep Git's fixture metadata short even when this smoke runs from a deep task checkout.
let scratchRoot = path.join(tmpdir(), "captain-storage-mcp");
try {
  const common = await git(pluginRoot, "rev-parse", "--path-format=absolute", "--git-common-dir");
  if (path.basename(common).toLowerCase() === ".git") {
    const primary = path.dirname(common), relative = "Temp/automation-scratch/storage-mcp/";
    await git(primary, "check-ignore", "--quiet", "--", relative);
    const candidate = path.join(primary, relative);
    // Git's Windows GIT_DIR limit still applies with core.longpaths enabled.
    // Reserve room for fixture names, linked worktrees and their intent IDs.
    if (process.platform !== "win32" || candidate.length <= 120) scratchRoot = candidate;
  }
} catch { /* An installed runtime outside a Git checkout uses a disposable OS temp fixture. */ }
await mkdir(scratchRoot, { recursive: true });
const fixtureRoot = await mkdtemp(path.join(scratchRoot, "run-"));
const cli = async (...args) => JSON.parse((await execute(process.execPath, [path.join(pluginRoot, "scripts/worktree-storage.mjs"), ...args], { cwd: pluginRoot, windowsHide: true })).stdout);
const hash = content => createHash("sha256").update(content).digest("hex");
const absent = async file => assert.rejects(access(file), { code: "ENOENT" });
let client;

async function initialize(root, ignored) {
  await mkdir(root);
  await git(root, "init", "-b", "dev");
  await git(root, "config", "core.autocrlf", "false");
  await git(root, "config", "core.longpaths", "true");
  await git(root, "config", "user.name", "Captain Storage Smoke");
  await git(root, "config", "user.email", "captain@example.invalid");
  await writeFile(path.join(root, ".gitignore"), ignored);
}

async function archivedReport(result, relative, expected) {
  assert.ok(result.evidence_root, "cleanup returns its durable compact evidence root");
  const directories = await readdir(result.evidence_root);
  assert.equal(directories.length, 1, "this disposable fixture removed exactly one newly registered checkout");
  const report = await readFile(path.join(result.evidence_root, directories[0], relative), "utf8");
  assert.equal(report, expected, "retained report bytes survive removal of the source checkout");
  return hash(report);
}

try {
  const project = path.join(fixtureRoot, "mcp project");
  await initialize(project, "/out/\n/Artifacts/\n/.captain-sdlc/worktrees/\n");
  await mkdir(path.join(project, ".captain-sdlc"));
  await writeFile(path.join(project, ".captain-sdlc/codex-policy.json"), JSON.stringify({
    profile: "low", visualRequired: false,
    commands: { build: "node fixture-gate.cjs build", ticket: "node fixture-gate.cjs ticket", "feature-smoke": "node fixture-gate.cjs ticket", "affected-regression": "node fixture-gate.cjs ticket" },
    artifactPaths: { build: "Artifacts/build.json" },
    outputRetention: { schema_version: 1, roots: { build: ["out/active", "Artifacts/build.json"] } },
    redGate: { expectedExitCodes: [1], outputPattern: "expected missing storage behavior" },
    commit: { conventional: true, require_version_suffix: true, require_task_trailer: true, version_file: "VERSION",
      version_surfaces: [{ path: "VERSION", pattern: "(?m)^(?<version>[0-9]+\\.[0-9]+\\.[0-9]+)\\s*$" }], changelog_files: ["CHANGELOG.md"] }
  }));
  await writeFile(path.join(project, ".captain-sdlc/merge-policy.json"), JSON.stringify({ schema_version: 1, strictness: "low" }));
  await writeFile(path.join(project, "VERSION"), "1.0.0\n");
  await writeFile(path.join(project, "CHANGELOG.md"), "# Changelog\n");
  await writeFile(path.join(project, "task.txt"), "pending\n");
  await writeFile(path.join(project, "fixture-gate.cjs"), [
    "const fs = require('node:fs');",
    "if (process.argv[2] === 'ticket') { if (fs.readFileSync('task.txt', 'utf8').trim() !== 'implemented') { console.error('expected missing storage behavior'); process.exit(1); } console.log('ticket passes'); }",
    "else { fs.mkdirSync('out/active', {recursive:true}); if (fs.readdirSync('out/active').length) throw new Error('previous build was retained'); fs.writeFileSync('out/active/player.bin', 'current generic application payload'); fs.mkdirSync('Artifacts', {recursive:true}); fs.writeFileSync('Artifacts/build.json', JSON.stringify({schema_version:1, status:'passed', version:fs.readFileSync('VERSION','utf8').trim(), payload:'out/active/player.bin'})); console.log('generic build passes'); }"
  ].join("\n") + "\n");
  await git(project, "add", "."); await git(project, "commit", "-m", "chore(test): initialize generic storage fixture (v1.0.0)");
  const originalTarget = await git(project, "rev-parse", "HEAD");
  const env = { ...process.env, CAPTAIN_PLUGIN_DATA: path.join(fixtureRoot, "mcp-authority"), CODEX_PLUGIN_ROOT: pluginRoot, PLUGIN_ROOT: pluginRoot };
  // The SDK's stdio transport uses shell:false and windowsHide:true on Windows.
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(pluginRoot, "dist/server.js")], cwd: pluginRoot, env, stderr: "pipe" });
  client = new Client({ name: "captain-storage-lifecycle-smoke", version: "1" });
  await client.connect(transport);
  assert.equal(client.getServerVersion()?.version, version);
  const call = async (name, args) => {
    const response = await client.callTool({ name, arguments: args }, undefined, { timeout: 120000 });
    assert.notEqual(response.isError, true, `${name}: ${JSON.stringify(response)}`);
    return response.structuredContent ?? JSON.parse(response.content.find(item => item.type === "text").text);
  };
  const session_id = "storage-smoke-session", task_id = "storage-smoke";
  // These instructions authorize only this disposable fixture's simulated task.
  const issued = await call("captain_issue_intent", { session_id, turn_id: "storage-smoke-start", project_root: project, task_id, action: "start",
    prompt: "Implement the disposable storage smoke fixture.\ncommit\nmerge to dev" });
  const begun = await call("captain_begin_implementation", { intent_id: issued.intent_id, objective: "Implement the disposable storage smoke fixture", project_root: project, task_id });
  const source = begun.worktreePath;
  assert.equal(path.resolve(source), path.join(project, ".captain-sdlc/worktrees", issued.intent_id));
  assert.equal((await call("captain_record_red", { intent_id: issued.intent_id })).phase, "implement");
  await writeFile(path.join(source, "task.txt"), "implemented\n");
  await writeFile(path.join(source, "VERSION"), "1.0.1\n");
  await writeFile(path.join(source, "CHANGELOG.md"), "# Changelog\n\n- Bounded storage fixture (v1.0.1)\n");
  const committed = await call("captain_commit", { intent_id: issued.intent_id, paths: ["task.txt", "VERSION", "CHANGELOG.md"],
    subject: "fix(storage): bound generic fixture outputs (v1.0.1)", task_outcome: "Completes", final: true });
  const committedHead = committed.committedState.head;
  await mkdir(path.join(source, "out/active/obsolete-attempt"), { recursive: true });
  await writeFile(path.join(source, "out/active/obsolete-attempt/player.bin"), "obsolete application payload");
  const proved = await call("captain_prove", { intent_id: issued.intent_id });
  assert.equal(proved.status, "green"); assert.equal(proved.phase, "complete");
  await absent(path.join(source, "out/active/obsolete-attempt"));
  assert.equal(await readFile(path.join(source, "out/active/player.bin"), "utf8"), "current generic application payload");
  await writeFile(path.join(source, "out/active/obsolete-merge.bin"), "obsolete merge output");
  // Include the private sibling in Prep's source snapshot; Back must preserve its bytes.
  const privateFile = path.join(source, "out/private.txt");
  await writeFile(privateFile, "private fixture data outside the declared output slot");
  const prepared = await call("captain_merge_prep", { source_worktree: source, target_worktree: project, target_branch: "dev", session_id });
  assert.equal(prepared.state, "ready"); assert.equal(prepared.receipt_valid, true);
  assert.equal(await git(project, "rev-parse", "HEAD"), originalTarget);
  await absent(path.join(source, "out/active/obsolete-merge.bin"));
  const report = await readFile(path.join(source, "Artifacts/build.json"), "utf8");
  const retained = await call("captain_merge_back", { merge_id: prepared.merge_id, session_id });
  assert.equal(retained.state, "merged"); assert.equal(retained.integrated_head, committedHead);
  assert.equal(await git(project, "rev-parse", "HEAD"), committedHead, "integration succeeds even when private data prevents checkout removal");
  assert.deepEqual(retained.cleanup.removed_worktrees, []);
  assert.equal(retained.cleanup.retained_worktrees.length, 1);
  assert.equal(retained.cleanup.retained_worktrees[0].worktree, source);
  assert.match(retained.cleanup.retained_worktrees[0].reason, /unclassified ignored content.*out\/private\.txt/);
  assert.equal(await readFile(privateFile, "utf8"), "private fixture data outside the declared output slot");
  await access(path.join(source, "out/active/player.bin"));
  // Dispose only of the private file created by this fixture, then retry its same Back.
  await rm(privateFile);
  const merged = await call("captain_merge_back", { merge_id: prepared.merge_id, session_id });
  assert.equal(merged.state, "merged"); assert.equal(merged.integrated_head, committedHead);
  assert.deepEqual(merged.cleanup.removed_worktrees, [source]); assert.deepEqual(merged.cleanup.retained_worktrees, []);
  await absent(source); assert.equal(await git(project, "rev-parse", "HEAD"), committedHead);
  const retainedReportSha256 = await archivedReport(merged.cleanup, "Artifacts/build.json", report);
  const historical = await call("captain_merge_status", { merge_id: prepared.merge_id, session_id });
  assert.equal(historical.receipt_valid, true); assert.equal(historical.state, "merged");
  const implementation = await call("captain_status", { intent_id: issued.intent_id });
  assert.equal(implementation.phase, "complete"); assert.equal(implementation.status, "green");
  assert.equal((await call("captain_merge_back", { merge_id: prepared.merge_id, session_id })).state, "merged");

  const ordinary = path.join(fixtureRoot, "ordinary project");
  await initialize(ordinary, "/artifacts/\n**/bin/\n**/obj/\n/.captain-sdlc/worktrees/\n/.captain-sdlc/storage-authority/\n");
  await mkdir(path.join(ordinary, "src/App"), { recursive: true });
  await writeFile(path.join(ordinary, "src/App/App.csproj"), '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>\n');
  await writeFile(path.join(ordinary, "src/App/Program.cs"), "// baseline generic application\n");
  await git(ordinary, "add", "."); await git(ordinary, "commit", "-m", "chore(test): initialize ordinary storage fixture");
  const created = await cli("create", "--project", ordinary, "--task", "ordinary-storage-smoke");
  const checkout = created.worktree_path;
  const firstSlot = await cli("prepare-output", "--worktree", checkout, "--root", "artifacts/active");
  await mkdir(path.join(firstSlot.build_output_path, "old-attempt"));
  await writeFile(path.join(firstSlot.build_output_path, "old-attempt/Imba.exe"), "obsolete package fixture");
  for (const relative of ["src/App/bin/Release/net8.0", "src/App/obj"]) await mkdir(path.join(checkout, relative), { recursive: true });
  await writeFile(path.join(checkout, "src/App/bin/Release/net8.0/Imba.dll"), "reusable compilation fixture");
  await writeFile(path.join(checkout, "src/App/obj/project.assets.json"), "{}\n");
  const secondSlot = await cli("prepare-output", "--worktree", checkout, "--root", "artifacts/active");
  assert.equal(secondSlot.build_output_path, firstSlot.build_output_path);
  await absent(path.join(secondSlot.build_output_path, "old-attempt"));
  assert.equal(await readFile(path.join(checkout, "src/App/bin/Release/net8.0/Imba.dll"), "utf8"), "reusable compilation fixture");
  await assert.rejects(cli("prepare-output", "--worktree", checkout, "--root", "artifacts/another"), error => error.code === 1);
  await absent(path.join(checkout, "artifacts/another"));
  await writeFile(path.join(secondSlot.build_output_path, "Imba.exe"), "current package fixture");
  const ordinaryReport = JSON.stringify({ schema_version: 1, passed: true, output: "artifacts/active/Imba.exe" });
  await writeFile(path.join(checkout, "artifacts/build-report.json"), ordinaryReport);
  await writeFile(path.join(checkout, "src/App/Program.cs"), "// implemented generic application\n");
  await git(checkout, "add", "src/App/Program.cs"); await git(checkout, "commit", "-m", "fix(storage): implement ordinary fixture");
  const ordinaryHead = await git(checkout, "rev-parse", "HEAD");
  await git(ordinary, "merge", "--ff-only", created.branch);
  const cleaned = await cli("cleanup", "--source", checkout, "--target", ordinary, "--evidence", "artifacts/build-report.json");
  assert.deepEqual(cleaned.removed_worktrees, [checkout]); assert.deepEqual(cleaned.retained_worktrees, []);
  await absent(checkout); assert.equal(await git(ordinary, "rev-parse", "HEAD"), ordinaryHead);
  const ordinaryReportSha256 = await archivedReport(cleaned, "artifacts/build-report.json", ordinaryReport);
  assert.deepEqual((await cli("cleanup", "--source", checkout, "--target", ordinary)).removed_worktrees, [checkout]);

  const proof = { schema_version: 1, status: "green", created_at: new Date().toISOString(), plugin_version: version,
    server_sha256: hash(await readFile(path.join(pluginRoot, "dist/server.js"))),
    mcp: { implementation_green: true, prepared_target_unchanged: true, integrated_head: committedHead, explicit_output_root: "out/active", private_sibling_preserved: true, retained_then_retried: true, source_removed: true, retained_report_sha256: retainedReportSha256, historical_status_valid: true, replay_succeeded: true },
    ordinary: { enrolled: false, fixed_slot_replaced: true, alternate_slot_refused: true, integrated_head: ordinaryHead, source_and_bin_obj_removed: true, retained_report_sha256: ordinaryReportSha256, replay_succeeded: true },
    fixture_cleanup: "Disposable fixture repositories and their temporary authority are removed after verification." };
  const evidenceRoot = path.join(pluginRoot, ".captain-proof"); await mkdir(evidenceRoot, { recursive: true });
  await writeFile(path.join(evidenceRoot, "storage-mcp-smoke.json"), JSON.stringify(proof, null, 2) + "\n");
  let combined;
  try { combined = JSON.parse(await readFile(path.join(evidenceRoot, "smoke.json"), "utf8")); }
  catch (error) { if (error.code !== "ENOENT") throw error; combined = { schema_version: 1 }; }
  combined.storage = proof;
  await writeFile(path.join(evidenceRoot, "smoke.json"), JSON.stringify(combined, null, 2) + "\n");
  process.stdout.write(`Captain storage MCP and ordinary CLI smoke: green (${version})\n`);
} finally {
  try { await client?.close(); }
  finally {
    assert.equal(path.dirname(path.resolve(fixtureRoot)), path.resolve(scratchRoot));
    assert.ok(path.basename(fixtureRoot).startsWith("run-"));
    assert.equal((await lstat(fixtureRoot)).isSymbolicLink(), false);
    await rm(fixtureRoot, { recursive: true, force: true });
  }
}
