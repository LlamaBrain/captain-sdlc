import assert from "node:assert/strict";
import test from "node:test";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { once } from "node:events";
import path from "node:path";
import { promisify } from "node:util";
import { acquireAuthorizedLease, putAuthorizedOnceExact, readAuthorizedLease, releaseAuthorizedLease } from "../src/authority.js";
import { LifecycleStore } from "../src/lifecycle.js";
import { assertWorktreeBinding, commitAtomic, loadPolicy } from "../src/workspace.js";
import { MergeWorkflowStore } from "../src/merge-workflow.js";
const exec = promisify(execFile);
const git = async (cwd: string, ...args: string[]) => (await exec("git", args, { cwd, windowsHide: true })).stdout.trim();
const ok = { exitCode: 0, stdout: "pass", stderr: "" };
async function fixture(strictness = "low") {
  const container = await mkdtemp(path.join(tmpdir(), "captain-merge-")), target = path.join(container, "target"), source = path.join(target, ".captain-sdlc", "worktrees", "task"), data = path.join(container, "authority");
  await mkdir(target); await git(target, "init", "-b", "main"); await git(target, "config", "core.autocrlf", "false"); await git(target, "config", "user.name", "Captain Test"); await git(target, "config", "user.email", "captain@example.invalid"); await mkdir(path.join(target, ".captain-sdlc"));
  await writeFile(path.join(target, ".captain-sdlc", "codex-policy.json"), JSON.stringify({ profile: "low", visualRequired: false, commands: { build: "trusted build", ticket: "trusted ticket", "feature-smoke": "trusted smoke", "affected-regression": "trusted affected", "super-smoke": "trusted ritual" }, commit: { conventional: true, require_version_suffix: false, require_task_trailer: false, version_file: "VERSION", version_surfaces: [], changelog_files: ["CHANGELOG.md"] }, sourceManifestExcludes: ["Temp"] }));
  await writeFile(path.join(target, ".captain-sdlc", "merge-policy.json"), JSON.stringify({ schema_version: 1, strictness })); await writeFile(path.join(target, ".gitignore"), "Temp/\nvendor/\nvendor.meta\n.captain-sdlc/worktrees/\n"); await writeFile(path.join(target, "shared.txt"), "base\n"); await writeFile(path.join(target, "VERSION"), "1.0.0\n"); await writeFile(path.join(target, "CHANGELOG.md"), "base\n"); await git(target, "add", "."); await git(target, "commit", "-m", "baseline"); await git(target, "worktree", "add", "-b", "task", source);
  return { container, target, source, data, args: { source_worktree: source, target_worktree: target, target_branch: "main", session_id: "session-a" } };
}
async function commit(cwd: string, filename: string, text: string) { await writeFile(path.join(cwd, filename), text); await git(cwd, "add", filename); await git(cwd, "commit", "-m", "fix(test): change fixture"); }
async function mergeCommit(cwd: string, paths: string[], subject: string) { await writeFile(path.join(cwd, "VERSION"), "1.0.1\n"); await writeFile(path.join(cwd, "CHANGELOG.md"), "base\nmerge preparation\n"); return { paths: [...paths, "VERSION", "CHANGELOG.md"], subject }; }

test("Prep stops ready; Back alone integrates without repeating gates", async () => {
  const f = await fixture(), gates: string[] = [], store = new MergeWorkflowStore(f.data, async command => { gates.push(command); return ok; }); await commit(f.source, "task.txt", "task\n"); const before = await git(f.target, "rev-parse", "HEAD");
  const prep = await store.prep(f.args); assert.equal(prep.state, "ready"); assert.deepEqual(gates, ["trusted build"]); assert.equal(await git(f.target, "rev-parse", "HEAD"), before);
  const back = await store.back({ merge_id: prep.merge_id, session_id: f.args.session_id }); assert.equal(back.state, "merged"); assert.equal(await git(f.target, "rev-parse", "HEAD"), await git(f.source, "rev-parse", "HEAD")); assert.equal(gates.length, 1); assert.equal((await store.back({ merge_id: prep.merge_id, session_id: f.args.session_id })).state, "merged"); assert.equal(gates.length, 1);
});
test("Prep remains ready when Unity regenerates ignored Addressables build outputs", async () => {
  const f = await fixture();
  const policyPath = path.join(f.source, ".captain-sdlc", "codex-policy.json");
  const policy = JSON.parse(await readFile(policyPath, "utf8"));
  policy.sourceManifestExcludes = [
    "Temp",
    "Assets/AddressableAssetsData/link.xml",
    "Assets/AddressableAssetsData/link.xml.meta",
    "Assets/AddressableAssetsData/Windows/addressables_content_state.bin",
    "Assets/AddressableAssetsData/Windows/addressables_content_state.bin.meta",
    "Assets/ThirdParty/GameAnalytics/Resources/GameAnalytics/Settings.asset",
    "Assets/TextMesh Pro/Resources/Fonts & Materials/LiberationSans SDF - Fallback.asset",
  ];
  await writeFile(policyPath, JSON.stringify(policy));
  await writeFile(path.join(f.source, ".gitignore"), "Temp/\nvendor/\nvendor.meta\n.captain-sdlc/worktrees/\nAssets/AddressableAssetsData/link.xml*\nAssets/AddressableAssetsData/*/*.bin*\nAssets/ThirdParty/\nAssets/TextMesh Pro/\n");
  await git(f.source, "add", ".captain-sdlc/codex-policy.json", ".gitignore");
  await git(f.source, "commit", "-m", "test generated Addressables policy");
  await commit(f.source, "task.txt", "task\n");
  const store = new MergeWorkflowStore(f.data, async () => {
    const generated = path.join(f.source, "Assets", "AddressableAssetsData");
    await mkdir(generated, { recursive: true });
    await writeFile(path.join(generated, "link.xml"), "<linker />\n");
    await writeFile(path.join(generated, "link.xml.meta"), "generated meta\n");
    const windows = path.join(generated, "Windows");
    await mkdir(windows, { recursive: true });
    await writeFile(path.join(windows, "addressables_content_state.bin"), "generated addressables state\n");
    await writeFile(path.join(windows, "addressables_content_state.bin.meta"), "generated state meta\n");
    const analytics = path.join(f.source, "Assets", "ThirdParty", "GameAnalytics", "Resources", "GameAnalytics");
    await mkdir(analytics, { recursive: true });
    await writeFile(path.join(analytics, "Settings.asset"), "version: 2.570.3\n");
    const fallback = path.join(f.source, "Assets", "TextMesh Pro", "Resources", "Fonts & Materials");
    await mkdir(fallback, { recursive: true });
    await writeFile(path.join(fallback, "LiberationSans SDF - Fallback.asset"), "generated fallback\n");
    return ok;
  });

  const prep = await store.prep(f.args);

  assert.equal(prep.state, "ready");
});
test("stale merge lease recovery requires the exact signed generation and resumes the same operation", async () => {
  const f = await fixture(), gates: string[] = [], store = new MergeWorkflowStore(f.data, async command => { gates.push(command); return ok; });
  const owner = await activeOwner(f, f.args.session_id); await new LifecycleStore(f.data, async () => ok).pause("active", { summary: "fixture paused for merge integration", nextSteps: ["resume after integration"] });
  await commit(f.source, "task.txt", "task\n");
  const first = await store.prep(f.args);
  gates.splice(0);
  const signedFirst = JSON.parse(await readFile(path.join(f.data, "merge-revisions", `${first.merge_id}-${first.revision}.json`), "utf8")).payload;
  const stale = { ...signedFirst, revision: signedFirst.revision + 1, previous_sha256: createHash("sha256").update(JSON.stringify(signedFirst)).digest("hex"), state: "verifying" as const, gates: [], ready_inputs: undefined, failure: undefined };
  await putAuthorizedOnceExact(f.data, "merge-revisions", `${first.merge_id}-${stale.revision}`, stale);
  await putAuthorizedOnceExact(f.data, "merge-watermarks", `${first.merge_id}-${stale.revision}`, { merge_id: first.merge_id, revision: stale.revision, sha256: createHash("sha256").update(JSON.stringify(stale)).digest("hex") });
  const staleLedger = path.join(f.data, "merge-revisions", `${first.merge_id}-${stale.revision}.json`), staleLedgerBytes = await readFile(staleLedger, "utf8");
  const staleStatus = await store.status({ merge_id: first.merge_id, session_id: f.args.session_id });
  assert.equal(staleStatus.state, "verifying");
  const leaseId = createHash("sha256").update(`merge-operation\0${first.merge_id}`).digest("hex"), leaseToken = "abandoned-generation";
  await acquireAuthorizedLease(f.data, leaseId, { intentId: first.merge_id, leaseToken, sessionId: f.args.session_id, operation: "integration" });
  const fenceId = createHash("sha256").update(`worktree-mutation\0${owner.runId}`).digest("hex");
  await acquireAuthorizedLease(f.data, fenceId, { intentId: first.merge_id, leaseToken: "abandoned-fence", sessionId: f.args.session_id, operation: "integration-worktree" });
  const bindingLeaseId = (branch: string, common: string) => createHash("sha256").update(`${path.resolve(common)}\0refs/heads/${branch}`.toLowerCase()).digest("hex");
  const sourceBranchLease = bindingLeaseId(first.source_binding.branch, first.source_binding.commonGitDir), targetBranchLease = bindingLeaseId(first.target_binding.branch, first.target_binding.commonGitDir);
  await acquireAuthorizedLease(f.data, sourceBranchLease, { intentId: first.merge_id, leaseToken: "abandoned-source-branch", sessionId: f.args.session_id, operation: "integration-branch", commonGitDir: first.source_binding.commonGitDir, targetBranch: first.source_binding.branch, targetOid: first.source_binding.head });
  await acquireAuthorizedLease(f.data, targetBranchLease, { intentId: first.merge_id, leaseToken: "abandoned-target-branch", sessionId: f.args.session_id, operation: "integration-branch", commonGitDir: first.target_binding.commonGitDir, targetBranch: first.target_binding.branch, targetOid: first.target_binding.head });
  const recovery = { merge_id: first.merge_id, session_id: f.args.session_id, source_worktree: f.source, target_worktree: f.target, target_branch: "main", expected_revision: staleStatus.revision, expected_lease_token: leaseToken, confirm_owner_stopped: true };
  await assert.rejects(() => store.recoverStaleLease({ ...recovery, confirm_owner_stopped: false }), /confirm that its owner is stopped/);
  await assert.rejects(() => store.recoverStaleLease({ ...recovery, expected_lease_token: "wrong" }), /generation|token|owner/);
  await assert.rejects(() => store.recoverStaleLease({ ...recovery, expected_revision: staleStatus.revision - 1 }), /revision/);
  assert.equal((await readAuthorizedLease<any>(f.data, leaseId)).leaseToken, leaseToken);
  const sourceHead = await git(f.source, "rev-parse", "HEAD"), targetHead = await git(f.target, "rev-parse", "HEAD");
  await store.recoverStaleLease(recovery);
  assert.equal(await readFile(staleLedger, "utf8"), staleLedgerBytes);
  assert.equal(await git(f.source, "rev-parse", "HEAD"), sourceHead); assert.equal(await git(f.target, "rev-parse", "HEAD"), targetHead);
  await assert.rejects(() => readAuthorizedLease(f.data, leaseId), /not held/);
  for (const id of [fenceId, sourceBranchLease, targetBranchLease]) await assert.rejects(() => readAuthorizedLease(f.data, id), /not held/);
  assert.equal((await store.recoverStaleLease(recovery)).released_resource_leases, 0);
  const resumed = await store.prep({ ...f.args, merge_id: first.merge_id });
  assert.equal(resumed.merge_id, first.merge_id); assert.equal(resumed.state, "ready"); assert.deepEqual(gates, ["trusted build"]);
});
test("stale merge lease recovery refuses an operation active in this process", async () => {
  const f = await fixture(); let enter!: () => void, finish!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; }), pending = new Promise<void>(resolve => { finish = resolve; });
  const store = new MergeWorkflowStore(f.data, async () => { enter(); await pending; return ok; }); await commit(f.source, "task.txt", "task\n");
  const prep = store.prep(f.args); await entered;
  const mergeId = (await readdir(path.join(f.data, "merge-revisions"))).find(name => name.endsWith("-0.json"))!.replace(/-0\.json$/, "");
  const status = await store.status({ merge_id: mergeId, session_id: f.args.session_id });
  const leaseId = createHash("sha256").update(`merge-operation\0${status.merge_id}`).digest("hex"), lease = await readAuthorizedLease<any>(f.data, leaseId);
  await assert.rejects(() => store.recoverStaleLease({ merge_id: status.merge_id, session_id: f.args.session_id, source_worktree: f.source, target_worktree: f.target, target_branch: "main", expected_revision: status.revision, expected_lease_token: lease.leaseToken, confirm_owner_stopped: true }), /active in this process/);
  finish(); assert.equal((await prep).state, "ready");
});

async function abandonedMerge(owner: Record<string, unknown> = {}) {
  const f = await fixture(), gates: string[] = [], store = new MergeWorkflowStore(f.data, async command => { gates.push(command); return ok; });
  await commit(f.source, "task.txt", "task\n");
  const ready = await store.prep(f.args), leaseId = createHash("sha256").update(`merge-operation\0${ready.merge_id}`).digest("hex");
  const leaseToken = "fixture-abandoned-generation";
  await acquireAuthorizedLease(f.data, leaseId, { intentId: ready.merge_id, sessionId: f.args.session_id, operation: "integration", leaseToken, ...owner });
  return { ...f, store, ready, leaseId, leaseToken, gates, statusArgs: { merge_id: ready.merge_id, session_id: f.args.session_id } };
}

async function stoppedOwnerPid() {
  const result = await exec(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { windowsHide: true });
  return Number(result.stdout);
}

test("public recovery status discovers a stopped separate process and resumes without confirmation", async () => {
  const f = await abandonedMerge({ ownerPid: await stoppedOwnerPid(), ownerHost: hostname() });
  const ledger = path.join(f.data, "merge-revisions", `${f.ready.merge_id}-${f.ready.revision}.json`), before = await readFile(ledger, "utf8");
  const sourceHead = await git(f.source, "rev-parse", "HEAD"), targetHead = await git(f.target, "rev-parse", "HEAD");
  const status = await f.store.status(f.statusArgs), lease = status.operation_lease!;
  assert.equal(lease.state, "held"); assert.equal(lease.owner!.state, "stopped");
  assert.equal(lease.owner!.host, hostname()); assert.equal(lease.recovery!.eligible, true);
  assert.equal(lease.recovery!.next_tool, "captain_recover_merge_lease");
  assert.equal(lease.recovery!.requires_owner_stop_verification, false);
  assert.deepEqual(lease.recovery!.args, { ...f.args, merge_id: f.ready.merge_id, expected_revision: f.ready.revision, expected_lease_token: f.leaseToken });
  assert.equal((await readAuthorizedLease<any>(f.data, f.leaseId)).leaseToken, f.leaseToken);
  await f.store.recoverStaleLease(lease.recovery!.args);
  assert.equal(await readFile(ledger, "utf8"), before);
  assert.equal(await git(f.source, "rev-parse", "HEAD"), sourceHead); assert.equal(await git(f.target, "rev-parse", "HEAD"), targetHead);
  assert.deepEqual(f.gates, ["trusted build"]);
  assert.equal((await f.store.status(f.statusArgs)).operation_lease!.state, "released");
  assert.equal((await f.store.prep({ ...f.args, merge_id: f.ready.merge_id })).revision, f.ready.revision);
  assert.equal((await f.store.back(f.statusArgs)).state, "merged"); assert.deepEqual(f.gates, ["trusted build"]);
});

test("public recovery status protects a live separate owner process", async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { windowsHide: true, stdio: "ignore" });
  await once(child, "spawn");
  try {
    const f = await abandonedMerge({ ownerPid: child.pid, ownerHost: hostname() });
    const lease = (await f.store.status(f.statusArgs)).operation_lease!;
    assert.equal(lease.owner!.state, "live"); assert.equal(lease.recovery!.eligible, false);
    assert.match(lease.recovery!.reason, /still active/);
    await assert.rejects(() => f.store.recoverStaleLease({ ...lease.recovery!.args, confirm_owner_stopped: true }), /still active/);
    assert.equal((await readAuthorizedLease<any>(f.data, f.leaseId)).leaseToken, f.leaseToken);
  } finally { const closed = once(child, "close"); child.kill(); await closed; }
});

for (const [owner, state, reason] of [
  [{}, "legacy", /independently verify/],
  [{ ownerPid: 1, ownerHost: "another-host.invalid" }, "foreign_host", /another host/],
  [{ ownerPid: -1, ownerHost: hostname() }, "unknown", /invalid/],
] as const) test(`public recovery status reports ${state} owner without inventing verification`, async () => {
  const f = await abandonedMerge(owner), lease = (await f.store.status(f.statusArgs)).operation_lease!;
  assert.equal(lease.owner!.state, state); assert.equal(lease.recovery!.eligible, false);
  assert.equal(lease.recovery!.requires_owner_stop_verification, state === "legacy");
  assert.match(lease.recovery!.reason, reason); assert.equal(lease.recovery!.args.confirm_owner_stopped, undefined);
  await assert.rejects(() => f.store.recoverStaleLease(lease.recovery!.args), /confirm|another host|invalid/);
  assert.equal((await readAuthorizedLease<any>(f.data, f.leaseId)).leaseToken, f.leaseToken);
  if (state === "legacy") await f.store.recoverStaleLease({ ...lease.recovery!.args, confirm_owner_stopped: true });
});

test("public recovery status refuses foreign sessions and source target identity mismatches", async () => {
  const f = await abandonedMerge();
  await assert.rejects(() => f.store.status({ ...f.statusArgs, session_id: "foreign" }), /session/);
  await assert.rejects(() => f.store.status({ ...f.statusArgs, source_worktree: f.target }), /identity/);
  const lease = (await f.store.status(f.statusArgs)).operation_lease!;
  await assert.rejects(() => f.store.recoverStaleLease({ ...lease.recovery!.args, target_worktree: f.source, confirm_owner_stopped: true }), /identity/);
  await releaseAuthorizedLease(f.data, f.leaseId, f.ready.merge_id, f.leaseToken);
  await acquireAuthorizedLease(f.data, f.leaseId, { intentId: f.ready.merge_id, sessionId: "foreign", operation: "integration", leaseToken: "foreign-fixture-token" });
  await assert.rejects(() => f.store.status(f.statusArgs), /owner|operation|session/);
});

test("public recovery status cannot release a rotated lease generation", async () => {
  const f = await abandonedMerge(), args = (await f.store.status(f.statusArgs)).operation_lease!.recovery!.args;
  await releaseAuthorizedLease(f.data, f.leaseId, f.ready.merge_id, f.leaseToken);
  await acquireAuthorizedLease(f.data, f.leaseId, { intentId: f.ready.merge_id, sessionId: f.args.session_id, operation: "integration", leaseToken: "rotated-fixture-token" });
  await assert.rejects(() => f.store.recoverStaleLease({ ...args, confirm_owner_stopped: true }), /generation|token/);
  assert.equal((await readAuthorizedLease<any>(f.data, f.leaseId)).leaseToken, "rotated-fixture-token");
});

for (const changed of ["source-branch", "target-head"] as const) test(`public recovery checks actual ${changed} binding before releasing leases`, async () => {
  const f = await abandonedMerge(), args = (await f.store.status(f.statusArgs)).operation_lease!.recovery!.args;
  const target = f.ready.target_binding, branchLeaseId = createHash("sha256").update(`${path.resolve(target.commonGitDir)}\0refs/heads/${target.branch}`.toLowerCase()).digest("hex");
  await acquireAuthorizedLease(f.data, branchLeaseId, { intentId: f.ready.merge_id, sessionId: f.args.session_id, operation: "integration-branch", leaseToken: "fixture-target-generation", commonGitDir: target.commonGitDir, targetBranch: target.branch, targetOid: target.head });
  if (changed === "source-branch") await git(f.source, "switch", "-c", "replacement-source");
  else await commit(f.target, "moved.txt", "foreign movement\n");
  const ledger = path.join(f.data, "merge-revisions", `${f.ready.merge_id}-${f.ready.revision}.json`), before = await readFile(ledger, "utf8");
  await assert.rejects(() => f.store.recoverStaleLease({ ...args, confirm_owner_stopped: true }), /binding|diverged/);
  assert.equal((await readAuthorizedLease<any>(f.data, f.leaseId)).leaseToken, f.leaseToken);
  assert.equal((await readAuthorizedLease<any>(f.data, branchLeaseId)).leaseToken, "fixture-target-generation");
  assert.equal(await readFile(ledger, "utf8"), before); assert.deepEqual(f.gates, ["trusted build"]);
});

test("public recovery permits the exact already integrated target without repeating gates", async () => {
  const f = await abandonedMerge({ ownerPid: await stoppedOwnerPid(), ownerHost: hostname() });
  await git(f.target, "merge", "--ff-only", f.ready.ready_inputs!.source.head);
  const status = await f.store.status(f.statusArgs);
  assert.equal(status.receipt_valid, true);
  await f.store.recoverStaleLease(status.operation_lease!.recovery!.args);
  assert.equal((await f.store.back(f.statusArgs)).state, "merged"); assert.deepEqual(f.gates, ["trusted build"]);
});
test("divergence prepares audited source merge and requires its explicit policy commit", async () => {
  const f = await fixture(), store = new MergeWorkflowStore(f.data, async () => ok); await commit(f.source, "task.txt", "task\n"); await commit(f.target, "target.txt", "target\n"); const targetHead = await git(f.target, "rev-parse", "HEAD");
  const pending = await store.prep(f.args); assert.equal(pending.state, "needs_commit"); assert.equal(await git(f.source, "rev-parse", "MERGE_HEAD"), targetHead); await assert.rejects(() => store.back({ merge_id: pending.merge_id, session_id: f.args.session_id }), /ready/);
  const ready = await store.prep({ ...f.args, merge_id: pending.merge_id, commit: await mergeCommit(f.source, ["target.txt"], "chore(merge): prepare target") }); assert.equal(ready.state, "ready"); assert.equal(await git(f.target, "rev-parse", "HEAD"), targetHead); assert.equal((await git(f.source, "rev-list", "--parents", "-n", "1", "HEAD")).split(" ").length, 3); assert.equal((await store.back({ merge_id: ready.merge_id, session_id: f.args.session_id })).state, "merged");
});
test("conflicts remain in source until resumed exact commit resolves them", async () => {
  const f = await fixture(), gates: string[] = [], store = new MergeWorkflowStore(f.data, async command => { gates.push(command); return ok; }); await commit(f.source, "shared.txt", "task\n"); await commit(f.target, "shared.txt", "main\n"); const targetHead = await git(f.target, "rev-parse", "HEAD"); const pending = await store.prep(f.args);
  assert.equal(pending.state, "needs_resolution"); assert.deepEqual(pending.conflicts, ["shared.txt"]); assert.equal(gates.length, 0); await writeFile(path.join(f.source, "shared.txt"), "task and main\n"); const ready = await store.prep({ ...f.args, merge_id: pending.merge_id, commit: await mergeCommit(f.source, ["shared.txt"], "fix(merge): resolve target conflict") }); assert.equal(ready.state, "ready"); assert.equal(await git(f.target, "rev-parse", "HEAD"), targetHead);
});
test("target ahead still pulls into the same source worktree", async () => { const f = await fixture(), store = new MergeWorkflowStore(f.data, async () => ok); await commit(f.target, "target.txt", "ahead\n"); const pending = await store.prep(f.args); assert.equal(pending.state, "needs_commit"); assert.equal((await store.prep({ ...f.args, merge_id: pending.merge_id, commit: await mergeCommit(f.source, ["target.txt"], "chore(merge): incorporate target") })).state, "ready"); });
for (const [strictness, expected] of [["standard", ["trusted build", "trusted ticket", "trusted smoke", "trusted affected"]], ["strict", ["trusted build", "trusted ticket", "trusted smoke", "trusted affected", "trusted ritual"]]] as const) test(`${strictness} runs exactly captured existing scopes`, async () => { const f = await fixture(strictness), gates: string[] = [], store = new MergeWorkflowStore(f.data, async command => { gates.push(command); return ok; }); await commit(f.source, "task.txt", "task\n"); assert.equal((await store.prep(f.args)).state, "ready"); assert.deepEqual(gates, expected); });
test("gate failure prevents Back and unchanged retries", async () => {
  const f = await fixture(); let failed = true, count = 0; const store = new MergeWorkflowStore(f.data, async () => { count++; return failed ? { ...ok, exitCode: 1 } : ok; }); await commit(f.source, "task.txt", "task\n"); const first = await store.prep(f.args); assert.equal(first.state, "failed"); await assert.rejects(() => store.back({ merge_id: first.merge_id, session_id: f.args.session_id }), /ready/); failed = false; await assert.rejects(() => store.prep({ ...f.args, merge_id: first.merge_id }), /relevant.*input|unchanged/); assert.equal(count, 1); await commit(f.source, "task.txt", "repaired\n"); assert.equal((await store.prep({ ...f.args, merge_id: first.merge_id })).state, "ready"); assert.equal(count, 2);
});
test("Back rejects target and source movement", async () => { for (const changed of ["target", "source"] as const) { const f = await fixture(), store = new MergeWorkflowStore(f.data, async () => ok); await commit(f.source, "task.txt", "task\n"); const ready = await store.prep(f.args); await commit(f[changed], "shared.txt", `${changed}\n`); await assert.rejects(() => store.back({ merge_id: ready.merge_id, session_id: f.args.session_id }), /stale|changed|diverged/); } });
test("Back pins ignored inputs and untracked root metadata", async () => { for (const filename of ["vendor/code.txt", "vendor.meta"]) { const f = await fixture(), store = new MergeWorkflowStore(f.data, async () => ok); await mkdir(path.join(f.source, "vendor")); await writeFile(path.join(f.source, filename), "before\n"); await commit(f.source, "task.txt", "task\n"); const ready = await store.prep(f.args); assert.equal(ready.state, "ready"); await writeFile(path.join(f.source, filename), "after\n"); await assert.rejects(() => store.back({ merge_id: ready.merge_id, session_id: f.args.session_id }), /input|stale|changed/); } });
test("local file packages pin actual content and revision", async () => {
  const f = await fixture(), dep = path.join(f.container, "dependency"); await mkdir(dep); await git(dep, "init", "-b", "main"); await git(dep, "config", "user.name", "Captain Test"); await git(dep, "config", "user.email", "captain@example.invalid"); await commit(dep, "code.ts", "before\n"); await mkdir(path.join(f.source, "Packages")); await writeFile(path.join(f.source, "Packages", "manifest.json"), JSON.stringify({ dependencies: { "com.example.dep": `file:${dep.replaceAll("\\", "/")}` } })); await git(f.source, "add", "Packages"); await git(f.source, "commit", "-m", "feat(test): package fixture"); const store = new MergeWorkflowStore(f.data, async () => ok), ready = await store.prep(f.args); assert.equal(ready.state, "ready"); await writeFile(path.join(dep, "code.ts"), "dirty after\n"); await assert.rejects(() => store.back({ merge_id: ready.merge_id, session_id: f.args.session_id }), /depend|input|stale/);
});
test("trusted gate source mutation produces failed prep", async () => { const f = await fixture(); await commit(f.source, "task.txt", "task\n"); const store = new MergeWorkflowStore(f.data, async () => { await writeFile(path.join(f.source, "task.txt"), "gate changed source\n"); return ok; }); const result = await store.prep(f.args); assert.equal(result.state, "failed"); await assert.rejects(() => store.back({ merge_id: result.merge_id, session_id: f.args.session_id }), /ready/); });
test("ownership rejects another session and foreign target branch lease", async () => {
  const f = await fixture(), store = new MergeWorkflowStore(f.data, async () => ok); await commit(f.source, "task.txt", "task\n"); const ready = await store.prep(f.args); await assert.rejects(() => store.back({ merge_id: ready.merge_id, session_id: "other" }), /session|owner/); const common = await git(f.target, "rev-parse", "--path-format=absolute", "--git-common-dir"), lease = createHash("sha256").update(`${path.resolve(common)}\0refs/heads/main`.toLowerCase()).digest("hex"); await acquireAuthorizedLease(f.data, lease, { intentId: "foreign", leaseToken: "token", sessionId: "other" }); await assert.rejects(() => store.back({ merge_id: ready.merge_id, session_id: f.args.session_id }), /leased|owner/);
});
test("dirty target is refused without discarding human work", async () => { const f = await fixture(), store = new MergeWorkflowStore(f.data, async () => ok); await writeFile(path.join(f.target, "shared.txt"), "human work\n"); await assert.rejects(() => store.prep(f.args), /clean|dirty/); assert.equal(await readFile(path.join(f.target, "shared.txt"), "utf8"), "human work\n"); });
test("signed tampering and revision tail rollback cannot restore readiness", async () => {
  for (const mode of ["tamper", "rollback"]) { const f = await fixture(), store = new MergeWorkflowStore(f.data, async () => ok); await commit(f.source, "task.txt", "task\n"); const ready = await store.prep(f.args), files = (await readdir(path.join(f.data, "merge-revisions"))).filter(name => name.startsWith(ready.merge_id)).sort((a, b) => Number(a.match(/-(\d+)\.json$/)![1]) - Number(b.match(/-(\d+)\.json$/)![1])); assert.ok(files.length > 1); const latest = path.join(f.data, "merge-revisions", files.at(-1)!); if (mode === "tamper") { const content = JSON.parse(await readFile(latest, "utf8")); content.payload.state = "failed"; await writeFile(latest, JSON.stringify(content)); } else await unlink(latest); await assert.rejects(() => store.back({ merge_id: ready.merge_id, session_id: f.args.session_id }), /authority|tag|watermark|regressed/); }
});
test("interrupted Back recovers the exact already integrated target without gates", async () => {
  const f = await fixture(); let count = 0; const store = new MergeWorkflowStore(f.data, async () => { count++; return ok; }); await commit(f.source, "task.txt", "task\n"); const ready = await store.prep(f.args);
  const previous = JSON.parse(await readFile(path.join(f.data, "merge-revisions", `${ready.merge_id}-${ready.revision}.json`), "utf8")).payload, recovering = { ...previous, revision: previous.revision + 1, previous_sha256: createHash("sha256").update(JSON.stringify(previous)).digest("hex"), state: "integrating" };
  await putAuthorizedOnceExact(f.data, "merge-revisions", `${ready.merge_id}-${recovering.revision}`, recovering); await git(f.target, "merge", "--ff-only", ready.ready_inputs!.source.head);
  assert.equal((await store.back({ merge_id: ready.merge_id, session_id: f.args.session_id })).state, "merged"); assert.equal(count, 1);
});
test("a failed subsequent prep supersedes an earlier successful receipt", async () => {
  const f = await fixture(); let failed = false; const store = new MergeWorkflowStore(f.data, async () => failed ? { ...ok, exitCode: 1 } : ok); await commit(f.source, "task.txt", "task\n"); const ready = await store.prep(f.args); await commit(f.source, "task.txt", "later\n"); failed = true;
  assert.equal((await store.prep({ ...f.args, merge_id: ready.merge_id })).state, "failed"); await assert.rejects(() => store.back({ merge_id: ready.merge_id, session_id: f.args.session_id }), /ready/);
});
test("completed signed implementation evidence stays byte for byte unchanged", async () => {
  const f = await fixture(), store = new MergeWorkflowStore(f.data, async () => ok); await commit(f.source, "task.txt", "task\n"); const owner = await activeOwner(f, "past-session"), signed = { ...owner, revision: owner.revision + 1, previousRevisionSha256: createHash("sha256").update(JSON.stringify(owner)).digest("hex"), phase: "complete", status: "green", evidence: [{ kind: "proof_passed", head: await git(f.source, "rev-parse", "HEAD") }] };
  await putAuthorizedOnceExact(f.data, "run-revisions", `active-${signed.revision}`, signed); const files = await readdir(path.join(f.data, "run-revisions")), before = await Promise.all(files.map(file => readFile(path.join(f.data, "run-revisions", file), "utf8"))); const ready = await store.prep(f.args); await store.back({ merge_id: ready.merge_id, session_id: f.args.session_id }); assert.deepEqual(await readdir(path.join(f.data, "run-revisions")), files); assert.deepEqual(await Promise.all(files.map(file => readFile(path.join(f.data, "run-revisions", file), "utf8"))), before);
});
test("local archive bytes changing invalidate readiness", async () => {
  const f = await fixture(), archive = path.join(f.container, "package.tgz"); await writeFile(archive, "archive-before"); await mkdir(path.join(f.source, "Packages")); await writeFile(path.join(f.source, "Packages", "manifest.json"), JSON.stringify({ dependencies: { "com.example.archive": `file:${archive.replaceAll("\\", "/")}` } })); await git(f.source, "add", "Packages"); await git(f.source, "commit", "-m", "fixture"); const store = new MergeWorkflowStore(f.data, async () => ok), ready = await store.prep(f.args); await writeFile(archive, "archive-after"); await assert.rejects(() => store.back({ merge_id: ready.merge_id, session_id: f.args.session_id }), /input|stale/);
});
async function activeOwner(f: Awaited<ReturnType<typeof fixture>>, sessionId: string) { const binding = await assertWorktreeBinding(f.source), policy = await loadPolicy(f.source, binding.head), lifecycle = new LifecycleStore(f.data, async () => ok); await lifecycle.markIntent({ intentId: "active", sessionId, turnId: "turn", projectRoot: f.target, prompt: "active implementation" }); return lifecycle.begin({ intentId: "active", objective: "active implementation", projectRoot: f.target, worktreePath: f.source, baseHead: binding.head, branch: binding.branch, commonGitDir: binding.commonGitDir, gitDir: binding.gitDir, policy }); }
test("ordinary active source owner is protected even without target branch lease", async () => {
  const f = await fixture(); const owner = await activeOwner(f, "foreign-session"); assert.equal(owner.leaseId, undefined); await commit(f.source, "task.txt", "task\n"); await commit(f.target, "target.txt", "target\n"); const store = new MergeWorkflowStore(f.data, async () => ok); await assert.rejects(() => store.prep(f.args), /session|owner/); await assert.rejects(() => git(f.source, "rev-parse", "--verify", "MERGE_HEAD"));
});
test("same-session ordinary owner retains signed run while its mutation fence is held", async () => {
  const f = await fixture(), owner = await activeOwner(f, f.args.session_id); await commit(f.source, "task.txt", "task\n"); const before = await readFile(path.join(f.data, "run-revisions", "active-0.json"), "utf8"), fenceId = createHash("sha256").update(`worktree-mutation\0${owner.runId}`).digest("hex"), store = new MergeWorkflowStore(f.data, async () => { assert.equal((await readAuthorizedLease<any>(f.data, fenceId)).operation, "integration-worktree"); return ok; }); assert.equal((await store.prep(f.args)).state, "ready"); assert.equal(await readFile(path.join(f.data, "run-revisions", "active-0.json"), "utf8"), before);
});
test("locked volatile metadata may change during a gate; other metadata stays pinned", async () => {
  const f = await fixture(); await mkdir(path.join(f.source, "vendor")); await writeFile(path.join(f.source, "vendor", "stable.txt"), "stable"); await writeFile(path.join(f.source, "vendor", "volatile.meta"), "before"); await commit(f.source, ".captain-sdlc/dependency-lock.json", JSON.stringify({ schema_version: 2, inputs: [{ path: "vendor", volatile_paths: ["volatile.meta"] }] })); const store = new MergeWorkflowStore(f.data, async () => { await writeFile(path.join(f.source, "vendor", "volatile.meta"), "after"); return ok; }); const ready = await store.prep(f.args); assert.equal(ready.state, "ready"); await writeFile(path.join(f.source, "vendor", "stable.meta"), "unexpected"); await assert.rejects(() => store.back({ merge_id: ready.merge_id, session_id: f.args.session_id }), /input|stale/);
});
for (const stage of ["before-ref", "after-ref"] as const) test(`prepared merge commit recovery ${stage} consumes the signed candidate`, async () => {
  const f = await fixture(), store = new MergeWorkflowStore(f.data, async () => ok); await commit(f.source, "task.txt", "task\n"); await commit(f.target, "target.txt", "target\n"); const pending = await store.prep(f.args), request = await mergeCommit(f.source, ["target.txt"], "chore(merge): prepared recovery");
  const old = JSON.parse(await readFile(path.join(f.data, "merge-revisions", `${pending.merge_id}-${pending.revision}.json`), "utf8")).payload;
  await assert.rejects(() => commitAtomic(f.source, request.paths, request.subject, undefined, undefined, pending.captured_policy.commit, [pending.prepared_merge!], pending.source_binding.branch, pending.source_binding.commonGitDir, pending.prepared_merge!.preMergeHead, pending.source_binding.gitDir, async prepared => { await putAuthorizedOnceExact(f.data, "merge-revisions", `${pending.merge_id}-${old.revision + 1}`, { ...old, revision: old.revision + 1, previous_sha256: createHash("sha256").update(JSON.stringify(old)).digest("hex"), prepared_commit: prepared, prepared_commit_request: request }); }, undefined, stage === "after-ref" ? async () => { throw new Error("simulated interruption"); } : undefined, stage === "before-ref" ? async () => { throw new Error("simulated interruption"); } : undefined), /simulated interruption/);
  assert.equal((await store.prep({ ...f.args, merge_id: pending.merge_id, commit: request })).state, "ready");
});
test("a crash after target merge authorization resumes the same clean operation", async () => {
  const f = await fixture(), store = new MergeWorkflowStore(f.data, async () => ok); await commit(f.source, "task.txt", "task\n"); await commit(f.target, "target.txt", "target\n"); const pending = await store.prep(f.args); await git(f.source, "merge", "--abort"); const resumed = await store.prep({ ...f.args, merge_id: pending.merge_id }); assert.equal(resumed.merge_id, pending.merge_id); assert.equal(resumed.state, "needs_commit"); assert.equal(await git(f.source, "rev-parse", "MERGE_HEAD"), pending.target_binding.head);
});
test("Back treats an exact independently prepared target as idempotent", async () => {
  const f = await fixture(); let gates = 0; const store = new MergeWorkflowStore(f.data, async () => { gates++; return ok; }); await commit(f.source, "task.txt", "task\n"); const ready = await store.prep(f.args); await git(f.target, "merge", "--ff-only", ready.ready_inputs!.source.head); assert.equal((await store.back({ merge_id: ready.merge_id, session_id: f.args.session_id })).state, "merged"); assert.equal(gates, 1);
});
test("an unfinished target task owner without branch lease prevents integration", async () => {
  const f = await fixture(), targetBinding = await assertWorktreeBinding(f.target), owner = { schemaVersion: 1, intentId: "target-owner", revision: 0, runId: "target-run", phase: "implement", status: "running", sessionId: f.args.session_id, worktreePath: f.target, branch: targetBinding.branch, commonGitDir: targetBinding.commonGitDir, gitDir: targetBinding.gitDir, policy: await loadPolicy(f.target, targetBinding.head), evidence: [] }; await putAuthorizedOnceExact(f.data, "run-revisions", "target-owner-0", owner); const store = new MergeWorkflowStore(f.data, async () => ok); await commit(f.source, "task.txt", "task\n"); await assert.rejects(() => store.prep(f.args), /target.*owner/);
});
