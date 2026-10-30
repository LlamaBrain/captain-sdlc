import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// Exercise the packaged MCP server with real Git LFS and a disposable repository.
// Only the fixture's branches are integrated; no caller project is modified.
const pluginRoot = path.resolve(process.argv[2] || path.join(import.meta.dirname, ".."));
const version = JSON.parse(await readFile(path.join(pluginRoot, "package.json"), "utf8")).version;
const run = await mkdtemp(path.join(tmpdir(), "captain-lfs-mcp-"));
const target = path.join(run, "game"), source = path.join(target, ".captain-sdlc", "worktrees", "task");
const gitEnv = { ...process.env };
for (const key of Object.keys(gitEnv)) if (/^GIT_/i.test(key)) delete gitEnv[key];
Object.assign(gitEnv, { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null", GIT_TERMINAL_PROMPT: "0" });
const exec = promisify(execFile);
const git = async (cwd, ...args) => (await exec("git", args, { cwd, env: gitEnv, windowsHide: true, timeout: 120000 })).stdout.trim();
await mkdir(target);
await git(target, "init", "-b", "main");
await git(target, "config", "user.name", "Captain LFS Smoke");
await git(target, "config", "user.email", "captain@example.invalid");
await git(target, "config", "core.autocrlf", "false");
await git(target, "config", "core.longpaths", "true");
await git(target, "lfs", "install", "--local");
await mkdir(path.join(target, ".captain-sdlc"));
await writeFile(path.join(target, ".captain-sdlc", "codex-policy.json"), JSON.stringify({
  profile: "low", visualRequired: false,
  commands: { build: "node gate.cjs", ticket: "node gate.cjs", "feature-smoke": "node gate.cjs", "affected-regression": "node gate.cjs" },
  commit: { conventional: true, require_version_suffix: false, require_task_trailer: false, version_file: "VERSION", version_surfaces: [], changelog_files: ["CHANGELOG.md"] }
}));
await writeFile(path.join(target, ".captain-sdlc", "merge-policy.json"), JSON.stringify({ schema_version: 1, strictness: "low" }));
await writeFile(path.join(target, ".gitignore"), ".captain-sdlc/worktrees/\n");
await writeFile(path.join(target, ".gitattributes"), "*.uasset filter=lfs diff=lfs merge=lfs -text\n");
await writeFile(path.join(target, "VERSION"), "1.0.0\n");
await writeFile(path.join(target, "CHANGELOG.md"), "# Changelog\n");
await writeFile(path.join(target, "gate.cjs"), "process.stdout.write('fixture gate passed\\n');\n");
await writeFile(path.join(target, "fixture.uasset"), Buffer.from("original game fixture\0"));
await git(target, "add", ".");
await git(target, "commit", "-m", "chore(test): create LFS fixture");
await git(target, "worktree", "add", "-b", "task", source);
const asset = Buffer.from("updated game fixture\0" + randomUUID());
await writeFile(path.join(source, "fixture.uasset"), asset);
await git(source, "add", "fixture.uasset");
await git(source, "commit", "-m", "fix(test): update LFS fixture");
const originalTarget = await git(target, "rev-parse", "HEAD");
const sourceHead = await git(source, "rev-parse", "HEAD");
const oid = createHash("sha256").update(asset).digest("hex");
const object = path.join(target, ".git", "lfs", "objects", oid.slice(0, 2), oid.slice(2, 4), oid);
const originalObject = await readFile(object);
await git(target, "config", "filter.lfs.process", "echo EXECUTED > hostile-marker; exit 1");
await git(target, "config", "filter.lfs.clean", "echo EXECUTED > hostile-marker; cat");
await git(target, "config", "merge.lfs.driver", "echo EXECUTED > hostile-marker; exit 1");

const authority = path.join(run, "authority");
const serverPath = path.join(pluginRoot, "dist", "server.js");
const serverHash = createHash("sha256").update(await readFile(serverPath)).digest("hex");
const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(pluginRoot, "dist", "server.js")], env: { ...process.env, CAPTAIN_PLUGIN_DATA: authority }, cwd: pluginRoot });
const client = new Client({ name: "captain-lfs-mcp-smoke", version: "1" });
let succeeded = false, evidence;
async function call(name, args) {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 600000 });
  assert.notEqual(result.isError, true, JSON.stringify(result));
  return result.structuredContent ?? JSON.parse(result.content.find(item => item.type === "text").text);
}
try {
  await client.connect(transport);
  assert.equal(client.getServerVersion()?.version, version);
  const session_id = "lfs-mcp-fixture", args = { source_worktree: source, target_worktree: target, target_branch: "main", session_id };
  const ready = await call("captain_merge_prep", args);
  assert.equal(ready.state, "ready");
  assert.equal(ready.receipt_valid, true);
  assert.equal(await git(target, "rev-parse", "HEAD"), originalTarget);
  assert.ok(ready.ready_inputs.lfs_objects.some(item => item.oid === oid && item.size === asset.length));
  await writeFile(object, Buffer.alloc(originalObject.length, 0x5a));
  const stale = await call("captain_merge_status", { merge_id: ready.merge_id, session_id });
  assert.equal(stale.receipt_valid, false);
  await writeFile(object, originalObject);
  const restored = await call("captain_merge_status", { merge_id: ready.merge_id, session_id });
  assert.equal(restored.receipt_valid, true);
  const merged = await call("captain_merge_back", { merge_id: ready.merge_id, session_id });
  assert.equal(merged.state, "merged");
  assert.equal(await git(target, "rev-parse", "HEAD"), sourceHead);
  assert.deepEqual(await readFile(path.join(target, "fixture.uasset")), asset);
  assert.equal(createHash("sha256").update(await readFile(serverPath)).digest("hex"), serverHash, "MCP server bundle changed during smoke");
  for (const root of [source, target]) {
    await assert.rejects(readFile(path.join(root, "hostile-marker")), { code: "ENOENT" });
  }
  evidence = {
    schema_version: 1, smoke: "mcp-lfs", status: "green", created_at: new Date().toISOString(),
    plugin_version: version, server_sha256: serverHash,
    fixture_retained: false, merge_id: ready.merge_id, source_head: sourceHead, original_target: originalTarget,
    lfs_oid: oid, corrupted_object_invalidated_receipt: true, hostile_drivers_executed: false
  };
  succeeded = true;
} finally {
  await client.close();
  if (succeeded) {
    if (path.resolve(path.dirname(run)) !== path.resolve(tmpdir()) || !path.basename(run).startsWith("captain-lfs-mcp-") || path.resolve(await realpath(run)) !== path.resolve(run)) throw new Error("refusing unsafe fixture cleanup");
    async function inspect(dir) {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const child = path.join(dir, entry.name), info = await lstat(child);
        if (info.isSymbolicLink()) throw new Error("refusing fixture cleanup through a reparse point");
        if (info.isDirectory()) await inspect(child);
      }
    }
    await inspect(run);
    await rm(run, { recursive: true });
  } else {
    process.stderr.write(`LFS smoke fixture retained for diagnosis: ${run}\n`);
  }
}
await mkdir(path.join(pluginRoot, ".captain-proof"), { recursive: true });
await writeFile(path.join(pluginRoot, ".captain-proof", "lfs-mcp-smoke.json"), JSON.stringify(evidence, null, 2) + "\n");
process.stdout.write("Captain MCP Git LFS smoke: green\n");
