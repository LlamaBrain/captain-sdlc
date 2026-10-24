---
name: merge-back
description: Merge a prepared task worktree back into its authorized target using Captain's signed readiness, retaining the Prep checks without rerunning them.
---

# Merge Back

## Developer changelog retention

The [changelog skill](../changelog/SKILL.md) retains the worktree's developer-facing
`changes.md` under a dated subject-named path in `changelog/changes/`. Prepare and
commit that archive in the owned source before final Prep readiness; Back brings
it into the target through the same signed fast-forward. Do not write a new target
commit or alter a prepared head behind the readiness receipt. If an archive is
requested after readiness, use eligible supported record finalization or return to
Prep with the normal source commit. Preserve historical source OIDs, original proof
and existing captured criteria. Never delete a foreign root draft to make Back
clean. Archive retention does not compose or publish a release automatically.

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
For newly registered worktrees, Back automatically cleans up eligible completed
members of the recorded worktree chain. Read its `cleanup` result and report each
removed checkout or retained path with its reason. Preserve unfinished tasks,
dirty work, locks and active ownership; a successful integration with retained
worktrees has an outstanding cleanup result. Do not force removal or sweep legacy
worktrees. Compact proof archives and signed historical receipts survive removal.
For ordinary projects without runtime enrollment, use the
[worktree storage skill](../worktree-storage/SKILL.md) after the completed,
authorized normal merge. Back does not implicitly authorize push or publication.

For a legacy target reservation with no discoverable owning run/merge, use
`captain_branch_lease_diagnose` with the exact project root, target checkout,
branch and session. Only an authenticated orphan diagnosis plus explicit existing
human repossession direction permits `captain_repossess_branch_lease`, using the
returned generation/HEAD selectors, reason and original instruction. This is
operator-directed retirement, not a claim that an unknown owner stopped. Surviving
authority, workspaces and active/foreign owners remain protected. Preserve the
signed receipt and continue the original operation in the SAME source/target
worktrees; normal Prep acquires the replacement lease. No new checkout, reset,
authority-file editing, repeated permission or old-proof relabeling is needed.

If diagnosis instead finds authenticated failed Begin records, use
`captain_failed_begin_lease_diagnose` against the actual primary/target bindings.
Only verified terminal pre-workspace state plus explicit existing human
repossession direction permits `captain_repossess_failed_begin` with its exact
operator selectors. It preserves the ORIGINAL signed root/session graph, publishes
the standard cancellation fence, records operator revocation without claiming the
old client stopped, and retains the same worktrees. Any progressed task or active
attempt remains refused; never supply a false confirm_owner_stopped value.
