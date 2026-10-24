import { type SessionOwner, type SessionOwnerProbe } from "./session-interruption.js";
import type { BeginDiagnosticArgs } from "./begin-diagnostics.js";
import type { PreparedCommitCore, PreparedMerge } from "./workspace.js";
import { type BookkeepingPolicy } from "./bookkeeping.js";
import { recordUserAuthorizations, type AuthorizationQuery } from "./user-authorization.js";
import { type UserRequestInput, type UserRequestQuery, type UserRequestStatus } from "./user-request.js";
import { type UserRequestSourceQuery } from "./user-request-source.js";
import { type OutputRetention } from "./output-retention.js";
export type Profile = "low" | "feature" | "pre-release";
export type GateResult = {
    exitCode: number;
    stdout: string;
    stderr: string;
};
export type GateRunner = (command: string, cwd: string) => Promise<GateResult>;
export type SourceState = {
    head: string;
    tree: string;
    status: string;
    manifest?: string;
    productManifest?: string;
    branch?: string;
    branchHead?: string;
    commonGitDir?: string;
    topLevel?: string;
    gitDir?: string;
};
export type StateProbe = (cwd: string, policy?: ProjectPolicy) => Promise<SourceState>;
export type CommitPolicy = {
    conventional?: boolean;
    require_version_suffix?: boolean;
    require_task_trailer?: boolean;
    version_file: string;
    version_surfaces?: Array<{
        path: string;
        pattern: string;
    }>;
    changelog_files: string[];
    bookkeeping?: BookkeepingPolicy;
};
export type HitlCheck = {
    id: string;
    criterionId: string;
    setup: string;
    action: string;
    expected: string;
    evidence: string;
};
export type HitlFeedbackInput = {
    decision: "accept" | "needs_changes";
    humanFeedback: string;
    checkIds: string[];
    evidenceReferences: string[];
    reviewedRevision?: string;
};
export type HitlFeedback = HitlFeedbackInput & {
    kind: "hitl_feedback";
    recordedAt: string;
    recordedSource: SourceState;
};
export type ProjectPolicy = {
    hitlChecks?: HitlCheck[];
    approvedPlans?: Array<{
        path: string;
        sha256: string;
    }>;
    profile: Profile;
    profiles?: Profile[];
    visualRequired: boolean;
    commands: Record<string, string>;
    artifactPaths?: Record<string, string>;
    outputRetention?: OutputRetention;
    redGate?: {
        expectedExitCodes: number[];
        outputPattern: string;
    };
    commitPolicyPath?: string;
    commitPolicySha256?: string;
    commit?: CommitPolicy;
    sourceManifestExcludes?: string[];
    sourceManifestRootFileExcludes?: string[];
};
export type Intent = {
    issuedAt?: string;
    intentId: string;
    sessionId: string;
    turnId: string;
    projectRoot: string;
    prompt: string;
    requestedProfile?: Profile;
    capability?: string;
    consumed?: boolean;
    resumeOf?: string;
    targetBranch?: string;
    targetOid?: string;
};
export type BeginOperation = {
    schemaVersion: 1;
    intentId: string;
    operationToken: string;
    leaseToken: string;
    runId: string;
    startedAt: string;
    sessionId: string;
    turnId: string;
    projectRoot: string;
    objective: string;
    taskId?: string;
    targetBranch?: string;
    targetOid?: string;
};
export type BeginRepository = {
    schemaVersion: 1;
    operationToken: string;
    projectRoot: string;
    baseHead: string;
    commonGitDir: string;
    policySha256: string;
};
export type BeginLease = {
    schemaVersion: 1;
    operationToken: string;
    leaseId?: string;
    leaseToken?: string;
    leaseRevision?: number;
    resourceGeneration?: string;
    commonGitDir?: string;
    targetBranch?: string;
    targetOid?: string;
};
export type BeginCancellationMarker = {
    schemaVersion: 1;
    kind: "failed_begin_cancelled";
    intentId: string;
    sessionId: string;
    turnId: string;
    operationToken: string;
    projectRoot: string;
    targetWorktree: string;
    targetBranch: string;
    leaseId: string;
    leaseToken: string;
    expectedLeaseRevision: number;
    resourceGeneration: string;
};
export type BeginWorkspace = {
    schemaVersion: 1;
    operationToken: string;
    projectRoot: string;
    worktreePath: string;
    baseHead: string;
    branch: string;
    commonGitDir: string;
    gitDir: string;
    targetBranch?: string;
};
export type ResumeOperation = {
    schemaVersion: 1;
    resumeIntentId: string;
    operationToken: string;
    intentId: string;
    runId: string;
    sessionId: string;
    turnId: string;
};
export type PauseHandoff = {
    user_request?: UserRequestStatus;
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
    phase: Run["phase"];
    status: Run["status"];
    planPath?: string;
    phaseLabel?: string;
    completedSteps: string[];
    summary: string;
    nextSteps: string[];
    blockers: string[];
    context?: string;
    worktreeState?: SourceState;
    evidence: Array<Record<string, unknown>>;
    resumeDirective: string;
    redirectPrompt?: string;
};
export type BlockerLink = {
    schemaVersion: 1;
    blockedIntentId: string;
    blockerIntentId: string;
    blockedRunId: string;
    blockerRunId: string;
    projectRoot: string;
    createdAt: string;
};
export type CommitOperationRequest = {
    paths: string[];
    subject: string;
    taskOutcome?: "Implements" | "Completes" | "Needs-QA";
    final: boolean;
};
export type CommitOperation = {
    leaseId: string;
    leaseToken: string;
    requestSha256: string;
    request?: CommitOperationRequest;
    stage: "reserved" | "authorized" | "prepared";
};
export type WorktreeMutationOperation = {
    leaseId: string;
    leaseToken: string;
    kind: "commit" | "merge" | "abort" | "recovery";
    requestSha256: string;
    stage: "reserved" | "authorized";
};
export type PreparedCommit = PreparedCommitCore & {
    paths: string[];
    subject: string;
    taskOutcome?: "Implements" | "Completes" | "Needs-QA";
    final: boolean;
};
export type TerminalCommit = {
    requestSha256: string;
    commitLeaseId: string;
    commitLeaseToken: string;
    mutationOperation?: WorktreeMutationOperation;
    candidate: string;
    outcome: "committed";
    final: boolean;
    commit: CommitEvidence;
};
export type TaskTicket = {
    filter: string;
    command: string;
    commandSha256: string;
    policyCommandSha256: string;
};
export type Run = {
    user_request?: UserRequestStatus;
    schemaVersion: 1;
    revision: number;
    previousRevisionSha256?: string;
    runId: string;
    operationToken: string;
    intentId: string;
    sessionId: string;
    turnId: string;
    activationToken?: string;
    taskId?: string;
    objective: string;
    projectRoot: string;
    worktreePath: string;
    baseHead: string;
    branch: string;
    targetBranch?: string;
    commonGitDir: string;
    gitDir: string;
    leaseId?: string;
    leaseToken?: string;
    sessionLeaseId?: string;
    sessionLeaseToken?: string;
    profile: Profile;
    visualRequired: boolean;
    startedAt: string;
    phase: "tdd_red" | "implement" | "prove" | "hitl" | "complete";
    status: "running" | "paused" | "green" | "red";
    policy: ProjectPolicy;
    taskTicket?: TaskTicket;
    preparedMerges?: PreparedMerge[];
    mutationOperation?: WorktreeMutationOperation;
    commitOperation?: CommitOperation;
    preparedCommit?: PreparedCommit;
    terminalCommit?: TerminalCommit;
    committedState?: SourceState;
    continuityState?: SourceState;
    evidence: Array<Record<string, unknown>>;
};
export type BeginInput = Omit<Run, "user_request" | "schemaVersion" | "revision" | "runId" | "operationToken" | "sessionId" | "turnId" | "sessionLeaseId" | "sessionLeaseToken" | "startedAt" | "phase" | "status" | "committedState" | "continuityState" | "mutationOperation" | "commitOperation" | "taskTicket" | "evidence" | "profile" | "visualRequired">;
export type CommitEvidence = {
    head: string;
    tree?: string;
    firstParent?: string;
    changedPaths?: string[];
    commitCount: number;
    clean: boolean;
    subject: string;
    versionChanged: boolean;
    changelogChanged: boolean;
    bookkeepingOnly?: boolean;
    taskTrailerValid?: boolean;
    taskTrailerPresent?: boolean;
    versionSurfacesValid?: boolean;
    preparedMergesValid?: boolean;
    phaseCommitsValid?: boolean;
    previousPhaseHead?: string;
    previousPhaseRetained?: boolean;
};
export type SessionInterruptionArgs = {
    intentId: string;
    sessionId: string;
    expectedRunRevision: number;
    expectedSessionLeaseRevision: number;
    resourceGeneration: string;
    summary: string;
    nextSteps: string[];
};
export type SessionOwnerBinding = {
    schemaVersion: 1;
    intentId: string;
    runId: string;
    sessionId: string;
    activationToken: string;
    sessionLeaseId: string;
    sessionLeaseToken: string;
    owner: SessionOwner;
};
export type LifecycleHooks = {
    sessionOwner?: (sessionId: string) => Promise<SessionOwner | undefined>;
    probeSessionOwner?: (owner: SessionOwner) => Promise<SessionOwnerProbe>;
    afterTerminalCommit?: (run: Run) => Promise<void>;
    afterRunCompleted?: (run: Run) => Promise<void>;
    afterResumeReserved?: (operation: ResumeOperation) => Promise<void>;
    afterRunRevision?: (run: Run) => Promise<void>;
};
export declare function approvedPlanDigest(content: string): string;
export declare function proofScopes(run: Pick<Run, "profile" | "visualRequired">): string[];
export declare function executionHead(run: Run): string;
export declare function isPendingPlanReview(run: Run): boolean;
export declare function effectiveGateDisclosure(run: Run): {
    hitlChecks: HitlCheck[];
    planReview: Record<string, unknown> | null;
    humanReview: HitlFeedback | null;
    humanReviewStatus: {
        acceptedCheckIds: string[];
        needsChangesCheckIds: string[];
        unreviewedCheckIds: string[];
    };
    planState: string;
    approvalAccepted: boolean;
    scopeBinding: string;
    approvedPlans: {
        path: string;
        sha256: string;
    }[];
    baseHead: string;
    policySource: string;
    progressLocation: string;
    proofStatus: {
        phase: string;
        status: string;
    };
    phaseAcceptance: string;
    taskTicket: TaskTicket | null;
    ticketCommand: string;
    gates: {
        scope: string;
        command: string;
        artifactPath: string | null;
    }[];
};
export declare class LifecycleStore {
    private readonly dataRoot;
    private readonly runner;
    private readonly probe?;
    private readonly hooks?;
    constructor(dataRoot: string, runner: GateRunner, probe?: StateProbe | undefined, hooks?: LifecycleHooks | undefined);
    withSerializedBeginAttempt<T>(intentId: string, action: () => Promise<T>): Promise<T>;
    withBeginAttemptGate<T>(intentId: string, action: () => Promise<T>): Promise<T>;
    diagnoseBegin(args: BeginDiagnosticArgs): Promise<{
        diagnosis: "invalid_request";
        session_match: "unknown";
        read_only: true;
        intent_id: string;
    } | {
        diagnosis: "untrusted";
        session_match: "unknown";
        reason: string;
        read_only: true;
        intent_id: string;
    } | {
        diagnosis: "unavailable";
        session_match: "unknown";
        read_only: true;
        intent_id: string;
    } | {
        diagnosis: "untrusted";
        session_match: "same";
        reason: string;
        read_only: true;
        intent_id: string;
    } | {
        diagnosis: "inspected";
        session_match: "same";
        project_root_matches: boolean;
        target_branch_matches: boolean;
        issuance: "invalid_target_binding";
        stage: "unknown";
        recovery_disposition: "refused";
        refusal_code: string;
        read_only: true;
        intent_id: string;
    } | {
        diagnosis: "inspected";
        session_match: "same";
        project_root_matches: boolean;
        target_branch_matches: boolean;
        target_worktree_matches: boolean;
        issuance: "verified" | "missing_or_mismatched";
        recovery_disposition: "refused_request_binding_mismatch";
        read_only: true;
        intent_id: string;
    } | {
        user_request: UserRequestStatus;
        diagnosis: "inspected";
        session_match: "same";
        project_root_matches: boolean;
        target_branch_matches: boolean;
        issuance: "invalid_target_binding";
        stage: "unknown";
        recovery_disposition: "refused";
        refusal_code: string;
        read_only: true;
        intent_id: string;
    } | {
        user_request: UserRequestStatus;
        diagnosis: "inspected";
        session_match: "same";
        project_root_matches: boolean;
        target_branch_matches: boolean;
        target_worktree_matches: boolean;
        issuance: "verified" | "missing_or_mismatched";
        recovery_disposition: "refused_request_binding_mismatch";
        read_only: true;
        intent_id: string;
    } | {
        user_request: UserRequestStatus;
        diagnosis: "inspected";
        session_match: "same";
        project_root_matches: true;
        target_branch_matches: true;
        target_worktree_matches: boolean;
        target_ref_matches: boolean;
        issuance: "verified" | "missing_or_mismatched";
        reservation: "verified" | "mismatched" | "absent";
        repository_checkpoint: "verified" | "mismatched" | "absent";
        lease_checkpoint: "verified" | "mismatched" | "absent";
        stage: string;
        target_lease: {
            state: "held" | "released" | "absent";
            owner: "legacy" | "unknown" | "live" | "stopped" | "foreign_host" | "other";
            bindings_match: boolean;
            generation_revisioned: boolean;
            revision: number | null;
            resource_generation: string | null;
        };
        later_state: {
            workspace: boolean;
            run: boolean;
            active: boolean;
            activated: boolean;
            permit: boolean;
            canonical_path_exists: boolean;
            canonical_worktree_registered: boolean;
            pending_git_operation: boolean | "unknown";
        };
        recovery_disposition: string;
        observed_branch_checkout_outside_canonical: boolean;
        read_only: true;
        intent_id: string;
    }>;
    beginCancellationFor(intentId: string): Promise<BeginCancellationMarker | undefined>;
    readBeginCancellationEvidence(intentId: string): Promise<{
        intent: Intent;
        operation: BeginOperation;
        repository: BeginRepository;
        lease: BeginLease;
        consumed: {
            schemaVersion: number;
            operationToken: string;
            intentId: string;
        };
        completedSessionTombstone: boolean;
        completedSessionOwner: boolean;
    }>;
    recordBeginCancellation(marker: BeginCancellationMarker): Promise<BeginCancellationMarker>;
    releaseBeginTargetLeaseAtGeneration(leaseId: string, intentId: string, leaseToken: string, expectedRevision: number, resourceGeneration: string): Promise<void>;
    private assertBeginNotCancelled;
    markIntent(intent: Intent): Promise<void>;
    issueIdempotentIntent(request: {
        sessionId: string;
        turnId: string;
        projectRoot: string;
        prompt: string;
        taskId?: string;
        resumeOf?: string;
        targetBranch?: string;
        action?: string;
        requestKind?: "instruction" | "goal";
        sourceRequestId?: string;
    }, factory: () => Promise<Intent>): Promise<Intent>;
    recordUserAuthorization(input: Parameters<typeof recordUserAuthorizations>[1]): Promise<import("./user-authorization.js").AuthorizationReceipt[]>;
    userAuthorizations(query: AuthorizationQuery): Promise<{
        receipts: import("./user-authorization.js").AuthorizationReceipt[];
        guidance: string;
    }>;
    recordUserRequest(input: UserRequestInput): Promise<import("./user-request.js").UserRequestReceipt>;
    userRequests(query: UserRequestQuery): Promise<UserRequestStatus>;
    userRequestSource(query: UserRequestSourceQuery): Promise<import("./user-request-source.js").UserRequestSourceReceipt | undefined>;
    validateIntent(intentId: string, projectRoot: string): Promise<Intent>;
    beginOperationFor(intentId: string): Promise<BeginOperation>;
    activatedBeginRun(operation: BeginOperation): Promise<Run | undefined>;
    reserveBegin(input: {
        intentId: string;
        objective: string;
        projectRoot: string;
        taskId?: string;
        leaseToken?: string;
    }): Promise<BeginOperation>;
    checkpointBeginRepository(operation: BeginOperation, repository: {
        projectRoot: string;
        baseHead: string;
        commonGitDir: string;
    }, policy: ProjectPolicy): Promise<BeginRepository>;
    ensureBeginTargetLease(operation: BeginOperation, repository: BeginRepository): Promise<{
        leaseId: string;
        leaseToken: string;
        leaseRevision: number;
        resourceGeneration: string;
    } | undefined>;
    checkpointBeginLease(operation: BeginOperation, repository: BeginRepository, lease?: {
        leaseId: string;
        leaseToken: string;
        leaseRevision?: number;
        resourceGeneration?: string;
    }): Promise<BeginLease>;
    checkpointBeginWorkspace(operation: BeginOperation, workspace: Omit<BeginWorkspace, "schemaVersion" | "operationToken"> & {
        primaryProjectRoot?: string;
    }): Promise<BeginWorkspace>;
    checkpointBeginRun(operation: BeginOperation, policy: ProjectPolicy): Promise<Run>;
    checkpointBeginPermit(operation: BeginOperation, run: Run): Promise<ReturnType<LifecycleStore["permit"]>>;
    checkpointBeginActive(operation: BeginOperation): Promise<{
        intentId: string;
        operationToken: string;
    }>;
    checkpointBeginActivated(operation: BeginOperation): Promise<Run>;
    begin(input: BeginInput): Promise<Run>;
    bindSessionOwner(intentId: string, sessionId: string, owner: SessionOwner): Promise<void>;
    sessionInterruptionStatus(intentId: string, sessionId: string): Promise<{
        intentId: string;
        runId: string;
        sessionId: string;
        status: "paused" | "green";
        phase: "tdd_red" | "implement" | "prove" | "hitl" | "complete";
        owner: {
            pid?: number | undefined;
            host?: string | undefined;
            startedAt?: string | undefined;
            state: import("./session-interruption.js").SessionOwnerState;
            reason?: string;
        };
        canRecover: boolean;
        selectors: undefined;
    } | {
        intentId: string;
        runId: string;
        sessionId: string;
        status: "running" | "red";
        phase: "tdd_red" | "implement" | "prove" | "hitl" | "complete";
        owner: {
            pid?: number | undefined;
            host?: string | undefined;
            startedAt?: string | undefined;
            state: import("./session-interruption.js").SessionOwnerState;
            reason?: string;
        };
        canRecover: boolean;
        selectors: {
            intentId: string;
            sessionId: string;
            expectedRunRevision: number;
            expectedSessionLeaseRevision: number;
            resourceGeneration: string;
        };
    }>;
    recoverInterruptedSession(args: SessionInterruptionArgs): Promise<PauseHandoff>;
    recordSessionClosed(args: SessionInterruptionArgs & {
        ownerToken: string;
        reason: "closed" | "crashed";
    }): Promise<PauseHandoff>;
    resume(resumeIntentId: string): Promise<Run>;
    pause(intentId: string, input: {
        summary: string;
        nextSteps: string[];
        blockers?: string[];
        planPath?: string;
        phaseLabel?: string;
        completedSteps?: string[];
        context?: string;
        redirectTask?: string;
    }): Promise<PauseHandoff>;
    private pauseWithSessionFence;
    handoffs(): Promise<PauseHandoff[]>;
    linkBlocker(blockedIntentId: string, blockerIntentId: string): Promise<BlockerLink>;
    doctor(): Promise<{
        pausedHandoffs: PauseHandoff[];
        activeRuns: Array<Pick<Run, "intentId" | "sessionId" | "turnId" | "status" | "phase" | "worktreePath" | "branch" | "projectRoot" | "taskId">>;
    }>;
    migratePlanState(intentId: string, planPaths: string[]): Promise<string[]>;
    recordRed(intentId: string, command?: string, ticketFilter?: string): Promise<Run>;
    recordPreparedMerge(intentId: string, prepared: PreparedMerge): Promise<Run>;
    discardPreparedMerge(intentId: string, prepared: PreparedMerge): Promise<Run>;
    acquireWorktreeMutation(intentId: string, kind: WorktreeMutationOperation["kind"], request: unknown): Promise<WorktreeMutationOperation>;
    takeOverPreparedMergeForAbort(intentId: string, prepared: PreparedMerge, pinnedMergeStarted?: boolean): Promise<WorktreeMutationOperation>;
    assertWorktreeMutation(intentId: string, operation: WorktreeMutationOperation): Promise<void>;
    releaseWorktreeMutation(intentId: string, operation: WorktreeMutationOperation): Promise<Run>;
    assertPreparedMergeAuthority(intentId: string, prepared: PreparedMerge, operation: WorktreeMutationOperation, expectedKind?: "merge" | "abort"): Promise<void>;
    acquireCommitOperation(intentId: string, request: CommitOperationRequest): Promise<CommitOperation>;
    reserveCommitOperation(intentId: string, request: CommitOperationRequest): Promise<CommitOperation>;
    commitOperationFor(intentId: string, request: CommitOperationRequest): Promise<CommitOperation>;
    assertPreparedCommitAuthority(intentId: string, prepared: PreparedCommitCore, operation: CommitOperation): Promise<void>;
    discardCommitOperation(intentId: string, operation: CommitOperation): Promise<Run>;
    recordPreparedCommit(intentId: string, prepared: PreparedCommit, operation: CommitOperation): Promise<Run>;
    discardPreparedCommit(intentId: string, candidate: string): Promise<Run>;
    resumeTarget(resumeIntentId: string): Promise<Run>;
    recoverAdvancedPreparedCommit(intentId: string, commit: CommitEvidence, firstParent: string[], candidateVerification: {
        tree: string;
        subject: string;
    }): Promise<Run>;
    /** Associate only an authenticated standalone Prep candidate, under its existing resource fence. */
    recordMergeIntegration(intentId: string, mergeId: string, mergeRevision: number, assertAuthority: () => Promise<void>): Promise<Run>;
    recordCommit(intentId: string, commit: CommitEvidence, final?: boolean): Promise<Run>;
    reconcileAuthorizedCommit(intentId: string, request: CommitOperationRequest, commit: CommitEvidence): Promise<Run>;
    private recordCommitCore;
    completedCommitFor(intentId: string, request: CommitOperationRequest): Promise<Run | undefined>;
    finishTerminalCommit(intentId: string, requestSha256: string): Promise<Run>;
    runCheck(intentId: string, scope: string, ticketFilter?: string): Promise<Run>;
    prove(intentId: string): Promise<Run>;
    private proveAttempt;
    private isFrozenPlan;
    assertFrozenScope(intentId: string): Promise<void>;
    recordPlanReview(intentId: string, input: {
        decision: "accept" | "needs_changes";
        humanFeedback: string;
    }): Promise<Run>;
    recordHitlFeedback(intentId: string, input: HitlFeedbackInput): Promise<Run>;
    status(intentId: string): Promise<Run>;
    acquireTargetLease(intentId: string, commonGitDir: string, targetBranch: string, targetOid: string): Promise<{
        leaseId: string;
        leaseToken: `${string}-${string}-${string}-${string}-${string}`;
    }>;
    private safePlanPath;
    private projectPlanState;
    releaseTargetLease(leaseId: string, intentId: string, leaseToken: string): Promise<void>;
    permitFor(sessionId: string, turnId: string): Promise<ReturnType<LifecycleStore["permit"]> | null>;
    private permit;
    private phase;
    private run;
    private update;
    private writeRunWatermark;
    private reconcileRunProjections;
    private assertStableRun;
    private project;
    private assertBeginOperation;
    private assertBeginReservation;
    private authorizeCommitOperation;
    private proofSourceRepairFence;
    private assertCommitted;
    private assertCommitOperation;
    private captureSessionOwner;
    private assertRecoverableSameSessionWithoutLease;
    private readSessionOwner;
    private interruptionLeaseReadOnly;
    private assertInterruptionSelectors;
    private interruptionSelectorId;
    private completePendingSessionInterruption;
    private interruptionResult;
    private interruptionRunReadOnly;
    private assertSessionLease;
    private finalizeCompletion;
    private releaseCompletedLease;
    private resumeHandoff;
    private expectedHead;
    private assertWorktreeBinding;
    private load;
    private save;
}
