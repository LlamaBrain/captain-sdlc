import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
const data = await mkdtemp(path.join(tmpdir(), "captain-mcp-smoke-"));
const root = path.resolve(import.meta.dirname, "..");
const declaration = JSON.parse(await readFile(path.join(root, ".mcp.json"), "utf8")).mcpServers["captain-sdlc"];
const env = { ...process.env, CODEX_HOME: data, CODEX_PLUGIN_ROOT: root };
delete env.CAPTAIN_PLUGIN_DATA;
delete env.CODEX_PLUGIN_DATA;
delete env.PLUGIN_DATA;
delete env.PLUGIN_ROOT;
delete env.CLAUDE_PLUGIN_ROOT;
const child = spawn(declaration.command, declaration.args, { env, stdio: ["pipe", "pipe", "inherit"] });
const request = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "captain-smoke", version: "1" } } };
child.stdin.write(JSON.stringify(request) + "\n");
const timeout = setTimeout(() => { child.kill(); throw new Error("MCP initialize timed out"); }, 5000);
for await (const chunk of child.stdout) { if (chunk.toString().includes('"result"')) { clearTimeout(timeout); child.kill(); const proofDir = path.resolve(import.meta.dirname, "..", ".captain-proof"); await mkdir(proofDir, { recursive: true }); await writeFile(path.join(proofDir, "smoke.json"), JSON.stringify({ schema_version: 1, smoke: "mcp-initialize", status: "green", created_at: new Date().toISOString() }, null, 2)); process.stdout.write("captain MCP initialize: green\n"); break; } }
