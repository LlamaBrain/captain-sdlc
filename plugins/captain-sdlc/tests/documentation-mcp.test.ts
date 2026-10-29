import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { git } from "../src/workspace.js";

test("public MCP documentation preparation authorizes a clean task without fabricated red evidence", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "captain-documentation-mcp-")), data = await mkdtemp(path.join(tmpdir(), "captain-documentation-mcp-state-"));
  await git(["init"], root); await git(["config", "user.name", "Captain Test"], root); await git(["config", "user.email", "captain@example.invalid"], root);
  await mkdir(path.join(root, ".captain-sdlc"));
  await writeFile(path.join(root, ".captain-sdlc", "codex-policy.json"), JSON.stringify({ profile: "feature", visualRequired: false, commands: { build: "node gate.cjs", ticket: "node gate.cjs", "feature-smoke": "node gate.cjs", "affected-regression": "node gate.cjs" } }));
  await writeFile(path.join(root, ".gitignore"), ".captain-sdlc/worktrees/\n");
  await writeFile(path.join(root, "README.md"), "# Operator documentation\n"); await writeFile(path.join(root, "gate.cjs"), "console.log('trusted passing verification');\n");
  await git(["add", "."], root); await git(["commit", "-m", "baseline"], root);
  const pluginRoot = fileURLToPath(new URL("../", import.meta.url));
  // The SDK transport sets windowsHide on its child process; avoid a visible shell launcher.
  const transport = new StdioClientTransport({ command: process.execPath, args: ["--import", "tsx", "src/server.ts"], cwd: pluginRoot, stderr: "pipe", env: { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string")), CAPTAIN_PLUGIN_DATA: data, CODEX_PLUGIN_ROOT: pluginRoot, PLUGIN_ROOT: pluginRoot } });
  const client = new Client({ name: "captain-documentation-public-test", version: "1" });
  t.after(() => client.close()); await client.connect(transport);
  assert.ok((await client.listTools()).tools.some(tool => tool.name === "captain_prepare_documentation"));
  const call = async (name: string, args: Record<string, unknown>, expectError = false): Promise<any> => {
    const result = await client.callTool({ name, arguments: args });
    if (expectError) { assert.equal(result.isError, true); return result; }
    assert.notEqual(result.isError, true, JSON.stringify(result));
    return result.structuredContent ?? JSON.parse((result.content as any[]).find(item => item.type === "text").text);
  };
  const issued = await call("captain_issue_intent", { session_id: "documentation-mcp", turn_id: "start", project_root: root, prompt: "Update operator documentation", task_id: "DOCS-MCP", action: "start" });
  const begun = await call("captain_begin_implementation", { intent_id: issued.intent_id, objective: "Update operator documentation", project_root: root, task_id: "DOCS-MCP" });
  assert.equal(begun.schemaVersion, 1);
  const args = { intent_id: issued.intent_id, paths: ["README.md"], reason: "Documentation-only operator guidance", expected_head: begun.baseHead };
  await call("captain_prepare_documentation", { ...args, expected_head: "f".repeat(40) }, true);
  const prepared = await call("captain_prepare_documentation", args);
  assert.equal(prepared.schemaVersion, 2); assert.equal(prepared.documentationScope.schemaVersion, 1);
  assert.equal(prepared.phase, "implement"); assert.deepEqual(prepared.documentationScope.paths, ["README.md"]);
  assert.deepEqual(prepared.policy, begun.policy); assert.equal(prepared.runId, begun.runId); assert.equal(prepared.worktreePath, begun.worktreePath);
  assert.equal(prepared.evidence.some((item: any) => item.kind === "tdd_red"), false);
  const replay = await call("captain_prepare_documentation", args); assert.equal(replay.revision, prepared.revision);
  await writeFile(path.join(prepared.worktreePath, "README.md"), "# Revised operator documentation\n");
  const status = await call("captain_status", { intent_id: issued.intent_id });
  assert.equal(status.phase, "implement"); assert.deepEqual(status.documentationScope, prepared.documentationScope);
});
