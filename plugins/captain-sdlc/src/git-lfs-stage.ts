import { createHash } from "node:crypto";
import { lstat, readFile, readlink } from "node:fs/promises";
import path from "node:path";
import { withShadowGit, type GitReader } from "./git-safe-status.js";
import { formatLfsPointer, hashLfsFile, parseLfsPointer, persistLfsObject, verifyLfsObject, type LfsPointer } from "./lfs.js";

type IndexEntry = { path: string; mode: string; stage: string };
type Snapshot =
  | { path: string; kind: "file"; pointer: LfsPointer; mode: bigint }
  | { path: string; kind: "symlink"; target: Buffer; mode: bigint }
  | { path: string; kind: "gitlink"; head: string; identity: string };

function safePath(value: string): string {
  if (!value || value.includes("\0") || value.includes("\\") || path.isAbsolute(value) || /^[A-Za-z]:/.test(value) ||
      value.split("/").some(part => !part || part === "." || part === ".." || part.toLowerCase() === ".git"))
    throw new Error("Git staging selection must contain safe repository-relative paths");
  return value;
}

function fields(value: Buffer): string[] {
  if (!value.length) return [];
  if (value[value.length - 1] !== 0) throw new Error("invalid Git NUL-delimited path result");
  let decoded: string;
  try { decoded = new TextDecoder("utf-8", { fatal: true }).decode(value); }
  catch { throw new Error("Git path is not valid UTF-8"); }
  const result = decoded.split("\0"); result.pop(); return result;
}

function indexEntries(data: Buffer): IndexEntry[] {
  return fields(data).map(line => {
    const match = /^(\d{6}) [a-f0-9]{40}(?:[a-f0-9]{24})? ([0-3])\t([\s\S]+)$/.exec(line);
    if (!match) throw new Error("invalid Git index entry during staging");
    return { path: safePath(match[3]), mode: match[1], stage: match[2] };
  });
}

function batches(values: string[]): string[][] {
  const result: string[][] = []; let batch: string[] = [], length = 0;
  for (const value of values) {
    const size = Buffer.byteLength(value) + 4;
    if (size > 7000) throw new Error("Git staging path exceeds the supported command limit");
    if (length + size > 7000) { result.push(batch); batch = []; length = 0; }
    batch.push(value); length += size;
  }
  if (batch.length) result.push(batch);
  return result;
}

async function rejectAlternateStorage(worktree: string, git: GitReader): Promise<void> {
  try { await git(["config", "--get-all", "lfs.storage"], worktree); }
  catch (error: any) { if (error.code === 1) return; throw error; }
  throw new Error("configured lfs.storage is not yet supported by safe LFS staging");
}

async function safeDirectory(value: string): Promise<boolean> {
  const absolute = path.resolve(value), base = path.parse(absolute).root;
  let current = base;
  for (const component of path.relative(base, absolute).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    let info;
    try { info = await lstat(current); }
    catch (error: any) { if (error.code === "ENOENT") return false; throw error; }
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`Git staging path crosses a link or non-directory: ${current}`);
  }
  return true;
}

const samePath = (a: string, b: string) => process.platform === "win32" ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b);
const identity = (value: { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint }) => `${value.dev}:${value.ino}:${value.size}:${value.mtimeNs}:${value.ctimeNs}`;

async function snapshot(root: string, relative: string, git: GitReader): Promise<Snapshot | undefined> {
  const file = path.resolve(root, ...relative.split("/"));
  if (!file.startsWith(path.resolve(root) + path.sep)) throw new Error("Git staging path escapes the worktree");
  if (!await safeDirectory(path.dirname(file))) return undefined;
  let info;
  try { info = await lstat(file, { bigint: true }); }
  catch (error: any) { if (error.code === "ENOENT") return undefined; throw error; }
  if (info.isSymbolicLink()) {
    const target = await readlink(file, { encoding: "buffer" }), after = await lstat(file, { bigint: true });
    if (!after.isSymbolicLink() || identity(info) !== identity(after) || !await safeDirectory(path.dirname(file))) throw new Error(`Git symlink changed during staging: ${relative}`);
    return { path: relative, kind: "symlink", target, mode: info.mode };
  }
  if (info.isFile()) return { path: relative, kind: "file", pointer: await hashLfsFile(file), mode: info.mode };
  if (info.isDirectory()) {
    const marker = path.join(file, ".git"), markerInfo = await lstat(marker, { bigint: true }).catch((error: any) => { if (error.code === "ENOENT") throw new Error(`Git submodule is not initialized: ${relative}`); throw error; });
    if (markerInfo.isSymbolicLink() || !markerInfo.isDirectory() && !markerInfo.isFile() || markerInfo.size > 1024n * 1024n) throw new Error(`unsafe Git submodule metadata: ${relative}`);
    const markerBytes = markerInfo.isFile() ? await readFile(marker) : Buffer.alloc(0);
    const top = await git(["rev-parse", "--show-toplevel"], file), gitDir = path.resolve(await git(["rev-parse", "--path-format=absolute", "--git-dir"], file));
    if (!samePath(top, file) || !await safeDirectory(gitDir)) throw new Error(`Git submodule identity diverged: ${relative}`);
    const gitInfo = await lstat(gitDir, { bigint: true }), head = await git(["rev-parse", "--verify", "HEAD^{commit}"], file);
    if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(head)) throw new Error(`invalid Git submodule HEAD: ${relative}`);
    const current = await lstat(file, { bigint: true }), markerAfter = await lstat(marker, { bigint: true }), gitAfter = await lstat(gitDir, { bigint: true });
    if (!current.isDirectory() || current.isSymbolicLink() || identity(info) !== identity(current) || identity(markerInfo) !== identity(markerAfter) || identity(gitInfo) !== identity(gitAfter) || markerInfo.isFile() && !markerBytes.equals(await readFile(marker)) || !await safeDirectory(path.dirname(file)) || !await safeDirectory(gitDir)) throw new Error(`Git submodule changed during staging: ${relative}`);
    return { path: relative, kind: "gitlink", head, identity: `${identity(info)}\0${identity(markerInfo)}\0${createHash("sha256").update(markerBytes).digest("hex")}\0${gitDir}\0${identity(gitInfo)}` };
  }
  throw new Error(`Git staging requires a regular file, symlink, or initialized submodule: ${relative}`);
}

function equalSnapshot(a: Snapshot | undefined, b: Snapshot | undefined) {
  if (!a || !b) return !a && !b;
  if (a.path !== b.path || a.kind !== b.kind) return false;
  if (a.kind === "file" && b.kind === "file") return a.mode === b.mode && a.pointer.size === b.pointer.size && a.pointer.oid === b.pointer.oid;
  if (a.kind === "symlink" && b.kind === "symlink") return a.mode === b.mode && a.target.equals(b.target);
  return a.kind === "gitlink" && b.kind === "gitlink" && a.head === b.head && a.identity === b.identity;
}

/**
 * Stage explicitly selected paths without executing repository-configured filters.
 * The real index is published only after its original state and HEAD remain pinned.
 * Existing staged paths outside the selection are retained for the caller's normal
 * explicit-selection preflight; they are never dropped or rewritten here.
 */
export async function stageLfsSelection(worktree: string, selection: string[], git: GitReader): Promise<void> {
  if (!selection.length) throw new Error("Git staging requires explicit selected paths");
  const root = path.resolve(worktree), selected = [...new Set(selection.map(safePath))];
  await rejectAlternateStorage(root, git);
  const common = path.resolve(await git(["rev-parse", "--path-format=absolute", "--git-common-dir"], root));
  const objects = path.join(common, "lfs", "objects");
  await withShadowGit(root, git, async shadow => {
    const conflicts = indexEntries(await shadow.run(["ls-files", "--stage", "-z"])).filter(item => item.stage !== "0");
    for (const item of conflicts) {
      if (!selected.some(value => item.path === value || item.path.startsWith(`${value}/`))) throw new Error(`unselected conflict requires explicit resolution: ${item.path}`);
      if (!["100644", "100755", "120000", "160000"].includes(item.mode)) throw new Error(`unsupported indexed conflict type: ${item.path}`);
    }
    const all = new Set<string>(), indexed = new Map<string, IndexEntry>();
    for (const batch of batches(selected)) {
      const command = ["--literal-pathspecs", "ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...batch];
      for (const name of fields(await shadow.run(command))) all.add(safePath(name.endsWith("/") ? name.slice(0, -1) : name));
      for (const item of indexEntries(await shadow.run(["--literal-pathspecs", "ls-files", "--stage", "-z", "--", ...batch]))) {
        const previous = indexed.get(item.path);
        if (!previous || item.stage === "2" || (previous.stage !== "2" && item.stage === "0")) indexed.set(item.path, item);
        all.add(item.path);
      }
      for (const name of fields(await shadow.run(["--literal-pathspecs", "ls-tree", "-r", "--name-only", "-z", "HEAD", "--", ...batch]))) all.add(safePath(name));
    }
    const paths = [...all].sort();
    for (const wanted of selected) if (!paths.some(value => value === wanted || value.startsWith(`${wanted}/`))) throw new Error(`Git staging selection matched no paths: ${wanted}`);
    // Skip-worktree entries are not evidence of deleted files in a sparse checkout.
    for (const batch of batches(selected)) for (const item of fields(await shadow.run(["--literal-pathspecs", "ls-files", "-v", "-z", "--", ...batch]))) {
      if (item[0].toLowerCase() === "s") throw new Error("Git LFS staging does not support sparse skip-worktree paths");
    }
    const attrs = await shadow.checkAttributes(paths, ["filter", "merge"]);
    const modes = (await shadow.run(["config", "--get", "core.filemode"]).catch(() => Buffer.from("true"))).toString("utf8").trim() !== "false";
    const snapshots = new Map<string, Snapshot | undefined>(), ordinary: string[] = [], prepared: Array<{ path: string; mode: string; oid: string }> = [];
    for (const row of attrs) {
      const filter = row.attributes.filter, merge = row.attributes.merge;
      if (!["lfs", "unspecified", "unset"].includes(filter)) throw new Error(`unsupported Git clean filter: ${row.path}`);
      if (!["lfs", "unspecified", "unset"].includes(merge)) throw new Error(`unsupported Git merge driver: ${row.path}`);
      const current = await snapshot(root, row.path, git);
      snapshots.set(row.path, current);
      if (!current) {
        if (indexed.has(row.path)) ordinary.push(row.path); // Stage a tracked deletion.
        continue; // A path already deleted from the index remains staged for deletion.
      }
      if (filter !== "lfs") {
        if (current.kind === "gitlink") prepared.push({ path: row.path, mode: "160000", oid: current.head });
        else ordinary.push(row.path);
        continue;
      }
      if (current.kind !== "file" || conflicts.some(item => item.path === row.path && item.mode !== "100644" && item.mode !== "100755")) throw new Error(`Git LFS asset must be a regular file: ${row.path}`);
      const pointer = await persistLfsObject(objects, path.join(root, ...row.path.split("/")));
      if (pointer.oid !== current.pointer.oid || pointer.size !== current.pointer.size) throw new Error(`Git LFS file changed during staging: ${row.path}`);
      if (pointer.size > 0 && pointer.size < 1024) {
        const bytes = await readFile(await verifyLfsObject(objects, pointer));
        if (bytes.length !== pointer.size || createHash("sha256").update(bytes).digest("hex") !== pointer.oid) throw new Error(`Git LFS object changed during staging: ${row.path}`);
        if (parseLfsPointer(bytes)) throw new Error(`Git LFS asset is an unhydrated pointer: ${row.path}`);
      }
      const old = indexed.get(row.path);
      if (old && old.mode !== "100644" && old.mode !== "100755") throw new Error(`Git LFS asset is not a regular indexed file: ${row.path}`);
      const mode = !modes && old ? old.mode : (current.mode & 0o100n) !== 0n ? "100755" : "100644";
      const oid = await shadow.writeObject(formatLfsPointer(pointer));
      prepared.push({ path: row.path, mode, oid });
    }
    if (ordinary.length) await shadow.stageFiles(ordinary);
    if (prepared.length) {
      const input = Buffer.from(prepared.map(item => `${item.mode} ${item.oid}\t${item.path}\0`).join(""), "utf8");
      await shadow.run(["update-index", "-z", "--index-info"], input);
    }
    if (fields(await shadow.run(["ls-files", "--unmerged", "-z"])).length) throw new Error("Git staging left unresolved conflicts in its private index");
    for (const [name, before] of snapshots) if (!equalSnapshot(before, await snapshot(root, name, git))) throw new Error(`Git staging source changed while preparing the index: ${name}`);
    const afterAttrs = await shadow.checkAttributes(paths, ["filter", "merge"]);
    if (JSON.stringify(attrs) !== JSON.stringify(afterAttrs)) throw new Error("Git attributes changed during staging");
    await rejectAlternateStorage(root, git);
    await shadow.publishIndex();
  });
}
