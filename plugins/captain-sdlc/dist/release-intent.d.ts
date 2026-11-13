type PinnedFile = {
    path: string;
    sha256: string;
};
export type ScriptReleaseIntentChecker = PinnedFile & {
    kind?: "script";
    args?: string[];
};
export type NativeReleaseIntentChecker = PinnedFile & {
    kind: "native";
    executable: string;
    executableSha256: string;
    dependencies: PinnedFile[];
    args: string[];
};
export type ReleaseIntentChecker = ScriptReleaseIntentChecker | NativeReleaseIntentChecker;
export type NativeCompatibilityDecision = {
    report_digest: string;
    finding_digest: string;
    choice: "confirm-major" | "reject-major" | "revise";
    actor: string;
    reason: string;
    all_findings: boolean;
};
export type NativeReleaseIntentContext = {
    base: string;
    head: string;
    tree: string;
    decision?: NativeCompatibilityDecision;
};
export type NativeReleaseIntentSummary = {
    status: "ready" | "needs_human" | "needs_revision" | "blocked";
    base: string | null;
    policyBase: string | null;
    head: string | null;
    tree: string | null;
    bump: string | null;
    reportDigest: string | null;
    findingDigest: string | null;
    reportPath: string | null;
    humanReportPath: string | null;
    humanReportSha256?: string;
    errors: string[];
    coverage: Array<{
        name: string;
        status: "unavailable";
        reason: string;
        affected: boolean;
        onUnavailable: "block" | "report";
    }>;
};
type CheckerResult = {
    exitCode: number;
    stdout: string;
    stderr: string;
    summary?: NativeReleaseIntentSummary;
};
export declare function assertReleaseIntentChecker(checker: ReleaseIntentChecker, forbiddenRoots: string[]): Promise<void>;
export declare function releaseIntentCommand(checker: ReleaseIntentChecker): string;
export declare function runReleaseIntentChecker(checker: ReleaseIntentChecker, cwd: string, forbiddenRoots: string[]): Promise<CheckerResult>;
/** Called only through authority.ts, which owns the private key provider. */
export declare function runNativeReleaseIntentChecker(checker: NativeReleaseIntentChecker, cwd: string, forbiddenRoots: string[], context: NativeReleaseIntentContext, authority: () => Promise<Buffer>): Promise<CheckerResult>;
export {};
