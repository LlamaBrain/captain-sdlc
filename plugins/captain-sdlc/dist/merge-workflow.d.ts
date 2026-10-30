import { type FinalizationArgs, type FinalizationReceipt } from "./bookkeeping-finalization.js";
import { type GateRunner, type ProjectPolicy, type Run } from "./lifecycle.js";
import { assertWorktreeBinding, sourceState, type PreparedCommitCore, type PreparedMerge } from "./workspace.js";
import { type WorktreeCleanupResult } from "./worktree-cleanup.js";
export type MergeCommitInput = {
    paths: string[];
    subject: string;
    task_outcome?: "Implements" | "Completes" | "Needs-QA";
    task_id?: string;
};
export type MergeFinalizationSelection = Omit<FinalizationArgs, "worktree" | "session_id">;
export type MergeFinalizationInput = {
    source?: MergeFinalizationSelection;
    target?: MergeFinalizationSelection;
};
export type MergePrepArgs = {
    source_worktree: string;
    target_worktree: string;
    target_branch: string;
    session_id: string;
    merge_id?: string;
    commit?: MergeCommitInput;
    finalization?: MergeFinalizationInput;
};
export type MergeBackArgs = {
    merge_id: string;
    session_id: string;
    source_worktree?: string;
    target_worktree?: string;
    target_branch?: string;
    finalization?: MergeFinalizationInput;
};
export type MergeLeaseRecoveryArgs = MergeBackArgs & {
    source_worktree: string;
    target_worktree: string;
    target_branch: string;
    expected_revision: number;
    expected_lease_token: string;
    confirm_owner_stopped?: boolean;
};
export type MergeState = "preparing" | "needs_resolution" | "needs_commit" | "verifying" | "failed" | "ready" | "integrating" | "merged";
type Binding = Awaited<ReturnType<typeof assertWorktreeBinding>>;
type Inputs = {
    source: Awaited<ReturnType<typeof sourceState>>;
    metadata: string;
    dependencies: Array<Record<string, unknown>>;
    lfs_objects?: Array<{
        oid: string;
        size: number;
    }>;
};
type GateEvidence = {
    scope: string;
    commandSha256: string;
    exitCode: number;
    stdoutSha256: string;
    stderrSha256: string;
};
export type MergeRecord = {
    schema_version: 1;
    merge_id: string;
    revision: number;
    previous_sha256?: string;
    session_id: string;
    state: MergeState;
    source_worktree: string;
    target_worktree: string;
    target_branch: string;
    source_binding: Binding;
    target_binding: Binding;
    captured_policy: ProjectPolicy;
    policy_sha256: string;
    strictness: "low" | "standard" | "strict";
    scopes: string[];
    prepared_merge?: PreparedMerge;
    prepared_commit?: PreparedCommitCore;
    prepared_commit_request?: MergeCommitInput;
    conflicts: string[];
    gates: GateEvidence[];
    finalizations?: FinalizationReceipt[];
    finalization_requests?: Partial<Record<"source" | "target", {
        selection: MergeFinalizationSelection;
        expected_head: string;
    }>>;
    bookkeeping_extensions?: Array<{
        kind: "source" | "target";
        from_head: string;
        to_head: string;
    }>;
    integration_inputs?: Inputs;
    attempted_inputs?: Inputs;
    ready_inputs?: Inputs;
    failure?: string;
    integrated_head?: string;
    lfs_fast_forward?: {
        id: string;
        sha256: string;
    };
    lfs_merge?: {
        id: string;
        sha256: string;
    };
    cleanup?: WorktreeCleanupResult;
};
export type MergeLeaseOwner = {
    pid?: number;
    host?: string;
    state: "stopped" | "live" | "foreign_host" | "unknown" | "legacy";
};
export type MergeOperationLeaseStatus = {
    state: "absent" | "held" | "released";
    owner?: MergeLeaseOwner;
    recovery?: {
        next_tool: "captain_recover_merge_lease";
        args: MergeLeaseRecoveryArgs;
        eligible: boolean;
        requires_owner_stop_verification: boolean;
        reason: string;
    };
};
export type MergeStatus = MergeRecord & {
    receipt_valid?: boolean;
    stale_reason?: string;
    captain_green: false;
    operation_lease?: MergeOperationLeaseStatus;
};
export type MergeDiagnosticArgs = Pick<MergePrepArgs, "session_id" | "source_worktree" | "target_worktree" | "target_branch">;
export type MergeDiagnostic = {
    read_only: true;
    captain_green: false;
    operations: Array<Pick<MergeRecord, "merge_id" | "revision" | "state" | "source_worktree" | "target_worktree" | "target_branch"> & {
        source_head: string;
        target_head: string;
    }>;
    target_lease: {
        state: "absent" | "held" | "released";
        intent_id?: string;
        operation?: string;
        owner?: MergeLeaseOwner;
        session_match?: "same" | "other" | "unknown";
    };
};
/** Context is attached only after Prep has established its caller-owned signed record. */
export declare class MergeWorkflowError extends Error {
    readonly merge_id: string;
    constructor(merge_id: string, cause: unknown);
}
/** Independent integration ledger. Signed candidates may append intermediate phase evidence; prior proof is retained. */
export declare class MergeWorkflowStore {
    private readonly dataRoot;
    private readonly runner;
    private readonly activeOperations;
    constructor(dataRoot: string, runner?: GateRunner);
    private fastForwardCheckpoint;
    private lfsMergeCheckpoint;
    diagnose(args: MergeDiagnosticArgs): Promise<MergeDiagnostic>;
    prep(args: MergePrepArgs): Promise<MergeStatus>;
    /** Recover an older signed Prep candidate without trusting caller-supplied source evidence. */
    reconcileImplementation(args: {
        merge_id: string;
        session_id: string;
        intent_id: string;
    }): Promise<{
        merge_id: string;
        implementation: Run;
        captain_green: false;
    }>;
    private reconcileOwnedImplementation;
    back(args: MergeBackArgs): Promise<MergeStatus>;
    status(args: MergeBackArgs): Promise<MergeStatus>;
    private assertHistoricalMerge;
    private historicalRepository;
    private cleanedHead;
    private compactEvidence;
    private cleanupCandidates;
    private cleanupMergedChain;
    private operationLeaseStatus;
    recoverStaleLease(args: MergeLeaseRecoveryArgs): Promise<{
        merge_id: string;
        released: boolean;
        released_resource_leases: number;
        merge_revision: number;
        resumed_operation: string;
    }>;
    private assertMergeLease;
    private assertLeaseOwnerStopped;
    private leaseOwnerStatus;
    private readHeldLease;
    private session;
    private match;
    private output;
    private bindings;
    private validateLfsFastForwardInputs;
    private resumeLfsMerge;
    private assertTargetLfsCompatibility;
    private assertInputs;
    private assertReady;
    private deliveryInputs;
    /** Rules captured by Prep can excuse records, never new product or dependency inputs. */
    private associateBookkeepingInputs;
    private advanceBookkeepingTarget;
    private finalizeSelected;
    private retireFinalizationRequest;
    private assertRecordContinuity;
    private lock;
    private resources;
    private initial;
    private update;
    private watermark;
    /** Verify existing history and watermarks; never repair a checkpoint while diagnosing. */
    private readForDiagnosis;
    private read;
}
export {};
