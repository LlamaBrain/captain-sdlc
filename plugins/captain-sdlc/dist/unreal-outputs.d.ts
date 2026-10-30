/** Recognize only project output roots or output roots belonging to a plugin. */
export declare function isUnrealGeneratedPath(relative: string): boolean;
/** A captured policy can opt in only for an Unreal project and a real installed plugin. */
export declare function isApprovedUnrealGeneratedPath(root: string, relative: string, trackedBasePaths: readonly string[]): Promise<boolean>;
/** New tracked inputs must not disappear behind an exclusion captured earlier. */
export declare function assertNoTrackedExcludedPaths(exclusions: readonly string[], trackedPaths: Iterable<string>): void;
/** An excluded directory is never followed through a junction or symbolic link. */
export declare function assertUnrealExclusionRootsSafe(root: string, exclusions: readonly string[]): Promise<void>;
