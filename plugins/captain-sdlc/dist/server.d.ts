import { LifecycleStore } from "./lifecycle.js";
import { abortMerge, applyPreparedCommit, assertWorktreeBinding, commitAtomic, commitEvidence, ensureWorktree, loadPolicy, prepareMerge, preparedMergeState, reconcilePreparedCommit, reconcilePreparedMerge, repositoryIdentity } from "./workspace.js";
export type CaptainBeginStage = "reservation" | "lease-acquired" | "worktree-created" | "run" | "permit" | "active";
export type CaptainBeginArgs = {
    intent_id: string;
    objective: string;
    project_root: string;
    task_id?: string;
};
export type CaptainBeginDependencies = {
    repositoryIdentity: typeof repositoryIdentity;
    loadPolicy: typeof loadPolicy;
    ensureWorktree: typeof ensureWorktree;
    afterStage?: (stage: CaptainBeginStage) => Promise<void>;
};
export declare function captainBegin(store: LifecycleStore, { intent_id, objective, project_root, task_id }: CaptainBeginArgs, dependencies?: CaptainBeginDependencies): Promise<import("./lifecycle.js").Run>;
export type CaptainCommitArgs = {
    intent_id: string;
    paths: string[];
    subject: string;
    task_outcome?: "Implements" | "Completes" | "Needs-QA";
    final: boolean;
};
export type CaptainCommitDependencies = {
    applyPreparedCommit: typeof applyPreparedCommit;
    assertWorktreeBinding: typeof assertWorktreeBinding;
    commitAtomic: typeof commitAtomic;
    commitEvidence: typeof commitEvidence;
    reconcilePreparedCommit: typeof reconcilePreparedCommit;
};
export declare function captainCommit(store: LifecycleStore, { intent_id, paths, subject, task_outcome, final }: CaptainCommitArgs, dependencies?: CaptainCommitDependencies): Promise<import("./lifecycle.js").Run>;
export type CaptainMergeDependencies = {
    prepareMerge: typeof prepareMerge;
    abortMerge: typeof abortMerge;
    preparedMergeState: typeof preparedMergeState;
    assertWorktreeBinding: typeof assertWorktreeBinding;
    reconcilePreparedMerge: typeof reconcilePreparedMerge;
};
export declare function captainPrepareMerge(store: LifecycleStore, { intent_id, commit_oid, strategy }: {
    intent_id: string;
    commit_oid: string;
    strategy: "ort" | "ours";
}, dependencies?: CaptainMergeDependencies): Promise<{
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
export declare function captainAbortMerge(store: LifecycleStore, { intent_id }: {
    intent_id: string;
}, dependencies?: CaptainMergeDependencies): Promise<import("./lifecycle.js").Run>;
