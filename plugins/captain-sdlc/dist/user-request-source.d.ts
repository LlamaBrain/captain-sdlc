export type UserRequestSourceInput = {
    projectRoot: string;
    sessionId: string;
    turnId: string;
    prompt: string;
    requestKind?: "instruction" | "goal";
    source: "UserPromptSubmit";
};
export type UserRequestSourceQuery = {
    projectRoot: string;
    sessionId: string;
    turnId: string;
    sourceId?: string;
};
export type UserRequestSourceReceipt = {
    schemaVersion: 1;
    id: string;
    originalText: string;
    commonGitDir: string;
    source: "UserPromptSubmit";
    sessionId: string;
    turnId: string;
    requestKind?: "instruction" | "goal";
    recordedAt: string;
};
export declare function readUserRequestSource(data: string, query: UserRequestSourceQuery): Promise<UserRequestSourceReceipt | undefined>;
export declare function recordUserRequestSource(data: string, input: UserRequestSourceInput): Promise<UserRequestSourceReceipt>;
