import { execFileSync } from "node:child_process";
import { access, readdir } from "node:fs/promises";
import path from "node:path";
import { readAuthorizedLeaseSnapshotReadOnly, readAuthorizedReadOnly } from "./authority.js";
import { diagnoseBeginTargetLease } from "./begin-diagnostics.js";
function gitRead(cwd, ...args) {
    return execFileSync("git", ["--no-optional-locks", "-C", cwd, ...args], {
        encoding: "utf8",
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
    }).trim();
}
function parseWorktrees(value) {
    const result = [];
    let current;
    for (const line of value.split(/\r?\n/)) {
        if (!line) {
            current = undefined;
            continue;
        }
        const separator = line.indexOf(" ");
        if (separator < 0)
            continue;
        const key = line.slice(0, separator);
        const field = line.slice(separator + 1);
        if (key === "worktree") {
            current = { path: field };
            result.push(current);
        }
        else if (current && key === "HEAD")
            current.head = field;
        else if (current && key === "branch")
            current.branch = field;
    }
    return result;
}
async function exists(file) {
    try {
        await access(file);
        return true;
    }
    catch (error) {
        if (error.code === "ENOENT")
            return false;
        throw error;
    }
}
async function pendingOperation(projectRoot) {
    const markers = ["MERGE_HEAD", "REBASE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "sequencer/todo", "rebase-merge", "rebase-apply"];
    for (const marker of markers) {
        const resolved = gitRead(projectRoot, "rev-parse", "--path-format=absolute", "--git-path", marker);
        if (await exists(resolved))
            return true;
    }
    return false;
}
function samePath(left, right) {
    return path.resolve(left).replace(/[\\/]+$/, "").toLowerCase() ===
        path.resolve(right).replace(/[\\/]+$/, "").toLowerCase();
}
export function createBeginDiagnosticAdapter(dataRoot) {
    const deps = {
        async readSigned(bucket, id) {
            return readAuthorizedReadOnly(dataRoot, bucket, id);
        },
        async listSigned(bucket) {
            try {
                return await readdir(path.join(dataRoot, bucket));
            }
            catch (error) {
                if (error.code === "ENOENT")
                    return [];
                throw error;
            }
        },
        async readLease(leaseId) {
            const snapshot = await readAuthorizedLeaseSnapshotReadOnly(dataRoot, leaseId);
            return snapshot && { ...snapshot, integrity: "verified" };
        },
        async inspectGit(input) {
            const projectRoot = path.resolve(gitRead(input.projectRoot, "rev-parse", "--show-toplevel"));
            const commonGitDir = path.resolve(gitRead(projectRoot, "rev-parse", "--path-format=absolute", "--git-common-dir"));
            const targetRefOid = gitRead(projectRoot, "rev-parse", "--verify", `refs/heads/${input.targetBranch}^{commit}`);
            const worktrees = parseWorktrees(gitRead(projectRoot, "worktree", "list", "--porcelain"));
            const target = worktrees.find(item => item.branch === `refs/heads/${input.targetBranch}`);
            const canonicalWorktrees = worktrees.filter(item => typeof item.path === "string" && samePath(item.path, input.canonicalProposedPath));
            const pendingGitOperation = await pendingOperation(projectRoot);
            return {
                projectRoot,
                targetWorktree: projectRoot,
                commonGitDir,
                targetRefOid,
                targetBranchWorktreePath: target?.path,
                targetBranchWorktreeHead: target?.head,
                canonicalProposedPathExists: await exists(input.canonicalProposedPath),
                canonicalWorktreeRegistered: canonicalWorktrees.length > 0,
                pendingGitOperation,
            };
        },
        // Current signed records do not carry a verifiable OS process identity.
        // Keep modern owners unknown unless a future adapter can prove host/PID/start.
        ownerState: () => "unknown",
    };
    return async (args) => {
        try {
            await access(path.join(dataRoot, "authority.key"));
        }
        catch (error) {
            if (error.code === "ENOENT") {
                const untrusted = new Error("Captain authority key is unavailable; refusing to classify signed evidence");
                untrusted.code = "EAUTHORITYKEY";
                throw untrusted;
            }
            throw error;
        }
        return diagnoseBeginTargetLease(args, deps);
    };
}
