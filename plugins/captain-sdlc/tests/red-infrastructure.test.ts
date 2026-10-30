import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { LifecycleStore, type GateResult, type StateProbe } from "../src/lifecycle.js";
import { gateRunner } from "../src/workspace.js";

async function fixture(t: TestContext, result: GateResult) {
  const root = await mkdtemp(path.join(tmpdir(), "captain-red-infrastructure-")), data = path.join(root, "authority"), worktree = path.join(root, ".captain-sdlc", "worktrees", "red");
  t.after(async () => { assert.equal(path.dirname(root), path.resolve(tmpdir())); assert.ok(path.basename(root).startsWith("captain-red-infrastructure-")); await rm(root, { recursive: true, force: true }); });
  await mkdir(worktree, { recursive: true });
  const head = "a".repeat(40), branch = "captain/red", commonGitDir = path.join(root, ".git"), gitDir = path.join(commonGitDir, "worktrees", "red");
  const probe: StateProbe = async () => ({ head, tree: "b".repeat(40), status: "", branch, branchHead: head, commonGitDir, topLevel: worktree, gitDir });
  const store = new LifecycleStore(data, async () => result, probe);
  const policy = { profile: "feature" as const, visualRequired: false, commands: { build: "build", ticket: "ticket", "feature-smoke": "smoke", "affected-regression": "regression" }, redGate: { expectedExitCodes: [1], outputPattern: "fail [1-9][0-9]*" } };
  await store.markIntent({ intentId: "red", sessionId: "session", turnId: "turn", projectRoot: root, prompt: "fix red gate" });
  await store.begin({ intentId: "red", objective: "fix red gate", projectRoot: root, worktreePath: worktree, baseHead: head, branch, commonGitDir, gitDir, policy });
  return store;
}

for (const [name, output] of [
  ["esbuild loader ENOENT", "TAP version 13\n# Error: The service is no longer running: spawn C:\\deep\\esbuild.exe ENOENT\nnot ok 1 - test loader\n# fail 60\n"],
  ["Node module loader failure", "TAP version 13\n# Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'tsx' imported from C:/test.mjs\nnot ok 1 - loader\n# fail 1\n"],
  ["test process spawn failure", "Error: spawn node ENOENT\n# fail 1\n"],
  ["npm executable or package failure", "npm error code ENOENT\n# fail 1\n"],
  ["late loader failure after bounded policy match", `# fail 1\n${"x".repeat(1024 * 1024 + 100)}\n# Error: The service is no longer running: spawn C:\\deep\\esbuild.exe ENOENT\n`],
] as const) {
  test(`red gate rejects ${name} despite a matching failure count`, async t => {
    const store = await fixture(t, { exitCode: 1, stdout: output, stderr: "" });
    await assert.rejects(() => store.recordRed("red"), /infrastructure/i);
    const run = await store.status("red");
    assert.equal(run.phase, "tdd_red");
    assert.equal(run.evidence.some(item => item.kind === "tdd_red"), false);
  });
}

test("red gate still accepts a behavioral assertion failure", async t => {
  const output = "TAP version 13\nnot ok 1 - fixture should increment\n  error: 'Expected values to be strictly equal: 0 !== 1'\n# fail 1\n";
  const store = await fixture(t, { exitCode: 1, stdout: output, stderr: "" });
  const run = await store.recordRed("red");
  assert.equal(run.phase, "implement");
  assert.equal(run.evidence.filter(item => item.kind === "tdd_red").length, 1);
});

test("red gate does not reject an assertion merely mentioning ENOENT", async t => {
  const output = "TAP version 13\nnot ok 1 - missing file handling\n  error: 'expected an ENOENT diagnostic'\n# fail 1\n";
  const store = await fixture(t, { exitCode: 1, stdout: output, stderr: "" });
  assert.equal((await store.recordRed("red")).phase, "implement");
});

test("real runner output overflow cannot masquerade as a red test", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "captain-red-overflow-"));
  t.after(async () => { assert.equal(path.dirname(root), path.resolve(tmpdir())); assert.ok(path.basename(root).startsWith("captain-red-overflow-")); await rm(root, { recursive: true, force: true }); });
  await writeFile(path.join(root, "overflow.cjs"), "process.stdout.write('fail 1\\n'); process.stdout.write('x'.repeat(11 * 1024 * 1024));\n");
  const result = await gateRunner("node overflow.cjs", root);
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /maxBuffer length exceeded/i);
  const store = await fixture(t, result);
  await assert.rejects(() => store.recordRed("red"), /infrastructure/i);
  assert.equal((await store.status("red")).phase, "tdd_red");
});
