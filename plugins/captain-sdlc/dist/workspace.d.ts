import type { CommitPolicy, GateRunner, ProjectPolicy } from "./lifecycle.js";
export type PreparedMerge = {
    preMergeHead: string;
    targetOid: string;
    strategy: "ort" | "ours";
};
export declare const gateRunner: GateRunner;
export declare function git(args: string[], cwd: string): Promise<string>;
export declare function loadPolicy(projectRoot: string, baseHead: string): Promise<ProjectPolicy>;
export declare function repositoryIdentity(projectRoot: string): Promise<{
    projectRoot: string;
    baseHead: string;
}>;
export declare function ensureWorktree(projectRoot: string, baseHead: string, intentId: string): Promise<{
    projectRoot: string;
    worktreePath: string;
    baseHead: string;
}>;
export declare function commitEvidence(worktree: string, baseHead: string, policy?: ProjectPolicy, taskId?: string, preparedMerges?: PreparedMerge[]): Promise<{
    head: string;
    tree: string;
    commitCount: number;
    clean: boolean;
    subject: string;
    versionChanged: boolean;
    changelogChanged: boolean;
    taskTrailerValid: boolean;
    versionSurfacesValid: boolean;
    preparedMergesValid: boolean;
    phaseCommitsValid: boolean;
}>;
export declare function commitAtomic(worktree: string, paths: string[], subject: string, taskOutcome?: "Implements" | "Completes" | "Needs-QA", taskId?: string, commitPolicy?: CommitPolicy, preparedMerges?: PreparedMerge[]): Promise<void>;
export declare function prepareMerge(worktree: string, commitOid: string, strategy?: "ort" | "ours", authorize?: (prepared: PreparedMerge) => Promise<void>, revoke?: (prepared: PreparedMerge) => Promise<void>): Promise<{
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
export declare function abortMerge(worktree: string, prepared: PreparedMerge): Promise<void>;
export declare function reconcilePreparedMerge(worktree: string, prepared: PreparedMerge): Promise<void>;
export declare function sourceState(worktree: string, policy?: ProjectPolicy): Promise<{
    head: string;
    tree: string;
    status: string;
    manifest: string;
}>;
