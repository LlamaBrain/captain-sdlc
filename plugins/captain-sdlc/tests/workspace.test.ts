import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { execFile } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { abortMerge, applyPreparedCommit, commitAtomic, commitEvidence, ensureWorktree, loadPolicy, prepareMerge, reconcilePreparedCommit, reconcilePreparedMerge, repositoryIdentity, sourceState } from "../src/workspace.js";
const exec = promisify(execFile);
const runGit = (root: string, ...args: string[]) => exec("git", args, { cwd: root });
async function repo() { const root = await mkdtemp(path.join(tmpdir(), "captain-workspace-")); await exec("git", ["init"], { cwd: root }); await exec("git", ["config", "user.name", "Captain Test"], { cwd: root }); await exec("git", ["config", "user.email", "captain@example.invalid"], { cwd: root }); await mkdir(path.join(root, ".captain-sdlc")); await writeFile(path.join(root, ".captain-sdlc", "codex-policy.json"), JSON.stringify({ profile: "feature", visualRequired: false, commands: { build: "build", ticket: "trusted", "feature-smoke": "smoke", "affected-regression": "affected" } })); await exec("git", ["add", "."], { cwd: root }); await exec("git", ["commit", "-m", "baseline"], { cwd: root }); return root; }

const selfHostGeneratedRoots = ["plugins/captain-sdlc/bin", "plugins/captain-sdlc/Temp/automation-scratch", "plugins/captain-sdlc/.captain-proof"];
async function selfHostConfiguredRepo(t: TestContext) {
  const root = await repo();
  // Match the scrubbed production Git environment and retain referenced rule bytes.
  await runGit(root, "config", "core.autocrlf", "false");
  t.after(async () => {
    assert.equal(path.dirname(root), path.resolve(tmpdir()));
    assert.ok(path.basename(root).startsWith("captain-workspace-"));
    await rm(root, { recursive: true, force: true });
  });
  const sourceRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const shippedText = await readFile(path.join(sourceRoot, ".captain-sdlc/codex-policy.json"), "utf8");
  const shipped = JSON.parse(shippedText);
  await writeFile(path.join(root, ".captain-sdlc/codex-policy.json"), shippedText);
  let commitPolicy = shipped.commit;
  if (shipped.commitPolicyPath) {
    const text = await readFile(path.join(sourceRoot, shipped.commitPolicyPath), "utf8");
    await mkdir(path.dirname(path.join(root, shipped.commitPolicyPath)), { recursive: true });
    await writeFile(path.join(root, shipped.commitPolicyPath), text);
    commitPolicy = JSON.parse(text).commit;
  }
  if (commitPolicy?.bookkeeping?.path_file) {
    const relative = commitPolicy.bookkeeping.path_file;
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), await readFile(path.join(sourceRoot, relative)));
  }
  await writeFile(path.join(root, ".gitignore"), await readFile(path.join(sourceRoot, ".gitignore")));
  const retainedSource = "plugins/captain-sdlc/src/retained-contract.ts";
  await mkdir(path.dirname(path.join(root, retainedSource)), { recursive: true });
  await writeFile(path.join(root, retainedSource), "export const retainedContract = 1;\n");
  await runGit(root, "add", ".");
  await runGit(root, "commit", "-m", "fixture actual self-host generated paths");
  const baseHead = (await runGit(root, "rev-parse", "HEAD")).stdout.trim();
  return { root, baseHead, retainedSource };
}

test("shipped self-host policy keeps required ignored generated outputs out of its source manifest", async t => {
  const fixture = await selfHostConfiguredRepo(t);
  const policy = await loadPolicy(fixture.root, fixture.baseHead);
  const before = await sourceState(fixture.root, policy);
  for (const relative of selfHostGeneratedRoots) {
    await mkdir(path.join(fixture.root, relative), { recursive: true });
    await writeFile(path.join(fixture.root, relative, "generated-proof-fixture.json"), "generated output\n");
    await runGit(fixture.root, "check-ignore", "-q", "--", `${relative}/generated-proof-fixture.json`);
  }
  const after = await sourceState(fixture.root, policy);
  assert.equal(after.status, "", "these exact artifact writes must remain ignored by the shipped repository rules");
  assert.equal(after.manifest, before.manifest, "required self-host build/smoke/scratch outputs must not invalidate source proof");
  await writeFile(path.join(fixture.root, fixture.retainedSource), "export const retainedContract = 2;\n");
  assert.notEqual((await sourceState(fixture.root, policy)).manifest, before.manifest, "the surrounding plugin source must remain in the proof manifest");
});

test("shipped self-host generated exclusions refuse tracked authored files in each exact root", async t => {
  const fixture = await selfHostConfiguredRepo(t);
  for (const relative of selfHostGeneratedRoots) {
    const authored = path.join(relative, "authored-contract.txt").replaceAll("\\", "/");
    await mkdir(path.dirname(path.join(fixture.root, authored)), { recursive: true });
    await writeFile(path.join(fixture.root, authored), "tracked authored contract\n");
    await runGit(fixture.root, "add", "-f", "--", authored);
    await runGit(fixture.root, "commit", "-m", "fixture tracked authored file under " + relative);
    const head = (await runGit(fixture.root, "rev-parse", "HEAD")).stdout.trim();
    await assert.rejects(loadPolicy(fixture.root, head), /tracked base files and cannot be excluded/, "generated-path admission must retain the tracked-content refusal");
    await runGit(fixture.root, "rm", "--", authored);
    await runGit(fixture.root, "commit", "-m", "remove owned authored fixture");
  }
});

const repositoryCommitPolicy = {
  conventional: true,
  require_version_suffix: true,
  require_task_trailer: true,
  version_file: "VERSION",
  version_surfaces: [
    { path: "VERSION", pattern: "(?m)^(?<version>[0-9]+\\.[0-9]+\\.[0-9]+)\\s*$" },
    { path: "ProjectSettings/ProjectSettings.asset", pattern: "(?m)^\\s*bundleVersion:\\s*(?<version>[0-9]+\\.[0-9]+\\.[0-9]+)\\s*$" },
    { path: "doxygen/dirigible.Doxyfile", pattern: "(?m)^PROJECT_NUMBER\\s*=\\s*(?<version>[0-9]+\\.[0-9]+\\.[0-9]+)\\s*$" },
  ],
  changelog_files: ["Changelog/SPIKE_COLONY_CHANGELOG.md"],
};

async function governedRepo() {
  const root = await repo();
  await mkdir(path.join(root, "ProjectSettings")); await mkdir(path.join(root, "doxygen")); await mkdir(path.join(root, "Changelog"));
  await writeFile(path.join(root, ".captain-sdlc", "codex-policy.json"), JSON.stringify({ profile: "feature", visualRequired: false, commitPolicyPath: ".captain-sdlc/project-policy.json", commands: { build: "build", ticket: "trusted", "feature-smoke": "smoke", "affected-regression": "affected" } }));
  await writeFile(path.join(root, ".captain-sdlc", "project-policy.json"), JSON.stringify({ schema_version: 1, commit: repositoryCommitPolicy }));
  await writeFile(path.join(root, "VERSION"), "1.0.0\n");
  await writeFile(path.join(root, "ProjectSettings", "ProjectSettings.asset"), "bundleVersion: 1.0.0\n");
  await writeFile(path.join(root, "doxygen", "dirigible.Doxyfile"), "PROJECT_NUMBER = 1.0.0\n");
  await writeFile(path.join(root, "Changelog", "SPIKE_COLONY_CHANGELOG.md"), "# Changelog\n");
  await runGit(root, "add", "."); await runGit(root, "commit", "-m", "governed baseline");
  return root;
}

test("commit repairs stale parent companion versions using the configured canonical version", async () => {
  const root = await governedRepo();
  await writeFile(path.join(root, "doxygen", "dirigible.Doxyfile"), "PROJECT_NUMBER = 0.9.0\n");
  await runGit(root, "add", "doxygen/dirigible.Doxyfile"); await runGit(root, "commit", "-m", "stale documentation fixture");
  const base = (await runGit(root, "rev-parse", "HEAD")).stdout.trim();
  await writeFile(path.join(root, "VERSION"), "1.0.1\n");
  await writeFile(path.join(root, "ProjectSettings", "ProjectSettings.asset"), "bundleVersion: 1.0.1\n");
  await writeFile(path.join(root, "doxygen", "dirigible.Doxyfile"), "PROJECT_NUMBER = 1.0.1\n");
  await writeFile(path.join(root, "Changelog", "SPIKE_COLONY_CHANGELOG.md"), "# Changelog\n- Repair stale companion (v1.0.1)\n");
  await commitAtomic(root, ["VERSION", "ProjectSettings/ProjectSettings.asset", "doxygen/dirigible.Doxyfile", "Changelog/SPIKE_COLONY_CHANGELOG.md"], "fix(policy): repair stale companion (v1.0.1)", "Completes", "FOOD", repositoryCommitPolicy);
  const evidence = await commitEvidence(root, base, { commit: repositoryCommitPolicy } as any, "FOOD");
  assert.equal(evidence.phaseCommitsValid, true); assert.equal(evidence.versionSurfacesValid, true); assert.equal(evidence.clean, true);
});

test("trusted policy comes from captured base, not dirty working tree", async () => {
  const root = await repo(), identity = await repositoryIdentity(root); await writeFile(path.join(root, ".captain-sdlc", "codex-policy.json"), JSON.stringify({ commands: { ticket: "exit 0" } }));
  const policy = await loadPolicy(root, identity.baseHead); assert.equal(policy.commands.ticket, "trusted");
});

for (const defect of ["invalid-canonical-parent", "unsynchronized-candidate"]) {
  test(`stale companion recovery still rejects ${defect}`, async () => {
    const root = await governedRepo();
    await writeFile(path.join(root, "doxygen", "dirigible.Doxyfile"), "PROJECT_NUMBER = 0.9.0\n");
    if (defect === "invalid-canonical-parent") await writeFile(path.join(root, "VERSION"), "not-a-version\n");
    await runGit(root, "add", "VERSION", "doxygen/dirigible.Doxyfile"); await runGit(root, "commit", "-m", "invalid parent fixture");
    const parent = (await runGit(root, "rev-parse", "HEAD")).stdout.trim();
    await writeFile(path.join(root, "VERSION"), "1.0.1\n");
    await writeFile(path.join(root, "ProjectSettings", "ProjectSettings.asset"), "bundleVersion: 1.0.1\n");
    await writeFile(path.join(root, "doxygen", "dirigible.Doxyfile"), `PROJECT_NUMBER = ${defect === "unsynchronized-candidate" ? "0.9.0" : "1.0.1"}\n`);
    await writeFile(path.join(root, "Changelog", "SPIKE_COLONY_CHANGELOG.md"), "# Changelog\n- Candidate (v1.0.1)\n");
    await assert.rejects(() => commitAtomic(root, ["VERSION", "ProjectSettings/ProjectSettings.asset", "doxygen/dirigible.Doxyfile", "Changelog/SPIKE_COLONY_CHANGELOG.md"], "fix(policy): candidate (v1.0.1)", "Completes", "FOOD", repositoryCommitPolicy), /preflight/);
    assert.equal((await runGit(root, "rev-parse", "HEAD")).stdout.trim(), parent);
  });
}

test("Git children ignore repository and configuration redirection environment", async () => {
  const root = await repo(), hostile = await repo(), expectedHead = (await runGit(root, "rev-parse", "HEAD")).stdout.trim();
  const previous = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries({ GIT_DIR: path.join(hostile, ".git"), GIT_WORK_TREE: hostile, GIT_INDEX_FILE: path.join(hostile, ".git", "index"), GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.hooksPath", GIT_CONFIG_VALUE_0: hostile })) { previous.set(name, process.env[name]); process.env[name] = value; }
  try { const identity = await repositoryIdentity(root); assert.equal(identity.projectRoot, path.resolve(root)); assert.equal(identity.baseHead, expectedHead); }
  finally { for (const [name, value] of previous) if (value === undefined) delete process.env[name]; else process.env[name] = value; }
});

test("commit preflight rejects command-bearing clean-filter attributes before git add", async () => {
  const root = await governedRepo();
  await writeFile(path.join(root, ".gitattributes"), "*.txt filter=hostile\n"); await runGit(root, "add", ".gitattributes"); await runGit(root, "commit", "-m", "add hostile filter fixture");
  await runGit(root, "config", "filter.hostile.clean", "false"); await writeFile(path.join(root, "safe.txt"), "safe\n");
  await assert.rejects(() => commitAtomic(root, ["safe.txt"], "fix(policy): reject filters (v1.0.1)"), /clean filters/);
  assert.equal((await runGit(root, "diff", "--cached", "--name-only")).stdout.trim(), "");
});

test("Git children ignore GIT_ATTR_SOURCE attribute redirection", async () => {
  const root = await governedRepo(), primary = (await runGit(root, "branch", "--show-current")).stdout.trim();
  await runGit(root, "switch", "-c", "hostile-attribute-source"); await writeFile(path.join(root, ".gitattributes"), "*.txt filter=hostile\n"); await runGit(root, "add", ".gitattributes"); await runGit(root, "commit", "-m", "hostile attribute source");
  const hostileSource = (await runGit(root, "rev-parse", "HEAD")).stdout.trim(); await runGit(root, "switch", primary); await runGit(root, "config", "filter.hostile.clean", "false");
  await writeFile(path.join(root, "safe.txt"), "safe\n"); await writeFile(path.join(root, "VERSION"), "1.0.1\n"); await writeFile(path.join(root, "ProjectSettings", "ProjectSettings.asset"), "bundleVersion: 1.0.1\n"); await writeFile(path.join(root, "doxygen", "dirigible.Doxyfile"), "PROJECT_NUMBER = 1.0.1\n"); await writeFile(path.join(root, "Changelog", "SPIKE_COLONY_CHANGELOG.md"), "# Changelog\n- Ignore redirected attributes (v1.0.1)\n");
  const previous = process.env.GIT_ATTR_SOURCE; process.env.GIT_ATTR_SOURCE = hostileSource;
  try { await commitAtomic(root, ["safe.txt", "VERSION", "ProjectSettings/ProjectSettings.asset", "doxygen/dirigible.Doxyfile", "Changelog/SPIKE_COLONY_CHANGELOG.md"], "fix(policy): ignore redirected attributes (v1.0.1)", "Implements", "COLONY-SPIKE", repositoryCommitPolicy); }
  finally { if (previous === undefined) delete process.env.GIT_ATTR_SOURCE; else process.env.GIT_ATTR_SOURCE = previous; }
});

test("commit preflight rejects common-info and ignored worktree attribute bypasses", async () => {
  const root = await governedRepo(), infoAttributes = path.resolve(root, (await runGit(root, "rev-parse", "--git-path", "info/attributes")).stdout.trim());
  await mkdir(path.dirname(infoAttributes), { recursive: true }); await writeFile(infoAttributes, "*.txt filter=hostile\n"); await runGit(root, "config", "filter.hostile.clean", "false"); await runGit(root, "config", "filter.hostile.required", "true"); await writeFile(path.join(root, "safe.txt"), "safe\n");
  await assert.rejects(() => commitAtomic(root, ["safe.txt"], "fix(policy): reject info attributes (v1.0.1)"), /Git metadata attributes/);
  await unlink(infoAttributes); await mkdir(path.join(root, "nested")); await writeFile(path.join(root, ".gitignore"), "nested/.gitattributes\n"); await writeFile(path.join(root, "nested", ".gitattributes"), "*.txt filter=hostile\n"); await writeFile(path.join(root, "nested", "safe.txt"), "safe\n");
  await assert.rejects(() => commitAtomic(root, ["nested/safe.txt"], "fix(policy): reject ignored attributes (v1.0.1)"), /Git attributes/);
  assert.equal((await runGit(root, "diff", "--cached", "--name-only")).stdout.trim(), "");
});

test("merge preparation rejects command-bearing merge-driver attributes before git merge", async () => {
  const root = await governedRepo(), primary = (await runGit(root, "branch", "--show-current")).stdout.trim();
  await runGit(root, "switch", "-c", "hostile-topic"); await writeFile(path.join(root, ".gitattributes"), "*.txt merge=hostile\n"); await writeFile(path.join(root, "topic.txt"), "topic\n"); await runGit(root, "add", "."); await runGit(root, "commit", "-m", "hostile merge fixture");
  const target = (await runGit(root, "rev-parse", "HEAD")).stdout.trim(); await runGit(root, "switch", primary); await runGit(root, "config", "merge.hostile.driver", "false");
  await assert.rejects(() => prepareMerge(root, target), /merge drivers/);
  await assert.rejects(() => runGit(root, "rev-parse", "--verify", "MERGE_HEAD"));
});

test("legacy default commit policy remains usable without an external project policy", async () => {
  const root = await repo(); await writeFile(path.join(root, "VERSION"), "1.0.0\n"); await writeFile(path.join(root, "CHANGELOG.md"), "# Changelog\n"); await runGit(root, "add", "."); await runGit(root, "commit", "-m", "legacy version baseline");
  const baseHead = (await runGit(root, "rev-parse", "HEAD")).stdout.trim();
  await writeFile(path.join(root, "VERSION"), "1.0.1\n"); await writeFile(path.join(root, "CHANGELOG.md"), "# Changelog\n- Legacy repair (v1.0.1)\n"); await runGit(root, "add", "."); await runGit(root, "commit", "-m", "fix(core): legacy repair (v1.0.1)");
  assert.equal((await commitEvidence(root, baseHead)).phaseCommitsValid, true);
});

test("trusted lifecycle policy imports repository commit rules from the captured base", async () => {
  const root = await governedRepo(), identity = await repositoryIdentity(root);
  const policy = await loadPolicy(root, identity.baseHead);
  assert.equal(policy.commit?.version_file, "VERSION");
  assert.deepEqual(policy.commit?.changelog_files, ["Changelog/SPIKE_COLONY_CHANGELOG.md"]);
  assert.equal(policy.commit?.require_task_trailer, true);
  await writeFile(path.join(root, ".captain-sdlc", "project-policy.json"), JSON.stringify({ commit: { version_file: "PWNED" } }));
  assert.equal((await loadPolicy(root, identity.baseHead)).commit?.version_file, "VERSION");
});

test("trusted repository policy rejects unknown schemas, unsafe regexes, and source-root exclusions", async () => {
  const root = await governedRepo();
  const writePolicy = async (value: unknown) => {
    await writeFile(path.join(root, ".captain-sdlc", "project-policy.json"), JSON.stringify(value));
    await runGit(root, "add", ".captain-sdlc/project-policy.json");
    await runGit(root, "commit", "-m", "replace policy fixture");
    return (await runGit(root, "rev-parse", "HEAD")).stdout.trim();
  };
  let head = await writePolicy({ schema_version: 2, commit: repositoryCommitPolicy });
  await assert.rejects(() => loadPolicy(root, head), /schema_version/);
  for (const pattern of ["(?m)^(?<version>(a+)+)$", "(?m)^(?<version>(a|aa)+)$", "(?m)^(?<version>(a?)+)$"]) {
    head = await writePolicy({ schema_version: 1, commit: { ...repositoryCommitPolicy, version_surfaces: [{ path: "VERSION", pattern }] } });
    await assert.rejects(() => loadPolicy(root, head), /unsafe regular expression/);
  }
  for (const commit of [{ ...repositoryCommitPolicy, conventional: false }, { ...repositoryCommitPolicy, require_version_suffix: false }]) {
    head = await writePolicy({ schema_version: 1, commit }); await assert.rejects(() => loadPolicy(root, head), /unsupported commit policy/);
  }
  await writeFile(path.join(root, ".captain-sdlc", "codex-policy.json"), JSON.stringify({ profile: "feature", visualRequired: false, commitPolicyPath: ".captain-sdlc/project-policy.json", sourceManifestExcludes: ["src"], commands: { build: "build", ticket: "trusted", "feature-smoke": "smoke", "affected-regression": "affected" } }));
  await writeFile(path.join(root, ".captain-sdlc", "project-policy.json"), JSON.stringify({ schema_version: 1, commit: repositoryCommitPolicy }));
  await mkdir(path.join(root, "src")); await writeFile(path.join(root, "src", "owned.ts"), "source\n"); await runGit(root, "add", "."); await runGit(root, "commit", "-m", "add unsafe exclusion fixture");
  head = (await runGit(root, "rev-parse", "HEAD")).stdout.trim();
  await assert.rejects(() => loadPolicy(root, head), /generated-output/);
});

test("commit evidence validates first-parent integration commits and grandfathers imported side history", async () => {
  const root = await governedRepo();
  const primary = (await runGit(root, "branch", "--show-current")).stdout.trim();
  await runGit(root, "switch", "-c", "legacy-topic");
  await writeFile(path.join(root, "legacy.txt"), "legacy content\n"); await runGit(root, "add", "legacy.txt"); await runGit(root, "commit", "-m", "legacy commit without modern bookkeeping");
  await runGit(root, "switch", primary);
  await writeFile(path.join(root, "current.txt"), "current content\n"); await runGit(root, "add", "current.txt"); await runGit(root, "commit", "-m", "pre-run integration base");
  const baseHead = (await runGit(root, "rev-parse", "HEAD")).stdout.trim();
  await runGit(root, "merge", "--no-ff", "--no-commit", "legacy-topic");
  await writeFile(path.join(root, "VERSION"), "1.1.0\n");
  await writeFile(path.join(root, "ProjectSettings", "ProjectSettings.asset"), "bundleVersion: 1.1.0\n");
  await writeFile(path.join(root, "doxygen", "dirigible.Doxyfile"), "PROJECT_NUMBER = 1.1.0\n");
  await writeFile(path.join(root, "Changelog", "SPIKE_COLONY_CHANGELOG.md"), "# Changelog\n- Land legacy topic (v1.1.0)\n");
  await runGit(root, "add", "VERSION", "ProjectSettings/ProjectSettings.asset", "doxygen/dirigible.Doxyfile", "Changelog/SPIKE_COLONY_CHANGELOG.md");
  await runGit(root, "commit", "-m", "feat(integration): land legacy topic (v1.1.0)", "-m", "Implements: COLONY-SPIKE");
  const policy = await loadPolicy(root, baseHead);
  const evidence = await commitEvidence(root, baseHead, policy, "COLONY-SPIKE", [{ preMergeHead: baseHead, targetOid: (await runGit(root, "rev-parse", "legacy-topic")).stdout.trim(), strategy: "ort" }]);
  assert.equal(evidence.commitCount, 1);
  assert.equal(evidence.versionChanged, true);
  assert.equal(evidence.changelogChanged, true);
  assert.equal(evidence.taskTrailerValid, true);
  assert.equal(evidence.taskTrailerPresent, true);
  assert.equal(evidence.versionSurfacesValid, true);
  assert.equal(evidence.phaseCommitsValid, true);
});

test("source manifest excludes only trusted generated-output roots", async () => {
  const root = await repo(); await mkdir(path.join(root, "Generated")); await mkdir(path.join(root, "IgnoredInput"));
  await writeFile(path.join(root, "Generated", "output.bin"), "first"); await writeFile(path.join(root, "IgnoredInput", "input.bin"), "first");
  const policy = { profile: "feature" as const, visualRequired: false, sourceManifestExcludes: ["Generated"], commands: { build: "build", ticket: "ticket", "feature-smoke": "smoke", "affected-regression": "affected" } };
  const before = await sourceState(root, policy);
  await writeFile(path.join(root, "Generated", "output.bin"), "second");
  assert.equal((await sourceState(root, policy)).manifest, before.manifest);
  await writeFile(path.join(root, "IgnoredInput", "input.bin"), "second");
  assert.notEqual((await sourceState(root, policy)).manifest, before.manifest);
});

test("source manifest ignores untracked Unity meta sidecars but binds tracked meta files", async () => {
  const root = await repo();
  await writeFile(path.join(root, "tracked.asset.meta"), "tracked-first");
  await runGit(root, "add", "tracked.asset.meta"); await runGit(root, "commit", "-m", "track meta sidecar");
  await writeFile(path.join(root, "generated.asset.meta"), "generated-first");
  const before = await sourceState(root);
  await writeFile(path.join(root, "generated.asset.meta"), "generated-second");
  assert.equal((await sourceState(root)).manifest, before.manifest);
  await writeFile(path.join(root, "tracked.asset.meta"), "tracked-second");
  assert.notEqual((await sourceState(root)).manifest, before.manifest);
});

test("trusted source manifest policy excludes approved Unity outputs but still binds ignored inputs", async () => {
  const root = await repo();
  await writeFile(path.join(root, ".captain-sdlc", "codex-policy.json"), JSON.stringify({
    profile: "feature",
    visualRequired: false,
    sourceManifestExcludes: ["UserSettings", "dirigibles", "doxygen/dirigibles", "doxygen/doxygen_warnings.log", "Assets/packages-merged-link", "Assets/packages-merged-link.meta", "Assets/_Dirigible/Temp", "Assets/_Dirigible/Temp.meta"],
    sourceManifestRootFileExcludes: ["*.csproj", "*.sln", "*.DotSettings", "doxygen_warnings.log"],
    commands: { build: "build", ticket: "trusted", "feature-smoke": "smoke", "affected-regression": "affected" },
  }));
  await runGit(root, "add", ".captain-sdlc/codex-policy.json"); await runGit(root, "commit", "-m", "add Unity proof policy");
  const head = (await runGit(root, "rev-parse", "HEAD")).stdout.trim(), policy = await loadPolicy(root, head);
  await mkdir(path.join(root, "UserSettings")); await writeFile(path.join(root, "UserSettings", "EditorUserSettings.asset"), "first");
  await mkdir(path.join(root, "doxygen", "dirigibles"), { recursive: true }); await writeFile(path.join(root, "doxygen", "dirigibles", "index.html"), "first"); await writeFile(path.join(root, "doxygen", "doxygen_warnings.log"), "first");
  await mkdir(path.join(root, "Assets", "packages-merged-link"), { recursive: true }); await writeFile(path.join(root, "Assets", "packages-merged-link", "link.xml"), "first");
  await writeFile(path.join(root, "Assembly-CSharp.csproj"), "first"); await writeFile(path.join(root, "project.sln"), "first"); await writeFile(path.join(root, "project.csproj.DotSettings"), "first");
  await mkdir(path.join(root, "IgnoredDependency")); await writeFile(path.join(root, "IgnoredDependency", "input.dll"), "first");
  const before = await sourceState(root, policy);
  await writeFile(path.join(root, "UserSettings", "EditorUserSettings.asset"), "second"); await writeFile(path.join(root, "doxygen", "dirigibles", "index.html"), "second"); await writeFile(path.join(root, "doxygen", "doxygen_warnings.log"), "second"); await writeFile(path.join(root, "Assets", "packages-merged-link", "link.xml"), "second"); await writeFile(path.join(root, "Assembly-CSharp.csproj"), "second");
  assert.equal((await sourceState(root, policy)).manifest, before.manifest);
  await writeFile(path.join(root, "IgnoredDependency", "input.dll"), "second");
  assert.notEqual((await sourceState(root, policy)).manifest, before.manifest);
});

test("trusted source policy approves ignored Addressables linker outputs", async () => {
  const root = await repo();
  const exclusions = [
    "Temp",
    "Assets/AddressableAssetsData/link.xml",
    "Assets/AddressableAssetsData/link.xml.meta",
    "Assets/AddressableAssetsData/Windows/addressables_content_state.bin",
    "Assets/AddressableAssetsData/Windows/addressables_content_state.bin.meta",
    "Assets/ThirdParty/GameAnalytics/Resources/GameAnalytics/Settings.asset",
    "Assets/TextMesh Pro/Resources/Fonts & Materials/LiberationSans SDF - Fallback.asset",
  ];
  await writeFile(path.join(root, ".captain-sdlc", "codex-policy.json"), JSON.stringify({
    profile: "low",
    visualRequired: false,
    sourceManifestExcludes: exclusions,
    commands: { build: "build", ticket: "ticket", "feature-smoke": "smoke", "affected-regression": "affected" },
  }));
  await runGit(root, "add", ".captain-sdlc/codex-policy.json");
  await runGit(root, "commit", "-m", "add generated Addressables policy");
  const head = (await runGit(root, "rev-parse", "HEAD")).stdout.trim();

  const policy = await loadPolicy(root, head);

  assert.deepEqual(policy.sourceManifestExcludes, exclusions);
});

test("trusted source manifest policy rejects arbitrary output paths and root patterns", async () => {
  const root = await repo();
  const writePolicy = async (sourceManifestExcludes: string[], sourceManifestRootFileExcludes: string[]) => {
    await writeFile(path.join(root, ".captain-sdlc", "codex-policy.json"), JSON.stringify({ profile: "feature", visualRequired: false, sourceManifestExcludes, sourceManifestRootFileExcludes, commands: { build: "build", ticket: "trusted", "feature-smoke": "smoke", "affected-regression": "affected" } }));
    await runGit(root, "add", ".captain-sdlc/codex-policy.json"); await runGit(root, "commit", "-m", "replace source policy");
    return (await runGit(root, "rev-parse", "HEAD")).stdout.trim();
  };
  let head = await writePolicy(["Assets"], []); await assert.rejects(() => loadPolicy(root, head), /approved generated-output/);
  head = await writePolicy([], ["*.txt"]); await assert.rejects(() => loadPolicy(root, head), /approved generated root-file pattern/);
  await writeFile(path.join(root, "owned.csproj"), "tracked"); await runGit(root, "add", "-f", "owned.csproj"); await runGit(root, "commit", "-m", "add tracked generated-looking source");
  head = await writePolicy([], ["*.csproj"]); await assert.rejects(() => loadPolicy(root, head), /tracked base file/);
});

test("generated path exclusions reject case-variant tracked base content", async () => {
  const root = await repo(); await mkdir(path.join(root, "UserSettings")); await writeFile(path.join(root, "UserSettings", "Owned.asset"), "tracked"); await runGit(root, "add", "-f", "UserSettings/Owned.asset");
  await writeFile(path.join(root, ".captain-sdlc", "codex-policy.json"), JSON.stringify({ profile: "feature", visualRequired: false, sourceManifestExcludes: ["usersettings"], commands: { build: "build", ticket: "trusted", "feature-smoke": "smoke", "affected-regression": "affected" } }));
  await runGit(root, "add", ".captain-sdlc/codex-policy.json"); await runGit(root, "commit", "-m", "case variant fixture"); const head = (await runGit(root, "rev-parse", "HEAD")).stdout.trim();
  await assert.rejects(() => loadPolicy(root, head), /tracked base files/);
});

test("target branch support adopts only a clean canonical existing worktree", async () => {
  const root = await repo(), base = (await runGit(root, "rev-parse", "HEAD")).stdout.trim();
  await runGit(root, "branch", "colony/spike", base);
  const target = path.join(root, ".captain-sdlc", "worktrees", "colony-spike"); await mkdir(path.dirname(target), { recursive: true });
  await runGit(root, "worktree", "add", target, "colony/spike");
  const identity = await repositoryIdentity(root, "colony/spike", base); assert.equal(identity.baseHead, base);
  const adopted = await ensureWorktree(root, identity.baseHead, "intent-x", "colony/spike");
  assert.equal(path.resolve(adopted.worktreePath), path.resolve(target)); assert.equal(adopted.baseHead, base); assert.equal(adopted.branch, "colony/spike"); assert.match(adopted.gitDir, /worktrees/i);
  await writeFile(path.join(target, "dirty.txt"), "dirty");
  await assert.rejects(() => ensureWorktree(root, identity.baseHead, "intent-y", "colony/spike"), /clean/);
});

test("new worktree copies ignored Unity plugin roots and sibling metadata", async () => {
  const root = await repo();
  await writeFile(path.join(root, ".gitignore"), "Assets/Plugins/\nAssets/Plugins.meta\nPackages/com.example.plugin/\n");
  await runGit(root, "add", ".gitignore"); await runGit(root, "commit", "-m", "ignore plugins");
  await mkdir(path.join(root, "Assets", "Plugins", "Vendor"), { recursive: true });
  await writeFile(path.join(root, "Assets", "Plugins", "Vendor", "plugin.dll"), "plugin");
  await writeFile(path.join(root, "Assets", "Plugins", "Vendor.meta"), "nested meta");
  await writeFile(path.join(root, "Assets", "Plugins.meta"), "root meta");
  await mkdir(path.join(root, "Packages", "com.example.plugin"), { recursive: true });
  await writeFile(path.join(root, "Packages", "com.example.plugin", "package.json"), "{}");
  const base = (await runGit(root, "rev-parse", "HEAD")).stdout.trim();
  const created = await ensureWorktree(root, base, "hydrate-plugins");
  assert.equal(await readFile(path.join(created.worktreePath, "Assets", "Plugins", "Vendor", "plugin.dll"), "utf8"), "plugin");
  assert.equal(await readFile(path.join(created.worktreePath, "Assets", "Plugins", "Vendor.meta"), "utf8"), "nested meta");
  assert.equal(await readFile(path.join(created.worktreePath, "Assets", "Plugins.meta"), "utf8"), "root meta");
  assert.equal(await readFile(path.join(created.worktreePath, "Packages", "com.example.plugin", "package.json"), "utf8"), "{}");
  await writeFile(path.join(created.worktreePath, "Assets", "Plugins", "Vendor", "plugin.dll"), "worktree version");
  await ensureWorktree(root, base, "hydrate-plugins");
  assert.equal(await readFile(path.join(created.worktreePath, "Assets", "Plugins", "Vendor", "plugin.dll"), "utf8"), "worktree version");
});
test("ordinary begin adopts its exact canonical worktree after an interrupted creation", async () => {
  const root = await repo(), identity = await repositoryIdentity(root), intentId = "intent-retry", expected = path.join(root, ".captain-sdlc", "worktrees", intentId);
  await ensureWorktree(root, identity.baseHead, intentId);
  const recovered = await ensureWorktree(root, identity.baseHead, intentId);
  assert.equal(recovered.worktreePath, expected);
  assert.equal(recovered.branch, `captain/${intentId}`);
});

test("target branch support rejects unsafe names and noncanonical checked-out worktrees", async () => {
  const root = await repo(), base = (await runGit(root, "rev-parse", "HEAD")).stdout.trim();
  await assert.rejects(() => repositoryIdentity(root, "../colony", base), /target branch/);
  await runGit(root, "branch", "colony/spike", base);
  const outside = await mkdtemp(path.join(tmpdir(), "captain-outside-worktree-"));
  await runGit(root, "worktree", "add", outside, "colony/spike");
  await assert.rejects(() => ensureWorktree(root, base, "intent-x", "colony/spike"), /canonical worktree container/);
});

test("commit rejects a moved governed HEAD before staging selected paths", async () => {
  const root = await governedRepo(), binding = await sourceState(root), expectedHead = binding.head;
  await writeFile(path.join(root, "attacker.txt"), "advance\n"); await runGit(root, "add", "attacker.txt"); await runGit(root, "commit", "-m", "advance outside Captain");
  await writeFile(path.join(root, "VERSION"), "1.0.1\n");
  await assert.rejects(() => commitAtomic(root, ["VERSION"], "fix(policy): guarded commit (v1.0.1)", "Implements", "COLONY-SPIKE", repositoryCommitPolicy, [], binding.branch, binding.commonGitDir, expectedHead, binding.gitDir), /binding/);
  assert.equal((await runGit(root, "diff", "--cached", "--name-only")).stdout.trim(), "");
  assert.notEqual((await runGit(root, "rev-parse", "HEAD")).stdout.trim(), expectedHead);
});

test("merge rejects a moved governed HEAD before creating merge state", async () => {
  const root = await governedRepo(), primary = (await runGit(root, "branch", "--show-current")).stdout.trim();
  await runGit(root, "switch", "-c", "topic"); await writeFile(path.join(root, "topic.txt"), "topic\n"); await runGit(root, "add", "topic.txt"); await runGit(root, "commit", "-m", "topic");
  const topic = (await runGit(root, "rev-parse", "HEAD")).stdout.trim(); await runGit(root, "switch", primary);
  const binding = await sourceState(root), expectedHead = binding.head;
  await writeFile(path.join(root, "attacker.txt"), "advance\n"); await runGit(root, "add", "attacker.txt"); await runGit(root, "commit", "-m", "advance outside Captain");
  await assert.rejects(() => prepareMerge(root, topic, "ort", undefined, undefined, binding.branch, binding.commonGitDir, expectedHead, binding.gitDir), /binding/);
  await assert.rejects(() => runGit(root, "rev-parse", "--verify", "MERGE_HEAD"));
});

test("merge preparation pins a full commit oid and leaves an auditable no-commit merge", async () => {
  const root = await governedRepo(), primary = (await runGit(root, "branch", "--show-current")).stdout.trim();
  await runGit(root, "switch", "-c", "topic"); await writeFile(path.join(root, "topic.txt"), "topic\n"); await runGit(root, "add", "topic.txt"); await runGit(root, "commit", "-m", "legacy topic");
  const topic = (await runGit(root, "rev-parse", "HEAD")).stdout.trim(); await runGit(root, "switch", primary);
  const base = (await runGit(root, "rev-parse", "HEAD")).stdout.trim(), result = await prepareMerge(root, topic, "ort");
  assert.equal(result.commitOid, topic); assert.equal(result.status, "ready");
  assert.equal((await runGit(root, "rev-parse", "HEAD")).stdout.trim(), base);
  assert.equal((await runGit(root, "rev-parse", "MERGE_HEAD")).stdout.trim(), topic);
});

test("ours merge evidence permits only required bookkeeping changes", async () => {
  const root = await governedRepo(), primary = (await runGit(root, "branch", "--show-current")).stdout.trim();
  await runGit(root, "switch", "-c", "stale-topic"); await writeFile(path.join(root, "must-not-land.txt"), "stale payload\n"); await runGit(root, "add", "must-not-land.txt"); await runGit(root, "commit", "-m", "stale payload");
  const targetOid = (await runGit(root, "rev-parse", "HEAD")).stdout.trim(); await runGit(root, "switch", primary);
  const baseHead = (await runGit(root, "rev-parse", "HEAD")).stdout.trim(), prepared = { preMergeHead: baseHead, targetOid, strategy: "ours" as const };
  assert.equal((await prepareMerge(root, targetOid, "ours")).status, "ready");
  await writeFile(path.join(root, "VERSION"), "1.0.1\n"); await writeFile(path.join(root, "ProjectSettings", "ProjectSettings.asset"), "bundleVersion: 1.0.1\n"); await writeFile(path.join(root, "doxygen", "dirigible.Doxyfile"), "PROJECT_NUMBER = 1.0.1\n"); await writeFile(path.join(root, "Changelog", "SPIKE_COLONY_CHANGELOG.md"), "# Changelog\n- Record stale ancestry (v1.0.1)\n");
  await runGit(root, "add", "."); await runGit(root, "commit", "-m", "chore(integration): record stale ancestry (v1.0.1)", "-m", "Implements: COLONY-SPIKE");
  assert.equal((await commitEvidence(root, baseHead, await loadPolicy(root, baseHead), "COLONY-SPIKE", [prepared])).phaseCommitsValid, true);
  await assert.rejects(() => access(path.join(root, "must-not-land.txt")));
});

test("conflicted merge preparation verifies and can abort only the pinned merge state", async () => {
  const root = await governedRepo(), primary = (await runGit(root, "branch", "--show-current")).stdout.trim();
  await writeFile(path.join(root, "shared.txt"), "base\n"); await runGit(root, "add", "shared.txt"); await runGit(root, "commit", "-m", "shared baseline");
  await runGit(root, "switch", "-c", "topic"); await writeFile(path.join(root, "shared.txt"), "topic\n"); await runGit(root, "commit", "-am", "topic conflict");
  const topic = (await runGit(root, "rev-parse", "HEAD")).stdout.trim(); await runGit(root, "switch", primary);
  await writeFile(path.join(root, "shared.txt"), "primary\n"); await runGit(root, "commit", "-am", "primary conflict");
  const preMergeHead = (await runGit(root, "rev-parse", "HEAD")).stdout.trim(), result = await prepareMerge(root, topic, "ort");
  assert.equal(result.status, "conflicts"); assert.equal(result.preMergeHead, preMergeHead);
  assert.equal((await runGit(root, "rev-parse", "MERGE_HEAD")).stdout.trim(), topic);
  await assert.rejects(() => abortMerge(root, { preMergeHead, targetOid: "f".repeat(40), strategy: "ort" }), /pinned/);
  await abortMerge(root, { preMergeHead, targetOid: topic, strategy: "ort" });
  assert.equal((await runGit(root, "status", "--porcelain")).stdout.trim(), "");
});

test("failed merge cleanup retains signed authorization for explicit recovery", async () => {
  const root = await governedRepo(), primary = (await runGit(root, "branch", "--show-current")).stdout.trim();
  await runGit(root, "switch", "-c", "cleanup-topic"); await writeFile(path.join(root, "blocking.txt"), "topic\n"); await runGit(root, "add", "blocking.txt"); await runGit(root, "commit", "-m", "topic update"); const topic = (await runGit(root, "rev-parse", "HEAD")).stdout.trim(); await runGit(root, "switch", primary);
  let authorized = false, revoked = false;
  await assert.rejects(() => prepareMerge(root, topic, "ort", async () => { authorized = true; await writeFile(path.join(root, "blocking.txt"), "local interruption\n"); }, async () => { revoked = true; }), /authorization was retained/);
  assert.equal(authorized, true); assert.equal(revoked, false); assert.equal((await runGit(root, "rev-parse", "HEAD")).stdout.trim(), (await runGit(root, "rev-parse", primary)).stdout.trim());
});

test("merge cleanup retains authorization unless abort restores a clean pre-merge state", async () => {
  const root = await governedRepo(), primary = (await runGit(root, "branch", "--show-current")).stdout.trim();
  await runGit(root, "switch", "-c", "abort-cleanup-topic"); await writeFile(path.join(root, "topic.txt"), "topic\n"); await runGit(root, "add", "topic.txt"); await runGit(root, "commit", "-m", "topic update"); const topic = (await runGit(root, "rev-parse", "HEAD")).stdout.trim(); await runGit(root, "switch", primary);
  let revoked = false;
  await assert.rejects(() => prepareMerge(root, topic, "ort", async () => {}, async () => { revoked = true; }, undefined, undefined, undefined, undefined, async () => { await writeFile(path.join(root, "abort-leftover.tmp"), "leftover\n"); throw new Error("interrupt after merge"); }), /authorization was retained/);
  assert.equal(revoked, false); assert.equal((await runGit(root, "rev-parse", "HEAD")).stdout.trim(), (await runGit(root, "rev-parse", primary)).stdout.trim());
});

test("stale signed merge authorization can reconcile only a clean unchanged pre-merge state", async () => {
  const root = await governedRepo(), preMergeHead = (await runGit(root, "rev-parse", "HEAD")).stdout.trim(), prepared = { preMergeHead, targetOid: "d".repeat(40), strategy: "ort" as const };
  await reconcilePreparedMerge(root, prepared);
  await writeFile(path.join(root, "dirty.txt"), "dirty\n"); await assert.rejects(() => reconcilePreparedMerge(root, prepared), /clean unchanged/);
});

test("Captain commits ignore repository hooks and scrub authority paths", async () => {
  const root = await governedRepo(), hooks = await mkdtemp(path.join(tmpdir(), "captain-hostile-hooks-")), sentinel = path.join(root, "leaked-authority.txt");
  const hook = path.join(hooks, "pre-commit");
  await writeFile(hook, `#!/bin/sh\nprintf '%s' "$CAPTAIN_PLUGIN_DATA" > "${sentinel.replaceAll("\\", "/")}"\nexit 1\n`); await chmod(hook, 0o755);
  await runGit(root, "config", "core.hooksPath", hooks);
  await writeFile(path.join(root, "safe.txt"), "safe\n"); await writeFile(path.join(root, "VERSION"), "1.0.1\n"); await writeFile(path.join(root, "ProjectSettings", "ProjectSettings.asset"), "bundleVersion: 1.0.1\n"); await writeFile(path.join(root, "doxygen", "dirigible.Doxyfile"), "PROJECT_NUMBER = 1.0.1\n"); await writeFile(path.join(root, "Changelog", "SPIKE_COLONY_CHANGELOG.md"), "# Changelog\n- Isolate Git children (v1.0.1)\n");
  const previous = process.env.CAPTAIN_PLUGIN_DATA; process.env.CAPTAIN_PLUGIN_DATA = "TOP-SECRET-AUTHORITY-PATH";
  try { await commitAtomic(root, ["safe.txt", "VERSION", "ProjectSettings/ProjectSettings.asset", "doxygen/dirigible.Doxyfile", "Changelog/SPIKE_COLONY_CHANGELOG.md"], "fix(policy): isolate git children (v1.0.1)", undefined, undefined, { ...repositoryCommitPolicy, require_task_trailer: false }); }
  finally { if (previous === undefined) delete process.env.CAPTAIN_PLUGIN_DATA; else process.env.CAPTAIN_PLUGIN_DATA = previous; }
  await assert.rejects(() => access(sentinel));
});

test("Captain preflights semantic commit policy before moving HEAD", async () => {
  const root = await governedRepo(), head = (await runGit(root, "rev-parse", "HEAD")).stdout.trim();
  await writeFile(path.join(root, "VERSION"), "1.1.0\n"); await writeFile(path.join(root, "ProjectSettings", "ProjectSettings.asset"), "bundleVersion: 1.1.0\n"); await writeFile(path.join(root, "doxygen", "dirigible.Doxyfile"), "PROJECT_NUMBER = 1.1.0\n"); await writeFile(path.join(root, "Changelog", "SPIKE_COLONY_CHANGELOG.md"), "# Changelog\n- Wrong fix bump (v1.1.0)\n");
  await assert.rejects(() => commitAtomic(root, ["VERSION", "ProjectSettings/ProjectSettings.asset", "doxygen/dirigible.Doxyfile", "Changelog/SPIKE_COLONY_CHANGELOG.md"], "fix(policy): wrong bump (v1.1.0)", "Implements", "COLONY-SPIKE", repositoryCommitPolicy), /preflight/);
  assert.equal((await runGit(root, "rev-parse", "HEAD")).stdout.trim(), head);
});

test("a post-CAS failure retains signed candidate evidence and reconciles after restart", async () => {
  const root = await governedRepo(), state = await sourceState(root), dirty = path.join(root, "post-cas.tmp"); let prepared: any, revoked = false;
  await writeFile(path.join(root, "VERSION"), "1.0.1\n"); await writeFile(path.join(root, "ProjectSettings", "ProjectSettings.asset"), "bundleVersion: 1.0.1\n"); await writeFile(path.join(root, "doxygen", "dirigible.Doxyfile"), "PROJECT_NUMBER = 1.0.1\n"); await writeFile(path.join(root, "Changelog", "SPIKE_COLONY_CHANGELOG.md"), "# Changelog\n- Recover commit (v1.0.1)\n");
  await assert.rejects(() => commitAtomic(root, ["VERSION", "ProjectSettings/ProjectSettings.asset", "doxygen/dirigible.Doxyfile", "Changelog/SPIKE_COLONY_CHANGELOG.md"], "fix(policy): recover commit (v1.0.1)", "Implements", "COLONY-SPIKE", repositoryCommitPolicy, [], state.branch, state.commonGitDir, state.head, state.gitDir, async value => { prepared = value; }, async () => { revoked = true; }, async () => { await writeFile(dirty, "interrupt\n"); }), /diverged/);
  assert.equal(revoked, false); assert.equal((await runGit(root, "rev-parse", "HEAD")).stdout.trim(), prepared.candidate);
  await unlink(dirty); await reconcilePreparedCommit(root, prepared, state.branch!, state.commonGitDir!, state.gitDir!);
  assert.equal((await commitEvidence(root, state.head, await loadPolicy(root, state.head), "COLONY-SPIKE")).phaseCommitsValid, true);
});

test("prepared pre-HEAD recovery applies only the already signed candidate object", async () => {
  const root = await governedRepo(), state = await sourceState(root); let prepared: any, validations = 0;
  await writeFile(path.join(root, "VERSION"), "1.0.1\n"); await writeFile(path.join(root, "ProjectSettings", "ProjectSettings.asset"), "bundleVersion: 1.0.1\n"); await writeFile(path.join(root, "doxygen", "dirigible.Doxyfile"), "PROJECT_NUMBER = 1.0.1\n"); await writeFile(path.join(root, "Changelog", "SPIKE_COLONY_CHANGELOG.md"), "# Changelog\n- Apply signed candidate (v1.0.1)\n");
  await assert.rejects(() => commitAtomic(root, ["VERSION", "ProjectSettings/ProjectSettings.asset", "doxygen/dirigible.Doxyfile", "Changelog/SPIKE_COLONY_CHANGELOG.md"], "fix(policy): apply signed candidate (v1.0.1)", "Implements", "COLONY-SPIKE", repositoryCommitPolicy, [], state.branch, state.commonGitDir, state.head, state.gitDir, async value => { prepared = value; }, undefined, undefined, async () => { throw new Error("pause signed candidate before CAS"); }), /pause signed candidate/);
  assert.equal((await runGit(root, "rev-parse", "HEAD")).stdout.trim(), state.head); await applyPreparedCommit(root, prepared, state.branch!, state.commonGitDir!, state.gitDir!, async value => { validations++; assert.deepEqual(value, prepared); });
  assert.equal((await runGit(root, "rev-parse", "HEAD")).stdout.trim(), prepared.candidate); assert.equal((await runGit(root, "status", "--porcelain")).stdout.trim(), ""); assert.equal(validations, 1);
});

test("prepared commit authorization is retained when post-failure HEAD cannot be proven", async () => {
  const root = await governedRepo(), hiddenGit = path.join(root, ".git-hidden"); let revoked = false;
  await writeFile(path.join(root, "VERSION"), "1.0.1\n"); await writeFile(path.join(root, "ProjectSettings", "ProjectSettings.asset"), "bundleVersion: 1.0.1\n"); await writeFile(path.join(root, "doxygen", "dirigible.Doxyfile"), "PROJECT_NUMBER = 1.0.1\n"); await writeFile(path.join(root, "Changelog", "SPIKE_COLONY_CHANGELOG.md"), "# Changelog\n- Retain unknown commit state (v1.0.1)\n");
  try {
    await assert.rejects(() => commitAtomic(root, ["VERSION", "ProjectSettings/ProjectSettings.asset", "doxygen/dirigible.Doxyfile", "Changelog/SPIKE_COLONY_CHANGELOG.md"], "fix(policy): retain unknown commit state (v1.0.1)", "Implements", "COLONY-SPIKE", repositoryCommitPolicy, [], undefined, undefined, undefined, undefined, async () => {}, async () => { revoked = true; }, async () => { await rename(path.join(root, ".git"), hiddenGit); throw new Error("interrupt with unavailable Git metadata"); }), /interrupt/);
  } finally { if (await access(hiddenGit).then(() => true, () => false)) await rename(hiddenGit, path.join(root, ".git")); }
  assert.equal(revoked, false);
});

test("Captain rejects multiline commit subjects before moving HEAD", async () => {
  const root = await governedRepo(), head = (await runGit(root, "rev-parse", "HEAD")).stdout.trim(); await writeFile(path.join(root, "safe.txt"), "safe\n");
  await assert.rejects(() => commitAtomic(root, ["safe.txt"], "fix(policy): line one\nfix(policy): line two (v1.0.1)"), /single line/);
  assert.equal((await runGit(root, "rev-parse", "HEAD")).stdout.trim(), head);
});

test("commit paths reject normalized traversal", async () => {
  const root = await governedRepo(); await assert.rejects(() => commitAtomic(root, ["dir/../VERSION"], "fix(policy): reject traversal (v1.0.1)"), /safe repository-relative/);
});

test("task trailer evidence rejects a trailer-shaped body line", async () => {
  const root = await governedRepo(), baseHead = (await runGit(root, "rev-parse", "HEAD")).stdout.trim();
  await writeFile(path.join(root, "VERSION"), "1.0.1\n"); await writeFile(path.join(root, "ProjectSettings", "ProjectSettings.asset"), "bundleVersion: 1.0.1\n"); await writeFile(path.join(root, "doxygen", "dirigible.Doxyfile"), "PROJECT_NUMBER = 1.0.1\n");
  await writeFile(path.join(root, "Changelog", "SPIKE_COLONY_CHANGELOG.md"), "# Changelog\n- Update policy (v1.0.1)\n"); await runGit(root, "add", ".");
  await runGit(root, "commit", "-m", "fix(policy): update policy (v1.0.1)", "-m", "Implements: COLONY-SPIKE\n\nThis paragraph makes the apparent trailer part of the body.");
  const evidence = await commitEvidence(root, baseHead, await loadPolicy(root, baseHead), "COLONY-SPIKE");
  assert.equal(evidence.taskTrailerValid, false); assert.equal(evidence.phaseCommitsValid, false);
});

test("phase evidence rejects an incorrect semantic version bump", async () => {
  const root = await governedRepo(), baseHead = (await runGit(root, "rev-parse", "HEAD")).stdout.trim();
  await writeFile(path.join(root, "VERSION"), "1.1.0\n"); await writeFile(path.join(root, "ProjectSettings", "ProjectSettings.asset"), "bundleVersion: 1.1.0\n"); await writeFile(path.join(root, "doxygen", "dirigible.Doxyfile"), "PROJECT_NUMBER = 1.1.0\n");
  await writeFile(path.join(root, "Changelog", "SPIKE_COLONY_CHANGELOG.md"), "# Changelog\n- Apply a fix (v1.1.0)\n"); await runGit(root, "add", "."); await runGit(root, "commit", "-m", "fix(policy): apply a fix (v1.1.0)", "-m", "Implements: COLONY-SPIKE");
  assert.equal((await commitEvidence(root, baseHead, await loadPolicy(root, baseHead), "COLONY-SPIKE")).phaseCommitsValid, false);
});

test("phase evidence requires the new version in an added changelog line", async () => {
  const root = await governedRepo(), baseHead = (await runGit(root, "rev-parse", "HEAD")).stdout.trim();
  await writeFile(path.join(root, "VERSION"), "1.0.1\n"); await writeFile(path.join(root, "ProjectSettings", "ProjectSettings.asset"), "bundleVersion: 1.0.1\n"); await writeFile(path.join(root, "doxygen", "dirigible.Doxyfile"), "PROJECT_NUMBER = 1.0.1\n");
  await writeFile(path.join(root, "Changelog", "SPIKE_COLONY_CHANGELOG.md"), "# Changelog\n- Apply a fix without inline linkage\n"); await runGit(root, "add", "."); await runGit(root, "commit", "-m", "fix(policy): apply a fix (v1.0.1)", "-m", "Implements: COLONY-SPIKE");
  assert.equal((await commitEvidence(root, baseHead, await loadPolicy(root, baseHead), "COLONY-SPIKE")).phaseCommitsValid, false);
});

test("task trailer evidence rejects a valid trailer for another run task", async () => {
  const root = await governedRepo(), baseHead = (await runGit(root, "rev-parse", "HEAD")).stdout.trim();
  await writeFile(path.join(root, "VERSION"), "1.0.1\n"); await writeFile(path.join(root, "ProjectSettings", "ProjectSettings.asset"), "bundleVersion: 1.0.1\n"); await writeFile(path.join(root, "doxygen", "dirigible.Doxyfile"), "PROJECT_NUMBER = 1.0.1\n");
  await writeFile(path.join(root, "Changelog", "SPIKE_COLONY_CHANGELOG.md"), "# Changelog\n- Apply a fix (v1.0.1)\n"); await runGit(root, "add", "."); await runGit(root, "commit", "-m", "fix(policy): apply a fix (v1.0.1)", "-m", "Implements: OTHER-TASK");
  const evidence = await commitEvidence(root, baseHead, await loadPolicy(root, baseHead), "COLONY-SPIKE");
  assert.equal(evidence.taskTrailerValid, false); assert.equal(evidence.phaseCommitsValid, false);
});

test("preexisting canonical worktree collision is rejected", async () => {
  const root = await repo(), identity = await repositoryIdentity(root), target = path.join(root, ".captain-sdlc", "worktrees", "intent-x"); await mkdir(target, { recursive: true });
  await assert.rejects(() => ensureWorktree(root, identity.baseHead, "intent-x"));
});

test("trusted LOW profile loads from the committed policy", async () => {
  const root = await repo();
  await writeFile(path.join(root, ".captain-sdlc", "codex-policy.json"), JSON.stringify({ profile: "low", profiles: ["low", "feature", "pre-release"], visualRequired: false, commands: { build: "build", ticket: "ticket", "feature-smoke": "smoke", "affected-regression": "affected" } }));
  await exec("git", ["add", ".captain-sdlc/codex-policy.json"], { cwd: root });
  await exec("git", ["commit", "-m", "low policy"], { cwd: root });
  const identity = await repositoryIdentity(root);
  const policy = await loadPolicy(root, identity.baseHead);
  assert.equal(policy.profile, "low");
  assert.deepEqual(policy.profiles, ["low", "feature", "pre-release"]);
});
