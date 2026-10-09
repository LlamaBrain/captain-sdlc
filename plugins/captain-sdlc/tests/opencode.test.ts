import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

test("OpenCode adapter issues a signed intent, injects begin guidance, and blocks pre-begin mutation", async () => {
  const data = await mkdtemp(path.join(tmpdir(), "captain-opencode-data-")), project = await mkdtemp(path.join(tmpdir(), "captain-opencode-project-"));
  process.env.CAPTAIN_PLUGIN_DATA = data;
  const { CaptainSdlc } = await import(`../opencode/captain-sdlc.mjs?test=${Date.now()}`);
  const hooks = await CaptainSdlc({ directory: project });
  await hooks["chat.message"]({ sessionID: "opencode-session", messageID: "turn-1" }, { message: {}, parts: [{ type: "text", text: "Implement the portable handoff command." }] });
  const system = { system: [] as string[] }; await hooks["experimental.chat.system.transform"]({ sessionID: "opencode-session", model: {} }, system);
  assert.match(system.system.join("\n"), /captain_begin_implementation/);
  await assert.rejects(() => hooks["tool.execute.before"]({ tool: "apply_patch", sessionID: "opencode-session", callID: "call-1" }, { args: {} }), /mutation denied/);
});
