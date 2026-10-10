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

test("base MCP server publishes the guarded failed Begin cancellation capability", async () => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "captain-begin-cancel-red-"));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(pluginRoot, "dist", "server.js")],
    env: { ...process.env, CAPTAIN_PLUGIN_DATA: dataRoot },
    cwd: pluginRoot,
    stderr: "pipe",
  });
  const client = new Client({ name: "captain-begin-cancel-red", version: "1" });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    assert.ok(
      tools.some(tool => tool.name === "captain_cancel_failed_begin"),
      "the public SDK transport must advertise captain_cancel_failed_begin",
    );
  } finally {
    await client.close();
    assert.equal(path.dirname(dataRoot), path.resolve(tmpdir()));
    assert.ok(path.basename(dataRoot).startsWith("captain-begin-cancel-red-"));
    await rm(dataRoot, { recursive: true, force: true });
  }
});
