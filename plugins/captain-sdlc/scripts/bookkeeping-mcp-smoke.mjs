import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const root = path.resolve(process.argv[2] ?? path.join(import.meta.dirname, ".."));
const run = await mkdtemp(path.join(tmpdir(), "captain-bookkeeping-mcp-"));
const target = path.join(run, "project with spaces"), source = path.join(run, "task with spaces");
const exec = promisify(execFile);
const git = async (cwd, ...args) => (await exec("git", args, { cwd, windowsHide: true })).stdout.trim();
await mkdir(path.join(target, ".captain-sdlc/notebook"), { recursive: true });
await git(target, "init", "-b", "main"); await git(target, "config", "core.autocrlf", "false");
await git(target, "config", "user.name", "Captain Fixture"); await git(target, "config", "user.email", "captain@example.invalid");
const commands = Object.fromEntries(["build", "ticket", "feature-smoke", "affected-regression"].map(scope => [scope, "node gate.cjs"]));
await writeFile(path.join(target, ".captain-sdlc/codex-policy.json"), JSON.stringify({ profile: "low", visualRequired: false, commands,
  commit: { conventional: true, require_version_suffix: false, require_task_trailer: true, version_file: "VERSION", version_surfaces: [],
    changelog_files: ["CHANGELOG.md"], bookkeeping: { path_file: ".captain-sdlc/captain.ignore" } }, sourceManifestExcludes: ["Temp"] }));
await writeFile(path.join(target, ".captain-sdlc/captain.ignore"), "# Still tracked by Git\n/.captain-sdlc/notebook/\n");
await writeFile(path.join(target, ".captain-sdlc/notebook/notes.json"), "{}\n");
await writeFile(path.join(target, "VERSION"), "1.0.0\n"); await writeFile(path.join(target, "CHANGELOG.md"), "baseline\n");
await writeFile(path.join(target, ".gitignore"), "Temp/\n");
await writeFile(path.join(target, "gate.cjs"), "const fs=require('node:fs');fs.mkdirSync('Temp',{recursive:true});const p='Temp/build-count';fs.writeFileSync(p,String(Number(fs.existsSync(p)?fs.readFileSync(p,'utf8'):0)+1));console.log('build passed');\n");
await git(target, "add", "."); await git(target, "commit", "-m", "fixture baseline"); await git(target, "worktree", "add", "-b", "task", source);
await writeFile(path.join(source, "product.txt"), "implemented\n"); await git(source, "add", "product.txt"); await git(source, "commit", "-m", "fixture product change");
const env = { ...process.env, CAPTAIN_PLUGIN_DATA: path.join(run, "authority"), CODEX_PLUGIN_ROOT: root, PLUGIN_ROOT: root };
const client = new Client({ name: "captain-bookkeeping-smoke", version: "1" });
const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, "dist/server.js")], cwd: root, env, stderr: "pipe" });
const outcomes = [];
async function call(name, args, expectError = false) {
  const response = await client.callTool({ name, arguments: args }, undefined, { timeout: 600000 });
  if (expectError) { assert.equal(response.isError, true); return response; }
  assert.notEqual(response.isError, true, JSON.stringify(response));
  return response.structuredContent ?? JSON.parse(response.content.find(item => item.type === "text").text);
}
try {
  await client.connect(transport);
  const tools = (await client.listTools()).tools.map(tool => tool.name);
  assert.ok(tools.includes("captain_finalize_bookkeeping")); assert.ok(tools.includes("captain_bookkeeping_status"));
  const notePath = ".captain-sdlc/notebook/notes.json";
  await writeFile(path.join(source, notePath), '{"completed":true}\n');
  const committed = await call("captain_finalize_bookkeeping", { worktree: source, session_id: "smoke", task_id: "records",
    paths: [notePath], subject: "docs(captain): retain completion record", disposition: "commit" });
  assert.equal(committed.state, "committed"); assert.equal(await readFile(path.join(source, "VERSION"), "utf8"), "1.0.0\n");
  assert.equal((await call("captain_bookkeeping_status", { finalization_id: committed.finalization_id, session_id: "smoke", worktree: source })).commit_oid, committed.commit_oid);
  outcomes.push("public version-neutral record commit and independent signed status");
  const prep = await call("captain_merge_prep", { source_worktree: source, target_worktree: target, target_branch: "main", session_id: "smoke" });
  assert.equal(prep.state, "ready"); const tested = prep.ready_inputs.source.head;
  await writeFile(path.join(source, notePath), '{"merge":"source"}\n'); await writeFile(path.join(target, notePath), '{"merge":"target"}\n');
  const selection = { paths: [notePath], subject: "docs(captain): retain merge records", task_id: "records", disposition: "commit" };
  const back = await call("captain_merge_back", { merge_id: prep.merge_id, session_id: "smoke", finalization: {
    source: selection, target: { ...selection, disposition: "stash" } } });
  assert.equal(back.state, "merged"); assert.equal(back.ready_inputs.source.head, tested);
  assert.notEqual(back.integration_inputs.source.head, tested); assert.equal(await git(target, "rev-parse", "HEAD"), back.integration_inputs.source.head);
  assert.equal(await readFile(path.join(source, "Temp/build-count"), "utf8"), "1"); assert.equal(await git(target, "status", "--porcelain"), "");
  const parked = back.finalizations.find(receipt => receipt.state === "stashed");
  assert.equal(await git(target, "show", `${parked.stash_oid}:${notePath}`), '{"merge":"target"}');
  assert.ok((await git(target, "stash", "list", "--format=%H")).split(/\r?\n/).includes(parked.stash_oid));
  outcomes.push("Back finalizes both sides, retains tested revision/build once and exact stash");
  await writeFile(path.join(target, notePath), '{"new":true}\n'); await writeFile(path.join(target, "product.txt"), "new product work\n");
  const refused = await call("captain_finalize_bookkeeping", { worktree: target, session_id: "smoke", task_id: "records", paths: [notePath, "product.txt"],
    subject: "docs(captain): mixed change", disposition: "stash", finalization_id: "mixed-refusal" }, true);
  assert.equal(refused.structuredContent.finalization_id, "mixed-refusal");
  assert.equal(refused.structuredContent.next_step.tool, "captain_bookkeeping_status");
  assert.equal(await readFile(path.join(target, "product.txt"), "utf8"), "new product work\n");
  outcomes.push("mixed product paths refused with public recovery selector and preserved bytes");
  const proofPath = path.join(root, ".captain-proof/smoke.json"), proof = JSON.parse(await readFile(proofPath, "utf8"));
  proof.bookkeeping = { status: "green", created_at: new Date().toISOString(), server_sha256: createHash("sha256").update(await readFile(path.join(root, "dist/server.js"))).digest("hex"), outcomes, fixture: run };
  await writeFile(proofPath, JSON.stringify(proof, null, 2) + "\n"); console.log(JSON.stringify(proof.bookkeeping));
} finally { await client.close(); }
