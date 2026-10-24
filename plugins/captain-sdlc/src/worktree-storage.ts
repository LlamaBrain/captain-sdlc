import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { putAuthorizedOnceExact, readAuthorizedReadOnly } from "./authority.js";

export type ParentWorktree = { registration_id: string; worktree_path: string; branch: string; git_dir: string; head: string };
export type WorktreeCreation = {
  schema_version: 1; intent_id: string; project_root: string; common_git_dir: string;
  worktree_path: string; branch: string; base_head: string; parent_worktree?: ParentWorktree;
};
export type WorktreeRegistration = WorktreeCreation & { git_dir: string };
const keyPath = (value: string) => process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
const samePath = (left: string, right: string) => keyPath(left) === keyPath(right);
const sameValue = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
const commit = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{40,64}$/i.test(value) && !/^0+$/.test(value);

export function storageRegistrationId(commonGitDir: string, worktreePath: string): string {
  return createHash("sha256").update(`${keyPath(commonGitDir)}\0${keyPath(worktreePath)}`).digest("hex");
}

function absolute(value: unknown, label: string): string {
  if (typeof value !== "string" || !path.isAbsolute(value) || value.includes("\0")) throw new Error(`worktree registration ${label} must be absolute`);
  return path.resolve(value);
}
function creation(value: WorktreeCreation): WorktreeCreation {
  if (!value || value.schema_version !== 1 || typeof value.intent_id !== "string" || !/^[A-Za-z0-9_-]+$/.test(value.intent_id) ||
      typeof value.branch !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value.branch) || !commit(value.base_head))
    throw new Error("worktree creation registration identity is invalid");
  const project_root = absolute(value.project_root, "project root"), common_git_dir = absolute(value.common_git_dir, "common Git directory"), worktree_path = absolute(value.worktree_path, "worktree path");
  if (!samePath(path.dirname(worktree_path), path.join(project_root, ".captain-sdlc", "worktrees")) || path.basename(worktree_path) !== value.intent_id)
    throw new Error("worktree registration must name its exact canonical primary container child");
  const result: WorktreeCreation = { schema_version: 1, intent_id: value.intent_id, project_root, common_git_dir, worktree_path, branch: value.branch, base_head: value.base_head };
  if (value.parent_worktree !== undefined) {
    const parent = value.parent_worktree;
    if (!parent || typeof parent.registration_id !== "string" || !/^[0-9a-f]{64}$/.test(parent.registration_id) || typeof parent.branch !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(parent.branch) || !commit(parent.head) || parent.head !== result.base_head)
      throw new Error("worktree parent registration binding is invalid");
    const parentPath = absolute(parent.worktree_path, "parent path"), gitDir = absolute(parent.git_dir, "parent Git directory");
    if (samePath(parentPath, worktree_path) || !samePath(path.dirname(parentPath), path.join(project_root, ".captain-sdlc", "worktrees")) ||
        parent.registration_id !== storageRegistrationId(common_git_dir, parentPath) || !samePath(path.dirname(gitDir), path.join(common_git_dir, "worktrees")))
      throw new Error("worktree parent registration identity diverged");
    result.parent_worktree = { registration_id: parent.registration_id, worktree_path: parentPath, branch: parent.branch, git_dir: gitDir, head: parent.head };
  }
  return result;
}
async function optionalSigned<T>(dataRoot: string, bucket: string, id: string): Promise<T | undefined> {
  const file = path.join(dataRoot, bucket, id + ".json");
  try { const info = await lstat(file); if (!info.isFile() || info.isSymbolicLink()) throw new Error("worktree registration must be a regular signed file"); }
  catch (error: any) { if (error.code === "ENOENT") return undefined; throw error; }
  return readAuthorizedReadOnly<T>(dataRoot, bucket, id);
}
export async function readWorktreeCreation(dataRoot: string, commonGitDir: string, worktreePath: string): Promise<WorktreeCreation | undefined> {
  const stored = await optionalSigned<WorktreeCreation>(dataRoot, "worktree-creations", storageRegistrationId(commonGitDir, worktreePath));
  if (!stored) return undefined;
  const value = creation(stored);
  if (!samePath(value.common_git_dir, commonGitDir) || !samePath(value.worktree_path, worktreePath)) throw new Error("worktree creation filename binding diverged");
  return value;
}

/** Publish before Git creates the checkout; adopting an existing directory never opts it in. */
export async function reserveWorktreeCreation(dataRoot: string, input: WorktreeCreation): Promise<WorktreeCreation> {
  const value = creation(input), id = storageRegistrationId(value.common_git_dir, value.worktree_path), prior = await readWorktreeCreation(dataRoot, value.common_git_dir, value.worktree_path);
  if (prior) { if (!sameValue(prior, value)) throw new Error("worktree creation checkpoint differs from its original identity"); return prior; }
  const dataRelative = path.relative(value.worktree_path, path.resolve(dataRoot));
  if (!dataRelative || dataRelative !== ".." && !dataRelative.startsWith(`..${path.sep}`) && !path.isAbsolute(dataRelative)) throw new Error("worktree registration authority must survive outside the checkout");
  if (!samePath(await realpath(value.project_root), value.project_root) || !samePath(await realpath(value.common_git_dir), value.common_git_dir)) throw new Error("worktree registration crosses a reparse point");
  try { await lstat(value.worktree_path); throw new Error("worktree creation registration refuses an existing path"); }
  catch (error: any) { if (error.code !== "ENOENT") throw error; }
  return putAuthorizedOnceExact(dataRoot, "worktree-creations", id, value);
}

/** Complete only a prior creation journal after Git has verified that exact checkout binding. */
export async function completeWorktreeCreation(dataRoot: string, input: WorktreeCreation, gitDir: string): Promise<WorktreeRegistration> {
  const value = creation(input), prior = await readWorktreeCreation(dataRoot, value.common_git_dir, value.worktree_path), git_dir = absolute(gitDir, "linked Git directory");
  if (!prior || !sameValue(prior, value) || !samePath(path.dirname(git_dir), path.join(value.common_git_dir, "worktrees"))) throw new Error("worktree registration does not match its signed creation journal");
  const registration: WorktreeRegistration = { ...value, git_dir };
  return putAuthorizedOnceExact(dataRoot, "worktree-registrations", storageRegistrationId(value.common_git_dir, value.worktree_path), registration);
}

export async function readWorktreeRegistration(dataRoot: string, commonGitDir: string, worktreePath: string): Promise<WorktreeRegistration | undefined> {
  const stored = await optionalSigned<WorktreeRegistration>(dataRoot, "worktree-registrations", storageRegistrationId(commonGitDir, worktreePath));
  if (!stored) return undefined;
  const value = creation(stored), prior = await readWorktreeCreation(dataRoot, commonGitDir, worktreePath), git_dir = absolute(stored.git_dir, "linked Git directory");
  if (!samePath(value.common_git_dir, commonGitDir) || !samePath(value.worktree_path, worktreePath) || !prior || !sameValue(prior, value) ||
      !samePath(path.dirname(git_dir), path.join(value.common_git_dir, "worktrees"))) throw new Error("worktree registration binding diverged from its signed creation");
  return { ...value, git_dir };
}
