# Plan lifecycle and bounded human review

Updated: 2026-09-26
Version: 1

Decision: Michael, 2026-09-26. Applies to plan execution and closeout.

| State | Entry | Scope changes |
| --- | --- | --- |
| Draft | Requirements are being developed | Allowed |
| Ready | Reviewable plan with numbered criteria and declared gates | Allowed before start |
| Working | Michael directs implementation; approval is accepted | Forbidden |
| HITL review | Declared provable segment is ready for its human checks | Forbidden |
| Completed | Original criteria and declared human checks are satisfied | Forbidden |

Pause/resume is execution status, not permission to edit the plan. Resume uses the same
run and worktree. Explicit cancellation/replacement is a human decision recorded separately.

## Starting

Pass selected committed plan files as `plan_paths` to Captain begin. The run binds their
contents at its base revision, together with mandatory policy `approvedPlanPaths`. Keep
the immutable specification separate from mutable progress and closure evidence. Inspect
the returned effective gates before implementing. Unbound legacy runs are not retroactively
frozen by this feature and must be described honestly.

## HITL belongs at the end of a provable segment

Declare checkpoints in the ready plan, then freeze them at start. Use one grouped review
for related goals. Agent-verifiable behavior is tested first. Ask for human review only
when that segment is staged and each human goal is concrete. Do not introduce another
HITL merely because an audit or implementation session ended.

Each goal has these fields (passed as `hitl_checks` at begin when required):

| Field | Required content |
| --- | --- |
| `id` | Stable review-goal identifier |
| `criterionId` | Original acceptance criterion, not a new requirement |
| `setup` | Scenario, initial state, automated proof completed, and remaining human question |
| `action` | Exact action Michael performs or behavior he observes |
| `expected` | Observable expected result and explicit pass/fail condition |
| `evidence` | Screenshot/video/log or written feedback to retain, with its revision |

Example format: "Criterion C2: the agent stages the approved building fixture and runs
placement assertions. Michael opens its Build Window and selects the declared item. Pass
if the selected item, cost and preview match C2; fail if any differs. Record Michael's
decision and the staged screenshot at the tested revision." Substitute the actual plan's
requirements; this example does not add a building requirement to any plan.

Present the goals, automated results, review instructions and evidence together. Retain
the staged scene/player state and pause at the agreed observation point. A demonstration
and hands-on UX evaluation remain separate goals when both were declared. Never record
human acceptance on Michael's behalf.

## Closing

Keep one closure record with original criterion IDs, outcomes, evidence revisions and
unresolved original failures. Separate signed proof status from human acceptance. Captain
can report proof complete/green while plan state remains HITL; it becomes completed only
after the declared human checks are accepted. HITL remains an active, discoverable phase
with the same worktree and ownership. Rejection returns that same run to implementation
for repair of its original criteria, followed by fresh proof and the declared review.
The frozen plan and earlier evidence are retained. Accepted plans are terminal; new
requirements still need separate human authorization.

Use a **Follow-ups for human review** section for new discoveries: finding, evidence,
impact, proposed next action. These are non-blocking. Once agreed work is complete, Michael
decides what to authorize next. Neither an agent nor a follow-up list can expand or reopen
the plan. A human review of follow-ups is not itself a completion gate.
