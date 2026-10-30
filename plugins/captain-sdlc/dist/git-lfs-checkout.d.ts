import { type GitReader } from "./git-safe-status.js";
/** Populate a newly linked --no-checkout worktree without executing repository filters. */
export declare function populateLfsWorktree(sourceRoot: string, targetRoot: string, baseHead: string, git: GitReader): Promise<void>;
