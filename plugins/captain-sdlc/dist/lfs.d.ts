/** A Git LFS SHA-256 object. Object paths are always derived from the validated OID. */
export type LfsPointer = {
    oid: string;
    size: number;
};
/**
 * Parse the strict Git LFS v1 and historical Hawser formats. Ordinary blobs, including
 * Git LFS's empty-file passthrough, return null. A pointer-looking malformed or
 * extension-bearing blob throws; we cannot safely execute configured LFS extensions.
 */
export declare function parseLfsPointer(bytes: Buffer): LfsPointer | null;
/** Emit the canonical current pointer, retaining Git LFS's empty-file passthrough. */
export declare function formatLfsPointer(value: LfsPointer): Buffer;
export declare function hashLfsFile(file: string): Promise<LfsPointer>;
/** Verify an already present local LFS object; missing and corrupted objects fail closed. */
export declare function verifyLfsObject(objectsRoot: string, value: LfsPointer): Promise<string>;
/**
 * Stream to an exclusive temporary file, then publish by an atomic no-overwrite
 * hard link. Existing content is verified rather than replaced.
 */
export declare function persistLfsObject(objectsRoot: string, sourceFile: string): Promise<LfsPointer>;
/** Hydrate only an unchanged pointer file, and publish only after integrity checks. */
export declare function hydrateLfsObject(objectsRoot: string, value: LfsPointer, destinationFile: string): Promise<void>;
