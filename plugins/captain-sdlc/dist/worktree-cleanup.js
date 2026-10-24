import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { acquireAuthorizedLease, putAuthorizedOnceExact, readAuthorized, readAuthorizedLease, readAuthorizedLeaseSnapshotReadOnly, releaseAuthorizedLease, releaseAuthorizedLeaseAtGeneration } from "./authority.js";
import { LifecycleStore } from "./lifecycle.js";
import { assertWorktreeBinding, gateRunner, git, gitRaw, primaryRepositoryRoot } from "./workspace.js";
import { readWorktreeRegistration, storageRegistrationId } from "./worktree-storage.js";
import { outputRoot } from "./output-retention.js";
const digest = (value) => createHash("sha256").update(typeof value === "string" || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest("hex");
const same = (a, b) => process.platform === "win32" ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b);
const within = (root, child) => { const relative = path.relative(path.resolve(root), path.resolve(child)); return relative === "" || (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative)); };
const missing = (error) => error?.code === "ENOENT";
const lines = (text) => text.split(/\r?\n/).filter(Boolean);
const cleanupId = (registration, head) => digest(`${storageRegistrationId(registration.common_git_dir, registration.worktree_path)}\0${head}`);
const branchLeaseId = (common, branch) => digest(`${path.resolve(common)}\0refs/heads/${branch}`.toLowerCase());
const evidenceDirectory = (dataRoot, id) => path.join(dataRoot, "worktree-evidence", id);
const budget = 16 * 1024 * 1024;
const generated = new Set(["library", "temp", "logs", "build", "builds", "dist", "artifacts", "node_modules", "bin", "obj", "coverage", ".captain-proof"]);
async function exists(file) { try {
    await lstat(file);
    return true;
}
catch (error) {
    if (missing(error))
        return false;
    throw error;
} }
async function safeAncestors(file) {
    for (let cursor = path.resolve(file);; cursor = path.dirname(cursor)) {
        try {
            if ((await lstat(cursor)).isSymbolicLink())
                throw new Error("cleanup path crosses a reparse point");
        }
        catch (error) {
            if (!missing(error))
                throw error;
        }
        if (cursor === path.dirname(cursor))
            break;
    }
}
function relativeFile(value) {
    const normalized = value.replaceAll("\\", "/");
    if (!normalized || path.isAbsolute(value) || /^[A-Za-z]:/.test(value) || normalized.split("/").some(part => !part || part === "." || part === ".." || part.toLowerCase() === ".git") || value.includes("\0"))
        throw new Error("retained evidence requires a safe relative path");
    return normalized;
}
async function readOptional(root, bucket, id) {
    try {
        return await readAuthorized(root, bucket, id);
    }
    catch (error) {
        if (missing(error))
            return undefined;
        throw error;
    }
}
/** A removal receipt is useful only while its retained report bytes still authenticate. */
export async function readWorktreeCleanupCompletion(dataRoot, registration, head) {
    const id = cleanupId(registration, head), completion = await readOptional(dataRoot, "worktree-cleanup-completions", id);
    if (!completion)
        return undefined;
    const plan = await readAuthorized(dataRoot, "worktree-cleanup-plans", id);
    if (completion.schema_version !== 1 || completion.cleanup_id !== id || completion.worktree !== registration.worktree_path || completion.head !== head ||
        completion.plan_sha256 !== digest(plan) || plan.cleanup_id !== id || digest(plan.registration) !== digest(registration) || plan.head !== head)
        throw new Error("signed worktree cleanup receipt binding is invalid");
    await validateArchive(dataRoot, plan);
    return completion;
}
async function validateArchive(dataRoot, plan) {
    for (const item of plan.evidence) {
        const file = path.join(evidenceDirectory(dataRoot, plan.cleanup_id), relativeFile(item.relative));
        await safeAncestors(file);
        const content = await readFile(file);
        if (content.length !== item.bytes || digest(content) !== item.sha256)
            throw new Error("retained worktree proof archive changed");
    }
}
export async function retainedWorktreeHead(dataRoot, registration) {
    let names;
    try {
        names = await readdir(path.join(dataRoot, "worktree-cleanup-completions"));
    }
    catch (error) {
        if (missing(error))
            return undefined;
        throw error;
    }
    for (const name of names.filter(item => /^[0-9a-f]{64}\.json$/.test(item))) {
        const receipt = await readAuthorized(dataRoot, "worktree-cleanup-completions", name.slice(0, -5));
        if (!same(receipt.worktree, registration.worktree_path))
            continue;
        if (await readWorktreeCleanupCompletion(dataRoot, registration, receipt.head))
            return receipt.head;
    }
    return undefined;
}
async function archiveEvidence(dataRoot, id, root, requested) {
    const files = new Map();
    let bytes = 0, directories = 0;
    async function collect(relative) {
        const full = path.join(root, relative);
        await safeAncestors(full);
        const info = await lstat(full);
        if (info.isDirectory()) {
            if (++directories > 4096)
                throw new Error("required compact proof exceeds the directory retention budget");
            for (const name of (await readdir(full)).sort()) {
                if (name.toLowerCase() === ".git")
                    throw new Error("retained evidence contains a nested repository");
                await collect(relativeFile(relative + "/" + name));
            }
        }
        else if (info.isFile()) {
            if (files.has(relative))
                return;
            if (files.size >= 2048)
                throw new Error("required compact proof exceeds the 2048-file retention budget");
            if (bytes + info.size > budget)
                throw new Error("required compact proof exceeds the 16 MiB retention budget; preserve it explicitly before cleanup");
            const content = await readFile(full);
            bytes += content.length;
            if (bytes > budget)
                throw new Error("required proof changed beyond the retention budget");
            files.set(relative, content);
        }
        else
            throw new Error("retained evidence is not a regular file or directory");
    }
    for (const raw of requested) {
        const relative = relativeFile(raw.replace(/\/$/, ""));
        await collect(relative);
    }
    // Local task handoffs are small operational records, rather than disposable builds.
    for (const relative of [".captain-sdlc/tasks", ".captain-sdlc/handoffs", ".captain-sdlc/closeouts", ".captain-sdlc/notebook"])
        if (await exists(path.join(root, relative)))
            await collect(relative);
    const manifest = [];
    for (const [relative, content] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
        const full = path.join(evidenceDirectory(dataRoot, id), relative);
        await safeAncestors(full);
        await mkdir(path.dirname(full), { recursive: true });
        if (await exists(full)) {
            if (!(await readFile(full)).equals(content))
                throw new Error("retained proof conflicts with an existing cleanup attempt");
        }
        else
            await writeFile(full, content, { flag: "wx", mode: 0o600 });
        manifest.push({ relative, sha256: digest(content), bytes: content.length });
    }
    return manifest;
}
async function registeredTrees(root) {
    return (await git(["worktree", "list", "--porcelain"], root)).split(/\r?\n\r?\n/).map(block => ({
        path: /^worktree (.+)$/m.exec(block)?.[1], locked: /^locked(?: |$)/m.test(block),
    })).filter((item) => Boolean(item.path));
}
async function walkSafety(root, dir = root) {
    for (const item of await readdir(dir, { withFileTypes: true })) {
        if (item.name.toLowerCase() === ".git") {
            if (!same(root, dir))
                throw new Error("worktree contains a nested Git repository");
            continue;
        }
        const full = path.join(dir, item.name), info = await lstat(full);
        if (info.isSymbolicLink()) {
            const destination = await realpath(full);
            if (!within(root, destination))
                throw new Error("worktree contains an external reparse point");
        }
        else if (info.isDirectory())
            await walkSafety(root, full);
    }
}
async function sameContent(left, right) {
    try {
        const a = await lstat(left), b = await lstat(right);
        if (a.isSymbolicLink() || b.isSymbolicLink())
            return false;
        if (a.isFile() && b.isFile())
            return a.size === b.size && digest(await readFile(left)) === digest(await readFile(right));
        if (!a.isDirectory() || !b.isDirectory())
            return false;
        const aa = (await readdir(left)).sort(), bb = (await readdir(right)).sort();
        if (digest(aa) !== digest(bb))
            return false;
        for (const name of aa)
            if (!await sameContent(path.join(left, name), path.join(right, name)))
                return false;
        return true;
    }
    catch (error) {
        if (missing(error))
            return false;
        throw error;
    }
}
async function configuredOutputRoots(dataRoot, registration, selected, owners) {
    const roots = [...selected, ...owners.flatMap(owner => Object.values(owner.policy.outputRetention?.roots ?? {}).flat())];
    const slot = await readOptional(dataRoot, "ordinary-output-slots", storageRegistrationId(registration.common_git_dir, registration.worktree_path));
    if (slot) {
        if (slot.schema_version !== 1 || !same(slot.worktree_path, registration.worktree_path) || !slot.roots ||
            Object.values(slot.roots).some(values => !Array.isArray(values)))
            throw new Error("signed ordinary output slot binding is invalid");
        roots.push(...Object.values(slot.roots).flat());
    }
    const verified = [...new Set(roots.map(outputRoot))];
    if (verified.length > 256)
        throw new Error("configured cleanup output roots exceed the bounded policy");
    return verified;
}
async function assertIgnoredDataSafe(registration, evidence, outputRoots) {
    const ignored = (await gitRaw(["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"], registration.worktree_path)).split("\0").filter(Boolean);
    const comparison = (value) => process.platform === "win32" ? value.toLowerCase() : value;
    const classified = [...evidence, ...outputRoots].map(comparison);
    async function check(relative) {
        const parts = relative.toLowerCase().split("/"), comparable = comparison(relative);
        if (parts.some(part => generated.has(part)) || classified.some(item => comparable === item || comparable.startsWith(item + "/")) ||
            /^\.captain-sdlc\/(tasks|handoffs|closeouts|notebook)(\/|$)/i.test(relative))
            return;
        const full = path.join(registration.worktree_path, relative);
        if (classified.some(item => item.startsWith(comparable + "/")) && (await lstat(full)).isDirectory()) {
            for (const name of await readdir(full))
                await check(relative + "/" + name);
            return;
        }
        if (await sameContent(full, path.join(registration.project_root, relative)))
            return;
        throw new Error(`unclassified ignored content requires preservation before cleanup: ${relative}`);
    }
    for (const raw of ignored)
        await check(raw.replaceAll("\\", "/").replace(/\/$/, ""));
}
async function completedOwners(dataRoot, root, intentId) {
    const lifecycle = new LifecycleStore(dataRoot, gateRunner);
    if ((await lifecycle.doctor()).activeRuns.some(owner => same(owner.worktreePath, root)))
        throw new Error("worktree has an unfinished Captain task");
    let names;
    try {
        names = await readdir(path.join(dataRoot, "run-revisions"));
    }
    catch (error) {
        if (missing(error))
            names = [];
        else
            throw error;
    }
    const result = [];
    for (const name of names.filter(value => value.endsWith("-0.json"))) {
        const initial = await readAuthorized(dataRoot, "run-revisions", name.slice(0, -5));
        if (!same(initial.worktreePath, root))
            continue;
        const run = await lifecycle.status(name.slice(0, -7));
        if (!same(run.worktreePath, root))
            continue;
        if (run.phase !== "complete" || run.status !== "green" || run.preparedCommit || run.commitOperation || run.mutationOperation)
            throw new Error("worktree has unfinished Captain authority");
        if (run.sessionLeaseId) {
            const session = await readAuthorizedLeaseSnapshotReadOnly(dataRoot, run.sessionLeaseId);
            if (!run.sessionLeaseToken || session?.state === "held" && session.payload.intentId === run.intentId && session.payload.leaseToken === run.sessionLeaseToken)
                throw new Error("completed worktree still has held Captain session authority");
        }
        result.push(run);
    }
    const begin = await readOptional(dataRoot, "begin-operations", intentId);
    if (begin && !result.some(owner => owner.intentId === begin.intentId && owner.runId === begin.runId))
        throw new Error("worktree has an unfinished Captain Begin operation");
    const attempt = await readAuthorizedLeaseSnapshotReadOnly(dataRoot, `begin-attempt-${digest(intentId)}`);
    if (attempt?.state === "held")
        throw new Error("worktree creation attempt is still active");
    return result;
}
/** Only exact, newly registered checkouts are eligible. Retention is explicit; integration remains successful. */
export async function cleanupRegisteredWorktrees(dataRoot, targetWorktree, candidates, assertAuthority = async () => { }) {
    const result = { removed_worktrees: [], retained_worktrees: [] };
    const target = await assertWorktreeBinding(targetWorktree);
    for (const candidate of candidates) {
        const registration = candidate.registration, root = registration.worktree_path, head = candidate.head, id = cleanupId(registration, head);
        const held = [];
        try {
            if (candidate.retentionReason)
                throw new Error(candidate.retentionReason);
            if (!/^[0-9a-f]{40,64}$/i.test(head))
                throw new Error("cleanup requires an exact integrated commit");
            const verified = await readWorktreeRegistration(dataRoot, registration.common_git_dir, root);
            if (!verified || digest(verified) !== digest(registration))
                throw new Error("worktree has no matching future creation registration");
            if (!same(target.commonGitDir, registration.common_git_dir) || same(root, registration.project_root) || within(root, targetWorktree) || within(root, dataRoot) ||
                !same(path.dirname(root), path.join(registration.project_root, ".captain-sdlc", "worktrees")))
                throw new Error("cleanup path is outside its exact canonical task checkout");
            if (!same(await primaryRepositoryRoot(targetWorktree, registration.common_git_dir), registration.project_root))
                throw new Error("cleanup primary repository binding diverged");
            await safeAncestors(root);
            await safeAncestors(dataRoot);
            await git(["merge-base", "--is-ancestor", head, target.head], targetWorktree);
            const owners = await completedOwners(dataRoot, root, registration.intent_id);
            const originalAttempt = await readOptional(dataRoot, "worktree-cleanup-attempts", id);
            const attempt = { schema_version: 1, cleanup_id: id, registration, head };
            const leaseIds = [branchLeaseId(registration.common_git_dir, registration.branch), ...owners.map(owner => digest(`worktree-mutation\0${owner.runId}`))].sort();
            // A rejected recovery must never manufacture the historical journal it lacked.
            for (const leaseId of leaseIds) {
                const existing = await readAuthorizedLeaseSnapshotReadOnly(dataRoot, leaseId);
                if (existing?.state === "held" && (!originalAttempt || digest(originalAttempt) !== digest(attempt)))
                    throw new Error("worktree branch or mutation authority is leased without a matching original cleanup attempt journal");
            }
            await putAuthorizedOnceExact(dataRoot, "worktree-cleanup-attempts", id, attempt);
            for (const leaseId of leaseIds) {
                const stale = await readAuthorizedLeaseSnapshotReadOnly(dataRoot, leaseId);
                if (stale?.state === "held") {
                    const payload = stale.payload;
                    if (!originalAttempt || digest(originalAttempt) !== digest(attempt) || stale.legacy || stale.revision === null || payload.intentId !== id || payload.operation !== "worktree-cleanup" ||
                        payload.ownerHost !== os.hostname() || !Number.isSafeInteger(payload.ownerPid) || payload.ownerPid <= 0)
                        throw new Error("worktree branch or mutation authority is still leased");
                    let stopped = false;
                    try {
                        process.kill(payload.ownerPid, 0);
                    }
                    catch (error) {
                        if (error.code === "ESRCH")
                            stopped = true;
                    }
                    if (!stopped)
                        throw new Error("cleanup lease owner is active or cannot be verified stopped");
                    await releaseAuthorizedLeaseAtGeneration(dataRoot, leaseId, id, payload.leaseToken, stale.revision, digest({ leaseId, revision: stale.revision, state: "held", payload }));
                }
                const token = randomUUID();
                await acquireAuthorizedLease(dataRoot, leaseId, { intentId: id, leaseToken: token, operation: "worktree-cleanup", ownerPid: process.pid, ownerHost: os.hostname() });
                held.push({ id: leaseId, token });
            }
            const prior = await readWorktreeCleanupCompletion(dataRoot, registration, head);
            if (prior) {
                if (await exists(root) || (await registeredTrees(targetWorktree)).some(tree => same(tree.path, root)))
                    throw new Error("a checkout reappeared after cleanup; preserve its replacement identity");
                result.removed_worktrees.push(root);
                (result.removed_heads ??= {})[root] = head;
                result.evidence_root = path.join(dataRoot, "worktree-evidence");
                continue;
            }
            const plan = await readOptional(dataRoot, "worktree-cleanup-plans", id);
            if (!await exists(root)) {
                if (!plan || digest(plan.registration) !== digest(registration) || plan.head !== head || !same(plan.target_worktree, targetWorktree) ||
                    (await registeredTrees(targetWorktree)).some(tree => same(tree.path, root)))
                    throw new Error("missing worktree has no completed exact removal journal");
                await validateArchive(dataRoot, plan);
                const completion = { schema_version: 1, cleanup_id: id, plan_sha256: digest(plan), worktree: root, head };
                await putAuthorizedOnceExact(dataRoot, "worktree-cleanup-completions", id, completion);
                await readWorktreeCleanupCompletion(dataRoot, registration, head);
                result.removed_worktrees.push(root);
                (result.removed_heads ??= {})[root] = head;
                result.evidence_root = path.join(dataRoot, "worktree-evidence");
                continue;
            }
            const validate = async () => {
                await assertAuthority();
                for (const lease of held) {
                    const actual = await readAuthorizedLease(dataRoot, lease.id);
                    if (actual.intentId !== id || actual.leaseToken !== lease.token)
                        throw new Error("cleanup authority changed");
                }
                await completedOwners(dataRoot, root, registration.intent_id);
                await assertWorktreeBinding(root, registration.branch, registration.common_git_dir, head, true, registration.git_dir);
                for (const marker of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "REBASE_HEAD", "BISECT_LOG", "BISECT_START", "rebase-merge", "rebase-apply", "sequencer", "index.lock"]) {
                    if (await exists(path.join(registration.git_dir, marker)))
                        throw new Error(`worktree has an unfinished Git operation or lock: ${marker}`);
                }
                const entries = await registeredTrees(targetWorktree), selected = entries.find(tree => same(tree.path, root));
                if (!selected || selected.locked)
                    throw new Error("worktree is missing or locked");
                if (entries.some(tree => !same(tree.path, root) && within(root, tree.path)))
                    throw new Error("worktree contains another registered worktree");
                const actualTarget = await assertWorktreeBinding(targetWorktree, target.branch, target.commonGitDir, target.head, false, target.gitDir);
                await git(["merge-base", "--is-ancestor", head, actualTarget.head], targetWorktree);
            };
            await validate();
            await walkSafety(root);
            const evidencePaths = (candidate.evidencePaths ?? []).map(item => relativeFile(item.replace(/\/$/, "")));
            const outputRoots = await configuredOutputRoots(dataRoot, registration, candidate.outputRoots ?? [], owners);
            await assertIgnoredDataSafe(registration, evidencePaths, outputRoots);
            let removal = plan;
            if (removal) {
                if (digest(removal.registration) !== digest(registration) || removal.head !== head || !same(removal.target_worktree, targetWorktree))
                    throw new Error("cleanup retry cannot adopt a replacement worktree");
                for (const evidence of removal.evidence)
                    if (digest(await readFile(path.join(root, evidence.relative))) !== evidence.sha256)
                        throw new Error("source proof changed after the cleanup journal");
                await validateArchive(dataRoot, removal);
            }
            else {
                const evidence = await archiveEvidence(dataRoot, id, root, evidencePaths);
                removal = await putAuthorizedOnceExact(dataRoot, "worktree-cleanup-plans", id, { schema_version: 1, cleanup_id: id, registration, head,
                    target_worktree: path.resolve(targetWorktree), target_branch: target.branch, target_common_git_dir: target.commonGitDir, target_head: target.head, evidence });
            }
            await validate();
            await safeAncestors(root);
            // Normal Git removal protects tracked/untracked dirt and registered locks. Never force deletion.
            await git(["worktree", "remove", root], registration.project_root);
            if (await exists(root) || (await registeredTrees(targetWorktree)).some(tree => same(tree.path, root)))
                throw new Error("Git did not complete the exact worktree removal");
            await putAuthorizedOnceExact(dataRoot, "worktree-cleanup-completions", id, { schema_version: 1, cleanup_id: id, plan_sha256: digest(removal), worktree: root, head });
            await readWorktreeCleanupCompletion(dataRoot, registration, head);
            result.removed_worktrees.push(root);
            (result.removed_heads ??= {})[root] = head;
            result.evidence_root = path.join(dataRoot, "worktree-evidence");
        }
        catch (error) {
            result.retained_worktrees.push({ worktree: root, reason: error.message });
        }
        finally {
            for (const lease of held.reverse())
                await releaseAuthorizedLease(dataRoot, lease.id, id, lease.token);
        }
    }
    return result;
}
