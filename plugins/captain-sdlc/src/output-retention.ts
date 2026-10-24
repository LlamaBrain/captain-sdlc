import { lstat, mkdir, readdir, realpath, rm, rmdir } from "node:fs/promises";
import path from "node:path";
import type { ProjectPolicy } from "./lifecycle.js";
import { git } from "./workspace.js";

export type OutputRetention = { schema_version: 1; roots: Record<string, string[]> };
export type OutputPreparation = { scope: string; roots: string[]; removedFiles: number; retainedTrackedFiles: number };
const generated = new Set(["artifacts", "build", "builds", "dist", "bin", "obj", "coverage", "generated", ".captain-proof", "out", "output", "target", "publish"]);
const payloadDirectories = new Set(["build", "builds", "dist", "out", "output", "target", "publish"]);
const protectedSegments = new Set([".git", ".agents", ".codex", "node_modules", "worktrees", ".worktrees"]);
const reportExtension = /\.(?:json|xml|txt|log|md|csv|html|junit|sha256)$/i;
const payloadExtension = /\.(?:zip|tar|gz|7z|exe|apk|aab|app|msi|nupkg|vsix|whl|jar|wasm|dll|so|dylib)$/i;
const mediaFileExtension = /\.(?:png|apng|jpe?g|webp|gif|bmp|tiff?|tga|ico|svg|avif|heic|heif|exr|hdr|mp4|m4v|webm|mov|avi|mkv|mpe?g|ogv)$/i;
// File preparation is independent of which paths can grant build-payload authority.
const outputFile = (relative: string) => reportExtension.test(relative) || payloadExtension.test(relative) || mediaFileExtension.test(relative);
const normalized = (value: string) => value.replaceAll("\\", "/");
const key = (value: string) => normalized(value).toLowerCase();
const contains = (parent: string, child: string) => key(child) === key(parent) || key(child).startsWith(key(parent).replace(/\/$/, "") + "/");
const samePath = (left: string, right: string) => process.platform === "win32" ? path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase() : path.resolve(left) === path.resolve(right);

/** Output ownership is explicit and narrower than the repository or its worktree container. */
export function outputRoot(value: unknown): string {
  if (typeof value !== "string" || !value || path.isAbsolute(value) || !/^[A-Za-z0-9._/& -]+$/.test(value)) throw new Error("output retention root must use a safe repository-relative path");
  const relative = normalized(value), segments = relative.split("/"), lower = segments.map(segment => segment.toLowerCase());
  if (segments.some(segment => !segment || segment === "." || segment === ".." || /[. ]$/.test(segment)) || lower.some(segment => protectedSegments.has(segment))) throw new Error("output retention root overlaps a protected metadata or worktree path");
  if (lower.includes(".captain-sdlc") && !(lower[0] === ".captain-sdlc" && lower[1] === "output" && lower.length >= 3)) throw new Error("output retention root overlaps protected Captain metadata");
  if (!lower.some(segment => generated.has(segment)) && !payloadExtension.test(relative)) throw new Error("output retention root must name generated output, not authored source");
  return relative;
}

function parseRetention(value: unknown): OutputRetention {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("output retention must be an object");
  const raw = value as Record<string, unknown>;
  if (raw.schema_version !== 1 || !raw.roots || typeof raw.roots !== "object" || Array.isArray(raw.roots)) throw new Error("output retention requires schema_version 1 and scope roots");
  const roots: Record<string, string[]> = {}, all: string[] = [];
  for (const [scope, values] of Object.entries(raw.roots)) {
    if (!/^[a-z][a-z-]*$/.test(scope) || !Array.isArray(values) || values.length > 64) throw new Error("output retention scope roots must be bounded arrays");
    roots[scope] = values.map(outputRoot);
    for (const relative of roots[scope]) {
      if (all.some(previous => contains(previous, relative) || contains(relative, previous))) throw new Error("output retention roots must not overlap");
      all.push(relative);
    }
  }
  return { schema_version: 1, roots };
}

async function ignored(root: string, relative: string) {
  for (const candidate of [relative, ...(!outputFile(relative) ? [relative + "/"] : [])]) {
    try { await git(["check-ignore", "--no-index", "--quiet", "--", candidate], root); return true; }
    catch (error: any) { if (error.code !== 1) throw error; }
  }
  return false;
}

/** Called only while capturing a new policy; saved policies never gain deletion authority. */
export async function captureOutputRetention(root: string, baseHead: string, raw: unknown, artifactPaths: Record<string, string> = {}, trackedBasePaths: string[] = [], sourceExcludes: string[] = []): Promise<OutputRetention> {
  const tracked = trackedBasePaths.map(normalized), inferred: Record<string, string[]> = {};
  let result: OutputRetention;
  if (raw !== undefined) result = parseRetention(raw);
  else {
    const buildRoots: string[] = [];
    const add = (relative: string) => {
      relative = outputRoot(relative);
      if (buildRoots.some(previous => contains(previous, relative))) return;
      for (let index = buildRoots.length - 1; index >= 0; index--) if (contains(relative, buildRoots[index])) buildRoots.splice(index, 1);
      buildRoots.push(relative);
    };
    if (artifactPaths.build) {
      const artifact = normalized(artifactPaths.build), segments = artifact.split("/"), payloadIndex = segments.findIndex(segment => payloadDirectories.has(segment.toLowerCase()));
      if (payloadIndex >= 0) {
        const candidate = segments.slice(0, payloadIndex + 1).join("/");
        add(candidate);
      }
      if (tracked.some(file => file.startsWith(artifact + "/"))) add(artifact);
      else if (!reportExtension.test(artifact) && payloadExtension.test(artifact)) add(artifact);
      for (const candidate of sourceExcludes) {
        if (!payloadDirectories.has(candidate.split("/").at(-1)!.toLowerCase()) || tracked.some(file => contains(candidate, file))) continue;
        add(candidate);
      }
    }
    if (buildRoots.length) inferred.build = buildRoots;
    for (const [role, scope] of [["smoke", "feature-smoke"], ["visual", "visual"]]) {
      const artifact = artifactPaths[role];
      if (artifact && !buildRoots.some(parent => contains(parent, artifact))) {
        // A mutable local ignore rule never grants new deletion roots.
        try { inferred[scope] = [outputRoot(artifact)]; } catch { /* Non-generated legacy report locations require explicit configuration. */ }
      }
    }
    result = parseRetention({ schema_version: 1, roots: inferred });
  }
  if (artifactPaths.build && !(result.roots.build ?? []).some(relative => !reportExtension.test(relative) || tracked.some(file => file.startsWith(relative + "/")))) throw new Error("build policy must configure outputRetention.roots.build with a disposable payload root; a report file alone does not bound build storage");
  for (const [scope, roots] of Object.entries(result.roots)) {
    for (const relative of roots) {
      // The base commit is authoritative even if ignored output rules in this checkout changed.
      const entry = await git(["ls-tree", baseHead, "--", relative], root);
      if (/^120000 /.test(entry) || /^160000 /.test(entry)) throw new Error(`output retention root is a tracked link or repository: ${relative}`);
    }
    if (!scope) throw new Error("output retention scope is empty");
  }
  return result;
}

/** Generated files are not source inputs; tracked build surfaces remain bound to their hashes. */
export function outputPathExcluded(relative: string, policy: Pick<ProjectPolicy, "outputRetention">, tracked: Set<string>): boolean {
  if (!policy.outputRetention) return false;
  const roots = Object.values(policy.outputRetention.roots).flat();
  if (!roots.some(root => contains(root, relative))) return false;
  return ![...tracked].some(file => contains(relative, file) || contains(file, relative));
}

async function ancestors(root: string, target: string) {
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("output retention target escapes the worktree");
  for (let cursor = target; ; cursor = path.dirname(cursor)) {
    try { if ((await lstat(cursor)).isSymbolicLink()) throw new Error("output retention crosses a reparse point or symlink"); }
    catch (error: any) { if (error.code !== "ENOENT") throw error; }
    if (!samePath(cursor, root)) {
      try { await lstat(path.join(cursor, ".git")); throw new Error("output retention crosses a nested repository"); }
      catch (error: any) { if (!["ENOENT", "ENOTDIR"].includes(error.code)) throw error; }
    }
    if (samePath(cursor, root)) break;
  }
}

async function trackedSnapshot(root: string) {
  const head = await git(["rev-parse", "HEAD"], root), index = await git(["ls-files", "--stage", "-z"], root);
  const files = new Set([...index.split("\0").filter(Boolean).map(entry => entry.slice(entry.indexOf("\t") + 1)), ...((await git(["ls-tree", "-r", "--name-only", "-z", head], root)).split("\0"))].filter(Boolean).map(key));
  return { head, index, files };
}

/** Preflight every declared output tree before removing generated files from any of them. */
export async function prepareScopeOutputs(worktree: string, policy: Pick<ProjectPolicy, "outputRetention">, scope: string, options: { validateOnly?: boolean } = {}): Promise<OutputPreparation> {
  const summary: OutputPreparation = { scope, roots: [], removedFiles: 0, retainedTrackedFiles: 0 };
  if (!policy.outputRetention) return summary;
  const retention = parseRetention(policy.outputRetention), roots = retention.roots[scope] ?? [];
  if (!roots.length) return summary;
  const root = path.resolve(worktree), actual = path.resolve(await git(["rev-parse", "--show-toplevel"], root));
  if (!samePath(root, actual) || !samePath(root, await realpath(root))) throw new Error("output retention requires the real Git worktree root");
  const registered = (await git(["worktree", "list", "--porcelain", "-z"], root)).split("\0").filter(entry => entry.startsWith("worktree ")).map(entry => path.resolve(entry.slice(9)));
  const snapshot = await trackedSnapshot(root), tracked = snapshot.files;
  const isTracked = (relative: string) => [...tracked].some(file => contains(file, relative));
  const plans: Array<{ relative: string; absolute: string; files: string[]; directories: string[]; fileRoot: boolean }> = [];
  for (const relative of roots) {
    const absolute = path.resolve(root, relative); await ancestors(root, absolute);
    if (registered.some(other => contains(absolute, other))) throw new Error(`output retention root contains a registered worktree: ${relative}`);
    const files: string[] = [], directories: string[] = [];
    let fileRoot = outputFile(relative);
    async function scan(target: string) {
      let info;
      try { info = await lstat(target); } catch (error: any) { if (error.code === "ENOENT") return; throw error; }
      if (info.isSymbolicLink()) throw new Error("output retention tree contains a reparse point or symlink");
      if (info.isDirectory()) {
        if (target === absolute) fileRoot = false;
        directories.push(target);
        for (const entry of await readdir(target, { withFileTypes: true })) {
          if (entry.name.toLowerCase() === ".git" || entry.name.toLowerCase() === ".captain-sdlc") throw new Error("output retention tree contains a nested repository or Captain metadata");
          await scan(path.join(target, entry.name));
        }
      } else if (info.isFile()) { if (target === absolute) fileRoot = true; files.push(target); }
      else throw new Error("output retention tree contains an unsupported filesystem entry");
    }
    await scan(absolute);
    const retainsTracked = [...tracked].some(file => contains(relative, file));
    if (!retainsTracked && !await ignored(root, relative)) throw new Error(`output retention root must be Git-ignored generated output: ${relative}`);
    plans.push({ relative, absolute, files, directories, fileRoot });
  }
  if (options.validateOnly) return { ...summary, roots: plans.map(plan => plan.relative) };
  for (const plan of plans) {
    const current = await trackedSnapshot(root);
    if (current.head !== snapshot.head || current.index !== snapshot.index) throw new Error("output retention HEAD or index changed during preflight; preserve the new tracked state and retry under its owner");
    const currentWorktrees = (await git(["worktree", "list", "--porcelain", "-z"], root)).split("\0").filter(entry => entry.startsWith("worktree ")).map(entry => path.resolve(entry.slice(9)));
    if (currentWorktrees.some(other => contains(plan.absolute, other))) throw new Error("output retention root acquired a registered worktree during preflight");
    for (const file of plan.files) {
      const relative = normalized(path.relative(root, file));
      if (isTracked(relative)) { summary.retainedTrackedFiles++; continue; }
      await ancestors(root, file);
      try { if ((await lstat(file)).isSymbolicLink()) throw new Error("output retention target changed to a reparse point"); }
      catch (error: any) { if (error.code !== "ENOENT") throw error; }
      await rm(file, { force: true }); summary.removedFiles++;
    }
    for (const directory of plan.directories.reverse()) {
      await ancestors(root, directory);
      try { await rmdir(directory); } catch (error: any) { if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error.code)) throw error; }
    }
    await ancestors(root, plan.absolute);
    await mkdir(plan.fileRoot ? path.dirname(plan.absolute) : plan.absolute, { recursive: true });
    summary.roots.push(plan.relative);
  }
  return summary;
}

/** Validate a prospective stable slot before recording immutable ownership metadata. */
export const validateScopeOutputs = (worktree: string, policy: Pick<ProjectPolicy, "outputRetention">, scope: string) => prepareScopeOutputs(worktree, policy, scope, { validateOnly: true });
