export type UserAuthorization = {
    operation: "commit" | "merge";
    decision: "approve" | "revoke";
    targetBranch?: string;
    quote: string;
};
export type AuthorizationReceipt = UserAuthorization & {
    schemaVersion: 1;
    id: string;
    source: "UserPromptSubmit" | "client-adapter";
    sessionId: string;
    turnId: string;
    instructionIndex: number;
    intentId?: string;
    taskId?: string;
    projectRoot: string;
    commonGitDir: string;
    sourceBranch: string;
    recordedAt: string;
};
type RecordInput = {
    projectRoot: string;
    sessionId: string;
    turnId: string;
    prompt: string;
    intentId?: string;
    taskId?: string;
    source: AuthorizationReceipt["source"];
};
export type AuthorizationQuery = {
    projectRoot: string;
    sessionId?: string;
    intentId?: string;
    operation?: UserAuthorization["operation"];
    targetBranch?: string;
};
export declare function parseUserAuthorizations(prompt: string): UserAuthorization[];
export declare function recordUserAuthorizations(data: string, input: RecordInput): Promise<AuthorizationReceipt[]>;
export declare function userAuthorizationStatus(data: string, query: AuthorizationQuery): Promise<{
    receipts: AuthorizationReceipt[];
    guidance: string;
}>;
export {};
