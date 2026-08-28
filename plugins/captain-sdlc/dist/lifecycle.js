import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { acquireAuthorizedLease, ensureAuthorizedLease, putAuthorizedOnceExact, readAuthorized, readAuthorizedLease, releaseAuthorizedLease, writeAuthorized } from "./authority.js";
import { compileSafeRegex, subjectVersion } from "./validation.js";
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
    async markIntent(intent) { await this.save("intents", intent.intentId, intent); }
    async validateIntent(intentId, projectRoot) { const intent = await this.load("intents", intentId); if (intent.consumed || intent.resumeOf)
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
        return { leaseId, leaseToken: operation.leaseToken };
    }
    async checkpointBeginLease(operation, repository, lease) {
        await this.assertBeginOperation(operation);
        const value = { schemaVersion: 1, operationToken: operation.operationToken, ...(lease ? { leaseId: lease.leaseId, leaseToken: lease.leaseToken, commonGitDir: repository.commonGitDir, targetBranch: operation.targetBranch, targetOid: operation.targetOid } : {}) };
        if (Boolean(operation.targetBranch) !== Boolean(lease) || (lease && lease.leaseToken !== operation.leaseToken))
            throw new Error("target lease checkpoint does not match the signed begin reservation");
        if (lease) {
            const authorized = await readAuthorizedLease(this.dataRoot, lease.leaseId);
            if (authorized.intentId !== operation.intentId || authorized.leaseToken !== operation.leaseToken || authorized.targetBranch !== operation.targetBranch || authorized.targetOid !== operation.targetOid || !samePath(authorized.commonGitDir, repository.commonGitDir))
                throw new Error("target lease checkpoint does not match its signed authority");
        }
        return putAuthorizedOnceExact(this.dataRoot, "begin-leases", operation.operationToken, value);
    }
    async checkpointBeginWorkspace(operation, workspace) {
        await this.assertBeginOperation(operation);
        const value = { schemaVersion: 1, operationToken: operation.operationToken, ...workspace, projectRoot: path.resolve(workspace.projectRoot), worktreePath: path.resolve(workspace.worktreePath), commonGitDir: path.resolve(workspace.commonGitDir), gitDir: path.resolve(workspace.gitDir) };
        const canonical = path.join(operation.projectRoot, ".captain-sdlc", "worktrees") + path.sep;
        if (!value.worktreePath.startsWith(canonical) || !samePath(value.projectRoot, operation.projectRoot) || value.targetBranch !== operation.targetBranch || (operation.targetBranch && value.branch !== operation.targetBranch))
            throw new Error("workspace checkpoint does not match the signed begin reservation");
        return putAuthorizedOnceExact(this.dataRoot, "begin-workspaces", operation.operationToken, value);
    }
    async checkpointBeginRun(operation, policy) {
        await this.assertBeginOperation(operation);
        const repository = await this.load("begin-repositories", operation.operationToken), lease = await this.load("begin-leases", operation.operationToken), workspace = await this.load("begin-workspaces", operation.operationToken);
        if (repository.policySha256 !== digest(JSON.stringify(policy)) || repository.baseHead !== workspace.baseHead || !samePath(repository.commonGitDir, workspace.commonGitDir))
            throw new Error("begin checkpoints diverged before run activation");
        const profile = (await this.load("intents", operation.intentId)).requestedProfile ?? policy.profile;
        if (!(policy.profiles ?? [policy.profile]).includes(profile))
            throw new Error(`requested ${profile} sequence is not allowed by trusted policy`);
        if (policy.commit?.require_task_trailer && (!operation.taskId || !/^[A-Za-z0-9._-]+$/.test(operation.taskId)))
            throw new Error("trusted commit policy requires a safe task id");
        const run = { schemaVersion: 1, revision: 0, runId: operation.runId, operationToken: operation.operationToken, intentId: operation.intentId, sessionId: operation.sessionId, turnId: operation.turnId, ...(operation.taskId ? { taskId: operation.taskId } : {}), objective: operation.objective, projectRoot: workspace.projectRoot, worktreePath: workspace.worktreePath, baseHead: workspace.baseHead, branch: workspace.branch, ...(operation.targetBranch ? { targetBranch: operation.targetBranch } : {}), commonGitDir: workspace.commonGitDir, gitDir: workspace.gitDir, ...(lease.leaseId ? { leaseId: lease.leaseId, leaseToken: lease.leaseToken } : {}), profile, visualRequired: policy.visualRequired, startedAt: operation.startedAt, phase: "tdd_red", status: "running", policy, evidence: [] };
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
        throw new Error("begin activation checkpoints are incomplete"); await this.assertSessionLease(run); await putAuthorizedOnceExact(this.dataRoot, "begin-activated", operation.operationToken, { schemaVersion: 1, operationToken: operation.operationToken, intentId: operation.intentId, runId: operation.runId, sessionId: operation.sessionId, turnId: operation.turnId }); await this.project("active", operation.sessionId, active); return run; }
    async begin(input) {
        const operation = await this.reserveBegin({ intentId: input.intentId, objective: input.objective, projectRoot: input.projectRoot, taskId: input.taskId, leaseToken: input.leaseToken });
        const activated = await this.activatedBeginRun(operation);
        if (activated)
            return activated;
        const repository = await this.checkpointBeginRepository(operation, input, input.policy), lease = await this.checkpointBeginLease(operation, repository, input.leaseId && input.leaseToken ? { leaseId: input.leaseId, leaseToken: input.leaseToken } : undefined);
        await this.checkpointBeginWorkspace(operation, { projectRoot: input.projectRoot, worktreePath: input.worktreePath, baseHead: input.baseHead, branch: input.branch, targetBranch: input.targetBranch, commonGitDir: input.commonGitDir, gitDir: input.gitDir });
        const run = await this.checkpointBeginRun(operation, input.policy);
        await this.checkpointBeginActive(operation);
        const activatedRun = await this.checkpointBeginActivated(operation);
        await this.checkpointBeginPermit(operation, activatedRun);
        return this.status(operation.intentId);
    }
    async resume(resumeIntentId) {
        const intent = await this.load("intents", safeId(resumeIntentId));
        if (!intent.resumeOf)
            throw new Error("resume intent is invalid or consumed");
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
            if (run.status === "green" || run.sessionId !== intent.sessionId)
                throw new Error("completed or unrelated run cannot be resumed");
            await this.assertSessionLease(run);
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
        await this.assertSessionLease(run);
        if (this.probe) {
            const current = await this.probe(run.worktreePath, run.policy);
            this.assertWorktreeBinding(run, current);
            if (run.preparedCommit ? ![run.preparedCommit.preCommitHead, run.preparedCommit.candidate].includes(current.head) : current.head !== this.expectedHead(run))
                throw new Error("worktree branch binding diverged from the signed Captain run");
        }
        if (run.turnId !== operation.turnId) {
            try {
                run = await this.update({ ...run, turnId: operation.turnId });
            }
            catch (error) {
                run = await this.run(operation.intentId);
                if (run.turnId !== operation.turnId)
                    throw error;
            }
        }
        await putAuthorizedOnceExact(this.dataRoot, "resume-runs", operation.operationToken, { schemaVersion: 1, operationToken: operation.operationToken, intentId: run.intentId, runId: run.runId, revision: run.revision, turnId: run.turnId });
        await putAuthorizedOnceExact(this.dataRoot, "resume-activated", operation.operationToken, { schemaVersion: 1, operationToken: operation.operationToken, intentId: run.intentId, runId: run.runId, turnId: run.turnId });
        await this.project("permits", `${run.sessionId}-${run.turnId}`, this.permit(run));
        return run;
    }
    async recordRed(intentId, command) {
        const run = await this.run(intentId);
        this.phase(run, "tdd_red");
        const configured = run.policy.commands.ticket;
        if (this.probe)
            this.assertWorktreeBinding(run, await this.probe(run.worktreePath, run.policy), run.baseHead);
        if (!configured || (command && command !== configured))
            throw new Error("red test must use the trusted ticket command");
        const result = await this.runner(configured, run.worktreePath), red = run.policy.redGate;
        if (this.probe)
            this.assertWorktreeBinding(run, await this.probe(run.worktreePath, run.policy), run.baseHead);
        if (!red || !red.expectedExitCodes.includes(result.exitCode) || !compileSafeRegex(red.outputPattern, "i", "trusted red gate pattern").test(`${result.stdout}\n${result.stderr}`.slice(0, 1024 * 1024)))
            throw new Error("TDD red gate must be an expected failing test result, not an infrastructure failure");
        return this.update({ ...run, phase: "implement", evidence: [...run.evidence, { kind: "tdd_red", commandSha256: digest(configured), exitCode: result.exitCode, outputSha256: digest(`${result.stdout}\n${result.stderr}`) }] });
    }
    async recordPreparedMerge(intentId, prepared) {
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
        let run = await this.run(intentId);
        this.phase(run, "implement");
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
        let run = await this.run(intentId);
        this.phase(run, "implement");
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
        const operation = { leaseId, leaseToken: randomUUID(), requestSha256, stage: "reserved" };
        run = await this.update({ ...run, commitOperation: operation, evidence: [...run.evidence, { kind: "commit_operation_reserved", leaseId, requestSha256 }] });
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
    }
    async discardCommitOperation(intentId, operation) {
        const run = await this.run(intentId);
        this.phase(run, "implement");
        if (run.preparedCommit)
            throw new Error("a signed prepared commit must use prepared recovery");
        await this.assertCommitOperation(run, operation);
        const discarded = await this.update({ ...run, commitOperation: undefined, evidence: [...run.evidence, { kind: "commit_operation_discarded", leaseId: operation.leaseId }] });
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
    async recordCommit(intentId, commit, final = true) {
        const run = await this.run(intentId);
        this.phase(run, "implement");
        const operation = run.commitOperation;
        if (run.targetBranch && (!run.preparedCommit || !operation))
            throw new Error("governed target commit requires signed prepared operation ownership");
        if (run.preparedCommit && !operation)
            throw new Error("signed prepared commit has no operation lease ownership");
        if (operation) {
            if (!run.preparedCommit || operation.stage !== "prepared")
                throw new Error("commit operation cannot finalize before signed candidate authorization");
            await this.assertCommitOperation(run, operation);
        }
        if (!commit.clean || commit.commitCount < 1 || !/^[0-9a-f]{40,64}$/i.test(commit.head) || commit.head === run.baseHead)
            throw new Error("commit gate requires at least one clean atomic phase commit after base");
        const conventional = /^(feat|fix|refactor|perf|test|docs|build|ci|chore)(\([^)]+\))?!?: .+/.test(commit.subject);
        if ((run.policy.commit?.conventional ?? true) && !conventional)
            throw new Error("commit must use a Conventional Commit subject");
        if ((run.policy.commit?.require_version_suffix ?? true) && !subjectVersion(commit.subject))
            throw new Error("commit must include a strict SemVer suffix");
        if (!commit.versionChanged || !commit.changelogChanged)
            throw new Error("commit must update the configured version file and changelog");
        if (run.policy.commit?.require_task_trailer && !commit.taskTrailerValid)
            throw new Error("commit must include a configured task trailer");
        if (run.policy.commit?.version_surfaces?.length && !commit.versionSurfacesValid)
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
        const next = { ...run, phase: final ? "prove" : "implement", committedState, evidence: [...run.evidence, { kind: final ? "commit" : "phase_commit", final, ...commit, ...(operation ? { operationLeaseId: operation.leaseId } : {}) }] };
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
    async runCheck(intentId, scope) {
        const run = await this.run(intentId);
        this.phase(run, "implement");
        if (run.preparedCommit)
            throw new Error("prepared commit recovery must complete before iteration checks");
        const command = run.policy.commands[scope];
        if (!command || !["ticket", "feature-smoke", "affected-regression"].includes(scope))
            throw new Error("iteration check must be a trusted implementation scope");
        if (this.probe)
            this.assertWorktreeBinding(run, await this.probe(run.worktreePath, run.policy), this.expectedHead(run));
        const result = await this.runner(command, run.worktreePath);
        if (this.probe)
            this.assertWorktreeBinding(run, await this.probe(run.worktreePath, run.policy), this.expectedHead(run));
        return this.update({ ...run, evidence: [...run.evidence, { kind: "iteration", scope, commandSha256: digest(command), exitCode: result.exitCode }] });
    }
    async prove(intentId) {
        const current = await this.run(intentId);
        if (current.phase === "complete" && current.status === "green")
            return this.finalizeCompletion(intentId);
        try {
            return await this.proveAttempt(intentId);
        }
        catch (error) {
            const latest = await this.run(intentId);
            if (latest.phase === "prove")
                await this.update({ ...latest, phase: "implement", status: "red", evidence: [...latest.evidence, { kind: "proof_error", messageSha256: digest(String(error.message)) }] });
            throw error;
        }
    }
    async proveAttempt(intentId) {
        const run = await this.run(intentId);
        this.phase(run, "prove");
        if (!this.probe || !run.committedState)
            throw new Error("source-state probe is required");
        await this.assertCommitted(run);
        const scopes = run.profile === "pre-release" ? ["build", "ticket", "feature-smoke", "affected-regression", "super-smoke", ...(run.visualRequired ? ["visual"] : [])] : ["build", "ticket", "feature-smoke", "affected-regression", ...(run.visualRequired ? ["visual"] : [])];
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
            const command = run.policy.commands[scope], result = await this.runner(command, run.worktreePath);
            proof.push({ scope, commandSha256: digest(command), exitCode: result.exitCode });
            if (result.exitCode !== 0) {
                await this.update({ ...run, phase: "implement", status: "red", evidence: [...run.evidence, ...proof] });
                throw new Error(`${scope} proof failed; run returned to implement for repair`);
            }
            await this.assertCommitted(run);
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
        const completed = await this.update({ ...run, phase: "complete", status: "green", evidence: [...run.evidence, ...proof, { kind: "artifacts", artifacts }] });
        await this.hooks?.afterRunCompleted?.(completed);
        return this.finalizeCompletion(intentId);
    }
    async status(intentId) { const run = await this.run(intentId); await this.reconcileRunProjections(run); return run; }
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
    async releaseTargetLease(leaseId, intentId, leaseToken) { await releaseAuthorizedLease(this.dataRoot, leaseId, intentId, leaseToken); }
    async permitFor(sessionId, turnId) { try {
        const permit = await this.load("permits", `${sessionId}-${turnId}`), run = await this.run(permit.intentId), active = await this.load("active", sessionId), activated = await this.load("begin-activated", permit.operationToken);
        if (run.status === "green" || run.sessionId !== sessionId || run.turnId !== turnId || run.revision !== permit.runRevision || run.operationToken !== permit.operationToken || active.operationToken !== permit.operationToken || activated.operationToken !== permit.operationToken)
            return null;
        await this.assertSessionLease(run);
        return permit;
    }
    catch {
        return null;
    } }
    permit(run) { return { schemaVersion: 1, sessionId: run.sessionId, turnId: run.turnId, worktreePath: run.worktreePath, phase: run.phase, intentId: run.intentId, runId: run.runId, runRevision: run.revision, operationToken: run.operationToken, sessionLeaseId: run.sessionLeaseId, sessionLeaseToken: run.sessionLeaseToken, activated: true }; }
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
        await putAuthorizedOnceExact(this.dataRoot, "run-revisions", `${safe}-0`, normalized);
        await this.writeRunWatermark(normalized);
        return normalized;
    } for (let index = 0; index < revisions.length; index++)
        if (revisions[index] !== index)
            throw new Error("signed run revision sequence is not contiguous"); let latest, previous; for (const revision of revisions) {
        latest = await this.load("run-revisions", `${safe}-${revision}`);
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
        throw new Error("Captain run changed concurrently; retry from authoritative status"); const next = { ...run, revision: current.revision + 1, previousRevisionSha256: digest(JSON.stringify(current)) }; const stored = await putAuthorizedOnceExact(this.dataRoot, "run-revisions", `${run.intentId}-${next.revision}`, next); await this.writeRunWatermark(stored); await this.hooks?.afterRunRevision?.(stored); await this.reconcileRunProjections(await this.run(run.intentId)); return stored; }
    async writeRunWatermark(run) { await putAuthorizedOnceExact(this.dataRoot, "run-watermarks", `${run.intentId}-${run.revision}`, { schemaVersion: 1, intentId: run.intentId, runId: run.runId, revision: run.revision, runSha256: digest(JSON.stringify(run)), previousRevisionSha256: run.previousRevisionSha256 }); }
    async reconcileRunProjections(run) { const latest = await this.run(run.intentId); await this.project("runs", latest.intentId, latest); if (latest.status !== "green" && latest.sessionLeaseId && latest.sessionLeaseToken)
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
    assertStableRun(previous, current) { const stable = (run) => ({ schemaVersion: run.schemaVersion, runId: run.runId, operationToken: run.operationToken, intentId: run.intentId, sessionId: run.sessionId, taskId: run.taskId, objective: run.objective, projectRoot: path.resolve(run.projectRoot), worktreePath: path.resolve(run.worktreePath), baseHead: run.baseHead, branch: run.branch, targetBranch: run.targetBranch, commonGitDir: path.resolve(run.commonGitDir), gitDir: path.resolve(run.gitDir), profile: run.profile, visualRequired: run.visualRequired, startedAt: run.startedAt, policy: run.policy }); if (JSON.stringify(stable(previous)) !== JSON.stringify(stable(current)))
        throw new Error("signed run immutable binding changed across revisions"); }
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
    async assertBeginOperation(operation) { const signed = await this.beginOperationFor(operation.intentId); if (JSON.stringify(signed) !== JSON.stringify(operation))
        throw new Error("signed begin operation ownership diverged"); }
    assertBeginReservation(operation, intent, input) { if (operation.schemaVersion !== 1 || operation.intentId !== input.intentId || operation.intentId !== intent.intentId || operation.sessionId !== intent.sessionId || operation.turnId !== intent.turnId || !samePath(operation.projectRoot, input.projectRoot) || !samePath(operation.projectRoot, intent.projectRoot) || operation.objective !== input.objective || operation.taskId !== input.taskId || operation.targetBranch !== intent.targetBranch || operation.targetOid !== intent.targetOid || (input.leaseToken && operation.leaseToken !== input.leaseToken))
        throw new Error("retry does not match the signed begin reservation"); }
    async authorizeCommitOperation(run, operation) { const payload = { intentId: run.intentId, leaseToken: operation.leaseToken, runId: run.runId, requestSha256: operation.requestSha256, operation: "prepared-commit" }; await ensureAuthorizedLease(this.dataRoot, operation.leaseId, payload); if (operation.stage === "authorized") {
        await this.assertCommitOperation(run, operation);
        return operation;
    } if (operation.stage !== "reserved")
        throw new Error("prepared commit recovery must complete before a new commit operation"); const latest = await this.run(run.intentId); if (!latest.commitOperation || latest.commitOperation.leaseToken !== operation.leaseToken || latest.commitOperation.stage !== "reserved")
        throw new Error("Captain commit operation changed during lease authorization"); const authorized = { ...operation, stage: "authorized" }, updated = await this.update({ ...latest, commitOperation: authorized, evidence: [...latest.evidence, { kind: "commit_operation_authorized", leaseId: operation.leaseId }] }); return updated.commitOperation; }
    async assertCommitted(run) { const current = await this.probe(run.worktreePath, run.policy), expected = run.committedState; this.assertWorktreeBinding(run, current, expected.head); if (current.head !== expected.head || current.tree !== expected.tree || current.status !== "" || (expected.manifest && current.manifest !== expected.manifest))
        throw new Error("proof source state diverged from the clean committed tree or ignored-input manifest"); }
    async assertCommitOperation(run, operation) { if (!run.commitOperation || run.commitOperation.leaseId !== operation.leaseId || run.commitOperation.leaseToken !== operation.leaseToken || run.commitOperation.requestSha256 !== operation.requestSha256)
        throw new Error("Captain commit operation lease ownership diverged from the signed run"); const lease = await readAuthorizedLease(this.dataRoot, operation.leaseId); if (lease.intentId !== run.intentId || lease.leaseToken !== operation.leaseToken || lease.runId !== run.runId || lease.requestSha256 !== operation.requestSha256 || lease.operation !== "prepared-commit")
        throw new Error("Captain commit operation lease ownership is invalid"); }
    async assertSessionLease(run) { if (!run.sessionLeaseId || !run.sessionLeaseToken)
        throw new Error("Captain run has no active session ownership"); const lease = await readAuthorizedLease(this.dataRoot, run.sessionLeaseId); if (lease.intentId !== run.intentId || lease.leaseToken !== run.sessionLeaseToken || lease.operationToken !== run.operationToken || lease.runId !== run.runId || lease.sessionId !== run.sessionId || lease.operation !== "session-active")
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
    expectedHead(run) { return run.committedState?.head ?? run.baseHead; }
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
