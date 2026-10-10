import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { MergeWorkflowError, MergeWorkflowStore } from "./merge-workflow.js";
import { z } from "zod";
import { LifecycleStore, effectiveGateDisclosure, executionHead, isPendingPlanReview, type HitlCheck } from "./lifecycle.js";
import { extractAuthorizedTargetBranch, extractCaptainResumeIntent } from "./intent.js";
import { git } from "./workspace.js";
import { abortMerge, applyPreparedCommit, assertWorktreeBinding, commitAtomic, commitEvidence, ensureWorktree, gateRunner, loadPolicy, prepareMerge, preparedMergeState, reconcilePreparedCommit, reconcilePreparedMerge, repositoryIdentity, sourceState } from "./workspace.js";
export type CaptainBeginStage = "reservation" | "lease-acquired" | "worktree-created" | "run" | "permit" | "active";
export type CaptainBeginArgs = { intent_id: string; objective: string; project_root: string; task_id?: string; plan_paths?: string[]; hitl_checks?: HitlCheck[] };
export type CaptainIssueIntentArgs = { session_id: string; turn_id: string; project_root: string; prompt: string; task_id?: string; resume_of?: string; target_branch?: string; action?: "start" | "resume" };
export type CaptainBeginDependencies = { repositoryIdentity: typeof repositoryIdentity; loadPolicy: typeof loadPolicy; ensureWorktree: typeof ensureWorktree; afterStage?: (stage: CaptainBeginStage) => Promise<void> };
const beginDependencies: CaptainBeginDependencies = { repositoryIdentity, loadPolicy, ensureWorktree };
export async function captainBegin(store: LifecycleStore, { intent_id, objective, project_root, task_id, plan_paths, hitl_checks }: CaptainBeginArgs, dependencies: CaptainBeginDependencies = beginDependencies) {
  const operation = await store.reserveBegin({ intentId: intent_id, objective, projectRoot: project_root, taskId: task_id }); await dependencies.afterStage?.("reservation"); const activated = await store.activatedBeginRun(operation);
  if (activated) {
    const requestedPolicy = await dependencies.loadPolicy(activated.projectRoot, activated.baseHead, plan_paths, hitl_checks);
    if (JSON.stringify(requestedPolicy.approvedPlans ?? []) !== JSON.stringify(activated.policy.approvedPlans ?? [])) throw new Error("begin retry changes the frozen plan selection");
    if (JSON.stringify(requestedPolicy.hitlChecks ?? []) !== JSON.stringify(activated.policy.hitlChecks ?? [])) throw new Error("begin retry changes the frozen HITL checks");
    return activated;
  }
  const identified = await dependencies.repositoryIdentity(project_root, operation.targetBranch, operation.targetOid), policy = await dependencies.loadPolicy(identified.projectRoot, identified.baseHead, plan_paths, hitl_checks), repository = await store.checkpointBeginRepository(operation, identified, policy);
  const lease = await store.ensureBeginTargetLease(operation, repository); await dependencies.afterStage?.("lease-acquired"); await store.checkpointBeginLease(operation, repository, lease);
  const workspace = await dependencies.ensureWorktree(repository.projectRoot, repository.baseHead, intent_id, operation.targetBranch, repository.commonGitDir); await dependencies.afterStage?.("worktree-created"); await store.checkpointBeginWorkspace(operation, workspace);
  const run = await store.checkpointBeginRun(operation, policy); await dependencies.afterStage?.("run"); await store.checkpointBeginActive(operation); await dependencies.afterStage?.("active"); const activatedRun = await store.checkpointBeginActivated(operation); await store.checkpointBeginPermit(operation, activatedRun); await dependencies.afterStage?.("permit"); return store.status(operation.intentId);
}
export async function captainIssueIntent(store: LifecycleStore, { session_id, turn_id, project_root, prompt, task_id, resume_of, target_branch, action }: CaptainIssueIntentArgs) {
  const directiveTarget = extractAuthorizedTargetBranch(prompt), directiveResume = extractCaptainResumeIntent(prompt);
  if (target_branch !== undefined && (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(target_branch) || extractAuthorizedTargetBranch(`[Captain target: ${target_branch}]`) !== target_branch)) throw new Error("target_branch is invalid");
  if (target_branch && directiveTarget && target_branch !== directiveTarget) throw new Error("target branch selectors conflict");
  if (resume_of && directiveResume && resume_of !== directiveResume) throw new Error("resume selectors conflict");
  target_branch ??= directiveTarget; resume_of ??= directiveResume;
  if (action === "start" && resume_of) throw new Error("start action conflicts with resume selector");
  const issued = await store.issueIdempotentIntent({ sessionId: session_id, turnId: turn_id, projectRoot: project_root, prompt, taskId: task_id, resumeOf: resume_of, targetBranch: target_branch, action }, async () => {
  if (!resume_of && task_id && action !== "start") {
    const candidates = await Promise.all((await store.doctor()).activeRuns.map(run => store.status(run.intentId)));
    const matching = candidates.filter(run => (run.status !== "green" || isPendingPlanReview(run)) && run.taskId === task_id && path.resolve(run.projectRoot) === path.resolve(project_root));
    if (matching.length > 1) throw new Error("task resume is ambiguous; supply resume_of for the intended run");
    resume_of = matching[0]?.intentId;
  }
  if (action === "resume" && !resume_of) throw new Error("no unfinished run found; supply task_id or resume_of");
  if (resume_of) {
    const run = await store.status(resume_of);
    if ((run.status === "green" && !isPendingPlanReview(run)) || path.resolve(run.projectRoot) !== path.resolve(project_root)) throw new Error("resume target is completed or belongs to a different project");
    if (task_id && run.taskId !== task_id) throw new Error("resume task_id conflicts with the existing run");
    if (target_branch && run.branch !== target_branch) throw new Error("resume target branch conflicts with the existing worktree");
    if (run.status !== "paused" && !(run.status === "green" && isPendingPlanReview(run) && !run.sessionLeaseId && !run.leaseId) && run.sessionId !== session_id) throw new Error("run is active in another session; its owner must pause before handoff");
  }
  let targetOid: string | undefined;
  if (target_branch && !resume_of) {
    targetOid = await git(["rev-parse", "--verify", `refs/heads/${target_branch}^{commit}`], project_root);
    await repositoryIdentity(project_root, target_branch, targetOid);
  }
  const intentId = `intent-${randomUUID()}`;
  return { intentId, sessionId: session_id, turnId: turn_id, projectRoot: path.resolve(project_root), prompt, ...(task_id ? { taskId: task_id } : {}), ...(resume_of ? { resumeOf: resume_of } : {}), ...(targetOid ? { targetBranch: target_branch, targetOid } : {}) };
  });
  const intentId = issued.intentId; resume_of = issued.resumeOf;
  await store.recordUserAuthorization({ projectRoot: project_root, sessionId: session_id, turnId: turn_id, prompt, intentId: resume_of ?? intentId, taskId: task_id, source: "client-adapter" });
  return { intent_id: intentId, ...(resume_of ? { resume_instruction: `Call captain_resume_implementation with resume_intent_id=${intentId}.` } : { begin_instruction: `Call captain_begin_implementation with intent_id=${intentId}.` }) };
}
export type CaptainCommitArgs = { intent_id: string; paths: string[]; subject: string; task_outcome?: "Implements" | "Completes" | "Needs-QA"; final: boolean };
export type CaptainResumeDependencies = { assertWorktreeBinding: typeof assertWorktreeBinding; git: typeof git; commitEvidence: typeof commitEvidence };
const resumeDependencies: CaptainResumeDependencies = { assertWorktreeBinding, git, commitEvidence };
export async function captainResume(store: LifecycleStore, resumeIntentId: string, dependencies: CaptainResumeDependencies = resumeDependencies) {
  const run = await store.resumeTarget(resumeIntentId), prepared = run.preparedCommit;
  if (run.terminalCommit && prepared) {
    await store.completedCommitFor(run.intentId, { paths: prepared.paths, subject: prepared.subject, taskOutcome: prepared.taskOutcome, final: prepared.final });
  } else if (prepared) {
    const binding = await dependencies.assertWorktreeBinding(run.worktreePath, run.branch, run.commonGitDir, undefined, false, run.gitDir);
    if (binding.head !== prepared.preCommitHead && binding.head !== prepared.candidate) {
      const firstParent = (await dependencies.git(["rev-list", "--first-parent", "--reverse", `${run.baseHead}..${binding.head}`], run.worktreePath)).split(/\r?\n/).filter(Boolean);
      if (!firstParent.includes(prepared.candidate)) throw new Error("prepared candidate is not retained in the advanced first-parent history");
      const candidateVerification = {
        tree: await dependencies.git(["rev-parse", `${prepared.candidate}^{tree}`], run.worktreePath),
        subject: await dependencies.git(["show", "-s", "--format=%s", prepared.candidate], run.worktreePath)
      };
      const evidence = await dependencies.commitEvidence(run.worktreePath, run.baseHead, run.policy, run.taskId, run.preparedMerges, run.committedState?.head);
      await store.recoverAdvancedPreparedCommit(run.intentId, evidence, firstParent, candidateVerification);
    }
  }
  return store.resume(resumeIntentId);
}
export type CaptainCommitDependencies = { applyPreparedCommit: typeof applyPreparedCommit; assertWorktreeBinding: typeof assertWorktreeBinding; commitAtomic: typeof commitAtomic; commitEvidence: typeof commitEvidence; reconcilePreparedCommit: typeof reconcilePreparedCommit };
const commitDependencies: CaptainCommitDependencies = { applyPreparedCommit, assertWorktreeBinding, commitAtomic, commitEvidence, reconcilePreparedCommit };
export async function captainCommit(store: LifecycleStore, { intent_id, paths, subject, task_outcome, final }: CaptainCommitArgs, dependencies: CaptainCommitDependencies = commitDependencies) {
  if (!final && task_outcome === "Completes") throw new Error("an intermediate phase commit cannot complete the governed task");
  const request = { paths, subject, taskOutcome: task_outcome, final }, completed = await store.completedCommitFor(intent_id, request); if (completed) return completed; const mutation = await store.acquireWorktreeMutation(intent_id, "commit", request); let run = await store.status(intent_id);
  try {
    if (run.preparedCommit) {
      const prepared = run.preparedCommit, operation = await store.commitOperationFor(intent_id, request);
      if (JSON.stringify(prepared.paths) !== JSON.stringify(paths) || prepared.subject !== subject || prepared.taskOutcome !== task_outcome || prepared.final !== final) throw new Error("prepared commit recovery requires the exact approved commit request");
      const binding = await dependencies.assertWorktreeBinding(run.worktreePath, run.branch, run.commonGitDir, undefined, false, run.gitDir);
      if (binding.head === prepared.preCommitHead) await dependencies.applyPreparedCommit(run.worktreePath, prepared, run.branch, run.commonGitDir, run.gitDir, async value => { await store.assertWorktreeMutation(intent_id, mutation); await store.assertPreparedCommitAuthority(intent_id, value, operation); });
      else if (binding.head === prepared.candidate) await dependencies.reconcilePreparedCommit(run.worktreePath, prepared, run.branch, run.commonGitDir, run.gitDir);
      else throw new Error("prepared commit recovery found a branch HEAD outside the signed transition");
      const committed = await store.recordCommit(intent_id, await dependencies.commitEvidence(run.worktreePath, run.baseHead, run.policy, run.taskId, run.preparedMerges, run.committedState?.head), prepared.final); await store.releaseWorktreeMutation(intent_id, mutation); return committed;
    }
    const operation = await store.acquireCommitOperation(intent_id, request);
    run = await store.status(intent_id); const expectedHead = executionHead(run);
    await dependencies.commitAtomic(run.worktreePath, paths, subject, task_outcome, run.taskId, run.policy.commit, run.preparedMerges, run.branch, run.commonGitDir, expectedHead, run.gitDir, prepared => store.recordPreparedCommit(intent_id, { ...prepared, paths, subject, taskOutcome: task_outcome, final }, operation).then(() => undefined), prepared => store.discardPreparedCommit(intent_id, prepared.candidate).then(() => undefined), undefined, async prepared => { await store.assertWorktreeMutation(intent_id, mutation); await store.assertPreparedCommitAuthority(intent_id, prepared, await store.commitOperationFor(intent_id, request)); });
    const committed = await store.recordCommit(intent_id, await dependencies.commitEvidence(run.worktreePath, run.baseHead, run.policy, run.taskId, run.preparedMerges, run.committedState?.head), final); await store.releaseWorktreeMutation(intent_id, mutation); return committed;
  } catch (error) {
    const latest = await store.status(intent_id);
    if (!latest.preparedCommit && latest.commitOperation) await store.discardCommitOperation(intent_id, latest.commitOperation);
    const afterDiscard = await store.status(intent_id); if (!afterDiscard.preparedCommit && afterDiscard.mutationOperation?.leaseToken === mutation.leaseToken) await store.releaseWorktreeMutation(intent_id, mutation);
    throw error;
  }
}
export type CaptainMergeDependencies = { prepareMerge: typeof prepareMerge; abortMerge: typeof abortMerge; preparedMergeState: typeof preparedMergeState; assertWorktreeBinding: typeof assertWorktreeBinding; reconcilePreparedMerge: typeof reconcilePreparedMerge };
const mergeDependencies: CaptainMergeDependencies = { prepareMerge, abortMerge, preparedMergeState, assertWorktreeBinding, reconcilePreparedMerge };
export async function captainPrepareMerge(store: LifecycleStore, { intent_id, commit_oid, strategy }: { intent_id: string; commit_oid: string; strategy: "ort" | "ours" }, dependencies: CaptainMergeDependencies = mergeDependencies) {
  const mutation = await store.acquireWorktreeMutation(intent_id, "merge", { commitOid: commit_oid, strategy });
  try {
    const run = await store.status(intent_id); if (run.phase !== "implement") throw new Error(`merge preparation requires implement phase, found ${run.phase}`); const expectedHead = executionHead(run);
    const result = await dependencies.prepareMerge(run.worktreePath, commit_oid, strategy, prepared => store.recordPreparedMerge(intent_id, prepared).then(() => undefined), prepared => store.discardPreparedMerge(intent_id, prepared).then(() => undefined), run.branch, run.commonGitDir, expectedHead, run.gitDir, undefined, mutation.leaseToken, prepared => store.assertPreparedMergeAuthority(intent_id, prepared, mutation));
    await store.releaseWorktreeMutation(intent_id, mutation); return result;
  } catch (error) { const latest = await store.status(intent_id); if (!latest.preparedMerges?.some(value => value.operationToken === mutation.leaseToken) && latest.mutationOperation?.leaseToken === mutation.leaseToken) await store.releaseWorktreeMutation(intent_id, mutation); throw error; }
}
export async function captainAbortMerge(store: LifecycleStore, { intent_id }: { intent_id: string }, dependencies: CaptainMergeDependencies = mergeDependencies) {
  const run = await store.status(intent_id), prepared = run.preparedMerges?.at(-1); if (!prepared) throw new Error("no signed prepared merge is available to abort");
  await dependencies.assertWorktreeBinding(run.worktreePath, run.branch, run.commonGitDir, prepared.preMergeHead, false, run.gitDir); const state = await dependencies.preparedMergeState(run.worktreePath, prepared); if (state === "clean") throw new Error("signed merge is still at clean pre-merge recovery; retry the exact captain_prepare_merge request before aborting"); if (state !== "pinned") throw new Error("prepared merge worktree state diverged from its signed authority");
  const mutation = await store.takeOverPreparedMergeForAbort(intent_id, prepared, true);
  await dependencies.abortMerge(run.worktreePath, prepared, value => store.assertPreparedMergeAuthority(intent_id, value, mutation, "abort"));
  const discarded = await store.discardPreparedMerge(intent_id, prepared); await store.releaseWorktreeMutation(intent_id, mutation); return discarded;
}
export async function startCaptainMcp() {
const dataRoot = process.env.CAPTAIN_PLUGIN_DATA || process.env.CODEX_PLUGIN_DATA || process.env.PLUGIN_DATA || path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "plugins", "data", "captain-sdlc-personal");
const store = new LifecycleStore(dataRoot, gateRunner, sourceState);
const merges = new MergeWorkflowStore(dataRoot, gateRunner);
const server = new McpServer({ name: "captain-sdlc", version: "0.2.3" });
const reply = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }], structuredContent: value as Record<string, unknown> });
const guarded = <T>(operation: () => Promise<T>) => operation().then(reply).catch((error: Error) => ({ isError: true, content: [{ type: "text" as const, text: error.message }] }));
const guardedMerge = <T>(operation: () => Promise<T>, args: { merge_id?: string; session_id: string }) => operation().then(reply).catch((error: Error) => {
  const merge_id = args.merge_id ?? (error instanceof MergeWorkflowError ? error.merge_id : undefined);
  const next_step = merge_id ? {
    tool: "captain_merge_status",
    arguments: { merge_id, session_id: args.session_id },
    guidance: "Read the signed source/target bindings and operation_lease recovery context. Repair the diagnosed cause and continue the same authorized operation; lease recovery is separate from abort/reset.",
  } : undefined;
  return { isError: true, content: [{ type: "text" as const, text: error.message + (next_step ? "\nInspect captain_merge_status with this same merge_id and session_id." : "") }], structuredContent: { error: error.message, ...(merge_id ? { merge_id } : {}), ...(next_step ? { next_step } : {}) } };
});
server.registerTool("captain_begin_implementation", { description: "Mandatory first action for implementation requests. Consumes the hook-issued intent and creates or adopts its signed canonical target worktree.", inputSchema: { intent_id: z.string(), objective: z.string(), project_root: z.string(), task_id: z.string().regex(/^[A-Za-z0-9._-]+$/).optional(), plan_paths: z.array(z.string().min(1)).optional(), hitl_checks: z.array(z.object({ id: z.string().trim().min(1), criterionId: z.string().trim().min(1), setup: z.string().trim().min(1), action: z.string().trim().min(1), expected: z.string().trim().min(1), evidence: z.string().trim().min(1) })).optional() } }, async args => guarded(async () => { const run = await captainBegin(store, args); return { ...run, effective_gates: effectiveGateDisclosure(run) }; }));
server.registerTool("captain_issue_intent", { description: "Client-neutral adapter entrypoint. Issues one signed implementation or resume intent for an explicitly supplied client session and turn.", inputSchema: { session_id: z.string().min(1).max(256), turn_id: z.string().min(1).max(256), project_root: z.string().min(1), prompt: z.string().min(1).max(12000), task_id: z.string().regex(/^[A-Za-z0-9._-]+$/).optional(), resume_of: z.string().optional(), target_branch: z.string().min(1).optional(), action: z.enum(["start", "resume"]).optional() } }, async args => guarded(() => captainIssueIntent(store, args)));
server.registerTool("captain_user_authorization_status", { description: "Retrieve durable commit/merge approval and revocation receipts, including original user wording, source turn, repository, task and merge target. Reuse existing authorization for the same task; missing parser receipts never negate explicit conversational approval. This is evidence, not a new approval gate or a waiver of Git hygiene.", inputSchema: { project_root: z.string().min(1), session_id: z.string().optional(), intent_id: z.string().optional(), operation: z.enum(["commit", "merge"]).optional(), target_branch: z.string().optional() } }, async args => guarded(() => store.userAuthorizations({ projectRoot: args.project_root, sessionId: args.session_id, intentId: args.intent_id, operation: args.operation, targetBranch: args.target_branch })));
server.registerTool("captain_record_red", { description: "Run the trusted ticket test and require it to fail before implementation.", inputSchema: { intent_id: z.string() } }, async ({ intent_id }) => guarded(() => store.recordRed(intent_id)));
server.registerTool("captain_run_check", { description: "Run a trusted ticket/smoke/regression check during the implementation loop.", inputSchema: { intent_id: z.string(), scope: z.enum(["ticket", "feature-smoke", "affected-regression"]) } }, async ({ intent_id, scope }) => guarded(() => store.runCheck(intent_id, scope)));
  server.registerTool("captain_resume_implementation", { description: "Consume a hook-issued one-time resume token for a later turn in the same governed run. Reconcile a validated advanced prepared commit before resuming.", inputSchema: { resume_intent_id: z.string() } }, async ({ resume_intent_id }) => guarded(async () => { const run = await captainResume(store, resume_intent_id); return { ...run, effective_gates: effectiveGateDisclosure(run) }; }));
  server.registerTool("captain_pause_implementation", { description: "Write a signed handoff and release session ownership only for an actual execution limit, explicit human stop, pending human review, or demonstrated external blocker. Keep working when an authorized next action exists; do not self-pause after one rejected tool call. Optionally supply a blocker task to start next.", inputSchema: { intent_id: z.string(), summary: z.string().min(1).max(4000), next_steps: z.array(z.string().min(1).max(1000)).min(1).max(20), blockers: z.array(z.string().min(1).max(1000)).max(20).optional(), plan_path: z.string().max(2000).optional(), phase_label: z.string().max(500).optional(), completed_steps: z.array(z.string().min(1).max(1000)).max(50).optional(), context: z.string().max(12000).optional(), redirect_task: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._#-]*$/).optional() } }, async ({ intent_id, summary, next_steps, blockers, plan_path, phase_label, completed_steps, context, redirect_task }) => guarded(() => store.pause(intent_id, { summary, nextSteps: next_steps, blockers, planPath: plan_path, phaseLabel: phase_label, completedSteps: completed_steps, context, redirectTask: redirect_task })));
server.registerTool("captain_link_blocker", { description: "Append a signed dependency from a paused run to the active blocker run that must be completed before it can resume.", inputSchema: { blocked_intent_id: z.string(), blocker_intent_id: z.string() } }, async ({ blocked_intent_id, blocker_intent_id }) => guarded(() => store.linkBlocker(blocked_intent_id, blocker_intent_id)));
server.registerTool("captain_doctor", { description: "List durable paused handoffs and unfinished Captain runs so a new agent can choose the correct resume or blocker task without rediscovery.", inputSchema: {} }, async () => guarded(() => store.doctor()));
server.registerTool("captain_migrate_plan_state", { description: "Migrate explicitly selected Markdown plans to Captain's bounded work-state block. This is the same backend used by the Captain dashboard and Codex skill.", inputSchema: { intent_id: z.string(), plan_paths: z.array(z.string().min(1).max(2000)).min(1).max(100) } }, async ({ intent_id, plan_paths }) => guarded(() => store.migratePlanState(intent_id, plan_paths)));
server.registerTool("captain_merge_diagnose", {
  description: "Read-only discovery of this caller session's signed merge operations matching exact source, target and branch bindings, plus allowlisted target lease owner metadata. Verifies existing authority without allocating, migrating, repairing or changing leases; does not certify readiness or Captain green.",
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  inputSchema: { session_id: z.string().min(1).max(256), source_worktree: z.string().min(1), target_worktree: z.string().min(1), target_branch: z.string().min(1) }
}, async args => guarded(() => merges.diagnose(args)));
const mergePrepConfig = {
  description: "Merge Prep: pin and pull the local target into the existing source worktree, retain conflicts for resolution, run captured merge-policy checks after an authorized source commit, and stop at signed readiness with the target unchanged. Reuse merge_id to continue; readiness is separate from implementation Captain green.",
  inputSchema: {
    session_id: z.string().min(1).max(256), source_worktree: z.string().min(1), target_worktree: z.string().min(1), target_branch: z.string().min(1), merge_id: z.string().optional(),
    commit: z.object({ paths: z.array(z.string().min(1)).min(1), subject: z.string().min(1), task_outcome: z.enum(["Implements", "Completes", "Needs-QA"]).optional(), task_id: z.string().regex(/^[A-Za-z0-9._-]+$/).optional() }).optional()
  }
};
for (const name of ["captain_merge_prep", "captain_merge_begin"]) {
  server.registerTool(name, mergePrepConfig, async args => guardedMerge(() => merges.prep(args), args));
}
const mergeBackConfig = {
  description: "Merge Back: under matching user integration authorization, verify an existing signed Merge Prep receipt and fast-forward its prepared source into the pinned target. Retain Prep gates at their tested revision; do not rerun them or modify prior implementation proof.",
  inputSchema: { merge_id: z.string().min(1), session_id: z.string().min(1).max(256), source_worktree: z.string().optional(), target_worktree: z.string().optional(), target_branch: z.string().optional() }
};
for (const name of ["captain_merge_back", "captain_merge_finish"]) {
  server.registerTool(name, mergeBackConfig, async args => guardedMerge(() => merges.back(args), args));
}
server.registerTool("captain_merge_status", {
  description: "Read the signed Merge Prep/Back operation, source/target bindings, retained gate evidence, and authenticated operation lease owner/recovery context. Use operation_lease.recovery.args for exact-generation recovery after verifying its owner is stopped; no internal storage inspection is needed. Merge readiness and integration are separate from implementation complete/green.",
  inputSchema: { merge_id: z.string().min(1), session_id: z.string().min(1).max(256), source_worktree: z.string().optional(), target_worktree: z.string().optional(), target_branch: z.string().optional() }
}, async args => guarded(() => merges.status(args)));
server.registerTool("captain_recover_merge_lease", {
  description: "Release only abandoned merge-operation, integration-worktree, and integration-branch leases after verifying the signed merge id, revision, source/target identity, session, pinned bindings, and exact operation lease token. It refuses active worktree owners and foreign leases. For legacy leases without owner-process metadata, the caller must confirm the previous owner is stopped. Resume the same merge_id with captain_merge_prep or captain_merge_back; this does not alter Git refs or merge readiness evidence.",
  inputSchema: {
    merge_id: z.string().min(1), session_id: z.string().min(1).max(256), source_worktree: z.string().min(1), target_worktree: z.string().min(1), target_branch: z.string().min(1),
    expected_revision: z.number().int().nonnegative(), expected_lease_token: z.string().min(1), confirm_owner_stopped: z.boolean().optional()
  }
}, async args => guardedMerge(() => merges.recoverStaleLease(args), args));
server.registerTool("captain_prepare_merge", { description: "Low-level audited no-commit implementation merge from a pinned full commit object id. Use captain_merge_prep for the complete Merge Prep workflow; this tool does not certify readiness or perform Merge Back.", inputSchema: { intent_id: z.string(), commit_oid: z.string().regex(/^[0-9a-f]{40,64}$/i), strategy: z.enum(["ort", "ours"]).default("ort") } }, async args => guarded(() => captainPrepareMerge(store, args)));
server.registerTool("captain_abort_merge", { description: "Abort the latest signed merge, or reconcile an authorization left before Git started, and restore its clean pre-merge state.", inputSchema: { intent_id: z.string() } }, async args => guarded(() => captainAbortMerge(store, args)));
server.registerTool("captain_commit", { description: "After explicit user approval, preflight and create one atomic Conventional Commit. Set final=false to validate an intermediate phase commit while keeping a multi-commit implementation open.", inputSchema: { intent_id: z.string(), paths: z.array(z.string()).min(1), subject: z.string(), task_outcome: z.enum(["Implements", "Completes", "Needs-QA"]).optional(), final: z.boolean().default(true) } }, async args => guarded(() => captainCommit(store, args)));
server.registerTool("captain_record_commit", { description: "Validate the exact clean atomic Conventional Commit, SemVer, changelog, task-trailer, and first-parent phase boundary.", inputSchema: { intent_id: z.string() } }, async ({ intent_id }) => guarded(async () => { const run = await store.status(intent_id); if (run.targetBranch) throw new Error("governed target integrations must create commits through captain_commit"); await assertWorktreeBinding(run.worktreePath, run.branch, run.commonGitDir, undefined, true, run.gitDir); return store.recordCommit(intent_id, await commitEvidence(run.worktreePath, run.baseHead, run.policy, run.taskId, run.preparedMerges, run.committedState?.head)); }));
server.registerTool("captain_prove", { description: "Run trusted scoped proof commands and bind trusted-policy build, smoke, and optional visual artifacts.", inputSchema: { intent_id: z.string() } }, async (args) => guarded(() => store.prove(args.intent_id)));
server.registerTool("captain_record_hitl_feedback", { description: "Retain actual human feedback for declared HITL checks independently of automated proof. Does not complete the run or waive failed gates; recorded_source is receipt-time provenance, not a claim about the earlier reviewed state.", inputSchema: { intent_id: z.string(), decision: z.enum(["accept", "needs_changes"]), human_feedback: z.string().min(1).max(12000), check_ids: z.array(z.string()).min(1).max(50), evidence_references: z.array(z.string().min(1).max(2000)).max(50), reviewed_revision: z.string().regex(/^[0-9a-f]{40,64}$/i).optional() } }, async ({ intent_id, decision, human_feedback, check_ids, evidence_references, reviewed_revision }) => guarded(async () => { const run = await store.recordHitlFeedback(intent_id, { decision, humanFeedback: human_feedback, checkIds: check_ids, evidenceReferences: evidence_references, ...(reviewed_revision ? { reviewedRevision: reviewed_revision } : {}) }); return { ...run, effective_gates: effectiveGateDisclosure(run) }; }));
server.registerTool("captain_record_plan_review", { description: "Record actual human feedback after signed proof is green. Copy the human feedback faithfully; never infer acceptance from agent tests or demonstrations. needs_changes retains HITL and records a bounded repair handoff.", inputSchema: { intent_id: z.string(), decision: z.enum(["accept", "needs_changes"]), human_feedback: z.string().trim().min(1) } }, async ({ intent_id, decision, human_feedback }) => guarded(async () => { const run = await store.recordPlanReview(intent_id, { decision, humanFeedback: human_feedback }); return { ...run, effective_gates: effectiveGateDisclosure(run) }; }));
server.registerTool("captain_status", { description: "Return the authoritative lifecycle phase and evidence ledger.", inputSchema: { intent_id: z.string() } }, async ({ intent_id }) => guarded(async () => { const run = await store.status(intent_id); return { ...run, effective_gates: effectiveGateDisclosure(run) }; }));
await server.connect(new StdioServerTransport());
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await startCaptainMcp();
