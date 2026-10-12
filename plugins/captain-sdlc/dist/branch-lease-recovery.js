import { createHash, randomUUID } from "node:crypto";
import { lstat, readdir, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { acquireAuthorizedLease, putAuthorizedOnceExact, readAuthorizedLeaseSnapshotReadOnly, readAuthorizedLegacyLeaseMigrationReadOnly, readAuthorizedReadOnly, releaseAuthorizedLeaseAtGeneration, releaseAuthorizedLegacyLeaseAtGeneration } from "./authority.js";
import { git } from "./workspace.js";
import { LifecycleStore } from "./lifecycle.js";
import { createBeginDiagnosticAdapter } from "./begin-diagnostic-adapter.js";
import { verifiedFailedBeginCancellationMarker } from "./failed-begin-cancellation.js";
class FailedBeginVerificationError extends Error {
    details;
    constructor(details) {
        super(String(details.refusal_code));
        this.details = details;
    }
}
const hash = (value) => createHash("sha256").update(value).digest("hex");
const digest = (value) => hash(JSON.stringify(value));
const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const safeId = (id) => { if (!/^[A-Za-z0-9_-]+$/.test(id))
    throw new Error("unsafe lease recovery id"); return id; };
const resourceId = (binding) => hash(`${path.resolve(binding.commonGitDir)}\0refs/heads/${binding.branch}`.toLowerCase());
const generation = (id, revision, payload) => digest({ leaseId: id, revision, state: "held", payload });
const gateId = (intent) => `begin-attempt-${hash(intent)}`;
const signedBuckets = [
    "intents", "intent-issuance", "begin-operations", "begin-repositories", "begin-leases", "begin-workspaces", "begin-active", "begin-activated", "begin-permits", "begin-turn-resumes", "begin-intent-consumed", "begin-cancellations",
    "runs", "run-revisions", "run-watermarks", "active", "permits", "pause-handoffs", "blocker-links", "commit-outcomes", "session-owner-bindings", "session-interruption-drafts", "session-interruption-results",
    "resume-operations", "resume-runs", "resume-activated", "resume-intent-consumed", "merge-revisions", "merge-watermarks", "bookkeeping-revisions", "bookkeeping-watermarks", "user-authorizations", "user-requests", "user-request-sources",
];
/** Explicitly revoke one unclaimed legacy reservation; never allocate a checkout or alter Git. */
export class BranchLeaseRecoveryStore {
    dataRoot;
    hooks;
    constructor(dataRoot, hooks) {
        this.dataRoot = dataRoot;
        this.hooks = hooks;
    }
    async diagnoseFailedBegin(input) {
        const args = normalizeDiagnostic(input), binding = await readBinding(args), id = resourceId(binding);
        const lease = await readAuthorizedLeaseSnapshotReadOnly(this.dataRoot, id);
        const summary = lease ? { state: lease.state, intent_id: safeId(lease.payload.intentId), revision: lease.revision, legacy_storage: lease.legacy } : { state: "absent" };
        if (!lease || lease.legacy || lease.revision === null)
            return { read_only: true, eligible: false, reason: "no_revisioned_begin_reservation", verified_pre_workspace: false, original_session_match: "unknown", lease: summary };
        const journal = await this.failedJournal(lease.payload.intentId);
        if (journal && (journal.session_id !== args.session_id || !samePath(journal.project_root, args.project_root) || !samePath(journal.target_worktree, args.target_worktree) || journal.target_branch !== args.target_branch))
            return { read_only: true, eligible: false, reason: "operator_selection_owned_elsewhere", verified_pre_workspace: false, original_session_match: "unknown", lease: summary };
        const selection = journal ? request(journal) : { ...args, old_intent_id: lease.payload.intentId, expected_lease_revision: lease.revision, resource_generation: generation(id, lease.revision, lease.payload), expected_head: binding.head };
        if (!selectionMatches(binding, id, lease, selection, Boolean(journal)))
            return { read_only: true, eligible: false, reason: "generation_changed", verified_pre_workspace: false, original_session_match: "unknown", lease: summary };
        const completed = await optionalRead(this.dataRoot, "failed-begin-operator-results", lease.payload.intentId);
        if (completed) {
            if (!journal || completed.recovery_id !== journal.recovery_id || lease.state !== "released" || completed.released_lease_revision !== lease.revision)
                throw new Error("signed operator revocation result conflicts with branch lease tail");
            return { read_only: true, eligible: false, reason: "operator_revocation_completed", verified_pre_workspace: true, original_session_match: "unknown", lease: summary };
        }
        if (lease.state === "released" && !journal)
            return { read_only: true, eligible: false, reason: "lease_not_held", verified_pre_workspace: false, original_session_match: "unknown", lease: summary };
        try {
            const checked = await this.verifiedFailedBegin(binding, id, lease, selection, journal);
            return { read_only: true, eligible: true, reason: journal ? "operator_revocation_interrupted" : "verified_terminal_pre_workspace_reservation", verified_pre_workspace: true, original_session_match: checked.originalSession === args.session_id ? "same" : "other", lease: summary, original_state: checked.publicState, recovery: { next_tool: "captain_repossess_failed_begin", args: selection } };
        }
        catch (error) {
            const details = error instanceof FailedBeginVerificationError ? error.details : { refusal_code: "untrusted_original_graph" };
            return { read_only: true, eligible: false, reason: String(details.refusal_code), verified_pre_workspace: false, original_session_match: ["same", "other"].includes(String(details.original_session_match)) ? details.original_session_match : "unknown", lease: summary, original_state: details };
        }
    }
    async repossessFailedBegin(input) {
        const args = normalizeRequest(input), binding = await readBinding(args), id = resourceId(binding);
        const prior = await this.failedJournal(args.old_intent_id);
        if (prior && (digest(request(prior)) !== digest(args) || digest(prior.binding) !== digest(binding)))
            throw new Error("operator revocation selection or worktree binding changed");
        const lease = await readAuthorizedLeaseSnapshotReadOnly(this.dataRoot, id);
        if (!lease || !selectionMatches(binding, id, lease, args, Boolean(prior)))
            throw new Error("operator revocation owner or generation changed");
        let verified;
        try {
            verified = await this.verifiedFailedBegin(binding, id, lease, args, prior);
        }
        catch {
            throw new Error("operator revocation refused: original Begin is not verified terminal pre-workspace or its attempt is active");
        }
        const completed = await optionalRead(this.dataRoot, "failed-begin-operator-results", args.old_intent_id);
        if (completed) {
            if (!prior || completed.recovery_id !== prior.recovery_id || digest(request(completed)) !== digest(args) || lease.state !== "released" || completed.released_lease_revision !== lease.revision)
                throw new Error("signed operator revocation result binding changed");
            return completed;
        }
        const recoveryId = digest({ kind: "failed_begin_operator_revocation", ...args });
        const journal = prior ?? { schema_version: 1, kind: "failed_begin_operator_selection", ...args, recovery_id: recoveryId, lease_id: id, binding, graph_sha256: verified.graphHash };
        if (journal.graph_sha256 !== verified.graphHash)
            throw new Error("signed original Begin graph changed");
        await putAuthorizedOnceExact(this.dataRoot, "failed-begin-operator-selections", args.old_intent_id, journal);
        return this.withGuard(args, recoveryId, async (guard) => {
            await this.hooks?.afterGuard?.();
            const currentBinding = await readBinding(args), currentLease = await readAuthorizedLeaseSnapshotReadOnly(this.dataRoot, id);
            if (!currentLease || digest(currentBinding) !== digest(binding) || !selectionMatches(currentBinding, id, currentLease, args, true))
                throw new Error("operator revocation branch binding or generation changed");
            let checked;
            try {
                checked = await this.verifiedFailedBegin(currentBinding, id, currentLease, args, journal, guard);
            }
            catch {
                throw new Error("operator revocation refused: original Begin progressed or its evidence changed");
            }
            if (checked.graphHash !== journal.graph_sha256)
                throw new Error("signed original Begin graph changed");
            const lifecycle = new LifecycleStore(this.dataRoot, async () => { throw new Error("operator revocation cannot run a gate"); });
            const existing = await lifecycle.beginCancellationFor(args.old_intent_id);
            if (existing && digest(existing) !== digest(checked.cancellation))
                throw new Error("a different cancellation owns the original Begin");
            await lifecycle.recordBeginCancellation(checked.cancellation);
            await this.hooks?.afterTombstone?.();
            const finalBinding = await readBinding(args), finalLease = await readAuthorizedLeaseSnapshotReadOnly(this.dataRoot, id);
            if (!finalLease || digest(finalBinding) !== digest(binding) || !selectionMatches(finalBinding, id, finalLease, args, true))
                throw new Error("operator revocation branch binding or generation changed");
            let finalChecked;
            try {
                finalChecked = await this.verifiedFailedBegin(finalBinding, id, finalLease, args, journal, guard);
            }
            catch {
                throw new Error("operator revocation refused: original Begin progressed or its evidence changed");
            }
            if (finalChecked.graphHash !== journal.graph_sha256 || digest(finalChecked.cancellation) !== digest(checked.cancellation))
                throw new Error("signed original Begin graph changed");
            await this.assertGuard(guard);
            await releaseAuthorizedLeaseAtGeneration(this.dataRoot, id, args.old_intent_id, finalLease.payload.leaseToken, args.expected_lease_revision, args.resource_generation);
            await this.hooks?.afterRelease?.();
            const released = await readAuthorizedLeaseSnapshotReadOnly(this.dataRoot, id);
            if (!released || released.state !== "released" || !selectionMatches(await readBinding(args), id, released, args, true) || released.revision === null)
                throw new Error("operator revocation release changed before receipt");
            return putAuthorizedOnceExact(this.dataRoot, "failed-begin-operator-results", args.old_intent_id, { schema_version: 1, ...args, recovery_id: recoveryId, state: "revoked", released_lease_revision: released.revision });
        }, journal);
    }
    async failedJournal(intent) {
        const journal = await optionalRead(this.dataRoot, "failed-begin-operator-selections", safeId(intent));
        if (journal && (journal.schema_version !== 1 || journal.kind !== "failed_begin_operator_selection" || journal.old_intent_id !== intent || journal.recovery_id !== digest({ kind: "failed_begin_operator_revocation", ...request(journal) }) || !/^[0-9a-f]{64}$/.test(journal.graph_sha256)))
            throw new Error("signed operator revocation journal is invalid");
        if (!journal && await optionalRead(this.dataRoot, "failed-begin-operator-results", intent))
            throw new Error("signed operator revocation journal tail regressed");
        return journal;
    }
    async verifiedFailedBegin(binding, id, lease, selection, journal, ownGuard) {
        if (lease.legacy || selection.expected_lease_revision === null || !selectionMatches(binding, id, lease, selection, Boolean(journal)))
            throw new Error("original Begin lease selector is invalid");
        const lifecycle = new LifecycleStore(this.dataRoot, async () => { throw new Error("operator revocation cannot run a gate"); });
        let evidence;
        try {
            evidence = await lifecycle.readBeginCancellationEvidence(selection.old_intent_id);
        }
        catch (error) {
            const bucket = typeof error.path === "string" ? path.basename(path.dirname(error.path)) : undefined;
            throw new FailedBeginVerificationError({ refusal_code: "original_checkpoint_read_failed", error_class: error.code === "ENOENT" ? "missing_checkpoint" : "untrusted_checkpoint", ...(bucket && signedBuckets.includes(bucket) ? { checkpoint_bucket: bucket } : {}) });
        }
        const intent = evidence.intent, operation = evidence.operation;
        const relation = intent.sessionId === selection.session_id ? "same" : "other";
        let originalPinExists = false;
        if (typeof operation.targetOid === "string" && /^[0-9a-f]{40,64}$/i.test(operation.targetOid)) {
            try {
                originalPinExists = (await readGit(binding.topLevel, ["rev-parse", "--verify", `${operation.targetOid}^{commit}`])).toLowerCase() === operation.targetOid.toLowerCase();
            }
            catch { /* Missing original pins never authorize revocation. */ }
        }
        const resourceFlags = { original_intent_matches: intent.intentId === selection.old_intent_id, original_branch_matches: operation.targetBranch === binding.branch, original_oid_matches_current_head: operation.targetOid === binding.head,
            original_pin_exists: originalPinExists, original_signed_pin_matches: typeof operation.targetOid === "string" && [intent.targetOid, evidence.repository.baseHead, evidence.lease.targetOid, lease.payload.targetOid].every(value => value === operation.targetOid),
            original_common_git_matches: samePath(evidence.repository.commonGitDir, binding.commonGitDir), original_lease_id_matches: evidence.lease.leaseId === id, original_lease_token_matches: evidence.lease.leaseToken === lease.payload.leaseToken };
        if (Object.entries(resourceFlags).some(([key, value]) => key !== "original_oid_matches_current_head" && !value) || typeof intent.sessionId !== "string" || typeof intent.projectRoot !== "string")
            throw new FailedBeginVerificationError({ refusal_code: "original_resource_binding_mismatch", original_session_match: relation, resource_binding_matches: false, ...resourceFlags });
        const original = { intent_id: selection.old_intent_id, session_id: intent.sessionId, project_root: intent.projectRoot, target_worktree: intent.projectRoot, target_branch: binding.branch, expected_lease_revision: selection.expected_lease_revision, resource_generation: selection.resource_generation };
        const diagnosis = await createBeginDiagnosticAdapter(this.dataRoot)(original);
        const later = diagnosis.later_state;
        const sessionActivity = await this.sessionActivity(binding, evidence);
        const unrelatedPausedSession = sessionActivity.projection_kind === "task_owner" && sessionActivity.projection_shape_recognized &&
            sessionActivity.correlated_run_verified && sessionActivity.projection_matches_correlated_run && sessionActivity.correlated_run_status === "paused" &&
            sessionActivity.session_lease_state === "released" && !sessionActivity.correlated_run_is_original && !sessionActivity.correlated_run_owns_actual_target &&
            !sessionActivity.active_projection_claims_original && !sessionActivity.active_projection_original_operation_matches && !sessionActivity.active_projection_original_run_matches &&
            !sessionActivity.session_lease_claims_original && !sessionActivity.session_lease_original_operation_matches && !sessionActivity.session_lease_original_run_matches;
        const publicState = { original_session_match: relation, diagnosis: diagnosis.diagnosis, stage: diagnosis.stage ?? "unknown", issuance: diagnosis.issuance ?? "unknown", reservation: diagnosis.reservation ?? "unknown", repository_checkpoint: diagnosis.repository_checkpoint ?? "unknown", lease_checkpoint: diagnosis.lease_checkpoint ?? "unknown", resource_binding_matches: true, ...resourceFlags,
            project_root_matches: diagnosis.project_root_matches === true, target_branch_matches: diagnosis.target_branch_matches === true, target_ref_matches: diagnosis.target_ref_matches === true, owner_state: diagnosis.target_lease?.owner ?? "unknown", lease_bindings_match: diagnosis.target_lease?.bindings_match === true, generation_revisioned: diagnosis.target_lease?.generation_revisioned === true, completed_session_tombstone_verified: evidence.completedSessionTombstone,
            session_activity: sessionActivity, unrelated_paused_session_projection_verified: unrelatedPausedSession, later_state: later ? { workspace: later.workspace, run: later.run, active: later.active, activated: later.activated, permit: later.permit, canonical_path_exists: later.canonical_path_exists, canonical_worktree_registered: later.canonical_worktree_registered, pending_git_operation: later.pending_git_operation } : { unknown: true } };
        if (diagnosis.diagnosis !== "inspected" || diagnosis.session_match !== "same" || diagnosis.project_root_matches !== true || diagnosis.target_branch_matches !== true || diagnosis.issuance !== "verified" || diagnosis.reservation !== "verified" || diagnosis.repository_checkpoint !== "verified" || diagnosis.lease_checkpoint !== "verified" || diagnosis.stage !== "lease_checkpointed" || diagnosis.target_lease?.bindings_match !== true || diagnosis.target_lease?.generation_revisioned !== true || !["legacy", "stopped"].includes(diagnosis.target_lease?.owner) ||
            !later || later.workspace !== false || later.run !== false || later.activated !== false || later.permit !== false || later.canonical_path_exists !== false || later.canonical_worktree_registered !== false || later.pending_git_operation !== false || later.active !== false && !evidence.completedSessionTombstone && !unrelatedPausedSession)
            throw new FailedBeginVerificationError({ ...publicState, refusal_code: diagnosis.stage !== "lease_checkpointed" ? "original_stage_not_terminal_pre_workspace" : "original_graph_or_later_state_refused" });
        const entries = await inventory(this.dataRoot);
        const leases = await leaseInventory(this.dataRoot);
        const lifecycleCandidates = entries.filter(entry => ownerApplies(entry, binding) && isActive(entry));
        const candidates = await Promise.all(lifecycleCandidates.map(async (entry) => {
            const candidate = { ...targetOwnerDiagnostic(entry, entries, binding, evidence), ...(entry.bucket === "merge-revisions" ? { merge: await this.mergeOwnerDiagnostic(entry, entries, binding, evidence, leases) } : {}) };
            return { ...candidate, exclusive_target_owner: !idleFailedMerge(candidate) };
        }));
        const activeCandidates = candidates.filter(candidate => candidate.exclusive_target_owner);
        const inventoryState = { ...publicState, idle_failed_merge_records_verified: candidates.length - activeCandidates.length, target_lifecycle_candidates: candidates.slice(0, 32), active_target_candidate_count: activeCandidates.length, active_target_candidates: activeCandidates.slice(0, 32) };
        if (activeCandidates.length)
            throw new FailedBeginVerificationError({ ...inventoryState, refusal_code: "active_target_lifecycle_owner" });
        if (await hasTaskWorkspaceFootprint(binding, selection.old_intent_id))
            throw new FailedBeginVerificationError({ ...inventoryState, refusal_code: "retained_task_workspace_at_primary_or_registered_ref" });
        const guardLease = await readAuthorizedLeaseSnapshotReadOnly(this.dataRoot, gateId(selection.old_intent_id));
        if (guardLease?.state === "held" && !(ownGuard && guardLease.revision === ownGuard.revision && digest(guardLease.payload) === digest(ownGuard.payload)) && !(journal && this.recoverableGuard(guardLease, journal)))
            throw new FailedBeginVerificationError({ ...inventoryState, refusal_code: "active_or_ambiguous_begin_attempt" });
        for (const held of leases) {
            if (held.id === id || held.id === gateId(selection.old_intent_id))
                continue;
            if (held.snapshot.state === "held" && (applies(held.snapshot.payload, binding) || contains(held.snapshot.payload, selection.old_intent_id) || contains(held.snapshot.payload, operation.operationToken)))
                throw new FailedBeginVerificationError({ ...inventoryState, refusal_code: "active_target_or_original_operation_lease" });
        }
        const cancellation = verifiedFailedBeginCancellationMarker(original, evidence);
        return { cancellation, originalSession: intent.sessionId, publicState: inventoryState, graphHash: digest({ intent: evidence.intent, operation: evidence.operation, repository: evidence.repository, lease: evidence.lease, consumed: evidence.consumed }) };
    }
    async sessionActivity(binding, evidence) {
        const original = evidence.intent, operation = evidence.operation;
        const projection = await optionalRead(this.dataRoot, "active", original.sessionId);
        const sessionId = hash(`session-active\0${original.sessionId}`), sessionLease = await readAuthorizedLeaseSnapshotReadOnly(this.dataRoot, sessionId);
        const owner = sessionLease?.payload;
        const entries = await inventory(this.dataRoot);
        const run = owner && typeof owner.runId === "string" ? entries.find(entry => !entry.historical && ["runs", "run-revisions"].includes(entry.bucket) && entry.value.intentId === owner.intentId && entry.value.runId === owner.runId) : undefined;
        const r = run?.value, activation = r?.activationToken ?? r?.operationToken;
        const verified = Boolean(r && r.schemaVersion === 1 && sessionLease && !sessionLease.legacy && Number.isSafeInteger(sessionLease.revision) && typeof activation === "string" && activation && r.sessionId === original.sessionId && owner?.sessionId === original.sessionId && owner?.operation === "session-active" && owner?.operationToken === activation && owner?.leaseToken === activation && typeof r.phase === "string" && ["tdd_red", "implement", "prove", "hitl", "complete"].includes(r.phase) && ["running", "paused", "green", "red"].includes(r.status));
        const terminalShape = Boolean(projection && digest(Object.keys(projection).sort()) === digest(["complete", "intentId", "operationToken"]) && projection.intentId === "none" && projection.complete === true && typeof projection.operationToken === "string");
        const ownerShape = Boolean(projection && projection.schemaVersion === 1 && digest(Object.keys(projection).sort()) === digest(["intentId", "leaseId", "leaseToken", "operationToken", "runId", "schemaVersion", "sessionId"]) && typeof projection.intentId === "string" && typeof projection.operationToken === "string");
        return {
            active_projection_present: Boolean(projection), projection_shape_recognized: terminalShape || ownerShape, projection_kind: terminalShape ? "terminal_none" : ownerShape ? "task_owner" : projection ? "unrecognized" : "absent",
            active_projection_claims_original: projection?.intentId === original.intentId, active_projection_original_operation_matches: projection?.operationToken === operation.operationToken, active_projection_original_run_matches: projection?.runId === operation.runId,
            active_projection_complete_flag: projection?.complete === true, session_lease_state: sessionLease?.state ?? "absent", session_lease_claims_original: owner?.intentId === original.intentId, session_lease_original_operation_matches: owner?.operationToken === operation.operationToken, session_lease_original_run_matches: owner?.runId === operation.runId,
            correlated_run_verified: verified, correlated_run_phase: verified ? r.phase : "unknown", correlated_run_status: verified ? r.status : "unknown", correlated_run_is_original: Boolean(verified && r.intentId === original.intentId), correlated_run_owns_actual_target: Boolean(verified && ownerApplies(run, binding)), correlated_run_has_pending_work_or_review: Boolean(verified && isActive(run)),
            projection_matches_correlated_run: Boolean(verified && projection?.operationToken === activation && (terminalShape || ownerShape && projection.intentId === r.intentId && projection.runId === r.runId && projection.sessionId === original.sessionId && projection.leaseId === sessionId && projection.leaseToken === activation)),
        };
    }
    async mergeOwnerDiagnostic(entry, entries, binding, evidence, leases) {
        const v = entry.value, states = ["preparing", "needs_resolution", "needs_commit", "verifying", "failed", "ready", "integrating", "merged"];
        const shape = v.schema_version === 1 && typeof v.merge_id === "string" && /^[A-Za-z0-9_-]+$/.test(v.merge_id) && typeof v.session_id === "string" && states.includes(v.state);
        const leaseSummary = async (id, operation, expected) => {
            if (!id)
                return { state: "unknown", read_verified: false, revisioned: false, record_owner_matches: false, merge_owner_reference: false, original_begin_owner_matches: false, held_by_this_merge: false, held_by_original_begin: false, held_integration_resource: false, distinct_nonintegration_legacy_owner: false, owner_state: "unknown" };
            let lease;
            try {
                lease = await readAuthorizedLeaseSnapshotReadOnly(this.dataRoot, id);
            }
            catch {
                return { state: "unknown", read_verified: false, revisioned: false, record_owner_matches: false, merge_owner_reference: false, original_begin_owner_matches: false, held_by_this_merge: false, held_by_original_begin: false, held_integration_resource: false, distinct_nonintegration_legacy_owner: false, owner_state: "unknown" };
            }
            const p = lease?.payload, matches = Boolean(shape && p?.intentId === v.merge_id && p?.sessionId === v.session_id && p?.operation === operation);
            let owner = "unknown";
            if (p)
                owner = p.ownerPid === undefined && p.ownerHost === undefined ? "legacy" : typeof p.ownerHost !== "string" || !Number.isSafeInteger(p.ownerPid) || p.ownerPid <= 0 ? "unknown" : p.ownerHost.toLowerCase() !== os.hostname().toLowerCase() ? "foreign_host" : stopped(p.ownerPid) ? "stopped" : "live";
            const mergeOwner = p?.intentId === v.merge_id, originalOwner = p?.intentId === evidence.intent.intentId, integration = ["integration", "integration-branch", "integration-worktree"].includes(String(p?.operation));
            const legacyShape = Boolean(p && expected && owner === "legacy" && Object.keys(p).every(key => ["intentId", "leaseToken", "operationToken", "commonGitDir", "targetBranch", "targetOid"].includes(key)) && typeof p.intentId === "string" && /^[A-Za-z0-9_-]+$/.test(p.intentId) && typeof p.leaseToken === "string" && p.leaseToken && (p.operationToken === undefined || typeof p.operationToken === "string" && /^[A-Za-z0-9_-]+$/.test(p.operationToken)) && typeof p.commonGitDir === "string" && typeof p.targetBranch === "string" && typeof p.targetOid === "string" && /^[0-9a-f]{40,64}$/i.test(p.targetOid));
            let legacyBinding = Boolean(legacyShape && typeof expected.commonGitDir === "string" && typeof expected.branch === "string" && samePath(p.commonGitDir, expected.commonGitDir) && p.targetBranch === expected.branch);
            if (legacyBinding) {
                try {
                    legacyBinding = await readGit(binding.topLevel, ["rev-parse", "--verify", `${p.targetOid}^{commit}`]) === p.targetOid;
                }
                catch {
                    legacyBinding = false;
                }
            }
            return { state: lease?.state ?? "absent", read_verified: true, revisioned: Boolean(lease && !lease.legacy && Number.isSafeInteger(lease.revision)), record_owner_matches: matches, merge_owner_reference: mergeOwner, original_begin_owner_matches: originalOwner, held_by_this_merge: lease?.state === "held" && mergeOwner,
                held_by_original_begin: lease?.state === "held" && originalOwner, held_integration_resource: lease?.state === "held" && integration, legacy_branch_reservation_shape_recognized: legacyShape, legacy_branch_binding_verified: legacyBinding, distinct_nonintegration_legacy_owner: Boolean(lease?.state === "held" && legacyBinding && !mergeOwner && !originalOwner && !contains(p, evidence.operation.operationToken) && !contains(p, evidence.operation.runId)), owner_state: owner };
        };
        const resource = (saved) => saved && typeof saved.commonGitDir === "string" && typeof saved.branch === "string" ? hash(`${path.resolve(saved.commonGitDir)}\0refs/heads/${saved.branch}`.toLowerCase()) : undefined;
        const [sourceBinding, targetBinding, operationLease, sourceResource, targetResource] = await Promise.all([
            savedMergeBindingDiagnostic(v.source_worktree, v.source_binding, binding), savedMergeBindingDiagnostic(v.target_worktree, v.target_binding, binding),
            leaseSummary(shape ? hash(`merge-operation\0${v.merge_id}`) : undefined, "integration"), leaseSummary(resource(v.source_binding), "integration-branch", v.source_binding), leaseSummary(resource(v.target_binding), "integration-branch", v.target_binding),
        ]);
        const sourceOwners = entries.filter(candidate => !candidate.historical && ["runs", "run-revisions"].includes(candidate.bucket) && typeof candidate.value.runId === "string" && typeof candidate.value.worktreePath === "string" && typeof v.source_worktree === "string" && samePath(candidate.value.worktreePath, v.source_worktree));
        const worktreeResources = await Promise.all(sourceOwners.map(owner => leaseSummary(hash(`worktree-mutation\0${owner.value.runId}`), "integration-worktree")));
        let staticBindings = Boolean(shape && sourceBinding.schema_recognized && targetBinding.schema_recognized && samePath(v.source_binding.topLevel, v.source_worktree) && samePath(v.target_binding.topLevel, v.target_worktree) && !samePath(v.source_worktree, v.target_worktree) && v.source_binding.branch !== v.target_binding.branch && v.target_branch === v.target_binding.branch && v.target_branch === binding.branch && samePath(v.source_binding.commonGitDir, binding.commonGitDir) && samePath(v.target_binding.commonGitDir, binding.commonGitDir));
        if (staticBindings) {
            try {
                staticBindings = (await Promise.all([v.source_binding.head, v.target_binding.head].map(async (oid) => await readGit(binding.topLevel, ["rev-parse", "--verify", `${oid}^{commit}`]) === oid))).every(Boolean);
            }
            catch {
                staticBindings = false;
            }
        }
        return { state: shape ? v.state : "unknown", schema_recognized: shape, static_bindings_verified: staticBindings, prepared_merge_present: v.prepared_merge !== undefined, prepared_commit_present: v.prepared_commit !== undefined || v.prepared_commit_request !== undefined, finalization_request_present: v.finalization_requests !== undefined && (typeof v.finalization_requests !== "object" || !v.finalization_requests || Object.keys(v.finalization_requests).length > 0),
            source_binding: sourceBinding, target_binding: targetBinding, operation_lease: operationLease, source_resource: sourceResource, target_resource: targetResource,
            correlated_worktree_resource_count: worktreeResources.length, correlated_worktree_resource_reads_verified: worktreeResources.every(resource => resource.read_verified), held_correlated_worktree_resource: worktreeResources.some(resource => resource.state === "held"), held_this_merge_worktree_resource: worktreeResources.some(resource => resource.held_by_this_merge),
            held_merge_reference_resource: Boolean(shape && leases.some(lease => lease.snapshot.state === "held" && (lease.id === v.merge_id || contains(lease.snapshot.payload, v.merge_id)))),
        };
    }
    async diagnose(input) {
        const args = normalizeDiagnostic(input), binding = await readBinding(args), id = resourceId(binding);
        const lease = await this.readLease(id);
        if (!lease)
            return { read_only: true, captain_green: false, eligible: false, reason: "lease_absent", lease: { state: "absent" } };
        const summary = { state: lease.state, intent_id: safeId(lease.payload.intentId), revision: lease.revision, legacy_storage: lease.legacy,
            payload_fields: Object.keys(lease.payload).filter(key => !["intentId", "leaseToken"].includes(key) && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key)).sort() };
        const marker = await this.marker(lease.payload.intentId);
        const pending = marker ?? await this.journal(lease.payload.intentId);
        if (pending && (!samePath(pending.project_root, args.project_root) || !samePath(pending.target_worktree, args.target_worktree) || pending.target_branch !== args.target_branch || pending.session_id !== args.session_id)) {
            return { read_only: true, captain_green: false, eligible: false, reason: "repossession_owned_by_other_selection", lease: summary };
        }
        if (pending && (digest(pending.binding) !== digest(binding) || !selectionMatches(binding, id, lease, pending, Boolean(marker))))
            return { read_only: true, captain_green: false, eligible: false, reason: "generation_changed", lease: summary };
        if (lease.state !== "held" && (!marker || await optionalRead(this.dataRoot, "branch-lease-repossession-results", lease.payload.intentId)))
            return { read_only: true, captain_green: false, eligible: false, reason: "lease_not_held", lease: summary };
        const reason = await this.inspect(binding, id, lease, pending);
        const result = pending && await optionalRead(this.dataRoot, "branch-lease-repossession-results", lease.payload.intentId);
        if (result && (lease.state !== "released" || lease.revision !== result.released_lease_revision))
            throw new Error("signed lease repossession result conflicts with regressed branch lease tail");
        const selection = pending ? request(pending) : { ...args, old_intent_id: lease.payload.intentId, expected_lease_revision: lease.revision, resource_generation: generation(id, lease.revision, lease.payload), expected_head: binding.head };
        return { read_only: true, captain_green: false, eligible: !reason, reason: reason ?? (pending ? "repossession_interrupted" : "unclaimed_legacy_branch_reservation"), lease: summary,
            ...(!reason ? { recovery: { next_tool: "captain_repossess_branch_lease", args: selection } } : {}),
            ...(reason === "surviving_authority" ? { authority: await this.provenance(args, binding, lease) } : {}) };
    }
    async repossess(input) {
        const args = normalizeRequest(input), binding = await readBinding(args), id = resourceId(binding);
        if (binding.head !== args.expected_head)
            throw new Error("lease recovery target HEAD binding changed");
        const existing = await this.marker(args.old_intent_id);
        const pending = existing ?? await this.journal(args.old_intent_id);
        if (pending && digest(request(pending)) !== digest(args))
            throw new Error("signed lease repossession selection changed");
        if (pending && digest(pending.binding) !== digest(binding))
            throw new Error("lease repossession worktree Git binding changed");
        let lease = await this.readLease(id);
        if (!lease || !selectionMatches(binding, id, lease, args, Boolean(existing)))
            throw new Error("branch lease owner or generation selector changed");
        const result = await optionalRead(this.dataRoot, "branch-lease-repossession-results", args.old_intent_id);
        if (result) {
            if (!existing || result.schema_version !== 1 || result.state !== "released" || digest(request(result)) !== digest(args) || result.recovery_id !== existing.recovery_id || lease.state !== "released" || result.released_lease_revision !== lease.revision)
                throw new Error("signed lease repossession result binding is invalid");
            return result;
        }
        const reason = await this.inspect(binding, id, lease, pending);
        if (reason)
            throw new Error(`branch lease repossession refused: ${reason}`);
        const recoveryId = digest({ kind: "orphan_branch_lease_repossessed", ...args });
        const journal = { schema_version: 1, kind: "orphan_branch_lease_selection", ...args, recovery_id: recoveryId, lease_id: id, binding };
        await putAuthorizedOnceExact(this.dataRoot, "branch-lease-repossession-selections", args.old_intent_id, journal);
        return this.withGuard(args, recoveryId, async (guard) => {
            await this.hooks?.afterGuard?.();
            lease = await this.readLease(id);
            const currentBinding = await readBinding(args);
            if (digest(currentBinding) !== digest(binding))
                throw new Error("lease repossession worktree Git binding changed");
            if (!lease || !selectionMatches(currentBinding, id, lease, args, Boolean(existing)))
                throw new Error("branch lease owner or generation selector changed");
            const before = await this.inspect(currentBinding, id, lease, pending ?? journal, guard);
            if (before)
                throw new Error(`branch lease repossession refused: ${before}`);
            const marker = existing ?? { schema_version: 1, kind: "orphan_branch_lease_repossessed", ...args, recovery_id: recoveryId, lease_id: id, binding: currentBinding };
            await putAuthorizedOnceExact(this.dataRoot, "branch-lease-repossessions", args.old_intent_id, marker);
            await putAuthorizedOnceExact(this.dataRoot, "branch-lease-repossession-watermarks", args.old_intent_id, { schema_version: 1, old_intent_id: args.old_intent_id, recovery_id: recoveryId, marker_sha256: digest(marker) });
            await this.hooks?.afterTombstone?.();
            const finalBinding = await readBinding(args), finalLease = await this.readLease(id);
            if (digest(finalBinding) !== digest(marker.binding))
                throw new Error("lease repossession worktree Git binding changed");
            if (!finalLease || !selectionMatches(finalBinding, id, finalLease, args, true))
                throw new Error("branch lease owner or generation selector changed");
            const finalReason = await this.inspect(finalBinding, id, finalLease, marker, guard);
            if (finalReason)
                throw new Error(`branch lease repossession refused: ${finalReason}`);
            await this.assertGuard(guard);
            if (args.expected_lease_revision === null)
                await releaseAuthorizedLegacyLeaseAtGeneration(this.dataRoot, id, args.old_intent_id, finalLease.payload.leaseToken, args.resource_generation, this.hooks?.afterLegacyMigration, this.hooks?.afterLegacyRevision);
            else
                await releaseAuthorizedLeaseAtGeneration(this.dataRoot, id, args.old_intent_id, finalLease.payload.leaseToken, args.expected_lease_revision, args.resource_generation);
            await this.hooks?.afterRelease?.();
            const released = await readAuthorizedLeaseSnapshotReadOnly(this.dataRoot, id);
            if (!released || !selectionMatches(await readBinding(args), id, released, args, true) || released.state !== "released" || released.revision === null)
                throw new Error("branch lease repossession release changed before receipt");
            return putAuthorizedOnceExact(this.dataRoot, "branch-lease-repossession-results", args.old_intent_id, { schema_version: 1, ...args, recovery_id: recoveryId, state: "released", released_lease_revision: released.revision });
        });
    }
    async journal(intent) {
        const journal = await optionalRead(this.dataRoot, "branch-lease-repossession-selections", safeId(intent));
        if (journal && (journal.schema_version !== 1 || journal.kind !== "orphan_branch_lease_selection" || journal.old_intent_id !== intent || journal.recovery_id !== digest({ kind: "orphan_branch_lease_repossessed", ...request(journal) })))
            throw new Error("signed lease repossession selection journal is invalid");
        return journal;
    }
    async readLease(id) {
        try {
            return await readAuthorizedLeaseSnapshotReadOnly(this.dataRoot, id);
        }
        catch (original) {
            // Only a signed tombstone for the exact raw generation authorizes this incomplete migration.
            const raw = await optionalRead(this.dataRoot, "leases", id);
            const marker = raw && await this.marker(raw.intentId);
            if (!marker || marker.lease_id !== id || marker.expected_lease_revision !== null || await optionalRead(this.dataRoot, "branch-lease-repossession-results", marker.old_intent_id))
                throw original;
            return readAuthorizedLegacyLeaseMigrationReadOnly(this.dataRoot, id, marker.old_intent_id, marker.resource_generation);
        }
    }
    async provenance(args, binding, lease) {
        const entries = await inventory(this.dataRoot), owner = lease.payload;
        const intentMatches = (entry) => entry.id === owner.intentId || contains(entry.value, owner.intentId);
        const operationMatches = (entry) => typeof owner.operationToken === "string" && (entry.id === owner.operationToken || contains(entry.value, owner.operationToken));
        const matching = entries.filter(entry => intentMatches(entry) || operationMatches(entry));
        const intent = matching.find(entry => entry.bucket === "intents" && entry.id === owner.intentId && entry.value.intentId === owner.intentId)?.value;
        const operation = matching.find(entry => entry.bucket === "begin-operations" && entry.id === owner.intentId && entry.value.intentId === owner.intentId)?.value;
        const session = typeof intent?.sessionId === "string" ? intent.sessionId : typeof operation?.sessionId === "string" ? operation.sessionId : undefined;
        const sessionMatch = session === undefined ? "unknown" : session === args.session_id ? "same" : "other";
        let recordedRootMatches = false;
        if (typeof intent?.projectRoot === "string") {
            try {
                recordedRootMatches = samePath(await realpath(intent.projectRoot), intent.projectRoot) && samePath(await readGit(intent.projectRoot, ["rev-parse", "--path-format=absolute", "--git-common-dir"]), binding.commonGitDir);
            }
            catch { /* Foreign or missing recorded roots never gain recovery selectors. */ }
        }
        const exactCaller = intent && operation && sessionMatch === "same" && operation.sessionId === args.session_id && operation.schemaVersion === 1 && typeof operation.operationToken === "string" && (owner.operationToken === undefined || owner.operationToken === operation.operationToken) && typeof operation.projectRoot === "string" && samePath(operation.projectRoot, intent.projectRoot) && operation.targetBranch === binding.branch && intent.targetBranch === binding.branch && recordedRootMatches;
        return { matched_buckets: [...new Set(matching.map(entry => entry.bucket))].sort(), intent_reference: matching.some(intentMatches), operation_reference: matching.some(operationMatches), session_match: sessionMatch, recorded_root_matches_repository: recordedRootMatches,
            ...(exactCaller ? { next_tool: "captain_begin_diagnose", args: { intent_id: owner.intentId, session_id: args.session_id, project_root: path.resolve(intent.projectRoot), target_worktree: path.resolve(intent.projectRoot), target_branch: binding.branch } } : {}) };
    }
    async marker(intent) {
        const marker = await optionalRead(this.dataRoot, "branch-lease-repossessions", safeId(intent));
        const mark = await optionalRead(this.dataRoot, "branch-lease-repossession-watermarks", intent);
        if (!marker) {
            if (mark || await optionalRead(this.dataRoot, "branch-lease-repossession-results", intent))
                throw new Error("lease repossession marker tail regressed behind signed watermark");
            return undefined;
        }
        if (marker.schema_version !== 1 || marker.kind !== "orphan_branch_lease_repossessed" || marker.old_intent_id !== intent || marker.recovery_id !== digest({ kind: marker.kind, ...request(marker) }))
            throw new Error("signed lease repossession marker is invalid");
        // A crash between marker and watermark remains fenced. Mutation retries publish the missing mark.
        if (mark && (mark.schema_version !== 1 || mark.old_intent_id !== intent || mark.recovery_id !== marker.recovery_id || mark.marker_sha256 !== digest(marker)))
            throw new Error("signed lease repossession watermark is invalid");
        return marker;
    }
    async inspect(binding, selectedId, lease, marker, ownGuard) {
        const owner = lease.payload;
        if (!/^intent-[A-Za-z0-9_-]+$/.test(owner.intentId))
            return "nonlegacy_resource_owner";
        if (Object.keys(owner).some(key => !["intentId", "leaseToken", "operationToken", "commonGitDir", "targetBranch", "targetOid"].includes(key)))
            return "owner_metadata_present";
        if (typeof owner.leaseToken !== "string" || !owner.leaseToken)
            throw new Error("signed branch lease token is invalid");
        if (owner.operationToken !== undefined && (typeof owner.operationToken !== "string" || owner.operationToken.length > 256 || !/^[A-Za-z0-9_-]+$/.test(owner.operationToken)))
            return "lease_binding_mismatch";
        if (lease.legacy && (typeof owner.commonGitDir !== "string" || typeof owner.targetBranch !== "string" || typeof owner.targetOid !== "string"))
            return "unbound_legacy_storage";
        if (owner.commonGitDir !== undefined && (typeof owner.commonGitDir !== "string" || !samePath(owner.commonGitDir, binding.commonGitDir)))
            return "lease_binding_mismatch";
        if (owner.targetBranch !== undefined && owner.targetBranch !== binding.branch)
            return "lease_binding_mismatch";
        if (owner.targetOid !== undefined) {
            if (typeof owner.targetOid !== "string" || !/^[0-9a-f]{40,64}$/i.test(owner.targetOid))
                return "lease_binding_mismatch";
            try {
                if ((await readGit(binding.topLevel, ["rev-parse", "--verify", `${owner.targetOid}^{commit}`])).toLowerCase() !== owner.targetOid.toLowerCase())
                    return "lease_binding_mismatch";
            }
            catch {
                return "lease_binding_mismatch";
            }
        }
        const entries = await inventory(this.dataRoot);
        const selectors = [owner.intentId, ...(typeof owner.operationToken === "string" ? [owner.operationToken] : [])];
        if (entries.some(entry => selectors.some(selector => entry.id === selector || contains(entry.value, selector))))
            return "surviving_authority";
        if (entries.some(entry => ownerApplies(entry, binding) && isActive(entry)))
            return "active_worktree_owner";
        const names = [...await directoryNames(path.join(this.dataRoot, "lease-revisions")), ...await directoryNames(path.join(this.dataRoot, "lease-watermarks"))];
        const ids = new Set(names.map(name => /^(.+)-[0-9]+\.json$/.exec(name)?.[1]).filter((id) => Boolean(id)));
        for (const name of await directoryNames(path.join(this.dataRoot, "leases")))
            if (name.endsWith(".json"))
                ids.add(name.slice(0, -5));
        for (const id of ids) {
            if (id === selectedId)
                continue;
            const current = await readAuthorizedLeaseSnapshotReadOnly(this.dataRoot, safeId(id));
            if (!current || current.state !== "held")
                continue;
            if (ownGuard && id === ownGuard.id && current.revision === ownGuard.revision && digest(current.payload) === digest(ownGuard.payload))
                continue;
            if (marker && id === gateId(owner.intentId) && this.recoverableGuard(current, marker))
                continue;
            if (selectors.some(selector => contains(current.payload, selector)))
                return "surviving_authority";
            if (applies(current.payload, binding))
                return "active_worktree_owner";
        }
        if (await hasTaskWorkspaceFootprint(binding, owner.intentId))
            return "surviving_task_workspace";
        return undefined;
    }
    recoverableGuard(lease, marker) {
        const p = lease.payload;
        const operation = marker.kind === "failed_begin_operator_selection" ? "failed-begin-repossession-attempt" : "branch-repossession-attempt";
        return !lease.legacy && lease.revision !== null && p.intentId === marker.old_intent_id && p.operation === operation && p.sessionId === marker.session_id && p.recoveryId === marker.recovery_id && p.resourceGeneration === marker.resource_generation && p.ownerHost === os.hostname() && stopped(p.ownerPid);
    }
    async withGuard(args, recoveryId, action, selected) {
        const id = gateId(args.old_intent_id), previous = await readAuthorizedLeaseSnapshotReadOnly(this.dataRoot, id);
        if (previous?.state === "held") {
            const marker = selected ?? await this.marker(args.old_intent_id) ?? await this.journal(args.old_intent_id);
            if (!marker || marker.recovery_id !== recoveryId || !this.recoverableGuard(previous, marker) || previous.revision === null)
                throw new Error("lease repossession Begin attempt owner is active or ambiguous");
            await releaseAuthorizedLeaseAtGeneration(this.dataRoot, id, args.old_intent_id, previous.payload.leaseToken, previous.revision, generation(id, previous.revision, previous.payload));
        }
        const payload = { intentId: args.old_intent_id, leaseToken: randomUUID(), operation: selected ? "failed-begin-repossession-attempt" : "branch-repossession-attempt", sessionId: args.session_id, recoveryId, resourceGeneration: args.resource_generation, ownerHost: os.hostname(), ownerPid: process.pid };
        await acquireAuthorizedLease(this.dataRoot, id, payload);
        const snapshot = await readAuthorizedLeaseSnapshotReadOnly(this.dataRoot, id);
        if (!snapshot || snapshot.state !== "held" || snapshot.revision === null || digest(snapshot.payload) !== digest(payload))
            throw new Error("lease repossession Begin attempt generation changed");
        const guard = { id, payload, revision: snapshot.revision, generation: generation(id, snapshot.revision, payload) };
        try {
            return await action(guard);
        }
        finally {
            await releaseAuthorizedLeaseAtGeneration(this.dataRoot, id, args.old_intent_id, payload.leaseToken, guard.revision, guard.generation);
        }
    }
    async assertGuard(guard) {
        const current = await readAuthorizedLeaseSnapshotReadOnly(this.dataRoot, guard.id);
        if (!current || current.state !== "held" || current.revision !== guard.revision || digest(current.payload) !== digest(guard.payload))
            throw new Error("lease repossession Begin attempt generation changed");
    }
}
function request(args) { return { project_root: args.project_root, target_worktree: args.target_worktree, target_branch: args.target_branch, session_id: args.session_id, old_intent_id: args.old_intent_id, expected_lease_revision: args.expected_lease_revision, resource_generation: args.resource_generation, expected_head: args.expected_head, reason: args.reason, user_authorization: args.user_authorization }; }
function normalizeDiagnostic(args) {
    for (const [name, value] of Object.entries(args))
        if (typeof value !== "string" || !value.trim() || value.length > 4096)
            throw new Error(`lease recovery ${name} is invalid`);
    return { project_root: path.resolve(args.project_root), target_worktree: path.resolve(args.target_worktree), target_branch: args.target_branch, session_id: args.session_id };
}
function normalizeRequest(args) {
    const base = normalizeDiagnostic({ project_root: args.project_root, target_worktree: args.target_worktree, target_branch: args.target_branch, session_id: args.session_id });
    safeId(args.old_intent_id);
    if (!(args.expected_lease_revision === null || Number.isSafeInteger(args.expected_lease_revision) && args.expected_lease_revision >= 0 && args.expected_lease_revision < Number.MAX_SAFE_INTEGER) || !/^[0-9a-f]{64}$/i.test(args.resource_generation) || !/^[0-9a-f]{40,64}$/i.test(args.expected_head))
        throw new Error("lease recovery generation selector is invalid");
    for (const [name, text] of [["reason", args.reason], ["user authorization", args.user_authorization]])
        if (typeof text !== "string" || !text.trim() || text.length > 4096)
            throw new Error(`lease recovery ${name} is required and bounded`);
    return { ...base, old_intent_id: args.old_intent_id, expected_lease_revision: args.expected_lease_revision, resource_generation: args.resource_generation.toLowerCase(), expected_head: args.expected_head.toLowerCase(), reason: args.reason, user_authorization: args.user_authorization };
}
function selectionMatches(binding, id, lease, args, allowReleased) {
    if (binding.head !== args.expected_head || resourceId(binding) !== id || lease.payload.intentId !== args.old_intent_id)
        return false;
    if (generation(id, args.expected_lease_revision, lease.payload) !== args.resource_generation)
        return false;
    if (args.expected_lease_revision === null)
        return lease.legacy && lease.state === "held" || allowReleased && !lease.legacy && (lease.revision === 0 && lease.state === "held" || lease.revision === 1 && lease.state === "released");
    return !lease.legacy && (lease.revision === args.expected_lease_revision && lease.state === "held" || allowReleased && lease.revision === args.expected_lease_revision + 1 && lease.state === "released");
}
const readGit = (cwd, args) => git(["--no-optional-locks", ...args], cwd);
async function readBinding(args) {
    const root = path.resolve(args.project_root), target = path.resolve(args.target_worktree);
    for (const location of [root, target])
        if (!samePath(await realpath(location), location) || !samePath(await readGit(location, ["rev-parse", "--show-toplevel"]), location))
            throw new Error("lease recovery worktree path binding is invalid");
    const commonGitDir = path.resolve(await readGit(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]));
    if (!samePath(await readGit(root, ["rev-parse", "--path-format=absolute", "--git-dir"]), commonGitDir))
        throw new Error("lease recovery project_root must be the primary repository checkout");
    if (!samePath(await readGit(target, ["rev-parse", "--path-format=absolute", "--git-common-dir"]), commonGitDir))
        throw new Error("lease recovery target belongs to another Git repository");
    const branch = await readGit(target, ["symbolic-ref", "--quiet", "--short", "HEAD"]), head = await readGit(target, ["rev-parse", "--verify", "HEAD^{commit}"]);
    if (branch !== args.target_branch || head !== await readGit(target, ["rev-parse", "--verify", `refs/heads/${branch}^{commit}`]))
        throw new Error("lease recovery target branch HEAD binding changed");
    for (const name of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "REBASE_HEAD", "BISECT_START", "BISECT_LOG", "rebase-merge", "rebase-apply", "sequencer", "index.lock", "HEAD.lock"]) {
        const file = await readGit(target, ["rev-parse", "--path-format=absolute", "--git-path", name]);
        try {
            await lstat(file);
            throw new Error(`lease recovery refuses unfinished Git operation ${name}`);
        }
        catch (error) {
            if (error.code !== "ENOENT")
                throw error;
        }
    }
    return { projectRoot: root, branch, head, commonGitDir, gitDir: path.resolve(await readGit(target, ["rev-parse", "--path-format=absolute", "--git-dir"])), topLevel: target };
}
async function directoryNames(directory) { try {
    return await readdir(directory);
}
catch (error) {
    if (error.code !== "ENOENT")
        throw error;
    return [];
} }
async function hasTaskWorkspaceFootprint(binding, intentId) {
    const refs = (await readGit(binding.topLevel, ["for-each-ref", "--format=%(refname)"])).split(/\r?\n/);
    if (refs.includes(`refs/heads/captain/${safeId(intentId)}`))
        return true;
    const worktrees = await readGit(binding.topLevel, ["worktree", "list", "--porcelain"]);
    if (worktrees.split(/\r?\n/).some(line => line.startsWith("worktree ") && path.basename(line.slice(9)) === intentId))
        return true;
    try {
        await lstat(path.join(binding.projectRoot, ".captain-sdlc", "worktrees", intentId));
        return true;
    }
    catch (error) {
        if (error.code !== "ENOENT")
            throw error;
    }
    return false;
}
async function optionalRead(root, bucket, id) { try {
    return await readAuthorizedReadOnly(root, bucket, safeId(id));
}
catch (error) {
    if (error.code !== "ENOENT")
        throw error;
    return undefined;
} }
function contains(value, selector) { if (value === selector)
    return true; return Boolean(value && typeof value === "object" && Object.values(value).some(child => contains(child, selector))); }
function applies(value, binding) {
    if ([value.worktree, value.worktreePath, value.source_worktree, value.target_worktree, value.topLevel].some(location => typeof location === "string" && samePath(location, binding.topLevel)))
        return true;
    if ([value.branch, value.targetBranch, value.target_branch].includes(binding.branch) && typeof value.commonGitDir === "string" && samePath(value.commonGitDir, binding.commonGitDir))
        return true;
    return [value.before, value.source_binding, value.target_binding].some(child => child && typeof child === "object" && applies(child, binding));
}
function ownerApplies(entry, binding) {
    if (entry.bucket === "runs" || entry.bucket === "run-revisions") {
        // A task's planned base is not a lease on that checkout. Match its actual ownership.
        const { targetBranch: _targetBranch, target_branch: _targetBranchAlias, ...owned } = entry.value;
        return applies(owned, binding);
    }
    return applies(entry.value, binding);
}
function targetOwnerDiagnostic(entry, entries, binding, evidence) {
    const v = entry.value;
    const references = ["intentId", "runId", "operationToken"];
    const supplied = references.filter(key => typeof v[key] === "string");
    const correlated = entries.filter(candidate => !candidate.historical && ["runs", "run-revisions"].includes(candidate.bucket) && candidate.value.schemaVersion === 1 && supplied.length && supplied.every(key => key === "operationToken" ? [candidate.value.operationToken, candidate.value.activationToken].includes(v[key]) : candidate.value[key] === v[key]) && (typeof v.sessionId !== "string" || candidate.value.sessionId === v.sessionId));
    const run = correlated.length === 1 ? correlated[0] : undefined;
    const verified = Boolean(run && ["tdd_red", "implement", "prove", "hitl", "complete"].includes(run.value.phase) && ["running", "paused", "green", "red"].includes(run.value.status));
    const commonMatches = typeof v.commonGitDir === "string" && samePath(v.commonGitDir, binding.commonGitDir);
    return {
        bucket: entry.bucket, schema_recognized: v.schemaVersion === 1 || v.schema_version === 1,
        actual_worktree_matches: [v.worktree, v.worktreePath, v.source_worktree, v.target_worktree, v.topLevel].some(location => typeof location === "string" && samePath(location, binding.topLevel)),
        actual_branch_matches: v.branch === binding.branch && commonMatches, common_git_matches: commonMatches,
        planned_target_branch_matches: [v.targetBranch, v.target_branch].includes(binding.branch),
        nested_actual_target_binding_matches: [v.before, v.source_binding, v.target_binding].some(child => child && typeof child === "object" && applies(child, binding)),
        original_intent_reference: entry.id === evidence.intent.intentId || contains(v, evidence.intent.intentId),
        original_operation_reference: entry.id === evidence.operation.operationToken || contains(v, evidence.operation.operationToken),
        original_run_reference: entry.id === evidence.operation.runId || contains(v, evidence.operation.runId),
        correlated_latest_run_verified: verified, correlated_run_phase: verified ? run.value.phase : "unknown", correlated_run_status: verified ? run.value.status : "unknown",
        correlated_run_owns_actual_target: Boolean(verified && ownerApplies(run, binding)),
    };
}
async function savedMergeBindingDiagnostic(location, saved, selected) {
    const shape = typeof location === "string" && saved && ["topLevel", "branch", "commonGitDir", "gitDir", "head"].every(key => typeof saved[key] === "string" && saved[key]) && /^[0-9a-f]{40,64}$/i.test(saved.head);
    const basic = { read_verified: false, schema_recognized: Boolean(shape), saved_binding_matches_current: false, saved_head_matches_current: false, saved_commit_exists: false, pending_git_operation: "unknown",
        matches_selected_target: Boolean(shape && saved.branch === selected.branch && samePath(saved.commonGitDir, selected.commonGitDir)), saved_head_matches_selected_target: Boolean(shape && saved.head === selected.head) };
    if (!shape)
        return basic;
    try {
        const root = await realpath(location), top = path.resolve(await readGit(root, ["rev-parse", "--show-toplevel"])), common = path.resolve(await readGit(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"])), gitDir = path.resolve(await readGit(root, ["rev-parse", "--path-format=absolute", "--git-dir"]));
        const branch = await readGit(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]), head = await readGit(root, ["rev-parse", "--verify", "HEAD^{commit}"]);
        const exists = await readGit(root, ["rev-parse", "--verify", `${saved.head}^{commit}`]) === saved.head;
        let pending = false;
        for (const name of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "REBASE_HEAD", "BISECT_START", "BISECT_LOG", "rebase-merge", "rebase-apply", "sequencer", "index.lock", "HEAD.lock"]) {
            const file = await readGit(root, ["rev-parse", "--path-format=absolute", "--git-path", name]);
            try {
                await lstat(file);
                pending = true;
            }
            catch (error) {
                if (error.code !== "ENOENT")
                    throw error;
            }
        }
        return { ...basic, read_verified: true, saved_binding_matches_current: samePath(root, top) && samePath(saved.topLevel, top) && samePath(saved.commonGitDir, common) && samePath(saved.gitDir, gitDir) && saved.branch === branch,
            saved_head_matches_current: saved.head === head, saved_commit_exists: exists, pending_git_operation: pending };
    }
    catch {
        return basic;
    }
}
/** A failed saved receipt can coexist with retirement; its own future merge checks remain unchanged. */
function idleFailedMerge(candidate) {
    const m = candidate.merge;
    if (candidate.bucket !== "merge-revisions" || candidate.original_intent_reference || candidate.original_operation_reference || candidate.original_run_reference ||
        !m || !m.schema_recognized || !m.static_bindings_verified || m.state !== "failed" || m.prepared_merge_present || m.prepared_commit_present || m.finalization_request_present ||
        !m.operation_lease.read_verified || !m.operation_lease.revisioned || m.operation_lease.state !== "released" || !m.operation_lease.record_owner_matches ||
        !m.source_binding.read_verified || !m.source_binding.saved_binding_matches_current || !m.source_binding.saved_commit_exists || m.source_binding.pending_git_operation !== false ||
        m.target_binding.read_verified && m.target_binding.pending_git_operation !== false ||
        !m.source_resource.read_verified || !m.target_resource.read_verified || m.source_resource.held_by_this_merge || m.source_resource.held_by_original_begin || m.source_resource.held_integration_resource ||
        m.target_resource.held_by_this_merge || m.target_resource.held_integration_resource ||
        !m.correlated_worktree_resource_reads_verified || m.held_correlated_worktree_resource || m.held_merge_reference_resource)
        return false;
    const sourceIdle = ["absent", "released"].includes(m.source_resource.state) || m.source_resource.state === "held" && m.source_resource.distinct_nonintegration_legacy_owner;
    return sourceIdle && ["held", "released"].includes(m.target_resource.state) && m.target_resource.original_begin_owner_matches;
}
function isActive(entry) {
    if (entry.historical)
        return false;
    const v = entry.value;
    if (entry.bucket === "runs" || entry.bucket === "run-revisions")
        return v.phase !== "complete" || v.status !== "green" || Boolean(v.preparedCommit || v.commitOperation || v.mutationOperation || v.phase === "hitl" || v.policy?.hitlChecks?.length && v.evidence?.filter((e) => e.kind === "plan_review").at(-1)?.decision !== "accept");
    if (entry.bucket === "merge-revisions")
        return !["merged", "aborted"].includes(v.state);
    if (entry.bucket === "bookkeeping-revisions")
        return !["committed", "stashed"].includes(v.state);
    return ["active", "permits", "begin-workspaces", "begin-active", "begin-activated", "resume-operations"].includes(entry.bucket) && v.complete !== true;
}
function stopped(pid) {
    if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid)
        return false;
    try {
        process.kill(pid, 0);
        return false;
    }
    catch (error) {
        return error.code === "ESRCH";
    }
}
async function leaseInventory(root) {
    const [revisions, watermarks, projections] = await Promise.all(["lease-revisions", "lease-watermarks", "leases"].map(bucket => directoryNames(path.join(root, bucket))));
    const ids = new Set([...revisions, ...watermarks].map(name => /^(.+)-[0-9]+\.json$/.exec(name)?.[1]).filter((id) => Boolean(id)));
    for (const name of projections)
        if (name.endsWith(".json"))
            ids.add(name.slice(0, -5));
    const snapshots = await Promise.all([...ids].map(async (id) => ({ id: safeId(id), snapshot: await readAuthorizedLeaseSnapshotReadOnly(root, safeId(id)) })));
    return snapshots.filter((entry) => Boolean(entry.snapshot));
}
async function inventory(root) {
    const entries = [], byBucket = new Map();
    for (const bucket of signedBuckets) {
        const map = new Map();
        byBucket.set(bucket, map);
        for (const name of await directoryNames(path.join(root, bucket))) {
            if (!name.endsWith(".json"))
                continue;
            const id = safeId(name.slice(0, -5)), value = await readAuthorizedReadOnly(root, bucket, id);
            if (!value || typeof value !== "object" || Array.isArray(value))
                throw new Error("signed lease recovery authority record is invalid");
            const entry = { bucket, id, value };
            entries.push(entry);
            map.set(id, entry);
        }
    }
    const obsolete = new Set();
    for (const [kind, idField, previousField, hashField] of [["run", "intentId", "previousRevisionSha256", "runSha256"], ["merge", "merge_id", "previous_sha256", "sha256"], ["bookkeeping", "finalization_id", "previous_sha256", "sha256"]]) {
        const revisions = byBucket.get(`${kind}-revisions`), marks = byBucket.get(`${kind}-watermarks`);
        const ids = new Set([...revisions.keys(), ...marks.keys()].map(name => /^(.+)-[0-9]+$/.exec(name)?.[1]).filter((id) => Boolean(id)));
        for (const id of ids) {
            const expression = new RegExp(`^${safeId(id)}-([0-9]+)$`);
            const numbers = [...revisions.keys()].map(name => expression.exec(name)).filter((m) => Boolean(m)).map(m => Number(m[1])).sort((a, b) => a - b);
            if (!numbers.length || numbers.some((n, i) => n !== i) || [...marks.keys()].some(name => { const m = expression.exec(name); return Boolean(m && Number(m[1]) >= numbers.length); }))
                throw new Error("signed ownership revision tail regressed or chain is missing behind watermark");
            let previous;
            for (const revision of numbers) {
                const entry = revisions.get(`${id}-${revision}`), current = entry.value, mark = marks.get(`${id}-${revision}`)?.value;
                if (!mark || current[idField] !== id || current.revision !== revision || current[previousField] !== (previous ? digest(previous) : undefined) || mark[idField] !== id || mark.revision !== revision || mark[hashField] !== digest(current))
                    throw new Error("signed ownership revision chain or watermark is invalid");
                if (revision < numbers.length - 1)
                    obsolete.add(entry);
                previous = current;
            }
            if (kind === "run") {
                const projection = byBucket.get("runs")?.get(id);
                if (projection)
                    obsolete.add(projection);
            }
        }
    }
    // Historical records still protect their exact old intent. Only ownership checks use latest revisions.
    const latestRuns = entries.filter(entry => !obsolete.has(entry) && ["runs", "run-revisions"].includes(entry.bucket));
    for (const entry of entries) {
        if (!["begin-workspaces", "begin-active", "begin-activated", "permits", "resume-operations"].includes(entry.bucket))
            continue;
        const v = entry.value;
        const completed = latestRuns.find(run => !isActive(run) && (typeof v.intentId === "string" && v.intentId === run.value.intentId || typeof v.runId === "string" && v.runId === run.value.runId || typeof v.operationToken === "string" && [run.value.operationToken, run.value.activationToken].includes(v.operationToken)));
        if (completed)
            obsolete.add(entry);
    }
    return entries.map(entry => obsolete.has(entry) ? { ...entry, historical: true } : entry);
}
