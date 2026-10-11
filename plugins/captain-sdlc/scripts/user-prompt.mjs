#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { classifyImplementationIntent, extractAuthorizedTargetBranch, extractCaptainPlanTask, extractCaptainResumeIntent } from "../dist/intent.js";
import { putAuthorizedOnceExact, readAuthorized, writeAuthorized } from "../dist/authority.js";
import { recordUserAuthorizations, userAuthorizationStatus } from "../dist/user-authorization.js";
import { recordUserRequest, userRequestStatus } from "../dist/user-request.js";
import { recordUserRequestSource } from "../dist/user-request-source.js";
import { git } from "../dist/workspace.js";
import { activeRunForSession, latestRun } from "./authoritative-state.mjs";
import { hooksEnabled } from "./hook-control.mjs";
import { repositoryIsGoverned, repositoryUsesLowStrictness } from "./governed-repository.mjs";

let raw = ""; for await (const chunk of process.stdin) raw += chunk;
const input = JSON.parse(raw || "{}"), prompt = input.prompt || input.user_prompt || "";
const plannedTaskId = extractCaptainPlanTask(prompt), explicitResumeOf = extractCaptainResumeIntent(prompt);
const promptRoot = path.resolve(input.cwd || process.cwd());
const data = process.env.PLUGIN_DATA || process.env.CAPTAIN_PLUGIN_DATA;
if (!data) throw new Error("PLUGIN_DATA is required");
if (!await hooksEnabled(data)) process.exit(0);

let requestSource;
async function captureSourceRecord(projectRoot) {
  requestSource = await recordUserRequestSource(data, { projectRoot, sessionId: input.session_id, turnId: input.turn_id,
    prompt, source: "UserPromptSubmit",
    ...(input.request_kind === "goal" || input.request_kind === "instruction" ? { requestKind: input.request_kind } : {}) });
  return requestSource;
}
const pathKey = value => process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
const outsideGit = error => error?.code === 128 && /not a git repository/i.test(error.stderr || "");
async function repositoryContext(root) {
  // A hook can also run outside a checkout. Such a prompt has no repository-bound
  // task evidence; do not confuse an absent cwd with a missing Git executable.
  try { await stat(root); } catch (error) { if (error?.code === "ENOENT") return undefined; throw error; }
  try {
    const commonGitDir = path.resolve(await git(["rev-parse", "--path-format=absolute", "--git-common-dir"], root));
    const worktrees = (await git(["worktree", "list", "--porcelain", "-z"], root)).split("\0");
    const primary = worktrees.find(line => line.startsWith("worktree "));
    if (!primary) throw new Error("Captain repository has no registered primary worktree");
    return { commonGitDir, projectRoot: path.resolve(primary.slice("worktree ".length)) };
  } catch (error) { if (outsideGit(error)) return undefined; throw error; }
}
async function validateRepositoryBinding(binding) {
  const current = await repositoryContext(promptRoot), expected = await repositoryContext(binding.projectRoot);
  if (current && expected && pathKey(current.commonGitDir) === pathKey(expected.commonGitDir)) return;
  if (!current && !expected && [binding.projectRoot, binding.worktreePath].filter(Boolean).some(root => pathKey(root) === pathKey(promptRoot))) return;
  throw new Error("Captain task repository binding does not match the current prompt checkout");
}
async function historicalRequestBinding(binding) {
  if (!binding) return binding;
  const status = await userRequestStatus(data, { projectRoot: binding.projectRoot, intentId: binding.intentId });
  const prior = status.receipts.find(receipt => receipt.source === "UserPromptSubmit"
    && receipt.sourceIntentId === binding.sourceIntentId && receipt.sessionId === input.session_id && receipt.turnId === input.turn_id);
  if (prior) return { ...binding, taskId: prior.taskId, targetBranch: prior.targetBranch };
  let sourceIntent;
  try { sourceIntent = await readAuthorized(data, "intents", binding.sourceIntentId); }
  catch (error) { if (error?.code !== "ENOENT") throw error; return binding; }
  if (sourceIntent.sessionId !== input.session_id || sourceIntent.turnId !== input.turn_id) return binding;
  const historical = sourceIntent.requestBinding || sourceIntent;
  if (sourceIntent.requestBinding && historical.intentId !== binding.intentId)
    throw new Error("Captain source request binding does not match its original canonical task");
  return { ...binding, taskId: historical.taskId, targetBranch: historical.targetBranch };
}
async function captureUserContext(binding, captureSource = true) {
  const projectRoot = binding?.projectRoot || promptRoot, contexts = [];
  const repository = await repositoryContext(projectRoot);
  if (!repository) return "";
  binding = await historicalRequestBinding(binding);
  if (captureSource) {
    const source = requestSource || await captureSourceRecord(projectRoot);
    contexts.push("CAPTAIN USER REQUEST SOURCE: " + JSON.stringify({
      source_request_id: source.id, session_id: source.sessionId, turn_id: source.turnId,
      originalText: source.originalText, ...(source.requestKind ? { request_kind: source.requestKind } : {}),
    }) + "\nUse these exact source selectors when issuing this request; source evidence alone creates no task, scope, or operation grant.");
  }
  const intentId = binding?.intentId;
  await recordUserAuthorizations(data, { projectRoot, sessionId: input.session_id, turnId: input.turn_id,
    prompt, intentId, taskId: binding?.taskId || plannedTaskId, source: "UserPromptSubmit" });
  const approval = await userAuthorizationStatus(data, { projectRoot, sessionId: input.session_id, intentId });
  if (approval.receipts.length) contexts.push("CAPTAIN USER AUTHORIZATION: " + JSON.stringify(approval)
    + "\nUse these original user statements for the same task; do not ask for the same approval again.");
  if (binding) {
    await recordUserRequest(data, { projectRoot, sessionId: input.session_id, turnId: input.turn_id, prompt,
      source: "UserPromptSubmit", sourceIntentId: binding.sourceIntentId, intentId,
      ...(requestSource ? { sourceRecordedAt: requestSource.recordedAt } : {}),
      ...(binding.taskId ? { taskId: binding.taskId } : {}),
      ...(binding.targetBranch ? { targetBranch: binding.targetBranch } : {}),
      ...(input.request_kind === "goal" || input.request_kind === "instruction" ? { requestKind: input.request_kind } : {}) });
    const request = await userRequestStatus(data, { projectRoot, intentId, sessionId: input.session_id });
    contexts.push("CAPTAIN USER REQUEST: " + JSON.stringify(request)
      + "\nRetain this original task context through supported preparation and recovery. Request evidence does not establish stopped ownership, HITL acceptance, or authority for another operation or target.");
  }
  return contexts.join("\n");
}
function emitContext(context) {
  if (context) process.stdout.write(JSON.stringify({ hookSpecificOutput: {
    hookEventName: "UserPromptSubmit", additionalContext: context,
  } }));
}

const activeRun = await activeRunForSession(data, input.session_id);
if (activeRun && explicitResumeOf) throw new Error("Captain resume directive conflicts with the active run in this session");
if (plannedTaskId && explicitResumeOf) throw new Error("Captain plan and resume directives cannot be combined");
if (activeRun) await validateRepositoryBinding(activeRun);

let resumedRun;
if (explicitResumeOf) {
  resumedRun = await latestRun(data, explicitResumeOf);
  if (resumedRun.status === "green") throw new Error("Captain resume directive names a completed run");
  await validateRepositoryBinding(resumedRun);

}

const pending = [];
try {
  for (const entry of await readdir(path.join(data, "begin-operations"))) {
    if (!entry.endsWith(".json")) continue;
    const operation = await readAuthorized(data, "begin-operations", entry.slice(0, -5));
    if (operation.sessionId !== input.session_id) continue;
    try { await readAuthorized(data, "begin-activated", operation.operationToken); }
    catch (error) { if (error?.code !== "ENOENT") throw error; pending.push(operation); }
  }
} catch (error) { if (error?.code !== "ENOENT") throw error; }
if (pending.length > 1) throw new Error("multiple incomplete Captain begin operations exist for this session");
const pendingBegin = pending[0];
if (pendingBegin) await validateRepositoryBinding(pendingBegin);

const unvalidatedForeignResume = resumedRun && resumedRun.status !== "paused" && resumedRun.sessionId !== input.session_id;
const boundRun = activeRun || (unvalidatedForeignResume ? undefined : resumedRun) || pendingBegin;
const existingBinding = boundRun ? {
  projectRoot: boundRun.projectRoot, intentId: boundRun.intentId, sourceIntentId: boundRun.intentId,
  taskId: boundRun.taskId, targetBranch: boundRun.targetBranch,
} : undefined;
const lowStrictness = await repositoryUsesLowStrictness(promptRoot);
const governed = activeRun || resumedRun || pendingBegin ? true : await repositoryIsGoverned(promptRoot);
if (lowStrictness || governed) {
  const sourceRoot = (activeRun || resumedRun || pendingBegin)?.projectRoot || (await repositoryContext(promptRoot))?.projectRoot;
  if (sourceRoot && await repositoryContext(sourceRoot)) await captureSourceRecord(sourceRoot);
}
if (lowStrictness) {
  await writeAuthorized(data, "turns", input.session_id + "-" + input.turn_id, {
    implementationRequired: Boolean(classifyImplementationIntent(prompt)), lowStrictness: true, projectRoot: promptRoot,
  });
  emitContext(await captureUserContext(existingBinding));
  process.exit(0);
}

const implementationRequired = governed && (classifyImplementationIntent(prompt) || Boolean(activeRun) || Boolean(pendingBegin));
await writeAuthorized(data, "turns", input.session_id + "-" + input.turn_id, { implementationRequired });
if (!implementationRequired) { emitContext(await captureUserContext(undefined, governed)); process.exit(0); }
if (pendingBegin) {
  await writeAuthorized(data, "begin-turn-resumes", pendingBegin.operationToken, {
    schemaVersion: 1, operationToken: pendingBegin.operationToken, intentId: pendingBegin.intentId,
    sessionId: input.session_id, turnId: input.turn_id,
  });
  const context = await captureUserContext(existingBinding);
  const task = pendingBegin.taskId ? " and task_id=" + pendingBegin.taskId : "";
  emitContext("CAPTAIN SDLC ENFORCEMENT: Retry the incomplete signed begin by calling captain_begin_implementation with intent_id="
    + pendingBegin.intentId + ", objective=" + JSON.stringify(pendingBegin.objective) + ", project_root="
    + pendingBegin.projectRoot + task + ". Do not mint or use a competing intent. Work only in the returned worktree. Follow red → implement → versioned atomic commit → scoped proof. Do not claim completion unless captain_status is green.\n" + context);
  process.exit(0);
}

const sourceUuid = requestSource?.id.slice(0, 32);
const intentId = "intent-" + (sourceUuid
  ? [sourceUuid.slice(0, 8), sourceUuid.slice(8, 12), sourceUuid.slice(12, 16), sourceUuid.slice(16, 20), sourceUuid.slice(20, 32)].join("-")
  : randomUUID());
async function replayIssuedIntent(record) {
  if (!requestSource || record.sourceRequestId !== requestSource.id || record.sessionId !== input.session_id ||
      record.turnId !== input.turn_id || record.prompt !== prompt || pathKey(record.projectRoot) !== pathKey(projectRoot))
    throw new Error("Captain hook source replay does not match its original signed intent");
  const canonical = record.resumeOf || record.intentId;
  if (activeRun && activeRun.intentId !== canonical)
    throw new Error("Captain source replay conflicts with another active task binding");
  const context = await captureUserContext(unvalidatedForeignResume ? undefined : {
    projectRoot: record.projectRoot, intentId: canonical, sourceIntentId: record.intentId,
    taskId: record.requestBinding?.taskId ?? record.taskId, targetBranch: record.requestBinding?.targetBranch ?? record.targetBranch,
  });
  const instruction = record.consumed
    ? "This source event already issued intent_id=" + record.intentId + ". Read captain_status for " + canonical
      + " and continue the existing owned task; do not mint or consume a competing intent."
    : record.resumeOf
      ? "Resume Captain run " + record.resumeOf + " by calling captain_resume_implementation with resume_intent_id=" + record.intentId + " before mutation."
      : "Before mutation, call captain_begin_implementation with intent_id=" + record.intentId + ", the original objective, project_root=" + record.projectRoot
        + (record.taskId ? ", and task_id=" + record.taskId : "") + ".";
  emitContext("CAPTAIN SDLC ENFORCEMENT: " + instruction + " Work only in the returned worktree.\n" + context);
}
const requestedProfile = /\b(pre[- ]?release|release candidate|ship (?:the )?release)\b/i.test(prompt) ? "pre-release" : "feature";
const requestedTargetBranch = activeRun || explicitResumeOf ? undefined : extractAuthorizedTargetBranch(prompt);
const repository = await repositoryContext(promptRoot);
let projectRoot = activeRun || resumedRun || pendingBegin ? path.resolve((activeRun || resumedRun || pendingBegin).projectRoot) : repository?.projectRoot || promptRoot;
let targetBranch, targetOid;
let issued;
try { issued = await readAuthorized(data, "intents", intentId); }
catch (error) { if (error?.code !== "ENOENT") throw error; }
if (issued) { await replayIssuedIntent(issued); process.exit(0); }
if (requestedTargetBranch) {
  await git(["check-ref-format", "--branch", requestedTargetBranch], projectRoot);
  const requestedRef = "refs/heads/" + requestedTargetBranch;
  const matches = (await git(["for-each-ref", "--format=%(refname)", "refs/heads"], projectRoot))
    .split(/\r?\n/).filter(ref => ref.toLowerCase() === requestedRef.toLowerCase());
  if (matches.length !== 1) throw new Error("Captain target branch did not resolve to exactly one canonical local ref");
  targetBranch = matches[0].slice("refs/heads/".length);
  targetOid = await git(["rev-parse", "--verify", matches[0] + "^{commit}"], projectRoot);
  if (!/^[0-9a-f]{40,64}$/i.test(targetOid)) throw new Error("Captain target branch did not resolve to a full commit oid");
}
const resumeOf = activeRun?.intentId || explicitResumeOf;
const requestBinding = {
  intentId: resumeOf || intentId,
  ...(boundRun?.taskId || plannedTaskId ? { taskId: boundRun?.taskId || plannedTaskId } : {}),
  ...(boundRun?.targetBranch || targetBranch ? { targetBranch: boundRun?.targetBranch || targetBranch } : {}),
};
const record = { intentId, sessionId: input.session_id, turnId: input.turn_id, projectRoot, prompt, requestedProfile,
  ...(requestSource ? { sourceRequestId: requestSource.id, issuedAt: requestSource.recordedAt, requestBinding } : {}),
  ...(plannedTaskId ? { taskId: plannedTaskId } : {}), ...(targetBranch ? { targetBranch, targetOid } : {}),
  ...(resumeOf ? { resumeOf } : {}) };
try { await putAuthorizedOnceExact(data, "intents", intentId, record); }
catch (error) {
  let prior;
  try { prior = await readAuthorized(data, "intents", intentId); } catch { throw error; }
  await replayIssuedIntent(prior); process.exit(0);
}
const context = await captureUserContext(unvalidatedForeignResume ? undefined : {
  projectRoot, intentId: resumeOf || intentId, sourceIntentId: intentId,
  taskId: boundRun?.taskId || plannedTaskId, targetBranch: boundRun?.targetBranch || targetBranch,
});
const ownershipContext = unvalidatedForeignResume
  ? "\nThe prior run has another active session. This token does not adopt its owner or inherit canonical task consent; establish supported continuity through Captain before resuming." : "";
const instruction = resumeOf
  ? "Resume Captain run " + resumeOf + " by calling captain_resume_implementation with resume_intent_id=" + intentId
    + " before mutation." + (resumedRun ? " Its canonical worktree is " + resumedRun.worktreePath + "." : "")
  : "Before mutation, call captain_begin_implementation with intent_id=" + intentId
    + ", the user's objective, project_root=" + record.projectRoot + ", and task_id=" + plannedTaskId + ". "
    + (targetBranch ? "The signed target is " + targetBranch + " at " + targetOid + ". " : "")
    + "The trusted repository policy owns feature/pre-release and visual requirements.";
emitContext("CAPTAIN SDLC ENFORCEMENT: " + instruction
  + " Work only in the returned worktree. Follow red → implement → versioned atomic commit → scoped proof. Do not claim completion unless captain_status is green.\n" + context + ownershipContext);
