import { type Fingerprint, type LfsFastForwardPlan } from "./git-lfs-fastforward.js";
import { type GitReader } from "./git-safe-status.js";
import type { ProjectPolicy } from "./lifecycle.js";
export type LfsMergePlan = {
    schema_version: 1;
    transition: LfsFastForwardPlan;
    target_head: string;
    merge_head_file: string;
    merge_head: Fingerprint;
    conflicts: string[];
    input_manifest: string;
    object_pin: string;
    file_mode: boolean;
    conflict_witnesses: Array<{
        path: string;
        before?: Fingerprint;
    }>;
};
/** Tracked status complements the manifest, which intentionally omits some directories. */
export declare function assertJournalTrackedStatus(root: string, git: GitReader, allowed: string[], policy: ProjectPolicy): Promise<void>;
/** Prepare content privately and retain its objects with a private ref; leave the checkout and branch unchanged. */
export declare function prepareLfsMerge(root: string, branch: string, ours: string, theirs: string, git: GitReader, validateCommit: (commit: string) => Promise<unknown>): Promise<LfsMergePlan>;
/** Resume only the signed, authenticated preimage or result at every publication step. */
export declare function applyLfsMerge(plan: LfsMergePlan, git: GitReader, authorize: () => Promise<void>, checkpoint: (phase: string) => Promise<void>, validateInputs: () => Promise<void>): Promise<void>;
