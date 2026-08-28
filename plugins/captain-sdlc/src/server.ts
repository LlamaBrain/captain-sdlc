import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { z } from "zod";
import { LifecycleStore } from "./lifecycle.js";
import { abortMerge, applyPreparedCommit, assertWorktreeBinding, commitAtomic, commitEvidence, ensureWorktree, gateRunner, loadPolicy, prepareMerge, preparedMergeState, reconcilePreparedCommit, reconcilePreparedMerge, repositoryIdentity, sourceState } from "./workspace.js";
export type CaptainBeginStage = "reservation" | "lease-acquired" | "worktree-created" | "run" | "permit" | "active";
export type CaptainBeginArgs = { intent_id: string; objective: string; project_root: string; task_id?: string };
export type CaptainBeginDependencies = { repositoryIdentity: typeof repositoryIdentity; loadPolicy: typeof loadPolicy; ensureWorktree: typeof ensureWorktree; afterStage?: (stage: CaptainBeginStage) => Promise<void> };
const beginDependencies: CaptainBeginDependencies = { repositoryIdentity, loadPolicy, ensureWorktree };
export async function captainBegin(store: LifecycleStore, { intent_id, objective, project_root, task_id }: CaptainBeginArgs, dependencies: CaptainBeginDependencies = beginDependencies) {
  const operation = await store.reserveBegin({ intentId: intent_id, objective, projectRoot: project_root, taskId: task_id }); await dependencies.afterStage?.("reservation"); const activated = await store.activatedBeginRun(operation); if (activated) return activated;
  const identified = await dependencies.repositoryIdentity(project_root, operation.targetBranch, operation.targetOid), policy = await dependencies.loadPolicy(identified.projectRoot, identified.baseHead), repository = await store.checkpointBeginRepository(operation, identified, policy);
  const lease = await store.ensureBeginTargetLease(operation, repository); await dependencies.afterStage?.("lease-acquired"); await store.checkpointBeginLease(operation, repository, lease);
  const workspace = await dependencies.ensureWorktree(repository.projectRoot, repository.baseHead, intent_id, operation.targetBranch, repository.commonGitDir); await dependencies.afterStage?.("worktree-created"); await store.checkpointBeginWorkspace(operation, workspace);
  const run = await store.checkpointBeginRun(operation, policy); await dependencies.afterStage?.("run"); await store.checkpointBeginActive(operation); await dependencies.afterStage?.("active"); const activatedRun = await store.checkpointBeginActivated(operation); await store.checkpointBeginPermit(operation, activatedRun); await dependencies.afterStage?.("permit"); return store.status(operation.intentId);
}
export type CaptainCommitArgs = { intent_id: string; paths: string[]; subject: string; task_outcome?: "Implements" | "Completes" | "Needs-QA"; final: boolean };
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
    run = await store.status(intent_id); const expectedHead = run.committedState?.head ?? run.baseHead;
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
    const run = await store.status(intent_id); if (run.phase !== "implement") throw new Error(`merge preparation requires implement phase, found ${run.phase}`); const expectedHead = run.committedState?.head ?? run.baseHead;
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
async function main() {
const dataRoot = process.env.CAPTAIN_PLUGIN_DATA || process.env.PLUGIN_DATA;
if (!dataRoot) throw new Error("CAPTAIN_PLUGIN_DATA or PLUGIN_DATA is required");
const store = new LifecycleStore(dataRoot, gateRunner, sourceState);
const server = new McpServer({ name: "captain-sdlc", version: "0.1.2" });
const reply = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }], structuredContent: value as Record<string, unknown> });
const guarded = <T>(operation: () => Promise<T>) => operation().then(reply).catch((error: Error) => ({ isError: true, content: [{ type: "text" as const, text: error.message }] }));
server.registerTool("captain_begin_implementation", { description: "Mandatory first action for implementation requests. Consumes the hook-issued intent and creates or adopts its signed canonical target worktree.", inputSchema: { intent_id: z.string(), objective: z.string(), project_root: z.string(), task_id: z.string().regex(/^[A-Za-z0-9._-]+$/).optional() } }, async args => guarded(() => captainBegin(store, args)));
server.registerTool("captain_record_red", { description: "Run the trusted ticket test and require it to fail before implementation.", inputSchema: { intent_id: z.string() } }, async ({ intent_id }) => guarded(() => store.recordRed(intent_id)));
server.registerTool("captain_run_check", { description: "Run a trusted ticket/smoke/regression check during the implementation loop.", inputSchema: { intent_id: z.string(), scope: z.enum(["ticket", "feature-smoke", "affected-regression"]) } }, async ({ intent_id, scope }) => guarded(() => store.runCheck(intent_id, scope)));
server.registerTool("captain_resume_implementation", { description: "Consume a hook-issued one-time resume token for a later turn in the same governed run.", inputSchema: { resume_intent_id: z.string() } }, async ({ resume_intent_id }) => guarded(() => store.resume(resume_intent_id)));
server.registerTool("captain_prepare_merge", { description: "Prepare an audited no-commit merge from one pinned full commit object id inside the owned worktree.", inputSchema: { intent_id: z.string(), commit_oid: z.string().regex(/^[0-9a-f]{40,64}$/i), strategy: z.enum(["ort", "ours"]).default("ort") } }, async args => guarded(() => captainPrepareMerge(store, args)));
server.registerTool("captain_abort_merge", { description: "Abort the latest signed merge, or reconcile an authorization left before Git started, and restore its clean pre-merge state.", inputSchema: { intent_id: z.string() } }, async args => guarded(() => captainAbortMerge(store, args)));
server.registerTool("captain_commit", { description: "After explicit user approval, preflight and create one atomic Conventional Commit. Set final=false to validate an intermediate phase commit while keeping a multi-commit implementation open.", inputSchema: { intent_id: z.string(), paths: z.array(z.string()).min(1), subject: z.string(), task_outcome: z.enum(["Implements", "Completes", "Needs-QA"]).optional(), final: z.boolean().default(true) } }, async args => guarded(() => captainCommit(store, args)));
server.registerTool("captain_record_commit", { description: "Validate the exact clean atomic Conventional Commit, SemVer, changelog, task-trailer, and first-parent phase boundary.", inputSchema: { intent_id: z.string() } }, async ({ intent_id }) => guarded(async () => { const run = await store.status(intent_id); if (run.targetBranch) throw new Error("governed target integrations must create commits through captain_commit"); await assertWorktreeBinding(run.worktreePath, run.branch, run.commonGitDir, undefined, true, run.gitDir); return store.recordCommit(intent_id, await commitEvidence(run.worktreePath, run.baseHead, run.policy, run.taskId, run.preparedMerges, run.committedState?.head)); }));
server.registerTool("captain_prove", { description: "Run trusted scoped proof commands and bind trusted-policy build, smoke, and optional visual artifacts.", inputSchema: { intent_id: z.string() } }, async (args) => guarded(() => store.prove(args.intent_id)));
server.registerTool("captain_status", { description: "Return the authoritative lifecycle phase and evidence ledger.", inputSchema: { intent_id: z.string() } }, async ({ intent_id }) => guarded(() => store.status(intent_id)));
await server.connect(new StdioServerTransport());
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
