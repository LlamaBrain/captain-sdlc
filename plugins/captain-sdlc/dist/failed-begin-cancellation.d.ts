import type { BeginDiagnosticArgs } from "./begin-diagnostics.js";
import type { LifecycleStore } from "./lifecycle.js";
export type CancelFailedBeginArgs = BeginDiagnosticArgs & {
    expected_lease_revision: number;
    resource_generation: string;
    confirm_owner_stopped: boolean;
};
/** Retire only an authenticated terminal pre-workspace Begin with an exact lease generation. */
export declare function captainCancelFailedBegin(store: LifecycleStore, args: CancelFailedBeginArgs): Promise<{
    intent_id: string;
    state: "cancelled";
    cancelled: true;
}>;
