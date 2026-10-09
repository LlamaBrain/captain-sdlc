---
name: merge-back
description: Merge a prepared task worktree back into its authorized target using Captain's signed readiness, retaining the Prep checks without rerunning them.
---

# Merge Back

Merge Finish (`merge finish` or `merge-finish`) is an alias for this workflow.
`captain_merge_finish` and `captain_merge_back` accept the same arguments and share
the same operation and `merge_id`, including integration authorization and saved proof.

Resolve the existing signed `merge_id` from the Prep handoff; `captain_merge_status` reports
its current state. Use the same source and target worktrees. A readiness receipt establishes
preparation; integration still needs the user's explicit instruction or preserved matching
authorization. Do not ask again when that authorization already applies.

Call `captain_merge_back` for that operation and the current client session ID. Captain checks
the prepared identities, revisions, policy and dependency inputs before fast-forwarding the
target. Back retains the test/build evidence from Prep and does not repeat those checks.

If readiness is missing or stale, preserve the rejection and return to [Merge Prep](../merge-prep/SKILL.md)
in the existing source checkout. Do not force a merge, fabricate readiness, weaken checks, or
silently adopt another session's operation. Report the resulting target revision and signed
merge status separately from implementation `complete/green`, plan acceptance and release proof.
Keep the source worktree; Back does not implicitly authorize push, publication or deletion.
