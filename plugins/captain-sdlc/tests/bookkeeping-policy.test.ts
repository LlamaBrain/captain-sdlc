import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import * as workspace from "../src/workspace.js";
import { LifecycleStore, type CommitPolicy } from "../src/lifecycle.js";

const exec = promisify(execFile);
const git = async (cwd: string, ...args: string[]) => (await exec("git", args, { cwd, windowsHide: true })).stdout.trim();
const rules = "# Captain operational records\n/.captain-sdlc/notebook/\n/.captain-sdlc/handoffs/\n/.captain-sdlc/closeouts/\n/.captain-sdlc/evidence/\n/Churn/\n";
function policy(): CommitPolicy { return { conventional: true, require_version_suffix: true, require_task_trailer: true, version_file: "VERSION", version_surfaces: [{ path: "VERSION", pattern: "(?m)^(?<version>[0-9]+\\.[0-9]+\\.[0-9]+)\\s*$" }], changelog_files: ["CHANGELOG.md"], bookkeeping: { path_file: ".captain-sdlc/captain.ignore" } } as any; }
async function put(cwd: string, relative: string, content: string | Buffer) { await mkdir(path.dirname(path.join(cwd, relative)), { recursive: true }); await writeFile(path.join(cwd, relative), content); }
async function fixture(t: TestContext, patterns = rules) {
  const root = await mkdtemp(path.join(tmpdir(), "captain-bookkeeping-"));
  t.after(async () => { assert.equal(path.dirname(root), path.resolve(tmpdir())); assert.ok(path.basename(root).startsWith("captain-bookkeeping-")); await rm(root, { recursive: true, force: true }); });
  await git(root, "init", "-b", "main"); await git(root, "config", "user.name", "Captain Test"); await git(root, "config", "user.email", "captain@example.invalid"); await git(root, "config", "core.autocrlf", "false");
  const configured = policy();
  await put(root, ".captain-sdlc/codex-policy.json", JSON.stringify({ profile: "low", visualRequired: false, commands: { build: "trusted build", ticket: "trusted ticket", "feature-smoke": "trusted smoke", "affected-regression": "trusted affected" }, commit: configured, redGate: { expectedExitCodes: [1], outputPattern: "ticket" } }));
  await put(root, ".captain-sdlc/captain.ignore", patterns);
  await put(root, "VERSION", "1.0.0\n"); await put(root, "CHANGELOG.md", "# Changelog\n"); await put(root, ".captain-sdlc/notebook/notes.json", "{\"notes\":[]}\n"); await put(root, "code.ts", "export const behavior = 1;\n");
  await git(root, "add", "."); await git(root, "commit", "-m", "baseline");
  const base = await git(root, "rev-parse", "HEAD"), captured = await workspace.loadPolicy(root, base);
  return { root, base, commitPolicy: captured.commit! };
}
async function rawCommit(root: string, subject = "docs(captain): retain task records", trailer = "Completes: TASK") { await git(root, "add", "."); await git(root, "commit", "-m", subject, "-m", trailer); return git(root, "rev-parse", "HEAD"); }
function classifier() { const candidate = (workspace as any).bookkeepingCommitValid; assert.equal(typeof candidate, "function", "workspace must expose the actual-delta bookkeeping validator"); return candidate as (root: string, parent: string, head: string, subject: string, policy: CommitPolicy) => Promise<boolean>; }
function historyValidator() { const candidate = (workspace as any).bookkeepingHistoryValid; assert.equal(typeof candidate, "function", "workspace must expose bookkeeping proof-extension validation"); return candidate as (root: string, base: string, head: string, policy: CommitPolicy) => Promise<boolean>; }

test("trusted policy captures a narrow bookkeeping exemption", async t => {
  const f = await fixture(t), captured = await workspace.loadPolicy(f.root, f.base);
  assert.equal((captured.commit as any).bookkeeping.path_file, ".captain-sdlc/captain.ignore");
  assert.equal((captured.commit as any).bookkeeping.patterns, rules);
  assert.match((captured.commit as any).bookkeeping.sha256, /^[0-9a-f]{64}$/);
});

test("bookkeeping atomic commit keeps product version and changelog unchanged", async t => {
  const f = await fixture(t); await put(f.root, ".captain-sdlc/notebook/notes.json", "{\"notes\":[\"retained\"]}\n");
  await workspace.commitAtomic(f.root, [".captain-sdlc/notebook/notes.json"], "docs(captain): retain task records", "Completes", "TASK", f.commitPolicy);
  const evidence = await workspace.commitEvidence(f.root, f.base, { commit: f.commitPolicy } as any, "TASK");
  assert.equal((evidence as any).bookkeepingOnly, true); assert.equal(evidence.phaseCommitsValid, true); assert.equal(evidence.preparedMergesValid, true); assert.equal(evidence.taskTrailerValid, true);
  assert.equal(evidence.versionChanged, false); assert.equal(evidence.changelogChanged, false); assert.equal(evidence.clean, true);
  assert.equal(await readFile(path.join(f.root, "VERSION"), "utf8"), "1.0.0\n"); assert.equal(await readFile(path.join(f.root, "CHANGELOG.md"), "utf8"), "# Changelog\n");
});

test("bookkeeping retains the configured task trailer requirement", async t => {
  const f = await fixture(t); await put(f.root, "Churn/incident.md", "Retain observed failure.\n");
  await assert.rejects(() => workspace.commitAtomic(f.root, ["Churn/incident.md"], "docs(captain): retain incident", undefined, undefined, f.commitPolicy), /trailer/);
});

test("absent exemption and mixed code changes retain ordinary versioned policy", async t => {
  const f = await fixture(t); await put(f.root, "Churn/incident.md", "Retain observed failure.\n");
  const without = { ...f.commitPolicy }; delete (without as any).bookkeeping;
  await assert.rejects(() => workspace.commitAtomic(f.root, ["Churn/incident.md"], "docs(captain): retain incident", "Completes", "TASK", without), /subject|preflight/);
  await put(f.root, "code.ts", "export const behavior = 2;\n");
  await assert.rejects(() => workspace.commitAtomic(f.root, ["Churn/incident.md", "code.ts"], "docs(captain): retain incident", "Completes", "TASK", f.commitPolicy), /subject|preflight/);
});

test("bookkeeping policy refuses caller-supplied captured patterns and hash", async t => {
  for (const forged of [{ patterns: "**\\n" }, { sha256: "a".repeat(64) }, { path_file: ".gitignore" }]) {
    const f = await fixture(t), altered = policy(); (altered as any).bookkeeping = { ...(altered as any).bookkeeping, ...forged };
    await put(f.root, ".captain-sdlc/codex-policy.json", JSON.stringify({ profile: "low", visualRequired: false, commands: { build: "build", ticket: "ticket", "feature-smoke": "smoke", "affected-regression": "affected" }, commit: altered }));
    const head = await rawCommit(f.root); await assert.rejects(() => workspace.loadPolicy(f.root, head), /bookkeeping|record|path|captur|pattern|hash/i);
  }
});

test("bookkeeping classifies actual paths and rejects forbidden subjects and mixed trees", async t => {
  const validate = classifier();
  for (const [relative, subject, expected] of [
    ["Churn/incident.md", "docs(captain): retain incident", true],
    [".captain-sdlc/closeouts/task.md", "chore(captain): retain closeout", true],
    [".captain-sdlc/evidence/summary.json", "docs(captain): retain summary", true],
    [".captain-sdlc/handoffs/task.txt", "docs(captain): retain handoff", true],
    [".captain-sdlc/notebook/notes.json", "fix(captain): retain records", false],
    [".captain-sdlc/notebook/notes.json", "docs(captain): retain records (v1.0.1)", false],
    [".captain-sdlc/handoffs/AGENTS.md", "docs(captain): change instruction", false],
    [".captain-sdlc/evidence/code.ts", "docs(captain): change code", false],
    [".captain-sdlc/evidence/asset.prefab", "docs(captain): change asset", false],
    [".captain-sdlc/evidence/asset.meta", "docs(captain): change metadata", false],
    [".captain-sdlc/merge-policy.json", "docs(captain): change policy", false],
    ["VERSION", "docs(captain): change product version", false],
    ["CHANGELOG.md", "docs(captain): change changelog", false],
    [".captain-sdlc/captain.ignore", "docs(captain): broaden rules", false],
  ] as const) { const f = await fixture(t); await put(f.root, relative, "changed text\n"); const head = await rawCommit(f.root, subject); assert.equal(await validate(f.root, f.base, head, subject, f.commitPolicy), expected, relative); }
});

test("bookkeeping rejects binary blobs, executable modes and symlinks", async t => {
  const validate = classifier();
  for (const mode of ["binary", "executable", "symlink"] as const) {
    const f = await fixture(t), relative = ".captain-sdlc/evidence/record.txt", subject = "docs(captain): retain record";
    await put(f.root, relative, mode === "binary" ? Buffer.from([0, 255, 1, 2]) : "record\n"); await git(f.root, "add", ".");
    if (mode === "executable") await git(f.root, "update-index", "--chmod=+x", relative);
    if (mode === "symlink") { const blob = await git(f.root, "hash-object", relative); await git(f.root, "update-index", "--cacheinfo", `120000,${blob},${relative}`); }
    await git(f.root, "commit", "-m", subject, "-m", "Completes: TASK"); const head = await git(f.root, "rev-parse", "HEAD");
    assert.equal(await validate(f.root, f.base, head, subject, f.commitPolicy), false, mode);
  }
});

test("bookkeeping rename from product source cannot hide its old path", async t => {
  const validate = classifier(), f = await fixture(t), relative = ".captain-sdlc/handoffs/code.txt";
  await mkdir(path.dirname(path.join(f.root, relative)), { recursive: true }); await rename(path.join(f.root, "code.ts"), path.join(f.root, relative)); const subject = "docs(captain): retain renamed code", head = await rawCommit(f.root, subject);
  assert.equal(await validate(f.root, f.base, head, subject, f.commitPolicy), false);
});

test("bookkeeping history preserves every descendant delta and rejects zero extension", async t => {
  const validate = historyValidator(), f = await fixture(t);
  assert.equal(await validate(f.root, f.base, f.base, f.commitPolicy), false);
  await put(f.root, "Churn/one.md", "first\n"); await rawCommit(f.root); await put(f.root, "Churn/two.md", "second\n"); const cleanHead = await rawCommit(f.root, "chore(captain): retain second record");
  assert.equal(await validate(f.root, f.base, cleanHead, f.commitPolicy), true);
  await put(f.root, "code.ts", "export const behavior = 2;\n"); const changed = await rawCommit(f.root);
  assert.equal(await validate(f.root, f.base, changed, f.commitPolicy), false);
});

test("bookkeeping history permits a prepared merge first-parent delta containing only records", async t => {
  const validate = historyValidator(), f = await fixture(t); await git(f.root, "branch", "incoming");
  await put(f.root, "Churn/source.md", "source record\n"); await rawCommit(f.root); await git(f.root, "switch", "incoming"); await put(f.root, "Churn/incoming.md", "incoming record\n"); await rawCommit(f.root); await git(f.root, "switch", "main");
  await git(f.root, "merge", "--no-ff", "incoming", "-m", "docs(captain): reconcile task records", "-m", "Completes: TASK");
  assert.equal(await validate(f.root, f.base, await git(f.root, "rev-parse", "HEAD"), f.commitPolicy), true);
});


test("captain.ignore negation and anchoring retain exact exceptions", async t => {
  const validate = classifier(), patterns = "/.captain-sdlc/evidence/**\n!/.captain-sdlc/evidence/private/\n!/.captain-sdlc/evidence/private/**\n/Churn/*.md\n";
  for (const [relative, expected] of [[".captain-sdlc/evidence/public/run.json", true], [".captain-sdlc/evidence/private/run.json", false], ["Churn/incident.md", true], ["nested/Churn/incident.md", false]] as const) {
    const f = await fixture(t, patterns); await put(f.root, relative, "record\n"); const subject = "docs(captain): retain record", head = await rawCommit(f.root, subject);
    assert.equal(await validate(f.root, f.base, head, subject, f.commitPolicy), expected, relative);
  }
});

test("working captain.ignore cannot broaden the captured committed rules", async t => {
  const validate = classifier(), f = await fixture(t, "/Churn/*.md\n");
  await put(f.root, ".captain-sdlc/captain.ignore", rules); await put(f.root, ".captain-sdlc/evidence/run.json", "{}\n");
  await git(f.root, "add", ".captain-sdlc/evidence/run.json"); const tree = await git(f.root, "write-tree"), subject = "docs(captain): retain record", candidate = await git(f.root, "commit-tree", tree, "-p", f.base, "-m", subject, "-m", "Completes: TASK");
  assert.equal(await validate(f.root, f.base, candidate, subject, f.commitPolicy), false);
});

test("broad captain.ignore patterns cannot exempt governance or product files", async t => {
  const validate = classifier();
  for (const relative of ["AGENTS.md", ".captain-sdlc/dependency-lock.json", ".captain-sdlc/project-policy.json", ".captain-sdlc/hooks/command.md", ".captain-sdlc/plans/approved.md", "Assets/record.txt", "code.ts"]) {
    const f = await fixture(t, "**\n"); await put(f.root, relative, "changed\n"); const subject = "docs(captain): retain record", head = await rawCommit(f.root, subject);
    assert.equal(await validate(f.root, f.base, head, subject, f.commitPolicy), false, relative);
  }
});


test("implementation lifecycle accepts validated bookkeeping phase evidence", async t => {
  const f = await fixture(t), data = await mkdtemp(path.join(tmpdir(), "captain-bookkeeping-state-"));
  t.after(async () => { assert.equal(path.dirname(data), path.resolve(tmpdir())); assert.ok(path.basename(data).startsWith("captain-bookkeeping-state-")); await rm(data, { recursive: true, force: true }); });
  const source = path.join(f.root, ".captain-sdlc", "worktrees", "records"); await git(f.root, "worktree", "add", "-b", "captain/records", source);
  const captured = await workspace.loadPolicy(source, f.base), binding = await workspace.sourceState(source, captured);
  const store = new LifecycleStore(data, async command => ({ exitCode: command === "trusted ticket" ? 1 : 0, stdout: "ticket", stderr: "" }), workspace.sourceState);
  await store.markIntent({ intentId: "records", sessionId: "session", turnId: "turn", projectRoot: f.root, prompt: "retain task records" });
  await store.begin({ intentId: "records", taskId: "TASK", objective: "retain task records", projectRoot: f.root, worktreePath: source, baseHead: f.base, branch: binding.branch!, commonGitDir: binding.commonGitDir!, gitDir: binding.gitDir!, policy: captured });
  await store.recordRed("records", "trusted ticket"); await put(source, "Churn/incident.md", "retained evidence\n");
  await workspace.commitAtomic(source, ["Churn/incident.md"], "docs(captain): retain incident", "Completes", "TASK", f.commitPolicy);
  const evidence = await workspace.commitEvidence(source, f.base, captured, "TASK"), accepted = await store.recordCommit("records", evidence, false);
  assert.equal(accepted.phase, "implement"); assert.equal(accepted.committedState!.head, evidence.head); assert.equal((accepted.evidence.find(item => item.kind === "phase_commit") as any).bookkeepingOnly, true);
});


test("product manifest retains ignored product inputs while allowing only bookkeeping records", async t => {
  const f = await fixture(t); await put(f.root, ".gitignore", "ignored-product.txt\n"); await rawCommit(f.root, "fixture ignore rule");
  const captured = await workspace.loadPolicy(f.root, await git(f.root, "rev-parse", "HEAD")); await put(f.root, "ignored-product.txt", "initial ignored product input\n");
  const before = await workspace.sourceState(f.root, captured); assert.equal(typeof (before as any).productManifest, "string");
  await put(f.root, ".captain-sdlc/notebook/notes.json", "{\"notes\":[\"retained\"]}\n"); const records = await workspace.sourceState(f.root, captured);
  assert.notEqual(records.manifest, before.manifest); assert.equal((records as any).productManifest, (before as any).productManifest);
  await put(f.root, "ignored-product.txt", "changed ignored product input\n"); const product = await workspace.sourceState(f.root, captured);
  assert.notEqual((product as any).productManifest, (records as any).productManifest);
  const legacy = { ...captured, commit: { ...captured.commit } }; delete (legacy.commit as any).bookkeeping;
  assert.equal(Object.prototype.hasOwnProperty.call(await workspace.sourceState(f.root, legacy as any), "productManifest"), false);
});


test("bookkeeping HEAD after a product phase retains valid first-parent commit evidence", async t => {
  const f = await fixture(t); await put(f.root, "code.ts", "export const behavior = 2;\n"); await put(f.root, "VERSION", "1.0.1\n"); await put(f.root, "CHANGELOG.md", "# Changelog\n- Repair behavior (v1.0.1)\n");
  await workspace.commitAtomic(f.root, ["code.ts", "VERSION", "CHANGELOG.md"], "fix(product): repair behavior (v1.0.1)", "Completes", "TASK", f.commitPolicy);
  await put(f.root, "Churn/incident.md", "retained operational record\n"); await workspace.commitAtomic(f.root, ["Churn/incident.md"], "docs(captain): retain incident", "Completes", "TASK", f.commitPolicy);
  const evidence = await workspace.commitEvidence(f.root, f.base, { commit: f.commitPolicy } as any, "TASK");
  assert.equal(evidence.phaseCommitsValid, true); assert.equal((evidence as any).bookkeepingOnly, true); assert.equal(evidence.versionChanged, true); assert.equal(evidence.changelogChanged, true); assert.equal(evidence.versionSurfacesValid, true);
});

test("bookkeeping refuses empty commit trees and repository gitignore contamination", async t => {
  const validate = classifier(), f = await fixture(t, "/Churn/*.md\n");
  const tree = await git(f.root, "rev-parse", "HEAD^{tree}"), subject = "docs(captain): retain record", empty = await git(f.root, "commit-tree", tree, "-p", f.base, "-m", subject);
  assert.equal(await validate(f.root, f.base, empty, subject, f.commitPolicy), false);
  await put(f.root, ".gitignore", "/.captain-sdlc/evidence/\n"); await put(f.root, ".captain-sdlc/evidence/run.json", "{}\n"); await git(f.root, "add", "-f", ".captain-sdlc/evidence/run.json");
  const selected = await git(f.root, "write-tree"), candidate = await git(f.root, "commit-tree", selected, "-p", f.base, "-m", subject);
  assert.equal(await validate(f.root, f.base, candidate, subject, f.commitPolicy), false);
});
