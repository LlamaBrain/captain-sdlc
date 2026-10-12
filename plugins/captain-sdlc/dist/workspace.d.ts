import type { CommitPolicy, GateRunner, ProjectPolicy, HitlCheck } from "./lifecycle.js";
export type PreparedMerge = {
    preMergeHead: string;
    targetOid: string;
    strategy: "ort" | "ours";
    operationToken?: string;
};
export type PreparedCommitCore = {
    preCommitHead: string;
    candidate: string;
    tree: string;
    mergeHead?: string;
};
export declare const gateRunner: GateRunner;
export declare function git(args: string[], cwd: string): Promise<string>;
export declare function loadPolicy(projectRoot: string, baseHead: string, planPaths?: string[], hitlChecks?: HitlCheck[]): Promise<ProjectPolicy>;
export declare function repositoryIdentity(projectRoot: string, targetBranch?: string, targetOid?: string): Promise<{
    projectRoot: string;
    baseHead: string;
    commonGitDir: string;
}>;
export declare function ensureWorktree(projectRoot: string, baseHead: string, intentId: string, targetBranch?: string, expectedCommonGitDir?: string): Promise<{
    projectRoot: string;
    worktreePath: string;
    baseHead: string;
    targetBranch?: string;
    branch: string;
    commonGitDir: string;
    gitDir: string;
}>;
export declare function commitEvidence(worktree: string, baseHead: string, policy?: ProjectPolicy, taskId?: string, preparedMerges?: PreparedMerge[], previousPhaseHead?: string): Promise<{
    preparedMergesValid: boolean;
    phaseCommitsValid: boolean;
    previousPhaseHead: string | undefined;
    previousPhaseRetained: boolean;
    bookkeepingOnly?: boolean | undefined;
    head: string;
    tree: string;
    commitCount: number;
    clean: boolean;
    subject: string;
    versionChanged: boolean;
    changelogChanged: boolean;
    taskTrailerValid: boolean;
    versionSurfacesValid: boolean;
}>;
export declare function commitAtomic(worktree: string, paths: string[], subject: string, taskOutcome?: "Implements" | "Completes" | "Needs-QA", taskId?: string, commitPolicy?: CommitPolicy, preparedMerges?: PreparedMerge[], expectedBranch?: string, expectedCommonGitDir?: string, expectedHead?: string, expectedGitDir?: string, authorize?: (prepared: PreparedCommitCore) => Promise<void>, revoke?: (prepared: PreparedCommitCore) => Promise<void>, afterRefUpdate?: () => Promise<void>, validateAuthority?: (prepared: PreparedCommitCore) => Promise<void>): Promise<{
    mergeHead?: string | undefined;
    preCommitHead: string;
    candidate: string;
    tree: string;
}>;
export declare function reconcilePreparedCommit(worktree: string, prepared: PreparedCommitCore, expectedBranch: string, expectedCommonGitDir: string, expectedGitDir: string): Promise<void>;
export declare function applyPreparedCommit(worktree: string, prepared: PreparedCommitCore, expectedBranch: string, expectedCommonGitDir: string, expectedGitDir: string, validateAuthority: (prepared: PreparedCommitCore) => Promise<void>): Promise<void>;
export declare function prepareMerge(worktree: string, commitOid: string, strategy?: "ort" | "ours", authorize?: (prepared: PreparedMerge) => Promise<void>, revoke?: (prepared: PreparedMerge) => Promise<void>, expectedBranch?: string, expectedCommonGitDir?: string, expectedHead?: string, expectedGitDir?: string, afterMerge?: () => Promise<void>, operationToken?: string, validateAuthority?: (prepared: PreparedMerge) => Promise<void>): Promise<{
    commitOid: string;
    preMergeHead: string;
    strategy: "ort" | "ours";
    status: "conflicts";
    conflicts: string[];
} | {
    commitOid: string;
    preMergeHead: string;
    strategy: "ort" | "ours";
    status: "ready";
    conflicts: string[];
}>;
export declare function abortMerge(worktree: string, prepared: PreparedMerge, validateAuthority?: (prepared: PreparedMerge) => Promise<void>): Promise<void>;
export declare function preparedMergeState(worktree: string, prepared: PreparedMerge): Promise<"clean" | "pinned" | "diverged">;
export declare function reconcilePreparedMerge(worktree: string, prepared: PreparedMerge): Promise<void>;
export declare function sourceState(worktree: string, policy?: ProjectPolicy): Promise<{
    branch: string | undefined;
    branchHead: string | undefined;
    commonGitDir: string;
    topLevel: string;
    gitDir: string;
    manifest: string;
    productManifest?: string;
    head: string;
    tree: string;
    status: string;
}>;
export declare function assertWorktreeBinding(worktree: string, expectedBranch?: string, expectedCommonGitDir?: string, expectedHead?: string, requireClean?: boolean, expectedGitDir?: string): Promise<{
    branch: string;
    commonGitDir: string;
    gitDir: string;
    topLevel: string;
    head: string;
}>;
export declare function assertSafeGitAttributesInWorktree(cwd: string, selectedPaths: string[]): Promise<void>;
export declare function bookkeepingPathAllowed(relative: string, policy: CommitPolicy): Promise<boolean>;
/** Blob validation preserves raw bytes at whitespace/control boundaries. */
export declare function bookkeepingBlobAllowed(worktree: string, oid: string): Promise<boolean>;
/** Classifies the real first-parent tree delta, including rename source paths and modes. */
export declare function bookkeepingCommitValid(worktree: string, parent: string, hash: string, subject: string, policy: CommitPolicy): Promise<boolean>;
/** Proof extension admits only descendant record commits; old proof stays at base. */
export declare function bookkeepingHistoryValid(worktree: string, base: string, head: string, policy: CommitPolicy): Promise<boolean>;
