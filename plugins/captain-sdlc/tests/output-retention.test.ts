import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { execFile } from "node:child_process";
import { access, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { commitEvidence, ensureWorktree, loadPolicy, sourceState } from "../src/workspace.js";
import { LifecycleStore } from "../src/lifecycle.js";

const exec = promisify(execFile);
const git = async (root: string, ...args: string[]) => (await exec("git", args, { cwd: root, windowsHide: true })).stdout.trim();
const retention = { schema_version: 1, roots: { build: ["Builds/active"], "feature-smoke": ["Artifacts/active-smoke"] } };
async function fixture(t: TestContext, outputRetention: unknown = retention) {
  const root = await mkdtemp(path.join(tmpdir(), "captain-output-retention-"));
  t.after(async () => {
    assert.equal(path.dirname(root), path.resolve(tmpdir()));
    assert.ok(path.basename(root).startsWith("captain-output-retention-"));
    await rm(root, { recursive: true, force: true });
  });
  await git(root, "init");
  await git(root, "config", "user.name", "Captain Test");
  await git(root, "config", "user.email", "captain@example.invalid");
  await git(root, "config", "core.autocrlf", "false");
  await mkdir(path.join(root, ".captain-sdlc"));
  await writeFile(path.join(root, ".gitignore"), "/Builds/\n/Artifacts/\n");
  await writeFile(path.join(root, "source.txt"), "authored source\n");
  await writeFile(path.join(root, "VERSION"), "1.0.0\n");
  await writeFile(path.join(root, "CHANGELOG.md"), "# Changelog\n");
  await writeFile(path.join(root, ".captain-sdlc/codex-policy.json"), JSON.stringify({ profile: "feature", visualRequired: false,
    commands: { build: "build", ticket: "ticket", "feature-smoke": "smoke", "affected-regression": "affected" },
    artifactPaths: { build: "Builds/active/player.exe", smoke: "Artifacts/active-smoke/result.json" },
    redGate: { expectedExitCodes: [1], outputPattern: "expected missing behavior" }, outputRetention }));
  await git(root, "add", "."); await git(root, "commit", "-m", "baseline");
  return { root, head: await git(root, "rev-parse", "HEAD") };
}

test("trusted policy captures fixed generic output roots for replace-in-place builds", async t => {
  const { root, head } = await fixture(t);
  const policy = await loadPolicy(root, head);
  assert.deepEqual((policy as any).outputRetention, retention);
  assert.equal(await readFile(path.join(root, "source.txt"), "utf8"), "authored source\n");
});

test("trusted policy rejects output roots that overlap source or Captain metadata", async t => {
  for (const relative of ["source.txt", ".captain-sdlc", ".git", "../outside", "/absolute", "Artifacts/worktrees", "Artifacts/.git/cache"]) {
    const { root, head } = await fixture(t, { schema_version: 1, roots: { build: [relative] } });
    await assert.rejects(loadPolicy(root, head), /output|retention|tracked|relative|protected/i, relative);
  }
});

test("rebuild replaces only its declared output slot and preserves source and siblings", async t => {
  const { prepareScopeOutputs } = await import("../src/output-retention.js");
  const { root, head } = await fixture(t), policy = await loadPolicy(root, head);
  await mkdir(path.join(root, "Builds/active/attempt-old"), { recursive: true });
  await mkdir(path.join(root, "Builds/unrelated"));
  await writeFile(path.join(root, "Builds/active/attempt-old/player.exe"), "old build");
  await writeFile(path.join(root, "Builds/unrelated/keep.txt"), "other output");
  const before = await sourceState(root, policy);
  await prepareScopeOutputs(root, policy, "build");
  await assert.rejects(access(path.join(root, "Builds/active/attempt-old/player.exe")), { code: "ENOENT" });
  await writeFile(path.join(root, "Builds/active/player.exe"), "current build");
  assert.equal((await sourceState(root, policy)).manifest, before.manifest, "generated output replacement must not invalidate source proof");
  await prepareScopeOutputs(root, policy, "build");
  await assert.rejects(access(path.join(root, "Builds/active/player.exe")), { code: "ENOENT" });
  assert.equal(await readFile(path.join(root, "Builds/unrelated/keep.txt"), "utf8"), "other output");
  assert.equal(await readFile(path.join(root, "source.txt"), "utf8"), "authored source\n");
});

test("generated root replacement preserves tracked build surfaces and their source hashes", async t => {
  const { prepareScopeOutputs } = await import("../src/output-retention.js");
  const { root } = await fixture(t);
  await mkdir(path.join(root, "Builds/active"), { recursive: true });
  await writeFile(path.join(root, "Builds/active/retained.txt"), "tracked\n");
  await git(root, "add", "-f", "Builds/active/retained.txt"); await git(root, "commit", "-m", "tracked generated surface");
  const policy = await loadPolicy(root, await git(root, "rev-parse", "HEAD"));
  await writeFile(path.join(root, "Builds/active/stale.exe"), "stale build");
  const before = await sourceState(root, policy);
  await prepareScopeOutputs(root, policy, "build");
  assert.equal(await readFile(path.join(root, "Builds/active/retained.txt"), "utf8"), "tracked\n");
  await assert.rejects(access(path.join(root, "Builds/active/stale.exe")), { code: "ENOENT" });
  assert.equal((await sourceState(root, policy)).manifest, before.manifest);
  await writeFile(path.join(root, "Builds/active/retained.txt"), "changed\n");
  assert.notEqual((await sourceState(root, policy)).manifest, before.manifest);
});

test("files staged after policy capture remain protected from output replacement", async t => {
  const { prepareScopeOutputs } = await import("../src/output-retention.js");
  const { root, head } = await fixture(t), policy = await loadPolicy(root, head);
  await mkdir(path.join(root, "Builds/active"), { recursive: true });
  await writeFile(path.join(root, "Builds/active/newly-staged.txt"), "new owned source");
  await writeFile(path.join(root, "Builds/active/stale.exe"), "old payload");
  await git(root, "add", "-f", "Builds/active/newly-staged.txt");
  await prepareScopeOutputs(root, policy, "build");
  assert.equal(await readFile(path.join(root, "Builds/active/newly-staged.txt"), "utf8"), "new owned source");
  await assert.rejects(access(path.join(root, "Builds/active/stale.exe")), { code: "ENOENT" });
});

test("all output trees are checked for nested repositories before any files are removed", async t => {
  const { prepareScopeOutputs } = await import("../src/output-retention.js");
  const { root, head } = await fixture(t, { schema_version: 1, roots: { build: ["Builds/active", "Artifacts/active"] } });
  const policy = await loadPolicy(root, head);
  await mkdir(path.join(root, "Builds/active"), { recursive: true });
  await mkdir(path.join(root, "Artifacts/active/nested"), { recursive: true });
  await writeFile(path.join(root, "Builds/active/player.exe"), "must survive refusal");
  await writeFile(path.join(root, "Artifacts/active/nested/.git"), "gitdir: another-repository\n");
  await assert.rejects(prepareScopeOutputs(root, policy, "build"), /nested|repository|\.git/i);
  assert.equal(await readFile(path.join(root, "Builds/active/player.exe"), "utf8"), "must survive refusal");
});

test("output replacement refuses links and leaves the external payload intact", async t => {
  const { prepareScopeOutputs } = await import("../src/output-retention.js");
  const { root, head } = await fixture(t), policy = await loadPolicy(root, head);
  const outside = path.join(root, "external"); await mkdir(outside);
  await writeFile(path.join(outside, "keep.txt"), "external payload");
  await mkdir(path.join(root, "Builds"));
  await symlink(outside, path.join(root, "Builds/active"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(prepareScopeOutputs(root, policy, "build"), /reparse|symlink|link/i);
  assert.equal(await readFile(path.join(outside, "keep.txt"), "utf8"), "external payload");
});

test("output root cannot contain a registered worktree even when it is called artifacts", async t => {
  const { prepareScopeOutputs } = await import("../src/output-retention.js");
  const { root, head } = await fixture(t, { schema_version: 1, roots: { build: ["Artifacts"] } });
  const policy = await loadPolicy(root, head), nested = path.join(root, "Artifacts/task-checkout");
  await git(root, "worktree", "add", "-b", "nested-task", nested, head);
  await assert.rejects(prepareScopeOutputs(root, policy, "build"), /worktree|repository/i);
  assert.equal(await readFile(path.join(nested, "source.txt"), "utf8"), "authored source\n");
});

test("legacy captured policies without output retention do not acquire deletion behavior", async t => {
  const { prepareScopeOutputs } = await import("../src/output-retention.js");
  const { root } = await fixture(t);
  await mkdir(path.join(root, "Builds/active"), { recursive: true });
  await writeFile(path.join(root, "Builds/active/legacy.exe"), "legacy payload");
  await prepareScopeOutputs(root, { commands: { build: "build" } } as any, "build");
  assert.equal(await readFile(path.join(root, "Builds/active/legacy.exe"), "utf8"), "legacy payload");
});

test("missing image and video output files stay absent while their parent is prepared", async t => {
  const { prepareScopeOutputs } = await import("../src/output-retention.js");
  const { root } = await fixture(t);
  await writeFile(path.join(root, ".gitignore"), "/Builds/\n/Artifacts/\n/.captain-proof/\n");
  for (const extension of ["png", "jpg", "jpeg", "webp", "gif", "bmp", "tiff", "svg", "mp4", "webm", "mov", "avi", "mkv", "m4v"]) {
    const relative = `.captain-proof/visual.${extension}`, full = path.join(root, relative);
    const policy = { outputRetention: { schema_version: 1 as const, roots: { visual: [relative] } } };
    await prepareScopeOutputs(root, policy, "visual");
    assert.equal((await lstat(path.dirname(full))).isDirectory(), true);
    await assert.rejects(access(full), { code: "ENOENT" }, `${extension} must be a producer-owned file path, not a created directory`);
    await writeFile(full, `current ${extension} evidence`);
    await prepareScopeOutputs(root, policy, "visual");
    await assert.rejects(access(full), { code: "ENOENT" }, `${extension} must remain a file slot when replacing its prior output`);
    await writeFile(full, `rebuilt ${extension} evidence`);
    assert.equal(await readFile(full, "utf8"), `rebuilt ${extension} evidence`);
  }
});

test("dotted output directories remain directories instead of being inferred as files", async t => {
  const { prepareScopeOutputs } = await import("../src/output-retention.js");
  const { root } = await fixture(t);
  await writeFile(path.join(root, ".gitignore"), "/Builds/\n/Artifacts/\n/.captain-proof/\n");
  const relative = ".captain-proof/net8.0", full = path.join(root, relative);
  const policy = { outputRetention: { schema_version: 1 as const, roots: { build: [relative] } } };
  await prepareScopeOutputs(root, policy, "build");
  assert.equal((await lstat(full)).isDirectory(), true);
  await writeFile(path.join(full, "old-output.bin"), "obsolete output");
  await prepareScopeOutputs(root, policy, "build");
  assert.equal((await lstat(full)).isDirectory(), true);
  await assert.rejects(access(path.join(full, "old-output.bin")), { code: "ENOENT" });
});

test("new policies infer a single conventional build parent rather than retaining attempt folders", async t => {
  const { root } = await fixture(t);
  const policyPath = path.join(root, ".captain-sdlc/codex-policy.json"), raw = JSON.parse(await readFile(policyPath, "utf8"));
  delete raw.outputRetention;
  await writeFile(policyPath, JSON.stringify(raw)); await git(root, "add", "."); await git(root, "commit", "-m", "infer conventional build root");
  const policy = await loadPolicy(root, await git(root, "rev-parse", "HEAD"));
  assert.deepEqual(policy.outputRetention?.roots.build, ["Builds"]);
});

test("report-only build policies require an explicit disposable payload root", async t => {
  const { root } = await fixture(t);
  const policyPath = path.join(root, ".captain-sdlc/codex-policy.json"), raw = JSON.parse(await readFile(policyPath, "utf8"));
  delete raw.outputRetention;
  raw.artifactPaths.build = "Artifacts/build-report.json";
  await writeFile(path.join(root, ".gitignore"), "/Artifacts/\n");
  await writeFile(policyPath, JSON.stringify(raw)); await git(root, "add", "."); await git(root, "commit", "-m", "report without bounded payload");
  await assert.rejects(loadPolicy(root, await git(root, "rev-parse", "HEAD")), /outputRetention\.roots\.build|payload root/);
});

test("an explicit report file cannot masquerade as the replaceable build payload", async t => {
  const { root, head } = await fixture(t, { schema_version: 1, roots: { build: ["Artifacts/build-report.json"] } });
  await assert.rejects(loadPolicy(root, head), /payload root/);
});

test("dirty or local ignore rules cannot grant new output deletion roots", async t => {
  const { root } = await fixture(t);
  const policyPath = path.join(root, ".captain-sdlc/codex-policy.json"), raw = JSON.parse(await readFile(policyPath, "utf8"));
  delete raw.outputRetention; raw.artifactPaths.build = "Artifacts/build-report.json";
  await writeFile(path.join(root, ".gitignore"), "/Artifacts/\n");
  await writeFile(policyPath, JSON.stringify(raw)); await git(root, "add", "."); await git(root, "commit", "-m", "trusted report-only policy");
  const head = await git(root, "rev-parse", "HEAD");
  await writeFile(path.join(root, ".gitignore"), "/Artifacts/\n/Builds/\n");
  await writeFile(path.join(root, ".git/info/exclude"), "/dist/\n");
  await assert.rejects(loadPolicy(root, head), /outputRetention\.roots\.build|payload root/);
});

test("iteration checks and final proof clear their output slots before the trusted command", async t => {
  const { root, head } = await fixture(t), workspace = await ensureWorktree(root, head, "output-proof");
  const policy = await loadPolicy(root, head), worktree = workspace.worktreePath, dataRoot = path.join(root, "authority");
  let ticketRed = true, buildInvoked = false, smokeInvocations = 0;
  const store = new LifecycleStore(dataRoot, async command => {
    if (command === "ticket" && ticketRed) { ticketRed = false; return { exitCode: 1, stdout: "expected missing behavior", stderr: "" }; }
    if (command === "build") {
      buildInvoked = true;
      await assert.rejects(access(path.join(worktree, "Builds/active/obsolete.exe")), { code: "ENOENT" });
      await writeFile(path.join(worktree, "Builds/active/player.exe"), "testable current build");
    }
    if (command === "smoke") {
      smokeInvocations++;
      await assert.rejects(access(path.join(worktree, "Artifacts/active-smoke/stale.json")), { code: "ENOENT" });
      await writeFile(path.join(worktree, "Artifacts/active-smoke/result.json"), JSON.stringify({ passed: true }));
    }
    return { exitCode: 0, stdout: command, stderr: "" };
  }, sourceState);
  await store.markIntent({ intentId: "output-proof", sessionId: "output-owner", turnId: "output-turn", projectRoot: root, prompt: "bound proof output" });
  await store.begin({ intentId: "output-proof", objective: "bound proof output", ...workspace, policy });
  await store.recordRed("output-proof");
  await mkdir(path.join(worktree, "Artifacts/active-smoke"), { recursive: true });
  await writeFile(path.join(worktree, "Artifacts/active-smoke/stale.json"), "stale iteration result");
  await store.runCheck("output-proof", "feature-smoke");
  await writeFile(path.join(worktree, "VERSION"), "1.0.1\n");
  await writeFile(path.join(worktree, "CHANGELOG.md"), "# Changelog\n\n- Bounded output (v1.0.1)\n");
  await git(worktree, "add", "VERSION", "CHANGELOG.md");
  await git(worktree, "commit", "-m", "fix(output): bound generated proof output (v1.0.1)");
  await store.recordCommit("output-proof", await commitEvidence(worktree, head, policy));
  await mkdir(path.join(worktree, "Builds/active"), { recursive: true });
  await writeFile(path.join(worktree, "Builds/active/obsolete.exe"), "obsolete payload");
  await writeFile(path.join(worktree, "Artifacts/active-smoke/stale.json"), "stale proof result");
  const proved = await store.prove("output-proof");
  assert.equal(proved.status, "green"); assert.equal(proved.phase, "complete");
  assert.equal(buildInvoked, true); assert.equal(smokeInvocations, 2);
});
