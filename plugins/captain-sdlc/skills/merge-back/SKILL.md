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
Read the conversation and `captain_user_authorization_status` before claiming authority is missing;
missing parser receipts do not cancel clear conversational approval. Matching authority survives
turns, models and session handoffs for the same task and target. Honor later revocations and
preserve Captain's session ownership checks; authority does not permit adopting foreign ownership.
Use the signed operation's source, target and branch bindings, never an ancestor branch, current
checkout HEAD or superseded handoff. Do not require the human to repeat the target or internal ID.

Call `captain_merge_back` for that operation and the current client session ID. Captain checks
the prepared identities, revisions, policy and dependency inputs before fast-forwarding the
target. Back retains the test/build evidence from Prep and does not repeat those checks.

If a stale operation lease blocks Back, read `captain_merge_status.operation_lease`, including
owner information and `recovery.args`. Verify the previous owner is stopped and call
`captain_recover_merge_lease` with those exact arguments, then resume Back with the same `merge_id`
and existing authority. No repeated permission is needed for this recovery that preserves Git refs
and readiness. Legacy `confirm_owner_stopped` records an independently verified fact; never assume
it, recover active or foreign owners, guess IDs, mutate lease files, or substitute
implementation-scoped `captain_abort_merge`. Diagnose a rejection before another attempt and
report an unresolved blocker once.

If readiness is missing or stale, preserve the rejection and return to [Merge Prep](../merge-prep/SKILL.md)
in the existing source checkout. Do not force a merge, fabricate readiness, weaken checks, or
silently adopt another session's operation. After repaired Prep returns valid readiness, continue
the already-authorized Back without another human instruction. Report the resulting target revision
and signed merge status separately from implementation `complete/green`, plan acceptance and
release proof.
Keep the source worktree; Back does not implicitly authorize push, publication or deletion.
