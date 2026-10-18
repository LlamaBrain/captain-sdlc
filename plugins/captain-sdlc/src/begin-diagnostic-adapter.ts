import { execFileSync } from "node:child_process";
import { access, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { readAuthorizedLeaseSnapshotReadOnly, readAuthorizedReadOnly } from "./authority.js";
import { diagnoseBeginTargetLease, type BeginDiagnosticArgs, type BeginDiagnosticDependencies } from "./begin-diagnostics.js";

type AnyRecord = Record<string, unknown>;
type Worktree = { path?: string; head?: string; branch?: string };

function gitRead(cwd: string, ...args: string[]) {
  return execFileSync("git", ["--no-optional-locks", "-C", cwd, ...args], {
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function parseWorktrees(value: string): Worktree[] {
  const result: Worktree[] = [];
  let current: Worktree | undefined;
  for (const line of value.split(/\r?\n/)) {
    if (!line) {
      current = undefined;
      continue;
    }
    const separator = line.indexOf(" ");
    if (separator < 0) continue;
    const key = line.slice(0, separator);
    const field = line.slice(separator + 1);
    if (key === "worktree") {
      current = { path: field };
      result.push(current);
    } else if (current && key === "HEAD") current.head = field;
    else if (current && key === "branch") current.branch = field;
  }
  return result;
}

async function exists(file: string) {
  try { await access(file); return true; }
  catch (error: any) { if (error.code === "ENOENT") return false; throw error; }
}

async function pendingOperation(projectRoot: string) {
  const markers = ["MERGE_HEAD", "REBASE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "sequencer/todo", "rebase-merge", "rebase-apply"];
  for (const marker of markers) {
    const resolved = gitRead(projectRoot, "rev-parse", "--path-format=absolute", "--git-path", marker);
    if (await exists(resolved)) return true;
  }
  return false;
}

function samePath(left: string, right: string) {
  return path.resolve(left).replace(/[\\/]+$/, "").toLowerCase() ===
    path.resolve(right).replace(/[\\/]+$/, "").toLowerCase();
}

export function createBeginDiagnosticAdapter(dataRoot: string) {
  const deps: BeginDiagnosticDependencies = {
    async readSigned(bucket, id) {
      return readAuthorizedReadOnly<AnyRecord>(dataRoot, bucket, id);
    },
    async listSigned(bucket) {
      try { return await readdir(path.join(dataRoot, bucket)); }
      catch (error: any) { if (error.code === "ENOENT") return []; throw error; }
    },
    async readLease(leaseId) {
      const snapshot = await readAuthorizedLeaseSnapshotReadOnly<AnyRecord & { intentId: string; leaseToken: string }>(dataRoot, leaseId);
      return snapshot && { ...snapshot, integrity: "verified" as const };
    },
    async inspectGit(input) {
      const projectRoot = path.resolve(gitRead(input.projectRoot, "rev-parse", "--show-toplevel"));
      const commonGitDir = path.resolve(gitRead(projectRoot, "rev-parse", "--path-format=absolute", "--git-common-dir"));
      const targetRefOid = gitRead(projectRoot, "rev-parse", "--verify", `refs/heads/${input.targetBranch}^{commit}`);
      const worktrees = parseWorktrees(gitRead(projectRoot, "worktree", "list", "--porcelain"));
      const target = worktrees.find(item => item.branch === `refs/heads/${input.targetBranch}`);
      const canonicalWorktrees = worktrees.filter(item => typeof item.path === "string" && samePath(item.path, input.canonicalProposedPath));
      const targetWorktree = path.resolve(target?.path ?? projectRoot);
      if (!samePath(await realpath(targetWorktree), targetWorktree) ||
          !samePath(gitRead(targetWorktree, "rev-parse", "--show-toplevel"), targetWorktree) ||
          !samePath(gitRead(targetWorktree, "rev-parse", "--path-format=absolute", "--git-common-dir"), commonGitDir) ||
          gitRead(targetWorktree, "symbolic-ref", "--quiet", "--short", "HEAD") !== input.targetBranch ||
          gitRead(targetWorktree, "rev-parse", "HEAD").toLowerCase() !== targetRefOid.toLowerCase()) {
        throw new Error("registered target worktree binding does not match its signed branch");
      }
      const pendingGitOperation = await pendingOperation(projectRoot) ||
        (!samePath(targetWorktree, projectRoot) && await pendingOperation(targetWorktree));
      return {
        projectRoot,
        targetWorktree,
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

  return async (args: BeginDiagnosticArgs) => {
    try { await access(path.join(dataRoot, "authority.key")); }
    catch (error: any) {
      if (error.code === "ENOENT") {
        const untrusted = new Error("Captain authority key is unavailable; refusing to classify signed evidence") as NodeJS.ErrnoException;
        untrusted.code = "EAUTHORITYKEY";
        throw untrusted;
      }
      throw error;
    }
    return diagnoseBeginTargetLease(args, deps);
  };
}
