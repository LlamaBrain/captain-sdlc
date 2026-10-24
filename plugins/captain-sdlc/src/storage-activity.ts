import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { acquireAuthorizedLease, readAuthorizedLeaseState, releaseAuthorizedLease } from "./authority.js";
import { storageRegistrationId, type WorktreeRegistration } from "./worktree-storage.js";

type Reservation = { intentId: string; leaseToken: string; operation: string; registration_id: string; worktree_path: string; git_dir: string };
const samePath = (a: string, b: string) => process.platform === "win32" ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b);
// Shared cleanup already fences this exact branch resource; ordinary activity must use it too.
const leaseId = (registration: WorktreeRegistration) => createHash("sha256").update(`${path.resolve(registration.common_git_dir)}\0refs/heads/${registration.branch}`.toLowerCase()).digest("hex");
const reservationId = (registration: WorktreeRegistration) => "ordinary-" + storageRegistrationId(registration.common_git_dir, registration.worktree_path);
function owns(payload: Reservation, registration: WorktreeRegistration) {
  return payload.intentId === reservationId(registration) && payload.operation === "ordinary-worktree-active" &&
    payload.registration_id === storageRegistrationId(registration.common_git_dir, registration.worktree_path) &&
    typeof payload.worktree_path === "string" && samePath(payload.worktree_path, registration.worktree_path) &&
    typeof payload.git_dir === "string" && samePath(payload.git_dir, registration.git_dir);
}

/** This is a task reservation, never a claim about the short-lived helper process. */
export async function readOrdinaryActivity(dataRoot: string, registration: WorktreeRegistration): Promise<"active" | "inactive" | "reserved"> {
  const current = await readAuthorizedLeaseState<Reservation>(dataRoot, leaseId(registration));
  if (!current || current.state === "released") return "inactive";
  return owns(current.payload, registration) ? "active" : "reserved";
}

export async function markOrdinaryActive(dataRoot: string, registration: WorktreeRegistration): Promise<void> {
  const activity = await readOrdinaryActivity(dataRoot, registration);
  if (activity === "active") return;
  if (activity === "reserved") throw new Error("Worktree branch is reserved by another storage operation");
  await acquireAuthorizedLease(dataRoot, leaseId(registration), {
    intentId: reservationId(registration), leaseToken: randomUUID(), operation: "ordinary-worktree-active",
    registration_id: storageRegistrationId(registration.common_git_dir, registration.worktree_path),
    worktree_path: registration.worktree_path, git_dir: registration.git_dir,
  });
}

/** Only explicit completion of the selected task can release its active reservation. */
export async function finishOrdinaryActivity(dataRoot: string, registration: WorktreeRegistration): Promise<void> {
  const current = await readAuthorizedLeaseState<Reservation>(dataRoot, leaseId(registration));
  if (!current || current.state === "released") return;
  if (!owns(current.payload, registration)) throw new Error("Worktree branch has an active foreign reservation; preserve its owner");
  await releaseAuthorizedLease(dataRoot, leaseId(registration), current.payload.intentId, current.payload.leaseToken);
}
