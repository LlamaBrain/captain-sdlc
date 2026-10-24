---
name: captain-sdlc-enforce
description: Mandatory implementation workflow. Use whenever the user asks to implement, build, add, change, fix, refactor, migrate, remove, or ship repository code or assets.
---

# Captain SDLC Enforced Implementation

The purpose is clean Git hygiene and preserving authorized work. Saying "commit" is explicit
approval for the current task; "merge to X" approves that integration target. Preserve this
authority across turns, models and session handoffs for the same task and target. Consult
`captain_user_authorization_status` and the conversation for original user instructions
before claiming approval is absent. Missing parser receipts do not negate conversational
authorization. Do not demand exact wording, repeated confirmation, or treat ordinary append-only
commits as history rewrites. Commit/merge approval does not by itself authorize push or disabling
controls. A completed Git commit is distinct from Captain proof completion.

The hook-provided `intent_id` is authoritative. Do not mutate the repository before entering Captain.

## Frozen scope and human follow-ups

Once a human approves a plan and implementation begins, its scope, acceptance criteria,
phase assignments and definition of done are immutable. Do not add work or gates through
reviews, audits, handoffs, checklists or closeout. Fix defects against an existing criterion
under that criterion's ID. New requirements go only into a non-blocking "Follow-ups for human
review" section of the separate closure record. After completion the human decides what
becomes separately authorized work. Follow-up review cannot delay closure or reopen the plan.

Plans progress through draft, ready, working, optional HITL review, and completed. Draft/ready are editable.
A human instruction to start accepts approval and enters working; no second approval is
needed. Pass the selected committed plan paths as `plan_paths` when beginning the run;
Captain freezes their contents from the trusted base. Policy `approvedPlanPaths` also binds
mandatory plans. Pausing execution leaves the plan working and frozen. Completed plans stay
frozen; follow-ups become separate human-authorized work.

Declare `hitl_checks` at start only for segments needing human judgment. Each goal includes
`id`, original `criterionId`, `setup` (including automatic proof), exact human `action`,
`expected` observable pass/fail result, and `evidence` to retain. Group checks at the end
of the provable segment; do not pepper implementation with vague or repeated HITL requests.
Present the concrete goals and staged evidence together, retain the review state, and wait
for actual human feedback. Record received feedback promptly with
`captain_record_hitl_feedback`, even when automated proof is incomplete or failed. This
retains the human's decision independently; it does not complete the run or waive a gate.
Supply the declared check IDs and existing evidence references. Its receipt-time source
snapshot is not a claim that the human reviewed that exact revision; supply
`reviewed_revision` only when known. Never manufacture acceptance.
`captain_record_plan_review` finalizes acceptance after green proof. Reuse the human's
recorded acceptance when the reviewed behavior still applies; compare concrete behavioral
changes before asking for another review. Documentation, bookkeeping, or a failed unrelated
test alone does not invalidate HITL or require the human to approve it again.
Proof green with pending HITL is not a completed plan.
HITL remains an active, discoverable phase. A rejection returns the same run/worktree to
implementation for bounded repair and fresh proof of the original criteria; new behavior
requests stay follow-ups. Never create a replacement run solely because HITL failed.

Before beginning plan implementation, inspect the effective gate disclosure. Resolve policy conflicts
before implementation. Existing unbound runs must be reported as unbound; do not claim that
they have retroactive machine enforcement. Never change a signed run's policy to pass a gate.
Track progress in one external closure record, referencing original criteria, owner, next
action, evidence revision and outcome. Do not edit frozen plans for progress bookkeeping.

Item completion, phase acceptance, integration readiness and release proof are separate
statuses. Preserve the originally assigned gates; do not import later gates automatically.
Only call signed Captain proof complete when status is complete/green. A pending release
gate does not reopen an accepted phase unless that gate was part of its original acceptance.
Retain evidence at its real revision; documentation alone does not justify repeating runtime
checks. Signed proof validation still applies. Retry failures only after the relevant input
or diagnosed cause changes; after three unsuccessful approaches, record the blocker once.

## Fluid task lifecycle

Keep one task in its existing worktree across turns, models and sessions. Use the issue
adapter's structured target branch for a requested branch; verify the returned branch and
base before editing. Never silently fall back to the current branch.

Ordinary human wording to resume is sufficient. Resolve a unique task in the same repository
through signed status/handoff, then use the adapter's resume action/task ID or resume_of.
The human need not reproduce an intent token. Ambiguous tasks require clarification;
another session's active ownership must not be taken over automatically. Resume retains
the original worktree, dirty task work, phase and evidence. Missing or changed worktree
identity requires a specific recovery diagnosis, not a fresh implementation worktree.
Closing and reopening a client session, or a verified crash, is execution
continuity for the retained task. When the client adapter supplies its real
process identity, pass `client_pid` on Begin/Resume (or bind it through
`captain_bind_session_owner`). Never bind a temporary helper/MCP PID. A client
that supports logical close notification may bind a private close-token hash
and call `captain_record_session_closed` on panel closure; keep the token private.
On ordinary resume, Captain can turn a positively stopped registered owner into
the existing signed pause handoff automatically. If diagnosis is needed, use
`captain_session_interruption_status` and its exact selectors before
`captain_recover_interrupted_session`. Preserve the same run, branch, dirty work
and evidence. An inaccessible, live, foreign-host or unregistered owner is not
proof of a crash. A turn Stop event is not session closure.

Resume uses the exact signed pause snapshot to retain an already-recorded task HEAD.
This execution continuity is distinct from validated commit evidence and proof; it never
fills a missing commit ledger or marks tests green. A HEAD changed after that snapshot,
foreign checkout identity, or an interrupted prepared commit still requires its specific
recovery procedure.

Pause once with a concise signed handoff and the next concrete action. On resume read it,
check the recorded identity and relevant invalidators, and continue. Finish against frozen
criteria, with separate honest proof status and non-blocking follow-ups for the human.

Do not pause or end the turn just because a step is difficult, a tool rejected one attempt,
the run is long, or an approval receipt needs checking. Continue the authorized next action.
Pause only for a human stop request, a required human review or decision, a demonstrated
external blocker, or an actual execution limit. Before pausing, record the exact failed
operation and changed input needed for another attempt; do not repeat unchanged calls.
On resume, first reconcile an interrupted prepared commit through the same run and worktree.
If Captain reports an unrecoverable divergence, report that specific invariant once and
keep independent authorized work moving. Do not mint a replacement run or ask for the
same authorization merely because the original run was interrupted.
Retry an interrupted issue-intent call with its original session, turn and selectors;
the signed issuance receipt returns the same token and original branch pin. Do not mint
new session/turn identities to work around an unchanged error. LOW turn hygiene allows
clean committed worktrees and never substitutes for task proof.

Store disposable tool arguments and probes in an ignored task scratch directory, never the
repository root. Keep durable evidence, policy and handoffs in their documented locations.

1. Call `captain_begin_implementation` with the intent id, exact objective, repository root, and the repository task id when the trusted commit policy requires a task trailer. Profile and visual requirements come from trusted policy, not caller input.
2. Switch all implementation work to the canonical worktree returned by Captain.
3. Write the ticket test first, then call `captain_record_red`. The trusted ticket command must fail for the expected missing behavior.
For a LOW run whose captured ticket selects an unrelated Unity fixture, pass the
smallest task-relevant class or method as `ticket_filter` to `captain_record_red`.
Captain binds only the trusted runner's literal filter argument; subsequent
`captain_run_check` ticket calls reuse that immutable selection. Do not override
the command, edit captured policy or import broader suites for this selection.
4. Implement until the ticket test is green. Build a new deterministic feature smoke that runs in the provided build. Keep affected regression scope narrow; do not run the release-wide suite for ordinary feature work.
5. Produce the configured testable build, smoke result, and required screenshot/video evidence.
6. During implementation, `captain_prepare_merge`/`captain_abort_merge` remain the low-level audited tools for a pinned incoming commit when the existing run permits it. Resolve in the owned source; they do not certify integration readiness or update the target. Perform the separate branch-integration workflow below after the source is committed.
7. After explicit user approval, call `captain_commit` with exact paths, the atomic Conventional Commit subject and task outcome. Each phase commit must carry its deterministic SemVer bump, synchronized version surfaces, matching changelog entry, and task-bound trailer. A repair after failed proof is another explicit atomic phase commit, not an amend or history rewrite.
8. Call `captain_record_commit` only when validating an already-created governed commit, then call `captain_prove`. Captain takes artifact paths and proof commands only from the trusted base policy. A new `low` run executes the development-build gate, with basic source/dependency validation handled by that trusted command; task-specific red/green proof is performed during implementation; it does not import broad smoke, regression, IL2CPP, or full-suite checks. Existing `feature` runs keep build, ticket, feature-smoke, and affected-regression gates; `pre-release` additionally runs super-smoke. Existing signed runs retain their captured gates.
9. Call `captain_status`. Report completion only when it returns `complete/green`, and include its evidence locations and testable build.

Branch integration has two steps, separate from implementation completion.
Merge Begin and Merge Finish requests route to the same Prep and Back operations:
`captain_merge_begin` aliases `captain_merge_prep`; `captain_merge_finish` aliases
`captain_merge_back`. Keep the same merge ID, checks, and authorization rules.

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

Start with a
clean committed source and the existing source/target worktrees. Use
[Merge Prep](../merge-prep/SKILL.md) and `captain_merge_prep` to pull the pinned target
into that source, resolve conflicts/errors there, and run the captured merge checks;
the Prep tool stops at `ready` with the target unchanged. When matching integration authority
already applies, continue [Merge Back](../merge-back/SKILL.md) and `captain_merge_back` in the
same turn without another permission request. A Prep-only or Begin-only instruction stops at
readiness and does not grant Back authority. Back consumes
the signed Prep receipt without repeating gates. Preserve proof at its actual revision
and report integration readiness separately from implementation complete/green;
integration does not reopen a completed plan or substitute for its signed proof.

For existing merge operations, use the `captain_merge_status` source/target/branch bindings
before considering checkout HEAD, ancestor branches or older handoffs. Preserve the selected
target and task identity. For stale leases, read `operation_lease` status, verify the stopped
owner, call `captain_recover_merge_lease` with its exact `recovery.args`, then continue the same
authorized operation. This recovery preserves Git refs and readiness; do not ask for the same
permission again, guess IDs, edit lease files, or substitute implementation `captain_abort_merge`.
Active or foreign ownership remains protected by Captain's checks.

After updating the installed plugin, a conversation may still expose an older MCP
tool list. Check the installed package and its public `initialize`/`tools/list`
responses. When the required tool exists in that installed runtime, use an MCP
SDK stdio client to its `dist/server.js` with the installation's existing plugin
data directory. Preserve the same session, task, merge ID and authority store;
call the public tool with its published schema. Keep any client payloads in the
project's ignored automation scratch directory. This uses the installed public
transport and does not grant new authority. Do not make the human restart a
thread, find IDs or reauthorize work to compensate for a stale tool inventory.
Never bypass hook decisions or mark untrusted changed hooks as trusted. Actual
Codex hook trust prompts still belong to the human.

If the repository's committed `HEAD` lacks `.captain-sdlc/codex-policy.json`, use
its normal commit, test and integration workflow with the
[worktree storage skill](../worktree-storage/SKILL.md). Whenever that workflow
creates a worktree, create it through the storage helper so it receives a forward
cleanup registration under the primary checkout's `.captain-sdlc/worktrees/`.
On resuming a registered ordinary task, run the helper's `resume` command before
continuing so its active branch reservation protects it from chain cleanup.
Replace the same declared active build slot before every build or publish.
After the task and its required human checks are complete and its authorized merge
has landed, run the helper's cleanup from the retained target, passing the compact
proof reports to preserve. This includes eligible terminal predecessors in the
recorded chain and reports any retained checkout with a concrete reason. Do not
use task-named or timestamp-named publish folders, create nested worktrees,
silently leave merged worktrees behind, or register old worktrees for deletion.
Existing worktrees remain excluded from automatic removal. Ordinary work can
still bootstrap or repair Captain policy without unavailable MCP entry points;
ordinary storage receipts never claim signed Captain implementation proof.

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
