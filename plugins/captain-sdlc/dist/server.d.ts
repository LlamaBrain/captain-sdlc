import { captainCancelFailedBegin } from "./failed-begin-cancellation.js";
import { LifecycleStore, type HitlCheck } from "./lifecycle.js";
import { git } from "./workspace.js";
import { abortMerge, applyPreparedCommit, assertWorktreeBinding, commitAtomic, commitEvidence, ensureWorktree, loadPolicy, prepareMerge, preparedMergeState, reconcilePreparedCommit, reconcilePreparedMerge, repositoryIdentity } from "./workspace.js";
export type CaptainBeginStage = "reservation" | "lease-acquired" | "worktree-created" | "run" | "permit" | "active";
export type ClientOwnerArgs = {
    client_pid?: number;
    close_token_hash?: string;
};
export type CaptainBeginArgs = ClientOwnerArgs & {
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
    request_kind?: "instruction" | "goal";
    source_request_id?: string;
};
export type CaptainBeginDependencies = {
    repositoryIdentity: typeof repositoryIdentity;
    loadPolicy: typeof loadPolicy;
    ensureWorktree: typeof ensureWorktree;
    afterStage?: (stage: CaptainBeginStage) => Promise<void>;
};
export declare function captainBegin(store: LifecycleStore, { intent_id, objective, project_root, task_id, plan_paths, hitl_checks, client_pid, close_token_hash }: CaptainBeginArgs, dependencies?: CaptainBeginDependencies): Promise<import("./lifecycle.js").Run>;
export { captainCancelFailedBegin };
export declare function captainDoctor(store: Pick<LifecycleStore, "doctor">): Promise<{
    pausedHandoffs: {
        worktreeState?: {
            head: string;
            tree: string;
        } | undefined;
        handoffId: string;
        evidenceCount: number;
        user_request?: import("./user-request.js").UserRequestStatus;
        schemaVersion: 1;
        intentId: string;
        runId: string;
        revision: number;
        sessionId: string;
        turnId: string;
        projectRoot: string;
        worktreePath: string;
        branch: string;
        taskId?: string;
        objective: string;
        phase: import("./lifecycle.js").Run["phase"];
        status: import("./lifecycle.js").Run["status"];
        planPath?: string;
        phaseLabel?: string;
        completedSteps: string[];
        summary: string;
        nextSteps: string[];
        blockers: string[];
        context?: string;
        resumeDirective: string;
        redirectPrompt?: string;
    }[];
    activeRuns: Array<Pick<import("./lifecycle.js").Run, "intentId" | "sessionId" | "turnId" | "status" | "phase" | "worktreePath" | "branch" | "projectRoot" | "taskId">>;
}>;
export declare function captainIssueIntent(store: LifecycleStore, { session_id, turn_id, project_root, prompt, task_id, resume_of, target_branch, action, request_kind, source_request_id }: CaptainIssueIntentArgs): Promise<{
    resume_instruction: string;
    intent_id: string;
    user_request: import("./user-request.js").UserRequestStatus;
} | {
    begin_instruction: string;
    intent_id: string;
    user_request: import("./user-request.js").UserRequestStatus;
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
export declare function captainResume(store: LifecycleStore, resumeIntentId: string, dependencies?: CaptainResumeDependencies, client?: ClientOwnerArgs): Promise<import("./lifecycle.js").Run>;
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
export declare function captainReconcileAuthorizedCommit(store: LifecycleStore, { intent_id, paths, subject, task_outcome, final }: CaptainCommitArgs, dependencies?: Pick<CaptainCommitDependencies, "assertWorktreeBinding" | "commitEvidence">): Promise<import("./lifecycle.js").Run>;
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
