import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, unlink, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { once } from "node:events";
import path from "node:path";
import { promisify } from "node:util";
import { acquireAuthorizedLease, putAuthorizedOnceExact, releaseAuthorizedLease, writeAuthorized } from "../src/authority.js";
import { assertWorktreeBinding, loadPolicy } from "../src/workspace.js";
import { MergeWorkflowStore, type MergeRecord } from "../src/merge-workflow.js";

const exec = promisify(execFile);
const git = async (cwd: string, ...args: string[]) => (await exec("git", ["--no-optional-locks", ...args], { cwd, windowsHide: true })).stdout.trim();
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const ok = { exitCode: 0, stdout: "pass", stderr: "" };

async function fixture(t: TestContext) {
  const container = await mkdtemp(path.join(tmpdir(), "captain-diagnostics-"));
  t.after(async () => { assert.ok(path.basename(container).startsWith("captain-diagnostics-")); await rm(container, { recursive: true, force: true }); });
  const target = path.join(container, "target"), source = path.join(container, "source"), data = path.join(container, "authority");
  await mkdir(target); await git(target, "init", "-b", "main");
  await git(target, "config", "core.autocrlf", "false"); await git(target, "config", "user.name", "Captain Test"); await git(target, "config", "user.email", "captain@example.invalid");
  await mkdir(path.join(target, ".captain-sdlc"));
  await writeFile(path.join(target, ".captain-sdlc", "codex-policy.json"), JSON.stringify({ profile: "low", visualRequired: false, commands: { build: "trusted build", ticket: "trusted ticket", "feature-smoke": "trusted smoke", "affected-regression": "trusted affected", "super-smoke": "trusted ritual" }, commit: { conventional: true, require_version_suffix: false, require_task_trailer: false, version_file: "VERSION", version_surfaces: [], changelog_files: ["CHANGELOG.md"] } }));
  await writeFile(path.join(target, ".captain-sdlc", "merge-policy.json"), JSON.stringify({ schema_version: 1, strictness: "low" }));
  await writeFile(path.join(target, "VERSION"), "1.0.0\n"); await writeFile(path.join(target, "CHANGELOG.md"), "base\n");
  await writeFile(path.join(target, "shared.txt"), "base\n"); await git(target, "add", "."); await git(target, "commit", "-m", "baseline");
  await git(target, "worktree", "add", "-b", "task", source);
  await putAuthorizedOnceExact(data, "test-fixture", "initialized", { synthetic: true });
  const args = { source_worktree: source, target_worktree: target, target_branch: "main", session_id: "session-a" };
  const store = new MergeWorkflowStore(data, async () => { throw new Error("diagnosis must not run a gate"); });
  return { container, target, source, data, args, store };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function seed(f: Fixture, id: string, session = f.args.session_id, overrides: Partial<MergeRecord> = {}) {
  const source = await assertWorktreeBinding(f.source), target = await assertWorktreeBinding(f.target), policy = await loadPolicy(f.source, source.head);
  const record: MergeRecord = { schema_version: 1, merge_id: id, revision: 0, session_id: session, state: "preparing", source_worktree: f.source, target_worktree: f.target, target_branch: "main", source_binding: source, target_binding: target, captured_policy: policy, policy_sha256: digest(policy), strictness: "low", scopes: ["build"], conflicts: [], gates: [], ...overrides };
  await putAuthorizedOnceExact(f.data, "merge-revisions", `${id}-0`, record);
  await watermark(f, record);
  return record;
}
async function watermark(f: Fixture, record: MergeRecord) {
  await putAuthorizedOnceExact(f.data, "merge-watermarks", `${record.merge_id}-${record.revision}`, { merge_id: record.merge_id, revision: record.revision, sha256: digest(record) });
}
async function append(f: Fixture, previous: MergeRecord, overrides: Partial<MergeRecord> = {}) {
  const record = { ...previous, revision: previous.revision + 1, previous_sha256: digest(previous), ...overrides };
  await putAuthorizedOnceExact(f.data, "merge-revisions", `${record.merge_id}-${record.revision}`, record); await watermark(f, record); return record;
}
async function targetLeaseId(f: Fixture) {
  const common = await git(f.target, "rev-parse", "--path-format=absolute", "--git-common-dir");
  return createHash("sha256").update(`${path.resolve(common)}\0refs/heads/main`.toLowerCase()).digest("hex");
}
async function snapshotTree(root: string) {
  const rows: Array<{ path: string; kind: string; sha256?: string; mtime: string }> = [];
  async function walk(relative: string) {
    const absolute = path.join(root, relative), metadata = await stat(absolute, { bigint: true });
    rows.push({ path: relative, kind: metadata.isDirectory() ? "directory" : "file", mtime: metadata.mtimeNs.toString(), ...(metadata.isDirectory() ? {} : { sha256: createHash("sha256").update(await readFile(absolute)).digest("hex") }) });
    if (metadata.isDirectory()) for (const name of (await readdir(absolute)).sort()) await walk(path.join(relative, name));
  }
  await walk(""); return rows;
}
async function readOnly<T>(f: Fixture, action: () => Promise<T>) {
  const before = await snapshotTree(f.container);
  try { return await action(); } finally { assert.deepEqual(await snapshotTree(f.container), before, "diagnosis must preserve every authority and Git file/directory byte and mtime"); }
}
async function diagnose(f: Fixture, args = f.args): Promise<any> {
  assert.equal(typeof (f.store as any).diagnose, "function", "MergeWorkflowStore.diagnose must expose missing-ID diagnostics without mutation");
  return (f.store as any).diagnose(args);
}
const summary = (record: MergeRecord) => ({ merge_id: record.merge_id, revision: record.revision, state: record.state, source_worktree: record.source_worktree, target_worktree: record.target_worktree, target_branch: record.target_branch, source_head: record.source_binding.head, target_head: record.target_binding.head });

test("diagnose returns every caller-owned exact-binding summary without changing Git or authority", async t => {
  const f = await fixture(t), first = await append(f, await seed(f, "merge-owned-a"), { state: "failed", failure: "private failure detail" }), second = await seed(f, "merge-owned-b");
  await seed(f, "merge-foreign", "private-foreign-session");
  const otherSource = path.join(f.container, "other-source"); await git(f.target, "worktree", "add", "-b", "other-task", otherSource);
  await seed(f, "merge-other-binding", f.args.session_id, { source_worktree: otherSource, source_binding: await assertWorktreeBinding(otherSource) });
  await writeFile(path.join(f.source, "shared.txt"), "uncommitted human work\n");
  const result = await readOnly(f, () => diagnose(f));
  assert.equal(result.read_only, true); assert.equal(result.captain_green, false); assert.deepEqual(result.target_lease, { state: "absent" });
  assert.deepEqual(result.operations.sort((a: any, b: any) => a.merge_id.localeCompare(b.merge_id)), [summary(first), summary(second)]);
  assert.deepEqual(Object.keys(result).sort(), ["captain_green", "operations", "read_only", "target_lease"]);
  assert.doesNotMatch(JSON.stringify(result), /private-foreign-session|private failure detail|leaseToken|captured_policy|recovery/);
});

test("diagnose empty existing authority reports no operation or lease without creating buckets", async t => {
  const f = await fixture(t), result = await readOnly(f, () => diagnose(f));
  assert.deepEqual(result, { read_only: true, captain_green: false, operations: [], target_lease: { state: "absent" } });
});

test("diagnose different nonempty caller session returns no owned matches and only other lease relation", async t => {
  const f = await fixture(t); await seed(f, "merge-original-session");
  await acquireAuthorizedLease(f.data, await targetLeaseId(f), { intentId: "merge-target-owner", leaseToken: "private-token", sessionId: f.args.session_id, operation: "integration-branch" });
  const result = await readOnly(f, () => diagnose(f, { ...f.args, session_id: "different-caller-session" }));
  assert.deepEqual(result.operations, []); assert.equal(result.target_lease.session_match, "other");
  assert.doesNotMatch(JSON.stringify(result), /session-a|private-token|leaseToken/);
});

test("diagnose different valid requested source returns no exact-binding operation matches", async t => {
  const f = await fixture(t); await seed(f, "merge-original-source");
  const requestedSource = path.join(f.container, "requested-source"); await git(f.target, "worktree", "add", "-b", "requested-task", requestedSource);
  const result = await readOnly(f, () => diagnose(f, { ...f.args, source_worktree: requestedSource }));
  assert.deepEqual(result, { read_only: true, captain_green: false, operations: [], target_lease: { state: "absent" } });
});

for (const relation of ["same", "other", "unknown"] as const) test(`diagnose held target lease exposes ${relation} session relation without tokens or foreign session`, async t => {
  const f = await fixture(t); await seed(f, "merge-owned");
  const payload = { intentId: "merge-target-owner", leaseToken: "private-token", operation: "integration-branch", ownerPid: process.pid, ownerHost: hostname(), ...(relation === "unknown" ? {} : { sessionId: relation === "same" ? f.args.session_id : "private-foreign-session" }), privateExtra: "private-payload-field" };
  await acquireAuthorizedLease(f.data, await targetLeaseId(f), payload);
  const result = await readOnly(f, () => diagnose(f));
  assert.deepEqual(result.target_lease, { state: "held", intent_id: "merge-target-owner", operation: "integration-branch", owner: { pid: process.pid, host: hostname(), state: "live" }, session_match: relation });
  assert.doesNotMatch(JSON.stringify(result), /private-token|private-foreign-session|private-payload-field|leaseToken|session_id|recovery/);
});

test("diagnose released target lease preserves its authenticated state without reacquisition", async t => {
  const f = await fixture(t), id = await targetLeaseId(f), payload = { intentId: "merge-target-owner", leaseToken: "private-token", sessionId: f.args.session_id, operation: "integration-branch" };
  await acquireAuthorizedLease(f.data, id, payload); await releaseAuthorizedLease(f.data, id, payload.intentId, payload.leaseToken);
  const result = await readOnly(f, () => diagnose(f));
  assert.deepEqual(result.target_lease, { state: "released", intent_id: payload.intentId, operation: payload.operation, owner: { state: "legacy" }, session_match: "same" });
});

for (const state of ["legacy", "stopped", "foreign_host", "unknown"] as const) test(`diagnose signed legacy target lease reports ${state} owner without conversion`, async t => {
  const f = await fixture(t); let owner: Record<string, unknown> = {};
  if (state === "stopped") { const child = spawn(process.execPath, ["-e", ""], { windowsHide: true }); const pid = child.pid; await once(child, "close"); assert.ok(pid); owner = { ownerPid: pid, ownerHost: hostname() }; }
  if (state === "foreign_host") owner = { ownerPid: process.pid, ownerHost: "captain-different-host.invalid" };
  if (state === "unknown") owner = { ownerPid: -1, ownerHost: hostname() };
  await writeAuthorized(f.data, "leases", await targetLeaseId(f), { intentId: "legacy-target", leaseToken: "private-legacy-token", operation: "integration-branch", ...owner });
  const result = await readOnly(f, () => diagnose(f));
  assert.equal(result.target_lease.state, "held"); assert.equal(result.target_lease.owner.state, state); assert.equal(result.target_lease.session_match, "unknown");
  assert.doesNotMatch(JSON.stringify(result), /private-legacy-token|leaseToken|recovery/);
  await assert.rejects(() => stat(path.join(f.data, "lease-revisions")), { code: "ENOENT" });
});

for (const corruption of ["missing-watermark", "tamper", "rollback", "broken-link", "missing-key"] as const) test(`diagnose rejects ${corruption} without repairing signed merge state`, async t => {
  const f = await fixture(t), first = await seed(f, "merge-invalid");
  if (corruption === "missing-watermark") await unlink(path.join(f.data, "merge-watermarks", `${first.merge_id}-0.json`));
  if (corruption === "missing-key") await unlink(path.join(f.data, "authority.key"));
  if (corruption === "tamper") { const file = path.join(f.data, "merge-revisions", `${first.merge_id}-0.json`), value = JSON.parse(await readFile(file, "utf8")); value.payload.state = "ready"; await writeFile(file, JSON.stringify(value)); }
  if (corruption === "rollback") { const latest = await append(f, first); await unlink(path.join(f.data, "merge-revisions", `${first.merge_id}-${latest.revision}.json`)); }
  if (corruption === "broken-link") await append(f, first, { previous_sha256: "0".repeat(64) });
  await readOnly(f, () => assert.rejects(() => diagnose(f), /watermark|authority|signature|tag|regress|chain|binding|ENOENT/));
});

test("diagnose refuses missing target-lease watermark without filling it", async t => {
  const f = await fixture(t), id = await targetLeaseId(f);
  await acquireAuthorizedLease(f.data, id, { intentId: "target-owner", leaseToken: "secret" }); await unlink(path.join(f.data, "lease-watermarks", `${id}-0.json`));
  await readOnly(f, () => assert.rejects(() => diagnose(f), /watermark|checkpoint/));
});

for (const mismatch of ["target-branch", "cross-repository", "nested-worktree", "nested-source", "empty-session", "signed-git-directory"] as const) test(`diagnose rejects ${mismatch} binding without modifying repositories`, async t => {
  const f = await fixture(t); let args = f.args;
  if (mismatch === "target-branch") args = { ...args, target_branch: "other" };
  if (mismatch === "empty-session") args = { ...args, session_id: " " };
  if (mismatch === "nested-worktree") { const nested = path.join(f.target, "nested"); await mkdir(nested); args = { ...args, target_worktree: nested }; }
  if (mismatch === "nested-source") { const nested = path.join(f.source, "nested"); await mkdir(nested); args = { ...args, source_worktree: nested }; }
  if (mismatch === "cross-repository") { const unrelated = path.join(f.container, "unrelated"); await mkdir(unrelated); await git(unrelated, "init", "-b", "main"); await git(unrelated, "config", "user.name", "Test"); await git(unrelated, "config", "user.email", "test@example.invalid"); await writeFile(path.join(unrelated, "file.txt"), "unrelated"); await git(unrelated, "add", "."); await git(unrelated, "commit", "-m", "unrelated"); args = { ...args, target_worktree: unrelated }; }
  if (mismatch === "signed-git-directory") { const actual = await assertWorktreeBinding(f.target); await seed(f, "merge-wrong-binding", f.args.session_id, { target_binding: { ...actual, gitDir: path.join(f.container, "wrong-git-dir") } }); }
  await readOnly(f, () => assert.rejects(() => diagnose(f, args), /branch|repository|Git|worktree|session|binding|top.level/));
});

test("initial Prep target conflict exposes only its durable caller-owned generated merge ID", async t => {
  const f = await fixture(t), store = new MergeWorkflowStore(f.data, async () => ok);
  await acquireAuthorizedLease(f.data, await targetLeaseId(f), { intentId: "foreign-owner", leaseToken: "private-token", sessionId: "private-foreign-session" });
  let caught: any;
  try { await store.prep(f.args); } catch (error) { caught = error; }
  assert.ok(caught instanceof Error); assert.match(caught.message, /target branch is already leased/);
  assert.equal(caught.name, "MergeWorkflowError", "persisted initial Prep failures must retain durable operation context");
  assert.match(caught.merge_id, /^merge-[a-zA-Z0-9_-]+$/);
  const signed = JSON.parse(await readFile(path.join(f.data, "merge-revisions", `${caught.merge_id}-0.json`), "utf8")).payload;
  assert.equal(signed.merge_id, caught.merge_id); assert.equal(signed.session_id, f.args.session_id); assert.equal(signed.source_worktree, f.source);
  assert.doesNotMatch(JSON.stringify(caught), /private-token|private-foreign-session|leaseToken/);
});

test("Prep prevalidation failure never exposes an unsigned generated operation ID", async t => {
  const f = await fixture(t), store = new MergeWorkflowStore(f.data, async () => ok); let caught: any;
  try { await store.prep({ ...f.args, target_branch: "wrong" }); } catch (error) { caught = error; }
  assert.ok(caught instanceof Error); assert.match(caught.message, /branch/); assert.equal(caught.merge_id, undefined); assert.notEqual(caught.name, "MergeWorkflowError");
  await assert.rejects(() => stat(path.join(f.data, "merge-revisions")), { code: "ENOENT" });
});

test("initial Prep checkpoint failure retains the ID once signed revision zero exists", async t => {
  const f = await fixture(t), store = new MergeWorkflowStore(f.data, async () => ok);
  await writeFile(path.join(f.data, "merge-watermarks"), "blocked checkpoint directory");
  let caught: any;
  try { await store.prep(f.args); } catch (error) { caught = error; }
  assert.ok(caught instanceof Error); assert.equal(caught.name, "MergeWorkflowError"); assert.ok(caught.cause instanceof Error); assert.equal(caught.message, caught.cause.message);
  assert.match(caught.merge_id, /^merge-[a-zA-Z0-9_-]+$/);
  const signed = JSON.parse(await readFile(path.join(f.data, "merge-revisions", `${caught.merge_id}-0.json`), "utf8")).payload;
  assert.equal(signed.merge_id, caught.merge_id); assert.equal(signed.session_id, f.args.session_id);
  assert.equal(await readFile(path.join(f.data, "merge-watermarks"), "utf8"), "blocked checkpoint directory");
});

test("Prep foreign-session continuation refuses before attaching another owner's operation context", async t => {
  const f = await fixture(t), record = await seed(f, "merge-foreign-record", "other-session"); let caught: any;
  try { await f.store.prep({ ...f.args, merge_id: record.merge_id }); } catch (error) { caught = error; }
  assert.ok(caught instanceof Error); assert.match(caught.message, /session ownership mismatch/); assert.equal(caught.merge_id, undefined); assert.notEqual(caught.name, "MergeWorkflowError");
});
