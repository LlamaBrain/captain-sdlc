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
export {};
