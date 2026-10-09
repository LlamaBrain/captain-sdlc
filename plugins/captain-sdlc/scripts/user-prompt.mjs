#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { classifyImplementationIntent, extractAuthorizedTargetBranch, extractCaptainPlanTask, extractCaptainResumeIntent } from "../dist/intent.js";
import { readAuthorized, writeAuthorized } from "../dist/authority.js";
import { recordUserAuthorizations, userAuthorizationStatus } from "../dist/user-authorization.js";
import { activeRunForSession, latestRun } from "./authoritative-state.mjs";
import { hooksEnabled } from "./hook-control.mjs";
import { repositoryIsGoverned, repositoryUsesLowStrictness } from "./governed-repository.mjs";
let raw = ""; for await (const chunk of process.stdin) raw += chunk;
const input = JSON.parse(raw || "{}"), prompt = input.prompt || input.user_prompt || "", plannedTaskId = extractCaptainPlanTask(prompt), explicitResumeOf = extractCaptainResumeIntent(prompt);
const data = process.env.PLUGIN_DATA || process.env.CAPTAIN_PLUGIN_DATA; if (!data) throw new Error("PLUGIN_DATA is required");
if (!await hooksEnabled(data)) process.exit(0);
async function captureUserApproval(intentId) {
  const projectRoot = input.cwd || process.cwd();
  try {
    await recordUserAuthorizations(data, { projectRoot, sessionId: input.session_id, turnId: input.turn_id, prompt, intentId, taskId: plannedTaskId, source: "UserPromptSubmit" });
    const status = await userAuthorizationStatus(data, { projectRoot, sessionId: input.session_id, intentId });
    return status.receipts.length ? `CAPTAIN USER AUTHORIZATION: ${JSON.stringify(status)}\nUse these original user statements for the same task; do not ask for the same approval again.` : "";
  } catch (error) {
    // A prompt outside Git has no repository-bound authorization to capture.
    // Do not hide receipt tampering, broken Git installations, or other errors.
    if (error?.code === 128 && /not a git repository/i.test(error.stderr || "")) return "";
    throw error;
  }
}
function emitApprovalContext(context) { if (context) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: context } })); }
const lowStrictness = await repositoryUsesLowStrictness(input.cwd || process.cwd());
if (lowStrictness) {
  await writeAuthorized(data, "turns", `${input.session_id}-${input.turn_id}`, { implementationRequired: Boolean(classifyImplementationIntent(prompt)), lowStrictness: true, projectRoot: path.resolve(input.cwd || process.cwd()) });
  emitApprovalContext(await captureUserApproval());
  process.exit(0);
}
const activeRun = await activeRunForSession(data, input.session_id), active = activeRun ? { intentId: activeRun.intentId, operationToken: activeRun.operationToken } : null;
const approvalContext = await captureUserApproval(active?.intentId ?? explicitResumeOf);
if (active && explicitResumeOf) throw new Error("Captain resume directive conflicts with the active run in this session");
if (plannedTaskId && explicitResumeOf) throw new Error("Captain plan and resume directives cannot be combined");
const pending = []; try { for (const entry of await readdir(path.join(data, "begin-operations"))) { if (!entry.endsWith(".json")) continue; const operation = await readAuthorized(data, "begin-operations", entry.slice(0, -5)); if (operation.sessionId !== input.session_id) continue; try { await readAuthorized(data, "begin-activated", operation.operationToken); } catch (error) { if (error?.code !== "ENOENT") throw error; pending.push(operation); } } } catch (error) { if (error?.code !== "ENOENT") throw error; }
if (pending.length > 1) throw new Error("multiple incomplete Captain begin operations exist for this session");
const pendingBegin = pending[0], governed = active || pendingBegin ? true : await repositoryIsGoverned(input.cwd || process.cwd()), implementationRequired = governed && (classifyImplementationIntent(prompt) || Boolean(active) || Boolean(pendingBegin));
await writeAuthorized(data, "turns", `${input.session_id}-${input.turn_id}`, { implementationRequired });
if (!implementationRequired) { emitApprovalContext(approvalContext); process.exit(0); }
if (pendingBegin) await writeAuthorized(data, "begin-turn-resumes", pendingBegin.operationToken, { schemaVersion: 1, operationToken: pendingBegin.operationToken, intentId: pendingBegin.intentId, sessionId: input.session_id, turnId: input.turn_id });
if (pendingBegin) { const task = pendingBegin.taskId ? ` and task_id=${pendingBegin.taskId}` : ""; process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: `CAPTAIN SDLC ENFORCEMENT: Retry the incomplete signed begin by calling captain_begin_implementation with intent_id=${pendingBegin.intentId}, objective=${JSON.stringify(pendingBegin.objective)}, project_root=${pendingBegin.projectRoot}${task}. Do not mint or use a competing intent. Work only in the returned worktree. Follow red â†’ implement â†’ versioned atomic commit â†’ scoped proof. Do not claim completion unless captain_status is green.` } })); process.exit(0); }
const intentId = `intent-${randomUUID()}`;
const requestedProfile = /\b(pre[- ]?release|release candidate|ship (?:the )?release)\b/i.test(prompt) ? "pre-release" : "feature";
const exec = promisify(execFile), requestedTargetBranch = active || explicitResumeOf ? undefined : extractAuthorizedTargetBranch(prompt); let projectRoot = path.resolve(input.cwd), targetBranch, targetOid, resumedRun;
if (explicitResumeOf) { resumedRun = await latestRun(data, explicitResumeOf); if (resumedRun.status === "green") throw new Error("Captain resume directive names a completed run"); projectRoot = path.resolve(resumedRun.projectRoot); }
if (requestedTargetBranch) {
  const env = { ...process.env }; for (const name of Object.keys(env)) if (/^(?:GIT_(?:DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|QUARANTINE_PATH|SHALLOW_FILE|NAMESPACE|EXEC_PATH|CEILING_DIRECTORIES|DISCOVERY_ACROSS_FILESYSTEM|ATTR_SOURCE|CONFIG|CONFIG_GLOBAL|CONFIG_SYSTEM|CONFIG_NOSYSTEM|CONFIG_COUNT|CONFIG_PARAMETERS|EXTERNAL_DIFF|DIFF_OPTS)|GIT_CONFIG_(?:KEY|VALUE)_\d+)$/i.test(name)) delete env[name]; Object.assign(env, { GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat", GIT_NO_REPLACE_OBJECTS: "1", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null", GIT_ATTR_NOSYSTEM: "1" });
  projectRoot = path.resolve((await exec("git", ["rev-parse", "--show-toplevel"], { cwd: projectRoot, env, windowsHide: true })).stdout.trim());
  await exec("git", ["check-ref-format", "--branch", requestedTargetBranch], { cwd: projectRoot, env, windowsHide: true });
  const requestedRef = `refs/heads/${requestedTargetBranch}`, matches = (await exec("git", ["for-each-ref", "--format=%(refname)", "refs/heads"], { cwd: projectRoot, env, windowsHide: true })).stdout.split(/\r?\n/).filter(ref => ref.toLowerCase() === requestedRef.toLowerCase());
  if (matches.length !== 1) throw new Error("Captain target branch did not resolve to exactly one canonical local ref");
  targetBranch = matches[0].slice("refs/heads/".length);
  targetOid = (await exec("git", ["rev-parse", "--verify", `${matches[0]}^{commit}`], { cwd: projectRoot, env, windowsHide: true })).stdout.trim();
  if (!/^[0-9a-f]{40,64}$/i.test(targetOid)) throw new Error("Captain target branch did not resolve to a full commit oid");
}
const resumeOf = active?.intentId ?? explicitResumeOf;
const record = { intentId, sessionId: input.session_id, turnId: input.turn_id, projectRoot, prompt, requestedProfile, ...(plannedTaskId ? { taskId: plannedTaskId } : {}), ...(targetBranch ? { targetBranch, targetOid } : {}), ...(resumeOf ? { resumeOf } : {}) };
await writeAuthorized(data, "intents", intentId, record);
const instruction = resumeOf ? `Resume Captain run ${resumeOf} by calling captain_resume_implementation with resume_intent_id=${intentId} before mutation.${resumedRun ? ` Its canonical worktree is ${resumedRun.worktreePath}.` : ""}` : `Before mutation, call captain_begin_implementation with intent_id=${intentId}, the user's objective, project_root=${record.projectRoot}, and task_id=${plannedTaskId}. ${targetBranch ? `The signed target is ${targetBranch} at ${targetOid}. ` : ""}The trusted repository policy owns feature/pre-release and visual requirements.`;
process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: `CAPTAIN SDLC ENFORCEMENT: ${instruction} Work only in the returned worktree. Follow red → implement → versioned atomic commit → scoped proof. Do not claim completion unless captain_status is green.\n${approvalContext}` } }));
