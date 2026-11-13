import { createHash } from "node:crypto";
import path from "node:path";
import type { Run } from "./lifecycle.js";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
export function executionHead(run: Run): string { return run.continuityState?.head ?? run.committedState?.head ?? run.baseHead; }
/** Structural version recognition only; authenticate the revision chain before trusting a run. */
export function isSupportedRunSchema(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const run = value as Run;
  return run.schemaVersion === 1 ? run.documentationScope === undefined
    : run.schemaVersion === 2 && run.documentationScope?.schemaVersion === 1;
}

export function assertRunRevisionTransition(previous: Run | undefined, current: Run): void {
  if (!previous) {
    if (current.schemaVersion !== 1 || current.documentationScope) throw new Error("initial signed run must use ordinary schema before documentation classification");
    return;
  }
  const scope = current.documentationScope;
  const documentationMigration = previous.schemaVersion === 1 && current.schemaVersion === 2
    && previous.phase === "tdd_red" && current.phase === "implement"
    && previous.status === "running" && current.status === "running"
    && !previous.documentationScope && scope?.schemaVersion === 1
    && scope.expectedHead === executionHead(previous)
    && scope.policySha256 === digest(JSON.stringify(previous.policy))
    && scope.sessionId === previous.sessionId && scope.turnId === previous.turnId
    && current.sessionId === previous.sessionId && current.turnId === previous.turnId
    && current.activationToken === previous.activationToken
    && current.sessionLeaseId === previous.sessionLeaseId && current.sessionLeaseToken === previous.sessionLeaseToken
    && current.evidence.length === previous.evidence.length + 1
    && JSON.stringify(current.evidence.slice(0, -1)) === JSON.stringify(previous.evidence)
    && JSON.stringify(current.evidence.at(-1)) === JSON.stringify({ kind: "documentation_scope", ...scope });
  // Version 2 fences older runtimes: their immutable-schema guard rejects this
  // transition before they can commit without understanding documentation scope.
  if (![1, 2].includes(current.schemaVersion) || (current.schemaVersion === 2) !== Boolean(scope)
    || (previous.schemaVersion !== current.schemaVersion && !documentationMigration))
    throw new Error("signed run documentation schema transition is invalid");
  const stable = (run: Run) => ({ runId: run.runId, operationToken: run.operationToken, intentId: run.intentId,
    taskId: run.taskId, objective: run.objective, projectRoot: path.resolve(run.projectRoot), worktreePath: path.resolve(run.worktreePath),
    baseHead: run.baseHead, branch: run.branch, targetBranch: run.targetBranch, commonGitDir: path.resolve(run.commonGitDir),
    gitDir: path.resolve(run.gitDir), profile: run.profile, visualRequired: run.visualRequired, startedAt: run.startedAt, policy: run.policy });
  if (JSON.stringify(stable(previous)) !== JSON.stringify(stable(current))) throw new Error("signed run immutable binding changed across revisions");
  if (previous.documentationScope !== undefined && JSON.stringify(previous.documentationScope) !== JSON.stringify(current.documentationScope)) throw new Error("signed run immutable documentation scope changed across revisions");
  if (previous.taskTicket !== undefined && JSON.stringify(previous.taskTicket) !== JSON.stringify(current.taskTicket)) throw new Error("signed run immutable task ticket binding changed across revisions");
}
