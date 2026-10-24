import { type WorktreeRegistration } from "./worktree-storage.js";
export type CleanupCandidate = {
    registration: WorktreeRegistration;
    head: string;
    evidencePaths?: string[];
    outputRoots?: string[];
    retentionReason?: string;
};
export type WorktreeCleanupResult = {
    removed_worktrees: string[];
    retained_worktrees: Array<{
        worktree: string;
        reason: string;
    }>;
    evidence_root?: string;
    removed_heads?: Record<string, string>;
};
export type WorktreeCleanupCompletion = {
    schema_version: 1;
    cleanup_id: string;
    plan_sha256: string;
    worktree: string;
    head: string;
};
/** A removal receipt is useful only while its retained report bytes still authenticate. */
export declare function readWorktreeCleanupCompletion(dataRoot: string, registration: WorktreeRegistration, head: string): Promise<WorktreeCleanupCompletion | undefined>;
export declare function retainedWorktreeHead(dataRoot: string, registration: WorktreeRegistration): Promise<string | undefined>;
/** Only exact, newly registered checkouts are eligible. Retention is explicit; integration remains successful. */
export declare function cleanupRegisteredWorktrees(dataRoot: string, targetWorktree: string, candidates: CleanupCandidate[], assertAuthority?: () => Promise<void>): Promise<WorktreeCleanupResult>;
