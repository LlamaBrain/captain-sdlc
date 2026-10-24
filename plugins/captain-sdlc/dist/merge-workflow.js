import { createHash, randomUUID } from "node:crypto";
import os from "node:os";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { acquireAuthorizedLease, putAuthorizedOnceExact, readAuthorized, readAuthorizedReadOnly, readAuthorizedLease, readAuthorizedLeaseState, readAuthorizedLeaseStateReadOnly, releaseAuthorizedLease } from "./authority.js";
import { BookkeepingFinalizationStore } from "./bookkeeping-finalization.js";
import { LifecycleStore } from "./lifecycle.js";
import { applyPreparedCommit, assertWorktreeBinding, bookkeepingHistoryValid, commitAtomic, gateRunner, git, loadPolicy, prepareMerge, reconcilePreparedCommit, reconcilePreparedMerge, repositoryIdentity, sourceState } from "./workspace.js";
import { cleanupRegisteredWorktrees, readWorktreeCleanupCompletion, retainedWorktreeHead } from "./worktree-cleanup.js";
import { readWorktreeRegistration, storageRegistrationId } from "./worktree-storage.js";
import { prepareScopeOutputs } from "./output-retention.js";
import { primaryRepositoryRoot } from "./workspace.js";
/** Context is attached only after Prep has established its caller-owned signed record. */
export class MergeWorkflowError extends Error {
    merge_id;
    constructor(merge_id, cause) {
        super(cause instanceof Error ? cause.message : String(cause), { cause });
        this.merge_id = merge_id;
        this.name = "MergeWorkflowError";
    }
}
const hash = (text) => createHash("sha256").update(text).digest("hex");
const digest = (value) => hash(JSON.stringify(value));
const samePath = (left, right) => process.platform === "win32" ? path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase() : path.resolve(left) === path.resolve(right);
const safeId = (id) => { if (!/^[a-zA-Z0-9_-]+$/.test(id))
    throw new Error("unsafe merge id"); return id; };
const relativePath = (value) => { if (!value || value.includes("\0") || path.isAbsolute(value) || /(^|[\\/])\.\.([\\/]|$)/.test(value))
    throw new Error("dependency input must use a safe repository-relative path"); return value.replaceAll("\\", "/"); };
const resourceId = (common, branch) => hash(`${path.resolve(common)}\0refs/heads/${branch}`.toLowerCase());
/** Independent integration ledger. Signed candidates may append intermediate phase evidence; prior proof is retained. */
export class MergeWorkflowStore {
    dataRoot;
    runner;
    activeOperations = new Set();
    constructor(dataRoot, runner = gateRunner) {
        this.dataRoot = dataRoot;
        this.runner = runner;
    }
    async diagnose(args) {
        this.session(args.session_id);
        const source = await readOnlyBinding(args.source_worktree), target = await readOnlyBinding(args.target_worktree, args.target_branch, source.commonGitDir);
        if (samePath(source.topLevel, target.topLevel) || source.branch === target.branch)
            throw new Error("merge diagnosis requires distinct source and target worktree/branch bindings");
        const revisions = await directoryNames(path.join(this.dataRoot, "merge-revisions")), watermarks = await directoryNames(path.join(this.dataRoot, "merge-watermarks"));
        const ids = [...new Set([...revisions, ...watermarks].map(name => /^([A-Za-z0-9_-]+)-[0-9]+\.json$/.exec(name)?.[1]).filter((id) => Boolean(id)))].sort();
        const operations = [];
        for (const id of ids) {
            const record = await this.readForDiagnosis(id, revisions, watermarks);
            if (record.session_id !== args.session_id || !samePath(record.source_worktree, source.topLevel) || !samePath(record.target_worktree, target.topLevel) || record.target_branch !== args.target_branch)
                continue;
            for (const [stored, actual] of [[record.source_binding, source], [record.target_binding, target]]) {
                if (!stored || stored.branch !== actual.branch || !samePath(stored.topLevel, actual.topLevel) || !samePath(stored.commonGitDir, actual.commonGitDir) || !samePath(stored.gitDir, actual.gitDir) || !/^[0-9a-f]{40,64}$/i.test(stored.head))
                    throw new Error("signed merge Git/worktree binding diverged");
                if (await git(["--no-optional-locks", "rev-parse", "--verify", `${stored.head}^{commit}`], actual.topLevel) !== stored.head)
                    throw new Error("signed merge commit binding diverged");
            }
            operations.push({ merge_id: record.merge_id, revision: record.revision, state: record.state, source_worktree: record.source_worktree, target_worktree: record.target_worktree, target_branch: record.target_branch, source_head: record.source_binding.head, target_head: record.target_binding.head });
        }
        const lease = await readAuthorizedLeaseStateReadOnly(this.dataRoot, resourceId(target.commonGitDir, target.branch));
        let target_lease = { state: "absent" };
        if (lease) {
            const payload = lease.payload;
            target_lease = { state: lease.state, intent_id: safeId(payload.intentId), ...(typeof payload.operation === "string" ? { operation: payload.operation } : {}), owner: this.leaseOwnerStatus(payload).owner, session_match: typeof payload.sessionId !== "string" || !payload.sessionId.trim() ? "unknown" : payload.sessionId === args.session_id ? "same" : "other" };
        }
        return { read_only: true, captain_green: false, operations, target_lease };
    }
    async prep(args) {
        this.session(args.session_id);
        const mergeId = safeId(args.merge_id ?? `merge-${randomUUID()}`);
        let durableMergeId;
        try {
            return await this.lock(mergeId, args.session_id, async (assertOperation) => {
                let record;
                if (args.merge_id) {
                    record = await this.read(mergeId);
                    this.match(record, args);
                }
                else {
                    const sourceRoot = path.resolve(args.source_worktree), targetRoot = path.resolve(args.target_worktree);
                    if (samePath(sourceRoot, targetRoot))
                        throw new Error("Merge Prep needs distinct source and target worktrees");
                    const source = await assertWorktreeBinding(sourceRoot, undefined, undefined, undefined, !args.finalization?.source), target = await assertWorktreeBinding(targetRoot, args.target_branch, source.commonGitDir, undefined, !args.finalization?.target);
                    if (source.branch === target.branch)
                        throw new Error("source and target branches must differ");
                    await assertNoOperation(sourceRoot);
                    await assertNoOperation(targetRoot);
                    await repositoryIdentity(sourceRoot);
                    await repositoryIdentity(targetRoot);
                    const policy = await loadPolicy(sourceRoot, source.head), mergePolicyText = await committedFile(sourceRoot, source.head, ".captain-sdlc/merge-policy.json"), mergePolicy = JSON.parse(mergePolicyText ?? '{"schema_version":1,"strictness":"low"}');
                    if (mergePolicy.schema_version !== 1 || !["low", "standard", "strict"].includes(mergePolicy.strictness))
                        throw new Error("trusted merge policy must configure schema_version 1 and low, standard, or strict");
                    const scopes = mergePolicy.strictness === "low" ? ["build"] : ["build", "ticket", "feature-smoke", "affected-regression", ...(mergePolicy.strictness === "strict" ? ["super-smoke"] : [])];
                    for (const scope of scopes)
                        if (!policy.commands[scope])
                            throw new Error(`trusted merge policy is missing ${scope} command`);
                    record = await this.initial({ schema_version: 1, merge_id: mergeId, revision: 0, session_id: args.session_id, state: "preparing", source_worktree: sourceRoot, target_worktree: targetRoot, target_branch: args.target_branch, source_binding: source, target_binding: target, captured_policy: policy, policy_sha256: digest({ policy, mergePolicyText }), strictness: mergePolicy.strictness, scopes, conflicts: [], gates: [] });
                }
                durableMergeId = record.merge_id;
                if (record.state === "merged")
                    return this.output(record);
                record = await this.finalizeSelected(record, args.finalization, assertOperation);
                return this.resources(record, async (assertResources) => {
                    const assertAuthority = async () => { await assertOperation(); await assertResources(); };
                    record = await this.advanceBookkeepingTarget(record);
                    await this.bindings(record, false);
                    await assertNoOperation(record.target_worktree);
                    let recoveredCommit = false;
                    if (record.prepared_commit) {
                        if (args.commit && digest(args.commit) !== digest(record.prepared_commit_request))
                            throw new Error("prepared integration commit recovery must use the same signed commit request");
                        const currentHead = await git(["rev-parse", "HEAD"], record.source_worktree);
                        if (currentHead === record.prepared_commit.candidate) {
                            await assertAuthority();
                            await reconcilePreparedCommit(record.source_worktree, record.prepared_commit, record.source_binding.branch, record.source_binding.commonGitDir, record.source_binding.gitDir);
                        }
                        else if (currentHead === record.prepared_commit.preCommitHead) {
                            const prepared = record.prepared_commit;
                            await applyPreparedCommit(record.source_worktree, prepared, record.source_binding.branch, record.source_binding.commonGitDir, record.source_binding.gitDir, async (candidate) => { await assertAuthority(); await this.bindings(record, false); if (digest((await this.read(record.merge_id)).prepared_commit) !== digest(candidate))
                                throw new Error("signed integration commit recovery authority changed"); });
                        }
                        else
                            throw new Error("prepared commit recovery found diverged source HEAD");
                        record = await this.update({ ...record, prepared_commit: undefined, prepared_commit_request: undefined, prepared_merge: undefined, state: "preparing", conflicts: [] });
                        recoveredCommit = true;
                    }
                    if (record.prepared_merge && !await optionalGit(["rev-parse", "--verify", "MERGE_HEAD"], record.source_worktree)) {
                        await assertAuthority();
                        await reconcilePreparedMerge(record.source_worktree, record.prepared_merge);
                        record = await this.update({ ...record, prepared_merge: undefined, state: "preparing" });
                    }
                    if (record.prepared_merge) {
                        const mergeHead = await optionalGit(["rev-parse", "--verify", "MERGE_HEAD"], record.source_worktree), head = await git(["rev-parse", "HEAD"], record.source_worktree);
                        if (mergeHead !== record.prepared_merge.targetOid || head !== record.prepared_merge.preMergeHead)
                            throw new Error("source no longer matches the signed pending merge; recover that operation before another prep");
                        await assertNoOperation(record.source_worktree, true);
                        if (args.commit) {
                            const pending = record.prepared_merge;
                            await assertAuthority();
                            await commitAtomic(record.source_worktree, args.commit.paths, args.commit.subject, args.commit.task_outcome, args.commit.task_id, record.captured_policy.commit, [pending], record.source_binding.branch, record.source_binding.commonGitDir, pending.preMergeHead, record.source_binding.gitDir, async (prepared) => { record = await this.update({ ...record, prepared_commit: prepared, prepared_commit_request: args.commit }); }, async () => { record = await this.update({ ...record, prepared_commit: undefined, prepared_commit_request: undefined }); }, undefined, async (prepared) => { await assertAuthority(); const latest = await this.read(record.merge_id); if (digest(latest.prepared_commit) !== digest(prepared))
                                throw new Error("signed integration commit authority changed"); await this.bindings(record, false); });
                            record = await this.update({ ...record, prepared_commit: undefined, prepared_commit_request: undefined, prepared_merge: undefined, state: "preparing", conflicts: [] });
                        }
                        else {
                            const conflicts = lines(await git(["diff", "--name-only", "--diff-filter=U"], record.source_worktree));
                            record = await this.update({ ...record, state: conflicts.length ? "needs_resolution" : "needs_commit", conflicts });
                            return this.output(record);
                        }
                    }
                    else if (args.commit && !recoveredCommit)
                        throw new Error("Merge Prep commit metadata is only valid for its signed pending target merge");
                    await assertNoOperation(record.source_worktree);
                    await assertWorktreeBinding(record.source_worktree, record.source_binding.branch, record.source_binding.commonGitDir, undefined, true, record.source_binding.gitDir);
                    await this.reconcileOwnedImplementation(record, assertAuthority);
                    if (!await ancestor(record.target_binding.head, await git(["rev-parse", "HEAD"], record.source_worktree), record.source_worktree)) {
                        const currentHead = await git(["rev-parse", "HEAD"], record.source_worktree);
                        const result = await prepareMerge(record.source_worktree, record.target_binding.head, "ort", async (prepared) => { record = await this.update({ ...record, state: "preparing", prepared_merge: prepared, ...(record.ready_inputs ? {} : { ready_inputs: undefined, integration_inputs: undefined, gates: [] }) }); }, async () => { record = await this.update({ ...record, prepared_merge: undefined, state: "failed", failure: "target merge preparation was rejected" }); }, record.source_binding.branch, record.source_binding.commonGitDir, currentHead, record.source_binding.gitDir, undefined, mergeId, async (prepared) => { await assertAuthority(); await this.bindings(record, false); const latest = await this.read(mergeId); if (digest(latest.prepared_merge) !== digest(prepared))
                            throw new Error("signed target merge authority changed"); });
                        record = await this.update({ ...record, state: result.status === "conflicts" ? "needs_resolution" : "needs_commit", conflicts: result.conflicts });
                        return this.output(record);
                    }
                    const inputs = await captureInputs(record.source_worktree, record.captured_policy);
                    if (record.ready_inputs) {
                        const retained = await this.associateBookkeepingInputs(record, inputs);
                        if (retained) {
                            const ready = { ...retained, state: "ready", failure: undefined };
                            if (digest(ready) !== digest(record))
                                record = await this.update(ready);
                            await this.assertReady(record);
                            return this.output(record, true);
                        }
                    }
                    if (record.state === "failed" && digest(inputs) === digest(record.attempted_inputs))
                        throw new Error("failed prep inputs are unchanged; repair a relevant source or dependency input before retrying");
                    record = await this.update({ ...record, state: "verifying", ready_inputs: undefined, integration_inputs: undefined, attempted_inputs: inputs, gates: [], failure: undefined });
                    try {
                        await git(["diff", "--check", record.target_binding.head, inputs.source.head], record.source_worktree);
                        for (const scope of record.scopes) {
                            await assertAuthority();
                            await this.bindings(record, false);
                            await this.assertInputs(record, inputs);
                            await prepareScopeOutputs(record.source_worktree, record.captured_policy, scope);
                            const command = record.captured_policy.commands[scope], result = await this.runner(command, record.source_worktree);
                            record = await this.update({ ...record, gates: [...record.gates, { scope, commandSha256: hash(command), exitCode: result.exitCode, stdoutSha256: hash(result.stdout), stderrSha256: hash(result.stderr) }] });
                            if (result.exitCode !== 0)
                                throw new Error(`${scope} merge prep gate failed (exit ${result.exitCode})`);
                            await assertAuthority();
                            await this.bindings(record, false);
                            await this.assertInputs(record, inputs);
                        }
                        record = await this.update({ ...record, state: "ready", ready_inputs: inputs });
                        return this.output(record, true);
                    }
                    catch (error) {
                        record = await this.update({ ...record, state: "failed", ready_inputs: undefined, failure: error.message });
                        return this.output(record, false);
                    }
                });
            });
        }
        catch (error) {
            if (durableMergeId)
                throw new MergeWorkflowError(durableMergeId, error);
            throw error;
        }
    }
    /** Recover an older signed Prep candidate without trusting caller-supplied source evidence. */
    async reconcileImplementation(args) {
        this.session(args.session_id);
        safeId(args.merge_id);
        safeId(args.intent_id);
        return this.lock(args.merge_id, args.session_id, async (assertOperation) => {
            const record = await this.read(args.merge_id);
            this.match(record, args);
            return this.resources(record, async (assertResources) => {
                const assertAuthority = async () => { await assertOperation(); await assertResources(); };
                await assertNoOperation(record.source_worktree);
                await assertNoOperation(record.target_worktree);
                const targetHead = await git(["rev-parse", "HEAD"], record.target_worktree);
                await this.bindings(record, Boolean(this.deliveryInputs(record) && targetHead === this.deliveryInputs(record).source.head));
                const implementation = await this.reconcileOwnedImplementation(record, assertAuthority, args.intent_id);
                if (!implementation)
                    throw new Error("no exact signed merge candidate belongs to this implementation owner");
                return { merge_id: record.merge_id, implementation, captain_green: false };
            });
        });
    }
    async reconcileOwnedImplementation(record, assertAuthority, intentId) {
        const lifecycle = new LifecycleStore(this.dataRoot, this.runner, sourceState);
        const owners = (await lifecycle.doctor()).activeRuns.filter(owner => samePath(owner.worktreePath, record.source_worktree));
        if (owners.length > 1 || owners.some(owner => owner.sessionId !== record.session_id))
            throw new Error("source implementation session owner mismatch");
        const owner = owners[0];
        if (!owner || intentId && owner.intentId !== intentId) {
            if (intentId)
                throw new Error("signed merge does not belong to the selected implementation intent");
            return undefined;
        }
        // Standalone readiness must not advance or reinterpret an unfinished proof phase.
        if (owner.phase !== "implement" || owner.status !== "running") {
            if (intentId)
                throw new Error(`merge reconciliation requires an implement/running owner; found ${owner.phase}/${owner.status}`);
            return undefined;
        }
        const head = await git(["rev-parse", "HEAD"], record.source_worktree);
        // read() authenticates the complete revision/watermark chain before selecting a candidate.
        const verified = await this.read(record.merge_id);
        if (verified.revision !== record.revision || digest(verified) !== digest(record))
            throw new Error("signed merge changed before lifecycle reconciliation");
        let candidate;
        for (let revision = record.revision; revision >= 0; revision--) {
            const historical = await readAuthorized(this.dataRoot, "merge-revisions", `${record.merge_id}-${revision}`);
            if (historical.prepared_commit?.candidate === head && historical.prepared_merge && historical.prepared_commit_request) {
                candidate = historical;
                break;
            }
        }
        if (!candidate) {
            if (intentId)
                throw new Error("source HEAD is not an exact authenticated signed Prep candidate");
            return undefined;
        }
        await assertAuthority();
        return lifecycle.recordMergeIntegration(owner.intentId, record.merge_id, candidate.revision, assertAuthority);
    }
    async back(args) {
        this.session(args.session_id);
        safeId(args.merge_id);
        return this.lock(args.merge_id, args.session_id, async (assertOperation) => {
            let record = await this.read(args.merge_id);
            this.match(record, args);
            if (!["ready", "integrating", "merged"].includes(record.state) || !record.ready_inputs)
                throw new Error("Merge Back requires a successful current ready Merge Prep");
            if (record.state === "merged") {
                await this.assertHistoricalMerge(record);
                if (record.cleanup?.removed_worktrees.length && record.cleanup.retained_worktrees.length === 0)
                    return this.output(record, true);
                return this.cleanupMergedChain(record, assertOperation);
            }
            record = await this.finalizeSelected(record, args.finalization, assertOperation);
            record = await this.resources(record, async (assertResources) => {
                await assertOperation();
                await assertResources();
                if (record.state !== "merged") {
                    const inputs = await captureInputs(record.source_worktree, record.captured_policy);
                    const retained = await this.associateBookkeepingInputs(record, inputs);
                    if (!retained)
                        throw new Error("merge prep product or dependency inputs changed; readiness is stale; continue the same Merge Prep");
                    if (digest(retained) !== digest(record))
                        record = await this.update(retained);
                }
                const targetHead = await git(["rev-parse", "HEAD"], record.target_worktree), sourceHead = this.deliveryInputs(record).source.head;
                await this.assertReady(record, targetHead === sourceHead);
                if (targetHead === sourceHead)
                    return this.update({ ...record, state: "merged", integrated_head: sourceHead });
                record = await this.update({ ...record, state: "integrating" });
                await assertOperation();
                await assertResources();
                await this.assertReady(record);
                // git() isolates hooks, external configuration, filters and ambient Git redirection.
                await git(["merge", "--ff-only", sourceHead], record.target_worktree);
                await this.assertReady(record, true);
                record = await this.update({ ...record, state: "merged", integrated_head: sourceHead });
                return record;
            });
            // Release integration resources before taking independent, exact cleanup guards.
            return this.cleanupMergedChain(record, assertOperation);
        });
    }
    async status(args) {
        this.session(args.session_id);
        const record = await this.read(safeId(args.merge_id));
        this.match(record, args);
        const operation_lease = await this.operationLeaseStatus(record);
        if (record.state === "merged") {
            try {
                await this.assertHistoricalMerge(record);
                return { ...this.output(record, true), operation_lease };
            }
            catch (error) {
                return { ...this.output(record, false), stale_reason: error.message, operation_lease };
            }
        }
        if (["ready", "integrating", "merged"].includes(record.state)) {
            try {
                await this.assertReady(record, await git(["rev-parse", "HEAD"], record.target_worktree) === this.deliveryInputs(record)?.source.head);
                return { ...this.output(record, true), operation_lease };
            }
            catch (error) {
                return { ...this.output(record, false), stale_reason: error.message, operation_lease };
            }
        }
        return { ...this.output(record, false), operation_lease };
    }
    async assertHistoricalMerge(record) {
        const source = this.deliveryInputs(record)?.source;
        if (!source || record.integrated_head !== source.head || record.gates.length !== record.scopes.length ||
            record.gates.some((gate, index) => gate.exitCode !== 0 || gate.scope !== record.scopes[index] || gate.commandSha256 !== hash(record.captured_policy.commands[gate.scope])))
            throw new Error("signed merged operation has no complete integration proof");
        const lookup = await this.historicalRepository(record);
        const targetHead = await git(["rev-parse", "--verify", `refs/heads/${record.target_branch}^{commit}`], lookup);
        if (!await ancestor(source.head, targetHead, lookup))
            throw new Error("integrated commit is no longer retained by the target");
        for (const root of record.cleanup?.removed_worktrees ?? []) {
            const registration = await readWorktreeRegistration(this.dataRoot, record.target_binding.commonGitDir, root);
            if (!registration)
                throw new Error("removed worktree creation record is missing");
            const completionHead = record.cleanup?.removed_heads?.[root] ?? (samePath(root, record.source_worktree) ? source.head : await this.cleanedHead(record, root));
            if (!completionHead || !await readWorktreeCleanupCompletion(this.dataRoot, registration, completionHead))
                throw new Error("removed worktree has no authenticated proof retention receipt");
        }
    }
    async historicalRepository(record) {
        try {
            await lstat(record.target_worktree);
            await assertWorktreeBinding(record.target_worktree, record.target_branch, record.target_binding.commonGitDir, undefined, false, record.target_binding.gitDir);
            return record.target_worktree;
        }
        catch (error) {
            if (error.code !== "ENOENT")
                throw error;
            const registration = await readWorktreeRegistration(this.dataRoot, record.target_binding.commonGitDir, record.target_worktree);
            if (!registration || registration.branch !== record.target_branch || !samePath(registration.git_dir, record.target_binding.gitDir))
                throw new Error("historical merge target is missing without its registered identity");
            const retained = await retainedWorktreeHead(this.dataRoot, registration);
            if (!retained)
                throw new Error("historical merge target has no authenticated cleanup receipt");
            const primary = await primaryRepositoryRoot(registration.project_root, registration.common_git_dir);
            const branchHead = await git(["rev-parse", "--verify", `refs/heads/${record.target_branch}^{commit}`], primary);
            if (!await ancestor(retained, branchHead, primary))
                throw new Error("retired merge target branch lost its retained head");
            return primary;
        }
    }
    async cleanedHead(record, root) {
        const candidates = await this.cleanupCandidates(record);
        return candidates.find(candidate => samePath(candidate.registration.worktree_path, root))?.head;
    }
    async compactEvidence(record) {
        const selected = [];
        for (const [role, relative] of Object.entries(record.captured_policy.artifactPaths ?? {})) {
            if (role === "build") {
                if (/\.(json|jsonl|xml|txt|log|md)$/i.test(relative))
                    selected.push(relative);
                continue;
            }
            const required = role === "smoke" && record.scopes.includes("feature-smoke") || role === "visual" && record.captured_policy.visualRequired;
            if (required)
                selected.push(relative);
            else {
                try {
                    await lstat(path.join(record.source_worktree, relative));
                    selected.push(relative);
                }
                catch (error) {
                    if (error.code !== "ENOENT")
                        throw error;
                }
            }
        }
        return selected;
    }
    async cleanupCandidates(record) {
        const common = record.source_binding.commonGitDir, candidates = new Map();
        const add = async (root, head, evidencePaths = [], outputRoots = []) => {
            const registration = await readWorktreeRegistration(this.dataRoot, common, root);
            if (!registration)
                return;
            const key = storageRegistrationId(common, root), existing = candidates.get(key);
            if (existing && existing.head !== head && !samePath(root, record.source_worktree))
                existing.retentionReason = "predecessor has conflicting completed heads; preserve its ambiguous checkout";
            if (!existing)
                candidates.set(key, { registration, head, evidencePaths, outputRoots });
        };
        await add(record.source_worktree, this.deliveryInputs(record).source.head, await this.compactEvidence(record), Object.values(record.captured_policy.outputRetention?.roots ?? {}).flat());
        if (!candidates.size)
            return [];
        const names = await directoryNames(path.join(this.dataRoot, "merge-revisions"));
        const ids = [...new Set(names.map(name => /^(.*)-0\.json$/.exec(name)?.[1]).filter((id) => Boolean(id)))];
        const merged = [];
        for (const id of ids) {
            const previous = await this.read(id);
            if (previous.state === "merged" && samePath(previous.source_binding.commonGitDir, common))
                merged.push(previous);
        }
        const lookup = await this.historicalRepository(record);
        for (let index = 0; index < candidates.size; index++) {
            if (candidates.size > 256)
                throw new Error("worktree chain exceeds the bounded cleanup graph");
            const candidate = [...candidates.values()][index], parent = candidate.registration.parent_worktree;
            if (parent) {
                const registration = await readWorktreeRegistration(this.dataRoot, common, parent.worktree_path);
                if (!registration || storageRegistrationId(common, parent.worktree_path) !== parent.registration_id || registration.branch !== parent.branch || !samePath(registration.git_dir, parent.git_dir))
                    throw new Error("worktree predecessor registration diverged");
                await add(parent.worktree_path, parent.head);
            }
            for (const previous of merged)
                if (samePath(previous.target_worktree, candidate.registration.worktree_path)) {
                    const previousHead = previous.integrated_head;
                    if (previousHead && await ancestor(previousHead, candidate.head, lookup))
                        await add(previous.source_worktree, previousHead, await this.compactEvidence(previous), Object.values(previous.captured_policy.outputRetention?.roots ?? {}).flat());
                }
        }
        return [...candidates.values()];
    }
    async cleanupMergedChain(record, assertOperation) {
        let cleanup;
        try {
            const candidates = await this.cleanupCandidates(record);
            cleanup = candidates.length ? await cleanupRegisteredWorktrees(this.dataRoot, await this.historicalRepository(record), candidates, assertOperation) :
                { removed_worktrees: [], retained_worktrees: [{ worktree: record.source_worktree, reason: "legacy or unregistered worktree; automatic cleanup applies only to new creation records" }] };
        }
        catch (error) {
            cleanup = { removed_worktrees: record.cleanup?.removed_worktrees ?? [], retained_worktrees: [{ worktree: record.source_worktree, reason: error.message }] };
        }
        await assertOperation();
        if (digest(cleanup) !== digest(record.cleanup ?? null))
            record = await this.update({ ...record, cleanup });
        return this.output(record, true);
    }
    async operationLeaseStatus(record) {
        const leaseId = hash(`merge-operation\0${record.merge_id}`), operation = await readAuthorizedLeaseState(this.dataRoot, leaseId);
        if (!operation)
            return { state: "absent" };
        const lease = operation.payload;
        this.assertMergeLease(lease, record.merge_id, record.session_id, "integration");
        const { owner, reason } = this.leaseOwnerStatus(lease);
        if (operation.state === "released")
            return { state: "released", owner };
        return {
            state: "held", owner,
            recovery: {
                next_tool: "captain_recover_merge_lease",
                args: { merge_id: record.merge_id, session_id: record.session_id, source_worktree: record.source_worktree, target_worktree: record.target_worktree, target_branch: record.target_branch, expected_revision: record.revision, expected_lease_token: lease.leaseToken },
                eligible: owner.state === "stopped" && !this.activeOperations.has(leaseId),
                requires_owner_stop_verification: owner.state === "legacy",
                reason: this.activeOperations.has(leaseId) ? "merge operation is active in this process; recovery is refused" : reason,
            },
        };
    }
    async recoverStaleLease(args) {
        this.session(args.session_id);
        safeId(args.merge_id);
        const leaseId = hash(`merge-operation\0${args.merge_id}`);
        if (this.activeOperations.has(leaseId))
            throw new Error("merge operation is active in this process and cannot be recovered");
        const record = await this.read(args.merge_id);
        this.match(record, args);
        if (record.revision !== args.expected_revision)
            throw new Error("signed merge revision changed; refresh status before recovery");
        const operation = await readAuthorizedLeaseState(this.dataRoot, leaseId);
        if (!operation)
            throw new Error("signed merge operation lease history was not found");
        const lease = operation.payload;
        this.assertMergeLease(lease, args.merge_id, args.session_id, "integration");
        if (lease.leaseToken !== args.expected_lease_token)
            throw new Error("merge lease generation owner or token mismatch");
        if (operation.state === "held") {
            if (this.activeOperations.has(leaseId))
                throw new Error("merge operation is active in this process and cannot be recovered");
        }
        this.assertLeaseOwnerStopped(lease, args.confirm_owner_stopped);
        const resources = [];
        const lifecycle = new LifecycleStore(this.dataRoot, this.runner), active = (await lifecycle.doctor()).activeRuns;
        if (active.some(owner => samePath(owner.worktreePath, record.target_worktree)))
            throw new Error("target worktree has an unfinished Captain owner; stale merge resources cannot be recovered");
        const sourceOwners = active.filter(owner => samePath(owner.worktreePath, record.source_worktree));
        if (sourceOwners.length > 1 || sourceOwners.some(owner => owner.sessionId !== record.session_id || owner.branch !== record.source_binding.branch))
            throw new Error("source Captain owner differs from the signed merge identity");
        for (const owner of sourceOwners) {
            const current = await lifecycle.status(owner.intentId);
            if (current.status !== "paused" || current.branch !== record.source_binding.branch || !samePath(current.commonGitDir, record.source_binding.commonGitDir) || !samePath(current.gitDir, record.source_binding.gitDir))
                throw new Error("source Captain owner must be paused and match the signed merge binding before stale integration resources can be recovered");
            const id = hash(`worktree-mutation\0${current.runId}`), fence = await this.readHeldLease(id);
            if (fence) {
                this.assertMergeLease(fence, args.merge_id, args.session_id, "integration-worktree");
                this.assertLeaseOwnerStopped(fence, args.confirm_owner_stopped);
                resources.push({ id, payload: fence });
            }
        }
        for (const binding of [record.source_binding, record.target_binding]) {
            const id = resourceId(binding.commonGitDir, binding.branch), existing = await this.readHeldLease(id);
            if (!existing)
                continue;
            if (existing.intentId === args.merge_id) {
                this.assertMergeLease(existing, args.merge_id, args.session_id, "integration-branch");
                if (!samePath(existing.commonGitDir, binding.commonGitDir) || existing.targetBranch !== binding.branch || existing.targetOid !== binding.head)
                    throw new Error("stale integration branch lease differs from the pinned merge binding");
                this.assertLeaseOwnerStopped(existing, args.confirm_owner_stopped);
                resources.push({ id, payload: existing });
            }
            else {
                const owner = sourceOwners.find(candidate => candidate.intentId === existing.intentId);
                if (binding !== record.source_binding || !owner)
                    throw new Error("a branch lease is owned by another Captain operation; preserve it");
                const fullOwner = await lifecycle.status(owner.intentId);
                if (fullOwner.sessionId !== args.session_id || !samePath(fullOwner.worktreePath, record.source_worktree) || fullOwner.branch !== binding.branch || fullOwner.leaseId !== id || fullOwner.leaseToken !== existing.leaseToken)
                    throw new Error("a branch lease is owned by another Captain operation; preserve it");
            }
        }
        const targetIntegrated = !!record.ready_inputs && await git(["rev-parse", "HEAD"], record.target_worktree) === record.ready_inputs.source.head;
        await this.bindings(record, targetIntegrated);
        const latest = await this.read(args.merge_id);
        this.match(latest, args);
        if (latest.revision !== args.expected_revision)
            throw new Error("signed merge revision changed during recovery; refresh status");
        for (const resource of resources)
            await releaseAuthorizedLease(this.dataRoot, resource.id, args.merge_id, resource.payload.leaseToken);
        if (operation.state === "held")
            await releaseAuthorizedLease(this.dataRoot, leaseId, args.merge_id, args.expected_lease_token);
        return { merge_id: args.merge_id, released: true, released_resource_leases: resources.length, merge_revision: args.expected_revision, resumed_operation: "reuse captain_merge_prep or captain_merge_back with the same merge_id" };
    }
    assertMergeLease(lease, id, session, operation) {
        if (lease.intentId !== id || lease.sessionId !== session || lease.operation !== operation || typeof lease.leaseToken !== "string")
            throw new Error("merge lease generation owner or operation mismatch");
    }
    assertLeaseOwnerStopped(lease, confirmed) {
        const { owner, reason } = this.leaseOwnerStatus(lease);
        if (owner.state === "stopped" || (owner.state === "legacy" && confirmed === true))
            return;
        throw new Error(reason);
    }
    leaseOwnerStatus(lease) {
        const metadata = { ...(typeof lease.ownerPid === "number" ? { pid: lease.ownerPid } : {}), ...(typeof lease.ownerHost === "string" ? { host: lease.ownerHost } : {}) };
        if (lease.ownerPid === undefined && lease.ownerHost === undefined)
            return { owner: { state: "legacy" }, reason: "legacy merge lease has no process metadata; independently verify and confirm that its owner is stopped" };
        if (!Number.isSafeInteger(lease.ownerPid) || lease.ownerPid <= 0 || typeof lease.ownerHost !== "string" || !lease.ownerHost.trim())
            return { owner: { ...metadata, state: "unknown" }, reason: "merge lease owner process metadata is invalid; recovery refused" };
        if (lease.ownerHost.toLowerCase() !== os.hostname().toLowerCase())
            return { owner: { ...metadata, state: "foreign_host" }, reason: "merge lease owner is on another host and cannot be verified locally" };
        try {
            process.kill(lease.ownerPid, 0);
        }
        catch (error) {
            if (error.code === "ESRCH")
                return { owner: { ...metadata, state: "stopped" }, reason: "merge lease owner process is stopped; owner verification permits recovery, which must still validate current worktree and resource bindings" };
            return { owner: { ...metadata, state: "unknown" }, reason: "merge lease owner process state is unknown; recovery refused" };
        }
        return { owner: { ...metadata, state: "live" }, reason: "merge lease owner process is still active; recovery refused" };
    }
    async readHeldLease(id) {
        try {
            return await readAuthorizedLease(this.dataRoot, id);
        }
        catch (error) {
            if (error.code === "ENOENT")
                return undefined;
            throw error;
        }
    }
    session(value) { if (!value?.trim())
        throw new Error("integration session_id is required"); }
    match(record, args) {
        if (record.session_id !== args.session_id)
            throw new Error("signed merge session ownership mismatch");
        if ((args.source_worktree && !samePath(record.source_worktree, args.source_worktree)) || (args.target_worktree && !samePath(record.target_worktree, args.target_worktree)) || (args.target_branch && record.target_branch !== args.target_branch))
            throw new Error("signed merge source/target identity does not match this request");
    }
    output(record, receipt_valid) { return { ...record, ...(receipt_valid === undefined ? {} : { receipt_valid }), captain_green: false }; }
    async bindings(record, targetIntegrated) {
        await assertWorktreeBinding(record.source_worktree, record.source_binding.branch, record.source_binding.commonGitDir, undefined, false, record.source_binding.gitDir);
        await assertWorktreeBinding(record.target_worktree, record.target_branch, record.target_binding.commonGitDir, targetIntegrated ? this.deliveryInputs(record)?.source.head : record.target_binding.head, true, record.target_binding.gitDir);
    }
    async assertInputs(record, expected) { if (digest(await captureInputs(record.source_worktree, record.captured_policy)) !== digest(expected))
        throw new Error("merge prep source or dependency inputs changed; readiness is stale"); }
    async assertReady(record, targetIntegrated = false) {
        if (!record.ready_inputs || record.gates.length !== record.scopes.length || record.gates.some((gate, index) => gate.exitCode !== 0 || gate.scope !== record.scopes[index] || gate.commandSha256 !== hash(record.captured_policy.commands[gate.scope])))
            throw new Error("signed Merge Prep has no complete ready gate receipt");
        await this.bindings(record, targetIntegrated);
        await assertNoOperation(record.source_worktree);
        await assertNoOperation(record.target_worktree);
        await this.assertInputs(record, this.deliveryInputs(record));
        if (!await ancestor(record.target_binding.head, this.deliveryInputs(record).source.head, record.source_worktree))
            throw new Error("prepared source no longer contains the pinned target");
    }
    deliveryInputs(record) { return record.integration_inputs ?? record.ready_inputs; }
    /** Rules captured by Prep can excuse records, never new product or dependency inputs. */
    async associateBookkeepingInputs(record, inputs) {
        const tested = record.ready_inputs;
        if (!tested)
            return undefined;
        const current = this.deliveryInputs(record);
        if (digest(inputs) === digest(current))
            return record;
        const policy = record.captured_policy.commit;
        if (!policy?.bookkeeping || !tested.source.productManifest || !inputs.source.productManifest ||
            tested.source.productManifest !== inputs.source.productManifest || tested.metadata !== inputs.metadata ||
            digest(tested.dependencies) !== digest(inputs.dependencies) || inputs.source.status ||
            digest([tested.source.branch, tested.source.commonGitDir, tested.source.gitDir, tested.source.topLevel]) !==
                digest([inputs.source.branch, inputs.source.commonGitDir, inputs.source.gitDir, inputs.source.topLevel]) ||
            !await bookkeepingHistoryValid(record.source_worktree, tested.source.head, inputs.source.head, policy))
            return undefined;
        return { ...record, integration_inputs: inputs, bookkeeping_extensions: [...(record.bookkeeping_extensions ?? []),
                { kind: "source", from_head: current.source.head, to_head: inputs.source.head }] };
    }
    async advanceBookkeepingTarget(record) {
        const before = record.target_binding, actual = await assertWorktreeBinding(record.target_worktree, record.target_branch, before.commonGitDir, undefined, true, before.gitDir);
        if (actual.head === before.head)
            return record;
        const policy = record.captured_policy.commit;
        if (!policy?.bookkeeping || !await bookkeepingHistoryValid(record.target_worktree, before.head, actual.head, policy))
            throw new Error("pinned target changed beyond bookkeeping; start fresh Merge Prep for the product inputs");
        return this.update({ ...record, target_binding: actual, bookkeeping_extensions: [...(record.bookkeeping_extensions ?? []),
                { kind: "target", from_head: before.head, to_head: actual.head }] });
    }
    async finalizeSelected(record, requested, assertOperation) {
        if (!requested && !record.finalization_requests)
            return record;
        if (!record.captured_policy.commit?.bookkeeping)
            throw new Error("bookkeeping finalization requires captured captain.ignore opt-in");
        for (const side of ["source", "target"]) {
            const binding = side === "source" ? record.source_binding : record.target_binding;
            const worktree = side === "source" ? record.source_worktree : record.target_worktree;
            if (requested?.[side] || record.finalization_requests?.[side])
                await assertWorktreeBinding(worktree, binding.branch, binding.commonGitDir, undefined, false, binding.gitDir);
            let pending = record.finalization_requests?.[side];
            const selection = requested?.[side];
            if (pending && !selection && !record.finalizations?.some(receipt => receipt.finalization_id === pending.selection.finalization_id)
                && !await new BookkeepingFinalizationStore(this.dataRoot).hasStarted({ finalization_id: pending.selection.finalization_id, session_id: record.session_id, worktree })
                && await git(["rev-parse", "HEAD"], worktree) === pending.expected_head && !await git(["status", "--porcelain"], worktree)) {
                await assertOperation();
                record = await this.retireFinalizationRequest(record, side);
                pending = undefined;
            }
            if (pending && selection && record.finalizations?.some(receipt => receipt.finalization_id === pending.selection.finalization_id)) {
                const worktree = side === "source" ? record.source_worktree : record.target_worktree;
                const dirty = Boolean(await git(["status", "--porcelain"], worktree));
                if (dirty && selection.finalization_id === pending.selection.finalization_id)
                    throw new Error("completed finalization id cannot consume new dirty records; omit the id for a new generation");
                if (dirty || selection.finalization_id && selection.finalization_id !== pending.selection.finalization_id)
                    pending = undefined;
            }
            if (pending && selection && digest({ ...selection, finalization_id: selection.finalization_id ?? pending.selection.finalization_id }) !== digest(pending.selection) &&
                !await new BookkeepingFinalizationStore(this.dataRoot).hasStarted({ finalization_id: pending.selection.finalization_id, session_id: record.session_id, worktree }))
                pending = undefined;
            if (pending && selection && (selection.finalization_id && selection.finalization_id !== pending.selection.finalization_id || digest({ ...selection, finalization_id: pending.selection.finalization_id }) !== digest(pending.selection)))
                throw new Error("merge finalization recovery requires the same signed selection");
            if (!pending && selection) {
                const worktree = side === "source" ? record.source_worktree : record.target_worktree;
                const actualHead = await git(["rev-parse", "HEAD"], worktree);
                const expected = side === "source" ? this.deliveryInputs(record)?.source.head : record.target_binding.head;
                if (expected && actualHead !== expected && !await bookkeepingHistoryValid(worktree, expected, actualHead, record.captured_policy.commit))
                    throw new Error("finalization cannot adopt changed product HEAD; continue Merge Prep");
                pending = { selection: { ...selection, finalization_id: selection.finalization_id ?? `finalization-${record.merge_id}-${side}-${record.revision}` }, expected_head: actualHead };
                record = await this.update({ ...record, finalization_requests: { ...record.finalization_requests, [side]: pending } });
            }
            if (!pending || record.finalizations?.some(receipt => receipt.finalization_id === pending.selection.finalization_id))
                continue;
            await assertOperation();
            let receipt;
            try {
                receipt = await new BookkeepingFinalizationStore(this.dataRoot).finalize({ ...pending.selection,
                    session_id: record.session_id, worktree: side === "source" ? record.source_worktree : record.target_worktree }, { policy: record.captured_policy, expected_head: pending.expected_head, expected_binding: binding });
            }
            catch (error) {
                if (!await new BookkeepingFinalizationStore(this.dataRoot).hasStarted({ finalization_id: pending.selection.finalization_id, session_id: record.session_id, worktree })) {
                    await assertOperation();
                    record = await this.retireFinalizationRequest(record, side);
                }
                throw error;
            }
            await assertOperation();
            record = await this.update({ ...record, finalizations: [...(record.finalizations ?? []), receipt] });
        }
        return record;
    }
    async retireFinalizationRequest(record, side) {
        const requests = { ...record.finalization_requests };
        delete requests[side];
        return this.update({ ...record, finalization_requests: Object.keys(requests).length ? requests : undefined });
    }
    assertRecordContinuity(current, previous) {
        const identity = (r) => [r.session_id, r.source_worktree, r.target_worktree, r.target_branch,
            r.source_binding, { ...r.target_binding, head: undefined }, r.policy_sha256, r.captured_policy, r.strictness, r.scopes];
        if (digest(identity(current)) !== digest(identity(previous)))
            throw new Error("signed merge identity or policy changed between revisions");
        if (current.target_binding.head !== previous.target_binding.head) {
            const oldExtensions = previous.bookkeeping_extensions ?? [], newExtensions = current.bookkeeping_extensions ?? [];
            const extension = newExtensions.at(-1);
            if (!current.captured_policy.commit?.bookkeeping || newExtensions.length !== oldExtensions.length + 1 ||
                digest(newExtensions.slice(0, -1)) !== digest(oldExtensions) || extension?.kind !== "target" ||
                extension.from_head !== previous.target_binding.head || extension.to_head !== current.target_binding.head)
                throw new Error("signed target changed without a bookkeeping association");
        }
    }
    async lock(id, session, action) {
        const leaseId = hash(`merge-operation\0${id}`), leaseToken = randomUUID(), payload = { intentId: id, leaseToken, sessionId: session, operation: "integration", ownerPid: process.pid, ownerHost: os.hostname() };
        if (this.activeOperations.has(leaseId))
            throw new Error("merge operation is already active in this process");
        this.activeOperations.add(leaseId);
        try {
            await acquireAuthorizedLease(this.dataRoot, leaseId, payload);
            try {
                return await action(async () => { if (digest(await readAuthorizedLease(this.dataRoot, leaseId)) !== digest(payload))
                    throw new Error("integration operation lease ownership changed"); });
            }
            finally {
                await releaseAuthorizedLease(this.dataRoot, leaseId, id, leaseToken);
            }
        }
        finally {
            this.activeOperations.delete(leaseId);
        }
    }
    async resources(record, action) {
        const held = [];
        try {
            const lifecycle = new LifecycleStore(this.dataRoot, this.runner), active = (await lifecycle.doctor()).activeRuns;
            if (active.some(owner => samePath(owner.worktreePath, record.target_worktree)))
                throw new Error("target worktree has an unfinished Captain owner; preserve that task before integrating");
            const sourceOwners = active.filter(owner => samePath(owner.worktreePath, record.source_worktree));
            if (sourceOwners.length > 1 || sourceOwners.some(owner => owner.sessionId !== record.session_id))
                throw new Error("source worktree belongs to another active Captain session owner");
            const reserveFence = async (owner) => {
                if (owner.sessionId !== record.session_id)
                    throw new Error("source Captain session ownership changed before its mutation fence");
                if (owner.branch !== record.source_binding.branch || !samePath(owner.commonGitDir, record.source_binding.commonGitDir) || !samePath(owner.gitDir, record.source_binding.gitDir))
                    throw new Error("source Captain owner Git binding diverged");
                const fenceId = hash(`worktree-mutation\0${owner.runId}`);
                if (held.some(lease => lease.id === fenceId))
                    return;
                const fence = { intentId: record.merge_id, leaseToken: randomUUID(), sessionId: record.session_id, operation: "integration-worktree", ownerPid: process.pid, ownerHost: os.hostname() };
                await acquireAuthorizedLease(this.dataRoot, fenceId, fence);
                held.push({ id: fenceId, payload: fence, borrowed: false });
            };
            for (const owner of sourceOwners)
                await reserveFence(await lifecycle.status(owner.intentId));
            for (const binding of [record.source_binding, record.target_binding].sort((a, b) => resourceId(a.commonGitDir, a.branch).localeCompare(resourceId(b.commonGitDir, b.branch)))) {
                const id = resourceId(binding.commonGitDir, binding.branch), payload = { intentId: record.merge_id, leaseToken: randomUUID(), sessionId: record.session_id, operation: "integration-branch", commonGitDir: binding.commonGitDir, targetBranch: binding.branch, targetOid: binding.head, ownerPid: process.pid, ownerHost: os.hostname() };
                let existing;
                try {
                    existing = await readAuthorizedLease(this.dataRoot, id);
                }
                catch (error) {
                    if (error.code !== "ENOENT")
                        throw error;
                }
                if (existing) {
                    if (binding.branch !== record.source_binding.branch)
                        throw new Error("target branch is already leased by another Captain operation");
                    const owner = await lifecycle.status(existing.intentId);
                    if (owner.sessionId !== record.session_id || !samePath(owner.worktreePath, record.source_worktree) || owner.branch !== binding.branch || owner.leaseId !== id || owner.leaseToken !== existing.leaseToken)
                        throw new Error("source branch lease belongs to another session or worktree owner");
                    held.push({ id, payload: existing, borrowed: true });
                    await reserveFence(owner);
                }
                else {
                    await acquireAuthorizedLease(this.dataRoot, id, payload);
                    held.push({ id, payload, borrowed: false });
                }
            }
            return await action(async () => { for (const lease of held)
                if (digest(await readAuthorizedLease(this.dataRoot, lease.id)) !== digest(lease.payload))
                    throw new Error("source or target branch lease ownership changed before integration mutation"); });
        }
        finally {
            for (const lease of held.reverse())
                if (!lease.borrowed)
                    await releaseAuthorizedLease(this.dataRoot, lease.id, lease.payload.intentId, lease.payload.leaseToken);
        }
    }
    async initial(record) {
        const stored = await putAuthorizedOnceExact(this.dataRoot, "merge-revisions", `${record.merge_id}-0`, record);
        try {
            await this.watermark(stored);
            return stored;
        }
        catch (error) {
            throw new MergeWorkflowError(stored.merge_id, error);
        }
    }
    async update(record) {
        const current = await this.read(record.merge_id);
        if (current.revision !== record.revision)
            throw new Error("signed merge workflow changed concurrently");
        const next = JSON.parse(JSON.stringify({ ...record, revision: current.revision + 1, previous_sha256: digest(current) }));
        const stored = await putAuthorizedOnceExact(this.dataRoot, "merge-revisions", `${record.merge_id}-${next.revision}`, next);
        await this.watermark(stored);
        return stored;
    }
    async watermark(record) { await putAuthorizedOnceExact(this.dataRoot, "merge-watermarks", `${record.merge_id}-${record.revision}`, { merge_id: record.merge_id, revision: record.revision, sha256: digest(record) }); }
    /** Verify existing history and watermarks; never repair a checkpoint while diagnosing. */
    async readForDiagnosis(id, names, watermarkNames) {
        safeId(id);
        const expression = new RegExp(`^${id}-([0-9]+)\\.json$`), revisions = names.map(name => expression.exec(name)).filter(Boolean).map(match => Number(match[1])).sort((a, b) => a - b);
        if (!revisions.length)
            throw new Error("signed merge revision tail regressed behind its watermark");
        let previous;
        for (let index = 0; index < revisions.length; index++) {
            if (revisions[index] !== index)
                throw new Error("signed merge revision chain is not contiguous");
            const current = await readAuthorizedReadOnly(this.dataRoot, "merge-revisions", `${id}-${index}`);
            if (current.schema_version !== 1 || current.merge_id !== id || current.revision !== index || (previous ? current.previous_sha256 !== digest(previous) : current.previous_sha256 !== undefined))
                throw new Error("signed merge revision binding is invalid");
            if (typeof current.session_id !== "string" || !current.session_id.trim() || typeof current.source_worktree !== "string" || typeof current.target_worktree !== "string" || typeof current.target_branch !== "string" || !["preparing", "needs_resolution", "needs_commit", "verifying", "failed", "ready", "integrating", "merged"].includes(current.state))
                throw new Error("signed merge identity/state is invalid");
            if (previous)
                this.assertRecordContinuity(current, previous);
            if (!watermarkNames.includes(`${id}-${index}.json`))
                throw new Error("signed merge watermark is missing");
            const watermark = await readAuthorizedReadOnly(this.dataRoot, "merge-watermarks", `${id}-${index}`);
            if (watermark.merge_id !== id || watermark.revision !== index || watermark.sha256 !== digest(current))
                throw new Error("signed merge watermark binding is invalid");
            previous = current;
        }
        if (watermarkNames.some(name => { const match = expression.exec(name); return match && Number(match[1]) > previous.revision; }))
            throw new Error("signed merge revision tail regressed behind its monotonic watermark");
        return previous;
    }
    async read(id) {
        safeId(id);
        const expression = new RegExp(`^${id}-([0-9]+)\\.json$`), names = await readdir(path.join(this.dataRoot, "merge-revisions")), revisions = names.map(name => expression.exec(name)).filter(Boolean).map(match => Number(match[1])).sort((a, b) => a - b);
        if (!revisions.length)
            throw new Error("signed merge workflow was not found");
        let previous;
        for (let index = 0; index < revisions.length; index++) {
            if (revisions[index] !== index)
                throw new Error("signed merge revision chain is not contiguous");
            const current = await readAuthorized(this.dataRoot, "merge-revisions", `${id}-${index}`);
            if (current.schema_version !== 1 || current.merge_id !== id || current.revision !== index || (previous ? current.previous_sha256 !== digest(previous) : current.previous_sha256 !== undefined))
                throw new Error("signed merge revision binding is invalid");
            if (previous)
                this.assertRecordContinuity(current, previous);
            await this.watermark(current);
            previous = current;
        }
        const watermarkNames = await readdir(path.join(this.dataRoot, "merge-watermarks"));
        if (watermarkNames.some(name => { const match = expression.exec(name); return match && Number(match[1]) > previous.revision; }))
            throw new Error("signed merge revision tail regressed behind its monotonic watermark");
        return previous;
    }
}
const lines = (value) => value.split(/\r?\n/).filter(Boolean);
async function directoryNames(directory) { try {
    return await readdir(directory);
}
catch (error) {
    if (error.code === "ENOENT")
        return [];
    throw error;
} }
async function readOnlyBinding(worktree, expectedBranch, expectedCommonGitDir) {
    const owned = path.resolve(worktree), real = await realpath(owned);
    if (!samePath(real, owned))
        throw new Error("worktree path resolves through a reparse point");
    const readGit = (args) => git(["--no-optional-locks", ...args], owned);
    const topLevel = path.resolve(await readGit(["rev-parse", "--show-toplevel"]));
    if (!samePath(topLevel, owned))
        throw new Error("Git top-level does not match the requested worktree");
    const branch = await readGit(["symbolic-ref", "--quiet", "--short", "HEAD"]);
    if (!branch || (expectedBranch !== undefined && branch !== expectedBranch))
        throw new Error("worktree symbolic target branch binding diverged");
    const commonGitDir = path.resolve(await readGit(["rev-parse", "--path-format=absolute", "--git-common-dir"])), gitDir = path.resolve(await readGit(["rev-parse", "--path-format=absolute", "--git-dir"]));
    if (expectedCommonGitDir && !samePath(commonGitDir, expectedCommonGitDir))
        throw new Error("worktree common Git repository binding diverged");
    const head = await readGit(["rev-parse", "--verify", "HEAD^{commit}"]);
    if (head !== await readGit(["rev-parse", "--verify", `refs/heads/${branch}^{commit}`]))
        throw new Error("worktree branch ref binding diverged");
    return { branch, commonGitDir, gitDir, topLevel, head };
}
async function optionalGit(args, cwd) { try {
    return await git(args, cwd);
}
catch {
    return undefined;
} }
async function ancestor(before, after, cwd) { try {
    await git(["merge-base", "--is-ancestor", before, after], cwd);
    return true;
}
catch (error) {
    if (error.code === 1)
        return false;
    throw error;
} }
async function assertNoOperation(cwd, allowMerge = false) {
    for (const name of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "REBASE_HEAD", "BISECT_START", "rebase-merge", "rebase-apply", "sequencer"]) {
        if (name === "MERGE_HEAD" && allowMerge)
            continue;
        const file = await git(["rev-parse", "--path-format=absolute", "--git-path", name], cwd);
        try {
            await lstat(file);
            throw new Error(`preexisting Git operation ${name} must be resolved by its owner`);
        }
        catch (error) {
            if (error.code !== "ENOENT")
                throw error;
        }
    }
}
async function committedFile(cwd, head, relative) {
    const listing = await git(["ls-tree", head, "--", relative], cwd);
    if (!listing)
        return undefined;
    if (!/^100(?:644|755) blob /.test(listing))
        throw new Error(`trusted merge input must be a regular tracked file: ${relative}`);
    const text = await git(["show", `${head}:${relative}`], cwd);
    if (Buffer.byteLength(text) > 1024 * 1024)
        throw new Error("trusted merge input exceeds bounded limit");
    return text;
}
function excluded(relative, policy) {
    const lower = relative.toLowerCase();
    return (policy.sourceManifestExcludes ?? []).some(item => lower === item.toLowerCase() || lower.startsWith(`${item.toLowerCase()}/`)) || (!relative.includes("/") && (policy.sourceManifestRootFileExcludes ?? []).some(item => item.startsWith("*.") ? lower.endsWith(item.slice(1).toLowerCase()) : lower === item.toLowerCase()));
}
async function metadataInputs(cwd, policy, volatilePaths) {
    const files = (await git(["ls-files", "--others", "-z"], cwd)).split("\0").filter(relative => relative.toLowerCase().endsWith(".meta") && !excluded(relative, policy) && !volatilePaths.has(relative.toLowerCase())).sort(), values = [];
    for (const relative of files) {
        const info = await lstat(path.join(cwd, relative));
        if (info.isSymbolicLink() || !info.isFile())
            throw new Error(`dependency metadata must be a regular file: ${relative}`);
        values.push(`${relative}:${hash(await readFile(path.join(cwd, relative)))}`);
    }
    return digest(values);
}
async function contentDigest(root, volatile = [], sharedPackage = false) {
    const values = [];
    const generated = new Set(["library", "temp", "logs", "artifacts", "obj", "bin", "node_modules"]);
    async function walk(full, relative) {
        const info = await lstat(full);
        if (info.isSymbolicLink())
            throw new Error(`dependency input crosses a reparse point: ${full}`);
        if (volatile.includes(relative))
            return;
        if (info.isDirectory()) {
            for (const entry of (await readdir(full, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
                if (entry.name === ".git" || (sharedPackage && !relative && generated.has(entry.name.toLowerCase())))
                    continue;
                await walk(path.join(full, entry.name), relative ? `${relative}/${entry.name}` : entry.name);
            }
        }
        else if (info.isFile())
            values.push(`${relative}:${hash(await readFile(full))}`);
        else
            throw new Error(`dependency input is not a regular file or directory: ${full}`);
    }
    await walk(root, "");
    return { sha256: digest(values), file_count: values.length };
}
async function captureInputs(cwd, policy) {
    const source = await sourceState(cwd, policy);
    if (source.status)
        throw new Error("merge prep source must be clean before verifying inputs");
    const dependencies = [], volatilePaths = new Set(), lockText = await committedFile(cwd, source.head, ".captain-sdlc/dependency-lock.json"), lock = lockText ? JSON.parse(lockText) : undefined;
    if (lock?.inputs !== undefined && !Array.isArray(lock.inputs))
        throw new Error("dependency lock inputs must be an array");
    for (const input of lock?.inputs ?? []) {
        const relative = relativePath(input.path), full = path.resolve(cwd, relative), volatile = (input.volatile_paths ?? []).map((item) => relativePath(item));
        for (const item of volatile)
            volatilePaths.add(`${relative}/${item}`.toLowerCase());
        if (!samePath(full, path.join(cwd, relative)) || path.relative(cwd, full).startsWith(".."))
            throw new Error("locked dependency escapes source worktree");
        if (!samePath(full, await realpath(full)))
            throw new Error(`locked dependency crosses a reparse point: ${relative}`);
        dependencies.push({ kind: "locked-input", path: relative, ...await contentDigest(full, volatile) });
    }
    const manifestText = await committedFile(cwd, source.head, "Packages/manifest.json");
    if (manifestText) {
        const manifest = JSON.parse(manifestText);
        for (const [name, spec] of Object.entries(manifest.dependencies ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
            if (typeof spec !== "string" || !spec.startsWith("file:"))
                continue;
            const supplied = spec.slice(5);
            if (!supplied || supplied.includes("\0"))
                throw new Error(`local dependency path is invalid: ${name}`);
            const full = path.resolve(path.join(cwd, "Packages"), supplied), canonical = await realpath(full);
            if (!samePath(full, canonical))
                throw new Error(`local dependency path crosses a reparse point: ${name}`);
            const info = await lstat(full);
            let gitState;
            const normalize = (value) => value.toLowerCase().replace(/[^a-z0-9]/g, "");
            const expected = (lock?.local_packages ?? []).find((entry) => normalize(name).endsWith(normalize(entry.name)));
            let ownGit = false;
            if (info.isDirectory()) {
                try {
                    await lstat(path.join(full, ".git"));
                    ownGit = true;
                }
                catch (error) {
                    if (error.code !== "ENOENT")
                        throw error;
                }
            }
            if (ownGit) {
                if (!samePath(await git(["rev-parse", "--show-toplevel"], full), full))
                    throw new Error(`local package Git identity diverged: ${name}`);
                const head = await git(["rev-parse", "HEAD"], full);
                gitState = { head, tree: await git(["rev-parse", "HEAD^{tree}"], full), status: await git(["status", "--porcelain"], full), indexSha256: hash(await git(["ls-files", "--stage", "-z"], full)) };
                if (expected && expected.source_commit !== head)
                    throw new Error(`Pinned shared local-package revision diverged: ${name}`);
            }
            else if (expected)
                throw new Error(`cannot verify pinned local-package revision without its Git identity: ${name}`);
            dependencies.push({ kind: info.isDirectory() ? "local-package" : "local-archive", name, path: full, ...(gitState ? { git: gitState } : {}), ...await contentDigest(full, [], info.isDirectory()) });
        }
    }
    const result = { source, metadata: await metadataInputs(cwd, policy, volatilePaths), dependencies };
    const after = await sourceState(cwd, policy);
    if (digest(after) !== digest(source))
        throw new Error("source changed during merge input capture");
    return result;
}
