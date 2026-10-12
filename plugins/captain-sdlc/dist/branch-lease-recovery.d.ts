export type BranchLeaseDiagnosticArgs = {
    project_root: string;
    target_worktree: string;
    target_branch: string;
    session_id: string;
};
export type BranchLeaseRepossessArgs = BranchLeaseDiagnosticArgs & {
    old_intent_id: string;
    expected_lease_revision: number | null;
    resource_generation: string;
    expected_head: string;
    reason: string;
    user_authorization: string;
};
type Selection = Omit<BranchLeaseRepossessArgs, "reason" | "user_authorization">;
export type BranchLeaseDiagnostic = {
    read_only: true;
    captain_green: false;
    eligible: boolean;
    reason: string;
    lease: {
        state: "absent" | "held" | "released";
        intent_id?: string;
        revision?: number | null;
        legacy_storage?: boolean;
        payload_fields?: string[];
    };
    recovery?: {
        next_tool: "captain_repossess_branch_lease";
        args: Selection | BranchLeaseRepossessArgs;
    };
    authority?: {
        matched_buckets: string[];
        intent_reference: boolean;
        operation_reference: boolean;
        session_match: "same" | "other" | "unknown";
        recorded_root_matches_repository: boolean;
        next_tool?: "captain_begin_diagnose";
        args?: {
            intent_id: string;
            session_id: string;
            project_root: string;
            target_worktree: string;
            target_branch: string;
        };
    };
};
export type BranchLeaseReceipt = BranchLeaseRepossessArgs & {
    schema_version: 1;
    recovery_id: string;
    state: "released";
    released_lease_revision: number;
};
export type FailedBeginReceipt = BranchLeaseRepossessArgs & {
    schema_version: 1;
    recovery_id: string;
    state: "revoked";
    released_lease_revision: number;
};
export type FailedBeginLeaseDiagnostic = {
    read_only: true;
    eligible: boolean;
    reason: string;
    verified_pre_workspace: boolean;
    original_session_match: "same" | "other" | "unknown";
    lease: BranchLeaseDiagnostic["lease"];
    original_state?: Record<string, unknown>;
    recovery?: {
        next_tool: "captain_repossess_failed_begin";
        args: Selection | BranchLeaseRepossessArgs;
    };
};
export type BranchLeaseRecoveryHooks = {
    afterGuard?: () => Promise<void>;
    afterTombstone?: () => Promise<void>;
    afterLegacyRevision?: () => Promise<void>;
    afterLegacyMigration?: () => Promise<void>;
    afterRelease?: () => Promise<void>;
};
/** Explicitly revoke one unclaimed legacy reservation; never allocate a checkout or alter Git. */
export declare class BranchLeaseRecoveryStore {
    private readonly dataRoot;
    private readonly hooks?;
    constructor(dataRoot: string, hooks?: BranchLeaseRecoveryHooks | undefined);
    diagnoseFailedBegin(input: BranchLeaseDiagnosticArgs): Promise<FailedBeginLeaseDiagnostic>;
    repossessFailedBegin(input: BranchLeaseRepossessArgs): Promise<FailedBeginReceipt>;
    private failedJournal;
    private verifiedFailedBegin;
    private sessionActivity;
    private mergeOwnerDiagnostic;
    diagnose(input: BranchLeaseDiagnosticArgs): Promise<BranchLeaseDiagnostic>;
    repossess(input: BranchLeaseRepossessArgs): Promise<BranchLeaseReceipt>;
    private journal;
    private readLease;
    private provenance;
    private marker;
    private inspect;
    private recoverableGuard;
    private withGuard;
    private assertGuard;
}
export {};
