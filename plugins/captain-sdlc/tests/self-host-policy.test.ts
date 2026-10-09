import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LifecycleStore } from "../src/lifecycle.js";
import { captainBegin, captainIssueIntent } from "../src/server.js";
import { git } from "../src/workspace.js";

test("the shipped Captain policy can begin and record a failing ticket without manual bootstrap repair", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "captain-self-host-"));
  const project = path.join(root, "project");
  await mkdir(path.join(project, ".captain-sdlc"), { recursive: true });
  const policyPath = fileURLToPath(new URL("../../../.captain-sdlc/codex-policy.json", import.meta.url));
  const shippedPolicy = await readFile(policyPath, "utf8");
  await writeFile(path.join(project, ".captain-sdlc", "codex-policy.json"), shippedPolicy);
  await writeFile(path.join(project, ".gitignore"), ".captain-sdlc/worktrees/\n");
  await git(["init", "-b", "main"], project);
  await git(["add", "."], project);
  await git(["-c", "user.name=Captain Fixture", "-c", "user.email=captain@example.invalid", "commit", "-m", "fixture shipped policy"], project);
  let ticketRuns = 0;
  const store = new LifecycleStore(path.join(root, "authority"), async command => {
    assert.equal(command, JSON.parse(shippedPolicy).commands.ticket);
    ticketRuns++;
    return { exitCode: 1, stdout: "# tests 1\n# pass 0\n# fail 1\n", stderr: "" };
  });
  const issued = await captainIssueIntent(store, {
    session_id: "self-host-policy", turn_id: "start", project_root: project,
    prompt: "implement the bounded ticket", action: "start",
  });
  const run = await captainBegin(store, { intent_id: issued.intent_id, project_root: project, objective: "bounded ticket" });
  assert.equal(run.phase, "tdd_red");
  const red = await store.recordRed(issued.intent_id);
  assert.equal(red.phase, "implement");
  assert.equal(ticketRuns, 1);
});
