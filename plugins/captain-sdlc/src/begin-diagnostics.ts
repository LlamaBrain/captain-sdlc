import { createHash } from "node:crypto";
import path from "node:path";
import type { Run } from "./lifecycle.js";
import { assertRunRevisionTransition, isSupportedRunSchema } from "./run-validation.js";

type AnyRecord = Record<string, unknown>;
type Presence = { present: false } | { present: true; value: AnyRecord };
type LeaseSnapshot = {
  state: "held" | "released";
  payload: AnyRecord & { intentId: string; leaseToken: string };
  revision: number | null;
  legacy: boolean;
  integrity: "verified";
};

export type BeginDiagnosticArgs = {
  intent_id: string;
  session_id: string;
  project_root: string;
  target_worktree: string;
  target_branch: string;
};

export type BeginDiagnosticDependencies = {
  // Must authenticate an exact envelope without creating directories, migrating
  // records, repairing watermarks, or writing a projection.
  readSigned(bucket: string, id: string): Promise<AnyRecord>;
  listSigned(bucket: string): Promise<string[]>;
  // Must verify the full revision/watermark chain without publishing watermarks,
  // and return the verified latest revision for an opaque generation token.
  readLease(leaseId: string): Promise<LeaseSnapshot | undefined>;
  // Read-only Git/path inspection for the exact supplied target and signed root.
  inspectGit(input: {
    projectRoot: string;
    targetWorktree: string;
    targetBranch: string;
    targetOid: string;
    canonicalProposedPath: string;
  }): Promise<{
    projectRoot: string;
    targetWorktree: string;
    commonGitDir: string;
    targetRefOid: string;
    targetBranchWorktreePath?: string;
    targetBranchWorktreeHead?: string;
    canonicalProposedPathExists: boolean;
    canonicalWorktreeRegistered: boolean;
    pendingGitOperation: boolean | "unknown";
  }>;
  // Only report stopped after host/PID/process-start identity is checked by the
  // adapter. Owner binding to session/turn/operation is checked below.
  ownerState(payload: AnyRecord): "live" | "stopped" | "foreign_host" | "unknown";
};

const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const digestText = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const record = (value: unknown): value is AnyRecord =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const samePath = (left: string, right: string) =>
  path.resolve(left).replace(/[\\/]+$/, "").toLowerCase() ===
  path.resolve(right).replace(/[\\/]+$/, "").toLowerCase();
const safeId = (value: string) => /^[A-Za-z0-9_-]+$/.test(value);
const isMissing = (error: unknown) =>
  record(error) && error.code === "ENOENT";
const withoutConsumed = (value: AnyRecord) => {
  const copy = { ...value };
  delete copy.consumed;
  return copy;
};

function classifyOwner(
  payload: AnyRecord,
  intent: AnyRecord,
  operation: AnyRecord | undefined,
  deps: BeginDiagnosticDependencies,
): "live" | "stopped" | "foreign_host" | "legacy" | "unknown" {
  const ownerFields = [
    payload.ownerHost,
    payload.ownerPid,
    payload.ownerProcessStart,
    payload.ownerSessionId,
    payload.ownerTurnId,
    payload.ownerOperationToken,
  ];
  if (ownerFields.every(value => value === undefined)) return "legacy";
  if (
    typeof payload.ownerHost !== "string" ||
    !payload.ownerHost.trim() ||
    !Number.isSafeInteger(payload.ownerPid) ||
    Number(payload.ownerPid) <= 0 ||
    typeof payload.ownerProcessStart !== "string" ||
    !payload.ownerProcessStart.trim() ||
    payload.ownerSessionId !== intent.sessionId ||
    payload.ownerTurnId !== intent.turnId ||
    payload.ownerOperationToken !== operation?.operationToken
  ) return "unknown";
  return deps.ownerState(payload);
}

async function maybeRead(
  deps: BeginDiagnosticDependencies,
  bucket: string,
  id: string,
): Promise<Presence> {
  try {
    const value = await deps.readSigned(bucket, id);
    if (!record(value)) throw new Error("signed_record_not_object");
    return { present: true, value };
  } catch (error) {
    if (isMissing(error)) return { present: false };
    throw error;
  }
}

function exactRevisions(names: string[], intentId: string, bucket: string) {
  const prefix = intentId + "-";
  const revisions: number[] = [];
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    if (!name.endsWith(".json")) throw new Error(bucket + "_revision_filename_invalid");
    const stem = name.slice(0, -5);
    const raw = stem.slice(prefix.length);
    if (!/^(0|[1-9][0-9]*)$/.test(raw)) throw new Error(bucket + "_revision_filename_invalid");
    revisions.push(Number(raw));
  }
  if (revisions.some(value => !Number.isSafeInteger(value))) {
    throw new Error(bucket + "_revision_invalid");
  }
  return [...new Set(revisions)].sort((a, b) => a - b);
}

async function inspectRunHistory(
  intentId: string,
  operation: AnyRecord,
  intent: AnyRecord,
  canonicalWorktreePath: string,
  deps: BeginDiagnosticDependencies,
) {
  const [revisionNames, watermarkNames, legacy] = await Promise.all([
    deps.listSigned("run-revisions"),
    deps.listSigned("run-watermarks"),
    maybeRead(deps, "runs", intentId),
  ]);
  const revisions = exactRevisions(revisionNames, intentId, "run");
  const watermarks = exactRevisions(watermarkNames, intentId, "run-watermark");
  if (revisions.length === 0 && watermarks.length === 0) {
    if (legacy.present) {
      if (legacy.value.schemaVersion !== 1 || legacy.value.documentationScope || !runMatches(legacy.value, intentId, operation, intent, canonicalWorktreePath)) {
        throw new Error("legacy_run_binding_invalid");
      }
      return { present: true, integrity: "verified" as const, revisionCount: 0 };
    }
    return { present: false, integrity: "verified" as const, revisionCount: 0 };
  }
  if (revisions.length === 0 || revisions.some((value, index) => value !== index)) {
    throw new Error("run_revision_chain_invalid");
  }
  let previous: AnyRecord | undefined;
  for (const revision of revisions) {
    const current = await maybeRead(deps, "run-revisions", intentId + "-" + revision);
    if (!current.present) throw new Error("run_revision_missing");
    if (
      current.value.intentId !== intentId ||
      current.value.revision !== revision ||
      !runMatches(current.value, intentId, operation, intent, canonicalWorktreePath) ||
      (revision === 0
        ? current.value.previousRevisionSha256 !== undefined
        : current.value.previousRevisionSha256 !== digest(previous))
    ) throw new Error("run_revision_binding_invalid");
    const watermark = await maybeRead(deps, "run-watermarks", intentId + "-" + revision);
    const expected = {
      schemaVersion: 1,
      intentId,
      runId: current.value.runId,
      revision,
      runSha256: digest(current.value),
      previousRevisionSha256: current.value.previousRevisionSha256,
    };
    if (!watermark.present || JSON.stringify(watermark.value) !== JSON.stringify(expected)) {
      throw new Error("run_watermark_invalid");
    }
    assertRunRevisionTransition(previous as Run | undefined, current.value as Run);
    previous = current.value;
  }
  if (watermarks.some(value => value > revisions.length - 1)) {
    throw new Error("run_watermark_tail_invalid");
  }
  if (legacy.present && !runMatches(legacy.value, intentId, operation, intent, canonicalWorktreePath)) {
    throw new Error("legacy_run_binding_invalid");
  }
  if (!previous || previous.runId !== operation.runId) throw new Error("run_operation_binding_invalid");
  return { present: true, integrity: "verified" as const, revisionCount: revisions.length };
}

function runMatches(
  run: AnyRecord,
  intentId: string,
  operation: AnyRecord,
  intent: AnyRecord,
  canonicalWorktreePath: string,
) {
  return isSupportedRunSchema(run) &&
    run.intentId === intentId &&
    run.runId === operation.runId &&
    run.operationToken === operation.operationToken &&
    run.sessionId === intent.sessionId &&
    run.turnId === intent.turnId &&
    typeof run.projectRoot === "string" &&
    typeof intent.projectRoot === "string" && samePath(run.projectRoot, intent.projectRoot) &&
    typeof run.worktreePath === "string" && samePath(run.worktreePath, canonicalWorktreePath) &&
    run.targetBranch === intent.targetBranch &&
    run.baseHead === intent.targetOid &&
    run.branch === intent.targetBranch;
}

async function hasAuthenticatedBeginPermit(
  operation: AnyRecord,
  intent: AnyRecord,
  canonicalWorktreePath: string,
  deps: BeginDiagnosticDependencies,
) {
  const prefix = String(operation.operationToken) + "-";
  const names = await deps.listSigned("begin-permits");
  let found = false;
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    if (!name.endsWith(".json")) throw new Error("begin_permit_filename_invalid");
    const turnId = name.slice(prefix.length, -5);
    if (!turnId || !safeId(turnId)) throw new Error("begin_permit_filename_invalid");
    const permit = await maybeRead(deps, "begin-permits", name.slice(0, -5));
    if (!permit.present) throw new Error("begin_permit_missing");
    const value = permit.value;
    if (
      value.schemaVersion !== 1 ||
      value.operationToken !== operation.operationToken ||
      value.intentId !== operation.intentId ||
      value.runId !== operation.runId ||
      value.sessionId !== intent.sessionId ||
      value.turnId !== turnId ||
      typeof value.sessionId !== "string" ||
      value.sessionId !== intent.sessionId ||
      value.activationToken !== operation.operationToken ||
      value.activated !== true ||
      typeof value.worktreePath !== "string" ||
      !samePath(value.worktreePath, canonicalWorktreePath) ||
      value.phase !== "tdd_red" && value.phase !== "implement" && value.phase !== "prove" && value.phase !== "hitl" && value.phase !== "complete" ||
      typeof value.runId !== "string" ||
      !Number.isSafeInteger(value.runRevision) || Number(value.runRevision) < 0 ||
      !Array.isArray(value.frozenPlanPaths) || value.frozenPlanPaths.some((item: unknown) => typeof item !== "string") ||
      value.sessionLeaseId !== digestText("session-active\0" + intent.sessionId) ||
      value.sessionLeaseToken !== operation.operationToken
    ) throw new Error("begin_permit_binding_invalid");
    found = true;
  }
  return found;
}

export async function diagnoseBeginTargetLease(
  args: BeginDiagnosticArgs,
  deps: BeginDiagnosticDependencies,
) {
  const base = { read_only: true as const, intent_id: args.intent_id };
  if (
    !safeId(args.intent_id) ||
    !args.session_id.trim() ||
    !args.project_root.trim() ||
    !args.target_worktree.trim() ||
    !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(args.target_branch)
  ) {
    return { ...base, diagnosis: "invalid_request" as const, session_match: "unknown" as const };
  }

  let intentRead: Presence;
  try {
    intentRead = await maybeRead(deps, "intents", args.intent_id);
  } catch {
    return { ...base, diagnosis: "untrusted" as const, session_match: "unknown" as const, reason: "signed_authority_invalid" };
  }
  if (!intentRead.present) return { ...base, diagnosis: "unavailable" as const, session_match: "unknown" as const };
  const intent = intentRead.value;
  if (typeof intent.sessionId !== "string" || intent.sessionId !== args.session_id) {
    return { ...base, diagnosis: "unavailable" as const, session_match: "unknown" as const };
  }
  if (
    typeof intent.intentId !== "string" ||
    intent.intentId !== args.intent_id ||
    typeof intent.turnId !== "string" ||
    typeof intent.projectRoot !== "string" ||
    typeof intent.prompt !== "string"
  ) {
    return { ...base, diagnosis: "untrusted" as const, session_match: "same" as const, reason: "intent_binding_invalid" };
  }

  try {
    const projectRootMatches = samePath(intent.projectRoot, args.project_root);
    const signedTargetBranch = typeof intent.targetBranch === "string"
      ? intent.targetBranch
      : undefined;
    const branchMatches = signedTargetBranch === args.target_branch;
    const oid = intent.targetOid;
    if (typeof oid !== "string" || !/^[0-9a-f]{40,64}$/i.test(oid)) {
      return {
        ...base, diagnosis: "inspected" as const, session_match: "same" as const,
        project_root_matches: projectRootMatches, target_branch_matches: branchMatches,
        issuance: "invalid_target_binding" as const, stage: "unknown" as const,
        recovery_disposition: "refused" as const, refusal_code: "invalid_target_binding",
      };
    }

    const issuanceId = digestText(JSON.stringify([
      path.resolve(intent.projectRoot), intent.sessionId, intent.turnId,
    ]));
    const issuance = await maybeRead(deps, "intent-issuance", issuanceId);
    const operationRead = await maybeRead(deps, "begin-operations", args.intent_id);
    const operation = operationRead.present ? operationRead.value : undefined;
    const issuanceRequest = issuance.present && record(issuance.value.request)
      ? issuance.value.request
      : undefined;
    const issuedIntentMatches = issuance.present &&
      record(issuance.value.intent) &&
      JSON.stringify(withoutConsumed(issuance.value.intent)) === JSON.stringify(withoutConsumed(intent)) &&
      !!issuanceRequest &&
      issuanceRequest.sessionId === intent.sessionId &&
      issuanceRequest.turnId === intent.turnId &&
      issuanceRequest.prompt === intent.prompt &&
      (issuanceRequest.action === undefined || issuanceRequest.action === "start") &&
      !intent.resumeOf &&
      (intent.taskId === undefined || issuanceRequest.taskId === intent.taskId) &&
      issuanceRequest.resumeOf === intent.resumeOf &&
      issuanceRequest.targetBranch === intent.targetBranch &&
      typeof issuanceRequest.projectRoot === "string" &&
      samePath(issuanceRequest.projectRoot, intent.projectRoot);

    // Never let caller-supplied paths or branches drive local Git inspection.
    // Resolve the signed branch's registered checkout independently of its primary root.
    if (!signedTargetBranch || !projectRootMatches || !branchMatches) {
      return {
        ...base,
        diagnosis: "inspected" as const,
        session_match: "same" as const,
        project_root_matches: projectRootMatches,
        target_branch_matches: branchMatches,
        target_worktree_matches: false,
        issuance: issuedIntentMatches ? "verified" as const : "missing_or_mismatched" as const,
        recovery_disposition: "refused_request_binding_mismatch" as const,
      };
    }

    const operationMatches = !!operation &&
      operation.schemaVersion === 1 &&
      operation.intentId === args.intent_id &&
      operation.sessionId === intent.sessionId &&
      operation.turnId === intent.turnId &&
      typeof operation.operationToken === "string" &&
      typeof operation.leaseToken === "string" &&
      (issuanceRequest !== undefined && issuanceRequest.taskId === operation.taskId) &&
      samePath(String(operation.projectRoot), intent.projectRoot) &&
      operation.targetBranch === intent.targetBranch &&
      operation.targetOid === intent.targetOid;

    const git = await deps.inspectGit({
      projectRoot: intent.projectRoot,
      targetWorktree: intent.projectRoot,
      targetBranch: signedTargetBranch,
      targetOid: oid,
      canonicalProposedPath: path.join(
        path.resolve(intent.projectRoot),
        ".captain-sdlc",
        "worktrees",
        args.intent_id.replace(/[^A-Za-z0-9_-]/g, ""),
      ),
    });
    const targetWorktreeMatches = samePath(git.targetWorktree, args.target_worktree);
    const gitBindingMatches =
      samePath(git.projectRoot, intent.projectRoot) &&
      samePath(git.targetWorktree, args.target_worktree) &&
      git.targetRefOid.toLowerCase() === oid.toLowerCase();

    let repositoryPresent = false, repositoryMatches = false;
    let leaseCheckpointPresent = false, leaseCheckpointMatches = false;
    let workspacePresent = false;
    let leaseState: "absent" | "held" | "released" = "absent";
    let leaseRevision: number | null = null;
    let leaseOwner: "live" | "stopped" | "foreign_host" | "legacy" | "unknown" | "other" = "unknown";
    let leaseGenerationRevisioned = false;
    let leaseBindingsMatch = false;
    let runPresent = false;
    let activePresent = false, activatedPresent = false, permitPresent = false;
    let sessionLeaseHeld = false, projectionActivePresent = false, projectionPermitPresent = false;
    let consumedMarkerPresent = false;
    const commonGitDir = git.commonGitDir;

    if (operation && operationMatches) {
      const consumed = await maybeRead(deps, "begin-intent-consumed", operation.operationToken as string);
      consumedMarkerPresent = consumed.present;
      if (consumed.present &&
          (consumed.value.schemaVersion !== 1 ||
           consumed.value.operationToken !== operation.operationToken ||
           consumed.value.intentId !== operation.intentId)) throw new Error("consumed_marker_invalid");

      const repository = await maybeRead(deps, "begin-repositories", operation.operationToken as string);
      repositoryPresent = repository.present;
      if (repository.present) {
        const repositoryCommonGitDir = repository.value.commonGitDir;
        repositoryMatches =
          repository.value.schemaVersion === 1 &&
          repository.value.operationToken === operation.operationToken &&
          samePath(String(repository.value.projectRoot), intent.projectRoot) &&
          typeof repositoryCommonGitDir === "string" &&
          samePath(repositoryCommonGitDir, git.commonGitDir) &&
          repository.value.baseHead === oid &&
          typeof repository.value.policySha256 === "string";
        if (!repositoryMatches) throw new Error("repository_checkpoint_invalid");
      }
      const leaseCheckpoint = await maybeRead(deps, "begin-leases", operation.operationToken as string);
      leaseCheckpointPresent = leaseCheckpoint.present;
      if (leaseCheckpoint.present) {
        leaseCheckpointMatches =
          leaseCheckpoint.value.schemaVersion === 1 &&
          leaseCheckpoint.value.operationToken === operation.operationToken &&
          leaseCheckpoint.value.leaseToken === operation.leaseToken &&
          typeof leaseCheckpoint.value.leaseId === "string" &&
          leaseCheckpoint.value.leaseId === digestText((path.resolve(git.commonGitDir) + "\0refs/heads/" + intent.targetBranch).toLowerCase()) &&
          typeof leaseCheckpoint.value.commonGitDir === "string" &&
          samePath(leaseCheckpoint.value.commonGitDir, git.commonGitDir) &&
          leaseCheckpoint.value.targetBranch === intent.targetBranch &&
          leaseCheckpoint.value.targetOid === intent.targetOid;
        if (!leaseCheckpointMatches) throw new Error("lease_checkpoint_invalid");
      }
      const canonicalRunWorktreePath = path.join(
        path.resolve(intent.projectRoot), ".captain-sdlc", "worktrees",
        args.intent_id.replace(/[^A-Za-z0-9_-]/g, ""),
      );
      const workspace = await maybeRead(deps, "begin-workspaces", operation.operationToken as string);
      workspacePresent = workspace.present;
      if (workspace.present &&
          (workspace.value.schemaVersion !== 1 ||
           workspace.value.operationToken !== operation.operationToken ||
           typeof workspace.value.projectRoot !== "string" ||
           !samePath(workspace.value.projectRoot, intent.projectRoot) ||
           typeof workspace.value.worktreePath !== "string" ||
           !samePath(workspace.value.worktreePath, canonicalRunWorktreePath) ||
           workspace.value.baseHead !== intent.targetOid ||
           workspace.value.branch !== intent.targetBranch ||
           workspace.value.targetBranch !== intent.targetBranch ||
           typeof workspace.value.commonGitDir !== "string" ||
           !samePath(workspace.value.commonGitDir, git.commonGitDir) ||
           typeof workspace.value.gitDir !== "string" ||
           !workspace.value.gitDir.trim())) {
        throw new Error("workspace_checkpoint_invalid");
      }

      runPresent = (await inspectRunHistory(args.intent_id, operation, intent, canonicalRunWorktreePath, deps)).present;
      const [active, activated, permits, activeProjection, permitProjection] = await Promise.all([
        maybeRead(deps, "begin-active", operation.operationToken as string),
        maybeRead(deps, "begin-activated", operation.operationToken as string),
        hasAuthenticatedBeginPermit(operation, intent, canonicalRunWorktreePath, deps),
        maybeRead(deps, "active", intent.sessionId),
        maybeRead(deps, "permits", intent.sessionId + "-" + intent.turnId),
      ]);
      activePresent = active.present;
      activatedPresent = activated.present;
      permitPresent = permits;
      projectionActivePresent = activeProjection.present;
      projectionPermitPresent = permitProjection.present;
      if (active.present && (
          active.value.schemaVersion !== 1 ||
          active.value.intentId !== args.intent_id ||
          active.value.operationToken !== operation.operationToken ||
          active.value.runId !== operation.runId ||
          active.value.sessionId !== intent.sessionId ||
          active.value.leaseToken !== operation.operationToken ||
          active.value.leaseId !== digestText("session-active\0" + intent.sessionId)
        )) {
        throw new Error("active_checkpoint_invalid");
      }
      if (activated.present && (
          activated.value.schemaVersion !== 1 ||
          activated.value.intentId !== args.intent_id ||
          activated.value.operationToken !== operation.operationToken ||
          activated.value.runId !== operation.runId ||
          activated.value.sessionId !== intent.sessionId ||
          activated.value.turnId !== operation.turnId
        )) {
        throw new Error("activation_checkpoint_invalid");
      }

      const sessionLeaseId = digestText("session-active\0" + intent.sessionId);
      const sessionLease = await deps.readLease(sessionLeaseId);
      sessionLeaseHeld = sessionLease?.state === "held";
      if (sessionLeaseHeld && sessionLease!.payload.intentId === args.intent_id &&
          sessionLease!.payload.operationToken !== operation.operationToken) {
        throw new Error("session_lease_generation_invalid");
      }
    }

    const leaseId = digestText((path.resolve(commonGitDir) + "\0refs/heads/" + args.target_branch).toLowerCase());
    const lease = await deps.readLease(leaseId);
    let leaseGeneration: string | undefined;
    if (lease) {
      if (lease.integrity !== "verified") throw new Error("target_lease_integrity_invalid");
      if (lease.legacy !== (lease.revision === null) || (lease.revision !== null && (!Number.isSafeInteger(lease.revision) || lease.revision < 0))) {
        throw new Error("target_lease_revision_invalid");
      }
      leaseState = lease.state;
      leaseRevision = lease.revision;
      leaseGenerationRevisioned = !lease.legacy && Number.isSafeInteger(lease.revision);
      leaseGeneration = digest({
        leaseId, revision: lease.revision ?? null, state: lease.state, payload: lease.payload,
      });
      leaseOwner = lease.payload.intentId !== args.intent_id
        ? "other"
        : classifyOwner(lease.payload, intent, operation, deps);
      leaseBindingsMatch = !!operation && operationMatches &&
        lease.payload.intentId === args.intent_id &&
        lease.payload.leaseToken === operation.leaseToken &&
        (lease.payload.operationToken === undefined || lease.payload.operationToken === operation.operationToken) &&
        typeof lease.payload.commonGitDir === "string" &&
        samePath(lease.payload.commonGitDir, commonGitDir) &&
        lease.payload.targetBranch === intent.targetBranch &&
        lease.payload.targetOid === intent.targetOid;
    }

    // Report the furthest observed progress even when an earlier checkpoint is
    // missing; a broken sequence must not hide later state from the refusal.
    const stage = !operation ? "no_reservation" :
      !operationMatches ? "reservation_mismatch" :
      permitPresent ? "permit_published" :
      activatedPresent ? "activated" :
      activePresent ? "active_checkpointed" :
      runPresent ? "run_checkpointed" :
      workspacePresent ? "workspace_checkpointed" :
      leaseState === "held" && !leaseCheckpointPresent ? "lease_acquired_before_checkpoint" :
      leaseCheckpointPresent ? "lease_checkpointed" :
      repositoryPresent ? "repository_checkpointed" :
      "reserved";

    const hasLaterEvidence = workspacePresent || runPresent || activePresent ||
      activatedPresent || permitPresent || sessionLeaseHeld ||
      projectionActivePresent || projectionPermitPresent ||
      git.canonicalProposedPathExists || git.canonicalWorktreeRegistered ||
      git.pendingGitOperation !== false;
    const expectedTargetCheckout = !!git.targetBranchWorktreePath &&
      samePath(git.targetBranchWorktreePath, args.target_worktree) &&
      git.targetBranchWorktreeHead?.toLowerCase() === git.targetRefOid.toLowerCase();
    const canonicalContainer = path.join(
      path.resolve(intent.projectRoot), ".captain-sdlc", "worktrees",
    );
    const targetCheckoutOutsideCanonical = !!git.targetBranchWorktreePath &&
      !samePath(git.targetBranchWorktreePath, canonicalContainer) &&
      !path.resolve(git.targetBranchWorktreePath).toLowerCase().startsWith(
        (canonicalContainer + path.sep).toLowerCase(),
      );
    const eligibleBindings = projectRootMatches && branchMatches && issuedIntentMatches &&
      operationMatches && repositoryMatches && leaseBindingsMatch &&
      consumedMarkerPresent && leaseGenerationRevisioned && leaseState === "held" &&
      gitBindingMatches && expectedTargetCheckout;
    const recoveryDisposition =
      !targetWorktreeMatches ? "refused_request_binding_mismatch" :
      !eligibleBindings ? "refused_binding_or_lease_mismatch" :
      hasLaterEvidence ? "refused_later_or_ambiguous_state" :
      leaseOwner === "stopped" ? "requires_begin_recovery_fence" :
      leaseOwner === "legacy" ? "refused_legacy_owner_unproven" :
      "refused_owner_not_proven_stopped";

    return {
      ...base,
      diagnosis: "inspected" as const,
      session_match: "same" as const,
      project_root_matches: projectRootMatches,
      target_branch_matches: branchMatches,
      target_worktree_matches: expectedTargetCheckout && samePath(git.targetWorktree, args.target_worktree),
      target_ref_matches: git.targetRefOid.toLowerCase() === oid.toLowerCase(),
      issuance: issuedIntentMatches ? "verified" as const : "missing_or_mismatched" as const,
      reservation: operationMatches ? "verified" as const : operation ? "mismatched" as const : "absent" as const,
      repository_checkpoint: repositoryPresent ? (repositoryMatches ? "verified" as const : "mismatched" as const) : "absent" as const,
      lease_checkpoint: leaseCheckpointPresent ? (leaseCheckpointMatches ? "verified" as const : "mismatched" as const) : "absent" as const,
      stage,
      target_lease: {
        state: leaseState,
        owner: leaseOwner,
        bindings_match: leaseBindingsMatch,
        generation_revisioned: leaseGenerationRevisioned,
        revision: leaseRevision ?? null,
        resource_generation: leaseGeneration ?? null,
      },
      later_state: {
        workspace: workspacePresent,
        run: runPresent,
        active: activePresent || projectionActivePresent || sessionLeaseHeld,
        activated: activatedPresent,
        permit: permitPresent || projectionPermitPresent,
        canonical_path_exists: git.canonicalProposedPathExists,
        canonical_worktree_registered: git.canonicalWorktreeRegistered,
        pending_git_operation: git.pendingGitOperation,
      },
      recovery_disposition: recoveryDisposition,
      // Informational only; this does not establish owner stop.
      observed_branch_checkout_outside_canonical: expectedTargetCheckout &&
        targetCheckoutOutsideCanonical,
    };
  } catch {
    return {
      ...base,
      diagnosis: "untrusted" as const,
      session_match: "same" as const,
      reason: "signed_or_git_evidence_invalid",
    };
  }
}
