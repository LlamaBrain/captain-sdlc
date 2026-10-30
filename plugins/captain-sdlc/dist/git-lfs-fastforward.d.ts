import { type GitReader } from "./git-safe-status.js";
export type Fingerprint = {
    sha256: string;
    size: number;
    dev: string;
    ino: string;
    executable: boolean;
};
type DirectoryIdentity = {
    dev: string;
    ino: string;
};
type WindowsAcl = {
    parent: string;
    before?: string;
    after?: string;
};
type Change = {
    path: string;
    before?: Fingerprint;
    after?: Fingerprint;
    staged?: string;
    backup?: string;
    windows_acl?: WindowsAcl;
};
type WindowsDirectory = {
    path: string;
    id: DirectoryIdentity;
    acl: string;
};
type WindowsDirectoryRoot = {
    path: string;
    staged: string;
    parent_id: DirectoryIdentity;
    parent_acl: string;
    nodes: WindowsDirectory[];
};
type PosixDirectory = {
    path: string;
    id: DirectoryIdentity;
};
type GitMetadata = {
    config_sha256: string;
    attributes?: Fingerprint;
    exclude?: Fingerprint;
};
export type LfsFastForwardPlan = {
    schema_version: 1;
    root: string;
    git_dir: string;
    common_git_dir: string;
    branch: string;
    root_id: DirectoryIdentity;
    git_dir_id: DirectoryIdentity;
    common_git_dir_id: DirectoryIdentity;
    old_head: string;
    new_head: string;
    transaction_dir: string;
    transaction_id: {
        dev: string;
        ino: string;
    };
    old_index: Fingerprint;
    new_index: Fingerprint;
    prepared_index: string;
    metadata: GitMetadata;
    changes: Change[];
    input_manifest?: string;
    windows_directories?: WindowsDirectoryRoot[];
    posix_directories?: PosixDirectory[];
};
/** MoveFileW rejects every pre-existing destination, unlike Node's Windows rename. */
export declare function moveWindowsDirectoryNoReplace(source: string, destination: string): Promise<void>;
export declare function safeRelative(value: string): string;
export declare function fingerprint(file: string): Promise<Fingerprint | undefined>;
export declare function matches(actual: Fingerprint | undefined, expected: Fingerprint | undefined): boolean;
export declare function writeDurable(file: string, bytes: Buffer): Promise<void>;
/** Hidden index flags can conceal a user's actual file content from ordinary status. */
export declare function assertVisibleFastForwardIndex(root: string, git: GitReader): Promise<void>;
/** Prepare verified files and index without changing the target checkout or refs. */
export declare function prepareLfsFastForward(root: string, branch: string, oldHead: string, newHead: string, git: GitReader): Promise<LfsFastForwardPlan>;
export declare function applyLfsFastForward(plan: LfsFastForwardPlan, git: GitReader, authorize: () => Promise<void>, checkpoint: (phase: string) => Promise<void>, validateInputs?: () => Promise<void>): Promise<void>;
export declare function applyLfsMergeTransition(plan: LfsFastForwardPlan, git: GitReader, authorize: () => Promise<void>, checkpoint: (phase: string) => Promise<void>): Promise<void>;
export {};
