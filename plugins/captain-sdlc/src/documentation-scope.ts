import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import type { Run } from "./lifecycle.js";
import { compileSafeRegex, parseStrictSemVer } from "./validation.js";
import { git, gitRaw } from "./workspace.js";

export type DocumentationScope = {
  schemaVersion: 1; expectedHead: string; paths: string[];
  pathDigests: Record<string, string | null>; reason: string; recordedAt: string;
  sessionId: string; turnId: string; policySha256: string; captureMode: "planned" | "existing_changes";
};
const maxText = 4 * 1024 * 1024, maxPaths = 10000;
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
function fail(reason: string): never { throw new Error(`documentation scope: ${reason}`); }
const under = (file: string, root: string) => file.toLowerCase() === root.toLowerCase() || file.toLowerCase().startsWith(root.toLowerCase().replace(/\/$/, "") + "/");
function safePath(value: string): string {
  if (typeof value !== "string" || !value || value.length > 2000 || !/^[A-Za-z0-9_./ -]+$/.test(value) || value.split("/").some(part => !part || part === "." || part === ".." || /[. ]$/.test(part)) || path.isAbsolute(value)) fail("paths must be canonical repository-relative files");
  return value;
}
function documentationPath(relative: string): boolean {
  safePath(relative);
  const parts = relative.toLowerCase().split("/");
  if (parts.some(part => part.startsWith(".") || ["src", "plugins", "scripts", "tools", "tests", "test", "skills", "hooks", "node_modules", "sequences"].includes(part)) || ["agents.md", "claude.md", "skill.md"].includes(parts.at(-1)!)) return false;
  return /\.(?:md|txt|rst)$/i.test(relative) || /^schemas\/(?:[A-Za-z0-9_ -]+\/)*[A-Za-z0-9_. -]+\.schema\.json$/.test(relative);
}
function text(value: string, label: string): string {
  if (Buffer.byteLength(value) > maxText || /[\0\uFFFD]/.test(value)) fail(`${label} is not bounded UTF-8 text`);
  return value;
}
function documentText(value: string, relative: string): void {
  text(value, relative);
  if (/^\s*(?:`{3,}|~{3,})\s*captain-sequence\b/im.test(value)) fail(`${relative} contains executable Captain sequence instructions`);
  if (relative.endsWith(".schema.json")) {
    let schema: any; try { schema = JSON.parse(value); } catch { fail(`${relative} is malformed schema JSON`); }
    if (!schema || Array.isArray(schema) || typeof schema !== "object" || typeof schema.$schema !== "string" || !/^https?:\/\/json-schema\.org\/(?:draft\/[0-9-]+\/schema|draft-[0-9]+\/schema)#?$/.test(schema.$schema)) fail(`${relative} requires an official JSON Schema dialect`);
  }
}
async function regularFile(root: string, relative: string, allowAbsent: boolean): Promise<string | null> {
  safePath(relative); let missing = false;
  const parts = relative.split("/");
  for (let index = 0; index <= parts.length; index++) {
    const target = path.join(root, ...parts.slice(0, index));
    let info; try { info = await lstat(target); } catch (error: any) { if (error.code === "ENOENT" && allowAbsent) { missing = true; continue; } throw error; }
    if (missing || info.isSymbolicLink() || (index < parts.length ? !info.isDirectory() : !info.isFile())) fail(`${relative} crosses a link or is not a regular file`);
    if (index === parts.length && ((info.mode & 0o111) !== 0 || info.size > maxText)) fail(`${relative} has executable mode or exceeds the text limit`);
  }
  return missing ? null : text(await readFile(path.join(root, relative), "utf8"), relative);
}
function list(raw: string): string[] {
  const result = raw.split("\0").filter(Boolean); if (result.length > maxPaths) fail("path list exceeds the bounded review limit");
  return result;
}
type Entry = { mode: string; oid: string };
async function entries(root: string, revision?: string): Promise<Map<string, Entry>> {
  const raw = revision ? await gitRaw(["ls-tree", "-r", "-z", revision], root) : await gitRaw(["ls-files", "--stage", "-z"], root);
  const result = new Map<string, Entry>();
  for (const item of list(raw)) {
    const match = /^(\d{6}) (?:blob |commit )?([0-9a-f]+)(?: (\d))?\t([\s\S]+)$/.exec(item);
    if (!match || (match[3] && match[3] !== "0")) fail("index has unresolved or unreadable entries");
    result.set(match[4], { mode: match[1], oid: match[2] });
  }
  return result;
}
function regularMode(relative: string, ...maps: Map<string, Entry>[]): void {
  for (const map of maps) {
    if (map.get(relative)?.mode && map.get(relative)!.mode !== "100644") fail(`${relative} has non-document Git mode`);
    for (const key of map.keys()) if (key.toLowerCase() === relative.toLowerCase() && key !== relative) fail(`${relative} is a case alias`);
  }
}
async function changed(root: string, base: string, candidate?: string): Promise<string[]> {
  const tracked = list(await gitRaw(["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--name-only", "-z", base, ...(candidate ? [candidate] : []), "--"], root));
  const untracked = candidate ? [] : list(await gitRaw(["ls-files", "--others", "--exclude-standard", "-z"], root));
  return [...new Set([...tracked, ...untracked])].sort();
}
async function ignoredInputs(run: Run): Promise<void> {
  const excludes = [...(run.policy.sourceManifestExcludes ?? []), ...(run.policy.outputRetention?.roots.build ?? []), ".captain-proof", ".captain-sdlc/trace"];
  for (const relative of list(await gitRaw(["ls-files", "--others", "--ignored", "--exclude-standard", "-z"], run.worktreePath))) {
    if (relative.split("/").some(part => part.toLowerCase() === "node_modules") || excludes.some(root => under(relative, root))) continue;
    const base = path.posix.basename(relative);
    if (/\.(?:[cm]?[jt]sx?|cs|[ch](?:pp)?|java|py|rb|go|rs|ps1|sh|cmd|bat|exe|dll|so|dylib|csproj|props|targets|sln|ya?ml)$/i.test(base) || /^(?:\.[^/]+|package(?:-lock)?\.json|tsconfig[^/]*\.json|agents\.md|claude\.md|skill\.md)$/i.test(base)) fail(`ignored executable or control input is not authorized: ${relative}`);
  }
}
async function blob(root: string, revision: string, relative: string, map: Map<string, Entry>): Promise<string | null> {
  return map.has(relative) ? text(await gitRaw(["show", `${revision}:${relative}`], root), relative) : null;
}
function versionCapture(value: string, pattern: string, expectedVersion?: string): { version: string; normalized: string } {
  // Git blobs use LF even when core.autocrlf materializes a CRLF worktree.
  value = value.replace(/\r\n/g, "\n");
  const multiline = pattern.startsWith("(?m)"), expression = compileSafeRegex(multiline ? pattern.slice(4) : pattern, `dg${multiline ? "m" : ""}`, "documentation version surface"), matches = [...value.matchAll(expression)].filter(match => expectedVersion === undefined || (match.groups?.version ?? match[1]) === expectedVersion);
  if (matches.length !== 1) fail("version surface requires exactly one version capture");
  const match = matches[0], version = match.groups?.version ?? match[1], range = match.indices?.groups?.version ?? match.indices?.[1];
  if (!range || !parseStrictSemVer(version)) fail("version surface lacks one strict version capture");
  return { version, normalized: value.slice(0, range[0]) + "<captain-version>" + value.slice(range[1]) };
}
function versionOnly(relative: string, previous: string, current: string, pattern: string, oldVersion: string, nextVersion: string, generated = false): void {
  const before = versionCapture(previous, pattern, generated ? oldVersion : undefined), after = versionCapture(current, pattern, generated ? nextVersion : undefined);
  if (before.version !== oldVersion || after.version !== nextVersion) fail(`${relative} version differs from the canonical version file`);
  if (relative.endsWith(".json")) {
    let left: any, right: any; try { left = JSON.parse(previous); right = JSON.parse(current); } catch { fail(`${relative} is invalid JSON metadata`); }
    if (left.version !== oldVersion || right.version !== nextVersion) fail(`${relative} root version is not canonical`);
    left.version = right.version = "<captain-version>";
    if (path.posix.basename(relative) === "package-lock.json" && (left.packages?.[""] || right.packages?.[""])) {
      if (left.packages?.[""]?.version !== oldVersion || right.packages?.[""]?.version !== nextVersion) fail("package-lock own-package version is not canonical");
      left.packages[""].version = right.packages[""].version = "<captain-version>";
    }
    if (JSON.stringify(left) !== JSON.stringify(right)) fail(`${relative} changes more than owned release versions`);
  } else if (before.normalized !== after.normalized) fail(`${relative} changes executable content beside its version`);
}
function archive(relative: string, value: string, run: Run): void {
  const match = /^changelog\/changes\/\d{4}-\d{2}-\d{2}-[a-z0-9]+(?:-[a-z0-9]+)*-([a-f0-9]{12})\.md$/.exec(relative);
  if (!match) fail(`${relative} is not an authorized document or release fragment`);
  documentText(value, relative);
  const blocks = [...value.matchAll(/<!-- captain-changes:v1 -->\r?\n```json\r?\n([\s\S]*?)\r?\n```/g)];
  let data: any; try { data = blocks.length === 1 ? JSON.parse(blocks[0][1]) : null; } catch { fail("release fragment metadata is malformed"); }
  if (!data || data.schema_version !== 1 || data.audience !== "developer" || data.id !== (run.taskId ?? run.intentId) || data.source_branch !== run.branch || typeof data.project !== "string" || !data.project.trim() || digest(data.project + "\0" + data.id).slice(0, 12) !== match[1]) fail("release fragment ownership differs from this task");
}

export async function captureDocumentationScope(run: Run, paths: string[], reason: string, expectedHead: string): Promise<DocumentationScope> {
  if (!Array.isArray(paths) || !paths.length || paths.length > 100 || new Set(paths.map(value => value.toLowerCase())).size !== paths.length || typeof reason !== "string" || !reason.trim() || reason.length > 4000) fail("requires unique bounded document paths and an explicit reason");
  if (!/^[0-9a-f]{40,64}$/.test(expectedHead) || await git(["rev-parse", "HEAD"], run.worktreePath) !== expectedHead) fail("expected HEAD is stale");
  const selected = [...paths].sort(), dirty = await changed(run.worktreePath, expectedHead);
  if (dirty.length && JSON.stringify(dirty) !== JSON.stringify(selected)) fail("selected paths must equal the complete dirty set");
  await ignoredInputs(run);
  const base = await entries(run.worktreePath, expectedHead), index = await entries(run.worktreePath), pathDigests: Record<string, string | null> = {};
  for (const relative of selected) {
    if (!documentationPath(relative)) fail(`${relative} is executable or control-plane content`);
    regularMode(relative, base, index);
    const value = await regularFile(run.worktreePath, relative, !dirty.length);
    if (relative.startsWith("changelog/changes/")) {
      if (base.has(relative)) fail("existing release archives are immutable");
      if (value !== null) archive(relative, value, run);
    } else if (value !== null) documentText(value, relative);
    pathDigests[relative] = value === null ? null : digest(value);
  }
  return { schemaVersion: 1, expectedHead, paths: selected, pathDigests, reason: reason.trim(), recordedAt: new Date().toISOString(), sessionId: run.sessionId, turnId: run.turnId, policySha256: digest(JSON.stringify(run.policy)), captureMode: dirty.length ? "existing_changes" : "planned" };
}

export async function assertDocumentationScope(run: Run, candidate?: string): Promise<void> {
  const scope = run.documentationScope; if (!scope) return;
  if (scope.schemaVersion !== 1 || scope.policySha256 !== digest(JSON.stringify(run.policy))) fail("signed documentation policy binding changed");
  if (!/^[0-9a-f]{40,64}$/.test(scope.expectedHead) || (candidate !== undefined && !/^[0-9a-f]{40,64}$/.test(candidate))) fail("review revisions must be exact commit identities");
  await ignoredInputs(run);
  const root = run.worktreePath, base = await entries(root, scope.expectedHead), target = await entries(root, candidate), paths = await changed(root, scope.expectedHead, candidate);
  const read = (relative: string) => candidate ? blob(root, candidate, relative, target) : regularFile(root, relative, false);
  const commit = run.policy.commit, surfaces = commit?.version_surfaces ?? [], canonical = surfaces.find(item => item.path === commit?.version_file);
  let oldVersion = "", nextVersion = "";
  if (canonical) {
    const before = await blob(root, scope.expectedHead, canonical.path, base), after = await read(canonical.path);
    if (before === null || after === null) fail("canonical release version file cannot be added or removed");
    oldVersion = versionCapture(before, canonical.pattern).version; nextVersion = versionCapture(after, canonical.pattern).version;
  }
  for (const relative of paths) {
    safePath(relative); regularMode(relative, base, target);
    if (candidate) await regularFile(root, relative, true);
    const value = await read(relative); if (value === null) fail(`${relative} cannot be removed under documentation scope`);
    if (relative.startsWith("changelog/changes/")) { if (base.has(relative)) fail("existing release archives are immutable"); archive(relative, value, run); continue; }
    if (scope.paths.includes(relative)) { if (!documentationPath(relative)) fail(`${relative} is not documentation`); documentText(value, relative); continue; }
    if (commit?.changelog_files.includes(relative)) {
      if (!/\.(?:md|txt|rst)$/i.test(relative) || /^(?:agents|claude|skill)\.md$/i.test(path.posix.basename(relative)) || relative.split("/").some(part => part.startsWith(".") || ["src", "scripts", "tools", "tests", "skills", "hooks", "node_modules"].includes(part.toLowerCase()))) fail(`${relative} is not a non-executable changelog document`);
      documentText(value, relative); continue;
    }
    const surface = surfaces.find(item => item.path === relative), previous = await blob(root, scope.expectedHead, relative, base);
    if (surface && previous !== null) { versionOnly(relative, previous, value, surface.pattern, oldVersion, nextVersion); continue; }
    if (/\.[cm]?js$/.test(relative) && (run.policy.outputRetention?.roots.build ?? []).some(output => under(relative, output)) && previous !== null && oldVersion && nextVersion) {
      const pattern = 'version: ["\x27](?<version>[0-9]+\\.[0-9]+\\.[0-9]+)["\x27]';
      versionOnly(relative, previous, value, pattern, oldVersion, nextVersion, true); continue;
    }
    fail(`${relative} changes executable content outside the signed documentation paths`);
  }
}
