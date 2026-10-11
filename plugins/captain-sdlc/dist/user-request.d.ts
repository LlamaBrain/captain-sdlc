export type UserRequestInput = {
    projectRoot: string;
    sessionId: string;
    turnId: string;
    prompt: string;
    source: "UserPromptSubmit" | "client-adapter";
    /** The source event's intent; canonical mapping must already be authenticated by the caller. */
    sourceIntentId: string;
    /** Exact canonical task intent, never inferred from a matching task name. */
    intentId: string;
    taskId?: string;
    targetBranch?: string;
    requestKind?: "instruction" | "goal";
    /** The caller verifies this timestamp against immutable original source evidence. */
    sourceRecordedAt?: string;
};
export type UserRequestQuery = {
    projectRoot: string;
    intentId: string;
    sessionId?: string;
    expectedScopeSha256?: string;
    expectedTargetBranch?: string;
};
type ConsentDecision = "expressed" | "unclear" | "revoked";
type ConsentBasis = "direct_instruction" | "continuation" | "explicit_approval";
export type UserRequestReceipt = {
    schemaVersion: 1;
    id: string;
    source: UserRequestInput["source"];
    sourceIntentId: string;
    intentId: string;
    sessionId: string;
    turnId: string;
    taskId?: string;
    targetBranch?: string;
    /** A later explicit target is evidence to assess against the defining task target. */
    requestedTargetBranch?: string;
    requestKind?: UserRequestInput["requestKind"];
    projectRoot: string;
    commonGitDir: string;
    originalText: string;
    objectiveLines: string[];
    /** This source event's own candidate instruction lines; never overwrite the defining objective. */
    requestedLines?: string[];
    /** The original defining instruction, retained across an approved continuation. */
    objectiveOriginalText?: string;
    scopeSha256: string;
    inputSha256: string;
    decision: ConsentDecision;
    basis?: ConsentBasis;
    sequence: number;
    recordedAt: string;
    sourceRecordedAt?: string;
};
export type UserRequestStatus = {
    status: ConsentDecision | "stale" | "missing";
    receipts: UserRequestReceipt[];
    originalText?: string;
    objectiveLines: string[];
    scopeSha256?: string;
    reason?: string;
    guidance: string;
};
/** Persist original user evidence. The caller authenticates task ownership and resume links. */
export declare function recordUserRequest(data: string, input: UserRequestInput): Promise<UserRequestReceipt>;
/** Recollect authenticated existing receipts without creating keys or modifying evidence. */
export declare function userRequestStatus(data: string, query: UserRequestQuery): Promise<UserRequestStatus>;
export {};
