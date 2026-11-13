import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { LifecycleStore, type Run } from "../src/lifecycle.js";
import { captainBegin, captainIssueIntent } from "../src/server.js";
import { createBeginDiagnosticAdapter } from "../src/begin-diagnostic-adapter.js";
import { BranchLeaseRecoveryStore } from "../src/branch-lease-recovery.js";
import { BookkeepingFinalizationStore } from "../src/bookkeeping-finalization.js";
import { readAuthorizedReadOnly, writeAuthorized } from "../src/authority.js";
import { git, sourceState } from "../src/workspace.js";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
async function fixture(t: TestContext) {
  const container = await mkdtemp(path.join(tmpdir(), "captain-run-consumers-"));
  t.after(async () => {
    assert.equal(path.dirname(container), path.resolve(tmpdir()));
    assert.ok(path.basename(container).startsWith("captain-run-consumers-"));
    await rm(container, { recursive: true, force: true });
  });
  const project = path.join(container, "project"), data = path.join(container, "authority");
  await mkdir(path.join(project, ".captain-sdlc"), { recursive: true });
  await git(["init", "-b", "main"], project); await git(["config", "user.name", "Captain Fixture"], project);
  await git(["config", "user.email", "captain@example.invalid"], project); await git(["config", "core.autocrlf", "false"], project);
  await writeFile(path.join(project, ".gitignore"), ".captain-sdlc/worktrees/\n.captain-proof/\n");
  await writeFile(path.join(project, "README.md"), "# Original operator guidance\n");
  await writeFile(path.join(project, "VERSION"), "1.0.0\n"); await writeFile(path.join(project, "CHANGELOG.md"), "# Changelog\n");
  await writeFile(path.join(project, ".captain-sdlc", "captain.ignore"), "/Churn/\n");
  await writeFile(path.join(project, ".captain-sdlc", "codex-policy.json"), JSON.stringify({
    profile: "low", visualRequired: false,
    commands: { build: "trusted-build", ticket: "trusted-ticket", "feature-smoke": "trusted-smoke", "affected-regression": "trusted-regression" },
    commit: { conventional: true, require_version_suffix: true, version_file: "VERSION", version_surfaces: [{ path: "VERSION", pattern: "(?m)^(?<version>[0-9]+\\.[0-9]+\\.[0-9]+)\\s*$" }], changelog_files: ["CHANGELOG.md"], bookkeeping: { path_file: ".captain-sdlc/captain.ignore" } },
  }));
  await git(["add", "."], project); await git(["commit", "-m", "fixture baseline"], project);
  const base = await git(["rev-parse", "HEAD"], project), session = "documentation-consumer-session";
  const store = new LifecycleStore(data, async () => ({ exitCode: 0, stdout: "", stderr: "" }), sourceState);
  const failed = await captainIssueIntent(store, { project_root: project, session_id: session, turn_id: "failed-begin-turn", prompt: "Start the bounded fixture task on main", task_id: "failed-main-task", target_branch: "main", action: "start" });
  await assert.rejects(() => captainBegin(store, { project_root: project, intent_id: failed.intent_id, objective: "Demonstrate failed Begin on the primary checkout", task_id: "failed-main-task" }), /outside.*canonical/i);
  const branch = "captain/documentation-consumer";
  await git(["branch", branch, base], project);
  const issued = await captainIssueIntent(store, { project_root: project, session_id: session, turn_id: "documentation-turn", prompt: "Clarify only operator documentation", task_id: "documentation-owner", target_branch: branch, action: "start" });
  const intentId = issued.intent_id;
  const worktree = path.join(project, ".captain-sdlc", "worktrees", intentId);
  await git(["worktree", "add", worktree, branch], project);
  await captainBegin(store, { intent_id: intentId, objective: "Clarify only operator documentation", project_root: project, task_id: "documentation-owner" });
  await writeFile(path.join(worktree, "README.md"), "# Clarified operator guidance\n");
  const classified = await store.prepareDocumentation(intentId, ["README.md"], "Operator documentation only", base);
  assert.equal(classified.schemaVersion, 2);
  await store.pause(intentId, { summary: "Retain the documentation fixture for read-only consumer checks", nextSteps: ["Resume the same documentation task"] });
  const metadata = path.join(container, "metadata");
  await git(["worktree", "add", "-b", "metadata-records", metadata, base], project);
  const prepareMetadata = async () => {
    await mkdir(path.join(metadata, "Churn"), { recursive: true }); await writeFile(path.join(metadata, "Churn", "consumer-check.md"), "Retain consumer compatibility evidence.\n");
    return { worktree: metadata, session_id: "metadata-session", task_id: "metadata-task", paths: ["Churn/consumer-check.md"], subject: "docs(captain): retain consumer evidence", disposition: "commit" as const };
  };
  return { container, project, data, base, session, store, intentId, worktree, branch, failed,
    diagnosisArgs: { project_root: project, target_worktree: worktree, target_branch: branch, intent_id: intentId, session_id: session },
    recoveryArgs: { project_root: project, target_worktree: project, target_branch: "main", intent_id: failed.intent_id, session_id: session },
    metadata, prepareMetadata };
}

async function forgeUnauditedScope(f: Awaited<ReturnType<typeof fixture>>) {
  const latest = await f.store.status(f.intentId);
  const classification = await readAuthorizedReadOnly<Run>(f.data, "run-revisions", `${f.intentId}-${latest.revision - 1}`);
  const badScope = { ...classification.documentationScope!, expectedHead: "f".repeat(40) };
  const forged = { ...classification, documentationScope: badScope, evidence: [...classification.evidence.slice(0, -1), { kind: "documentation_scope", ...badScope }] };
  await writeAuthorized(f.data, "run-revisions", `${f.intentId}-${forged.revision}`, forged);
  await writeAuthorized(f.data, "run-watermarks", `${f.intentId}-${forged.revision}`, { schemaVersion: 1, intentId: f.intentId, runId: forged.runId, revision: forged.revision, runSha256: hash(forged), previousRevisionSha256: forged.previousRevisionSha256 });
  const tail = { ...latest, documentationScope: badScope, previousRevisionSha256: hash(forged), evidence: [...latest.evidence] };
  tail.evidence[classification.evidence.length - 1] = { kind: "documentation_scope", ...badScope };
  await writeAuthorized(f.data, "run-revisions", `${f.intentId}-${tail.revision}`, tail);
  await writeAuthorized(f.data, "run-watermarks", `${f.intentId}-${tail.revision}`, { schemaVersion: 1, intentId: f.intentId, runId: tail.runId, revision: tail.revision, runSha256: hash(tail), previousRevisionSha256: tail.previousRevisionSha256 });
  await writeAuthorized(f.data, "runs", f.intentId, tail);
}

test("Begin diagnostics authenticate real audited schema-2 documentation history", async t => {
  const f = await fixture(t), diagnosis = await createBeginDiagnosticAdapter(f.data)(f.diagnosisArgs);
  assert.equal(diagnosis.diagnosis, "inspected");
  assert.equal(diagnosis.later_state?.run, true);
});

test("failed-Begin recovery recognizes a real paused schema-2 documentation owner", async t => {
  const f = await fixture(t), evidence = await f.store.readBeginCancellationEvidence(f.failed.intent_id);
  assert.equal(evidence.pausedSessionOwner?.worktreePath, f.worktree);
  const diagnosis: any = await new BranchLeaseRecoveryStore(f.data).diagnoseFailedBegin(f.recoveryArgs);
  assert.equal(diagnosis.original_state.unrelated_paused_session_projection_verified, true);
  assert.equal(diagnosis.original_state.session_activity.correlated_run_verified, true);
  assert.equal(diagnosis.original_state.session_activity.correlated_run_status, "paused");
});

test("bookkeeping consumers accept a lawful schema-2 history on another owned branch", async t => {
  const f = await fixture(t), receipt = await new BookkeepingFinalizationStore(f.data).finalize(await f.prepareMetadata());
  assert.equal(receipt.state, "committed");
  assert.equal(await git(["rev-parse", "HEAD"], f.worktree), f.base);
});

test("consumer readers reject cryptographically valid but unaudited schema-2 transitions", async t => {
  const f = await fixture(t); await forgeUnauditedScope(f);
  const diagnosis = await createBeginDiagnosticAdapter(f.data)(f.diagnosisArgs);
  assert.equal(diagnosis.diagnosis, "untrusted");
  const recovery = await new BranchLeaseRecoveryStore(f.data).diagnoseFailedBegin(f.recoveryArgs);
  assert.equal(recovery.eligible, false); assert.equal(recovery.verified_pre_workspace, false);
  const before = await git(["rev-parse", "HEAD"], f.metadata);
  await assert.rejects(async () => new BookkeepingFinalizationStore(f.data).finalize(await f.prepareMetadata()));
  assert.equal(await git(["rev-parse", "HEAD"], f.metadata), before, "invalid history must be rejected before bookkeeping Git mutation");
});

test("flat documentation snapshots cannot replace the audited schema-2 revision chain", async t => {
  const f = await fixture(t), owner = await f.store.status(f.intentId);
  await writeAuthorized(f.data, "runs", "legacy-documentation-snapshot", { ...owner, intentId: "legacy-documentation-snapshot" });
  const diagnosis = await new BranchLeaseRecoveryStore(f.data).diagnoseFailedBegin(f.recoveryArgs);
  assert.equal(diagnosis.eligible, false); assert.equal(diagnosis.verified_pre_workspace, false);
  const before = await git(["rev-parse", "HEAD"], f.metadata);
  await assert.rejects(async () => new BookkeepingFinalizationStore(f.data).finalize(await f.prepareMetadata()), /audited.*revision chain/i);
  assert.equal(await git(["rev-parse", "HEAD"], f.metadata), before);
});
