---
name: merge-prep
description: Pull a target branch into the existing task worktree, resolve conflicts and verification failures, and obtain signed readiness before continuing any already-authorized Merge Back.
---

# Merge Prep

Merge Begin (`merge begin` or `merge-begin`) is an alias for this workflow.
`captain_merge_begin` and `captain_merge_prep` accept the same arguments and share
the same operation and `merge_id`. Either tool stops at readiness with the target unchanged.

Resolve the task's existing source worktree and the exact local target branch/worktree.
For a new operation, use the user's explicitly selected target and the task's recorded identity.
For continuation, read `captain_merge_status` for the existing `merge_id` and retain its signed
source, target, branch and session bindings. Never infer a replacement target from checkout HEAD,
an ancestor branch or an older superseded handoff. A conflicting new target instruction requires
deliberate new preparation; do not silently retarget the existing operation.
Continue in that source checkout; preparation does not create a replacement implementation
worktree or reopen a completed plan. Preserve unrelated changes and another session's ownership.

Read the conversation and `captain_user_authorization_status` before claiming approval is missing.
Matching authority persists for the same task and target across turns, models and session handoffs;
missing parser receipts do not cancel clear conversational approval. Honor later revocations.
Do not ask the human to repeat an existing instruction or reproduce an internal token.

Necessary finalization belongs to the authorized merge operation. Inspect exact dirty paths
before invoking it. With captured `commit.bookkeeping.path_file` opt-in and committed
`.captain-sdlc/captain.ignore`, supply `finalization.source`/`finalization.target` with exact
`paths`, a Captain record subject, `task_id` and `disposition: commit | stash`. Source records
can be committed without a version bump; target records can be parked in a retained correlated
stash. Preserve the receipt's exact OID. Never auto-drop the stash or ignore unrelated dirt.
Prep and Back can each finalize new records with fresh generations; reuse an unfinished
`finalization_id` only for its identical selected data. Standalone `captain_finalize_bookkeeping`
also works after implementation completion, with independent signed status. Active/foreign
ownership, product/control changes and mixed paths remain refused. A rule/policy adoption or
change still uses an ordinary versioned commit; legacy captured operations retain their policy.
After readiness, retain original checks/revisions; audited record-only descendants receive a
separate integration association. Report tested and integrated heads distinctly. If a target
record was committed after Prep, reconcile it in the existing source through Prep before Back.
Without opt-in, finish necessary owned records with the ordinary authorized commit/stash
workflow before clean checks. Do not request the same task's approval again.

Call `captain_merge_prep` with the source, target, target branch, and current client session ID.
Retain its `merge_id` and use that same operation for subsequent Prep calls. Captain pins the
target revision, prepares the audited source merge, and reports conflicts or a pending commit.
Resolve conflicts and authorized verification errors in the source. Supply commit metadata
only under the user's existing commit authorization, keeping version/changelog/trailer rules.
Do not substitute raw Git merges, automatically abort/reset, or start a new operation to evade
a rejection.

For a leased merge operation, read `captain_merge_status.operation_lease`, including owner
information and `recovery.args`. Verify the previous owner is stopped; never recover active or
foreign ownership. Call `captain_recover_merge_lease` with those exact arguments, then continue
the same `merge_id`. This recovery preserves Git refs and readiness and does not need repeated
permission within the authorized operation. For legacy leases, supply `confirm_owner_stopped`
only after independently establishing that fact. Never guess identifiers, edit lease files, or
use implementation-scoped `captain_abort_merge` to recover a merge-workflow lease.
If the owner cannot be verified or recovery is rejected, diagnose the invariant and change the
relevant input before retrying; report a genuine unresolved blocker once.

Resume Prep after the pending merge/resolution is committed. Captain runs the existing merge
strictness checks from captured committed policy; caller-supplied commands cannot replace them.
After a failure, repair its diagnosed cause within the approved scope before retrying. Retain
prior evidence at the revision that produced it.

When Prep returns `ready`, continue through [Merge Back](../merge-back/SKILL.md) in the same turn
if matching integration authorization already applies. A Prep-only or Begin-only request stops
at readiness; preparation alone does not grant Back authority. Honor an explicit human stop.
Report the signed merge ID, source/target revisions, gate outcomes, and remaining blockers.
The Prep tool leaves the target unchanged. Merge readiness is separate from implementation proof,
human acceptance, and release proof.
