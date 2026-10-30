import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseLfsPointer } from "./lfs.js";

export type GitReader = (args: string[], cwd: string) => Promise<string>;
export type IndexedLfs = { path: string; oid: string; size: number; pointer: Buffer; indexOid: string };
export type ShadowGit = {
  dir: string; root: string; indexFile: string; fileMode: boolean;
  run(args: string[], input?: string | Buffer): Promise<Buffer>;
  mergeTree(ours: string, theirs: string): Promise<{ status: "clean" | "conflicts"; output: Buffer; binaryPaths: string[] }>;
  writeMergeCommit(tree: string, ours: string, theirs: string): Promise<string>;
  checkAttributes(paths: string[], attributes: string[], cached?: boolean): Promise<Array<{ path: string; attributes: Record<string, string> }>>;
  writeObject(value: Buffer): Promise<string>;
  stageFiles(paths: string[]): Promise<void>;
  publishIndex(): Promise<void>;
};

const maxOutput = 32 * 1024 * 1024, maxMetadata = 32 * 1024 * 1024;
/** Git before 2.43 can crash on merge-tree with a pinned attribute source. */
export function assertMergeTreeGitVersion(value: string): void {
  const match = /^git version (\d+)\.(\d+)\.(\d+)(?:\.[^\s]+)?\s*$/.exec(value);
  if (!match) throw new Error("cannot verify Git version; isolated LFS merge requires Git 2.43 or newer");
  const major = Number(match[1]), minor = Number(match[2]);
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor) || major < 2 || major === 2 && minor < 43) throw new Error("isolated LFS merge requires Git 2.43 or newer");
}
const samePath = (a: string, b: string) => process.platform === "win32" ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b);
const digest = (value: Buffer) => createHash("sha256").update(value).digest("hex");
function utf8(value: Buffer) { try { return new TextDecoder("utf-8", { fatal: true }).decode(value); } catch { throw new Error("Git paths or attributes are not valid UTF-8"); } }
function safeEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) if (/^GIT_/i.test(key) || key === "PLUGIN_DATA" || key === "CAPTAIN_PLUGIN_DATA") delete env[key];
  return { ...env, GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat", GIT_NO_REPLACE_OBJECTS: "1", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null", GIT_ATTR_NOSYSTEM: "1" };
}
async function invokeResult(args: string[], cwd: string, env: NodeJS.ProcessEnv, input?: string | Buffer): Promise<{ status: number; output: Buffer; error: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [], err: Buffer[] = []; let length = 0, errorLength = 0, overflow = false;
    child.stdout.on("data", (part: Buffer) => { length += part.length; if (length > maxOutput) { overflow = true; child.kill(); } else out.push(part); });
    child.stderr.on("data", (part: Buffer) => { errorLength += part.length; if (errorLength <= 1024 * 1024) err.push(part); });
    child.once("error", reject);
    child.once("close", code => {
      if (overflow) reject(new Error("isolated Git output exceeds its bounded limit"));
      else if (code === null) reject(new Error("isolated Git terminated without an exit status"));
      else resolve({ status: code, output: Buffer.concat(out), error: Buffer.concat(err).toString("utf8").trim() });
    });
    child.stdin.on("error", () => { /* child close reports failures */ });
    child.stdin.end(input);
  });
}
async function invoke(args: string[], cwd: string, env: NodeJS.ProcessEnv, input?: string | Buffer): Promise<Buffer> {
  const result = await invokeResult(args, cwd, env, input);
  if (result.status !== 0) throw new Error(`isolated Git ${args.at(-1) ?? "command"} failed: ${result.error}`);
  return result.output;
}

function binaryAttributeRule(relative: string): string {
  const parts = relative.split("/");
  if (!relative || /[\x00-\x1f\x7f\\]/.test(relative) || relative.includes("\ufffd") || path.isAbsolute(relative) || parts.some(part => !part || part === "." || part === ".." || part.toLowerCase() === ".git")) throw new Error("unsafe LFS merge path");
  // gitattributes uses Git's wildmatch after C-style unquoting. Escape glob syntax
  // first, then escape backslashes and quotes for the quoted attributes field.
  const literal = relative.replace(/[\*?\[\]]/g, value => `\\${value}`).replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
  return `"/${literal}" -merge\n`;
}
async function metadata(file: string): Promise<Buffer | undefined> {
  try {
    const info = await lstat(file, { bigint: true });
    if (info.isSymbolicLink() || !info.isFile() || info.size > BigInt(maxMetadata) || !samePath(await realpath(file), file)) throw new Error(`unsafe Git metadata: ${file}`);
    const handle = await open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    try {
      const before = await handle.stat({ bigint: true });
      if (before.dev !== info.dev || before.ino !== info.ino || before.size !== info.size || before.size > BigInt(maxMetadata)) throw new Error(`Git metadata changed while opening: ${file}`);
      const value = await handle.readFile(), after = await handle.stat({ bigint: true }), current = await lstat(file, { bigint: true });
      if (value.length > maxMetadata || current.isSymbolicLink() || !current.isFile() || current.dev !== before.dev || current.ino !== before.ino || current.size !== after.size || current.mtimeNs !== after.mtimeNs || current.ctimeNs !== after.ctimeNs || after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs) throw new Error(`Git metadata changed while reading: ${file}`);
      return value;
    } finally { await handle.close(); }
  } catch (error: any) { if (error.code === "ENOENT") return undefined; throw error; }
}
async function safeTempCleanup(root: string) {
  if (!samePath(path.dirname(root), tmpdir()) || !path.basename(root).startsWith("captain-shadow-git-") || !samePath(await realpath(root), root)) throw new Error("refusing unsafe isolated Git cleanup");
  async function inspect(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const child = path.join(dir, entry.name), info = await lstat(child);
      if (info.isSymbolicLink()) throw new Error("refusing isolated Git cleanup containing a reparse point");
      if (info.isDirectory()) await inspect(child);
    }
  }
  await inspect(root);
  await rm(root, { recursive: true, force: false });
}
function shadowConfig(raw: string): { config: string; fileMode: boolean } {
  const entries = new Map<string, string | undefined>();
  for (const record of raw.split("\0")) {
    if (!record) continue;
    const split = record.indexOf("\n"), key = (split < 0 ? record : record.slice(0, split)).toLowerCase();
    entries.set(key, split < 0 ? undefined : record.slice(split + 1));
  }
  if (entries.has("core.excludesfile")) throw new Error("repository core.excludesFile is not supported by isolated Git status");
  const sections: Record<string, string[]> = { core: [], status: [], diff: [] };
  let fileMode = true;
  const keys: Record<string, "bool" | "autocrlf" | "eol" | "checkstat" | "renames" | "safecrlf" | "limit"> = {
    "core.autocrlf": "autocrlf", "core.eol": "eol", "core.filemode": "bool", "core.symlinks": "bool", "core.ignorecase": "bool",
    "core.quotepath": "bool", "core.precomposeunicode": "bool", "core.trustctime": "bool", "core.checkstat": "checkstat",
    "core.ignorestat": "bool", "core.safecrlf": "safecrlf", "status.renames": "renames", "diff.renames": "renames", "diff.renamelimit": "limit",
  };
  for (const [key, kind] of Object.entries(keys)) {
    if (!entries.has(key)) continue;
    const original = entries.get(key), value = original === undefined ? "true" : original.toLowerCase(); let normalized: string;
    if (["bool", "autocrlf", "renames", "safecrlf"].includes(kind) && ["true", "yes", "on", "1"].includes(value)) normalized = "true";
    else if (["bool", "autocrlf", "renames", "safecrlf"].includes(kind) && ["false", "no", "off", "0", ""].includes(value)) normalized = "false";
    else if (kind === "autocrlf" && value === "input" || kind === "renames" && value === "copies" || kind === "safecrlf" && value === "warn" || kind === "eol" && ["lf", "crlf", "native"].includes(value) || kind === "checkstat" && ["default", "minimal"].includes(value) || kind === "limit" && /^(?:0|[1-9][0-9]{0,6})$/.test(value)) normalized = value;
    else throw new Error(`unsupported Git setting: ${key}`);
    if (key === "core.filemode") fileMode = normalized === "true";
    const [section, name] = key.split("."); sections[section].push(`\t${name} = ${normalized}\n`);
  }
  // Git defaults to true when the target has no setting. The freshly initialized
  // shadow may have probed a different filesystem and chosen a different value.
  if (!entries.has("core.filemode")) sections.core.push("\tfilemode = true\n");
  return { config: Object.entries(sections).filter(([, values]) => values.length).map(([section, values]) => `\n[${section}]\n${values.join("")}`).join(""), fileMode };
}

/** Private Git metadata prevents repository-controlled filters and hooks from running. */
export async function withShadowGit<T>(worktree: string, git: GitReader, operation: (shadow: ShadowGit) => Promise<T>): Promise<T> {
  const root = path.resolve(worktree), head = await git(["rev-parse", "--verify", "HEAD^{commit}"], root);
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(head)) throw new Error("invalid Git HEAD for isolated status");
  const locations = (await git(["rev-parse", "--path-format=absolute", "--show-object-format", "--git-path", "index", "--git-path", "objects", "--git-path", "info/exclude", "--git-path", "info/attributes", "--shared-index-path"], root)).split(/\r?\n/);
  if (locations.length < 5 || locations.length > 6 || locations.slice(1).some(value => !path.isAbsolute(value))) throw new Error("invalid Git metadata paths for isolated status");
  const [objectFormat, indexValue, objectsValue, excludeValue, attributesValue, sharedPathValue] = locations;
  if (objectFormat !== "sha1" && objectFormat !== "sha256") throw new Error("unsupported Git object format");
  const indexPath = path.resolve(indexValue), objectDir = path.resolve(objectsValue);
  const objectInfo = await lstat(objectDir, { bigint: true });
  if (objectInfo.isSymbolicLink() || !objectInfo.isDirectory() || !objectInfo.ino || !samePath(await realpath(objectDir), objectDir)) throw new Error("Git object store resolves through a reparse point or has no stable identity");
  const assertObjectStore = async () => {
    try {
      const current = await lstat(objectDir, { bigint: true });
      if (current.isSymbolicLink() || !current.isDirectory() || current.dev !== objectInfo.dev || current.ino !== objectInfo.ino || !samePath(await realpath(objectDir), objectDir)) throw new Error("identity diverged");
    } catch (error) { throw new Error("Git object store changed during isolated operation", { cause: error }); }
  };
  const originalIndex = await metadata(indexPath);
  if (!originalIndex) throw new Error("Git index is missing; prepare an index before isolated status");
  const sharedPath = sharedPathValue ? path.resolve(sharedPathValue) : undefined;
  if (sharedPath && !/^sharedindex\.[a-f0-9]{40,64}$/.test(path.basename(sharedPath))) throw new Error("unsafe Git shared-index path");
  const shared = sharedPath ? await metadata(sharedPath) : undefined;
  if (sharedPath && !shared) throw new Error("Git shared index is missing");
  const excludePath = path.resolve(excludeValue);
  const exclude = await metadata(excludePath);
  const attributesPath = path.resolve(attributesValue);
  const infoAttributes = await metadata(attributesPath);
  if ((exclude?.length ?? 0) > 1024 * 1024 || (infoAttributes?.length ?? 0) > 1024 * 1024) throw new Error("Git info metadata exceeds its bounded limit");
  const blockedAttributes = Buffer.concat([infoAttributes ?? Buffer.alloc(0), Buffer.from("\n* -filter -merge\n")]);
  const { config, fileMode } = shadowConfig(await git(["config", "--null", "--list"], root));
  const temp = await mkdtemp(path.join(tmpdir(), "captain-shadow-git-")), dir = path.join(temp, "git");
  const env = safeEnvironment();
  // Git documents C-style quoting for the platform-specific alternate-object separator.
  env.GIT_ALTERNATE_OBJECT_DIRECTORIES = JSON.stringify(objectDir.replaceAll("\\", "/"));
  try {
    await invoke(["init", "--bare", "-q", `--object-format=${objectFormat}`, dir], temp, env);
    if (config) await writeFile(path.join(dir, "config"), config, { flag: "a" });
    await writeFile(path.join(dir, "HEAD"), `${head}\n`);
    await writeFile(path.join(dir, "index"), originalIndex);
    if (shared && sharedPath) await writeFile(path.join(dir, path.basename(sharedPath)), shared);
    if (exclude) await writeFile(path.join(dir, "info", "exclude"), exclude);
    await writeFile(path.join(dir, "info", "attributes"), blockedAttributes);
    const run = (args: string[], input?: string | Buffer) => invoke([`--git-dir=${dir}`, `--work-tree=${root}`, "-c", `core.hooksPath=${path.join(temp, "hooks")}`, "-c", "core.fsmonitor=false", "-c", "merge.default=text", ...args], root, env, input);
    await mkdir(path.join(temp, "hooks"));
    let expectedIndex = originalIndex;
    const checkAttributes: ShadowGit["checkAttributes"] = async (paths, attributes, cached = false) => {
      if (!attributes.length || attributes.some(name => !/^[a-zA-Z][a-zA-Z0-9._-]*$/.test(name))) throw new Error("invalid Git attribute names");
      const found: Array<{ path: string; attributes: Record<string, string> }> = [], attrsPath = path.join(dir, "info", "attributes");
      try {
        // check-attr parses metadata only: it cannot run clean, smudge, or merge drivers.
        await writeFile(attrsPath, infoAttributes ?? Buffer.alloc(0));
        for (const batch of paths.length ? [paths] : []) {
          const input = Buffer.from(batch.map(value => `${value}\0`).join(""));
          if (input.length > maxOutput) throw new Error("Git attribute inputs exceed their bounded limit");
          const fields = utf8(await run(["check-attr", ...(cached ? ["--cached"] : []), "-z", "--stdin", ...attributes], input)).split("\0");
          if (fields.at(-1) === "") fields.pop();
          if (fields.length !== batch.length * attributes.length * 3) throw new Error("Git attribute result count diverged");
          for (let i = 0; i < batch.length; i++) {
            const values: Record<string, string> = {};
            for (let j = 0; j < attributes.length; j++) {
              const offset = (i * attributes.length + j) * 3;
              if (fields[offset] !== batch[i] || fields[offset + 1] !== attributes[j]) throw new Error("Git attribute result diverged");
              values[attributes[j]] = fields[offset + 2];
            }
            found.push({ path: batch[i], attributes: values });
          }
        }
      } finally { await writeFile(attrsPath, blockedAttributes); }
      return found;
    };
    const writeObject: ShadowGit["writeObject"] = async value => {
      await assertObjectStore();
      const writeEnv: NodeJS.ProcessEnv = { ...env, GIT_OBJECT_DIRECTORY: objectDir }; delete writeEnv.GIT_ALTERNATE_OBJECT_DIRECTORIES;
      const actual = (await invoke([`--git-dir=${dir}`, `--work-tree=${root}`, "hash-object", "-w", "--stdin"], root, writeEnv, value)).toString("ascii").trim();
      const expected = createHash(objectFormat).update(`blob ${value.length}\0`).update(value).digest("hex");
      await assertObjectStore();
      if (actual !== expected) throw new Error("Git object write diverged");
      return actual;
    };
    const writeMergeCommit: ShadowGit["writeMergeCommit"] = async (tree, ours, theirs) => {
      const oid = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
      if (![tree, ours, theirs].every(value => oid.test(value) && value.length === head.length) || ours !== head) throw new Error("invalid isolated merge commit binding");
      for (const [value, type] of [[tree, "tree"], [ours, "commit"], [theirs, "commit"]]) {
        if ((await run(["cat-file", "-t", value])).toString("ascii").trim() !== type) throw new Error("isolated merge commit object type diverged");
      }
      const value = Buffer.from(`tree ${tree}\nparent ${ours}\nparent ${theirs}\nauthor Captain SDLC <captain@invalid> 0 +0000\ncommitter Captain SDLC <captain@invalid> 0 +0000\n\nPrivate merge preparation\n`);
      await assertObjectStore();
      const writeEnv: NodeJS.ProcessEnv = { ...env, GIT_OBJECT_DIRECTORY: objectDir }; delete writeEnv.GIT_ALTERNATE_OBJECT_DIRECTORIES;
      const actual = (await invoke([`--git-dir=${dir}`, `--work-tree=${root}`, "hash-object", "-t", "commit", "-w", "--stdin"], root, writeEnv, value)).toString("ascii").trim();
      const expected = createHash(objectFormat).update(`commit ${value.length}\0`).update(value).digest("hex");
      await assertObjectStore();
      if (actual !== expected) throw new Error("isolated merge commit object write diverged");
      return actual;
    };
    const stageFiles: ShadowGit["stageFiles"] = async paths => {
      const writeEnv: NodeJS.ProcessEnv = { ...env, GIT_OBJECT_DIRECTORY: objectDir }; delete writeEnv.GIT_ALTERNATE_OBJECT_DIRECTORIES;
      for (const batch of batches(paths, value => value)) {
        await assertObjectStore();
        // Copying or rewriting the index refreshes its timestamp and can hide
        // same-size edits made within the filesystem's timestamp resolution.
        // Every batch must restore Git's racily-clean content check.
        await utimes(path.join(dir, "index"), new Date(1000), new Date(1000));
        await invoke(["--literal-pathspecs", `--git-dir=${dir}`, `--work-tree=${root}`, "-c", `core.hooksPath=${path.join(temp, "hooks")}`, "-c", "core.fsmonitor=false", "add", "--", ...batch], root, writeEnv);
        await assertObjectStore();
      }
    };
    const publishIndex: ShadowGit["publishIndex"] = async () => {
      await assertObjectStore();
      const lockPath = `${indexPath}.lock`, lock = await open(lockPath, "wx"); let closed = false, published = false;
      const ownedLock = await lock.stat({ bigint: true });
      try {
        const current = await metadata(indexPath);
        if (!current || !current.equals(expectedIndex) || await git(["rev-parse", "--verify", "HEAD^{commit}"], root) !== head) throw new Error("Git HEAD or index changed before index publication");
        await run(["update-index", "--no-split-index"]);
        const replacement = await metadata(path.join(dir, "index"));
        if (!replacement) throw new Error("isolated Git index is missing");
        await lock.writeFile(replacement); await lock.sync();
        const lockInfo = await lock.stat({ bigint: true }), pathInfo = await lstat(lockPath, { bigint: true });
        const unchanged = await metadata(indexPath);
        if (pathInfo.isSymbolicLink() || pathInfo.dev !== lockInfo.dev || pathInfo.ino !== lockInfo.ino || !unchanged || !unchanged.equals(expectedIndex) || await git(["rev-parse", "--verify", "HEAD^{commit}"], root) !== head) throw new Error("Git index authority changed during publication");
        await lock.close(); closed = true;
        await assertObjectStore();
        await rename(lockPath, indexPath); published = true; expectedIndex = replacement;
      } finally {
        if (!closed) await lock.close();
        if (!published) {
          try { const found = await lstat(lockPath, { bigint: true }); if (!found.isSymbolicLink() && found.dev === ownedLock.dev && found.ino === ownedLock.ino && found.ino !== 0n) await unlink(lockPath); }
          catch (error: any) { if (error.code !== "ENOENT") throw error; }
        }
      }
    };
    let shadow!: ShadowGit;
    const mergeTree: ShadowGit["mergeTree"] = async (ours, theirs) => {
      assertMergeTreeGitVersion((await run(["version"])).toString("utf8").trim());
      const oidPattern = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
      if (!oidPattern.test(ours) || !oidPattern.test(theirs) || ours !== head) throw new Error("invalid isolated merge-tree commit binding");
      if ((await run(["cat-file", "-t", theirs])).toString("ascii").trim() !== "commit") throw new Error("isolated merge-tree target is not a commit");
      const expectedTree = (await run(["rev-parse", `${ours}^{tree}`])).toString("ascii").trim();
      const currentTree = (await run(["write-tree"])).toString("ascii").trim();
      if (currentTree !== expectedTree) throw new Error("isolated merge-tree requires the unchanged source index");
      const originals = entries(await run(["ls-files", "--stage", "-v", "-z"]));
      if (originals.some(item => item.flag.toUpperCase() === "S" || /^[a-z]$/.test(item.flag))) throw new Error("isolated merge-tree refuses hidden index entries");
      const bases = (await run(["merge-base", "--all", ours, theirs])).toString("ascii").trim().split(/\r?\n/).filter(Boolean);
      if (!bases.length || bases.some(value => !oidPattern.test(value))) throw new Error("isolated merge-tree requires a valid merge base");
      const snapshots: Array<{ files: Set<string>; lfs: Set<string> }> = [], binary = new Set<string>();
      for (const revision of [...new Set([ours, theirs, ...bases])]) {
        await run(["read-tree", "--no-sparse-checkout", revision]);
        const indexed = entries(await run(["ls-files", "--stage", "-v", "-z"]));
        const lfs = await indexedLfs(shadow, false), selected = new Set(lfs.map(item => item.path));
        for (const item of lfs) binary.add(item.path);
        snapshots.push({ files: new Set(indexed.map(item => item.path)), lfs: selected });
      }
      for (const name of binary) for (const snapshot of snapshots) if (snapshot.files.has(name) && !snapshot.lfs.has(name)) throw new Error(`LFS attribute transition requires explicit resolution: ${name}`);
      const binaryPaths = [...binary].sort(), folded = new Set<string>();
      for (const name of binaryPaths) {
        const key = process.platform === "win32" ? name.toLowerCase() : name;
        if (folded.has(key)) throw new Error("LFS merge has case-colliding paths");
        folded.add(key);
      }
      await run(["read-tree", "--no-sparse-checkout", ours]);
      const attrsPath = path.join(dir, "info", "attributes"), rules = Buffer.concat([infoAttributes ?? Buffer.alloc(0), Buffer.from(`\n* -filter\n${binaryPaths.map(binaryAttributeRule).join("")}`)]);
      if (rules.length > maxOutput) throw new Error("LFS merge attribute rules exceed the bounded limit");
      try {
        await writeFile(attrsPath, rules);
        if (binaryPaths.length) {
          const input = Buffer.from(binaryPaths.map(value => `${value}\0`).join(""));
          const fields = utf8(await run(["check-attr", "--cached", "-z", "--stdin", "filter", "merge"], input)).split("\0");
          if (fields.at(-1) === "") fields.pop();
          if (fields.length !== binaryPaths.length * 6) throw new Error("LFS merge attribute verification diverged");
          for (let i = 0; i < binaryPaths.length; i++) {
            const part = fields.slice(i * 6, i * 6 + 6);
            if (part[0] !== binaryPaths[i] || part[1] !== "filter" || part[2] !== "unset" || part[3] !== binaryPaths[i] || part[4] !== "merge" || part[5] !== "unset") throw new Error(`LFS merge path does not use the binary driver: ${binaryPaths[i]}`);
          }
        }
        await assertObjectStore();
        const writeEnv: NodeJS.ProcessEnv = { ...env, GIT_OBJECT_DIRECTORY: objectDir }; delete writeEnv.GIT_ALTERNATE_OBJECT_DIRECTORIES;
        // The global option fails closed on Git versions without pinned attribute sources.
        const result = await invokeResult([`--attr-source=${ours}`, `--git-dir=${dir}`, `--work-tree=${root}`, "-c", `core.hooksPath=${path.join(temp, "hooks")}`, "-c", "core.fsmonitor=false", "-c", "merge.default=text", "merge-tree", "--write-tree", "-z", ours, theirs], root, writeEnv);
        await assertObjectStore();
        if (result.status !== 0 && result.status !== 1) throw new Error(`isolated Git merge-tree failed: ${result.error}`);
        return { status: result.status === 0 ? "clean" : "conflicts", output: result.output, binaryPaths };
      } finally { await writeFile(attrsPath, blockedAttributes); }
    };
    shadow = { dir, root, indexFile: path.join(dir, "index"), fileMode, run, mergeTree, checkAttributes, writeObject, writeMergeCommit, stageFiles, publishIndex };
    const result = await operation(shadow);
    await assertObjectStore();
    const finalIndex = await metadata(indexPath), finalShared = sharedPath ? await metadata(sharedPath) : undefined, finalExclude = await metadata(excludePath), finalAttributes = await metadata(attributesPath);
    if (!finalIndex || !finalIndex.equals(expectedIndex) || (shared && (!finalShared || !finalShared.equals(shared))) || Boolean(exclude) !== Boolean(finalExclude) || (exclude && !exclude.equals(finalExclude!)) || Boolean(infoAttributes) !== Boolean(finalAttributes) || (infoAttributes && !infoAttributes.equals(finalAttributes!)) || await git(["rev-parse", "--verify", "HEAD^{commit}"], root) !== head) throw new Error("Git HEAD, index, or info metadata changed during isolated status");
    return result;
  } finally { await safeTempCleanup(temp); }
}

type IndexEntry = { path: string; oid: string; mode: string; flag: string; stage: string };
function entries(data: Buffer, allowUnmerged = false): IndexEntry[] {
  const result: IndexEntry[] = [];
  for (const line of utf8(data).split("\0").filter(Boolean)) {
    const match = /^([A-Za-z?]) (\d{6}) ([a-f0-9]{40}(?:[a-f0-9]{24})?) ([0-3])\t([\s\S]+)$/.exec(line);
    if (!match) throw new Error("invalid Git index entry");
    if (match[4] !== "0" && !allowUnmerged) throw new Error("unmerged Git index requires explicit conflict resolution");
    const relative = match[5];
    if (path.isAbsolute(relative) || relative.split("/").some(part => !part || part === "." || part === "..")) throw new Error("unsafe Git index path");
    result.push({ path: relative, oid: match[3], mode: match[2], flag: match[1], stage: match[4] });
  }
  return result;
}
function batches<T>(items: T[], render: (item: T) => string): T[][] {
  const result: T[][] = []; let current: T[] = [], length = 0;
  for (const item of items) { const size = Buffer.byteLength(render(item)) + 4; if (size > 7000) throw new Error("Git path exceeds isolated command limit"); if (length + size > 7000) { result.push(current); current = []; length = 0; } current.push(item); length += size; }
  if (current.length) result.push(current); return result;
}
function parsePointer(pointer: Buffer, indexOid: string): { oid: string; size: number } {
  const algorithm = indexOid.length === 40 ? "sha1" : "sha256";
  if (createHash(algorithm).update(`blob ${pointer.length}\0`).update(pointer).digest("hex") !== indexOid) throw new Error("LFS pointer Git object hash mismatch");
  if (pointer.length === 0) return { oid: createHash("sha256").update(pointer).digest("hex"), size: 0 };
  const value = parseLfsPointer(pointer);
  if (!value || value.size <= 0) throw new Error("LFS index contains an invalid pointer or unsupported extension");
  return value;
}
async function indexedLfs(shadow: ShadowGit, allowUnmerged: boolean): Promise<IndexedLfs[]> {
  const all = entries(await shadow.run(["ls-files", "--stage", "-v", "-z"]), allowUnmerged);
  if (all.some(item => item.stage !== "0" && path.posix.basename(item.path).toLowerCase() === ".gitattributes")) throw new Error("unmerged Git attributes require explicit conflict resolution");
  const indexed = all.filter(item => item.stage === "0");
  const selected: IndexEntry[] = [], attributes = await shadow.checkAttributes(indexed.map(item => item.path), ["filter"], true);
  for (let i = 0; i < indexed.length; i++) {
    const item = indexed[i], value = attributes[i].attributes.filter;
    if (value === "lfs") { if (item.mode !== "100644" && item.mode !== "100755") throw new Error("LFS input must be a regular tracked file"); if (item.flag.toUpperCase() === "S") throw new Error(`sparse LFS path requires an expanded index: ${item.path}`); selected.push(item); }
    else if (value !== "unspecified" && value !== "unset") throw new Error(`unsupported Git clean filter for ${item.path}`);
  }
  const oids = [...new Set(selected.map(item => item.oid))];
  if (!oids.length) return [];
  const sizes = (await shadow.run(["cat-file", "--batch-check"], `${oids.join("\n")}\n`)).toString("utf8").trimEnd().split("\n");
  if (sizes.length !== oids.length) throw new Error("LFS object size result count diverged");
  for (let i = 0; i < oids.length; i++) {
    const match = /^([a-f0-9]+) blob ([0-9]+)$/.exec(sizes[i]);
    if (!match || match[1] !== oids[i] || Number(match[2]) >= 1024) throw new Error("LFS index contains a missing, oversized, or non-pointer object");
  }
  const output = await shadow.run(["cat-file", "--batch"], `${oids.join("\n")}\n`), pointers = new Map<string, Buffer>();
  let position = 0;
  for (const oid of oids) {
    const end = output.indexOf(10, position); if (end < 0) throw new Error("truncated LFS object header");
    const match = /^([a-f0-9]+) blob ([0-9]+)$/.exec(output.subarray(position, end).toString("ascii"));
    if (!match || match[1] !== oid || Number(match[2]) >= 1024) throw new Error("unexpected LFS object header");
    const size = Number(match[2]), first = end + 1, last = first + size;
    if (last >= output.length || output[last] !== 10) throw new Error("truncated LFS object content");
    pointers.set(oid, output.subarray(first, last)); position = last + 1;
  }
  if (position !== output.length) throw new Error("unexpected trailing LFS object data");
  return selected.map(item => { const pointer = pointers.get(item.oid)!; return { path: item.path, indexOid: item.oid, pointer, ...parsePointer(pointer, item.oid) }; });
}

/** Callers that stage or hydrate require a fully resolved index. */
export const listShadowIndexedLfs = (shadow: ShadowGit) => indexedLfs(shadow, false);

/** Discover indexed LFS pointers without starting repository-defined programs. */
export const listIndexedLfs = (worktree: string, git: GitReader) => withShadowGit(worktree, git, listShadowIndexedLfs);

type FileWitness = { path: string; dev: bigint; ino: bigint; size: bigint; mode: bigint; mtimeNs: bigint; ctimeNs: bigint };
async function hydrated(root: string, item: IndexedLfs): Promise<FileWitness | undefined> {
  const file = path.resolve(root, ...item.path.split("/")), relative = path.relative(root, file);
  if (!relative || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) throw new Error("LFS path escapes its worktree");
  let info;
  try { info = await lstat(file, { bigint: true }); } catch (error: any) { if (error.code === "ENOENT") return undefined; throw error; }
  if (info.isSymbolicLink()) throw new Error(`LFS path is a reparse point: ${item.path}`);
  if (!info.isFile()) return undefined;
  if (!samePath(await realpath(file), file)) throw new Error(`LFS path resolves through a reparse point: ${item.path}`);
  if (info.size !== BigInt(item.size)) {
    if (info.size === BigInt(item.pointer.length) && (await readFile(file)).equals(item.pointer)) throw new Error(`LFS asset is not hydrated: ${item.path}`);
    return undefined;
  }
  const handle = await open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat({ bigint: true });
    if (before.dev !== info.dev || before.ino !== info.ino || before.size !== info.size) throw new Error(`LFS input changed while opening: ${item.path}`);
    const hash = createHash("sha256");
    for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk as Buffer);
    const after = await handle.stat({ bigint: true }), current = await lstat(file, { bigint: true });
    if (!current.isFile() || current.isSymbolicLink() || after.size !== before.size || after.mode !== before.mode || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs || current.ino !== before.ino || current.dev !== before.dev || current.size !== after.size || current.mode !== after.mode || current.mtimeNs !== after.mtimeNs || current.ctimeNs !== after.ctimeNs) throw new Error(`LFS input changed while hashing: ${item.path}`);
    if (hash.digest("hex") !== item.oid) return undefined;
    return { path: file, dev: after.dev, ino: after.ino, size: after.size, mode: after.mode, mtimeNs: after.mtimeNs, ctimeNs: after.ctimeNs };
  } finally { await handle.close(); }
}

async function safeWorktreeQuery(worktree: string, git: GitReader, command: string[]): Promise<Buffer> {
  const result = await withShadowGit(worktree, git, async shadow => {
    const indexed = entries(await shadow.run(["ls-files", "--stage", "-v", "-z"]), true).filter(item => item.stage === "0");
    const assumed = indexed.filter(item => item.flag !== item.flag.toUpperCase()).map(item => item.path);
    const sparse = indexed.filter(item => item.flag.toUpperCase() === "S").map(item => item.path);
    // User index hints must not hide inputs from a signed clean-worktree check.
    for (const batch of batches(assumed, item => item)) await shadow.run(["update-index", "--no-assume-unchanged", "--", ...batch]);
    for (const batch of batches(sparse, item => item)) await shadow.run(["update-index", "--no-skip-worktree", "--", ...batch]);
    const lfs = await indexedLfs(shadow, true), clean: string[] = [], witnesses: FileWitness[] = [];
    const checked: Array<FileWitness | undefined> = new Array(lfs.length); let next = 0;
    await Promise.all(Array.from({ length: Math.min(8, lfs.length) }, async () => { for (;;) { const index = next++; if (index >= lfs.length) return; checked[index] = await hydrated(shadow.root, lfs[index]); } }));
    const indexedModes = new Map(indexed.map(item => [item.path, item.mode]));
    for (let index = 0; index < lfs.length; index++) {
      const witness = checked[index], mode = indexedModes.get(lfs[index].path);
      if (witness && (!shadow.fileMode || ((witness.mode & 0o100n) !== 0n) === (mode === "100755"))) {
        clean.push(lfs[index].path); witnesses.push(witness);
      }
    }
    for (const batch of batches(clean, item => item)) await shadow.run(["update-index", "--assume-unchanged", "--", ...batch]);
    // A copied or rewritten index gets a fresh mtime.  That can defeat Git's
    // racily-clean check for same-size edits with equal filesystem timestamps.
    // Age only the private index, after every shadow update and immediately
    // before the query, so Git rechecks potentially stale tracked content.
    await utimes(shadow.indexFile, new Date(1000), new Date(1000));
    return { output: await shadow.run(command), witnesses };
  });
  for (const witness of result.witnesses) {
    const current = await lstat(witness.path, { bigint: true });
    if (!current.isFile() || current.isSymbolicLink() || current.dev !== witness.dev || current.ino !== witness.ino || current.size !== witness.size || current.mode !== witness.mode || current.mtimeNs !== witness.mtimeNs || current.ctimeNs !== witness.ctimeNs) throw new Error("LFS input changed during isolated status");
  }
  return result.output;
}

/** Preserve Git porcelain using a private index and no executable repository filters. */
export const safeGitStatus = async (worktree: string, git: GitReader) => (await safeWorktreeQuery(worktree, git, ["status", "--porcelain", "--untracked-files=normal"])).toString("utf8").trim();

/** NUL-delimited status detects edits and modes even under manifest-excluded directories. */
export const safeGitJournalStatusRaw = (worktree: string, git: GitReader) => safeWorktreeQuery(worktree, git, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"]);

/** The tracked worktree diff must not run repository-configured clean filters. */
export const safeGitDiffNames = async (worktree: string, git: GitReader) => (await safeWorktreeQuery(worktree, git, ["diff", "--no-ext-diff", "--no-textconv", "--name-only"])).toString("utf8").trim();

/** Preserve NUL-delimited bytes for a pinned-commit versus working-tree diff. */
export function safeGitDiffRaw(worktree: string, git: GitReader, base: string): Promise<Buffer> {
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(base)) throw new Error("working-tree diff requires a full commit object ID");
  return safeWorktreeQuery(worktree, git, ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--name-only", "-z", base, "--"]);
}

/** HEAD is pinned in the private shadow and checked again before returning. */
export const safeGitDiffHeadRaw = (worktree: string, git: GitReader) => safeWorktreeQuery(worktree, git, ["diff", "--no-ext-diff", "--no-textconv", "--name-only", "-z", "HEAD"]);

/** Unmerged paths are index-only; no working-tree conversion is needed. */
export async function safeGitUnmergedNames(worktree: string, git: GitReader): Promise<string> {
  return withShadowGit(worktree, git, async shadow => (await shadow.run(["diff", "--cached", "--no-ext-diff", "--no-textconv", "--name-only", "--diff-filter=U"])).toString("utf8").trim());
}
