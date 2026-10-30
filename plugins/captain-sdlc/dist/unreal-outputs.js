import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import path from "node:path";
const generatedNames = new Set(["binaries", "intermediate", "saved"]);
const projectGeneratedNames = new Set([...generatedNames, "deriveddatacache"]);
const authoredNames = new Set(["source", "content", "config", "resources", "binaries", "intermediate", "saved", "deriveddatacache", ".git", ".captain-sdlc"]);
function segments(relative) {
    if (!relative || relative.includes("\\") || path.posix.isAbsolute(relative) || !/^[A-Za-z0-9._/& -]+$/.test(relative))
        return null;
    const parts = relative.split("/");
    if (parts.some(part => !part || part === "." || part === ".." || /[. ]$/.test(part)))
        return null;
    return parts;
}
/** Recognize only project output roots or output roots belonging to a plugin. */
export function isUnrealGeneratedPath(relative) {
    const parts = segments(relative);
    if (!parts)
        return false;
    const lower = parts.map(part => part.toLowerCase());
    if (parts.length === 1)
        return projectGeneratedNames.has(lower[0]);
    return lower[0] === "plugins" && parts.length >= 3 && generatedNames.has(lower.at(-1)) &&
        lower.slice(1, -1).every(part => !authoredNames.has(part));
}
/** A captured policy can opt in only for an Unreal project and a real installed plugin. */
export async function isApprovedUnrealGeneratedPath(root, relative, trackedBasePaths) {
    if (!isUnrealGeneratedPath(relative))
        return false;
    const lower = relative.toLowerCase();
    if (!trackedBasePaths.some(candidate => /^[^/\\]+\.uproject$/i.test(candidate)))
        return false;
    if (!lower.includes("/"))
        return true;
    let cursor = root;
    for (const part of relative.split("/").slice(0, -1)) {
        let entries;
        try {
            entries = await readdir(cursor);
        }
        catch (error) {
            if (error.code === "ENOENT")
                return false;
            throw error;
        }
        const matches = entries.filter(entry => entry.toLowerCase() === part.toLowerCase());
        if (matches.length > 1)
            throw new Error(`Unreal plugin path has ambiguous casing: ${relative}`);
        if (!matches.length)
            return false;
        cursor = path.join(cursor, matches[0]);
        const info = await lstat(cursor);
        if (info.isSymbolicLink())
            throw new Error(`Unreal plugin path crosses a reparse point: ${relative}`);
        if (!info.isDirectory())
            return false;
    }
    const descriptors = (await readdir(cursor)).filter(entry => entry.toLowerCase().endsWith(".uplugin"));
    if (descriptors.length !== 1)
        return false;
    const descriptor = path.join(cursor, descriptors[0]);
    const before = await lstat(descriptor);
    if (before.isSymbolicLink() || !before.isFile())
        throw new Error(`Unreal plugin descriptor is not a regular file: ${relative}`);
    if (before.size > 1024 * 1024)
        throw new Error(`Unreal plugin descriptor exceeds its size limit: ${relative}`);
    const handle = await open(descriptor, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
        const opened = await handle.stat();
        if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size || opened.mtimeMs !== before.mtimeMs)
            throw new Error(`Unreal plugin descriptor changed before reading: ${relative}`);
        const buffer = Buffer.alloc(opened.size + 1);
        let length = 0;
        while (length < buffer.length) {
            const result = await handle.read(buffer, length, buffer.length - length, length);
            if (!result.bytesRead)
                break;
            length += result.bytesRead;
        }
        const bytes = buffer.subarray(0, length);
        const after = await lstat(descriptor);
        if (after.isSymbolicLink() || !after.isFile() || after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || bytes.length !== opened.size)
            throw new Error(`Unreal plugin descriptor changed while reading: ${relative}`);
        let value;
        try {
            value = JSON.parse(bytes.toString("utf8"));
        }
        catch {
            throw new Error(`Unreal plugin descriptor is invalid JSON: ${relative}`);
        }
        return Boolean(value && typeof value === "object" && !Array.isArray(value) && Number.isInteger(value.FileVersion) && (value.FileVersion > 0));
    }
    finally {
        await handle.close();
    }
}
/** New tracked inputs must not disappear behind an exclusion captured earlier. */
export function assertNoTrackedExcludedPaths(exclusions, trackedPaths) {
    const roots = exclusions.map(relative => {
        if (!segments(relative))
            throw new Error("source manifest exclusion path must be a safe repository-relative path");
        return relative.toLowerCase();
    });
    for (const candidate of trackedPaths) {
        const file = candidate.replaceAll("\\", "/").toLowerCase();
        if (roots.some(root => file === root || file.startsWith(root + "/"))) {
            throw new Error(`source manifest exclusion contains a tracked file: ${candidate}`);
        }
    }
}
/** An excluded directory is never followed through a junction or symbolic link. */
export async function assertUnrealExclusionRootsSafe(root, exclusions) {
    for (const relative of exclusions) {
        if (!isUnrealGeneratedPath(relative))
            continue;
        let cursor = root;
        for (const part of relative.split("/")) {
            let entries;
            try {
                entries = await readdir(cursor);
            }
            catch (error) {
                if (error.code === "ENOENT")
                    break;
                throw error;
            }
            const matches = entries.filter(entry => entry.toLowerCase() === part.toLowerCase());
            if (matches.length > 1)
                throw new Error(`source manifest exclusion has ambiguous path casing: ${relative}`);
            if (!matches.length)
                break;
            cursor = path.join(cursor, matches[0]);
            let info;
            try {
                info = await lstat(cursor);
            }
            catch (error) {
                if (error.code === "ENOENT")
                    break;
                throw error;
            }
            if (info.isSymbolicLink())
                throw new Error(`source manifest exclusion crosses a reparse point: ${relative}`);
            if (!info.isDirectory())
                throw new Error(`source manifest exclusion is not a directory: ${relative}`);
        }
    }
}
