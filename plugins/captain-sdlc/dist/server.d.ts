import { LifecycleStore, type HitlCheck } from "./lifecycle.js";
import { git } from "./workspace.js";
import { abortMerge, applyPreparedCommit, assertWorktreeBinding, commitAtomic, commitEvidence, ensureWorktree, loadPolicy, prepareMerge, preparedMergeState, reconcilePreparedCommit, reconcilePreparedMerge, repositoryIdentity } from "./workspace.js";
export type CaptainBeginStage = "reservation" | "lease-acquired" | "worktree-created" | "run" | "permit" | "active";
export type CaptainBeginArgs = {
    intent_id: string;
    objective: string;
    project_root: string;
    task_id?: string;
    plan_paths?: string[];
    hitl_checks?: HitlCheck[];
};
export type CaptainIssueIntentArgs = {
    session_id: string;
    turn_id: string;
    project_root: string;
    prompt: string;
    task_id?: string;
    resume_of?: string;
    target_branch?: string;
    action?: "start" | "resume";
};
export type CaptainBeginDependencies = {
    repositoryIdentity: typeof repositoryIdentity;
    loadPolicy: typeof loadPolicy;
    ensureWorktree: typeof ensureWorktree;
    afterStage?: (stage: CaptainBeginStage) => Promise<void>;
};
export declare function captainBegin(store: LifecycleStore, { intent_id, objective, project_root, task_id, plan_paths, hitl_checks }: CaptainBeginArgs, dependencies?: CaptainBeginDependencies): Promise<import("./lifecycle.js").Run>;
export declare function captainIssueIntent(store: LifecycleStore, { session_id, turn_id, project_root, prompt, task_id, resume_of, target_branch, action }: CaptainIssueIntentArgs): Promise<{
    resume_instruction: string;
    intent_id: string;
} | {
    begin_instruction: string;
    intent_id: string;
}>;
export type CaptainCommitArgs = {
    intent_id: string;
    paths: string[];
    subject: string;
    task_outcome?: "Implements" | "Completes" | "Needs-QA";
    final: boolean;
};
export type CaptainResumeDependencies = {
    assertWorktreeBinding: typeof assertWorktreeBinding;
    git: typeof git;
    commitEvidence: typeof commitEvidence;
};
export declare function captainResume(store: LifecycleStore, resumeIntentId: string, dependencies?: CaptainResumeDependencies): Promise<import("./lifecycle.js").Run>;
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
export declare function startCaptainMcp(): Promise<void>;
