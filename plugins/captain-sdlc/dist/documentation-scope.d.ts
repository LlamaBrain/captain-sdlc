import type { Run } from "./lifecycle.js";
export type DocumentationScope = {
    schemaVersion: 1;
    expectedHead: string;
    paths: string[];
    pathDigests: Record<string, string | null>;
    reason: string;
    recordedAt: string;
    sessionId: string;
    turnId: string;
    policySha256: string;
    captureMode: "planned" | "existing_changes";
};
export declare function captureDocumentationScope(run: Run, paths: string[], reason: string, expectedHead: string): Promise<DocumentationScope>;
export declare function assertDocumentationScope(run: Run, candidate?: string): Promise<void>;
