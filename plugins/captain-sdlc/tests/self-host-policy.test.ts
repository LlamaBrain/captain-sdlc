import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LifecycleStore } from "../src/lifecycle.js";
import { captainBegin, captainIssueIntent } from "../src/server.js";
import { commitAtomic, commitEvidence, git, loadPolicy } from "../src/workspace.js";

const pluginRoot = "plugins/captain-sdlc";
const releasePaths = [
  `${pluginRoot}/package.json`, `${pluginRoot}/package-lock.json`,
  `${pluginRoot}/.codex-plugin/plugin.json`, `${pluginRoot}/src/server.ts`,
  `${pluginRoot}/CHANGELOG.md`,
];
const sourceRoot = fileURLToPath(new URL("../../../", import.meta.url));

async function copyReferencedCommitPolicy(project: string, shippedPolicy: string) {
  const policy = JSON.parse(shippedPolicy);
  let commitPolicy = policy.commit;
  if (policy.commitPolicyPath) {
    const target = path.join(project, policy.commitPolicyPath), text = await readFile(path.join(sourceRoot, policy.commitPolicyPath), "utf8");
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, text);
    commitPolicy = JSON.parse(text).commit;
  }
  if (commitPolicy?.bookkeeping?.path_file) {
    const relative = commitPolicy.bookkeeping.path_file, target = path.join(project, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, await readFile(path.join(sourceRoot, relative)));
  }
}

async function shippedRepository(t: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), "captain-self-host-config-"));
  t.after(async () => {
    assert.equal(path.dirname(root), path.resolve(tmpdir()));
    assert.ok(path.basename(root).startsWith("captain-self-host-config-"));
    await rm(root, { recursive: true, force: true });
  });
  const project = path.join(root, "project");
  await mkdir(path.join(project, ".captain-sdlc"), { recursive: true });
  const shippedPolicy = await readFile(path.join(sourceRoot, ".captain-sdlc/codex-policy.json"), "utf8");
  await writeFile(path.join(project, ".captain-sdlc/codex-policy.json"), shippedPolicy);
  await copyReferencedCommitPolicy(project, shippedPolicy);
  for (const relative of releasePaths) {
    await mkdir(path.dirname(path.join(project, relative)), { recursive: true });
    await writeFile(path.join(project, relative), await readFile(path.join(sourceRoot, relative)));
  }
  await writeFile(path.join(project, ".gitignore"), (await readFile(path.join(sourceRoot, ".gitignore"), "utf8")) + "\n.captain-sdlc/worktrees/\n");
  await git(["init", "-b", "main"], project);
  await git(["config", "user.name", "Captain Fixture"], project);
  await git(["config", "user.email", "captain@example.invalid"], project);
  await git(["add", "."], project);
  await git(["commit", "-m", "fixture shipped plugin configuration"], project);
  const baseHead = await git(["rev-parse", "HEAD"], project);
  return { root, project, shippedPolicy, baseHead };
}

async function patchRelease(project: string) {
  const packageFile = path.join(project, `${pluginRoot}/package.json`);
  const previous = JSON.parse(await readFile(packageFile, "utf8")).version as string;
  const components = previous.split(".").map(Number);
  assert.equal(components.length, 3);
  const next = `${components[0]}.${components[1]}.${components[2] + 1}`;
  for (const relative of releasePaths.slice(0, 3)) {
    const file = path.join(project, relative), value = JSON.parse(await readFile(file, "utf8"));
    value.version = next;
    if (relative.endsWith("package-lock.json")) value.packages[""].version = next;
    await writeFile(file, JSON.stringify(value, null, 2) + "\n");
  }
  const serverFile = path.join(project, `${pluginRoot}/src/server.ts`);
  const server = await readFile(serverFile, "utf8"), marker = `new McpServer({ name: "captain-sdlc", version: "${previous}" })`;
  assert.equal(server.split(marker).length, 2, "fixture must update the actual server release literal exactly once");
  await writeFile(serverFile, server.replace(marker, `new McpServer({ name: "captain-sdlc", version: "${next}" })`));
  const changelogFile = path.join(project, `${pluginRoot}/CHANGELOG.md`);
  await writeFile(changelogFile, `# Changelog\n\n## ${next}\n- Fixture synchronized plugin patch.\n` + (await readFile(changelogFile, "utf8")).replace(/^# Changelog\s*/, "\n"));
  return { previous, next };
}

test("the shipped Captain policy captures actual plugin version and changelog locations", async t => {
  const fixture = await shippedRepository(t);
  const policy = await loadPolicy(fixture.project, fixture.baseHead);
  assert.equal(policy.commit?.version_file, `${pluginRoot}/package.json`, "self-host policy must configure the existing canonical plugin release file");
  assert.deepEqual(policy.commit.changelog_files, [`${pluginRoot}/CHANGELOG.md`]);
  assert.deepEqual(policy.commit.version_surfaces?.map(surface => surface.path).sort(), releasePaths.slice(0, 4).sort());
  assert.equal(policy.commit.conventional, true);
  assert.equal(policy.commit.require_version_suffix, true);
  assert.deepEqual(policy.commands, JSON.parse(fixture.shippedPolicy).commands);
  assert.equal(policy.profile, "feature");
  assert.equal(policy.visualRequired, false);
});

test("the shipped Captain policy preflights a synchronized plugin patch without root release files", async t => {
  const fixture = await shippedRepository(t), policy = await loadPolicy(fixture.project, fixture.baseHead);
  for (const missing of ["VERSION", "CHANGELOG.md"]) await assert.rejects(access(path.join(fixture.project, missing)), { code: "ENOENT" });
  const { next } = await patchRelease(fixture.project);
  const prepared = await commitAtomic(fixture.project, releasePaths, `fix(config): synchronized plugin patch (v${next})`, "Implements", "CAP-SELF-HOST-CONFIG", policy.commit);
  assert.equal(prepared.preCommitHead, fixture.baseHead);
  const evidence = await commitEvidence(fixture.project, fixture.baseHead, policy, "CAP-SELF-HOST-CONFIG");
  assert.equal(evidence.head, prepared.candidate);
  assert.equal(evidence.clean, true);
  assert.equal(evidence.versionChanged, true);
  assert.equal(evidence.changelogChanged, true);
  assert.equal(evidence.versionSurfacesValid, true);
  assert.equal(evidence.phaseCommitsValid, true);
  assert.equal(evidence.commitCount, 1);
});

test("a captured self-host run keeps its committed policy after live replacement", async t => {
  const fixture = await shippedRepository(t);
  const store = new LifecycleStore(path.join(fixture.root, "authority"));
  const issued = await captainIssueIntent(store, { session_id: "self-host-config-freeze", turn_id: "start", project_root: fixture.project, prompt: "implement the bounded self-host configuration fixture", action: "start" });
  const run = await captainBegin(store, { intent_id: issued.intent_id, project_root: fixture.project, objective: "bounded configuration fixture" });
  const captured = JSON.parse(JSON.stringify(run.policy));
  const altered = JSON.parse(fixture.shippedPolicy);
  delete altered.commitPolicyPath;
  altered.commit = { conventional: true, require_version_suffix: true, version_file: "PWNED", version_surfaces: [{ path: "PWNED", pattern: "(?m)^(?<version>[0-9]+\\.[0-9]+\\.[0-9]+)\\s*$" }], changelog_files: ["PWNED_CHANGELOG"] };
  altered.commands.ticket = "untrusted replacement";
  await writeFile(path.join(run.worktreePath, ".captain-sdlc/codex-policy.json"), JSON.stringify(altered));
  assert.deepEqual((await store.status(issued.intent_id)).policy, captured, "existing signed run policy must not be switched by changed working-tree configuration");
  assert.deepEqual(await loadPolicy(run.worktreePath, run.baseHead), captured, "trusted policy remains bound to the committed base");
});

test("the shipped Captain policy can begin and record a failing ticket without manual bootstrap repair", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "captain-self-host-"));
  const project = path.join(root, "project");
  await mkdir(path.join(project, ".captain-sdlc"), { recursive: true });
  const policyPath = fileURLToPath(new URL("../../../.captain-sdlc/codex-policy.json", import.meta.url));
  const shippedPolicy = await readFile(policyPath, "utf8");
  await writeFile(path.join(project, ".captain-sdlc", "codex-policy.json"), shippedPolicy);
  await copyReferencedCommitPolicy(project, shippedPolicy);
  await writeFile(path.join(project, ".gitignore"), (await readFile(path.join(sourceRoot, ".gitignore"), "utf8")) + "\n.captain-sdlc/worktrees/\n");
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
