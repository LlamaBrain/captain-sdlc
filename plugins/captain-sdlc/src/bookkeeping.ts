import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CommitPolicy } from "./lifecycle.js";

export type BookkeepingPolicy = { path_file: string; patterns?: string; sha256?: string };
type Git = (args: string[], cwd: string) => Promise<string>;
const ruleFile = ".captain-sdlc/captain.ignore";
const matcherRoots = new Map<string, Promise<string>>();
const recordRoots = [".captain-sdlc/notebook/", ".captain-sdlc/handoffs/", ".captain-sdlc/closeouts/", ".captain-sdlc/evidence/"];
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

/** Raw policy declares a committed rule file; captured rules are loader-owned. */
export function validateBookkeepingPolicy(input: unknown): BookkeepingPolicy {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("bookkeeping policy must declare a committed path_file");
  const value = input as Record<string, unknown>;
  if (Object.keys(value).some(key => key !== "path_file")) throw new Error("bookkeeping captured patterns and hash cannot be supplied by repository policy");
  if (value.path_file !== ruleFile) throw new Error(`bookkeeping path_file must be ${ruleFile}`);
  return { path_file: ruleFile };
}

export function bookkeepingCaptured(policy: CommitPolicy): boolean {
  const value = policy.bookkeeping;
  return value?.path_file === ruleFile && typeof value.patterns === "string" && Buffer.byteLength(value.patterns) <= 1024 * 1024 && !value.patterns.includes("\0") && typeof value.sha256 === "string" && /^[0-9a-f]{64}$/.test(value.sha256) && hash(value.patterns) === value.sha256;
}

export function bookkeepingSubjectAllowed(subject: string): boolean {
  return /^(?:docs|chore)\(captain\): \S[^\r\n]*$/.test(subject) && !/\(v[^()]*\)$/.test(subject);
}

export function bookkeepingTextAllowed(content: string | Buffer): boolean {
  const text = Buffer.isBuffer(content) ? content.toString("utf8") : content;
  return Buffer.byteLength(text) <= 1024 * 1024 && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\ufffd]/.test(text);
}

/** Rules may narrow this ceiling, never admit product, code, or governing files. */
function safeRecordPath(relative: string, policy: CommitPolicy): boolean {
  if (!relative || !/^[A-Za-z0-9._/& -]+$/.test(relative) || relative.includes("\\") || relative.startsWith("/") || relative.split("/").some(part => !part || part === "." || part === "..")) return false;
  const lower = relative.toLowerCase(), segments = lower.split("/"), filename = segments.at(-1)!;
  const protectedPaths = [policy.version_file, ...policy.changelog_files, ...(policy.version_surfaces ?? []).map(surface => surface.path)].map(value => value.toLowerCase());
  if (protectedPaths.includes(lower) || filename === "agents.md" || segments.some(segment => /^(?:hooks?|plans?|polic(?:y|ies)|dependenc(?:y|ies))$/.test(segment)) || /(?:^|[-_.])(?:polic(?:y|ies)|dependency|lock|hooks?|plans?)(?:[-_.]|$)/.test(filename)) return false;
  if (lower.startsWith("churn/")) return lower.endsWith(".md");
  return recordRoots.some(root => lower.startsWith(root)) && /\.(?:md|txt|json|jsonl|log|csv|xml|yaml|yml)$/.test(lower);
}

async function matcherRoot(policy: CommitPolicy, git: Git): Promise<string> {
  const config = policy.bookkeeping!;
  let pending = matcherRoots.get(config.sha256!);
  if (!pending) {
    pending = (async () => {
      const root = await mkdtemp(path.join(tmpdir(), "captain-bookkeeping-rules-"));
      await git(["init", "--template="], root);
      await writeFile(path.join(root, ".gitignore"), config.patterns!, "utf8");
      await writeFile(path.join(root, "empty-excludes"), "", "utf8");
      return root;
    })();
    matcherRoots.set(config.sha256!, pending);
    pending.catch(() => { if (matcherRoots.get(config.sha256!) === pending) matcherRoots.delete(config.sha256!); });
  }
  const root = await pending;
  if (hash(await readFile(path.join(root, ".gitignore"), "utf8")) !== config.sha256) throw new Error("isolated bookkeeping matcher rules changed");
  return root;
}

/** Uses only captured captain.ignore through Git's own gitignore parser. */
export async function bookkeepingPathAllowedCore(relative: string, policy: CommitPolicy, git: Git): Promise<boolean> {
  if (!bookkeepingCaptured(policy) || !safeRecordPath(relative, policy)) return false;
  const root = await matcherRoot(policy, git);
  try { await git(["-c", `core.excludesFile=${path.join(root, "empty-excludes")}`, "check-ignore", "--no-index", "--", relative], root); return true; }
  catch (error: any) { if (Number(error.code) === 1) return false; throw error; }
}

export async function bookkeepingPathAllowed(relative: string, policy: CommitPolicy): Promise<boolean> { const { git } = await import("./workspace.js"); return bookkeepingPathAllowedCore(relative, policy, git); }
