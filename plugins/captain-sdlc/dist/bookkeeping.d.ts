import type { CommitPolicy } from "./lifecycle.js";
export type BookkeepingPolicy = {
    path_file: string;
    patterns?: string;
    sha256?: string;
};
type Git = (args: string[], cwd: string) => Promise<string>;
/** Raw policy declares a committed rule file; captured rules are loader-owned. */
export declare function validateBookkeepingPolicy(input: unknown): BookkeepingPolicy;
export declare function bookkeepingCaptured(policy: CommitPolicy): boolean;
export declare function bookkeepingSubjectAllowed(subject: string): boolean;
export declare function bookkeepingTextAllowed(content: string | Buffer): boolean;
/** Uses only captured captain.ignore through Git's own gitignore parser. */
export declare function bookkeepingPathAllowedCore(relative: string, policy: CommitPolicy, git: Git): Promise<boolean>;
export declare function bookkeepingPathAllowed(relative: string, policy: CommitPolicy): Promise<boolean>;
export {};
