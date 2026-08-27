import { execFile } from "node:child_process";
import { lstat, readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { promisify } from "node:util";
import type { GateRunner, ProjectPolicy } from "./lifecycle.js";
const exec = promisify(execFile);
export const gateRunner: GateRunner = async (command, cwd) => {
  const env = { ...process.env }; delete env.PLUGIN_DATA; delete env.CAPTAIN_PLUGIN_DATA;
  try { const result = await exec(process.platform === "win32" ? "cmd.exe" : "/bin/sh", process.platform === "win32" ? ["/d", "/s", "/c", command] : ["-c", command], { cwd, env, maxBuffer: 10 * 1024 * 1024 }); return { exitCode: 0, stdout: result.stdout, stderr: result.stderr }; }
  catch (error: any) { return { exitCode: Number(error.code) || 1, stdout: error.stdout ?? "", stderr: error.stderr ?? error.message }; }
};
export async function git(args: string[], cwd: string): Promise<string> { return (await exec("git", args, { cwd })).stdout.trim(); }
export async function loadPolicy(projectRoot: string, baseHead: string): Promise<ProjectPolicy> {
  const text = await git(["show", `${baseHead}:.captain-sdlc/codex-policy.json`], projectRoot);
  const parsed = JSON.parse(text) as ProjectPolicy;
  if (!parsed.profile || typeof parsed.visualRequired !== "boolean" || !parsed.commands?.build || !parsed.commands.ticket || !parsed.commands["feature-smoke"] || !parsed.commands["affected-regression"] || (parsed.visualRequired && !parsed.commands.visual)) throw new Error("trusted base policy is incomplete");
  return parsed;
}
export async function repositoryIdentity(projectRoot: string): Promise<{ projectRoot: string; baseHead: string }> { const root = path.resolve(await git(["rev-parse", "--show-toplevel"], projectRoot)); return { projectRoot: root, baseHead: await git(["rev-parse", "HEAD"], root) }; }
export async function ensureWorktree(projectRoot: string, baseHead: string, intentId: string): Promise<{ projectRoot: string; worktreePath: string; baseHead: string }> {
  const root = path.resolve(projectRoot);
  const safe = intentId.replace(/[^a-zA-Z0-9_-]/g, "");
  const worktreePath = path.join(root, ".captain-sdlc", "worktrees", safe);
  await rejectReparseAncestors(root, path.dirname(worktreePath));
  try { await lstat(worktreePath); throw new Error(`canonical worktree path already exists: ${worktreePath}`); } catch (error: any) { if (error.code !== "ENOENT") throw error; }
  await git(["worktree", "add", worktreePath, "-b", `captain/${safe}`, baseHead], root);
  return { projectRoot: root, worktreePath, baseHead };
}
export async function commitEvidence(worktree: string, baseHead: string) {
  const head = await git(["rev-parse", "HEAD"], worktree), tree = await git(["rev-parse", "HEAD^{tree}"], worktree), count = Number(await git(["rev-list", "--count", `${baseHead}..HEAD`], worktree));
  const status = await git(["status", "--porcelain"], worktree), subject = await git(["show", "-s", "--format=%s", "HEAD"], worktree);
  const changed = (await git(["diff", "--name-only", `${baseHead}..HEAD`], worktree)).split(/\r?\n/);
  const hashes = (await git(["rev-list", "--reverse", `${baseHead}..HEAD`], worktree)).split(/\r?\n/).filter(Boolean); let phaseCommitsValid = true;
  for (const hash of hashes) { const phaseSubject = await git(["show", "-s", "--format=%s", hash], worktree), phaseChanged = (await git(["diff-tree", "--no-commit-id", "--name-only", "-r", hash], worktree)).split(/\r?\n/); if (!/^(feat|fix|refactor|perf|test|docs|build|ci|chore)(\([^)]+\))?!?: .+ \(v\d+\.\d+\.\d+\)$/.test(phaseSubject) || !phaseChanged.includes("VERSION") || !phaseChanged.includes("CHANGELOG.md")) phaseCommitsValid = false; }
  return { head, tree, commitCount: count, clean: status === "", subject, versionChanged: changed.includes("VERSION"), changelogChanged: changed.includes("CHANGELOG.md"), phaseCommitsValid };
}
export async function commitAtomic(worktree: string, paths: string[], subject: string) { if (!paths.length || paths.some(value => path.isAbsolute(value) || value.startsWith("..") || !/^[A-Za-z0-9._/-]+$/.test(value))) throw new Error("commit paths must be explicit safe repository-relative paths"); if (!/^(feat|fix|refactor|perf|test|docs|build|ci|chore)(\([^)]+\))?!?: .+ \(v\d+\.\d+\.\d+\)$/.test(subject)) throw new Error("commit subject must be Conventional Commit with SemVer suffix"); await git(["add", "--", ...paths], worktree); await exec("git", ["commit", "-m", subject], { cwd: worktree }); }
export async function sourceState(worktree: string) { return { head: await git(["rev-parse", "HEAD"], worktree), tree: await git(["rev-parse", "HEAD^{tree}"], worktree), status: await git(["status", "--porcelain"], worktree), manifest: await sourceManifest(worktree) }; }
async function rejectReparseAncestors(root: string, target: string) { for (let cursor = path.resolve(target); cursor.startsWith(path.resolve(root)); cursor = path.dirname(cursor)) { try { if ((await lstat(cursor)).isSymbolicLink()) throw new Error(`canonical worktree container crosses a reparse point: ${cursor}`); } catch (error: any) { if (error.code !== "ENOENT") throw error; } if (cursor === path.resolve(root)) break; } }
async function sourceManifest(root: string): Promise<string> { const lines: string[] = []; async function walk(dir: string) { for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a,b) => a.name.localeCompare(b.name))) { const relative = path.relative(root, path.join(dir, entry.name)).replaceAll("\\", "/"); if (relative === ".git" || relative.startsWith(".captain-sdlc/trace/") || relative.startsWith(".captain-proof/") || relative === "node_modules" || relative.includes("/node_modules/") || relative === "dist" || relative.includes("/dist/")) continue; const full = path.join(dir, entry.name); const info = await lstat(full); if (info.isSymbolicLink()) throw new Error(`source manifest crosses reparse point: ${relative}`); if (info.isDirectory()) await walk(full); else if (info.isFile()) lines.push(`${relative}:${createHash("sha256").update(await readFile(full)).digest("hex")}`); } } await walk(root); return createHash("sha256").update(lines.join("\n")).digest("hex"); }
