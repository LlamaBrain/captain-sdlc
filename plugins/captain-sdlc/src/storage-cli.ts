import { lstat } from "node:fs/promises";
import path from "node:path";
import { putAuthorizedOnceExact, readAuthorized, writeAuthorized } from "./authority.js";
import type { ProjectPolicy } from "./lifecycle.js";
import { prepareScopeOutputs, validateScopeOutputs } from "./output-retention.js";
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
const usage = "worktree-storage create --project <checkout> --task <id> [--base <commit>] | resume --worktree <registered-checkout> | prepare-output --worktree <checkout> [--root artifacts/active] | cleanup --source <completed-worktree> --target <retained-checkout> [--evidence <relative-report>]";

function parse(argv: string[]): Arguments {
  const command = argv[0];
  if (command !== "create" && command !== "resume" && command !== "prepare-output" && command !== "cleanup") throw new Error(usage);
  const allowed = command === "create" ? new Set(["project", "task", "base"]) : command === "resume" ? new Set(["worktree"]) : command === "prepare-output" ? new Set(["worktree", "root"]) : new Set(["source", "target", "evidence"]);
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

async function context(invocation: string) {
  const binding = await assertWorktreeBinding(path.resolve(invocation)), primary = await primaryRepositoryRoot(binding.topLevel, binding.commonGitDir);
  for (const checkout of new Set([binding.topLevel, primary])) {
    if (await git(["ls-tree", "HEAD", "--", ".captain-sdlc/codex-policy.json"], checkout))
      throw new Error("This repository is enrolled in Captain; use its MCP Begin/Prep/Back workflow and captured storage policy");
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
    const current = await context(values.worktree), relative = values.root ?? "artifacts/active";
    await ignored(current.binding.topLevel, relative.replaceAll("\\", "/").replace(/\/$/, "") + "/");
    const id = storageRegistrationId(current.binding.commonGitDir, current.binding.topLevel);
    const slot = { schema_version: 1, worktree_path: current.binding.topLevel, roots: { build: [relative] } };
    const policy: Pick<ProjectPolicy, "outputRetention"> = { outputRetention: { schema_version: 1, roots: { build: [relative] } } };
    await validateScopeOutputs(current.binding.topLevel, policy, "build");
    const registration = await readWorktreeRegistration(current.dataRoot, current.binding.commonGitDir, current.binding.topLevel);
    if (registration) {
      await assertWorktreeBinding(current.binding.topLevel, registration.branch, registration.common_git_dir, undefined, false, registration.git_dir);
      await markOrdinaryActive(current.dataRoot, registration);
    }
    // A worktree retains one chosen slot. A later attempt cannot quietly allocate a new folder.
    await putAuthorizedOnceExact(current.dataRoot, "ordinary-output-slots", id, slot);
    await prepareScopeOutputs(current.binding.topLevel, policy, "build");
    return { schema_version: 1, command: "prepare-output", worktree_path: current.binding.topLevel, build_output_path: path.resolve(current.binding.topLevel, relative) };
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
