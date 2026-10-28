# Captain SDLC Codex plugin

This plugin supports clean Git hygiene and preservation of authorized work.

## Explicit user authorization

Direct user instructions such as `commit`, `commit it`, `approve commit`, or `merge to spike/colony`
are authorization, not invitations to ask again. UserPromptSubmit and the client intent adapter
store signed local receipts containing the original wording, session/turn, repository, source
branch, governed task when available, and exact merge target. Later prompts restore these receipts.
Use `captain_user_authorization_status` to retrieve them after a handoff. Revocations remain in
the ordered record. Approvals do not silently transfer to another repository, task or merge target.

This is evidence capture, not another approval gate. The parser intentionally recognizes a small
set of direct instructions; missing receipts do not invalidate clear authorization in conversation.
Quoted examples, discussion, code fences and commands to push are not converted into approval.
Client-adapter receipts identify their source separately from direct prompt-hook receipts.

After approval, verify Git branch/HEAD, scoped changes, version/changelog and relevant proof,
then preserve the work in a commit. A commit does not imply a push or a green release proof.
The parent SemVer baseline comes from the configured `version_file`; a stale companion such as
Doxygen can be repaired in that new commit. Every candidate version surface must still agree.

- `UserPromptSubmit` classifies implementation requests and issues a one-time intent.
- `PreToolUse` denies mutation until `captain_begin_implementation` owns a canonical worktree for the same session and turn.
- MCP tools enforce the TDD red gate, atomic Conventional Commit + SemVer + changelog gate, task-bound trailers, signed merge preparation/abort, trusted scoped proof commands, and required artifacts.
- `Stop` continues incomplete governed turns and permits completion only after `complete/green` evidence.

Each governed repository must commit `.captain-sdlc/codex-policy.json`. When `commitPolicyPath` is configured, its schema-versioned repository policy is also loaded from the captured base. Proof commands and commit rules come only from that trusted state; MCP callers cannot replace them with `exit 0` or mutable working-tree policy.

## Documentation-only work

After Begin, use `captain_prepare_documentation` before editing a clean documentation
task, or to recover documentation already retained in the same task worktree:

```json
{
  "intent_id": "<existing intent>",
  "paths": ["README.md", "docs/operator-guide.md"],
  "reason": "Update operator guidance without changing executable behavior",
  "expected_head": "<exact current governed commit SHA>"
}
```

A clean worktree can declare existing or new documents. With existing changes, the
selected paths must match the entire dirty set. Captain validates paths, regular
file modes, link boundaries and contents, then records schema-versioned
`documentationScope` evidence and moves the original run to `implement`. The run
advances from schema 1 to schema 2 through that audited transition, so older
runtimes reject its revision chain instead of ignoring the new restrictions. Use
the installed runtime's public transport if the host still exposes older tools.
Ordinary code runs retain schema 1. The documentation transition does
not record a failing test or alter the captured project policy. Exact retries are
idempotent; a changed request cannot replace the scope.

Commit reservation, candidate authorization, commit recovery and proof enforce the
whole pinned-base delta. Code, control-plane Markdown, executable sequence fences,
ignored executable inputs and arbitrary generated changes are refused. Captured
release surfaces can change only their version metadata; generated JavaScript can
propagate one exact version property. Captured changelogs and new task-owned
developer fragments remain supported. This narrow profile is not a classifier for
arbitrary build systems that execute documentation.

Use the normal TDD workflow for work that changes code or controls. Documentation
still requires every captured build, ticket, smoke, regression and human gate.
Complete its commit and proof before standalone Merge Prep imports upstream code.
Do not create another task, edit signed policy, or manufacture a red test to recover
an existing documentation task.

## Original objectives and task consent

Captain keeps the exact human request and its objective lines separately from the agent-supplied implementation objective. Prompt hooks capture repository-bound source events even before a task exists; intent adapters bind them to the validated task. `captain_issue_intent` accepts `request_kind: "goal"` for a user-requested goal and an optional `source_request_id` from the prompt hook. These are internal adapter fields, not phrases the human must repeat.

Issuance, status, failed-Begin diagnosis and signed pause/resume return `user_request` context automatically. `captain_user_request_status` provides read-only lookup for an exact repository and task. Its `expected_scope_sha256` and `expected_target_branch` selectors make mismatches visible. Requests such as "do it" continue an existing authorized task; ordinary supporting steps retain the defining objective and the source history. Sessions and elapsed time alone do not expire consent.

The record distinguishes expressed, unclear, revoked, stale and missing evidence. A source-only prompt does not create a task or approval for an unrelated operation. Later withdrawals and scope changes must be assessed against the original objective; "do not commit" restricts that operation without cancelling still-authorized implementation. Missing legacy records remain advisory. The caller still checks task ownership, recovery generations, current conditions and any declared human review. Source labels distinguish prompt-hook evidence from the client adapter's supplied wording; signatures protect recorded bytes and provenance rather than independently authenticating an adapter's human origin.

## Pending-work audit

Use the [pending-work skill](skills/pending-work/SKILL.md) to inventory unfinished
branch chains, dirty/detached worktrees, signed task/merge status, open decisions
and outstanding proof. Its bundled Git helper requires an explicit local target
and groups predecessor branches under their unmerged descendants. The audit
keeps integration, local installation, proof and human acceptance separate; it
does not authorize merging, cleanup or implementation of discovered work.

## Merge Prep and Merge Back

Integration uses two explicit MCP operations in the existing task checkout:

Merge Begin is an alias for Merge Prep; Merge Finish is an alias for Merge Back.
The MCP aliases are `captain_merge_begin` and `captain_merge_finish`. They use the
same arguments, signed `merge_id`, checks, and authorization rules as the canonical
tools. Either spelling can continue an operation started with the other spelling.

- `captain_merge_prep` pins the local target, pulls it into the source through an audited
  no-commit merge, retains conflicts for source-side resolution, and runs the existing
  strictness checks after the result is committed. It stops at signed `ready` with the
  target unchanged. Continue the same `merge_id`; do not replace the task worktree.
- `captain_merge_back` consumes that readiness, checks the exact prepared pair and current
  inputs, then fast-forwards the target without repeating Prep checks. Run it only with
  matching user integration authorization. `captain_merge_status` exposes the current record.
- `captain_recover_merge_lease` releases stale merge-operation and its associated
  integration-worktree/branch leases after checking the merge ID, signed revision,
  source/target identity, session, pinned bindings, and exact operation lease token. New
  leases include owner process metadata and cannot be recovered while that process is alive.
  Legacy leases require explicit confirmation that their owner stopped. Resume with the same
  `merge_id`; recovery leaves the merge ledger and Git refs unchanged.

`captain_merge_status.operation_lease` reports signed owner metadata and the exact
`recovery.args` for this operation. A stopped local process needs no confirmation;
a legacy owner must be independently verified before setting `confirm_owner_stopped`.
Live, foreign or unknown owners remain protected. Rejected continuations point back
to status, so recovery can proceed without internal storage inspection or asking the
human for identifiers. Keep the signed target and existing authorization. After Prep
is ready, continue through Back when matching integration authority already applies;
a Prep-only request stops at readiness.

Merge readiness and Git integration are separate from signed implementation `complete/green`,
human plan acceptance and release proof. A completed implementation run retains its original
proof; integration has its own signed record. Caller-supplied commands cannot replace gates.
The existing `captain_prepare_merge`/`captain_abort_merge` tools retain their low-level contracts
for current implementation clients. A request for Merge Prep never implies Merge Back.

### Active implementation association and legacy recovery

A standalone Prep commit is recorded as an intermediate commit of its exact owned
implementation in its running `implement` phase and live owning session. Paused,
proof and HITL phases are not reopened. Its signed merge provenance remains available to later ordinary
commits. Existing proof stays at its tested revision; the association grants no
`complete/green`, HITL acceptance, Merge Back authorization or push authority.

For an older preparation whose implementation ledger still names the pre-Prep
commit, call `captain_reconcile_merge_implementation` with the existing `merge_id`,
`session_id` and implementation `intent_id`. It authenticates the signed prepared
commit and original parent bindings under the merge and lifecycle fences. It
changes neither Git refs nor source files. Foreign ownership, unsigned commits,
dirty source, changed source HEAD/tree and unsupported target advances remain
refused. An already completed
fast-forward is recoverable only when the target exactly equals the signed
prepared source; Back must separately acknowledge that integration without rerunning
Prep gates. Use the same operation and worktrees throughout recovery.

A rejected bookkeeping request can be forgotten only when its journal and attempt
state prove mutation never started. Started or held attempts retain their normal
recovery requirements; a clean checkout alone is insufficient to discard them.

## Tracked bookkeeping and captain.ignore

Commit `.captain-sdlc/captain.ignore` and opt in through the repository's trusted commit policy:

```json
"bookkeeping": { "path_file": ".captain-sdlc/captain.ignore" }
```

The file contains one Git ignore pattern per line; blank lines, `#` comments, `*`, `**`, directory rules and `!` exclusions use Git's parser. See [the starter file](templates/captain.ignore). These are Captain bookkeeping exclusions: the files remain tracked by Git. The rule file and policy adoption/change use ordinary versioned commits. Existing captured runs do not gain new exclusions retroactively.

Rules may narrow supported notebook, handoff, closeout, text-evidence and `Churn/*.md` paths. A fixed ceiling refuses product/control files regardless of broad patterns, as well as binary files, symlinks, executable modes and mixed changes. Frozen plans, AGENTS.md, hooks, dependency locks, version surfaces and changelogs remain governed normally.

`captain_finalize_bookkeeping` accepts `worktree`, `session_id`, `task_id`, exact `paths`, a `docs(captain): ...` or `chore(captain): ...` subject, and `disposition: "commit" | "stash"`. A commit retains version/changelog unchanged and carries the configured task trailer. A stash retains tracked and untracked selected records under a correlation marker and exact `stash_oid`; it is never dropped automatically. All dirty/staged paths must belong to the explicit selection. Another active task or foreign branch lease is refused. Completed implementation proof remains untouched.

The receipt's `finalization_id` can be read with `captain_bookkeeping_status` and reused to recover an interrupted request. Keep the same selection and ID after mutation starts. A completed ID refers to its old records; omit it to finalize newly changed records with a fresh generation.

Merge Prep and Back accept `finalization: { source?: selection, target?: selection }`, using the same selection fields without worktree/session. Necessary task-owned finalization is part of an authorized Prep/Back request; no repeated conversational approval is needed. Commit source records or park target records before clean binding checks. A target bookkeeping commit must be reconciled through Prep in the source; Back can park target dirt with a retained stash.

After readiness, audited record-only descendants can inherit existing checks through `integration_inputs`. `ready_inputs` and gate evidence retain the tested revision. Product/policy/dependency changes and raw ignored product inputs still invalidate readiness. Report tested and integrated revisions separately. [Decision rationale](docs/decisions/0001-captain-bookkeeping-exclusions.md).

## Read-only Begin diagnosis

`captain_begin_diagnose` inspects an exact caller-owned startup using `intent_id`,
`session_id`, `project_root`, `target_worktree` and `target_branch`. It verifies
existing signed intent, issuance, startup checkpoints and lease history, then checks
the matching Git checkout. It reports the observed startup stage, binding results,
later state and an opaque lease generation without creating authority keys, repairing
records, publishing watermarks or changing Git state.

Missing or foreign ownership returns a generic unavailable result. A held legacy
lease remains unproven; this diagnostic neither establishes that its owner stopped
nor releases it. Continue the existing operation only through a supported recovery
that verifies ownership and protects startup progress. This tool does not grant
Merge Back or push authorization.

## Failed Begin cancellation

`captain_cancel_failed_begin` accepts the exact caller-owned startup and target
bindings used by `captain_begin_diagnose`, plus its observed lease revision,
opaque resource generation, and `confirm_owner_stopped: true`. The confirmation
means the failed logical startup invocation has ended and no same-intent call is
running or will be retried; an idle MCP server does not need to exit.

Cancellation verifies the signed producer chain and current Git bindings, refuses
foreign ownership or startup progress, and serializes against current-version
startup retries. It writes a signed terminal reservation before releasing only
the inspected lease generation. A repeated matching cancellation is idempotent
and cannot release a replacement lease. Older plugin binaries do not understand
the cancellation marker; callers must not replay that retired intent through them.
Git refs and working files remain unchanged. Continue the existing Merge Prep;
this operation grants no Merge Back or push authorization.

## Routing and emergency control

Ordinary requests are never governed. To start a governed worktree run, put a standalone task directive in the request: `[Captain plan: TASK-ID]`; add `[Captain target: branch]` when the plan must integrate a specific local branch.

## Handoff, pause, and resume

### OpenCode (first-class adapter)

Captain includes an OpenCode plugin adapter at `opencode/captain-sdlc.mjs`. It detects implementation requests, issues a signed intent for the current OpenCode session, injects the exact begin/resume call, and rejects direct mutation tools until that call has granted a permit. Register the bundled MCP server and adapter globally; individual repositories do not need a custom `AGENTS.md` for the lifecycle to apply.

Captain owns operational work memory; repositories do not need custom `AGENTS.md` rules to hand work to another agent. Call `captain_pause_implementation` with a concise summary, completed and next steps, blockers, plan/phase, and any context worth preserving. Captain adds the signed run identity, canonical worktree/branch, current source state, and evidence ledger, releases the session lease, and returns a resume directive.

The human can say "continue" or "resume". The agent resolves the existing task
through `captain_doctor` and its signed handoff, then issues a resume intent for
that run and restores the same worktree. The handoff retains this internal handle:

```text
[Captain resume: intent-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx]
```

The adapter mints a fresh one-time resume token; the agent calls
`captain_resume_implementation` with that token before any mutation. The human
does not need to reproduce the handle. If several tasks match, ask which task to
continue. A paused handoff may identify a dependency task; preserve the original
task's scope and authorization when resolving that dependency.

Ordinary recovery uses the public recovery tools with controls enabled. Emergency
hook control requires separate explicit human authorization. For that authorized
case only, the installed `scripts/hook-control.mjs` exposes `status`, `off` and
`on`; retain the prior state and restore it after recovery. Commit or merge
authority alone does not authorize disabling hooks.

## Local verification

On Windows, `npm run build` also compiles the GUI-subsystem hook launcher using
the installed .NET Framework compiler. `npm run test:windows` verifies its pipe,
argument, exit-code, mutation-denial, and cancellation behavior. Set
`CAPTAIN_TEST_WINDOWS_LAUNCHER=1` to run the existing hook regression tests through
the launcher. The Windows hook overrides preserve synchronous decisions and
launch Node with `CREATE_NO_WINDOW`; internal Git and gate subprocesses use
`windowsHide: true`. Changed hook definitions require a fresh Codex trust review.

```powershell
npm install
npm test
npm run typecheck
npm run smoke
```

## Installation

New worktrees use bounded generated output slots and automatic cleanup after a
completed merge. This applies to ordinary projects as well as runtime-enrolled
repositories. See the [worktree storage skill](skills/worktree-storage/SKILL.md)
and [storage policy](docs/decisions/0003-bounded-worktree-storage.md) for fixed
output paths, compact proof retention, active task protection and retained-path
reporting. Existing unregistered worktrees are excluded from cleanup.

From the Captain SDLC repository root:

```powershell
codex plugin marketplace add .
codex plugin add captain-sdlc@personal
```

Codex intentionally skips changed hooks until their new hash is trusted; review
any actual hook trust prompt. A conversation's MCP inventory may retain an older
tool list after installation. The agent can use the installed server's public MCP
transport with the existing plugin data directory, verify its advertised version
and tool schema, and continue the same authorized operation. A new thread is
optional for refreshing the host's inventory, not a prerequisite for using the
installed public tools. Preserve hook decisions and the original signed task
and merge bindings.

## Read-only merge diagnosis

When the initial Prep call fails after saving its signed operation, its error includes the durable `merge_id` and an exact `captain_merge_status` next step for the same session. Pre-validation failures do not claim a saved operation.

If the operation ID is unavailable, call `captain_merge_diagnose` with the actual `session_id`, `source_worktree`, `target_worktree`, and `target_branch`. It returns all matching caller-owned operations and limited target lease owner metadata. Diagnosis verifies existing signatures, chains and watermarks without writing authority or Git state; it does not establish readiness or grant recovery rights.

## Ticket selection and interrupted clients

A LOW task may pass `ticket_filter` to `captain_record_red`. Captain changes only the single literal `-TestFilter` argument in the captured trusted runner, binds the actual command and policy digest to the run, and reuses that binding for green ticket checks. Captured policy and final Build gates remain unchanged. Other profiles and arbitrary command overrides remain unsupported.

A client close or crash preserves the same run, phase, worktree, unfinished work, frozen scope and evidence. A resume adapter first selects only the matching signed repository/task, then resumes its retained checkout. It never allocates a replacement because a session ended.

Clients with process identity support supply their actual `client_pid` on Begin/Resume or call `captain_bind_session_owner`. Captain obtains host and process start from the OS. Never supply the temporary MCP/helper server PID. Clients with long-lived host processes also generate a private random close token and bind its SHA256 as `close_token_hash`; keep the raw token client-side.

`captain_session_interruption_status` returns read-only diagnosis and exact generation selectors. A positively stopped recorded client can be recovered automatically on cross-session resume or explicitly through `captain_recover_interrupted_session`. Graceful panel closure uses `captain_record_session_closed` with the private token, exact selectors, concise summary and next actions. Both produce the existing signed pause handoff, then ordinary resume transfers the retained task. Stop remains a turn completion event; it is never mistaken for session closure.

Clients that do not expose a client process or authenticated close notification cannot be diagnosed as crashed from elapsed time or MCP process lifetime. Legacy, live, foreign-host and unknown ownership remains protected. This does not change ordinary same-session continuation or already-paused resume.

Recovery discovery through `captain_doctor` returns a compact handoff index:
identity, objective, current phase, next steps, blockers, context, source head/tree,
`evidenceCount` and exact `handoffId`. Full signed source snapshots and evidence
remain in the authority store and are used by ordinary resume. Large retained
handoffs therefore do not overflow the MCP message buffer during task discovery.

## Orphan branch reservations

When the ordinary task/merge recovery APIs cannot identify a legacy target lease,
call `captain_branch_lease_diagnose` with `project_root`, `target_worktree`,
`target_branch` and the actual `session_id`. The read-only tool authenticates the
lease generation and Git binding, then checks for surviving authority, task
workspaces and unfinished Git operations. A missing run or elapsed time alone
does not qualify. Raw pre-revision storage must explicitly bind its repository,
branch and historical commit.

For a diagnosed orphan and existing explicit repossession direction, call
`captain_repossess_branch_lease` with its exact `recovery.args`, a concrete `reason`
and the original `user_authorization`. This records operator-directed repossession;
it does not manufacture stopped-owner evidence. The signed tombstone fences the
old intent and exact-generation release protects replacements and interrupted
retries. Surviving requests, runs, workspaces and active/foreign owners remain
refused. Do not replace a refused operation with raw authority-file edits.

Continue the original authorized Prep in the same source and target checkouts.
Normal Prep acquires a fresh branch lease. Recovery creates no worktree, changes
no Git refs/index/files, and does not grant merge-back or push authority. See
[the decision](docs/decisions/0002-orphan-branch-lease-repossession.md).

## Failed pre-workspace Begin reservations

A surviving Begin record is verified separately from an orphan. Use
`captain_failed_begin_lease_diagnose` with the actual primary root, target
checkout/branch and current operator session. It authenticates the original
issuance, recorded root/session, reservation and lease checkpoints without
rewriting those bindings. A wrong issued root remains visible in the retained
history; the actual target binding is checked independently. A legitimate target
advance does not invalidate the original signed graph: its historical commit must
still exist and all original checkpoints must agree. Recovery separately pins
the current HEAD and refuses a concurrent change.

An authenticated projection for a different paused task can remain present while
its session lease is released. The operator diagnostic reports that broad active
flag honestly and verifies the latest signed task/activation correlation separately.
Such a task can coexist with retirement of this unstarted request when every
original reference is absent and it owns no actual target resource. Recovery
preserves its task, projection and session records unchanged; running, ambiguous,
original or actual-target ownership remains refused.

A saved failed merge is not an exclusive target owner after its authenticated
operation and matching integration/mutation resources are released. The operator
path verifies its signed history, historical repository bindings and resource
states without changing it. Stale saved target locations and advanced source
HEADs remain retained evidence. Unknown state, retained preparation, pending Git
work or a held matching merge resource still refuses recovery. Any unrelated
held source reservation must match the recognized legacy producer shape and
remain untouched. Ordinary Merge Prep and Back keep their existing binding and
readiness checks.

Only a verified terminal pre-workspace reservation with no task checkout,
progressed run, activation, permit, active attempt or unfinished Git state can
receive operator-revocation selectors. With explicit existing repossession
direction, call `captain_repossess_failed_begin` using the exact selectors,
concrete reason and original instruction. The separate signed operator record
does not assert that an unknown original client stopped. Its standard Begin
cancellation marker also fences older supported runtimes. Original records and
unrelated session ownership remain intact.

Released ready/preparing Merge Prep receipts likewise cease exclusive target ownership only when their saved target pin is a strict ancestor of the current target. Recovery authenticates every completed bookkeeping request against its latest signed receipt and rejects held bookkeeping resources. Source commits, staged/loose work and the old receipts remain unchanged. This retires only the unrelated terminal pre-workspace Begin reservation; it does not integrate or complete the retained task.

Then continue the original authorized Prep in the same task and target worktrees.
This companion does not extend orphan eligibility or permit takeover of active
or progressed work.
