import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("public MCP exposes immutable ticket selector and session interruption controls", async () => {
  const data = await mkdtemp(path.join(tmpdir(), "captain-session-transport-"));
  const client = new Client({ name: "captain-task-session-contract", version: "1" });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [path.resolve(import.meta.dirname, "../dist/server.js")],
    env: { ...process.env, CAPTAIN_PLUGIN_DATA: data }, stderr: "pipe" });
  try {
    await client.connect(transport);
    const listed = (await client.listTools()).tools;
    for (const name of ["captain_record_red", "captain_run_check"]) {
      const tool = listed.find(item => item.name === name);
      assert.ok(tool);
      assert.equal((tool.inputSchema.properties as any).ticket_filter.type, "string");
      assert.ok(!tool.inputSchema.required?.includes("ticket_filter"));
    }
    for (const name of ["captain_bind_session_owner", "captain_session_interruption_status", "captain_recover_interrupted_session", "captain_record_session_closed"]) {
      assert.ok(listed.some(item => item.name === name), `missing public control ${name}`);
    }
  } finally { await client.close(); }
});

import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
const exec = promisify(execFile);

test("public MCP selects focused red and resumes the exact task after verified client exit", { skip: process.platform !== "win32", timeout: 90000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "captain-task-client-"));
  const project = path.join(root, "project");
  await mkdir(path.join(project, ".captain-sdlc"), { recursive: true });
  await mkdir(path.join(project, "Tools"));
  const git = (...args: string[]) => exec("git", args, { cwd: project, windowsHide: true });
  await git("init", "-b", "main");
  await git("config", "user.name", "Captain Contract Fixture");
  await git("config", "user.email", "captain@example.invalid");
  await git("config", "core.longpaths", "true");
  await writeFile(path.join(project, ".gitignore"), ".captain-sdlc/worktrees/\n");
  const ticket = "powershell.exe -NoProfile -File Tools/Ticket.ps1 -TestFilter Baseline.Ui";
  await writeFile(path.join(project, ".captain-sdlc", "codex-policy.json"), JSON.stringify({ profile: "low", visualRequired: false,
    commands: { ticket, build: "node build.cjs", "feature-smoke": "node smoke.cjs", "affected-regression": "node regress.cjs" },
    redGate: { expectedExitCodes: [1], outputPattern: "CAPTAIN_TICKET_RED: Task.Focused" } }));
  await writeFile(path.join(project, "Tools", "Ticket.ps1"), 'param([string]$TestFilter)\nif ($TestFilter -eq "Task.Focused") { Write-Output "CAPTAIN_TICKET_RED: Task.Focused"; exit 1 }; exit 0\n');
  await git("add", "."); await git("commit", "-m", "test: client contract fixture");
  const clientProcess = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { windowsHide: true, stdio: "ignore" });
  await once(clientProcess, "spawn");
  const token = randomUUID();
  const client = new Client({ name: "captain-client-contract", version: "1" });
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.resolve(import.meta.dirname, "../dist/server.js")],
    env: { ...process.env, CAPTAIN_PLUGIN_DATA: path.join(root, "authority") }, stderr: "pipe" });
  async function call(name: string, args: Record<string, unknown>) {
    const result = await client.callTool({ name, arguments: args });
    assert.ok(!result.isError, JSON.stringify(result));
    return result.structuredContent ?? JSON.parse((result.content as any)[0].text);
  }
  try {
    await client.connect(transport);
    const issued = await call("captain_issue_intent", { action: "start", session_id: "client-before", turn_id: "start", project_root: project, task_id: "retained-client-task", prompt: "Implement the client contract" });
    const original = await call("captain_begin_implementation", { intent_id: issued.intent_id, project_root: project, objective: "Retain the client contract", task_id: "retained-client-task",
      client_pid: clientProcess.pid, close_token_hash: createHash("sha256").update(token).digest("hex") });
    const red = await call("captain_record_red", { intent_id: original.intentId, ticket_filter: "Task.Focused" });
    assert.equal(red.phase, "implement"); assert.equal(red.taskTicket.filter, "Task.Focused"); assert.equal(red.policy.commands.ticket, ticket);
    await writeFile(path.join(original.worktreePath, "unfinished.txt"), "unfinished task retained\n");
    const live = await call("captain_session_interruption_status", { intent_id: original.intentId, session_id: "client-before" });
    assert.equal(live.owner.state, "live"); assert.equal(live.canRecover, false); assert.ok(!JSON.stringify(live).includes(token));
    const exited = once(clientProcess, "exit"); clientProcess.kill(); await exited;
    const resumeIntent = await call("captain_issue_intent", { action: "resume", session_id: "client-after", turn_id: "reopen", project_root: project, task_id: "retained-client-task", prompt: "Resume after reopening this client" });
    const resumed = await call("captain_resume_implementation", { resume_intent_id: resumeIntent.intent_id });
    assert.equal(resumed.runId, original.runId); assert.equal(resumed.worktreePath, original.worktreePath); assert.equal(resumed.branch, original.branch);
    assert.equal(resumed.phase, "implement"); assert.deepEqual(resumed.taskTicket, red.taskTicket); assert.deepEqual(resumed.policy, red.policy);
    assert.ok(resumed.evidence.some((item: any) => item.kind === "session_interruption")); assert.ok(resumed.evidence.some((item: any) => item.kind === "tdd_red"));
    assert.equal(await readFile(path.join(resumed.worktreePath, "unfinished.txt"), "utf8"), "unfinished task retained\n");
  } finally {
    await client.close();
    if (clientProcess.exitCode === null && clientProcess.signalCode === null) { const exited = once(clientProcess, "exit"); clientProcess.kill(); await exited; }
  }
});
