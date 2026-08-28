import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { readAuthorized, readAuthorizedLease } from "../dist/authority.js";

const sha256 = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const stable = run => ({ schemaVersion: run.schemaVersion, runId: run.runId, operationToken: run.operationToken, intentId: run.intentId, sessionId: run.sessionId, taskId: run.taskId, objective: run.objective, projectRoot: path.resolve(run.projectRoot), worktreePath: path.resolve(run.worktreePath), baseHead: run.baseHead, branch: run.branch, targetBranch: run.targetBranch, commonGitDir: path.resolve(run.commonGitDir), gitDir: path.resolve(run.gitDir), profile: run.profile, visualRequired: run.visualRequired, startedAt: run.startedAt, policy: run.policy });

export async function latestRun(data, intentId) {
  const prefix = `${intentId}-`, names = await readdir(path.join(data, "run-revisions")), expression = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([0-9]+)\\.json$`), revisions = names.map(name => expression.exec(name)).filter(Boolean).map(match => Number(match[1])).sort((a, b) => a - b);
  if (!revisions.length || revisions.some((revision, index) => revision !== index)) throw new Error("Captain signed run revision sequence is missing or noncontiguous");
  let previous, latest;
  for (const revision of revisions) {
    latest = await readAuthorized(data, "run-revisions", `${intentId}-${revision}`);
    if (latest.intentId !== intentId || latest.revision !== revision || (revision === 0 ? latest.previousRevisionSha256 !== undefined : latest.previousRevisionSha256 !== sha256(previous)) || (previous && JSON.stringify(stable(previous)) !== JSON.stringify(stable(latest)))) throw new Error("Captain signed run revision binding is invalid");
    const watermark = await readAuthorized(data, "run-watermarks", `${intentId}-${revision}`); if (watermark.intentId !== intentId || watermark.runId !== latest.runId || watermark.revision !== revision || watermark.runSha256 !== sha256(latest) || watermark.previousRevisionSha256 !== latest.previousRevisionSha256) throw new Error("Captain signed run watermark is invalid");
    previous = latest;
  }
  let watermarkNames = []; try { watermarkNames = await readdir(path.join(data, "run-watermarks")); } catch (error) { if (error?.code !== "ENOENT") throw error; }
  const watermarks = watermarkNames.map(name => expression.exec(name)).filter(Boolean).map(match => Number(match[1])); if (watermarks.some(revision => revision > latest.revision)) throw new Error("Captain run regressed behind its signed watermark");
  return latest;
}

export async function validPermit(data, sessionId, turnId) {
  const permit = await readAuthorized(data, "permits", `${sessionId}-${turnId}`); if (permit.schemaVersion !== 1 || permit.activated !== true || permit.sessionId !== sessionId || permit.turnId !== turnId) throw new Error("Captain turn permit binding is invalid");
  const run = await latestRun(data, permit.intentId); if (run.status === "green" || run.sessionId !== sessionId || run.turnId !== turnId || run.runId !== permit.runId || run.revision !== permit.runRevision || run.operationToken !== permit.operationToken || run.worktreePath !== permit.worktreePath || run.sessionLeaseId !== permit.sessionLeaseId || run.sessionLeaseToken !== permit.sessionLeaseToken) throw new Error("Captain turn permit is stale");
  const activated = await readAuthorized(data, "begin-activated", permit.operationToken), lease = await readAuthorizedLease(data, permit.sessionLeaseId); if (activated.operationToken !== permit.operationToken || activated.runId !== permit.runId || lease.intentId !== permit.intentId || lease.leaseToken !== permit.sessionLeaseToken || lease.operationToken !== permit.operationToken || lease.runId !== permit.runId || lease.sessionId !== sessionId || lease.operation !== "session-active") throw new Error("Captain turn permit has no current active ownership");
  return { permit, run };
}

export async function activeRunForSession(data, sessionId) {
  let names = []; try { names = await readdir(path.join(data, "run-revisions")); } catch (error) { if (error?.code !== "ENOENT") throw error; }
  const intentIds = [...new Set(names.map(name => /^(.*)-0\.json$/.exec(name)?.[1]).filter(Boolean))], active = [];
  for (const intentId of intentIds) { const run = await latestRun(data, intentId); if (run.sessionId !== sessionId || run.status === "green" || !run.sessionLeaseId || !run.sessionLeaseToken) continue; try { const lease = await readAuthorizedLease(data, run.sessionLeaseId); if (lease.intentId === run.intentId && lease.leaseToken === run.sessionLeaseToken && lease.operationToken === run.operationToken) active.push(run); } catch {} }
  if (active.length > 1) throw new Error("multiple authoritative Captain runs own this session"); return active[0] ?? null;
}
