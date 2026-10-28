import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { acquireAuthorizedLease, assertIntentNotRepossessed, ensureAuthorizedLease, putAuthorizedOnceExact, readAuthorized, readAuthorizedLease, readAuthorizedLeaseSnapshotReadOnly, readAuthorizedReadOnly, releaseAuthorizedLease, releaseAuthorizedLeaseAtGeneration, writeAuthorized } from "./authority.js";
import { createBeginDiagnosticAdapter } from "./begin-diagnostic-adapter.js";
import { probeSessionOwner, validateSessionOwner } from "./session-interruption.js";
import { compileSafeRegex, subjectVersion } from "./validation.js";
import { bookkeepingCaptured, bookkeepingSubjectAllowed } from "./bookkeeping.js";
import { recordUserAuthorizations, userAuthorizationStatus } from "./user-authorization.js";
import { recordUserRequest, userRequestStatus } from "./user-request.js";
import { readUserRequestSource } from "./user-request-source.js";
import { prepareScopeOutputs } from "./output-retention.js";
import { assertDocumentationScope, captureDocumentationScope } from "./documentation-scope.js";
class ProofSourceDivergenceError extends Error {
    fence;
    constructor(fence) {
        super("proof source state diverged from the clean committed tree or ignored-input manifest");
        this.fence = fence;
    }
}
export function approvedPlanDigest(content) { return digest(content.replaceAll("\r\n", "\n")); }
export function proofScopes(run) { return [...(run.profile === "low" ? ["build"] : ["build", "ticket", "feature-smoke", "affected-regression", ...(run.profile === "pre-release" ? ["super-smoke"] : [])]), ...(run.visualRequired ? ["visual"] : [])]; }
export function executionHead(run) { return run.continuityState?.head ?? run.committedState?.head ?? run.baseHead; }
export function isPendingPlanReview(run) {
    if (run.phase === "hitl")
        return true;
    const lastReview = run.evidence.filter(item => item.kind === "plan_review").at(-1);
    return run.phase === "complete" && run.status === "green" && Boolean(run.policy.hitlChecks?.length) && lastReview?.decision !== "accept";
}
export function effectiveGateDisclosure(run) {
    const bindings = { build: "build", "feature-smoke": "smoke", visual: "visual" };
    const planReview = run.evidence.filter(item => item.kind === "plan_review").at(-1);
    const pendingReview = isPendingPlanReview(run);
    const humanReview = run.evidence.filter(item => item.kind === "hitl_feedback").at(-1);
    const reviewDecisions = new Map();
    for (const item of run.evidence) {
        if (!["hitl_feedback", "plan_review"].includes(String(item.kind)) || !["accept", "needs_changes"].includes(String(item.decision)) || !Array.isArray(item.checkIds))
            continue;
        for (const id of item.checkIds)
            if (typeof id === "string")
                reviewDecisions.set(id, String(item.decision));
    }
    const declaredIds = (run.policy.hitlChecks ?? []).map(check => check.id);
    const humanReviewStatus = { acceptedCheckIds: declaredIds.filter(id => reviewDecisions.get(id) === "accept"), needsChangesCheckIds: declaredIds.filter(id => reviewDecisions.get(id) === "needs_changes"), unreviewedCheckIds: declaredIds.filter(id => !reviewDecisions.has(id)) };
    return {
        hitlChecks: run.policy.hitlChecks ?? [], planReview: planReview ?? null, humanReview: humanReview ?? null, humanReviewStatus,
        planState: !run.policy.approvedPlans?.length ? "unbound" : pendingReview ? "hitl" : run.phase === "complete" && run.status === "green" ? "completed" : "working",
        approvalAccepted: Boolean(run.policy.approvedPlans?.length), scopeBinding: run.policy.approvedPlans?.length ? "frozen" : "unbound",
        approvedPlans: run.policy.approvedPlans ?? [], baseHead: run.baseHead, policySource: ".captain-sdlc/codex-policy.json",
        progressLocation: "signed run evidence and pause handoffs; approved plans are immutable",
        proofStatus: pendingReview ? { phase: "complete", status: "green" } : { phase: run.phase, status: run.status },
        phaseAcceptance: humanReviewStatus.needsChangesCheckIds.length ? `human requested changes for ${humanReviewStatus.needsChangesCheckIds.length}/${declaredIds.length} declared checks; automated proof status remains separate` : humanReviewStatus.acceptedCheckIds.length ? `human accepted ${humanReviewStatus.acceptedCheckIds.length}/${declaredIds.length} declared checks; automated proof status remains separate` : pendingReview ? "awaiting declared human review" : "not inferred from proof status",
        ...(run.documentationScope ? { workKind: "documentation", documentationScope: run.documentationScope } : {}),
        taskTicket: run.taskTicket ?? null,
        ticketCommand: run.taskTicket?.command ?? run.policy.commands.ticket ?? null,
        gates: proofScopes(run).map(scope => ({ scope, command: run.policy.commands[scope] ?? null, artifactPath: run.policy.artifactPaths?.[bindings[scope]] ?? null }))
    };
}
/** Derive a task-owned scalar selector while preserving the captured policy command. */
function taskTicketCommand(run, scope, requestedFilter) {
    const configured = run.policy.commands[scope];
    if (requestedFilter !== undefined && scope !== "ticket")
        throw new Error("ticket filter is only supported for the ticket scope");
    if (scope !== "ticket" || (requestedFilter === undefined && !run.taskTicket))
        return { command: configured };
    if (run.profile !== "low" || run.policy.profile !== "low")
        throw new Error("task ticket filters are supported only by the LOW profile");
    const filter = requestedFilter ?? run.taskTicket.filter;
    if (typeof filter !== "string" || filter.length > 512 || !/^[A-Za-z_][A-Za-z0-9_.]*$/.test(filter))
        throw new Error("ticket filter must be one bounded ASCII namespace, class, or method selector");
    // Support a plain, unquoted PowerShell -File invocation only. Shell strings,
    // quotes, comments, redirects, and computed values have no safe scalar slot here.
    if (!configured || configured.length > 8192 || !/^[A-Za-z0-9_./\\:-]+(?:[ \t]+[A-Za-z0-9_./\\:-]+)*$/.test(configured))
        throw new Error("ticket selector requires an unquoted plain PowerShell -File command");
    const tokens = configured.split(/[ \t]+/);
    const fileSlots = tokens.map((token, index) => /^-File$/i.test(token) ? index : -1).filter(index => index >= 0);
    const fileIndex = fileSlots[0];
    if (!/^(?:powershell|pwsh)(?:\.exe)?$/i.test(tokens[0]) || fileSlots.length !== 1 || fileIndex < 1 || !/\.ps1$/i.test(tokens[fileIndex + 1] ?? "") || tokens.findIndex(token => /^-TestFilter$/i.test(token)) <= fileIndex + 1)
        throw new Error("ticket selector requires one PowerShell -File script and an actual script filter argument");
    for (let index = 1; index < fileIndex; index++) {
        if (/^-(?:NoLogo|NoProfile|NonInteractive)$/i.test(tokens[index]))
            continue;
        if (/^-ExecutionPolicy$/i.test(tokens[index]) && index + 1 < fileIndex && /^(?:Bypass|RemoteSigned|AllSigned|Restricted|Unrestricted|Default|Undefined)$/i.test(tokens[index + 1])) {
            index++;
            continue;
        }
        throw new Error("ticket selector does not support this PowerShell invocation option");
    }
    const slots = configured.match(/(?:^|\s)-TestFilter(?=[\s:=]|$)/gi) ?? [];
    const slot = /(?:^|\s)-TestFilter\s+([A-Za-z_][A-Za-z0-9_.]*)(?=\s|$)/i.exec(configured ?? "");
    if (slots.length !== 1 || !slot)
        throw new Error("trusted ticket command must contain exactly one unquoted scalar -TestFilter slot");
    const valueStart = slot.index + slot[0].length - slot[1].length;
    const command = configured.slice(0, valueStart) + filter + configured.slice(valueStart + slot[1].length);
    const binding = { filter, command, commandSha256: digest(command), policyCommandSha256: digest(configured) };
    if (run.taskTicket && (run.taskTicket.filter !== binding.filter || run.taskTicket.command !== binding.command || run.taskTicket.commandSha256 !== binding.commandSha256 || run.taskTicket.policyCommandSha256 !== binding.policyCommandSha256))
        throw new Error("ticket filter or command differs from the immutable task binding");
    return { command, binding };
}
const beginAttemptQueues = new Map();
export class LifecycleStore {
    dataRoot;
    runner;
    probe;
    hooks;
    constructor(dataRoot, runner, probe, hooks) {
        this.dataRoot = dataRoot;
        this.runner = runner;
        this.probe = probe;
        this.hooks = hooks;
    }
    async withSerializedBeginAttempt(intentId, action) {
        const resolvedRoot = path.resolve(this.dataRoot);
        const rootKey = process.platform === "win32" ? resolvedRoot.toLowerCase() : resolvedRoot;
        const key = rootKey + "\0" + intentId;
        const previous = beginAttemptQueues.get(key) ?? Promise.resolve();
        let release;
        const current = new Promise(resolve => { release = resolve; });
        beginAttemptQueues.set(key, current);
        await previous;
        try {
            return await this.withBeginAttemptGate(intentId, action);
        }
        finally {
            release();
            if (beginAttemptQueues.get(key) === current)
                beginAttemptQueues.delete(key);
        }
    }
    async withBeginAttemptGate(intentId, action) {
        const leaseId = `begin-attempt-${digest(intentId)}`, leaseToken = randomUUID();
        await acquireAuthorizedLease(this.dataRoot, leaseId, { intentId, leaseToken, operation: "begin-attempt" });
        try {
            return await action();
        }
        finally {
            await releaseAuthorizedLease(this.dataRoot, leaseId, intentId, leaseToken);
        }
    }
    async diagnoseBegin(args) {
        const diagnosis = await createBeginDiagnosticAdapter(this.dataRoot)(args);
        if (diagnosis.diagnosis !== "inspected" || diagnosis.session_match !== "same" || !diagnosis.project_root_matches)
            return diagnosis;
        return { ...diagnosis, user_request: await this.userRequests({ projectRoot: args.project_root, intentId: args.intent_id, sessionId: args.session_id }) };
    }
    async beginCancellationFor(intentId) {
        await readFile(path.join(this.dataRoot, "authority.key"), "utf8");
        try {
            return await readAuthorizedReadOnly(this.dataRoot, "begin-cancellations", safeId(intentId));
        }
        catch (error) {
            if (error.code === "ENOENT")
                return undefined;
            throw error;
        }
    }
    async readBeginCancellationEvidence(intentId) {
        const operation = await readAuthorizedReadOnly(this.dataRoot, "begin-operations", safeId(intentId));
        if (operation.intentId !== intentId)
            throw new Error("signed Begin operation binding is invalid");
        const [intent, repository, lease, consumed] = await Promise.all([
            readAuthorizedReadOnly(this.dataRoot, "intents", safeId(intentId)),
            readAuthorizedReadOnly(this.dataRoot, "begin-repositories", safeId(operation.operationToken)),
            readAuthorizedReadOnly(this.dataRoot, "begin-leases", safeId(operation.operationToken)),
            readAuthorizedReadOnly(this.dataRoot, "begin-intent-consumed", safeId(operation.operationToken)),
        ]);
        let activeProjection;
        try {
            activeProjection = await readAuthorizedReadOnly(this.dataRoot, "active", operation.sessionId);
        }
        catch (error) {
            if (error.code !== "ENOENT")
                throw error;
        }
        let completedSessionTombstone = false;
        let completedSessionOwner = false;
        let pausedSessionOwner;
        if (activeProjection) {
            const sessionLeaseId = digest(`session-active\0${operation.sessionId}`);
            const sessionLease = await readAuthorizedLeaseSnapshotReadOnly(this.dataRoot, sessionLeaseId);
            if (JSON.stringify(Object.keys(activeProjection).sort()) === JSON.stringify(["complete", "intentId", "operationToken"]) &&
                activeProjection.intentId === "none" &&
                activeProjection.complete === true && typeof activeProjection.operationToken === "string" &&
                activeProjection.operationToken && activeProjection.operationToken !== operation.operationToken &&
                sessionLease?.state === "released" && !sessionLease.legacy &&
                Number.isSafeInteger(sessionLease.revision) && sessionLease.payload.sessionId === operation.sessionId &&
                sessionLease.payload.operation === "session-active" && typeof sessionLease.payload.intentId === "string" &&
                sessionLease.payload.intentId !== intentId && typeof sessionLease.payload.operationToken === "string" &&
                typeof sessionLease.payload.runId === "string" && typeof sessionLease.payload.leaseToken === "string") {
                const priorIntentId = sessionLease.payload.intentId;
                const [priorOperation, priorRun] = await Promise.all([
                    readAuthorizedReadOnly(this.dataRoot, "begin-operations", safeId(priorIntentId)),
                    readAuthorizedReadOnly(this.dataRoot, "runs", safeId(priorIntentId)),
                ]);
                completedSessionTombstone = priorOperation.schemaVersion === 1 && priorOperation.intentId === priorIntentId &&
                    priorOperation.sessionId === operation.sessionId && priorOperation.operationToken === activeProjection.operationToken &&
                    priorOperation.runId === sessionLease.payload.runId && priorRun.schemaVersion === 1 &&
                    priorRun.intentId === priorIntentId && priorRun.runId === sessionLease.payload.runId &&
                    priorRun.operationToken === priorOperation.operationToken && priorRun.sessionId === operation.sessionId &&
                    priorRun.phase === "complete" && priorRun.status === "green";
            }
        }
        if (activeProjection?.schemaVersion === 1 &&
            JSON.stringify(Object.keys(activeProjection).sort()) === JSON.stringify(["intentId", "leaseId", "leaseToken", "operationToken", "runId", "schemaVersion", "sessionId"]) &&
            typeof activeProjection.intentId === "string" && activeProjection.intentId !== intentId &&
            activeProjection.sessionId === operation.sessionId) {
            const sessionLeaseId = digest(`session-active\0${operation.sessionId}`);
            const sessionLease = await readAuthorizedLeaseSnapshotReadOnly(this.dataRoot, sessionLeaseId);
            const owner = sessionLease?.payload;
            if (sessionLease?.state === "released" && !sessionLease.legacy &&
                Number.isSafeInteger(sessionLease.revision) && owner?.operation === "session-active" &&
                owner.intentId === activeProjection.intentId && owner.sessionId === operation.sessionId &&
                owner.runId === activeProjection.runId && owner.operationToken === activeProjection.operationToken &&
                owner.leaseToken === activeProjection.leaseToken && owner.leaseToken === owner.operationToken &&
                activeProjection.leaseId === sessionLeaseId && typeof owner.operationToken === "string" &&
                owner.operationToken && owner.operationToken !== operation.operationToken &&
                owner.runId !== operation.runId) {
                let priorRun;
                try {
                    priorRun = await this.interruptionRunReadOnly(owner.intentId);
                }
                catch (error) {
                    const absentLegacyChain = (error.code === "ENOENT" && typeof error.path === "string" &&
                        samePath(error.path, path.join(this.dataRoot, "run-revisions"))) ||
                        error.message === "legacy run has no authenticated revision chain for interruption recovery";
                    if (!absentLegacyChain)
                        throw error;
                    // An absent legacy chain grants no completed-owner exception. Existing paused-owner
                    // recovery authenticates its own evidence independently.
                }
                // A paused task retains its task-owner projection after releasing the session.
                // Authenticate legacy paused records independently; they never gain the completed-owner exception.
                let pausedRun = priorRun;
                if (!pausedRun) {
                    try {
                        const legacyRun = await readAuthorizedReadOnly(this.dataRoot, "runs", safeId(owner.intentId));
                        if (legacyRun.status === "paused")
                            pausedRun = legacyRun;
                    }
                    catch (error) {
                        if (error.code !== "ENOENT")
                            throw error;
                    }
                }
                const pausedActivation = pausedRun?.activationToken ?? pausedRun?.operationToken;
                if (pausedRun?.schemaVersion === 1 && pausedRun.status === "paused" &&
                    ["tdd_red", "implement", "prove", "hitl", "complete"].includes(pausedRun.phase) &&
                    pausedRun.intentId === owner.intentId && pausedRun.runId === owner.runId &&
                    pausedRun.sessionId === operation.sessionId && pausedActivation === owner.operationToken &&
                    typeof pausedRun.operationToken === "string" && pausedRun.operationToken.trim() &&
                    pausedRun.operationToken !== operation.operationToken &&
                    (pausedRun.sessionLeaseId === undefined || pausedRun.sessionLeaseId === sessionLeaseId) &&
                    (pausedRun.sessionLeaseToken === undefined || pausedRun.sessionLeaseToken === owner.leaseToken) &&
                    typeof pausedRun.worktreePath === "string" && pausedRun.worktreePath.trim() &&
                    typeof pausedRun.branch === "string" && pausedRun.branch.trim() &&
                    typeof pausedRun.commonGitDir === "string" && pausedRun.commonGitDir.trim()) {
                    pausedSessionOwner = { worktreePath: pausedRun.worktreePath, branch: pausedRun.branch,
                        commonGitDir: pausedRun.commonGitDir };
                }
                if (priorRun?.phase === "complete" && priorRun.status === "green") {
                    const priorOperation = await readAuthorizedReadOnly(this.dataRoot, "begin-operations", safeId(owner.intentId));
                    const activation = priorRun.activationToken ?? priorRun.operationToken;
                    completedSessionOwner = priorOperation.schemaVersion === 1 &&
                        priorOperation.intentId === owner.intentId && priorOperation.sessionId === operation.sessionId &&
                        priorOperation.runId === owner.runId && priorRun.schemaVersion === 1 &&
                        priorRun.intentId === owner.intentId && priorRun.runId === owner.runId &&
                        priorRun.operationToken === priorOperation.operationToken && priorRun.sessionId === operation.sessionId &&
                        activation === owner.operationToken &&
                        (priorRun.sessionLeaseId === undefined || priorRun.sessionLeaseId === sessionLeaseId) &&
                        (priorRun.sessionLeaseToken === undefined || priorRun.sessionLeaseToken === owner.leaseToken) &&
                        !priorRun.preparedCommit && !priorRun.commitOperation && !priorRun.mutationOperation &&
                        !isPendingPlanReview(priorRun);
                }
            }
        }
        return { intent, operation, repository, lease, consumed, completedSessionTombstone, completedSessionOwner, pausedSessionOwner };
    }
    async recordBeginCancellation(marker) {
        return putAuthorizedOnceExact(this.dataRoot, "begin-cancellations", safeId(marker.intentId), marker);
    }
    async releaseBeginTargetLeaseAtGeneration(leaseId, intentId, leaseToken, expectedRevision, resourceGeneration) {
        return releaseAuthorizedLeaseAtGeneration(this.dataRoot, leaseId, intentId, leaseToken, expectedRevision, resourceGeneration);
    }
    async assertBeginNotCancelled(intentId) {
        await assertIntentNotRepossessed(this.dataRoot, intentId);
        const marker = await this.beginCancellationFor(intentId);
        if (marker && marker.schemaVersion === 1 && marker.kind === "failed_begin_cancelled" && marker.intentId === intentId) {
            throw new Error("implementation Begin was cancelled and this intent cannot be retried");
        }
        if (marker)
            throw new Error("signed Begin cancellation marker is invalid");
    }
    async markIntent(intent) { await this.save("intents", intent.intentId, intent); }
    async issueIdempotentIntent(request, factory) {
        const normalized = JSON.parse(JSON.stringify({ ...request, projectRoot: path.resolve(request.projectRoot) }));
        const id = digest(JSON.stringify([normalized.projectRoot, request.sessionId, request.turnId]));
        let receipt;
        try {
            receipt = await this.load("intent-issuance", id);
        }
        catch (error) {
            if (error.code !== "ENOENT")
                throw error;
        }
        if (!receipt) {
            const candidate = { request: normalized, intent: await factory() };
            try {
                receipt = await putAuthorizedOnceExact(this.dataRoot, "intent-issuance", id, candidate);
            }
            catch (error) {
                try {
                    receipt = await this.load("intent-issuance", id);
                }
                catch {
                    throw error;
                }
            }
        }
        if (JSON.stringify(receipt.request) !== JSON.stringify(normalized))
            throw new Error("intent issuance request changed within the same turn; use a new turn for a different request");
        try {
            const existing = await this.load("intents", receipt.intent.intentId);
            if (JSON.stringify({ ...existing, consumed: undefined }) !== JSON.stringify({ ...receipt.intent, consumed: undefined }))
                throw new Error("issued intent differs from its signed issuance receipt");
        }
        catch (error) {
            if (error.code !== "ENOENT")
                throw error;
            await putAuthorizedOnceExact(this.dataRoot, "intents", receipt.intent.intentId, receipt.intent);
        }
        return receipt.intent;
    }
    async recordUserAuthorization(input) { return recordUserAuthorizations(this.dataRoot, input); }
    async userAuthorizations(query) { return userAuthorizationStatus(this.dataRoot, query); }
    async recordUserRequest(input) { return recordUserRequest(this.dataRoot, input); }
    async userRequests(query) { return userRequestStatus(this.dataRoot, query); }
    async userRequestSource(query) { return readUserRequestSource(this.dataRoot, query); }
    async validateIntent(intentId, projectRoot) { await this.assertBeginNotCancelled(intentId); const intent = await this.load("intents", intentId); if (intent.consumed || intent.resumeOf)
        throw new Error("implementation intent is invalid or consumed"); if (path.resolve(intent.projectRoot) !== path.resolve(projectRoot))
        throw new Error("intent project root mismatch"); return intent; }
    async beginOperationFor(intentId) { return this.load("begin-operations", safeId(intentId)); }
    async activatedBeginRun(operation) { await this.assertBeginOperation(operation); try {
        const activated = await this.load("begin-activated", operation.operationToken);
        if (activated.intentId !== operation.intentId || activated.runId !== operation.runId)
            throw new Error("activated begin checkpoint does not match its reservation");
        const run = await this.run(operation.intentId);
        await this.assertSessionLease(run);
        const active = await this.load("begin-active", operation.operationToken);
        await this.project("active", operation.sessionId, active);
        await this.project("runs", operation.intentId, run);
        await this.project("permits", `${run.sessionId}-${run.turnId}`, this.permit(run));
        return run;
    }
    catch (error) {
        if (error.code === "ENOENT")
            return undefined;
        throw error;
    } }
    async reserveBegin(input) {
        await this.assertBeginNotCancelled(input.intentId);
        const intent = await this.load("intents", safeId(input.intentId));
        if (intent.resumeOf)
            throw new Error("resume intent cannot reserve a new implementation");
        let existing;
        try {
            existing = await this.beginOperationFor(input.intentId);
        }
        catch (error) {
            if (error.code !== "ENOENT")
                throw error;
        }
        if (existing) {
            this.assertBeginReservation(existing, intent, input);
            await putAuthorizedOnceExact(this.dataRoot, "begin-intent-consumed", existing.operationToken, { schemaVersion: 1, operationToken: existing.operationToken, intentId: existing.intentId });
            if (!intent.consumed)
                await this.project("intents", input.intentId, { ...intent, consumed: true });
            return existing;
        }
        if (intent.consumed)
            throw new Error("implementation intent is consumed without a signed begin reservation");
        if (!samePath(intent.projectRoot, input.projectRoot))
            throw new Error("intent project root mismatch");
        const candidate = { schemaVersion: 1, intentId: intent.intentId, operationToken: randomUUID(), leaseToken: input.leaseToken ?? randomUUID(), runId: `codex-${randomUUID()}`, startedAt: new Date().toISOString(), sessionId: intent.sessionId, turnId: intent.turnId, projectRoot: path.resolve(intent.projectRoot), objective: input.objective, ...(input.taskId ? { taskId: input.taskId } : {}), ...(intent.targetBranch ? { targetBranch: intent.targetBranch, targetOid: intent.targetOid } : {}) };
        let operation;
        try {
            operation = await putAuthorizedOnceExact(this.dataRoot, "begin-operations", safeId(input.intentId), candidate);
        }
        catch (error) {
            if (!String(error.message).includes("checkpoint does not match"))
                throw error;
            operation = await this.beginOperationFor(input.intentId);
        }
        this.assertBeginReservation(operation, intent, input);
        const current = await this.load("intents", input.intentId);
        this.assertBeginReservation(operation, current, input);
        await putAuthorizedOnceExact(this.dataRoot, "begin-intent-consumed", operation.operationToken, { schemaVersion: 1, operationToken: operation.operationToken, intentId: operation.intentId });
        if (!current.consumed)
            await this.project("intents", input.intentId, { ...current, consumed: true });
        return operation;
    }
    async checkpointBeginRepository(operation, repository, policy) {
        await this.assertBeginOperation(operation);
        const value = { schemaVersion: 1, operationToken: operation.operationToken, projectRoot: path.resolve(repository.projectRoot), baseHead: repository.baseHead, commonGitDir: path.resolve(repository.commonGitDir), policySha256: digest(JSON.stringify(policy)) };
        if (!samePath(value.projectRoot, operation.projectRoot) || !/^[0-9a-f]{40,64}$/i.test(value.baseHead) || (operation.targetOid && operation.targetOid !== value.baseHead))
            throw new Error("repository checkpoint does not match the signed begin reservation");
        return putAuthorizedOnceExact(this.dataRoot, "begin-repositories", operation.operationToken, value);
    }
    async ensureBeginTargetLease(operation, repository) {
        await this.assertBeginOperation(operation);
        if (!operation.targetBranch || !operation.targetOid)
            return undefined;
        const leaseId = digest(`${path.resolve(repository.commonGitDir)}\0refs/heads/${operation.targetBranch}`.toLowerCase()), payload = { intentId: operation.intentId, leaseToken: operation.leaseToken, operationToken: operation.operationToken, commonGitDir: path.resolve(repository.commonGitDir), targetBranch: operation.targetBranch, targetOid: operation.targetOid };
        try {
            await ensureAuthorizedLease(this.dataRoot, leaseId, payload);
        }
        catch (error) {
            if (!String(error.message).includes("already leased"))
                throw error;
            const priorLease = await readAuthorizedLease(this.dataRoot, leaseId);
            let prior;
            try {
                prior = await this.run(priorLease.intentId);
            }
            catch {
                throw error;
            }
            if (prior.phase !== "complete" || prior.status !== "green" || prior.leaseId !== leaseId || prior.leaseToken !== priorLease.leaseToken)
                throw error;
            await releaseAuthorizedLease(this.dataRoot, leaseId, prior.intentId, priorLease.leaseToken);
            await ensureAuthorizedLease(this.dataRoot, leaseId, payload);
        }
        const snapshot = await readAuthorizedLeaseSnapshotReadOnly(this.dataRoot, leaseId);
        if (!snapshot || snapshot.state !== "held" || snapshot.legacy || !Number.isSafeInteger(snapshot.revision) ||
            snapshot.payload.intentId !== operation.intentId || snapshot.payload.leaseToken !== operation.leaseToken ||
            snapshot.payload.operationToken !== operation.operationToken || snapshot.payload.targetBranch !== operation.targetBranch ||
            snapshot.payload.targetOid !== operation.targetOid || !samePath(snapshot.payload.commonGitDir, repository.commonGitDir)) {
            throw new Error("target lease changed before the signed Begin lease checkpoint");
        }
        const resourceGeneration = digest(JSON.stringify({ leaseId, revision: snapshot.revision, state: snapshot.state, payload: snapshot.payload }));
        return { leaseId, leaseToken: operation.leaseToken, leaseRevision: snapshot.revision, resourceGeneration };
    }
    async checkpointBeginLease(operation, repository, lease) {
        await this.assertBeginOperation(operation);
        let leaseFields = {};
        if (lease) {
            const snapshot = await readAuthorizedLeaseSnapshotReadOnly(this.dataRoot, lease.leaseId);
            if (!snapshot || snapshot.state !== "held" || snapshot.legacy || !Number.isSafeInteger(snapshot.revision) ||
                snapshot.payload.intentId !== operation.intentId || snapshot.payload.leaseToken !== operation.leaseToken ||
                (snapshot.payload.operationToken !== undefined && snapshot.payload.operationToken !== operation.operationToken) ||
                snapshot.payload.targetBranch !== operation.targetBranch ||
                snapshot.payload.targetOid !== operation.targetOid || !samePath(snapshot.payload.commonGitDir, repository.commonGitDir)) {
                throw new Error("target lease checkpoint does not match its signed authority");
            }
            const resourceGeneration = digest(JSON.stringify({ leaseId: lease.leaseId, revision: snapshot.revision, state: snapshot.state, payload: snapshot.payload }));
            if ((lease.leaseRevision !== undefined && lease.leaseRevision !== snapshot.revision) ||
                (lease.resourceGeneration !== undefined && lease.resourceGeneration !== resourceGeneration)) {
                throw new Error("target lease changed before the signed Begin lease checkpoint");
            }
            leaseFields = { leaseRevision: snapshot.revision, resourceGeneration };
        }
        const value = { schemaVersion: 1, operationToken: operation.operationToken, ...(lease ? { leaseId: lease.leaseId, leaseToken: lease.leaseToken, ...leaseFields, commonGitDir: repository.commonGitDir, targetBranch: operation.targetBranch, targetOid: operation.targetOid } : {}) };
        if (Boolean(operation.targetBranch) !== Boolean(lease) || (lease && lease.leaseToken !== operation.leaseToken))
            throw new Error("target lease checkpoint does not match the signed begin reservation");
        return putAuthorizedOnceExact(this.dataRoot, "begin-leases", operation.operationToken, value);
    }
    async checkpointBeginWorkspace(operation, workspace) {
        await this.assertBeginOperation(operation);
        const { primaryProjectRoot, ...ownedWorkspace } = workspace;
        const value = { schemaVersion: 1, operationToken: operation.operationToken, ...ownedWorkspace, projectRoot: path.resolve(workspace.projectRoot), worktreePath: path.resolve(workspace.worktreePath), commonGitDir: path.resolve(workspace.commonGitDir), gitDir: path.resolve(workspace.gitDir) };
        const primary = primaryProjectRoot === undefined ? operation.projectRoot : await (await import("./workspace.js")).primaryRepositoryRoot(operation.projectRoot, value.commonGitDir);
        if (primaryProjectRoot !== undefined && !samePath(primary, primaryProjectRoot))
            throw new Error("workspace primary root differs from the registered Git repository");
        const canonical = path.join(primary, ".captain-sdlc", "worktrees");
        if (!samePath(path.dirname(value.worktreePath), canonical) || !samePath(value.projectRoot, operation.projectRoot) || value.targetBranch !== operation.targetBranch || (operation.targetBranch && value.branch !== operation.targetBranch))
            throw new Error("workspace checkpoint does not match the signed begin reservation");
        return putAuthorizedOnceExact(this.dataRoot, "begin-workspaces", operation.operationToken, value);
    }
    async checkpointBeginRun(operation, policy) {
        await this.assertBeginOperation(operation);
        const repository = await this.load("begin-repositories", operation.operationToken), lease = await this.load("begin-leases", operation.operationToken), workspace = await this.load("begin-workspaces", operation.operationToken);
        if (repository.policySha256 !== digest(JSON.stringify(policy)) || repository.baseHead !== workspace.baseHead || !samePath(repository.commonGitDir, workspace.commonGitDir))
            throw new Error("begin checkpoints diverged before run activation");
        if (Boolean(operation.targetBranch) !== Boolean(lease.leaseId))
            throw new Error("target lease checkpoint is missing or unexpected before run activation");
        if (lease.leaseId) {
            if (!lease.leaseToken || lease.leaseToken !== operation.leaseToken ||
                !Number.isSafeInteger(lease.leaseRevision) || typeof lease.resourceGeneration !== "string" ||
                !/^[0-9a-f]{64}$/i.test(lease.resourceGeneration)) {
                throw new Error("target lease generation is missing from the signed Begin checkpoint");
            }
            const current = await readAuthorizedLeaseSnapshotReadOnly(this.dataRoot, lease.leaseId);
            const generation = current && typeof current.revision === "number"
                ? digest(JSON.stringify({ leaseId: lease.leaseId, revision: current.revision, state: current.state, payload: current.payload }))
                : undefined;
            if (!current || current.state !== "held" || current.legacy || current.revision !== lease.leaseRevision || generation !== lease.resourceGeneration ||
                current.payload.intentId !== operation.intentId || current.payload.leaseToken !== operation.leaseToken ||
                (current.payload.operationToken !== undefined && current.payload.operationToken !== operation.operationToken) ||
                current.payload.targetBranch !== operation.targetBranch ||
                current.payload.targetOid !== operation.targetOid || !samePath(current.payload.commonGitDir, repository.commonGitDir)) {
                throw new Error("target lease generation changed before run revision 0; Begin was fenced");
            }
        }
        const profile = (await this.load("intents", operation.intentId)).requestedProfile ?? policy.profile;
        if (!(policy.profiles ?? [policy.profile]).includes(profile))
            throw new Error(`requested ${profile} sequence is not allowed by trusted policy`);
        if (policy.commit?.require_task_trailer && (!operation.taskId || !/^[A-Za-z0-9._-]+$/.test(operation.taskId)))
            throw new Error("trusted commit policy requires a safe task id");
        const run = { schemaVersion: 1, revision: 0, runId: operation.runId, operationToken: operation.operationToken, intentId: operation.intentId, sessionId: operation.sessionId, turnId: operation.turnId, activationToken: operation.operationToken, ...(operation.taskId ? { taskId: operation.taskId } : {}), objective: operation.objective, projectRoot: workspace.projectRoot, worktreePath: workspace.worktreePath, baseHead: workspace.baseHead, branch: workspace.branch, ...(operation.targetBranch ? { targetBranch: operation.targetBranch } : {}), commonGitDir: workspace.commonGitDir, gitDir: workspace.gitDir, ...(lease.leaseId ? { leaseId: lease.leaseId, leaseToken: lease.leaseToken } : {}), profile, visualRequired: policy.visualRequired, startedAt: operation.startedAt, phase: "tdd_red", status: "running", policy, evidence: [] };
        await putAuthorizedOnceExact(this.dataRoot, "run-revisions", `${operation.intentId}-0`, run);
        const authoritative = await this.run(operation.intentId);
        await this.reconcileRunProjections(authoritative);
        return authoritative;
    }
    async checkpointBeginPermit(operation, run) { await this.assertBeginOperation(operation); let authoritative = await this.run(operation.intentId); const activated = await this.load("begin-activated", operation.operationToken); if (run.runId !== operation.runId || authoritative.runId !== operation.runId || activated.operationToken !== operation.operationToken)
        throw new Error("run checkpoint is not activated for permit publication"); let claimedTurn; try {
        claimedTurn = await this.load("begin-turn-resumes", operation.operationToken);
    }
    catch (error) {
        if (error.code !== "ENOENT")
            throw error;
    } if (claimedTurn) {
        if (claimedTurn.operationToken !== operation.operationToken || claimedTurn.intentId !== operation.intentId || claimedTurn.sessionId !== operation.sessionId || typeof claimedTurn.turnId !== "string")
            throw new Error("pending begin current-turn claim is invalid");
        if (authoritative.turnId !== claimedTurn.turnId)
            authoritative = await this.update({ ...authoritative, turnId: claimedTurn.turnId });
    } await this.assertSessionLease(authoritative); const permit = this.permit(authoritative); await putAuthorizedOnceExact(this.dataRoot, "begin-permits", `${operation.operationToken}-${authoritative.turnId}`, permit); await this.project("permits", `${operation.sessionId}-${authoritative.turnId}`, permit); return permit; }
    async checkpointBeginActive(operation) {
        await this.assertBeginOperation(operation);
        let run = await this.run(operation.intentId);
        const sessionLeaseId = digest(`session-active\0${operation.sessionId}`), payload = { intentId: operation.intentId, leaseToken: operation.operationToken, operationToken: operation.operationToken, runId: operation.runId, sessionId: operation.sessionId, operation: "session-active" };
        try {
            await ensureAuthorizedLease(this.dataRoot, sessionLeaseId, payload);
        }
        catch (error) {
            if (!String(error.message).includes("already leased"))
                throw error;
            const priorLease = await readAuthorizedLease(this.dataRoot, sessionLeaseId), prior = await this.run(priorLease.intentId);
            if (prior.phase !== "complete" || prior.status !== "green" || prior.sessionLeaseId !== sessionLeaseId || prior.sessionLeaseToken !== priorLease.leaseToken)
                throw error;
            await releaseAuthorizedLease(this.dataRoot, sessionLeaseId, prior.intentId, priorLease.leaseToken);
            await ensureAuthorizedLease(this.dataRoot, sessionLeaseId, payload);
        }
        run = await this.run(operation.intentId);
        if (run.sessionLeaseId !== sessionLeaseId || run.sessionLeaseToken !== operation.operationToken) {
            try {
                run = await this.update({ ...run, sessionLeaseId, sessionLeaseToken: operation.operationToken });
            }
            catch (error) {
                run = await this.run(operation.intentId);
                if (run.sessionLeaseId !== sessionLeaseId || run.sessionLeaseToken !== operation.operationToken)
                    throw error;
            }
        }
        const active = { schemaVersion: 1, intentId: operation.intentId, operationToken: operation.operationToken, runId: operation.runId, sessionId: operation.sessionId, leaseId: sessionLeaseId, leaseToken: operation.operationToken };
        await putAuthorizedOnceExact(this.dataRoot, "begin-active", operation.operationToken, active);
        await this.project("active", operation.sessionId, active);
        return active;
    }
    async checkpointBeginActivated(operation) { await this.assertBeginOperation(operation); const run = await this.run(operation.intentId), active = await this.load("begin-active", operation.operationToken); if (run.runId !== operation.runId || active.intentId !== operation.intentId || active.operationToken !== operation.operationToken)
        throw new Error("begin activation checkpoints are incomplete"); await this.assertSessionLease(run); await this.captureSessionOwner(run); await putAuthorizedOnceExact(this.dataRoot, "begin-activated", operation.operationToken, { schemaVersion: 1, operationToken: operation.operationToken, intentId: operation.intentId, runId: operation.runId, sessionId: operation.sessionId, turnId: operation.turnId }); await this.project("active", operation.sessionId, active); return run; }
    async begin(input) {
        if ("documentationScope" in input || "schemaVersion" in input)
            throw new Error("Begin cannot inject documentation scope or schema; use the audited public transition");
        return this.withSerializedBeginAttempt(input.intentId, async () => {
            const operation = await this.reserveBegin({ intentId: input.intentId, objective: input.objective, projectRoot: input.projectRoot, taskId: input.taskId, leaseToken: input.leaseToken });
            const activated = await this.activatedBeginRun(operation);
            if (activated)
                return this.status(activated.intentId);
            const repository = await this.checkpointBeginRepository(operation, input, input.policy), lease = await this.checkpointBeginLease(operation, repository, input.leaseId && input.leaseToken ? { leaseId: input.leaseId, leaseToken: input.leaseToken } : undefined);
            await this.checkpointBeginWorkspace(operation, { projectRoot: input.projectRoot, worktreePath: input.worktreePath, baseHead: input.baseHead, branch: input.branch, targetBranch: input.targetBranch, commonGitDir: input.commonGitDir, gitDir: input.gitDir });
            const run = await this.checkpointBeginRun(operation, input.policy);
            await this.checkpointBeginActive(operation);
            const activatedRun = await this.checkpointBeginActivated(operation);
            await this.checkpointBeginPermit(operation, activatedRun);
            return this.status(operation.intentId);
        });
    }
    async bindSessionOwner(intentId, sessionId, owner) {
        validateSessionOwner(owner);
        const run = await this.run(intentId);
        if (run.sessionId !== sessionId || run.status === "paused" || run.status === "green")
            throw new Error("client owner session binding is not active");
        await this.assertSessionLease(run);
        const binding = { schemaVersion: 1, intentId, runId: run.runId, sessionId,
            activationToken: run.activationToken ?? run.operationToken, sessionLeaseId: run.sessionLeaseId,
            sessionLeaseToken: run.sessionLeaseToken, owner };
        await putAuthorizedOnceExact(this.dataRoot, "session-owner-bindings", binding.activationToken, binding);
    }
    async sessionInterruptionStatus(intentId, sessionId) {
        const run = await this.interruptionRunReadOnly(intentId);
        if (run.sessionId !== sessionId)
            throw new Error("client session binding does not match the selected run");
        const binding = await this.readSessionOwner(run);
        const ownerState = binding ? await (this.hooks?.probeSessionOwner ?? probeSessionOwner)(binding.owner) : { state: "legacy", reason: "no captured client owner identity" };
        const owner = { ...ownerState, ...(binding ? { pid: binding.owner.pid, host: binding.owner.host, startedAt: binding.owner.startedAt } : {}) };
        if (run.status === "paused" || run.status === "green")
            return { intentId, runId: run.runId, sessionId, status: run.status, phase: run.phase, owner, canRecover: false, selectors: undefined };
        const lease = await this.interruptionLeaseReadOnly(run);
        const selectors = { intentId, sessionId, expectedRunRevision: run.revision, expectedSessionLeaseRevision: lease.revision,
            resourceGeneration: digest(JSON.stringify({ leaseId: run.sessionLeaseId, revision: lease.revision, state: "held", payload: lease.payload })) };
        return { intentId, runId: run.runId, sessionId, status: run.status, phase: run.phase, owner, canRecover: ownerState.state === "stopped", selectors };
    }
    async recoverInterruptedSession(args) {
        const saved = await this.interruptionResult(args);
        if (saved)
            return saved;
        const run = await this.assertInterruptionSelectors(args);
        const binding = await this.readSessionOwner(run);
        if (!binding)
            throw new Error("legacy client session has no captured owner identity; recovery refused");
        const owner = await (this.hooks?.probeSessionOwner ?? probeSessionOwner)(binding.owner);
        if (owner.state !== "stopped")
            throw new Error(`client owner is ${owner.state}; positive stopped proof is required`);
        return this.pauseWithSessionFence(args.intentId, { summary: args.summary, nextSteps: args.nextSteps }, { args, reason: "crashed", requireStopped: true });
    }
    async recordSessionClosed(args) {
        const run = await this.interruptionRunReadOnly(args.intentId);
        const binding = await this.readSessionOwner(run);
        if (!binding?.owner.closeTokenHash || typeof args.ownerToken !== "string" || !args.ownerToken || digest(args.ownerToken) !== binding.owner.closeTokenHash) {
            throw new Error("client close capability token is invalid or owner identity is unregistered");
        }
        if (!["closed", "crashed"].includes(args.reason))
            throw new Error("client close reason is invalid");
        const saved = await this.interruptionResult(args);
        if (saved)
            return saved;
        await this.assertInterruptionSelectors(args);
        return this.pauseWithSessionFence(args.intentId, { summary: args.summary, nextSteps: args.nextSteps }, { args, reason: args.reason, requireStopped: false });
    }
    async resume(resumeIntentId) {
        const intent = await this.load("intents", safeId(resumeIntentId));
        if (!intent.resumeOf)
            throw new Error("resume intent is invalid or consumed");
        await this.assertFrozenScope(intent.resumeOf);
        let priorRun = await this.run(intent.resumeOf);
        if (priorRun.status === "paused") {
            await this.completePendingSessionInterruption(priorRun);
            priorRun = await this.run(intent.resumeOf);
        }
        if (priorRun.phase === "complete" && isPendingPlanReview(priorRun)) {
            if (!samePath(priorRun.projectRoot, intent.projectRoot))
                throw new Error("unrelated run cannot be resumed");
            if (priorRun.sessionLeaseId || priorRun.leaseId)
                throw new Error("legacy review ownership must be finalized before resume");
            if (this.probe)
                this.assertWorktreeBinding(priorRun, await this.probe(priorRun.worktreePath, priorRun.policy), this.expectedHead(priorRun));
            const targetLease = priorRun.targetBranch ? await this.acquireTargetLease(priorRun.intentId, priorRun.commonGitDir, priorRun.targetBranch, this.expectedHead(priorRun)) : undefined;
            priorRun = await this.update({ ...priorRun, ...targetLease, phase: "hitl", status: "paused", evidence: [...priorRun.evidence, { kind: "review_resume_migration", resumeIntentId }] });
        }
        if (priorRun.status !== "paused") {
            const transferringSession = priorRun.sessionId !== intent.sessionId;
            const hasSessionLease = Boolean(priorRun.sessionLeaseId && priorRun.sessionLeaseToken);
            // A logical session ID can survive an application restart. A positively
            // stopped captured owner still needs a fresh activation in that same ID.
            if (transferringSession || (hasSessionLease && await this.readSessionOwner(priorRun))) {
                const interruption = await this.sessionInterruptionStatus(priorRun.intentId, priorRun.sessionId);
                if (interruption.canRecover && interruption.selectors) {
                    await this.recoverInterruptedSession({ ...interruption.selectors, summary: "Client process ended; retain and resume the same task", nextSteps: ["Continue the existing signed task and retained worktree"] });
                    priorRun = await this.run(intent.resumeOf);
                }
                else if (transferringSession)
                    throw new Error(`active run belongs to another session; client owner is ${interruption.owner.state}; its owner must pause before transfer`);
            }
        }
        let operation;
        try {
            operation = await this.load("resume-operations", resumeIntentId);
        }
        catch (error) {
            if (error.code !== "ENOENT")
                throw error;
        }
        if (!operation) {
            if (intent.consumed)
                throw new Error("resume intent is invalid or consumed");
            const run = await this.run(intent.resumeOf);
            if (run.status === "green" || !samePath(run.projectRoot, intent.projectRoot))
                throw new Error("completed or unrelated run cannot be resumed");
            if (run.status !== "paused") {
                if (run.sessionId === intent.sessionId && !run.sessionLeaseId && !run.sessionLeaseToken)
                    await this.assertRecoverableSameSessionWithoutLease(run, intent);
                else
                    await this.assertSessionLease(run);
            }
            operation = await putAuthorizedOnceExact(this.dataRoot, "resume-operations", resumeIntentId, { schemaVersion: 1, resumeIntentId, operationToken: randomUUID(), intentId: run.intentId, runId: run.runId, sessionId: intent.sessionId, turnId: intent.turnId });
        }
        if (operation.resumeIntentId !== resumeIntentId || operation.intentId !== intent.resumeOf || operation.sessionId !== intent.sessionId || operation.turnId !== intent.turnId)
            throw new Error("resume retry does not match its signed operation");
        await putAuthorizedOnceExact(this.dataRoot, "resume-intent-consumed", operation.operationToken, { schemaVersion: 1, operationToken: operation.operationToken, resumeIntentId });
        if (!intent.consumed)
            await this.project("intents", resumeIntentId, { ...intent, consumed: true });
        await this.hooks?.afterResumeReserved?.(operation);
        try {
            const activated = await this.load("resume-activated", operation.operationToken);
            if (activated.intentId !== operation.intentId || activated.turnId !== operation.turnId)
                throw new Error("resume activation checkpoint is invalid");
            const run = await this.run(operation.intentId);
            await this.assertSessionLease(run);
            await this.project("permits", `${run.sessionId}-${run.turnId}`, this.permit(run));
            return run;
        }
        catch (error) {
            if (error.code !== "ENOENT")
                throw error;
        }
        let run = await this.run(operation.intentId);
        if (run.runId !== operation.runId || run.status === "green")
            throw new Error("resume operation no longer matches an active run");
        if (run.status !== "paused") {
            if (run.sessionId === operation.sessionId && !run.sessionLeaseId && !run.sessionLeaseToken)
                await this.assertRecoverableSameSessionWithoutLease(run, intent);
            else
                await this.assertSessionLease(run);
        }
        if (this.probe) {
            const current = await this.probe(run.worktreePath, run.policy);
            this.assertWorktreeBinding(run, current);
            if (run.preparedCommit) {
                if (![run.preparedCommit.preCommitHead, run.preparedCommit.candidate].includes(current.head))
                    throw new Error("worktree branch binding diverged from the signed Captain run");
            }
            else if (current.head !== this.expectedHead(run)) {
                const handoff = await this.resumeHandoff(run);
                if (!handoff?.worktreeState || current.head !== handoff.worktreeState.head || current.tree !== handoff.worktreeState.tree)
                    throw new Error("worktree branch binding diverged from the signed Captain run");
                run = { ...run, continuityState: handoff.worktreeState, evidence: [...run.evidence, { kind: "resume_source_reconciled", pauseRevision: handoff.revision, previousExpectedHead: this.expectedHead(run), head: current.head, tree: current.tree, proofRecorded: false }] };
            }
        }
        if (run.status !== "paused" && run.sessionId === operation.sessionId && run.sessionLeaseId && run.sessionLeaseToken) {
            if (run.turnId !== operation.turnId)
                run = await this.update({ ...run, turnId: operation.turnId });
        }
        else {
            const previousLease = run.status === "paused" || !run.sessionLeaseId || !run.sessionLeaseToken ? undefined : { id: run.sessionLeaseId, token: run.sessionLeaseToken }, sessionLeaseId = digest(`session-active\0${operation.sessionId}`), sessionLeaseToken = operation.operationToken;
            await ensureAuthorizedLease(this.dataRoot, sessionLeaseId, { intentId: run.intentId, leaseToken: sessionLeaseToken, operationToken: operation.operationToken, runId: run.runId, sessionId: operation.sessionId, operation: "session-active" });
            run = await this.update({ ...run, sessionId: operation.sessionId, turnId: operation.turnId, activationToken: operation.operationToken, sessionLeaseId, sessionLeaseToken, status: "running" });
            if (previousLease)
                await releaseAuthorizedLease(this.dataRoot, previousLease.id, run.intentId, previousLease.token);
        }
        await this.captureSessionOwner(run);
        await this.project("active", operation.sessionId, { schemaVersion: 1, intentId: run.intentId, operationToken: run.activationToken ?? run.operationToken, runId: run.runId, sessionId: operation.sessionId, leaseId: run.sessionLeaseId, leaseToken: run.sessionLeaseToken });
        const handoff = (await this.handoffs()).find(candidate => candidate.intentId === run.intentId && candidate.planPath);
        if (handoff?.planPath)
            await this.projectPlanState(run, handoff.planPath, { status: "in-progress", phase: handoff.phaseLabel ?? run.phase, handoff: "none", blocker: "none", next: handoff.nextSteps });
        await putAuthorizedOnceExact(this.dataRoot, "resume-runs", operation.operationToken, { schemaVersion: 1, operationToken: operation.operationToken, intentId: run.intentId, runId: run.runId, revision: run.revision, turnId: run.turnId });
        await putAuthorizedOnceExact(this.dataRoot, "resume-activated", operation.operationToken, { schemaVersion: 1, operationToken: operation.operationToken, intentId: run.intentId, runId: run.runId, turnId: run.turnId });
        await this.project("permits", `${run.sessionId}-${run.turnId}`, this.permit(run));
        return run;
    }
    async pause(intentId, input) {
        return this.pauseWithSessionFence(intentId, input);
    }
    async pauseWithSessionFence(intentId, input, fence) {
        const run = await this.run(intentId);
        if (run.status === "green")
            throw new Error("a completed Captain run cannot be paused");
        await this.assertSessionLease(run);
        const summary = input.summary.trim(), nextSteps = input.nextSteps.map(step => step.trim()).filter(Boolean), blockers = (input.blockers ?? []).map(blocker => blocker.trim()).filter(Boolean), completedSteps = (input.completedSteps ?? []).map(step => step.trim()).filter(Boolean), planPath = input.planPath?.trim() || undefined, phaseLabel = input.phaseLabel?.trim() || undefined, context = input.context?.trim() || undefined, redirectTask = input.redirectTask?.trim() || undefined;
        if (!summary || !nextSteps.length)
            throw new Error("pause handoff requires a summary and at least one next step");
        const user_request = await this.userRequests({ projectRoot: run.projectRoot, intentId: run.intentId });
        const worktreeState = this.probe ? await this.probe(run.worktreePath, run.policy) : undefined;
        if (worktreeState)
            this.assertWorktreeBinding(run, worktreeState);
        if (fence) {
            await this.assertInterruptionSelectors(fence.args);
            if (fence.requireStopped) {
                const binding = await this.readSessionOwner(run);
                const checked = binding && await (this.hooks?.probeSessionOwner ?? probeSessionOwner)(binding.owner);
                if (checked?.state !== "stopped")
                    throw new Error("client owner stopped proof changed before pause");
                await this.assertInterruptionSelectors(fence.args);
            }
        }
        if (fence) {
            const draft = { user_request, schemaVersion: 1, intentId: run.intentId, runId: run.runId,
                revision: run.revision + 1, sessionId: run.sessionId, turnId: run.turnId, projectRoot: run.projectRoot,
                worktreePath: run.worktreePath, branch: run.branch, ...(run.taskId ? { taskId: run.taskId } : {}),
                objective: run.objective, phase: run.phase, status: "paused", ...(planPath ? { planPath } : {}),
                ...(phaseLabel ? { phaseLabel } : {}), completedSteps, summary, nextSteps, blockers,
                ...(context ? { context } : {}), ...(worktreeState ? { worktreeState } : {}),
                resumeDirective: `[Captain resume: ${run.intentId}]`, ...(redirectTask ? { redirectPrompt: `[Captain plan: ${redirectTask}]` } : {}) };
            const selectors = { intentId: fence.args.intentId, sessionId: fence.args.sessionId, expectedRunRevision: fence.args.expectedRunRevision,
                expectedSessionLeaseRevision: fence.args.expectedSessionLeaseRevision, resourceGeneration: fence.args.resourceGeneration };
            await putAuthorizedOnceExact(this.dataRoot, "session-interruption-drafts", this.interruptionSelectorId(fence.args), { handoff: draft, selectors });
        }
        const paused = await this.update({ ...run, status: "paused", evidence: [...run.evidence,
                ...(fence ? [{ kind: "session_interruption", reason: fence.reason, sessionId: run.sessionId, selectorHash: this.interruptionSelectorId(fence.args), retainedWorktree: run.worktreePath }] : []), { kind: "pause", summarySha256: digest(summary), nextSteps, blockers, ...(planPath ? { planPath } : {}), ...(phaseLabel ? { phaseLabel } : {}) }] });
        const handoff = { user_request, schemaVersion: 1, intentId: paused.intentId, runId: paused.runId, revision: paused.revision, sessionId: paused.sessionId, turnId: paused.turnId, projectRoot: paused.projectRoot, worktreePath: paused.worktreePath, branch: paused.branch, ...(paused.taskId ? { taskId: paused.taskId } : {}), objective: paused.objective, phase: paused.phase, status: paused.status, ...(planPath ? { planPath } : {}), ...(phaseLabel ? { phaseLabel } : {}), completedSteps, summary, nextSteps, blockers, ...(context ? { context } : {}), ...(worktreeState ? { worktreeState } : {}), evidence: paused.evidence, resumeDirective: `[Captain resume: ${paused.intentId}]`, ...(redirectTask ? { redirectPrompt: `[Captain plan: ${redirectTask}]` } : {}) };
        const saved = await putAuthorizedOnceExact(this.dataRoot, "pause-handoffs", `${paused.intentId}-${paused.revision}`, handoff);
        if (planPath)
            await this.projectPlanState(paused, planPath, { status: blockers.length ? "blocked" : redirectTask ? "redirected" : "paused", phase: phaseLabel ?? paused.phase, handoff: `${paused.intentId}-${paused.revision}`, blocker: blockers.join("; ") || "none", next: nextSteps });
        if (fence) {
            await releaseAuthorizedLeaseAtGeneration(this.dataRoot, run.sessionLeaseId, run.intentId, run.sessionLeaseToken, fence.args.expectedSessionLeaseRevision, fence.args.resourceGeneration);
            await putAuthorizedOnceExact(this.dataRoot, "session-interruption-results", this.interruptionSelectorId(fence.args), saved);
        }
        else
            await releaseAuthorizedLease(this.dataRoot, run.sessionLeaseId, run.intentId, run.sessionLeaseToken);
        return saved;
    }
    async handoffs() { let names = []; try {
        names = await readdir(path.join(this.dataRoot, "pause-handoffs"));
    }
    catch (error) {
        if (error.code !== "ENOENT")
            throw error;
    } return (await Promise.all(names.filter(name => name.endsWith(".json")).map(name => this.load("pause-handoffs", name.slice(0, -5))))).sort((left, right) => right.revision - left.revision); }
    async linkBlocker(blockedIntentId, blockerIntentId) { const blocked = await this.run(blockedIntentId), blocker = await this.run(blockerIntentId); if (blocked.status !== "paused" || blocker.status === "green" || !samePath(blocked.projectRoot, blocker.projectRoot))
        throw new Error("blocker link requires a paused parent and an active same-project blocker"); const candidate = { schemaVersion: 1, blockedIntentId: blocked.intentId, blockerIntentId: blocker.intentId, blockedRunId: blocked.runId, blockerRunId: blocker.runId, projectRoot: blocked.projectRoot, createdAt: new Date().toISOString() }, link = await putAuthorizedOnceExact(this.dataRoot, "blocker-links", `${blocked.intentId}-${blocker.intentId}`, candidate); const handoff = (await this.handoffs()).find(candidate => candidate.intentId === blocked.intentId && candidate.planPath); if (handoff?.planPath)
        await this.projectPlanState(blocked, handoff.planPath, { status: "blocked", phase: handoff.phaseLabel ?? blocked.phase, handoff: `${handoff.intentId}-${handoff.revision}`, blocker: blockerIntentId, next: handoff.nextSteps }); return link; }
    async doctor() { const handoffs = await this.handoffs(); let names = []; try {
        names = await readdir(path.join(this.dataRoot, "run-revisions"));
    }
    catch (error) {
        if (error.code !== "ENOENT")
            throw error;
    } const ids = [...new Set(names.map(name => /^(.*)-0\.json$/.exec(name)?.[1]).filter((value) => Boolean(value)))], runs = await Promise.all(ids.map(id => this.run(id))); return { pausedHandoffs: handoffs, activeRuns: runs.filter(run => run.status !== "green" || isPendingPlanReview(run)).map(run => ({ intentId: run.intentId, sessionId: run.sessionId, turnId: run.turnId, status: run.status, phase: run.phase, worktreePath: run.worktreePath, branch: run.branch, projectRoot: run.projectRoot, ...(run.taskId ? { taskId: run.taskId } : {}) })) }; }
    async migratePlanState(intentId, planPaths) {
        const run = await this.run(intentId);
        this.phase(run, "implement");
        await this.assertSessionLease(run);
        if (!planPaths.length)
            throw new Error("select at least one Markdown plan to migrate");
        const migrated = [];
        for (const relative of planPaths) {
            const normalized = this.safePlanPath(run, relative);
            if (this.isFrozenPlan(run, normalized))
                throw new Error(`frozen approved plan cannot receive progress edits: ${relative}; use the signed handoff or a separate closure record`);
            const file = path.resolve(run.worktreePath, normalized);
            const original = await readFile(file, "utf8");
            if (/<!-- captain:work-state\r?\n[\s\S]*?-->/.test(original))
                continue;
            const heading = /^# .+\r?\n/.exec(original);
            if (!heading)
                throw new Error(`plan requires a level-one title before migration: ${relative}`);
            const line = heading[0].includes("\r\n") ? "\r\n" : "\n", block = `${line}<!-- captain:work-state${line}status: in-progress${line}phase: unspecified${line}updated: ${new Date().toISOString()}${line}handoff: none${line}blocker: none${line}next: []${line}-->${line}`;
            await writeFile(file, `${heading[0]}${block}${original.slice(heading[0].length)}`, "utf8");
            migrated.push(normalized);
        }
        return migrated;
    }
    async prepareDocumentation(intentId, paths, reason, expectedHead) {
        await this.assertFrozenScope(intentId);
        const run = await this.run(intentId);
        await this.assertSessionLease(run);
        if (run.status === "paused" || run.status === "green")
            throw new Error("documentation preparation requires an active owned run; resume the original task first");
        if (run.documentationScope) {
            this.phase(run, "implement");
            if (JSON.stringify([...paths].sort()) !== JSON.stringify(run.documentationScope.paths) || reason.trim() !== run.documentationScope.reason || expectedHead !== run.documentationScope.expectedHead)
                throw new Error("documentation scope replay must match its original paths, reason and revision");
            await assertDocumentationScope(run);
            return run;
        }
        this.phase(run, "tdd_red");
        if (run.preparedCommit || run.commitOperation || run.mutationOperation || run.preparedMerges?.length || run.committedState || run.taskTicket || run.evidence.some(item => item.kind === "tdd_red"))
            throw new Error("documentation classification requires an uncommitted pre-implementation task without pending operations");
        if (!this.probe || expectedHead !== this.expectedHead(run))
            throw new Error("documentation scope must pin the current governed revision");
        this.assertWorktreeBinding(run, await this.probe(run.worktreePath, run.policy), expectedHead);
        const documentationScope = await captureDocumentationScope(run, paths, reason, expectedHead);
        this.assertWorktreeBinding(run, await this.probe(run.worktreePath, run.policy), expectedHead);
        return this.update({ ...run, schemaVersion: 2, documentationScope, phase: "implement", evidence: [...run.evidence, { kind: "documentation_scope", ...documentationScope }] });
    }
    async recordRed(intentId, command, ticketFilter) {
        await this.assertFrozenScope(intentId);
        const run = await this.run(intentId);
        this.phase(run, "tdd_red");
        const configured = run.policy.commands.ticket;
        if (this.probe)
            this.assertWorktreeBinding(run, await this.probe(run.worktreePath, run.policy), this.expectedHead(run));
        if (!configured || (command && command !== configured))
            throw new Error("red test must use the trusted ticket command");
        const selected = taskTicketCommand(run, "ticket", ticketFilter);
        await prepareScopeOutputs(run.worktreePath, run.policy, "ticket");
        const result = await this.runner(selected.command, run.worktreePath), red = run.policy.redGate;
        if (this.probe)
            this.assertWorktreeBinding(run, await this.probe(run.worktreePath, run.policy), this.expectedHead(run));
        if (!red || !red.expectedExitCodes.includes(result.exitCode) || !compileSafeRegex(red.outputPattern, "i", "trusted red gate pattern").test(`${result.stdout}\n${result.stderr}`.slice(0, 1024 * 1024)))
            throw new Error("TDD red gate must be an expected failing test result, not an infrastructure failure");
        return this.update({ ...run, ...(selected.binding ? { taskTicket: selected.binding } : {}), phase: "implement", evidence: [...run.evidence, { kind: "tdd_red", commandSha256: digest(selected.command), ...(selected.binding ? { ticketFilter: selected.binding.filter, policyCommandSha256: selected.binding.policyCommandSha256 } : {}), exitCode: result.exitCode, outputSha256: digest(`${result.stdout}\n${result.stderr}`) }] });
    }
    async recordPreparedMerge(intentId, prepared) {
        if ((await this.run(intentId)).documentationScope)
            throw new Error("documentation scope requires standalone Merge Prep after task completion");
        const run = await this.run(intentId);
        this.phase(run, "implement");
        if (this.probe)
            this.assertWorktreeBinding(run, await this.probe(run.worktreePath, run.policy), prepared.preMergeHead);
        if (!/^[0-9a-f]{40,64}$/i.test(prepared.preMergeHead) || !/^[0-9a-f]{40,64}$/i.test(prepared.targetOid) || !["ort", "ours"].includes(prepared.strategy))
            throw new Error("prepared merge binding is invalid");
        const existing = run.preparedMerges?.find(value => value.preMergeHead === prepared.preMergeHead);
        if (existing) {
            if (JSON.stringify(existing) === JSON.stringify(prepared))
                return run;
            throw new Error("pre-merge HEAD already has a signed merge authorization");
        }
        return this.update({ ...run, preparedMerges: [...(run.preparedMerges ?? []), prepared], evidence: [...run.evidence, { kind: "merge_prepared", ...prepared }] });
    }
    async discardPreparedMerge(intentId, prepared) {
        const run = await this.run(intentId);
        this.phase(run, "implement");
        const values = run.preparedMerges ?? [], latest = values.at(-1);
        if (!latest || JSON.stringify(latest) !== JSON.stringify(prepared))
            throw new Error("only the latest signed prepared merge can be discarded");
        return this.update({ ...run, preparedMerges: values.slice(0, -1), evidence: [...run.evidence, { kind: "merge_aborted", ...prepared }] });
    }
    async acquireWorktreeMutation(intentId, kind, request) {
        await this.assertFrozenScope(intentId);
        let run = await this.run(intentId);
        this.phase(run, "implement");
        if (run.documentationScope && kind === "merge")
            throw new Error("documentation scope must complete commit and proof before standalone Merge Prep imports upstream code");
        const requestSha256 = digest(JSON.stringify(request)), leaseId = digest(`worktree-mutation\0${run.runId}`);
        if (run.mutationOperation) {
            if (run.mutationOperation.kind !== kind || run.mutationOperation.requestSha256 !== requestSha256)
                throw new Error("another Captain commit operation or worktree mutation is already active for this run");
            await ensureAuthorizedLease(this.dataRoot, leaseId, { intentId, leaseToken: run.mutationOperation.leaseToken, runId: run.runId, operation: "worktree-mutation" });
            if (run.mutationOperation.stage === "authorized") {
                await this.assertWorktreeMutation(intentId, run.mutationOperation);
                return run.mutationOperation;
            }
            const authorized = { ...run.mutationOperation, stage: "authorized" };
            run = await this.update({ ...run, mutationOperation: authorized });
            return authorized;
        }
        let stale;
        try {
            stale = await readAuthorizedLease(this.dataRoot, leaseId);
        }
        catch (error) {
            if (error.code !== "ENOENT")
                throw error;
        }
        if (stale) {
            if (stale.intentId !== intentId || stale.runId !== run.runId || stale.operation !== "worktree-mutation")
                throw new Error("another Captain worktree mutation operation is already active for this run");
            await releaseAuthorizedLease(this.dataRoot, leaseId, stale.intentId, stale.leaseToken);
        }
        const operation = { leaseId, leaseToken: randomUUID(), kind, requestSha256, stage: "reserved" };
        run = await this.update({ ...run, mutationOperation: operation, evidence: [...run.evidence, { kind: "worktree_mutation_reserved", mutationKind: kind, leaseId, requestSha256 }] });
        await ensureAuthorizedLease(this.dataRoot, leaseId, { intentId, leaseToken: operation.leaseToken, runId: run.runId, operation: "worktree-mutation" });
        const latest = await this.run(intentId);
        if (!latest.mutationOperation || latest.mutationOperation.leaseToken !== operation.leaseToken || latest.mutationOperation.stage !== "reserved")
            throw new Error("Captain worktree mutation operation changed during authorization");
        const authorized = { ...operation, stage: "authorized" };
        await this.update({ ...latest, mutationOperation: authorized, evidence: [...latest.evidence, { kind: "worktree_mutation_authorized", mutationKind: kind, leaseId }] });
        return authorized;
    }
    async takeOverPreparedMergeForAbort(intentId, prepared, pinnedMergeStarted = false) {
        const run = await this.run(intentId);
        this.phase(run, "implement");
        const existing = run.mutationOperation, requestSha256 = digest(JSON.stringify({ prepared, action: "abort" }));
        if (!existing)
            return this.acquireWorktreeMutation(intentId, "abort", { prepared, action: "abort" });
        if (existing.kind === "abort" && existing.requestSha256 === requestSha256) {
            await this.assertWorktreeMutation(intentId, existing);
            return existing;
        }
        if (existing.kind !== "merge" || prepared.operationToken !== existing.leaseToken || !run.preparedMerges?.some(value => JSON.stringify(value) === JSON.stringify(prepared)))
            throw new Error("another Captain commit operation or worktree mutation is already active for this run");
        if (!pinnedMergeStarted)
            throw new Error("the signed merge execution still owns the worktree fence; retry the exact prepare request from clean pre-merge state");
        await this.assertWorktreeMutation(intentId, existing);
        const taken = { ...existing, kind: "abort", requestSha256 };
        const updated = await this.update({ ...run, mutationOperation: taken, evidence: [...run.evidence, { kind: "worktree_mutation_taken_over", from: "merge", to: "abort", leaseId: existing.leaseId }] });
        return updated.mutationOperation;
    }
    async assertWorktreeMutation(intentId, operation) { const run = await this.run(intentId); if (!run.mutationOperation || JSON.stringify(run.mutationOperation) !== JSON.stringify(operation) || operation.stage !== "authorized")
        throw new Error("Captain worktree mutation authority changed before Git mutation"); const lease = await readAuthorizedLease(this.dataRoot, operation.leaseId); if (lease.intentId !== intentId || lease.leaseToken !== operation.leaseToken || lease.runId !== run.runId || lease.operation !== "worktree-mutation")
        throw new Error("Captain worktree mutation lease ownership is invalid"); }
    async releaseWorktreeMutation(intentId, operation) { const run = await this.run(intentId); if (!run.mutationOperation) {
        try {
            await releaseAuthorizedLease(this.dataRoot, operation.leaseId, intentId, operation.leaseToken);
        }
        catch { }
        return run;
    } await this.assertWorktreeMutation(intentId, operation); const released = await this.update({ ...run, mutationOperation: undefined, evidence: [...run.evidence, { kind: "worktree_mutation_released", mutationKind: operation.kind, leaseId: operation.leaseId }] }); await releaseAuthorizedLease(this.dataRoot, operation.leaseId, intentId, operation.leaseToken); return released; }
    async assertPreparedMergeAuthority(intentId, prepared, operation, expectedKind = "merge") { const run = await this.run(intentId); if (!run.preparedMerges?.some(value => JSON.stringify(value) === JSON.stringify(prepared)) || (expectedKind === "merge" && prepared.operationToken !== operation.leaseToken) || operation.kind !== expectedKind)
        throw new Error("signed prepared merge authority changed before Git mutation"); await this.assertWorktreeMutation(intentId, operation); }
    async acquireCommitOperation(intentId, request) {
        const operation = await this.reserveCommitOperation(intentId, request), run = await this.run(intentId);
        return this.authorizeCommitOperation(run, operation);
    }
    async reserveCommitOperation(intentId, request) {
        await this.assertFrozenScope(intentId);
        let run = await this.run(intentId);
        this.phase(run, "implement");
        await assertDocumentationScope(run);
        const requestSha256 = commitRequestSha256(request);
        if (run.preparedCommit && !run.commitOperation)
            throw new Error("signed prepared commit has no operation lease ownership");
        if (run.commitOperation) {
            if (run.commitOperation.requestSha256 !== requestSha256)
                throw new Error("another Captain commit operation is already active for this run");
            return run.commitOperation;
        }
        const leaseId = digest(`prepared-commit\0${run.runId}`);
        let stale;
        try {
            stale = await readAuthorizedLease(this.dataRoot, leaseId);
        }
        catch (error) {
            if (error.code !== "ENOENT")
                throw error;
        }
        if (stale) {
            if (stale.intentId !== intentId || stale.runId !== run.runId || stale.operation !== "prepared-commit")
                throw new Error("another Captain commit operation is already active for this run");
            await releaseAuthorizedLease(this.dataRoot, leaseId, stale.intentId, stale.leaseToken);
        }
        const operation = { leaseId, leaseToken: randomUUID(), requestSha256, request, stage: "reserved" };
        run = await this.update({ ...run, commitOperation: operation, evidence: [...run.evidence, { kind: "commit_operation_reserved", leaseId, requestSha256, request }] });
        return run.commitOperation;
    }
    async commitOperationFor(intentId, request) {
        const run = await this.run(intentId);
        this.phase(run, "implement");
        const operation = run.commitOperation;
        if (!operation || operation.stage !== "prepared" || operation.requestSha256 !== commitRequestSha256(request))
            throw new Error("prepared commit recovery requires the exact approved commit request");
        await this.assertCommitOperation(run, operation);
        return operation;
    }
    async assertPreparedCommitAuthority(intentId, prepared, operation) {
        const run = await this.run(intentId);
        this.phase(run, "implement");
        if (!run.preparedCommit || JSON.stringify({ preCommitHead: run.preparedCommit.preCommitHead, candidate: run.preparedCommit.candidate, tree: run.preparedCommit.tree, ...(run.preparedCommit.mergeHead ? { mergeHead: run.preparedCommit.mergeHead } : {}) }) !== JSON.stringify(prepared) || operation.stage !== "prepared")
            throw new Error("signed prepared commit authority changed before Git mutation");
        await this.assertCommitOperation(run, operation);
        await assertDocumentationScope(run, prepared.candidate);
    }
    async discardCommitOperation(intentId, operation) {
        const run = await this.run(intentId);
        this.phase(run, "implement");
        if (run.preparedCommit)
            throw new Error("a signed prepared commit must use prepared recovery");
        await this.assertCommitOperation(run, operation);
        const discarded = await this.update({ ...run, commitOperation: undefined, evidence: [...run.evidence, { kind: "commit_operation_discarded", leaseId: operation.leaseId, requestSha256: operation.requestSha256, ...(operation.request ? { request: operation.request } : {}) }] });
        await releaseAuthorizedLease(this.dataRoot, operation.leaseId, intentId, operation.leaseToken);
        return discarded;
    }
    async recordPreparedCommit(intentId, prepared, operation) {
        const run = await this.run(intentId);
        this.phase(run, "implement");
        if (run.preparedCommit)
            throw new Error("a signed prepared commit is already pending recovery");
        if (operation.stage !== "authorized")
            throw new Error("prepared commit requires an authorized operation lease");
        await this.assertCommitOperation(run, operation);
        if (operation.requestSha256 !== commitRequestSha256(prepared))
            throw new Error("prepared commit does not match its leased approved request");
        if (!/^[0-9a-f]{40,64}$/i.test(prepared.preCommitHead) || !/^[0-9a-f]{40,64}$/i.test(prepared.candidate) || !/^[0-9a-f]{40,64}$/i.test(prepared.tree) || !prepared.paths.length || prepared.subject.includes("\n"))
            throw new Error("prepared commit binding is invalid");
        if (prepared.preCommitHead !== this.expectedHead(run))
            throw new Error("prepared commit does not extend the governed HEAD");
        await assertDocumentationScope(run, prepared.candidate);
        if (this.probe)
            this.assertWorktreeBinding(run, await this.probe(run.worktreePath, run.policy), prepared.preCommitHead);
        return this.update({ ...run, commitOperation: { ...operation, stage: "prepared" }, preparedCommit: prepared, evidence: [...run.evidence, { kind: "commit_prepared", preCommitHead: prepared.preCommitHead, candidate: prepared.candidate, tree: prepared.tree, final: prepared.final, operationLeaseId: operation.leaseId }] });
    }
    async discardPreparedCommit(intentId, candidate) {
        const run = await this.run(intentId);
        this.phase(run, "implement");
        if (!run.preparedCommit || run.preparedCommit.candidate !== candidate)
            throw new Error("signed prepared commit recovery binding does not match");
        const operation = run.commitOperation;
        if (!operation)
            throw new Error("signed prepared commit has no operation lease ownership");
        await this.assertCommitOperation(run, operation);
        const discarded = await this.update({ ...run, commitOperation: undefined, preparedCommit: undefined, evidence: [...run.evidence, { kind: "commit_preparation_discarded", candidate, operationLeaseId: operation.leaseId }] });
        await releaseAuthorizedLease(this.dataRoot, operation.leaseId, intentId, operation.leaseToken);
        return discarded;
    }
    async resumeTarget(resumeIntentId) {
        const intent = await this.load("intents", safeId(resumeIntentId));
        if (!intent.resumeOf)
            throw new Error("resume intent is invalid or consumed");
        const run = await this.run(intent.resumeOf);
        if (!samePath(run.projectRoot, intent.projectRoot))
            throw new Error("unrelated run cannot be resumed");
        await this.assertFrozenScope(run.intentId);
        return run;
    }
    async recoverAdvancedPreparedCommit(intentId, commit, firstParent, candidateVerification) {
        const run = await this.run(intentId), prepared = run.preparedCommit, operation = run.commitOperation;
        if (run.status !== "paused" || run.phase !== "implement" || !prepared || !operation || operation.stage !== "prepared")
            throw new Error("advanced prepared commit recovery requires a paused prepared run");
        await this.assertCommitOperation(run, operation);
        if (candidateVerification.tree !== prepared.tree || candidateVerification.subject !== prepared.subject)
            throw new Error("prepared candidate tree or subject diverged from signed authority");
        if (firstParent.at(-1) !== commit.head || !firstParent.includes(prepared.candidate) || firstParent.indexOf(prepared.candidate) === firstParent.length - 1 || new Set(firstParent).size !== firstParent.length)
            throw new Error("prepared candidate is not retained in the advanced first-parent history");
        if (!commit.phaseCommitsValid || !commit.preparedMergesValid || !commit.previousPhaseRetained || ((!commit.versionChanged || !commit.changelogChanged) && !(commit.bookkeepingOnly && run.policy.commit && bookkeepingCaptured(run.policy.commit) && bookkeepingSubjectAllowed(commit.subject))))
            throw new Error("advanced commit history does not satisfy the signed commit policy");
        if (!this.probe)
            throw new Error("source-state probe is required");
        const current = await this.probe(run.worktreePath, run.policy);
        this.assertWorktreeBinding(run, current);
        if (current.head !== commit.head || current.tree !== commit.tree)
            throw new Error("advanced commit evidence changed during recovery");
        const terminalCommit = { requestSha256: operation.requestSha256, commitLeaseId: operation.leaseId, commitLeaseToken: operation.leaseToken, ...(run.mutationOperation ? { mutationOperation: run.mutationOperation } : {}), candidate: prepared.candidate, outcome: "committed", final: prepared.final, commit };
        await this.update({ ...run, committedState: current, continuityState: undefined, terminalCommit, evidence: [...run.evidence, { kind: "advanced_prepared_commit_recovered", candidate: prepared.candidate, head: commit.head, commitCount: commit.commitCount, firstParent, originalRequestSha256: operation.requestSha256, dirty: current.status !== "" }] });
        return this.finishTerminalCommit(intentId, operation.requestSha256);
    }
    /** Associate only an authenticated standalone Prep candidate, under its existing resource fence. */
    async recordMergeIntegration(intentId, mergeId, mergeRevision, assertAuthority) {
        const run = await this.run(intentId);
        this.phase(run, "implement");
        if (run.status !== "running")
            throw new Error("merge integration requires the active running implementation owner");
        await this.assertSessionLease(run);
        await this.assertFrozenScope(intentId);
        await assertAuthority();
        if (run.preparedCommit || run.commitOperation || run.terminalCommit || run.mutationOperation)
            throw new Error("implementation has an active commit or mutation operation; recover it before merge reconciliation");
        const record = await readAuthorized(this.dataRoot, "merge-revisions", `${safeId(mergeId)}-${mergeRevision}`);
        const watermark = await readAuthorized(this.dataRoot, "merge-watermarks", `${mergeId}-${mergeRevision}`);
        const prepared = record.prepared_commit, pending = record.prepared_merge, request = record.prepared_commit_request;
        if (record.merge_id !== mergeId || record.revision !== mergeRevision || watermark.sha256 !== digest(JSON.stringify(record))
            || !prepared || !pending || !request)
            throw new Error("signed merge candidate authority is incomplete");
        if (run.sessionId !== record.session_id || run.branch !== record.source_binding.branch
            || !samePath(run.worktreePath, record.source_worktree) || !samePath(run.commonGitDir, record.source_binding.commonGitDir)
            || !samePath(run.gitDir, record.source_binding.gitDir))
            throw new Error("merge source session or implementation binding diverged");
        if (digest(JSON.stringify(run.policy.commit)) !== digest(JSON.stringify(record.captured_policy.commit)))
            throw new Error("merge and implementation captured commit policy differ");
        const fence = await readAuthorizedLease(this.dataRoot, digest(`worktree-mutation\0${run.runId}`));
        const operation = await readAuthorizedLease(this.dataRoot, digest(`merge-operation\0${mergeId}`));
        if (fence.intentId !== mergeId || fence.sessionId !== run.sessionId || fence.operation !== "integration-worktree"
            || operation.intentId !== mergeId || operation.sessionId !== run.sessionId || operation.operation !== "integration")
            throw new Error("merge operation or implementation mutation fence ownership changed");
        const { commitEvidence, git } = await import("./workspace.js");
        const current = await this.probe(run.worktreePath, run.policy);
        this.assertWorktreeBinding(run, current, prepared.candidate);
        if (current.status || current.tree !== prepared.tree || prepared.preCommitHead !== pending.preMergeHead
            || prepared.mergeHead !== pending.targetOid || pending.targetOid !== record.target_binding.head
            || record.source_binding.head !== pending.preMergeHead)
            throw new Error("source HEAD, tree or signed integration transition diverged");
        const parents = (await git(["rev-list", "--parents", "-n", "1", prepared.candidate], run.worktreePath)).split(" ");
        if (parents.length !== 3 || parents[1] !== pending.preMergeHead || parents[2] !== pending.targetOid
            || await git(["show", "-s", "--format=%s", prepared.candidate], run.worktreePath) !== request.subject)
            throw new Error("signed integration candidate parent vector or subject diverged");
        const prior = run.evidence.find(value => value.kind === "merge_integration_commit" && value.mergeId === mergeId
            && value.candidate === prepared.candidate);
        if (prior) {
            if (run.committedState?.head !== prepared.candidate || current.tree !== run.committedState.tree)
                throw new Error("recorded integration no longer matches the implementation phase");
            return run;
        }
        if (!run.committedState || run.committedState.head !== pending.preMergeHead
            || run.continuityState && run.continuityState.head !== pending.preMergeHead && run.continuityState.head !== prepared.candidate)
            throw new Error("signed merge does not extend the preceding implementation phase head");
        const preparedMerges = [...(run.preparedMerges ?? []), pending];
        const commit = await commitEvidence(run.worktreePath, run.baseHead, run.policy, run.taskId, preparedMerges, run.committedState.head);
        if (!commit.clean || commit.head !== prepared.candidate || commit.tree !== prepared.tree || !commit.phaseCommitsValid
            || !commit.preparedMergesValid || !commit.previousPhaseRetained || !commit.taskTrailerValid || !commit.versionSurfacesValid
            || !commit.versionChanged || !commit.changelogChanged)
            throw new Error("signed merge commit does not satisfy captured implementation phase policy");
        await assertAuthority();
        await this.assertSessionLease(run);
        const latest = await this.run(intentId);
        if (latest.revision !== run.revision)
            throw new Error("implementation changed during merge reconciliation");
        const finalState = await this.probe(run.worktreePath, run.policy);
        this.assertWorktreeBinding(run, finalState, prepared.candidate);
        if (digest(JSON.stringify(current)) !== digest(JSON.stringify(finalState)))
            throw new Error("merge source changed during reconciliation");
        return this.update({ ...run, committedState: finalState, continuityState: undefined, preparedMerges,
            evidence: [...run.evidence, { kind: "phase_commit", final: false, ...commit, integrationMergeId: mergeId },
                { kind: "merge_integration_commit", mergeId, mergeRevision, mergeRevisionSha256: watermark.sha256,
                    candidate: prepared.candidate, preMergeHead: pending.preMergeHead, tree: prepared.tree, proofRecorded: false }] });
    }
    async recordCommit(intentId, commit, final = true) {
        return this.recordCommitCore(intentId, commit, final);
    }
    async reconcileAuthorizedCommit(intentId, request, commit) {
        await this.assertFrozenScope(intentId);
        const run = await this.run(intentId);
        this.phase(run, "implement");
        if (run.status !== "running" || !run.taskId)
            throw new Error("authorized commit reconciliation requires the active task run");
        if (run.targetBranch && run.targetBranch !== run.branch)
            throw new Error("unprepared commits on a separate merge target cannot be reconciled");
        if (run.preparedCommit || run.commitOperation)
            throw new Error("a pending signed commit operation must use prepared recovery");
        if (!request.final)
            throw new Error("authorized commit reconciliation only accepts a final task commit");
        const expectedHead = run.committedState?.head ?? run.baseHead, requestSha256 = commitRequestSha256(request);
        if (!commit.clean || commit.commitCount !== 1 || commit.firstParent !== expectedHead || commit.subject !== request.subject || !commit.taskTrailerPresent)
            throw new Error("reconciliation requires the exact clean, single-parent task commit");
        const safePaths = (values) => values.length > 0 && new Set(values).size === values.length && values.every(value => typeof value === "string" && value.length > 0 && !value.startsWith("/") && !/^[A-Za-z]:/.test(value) && !value.includes("\\") && !value.split("/").some(part => !part || part === "." || part === ".."));
        if (!safePaths(request.paths) || !commit.changedPaths || !safePaths(commit.changedPaths) || JSON.stringify([...request.paths].sort()) !== JSON.stringify([...commit.changedPaths].sort()))
            throw new Error("reconciliation paths must exactly match the authorized selection and committed tree");
        const requests = await this.userRequests({ projectRoot: run.projectRoot, intentId: run.intentId });
        const authorized = requests.status === "expressed" && requests.receipts.some(receipt => receipt.decision === "expressed" && receipt.basis === "direct_instruction" && receipt.sessionId === run.sessionId && samePath(receipt.projectRoot, run.projectRoot) && receipt.intentId === run.intentId && receipt.taskId === run.taskId && (!run.targetBranch || receipt.targetBranch === run.targetBranch));
        if (!authorized)
            throw new Error("reconciliation requires the expressed user request for this repository, task, run, and session");
        let operation;
        let discardedOperation;
        for (const event of run.evidence) {
            if (event.kind === "commit_operation_reserved")
                operation = { leaseId: String(event.leaseId), requestSha256: String(event.requestSha256), request: event.request, authorized: false, prepared: false };
            else if (event.kind === "commit_operation_authorized" && operation && event.leaseId === operation.leaseId)
                operation.authorized = true;
            else if (event.kind === "commit_prepared" && operation && event.operationLeaseId === operation.leaseId)
                operation.prepared = true;
            else if (event.kind === "commit_operation_discarded" && operation && event.leaseId === operation.leaseId) {
                if (operation.authorized && !operation.prepared && operation.requestSha256 === requestSha256 && (!event.requestSha256 || event.requestSha256 === requestSha256) && (!operation.request || commitRequestSha256(operation.request) === requestSha256))
                    discardedOperation = { leaseId: operation.leaseId, requestSha256 };
                operation = undefined;
            }
        }
        if (!discardedOperation)
            throw new Error("no matching signed failed commit operation exists for this exact request");
        return this.recordCommitCore(intentId, commit, request.final, true, { ...discardedOperation, paths: request.paths, subject: request.subject, sessionId: run.sessionId, taskId: run.taskId, branch: run.branch, worktreePath: run.worktreePath });
    }
    async recordCommitCore(intentId, commit, final = true, authorizedRecovery = false, recoveryAudit) {
        await this.assertFrozenScope(intentId);
        const run = await this.run(intentId);
        this.phase(run, "implement");
        await assertDocumentationScope(run, commit.head);
        const operation = run.commitOperation;
        if (run.targetBranch && (!run.preparedCommit || !operation) && !authorizedRecovery)
            throw new Error("governed target commits require signed prepared operation ownership");
        if (run.preparedCommit && !operation)
            throw new Error("signed prepared commit has no operation lease ownership");
        if (operation) {
            if (!run.preparedCommit || operation.stage !== "prepared")
                throw new Error("commit operation cannot finalize before signed candidate authorization");
            await this.assertCommitOperation(run, operation);
        }
        if (!commit.clean || commit.commitCount < 1 || !/^[0-9a-f]{40,64}$/i.test(commit.head) || commit.head === run.baseHead)
            throw new Error("commit gate requires at least one clean atomic phase commit after base");
        const bookkeeping = commit.bookkeepingOnly === true && Boolean(run.policy.commit && bookkeepingCaptured(run.policy.commit)) && bookkeepingSubjectAllowed(commit.subject);
        if (commit.bookkeepingOnly && !bookkeeping)
            throw new Error("bookkeeping commit requires captured trusted rules and a versionless Captain subject");
        const conventional = /^(feat|fix|refactor|perf|test|docs|build|ci|chore)(\([^)]+\))?!?: .+/.test(commit.subject);
        if ((run.policy.commit?.conventional ?? true) && !conventional)
            throw new Error("commit must use a Conventional Commit subject");
        if (!bookkeeping && (run.policy.commit?.require_version_suffix ?? true) && !subjectVersion(commit.subject))
            throw new Error("commit must include a strict SemVer suffix");
        if (!bookkeeping && (!commit.versionChanged || !commit.changelogChanged))
            throw new Error("commit must update the configured version file and changelog");
        if (run.policy.commit?.require_task_trailer && !commit.taskTrailerValid)
            throw new Error("commit must include a configured task trailer");
        if (!bookkeeping && run.policy.commit?.version_surfaces?.length && !commit.versionSurfacesValid)
            throw new Error("commit version surfaces must match the subject SemVer suffix");
        if (!commit.preparedMergesValid)
            throw new Error("commit parent vector does not match signed prepared merge state");
        if (!commit.phaseCommitsValid)
            throw new Error("every first-parent repair phase commit must independently satisfy repository commit policy");
        if (run.committedState && (commit.previousPhaseHead !== run.committedState.head || !commit.previousPhaseRetained || commit.commitCount <= Number(run.evidence.filter(value => value.kind === "phase_commit" || value.kind === "commit").at(-1)?.commitCount ?? 0)))
            throw new Error("each atomic commit must extend the preceding phase commit without replacing history");
        if (!commit.tree || !/^[0-9a-f]{40,64}$/i.test(commit.tree))
            throw new Error("commit tree must be captured");
        if (!this.probe)
            throw new Error("source-state probe is required");
        const committedState = await this.probe(run.worktreePath, run.policy);
        this.assertWorktreeBinding(run, committedState, commit.head);
        if (committedState.head !== commit.head || committedState.tree !== commit.tree || committedState.status !== "")
            throw new Error("commit evidence no longer matches the clean probed commit");
        if (run.preparedCommit && (run.preparedCommit.candidate !== commit.head || run.preparedCommit.subject !== commit.subject || run.preparedCommit.final !== final))
            throw new Error("commit evidence does not match the signed prepared candidate");
        const next = { ...run, continuityState: undefined, phase: final ? "prove" : "implement", committedState, evidence: [...run.evidence, ...(recoveryAudit ? [{ kind: "authorized_commit_reconciled", ...recoveryAudit, head: commit.head, tree: commit.tree }] : []), { kind: final ? "commit" : "phase_commit", final, ...commit, ...(operation ? { operationLeaseId: operation.leaseId } : {}) }] };
        if (!operation || !run.preparedCommit)
            return this.update({ ...next, commitOperation: undefined, preparedCommit: undefined });
        const terminalCommit = { requestSha256: operation.requestSha256, commitLeaseId: operation.leaseId, commitLeaseToken: operation.leaseToken, ...(run.mutationOperation ? { mutationOperation: run.mutationOperation } : {}), candidate: run.preparedCommit.candidate, outcome: "committed", final, commit };
        const terminal = await this.update({ ...next, terminalCommit });
        await this.hooks?.afterTerminalCommit?.(terminal);
        return this.finishTerminalCommit(intentId, operation.requestSha256);
    }
    async completedCommitFor(intentId, request) {
        const requestSha256 = commitRequestSha256(request), run = await this.run(intentId);
        if (run.terminalCommit) {
            if (run.terminalCommit.requestSha256 !== requestSha256)
                throw new Error("terminal commit recovery requires the exact approved commit request");
            return this.finishTerminalCommit(intentId, requestSha256);
        }
        try {
            const outcome = await this.load("commit-outcomes", `${intentId}-${requestSha256}`);
            if (outcome.intentId !== intentId || outcome.runId !== run.runId || outcome.requestSha256 !== requestSha256 || outcome.outcome !== "committed")
                throw new Error("signed terminal commit outcome is invalid");
            return run;
        }
        catch (error) {
            if (error.code === "ENOENT")
                return undefined;
            throw error;
        }
    }
    async finishTerminalCommit(intentId, requestSha256) {
        let run = await this.run(intentId), terminal = run.terminalCommit;
        if (!terminal) {
            const outcome = await this.load("commit-outcomes", `${intentId}-${requestSha256}`);
            if (outcome.intentId !== intentId || outcome.requestSha256 !== requestSha256)
                throw new Error("signed terminal commit outcome is invalid");
            return run;
        }
        if (terminal.requestSha256 !== requestSha256)
            throw new Error("terminal commit recovery requires the exact approved commit request");
        await putAuthorizedOnceExact(this.dataRoot, "commit-outcomes", `${intentId}-${requestSha256}`, { schemaVersion: 1, intentId, runId: run.runId, requestSha256, candidate: terminal.candidate, outcome: terminal.outcome, final: terminal.final, commit: terminal.commit });
        await releaseAuthorizedLease(this.dataRoot, terminal.commitLeaseId, intentId, terminal.commitLeaseToken);
        if (terminal.mutationOperation)
            await releaseAuthorizedLease(this.dataRoot, terminal.mutationOperation.leaseId, intentId, terminal.mutationOperation.leaseToken);
        run = await this.run(intentId);
        if (!run.terminalCommit)
            return run;
        if (run.terminalCommit.requestSha256 !== requestSha256)
            throw new Error("terminal commit authority changed during finalization");
        return this.update({ ...run, commitOperation: undefined, preparedCommit: undefined, mutationOperation: undefined, terminalCommit: undefined, evidence: [...run.evidence, { kind: "commit_operation_finalized", requestSha256, candidate: terminal.candidate }] });
    }
    async runCheck(intentId, scope, ticketFilter) {
        await this.assertFrozenScope(intentId);
        const run = await this.run(intentId);
        this.phase(run, "implement");
        if (run.preparedCommit)
            throw new Error("prepared commit recovery must complete before iteration checks");
        await assertDocumentationScope(run);
        const command = run.policy.commands[scope];
        if (!command || !["ticket", "feature-smoke", "affected-regression"].includes(scope))
            throw new Error("iteration check must be a trusted implementation scope");
        const selected = taskTicketCommand(run, scope, ticketFilter);
        if (this.probe)
            this.assertWorktreeBinding(run, await this.probe(run.worktreePath, run.policy), this.expectedHead(run));
        await prepareScopeOutputs(run.worktreePath, run.policy, scope);
        const result = await this.runner(selected.command, run.worktreePath);
        if (this.probe)
            this.assertWorktreeBinding(run, await this.probe(run.worktreePath, run.policy), this.expectedHead(run));
        await assertDocumentationScope(run);
        return this.update({ ...run, ...(selected.binding && (run.taskTicket || result.exitCode === 0) ? { taskTicket: selected.binding } : {}), evidence: [...run.evidence, { kind: "iteration", scope, commandSha256: digest(selected.command), ...(selected.binding ? { ticketFilter: selected.binding.filter, policyCommandSha256: selected.binding.policyCommandSha256 } : {}), exitCode: result.exitCode }] });
    }
    async prove(intentId) {
        await this.assertFrozenScope(intentId);
        const current = await this.run(intentId);
        if (isPendingPlanReview(current)) {
            if (!this.probe || !current.committedState)
                throw new Error("HITL requires recorded source proof");
            await this.assertCommitted(current);
            return current;
        }
        if (current.phase === "complete" && current.status === "green")
            return this.finalizeCompletion(intentId);
        const repairFence = current.phase === "prove" ? await this.proofSourceRepairFence(current) : undefined;
        try {
            return await this.proveAttempt(intentId, repairFence);
        }
        catch (error) {
            if (error instanceof ProofSourceDivergenceError) {
                const latest = await this.run(intentId), expected = error.fence;
                if (latest.phase !== "prove" || latest.status !== "running" || latest.runId !== expected.runId ||
                    latest.revision !== expected.runRevision || digest(JSON.stringify(latest.committedState)) !== expected.committedStateSha256 ||
                    (latest.activationToken ?? latest.operationToken) !== expected.activationToken)
                    throw new Error("Captain run changed concurrently; source repair was not authorized", { cause: error });
                const actual = await this.proofSourceRepairFence(latest);
                if (JSON.stringify(actual) !== JSON.stringify(expected))
                    throw new Error("Captain source repair lease generation or activation changed", { cause: error });
                await this.update({ ...latest, phase: "implement", status: "red", evidence: [...latest.evidence,
                        { kind: "proof_error", messageSha256: digest(error.message), repairRequired: true, head: latest.committedState.head }] });
                throw new Error(`${error.message}; run returned to implement for repair`, { cause: error });
            }
            const latest = await this.run(intentId);
            if (latest.phase === "prove")
                await this.update({ ...latest, evidence: [...latest.evidence,
                        { kind: "proof_error", messageSha256: digest(String(error.message)) }] });
            throw error;
        }
    }
    async proveAttempt(intentId, repairFence) {
        const run = await this.run(intentId);
        this.phase(run, "prove");
        if (!this.probe || !run.committedState)
            throw new Error("source-state probe is required");
        await this.assertCommitted(run, repairFence);
        const scopes = proofScopes(run);
        for (const scope of scopes)
            if (!run.policy.commands[scope])
                throw new Error(`${scope} proof command is required`);
        const bindings = { build: "build", "feature-smoke": "smoke", visual: "visual" }, before = {};
        for (const [scope, role] of Object.entries(bindings))
            if (scopes.includes(scope)) {
                const relative = run.policy.artifactPaths?.[role];
                if (!relative)
                    throw new Error(`${role} artifact is required by trusted policy`);
                before[role] = await optionalHash(run.worktreePath, relative);
            }
        const proof = [];
        const artifacts = {};
        for (const scope of scopes) {
            const command = run.policy.commands[scope];
            await prepareScopeOutputs(run.worktreePath, run.policy, scope);
            const result = await this.runner(command, run.worktreePath);
            proof.push({ scope, commandSha256: digest(command), exitCode: result.exitCode });
            if (result.exitCode !== 0) {
                await this.update({ ...run, phase: "implement", status: "red", evidence: [...run.evidence, ...proof] });
                throw new Error(`${scope} proof failed; run returned to implement for repair`);
            }
            await this.assertCommitted(run, repairFence);
            const role = bindings[scope];
            if (role) {
                const relative = run.policy.artifactPaths[role];
                const absolute = await safeArtifact(run.worktreePath, relative);
                const after = await hashPath(absolute);
                if (role === "visual")
                    await assertImage(absolute);
                artifacts[role] = { path: relative, sha256: after, priorSha256: before[role], producedBy: scope };
            }
        }
        for (const [role, item] of Object.entries(artifacts)) {
            const finalHash = await hashPath(await safeArtifact(run.worktreePath, item.path));
            if (finalHash !== item.sha256)
                throw new Error(`${role} artifact changed after its producing proof command`);
        }
        const awaitsReview = Boolean(run.policy.hitlChecks?.length);
        const completed = await this.update({ ...run, phase: awaitsReview ? "hitl" : "complete", status: awaitsReview ? "running" : "green", evidence: [...run.evidence, ...proof, { kind: "artifacts", artifacts }, { kind: "proof_passed", head: run.committedState.head, tree: run.committedState.tree }] });
        if (awaitsReview)
            return completed;
        await this.hooks?.afterRunCompleted?.(completed);
        return this.finalizeCompletion(intentId);
    }
    isFrozenPlan(run, relative) { return (run.policy.approvedPlans ?? []).some(plan => plan.path.toLowerCase() === relative.replaceAll("\\", "/").toLowerCase()); }
    async assertFrozenScope(intentId) {
        const run = await this.run(intentId);
        for (const plan of run.policy.approvedPlans ?? []) {
            try {
                const file = await safeArtifact(run.worktreePath, plan.path);
                if (approvedPlanDigest(await readFile(file, "utf8")) !== plan.sha256)
                    throw new Error("content changed");
            }
            catch (error) {
                throw new Error(`frozen approved plan changed or is unavailable: ${plan.path}; restore the approved plan and keep progress and human closeout followups separate (${error.message})`);
            }
        }
    }
    async recordPlanReview(intentId, input) {
        const run = await this.run(intentId);
        if (!run.policy.hitlChecks?.length)
            throw new Error("plan review requires declared HITL checks frozen at begin");
        if (!["accept", "needs_changes"].includes(input.decision) || typeof input.humanFeedback !== "string" || !input.humanFeedback.trim() || input.humanFeedback.length > 12000)
            throw new Error("plan review requires a valid decision and actual human feedback");
        const lastReview = run.evidence.filter(item => item.kind === "plan_review").at(-1);
        if (run.phase === "complete" && run.status === "green" && lastReview?.decision === "accept" && input.decision === "accept" && lastReview.humanFeedback === input.humanFeedback.trim())
            return this.finalizeCompletion(intentId);
        if (run.phase !== "hitl")
            throw new Error("plan review requires green proof and the active HITL phase; resume legacy pending review first");
        await this.assertSessionLease(run);
        if (run.status === "paused")
            throw new Error("resume the paused HITL before recording its decision");
        await this.assertFrozenScope(intentId);
        if (!this.probe || !run.committedState)
            throw new Error("HITL requires recorded source proof");
        if (input.decision === "accept")
            await this.assertCommitted(run);
        else
            this.assertWorktreeBinding(run, await this.probe(run.worktreePath, run.policy), this.expectedHead(run));
        const review = { kind: "plan_review", decision: input.decision, humanFeedback: input.humanFeedback.trim(), recordedAt: new Date().toISOString(), proofHead: run.committedState.head, checkIds: run.policy.hitlChecks.map(check => check.id) };
        if (input.decision === "needs_changes")
            return this.update({ ...run, phase: "implement", status: "red", evidence: [...run.evidence, { ...review, nextAction: "Repair the unmet original criteria in this same run and worktree, then repeat their proof and declared HITL. New requirements remain separate human followups." }] });
        const completed = await this.update({ ...run, phase: "complete", status: "green", evidence: [...run.evidence, review] });
        await this.hooks?.afterRunCompleted?.(completed);
        return this.finalizeCompletion(intentId);
    }
    async recordHitlFeedback(intentId, input) {
        const run = await this.run(intentId);
        if (run.status === "paused")
            throw new Error("resume the paused run before recording HITL feedback");
        await this.assertSessionLease(run);
        await this.assertFrozenScope(intentId);
        if (!run.policy.hitlChecks?.length || !Array.isArray(input.checkIds) || !input.checkIds.length || new Set(input.checkIds).size !== input.checkIds.length || input.checkIds.some(id => !run.policy.hitlChecks.some(check => check.id === id)))
            throw new Error("feedback must reference declared HITL checks frozen at begin");
        if (!["accept", "needs_changes"].includes(input.decision) || typeof input.humanFeedback !== "string" || !input.humanFeedback.trim() || input.humanFeedback.length > 12000 || !Array.isArray(input.evidenceReferences) || input.evidenceReferences.length > 50 || input.evidenceReferences.some(value => typeof value !== "string" || !value.trim() || value.length > 2000) || (input.reviewedRevision !== undefined && !/^[0-9a-f]{40,64}$/i.test(input.reviewedRevision)))
            throw new Error("HITL feedback requires actual human feedback and valid evidence references");
        if (!this.probe)
            throw new Error("HITL feedback requires a source-state probe");
        const recordedSource = await this.probe(run.worktreePath, run.policy);
        this.assertWorktreeBinding(run, recordedSource, this.expectedHead(run));
        const normalized = { decision: input.decision, humanFeedback: input.humanFeedback.trim(), checkIds: [...input.checkIds].sort(), evidenceReferences: input.evidenceReferences.map(value => value.trim()), ...(input.reviewedRevision ? { reviewedRevision: input.reviewedRevision } : {}) };
        const prior = run.evidence.filter(item => item.kind === "hitl_feedback").at(-1);
        if (prior && JSON.stringify({ decision: prior.decision, humanFeedback: prior.humanFeedback, checkIds: prior.checkIds, evidenceReferences: prior.evidenceReferences, ...(prior.reviewedRevision ? { reviewedRevision: prior.reviewedRevision } : {}) }) === JSON.stringify(normalized))
            return run;
        const review = { ...normalized, kind: "hitl_feedback", recordedAt: new Date().toISOString(), recordedSource };
        return this.update({ ...run, evidence: [...run.evidence, review] });
    }
    async status(intentId) {
        const run = await this.run(intentId);
        await this.reconcileRunProjections(run);
        let lookupRoot = run.projectRoot;
        if (run.phase === "complete" && run.status === "green") {
            let missing = false;
            try {
                await lstat(run.projectRoot);
            }
            catch (error) {
                if (error.code !== "ENOENT")
                    throw error;
                missing = true;
            }
            if (missing) {
                const { readWorktreeRegistration } = await import("./worktree-storage.js"), registration = await readWorktreeRegistration(this.dataRoot, run.commonGitDir, run.worktreePath);
                if (registration) {
                    if (!samePath(registration.worktree_path, run.worktreePath) || !samePath(registration.common_git_dir, run.commonGitDir) || !samePath(registration.git_dir, run.gitDir) || registration.branch !== run.branch)
                        throw new Error("terminal worktree registration differs from its signed run");
                    lookupRoot = await (await import("./workspace.js")).primaryRepositoryRoot(registration.project_root, run.commonGitDir);
                    if (!samePath(lookupRoot, registration.project_root))
                        throw new Error("terminal worktree registration primary root diverged");
                }
            }
        }
        return { ...run, user_request: await this.userRequests({ projectRoot: lookupRoot, intentId: run.intentId }) };
    }
    async acquireTargetLease(intentId, commonGitDir, targetBranch, targetOid) { const leaseId = digest(`${path.resolve(commonGitDir)}\0refs/heads/${targetBranch}`.toLowerCase()), leaseToken = randomUUID(), payload = { intentId, leaseToken, commonGitDir: path.resolve(commonGitDir), targetBranch, targetOid }; try {
        await acquireAuthorizedLease(this.dataRoot, leaseId, payload);
        return { leaseId, leaseToken };
    }
    catch (error) {
        if (!String(error.message).includes("already leased"))
            throw error;
        const lease = await readAuthorizedLease(this.dataRoot, leaseId);
        let prior;
        try {
            prior = await this.run(lease.intentId);
        }
        catch {
            throw error;
        }
        if (prior.phase !== "complete" || prior.status !== "green")
            throw error;
        await this.releaseTargetLease(leaseId, lease.intentId, lease.leaseToken);
        await acquireAuthorizedLease(this.dataRoot, leaseId, payload);
        return { leaseId, leaseToken };
    } }
    safePlanPath(run, relative) { const normalized = relative.replaceAll("\\", "/"); if (!normalized.endsWith(".md") || normalized.startsWith("/") || normalized.split("/").some(part => !part || part === "." || part === ".."))
        throw new Error(`unsafe plan path: ${relative}`); const file = path.resolve(run.worktreePath, normalized), inside = path.relative(run.worktreePath, file); if (inside.startsWith("..") || path.isAbsolute(inside))
        throw new Error(`plan path escapes owned worktree: ${relative}`); return normalized; }
    async projectPlanState(run, relative, state) { if (this.isFrozenPlan(run, relative))
        return false; const normalized = this.safePlanPath(run, relative), file = path.resolve(run.worktreePath, normalized), original = await readFile(file, "utf8"), match = /<!-- captain:work-state(\r?\n)[\s\S]*?-->/.exec(original); if (!match)
        return false; const line = match[1], single = (value) => value.replace(/[\r\n]+/g, " ").trim(), block = `<!-- captain:work-state${line}status: ${state.status}${line}phase: ${single(state.phase)}${line}updated: ${new Date().toISOString()}${line}handoff: ${single(state.handoff)}${line}blocker: ${single(state.blocker)}${line}next: ${JSON.stringify(state.next.map(single))}${line}-->`; await writeFile(file, `${original.slice(0, match.index)}${block}${original.slice(match.index + match[0].length)}`, "utf8"); return true; }
    async releaseTargetLease(leaseId, intentId, leaseToken) { await releaseAuthorizedLease(this.dataRoot, leaseId, intentId, leaseToken); }
    async permitFor(sessionId, turnId) { try {
        const permit = await this.load("permits", `${sessionId}-${turnId}`), run = await this.run(permit.intentId), active = await this.load("active", sessionId), activationToken = run.activationToken ?? run.operationToken, activated = await this.load(activationToken === run.operationToken ? "begin-activated" : "resume-activated", activationToken);
        if (run.status === "green" || run.sessionId !== sessionId || run.turnId !== turnId || run.revision !== permit.runRevision || run.operationToken !== permit.operationToken || permit.activationToken !== activationToken || active.operationToken !== activationToken || activated.operationToken !== activationToken)
            return null;
        await this.assertSessionLease(run);
        return permit;
    }
    catch {
        return null;
    } }
    permit(run) { return { schemaVersion: 1, sessionId: run.sessionId, turnId: run.turnId, worktreePath: run.worktreePath, phase: run.phase, intentId: run.intentId, runId: run.runId, runRevision: run.revision, operationToken: run.operationToken, activationToken: run.activationToken ?? run.operationToken, sessionLeaseId: run.sessionLeaseId, sessionLeaseToken: run.sessionLeaseToken, frozenPlanPaths: run.policy.approvedPlans?.map(plan => plan.path) ?? [], activated: true }; }
    phase(run, expected) { if (run.phase !== expected)
        throw new Error(`expected ${expected} phase, found ${run.phase}`); }
    async run(id) { const safe = safeId(id), prefix = `${safe}-`; let names = []; try {
        names = await readdir(path.join(this.dataRoot, "run-revisions"));
    }
    catch (error) {
        if (error.code !== "ENOENT")
            throw error;
    } const revisions = names.map(name => new RegExp(`^${prefix}([0-9]+)\\.json$`).exec(name)).filter((match) => Boolean(match)).map(match => Number(match[1])).sort((a, b) => a - b); if (!revisions.length) {
        const legacy = await this.load("runs", safe), normalized = { ...legacy, revision: legacy.revision ?? 0 };
        if (normalized.schemaVersion !== 1 || normalized.documentationScope)
            throw new Error("legacy run cannot inject documentation schema without its audited revision chain");
        await putAuthorizedOnceExact(this.dataRoot, "run-revisions", `${safe}-0`, normalized);
        await this.writeRunWatermark(normalized);
        return normalized;
    } for (let index = 0; index < revisions.length; index++)
        if (revisions[index] !== index)
            throw new Error("signed run revision sequence is not contiguous"); let latest, previous; for (const revision of revisions) {
        latest = await this.load("run-revisions", `${safe}-${revision}`);
        if (revision === 0 && (latest.schemaVersion !== 1 || latest.documentationScope))
            throw new Error("initial signed run must use the ordinary schema before documentation classification");
        if (latest.intentId !== id || latest.revision !== revision || (revision === 0 ? latest.previousRevisionSha256 !== undefined : latest.previousRevisionSha256 !== digest(JSON.stringify(previous))))
            throw new Error("signed run revision binding is invalid");
        if (previous)
            this.assertStableRun(previous, latest);
        await this.writeRunWatermark(latest);
        previous = latest;
    } let watermarkNames = []; try {
        watermarkNames = await readdir(path.join(this.dataRoot, "run-watermarks"));
    }
    catch (error) {
        if (error.code !== "ENOENT")
            throw error;
    } const watermarks = watermarkNames.map(name => new RegExp(`^${prefix}([0-9]+)\\.json$`).exec(name)).filter((match) => Boolean(match)).map(match => Number(match[1])); if (watermarks.some(revision => revision > latest.revision))
        throw new Error("signed run revision tail regressed behind its monotonic watermark"); return latest; }
    async update(run) { const current = await this.run(run.intentId); if (current.revision !== run.revision || current.runId !== run.runId)
        throw new Error("Captain run changed concurrently; retry from authoritative status"); const { user_request: _context, ...persistedRun } = run; const next = { ...persistedRun, revision: current.revision + 1, previousRevisionSha256: digest(JSON.stringify(current)) }; const stored = await putAuthorizedOnceExact(this.dataRoot, "run-revisions", `${run.intentId}-${next.revision}`, next); await this.writeRunWatermark(stored); await this.hooks?.afterRunRevision?.(stored); await this.reconcileRunProjections(await this.run(run.intentId)); return stored; }
    async writeRunWatermark(run) { await putAuthorizedOnceExact(this.dataRoot, "run-watermarks", `${run.intentId}-${run.revision}`, { schemaVersion: 1, intentId: run.intentId, runId: run.runId, revision: run.revision, runSha256: digest(JSON.stringify(run)), previousRevisionSha256: run.previousRevisionSha256 }); }
    async reconcileRunProjections(run) { const latest = await this.run(run.intentId); await this.project("runs", latest.intentId, latest); if (latest.status !== "green" && latest.status !== "paused" && latest.sessionLeaseId && latest.sessionLeaseToken)
        try {
            const activated = await this.load("begin-activated", latest.operationToken);
            if (activated.operationToken === latest.operationToken) {
                await this.assertSessionLease(latest);
                await this.project("permits", `${latest.sessionId}-${latest.turnId}`, this.permit(latest));
            }
        }
        catch (error) {
            if (error.code !== "ENOENT" && !String(error.message).includes("not held"))
                throw error;
        } }
    assertStableRun(previous, current) {
        const scope = current.documentationScope;
        const documentationMigration = previous.schemaVersion === 1 && current.schemaVersion === 2
            && previous.phase === "tdd_red" && current.phase === "implement"
            && previous.status === "running" && current.status === "running"
            && !previous.documentationScope && scope?.schemaVersion === 1
            && scope.expectedHead === this.expectedHead(previous)
            && scope.policySha256 === digest(JSON.stringify(previous.policy))
            && scope.sessionId === previous.sessionId && scope.turnId === previous.turnId
            && current.sessionId === previous.sessionId && current.turnId === previous.turnId
            && current.activationToken === previous.activationToken
            && current.sessionLeaseId === previous.sessionLeaseId && current.sessionLeaseToken === previous.sessionLeaseToken
            && current.evidence.length === previous.evidence.length + 1
            && JSON.stringify(current.evidence.slice(0, -1)) === JSON.stringify(previous.evidence)
            && JSON.stringify(current.evidence.at(-1)) === JSON.stringify({ kind: "documentation_scope", ...scope });
        // Version 2 fences older runtimes: their immutable-schema guard rejects this
        // transition before they can commit without understanding documentation scope.
        if (![1, 2].includes(current.schemaVersion) || (current.schemaVersion === 2) !== Boolean(scope)
            || (previous.schemaVersion !== current.schemaVersion && !documentationMigration))
            throw new Error("signed run documentation schema transition is invalid");
        const stable = (run) => ({ runId: run.runId, operationToken: run.operationToken, intentId: run.intentId,
            taskId: run.taskId, objective: run.objective, projectRoot: path.resolve(run.projectRoot), worktreePath: path.resolve(run.worktreePath),
            baseHead: run.baseHead, branch: run.branch, targetBranch: run.targetBranch, commonGitDir: path.resolve(run.commonGitDir),
            gitDir: path.resolve(run.gitDir), profile: run.profile, visualRequired: run.visualRequired, startedAt: run.startedAt, policy: run.policy });
        if (JSON.stringify(stable(previous)) !== JSON.stringify(stable(current)))
            throw new Error("signed run immutable binding changed across revisions");
        if (previous.documentationScope !== undefined && JSON.stringify(previous.documentationScope) !== JSON.stringify(current.documentationScope))
            throw new Error("signed run immutable documentation scope changed across revisions");
        if (previous.taskTicket !== undefined && JSON.stringify(previous.taskTicket) !== JSON.stringify(current.taskTicket))
            throw new Error("signed run immutable task ticket binding changed across revisions");
    }
    async project(bucket, id, value) { let failure; for (let attempt = 0; attempt < 3; attempt++)
        try {
            await this.save(bucket, id, value);
            return;
        }
        catch (error) {
            failure = error;
            try {
                if (JSON.stringify(await this.load(bucket, id)) === JSON.stringify(value))
                    return;
            }
            catch { }
        } throw failure; }
    async assertBeginOperation(operation) { await this.assertBeginNotCancelled(operation.intentId); const signed = await this.beginOperationFor(operation.intentId); if (JSON.stringify(signed) !== JSON.stringify(operation))
        throw new Error("signed begin operation ownership diverged"); }
    assertBeginReservation(operation, intent, input) { if (operation.schemaVersion !== 1 || operation.intentId !== input.intentId || operation.intentId !== intent.intentId || operation.sessionId !== intent.sessionId || operation.turnId !== intent.turnId || !samePath(operation.projectRoot, input.projectRoot) || !samePath(operation.projectRoot, intent.projectRoot) || operation.objective !== input.objective || operation.taskId !== input.taskId || operation.targetBranch !== intent.targetBranch || operation.targetOid !== intent.targetOid || (input.leaseToken && operation.leaseToken !== input.leaseToken))
        throw new Error("retry does not match the signed begin reservation"); }
    async authorizeCommitOperation(run, operation) { const payload = { intentId: run.intentId, leaseToken: operation.leaseToken, runId: run.runId, requestSha256: operation.requestSha256, operation: "prepared-commit" }; await ensureAuthorizedLease(this.dataRoot, operation.leaseId, payload); if (operation.stage === "authorized") {
        await this.assertCommitOperation(run, operation);
        return operation;
    } if (operation.stage !== "reserved")
        throw new Error("prepared commit recovery must complete before a new commit operation"); const latest = await this.run(run.intentId); if (!latest.commitOperation || latest.commitOperation.leaseToken !== operation.leaseToken || latest.commitOperation.stage !== "reserved")
        throw new Error("Captain commit operation changed during lease authorization"); const authorized = { ...operation, stage: "authorized" }, updated = await this.update({ ...latest, commitOperation: authorized, evidence: [...latest.evidence, { kind: "commit_operation_authorized", leaseId: operation.leaseId, requestSha256: operation.requestSha256 }] }); return updated.commitOperation; }
    async proofSourceRepairFence(run) {
        const activationToken = run.activationToken ?? run.operationToken;
        const permit = await this.permitFor(run.sessionId, run.turnId);
        if (!permit || permit.intentId !== run.intentId || permit.runRevision !== run.revision || permit.activationToken !== activationToken)
            throw new Error("Captain source repair session activation or ownership is invalid");
        const lease = await this.interruptionLeaseReadOnly(run);
        return { runId: run.runId, runRevision: run.revision, committedStateSha256: digest(JSON.stringify(run.committedState)),
            activationToken, sessionLeaseRevision: lease.revision, sessionLeaseSha256: digest(JSON.stringify(lease.payload)) };
    }
    async assertCommitted(run, repairFence) {
        await this.assertFrozenScope(run.intentId);
        await assertDocumentationScope(run, run.committedState.head);
        const current = await this.probe(run.worktreePath, run.policy), expected = run.committedState;
        this.assertWorktreeBinding(run, current, expected.head);
        if (current.tree !== expected.tree)
            throw new Error("proof committed tree binding diverged from the signed Captain run");
        if (current.status !== "" || (expected.manifest && current.manifest !== expected.manifest)) {
            if (repairFence)
                throw new ProofSourceDivergenceError(repairFence);
            throw new Error("proof source state diverged from the clean committed tree or ignored-input manifest");
        }
    }
    async assertCommitOperation(run, operation) { if (!run.commitOperation || run.commitOperation.leaseId !== operation.leaseId || run.commitOperation.leaseToken !== operation.leaseToken || run.commitOperation.requestSha256 !== operation.requestSha256)
        throw new Error("Captain commit operation lease ownership diverged from the signed run"); const lease = await readAuthorizedLease(this.dataRoot, operation.leaseId); if (lease.intentId !== run.intentId || lease.leaseToken !== operation.leaseToken || lease.runId !== run.runId || lease.requestSha256 !== operation.requestSha256 || lease.operation !== "prepared-commit")
        throw new Error("Captain commit operation lease ownership is invalid"); }
    async captureSessionOwner(run) {
        if (!this.hooks?.sessionOwner || await this.readSessionOwner(run))
            return;
        const owner = await this.hooks.sessionOwner(run.sessionId);
        if (owner)
            await this.bindSessionOwner(run.intentId, run.sessionId, owner);
    }
    async assertRecoverableSameSessionWithoutLease(run, intent) {
        if (run.status === "paused" || run.sessionId !== intent.sessionId || !samePath(run.projectRoot, intent.projectRoot)) {
            throw new Error("missing session lease recovery is limited to the same authorized client session and project");
        }
        if (run.sessionLeaseId || run.sessionLeaseToken)
            throw new Error("partial session lease ownership metadata cannot be recovered");
        const requests = await this.userRequests({ projectRoot: run.projectRoot, intentId: run.intentId, sessionId: intent.sessionId });
        const authorized = requests.status === "expressed" && requests.receipts.some(receipt => receipt.decision === "expressed" && ["direct_instruction", "continuation", "explicit_approval"].includes(String(receipt.basis)) &&
            receipt.sessionId === intent.sessionId && receipt.turnId === intent.turnId && receipt.sourceIntentId === intent.intentId &&
            receipt.intentId === run.intentId && samePath(receipt.projectRoot, run.projectRoot) && samePath(receipt.commonGitDir, run.commonGitDir) &&
            (!run.taskId || receipt.taskId === run.taskId) && (!run.targetBranch || receipt.targetBranch === run.targetBranch));
        if (!authorized)
            throw new Error("same-session lease recovery requires this turn's expressed task authorization");
        const leaseId = digest(`session-active\0${intent.sessionId}`);
        const lease = await readAuthorizedLeaseSnapshotReadOnly(this.dataRoot, leaseId);
        if (lease?.state === "held")
            throw new Error("same-session resume cannot replace an active session lease held by another Captain operation");
    }
    async readSessionOwner(run) {
        const token = run.activationToken ?? run.operationToken;
        let binding;
        try {
            binding = await readAuthorizedReadOnly(this.dataRoot, "session-owner-bindings", safeId(token));
        }
        catch (error) {
            if (error.code === "ENOENT")
                return undefined;
            throw error;
        }
        if (binding.schemaVersion !== 1 || binding.intentId !== run.intentId || binding.runId !== run.runId || binding.sessionId !== run.sessionId ||
            binding.activationToken !== token || binding.sessionLeaseId !== run.sessionLeaseId || binding.sessionLeaseToken !== run.sessionLeaseToken)
            throw new Error("signed client owner binding diverged from the active session");
        validateSessionOwner(binding.owner);
        return binding;
    }
    async interruptionLeaseReadOnly(run) {
        if (!run.sessionLeaseId || !run.sessionLeaseToken)
            throw new Error("run has no current session ownership");
        const lease = await readAuthorizedLeaseSnapshotReadOnly(this.dataRoot, run.sessionLeaseId);
        const token = run.activationToken ?? run.operationToken;
        if (!lease || lease.legacy || lease.state !== "held" || lease.revision === null || lease.payload.intentId !== run.intentId ||
            lease.payload.runId !== run.runId || lease.payload.sessionId !== run.sessionId || lease.payload.leaseToken !== run.sessionLeaseToken ||
            lease.payload.operationToken !== token || lease.payload.operation !== "session-active")
            throw new Error("session lease generation or owner binding is invalid");
        return lease;
    }
    async assertInterruptionSelectors(args) {
        if (!Number.isSafeInteger(args.expectedRunRevision) || args.expectedRunRevision < 0 || !Number.isSafeInteger(args.expectedSessionLeaseRevision) || args.expectedSessionLeaseRevision < 0 || !/^[0-9a-f]{64}$/i.test(args.resourceGeneration))
            throw new Error("session interruption generation selectors are invalid");
        const run = await this.interruptionRunReadOnly(args.intentId);
        if (run.sessionId !== args.sessionId || run.revision !== args.expectedRunRevision || run.status === "paused" || run.status === "green")
            throw new Error("session interruption run revision or session binding changed");
        const lease = await this.interruptionLeaseReadOnly(run);
        const generation = digest(JSON.stringify({ leaseId: run.sessionLeaseId, revision: lease.revision, state: "held", payload: lease.payload }));
        if (lease.revision !== args.expectedSessionLeaseRevision || generation !== args.resourceGeneration.toLowerCase())
            throw new Error("session interruption lease generation changed");
        return run;
    }
    interruptionSelectorId(args) {
        return digest(JSON.stringify({ intentId: args.intentId, sessionId: args.sessionId, expectedRunRevision: args.expectedRunRevision,
            expectedSessionLeaseRevision: args.expectedSessionLeaseRevision, resourceGeneration: args.resourceGeneration.toLowerCase() }));
    }
    async completePendingSessionInterruption(run) {
        const interruption = run.evidence.filter(item => item.kind === "session_interruption").at(-1);
        if (!interruption || typeof interruption.selectorHash !== "string" || !/^[0-9a-f]{64}$/.test(interruption.selectorHash))
            return;
        try {
            await readAuthorizedReadOnly(this.dataRoot, "session-interruption-results", interruption.selectorHash);
            return;
        }
        catch (error) {
            if (error.code !== "ENOENT")
                throw error;
        }
        const checkpoint = await readAuthorizedReadOnly(this.dataRoot, "session-interruption-drafts", interruption.selectorHash);
        if (checkpoint.handoff.revision !== run.revision)
            return;
        const args = { ...checkpoint.selectors, summary: checkpoint.handoff.summary, nextSteps: checkpoint.handoff.nextSteps };
        if (this.interruptionSelectorId(args) !== interruption.selectorHash || args.intentId !== run.intentId || args.sessionId !== run.sessionId ||
            args.expectedRunRevision + 1 !== run.revision)
            throw new Error("pending signed interruption generation binding is invalid");
        if (!await this.interruptionResult(args))
            throw new Error("pending signed interruption could not finalize its original handoff and lease");
    }
    async interruptionResult(args) {
        try {
            return await readAuthorizedReadOnly(this.dataRoot, "session-interruption-results", this.interruptionSelectorId(args));
        }
        catch (error) {
            if (error.code !== "ENOENT")
                throw error;
        }
        // A terminated adapter may have written the pause before its release/result.
        const run = await this.interruptionRunReadOnly(args.intentId);
        if (run.status !== "paused" || run.sessionId !== args.sessionId || run.revision !== args.expectedRunRevision + 1 ||
            !run.evidence.some(item => item.kind === "session_interruption" && item.selectorHash === this.interruptionSelectorId(args)))
            return undefined;
        let handoff;
        try {
            handoff = await readAuthorizedReadOnly(this.dataRoot, "pause-handoffs", `${run.intentId}-${run.revision}`);
        }
        catch (error) {
            if (error.code !== "ENOENT")
                throw error;
            const checkpoint = await readAuthorizedReadOnly(this.dataRoot, "session-interruption-drafts", this.interruptionSelectorId(args));
            if (this.interruptionSelectorId({ ...checkpoint.selectors, summary: args.summary, nextSteps: args.nextSteps }) !== this.interruptionSelectorId(args))
                throw new Error("signed interruption checkpoint generation selectors are invalid");
            const draft = checkpoint.handoff;
            if (draft.schemaVersion !== 1 || draft.intentId !== run.intentId || draft.runId !== run.runId || draft.revision !== run.revision ||
                draft.sessionId !== run.sessionId || draft.turnId !== run.turnId || draft.projectRoot !== run.projectRoot || draft.branch !== run.branch ||
                draft.worktreePath !== run.worktreePath || draft.phase !== run.phase || draft.objective !== run.objective || draft.status !== "paused" ||
                draft.resumeDirective !== `[Captain resume: ${run.intentId}]` || !draft.summary || !draft.nextSteps.length)
                throw new Error("signed session interruption draft binding is invalid");
            if (draft.worktreeState)
                this.assertWorktreeBinding(run, draft.worktreeState);
            handoff = await putAuthorizedOnceExact(this.dataRoot, "pause-handoffs", `${run.intentId}-${run.revision}`, { ...draft, evidence: run.evidence });
        }
        if (handoff.runId !== run.runId || handoff.sessionId !== run.sessionId || handoff.worktreePath !== run.worktreePath)
            throw new Error("session interruption handoff binding is invalid");
        await releaseAuthorizedLeaseAtGeneration(this.dataRoot, run.sessionLeaseId, run.intentId, run.sessionLeaseToken, args.expectedSessionLeaseRevision, args.resourceGeneration);
        return putAuthorizedOnceExact(this.dataRoot, "session-interruption-results", this.interruptionSelectorId(args), handoff);
    }
    async interruptionRunReadOnly(intentId) {
        const id = safeId(intentId), prefix = `${id}-`;
        const names = await readdir(path.join(this.dataRoot, "run-revisions"));
        const revisions = names.map(name => name.startsWith(prefix) && /^(\d+)\.json$/.exec(name.slice(prefix.length))).filter(Boolean).map(match => Number(match[1])).sort((a, b) => a - b);
        if (!revisions.length)
            throw new Error("legacy run has no authenticated revision chain for interruption recovery");
        let previous;
        for (let index = 0; index < revisions.length; index++) {
            if (revisions[index] !== index)
                throw new Error("signed run revision sequence is not contiguous");
            const current = await readAuthorizedReadOnly(this.dataRoot, "run-revisions", `${id}-${index}`);
            const watermark = await readAuthorizedReadOnly(this.dataRoot, "run-watermarks", `${id}-${index}`);
            if (current.intentId !== intentId || current.revision !== index || current.previousRevisionSha256 !== (previous ? digest(JSON.stringify(previous)) : undefined) ||
                watermark.intentId !== intentId || watermark.runId !== current.runId || watermark.revision !== index || watermark.runSha256 !== digest(JSON.stringify(current)))
                throw new Error("signed run interruption revision binding is invalid");
            if (previous)
                this.assertStableRun(previous, current);
            previous = current;
        }
        const watermarks = await readdir(path.join(this.dataRoot, "run-watermarks"));
        if (watermarks.some(name => name.startsWith(prefix) && /^(\d+)\.json$/.test(name.slice(prefix.length)) && Number(name.slice(prefix.length, -5)) > previous.revision))
            throw new Error("signed run revision tail regressed behind its watermark");
        return previous;
    }
    async assertSessionLease(run) { if (!run.sessionLeaseId || !run.sessionLeaseToken)
        throw new Error("Captain run has no active session ownership"); const lease = await readAuthorizedLease(this.dataRoot, run.sessionLeaseId), activationToken = run.activationToken ?? run.operationToken; if (lease.intentId !== run.intentId || lease.leaseToken !== run.sessionLeaseToken || lease.operationToken !== activationToken || lease.runId !== run.runId || lease.sessionId !== run.sessionId || lease.operation !== "session-active")
        throw new Error("Captain session active ownership is invalid"); }
    async finalizeCompletion(intentId) {
        let run = await this.run(intentId);
        if (run.phase !== "complete" || run.status !== "green")
            throw new Error("only a green completed run can finalize ownership release");
        const released = [];
        if (run.leaseId && run.leaseToken) {
            await this.releaseCompletedLease(run.leaseId, run.intentId, run.leaseToken);
            released.push({ kind: "target_lease_released", leaseId: run.leaseId });
        }
        if (run.sessionLeaseId && run.sessionLeaseToken) {
            await this.releaseCompletedLease(run.sessionLeaseId, run.intentId, run.sessionLeaseToken);
            released.push({ kind: "session_lease_released", leaseId: run.sessionLeaseId });
        }
        if (run.leaseId || run.sessionLeaseId)
            run = await this.update({ ...run, leaseId: undefined, leaseToken: undefined, sessionLeaseId: undefined, sessionLeaseToken: undefined, evidence: [...run.evidence, ...released] });
        try {
            const active = await this.load("active", run.sessionId);
            if (active.operationToken === run.operationToken)
                await this.project("active", run.sessionId, { intentId: "none", complete: true, operationToken: run.operationToken });
        }
        catch { }
        return run;
    }
    async releaseCompletedLease(leaseId, intentId, leaseToken) { try {
        await releaseAuthorizedLease(this.dataRoot, leaseId, intentId, leaseToken);
    }
    catch (error) {
        try {
            const successor = await readAuthorizedLease(this.dataRoot, leaseId);
            if (successor.intentId !== intentId || successor.leaseToken !== leaseToken)
                return;
        }
        catch (read) {
            if (read.code === "ENOENT")
                return;
        }
        throw error;
    } }
    async resumeHandoff(run) {
        if (run.status !== "paused")
            return undefined;
        let handoff;
        try {
            handoff = await this.load("pause-handoffs", `${run.intentId}-${run.revision}`);
        }
        catch (error) {
            if (error.code === "ENOENT")
                return undefined;
            throw error;
        }
        if (handoff.intentId !== run.intentId || handoff.runId !== run.runId || handoff.revision !== run.revision || handoff.status !== "paused" || handoff.branch !== run.branch || !samePath(handoff.projectRoot, run.projectRoot) || !samePath(handoff.worktreePath, run.worktreePath))
            throw new Error("signed pause handoff binding diverged from the Captain run");
        if (handoff.worktreeState)
            this.assertWorktreeBinding(run, handoff.worktreeState);
        return handoff;
    }
    expectedHead(run) { return executionHead(run); }
    assertWorktreeBinding(run, current, expectedHead) { const same = (left, right) => Boolean(left && right && path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()); if (current.branch !== run.branch || current.branchHead !== current.head || !same(current.commonGitDir, run.commonGitDir) || !same(current.topLevel, run.worktreePath) || !same(current.gitDir, run.gitDir) || (expectedHead && current.head !== expectedHead))
        throw new Error("worktree branch binding diverged from the signed Captain run"); }
    async load(bucket, id) { return readAuthorized(this.dataRoot, bucket, safeId(id)); }
    async save(bucket, id, value) { await writeAuthorized(this.dataRoot, bucket, safeId(id), value); }
}
const safeId = (id) => { if (!/^[a-zA-Z0-9_-]+$/.test(id))
    throw new Error("unsafe id"); return id; };
const samePath = (left, right) => path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
const digest = (text) => createHash("sha256").update(text).digest("hex");
const commitRequestSha256 = (request) => digest(JSON.stringify({ paths: request.paths, subject: request.subject, taskOutcome: request.taskOutcome ?? null, final: request.final }));
async function safeArtifact(root, relative) { if (path.isAbsolute(relative))
    throw new Error("artifact must be relative"); const full = path.resolve(root, relative), prefix = path.resolve(root) + path.sep; if (!full.startsWith(prefix))
    throw new Error("artifact escapes worktree"); for (let cursor = full; cursor.startsWith(path.resolve(root)); cursor = path.dirname(cursor)) {
    const info = await lstat(cursor);
    if (info.isSymbolicLink())
        throw new Error("artifact crosses a reparse point");
    if (cursor === path.resolve(root))
        break;
} return full; }
async function hashPath(target) { const info = await lstat(target); if (info.isSymbolicLink())
    throw new Error("artifact tree contains a reparse point"); if (info.isFile())
    return createHash("sha256").update(await readFile(target)).digest("hex"); const entries = await readdir(target, { withFileTypes: true }); const lines = []; for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const child = path.join(target, entry.name);
    lines.push(`${entry.name}:${await hashPath(child)}`);
} return digest(lines.join("\n")); }
async function optionalHash(root, relative) { try {
    return await hashPath(await safeArtifact(root, relative));
}
catch (error) {
    if (error.code === "ENOENT")
        return null;
    throw error;
} }
async function assertImage(target) { const bytes = await readFile(target); let valid = false; if (bytes.length >= 45 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    const ihdr = bytes.toString("ascii", 12, 16) === "IHDR", width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20), iend = bytes.includes(Buffer.from("IEND"));
    valid = ihdr && width > 0 && height > 0 && iend;
} if (!valid && bytes.length >= 12 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9) {
    for (let i = 2; i + 8 < bytes.length;) {
        if (bytes[i++] !== 0xff)
            continue;
        const marker = bytes[i++], length = bytes.readUInt16BE(i);
        if (length < 2 || i + length > bytes.length)
            break;
        if ([0xc0, 0xc1, 0xc2].includes(marker) && bytes.readUInt16BE(i + 3) > 0 && bytes.readUInt16BE(i + 5) > 0) {
            valid = true;
            break;
        }
        i += length;
    }
} if (!valid)
    throw new Error("visual artifact is not a structurally valid nonempty PNG or JPEG image"); }
