import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
const currentVersion = "https://git-lfs.github.com/spec/v1";
const legacyVersion = "https://hawser.github.com/spec/v1";
const alphaVersion = "http://git-media.io/v/2";
const emptyOid = createHash("sha256").update(Buffer.alloc(0)).digest("hex");
const pointerLimit = 1024;
class LfsFileChangedError extends Error {
}
function checkedPointer(value) {
    if (!value || !/^[0-9a-f]{64}$/.test(value.oid) || !Number.isSafeInteger(value.size) || value.size < 0)
        throw new Error("invalid Git LFS object pointer");
    if (value.size === 0 && value.oid !== emptyOid)
        throw new Error("invalid Git LFS empty object hash");
    return { oid: value.oid, size: value.size };
}
/**
 * Parse the strict Git LFS v1 and historical Hawser formats. Ordinary blobs, including
 * Git LFS's empty-file passthrough, return null. A pointer-looking malformed or
 * extension-bearing blob throws; we cannot safely execute configured LFS extensions.
 */
export function parseLfsPointer(bytes) {
    if (!bytes.length || !bytes.subarray(0, 8).equals(Buffer.from("version ")))
        return null;
    const probe = bytes.subarray(0, pointerLimit).toString("utf8");
    if (!probe.startsWith("version https://") && !probe.startsWith("version http://") && !probe.includes("\noid sha256:"))
        return null;
    if (bytes.length >= pointerLimit)
        throw new Error("Git LFS pointer exceeds its size limit");
    let value;
    try {
        value = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    }
    catch {
        throw new Error("invalid Git LFS pointer encoding");
    }
    const match = /^version ([^\r\n]+)\noid sha256:([0-9a-f]{64})\nsize (0|[1-9][0-9]*)\n$/.exec(value);
    if (!match)
        throw new Error("malformed or unsupported Git LFS pointer or extension");
    if (match[1] !== currentVersion && match[1] !== legacyVersion && match[1] !== alphaVersion)
        throw new Error("unsupported Git LFS pointer version");
    return checkedPointer({ oid: match[2], size: Number(match[3]) });
}
/** Emit the canonical current pointer, retaining Git LFS's empty-file passthrough. */
export function formatLfsPointer(value) {
    const pointer = checkedPointer(value);
    return pointer.size === 0 ? Buffer.alloc(0) : Buffer.from(`version ${currentVersion}\noid sha256:${pointer.oid}\nsize ${pointer.size}\n`, "utf8");
}
function parts(value) {
    const absolute = path.resolve(value), root = path.parse(absolute).root;
    const relative = path.relative(root, absolute);
    return { absolute, root, parts: relative ? relative.split(path.sep).filter(Boolean) : [] };
}
/** Check every existing component, not only the object leaf, for links/junctions. */
async function safeDirectory(value, create) {
    const parsed = parts(value);
    let current = parsed.root;
    for (const component of parsed.parts) {
        current = path.join(current, component);
        try {
            let entry;
            try {
                entry = await lstat(current);
            }
            catch (error) {
                if (error.code !== "ENOENT" || !create)
                    throw error;
                try {
                    await mkdir(current);
                }
                catch (creationError) {
                    if (creationError.code !== "EEXIST")
                        throw creationError;
                }
                entry = await lstat(current);
            }
            if (entry.isSymbolicLink())
                throw new Error(`Git LFS path crosses a symlink or reparse point: ${current}`);
            if (!entry.isDirectory())
                throw new Error(`Git LFS path is not a directory: ${current}`);
        }
        catch (error) {
            if (error.code === "ENOENT")
                throw new Error(`Git LFS object directory is missing: ${current}`, { cause: error });
            throw error;
        }
    }
    return parsed.absolute;
}
function sameFile(a, b) {
    return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}
async function checkedFile(value) {
    const file = path.resolve(value);
    await safeDirectory(path.dirname(file), false);
    const info = await lstat(file, { bigint: true });
    if (info.isSymbolicLink() || !info.isFile())
        throw new Error(`Git LFS file must be regular and cannot be a symlink: ${file}`);
    return { file, info };
}
const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
async function writeAll(handle, buffer) {
    let offset = 0;
    while (offset < buffer.length) {
        const { bytesWritten } = await handle.write(buffer, offset, buffer.length - offset, null);
        if (!bytesWritten)
            throw new Error("Git LFS object write made no progress");
        offset += bytesWritten;
    }
}
/** Hash through a file handle using bounded memory and fail if its identity changes. */
async function streamLfsFile(value, chunk) {
    const { file, info } = await checkedFile(value);
    const handle = await open(file, constants.O_RDONLY | noFollow);
    try {
        const start = await handle.stat({ bigint: true });
        if (!start.isFile() || !sameFile(info, start))
            throw new LfsFileChangedError("Git LFS file changed before reading");
        const digest = createHash("sha256");
        let size = 0;
        for await (const value of handle.createReadStream({ autoClose: false })) {
            const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value);
            size += buffer.length;
            if (!Number.isSafeInteger(size))
                throw new Error("Git LFS object size is outside the safe range");
            digest.update(buffer);
            if (chunk)
                await chunk(buffer);
        }
        const end = await handle.stat({ bigint: true });
        const after = await checkedFile(file);
        if (!sameFile(start, end) || !sameFile(end, after.info) || BigInt(size) !== end.size)
            throw new LfsFileChangedError("Git LFS file changed while reading");
        return { oid: digest.digest("hex"), size };
    }
    finally {
        await handle.close();
    }
}
export async function hashLfsFile(file) { return streamLfsFile(file); }
function objectPath(objectsRoot, value) {
    const pointer = checkedPointer(value);
    return path.join(path.resolve(objectsRoot), pointer.oid.slice(0, 2), pointer.oid.slice(2, 4), pointer.oid);
}
/** Verify an already present local LFS object; missing and corrupted objects fail closed. */
export async function verifyLfsObject(objectsRoot, value) {
    const pointer = checkedPointer(value), file = objectPath(objectsRoot, pointer);
    await safeDirectory(path.dirname(file), false);
    let actual;
    try {
        actual = await streamLfsFile(file);
    }
    catch (error) {
        if (error.code === "ENOENT")
            throw new Error("Git LFS object is missing", { cause: error });
        throw error;
    }
    if (actual.oid !== pointer.oid || actual.size !== pointer.size)
        throw new Error("Git LFS object integrity check failed");
    return file;
}
async function checkOwnedTemporary(file, identity) {
    const { info } = await checkedFile(file);
    if (info.dev !== identity.dev || info.ino !== identity.ino)
        throw new Error(`Git LFS temporary file changed: ${file}`);
}
async function verifyOwnedTemporary(file, identity, expected) {
    await checkOwnedTemporary(file, identity);
    const actual = await streamLfsFile(file);
    if (actual.oid !== expected.oid || actual.size !== expected.size)
        throw new Error("Git LFS temporary content integrity check failed");
    await checkOwnedTemporary(file, identity);
}
async function removeOwnedTemporary(file, identity) {
    try {
        await checkOwnedTemporary(file, identity);
        await unlink(file);
    }
    catch (error) {
        if (error.code !== "ENOENT")
            throw error;
    }
}
/**
 * Stream to an exclusive temporary file, then publish by an atomic no-overwrite
 * hard link. Existing content is verified rather than replaced.
 */
export async function persistLfsObject(objectsRoot, sourceFile) {
    const root = await safeDirectory(objectsRoot, true);
    const temp = path.join(root, `.captain-lfs-${randomUUID()}.tmp`);
    let output;
    let identity;
    let tempPending = false;
    try {
        output = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow, 0o600);
        tempPending = true;
        identity = await output.stat({ bigint: true });
        const pointer = await streamLfsFile(sourceFile, value => writeAll(output, value));
        await output.sync();
        await output.close();
        output = undefined;
        const destination = objectPath(root, pointer);
        await safeDirectory(path.dirname(destination), true);
        await safeDirectory(root, false);
        await verifyOwnedTemporary(temp, identity, pointer);
        try {
            await link(temp, destination);
        }
        catch (error) {
            if (error.code !== "EEXIST")
                throw error;
        }
        // Removing the winning hard link changes the published inode's ctime.
        // Remove our temporary link first, then retry only transient identity
        // changes while another publisher is completing that same cleanup.
        await removeOwnedTemporary(temp, identity);
        tempPending = false;
        for (let attempt = 0;; attempt++) {
            try {
                await verifyLfsObject(root, pointer);
                break;
            }
            catch (error) {
                if (!(error instanceof LfsFileChangedError) || attempt >= 2)
                    throw error;
            }
        }
        return pointer;
    }
    finally {
        try {
            if (output)
                await output.close();
        }
        finally {
            if (tempPending && identity)
                await removeOwnedTemporary(temp, identity);
        }
    }
}
/** Hydrate only an unchanged pointer file, and publish only after integrity checks. */
export async function hydrateLfsObject(objectsRoot, value, destinationFile) {
    const pointer = checkedPointer(value), destination = await checkedFile(destinationFile);
    if (destination.info.size >= BigInt(pointerLimit))
        throw new Error("Git LFS hydration destination is not a pointer");
    const original = await readFile(destination.file), existing = parseLfsPointer(original);
    if (!existing || existing.oid !== pointer.oid || existing.size !== pointer.size)
        throw new Error("Git LFS hydration destination no longer matches the pointer");
    const source = await verifyLfsObject(objectsRoot, pointer);
    const temp = path.join(path.dirname(destination.file), `.captain-lfs-${randomUUID()}.tmp`);
    let output;
    let identity;
    let tempPending = false;
    try {
        output = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow, 0o600);
        tempPending = true;
        identity = await output.stat({ bigint: true });
        const actual = await streamLfsFile(source, value => writeAll(output, value));
        if (actual.oid !== pointer.oid || actual.size !== pointer.size)
            throw new Error("Git LFS object integrity check failed during hydration");
        await output.chmod(Number(destination.info.mode & 511n));
        await output.sync();
        await output.close();
        output = undefined;
        const current = await checkedFile(destination.file);
        if (!sameFile(destination.info, current.info) || !(await readFile(destination.file)).equals(original))
            throw new Error("Git LFS hydration destination changed during copy");
        await safeDirectory(path.dirname(destination.file), false);
        await verifyOwnedTemporary(temp, identity, pointer);
        const finalDestination = await checkedFile(destination.file);
        if (!sameFile(destination.info, finalDestination.info) || !(await readFile(destination.file)).equals(original))
            throw new Error("Git LFS hydration destination changed during verification");
        await rename(temp, destination.file);
        tempPending = false;
    }
    finally {
        try {
            if (output)
                await output.close();
        }
        finally {
            if (tempPending && identity)
                await removeOwnedTemporary(temp, identity);
        }
    }
}
