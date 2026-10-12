import type { BeginDiagnosticArgs } from "./begin-diagnostics.js";
import type { BeginCancellationMarker, LifecycleStore } from "./lifecycle.js";
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
/** Validate the original immutable checkpoint graph; contains no owner-stop assertion. */
export declare function verifiedFailedBeginCancellationMarker(args: Omit<CancelFailedBeginArgs, "confirm_owner_stopped">, evidence: Awaited<ReturnType<LifecycleStore["readBeginCancellationEvidence"]>>): BeginCancellationMarker;
