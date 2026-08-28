export type Permit = {
    sessionId: string;
    turnId?: string;
    worktreePath: string;
    phase: string;
    intentId?: string;
};
export type MutationInput = {
    toolName: string;
    cwd: string;
    sessionId: string;
    permit: Permit | null;
    command?: string;
    intentId?: string;
};
export declare function mutationDecision(input: MutationInput): {
    allow: boolean;
    reason?: string;
};
