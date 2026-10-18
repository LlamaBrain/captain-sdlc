import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import path from "node:path";
import { diagnoseBeginTargetLease, type BeginDiagnosticDependencies } from "../src/begin-diagnostics.js";

const hashText = (value: string) => createHash("sha256").update(value).digest("hex");
const hashJson = (value: unknown) => hashText(JSON.stringify(value));

function fixture() {
  const root = path.resolve("C:/Captain-fixture/project");
  const commonGitDir = path.join(root, ".git");
  const intentId = "intent-585bbfca-2d38-4de4-859f-5bab1e5747ed";
  const sessionId = "same-session-private";
  const turnId = "turn-17";
  const branch = "mt/feat/material-design";
  const oid = "a".repeat(40);
  const operationToken = "operation-token-must-not-leak";
  const leaseToken = "lease-token-must-not-leak";
  const intent = {
    intentId, sessionId, turnId, projectRoot: root,
    prompt: "private task prompt must not leak",
    targetBranch: branch, targetOid: oid,
  };
  const operation = {
    schemaVersion: 1, intentId, operationToken, leaseToken, runId: "codex-test",
    startedAt: "2026-10-09T00:00:00.000Z", sessionId, turnId, projectRoot: root,
    objective: "private objective must not leak", taskId: "task-17", targetBranch: branch, targetOid: oid,
  };
  const issuanceId = hashText(JSON.stringify([root, sessionId, turnId]));
  const targetLeaseId = hashText((commonGitDir + "\0refs/heads/" + branch).toLowerCase());
  const sessionLeaseId = hashText("session-active\0" + sessionId);
  const records = new Map<string, unknown>([
    ["intents/" + intentId, intent],
    ["intent-issuance/" + issuanceId, {
      request: {
        sessionId, turnId, projectRoot: root, prompt: intent.prompt,
        taskId: "task-17", targetBranch: branch,
        action: "start",
      },
      intent: JSON.parse(JSON.stringify(intent)),
    }],
    ["begin-operations/" + intentId, operation],
    ["begin-intent-consumed/" + operationToken, { schemaVersion: 1, operationToken, intentId }],
    ["begin-repositories/" + operationToken, {
      schemaVersion: 1, operationToken, projectRoot: root, baseHead: oid,
      commonGitDir, policySha256: "b".repeat(64),
    }],
  ]);
  const leases = new Map<string, any>([
    [targetLeaseId, {
      state: "held",
      revision: 3,
      legacy: false,
      integrity: "verified",
      payload: {
        intentId, leaseToken, commonGitDir, targetBranch: branch, targetOid: oid,
        // This is a genuine legacy owner shape: no owner PID/host/session metadata.
      },
    }],
  ]);
  let inspectCalls = 0;
  const deps: BeginDiagnosticDependencies = {
    async readSigned(bucket, id) {
      const value = records.get(bucket + "/" + id);
      if (value === undefined) {
        const error = new Error("missing") as NodeJS.ErrnoException;
        error.code = "ENOENT";
        throw error;
      }
      return JSON.parse(JSON.stringify(value));
    },
    async listSigned(bucket) {
      return [...records.keys()]
        .filter(key => key.startsWith(bucket + "/"))
        .map(key => key.slice(bucket.length + 1) + ".json");
    },
    async readLease(id) {
      const value = leases.get(id);
      return value ? JSON.parse(JSON.stringify(value)) : undefined;
    },
    async inspectGit(input) {
      inspectCalls++;
      return {
        projectRoot: root, targetWorktree: root, commonGitDir,
        targetRefOid: oid, targetBranchWorktreePath: root,
        targetBranchWorktreeHead: oid, canonicalProposedPathExists: false,
        canonicalWorktreeRegistered: false, pendingGitOperation: false,
      };
    },
    ownerState(payload) {
      return typeof payload.ownerPid === "number" && typeof payload.ownerHost === "string"
        ? "stopped"
        : "unknown";
    },
  };
  const args = {
    intent_id: intentId, session_id: sessionId, project_root: root,
    target_worktree: root, target_branch: branch,
  };
  return {
    args, deps, records, leases, targetLeaseId, sessionLeaseId,
    intentId, operation, operationToken, leaseToken, branch, root, oid,
    inspectCalls: () => inspectCalls,
  };
}

test("diagnosis authenticates the exact pending Begin and redacts every token/prompt", async () => {
  const f = fixture();
  const before = [...f.records.keys()].sort();
  const result: any = await diagnoseBeginTargetLease(f.args, f.deps);
  assert.equal(result.read_only, true);
  assert.equal(result.diagnosis, "inspected");
  assert.equal(result.session_match, "same");
  assert.equal(result.issuance, "verified");
  assert.equal(result.reservation, "verified");
  assert.equal(result.repository_checkpoint, "verified");
  assert.equal(result.lease_checkpoint, "absent");
  assert.equal(result.stage, "lease_acquired_before_checkpoint");
  assert.equal(result.target_lease.state, "held");
  assert.equal(result.target_lease.owner, "legacy");
  assert.equal(result.target_lease.bindings_match, true);
  assert.match(result.target_lease.resource_generation!, /^[a-f0-9]{64}$/);
  assert.equal(result.recovery_disposition, "refused_legacy_owner_unproven");
  assert.equal(result.observed_branch_checkout_outside_canonical, true);
  assert.deepEqual([...f.records.keys()].sort(), before);
  assert.equal("writeSigned" in f.deps, false);
  assert.equal("releaseLease" in f.deps, false);
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /operation-token-must-not-leak|lease-token-must-not-leak|same-session-private|private task prompt|private objective/);
});

test("foreign and missing intents have the same redacted response before inspection", async () => {
  const f = fixture();
  const result: any = await diagnoseBeginTargetLease({ ...f.args, session_id: "foreign-session-secret" }, f.deps);
  const missing: any = await diagnoseBeginTargetLease({ ...f.args, intent_id: "intent-not-present" }, f.deps);
  assert.deepEqual(result, { read_only: true, intent_id: f.intentId, diagnosis: "unavailable", session_match: "unknown" });
  assert.deepEqual(missing, { read_only: true, intent_id: "intent-not-present", diagnosis: "unavailable", session_match: "unknown" });
  assert.equal(f.inspectCalls(), 0);
  assert.doesNotMatch(JSON.stringify(result) + JSON.stringify(missing), /foreign-session-secret|lease-token|operation-token/);
});

test("a mismatched signed issuance receipt cannot make a held lease recoverable", async () => {
  const f = fixture();
  const receiptId = hashText(JSON.stringify([f.root, "same-session-private", "turn-17"]));
  const receipt = f.records.get("intent-issuance/" + receiptId) as any;
  receipt.intent.prompt = "tampered";
  f.records.set("intent-issuance/" + receiptId, receipt);
  const result: any = await diagnoseBeginTargetLease(f.args, f.deps);
  assert.equal(result.issuance, "missing_or_mismatched");
  assert.equal(result.recovery_disposition, "refused_binding_or_lease_mismatch");
});

test("workspace or canonical-worktree evidence blocks pre-workspace recovery", async () => {
  const f = fixture();
  f.records.set("begin-workspaces/" + f.operationToken, {
    schemaVersion: 1, operationToken: f.operationToken, projectRoot: f.root,
    worktreePath: path.join(f.root, ".captain-sdlc", "worktrees", f.intentId),
    baseHead: f.oid, branch: f.branch, commonGitDir: path.join(f.root, ".git"),
    gitDir: path.join(f.root, ".git", "worktrees", f.intentId),
    targetBranch: f.branch,
  });
  const result: any = await diagnoseBeginTargetLease(f.args, f.deps);
  assert.equal(result.stage, "workspace_checkpointed");
  assert.equal(result.later_state.workspace, true);
  assert.equal(result.recovery_disposition, "refused_later_or_ambiguous_state");

  const g = fixture();
  (g.deps.inspectGit as any) = async () => ({
    projectRoot: g.root, targetWorktree: g.root, commonGitDir: path.join(g.root, ".git"),
    targetRefOid: g.oid, targetBranchWorktreePath: g.root,
    targetBranchWorktreeHead: g.oid, canonicalProposedPathExists: true,
    canonicalWorktreeRegistered: false, pendingGitOperation: false,
  });
  const canonical: any = await diagnoseBeginTargetLease(g.args, g.deps);
  assert.equal(canonical.later_state.canonical_path_exists, true);
  assert.equal(canonical.recovery_disposition, "refused_later_or_ambiguous_state");
});

test("a run revision, activation, permit, or pending Git operation is never treated as an orphan", async () => {
  const f = fixture();
  f.records.set("runs/" + f.intentId, {
    schemaVersion: 1, intentId: f.intentId, operationToken: f.operationToken,
    runId: f.operation.runId, sessionId: f.args.session_id, turnId: "turn-17",
    projectRoot: f.root,
    worktreePath: path.join(f.root, ".captain-sdlc", "worktrees", f.intentId),
    baseHead: f.oid, branch: f.branch, targetBranch: f.branch,
  });
  const result: any = await diagnoseBeginTargetLease(f.args, f.deps);
  assert.equal(result.stage, "run_checkpointed");
  assert.equal(result.later_state.run, true);
  assert.equal(result.recovery_disposition, "refused_later_or_ambiguous_state");

  const g = fixture();
  (g.deps.inspectGit as any) = async (input: any) => ({
    projectRoot: g.root, targetWorktree: g.root, commonGitDir: path.join(g.root, ".git"),
    targetRefOid: g.oid, targetBranchWorktreePath: g.root,
    targetBranchWorktreeHead: g.oid, canonicalProposedPathExists: false,
    canonicalWorktreeRegistered: false, pendingGitOperation: true,
  });
  const pendingGit: any = await diagnoseBeginTargetLease(g.args, g.deps);
  assert.equal(pendingGit.later_state.pending_git_operation, true);
  assert.equal(pendingGit.recovery_disposition, "refused_later_or_ambiguous_state");
});

test("only a fully bound signed Begin permit advances the authenticated stage", async () => {
  const f = fixture();
  const id = f.operationToken + "-turn-17";
  const permit = {
    schemaVersion: 1,
    sessionId: f.args.session_id,
    turnId: "turn-17",
    worktreePath: path.join(f.root, ".captain-sdlc", "worktrees", f.intentId),
    phase: "tdd_red",
    intentId: f.intentId,
    runId: f.operation.runId,
    runRevision: 0,
    operationToken: f.operationToken,
    activationToken: f.operationToken,
    sessionLeaseId: f.sessionLeaseId,
    sessionLeaseToken: f.operationToken,
    frozenPlanPaths: [],
    activated: true,
  };
  f.records.set("begin-permits/" + id, permit);
  const valid: any = await diagnoseBeginTargetLease(f.args, f.deps);
  assert.equal(valid.stage, "permit_published");
  assert.equal(valid.later_state.permit, true);
  assert.equal(valid.recovery_disposition, "refused_later_or_ambiguous_state");

  const g = fixture();
  g.records.set("begin-permits/" + g.operationToken + "-turn-17", { ...permit, intentId: "other-intent" });
  const tampered: any = await diagnoseBeginTargetLease(g.args, g.deps);
  assert.equal(tampered.diagnosis, "untrusted");
  assert.equal(tampered.recovery_disposition, undefined);
});

test("malformed same-intent run revision filenames are untrusted rather than absent", async () => {
  const f = fixture();
  f.records.set("run-revisions/" + f.intentId + "-01", { schemaVersion: 1 });
  const result: any = await diagnoseBeginTargetLease(f.args, f.deps);
  assert.equal(result.diagnosis, "untrusted");
  assert.equal(result.recovery_disposition, undefined);
});

test("lease checkpoint and target lease require their signed resource bindings", async () => {
  const f = fixture();
  f.records.set("begin-leases/" + f.operationToken, {
    operationToken: f.operationToken, leaseToken: f.leaseToken,
    commonGitDir: path.join(f.root, ".git"), targetBranch: f.branch, targetOid: f.oid,
  });
  const missingSchema: any = await diagnoseBeginTargetLease(f.args, f.deps);
  assert.equal(missingSchema.diagnosis, "untrusted");

  const g = fixture();
  const lease = g.leases.get(g.targetLeaseId);
  delete lease.payload.commonGitDir;
  g.leases.set(g.targetLeaseId, lease);
  const noCommonDir: any = await diagnoseBeginTargetLease(g.args, g.deps);
  assert.equal(noCommonDir.target_lease.bindings_match, false);
  assert.equal(noCommonDir.recovery_disposition, "refused_binding_or_lease_mismatch");
});

test("incomplete modern owner metadata never reaches process classification", async () => {
  const f = fixture();
  let ownerChecks = 0;
  f.deps.ownerState = () => { ownerChecks++; return "stopped"; };
  const variants = [
    { ownerHost: "", ownerPid: 123, ownerProcessStart: "start" },
    { ownerHost: "host", ownerPid: -1, ownerProcessStart: "start" },
    { ownerHost: "host", ownerPid: 123, ownerProcessStart: "  " },
  ];
  for (const identity of variants) {
    const lease = f.leases.get(f.targetLeaseId);
    lease.payload = {
      ...lease.payload,
      ...identity,
      ownerSessionId: f.args.session_id,
      ownerTurnId: "turn-17",
      ownerOperationToken: f.operationToken,
    };
    f.leases.set(f.targetLeaseId, lease);
    const result: any = await diagnoseBeginTargetLease(f.args, f.deps);
    assert.equal(result.target_lease.owner, "unknown");
    assert.equal(result.recovery_disposition, "refused_owner_not_proven_stopped");
  }
  assert.equal(ownerChecks, 0);
});

test("project, target branch, and target checkout mismatches are explicit refusals", async () => {
  const f = fixture();
  const wrongRoot: any = await diagnoseBeginTargetLease({
    ...f.args, project_root: path.join(f.root, "elsewhere"),
  }, f.deps);
  assert.equal(wrongRoot.project_root_matches, false);
  assert.equal(wrongRoot.recovery_disposition, "refused_request_binding_mismatch");
  assert.equal(f.inspectCalls(), 0);

  const wrongBranch: any = await diagnoseBeginTargetLease({
    ...f.args, target_branch: "main",
  }, f.deps);
  assert.equal(wrongBranch.target_branch_matches, false);
  assert.equal(wrongBranch.recovery_disposition, "refused_request_binding_mismatch");
  assert.equal(f.inspectCalls(), 0);

  const inspectTrusted = f.deps.inspectGit;
  f.deps.inspectGit = async input => {
    assert.equal(input.projectRoot, f.root);
    assert.equal(input.targetWorktree, f.root, "caller-supplied checkout never drives Git inspection");
    return inspectTrusted(input);
  };
  const wrongTarget: any = await diagnoseBeginTargetLease({
    ...f.args, target_worktree: path.join(f.root, "unrelated"),
  }, f.deps);
  assert.equal(wrongTarget.target_worktree_matches, false);
  assert.equal(wrongTarget.recovery_disposition, "refused_request_binding_mismatch");
  assert.equal(f.inspectCalls(), 1, "registered checkout is resolved from the signed root before comparison");

  const h = fixture();
  (h.deps.inspectGit as any) = async () => ({
    projectRoot: h.root, targetWorktree: h.root, commonGitDir: path.join(h.root, ".git"),
    targetRefOid: h.oid, targetBranchWorktreePath: h.root,
    targetBranchWorktreeHead: "c".repeat(40), canonicalProposedPathExists: false,
    canonicalWorktreeRegistered: false, pendingGitOperation: false,
  });
  const wrongCheckout: any = await diagnoseBeginTargetLease(h.args, h.deps);
  assert.equal(wrongCheckout.target_worktree_matches, false);
  assert.equal(wrongCheckout.recovery_disposition, "refused_binding_or_lease_mismatch");
});

test("a replacement lease generation is not mistaken for the original Begin lease", async () => {
  const f = fixture();
  const current = f.leases.get(f.targetLeaseId);
  current.revision = 4;
  current.payload = {
    ...current.payload,
    intentId: "intent-other",
    leaseToken: "replacement-generation-secret",
  };
  f.leases.set(f.targetLeaseId, current);
  const result: any = await diagnoseBeginTargetLease(f.args, f.deps);
  assert.equal(result.target_lease.owner, "other");
  assert.equal(result.target_lease.bindings_match, false);
  assert.equal(result.recovery_disposition, "refused_binding_or_lease_mismatch");
  assert.doesNotMatch(JSON.stringify(result), /replacement-generation-secret|intent-other/);
});

test("missing Begin reservation is not inferred as a stopped or recoverable owner", async () => {
  const f = fixture();
  f.records.delete("begin-operations/" + f.intentId);
  const result: any = await diagnoseBeginTargetLease(f.args, f.deps);
  assert.equal(result.reservation, "absent");
  assert.equal(result.stage, "no_reservation");
  assert.equal(result.target_lease.bindings_match, false);
  assert.equal(result.recovery_disposition, "refused_binding_or_lease_mismatch");
});

test("an unknown process owner stays refused even when every signed binding matches", async () => {
  const f = fixture();
  const lease = f.leases.get(f.targetLeaseId);
  lease.payload = {
    ...lease.payload,
    ownerHost: "host-a", ownerPid: 123, ownerProcessStart: "instance-a",
    ownerSessionId: f.args.session_id, ownerTurnId: "turn-17",
    ownerOperationToken: f.operationToken,
  };
  f.leases.set(f.targetLeaseId, lease);
  f.deps.ownerState = () => "unknown";
  const result: any = await diagnoseBeginTargetLease(f.args, f.deps);
  assert.equal(result.recovery_disposition, "refused_owner_not_proven_stopped");
  assert.equal(result.target_lease.owner, "unknown");
});

test("owner identity must bind to the signed attempt and diagnosis never releases a stopped owner's lease", async () => {
  const f = fixture();
  const lease = f.leases.get(f.targetLeaseId);
  lease.payload = {
    ...lease.payload,
    ownerHost: "host-a", ownerPid: 123, ownerProcessStart: "instance-a",
    ownerSessionId: "different-session", ownerTurnId: "turn-17",
    ownerOperationToken: f.operationToken,
  };
  f.leases.set(f.targetLeaseId, lease);
  f.deps.ownerState = () => "stopped";
  const mismatched: any = await diagnoseBeginTargetLease(f.args, f.deps);
  assert.equal(mismatched.target_lease.owner, "unknown");
  assert.equal(mismatched.recovery_disposition, "refused_owner_not_proven_stopped");

  const g = fixture();
  const stoppedLease = g.leases.get(g.targetLeaseId);
  stoppedLease.payload = {
    ...stoppedLease.payload,
    ownerHost: "host-a", ownerPid: 123, ownerProcessStart: "instance-a",
    ownerSessionId: g.args.session_id, ownerTurnId: "turn-17",
    ownerOperationToken: g.operationToken,
  };
  g.leases.set(g.targetLeaseId, stoppedLease);
  g.deps.ownerState = () => "stopped";
  const stopped: any = await diagnoseBeginTargetLease(g.args, g.deps);
  assert.equal(stopped.target_lease.owner, "stopped");
  assert.equal(stopped.recovery_disposition, "requires_begin_recovery_fence");
  assert.equal(g.leases.get(g.targetLeaseId).state, "held");
  assert.equal("releaseLease" in g.deps, false);
});
