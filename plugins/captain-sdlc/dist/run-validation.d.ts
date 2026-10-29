import type { Run } from "./lifecycle.js";
export declare function executionHead(run: Run): string;
/** Structural version recognition only; authenticate the revision chain before trusting a run. */
export declare function isSupportedRunSchema(value: unknown): boolean;
export declare function assertRunRevisionTransition(previous: Run | undefined, current: Run): void;
