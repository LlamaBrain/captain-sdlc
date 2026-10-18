import path from "node:path";
const diagnosticArgs = (args) => ({
    intent_id: args.intent_id,
    session_id: args.session_id,
    project_root: args.project_root,
    target_worktree: args.target_worktree,
    target_branch: args.target_branch,
});
const fail = (message) => { throw new Error(message); };
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const samePath = (left, right) => path.resolve(left).replace(/[\\/]+$/, "").toLowerCase() ===
    path.resolve(right).replace(/[\\/]+$/, "").toLowerCase();
function assertDiagnosticIdentity(diagnostic, args) {
    if (diagnostic.diagnosis !== "inspected" ||
        diagnostic.session_match !== "same" ||
        diagnostic.project_root_matches !== true ||
        diagnostic.target_worktree_matches !== true ||
        diagnostic.target_branch_matches !== true ||
        diagnostic.target_ref_matches !== true ||
        diagnostic.issuance !== "verified" ||
        diagnostic.reservation !== "verified")
        fail("failed Begin identity or pre-workspace eligibility could not be verified");
}
function assertDiagnosticBinding(diagnostic, args, requireHeld, completedSessionTombstone = false) {
    assertDiagnosticIdentity(diagnostic, args);
    const later = diagnostic.later_state;
    if (!isRecord(later) ||
        later.workspace !== false || later.run !== false ||
        (later.active !== false && !(later.active === true && completedSessionTombstone && diagnostic.stage === "lease_checkpointed")) ||
        later.activated !== false || later.permit !== false ||
        later.canonical_path_exists !== false ||
        later.canonical_worktree_registered !== false ||
        later.pending_git_operation !== false) {
        fail("Begin has progressed or has ambiguous later state; cancellation was refused");
    }
    if (diagnostic.repository_checkpoint !== "verified" ||
        diagnostic.lease_checkpoint !== "verified" ||
        diagnostic.stage !== "lease_checkpointed" ||
        diagnostic.target_lease?.bindings_match !== true ||
        diagnostic.target_lease?.generation_revisioned !== true ||
        diagnostic.target_worktree_matches !== true) {
        fail("failed Begin identity or pre-workspace eligibility could not be verified");
    }
    if (requireHeld) {
        if (diagnostic.target_lease.state !== "held" || diagnostic.target_lease.owner === "live") {
            fail("failed Begin target lease is no longer held at the selected generation");
        }
        if (!Number.isSafeInteger(diagnostic.target_lease.revision) ||
            diagnostic.target_lease.revision !== args.expected_lease_revision ||
            diagnostic.target_lease.resource_generation !== args.resource_generation) {
            fail("failed Begin target lease revision or generation changed; cancellation was refused");
        }
    }
    else if (diagnostic.target_lease.state === "held") {
        if (diagnostic.target_lease.owner === "live" ||
            !Number.isSafeInteger(diagnostic.target_lease.revision) ||
            diagnostic.target_lease.revision !== args.expected_lease_revision ||
            diagnostic.target_lease.resource_generation !== args.resource_generation) {
            fail("failed Begin target lease revision or generation changed; cancellation was refused");
        }
    }
    else if (diagnostic.target_lease.state !== "released" ||
        diagnostic.target_lease.revision !== args.expected_lease_revision + 1) {
        fail("failed Begin target lease is no longer at the exact cancellable generation");
    }
}
function selectorMatches(marker, args, evidence) {
    return marker.schemaVersion === 1 &&
        marker.kind === "failed_begin_cancelled" &&
        marker.intentId === args.intent_id &&
        marker.sessionId === args.session_id &&
        marker.turnId === evidence.operation.turnId &&
        marker.operationToken === evidence.operation.operationToken &&
        samePath(marker.projectRoot, args.project_root) &&
        samePath(marker.projectRoot, evidence.intent.projectRoot) &&
        samePath(marker.targetWorktree, args.target_worktree) &&
        marker.targetBranch === args.target_branch &&
        marker.leaseId === evidence.lease.leaseId &&
        marker.leaseToken === evidence.lease.leaseToken &&
        marker.expectedLeaseRevision === args.expected_lease_revision &&
        marker.resourceGeneration === args.resource_generation;
}
function buildMarker(args, evidence) {
    return {
        schemaVersion: 1,
        kind: "failed_begin_cancelled",
        intentId: args.intent_id,
        sessionId: args.session_id,
        turnId: evidence.operation.turnId,
        operationToken: evidence.operation.operationToken,
        projectRoot: evidence.intent.projectRoot,
        targetWorktree: args.target_worktree,
        targetBranch: args.target_branch,
        leaseId: evidence.lease.leaseId,
        leaseToken: evidence.lease.leaseToken,
        expectedLeaseRevision: args.expected_lease_revision,
        resourceGeneration: args.resource_generation,
    };
}
async function retryExactCancellation(store, marker, args, evidence) {
    if (!selectorMatches(marker, args, evidence)) {
        fail("a different signed cancellation already owns this Begin intent");
    }
    if (!evidence.lease.leaseId || !evidence.lease.leaseToken) {
        throw new Error("signed cancellation is missing its target lease binding");
    }
    await store.releaseBeginTargetLeaseAtGeneration(evidence.lease.leaseId, args.intent_id, evidence.lease.leaseToken, args.expected_lease_revision, args.resource_generation);
    return { intent_id: args.intent_id, state: "cancelled", cancelled: true };
}
/** Retire only an authenticated terminal pre-workspace Begin with an exact lease generation. */
export async function captainCancelFailedBegin(store, args) {
    if (args.confirm_owner_stopped !== true) {
        fail("confirm_owner_stopped is required after the logical Begin request has returned");
    }
    if (!Number.isSafeInteger(args.expected_lease_revision) || args.expected_lease_revision < 0 ||
        !/^[0-9a-f]{64}$/i.test(args.resource_generation)) {
        fail("expected target lease revision and resource generation are invalid");
    }
    // Pure authorization and selector checks happen before claiming the shared gate.
    const initial = await store.diagnoseBegin(diagnosticArgs(args));
    if (!isRecord(initial))
        throw new Error("signed Begin diagnosis is unavailable");
    assertDiagnosticIdentity(initial, args);
    const initialEvidence = await store.readBeginCancellationEvidence(args.intent_id);
    const existing = await store.beginCancellationFor(args.intent_id);
    if (existing) {
        if (!selectorMatches(existing, args, initialEvidence)) {
            throw new Error("a different signed cancellation already owns this Begin intent");
        }
        assertDiagnosticBinding(initial, args, false, (initialEvidence.completedSessionTombstone || initialEvidence.completedSessionOwner));
        return store.withBeginAttemptGate(args.intent_id, async () => {
            const current = await store.beginCancellationFor(args.intent_id);
            if (!current)
                throw new Error("signed Begin cancellation marker disappeared");
            const evidence = await store.readBeginCancellationEvidence(args.intent_id);
            if (!selectorMatches(current, args, evidence)) {
                throw new Error("a different signed cancellation already owns this Begin intent");
            }
            const fresh = await store.diagnoseBegin(diagnosticArgs(args));
            if (!isRecord(fresh))
                throw new Error("signed Begin diagnosis is unavailable");
            assertDiagnosticBinding(fresh, args, false, (evidence.completedSessionTombstone || evidence.completedSessionOwner));
            // The authority CAS accepts only the original held generation or its exact
            // released N+1 successor; it never follows a same-token replacement.
            return retryExactCancellation(store, current, args, evidence);
        });
    }
    assertDiagnosticBinding(initial, args, true, (initialEvidence.completedSessionTombstone || initialEvidence.completedSessionOwner));
    return store.withBeginAttemptGate(args.intent_id, async () => {
        // A retry may have committed the terminal marker before a failed release.
        const fresh = await store.diagnoseBegin(diagnosticArgs(args));
        if (!isRecord(fresh))
            throw new Error("signed Begin diagnosis is unavailable");
        const priorMarker = await store.beginCancellationFor(args.intent_id);
        const evidence = await store.readBeginCancellationEvidence(args.intent_id);
        if (priorMarker) {
            if (!selectorMatches(priorMarker, args, evidence)) {
                throw new Error("a different signed cancellation already owns this Begin intent");
            }
            assertDiagnosticBinding(fresh, args, false, (evidence.completedSessionTombstone || evidence.completedSessionOwner));
            return retryExactCancellation(store, priorMarker, args, evidence);
        }
        assertDiagnosticBinding(fresh, args, true, (evidence.completedSessionTombstone || evidence.completedSessionOwner));
        const operation = evidence.operation;
        const repository = evidence.repository;
        const lease = evidence.lease;
        if (operation.schemaVersion !== 1 || operation.intentId !== args.intent_id ||
            operation.sessionId !== args.session_id || !samePath(operation.projectRoot, args.project_root) ||
            operation.targetBranch !== args.target_branch ||
            evidence.consumed.schemaVersion !== 1 ||
            evidence.consumed.operationToken !== operation.operationToken ||
            evidence.consumed.intentId !== args.intent_id ||
            repository.schemaVersion !== 1 || repository.operationToken !== operation.operationToken ||
            !samePath(repository.projectRoot, args.project_root) ||
            lease.schemaVersion !== 1 || lease.operationToken !== operation.operationToken ||
            !lease.leaseId || lease.leaseToken !== operation.leaseToken ||
            lease.targetBranch !== operation.targetBranch || lease.targetOid !== operation.targetOid ||
            typeof lease.commonGitDir !== "string" || !lease.commonGitDir ||
            typeof lease.commonGitDir !== "string" || !lease.commonGitDir ||
            !samePath(lease.commonGitDir, repository.commonGitDir))
            fail("signed Begin checkpoints do not match the exact cancellation request");
        const leaseId = lease.leaseId;
        const leaseToken = lease.leaseToken;
        if (!leaseId || !leaseToken)
            throw new Error("signed cancellation is missing its target lease binding");
        const marker = buildMarker(args, evidence);
        await store.recordBeginCancellation(marker);
        await store.releaseBeginTargetLeaseAtGeneration(leaseId, args.intent_id, leaseToken, args.expected_lease_revision, args.resource_generation);
        return { intent_id: args.intent_id, state: "cancelled", cancelled: true };
    });
}
/** Validate the original immutable checkpoint graph; contains no owner-stop assertion. */
export function verifiedFailedBeginCancellationMarker(args, evidence) {
    const operation = evidence.operation, repository = evidence.repository, lease = evidence.lease;
    if (operation.schemaVersion !== 1 || operation.intentId !== args.intent_id || operation.sessionId !== args.session_id || !samePath(operation.projectRoot, args.project_root) || operation.targetBranch !== args.target_branch ||
        evidence.consumed.schemaVersion !== 1 || evidence.consumed.operationToken !== operation.operationToken || evidence.consumed.intentId !== args.intent_id ||
        repository.schemaVersion !== 1 || repository.operationToken !== operation.operationToken || !samePath(repository.projectRoot, args.project_root) ||
        lease.schemaVersion !== 1 || lease.operationToken !== operation.operationToken || !lease.leaseId || lease.leaseToken !== operation.leaseToken || lease.targetBranch !== operation.targetBranch || lease.targetOid !== operation.targetOid ||
        typeof lease.commonGitDir !== "string" || !lease.commonGitDir || !samePath(lease.commonGitDir, repository.commonGitDir))
        throw new Error("signed Begin checkpoint graph does not match its exact selectors");
    // buildMarker does not inspect the original caller's confirmation field.
    return { schemaVersion: 1, kind: "failed_begin_cancelled", intentId: args.intent_id, sessionId: args.session_id, turnId: operation.turnId, operationToken: operation.operationToken,
        projectRoot: evidence.intent.projectRoot, targetWorktree: args.target_worktree, targetBranch: args.target_branch, leaseId: lease.leaseId, leaseToken: lease.leaseToken, expectedLeaseRevision: args.expected_lease_revision, resourceGeneration: args.resource_generation };
}
