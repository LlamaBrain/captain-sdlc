# ADR-0022: Approved scope is immutable; tasks resume in their owned worktree

Updated: 2026-09-26
Version: 1
Status: Accepted by Michael, 2026-09-26

## Problem

Approved work has accumulated requirements and verification gates during implementation.
Repeated intent creation and worktree allocation also lose continuity between work sessions.
These behaviors delay closure even when the originally agreed work can be finished.

## Solution

Approval followed by implementation freezes the plan's scope, criteria, phase assignments
and definition of done. Agents cannot extend that agreement. A defect against an existing
criterion is repaired under its original ID. A new requirement, improvement or unrelated
finding goes into the separate closeout record's non-blocking follow-up section.

Plan states are draft, ready, working, optional HITL review, and completed. Draft/ready are editable. The human's
instruction to start accepts approval and enters working without another approval exchange.
Beginning with selected `plan_paths` binds their committed content; configured policy paths
remain mandatory. Pausing execution leaves plan state working and immutable. Completed plans
stay frozen; subsequent work uses another plan. Legacy runs without bindings remain unbound.

Declare HITL goals before start and group them at the end of each provable segment, after
automated proof. Each goal names an original criterion, setup, exact human action, observable
expected result with pass/fail conditions, and evidence. No vague or repeated ad hoc human
checks. HITL stays frozen and retains the active run/worktree after automated proof.
Pause/resume preserves that review state. Rejection returns the same run to implementation
for original-criterion repairs and fresh proof; actual human acceptance completes the review. See
[the review format](../plan-lifecycle.md). New human requests remain follow-ups.

After the agreed work is complete, the human chooses which follow-ups become separately
authorized work. That review is not another closure gate. Human cancellation or replacement
remains possible but must be recorded explicitly; agents cannot silently amend the plan.

The approved plan and progress record have different purposes. Keep one mutable progress
record containing criterion IDs, owners, next actions and evidence at actual revisions.
Bind approved plan paths and content hashes into the signed run from trusted policy. Reject
changes before execution, commit or proof. Existing unbound runs must disclose that limit.

Disclose required gates before implementation. Distinguish item completion, phase acceptance,
integration readiness and release proof. Preserve explicit requirements and signed proof
semantics; do not import later gates or present a partial status as complete/green. Reuse
valid evidence with its original revision and record concrete invalidators before reruns.

A task retains its worktree, branch, dirty owned work and evidence across pause/resume.
Resume direction may be ordinary language; adapters resolve the task and handle intent
tokens internally. Ambiguity and conflicting live ownership require specific diagnosis.
Never silently choose another task, steal an active lease, or allocate a replacement worktree.
Pause stores a concise handoff; resume verifies identity and continues its next action.
Repeated identical adapter requests in the same session/turn reuse a signed issuance receipt;
they neither repin the target nor reset a consumed token. Changed requests need a new turn.

Retry a failed operation only after a relevant input or diagnosed cause changes. After
three failed approaches record the blocker and owner/action. Keep disposable automation
arguments in ignored task scratch folders, distinct from durable evidence and handoffs.

## Alternatives

- Continually extend the checklist: rejected because it prevents a bounded completion decision.
- Treat every discovery as a blocker: rejected because it lets agents replace human scope.
- Start a fresh intent/worktree per session: rejected because it loses task continuity.
- Remove proof gates to accelerate closure: rejected; completion claims still require evidence.

## Implementation boundary

The Captain plugin enforces hashes for selected or configured approved plans and discloses
unbound legacy runs. This is file integrity enforcement, not semantic detection of every
possible scope addition elsewhere. Agent instructions enforce the follow-up boundary.
The adapter resolves unique same-repository resume candidates and preserves lease checks.
Explicit resume can restore a legacy green run with pending declared HITL to review after
ownership and worktree checks. It does not bind previously unbound plans or alter their contents.
