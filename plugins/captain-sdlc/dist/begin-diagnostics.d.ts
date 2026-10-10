type AnyRecord = Record<string, unknown>;
type LeaseSnapshot = {
    state: "held" | "released";
    payload: AnyRecord & {
        intentId: string;
        leaseToken: string;
    };
    revision: number | null;
    legacy: boolean;
    integrity: "verified";
};
export type BeginDiagnosticArgs = {
    intent_id: string;
    session_id: string;
    project_root: string;
    target_worktree: string;
    target_branch: string;
};
export type BeginDiagnosticDependencies = {
    readSigned(bucket: string, id: string): Promise<AnyRecord>;
    listSigned(bucket: string): Promise<string[]>;
    readLease(leaseId: string): Promise<LeaseSnapshot | undefined>;
    inspectGit(input: {
        projectRoot: string;
        targetWorktree: string;
        targetBranch: string;
        targetOid: string;
        canonicalProposedPath: string;
    }): Promise<{
        projectRoot: string;
        targetWorktree: string;
        commonGitDir: string;
        targetRefOid: string;
        targetBranchWorktreePath?: string;
        targetBranchWorktreeHead?: string;
        canonicalProposedPathExists: boolean;
        canonicalWorktreeRegistered: boolean;
        pendingGitOperation: boolean | "unknown";
    }>;
    ownerState(payload: AnyRecord): "live" | "stopped" | "foreign_host" | "unknown";
};
export declare function diagnoseBeginTargetLease(args: BeginDiagnosticArgs, deps: BeginDiagnosticDependencies): Promise<{
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
export {};
