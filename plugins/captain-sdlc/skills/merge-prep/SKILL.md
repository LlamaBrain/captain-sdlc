---
name: merge-prep
description: Pull a target branch into the existing task worktree, resolve conflicts and verification failures, run Captain's merge checks, and stop at readiness for a separate Merge Back.
---

# Merge Prep

Merge Begin (`merge begin` or `merge-begin`) is an alias for this workflow.
`captain_merge_begin` and `captain_merge_prep` accept the same arguments and share
the same operation and `merge_id`. Either spelling stops at readiness.

Resolve the task's existing source worktree and the exact local target branch/worktree.
Continue in that source checkout; preparation does not create a replacement implementation
worktree or reopen a completed plan. Preserve unrelated changes and another session's ownership.

Call `captain_merge_prep` with the source, target, target branch, and current client session ID.
Retain its `merge_id` and use that same operation for subsequent Prep calls. Captain pins the
target revision, prepares the audited source merge, and reports conflicts or a pending commit.
Resolve conflicts and authorized verification errors in the source. Supply commit metadata
only under the user's existing commit authorization, keeping version/changelog/trailer rules.
Do not substitute raw Git merges, automatically abort/reset, or start a new operation to evade
a rejection. A changing target requires deliberate new preparation.

Resume Prep after the pending merge/resolution is committed. Captain runs the existing merge
strictness checks from captured committed policy; caller-supplied commands cannot replace them.
After a failure, repair its diagnosed cause within the approved scope before retrying. Retain
prior evidence at the revision that produced it.

Stop when Prep returns `ready`, even if earlier authorization would permit integration.
Report the signed merge ID, source/target revisions, gate outcomes, and remaining blockers.
The target stays unchanged. Merge readiness is separate from implementation proof, human
acceptance, and release proof. Hand off to [Merge Back](../merge-back/SKILL.md).
