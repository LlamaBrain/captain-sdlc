import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { putAuthorizedOnceExact, readAuthorized, writeAuthorized } from "./authority.js";
import type { ProjectPolicy } from "./lifecycle.js";
import { captureOutputRetention, prepareScopeOutputs, validateScopeOutputs } from "./output-retention.js";
import { finishOrdinaryActivity, markOrdinaryActive, readOrdinaryActivity } from "./storage-activity.js";
import { cleanupRegisteredWorktrees } from "./worktree-cleanup.js";
import { readWorktreeRegistration, storageRegistrationId, type WorktreeRegistration } from "./worktree-storage.js";
import { assertWorktreeBinding, ensureWorktree, git, primaryRepositoryRoot, repositoryIdentity } from "./workspace.js";

type Arguments = { command: "create" | "resume" | "prepare-output" | "cleanup"; values: Record<string, string>; evidence: string[] };
type OrdinaryCompletion = {
  schema_version: 1; registration_id: string; worktree_path: string; branch: string; git_dir: string;
  head: string; evidence_paths: string[];
};
const samePath = (a: string, b: string) => process.platform === "win32" ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b);
const usage = "worktree-storage create --project <checkout> --task <id> [--base <commit>] | resume --worktree <registered-checkout> | prepare-output --worktree <checkout> [--root artifacts/active] [--detached-head <full-oid>] | cleanup --source <completed-worktree> --target <retained-checkout> [--evidence <relative-report>]";

function parse(argv: string[]): Arguments {
  const command = argv[0];
  if (command !== "create" && command !== "resume" && command !== "prepare-output" && command !== "cleanup") throw new Error(usage);
  const allowed = command === "create" ? new Set(["project", "task", "base"]) : command === "resume" ? new Set(["worktree"]) : command === "prepare-output" ? new Set(["worktree", "root", "detached-head"]) : new Set(["source", "target", "evidence"]);
  const values: Record<string, string> = {}, evidence: string[] = [];
  for (let index = 1; index < argv.length; index += 2) {
    const key = argv[index].startsWith("--") ? argv[index].slice(2) : "", value = argv[index + 1];
    if (!allowed.has(key) || !value || value.startsWith("--") || value.includes("\0")) throw new Error(`Invalid storage argument ${argv[index] ?? ""}; ${usage}`);
    if (key === "evidence") { if (evidence.length >= 32) throw new Error("Too many evidence paths"); evidence.push(value); }
    else { if (values[key] !== undefined) throw new Error(`Duplicate storage option --${key}`); values[key] = value; }
  }
  const required = command === "create" ? ["project", "task"] : command === "prepare-output" || command === "resume" ? ["worktree"] : ["source", "target"];
  for (const key of required) if (!values[key]) throw new Error(`Missing storage option --${key}; ${usage}`);
  return { command, values, evidence };
}

async function ignored(cwd: string, relative: string) {
  try { await git(["check-ignore", "--no-index", "--quiet", "--", relative], cwd); }
  catch (error: any) { if (error.code !== 1) throw error; throw new Error(`Captain local storage must be Git-ignored: /${relative}`); }
}

/** Detached release previews receive output ownership only, never task/cleanup registration. */
async function pinnedDetachedBinding(invocation: string, expectedHead: string, expected?: { topLevel: string; commonGitDir: string; gitDir: string }) {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(expectedHead)) throw new Error("Detached output preparation requires an exact full HEAD OID pin");
  const topLevel = path.resolve(invocation);
  if (!samePath(topLevel, await realpath(topLevel))) throw new Error("Detached output worktree crosses a reparse point");
  const identity = await repositoryIdentity(topLevel);
  if (!samePath(topLevel, identity.projectRoot)) throw new Error("Detached output Git top-level differs from the requested worktree");
  let branch: string | undefined;
  try { branch = await git(["symbolic-ref", "--quiet", "--short", "HEAD"], topLevel); }
  catch (error: any) { if (error.code !== 1) throw error; }
  if (branch) throw new Error("--detached-head is valid only for an actual detached worktree");
  const commonGitDir = identity.commonGitDir, gitDir = path.resolve(await git(["rev-parse", "--path-format=absolute", "--git-dir"], topLevel));
  if (!samePath(gitDir, await realpath(gitDir)) || !samePath(commonGitDir, await realpath(commonGitDir))) throw new Error("Detached output Git directories must be canonical");
  const head = await git(["rev-parse", "--verify", "HEAD^{commit}"], topLevel);
  if (head.toLowerCase() !== expectedHead.toLowerCase() || identity.baseHead.toLowerCase() !== expectedHead.toLowerCase()) throw new Error("Detached output HEAD diverged from its exact revision pin");
  if (expected && (!samePath(topLevel, expected.topLevel) || !samePath(commonGitDir, expected.commonGitDir) || !samePath(gitDir, expected.gitDir)))
    throw new Error("Detached output worktree identity changed during preparation");
  return { topLevel, commonGitDir, gitDir, head, branch: "" };
}

async function context(invocation: string, detachedHead?: string, requestedOutput?: string) {
  const binding = detachedHead ? await pinnedDetachedBinding(invocation, detachedHead) : await assertWorktreeBinding(path.resolve(invocation)), primary = await primaryRepositoryRoot(binding.topLevel, binding.commonGitDir);
  let enrolled = false;
  for (const checkout of new Set([binding.topLevel, primary])) {
    if (await git(["ls-tree", "HEAD", "--", ".captain-sdlc/codex-policy.json"], checkout)) enrolled = true;
  }
  if (enrolled) {
    if (!detachedHead || !requestedOutput) throw new Error("This repository is enrolled in Captain; use its MCP Begin/Prep/Back workflow and captured storage policy");
    if (!await git(["ls-tree", binding.head, "--", ".captain-sdlc/codex-policy.json"], binding.topLevel))
      throw new Error("Enrolled detached preview must declare its captured build output root");
    const text = await git(["show", `${binding.head}:.captain-sdlc/codex-policy.json`], binding.topLevel);
    if (Buffer.byteLength(text, "utf8") > 1024 * 1024) throw new Error("Committed preview output policy is too large");
    let raw: any; try { raw = JSON.parse(text); } catch { throw new Error("Committed preview output policy is invalid JSON"); }
    const retention = await captureOutputRetention(binding.topLevel, binding.head, raw?.outputRetention);
    if (!(retention.roots.build ?? []).some(root => samePath(path.resolve(binding.topLevel, root), path.resolve(binding.topLevel, requestedOutput))))
      throw new Error("Enrolled detached output root must be declared in committed outputRetention.roots.build");
  }
  const dataRoot = path.join(primary, ".captain-sdlc", "storage-authority");
  for (const relative of [".captain-sdlc", ".captain-sdlc/storage-authority"]) {
    try { const info = await lstat(path.join(primary, relative)); if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("Captain storage authority crosses a reparse point or non-directory"); }
    catch (error: any) { if (error.code !== "ENOENT") throw error; }
  }
  if (await git(["ls-files", "-z", "--", ".captain-sdlc/storage-authority"], primary)) throw new Error("Captain storage authority contains tracked source files");
  await ignored(primary, ".captain-sdlc/storage-authority/");
  return { binding, primary, dataRoot };
}

async function optionalCompletion(dataRoot: string, registration: WorktreeRegistration): Promise<OrdinaryCompletion | undefined> {
  const id = storageRegistrationId(registration.common_git_dir, registration.worktree_path);
  let value: OrdinaryCompletion;
  try { value = await readAuthorized<OrdinaryCompletion>(dataRoot, "ordinary-worktree-completions", id); }
  catch (error: any) { if (error.code === "ENOENT") return undefined; throw error; }
  if (value.schema_version !== 1 || value.registration_id !== id || !samePath(value.worktree_path, registration.worktree_path) ||
      value.branch !== registration.branch || !samePath(value.git_dir, registration.git_dir) || !/^[0-9a-f]{40,64}$/i.test(value.head) ||
      !Array.isArray(value.evidence_paths) || value.evidence_paths.some(item => typeof item !== "string")) throw new Error("Ordinary terminal completion binding is invalid");
  return value;
}

async function assertIntegrated(cwd: string, sourceHead: string, targetHead: string) {
  try { await git(["merge-base", "--is-ancestor", sourceHead, targetHead], cwd); }
  catch (error: any) { if (error.code !== 1) throw error; throw new Error("Worktree source has unmerged commits; complete integration before cleanup"); }
}

/** Ordinary repositories use the same registered-worktree deletion safeguards as MCP Back. */
export async function runStorageCommand(argv: string[]): Promise<Record<string, unknown>> {
  if (argv.length === 1 && argv[0] === "--help") return { schema_version: 1, usage };
  const args = parse(argv), values = args.values;
  if (args.command === "create") {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(values.task)) throw new Error("Task id must contain 1-100 letters, digits, underscores or hyphens");
    const current = await context(values.project), identity = await repositoryIdentity(current.binding.topLevel);
    await ignored(current.primary, `.captain-sdlc/worktrees/${values.task}/`);
    const base = values.base ? await git(["rev-parse", "--verify", "--end-of-options", `${values.base}^{commit}`], current.binding.topLevel) : identity.baseHead;
    const created = await ensureWorktree(current.binding.topLevel, base, values.task, undefined, current.binding.commonGitDir, current.dataRoot, current.binding.topLevel);
    const registration = await readWorktreeRegistration(current.dataRoot, created.commonGitDir, created.worktreePath);
    if (!registration) throw new Error("Existing worktree has no forward storage registration; resume it through its original workflow");
    await markOrdinaryActive(current.dataRoot, registration);
    return { schema_version: 1, command: "create", project_root: current.primary, worktree_path: created.worktreePath, branch: created.branch, base_head: created.baseHead, storage_authority: current.dataRoot };
  }
  if (args.command === "resume") {
    const current = await context(values.worktree), registration = await readWorktreeRegistration(current.dataRoot, current.binding.commonGitDir, current.binding.topLevel);
    if (!registration) throw new Error("Resume requires a new-worktree storage registration; legacy checkouts retain their original workflow");
    await assertWorktreeBinding(current.binding.topLevel, registration.branch, registration.common_git_dir, undefined, false, registration.git_dir);
    await markOrdinaryActive(current.dataRoot, registration);
    return { schema_version: 1, command: "resume", worktree_path: current.binding.topLevel, activity: "active" };
  }
  if (args.command === "prepare-output") {
    const detachedHead = values["detached-head"], relative = values.root ?? "artifacts/active", current = await context(values.worktree, detachedHead, relative);
    await ignored(current.binding.topLevel, relative.replaceAll("\\", "/").replace(/\/$/, "") + "/");
    const id = storageRegistrationId(current.binding.commonGitDir, current.binding.topLevel);
    const slot = { schema_version: 1, worktree_path: current.binding.topLevel, roots: { build: [relative] },
      ...(detachedHead ? { detached: true, common_git_dir: current.binding.commonGitDir, git_dir: current.binding.gitDir } : {}) };
    const policy: Pick<ProjectPolicy, "outputRetention"> = { outputRetention: { schema_version: 1, roots: { build: [relative] } } };
    await validateScopeOutputs(current.binding.topLevel, policy, "build");
    const registration = await readWorktreeRegistration(current.dataRoot, current.binding.commonGitDir, current.binding.topLevel);
    if (detachedHead) {
      if (registration) throw new Error("Detached output preparation cannot adopt a registered task; resume its original workflow");
      const normalized = relative.replaceAll("\\", "/").replace(/\/$/, "");
      const tracked = (await git(["ls-files", "-z"], current.binding.topLevel)).split("\0").filter(Boolean);
      if (tracked.some(file => file === normalized || file.startsWith(normalized + "/") || normalized.startsWith(file + "/")))
        throw new Error("Detached output root overlaps tracked source");
      await pinnedDetachedBinding(current.binding.topLevel, detachedHead, current.binding);
    } else if (registration) {
      await assertWorktreeBinding(current.binding.topLevel, registration.branch, registration.common_git_dir, undefined, false, registration.git_dir);
      await markOrdinaryActive(current.dataRoot, registration);
    }
    // A worktree retains one chosen slot. A later attempt cannot quietly allocate a new folder.
    await putAuthorizedOnceExact(current.dataRoot, "ordinary-output-slots", id, slot);
    if (detachedHead) await pinnedDetachedBinding(current.binding.topLevel, detachedHead, current.binding);
    await prepareScopeOutputs(current.binding.topLevel, policy, "build");
    if (detachedHead) await pinnedDetachedBinding(current.binding.topLevel, detachedHead, current.binding);
    return { schema_version: 1, command: "prepare-output", worktree_path: current.binding.topLevel, build_output_path: path.resolve(current.binding.topLevel, relative), ...(detachedHead ? { detached_head: current.binding.head } : {}) };
  }
  const target = await context(values.target), source = path.resolve(values.source);
  if (samePath(source, target.binding.topLevel) || samePath(source, target.primary)) throw new Error("Cleanup requires a distinct registered source; the primary checkout is retained");
  const registration = await readWorktreeRegistration(target.dataRoot, target.binding.commonGitDir, source);
  if (!registration) throw new Error("Source has no new-worktree creation registration; legacy worktrees are excluded from automatic cleanup");
  const previous = await optionalCompletion(target.dataRoot, registration);
  let head: string, sourcePresent = true;
  try {
    head = (await assertWorktreeBinding(source, registration.branch, registration.common_git_dir, undefined, false, registration.git_dir)).head;
    if (await git(["ls-tree", head, "--", ".captain-sdlc/codex-policy.json"], source))
      throw new Error("The source is enrolled in Captain; use its MCP ownership and Merge Back cleanup workflow");
  }
  catch (error: any) { if (error.code !== "ENOENT" || !previous) throw error; head = previous.head; sourcePresent = false; }
  await assertIntegrated(target.binding.topLevel, head, target.binding.head);
  if (sourcePresent) await finishOrdinaryActivity(target.dataRoot, registration);
  else if (await readOrdinaryActivity(target.dataRoot, registration) !== "inactive") throw new Error("Missing source still has an active storage reservation; recover its original ownership");
  const evidencePaths = args.evidence.length ? args.evidence : previous?.head === head ? previous.evidence_paths : [];
  const completion: OrdinaryCompletion = { schema_version: 1, registration_id: storageRegistrationId(registration.common_git_dir, source), worktree_path: source, branch: registration.branch, git_dir: registration.git_dir, head, evidence_paths: evidencePaths };
  await writeAuthorized(target.dataRoot, "ordinary-worktree-completions", completion.registration_id, completion);
  const candidates = [{ registration, head, evidencePaths }], retainedParents: Array<{ worktree: string; reason: string }> = [], seen = new Set([completion.registration_id]);
  let parent = registration.parent_worktree;
  while (parent) {
    if (seen.has(parent.registration_id)) throw new Error("Registered worktree chain is cyclic"); seen.add(parent.registration_id);
    const registered = await readWorktreeRegistration(target.dataRoot, registration.common_git_dir, parent.worktree_path);
    if (!registered || storageRegistrationId(registered.common_git_dir, registered.worktree_path) !== parent.registration_id || registered.branch !== parent.branch || !samePath(registered.git_dir, parent.git_dir)) throw new Error("Registered parent worktree identity changed");
    const terminal = await optionalCompletion(target.dataRoot, registered);
    if (await readOrdinaryActivity(target.dataRoot, registered) !== "inactive") { retainedParents.push({ worktree: parent.worktree_path, reason: "Predecessor is active or reserved by another storage operation" }); break; }
    if (!terminal || terminal.head !== parent.head) { retainedParents.push({ worktree: parent.worktree_path, reason: "Predecessor has no terminal completion at the recorded chain revision" }); break; }
    await assertIntegrated(target.binding.topLevel, terminal.head, target.binding.head);
    candidates.push({ registration: registered, head: terminal.head, evidencePaths: terminal.evidence_paths }); parent = registered.parent_worktree;
  }
  const cleaned = await cleanupRegisteredWorktrees(target.dataRoot, target.binding.topLevel, candidates);
  return { schema_version: 1, command: "cleanup", ...cleaned, retained_worktrees: [...cleaned.retained_worktrees, ...retainedParents] };
}
