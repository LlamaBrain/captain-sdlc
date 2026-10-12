import type { ProjectPolicy } from "./lifecycle.js";
import { assertWorktreeBinding, type PreparedCommitCore } from "./workspace.js";
export type FinalizationArgs = {
    worktree: string;
    session_id: string;
    task_id: string;
    paths: string[];
    subject: string;
    disposition: "commit" | "stash";
    finalization_id?: string;
};
export type FinalizationStatusArgs = {
    finalization_id: string;
    session_id: string;
    worktree?: string;
};
export type FinalizationOptions = {
    policy?: ProjectPolicy;
    expected_head?: string;
    expected_binding?: Pick<Binding, "branch" | "commonGitDir" | "gitDir" | "topLevel">;
};
type Binding = Awaited<ReturnType<typeof assertWorktreeBinding>>;
export type FinalizationPathSnapshot = {
    path: string;
    working_sha256: string | null;
    working_blob: string | null;
    head_entry: string | null;
    index_entry: string | null;
};
type LeaseSpec = {
    id: string;
    token: string;
    operation: string;
};
type LeaseGeneration = {
    id: string;
    token: string;
    revision: number;
    resource_generation: string;
};
export type FinalizationReceipt = {
    schema_version: 1;
    finalization_id: string;
    revision: number;
    previous_sha256?: string;
    session_id: string;
    task_id: string;
    worktree: string;
    paths: string[];
    subject: string;
    disposition: "commit" | "stash";
    state: "pending" | "commit_prepared" | "stash_prepared" | "committed" | "stashed";
    request_sha256: string;
    before: Binding;
    after?: Binding;
    policy: ProjectPolicy;
    policy_sha256: string;
    snapshot: FinalizationPathSnapshot[];
    index_tree: string;
    lease_specs: LeaseSpec[];
    lease_generations?: LeaseGeneration[];
    stash_marker: string;
    stash_oid?: string;
    commit_oid?: string;
    prepared_commit?: PreparedCommitCore;
    evidence: Array<Record<string, unknown>>;
};
export type FinalizationHooks = {
    afterCommitRefUpdate?: () => Promise<void>;
    afterStash?: () => Promise<void>;
};
export declare class BookkeepingFinalizationError extends Error {
    readonly finalization_id: string;
    constructor(finalization_id: string, cause: unknown);
}
/** Independent bookkeeping ledger: product runs, acceptance and proof remain unchanged. */
export declare class BookkeepingFinalizationStore {
    private readonly dataRoot;
    private readonly hooks;
    constructor(dataRoot: string, hooks?: FinalizationHooks);
    finalize(args: FinalizationArgs, options?: FinalizationOptions): Promise<FinalizationReceipt>;
    /** Read-only absence probe; missing signed checkpoints are integrity failures. */
    hasStarted(args: FinalizationStatusArgs): Promise<boolean>;
    status(args: FinalizationStatusArgs): Promise<FinalizationReceipt>;
    private match;
    private attempt;
    private leasePayload;
    private resources;
    private assertResources;
    private assertNoOwner;
    private initial;
    private update;
    private watermark;
    private stable;
    private optionalRead;
    private read;
}
export {};
