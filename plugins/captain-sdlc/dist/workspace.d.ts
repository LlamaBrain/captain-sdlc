import type { GateRunner, ProjectPolicy } from "./lifecycle.js";
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
export declare function commitEvidence(worktree: string, baseHead: string): Promise<{
    head: string;
    tree: string;
    commitCount: number;
    clean: boolean;
    subject: string;
    versionChanged: boolean;
    changelogChanged: boolean;
    phaseCommitsValid: boolean;
}>;
export declare function commitAtomic(worktree: string, paths: string[], subject: string): Promise<void>;
export declare function sourceState(worktree: string): Promise<{
    head: string;
    tree: string;
    status: string;
    manifest: string;
}>;
