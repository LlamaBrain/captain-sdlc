import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { abortMerge, commitAtomic, commitEvidence, ensureWorktree, loadPolicy, prepareMerge, reconcilePreparedMerge, repositoryIdentity, sourceState } from "../src/workspace.js";
const exec = promisify(execFile);
const runGit = (root: string, ...args: string[]) => exec("git", args, { cwd: root });
async function repo() { const root = await mkdtemp(path.join(tmpdir(), "captain-workspace-")); await exec("git", ["init"], { cwd: root }); await exec("git", ["config", "user.name", "Captain Test"], { cwd: root }); await exec("git", ["config", "user.email", "captain@example.invalid"], { cwd: root }); await mkdir(path.join(root, ".captain-sdlc")); await writeFile(path.join(root, ".captain-sdlc", "codex-policy.json"), JSON.stringify({ profile: "feature", visualRequired: false, commands: { build: "build", ticket: "trusted", "feature-smoke": "smoke", "affected-regression": "affected" } })); await exec("git", ["add", "."], { cwd: root }); await exec("git", ["commit", "-m", "baseline"], { cwd: root }); return root; }

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

test("trusted policy comes from captured base, not dirty working tree", async () => {
  const root = await repo(), identity = await repositoryIdentity(root); await writeFile(path.join(root, ".captain-sdlc", "codex-policy.json"), JSON.stringify({ commands: { ticket: "exit 0" } }));
  const policy = await loadPolicy(root, identity.baseHead); assert.equal(policy.commands.ticket, "trusted");
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
  await assert.rejects(() => loadPolicy(root, head), /generated-output root/);
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

test("stale signed merge authorization can reconcile only a clean unchanged pre-merge state", async () => {
  const root = await governedRepo(), preMergeHead = (await runGit(root, "rev-parse", "HEAD")).stdout.trim(), prepared = { preMergeHead, targetOid: "d".repeat(40), strategy: "ort" as const };
  await reconcilePreparedMerge(root, prepared);
  await writeFile(path.join(root, "dirty.txt"), "dirty\n"); await assert.rejects(() => reconcilePreparedMerge(root, prepared), /clean unchanged/);
});

test("Captain commits ignore repository hooks and scrub authority paths", async () => {
  const root = await governedRepo(), hooks = path.join(root, "hostile-hooks"), sentinel = path.join(root, "leaked-authority.txt");
  await mkdir(hooks); const hook = path.join(hooks, "pre-commit");
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
