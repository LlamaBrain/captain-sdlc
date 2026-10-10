export type SessionOwner = {
    pid: number;
    host: string;
    startedAt: string;
    closeTokenHash?: string;
};
export type SessionOwnerState = "live" | "stopped" | "foreign_host" | "unknown" | "legacy";
export type SessionOwnerProbe = {
    state: SessionOwnerState;
    reason?: string;
};
export declare function validateSessionOwner(owner: SessionOwner): void;
/** Capture the actual client PID supplied by its trusted adapter, never the MCP host by default. */
export declare function captureClientSessionOwner(clientPid: number, closeTokenHash?: string): Promise<SessionOwner>;
export declare function probeSessionOwner(owner: SessionOwner): Promise<SessionOwnerProbe>;
