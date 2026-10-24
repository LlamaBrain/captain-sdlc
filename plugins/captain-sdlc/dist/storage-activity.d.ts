import { type WorktreeRegistration } from "./worktree-storage.js";
/** This is a task reservation, never a claim about the short-lived helper process. */
export declare function readOrdinaryActivity(dataRoot: string, registration: WorktreeRegistration): Promise<"active" | "inactive" | "reserved">;
export declare function markOrdinaryActive(dataRoot: string, registration: WorktreeRegistration): Promise<void>;
/** Only explicit completion of the selected task can release its active reservation. */
export declare function finishOrdinaryActivity(dataRoot: string, registration: WorktreeRegistration): Promise<void>;
