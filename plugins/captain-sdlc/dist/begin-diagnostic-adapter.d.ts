import { type BeginDiagnosticArgs } from "./begin-diagnostics.js";
export declare function createBeginDiagnosticAdapter(dataRoot: string): (args: BeginDiagnosticArgs) => Promise<{
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
    reservation: "absent" | "verified" | "mismatched";
    repository_checkpoint: "absent" | "verified" | "mismatched";
    lease_checkpoint: "absent" | "verified" | "mismatched";
    stage: string;
    target_lease: {
        state: "held" | "released" | "absent";
        owner: "legacy" | "live" | "stopped" | "foreign_host" | "unknown" | "other";
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
