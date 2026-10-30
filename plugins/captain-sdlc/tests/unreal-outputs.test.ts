import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { loadPolicy, sourceState } from "../src/workspace.js";
import { prepareScopeOutputs } from "../src/output-retention.js";

const exec = promisify(execFile);
const git = async (root: string, ...args: string[]) => (await exec("git", args, { cwd: root, windowsHide: true })).stdout.trim();
const generatedRoots = ["Binaries", "Intermediate", "Saved", "DerivedDataCache", "Plugins/Ath/Binaries", "Plugins/Ath/Intermediate", "Plugins/GameFeatures/Example/Binaries", "Plugins/GameFeatures/Example/Intermediate"];

async function fixture(t: TestContext, exclusions: string[] = generatedRoots) {
  const root = await mkdtemp(path.join(tmpdir(), "captain-unreal-output-"));
  t.after(async () => {
    assert.equal(path.dirname(root), path.resolve(tmpdir()));
    assert.ok(path.basename(root).startsWith("captain-unreal-output-"));
    await rm(root, { recursive: true, force: true });
  });
  await git(root, "init");
  await git(root, "config", "user.name", "Captain Test");
  await git(root, "config", "user.email", "captain@example.invalid");
  await git(root, "config", "core.autocrlf", "false");
  await mkdir(path.join(root, ".captain-sdlc"));
  await mkdir(path.join(root, "Source"));
  await mkdir(path.join(root, "Content"));
  await mkdir(path.join(root, "Plugins/Ath/Source"), { recursive: true });
  await mkdir(path.join(root, "Plugins/GameFeatures/Example/Source"), { recursive: true });
  await mkdir(path.join(root, "IgnoredInputs"));
  await writeFile(path.join(root, ".gitignore"), "/Binaries/\n/Intermediate/\n/Saved/\n/DerivedDataCache/\n/Plugins/**/Binaries/\n/Plugins/**/Intermediate/\n/IgnoredInputs/\n");
  await writeFile(path.join(root, "Game.uproject"), JSON.stringify({ FileVersion: 3, EngineAssociation: "5.8", Modules: [] }));
  await writeFile(path.join(root, "Plugins/Ath/Ath.uplugin"), JSON.stringify({ FileVersion: 3, Version: 1, VersionName: "1.0", Modules: [] }));
  await writeFile(path.join(root, "Plugins/GameFeatures/Example/Example.uplugin"), JSON.stringify({ FileVersion: 3, Version: 1, VersionName: "1.0", Modules: [] }));
  await writeFile(path.join(root, "Source/Game.cpp"), "game source\n");
  await writeFile(path.join(root, "Content/Map.umap"), "game asset\n");
  await writeFile(path.join(root, "Plugins/Ath/Source/Plugin.cpp"), "plugin source\n");
  await writeFile(path.join(root, "Plugins/GameFeatures/Example/Source/Feature.cpp"), "feature source\n");
  await writeFile(path.join(root, "IgnoredInputs/build-input.txt"), "first input\n");
  const policy = { profile: "feature", visualRequired: false, sourceManifestExcludes: exclusions,
    commands: { build: "build", ticket: "ticket", "feature-smoke": "smoke", "affected-regression": "regression" } };
  await writeFile(path.join(root, ".captain-sdlc/codex-policy.json"), JSON.stringify(policy));
  await git(root, "add", ".");
  await git(root, "commit", "-m", "unreal fixture");
  return { root, head: await git(root, "rev-parse", "HEAD"), policy };
}

test("trusted Unreal exclusions ignore only selected generated roots while binding project and plugin inputs", async t => {
  const { root, head } = await fixture(t);
  const policy = await loadPolicy(root, head);
  assert.deepEqual(policy.sourceManifestExcludes, generatedRoots);
  const baseline = await sourceState(root, policy);
  for (const relative of generatedRoots) {
    await mkdir(path.join(root, relative), { recursive: true });
    await writeFile(path.join(root, relative, "generated.bin"), "generated\n");
  }
  const built = await sourceState(root, policy);
  assert.equal(built.status, "");
  assert.equal(built.manifest, baseline.manifest, "Unreal build and runtime output should not change source proof");
  for (const relative of ["Source/Game.cpp", "Content/Map.umap", "Plugins/Ath/Source/Plugin.cpp", "Plugins/GameFeatures/Example/Source/Feature.cpp", "IgnoredInputs/build-input.txt"]) {
    const original = relative.startsWith("Source/") ? "game source\n" : relative.startsWith("Content/") ? "game asset\n" : relative.startsWith("Plugins/Ath/") ? "plugin source\n" : relative.startsWith("Plugins/GameFeatures/") ? "feature source\n" : "first input\n";
    await writeFile(path.join(root, relative), "changed\n");
    const changed = await sourceState(root, policy);
    assert.notEqual(changed.manifest, baseline.manifest, `${relative} must remain bound`);
    await writeFile(path.join(root, relative), original);
  }
  await prepareScopeOutputs(root, policy, "build");
  await access(path.join(root, "Saved/generated.bin"));
});

test("Unreal-generated roots remain bound unless the trusted policy explicitly excludes them", async t => {
  const { root, head } = await fixture(t, []);
  const policy = await loadPolicy(root, head);
  const before = await sourceState(root, policy);
  await mkdir(path.join(root, "Binaries"));
  await writeFile(path.join(root, "Binaries/generated.bin"), "new output\n");
  assert.notEqual((await sourceState(root, policy)).manifest, before.manifest);
});

test("ignored installed plugins may exclude generated files while binding their descriptor and source", async t => {
  const { root } = await fixture(t);
  await git(root, "rm", "-r", "--cached", "--", "Plugins/Ath");
  const ignore = path.join(root, ".gitignore");
  await writeFile(ignore, (await readFile(ignore, "utf8")) + "/Plugins/Ath/\n");
  await git(root, "add", ".gitignore");
  await git(root, "commit", "-m", "fixture installed plugin");
  const head = await git(root, "rev-parse", "HEAD");
  const policy = await loadPolicy(root, head);
  const before = await sourceState(root, policy);
  assert.equal(before.status, "");
  await mkdir(path.join(root, "Plugins/Ath/Binaries"), { recursive: true });
  await writeFile(path.join(root, "Plugins/Ath/Binaries/generated.bin"), "generated\n");
  assert.equal((await sourceState(root, policy)).manifest, before.manifest);
  for (const relative of ["Plugins/Ath/Ath.uplugin", "Plugins/Ath/Source/Plugin.cpp"]) {
    const file = path.join(root, relative), original = await readFile(file);
    await writeFile(file, "changed plugin input\n");
    assert.notEqual((await sourceState(root, policy)).manifest, before.manifest, `${relative} must remain bound`);
    await writeFile(file, original);
  }
  await writeFile(path.join(root, "Plugins/Ath/Ath.uplugin"), "not valid JSON");
  await assert.rejects(loadPolicy(root, head), /descriptor|JSON/i);
});

test("Unreal exclusions refuse authored directories, path escapes and unrelated binary directories", async t => {
  const { root, policy } = await fixture(t, []);
  for (const relative of ["Source", "Content", "Plugins/Ath", "Plugins/Ath/Source", "Source/Binaries", "Plugins/Ath/Source/Binaries", "Plugins/Ath/DerivedDataCache", "Plugins/Ath/Binaries/../Source", "../Binaries"]) {
    await writeFile(path.join(root, ".captain-sdlc/codex-policy.json"), JSON.stringify({ ...policy, sourceManifestExcludes: [relative] }));
    await git(root, "add", ".captain-sdlc/codex-policy.json");
    await git(root, "commit", "-m", "invalid exclusion fixture");
    await assert.rejects(loadPolicy(root, await git(root, "rev-parse", "HEAD")), /approved|relative|path|tracked/i, relative);
  }
});

test("Unreal exclusions reject tracked project or plugin files under each generated-looking root", async t => {
  for (const [relative, file] of [["Binaries", "owned.cpp"], ["Intermediate", "owned.asset"], ["Saved", "owned.umap"], ["DerivedDataCache", "owned.uasset"], ["Plugins/Ath/Binaries", "owned.cpp"], ["Plugins/Ath/Intermediate", "owned.uasset"], ["Plugins/GameFeatures/Example/Binaries", "owned.cpp"]]) {
    const { root } = await fixture(t);
    const tracked = `${relative}/${file}`;
    await mkdir(path.join(root, relative), { recursive: true });
    await writeFile(path.join(root, tracked), "tracked input\n");
    await git(root, "add", "-f", "--", tracked);
    await git(root, "commit", "-m", "track authored input");
    await assert.rejects(loadPolicy(root, await git(root, "rev-parse", "HEAD")), /tracked base files/i, tracked);
  }
});

test("DerivedDataCache is opt-in and binds newly staged assets", async t => {
  const { root, head } = await fixture(t, ["DerivedDataCache"]);
  const policy = await loadPolicy(root, head);
  const before = await sourceState(root, policy);
  await mkdir(path.join(root, "DerivedDataCache"));
  await writeFile(path.join(root, "DerivedDataCache/cache.bin"), "generated cache\n");
  assert.equal((await sourceState(root, policy)).manifest, before.manifest);
  await writeFile(path.join(root, "DerivedDataCache/new.uasset"), "new authored asset\n");
  await git(root, "add", "-f", "--", "DerivedDataCache/new.uasset");
  let after: Awaited<ReturnType<typeof sourceState>>;
  try { after = await sourceState(root, policy); }
  catch (error) { assert.match(String(error), /tracked|excluded|source/i); return; }
  assert.notEqual(after.status, "");
  assert.notEqual(after.manifest, before.manifest);
});

test("DerivedDataCache exclusion rejects a junction to outside content", async t => {
  const { root, head } = await fixture(t, ["DerivedDataCache"]);
  const policy = await loadPolicy(root, head);
  const outside = await mkdtemp(path.join(tmpdir(), "captain-unreal-outside-"));
  t.after(async () => {
    assert.equal(path.dirname(outside), path.resolve(tmpdir()));
    assert.ok(path.basename(outside).startsWith("captain-unreal-outside-"));
    await rm(outside, { recursive: true, force: true });
  });
  await writeFile(path.join(outside, "owned.txt"), "outside input\n");
  await symlink(outside, path.join(root, "DerivedDataCache"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(sourceState(root, policy), /reparse|symlink|link/i);
  await access(path.join(outside, "owned.txt"));
});

test("an authored file staged in an excluded Unreal directory after capture cannot disappear from proof", async t => {
  const { root, head } = await fixture(t);
  const policy = await loadPolicy(root, head);
  const before = await sourceState(root, policy);
  await mkdir(path.join(root, "Binaries"));
  await writeFile(path.join(root, "Binaries/new-input.cpp"), "new source\n");
  await git(root, "add", "-f", "--", "Binaries/new-input.cpp");
  let after: Awaited<ReturnType<typeof sourceState>>;
  try { after = await sourceState(root, policy); }
  catch (error) { assert.match(String(error), /tracked|excluded|source/i); return; }
  assert.notEqual(after.status, "", "the newly staged input must be dirty");
  assert.notEqual(after.manifest, before.manifest, "the newly staged input must be bound or rejected");
});

test("an excluded Unreal output root cannot be a link to files outside the project", async t => {
  const { root, head } = await fixture(t);
  const policy = await loadPolicy(root, head);
  const outside = await mkdtemp(path.join(tmpdir(), "captain-unreal-outside-"));
  t.after(async () => {
    assert.equal(path.dirname(outside), path.resolve(tmpdir()));
    assert.ok(path.basename(outside).startsWith("captain-unreal-outside-"));
    await rm(outside, { recursive: true, force: true });
  });
  await writeFile(path.join(outside, "owned.txt"), "outside input\n");
  await symlink(outside, path.join(root, "Binaries"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(sourceState(root, policy), /reparse|symlink|link/i);
  await access(path.join(outside, "owned.txt"));
});
