import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { acquireAuthorizedLease, putAuthorizedOnceExact, readAuthorizedLeaseSnapshotReadOnly, readAuthorizedReadOnly, releaseAuthorizedLeaseAtGeneration } from "./authority.js";
import { bookkeepingCaptured, bookkeepingPathAllowed, bookkeepingSubjectAllowed, bookkeepingTextAllowed } from "./bookkeeping.js";
import { applyPreparedCommit, assertSafeGitAttributesInWorktree, assertWorktreeBinding, bookkeepingBlobAllowed, bookkeepingCommitValid, commitAtomic, git, loadPolicy, reconcilePreparedCommit, repositoryIdentity } from "./workspace.js";
export class BookkeepingFinalizationError extends Error {
    finalization_id;
    constructor(finalization_id, cause) {
        super(cause instanceof Error ? cause.message : String(cause), { cause });
        this.finalization_id = finalization_id;
        this.name = "BookkeepingFinalizationError";
    }
}
const hash = (text) => createHash("sha256").update(text).digest("hex");
const digest = (value) => hash(JSON.stringify(value));
const samePath = (left, right) => process.platform === "win32" ? path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase() : path.resolve(left) === path.resolve(right);
const idValue = (id) => { if (!/^[a-zA-Z0-9_-]+$/.test(id))
    throw new Error("unsafe finalization id"); return id; };
const records = (value) => value.split("\0").filter(Boolean);
const terminal = (record) => record.state === "committed" || record.state === "stashed";
const attemptOperations = new Set();
/** Independent bookkeeping ledger: product runs, acceptance and proof remain unchanged. */
export class BookkeepingFinalizationStore {
    dataRoot;
    hooks;
    constructor(dataRoot, hooks = {}) {
        this.dataRoot = dataRoot;
        this.hooks = hooks;
    }
    async finalize(args, options = {}) {
        const normalized = validateRequest(args), id = idValue(args.finalization_id ?? `finalization-${randomUUID()}`);
        try {
            return await this.attempt(id, normalized.session_id, async (assertAttempt) => {
                let record = await this.optionalRead(id);
                if (record) {
                    this.match(record, normalized, options);
                    await assertExpectedBinding(record.worktree, options.expected_binding ?? record.before);
                    if (terminal(record))
                        return record;
                }
                else {
                    const before = await assertExpectedBinding(normalized.worktree, options.expected_binding);
                    if (options.expected_head && before.head !== options.expected_head)
                        throw new Error("bookkeeping finalization expected HEAD changed before reservation");
                    await assertNoOperation(before.topLevel);
                    await repositoryIdentity(before.topLevel);
                    const policy = options.policy ?? await loadPolicy(before.topLevel, before.head);
                    if (!policy.commit || !bookkeepingCaptured(policy.commit))
                        throw new Error("bookkeeping finalization requires a committed opt-in captured policy");
                    await this.assertNoOwner(before, id);
                    await assertSelection(before.topLevel, normalized.paths, policy);
                    await assertSafeGitAttributesInWorktree(before.topLevel, normalized.paths);
                    const snapshot = await captureSnapshot(before.topLevel, normalized.paths), indexTree = await git(["write-tree"], before.topLevel);
                    await assertWorktreeBinding(before.topLevel, before.branch, before.commonGitDir, before.head, false, before.gitDir);
                    const leaseSpecs = [
                        { id: hash(`${path.resolve(before.commonGitDir)}\0refs/heads/${before.branch}`.toLowerCase()), token: randomUUID(), operation: "bookkeeping-branch" },
                        { id: hash(`bookkeeping-worktree\0${path.resolve(before.commonGitDir)}\0${path.resolve(before.gitDir)}`.toLowerCase()), token: randomUUID(), operation: "bookkeeping-worktree" },
                    ].sort((a, b) => a.id.localeCompare(b.id));
                    record = await this.initial({ schema_version: 1, finalization_id: id, revision: 0, ...normalized, state: "pending", request_sha256: digest(normalized), before, policy, policy_sha256: digest(policy), snapshot, index_tree: indexTree, lease_specs: leaseSpecs, stash_marker: `Captain bookkeeping ${id} ${randomUUID()}`, evidence: [{ kind: "snapshot_captured", at: new Date().toISOString() }] });
                }
                const original = record;
                return this.resources(record, async (generations) => {
                    record = await this.update({ ...record, lease_generations: generations, evidence: [...record.evidence, { kind: "resource_generations_acquired", generations }] });
                    const assertAuthority = async () => { await assertExpectedBinding(record.worktree, options.expected_binding ?? record.before); await assertAttempt(); await this.assertResources(record); await this.assertNoOwner(record.before, id); };
                    await assertAuthority();
                    await assertWorktreeBinding(record.worktree, record.before.branch, record.before.commonGitDir, undefined, false, record.before.gitDir);
                    await assertNoOperation(record.worktree);
                    if (record.disposition === "commit") {
                        if (record.prepared_commit) {
                            const prepared = record.prepared_commit, actualHead = await git(["rev-parse", "HEAD"], record.worktree);
                            if (actualHead === prepared.candidate)
                                await reconcilePreparedCommit(record.worktree, prepared, record.before.branch, record.before.commonGitDir, record.before.gitDir);
                            else if (actualHead === prepared.preCommitHead) {
                                await assertWorkingSnapshot(record);
                                await applyPreparedCommit(record.worktree, prepared, record.before.branch, record.before.commonGitDir, record.before.gitDir, async () => { await assertAuthority(); });
                            }
                            else
                                throw new Error("bookkeeping prepared commit recovery found a changed HEAD");
                        }
                        else {
                            await assertUnchanged(record);
                            await commitAtomic(record.worktree, record.paths, record.subject, "Completes", record.task_id, record.policy.commit, [], record.before.branch, record.before.commonGitDir, record.before.head, record.before.gitDir, async (prepared) => { await assertAuthority(); await assertWorkingSnapshot(record); record = await this.update({ ...record, state: "commit_prepared", prepared_commit: prepared, evidence: [...record.evidence, { kind: "commit_candidate_authorized", candidate: prepared.candidate, tree: prepared.tree }] }); }, undefined, this.hooks.afterCommitRefUpdate, async (prepared) => { await assertAuthority(); const signed = await this.read(id); if (digest(signed.prepared_commit) !== digest(prepared))
                                throw new Error("bookkeeping prepared candidate authority changed"); await assertWorkingSnapshot(record); });
                        }
                        const after = await assertWorktreeBinding(record.worktree, record.before.branch, record.before.commonGitDir, record.prepared_commit.candidate, true, record.before.gitDir);
                        if (!await bookkeepingCommitValid(record.worktree, record.before.head, after.head, record.subject, record.policy.commit))
                            throw new Error("bookkeeping actual commit delta violates captured policy");
                        await assertAuthority();
                        return this.update({ ...record, state: "committed", after, commit_oid: after.head, evidence: [...record.evidence, { kind: "bookkeeping_commit_retained", oid: after.head, runtime_proof_relabelled: false }] });
                    }
                    let stashOid = await findStash(record);
                    if (!stashOid) {
                        await assertUnchanged(record);
                        if (record.state !== "stash_prepared")
                            record = await this.update({ ...record, state: "stash_prepared", evidence: [...record.evidence, { kind: "stash_marker_authorized", marker: record.stash_marker }] });
                        await assertAuthority();
                        await assertUnchanged(record);
                        await assertSafeGitAttributesInWorktree(record.worktree, record.paths);
                        await git(["stash", "push", "--include-untracked", "--message", record.stash_marker, "--", ...record.paths], record.worktree);
                        await this.hooks.afterStash?.();
                        stashOid = await findStash(record);
                        if (!stashOid)
                            throw new Error("bookkeeping stash produced no exact correlated object");
                    }
                    await assertStash(record, stashOid);
                    const after = await assertWorktreeBinding(record.worktree, record.before.branch, record.before.commonGitDir, record.before.head, true, record.before.gitDir);
                    await assertAuthority();
                    return this.update({ ...record, state: "stashed", after, stash_oid: stashOid, evidence: [...record.evidence, { kind: "bookkeeping_stash_parked", oid: stashOid, marker: record.stash_marker, auto_drop: false }] });
                }).catch(async (error) => { const current = await this.read(original.finalization_id); if (!terminal(current))
                    await this.update({ ...current, evidence: [...current.evidence, { kind: "recovery_required", message: String(error.message), at: new Date().toISOString() }] }); throw error; });
            });
        }
        catch (error) {
            throw new BookkeepingFinalizationError(id, error);
        }
    }
    /** Read-only absence probe; missing signed checkpoints are integrity failures. */
    async hasStarted(args) {
        requiredText(args.session_id, "session");
        const record = await this.optionalRead(idValue(args.finalization_id));
        if (!record) {
            const operationId = hash(`bookkeeping-operation\0${idValue(args.finalization_id)}`), expression = new RegExp(`^${operationId}-[0-9]+\\.json$`);
            const revisions = await directoryNames(path.join(this.dataRoot, "lease-revisions")), marks = await directoryNames(path.join(this.dataRoot, "lease-watermarks")), legacy = await directoryNames(path.join(this.dataRoot, "leases"));
            if (!revisions.some(name => expression.test(name)) && !marks.some(name => expression.test(name)) && !legacy.includes(`${operationId}.json`))
                return false;
            const selected = await readAuthorizedLeaseSnapshotReadOnly(this.dataRoot, operationId);
            if (!selected || selected.state === "released")
                return false;
            const owner = selected.payload;
            if (selected.legacy || selected.revision === null || owner.intentId !== args.finalization_id || owner.operation !== "bookkeeping-attempt" || typeof owner.leaseToken !== "string" || !owner.leaseToken || typeof owner.ownerHost !== "string" || !owner.ownerHost || !Number.isSafeInteger(owner.ownerPid) || owner.ownerPid <= 0)
                throw new Error("pre-journal bookkeeping operation ownership is ambiguous or foreign");
            if (owner.sessionId !== args.session_id)
                throw new Error("pre-journal bookkeeping operation belongs to another session owner");
            // A held operation already fences request replacement, even before a receipt exists.
            return true;
        }
        if (record.session_id !== args.session_id)
            throw new Error("bookkeeping finalization belongs to another session owner");
        if (args.worktree && !samePath(args.worktree, record.worktree))
            throw new Error("bookkeeping finalization worktree binding differs");
        return true;
    }
    async status(args) {
        requiredText(args.session_id, "session");
        const record = await this.read(idValue(args.finalization_id));
        if (record.session_id !== args.session_id)
            throw new Error("bookkeeping finalization belongs to another session owner");
        if (args.worktree && !samePath(args.worktree, record.worktree))
            throw new Error("bookkeeping finalization worktree binding differs");
        return record;
    }
    match(record, normalized, options) {
        if (record.session_id !== normalized.session_id)
            throw new Error("bookkeeping finalization belongs to another session owner");
        if (record.request_sha256 !== digest(normalized))
            throw new Error("bookkeeping finalization retry request does not match signed binding");
        if (options.expected_binding && (record.before.branch !== options.expected_binding.branch || !samePath(record.before.commonGitDir, options.expected_binding.commonGitDir) || !samePath(record.before.gitDir, options.expected_binding.gitDir) || !samePath(record.before.topLevel, options.expected_binding.topLevel)))
            throw new Error("bookkeeping retry expected binding does not match signed base");
        if (options.expected_head && record.before.head !== options.expected_head)
            throw new Error("bookkeeping finalization retry expected HEAD does not match signed base");
        if (options.policy && digest(options.policy) !== record.policy_sha256)
            throw new Error("bookkeeping finalization captured policy does not match signed request");
    }
    async attempt(id, session, action) {
        const leaseId = hash(`bookkeeping-operation\0${id}`), key = `${path.resolve(this.dataRoot)}\0${leaseId}`, token = randomUUID();
        if (attemptOperations.has(key))
            throw new Error("bookkeeping finalization operation is already active");
        attemptOperations.add(key);
        try {
            let existing;
            try {
                existing = await readAuthorizedLeaseSnapshotReadOnly(this.dataRoot, leaseId);
            }
            catch (error) {
                if (error.code !== "ENOENT")
                    throw error;
            }
            if (existing?.state === "held") {
                const owner = existing.payload;
                if (existing.legacy || existing.revision === null || owner.intentId !== id || owner.sessionId !== session || owner.operation !== "bookkeeping-attempt" || owner.ownerHost !== os.hostname() || !Number.isSafeInteger(owner.ownerPid) || owner.ownerPid <= 0 || owner.ownerPid === process.pid)
                    throw new Error("bookkeeping finalization attempt has an active or ambiguous owner");
                try {
                    process.kill(owner.ownerPid, 0);
                    throw new Error("bookkeeping finalization attempt owner is still active");
                }
                catch (error) {
                    if (error.code !== "ESRCH")
                        throw error;
                }
                await releaseAuthorizedLeaseAtGeneration(this.dataRoot, leaseId, id, owner.leaseToken, existing.revision, generation(leaseId, existing));
            }
            const payload = { intentId: id, leaseToken: token, sessionId: session, operation: "bookkeeping-attempt", ownerPid: process.pid, ownerHost: os.hostname() };
            await acquireAuthorizedLease(this.dataRoot, leaseId, payload);
            const selected = await readAuthorizedLeaseSnapshotReadOnly(this.dataRoot, leaseId);
            if (!selected || selected.revision === null)
                throw new Error("bookkeeping finalization attempt generation is missing");
            try {
                return await action(async () => { const current = await readAuthorizedLeaseSnapshotReadOnly(this.dataRoot, leaseId); if (!current || current.state !== "held" || current.revision !== selected.revision || digest(current.payload) !== digest(payload))
                    throw new Error("bookkeeping finalization attempt lease generation changed"); });
            }
            finally {
                await releaseAuthorizedLeaseAtGeneration(this.dataRoot, leaseId, id, token, selected.revision, generation(leaseId, selected));
            }
        }
        finally {
            attemptOperations.delete(key);
        }
    }
    leasePayload(record, spec) { return { intentId: record.finalization_id, leaseToken: spec.token, sessionId: record.session_id, operation: spec.operation, commonGitDir: record.before.commonGitDir, targetBranch: record.before.branch, worktree: record.worktree }; }
    async resources(record, action) {
        const held = [];
        try {
            await this.assertNoOwner(record.before, record.finalization_id);
            for (const spec of record.lease_specs) {
                const payload = this.leasePayload(record, spec), existing = await readAuthorizedLeaseSnapshotReadOnly(this.dataRoot, spec.id);
                if (existing?.state === "held") {
                    if (existing.legacy || digest(existing.payload) !== digest(payload))
                        throw new Error("bookkeeping branch or worktree resource is already leased by another owner");
                }
                else
                    await acquireAuthorizedLease(this.dataRoot, spec.id, payload);
                const selected = await readAuthorizedLeaseSnapshotReadOnly(this.dataRoot, spec.id);
                if (!selected || selected.state !== "held" || selected.revision === null || digest(selected.payload) !== digest(payload))
                    throw new Error("bookkeeping resource lease changed during reservation");
                held.push({ id: spec.id, token: spec.token, revision: selected.revision, resource_generation: generation(spec.id, selected) });
            }
            return await action(held);
        }
        finally {
            for (const selected of held.reverse())
                await releaseAuthorizedLeaseAtGeneration(this.dataRoot, selected.id, record.finalization_id, selected.token, selected.revision, selected.resource_generation);
        }
    }
    async assertResources(record) {
        if (record.lease_generations?.length !== record.lease_specs.length)
            throw new Error("bookkeeping resource generation evidence is incomplete");
        for (const selected of record.lease_generations) {
            const current = await readAuthorizedLeaseSnapshotReadOnly(this.dataRoot, selected.id);
            if (!current || current.state !== "held" || current.revision !== selected.revision || generation(selected.id, current) !== selected.resource_generation)
                throw new Error("bookkeeping resource lease generation changed before mutation");
        }
    }
    async assertNoOwner(binding, ownId) {
        for (const run of await signedRunsReadOnly(this.dataRoot)) {
            const applies = (typeof run.worktreePath === "string" && samePath(run.worktreePath, binding.topLevel)) || (run.branch === binding.branch && typeof run.commonGitDir === "string" && samePath(run.commonGitDir, binding.commonGitDir));
            const pendingReview = run.phase === "hitl" || Boolean(run.policy?.hitlChecks?.length && run.evidence?.filter(item => item.kind === "plan_review").at(-1)?.decision !== "accept");
            if (applies && (run.phase !== "complete" || run.status !== "green" || pendingReview))
                throw new Error("worktree has an active Captain lifecycle owner; use its normal captain_commit path");
        }
        const revisionNames = await directoryNames(path.join(this.dataRoot, "lease-revisions")), legacyNames = await directoryNames(path.join(this.dataRoot, "leases"));
        const leaseIds = [...new Set([...revisionNames.map(name => /^(.+)-[0-9]+\.json$/.exec(name)?.[1]), ...legacyNames.map(name => /^(.+)\.json$/.exec(name)?.[1])].filter((id) => Boolean(id)))];
        for (const id of leaseIds) {
            const selected = await readAuthorizedLeaseSnapshotReadOnly(this.dataRoot, id);
            if (!selected || selected.state !== "held" || selected.payload.intentId === ownId)
                continue;
            const owner = selected.payload, matchesWorktree = [owner.worktree, owner.worktreePath, owner.source_worktree, owner.target_worktree].some(value => typeof value === "string" && samePath(value, binding.topLevel));
            const matchesBranch = owner.targetBranch === binding.branch && typeof owner.commonGitDir === "string" && samePath(owner.commonGitDir, binding.commonGitDir);
            if (matchesWorktree || matchesBranch || id === hash(`${path.resolve(binding.commonGitDir)}\0refs/heads/${binding.branch}`.toLowerCase()))
                throw new Error("worktree or branch has an active foreign Captain lease owner");
        }
    }
    async initial(record) { const stored = await putAuthorizedOnceExact(this.dataRoot, "bookkeeping-revisions", `${record.finalization_id}-0`, record); await this.watermark(stored); return stored; }
    async update(record) {
        const current = await this.read(record.finalization_id);
        if (terminal(current))
            throw new Error("terminal bookkeeping finalization receipt is immutable");
        if (current.revision !== record.revision)
            throw new Error("bookkeeping finalization changed concurrently");
        const next = JSON.parse(JSON.stringify({ ...record, revision: current.revision + 1, previous_sha256: digest(current) }));
        this.stable(current, next);
        const stored = await putAuthorizedOnceExact(this.dataRoot, "bookkeeping-revisions", `${record.finalization_id}-${next.revision}`, next);
        await this.watermark(stored);
        return stored;
    }
    async watermark(record) { await putAuthorizedOnceExact(this.dataRoot, "bookkeeping-watermarks", `${record.finalization_id}-${record.revision}`, { finalization_id: record.finalization_id, revision: record.revision, sha256: digest(record) }); }
    stable(previous, current) {
        const fixed = (r) => [r.schema_version, r.finalization_id, r.session_id, r.task_id, r.worktree, r.paths, r.subject, r.disposition, r.request_sha256, r.before, r.policy, r.policy_sha256, r.snapshot, r.index_tree, r.lease_specs, r.stash_marker];
        if (digest(fixed(previous)) !== digest(fixed(current)) || (previous.prepared_commit && digest(previous.prepared_commit) !== digest(current.prepared_commit)) || terminal(previous))
            throw new Error("signed bookkeeping finalization identity or candidate changed");
    }
    async optionalRead(id) {
        const expression = new RegExp(`^${idValue(id)}-[0-9]+\\.json$`);
        const names = [...await directoryNames(path.join(this.dataRoot, "bookkeeping-revisions")), ...await directoryNames(path.join(this.dataRoot, "bookkeeping-watermarks"))];
        return names.some(name => expression.test(name)) ? this.read(id) : undefined;
    }
    async read(id) {
        const safe = idValue(id), expression = new RegExp(`^${safe}-([0-9]+)\\.json$`), names = await directoryNames(path.join(this.dataRoot, "bookkeeping-revisions")), marks = await directoryNames(path.join(this.dataRoot, "bookkeeping-watermarks"));
        const revisions = names.map(name => expression.exec(name)).filter(Boolean).map(match => Number(match[1])).sort((a, b) => a - b);
        if (!revisions.length) {
            if (marks.some(name => expression.test(name)))
                throw new Error("bookkeeping signed revision tail regressed behind watermark");
            const error = new Error("bookkeeping finalization not found");
            error.code = "ENOENT";
            throw error;
        }
        let previous;
        for (let index = 0; index < revisions.length; index++) {
            if (revisions[index] !== index)
                throw new Error("bookkeeping signed revision chain is not contiguous");
            const current = await readAuthorizedReadOnly(this.dataRoot, "bookkeeping-revisions", `${safe}-${index}`);
            if (current.schema_version !== 1 || current.finalization_id !== safe || current.revision !== index || current.previous_sha256 !== (previous ? digest(previous) : undefined) || current.policy_sha256 !== digest(current.policy))
                throw new Error("signed bookkeeping receipt binding is invalid");
            if (previous)
                this.stable(previous, current);
            const mark = await readAuthorizedReadOnly(this.dataRoot, "bookkeeping-watermarks", `${safe}-${index}`);
            if (mark.finalization_id !== safe || mark.revision !== index || mark.sha256 !== digest(current))
                throw new Error("signed bookkeeping watermark binding is invalid");
            previous = current;
        }
        if (marks.some(name => { const match = expression.exec(name); return match && Number(match[1]) >= revisions.length; }))
            throw new Error("bookkeeping signed revision tail regressed behind watermark");
        return previous;
    }
}
function requiredText(value, label) { if (typeof value !== "string" || !value.trim() || /[\r\n\0]/.test(value))
    throw new Error(`bookkeeping ${label} must be explicit single-line text`); }
function validateRequest(args) {
    requiredText(args.session_id, "session");
    requiredText(args.task_id, "task id");
    requiredText(args.subject, "subject");
    if (!bookkeepingSubjectAllowed(args.subject))
        throw new Error("bookkeeping subject must use docs(captain) or chore(captain) without product version");
    if (args.disposition !== "commit" && args.disposition !== "stash")
        throw new Error("bookkeeping disposition must be commit or stash");
    if (!Array.isArray(args.paths) || !args.paths.length)
        throw new Error("bookkeeping paths must be explicit selected files");
    const paths = args.paths.map(value => { if (typeof value !== "string" || value.includes("\\") || path.isAbsolute(value) || !/^[A-Za-z0-9._/& -]+$/.test(value) || value.split("/").some(part => !part || part === "." || part === ".."))
        throw new Error("bookkeeping paths must be canonical safe repository-relative files"); return value; }).sort();
    if (new Set(paths).size !== paths.length)
        throw new Error("bookkeeping selected paths must be unique");
    return { worktree: path.resolve(args.worktree), session_id: args.session_id, task_id: args.task_id, paths, subject: args.subject, disposition: args.disposition };
}
async function directoryNames(directory) { try {
    return await readdir(directory);
}
catch (error) {
    if (error.code !== "ENOENT")
        throw error;
    return [];
} }
function generation(id, selected) { return digest({ leaseId: id, revision: selected.revision, state: selected.state, payload: selected.payload }); }
async function assertNoOperation(worktree) { for (const name of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "REBASE_HEAD", "BISECT_START", "BISECT_LOG", "rebase-merge", "rebase-apply", "sequencer"]) {
    const file = await git(["rev-parse", "--git-path", name], worktree);
    try {
        await lstat(path.resolve(worktree, file));
        throw new Error(`bookkeeping finalization refuses unfinished Git operation ${name}`);
    }
    catch (error) {
        if (error.code !== "ENOENT")
            throw error;
    }
} }
async function dirtyPaths(worktree) { return [...new Set([...records(await git(["diff", "--no-ext-diff", "--no-textconv", "--name-only", "-z", "HEAD"], worktree)), ...records(await git(["ls-files", "--others", "--exclude-standard", "-z"], worktree)), ...records(await git(["diff", "--cached", "--no-ext-diff", "--no-textconv", "--name-only", "-z"], worktree))])].sort(); }
async function assertSelection(worktree, selected, policy) {
    const dirty = await dirtyPaths(worktree), staged = records(await git(["diff", "--cached", "--no-ext-diff", "--no-textconv", "--name-only", "-z"], worktree));
    if (!dirty.length || digest(dirty) !== digest([...selected].sort()) || staged.some(value => !selected.includes(value)))
        throw new Error("bookkeeping finalization requires all dirty and staged paths in the exact selected files");
    for (const relative of dirty)
        if (!await bookkeepingPathAllowed(relative, policy.commit))
            throw new Error(`dirty path is outside the captured bookkeeping ceiling: ${relative}`);
}
async function captureSnapshot(worktree, selected) {
    const snapshots = [];
    for (const relative of selected) {
        const segments = relative.split("/");
        for (let n = 1; n < segments.length; n++) {
            try {
                const parent = await lstat(path.join(worktree, ...segments.slice(0, n)));
                if (!parent.isDirectory() || parent.isSymbolicLink())
                    throw new Error(`bookkeeping path crosses a symlink or non-directory: ${relative}`);
            }
            catch (error) {
                if (error.code !== "ENOENT")
                    throw error;
            }
        }
        const headEntry = await git(["ls-tree", "HEAD", "--", relative], worktree) || null, indexEntry = await git(["ls-files", "--stage", "--", relative], worktree) || null;
        if ((headEntry && !headEntry.startsWith("100644 blob ")) || (indexEntry && (!indexEntry.startsWith("100644 ") || !/^100644 [0-9a-f]+ 0\t/.test(indexEntry))))
            throw new Error(`bookkeeping snapshot refuses executable, symlink or conflicted index mode: ${relative}`);
        for (const oid of [headEntry?.split(" ")[2]?.split("\t")[0], indexEntry?.split(" ")[1]].filter((value) => Boolean(value)))
            if (!await bookkeepingBlobAllowed(worktree, oid))
                throw new Error(`bookkeeping HEAD/index blob must be bounded text: ${relative}`);
        let workingHash = null, workingBlob = null;
        try {
            const info = await lstat(path.join(worktree, relative));
            if (!info.isFile() || info.isSymbolicLink() || (process.platform !== "win32" && (info.mode & 0o111)))
                throw new Error(`bookkeeping selected path must be a non-executable regular file: ${relative}`);
            const bytes = await readFile(path.join(worktree, relative));
            if (!bookkeepingTextAllowed(bytes))
                throw new Error(`bookkeeping snapshot must contain bounded text: ${relative}`);
            new TextDecoder("utf-8", { fatal: true }).decode(bytes);
            workingHash = hash(bytes);
            workingBlob = await git(["hash-object", "--", relative], worktree);
        }
        catch (error) {
            if (error.code !== "ENOENT")
                throw error;
        }
        snapshots.push({ path: relative, working_sha256: workingHash, working_blob: workingBlob, head_entry: headEntry, index_entry: indexEntry });
    }
    return snapshots;
}
async function assertUnchanged(record) { await assertWorktreeBinding(record.worktree, record.before.branch, record.before.commonGitDir, record.before.head, false, record.before.gitDir); await assertSelection(record.worktree, record.paths, record.policy); await assertSafeGitAttributesInWorktree(record.worktree, record.paths); if (await git(["write-tree"], record.worktree) !== record.index_tree || digest(await captureSnapshot(record.worktree, record.paths)) !== digest(record.snapshot))
    throw new Error("bookkeeping finalization selected path/index snapshot changed before mutation"); }
async function assertWorkingSnapshot(record) { await assertSafeGitAttributesInWorktree(record.worktree, record.paths); const current = await captureSnapshot(record.worktree, record.paths); if (digest(current.map(value => [value.path, value.working_sha256, value.working_blob, value.head_entry])) !== digest(record.snapshot.map(value => [value.path, value.working_sha256, value.working_blob, value.head_entry])))
    throw new Error("bookkeeping finalization working snapshot changed after preparation"); }
async function findStash(record) { const values = (await git(["stash", "list", "--format=%H%x00%s"], record.worktree)).split(/\r?\n/).filter(Boolean), found = []; for (const line of values) {
    const delimiter = line.indexOf("\0"), oid = line.slice(0, delimiter), subject = line.slice(delimiter + 1);
    if (delimiter >= 0 && subject.endsWith(`: ${record.stash_marker}`))
        found.push(oid);
} if (found.length > 1)
    throw new Error("bookkeeping stash marker matched multiple objects"); return found[0]; }
async function assertStash(record, oid) {
    if (await git(["rev-parse", `${oid}^1`], record.worktree) !== record.before.head || await git(["rev-parse", `${oid}^2^{tree}`], record.worktree) !== record.index_tree)
        throw new Error("bookkeeping parked stash parent/index differs from signed snapshot");
    let untrackedTree;
    try {
        untrackedTree = await git(["rev-parse", `${oid}^3`], record.worktree);
    }
    catch { }
    const changed = [...new Set([...records(await git(["diff", "--no-ext-diff", "--no-textconv", "--name-only", "-z", record.before.head, oid], record.worktree)), ...records(await git(["diff", "--no-ext-diff", "--no-textconv", "--name-only", "-z", record.before.head, `${oid}^2`], record.worktree)), ...(untrackedTree ? records(await git(["ls-tree", "-r", "--name-only", "-z", untrackedTree], record.worktree)) : [])])].sort();
    if (digest(changed) !== digest(record.paths))
        throw new Error("bookkeeping parked stash contains an unexpected actual path delta");
    for (const selected of record.snapshot) {
        const tree = selected.head_entry || selected.index_entry ? oid : untrackedTree;
        const entry = tree ? await git(["ls-tree", tree, "--", selected.path], record.worktree) : "";
        if (!selected.working_blob) {
            if (entry)
                throw new Error("bookkeeping parked stash lost a selected deletion");
        }
        else if (!entry.startsWith(`100644 blob ${selected.working_blob}\t`))
            throw new Error("bookkeeping parked stash content/mode differs from signed selected snapshot");
    }
}
async function signedRunsReadOnly(dataRoot) {
    const names = await directoryNames(path.join(dataRoot, "run-revisions")), legacy = await directoryNames(path.join(dataRoot, "runs")), marks = await directoryNames(path.join(dataRoot, "run-watermarks"));
    const ids = [...new Set([...names.map(name => /^(.*)-[0-9]+\.json$/.exec(name)?.[1]), ...legacy.map(name => /^(.*)\.json$/.exec(name)?.[1]), ...marks.map(name => /^(.*)-[0-9]+\.json$/.exec(name)?.[1])].filter((id) => Boolean(id)))], runs = [];
    for (const id of ids) {
        idValue(id);
        const expression = new RegExp(`^${id}-([0-9]+)\\.json$`), revisions = names.map(name => expression.exec(name)).filter(Boolean).map(match => Number(match[1])).sort((a, b) => a - b);
        if (!revisions.length) {
            if (marks.some(name => expression.test(name)))
                throw new Error("lifecycle ownership revision tail regressed behind watermark");
            runs.push(await readAuthorizedReadOnly(dataRoot, "runs", id));
            continue;
        }
        let previous;
        for (let n = 0; n < revisions.length; n++) {
            if (revisions[n] !== n)
                throw new Error("lifecycle ownership revision chain is not contiguous");
            const current = await readAuthorizedReadOnly(dataRoot, "run-revisions", `${id}-${n}`), mark = await readAuthorizedReadOnly(dataRoot, "run-watermarks", `${id}-${n}`);
            if (current.intentId !== id || current.revision !== n || current.previousRevisionSha256 !== (previous ? digest(previous) : undefined) || mark.intentId !== id || mark.runId !== current.runId || mark.revision !== n || mark.runSha256 !== digest(current))
                throw new Error("lifecycle signed ownership evidence is invalid");
            previous = current;
        }
        if (marks.some(name => { const match = expression.exec(name); return match && Number(match[1]) >= revisions.length; }))
            throw new Error("lifecycle ownership revision tail regressed behind watermark");
        runs.push(previous);
    }
    return runs;
}
async function assertExpectedBinding(worktree, expected) {
    const actual = await assertWorktreeBinding(worktree, expected?.branch, expected?.commonGitDir, undefined, false, expected?.gitDir);
    if (expected && !samePath(actual.topLevel, expected.topLevel))
        throw new Error("bookkeeping finalization expected worktree top-level binding changed");
    return actual;
}
