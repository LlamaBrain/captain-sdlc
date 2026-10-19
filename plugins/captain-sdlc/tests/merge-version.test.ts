import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { CommitPolicy, ProjectPolicy } from "../src/lifecycle.js";
import { commitAtomic, commitEvidence, prepareMerge, type PreparedMerge } from "../src/workspace.js";

const exec = promisify(execFile);
const git = (root: string, ...args: string[]) => exec("git", args, { cwd: root });
const selected = ["VERSION", "ProjectSettings.asset", "CHANGELOG.md"];
const policy: CommitPolicy = {
  conventional: true, require_version_suffix: true, require_task_trailer: true,
  version_file: "VERSION",
  version_surfaces: [
    { path: "VERSION", pattern: "(?m)^(?<version>[0-9]+\\.[0-9]+\\.[0-9]+)\\s*$" },
    { path: "ProjectSettings.asset", pattern: "(?m)^bundleVersion: (?<version>[0-9]+\\.[0-9]+\\.[0-9]+)\\s*$" },
  ],
  changelog_files: ["CHANGELOG.md"],
};

async function writeVersion(root: string, version: string) {
  await writeFile(path.join(root, "VERSION"), version + "\n");
  await writeFile(path.join(root, "ProjectSettings.asset"), "bundleVersion: " + version + "\n");
  await writeFile(path.join(root, "CHANGELOG.md"), "# Changelog\n- Fixture (v" + version + ")\n");
}

async function fixture(t: TestContext, sourceVersion = "2.550.3", targetVersion = "2.610.4") {
  const root = await mkdtemp(path.join(tmpdir(), "captain-merge-version-"));
  t.after(async () => {
    assert.equal(path.dirname(root), path.resolve(tmpdir()));
    assert.ok(path.basename(root).startsWith("captain-merge-version-"));
    await rm(root, { recursive: true, force: true });
  });
  await git(root, "init");
  await git(root, "config", "user.name", "Captain Test");
  await git(root, "config", "user.email", "captain@example.invalid");
  await git(root, "config", "core.autocrlf", "false");
  await mkdir(path.join(root, ".captain-sdlc"));
  await writeFile(path.join(root, ".captain-sdlc/codex-policy.json"), JSON.stringify({ commit: policy }));
  await writeVersion(root, "2.0.0");
  await git(root, "add", ".");
  await git(root, "commit", "-m", "fixture base");
  await git(root, "switch", "-c", "source");
  await writeVersion(root, sourceVersion);
  await git(root, "commit", "-am", "fixture source version");
  const source = (await git(root, "rev-parse", "HEAD")).stdout.trim();
  await git(root, "switch", "-c", "target", "HEAD^");
  await writeVersion(root, targetVersion);
  await git(root, "commit", "-am", "fixture target version");
  const target = (await git(root, "rev-parse", "HEAD")).stdout.trim();
  await git(root, "switch", "source");
  return { root, source, target };
}

async function prepare(f: Awaited<ReturnType<typeof fixture>>) {
  let authenticated: PreparedMerge | undefined;
  const result = await prepareMerge(f.root, f.target, "ort", async value => { authenticated = value; });
  assert.equal(result.status, "conflicts", "divergent release metadata must be resolved explicitly");
  assert.deepEqual(authenticated, { preMergeHead: f.source, targetOid: f.target, strategy: "ort" });
  assert.equal((await git(f.root, "rev-parse", "MERGE_HEAD")).stdout.trim(), f.target);
  return authenticated!;
}

function commit(root: string, version: string, prepared: PreparedMerge[] = []) {
  return commitAtomic(root, selected, "fix(integration): reconcile target version (v" + version + ")", "Implements", "MERGE-VERSION", policy, prepared);
}

test("authenticated target-first merge bumps the higher target canonical VERSION", async t => {
  const f = await fixture(t), prepared = await prepare(f);
  await writeVersion(f.root, "2.610.5");
  await commit(f.root, "2.610.5", [prepared]);
  assert.deepEqual((await git(f.root, "show", "-s", "--format=%P", "HEAD")).stdout.trim().split(" "), [f.source, f.target]);
  const evidence = await commitEvidence(f.root, f.source, { commit: policy } as ProjectPolicy, "MERGE-VERSION", [prepared]);
  assert.equal(evidence.phaseCommitsValid, true);
  assert.equal(evidence.preparedMergesValid, true);
  assert.equal(evidence.clean, true);
});

test("authenticated merge evidence accepts a higher target VERSION bump", async t => {
  const f = await fixture(t), prepared = await prepare(f);
  await writeVersion(f.root, "2.610.5");
  await git(f.root, "add", "--", ...selected);
  await git(f.root, "commit", "-m", "fix(integration): reconcile target version (v2.610.5)", "-m", "Implements: MERGE-VERSION");
  const evidence = await commitEvidence(f.root, f.source, { commit: policy } as ProjectPolicy, "MERGE-VERSION", [prepared]);
  assert.equal(evidence.phaseCommitsValid, true);
  assert.equal(evidence.preparedMergesValid, true);
});

test("authenticated merge uses the source VERSION when it is higher", async t => {
  const f = await fixture(t, "2.610.4", "2.550.3"), prepared = await prepare(f);
  await writeVersion(f.root, "2.610.5");
  await commit(f.root, "2.610.5", [prepared]);
  assert.equal((await git(f.root, "show", "HEAD:VERSION")).stdout.trim(), "2.610.5");
});

for (const version of ["2.550.4", "2.610.6"]) {
  test("authenticated merge rejects rollback or skipped bump " + version, async t => {
    const f = await fixture(t), prepared = await prepare(f);
    await writeVersion(f.root, version);
    await assert.rejects(() => commit(f.root, version, [prepared]), /preflight/);
    assert.equal((await git(f.root, "rev-parse", "HEAD")).stdout.trim(), f.source);
    assert.equal((await git(f.root, "rev-parse", "MERGE_HEAD")).stdout.trim(), f.target);
  });
}

test("merge without authenticated parent binding remains rejected", async t => {
  const f = await fixture(t);
  await prepare(f);
  // This satisfies the old first-parent rule; absent authority must still refuse it.
  await writeVersion(f.root, "2.550.4");
  await assert.rejects(() => commit(f.root, "2.550.4"), /preflight/);
  assert.equal((await git(f.root, "rev-parse", "HEAD")).stdout.trim(), f.source);
});

test("merge authority for a different actual parent remains rejected", async t => {
  const f = await fixture(t), prepared = await prepare(f);
  await writeVersion(f.root, "2.610.5");
  await assert.rejects(() => commit(f.root, "2.610.5", [{ ...prepared, targetOid: f.source }]), /preflight/);
  assert.equal((await git(f.root, "rev-parse", "HEAD")).stdout.trim(), f.source);
});

test("authenticated merge rejects invalid incoming canonical VERSION", async t => {
  const f = await fixture(t, "2.550.3", "invalid"), prepared = await prepare(f);
  await writeVersion(f.root, "2.550.4");
  await assert.rejects(() => commit(f.root, "2.550.4", [prepared]), /preflight/);
  assert.equal((await git(f.root, "rev-parse", "HEAD")).stdout.trim(), f.source);
});

test("ordinary commit retains its first-parent bump despite a higher unrelated branch", async t => {
  const f = await fixture(t);
  await writeVersion(f.root, "2.550.4");
  await commit(f.root, "2.550.4");
  assert.deepEqual((await git(f.root, "show", "-s", "--format=%P", "HEAD")).stdout.trim().split(" "), [f.source]);
});

test("ordinary commit cannot jump to an unrelated higher branch VERSION", async t => {
  const f = await fixture(t);
  await writeVersion(f.root, "2.610.5");
  await assert.rejects(() => commit(f.root, "2.610.5"), /preflight/);
  assert.equal((await git(f.root, "rev-parse", "HEAD")).stdout.trim(), f.source);
});
