import type { PreparedMerge } from "./workspace.js";
export type Profile = "feature" | "pre-release";
export type GateResult = {
    exitCode: number;
    stdout: string;
    stderr: string;
};
export type GateRunner = (command: string, cwd: string) => Promise<GateResult>;
export type SourceState = {
    head: string;
    tree: string;
    status: string;
    manifest?: string;
};
export type StateProbe = (cwd: string, policy?: ProjectPolicy) => Promise<SourceState>;
export type CommitPolicy = {
    conventional?: boolean;
    require_version_suffix?: boolean;
    require_task_trailer?: boolean;
    version_file: string;
    version_surfaces?: Array<{
        path: string;
        pattern: string;
    }>;
    changelog_files: string[];
};
export type ProjectPolicy = {
    profile: Profile;
    profiles?: Profile[];
    visualRequired: boolean;
    commands: Record<string, string>;
    artifactPaths?: Record<string, string>;
    redGate?: {
        expectedExitCodes: number[];
        outputPattern: string;
    };
    commitPolicyPath?: string;
    commitPolicySha256?: string;
    commit?: CommitPolicy;
    sourceManifestExcludes?: string[];
};
export type Intent = {
    intentId: string;
    sessionId: string;
    turnId: string;
    projectRoot: string;
    prompt: string;
    requestedProfile?: Profile;
    capability?: string;
    consumed?: boolean;
    resumeOf?: string;
};
export type Run = {
    schemaVersion: 1;
    runId: string;
    intentId: string;
    sessionId: string;
    turnId: string;
    taskId?: string;
    objective: string;
    projectRoot: string;
    worktreePath: string;
    baseHead: string;
    profile: Profile;
    visualRequired: boolean;
    startedAt: string;
    phase: "tdd_red" | "implement" | "prove" | "complete";
    status: "running" | "green" | "red";
    policy: ProjectPolicy;
    preparedMerges?: PreparedMerge[];
    committedState?: SourceState;
    evidence: Array<Record<string, unknown>>;
};
export type BeginInput = Omit<Run, "schemaVersion" | "runId" | "sessionId" | "turnId" | "startedAt" | "phase" | "status" | "committedState" | "evidence" | "profile" | "visualRequired">;
export type CommitEvidence = {
    head: string;
    tree?: string;
    commitCount: number;
    clean: boolean;
    subject: string;
    versionChanged: boolean;
    changelogChanged: boolean;
    taskTrailerValid?: boolean;
    versionSurfacesValid?: boolean;
    preparedMergesValid?: boolean;
    phaseCommitsValid?: boolean;
};
export declare class LifecycleStore {
    private readonly dataRoot;
    private readonly runner;
    private readonly probe?;
    constructor(dataRoot: string, runner: GateRunner, probe?: StateProbe | undefined);
    markIntent(intent: Intent): Promise<void>;
    validateIntent(intentId: string, projectRoot: string): Promise<Intent>;
    begin(input: BeginInput): Promise<Run>;
    resume(resumeIntentId: string): Promise<Run>;
    recordRed(intentId: string, command?: string): Promise<Run>;
    recordPreparedMerge(intentId: string, prepared: PreparedMerge): Promise<Run>;
    discardPreparedMerge(intentId: string, prepared: PreparedMerge): Promise<Run>;
    recordCommit(intentId: string, commit: CommitEvidence): Promise<Run>;
    runCheck(intentId: string, scope: string): Promise<Run>;
    prove(intentId: string): Promise<Run>;
    private proveAttempt;
    status(intentId: string): Promise<Run>;
    permitFor(sessionId: string, turnId: string): Promise<ReturnType<LifecycleStore["permit"]> | null>;
    private permit;
    private phase;
    private run;
    private update;
    private assertCommitted;
    private load;
    private save;
}
