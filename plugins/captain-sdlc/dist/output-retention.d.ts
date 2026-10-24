import type { ProjectPolicy } from "./lifecycle.js";
export type OutputRetention = {
    schema_version: 1;
    roots: Record<string, string[]>;
};
export type OutputPreparation = {
    scope: string;
    roots: string[];
    removedFiles: number;
    retainedTrackedFiles: number;
};
/** Output ownership is explicit and narrower than the repository or its worktree container. */
export declare function outputRoot(value: unknown): string;
/** Called only while capturing a new policy; saved policies never gain deletion authority. */
export declare function captureOutputRetention(root: string, baseHead: string, raw: unknown, artifactPaths?: Record<string, string>, trackedBasePaths?: string[], sourceExcludes?: string[]): Promise<OutputRetention>;
/** Generated files are not source inputs; tracked build surfaces remain bound to their hashes. */
export declare function outputPathExcluded(relative: string, policy: Pick<ProjectPolicy, "outputRetention">, tracked: Set<string>): boolean;
/** Preflight every declared output tree before removing generated files from any of them. */
export declare function prepareScopeOutputs(worktree: string, policy: Pick<ProjectPolicy, "outputRetention">, scope: string, options?: {
    validateOnly?: boolean;
}): Promise<OutputPreparation>;
/** Validate a prospective stable slot before recording immutable ownership metadata. */
export declare const validateScopeOutputs: (worktree: string, policy: Pick<ProjectPolicy, "outputRetention">, scope: string) => Promise<OutputPreparation>;
