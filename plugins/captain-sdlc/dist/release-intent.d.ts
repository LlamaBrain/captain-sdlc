export type ReleaseIntentChecker = {
    path: string;
    sha256: string;
    args?: string[];
};
export declare function assertReleaseIntentChecker(checker: ReleaseIntentChecker, forbiddenRoots: string[]): Promise<void>;
export declare function releaseIntentCommand(checker: ReleaseIntentChecker): string;
export declare function runReleaseIntentChecker(checker: ReleaseIntentChecker, cwd: string, forbiddenRoots: string[]): Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
}>;
