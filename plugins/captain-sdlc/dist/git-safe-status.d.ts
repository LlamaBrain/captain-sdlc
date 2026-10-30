export type GitReader = (args: string[], cwd: string) => Promise<string>;
export type IndexedLfs = {
    path: string;
    oid: string;
    size: number;
    pointer: Buffer;
    indexOid: string;
};
export type ShadowGit = {
    dir: string;
    root: string;
    indexFile: string;
    fileMode: boolean;
    run(args: string[], input?: string | Buffer): Promise<Buffer>;
    mergeTree(ours: string, theirs: string): Promise<{
        status: "clean" | "conflicts";
        output: Buffer;
        binaryPaths: string[];
    }>;
    writeMergeCommit(tree: string, ours: string, theirs: string): Promise<string>;
    checkAttributes(paths: string[], attributes: string[], cached?: boolean): Promise<Array<{
        path: string;
        attributes: Record<string, string>;
    }>>;
    writeObject(value: Buffer): Promise<string>;
    stageFiles(paths: string[]): Promise<void>;
    publishIndex(): Promise<void>;
};
/** Git before 2.43 can crash on merge-tree with a pinned attribute source. */
export declare function assertMergeTreeGitVersion(value: string): void;
/** Private Git metadata prevents repository-controlled filters and hooks from running. */
export declare function withShadowGit<T>(worktree: string, git: GitReader, operation: (shadow: ShadowGit) => Promise<T>): Promise<T>;
/** Callers that stage or hydrate require a fully resolved index. */
export declare const listShadowIndexedLfs: (shadow: ShadowGit) => Promise<IndexedLfs[]>;
/** Discover indexed LFS pointers without starting repository-defined programs. */
export declare const listIndexedLfs: (worktree: string, git: GitReader) => Promise<IndexedLfs[]>;
/** Preserve Git porcelain using a private index and no executable repository filters. */
export declare const safeGitStatus: (worktree: string, git: GitReader) => Promise<string>;
/** NUL-delimited status detects edits and modes even under manifest-excluded directories. */
export declare const safeGitJournalStatusRaw: (worktree: string, git: GitReader) => Promise<Buffer<ArrayBufferLike>>;
/** The tracked worktree diff must not run repository-configured clean filters. */
export declare const safeGitDiffNames: (worktree: string, git: GitReader) => Promise<string>;
/** Preserve NUL-delimited bytes for a pinned-commit versus working-tree diff. */
export declare function safeGitDiffRaw(worktree: string, git: GitReader, base: string): Promise<Buffer>;
/** HEAD is pinned in the private shadow and checked again before returning. */
export declare const safeGitDiffHeadRaw: (worktree: string, git: GitReader) => Promise<Buffer<ArrayBufferLike>>;
/** Unmerged paths are index-only; no working-tree conversion is needed. */
export declare function safeGitUnmergedNames(worktree: string, git: GitReader): Promise<string>;
