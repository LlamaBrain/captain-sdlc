import { type GitReader } from "./git-safe-status.js";
/**
 * Stage explicitly selected paths without executing repository-configured filters.
 * The real index is published only after its original state and HEAD remain pinned.
 * Existing staged paths outside the selection are retained for the caller's normal
 * explicit-selection preflight; they are never dropped or rewritten here.
 */
export declare function stageLfsSelection(worktree: string, selection: string[], git: GitReader): Promise<void>;
