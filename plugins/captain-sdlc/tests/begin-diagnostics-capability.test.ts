import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const pluginRoot = path.resolve(
  process.env.CAPTAIN_TEST_PLUGIN_ROOT ?? path.resolve(import.meta.dirname, ".."),
);
const requireFromPlugin = createRequire(path.join(pluginRoot, "package.json"));
const sdkImport = async (specifier) => import(pathToFileURL(requireFromPlugin.resolve(specifier)).href);
const { Client } = await sdkImport("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = await sdkImport("@modelcontextprotocol/sdk/client/stdio.js");

test("base MCP server publishes the read-only Begin diagnostic capability", async () => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "captain-begin-diagnose-red-"));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(pluginRoot, "dist", "server.js")],
    env: { ...process.env, CAPTAIN_PLUGIN_DATA: dataRoot },
    cwd: pluginRoot,
    stderr: "pipe",
  });
  const client = new Client({ name: "captain-begin-diagnose-red", version: "1" });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    assert.ok(
      tools.some(tool => tool.name === "captain_begin_diagnose"),
      "the public SDK transport must advertise captain_begin_diagnose",
    );
  } finally {
    await client.close();
    assert.equal(path.dirname(dataRoot), path.resolve(tmpdir()));
    assert.ok(path.basename(dataRoot).startsWith("captain-begin-diagnose-red-"));
    await rm(dataRoot, { recursive: true, force: true });
  }
});
