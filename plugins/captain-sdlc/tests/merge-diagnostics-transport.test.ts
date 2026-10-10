import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { acquireAuthorizedLease, readAuthorized } from "../dist/authority.js";

const exec = promisify(execFile);
const pluginRoot = path.resolve(import.meta.dirname, "..");
const serverPath = path.join(pluginRoot, "dist", "server.js");
const git = async (cwd: string, ...args: string[]) =>
  (await exec("git", args, { cwd, windowsHide: true })).stdout.trim();

function objectKeysDeep(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(objectKeysDeep);
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value as Record<string, unknown>)
    .flatMap(([key, nested]) => [key, ...objectKeysDeep(nested)]);
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "captain-merge-diagnostics-"));
  const target = path.join(root, "target");
  const source = path.join(target, ".captain-sdlc", "worktrees", "task");
  const data = path.join(root, "authority");
  const sessionId = "merge-diagnostics-" + randomUUID();
  await mkdir(target, { recursive: true });
  await git(target, "init", "-b", "main");
  await git(target, "config", "core.autocrlf", "false");
  await git(target, "config", "core.longpaths", "true");
  await git(target, "config", "user.name", "Captain Diagnostic Fixture");
  await git(target, "config", "user.email", "captain@example.invalid");
  await mkdir(path.join(target, ".captain-sdlc"), { recursive: true });
  await writeFile(path.join(target, ".captain-sdlc", "codex-policy.json"), JSON.stringify({
    profile: "low",
    visualRequired: false,
    commands: { build: "node fixture-gate.cjs", ticket: "node fixture-gate.cjs", "feature-smoke": "node fixture-gate.cjs", "affected-regression": "node fixture-gate.cjs" },
    sourceManifestExcludes: ["Temp"],
    commit: {
      conventional: true,
      require_version_suffix: false,
      require_task_trailer: false,
      version_file: "VERSION",
      version_surfaces: [],
      changelog_files: ["CHANGELOG.md"],
    },
  }));
  await writeFile(path.join(target, ".captain-sdlc", "merge-policy.json"), JSON.stringify({
    schema_version: 1,
    strictness: "low",
  }));
  await writeFile(path.join(target, ".gitignore"), "Temp/\n.captain-sdlc/worktrees/\n");
  await writeFile(path.join(target, "VERSION"), "1.0.0\n");
  await writeFile(path.join(target, "CHANGELOG.md"), "fixture baseline\n");
  await writeFile(path.join(target, "fixture-gate.cjs"), "process.exit(0);\n");
  await git(target, "add", ".");
  await git(target, "commit", "-m", "chore(test): diagnostic baseline");
  await git(target, "worktree", "add", "-b", "task", source);
  await writeFile(path.join(source, "task.txt"), "prepared task\n");
  await git(source, "add", "task.txt");
  await git(source, "commit", "-m", "fix(test): diagnostic task");

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    env: { CAPTAIN_PLUGIN_DATA: data },
    cwd: pluginRoot,
    stderr: "pipe",
  });
  const client = new Client({ name: "captain-merge-diagnostics-transport-test", version: "1" });
  await client.connect(transport);
  return {
    root,
    target,
    source,
    data,
    sessionId,
    args: {
      session_id: sessionId,
      source_worktree: source,
      target_worktree: target,
      target_branch: "main",
    },
    client,
  };
}

async function closeFixture(f: Fixture) {
  await f.client.close();
  await rm(f.root, { recursive: true, force: true });
}

function requireTool(tools: Array<{ name: string; inputSchema: Record<string, any> }>, name: string) {
  const tool = tools.find(candidate => candidate.name === name);
  assert.ok(tool, "public MCP server must advertise " + name);
  return tool;
}

async function persistedMergeRecords(data: string) {
  let names: string[];
  try {
    names = await readdir(path.join(data, "merge-revisions"));
  } catch (error: any) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  return Promise.all(names.filter(name => /\.json$/.test(name)).map(async name => ({
    name,
    payload: await readAuthorized<any>(data, "merge-revisions", name.slice(0, -5)),
  })));
}

async function authoritySnapshot(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  async function visit(directory: string, prefix: string) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error: any) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(directory, entry.name);
      const relative = path.posix.join(prefix, entry.name);
      if (entry.isDirectory()) await visit(absolute, relative);
      else if (entry.isFile()) {
        result[relative] = createHash("sha256").update(await readFile(absolute)).digest("hex");
      }
    }
  }
  await visit(root, "");
  return result;
}

async function gitSnapshot(f: Fixture) {
  return {
    sourceHead: await git(f.source, "rev-parse", "HEAD"),
    sourceBranch: await git(f.source, "branch", "--show-current"),
    targetHead: await git(f.target, "rev-parse", "HEAD"),
    targetBranch: await git(f.target, "branch", "--show-current"),
    mainHead: await git(f.target, "rev-parse", "refs/heads/main"),
  };
}

async function reserveForeignTargetLease(f: Fixture) {
  const commonGitDir = await git(f.target, "rev-parse", "--path-format=absolute", "--git-common-dir");
  const targetOid = await git(f.target, "rev-parse", "refs/heads/main");
  const leaseId = createHash("sha256")
    .update((path.resolve(commonGitDir) + "\0refs/heads/main").toLowerCase())
    .digest("hex");
  const foreignSession = "foreign-session-secret-" + randomUUID();
  const leaseToken = "foreign-token-secret-" + randomUUID();
  const intentId = "foreign-merge-" + randomUUID();
  await acquireAuthorizedLease(f.data, leaseId, {
    intentId,
    leaseToken,
    sessionId: foreignSession,
    operation: "integration-branch",
    commonGitDir,
    targetBranch: "main",
    targetOid,
    ownerPid: 1,
    ownerHost: "foreign-host.invalid",
  });
  return { foreignSession, leaseToken, intentId };
}

test("public MCP advertises the bound merge diagnosis schema", async () => {
  const f = await fixture();
  try {
    const tools = (await f.client.listTools()).tools as Array<{ name: string; inputSchema: Record<string, any> }>;
    const diagnose = requireTool(tools, "captain_merge_diagnose");
    for (const name of ["session_id", "source_worktree", "target_worktree", "target_branch"]) {
      assert.equal(diagnose.inputSchema.properties?.[name]?.type, "string", name + " is a public string binding");
      assert.ok(diagnose.inputSchema.required?.includes(name), name + " is required for exact diagnosis binding");
    }
  } finally {
    await closeFixture(f);
  }
});

test("initial prep conflict preserves its persisted merge id and same-session status step", async () => {
  const f = await fixture();
  try {
    await reserveForeignTargetLease(f);
    const reply = await f.client.callTool({ name: "captain_merge_prep", arguments: f.args });
    assert.equal(reply.isError, true, "the held target branch must block Merge Prep");
    const persisted = await persistedMergeRecords(f.data);
    assert.equal(persisted.length, 1, "the failed first attempt must have persisted one signed operation: " + JSON.stringify(reply));
    const record = persisted[0].payload;
    assert.equal(record.session_id, f.sessionId);
    assert.equal(record.source_worktree, path.resolve(f.source));
    assert.equal(record.target_worktree, path.resolve(f.target));

    const error = reply.structuredContent as Record<string, any>;
    assert.match(error.error, /target branch is already leased by another Captain operation/i, "the public failure must identify the actual target-branch lease conflict");
    assert.equal(error.merge_id, record.merge_id, "initial failure must return the operation actually written before lease conflict");
    assert.equal(error.next_step?.tool, "captain_merge_status");
    assert.deepEqual(error.next_step?.arguments, {
      merge_id: record.merge_id,
      session_id: f.sessionId,
    });
  } finally {
    await closeFixture(f);
  }
});

test("diagnosis returns the existing operation and sanitized foreign lease without changing authority or Git", async () => {
  const f = await fixture();
  try {
    const foreign = await reserveForeignTargetLease(f);
    const prep = await f.client.callTool({ name: "captain_merge_prep", arguments: f.args });
    assert.equal(prep.isError, true);
    const persistedBefore = await persistedMergeRecords(f.data);
    assert.equal(persistedBefore.length, 1, JSON.stringify(prep));
    const mergeId = persistedBefore[0].payload.merge_id;
    const authorityBefore = await authoritySnapshot(f.data);
    const gitBefore = await gitSnapshot(f);

    const tools = (await f.client.listTools()).tools as Array<{ name: string; inputSchema: Record<string, any> }>;
    requireTool(tools, "captain_merge_diagnose");
    const diagnosis = await f.client.callTool({ name: "captain_merge_diagnose", arguments: f.args });
    assert.notEqual(diagnosis.isError, true, JSON.stringify(diagnosis));
    const value = (diagnosis.structuredContent ?? JSON.parse(diagnosis.content.find(item => item.type === "text")!.text)) as Record<string, any>;

    assert.equal(value.read_only, true);
    assert.equal(value.captain_green, false);
    assert.equal(value.operations.length, 1, "diagnosis must return the existing matching operation without allocating another one");
    const operation = value.operations.find((item: Record<string, any>) => item.merge_id === mergeId);
    assert.ok(operation);
    assert.equal(operation.revision, persistedBefore[0].payload.revision);
    assert.equal(operation.state, persistedBefore[0].payload.state);
    assert.equal(operation.source_worktree, path.resolve(f.source));
    assert.equal(operation.target_worktree, path.resolve(f.target));
    assert.equal(operation.target_branch, "main");
    assert.equal(operation.source_head, gitBefore.sourceHead);
    assert.equal(operation.target_head, gitBefore.targetHead);

    const targetLease = value.target_lease as Record<string, any>;
    assert.ok(targetLease, "diagnosis must expose the held target lease owner needed to understand the conflict");
    assert.equal(targetLease.state, "held");
    assert.equal(targetLease.intent_id, foreign.intentId);
    assert.equal(targetLease.operation, "integration-branch");
    assert.equal(targetLease.session_match, "other");
    assert.equal(targetLease.owner?.state, "foreign_host");
    assert.deepEqual(Object.keys(targetLease).sort(), ["intent_id", "operation", "owner", "session_match", "state"].sort());

    const encoded = JSON.stringify(value);
    assert.equal(encoded.includes(foreign.foreignSession), false, "diagnosis must not return a foreign raw session id");
    assert.equal(encoded.includes(foreign.leaseToken), false, "diagnosis must not return a lease token");
    const keys = objectKeysDeep(value).map(key => key.toLowerCase());
    for (const forbidden of ["leasetoken", "lease_token", "sessionid", "session_id", "recovery", "next_tool", "confirm_owner_stopped", "transfer"]) {
      assert.equal(keys.includes(forbidden), false, "diagnosis must not expose " + forbidden);
    }
    assert.equal(encoded.includes("captain_recover_merge_lease"), false);

    const afterPersisted = await persistedMergeRecords(f.data);
    assert.deepEqual(afterPersisted.map(item => item.name).sort(), persistedBefore.map(item => item.name).sort());
    assert.deepEqual(await authoritySnapshot(f.data), authorityBefore, "diagnosis must not write authority records or watermarks");
    assert.deepEqual(await gitSnapshot(f), gitBefore, "diagnosis must leave all observed refs and worktree identities unchanged");
  } finally {
    await closeFixture(f);
  }
});

test("pre-persistence validation failure exposes no merge id or status continuation", async () => {
  const f = await fixture();
  try {
    const before = await persistedMergeRecords(f.data);
    const reply = await f.client.callTool({
      name: "captain_merge_prep",
      arguments: { ...f.args, source_worktree: f.target },
    });
    assert.equal(reply.isError, true);
    const error = (reply.structuredContent ?? {}) as Record<string, any>;
    assert.equal(error.merge_id, undefined, "validation before the signed initial checkpoint must not invent an operation id");
    assert.equal(error.next_step, undefined, "there is no persisted operation to inspect after pre-validation failure");
    assert.equal((await persistedMergeRecords(f.data)).length, before.length);
  } finally {
    await closeFixture(f);
  }
});
