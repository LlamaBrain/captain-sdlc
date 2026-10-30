import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, link, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { hashLfsFile, hydrateLfsObject, parseLfsPointer, verifyLfsObject } from "./lfs.js";
import { listShadowIndexedLfs, withShadowGit } from "./git-safe-status.js";
const maxIndexBytes = 32 * 1024 * 1024;
const samePath = (a, b) => process.platform === "win32" ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b);
const hashText = (text) => createHash("sha256").update(text).digest("hex");
const exec = promisify(execFile);
async function windowsAcl(file) {
    if (process.platform !== "win32")
        throw new Error("Windows ACL inspection is unavailable on this platform");
    const systemRoot = process.env.SystemRoot;
    if (!systemRoot || !path.isAbsolute(systemRoot))
        throw new Error("Windows ACL inspection requires SystemRoot");
    const executable = path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const script = "$ErrorActionPreference = 'Stop'; [Console]::Out.Write((Get-Acl -LiteralPath $env:CAPTAIN_LFS_ACL_PATH).Sddl)";
    const environment = { ...process.env, CAPTAIN_LFS_ACL_PATH: file, PSModulePath: path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "Modules") };
    let output;
    try {
        output = (await exec(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], { env: environment, windowsHide: true, maxBuffer: 1024 * 1024, timeout: 30000 })).stdout.trim();
    }
    catch (error) {
        throw new Error(`Windows ACL metadata could not be verified: ${file}`, { cause: error });
    }
    if (!output.startsWith("O:") || !output.includes("G:") || !output.includes("D:"))
        throw new Error(`Windows ACL metadata is incomplete: ${file}`);
    return output;
}
/** MoveFileW rejects every pre-existing destination, unlike Node's Windows rename. */
export async function moveWindowsDirectoryNoReplace(source, destination) {
    if (process.platform !== "win32")
        throw new Error("no-replace directory move requires Windows");
    const systemRoot = process.env.SystemRoot;
    if (!systemRoot || !path.isAbsolute(systemRoot))
        throw new Error("Windows directory move requires SystemRoot");
    const extended = (value) => { const absolute = path.resolve(value); return absolute.startsWith("\\\\") ? `\\\\?\\UNC\\${absolute.slice(2)}` : `\\\\?\\${absolute}`; };
    const executable = path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const script = `$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class CaptainMoveDirectory { [DllImport("kernel32.dll", EntryPoint="MoveFileW", CharSet=CharSet.Unicode, SetLastError=true)] [return: MarshalAs(UnmanagedType.Bool)] public static extern bool Move(string source, string destination); }'
if (-not [CaptainMoveDirectory]::Move($env:CAPTAIN_LFS_MOVE_SOURCE, $env:CAPTAIN_LFS_MOVE_DESTINATION)) { $code = [Runtime.InteropServices.Marshal]::GetLastWin32Error(); [Console]::Error.Write("Windows directory move refused: $code"); exit 1 }`;
    const env = { ...process.env, CAPTAIN_LFS_MOVE_SOURCE: extended(source), CAPTAIN_LFS_MOVE_DESTINATION: extended(destination), PSModulePath: path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "Modules") };
    try {
        await exec(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], { env, windowsHide: true, maxBuffer: 1024 * 1024, timeout: 30000 });
    }
    catch (error) {
        throw new Error("Windows directory destination exists or the no-replace move was refused", { cause: error });
    }
}
async function directoryIdentity(value) {
    const info = await lstat(value, { bigint: true });
    if (info.isSymbolicLink() || !info.isDirectory() || !info.ino)
        throw new Error("Git LFS directory has no safe stable identity");
    return { dev: info.dev.toString(), ino: info.ino.toString() };
}
function sameDirectoryIdentity(a, b) { return a.dev === b.dev && a.ino === b.ino; }
/** POSIX directory creation is unsupported until it has an authenticated publication journal. */
async function capturePosixDirectories(root, changed) {
    if (process.platform === "win32")
        return undefined;
    const directories = new Map();
    for (const name of changed) {
        let relative = "";
        for (const component of name.split("/").slice(0, -1)) {
            relative = relative ? `${relative}/${component}` : component;
            const target = path.join(root, ...relative.split("/"));
            let value;
            try {
                value = await directoryIdentity(target);
            }
            catch (error) {
                if (error.code === "ENOENT")
                    throw new Error(`POSIX fast-forward cannot create unjournaled destination directory: ${relative}`, { cause: error });
                throw error;
            }
            const previous = directories.get(relative);
            if (previous && !sameDirectoryIdentity(previous, value))
                throw new Error(`POSIX destination directory changed during planning: ${relative}`);
            directories.set(relative, value);
        }
    }
    return [...directories].map(([name, id]) => ({ path: name, id }));
}
function posixDirectoryLookup(plan) {
    if (process.platform === "win32") {
        if (plan.posix_directories?.length)
            throw new Error("POSIX directory plan cannot be published on Windows");
        return undefined;
    }
    if (!Array.isArray(plan.posix_directories) || plan.posix_directories.length > 200000)
        throw new Error("signed POSIX fast-forward plan lacks directory identities");
    const lookup = new Map();
    for (const directory of plan.posix_directories) {
        const relative = safeRelative(directory.path);
        if (lookup.has(relative) || !directory.id || !directory.id.dev || !directory.id.ino)
            throw new Error("invalid signed POSIX directory identity");
        lookup.set(relative, directory.id);
    }
    return lookup;
}
async function verifyPosixChangeParents(plan, name, lookup) {
    if (process.platform === "win32")
        return;
    if (!lookup)
        throw new Error("signed POSIX fast-forward plan lacks directory identities");
    let relative = "";
    for (const component of name.split("/").slice(0, -1)) {
        relative = relative ? `${relative}/${component}` : component;
        const expected = lookup.get(relative), target = path.join(plan.root, ...relative.split("/"));
        if (!expected)
            throw new Error(`signed POSIX fast-forward plan lacks a destination parent: ${relative}`);
        await safeDir(target);
        if (!sameDirectoryIdentity(expected, await directoryIdentity(target)))
            throw new Error(`POSIX destination directory identity changed: ${relative}`);
    }
}
export function safeRelative(value) {
    const parts = value.split("/");
    if (!value || /[\x00-\x1f\x7f\\]/.test(value) || value.includes("\ufffd") || path.isAbsolute(value) || parts.some(p => !p || p === "." || p === ".." || p.toLowerCase() === ".git"))
        throw new Error("unsafe Git LFS fast-forward path");
    if (process.platform === "win32" && parts.some(p => /[<>:"|?*]/.test(p) || /[. ]$/.test(p) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(p)))
        throw new Error("unsafe Windows Git LFS fast-forward path");
    return value;
}
function parsePaths(value) {
    if (!value.length)
        return [];
    if (value[value.length - 1] !== 0)
        throw new Error("truncated Git LFS fast-forward path list");
    let text;
    try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(value);
    }
    catch {
        throw new Error("invalid Git path encoding");
    }
    const entries = text.split("\0");
    entries.pop();
    return entries;
}
function indexed(data) {
    const map = new Map(), folded = new Set();
    for (const line of parsePaths(data)) {
        const match = /^(\d{6}) ([a-f0-9]{40}(?:[a-f0-9]{24})?) ([0-3])\t([\s\S]+)$/.exec(line);
        if (!match || match[3] !== "0")
            throw new Error("unmerged or invalid Git index in LFS fast-forward");
        const name = safeRelative(match[4]), key = process.platform === "win32" ? name.toLowerCase() : name;
        if (folded.has(key))
            throw new Error("case-colliding paths in Git LFS fast-forward");
        folded.add(key);
        map.set(name, { path: name, mode: match[1], oid: match[2] });
    }
    return map;
}
function tree(data) {
    const map = new Map(), folded = new Set();
    for (const line of parsePaths(data)) {
        const match = /^(\d{6}) (\w+) ([a-f0-9]{40}(?:[a-f0-9]{24})?)\t([\s\S]+)$/.exec(line);
        if (!match || !["blob", "commit"].includes(match[2]))
            throw new Error("unsupported Git tree in LFS fast-forward");
        const name = safeRelative(match[4]), key = process.platform === "win32" ? name.toLowerCase() : name;
        if (folded.has(key))
            throw new Error("case-colliding paths in Git LFS fast-forward");
        folded.add(key);
        map.set(name, { path: name, mode: match[1], oid: match[3] });
    }
    return map;
}
async function safeDir(value, create = false) {
    const absolute = path.resolve(value), base = path.parse(absolute).root;
    let current = base;
    for (const part of path.relative(base, absolute).split(path.sep).filter(Boolean)) {
        current = path.join(current, part);
        let info;
        try {
            info = await lstat(current);
        }
        catch (error) {
            if (error.code !== "ENOENT" || !create)
                throw error;
            try {
                await mkdir(current);
            }
            catch (e) {
                if (e.code !== "EEXIST")
                    throw e;
            }
            info = await lstat(current);
        }
        if (info.isSymbolicLink() || !info.isDirectory())
            throw new Error(`Git LFS fast-forward path crosses a reparse point or non-directory: ${current}`);
    }
}
export async function fingerprint(file) {
    try {
        await safeDir(path.dirname(file));
        const info = await lstat(file, { bigint: true });
        if (info.isSymbolicLink() || !info.isFile() || !info.ino)
            throw new Error(`Git LFS fast-forward requires a regular file with a stable ID: ${file}`);
        const value = await hashLfsFile(file), after = await lstat(file, { bigint: true });
        if (after.dev !== info.dev || after.ino !== info.ino || after.size !== info.size || after.mtimeNs !== info.mtimeNs || after.ctimeNs !== info.ctimeNs)
            throw new Error("Git LFS fast-forward input changed while hashing");
        return { sha256: value.oid, size: value.size, dev: info.dev.toString(), ino: info.ino.toString(), executable: process.platform !== "win32" && (info.mode & 64n) !== 0n };
    }
    catch (error) {
        if (error.code === "ENOENT")
            return undefined;
        throw error;
    }
}
export function matches(actual, expected) {
    return !actual && !expected || Boolean(actual && expected && actual.sha256 === expected.sha256 && actual.size === expected.size && actual.dev === expected.dev && actual.ino === expected.ino && actual.executable === expected.executable);
}
export async function writeDurable(file, bytes) {
    const handle = await open(file, "wx", 0o600);
    try {
        await handle.writeFile(bytes);
        await handle.sync();
    }
    finally {
        await handle.close();
    }
}
/** Measure file inheritance inside an owned, private staging directory. */
async function inheritedWindowsFileAcl(parent) {
    await safeDir(parent);
    const file = path.join(parent, `captain-acl-probe-${randomUUID()}`), handle = await open(file, "wx");
    const owned = await handle.stat({ bigint: true });
    await handle.close();
    try {
        return await windowsAcl(file);
    }
    finally {
        const current = await lstat(file, { bigint: true });
        if (!current.isFile() || current.isSymbolicLink() || current.dev !== owned.dev || current.ino !== owned.ino)
            throw new Error("Windows ACL probe ownership changed");
        await safeDir(parent);
        await unlink(file);
    }
}
/** Prepare private empty directories only when the exact parent ACLs imply identical inheritance. */
async function prepareWindowsDirectories(root, txn, changed, next) {
    const roots = [], byPath = new Map();
    if (process.platform !== "win32")
        return { roots, byPath };
    const stagingParent = path.join(txn, "directories");
    await mkdir(stagingParent);
    const stagingAcl = await windowsAcl(stagingParent);
    for (const name of changed) {
        if (!next.has(name))
            continue;
        let relative = "";
        for (const part of name.split("/").slice(0, -1)) {
            const previous = relative;
            relative = relative ? `${relative}/${part}` : part;
            const key = relative.toLowerCase();
            if (byPath.has(key))
                continue;
            const parentPlan = previous ? byPath.get(previous.toLowerCase()) : undefined;
            if (parentPlan) {
                const staged = path.join(parentPlan.staged, part);
                await mkdir(staged);
                const node = { path: relative, id: await directoryIdentity(staged), acl: await windowsAcl(staged) };
                parentPlan.root.nodes.push(node);
                byPath.set(key, { root: parentPlan.root, staged, node });
                continue;
            }
            const target = path.join(root, ...relative.split("/"));
            let info;
            try {
                info = await lstat(target);
            }
            catch (error) {
                if (error.code !== "ENOENT")
                    throw error;
            }
            if (info) {
                if (info.isSymbolicLink() || !info.isDirectory())
                    throw new Error(`Windows directory destination is not a regular directory: ${relative}`);
                await safeDir(target);
                continue;
            }
            const parent = path.dirname(target);
            await safeDir(parent);
            const parentId = await directoryIdentity(parent), parentAcl = await windowsAcl(parent);
            if (parentAcl !== stagingAcl)
                throw new Error(`Windows inherited directory ACL cannot be verified: ${relative}`);
            const staged = path.join(stagingParent, hashText(relative));
            await mkdir(staged);
            const node = { path: relative, id: await directoryIdentity(staged), acl: await windowsAcl(staged) };
            const entry = { path: relative, staged, parent_id: parentId, parent_acl: parentAcl, nodes: [node] };
            roots.push(entry);
            byPath.set(key, { root: entry, staged, node });
        }
    }
    return { roots, byPath };
}
async function optionalDirectory(value) {
    try {
        return await directoryIdentity(value);
    }
    catch (error) {
        if (error.code === "ENOENT")
            return undefined;
        throw new Error(`Windows directory collision or unsafe path: ${value}`, { cause: error });
    }
}
/** Verify both sides of every staged/published directory without adopting foreign directories. */
async function verifyWindowsDirectories(plan) {
    if (process.platform !== "win32") {
        if (plan.windows_directories?.length)
            throw new Error("Windows directory plan cannot be published on this platform");
        return;
    }
    const roots = plan.windows_directories ?? [], seen = new Set();
    if (!Array.isArray(roots) || roots.length > 200000)
        throw new Error("invalid Windows directory plan");
    for (const entry of roots) {
        const rootPath = safeRelative(entry.path), key = rootPath.toLowerCase(), target = path.join(plan.root, ...rootPath.split("/"));
        if (seen.has(key) || roots.some(other => other !== entry && (key.startsWith(`${other.path.toLowerCase()}/`) || other.path.toLowerCase().startsWith(`${key}/`))) || !samePath(path.dirname(entry.staged), path.join(plan.transaction_dir, "directories")) || path.basename(entry.staged) !== hashText(rootPath) || !Array.isArray(entry.nodes) || !entry.nodes.length)
            throw new Error("invalid Windows signed directory root");
        seen.add(key);
        const parent = path.dirname(target);
        await safeDir(parent);
        if (!sameDirectoryIdentity(entry.parent_id, await directoryIdentity(parent)) || entry.parent_acl !== await windowsAcl(parent))
            throw new Error(`Windows directory parent changed: ${rootPath}`);
        const staged = await optionalDirectory(entry.staged), published = await optionalDirectory(target);
        if (Boolean(staged) === Boolean(published))
            throw new Error(`Windows directory conflicts with foreign state: ${rootPath}`);
        const active = staged ? entry.staged : target, nodeKeys = new Set();
        for (const node of entry.nodes) {
            const name = safeRelative(node.path), nodeKey = name.toLowerCase();
            if (nodeKeys.has(nodeKey) || !(nodeKey === key || nodeKey.startsWith(`${key}/`)))
                throw new Error("invalid Windows signed directory node");
            nodeKeys.add(nodeKey);
            const suffix = name.slice(rootPath.length).replace(/^\//, ""), actual = suffix ? path.join(active, ...suffix.split("/")) : active;
            await safeDir(actual);
            if (!sameDirectoryIdentity(node.id, await directoryIdentity(actual)) || node.acl !== await windowsAcl(actual))
                throw new Error(`Windows directory identity or ACL changed: ${name}`);
            const allowed = new Set(entry.nodes.filter(child => path.posix.dirname(child.path).toLowerCase() === nodeKey).map(child => path.posix.basename(child.path).toLowerCase()));
            if (!staged)
                for (const change of plan.changes)
                    if (change.after && path.posix.dirname(change.path).toLowerCase() === nodeKey)
                        allowed.add(path.posix.basename(change.path).toLowerCase());
            for (const name of await readdir(actual))
                if (!allowed.has(name.toLowerCase()))
                    throw new Error(`Windows directory contains foreign user data: ${node.path}/${name}`);
        }
        if (!nodeKeys.has(key))
            throw new Error("Windows signed directory root node is missing");
    }
}
async function windowsChangeParent(plan, name) {
    const relative = path.posix.dirname(name), key = relative.toLowerCase();
    for (const entry of plan.windows_directories ?? []) {
        if (!(key === entry.path.toLowerCase() || key.startsWith(`${entry.path.toLowerCase()}/`)))
            continue;
        const staged = await optionalDirectory(entry.staged), target = path.join(plan.root, ...entry.path.split("/")), published = await optionalDirectory(target);
        if (Boolean(staged) === Boolean(published))
            throw new Error(`Windows directory conflicts with foreign state: ${entry.path}`);
        const node = entry.nodes.find(value => value.path.toLowerCase() === key);
        if (!node)
            throw new Error(`Windows directory plan is missing: ${relative}`);
        const suffix = relative.slice(entry.path.length).replace(/^\//, ""), actual = suffix ? path.join(staged ? entry.staged : target, ...suffix.split("/")) : staged ? entry.staged : target;
        await safeDir(actual);
        if (!sameDirectoryIdentity(node.id, await directoryIdentity(actual)) || node.acl !== await windowsAcl(actual))
            throw new Error(`Windows directory identity or ACL changed: ${relative}`);
        return actual;
    }
    return path.dirname(path.join(plan.root, ...name.split("/")));
}
function regular(entry) { return !entry || entry.mode === "100644" || entry.mode === "100755"; }
async function rejectAlternateStorage(root, git) {
    try {
        await git(["config", "--get-all", "lfs.storage"], root);
    }
    catch (error) {
        if (error.code === 1)
            return;
        throw error;
    }
    throw new Error("explicit lfs.storage is not supported by Git LFS fast-forward");
}
async function captureMetadata(root, git) {
    const local = await git(["config", "--local", "--includes", "--null", "--list"], root);
    let worktreeEnabled = false;
    try {
        worktreeEnabled = (await git(["config", "--local", "--includes", "--bool", "--get", "extensions.worktreeConfig"], root)) === "true";
    }
    catch (error) {
        if (error.code !== 1)
            throw error;
    }
    const worktree = worktreeEnabled ? await git(["config", "--worktree", "--includes", "--null", "--list"], root) : "";
    const attrs = path.resolve(await git(["rev-parse", "--path-format=absolute", "--git-path", "info/attributes"], root));
    const exclude = path.resolve(await git(["rev-parse", "--path-format=absolute", "--git-path", "info/exclude"], root));
    const attributes = await fingerprint(attrs), excluded = await fingerprint(exclude);
    return { config_sha256: hashText(`${local}\0${worktree}`), ...(attributes ? { attributes } : {}), ...(excluded ? { exclude: excluded } : {}) };
}
function sameMetadata(left, right) {
    return left.config_sha256 === right.config_sha256 && matches(left.attributes, right.attributes) && matches(left.exclude, right.exclude);
}
/** Hidden index flags can conceal a user's actual file content from ordinary status. */
export async function assertVisibleFastForwardIndex(root, git) {
    const entries = (await git(["ls-files", "-v", "-z"], root)).split("\0").filter(Boolean);
    for (const entry of entries) {
        if (!/^[A-Za-z?] /.test(entry))
            throw new Error("invalid Git index visibility result");
        if (entry[0] === "S" || /^[a-z]$/.test(entry[0]))
            throw new Error("Git LFS fast-forward refuses assume-unchanged or skip-worktree entries");
    }
}
/** Prepare verified files and index without changing the target checkout or refs. */
export async function prepareLfsFastForward(root, branch, oldHead, newHead, git) {
    root = path.resolve(root);
    if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(oldHead) || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(newHead) || !branch || branch.startsWith("-") || branch.includes("\0"))
        throw new Error("invalid Git LFS fast-forward binding");
    await safeDir(root);
    await rejectAlternateStorage(root, git);
    await assertVisibleFastForwardIndex(root, git);
    const metadata = await captureMetadata(root, git);
    const gitDir = path.resolve(await git(["rev-parse", "--path-format=absolute", "--git-dir"], root));
    const common = path.resolve(await git(["rev-parse", "--path-format=absolute", "--git-common-dir"], root));
    await safeDir(gitDir);
    await safeDir(common);
    if (await git(["rev-parse", "--verify", "HEAD^{commit}"], root) !== oldHead || await git(["symbolic-ref", "--quiet", "--short", "HEAD"], root) !== branch)
        throw new Error("Git LFS fast-forward target changed before preparation");
    await git(["merge-base", "--is-ancestor", oldHead, newHead], root);
    const rootInfo = await lstat(root, { bigint: true }), gitInfo = await lstat(gitDir, { bigint: true });
    const rootId = await directoryIdentity(root), gitDirId = await directoryIdentity(gitDir), commonDirId = await directoryIdentity(common);
    if (rootInfo.dev !== gitInfo.dev || !gitInfo.ino)
        throw new Error("Git LFS fast-forward requires a same-volume Git directory and stable file IDs");
    const oldIndex = await fingerprint(path.join(gitDir, "index"));
    if (!oldIndex || oldIndex.size > maxIndexBytes)
        throw new Error("Git LFS fast-forward index is missing or exceeds the supported limit");
    return withShadowGit(root, git, async (shadow) => {
        const indexTree = (await shadow.run(["write-tree"])).toString("ascii").trim();
        const oldTree = (await shadow.run(["rev-parse", `${oldHead}^{tree}`])).toString("ascii").trim();
        if (indexTree !== oldTree)
            throw new Error("Git LFS fast-forward index differs from the old tree; preserve staged input");
        const changed = parsePaths(await shadow.run(["diff", "--no-renames", "--name-only", "--no-ext-diff", "--no-textconv", "-z", oldHead, newHead, "--"])).map(safeRelative).sort();
        if (new Set(changed.map(value => process.platform === "win32" ? value.toLowerCase() : value)).size !== changed.length)
            throw new Error("case-colliding changed paths in Git LFS fast-forward");
        const posixDirectories = await capturePosixDirectories(root, changed);
        const rejectLockable = async () => {
            for (const item of await shadow.checkAttributes(changed, ["lockable"], true)) {
                const value = item.attributes.lockable;
                if (value !== "unset" && value !== "unspecified")
                    throw new Error(`Git LFS fast-forward does not yet support lockable paths: ${item.path}`);
            }
        };
        await rejectLockable();
        const previous = tree(await shadow.run(["ls-tree", "-r", "-z", "--full-tree", oldHead]));
        const oldLfs = new Map((await listShadowIndexedLfs(shadow)).map(item => [item.path, item]));
        const oldFiles = new Map();
        for (const name of changed) {
            const original = path.join(root, ...name.split("/")), before = await fingerprint(original), oldEntry = previous.get(name);
            if (!regular(oldEntry))
                throw new Error(`Git LFS fast-forward refuses symlink, submodule, or type change: ${name}`);
            if (oldEntry && !before)
                throw new Error(`Git LFS fast-forward target file is missing: ${name}`);
            if (!oldEntry && before)
                throw new Error(`Git LFS fast-forward would overwrite an existing or ignored file: ${name}`);
            if (oldEntry && before) {
                const previousLfs = oldLfs.get(name);
                if (previousLfs) {
                    if (previousLfs.indexOid !== oldEntry.oid || before.sha256 !== previousLfs.oid || before.size !== previousLfs.size)
                        throw new Error(`Git LFS fast-forward target differs from the old indexed LFS object: ${name}`);
                }
                else {
                    const actual = (await shadow.run(["hash-object", `--path=${name}`, "--", original])).toString("ascii").trim();
                    if (actual !== oldEntry.oid)
                        throw new Error(`Git LFS fast-forward target differs from the old Git object: ${name}`);
                }
                if (process.platform !== "win32" && before.executable !== (oldEntry.mode === "100755"))
                    throw new Error(`Git LFS fast-forward target executable mode differs: ${name}`);
            }
            oldFiles.set(name, before);
        }
        await shadow.run(["read-tree", newHead]);
        await rejectLockable();
        const next = indexed(await shadow.run(["ls-files", "--stage", "-z"]));
        for (const name of changed)
            if (!regular(previous.get(name)) || !regular(next.get(name)))
                throw new Error(`Git LFS fast-forward refuses symlink, submodule, or type change: ${name}`);
        const txn = await mkdtemp(path.join(gitDir, "captain-lfs-ff-")), txnInfo = await lstat(txn, { bigint: true });
        if (!txnInfo.ino || txnInfo.dev !== gitInfo.dev)
            throw new Error("Git LFS fast-forward transaction has no stable identity");
        const staging = path.join(txn, "materialized"), prepared = path.join(txn, "prepared"), backups = path.join(txn, "backups");
        await mkdir(staging);
        await mkdir(prepared);
        await mkdir(backups);
        const directories = await prepareWindowsDirectories(root, txn, changed, next), inheritedFileAcls = new Map();
        const lfs = await listShadowIndexedLfs(shadow), lfsByPath = new Map(lfs.map(item => [item.path, item]));
        const attrs = [...next.values()].filter(item => path.posix.basename(item.path).toLowerCase() === ".gitattributes").map(item => item.path).sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));
        if (attrs.some(name => lfsByPath.has(name) || !regular(next.get(name))))
            throw new Error("Git LFS attributes must be regular files and cannot track themselves");
        const checkout = async (names) => { if (names.length)
            await shadow.run([`--work-tree=${staging}`, "checkout-index", "--force", "-z", "--stdin"], Buffer.from(names.join("\0") + "\0")); };
        await checkout(attrs);
        const ordinary = changed.filter(name => next.has(name) && !lfsByPath.has(name));
        await checkout(ordinary);
        const objects = path.join(common, "lfs", "objects");
        for (const name of changed.filter(name => lfsByPath.has(name))) {
            const item = lfsByPath.get(name), file = path.join(staging, ...name.split("/"));
            await safeDir(path.dirname(file), true);
            await writeFile(file, item.pointer, { flag: "wx" });
            if (item.pointer.length) {
                const pointer = parseLfsPointer(item.pointer);
                if (!pointer || pointer.oid !== item.oid || pointer.size !== item.size)
                    throw new Error("Git LFS pointer diverged during fast-forward preparation");
                await verifyLfsObject(objects, pointer);
                await hydrateLfsObject(objects, pointer, file);
            }
            if (process.platform !== "win32")
                await chmod(file, next.get(name).mode === "100755" ? 0o755 : 0o644);
        }
        const changes = [];
        for (const name of changed) {
            const original = path.join(root, ...name.split("/")), before = oldFiles.get(name), oldEntry = previous.get(name), nextEntry = next.get(name);
            if (!matches(before, await fingerprint(original)))
                throw new Error(`Git LFS fast-forward target changed while preparing: ${name}`);
            if (!oldEntry && !nextEntry)
                throw new Error("Git LFS fast-forward change is not bound to a tree");
            const key = hashText(name), backup = before ? path.join(backups, key) : undefined;
            let after, staged;
            if (nextEntry) {
                const materialized = path.join(staging, ...name.split("/"));
                staged = path.join(prepared, key);
                await rename(materialized, staged);
                after = await fingerprint(staged);
                if (!after)
                    throw new Error(`Git LFS fast-forward did not prepare target file: ${name}`);
            }
            let windows_acl;
            if (process.platform === "win32") {
                const destinationParent = path.dirname(original);
                const stagedParent = directories.byPath.get(path.posix.dirname(name).toLowerCase())?.staged;
                const aclParent = stagedParent ?? destinationParent;
                try {
                    await safeDir(aclParent);
                }
                catch (error) {
                    throw new Error(`Windows ACL for a new destination directory cannot be verified: ${name}`, { cause: error });
                }
                const parent = await windowsAcl(aclParent), beforeAcl = before ? await windowsAcl(original) : undefined, afterAcl = staged ? await windowsAcl(staged) : undefined;
                if (beforeAcl && afterAcl && beforeAcl !== afterAcl)
                    throw new Error(`Windows ACL would change during Git LFS fast-forward: ${name}`);
                if (!before && staged) {
                    const probeParent = stagedParent ?? path.dirname(staged);
                    if (!stagedParent && parent !== await windowsAcl(probeParent))
                        throw new Error(`Windows ACL inheritance differs at the destination: ${name}`);
                    let expected = inheritedFileAcls.get(probeParent);
                    if (!expected) {
                        expected = await inheritedWindowsFileAcl(probeParent);
                        inheritedFileAcls.set(probeParent, expected);
                    }
                    if (afterAcl !== expected)
                        throw new Error(`Windows inherited file ACL differs at the destination: ${name}`);
                }
                windows_acl = { parent, ...(beforeAcl ? { before: beforeAcl } : {}), ...(afterAcl ? { after: afterAcl } : {}) };
            }
            changes.push({ path: name, ...(before ? { before, backup } : {}), ...(after ? { after, staged } : {}), ...(windows_acl ? { windows_acl } : {}) });
        }
        // A copied split index may refer to a sharedindex inside the temporary shadow
        // Git directory. Publish a self-contained index before that directory is removed.
        await shadow.run(["update-index", "--no-split-index"]);
        const bytes = await readFile(shadow.indexFile);
        if (bytes.length > maxIndexBytes)
            throw new Error("Git LFS prepared index exceeds the supported limit");
        const preparedIndex = path.join(txn, "index.prepared");
        await writeDurable(preparedIndex, bytes);
        const newIndex = await fingerprint(preparedIndex);
        if (!newIndex || !matches(await fingerprint(path.join(gitDir, "index")), oldIndex))
            throw new Error("Git index changed during LFS fast-forward preparation");
        await assertVisibleFastForwardIndex(root, git);
        if (!sameMetadata(metadata, await captureMetadata(root, git)))
            throw new Error("Git metadata changed during LFS fast-forward preparation");
        const plan = { schema_version: 1, root, git_dir: gitDir, common_git_dir: common, root_id: rootId, git_dir_id: gitDirId, common_git_dir_id: commonDirId, branch, old_head: oldHead, new_head: newHead, transaction_dir: txn,
            transaction_id: { dev: txnInfo.dev.toString(), ino: txnInfo.ino.toString() }, old_index: oldIndex, new_index: newIndex, prepared_index: preparedIndex, metadata, changes, ...(directories.roots.length ? { windows_directories: directories.roots } : {}), ...(posixDirectories ? { posix_directories: posixDirectories } : {}) };
        await verifyWindowsDirectories(plan);
        const posixLookup = posixDirectoryLookup(plan);
        for (const change of changes)
            await verifyPosixChangeParents(plan, change.path, posixLookup);
        return plan;
    });
}
function inside(parent, candidate) { const part = path.relative(path.resolve(parent), path.resolve(candidate)); return Boolean(part) && part !== ".." && !part.startsWith(`..${path.sep}`) && !path.isAbsolute(part); }
async function verifyPlan(plan, git) {
    if (plan.schema_version !== 1 || !samePath(path.dirname(plan.transaction_dir), plan.git_dir) || !path.basename(plan.transaction_dir).startsWith("captain-lfs-ff-") || !inside(plan.transaction_dir, plan.prepared_index))
        throw new Error("invalid signed Git LFS fast-forward plan");
    await safeDir(plan.root);
    await safeDir(plan.git_dir);
    await safeDir(plan.common_git_dir);
    await safeDir(plan.transaction_dir);
    if (!plan.root_id || !plan.git_dir_id || !plan.common_git_dir_id || !sameDirectoryIdentity(plan.root_id, await directoryIdentity(plan.root)) || !sameDirectoryIdentity(plan.git_dir_id, await directoryIdentity(plan.git_dir)) || !sameDirectoryIdentity(plan.common_git_dir_id, await directoryIdentity(plan.common_git_dir)))
        throw new Error("signed Git LFS worktree or Git directory identity changed");
    await rejectAlternateStorage(plan.root, git);
    if (!plan.metadata || !sameMetadata(plan.metadata, await captureMetadata(plan.root, git)))
        throw new Error("Git config or info metadata changed during LFS fast-forward");
    const info = await lstat(plan.transaction_dir, { bigint: true });
    if (info.dev.toString() !== plan.transaction_id.dev || info.ino.toString() !== plan.transaction_id.ino || !samePath(await realpath(plan.transaction_dir), plan.transaction_dir))
        throw new Error("signed Git LFS transaction directory changed");
    if (!samePath(await git(["rev-parse", "--path-format=absolute", "--git-dir"], plan.root), plan.git_dir) || !samePath(await git(["rev-parse", "--path-format=absolute", "--git-common-dir"], plan.root), plan.common_git_dir) || await git(["symbolic-ref", "--quiet", "--short", "HEAD"], plan.root) !== plan.branch)
        throw new Error("signed Git LFS fast-forward worktree binding diverged");
    const head = await git(["rev-parse", "--verify", "HEAD^{commit}"], plan.root);
    if (head !== plan.old_head && head !== plan.new_head)
        throw new Error("signed Git LFS fast-forward HEAD diverged");
    for (const change of plan.changes) {
        safeRelative(change.path);
        if (process.platform === "win32" && !change.windows_acl)
            throw new Error("signed Git LFS plan lacks Windows ACL evidence");
        if (change.staged && !inside(plan.transaction_dir, change.staged) || change.backup && !inside(plan.transaction_dir, change.backup))
            throw new Error("signed Git LFS transaction path escapes its directory");
    }
}
async function validateChange(plan, item, posixDirectories) {
    await verifyPosixChangeParents(plan, item.path, posixDirectories);
    const target = path.join(plan.root, ...item.path.split("/")), current = await fingerprint(target);
    const backup = item.backup ? await fingerprint(item.backup) : undefined, staged = item.staged ? await fingerprint(item.staged) : undefined;
    if (item.before && !matches(backup, item.before) && !(matches(current, item.before) && !backup))
        throw new Error(`Git LFS fast-forward target or backup changed: ${item.path}`);
    if (!item.before && backup)
        throw new Error(`unexpected Git LFS fast-forward backup: ${item.path}`);
    if (item.after && !matches(staged, item.after) && !matches(current, item.after))
        throw new Error(`Git LFS fast-forward staged file changed: ${item.path}`);
    if (current && !matches(current, item.before) && !matches(current, item.after))
        throw new Error(`Git LFS fast-forward target conflicts with user data: ${item.path}`);
    if (!item.after && current && !matches(current, item.before))
        throw new Error(`Git LFS fast-forward deletion conflicts: ${item.path}`);
    if (process.platform === "win32") {
        const acl = item.windows_acl;
        if (!acl || await windowsAcl(await windowsChangeParent(plan, item.path)) !== acl.parent)
            throw new Error(`Windows destination ACL changed: ${item.path}`);
        if (item.before && (matches(current, item.before) ? await windowsAcl(target) : await windowsAcl(item.backup)) !== acl.before)
            throw new Error(`Windows source ACL changed: ${item.path}`);
        if (item.after && (matches(current, item.after) ? await windowsAcl(target) : await windowsAcl(item.staged)) !== acl.after)
            throw new Error(`Windows staged ACL changed: ${item.path}`);
    }
}
/** Apply or resume only authenticated old/new states; unexpected user edits are retained. */
async function applyLfsTransition(plan, git, authorize, checkpoint, advanceRef, validateInputs) {
    if (plan.input_manifest !== undefined && (!/^[a-f0-9]{64}$/.test(plan.input_manifest) || !validateInputs))
        throw new Error("signed LFS transition requires input validation");
    await verifyPlan(plan, git);
    await authorize();
    await verifyWindowsDirectories(plan);
    const posixDirectories = posixDirectoryLookup(plan);
    if (validateInputs)
        await validateInputs();
    let head = await git(["rev-parse", "--verify", "HEAD^{commit}"], plan.root);
    if (!advanceRef && head !== plan.old_head)
        throw new Error("Git LFS merge source HEAD diverged");
    if (head !== plan.old_head && head !== plan.new_head)
        throw new Error("Git LFS fast-forward target HEAD diverged");
    const index = path.join(plan.git_dir, "index"), lock = `${index}.lock`;
    const currentIndex = await fingerprint(index);
    if (!matches(currentIndex, plan.old_index) && !matches(currentIndex, plan.new_index))
        throw new Error("Git LFS fast-forward index diverged from its signed state");
    if (head === plan.new_head && !matches(currentIndex, plan.new_index))
        throw new Error("Git LFS fast-forward ref advanced with an unexpected index");
    if (!matches(await fingerprint(plan.prepared_index), plan.new_index))
        throw new Error("signed Git LFS prepared index changed");
    for (const change of plan.changes)
        await validateChange(plan, change, posixDirectories);
    if (head === plan.new_head)
        for (const change of plan.changes) {
            const current = await fingerprint(path.join(plan.root, ...change.path.split("/")));
            if (!matches(current, change.after))
                throw new Error("Git LFS fast-forward ref advanced before all target files were published");
        }
    for (const directory of plan.windows_directories ?? []) {
        await authorize();
        await verifyPlan(plan, git);
        await verifyWindowsDirectories(plan);
        if (await optionalDirectory(directory.staged)) {
            const target = path.join(plan.root, ...directory.path.split("/"));
            await moveWindowsDirectoryNoReplace(directory.staged, target);
            await checkpoint("directory-moved");
            await verifyWindowsDirectories(plan);
            await checkpoint("directory");
        }
    }
    for (const change of plan.changes) {
        await authorize();
        await verifyPlan(plan, git);
        await verifyWindowsDirectories(plan);
        await validateChange(plan, change, posixDirectories);
        const target = path.join(plan.root, ...change.path.split("/"));
        if (change.after)
            await safeDir(path.dirname(target));
        let current = await fingerprint(target);
        if (change.before && matches(current, change.before) && !await fingerprint(change.backup)) {
            await rename(target, change.backup);
            if (!matches(await fingerprint(change.backup), change.before))
                throw new Error(`Git LFS fast-forward backup changed: ${change.path}`);
            current = undefined;
            await checkpoint("backup");
        }
        if (change.after && !matches(current, change.after)) {
            if (current)
                throw new Error(`Git LFS fast-forward target already exists: ${change.path}`);
            try {
                await link(change.staged, target);
            }
            catch (error) {
                if (error.code === "EEXIST")
                    throw new Error(`Git LFS fast-forward target conflicts with user data: ${change.path}`);
                throw error;
            }
            if (!matches(await fingerprint(target), change.after))
                throw new Error(`Git LFS fast-forward target changed after publication: ${change.path}`);
        }
        await checkpoint("file");
    }
    await verifyWindowsDirectories(plan);
    for (const change of plan.changes)
        await validateChange(plan, change, posixDirectories);
    if (!matches(await fingerprint(index), plan.new_index)) {
        await authorize();
        await verifyPlan(plan, git);
        if (validateInputs)
            await validateInputs();
        const existingLock = await fingerprint(lock);
        if (existingLock && !matches(existingLock, plan.new_index))
            throw new Error("Git LFS fast-forward found a foreign index lock");
        if (!existingLock)
            await link(plan.prepared_index, lock);
        if (!matches(await fingerprint(lock), plan.new_index) || !matches(await fingerprint(index), plan.old_index))
            throw new Error("Git LFS fast-forward index lock or original index changed");
        await checkpoint("index-lock");
        await rename(lock, index);
        if (!matches(await fingerprint(index), plan.new_index))
            throw new Error("Git LFS fast-forward index publication diverged");
    }
    await checkpoint("index");
    await authorize();
    await verifyPlan(plan, git);
    if (validateInputs)
        await validateInputs();
    // The index checkpoint is an interruption boundary: revalidate all published
    // directory identities, ACLs, and exact file postimages before advancing a ref.
    await verifyWindowsDirectories(plan);
    for (const change of plan.changes) {
        await validateChange(plan, change, posixDirectories);
        const current = await fingerprint(path.join(plan.root, ...change.path.split("/")));
        if (!matches(current, change.after))
            throw new Error(`Git LFS fast-forward file changed before ref publication: ${change.path}`);
    }
    head = await git(["rev-parse", "--verify", "HEAD^{commit}"], plan.root);
    if (!advanceRef) {
        if (head !== plan.old_head)
            throw new Error("Git LFS merge source HEAD changed during publication");
        return;
    }
    if (head === plan.old_head)
        await git(["update-ref", "-m", "Captain LFS fast-forward", `refs/heads/${plan.branch}`, plan.new_head, plan.old_head], plan.root);
    else if (head !== plan.new_head)
        throw new Error("Git LFS fast-forward target HEAD changed before ref update");
    await checkpoint("ref");
    if (await git(["rev-parse", "--verify", "HEAD^{commit}"], plan.root) !== plan.new_head)
        throw new Error("Git LFS fast-forward ref publication diverged");
}
export async function applyLfsFastForward(plan, git, authorize, checkpoint, validateInputs) {
    return applyLfsTransition(plan, git, authorize, checkpoint, true, validateInputs);
}
export async function applyLfsMergeTransition(plan, git, authorize, checkpoint) {
    return applyLfsTransition(plan, git, authorize, checkpoint, false);
}
