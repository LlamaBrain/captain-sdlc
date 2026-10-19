---
name: pending-work
description: Audit unfinished repository work, unmerged branch chains, retained worktrees, unresolved decisions and outstanding proof. Use when asking what is pending, what was left behind, or which work should be resumed; reports evidence without merging, deleting or implementing findings.
---

# Pending work

Produce an evidence-backed inventory of work and decisions that still need attention.
A check authorizes inspection; it does not turn its findings into implementation,
merge, cleanup or decision authority. Existing explicit instructions remain valid
for their original tasks. Do not add this audit as a new completion gate.

## Establish scope and targets

Start with the repositories named by the user or the current task and its known local
dependencies. Resolve Git common directories and registered worktrees so one repository
is counted once. Do not scan the user's whole drive or assume the current checkout is
the integration target.

Use the user's target or the task's signed merge/handoff binding. Otherwise inspect the
repository's documented integration branch. If multiple targets remain plausible, report
the alternatives and ask only when choosing one is necessary. Pin each named target and
local branch to its exact OID. Say that remote-tracking refs are locally cached; do not
fetch or claim current remote/CI state without a request and corresponding evidence.

## Find retained and unintegrated work

Run the bundled helper once per repository/target pair:

```text
node <skill-directory>/scripts/git-pending-work.mjs --repo <repository-path> --target <integration-ref>
```

It emits JSON using only local Git reads. For large repositories, save the full JSON
to ignored task scratch and print a compact projection of pending groups and worktree
exceptions; do not dump every integrated branch and raw status entry. The target is
required. Missing targets,
unreadable worktrees and a changing snapshot are incomplete checks, never an empty
backlog. Review its `snapshot` before drawing conclusions; a changed ref needs a fresh
bounded check rather than relabeling the old result.

Interpret the graph correctly:

- A branch is integrated when its tip is reachable from the selected target. If a
  descendant is integrated, its ancestor is necessarily integrated too.
- Group remaining branches by maximal unintegrated descendant tips. List predecessor
  branches under those tips, retaining shared ancestry and equal-OID aliases. Do not
  count a predecessor as another independent merge, or infer its successor is merged
  merely because an ancestor was merged.
- Include dirty and detached worktrees, unique detached commits, unfinished Git
  operations and missing/prunable registrations. A clean primary checkout does not
  prove there is no retained work. Do not inspect another worker's dirty content beyond
  what is needed to identify it, or call an active foreign task abandoned.
- Optionally inspect local `git stash list` metadata when it may hold task work. Retain
  exact stash OIDs and owner uncertainty; do not pop, drop or apply anything.

For likely cherry-picks or rewritten history, `git cherry <target> <branch>` can show
patch-equivalent non-merge commits. Keep that result separate from ancestry. A `+` is
not proof the feature is absent, and a `-` is not signed integration, human acceptance
or permission to delete a branch. Squashes and edited ports need focused comparison.
Check archive/checkpoint intent before proposing an operational merge.

## Reconcile tasks, proof and decisions

Use public Captain discovery/status tools in the repository's configured authority
context: `captain_doctor`, then `captain_status` for relevant returned runs and
`captain_merge_status` for known operations. Keep original task/session/worktree/target
bindings. Filter discovery by the actual Git common directory/registered checkout,
not just a path prefix: another repository's worktree may physically live below the
current repository. If discovery is large, retain its response outside model output
and project only relevant task IDs, repository/worktree identities, phase/status,
latest proof/review summary and handoff links. Read full ledgers only for selected
items; do not dump all historical evidence or handoff bodies. Confirm which repositories
the available authority context actually covers, and label missing coverage unverified.
Do not invent IDs, edit signed storage, adopt a foreign lease or start a
replacement implementation just to perform this audit. If tools are unavailable,
continue the Git/document checks and label signed lifecycle status unverified.

Read the repository's durable Captain Notes through `captain_notes_list` when available;
otherwise inspect its note source (`.captain-sdlc/notebook/notes.json`) using the documented
local CLI or file format. Generated dashboards are projections. Read relevant retained
handoffs, closure records, approved plan criteria and ADR/open-question records. Prefer
these sources over a broad TODO search. Include open decisions, questions, follow-ups,
blocked tasks and unfinished acceptance, with evidence and owner when known.

Keep these dimensions independent:

| Dimension | Evidence |
| --- | --- |
| Work retained/committed | Exact branch/commit, dirty worktree or stash |
| Integrated | Ancestry to named target; signed Back status separately |
| Installed/deployed | Verified installed runtime/artifact revision |
| Proven | Required test/build/smoke outcome at actual input revision |
| Human accepted | Explicit feedback for declared review criterion |
| Decision resolved | Recorded answer/ADR with its scope and authority |

For example, a plugin may be installed and tested locally while its source is still
unmerged. A target may already have been fast-forwarded while signed Back acknowledgment
is pending. A merged build can still have an outstanding HITL or failed performance gate.
Report the specific remaining action rather than flattening those into “done.”

Reconcile superseded records: a past failure with a valid passing replacement at the
applicable inputs is history. Do not reopen completed criteria, invent gates from new
findings, invalidate accepted HITL from bookkeeping alone, or silently promote optional
follow-ups into the approved scope. Disclose contradictions between Git, signed status,
notes and documentation; identify the next evidence or owner needed to resolve them.

## Report and stop

Lead with actionable pending groups and decisions, grouped by repository/category.
For each item retain enough to resume safely: branch/HEAD and target/OID, covered
predecessors/aliases, worktree/status, task/proof/review state, owner, next action and
source link. Separate known pending items from unknown/unverified state and historical
archives. Summarize integrated branches rather than flooding the report with them.

State inspection limits (local refs only, unavailable signed/CI status, unstable snapshot,
unreadable checkout). Never report “nothing pending” if a required evidence source was
not checked. End with the inventory; do not fetch, merge, rebase, stash, delete, alter
notes/plans, resolve decisions or begin implementing findings unless that separate action
is already explicitly authorized.
