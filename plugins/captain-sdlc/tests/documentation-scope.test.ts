import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LifecycleStore, type ProjectPolicy } from "../src/lifecycle.js";
import { readAuthorized, writeAuthorized } from "../src/authority.js";
import { commitEvidence, git, sourceState } from "../src/workspace.js";

const capturedPolicy = {
  profile: "feature" as const, visualRequired: false,
  commands: { build: "trusted-build", ticket: "trusted-ticket", "feature-smoke": "trusted-smoke", "affected-regression": "trusted-regression" },
  artifactPaths: { build: ".captain-proof/build.zip", smoke: ".captain-proof/smoke.json" },
  redGate: { expectedExitCodes: [1], outputPattern: "expected test failure" },
  commit: { conventional: true, require_version_suffix: true, version_file: "VERSION", version_surfaces: [{ path: "VERSION", pattern: "(?m)^(?<version>[0-9]+\\.[0-9]+\\.[0-9]+)\\s*$" }], changelog_files: ["CHANGELOG.md"] }
};

const lockfile = (version: string, dependencyVersion = "1.0.0") => ({ name: "documentation-fixture", version, lockfileVersion: 3, packages: { "": { name: "documentation-fixture", version }, "node_modules/dependency": { version: dependencyVersion, integrity: "sha512-fixed" } } });
const bundle = (version: string, behavior = 1) => `const metadata = { version: "${version}" };\nexport const behavior = ${behavior};\n`;
const fragmentHash = createHash("sha256").update(["captain-fixture", "docs"].join(String.fromCharCode(0))).digest("hex").slice(0, 12);
const fragmentPath = `changelog/changes/2026-10-28-documentation-${fragmentHash}.md`;
const fragment = (id = "docs", branch = "captain/documentation") => "# Documentation changes\n\n<!-- captain-changes:v1 -->\n```json\n" + JSON.stringify({ schema_version: 1, audience: "developer", project: "captain-fixture", id, source_branch: branch }) + "\n```\n";
async function fixture(releaseMetadata = false, existingArchive = false, generatedTail = "") {
  const root = await mkdtemp(path.join(tmpdir(), "captain-documentation-"));
  const data = await mkdtemp(path.join(tmpdir(), "captain-documentation-state-"));
  await git(["init"], root); await git(["config", "user.name", "Captain Test"], root); await git(["config", "user.email", "captain@example.invalid"], root);
  await writeFile(path.join(root, "README.md"), "# Original documentation\n");
  await writeFile(path.join(root, "CHANGELOG.md"), "# Changelog\n\n## [0.1.0]\n\n- Initial.\n");
  await writeFile(path.join(root, "VERSION"), "0.1.0\n");
  await writeFile(path.join(root, ".gitignore"), ".captain-sdlc/worktrees/\n.captain-proof/\n*.ignored.ts\n");
  await mkdir(path.join(root, "src")); await writeFile(path.join(root, "src", "program.ts"), "export const behavior = 1;\n");
  if (existingArchive) { await mkdir(path.dirname(path.join(root, fragmentPath)), { recursive: true }); await writeFile(path.join(root, fragmentPath), fragment()); }
  const policy: ProjectPolicy = structuredClone(capturedPolicy);
  if (releaseMetadata) {
    await writeFile(path.join(root, "src", "version.ts"), 'export const metadata = { version: "0.1.0", behavior: 1 };\n');
    await writeFile(path.join(root, "package-lock.json"), JSON.stringify(lockfile("0.1.0"), null, 2) + "\n");
    await mkdir(path.join(root, "dist")); await writeFile(path.join(root, "dist", "server.js"), bundle("0.1.0") + generatedTail);
    policy.commit!.version_surfaces!.push({ path: "src/version.ts", pattern: 'version: "(?<version>[0-9]+\\.[0-9]+\\.[0-9]+)"' }, { path: "package-lock.json", pattern: '(?m)^  "version": "(?<version>[0-9]+\\.[0-9]+\\.[0-9]+)"' });
    policy.outputRetention = { schema_version: 1, roots: { build: ["dist"] } };
  }
  await mkdir(path.join(root, ".captain-sdlc")); await writeFile(path.join(root, ".captain-sdlc", "codex-policy.json"), JSON.stringify(policy));
  await git(["add", "."], root); await git(["commit", "-m", "baseline"], root);
  const baseHead = await git(["rev-parse", "HEAD"], root), worktree = path.join(root, ".captain-sdlc", "worktrees", "documentation");
  await git(["worktree", "add", "-b", "captain/documentation", worktree, baseHead], root);
  const state = await sourceState(worktree), commands: string[] = [];
  const store = new LifecycleStore(data, async (command, cwd) => {
    commands.push(command);
    await mkdir(path.join(cwd, ".captain-proof"), { recursive: true });
    if (command === "trusted-build") await writeFile(path.join(cwd, ".captain-proof", "build.zip"), "trusted build output");
    if (command === "trusted-smoke") await writeFile(path.join(cwd, ".captain-proof", "smoke.json"), "trusted smoke output");
    return { exitCode: 0, stdout: "pass", stderr: "" };
  }, sourceState);
  await store.markIntent({ intentId: "docs", sessionId: "session", turnId: "turn", projectRoot: root, prompt: "Update the documentation" });
  const initial = await store.begin({ intentId: "docs", objective: "Update the documentation", projectRoot: root, worktreePath: worktree, baseHead, branch: state.branch!, commonGitDir: state.commonGitDir!, gitDir: state.gitDir!, policy });
  const write = async (relative: string, content: string) => { await mkdir(path.dirname(path.join(worktree, relative)), { recursive: true }); await writeFile(path.join(worktree, relative), content); };
  const prepare = (paths = ["README.md"], reason = "Documentation-only requirements and operator guidance", expectedHead = baseHead) => (store as any).prepareDocumentation("docs", paths, reason, expectedHead);
  const commit = async (withCode = false) => {
    await write("VERSION", "0.1.1\n"); await write("CHANGELOG.md", "# Changelog\n\n## [0.1.1]\n\n- Clarify documentation.\n\n## [0.1.0]\n\n- Initial.\n");
    if (withCode) await write("src/program.ts", "export const behavior = 99;\n");
    await git(["add", "."], worktree); await git(["commit", "-m", "docs: clarify operator guidance (v0.1.1)"], worktree);
    return commitEvidence(worktree, baseHead, policy);
  };
  return { root, data, worktree, baseHead, store, initial, policy, commands, write, prepare, commit };
}

test("documentation-only tasks have an audited transition without fabricating a failing code test", () => {
  assert.equal(typeof (LifecycleStore.prototype as any).prepareDocumentation, "function",
    "Captain must expose a guarded documentation-only transition for an existing run");
});

test("documentation transition preserves captured policy and identity with signed scope instead of red evidence", async () => {
  const f = await fixture(); await f.write("README.md", "# Updated operator guidance\n");
  assert.equal(f.initial.schemaVersion, 1, "ordinary implementation runs retain the existing schema");
  const run = await f.prepare();
  assert.equal(run.schemaVersion, 2, "documentation authority must fence older runtimes that cannot enforce its scope");
  assert.equal(run.phase, "implement"); assert.deepEqual(run.policy, f.initial.policy);
  for (const key of ["intentId", "runId", "sessionId", "turnId", "worktreePath", "branch", "baseHead", "commonGitDir", "gitDir"]) assert.equal(run[key], (f.initial as any)[key], key);
  assert.equal(run.documentationScope.schemaVersion, 1); assert.deepEqual(run.documentationScope.paths, ["README.md"]);
  assert.equal(run.documentationScope.expectedHead, f.baseHead); assert.match(run.documentationScope.reason, /Documentation-only/);
  assert.equal(run.evidence.some((item: any) => item.kind === "tdd_red"), false);
  assert.deepEqual(f.commands, [], "classification cannot manufacture command evidence");
  const persisted = await readAuthorized<any>(f.data, "runs", "docs");
  assert.deepEqual(persisted.documentationScope, run.documentationScope);
});

test("actual authoritative hook readers accept an audited documentation schema transition", async () => {
  const f = await fixture(), hooks = await import(new URL("../scripts/authoritative-state.mjs", import.meta.url).href);
  assert.equal((await hooks.latestRun(f.data, "docs")).schemaVersion, 1);
  assert.equal((await hooks.validPermit(f.data, "session", "turn")).run.runId, f.initial.runId);
  await f.write("README.md", "# Updated documentation\n"); const classified = await f.prepare();
  assert.equal(classified.schemaVersion, 2);
  assert.equal((await hooks.latestRun(f.data, "docs")).schemaVersion, 2);
  const permit = await hooks.validPermit(f.data, "session", "turn");
  assert.equal(permit.run.runId, classified.runId); assert.equal(permit.permit.phase, "implement");
});

async function appendSignedRevision(data: string, run: { revision: number }, changes: Record<string, unknown>) {
  const previous = await readAuthorized<any>(data, "run-revisions", `docs-${run.revision}`);
  const next = { ...previous, ...changes, revision: previous.revision + 1, previousRevisionSha256: createHash("sha256").update(JSON.stringify(previous)).digest("hex") };
  await writeAuthorized(data, "run-revisions", `docs-${next.revision}`, next);
  await writeRunWatermark(data, next);
}

async function writeRunWatermark(data: string, run: any) {
  await writeAuthorized(data, "run-watermarks", `docs-${run.revision}`, { schemaVersion: 1, intentId: run.intentId, runId: run.runId, revision: run.revision, runSha256: createHash("sha256").update(JSON.stringify(run)).digest("hex"), previousRevisionSha256: run.previousRevisionSha256 });
}

test("actual authoritative hook readers retain ordinary schema-one implementation runs", async () => {
  const f = await fixture(), hooks = await import(new URL("../scripts/authoritative-state.mjs", import.meta.url).href);
  const store = new LifecycleStore(f.data, async () => ({ exitCode: 1, stdout: "expected test failure", stderr: "" }), sourceState);
  const run = await store.recordRed("docs"); assert.equal(run.schemaVersion, 1);
  assert.equal((await hooks.latestRun(f.data, "docs")).phase, "implement");
  assert.equal((await hooks.validPermit(f.data, "session", "turn")).run.schemaVersion, 1);
});

test("actual authoritative hook readers reject a correctly signed initial schema-two record", async () => {
  const f = await fixture(), hooks = await import(new URL("../scripts/authoritative-state.mjs", import.meta.url).href);
  const initial = await readAuthorized<any>(f.data, "run-revisions", "docs-0"), forged = { ...initial, schemaVersion: 2 };
  await writeAuthorized(f.data, "run-revisions", "docs-0", forged); await writeRunWatermark(f.data, forged);
  await assert.rejects(() => hooks.latestRun(f.data, "docs"), /schema|documentation|initial/i);
  await assert.rejects(() => hooks.validPermit(f.data, "session", "turn"), /schema|documentation|initial/i);
});

test("actual authoritative hook readers reject schema migration without audited documentation authority", async () => {
  const f = await fixture(), hooks = await import(new URL("../scripts/authoritative-state.mjs", import.meta.url).href);
  await appendSignedRevision(f.data, f.initial, { schemaVersion: 2, phase: "implement" });
  await assert.rejects(() => hooks.latestRun(f.data, "docs"), /schema|documentation/i);
  await assert.rejects(() => hooks.validPermit(f.data, "session", "turn"), /schema|documentation/i);
});

test("actual authoritative hook readers reject mutation of signed documentation scope", async () => {
  const f = await fixture(), hooks = await import(new URL("../scripts/authoritative-state.mjs", import.meta.url).href);
  await f.write("README.md", "# Updated\n"); const classified = await f.prepare();
  await appendSignedRevision(f.data, classified, { documentationScope: { ...classified.documentationScope, reason: "Unapproved replacement scope" } });
  await assert.rejects(() => hooks.latestRun(f.data, "docs"), /scope|documentation/i);
  await assert.rejects(() => hooks.validPermit(f.data, "session", "turn"), /scope|documentation/i);
});

function actualHook(script: string, input: object, data: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL(`../scripts/${script}`, import.meta.url))], { windowsHide: true, env: { ...process.env, PLUGIN_DATA: data, CAPTAIN_PLUGIN_DATA: data }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = ""; child.stdout.on("data", chunk => stdout += chunk); child.stderr.on("data", chunk => stderr += chunk);
    child.on("error", reject); child.on("exit", code => code === 0 ? resolve(stdout) : reject(new Error(`actual hook exited ${code}: ${stderr}`)));
    child.stdin.end(JSON.stringify(input));
  });
}

test("actual mutation hook permits owned documentation edits after audited schema migration", async () => {
  const f = await fixture(); await f.write("README.md", "# Updated\n"); await f.prepare();
  const governance = await import(new URL("../scripts/governed-repository.mjs", import.meta.url).href);
  assert.equal(await governance.repositoryIsGoverned(f.worktree), true); assert.equal(await governance.repositoryUsesLowStrictness(f.worktree), false);
  const result = await actualHook("mutation-gate.mjs", { session_id: "session", turn_id: "turn", cwd: f.worktree, tool_name: "Write", tool_input: { file_path: path.join(f.worktree, "README.md") } }, f.data);
  assert.equal(result, "", "a lawful classified run must not be mistaken for a missing permit");
});

test("actual completion hook recognizes fully proved documentation runs", async () => {
  const f = await fixture(); await f.write("README.md", "# Updated\n"); await f.prepare();
  await f.store.recordCommit("docs", await f.commit()); const complete = await f.store.prove("docs"); assert.equal(complete.status, "green");
  const result = await actualHook("completion-gate.mjs", { session_id: "session", turn_id: "turn", cwd: f.worktree }, f.data);
  assert.equal(result, "", "a green signed documentation run must pass the actual completion hook");
});

test("a signed documentation run cannot roll back its schema to an older unenforcing runtime format", async () => {
  const f = await fixture(); await f.write("README.md", "# Updated\n"); const run = await f.prepare();
  await appendSignedRevision(f.data, run, { schemaVersion: 1 });
  await assert.rejects(() => f.store.status("docs"), /schema|immutable|documentation/i);
});

test("ordinary runs cannot acquire the documentation schema without the audited classification transition", async () => {
  const f = await fixture();
  await appendSignedRevision(f.data, f.initial, { schemaVersion: 2, phase: "implement" });
  await assert.rejects(() => f.store.status("docs"), /schema|immutable|documentation/i);
});

test("documentation transition requires the complete exact dirty set", async () => {
  const f = await fixture(); await f.write("README.md", "# Updated\n"); await f.write("ADR/review.md", "# Review authority\n");
  await assert.rejects(() => f.prepare(["README.md"]));
  await assert.rejects(() => f.prepare(["README.md", "ADR"]));
  await assert.rejects(() => f.prepare(["README.md", "ADR/review.md", "README.md"]));
  const run = await f.prepare(["ADR/review.md", "README.md"]);
  assert.deepEqual([...run.documentationScope.paths].sort(), ["ADR/review.md", "README.md"]);
});

test("clean documentation tasks can authorize an existing document before their first edit", async () => {
  const f = await fixture(); assert.equal((await sourceState(f.worktree)).status, "");
  const run = await f.prepare(["README.md"]);
  assert.equal(run.phase, "implement"); assert.deepEqual(run.documentationScope.paths, ["README.md"]);
  await f.write("README.md", "# Authorized operator guidance\n");
  await f.store.reserveCommitOperation("docs", { paths: ["README.md"], subject: "docs: clarify guidance (v0.1.1)", final: true });
  assert.equal((await f.store.status("docs")).evidence.some(item => item.kind === "tdd_red"), false);
});

test("clean documentation tasks can authorize a planned document whose directories do not exist", async () => {
  const f = await fixture(); assert.equal((await sourceState(f.worktree)).status, "");
  const run = await f.prepare(["docs/New.md"]);
  assert.equal(run.phase, "implement"); assert.deepEqual(run.documentationScope.paths, ["docs/New.md"]);
  await f.write("docs/New.md", "# Newly authorized documentation\n");
  await f.store.reserveCommitOperation("docs", { paths: ["docs/New.md"], subject: "docs: add guidance (v0.1.1)", final: true });
});

test("clean predeclared documentation cannot authorize planned executable or control-plane files", async () => {
  const f = await fixture();
  for (const relative of ["src/new.ts", "AGENTS.md", ".github/README.md", "skills/new/SKILL.md"]) await assert.rejects(() => f.prepare([relative]), relative);
  assert.equal((await f.store.status("docs")).phase, "tdd_red");
});

test("planned documentation cannot traverse a linked ancestor even when the leaf is missing", async t => {
  const f = await fixture(), target = path.join(f.root, "outside-docs"); await mkdir(target);
  try { await symlink(target, path.join(f.worktree, "docs"), process.platform === "win32" ? "junction" : "dir"); }
  catch (error: any) { if (process.platform === "win32" && ["EPERM", "EACCES"].includes(error.code)) { t.skip("Windows does not grant junction creation to this test process"); return; } throw error; }
  await assert.rejects(() => f.prepare(["docs/New.md"]));
});

test("documentation transition replays exactly and rejects changed authorization", async () => {
  const f = await fixture(); await f.write("README.md", "# Updated\n");
  const first = await f.prepare(), replay = await f.prepare();
  assert.deepEqual(replay, first);
  await assert.rejects(() => f.prepare(["README.md"], "Different justification"));
  await assert.rejects(() => f.prepare(["README.md", "CHANGELOG.md"]));
  assert.deepEqual((await f.store.status("docs") as any).documentationScope, first.documentationScope);
});

test("documentation transition rejects stale revision, empty justification and path escapes", async () => {
  const f = await fixture(); await f.write("README.md", "# Updated\n");
  await assert.rejects(() => f.prepare(["README.md"], "documentation", "f".repeat(40)));
  await assert.rejects(() => f.prepare(["README.md"], "  "));
  await assert.rejects(() => f.prepare(["../README.md"]));
  assert.equal((await f.store.status("docs")).phase, "tdd_red");
});

test("documentation transition rejects executable code and control-plane Markdown", async () => {
  for (const relative of ["src/program.ts", "AGENTS.md", ".github/README.md", "skills/review/SKILL.md", ".captain-sdlc/instructions.md"]) {
    const f = await fixture(); await f.write(relative, "# This file can change execution authority\n");
    await assert.rejects(() => f.prepare([relative]), `${relative} must not use the documentation transition`);
    assert.equal((await f.store.status("docs")).phase, "tdd_red");
  }
});

test("documentation classification rejects ignored executable inputs outside captured generated surfaces", async () => {
  const f = await fixture(); await f.write("README.md", "# Updated\n"); await f.write("src/injected.ignored.ts", "export const injected = true;\n");
  await git(["check-ignore", "--quiet", "src/injected.ignored.ts"], f.worktree);
  await assert.rejects(() => f.prepare());
  assert.equal((await f.store.status("docs")).phase, "tdd_red");
});

test("documentation scope rejects ignored executable inputs introduced after classification", async () => {
  const f = await fixture(); await f.write("README.md", "# Updated\n"); await f.prepare();
  await f.write("src/injected.ignored.ts", "export const injected = true;\n");
  await assert.rejects(() => f.store.reserveCommitOperation("docs", { paths: ["README.md"], subject: "docs: guidance (v0.1.1)", final: true }));
});

test("documentation transition refuses symbolic-link documentation", async t => {
  const f = await fixture(); await f.write("target.txt", "external contents\n");
  try { await symlink(path.join(f.worktree, "target.txt"), path.join(f.worktree, "linked.md"), "file"); }
  catch (error: any) { if (process.platform === "win32" && ["EPERM", "EACCES"].includes(error.code)) { t.skip("Windows does not grant symbolic-link creation to this test process"); return; } throw error; }
  await assert.rejects(() => f.prepare(["linked.md", "target.txt"]));
});

test("documentation transition refuses a staged symlink even where Git checks links out as ordinary files", async () => {
  const f = await fixture(); await f.write("linked.md", "src/program.ts");
  const blob = await git(["hash-object", "-w", "linked.md"], f.worktree);
  await git(["update-index", "--add", "--cacheinfo", "120000", blob, "linked.md"], f.worktree);
  await assert.rejects(() => f.prepare(["linked.md"]));
});

test("documentation transition accepts declarative schema documentation but rejects malformed schema JSON", async () => {
  const f = await fixture();
  await f.write("schemas/premerge-review-v1.schema.json", JSON.stringify({ $schema: "https://json-schema.org/draft/2020-12/schema", type: "object", properties: { schemaVersion: { const: 1 } } }));
  const run = await f.prepare(["schemas/premerge-review-v1.schema.json"]);
  assert.deepEqual(run.documentationScope.paths, ["schemas/premerge-review-v1.schema.json"]);
  const malformed = await fixture(); await malformed.write("schemas/premerge-review-v1.schema.json", "{ malformed");
  await assert.rejects(() => malformed.prepare(["schemas/premerge-review-v1.schema.json"]));
});

test("documentation classification cannot authorize later executable changes in a commit request", async () => {
  const f = await fixture(); await f.write("README.md", "# Updated\n"); await f.prepare();
  await f.write("src/program.ts", "export const behavior = 99;\n");
  await assert.rejects(() => f.store.reserveCommitOperation("docs", { paths: ["README.md", "src/program.ts"], subject: "docs: guidance (v0.1.1)", final: true }));
  assert.equal((await f.store.status("docs")).commitOperation, undefined);
});

test("documentation scope refuses newly executable Captain sequence content in a selected document", async () => {
  const f = await fixture(); await f.write("README.md", "# Updated\n"); await f.prepare();
  await f.write("README.md", "# Updated\n\n```captain-sequence\nschema_version: 1\nsteps:\n  - command: execute-unreviewed-code\n```\n");
  await assert.rejects(() => f.store.reserveCommitOperation("docs", { paths: ["README.md"], subject: "docs: guidance (v0.1.1)", final: true }));
});

test("documentation scope refuses staged executable mode on an otherwise selected Markdown file", async () => {
  const f = await fixture(); await f.write("README.md", "# Updated\n"); await f.prepare();
  await git(["update-index", "--chmod=+x", "README.md"], f.worktree);
  await assert.rejects(() => f.store.reserveCommitOperation("docs", { paths: ["README.md"], subject: "docs: guidance (v0.1.1)", final: true }));
});

test("documentation candidate authority inspects the candidate tree even when the current dirty scope is lawful", async () => {
  const f = await fixture(); await f.write("README.md", "# Updated\n"); await f.prepare();
  await f.write("VERSION", "0.1.1\n"); await f.write("CHANGELOG.md", "# Changelog\n\n## [0.1.1]\n\n- Clarify documentation.\n\n## [0.1.0]\n\n- Initial.\n");
  const request = { paths: ["README.md", "VERSION", "CHANGELOG.md"], subject: "docs: guidance (v0.1.1)", final: true };
  const operation = await f.store.acquireCommitOperation("docs", request);
  await f.write("src/program.ts", "export const behavior = 99;\n"); await git(["add", "."], f.worktree);
  const tree = await git(["write-tree"], f.worktree), candidate = await git(["commit-tree", tree, "-p", f.baseHead, "-m", request.subject], f.worktree);
  await git(["restore", "--source=HEAD", "--staged", "--worktree", "src/program.ts"], f.worktree);
  const prepared = { ...request, preCommitHead: f.baseHead, candidate, tree };
  await assert.rejects(async () => {
    await f.store.recordPreparedCommit("docs", prepared, operation);
    const run = await f.store.status("docs");
    await f.store.assertPreparedCommitAuthority("docs", prepared, run.commitOperation!);
  }, /documentation|scope/i);
  assert.equal(await git(["rev-parse", "HEAD"], f.worktree), f.baseHead, "the executable candidate must never become branch HEAD");
});

test("documentation commit reservation permits only the captured version token in executable metadata", async () => {
  const allowed = await fixture(true); await allowed.write("README.md", "# Updated\n"); await allowed.prepare();
  await allowed.write("VERSION", "0.1.1\n"); await allowed.write("src/version.ts", 'export const metadata = { version: "0.1.1", behavior: 1 };\n');
  await allowed.store.reserveCommitOperation("docs", { paths: ["README.md", "VERSION", "src/version.ts"], subject: "docs: guidance (v0.1.1)", final: true });
  const blocked = await fixture(true); await blocked.write("README.md", "# Updated\n"); await blocked.prepare();
  await blocked.write("VERSION", "0.1.1\n"); await blocked.write("src/version.ts", 'export const metadata = { version: "0.1.1", behavior: 99 };\n');
  await assert.rejects(() => blocked.store.reserveCommitOperation("docs", { paths: ["README.md", "VERSION", "src/version.ts"], subject: "docs: guidance (v0.1.1)", final: true }));
});

test("documentation version-only source updates tolerate Git LF versus working-tree CRLF", async () => {
  const f = await fixture(true); await f.write("README.md", "# Updated\n"); await f.prepare();
  await f.write("VERSION", "0.1.1\r\n"); await f.write("src/version.ts", 'export const metadata = { version: "0.1.1", behavior: 1 };\r\n');
  await f.store.reserveCommitOperation("docs", { paths: ["README.md", "VERSION", "src/version.ts"], subject: "docs: guidance (v0.1.1)", final: true });
});

test("documentation commit reservation permits own lockfile version updates but refuses dependency changes", async () => {
  const allowed = await fixture(true); await allowed.write("README.md", "# Updated\n"); await allowed.prepare();
  await allowed.write("VERSION", "0.1.1\n"); await allowed.write("package-lock.json", JSON.stringify(lockfile("0.1.1"), null, 2) + "\n");
  await allowed.store.reserveCommitOperation("docs", { paths: ["README.md", "VERSION", "package-lock.json"], subject: "docs: guidance (v0.1.1)", final: true });
  const blocked = await fixture(true); await blocked.write("README.md", "# Updated\n"); await blocked.prepare();
  await blocked.write("VERSION", "0.1.1\n"); await blocked.write("package-lock.json", JSON.stringify(lockfile("0.1.1", "9.0.0"), null, 2) + "\n");
  await assert.rejects(() => blocked.store.reserveCommitOperation("docs", { paths: ["README.md", "VERSION", "package-lock.json"], subject: "docs: guidance (v0.1.1)", final: true }));
});

test("documentation commit reservation permits existing generated version metadata without granting output-root code authority", async () => {
  const allowed = await fixture(true); await allowed.write("README.md", "# Updated\n"); await allowed.prepare();
  await allowed.write("VERSION", "0.1.1\n"); await allowed.write("dist/server.js", bundle("0.1.1"));
  await allowed.store.reserveCommitOperation("docs", { paths: ["README.md", "VERSION", "dist/server.js"], subject: "docs: guidance (v0.1.1)", final: true });
  const blocked = await fixture(true); await blocked.write("README.md", "# Updated\n"); await blocked.prepare();
  await blocked.write("VERSION", "0.1.1\n"); await blocked.write("dist/server.js", bundle("0.1.1", 99));
  await assert.rejects(() => blocked.store.reserveCommitOperation("docs", { paths: ["README.md", "VERSION", "dist/server.js"], subject: "docs: guidance (v0.1.1)", final: true }));
});

test("generated documentation version propagation preserves unrelated dependency versions and rejects ambiguous canonical metadata", async () => {
  const dependency = 'const dependency = { version: "9.8.7" };\n';
  const allowed = await fixture(true, false, dependency); await allowed.write("README.md", "# Updated\n"); await allowed.prepare();
  await allowed.write("VERSION", "0.1.1\n"); await allowed.write("dist/server.js", bundle("0.1.1") + dependency);
  await allowed.store.reserveCommitOperation("docs", { paths: ["README.md", "VERSION", "dist/server.js"], subject: "docs: guidance (v0.1.1)", final: true });
  const blocked = await fixture(true, false, 'const duplicate = { version: "0.1.0" };\n'); await blocked.write("README.md", "# Updated\n"); await blocked.prepare();
  await blocked.write("VERSION", "0.1.1\n"); await blocked.write("dist/server.js", bundle("0.1.1") + 'const duplicate = { version: "0.1.1" };\n');
  await assert.rejects(() => blocked.store.reserveCommitOperation("docs", { paths: ["README.md", "VERSION", "dist/server.js"], subject: "docs: guidance (v0.1.1)", final: true }));
});

test("documentation scope accepts a new retained changelog fragment with matching task and branch provenance", async () => {
  const f = await fixture(); await f.write("README.md", "# Updated\n"); await f.prepare();
  await f.write(fragmentPath, fragment());
  await f.store.reserveCommitOperation("docs", { paths: ["README.md", fragmentPath], subject: "docs: guidance (v0.1.1)", final: true });
});

test("documentation scope rejects new changelog fragments owned by another task or branch", async () => {
  for (const content of [fragment("foreign-task"), fragment("docs", "captain/foreign")]) {
    const f = await fixture(); await f.write("README.md", "# Updated\n"); await f.prepare(); await f.write(fragmentPath, content);
    await assert.rejects(() => f.store.reserveCommitOperation("docs", { paths: ["README.md", fragmentPath], subject: "docs: guidance (v0.1.1)", final: true }));
  }
});

test("documentation release allowance cannot rewrite an existing retained changelog fragment", async () => {
  const f = await fixture(false, true); await f.write("README.md", "# Updated\n"); await f.prepare();
  await f.write(fragmentPath, fragment() + "\nRewritten historical information.\n");
  await assert.rejects(() => f.store.reserveCommitOperation("docs", { paths: ["README.md", fragmentPath], subject: "docs: guidance (v0.1.1)", final: true }));
});

test("documentation classification rejects executable history through direct commit recording", async () => {
  const f = await fixture(); await f.write("README.md", "# Updated\n"); await f.prepare();
  const evidence = await f.commit(true);
  await assert.rejects(() => f.store.recordCommit("docs", evidence));
  assert.equal((await f.store.status("docs")).phase, "implement");
});

test("documentation commits retain all captured proof gates and version requirements", async () => {
  const f = await fixture(); await f.write("README.md", "# Updated\n"); await f.prepare();
  const evidence = await f.commit(); await f.store.recordCommit("docs", evidence);
  const run = await f.store.prove("docs");
  assert.equal(run.status, "green"); assert.equal(run.phase, "complete");
  assert.deepEqual(f.commands, ["trusted-build", "trusted-ticket", "trusted-smoke", "trusted-regression"]);
  assert.deepEqual(run.policy, f.initial.policy); assert.equal(run.evidence.some(item => item.kind === "tdd_red"), false);
});

test("documentation proof cannot accept an executable edit after the recorded commit", async () => {
  const f = await fixture(); await f.write("README.md", "# Updated\n"); await f.prepare();
  await f.store.recordCommit("docs", await f.commit()); await f.write("src/program.ts", "export const behavior = 99;\n");
  await assert.rejects(() => f.store.prove("docs"));
  assert.equal((await f.store.status("docs")).status === "green", false); assert.deepEqual(f.commands, []);
});
