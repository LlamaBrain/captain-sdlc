type LeasePayload = {
    intentId: string;
    leaseToken: string;
    [key: string]: unknown;
};
export declare function writeAuthorized(root: string, bucket: string, id: string, payload: unknown): Promise<void>;
export declare function readAuthorized<T>(root: string, bucket: string, id: string): Promise<T>;
export declare function putAuthorizedOnceExact<T>(root: string, bucket: string, id: string, payload: T): Promise<T>;
export declare function readAuthorizedLease<T extends LeasePayload>(root: string, id: string): Promise<T>;
export declare function readAuthorizedLeaseState<T extends LeasePayload>(root: string, id: string): Promise<{
    state: "held" | "released";
    payload: T;
} | undefined>;
export declare function ensureAuthorizedLease<T extends LeasePayload>(root: string, id: string, payload: T): Promise<T>;
export declare function acquireAuthorizedLease<T extends LeasePayload>(root: string, id: string, payload: T): Promise<string>;
export declare function releaseAuthorizedLease(root: string, id: string, intentId: string, leaseToken: string): Promise<void>;
/** Release one inspected generation without following a replacement lease. */
export declare function releaseAuthorizedLeaseAtGeneration(root: string, id: string, intentId: string, leaseToken: string, expectedRevision: number, resourceGeneration: string): Promise<void>;
/** Authenticate existing evidence without bootstrapping keys or checkpoints. */
export declare function readAuthorizedReadOnly<T>(root: string, bucket: string, id: string): Promise<T>;
/** Inspect signed lease ownership without migration, watermark publication or recovery. */
export declare function readAuthorizedLeaseSnapshotReadOnly<T extends LeasePayload>(root: string, id: string): Promise<{
    state: "held" | "released";
    payload: T;
    revision: number | null;
    legacy: boolean;
} | undefined>;
/** Preserve the existing public read-only lease result shape. */
export declare function readAuthorizedLeaseStateReadOnly<T extends LeasePayload>(root: string, id: string): Promise<{
    state: "held" | "released";
    payload: T;
} | undefined>;
/** Migrate and release only one fully bound inspected raw legacy generation. */
export declare function releaseAuthorizedLegacyLeaseAtGeneration(root: string, id: string, intentId: string, leaseToken: string, resourceGeneration: string, afterMigration?: () => Promise<void>, afterRevision?: () => Promise<void>): Promise<void>;
/** Read the single incomplete legacy migration checkpoint without repairing it. */
export declare function readAuthorizedLegacyLeaseMigrationReadOnly<T extends LeasePayload = LeasePayload>(root: string, id: string, intentId: string, resourceGeneration: string): Promise<{
    state: "held";
    payload: T;
    revision: 0;
    legacy: false;
}>;
/** A repossessed intent can never publish a new Begin, even after projection replay. */
export declare function assertIntentNotRepossessed(root: string, intentId: string): Promise<void>;
export {};
