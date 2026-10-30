import { lstat, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { hydrateLfsObject, parseLfsPointer, verifyLfsObject } from "./lfs.js";
import { listIndexedLfs, withShadowGit, type GitReader } from "./git-safe-status.js";

const samePath = (a: string, b: string) => process.platform === "win32" ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b);

async function requireRealDirectory(value: string): Promise<void> {
  const absolute = path.resolve(value), root = path.parse(absolute).root;
  let cursor = root;
  for (const component of path.relative(root, absolute).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, component);
    const info = await lstat(cursor);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`Git LFS checkout path crosses a reparse point or non-directory: ${cursor}`);
  }
}

type TreeEntry = { oid: string; mode: string };
function validateTree(tree: string): Map<string, TreeEntry> {
  const files = new Map<string, TreeEntry>(), names = new Set<string>(), directories = new Set<string>();
  for (const record of tree.split("\0").filter(Boolean)) {
    const match = /^(\d{6}) ([a-z]+) ([a-f0-9]{40}(?:[a-f0-9]{24})?)\t([\s\S]+)$/.exec(record);
    if (!match || (match[1] !== "100644" && match[1] !== "100755") || match[2] !== "blob") throw new Error("Git LFS checkout refuses symlink, submodule, or unsupported tree mode");
    const relative = match[4], parts = relative.split("/");
    if (!relative || relative.includes("\ufffd") || /[\x00-\x1f\x7f\\]/.test(relative) || parts.some(part => !part || part === "." || part === ".." || part.toLowerCase() === ".git")) throw new Error(`unsafe Git LFS checkout path: ${relative}`);
    if (process.platform === "win32" && parts.some(part => /[<>:"|?*]/.test(part) || /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(part))) throw new Error(`unsupported Windows Git LFS checkout path: ${relative}`);
    const key = process.platform === "win32" ? relative.toLowerCase() : relative;
    if (names.has(key) || directories.has(key)) throw new Error(`duplicate or conflicting Git LFS checkout path: ${relative}`);
    for (let index = 1; index < parts.length; index++) {
      const prefix = parts.slice(0, index).join("/"), dir = process.platform === "win32" ? prefix.toLowerCase() : prefix;
      if (names.has(dir)) throw new Error(`conflicting Git LFS checkout path: ${relative}`);
      directories.add(dir);
    }
    names.add(key); files.set(relative, { oid: match[3], mode: match[1] });
  }
  return files;
}

function validateIndex(index: string, files: ReadonlyMap<string, TreeEntry>): void {
  const seen = new Set<string>();
  for (const record of index.split("\0").filter(Boolean)) {
    const match = /^(\d{6}) ([a-f0-9]{40}(?:[a-f0-9]{24})?) 0\t([\s\S]+)$/.exec(record);
    if (!match) throw new Error("Git LFS checkout index contains an invalid or unmerged entry");
    const expected = files.get(match[3]);
    if (!expected || seen.has(match[3]) || expected.mode !== match[1] || expected.oid !== match[2]) throw new Error("Git LFS checkout index and pinned tree diverged");
    seen.add(match[3]);
  }
  if (seen.size !== files.size) throw new Error("Git LFS checkout index and pinned tree diverged");
}

/** Populate a newly linked --no-checkout worktree without executing repository filters. */
export async function populateLfsWorktree(sourceRoot: string, targetRoot: string, baseHead: string, git: GitReader): Promise<void> {
  const source = path.resolve(sourceRoot), target = path.resolve(targetRoot);
  if (samePath(source, target) || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(baseHead)) throw new Error("invalid Git LFS checkout source, target, or pinned commit");
  await requireRealDirectory(source); await requireRealDirectory(target);
  const sourceCommon = path.resolve(await git(["rev-parse", "--path-format=absolute", "--git-common-dir"], source));
  const targetCommon = path.resolve(await git(["rev-parse", "--path-format=absolute", "--git-common-dir"], target));
  const targetGit = path.resolve(await git(["rev-parse", "--path-format=absolute", "--git-dir"], target));
  if (!samePath(sourceCommon, targetCommon) || !samePath(path.dirname(targetGit), path.join(sourceCommon, "worktrees"))) throw new Error("Git LFS checkout worktree binding diverged");
  await requireRealDirectory(sourceCommon); await requireRealDirectory(targetGit);
  for (const root of [source, target]) {
    let storage: string | undefined;
    try { storage = await git(["config", "--get-all", "lfs.storage"], root); }
    catch (error: any) { if (error.code !== 1) throw error; }
    if (storage !== undefined) throw new Error("explicit lfs.storage is not supported");
  }
  if (await git(["rev-parse", "--verify", "HEAD^{commit}"], target) !== baseHead || await git(["rev-parse", "--verify", `${baseHead}^{commit}`], source) !== baseHead) throw new Error("Git LFS checkout commit binding diverged");
  const present = await readdir(target);
  if (present.length !== 1 || present[0] !== ".git") throw new Error("Git LFS checkout requires an empty newly linked worktree");
  const marker = await lstat(path.join(target, ".git"));
  if (marker.isSymbolicLink() || !marker.isFile()) throw new Error("Git LFS checkout worktree metadata is not a regular file");
  const index = path.join(targetGit, "index");
  try { await lstat(index); throw new Error("Git LFS checkout target index already exists"); }
  catch (error: any) { if (error.code !== "ENOENT") throw error; }
  const files = validateTree(await git(["ls-tree", "-r", "-z", "--full-tree", baseHead], source));

  // read-tree without -u writes index metadata only; checkout happens in an isolated Git directory below.
  await git(["read-tree", baseHead], target);
  const indexInfo = await lstat(index);
  if (indexInfo.isSymbolicLink() || !indexInfo.isFile()) throw new Error("Git LFS checkout index is not a regular file");
  validateIndex(await git(["ls-files", "--stage", "-z"], target), files);
  const selected = await listIndexedLfs(target, git), objectsRoot = path.join(sourceCommon, "lfs", "objects"), checked = new Set<string>();
  for (const item of selected) {
    if (!files.has(item.path) || files.get(item.path)!.oid !== item.indexOid) throw new Error("Git LFS checkout index and pinned tree diverged");
    if (path.posix.basename(item.path).toLowerCase() === ".gitattributes") throw new Error("Git LFS cannot track its own attributes file");
    if (item.pointer.length === 0) {
      if (item.size !== 0) throw new Error("invalid empty Git LFS checkout pointer");
      continue;
    }
    const pointer = parseLfsPointer(item.pointer);
    if (!pointer || pointer.oid !== item.oid || pointer.size !== item.size) throw new Error("Git LFS checkout pointer metadata diverged");
    if (!checked.has(item.oid)) { await verifyLfsObject(objectsRoot, pointer); checked.add(item.oid); }
  }
  const selectedPaths = new Set(selected.map(item => item.path));
  const ordinary = [...files.keys()].filter(relative => !selectedPaths.has(relative));
  // Ensure attribute files are present before checkout applies regular text conversions.
  ordinary.sort((a, b) => {
    const aAttr = path.posix.basename(a).toLowerCase() === ".gitattributes", bAttr = path.posix.basename(b).toLowerCase() === ".gitattributes";
    return aAttr === bAttr ? a.localeCompare(b) : aAttr ? -1 : 1;
  });
  await withShadowGit(target, git, async shadow => {
    validateIndex((await shadow.run(["ls-files", "--stage", "-z"])).toString("utf8"), files);
    const checkout = async (paths: string[]) => { if (paths.length) await shadow.run(["checkout-index", "-z", "--stdin"], Buffer.from(paths.join("\0") + "\0")); };
    await checkout(ordinary);
    // LFS pointers are protocol bytes, even if repository attributes request text conversion.
    await writeFile(path.join(shadow.dir, "info", "attributes"), "* -filter -merge -text -ident !working-tree-encoding !eol\n");
    await checkout(selected.map(item => item.path));
  });
  for (const item of selected) {
    if (item.pointer.length === 0) continue;
    const pointer = parseLfsPointer(item.pointer)!;
    await hydrateLfsObject(objectsRoot, pointer, path.join(target, ...item.path.split("/")));
  }
}
