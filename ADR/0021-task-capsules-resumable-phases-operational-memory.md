# ADR-0021: Task capsules are the operational-memory boundary for resumable phases

**Date:** 2026-08-27

## Problem

Captain can enqueue work and preserve run evidence, but continuity is still too session-shaped.
Taskout is launched as an interactive terminal while flay is queued as an orchestrator workflow;
global `scratch.md`, transient worktrees, run logs, and one-off recovery directories each preserve a
different fragment of intent. Stopping midway can therefore lose the exact handoff, and resuming can
repeat research, overwrite the active workflow, or force a human to reconstruct state from chat and
Git history.

The desired operating model is broader than taskout or flay: nearly every phase should be possible
to start, stop, resume, or deliberately reorder. Worktrees and reviewed plans should make that safe,
while the human remains the authority on which task deserves attention next. Completed work should
also retain enough structured history to answer what happened, when, why, and with what result.

## Decision

The canonical unit of in-flight operational memory is a **task capsule**, keyed by the canonical task
ID from ADR-0015 and stored at the project root independently of any agent session or worktree:

```text
.captain-sdlc/tasks/<sanitized-task-id>/
  task.json          # immutable identity + authored scope/source
  state.json         # current phase, checkpoint, ownership, worktree, blockers
  journal.md         # append-oriented done/next/decisions narrative
  checkpoint.json    # latest machine-readable resume packet
  evidence/          # bounded task-local evidence references or small artifacts
  artifacts/         # taskout plans, summaries, review packets, handoffs
```

Large, sensitive, or globally shared evidence remains in the existing trace/side-store/run locations;
the capsule references it. The capsule is a read model and handoff boundary, not a duplicate evidence
database.

### 1. Task lifecycle and phase lifecycle are separate

Task lifecycle records assignment and outcome (`backlog`, `queued`, `active`, `paused`, `blocked`,
`review`, `done`, `abandoned`, `archived`). Phase lifecycle records the current workflow step and its
checkpoint (`taskout`, `plan`, `review-plan`, `implement`, `verify`, `HITL`, `commit`, or a configured
extension). A task may revisit a phase or move to another phase only when that transition's declared
prerequisites hold.

The phase vocabulary is extensible configuration. The transition rules are explicit data, not UI
conditionals or agent inference. Captain refuses an ambiguous, destructive, or prerequisite-breaking
jump and explains what must be satisfied.

### 2. Stop is a durable checkpoint, not task cancellation

An explicit Stop requests a checkpoint from the active phase. Before execution ownership is released,
the phase writes:

- work completed since the previous checkpoint;
- exact next action;
- blockers, questions, and human decisions needed;
- plan/revision and worktree/base/head identity;
- dirty/untracked state and recovery artifact references;
- verification already run and its evidence;
- current phase plus allowed next transitions.

Provider lifecycle hooks bracket cooperative phases: a begin hook binds the session/turn to the task
capsule and an end/Stop hook refuses a bare exit until the checkpoint contract is met. Hard death is
still possible, so the daemon/orchestrator writes a mechanical fallback checkpoint from observable
worktree, run, and lease state and marks it `recovery_required`; hooks are not the sole durability
mechanism.

### 3. Resume reads operational memory before acting

Resume reacquires the same task ID, validates or reconstructs its worktree, reads `checkpoint.json`
and `journal.md`, verifies that referenced plan/base/head state has not drifted, and only then invokes
the selected phase adapter. A new agent session is expected; session identity is never task identity.

If the worktree is missing, the orchestrator restores from the committed base plus recorded WIP patch
or artifacts where possible. If safe reconstruction cannot be proven, the task becomes
`recovery_required`/`needs_human`; Captain does not silently restart from scratch.

### 4. Priority is human-owned and independent of pause/resume

The execution state machine owns continuity and correctness. The portfolio queue owns priority.
Automation may surface candidates, prerequisites, age, cost, or consequences, but it must not infer
taste and silently reorder tasks. The human chooses what starts or resumes next and may deliberately
preempt one task for another.

Stopping a task preserves its priority unless the human changes it. Pausing does not mean demoting;
resuming does not imply that the task should jump the queue. This preserves ADR-0012's boundary: tools
own correctness, the human owns taste.

### 5. Dashboards are clients of one transition API

Captain Bridge remains the canonical command/queue launcher. Captain Notes may browse plans, decisions,
questions, archives, and task capsules, but it requests `enqueue`, `start-phase`, `stop`, `resume`,
`transition`, or `archive` through Bridge's typed API. Neither dashboard writes queue, lease, run, or
task state independently.

Taskout and flay become phase adapters under the same protocol. Taskout may remain interactive, but
its begin/end hooks hold the task capsule and workflow identity for the interview; flay uses the same
checkpoint contract in its worktree. A newly enqueued action cannot overwrite another active phase of
the same task.

### 6. Milestone and spike association is typed state projected as tags

Plans, notes, decisions, and tasks may carry namespaced relationship tags such as
`milestone:M03_COLONY`, `spike:colony`, and `task:<canonical-task-id>`, alongside ordinary descriptive
tags such as `health` or `ui`. Captain Notes owns the convenient tagging/browsing projection; tags are
not themselves orchestration authority.

At enqueue or transition, Bridge resolves namespaced tags against the project's canonical roadmap and
configured spike registry/branch conventions, then writes typed capsule relationships (`milestone_ids[]`,
`spike_ids[]`, source document/note IDs). Unknown or ambiguous relationship tags are rejected or held
for human correction rather than silently creating a new milestone/spike. The orchestrator consumes
the typed relationships for prerequisites, grouping, and evidence; it does not parse UI tags during
execution.

Multiple relationships are permitted because a task may carry work between milestones or contribute
to a cross-cutting spike. One may be marked primary for presentation and accounting. Changing the
primary milestone/spike is a human-owned scope/priority decision and is journaled.

### 7. Completion archives operational memory for post-analysis

On terminal completion, Captain writes a final summary containing outcome, scope delivered, key
decisions, phase timeline, timestamps/durations, models/tools used, verification and HITL evidence,
commits/PRs, unresolved follow-ups, and cost/attempt data where available. The active capsule then
transitions to an immutable archived representation; later annotations append rather than rewrite the
historical record.

Archived capsules support post-analysis such as cycle time by phase, repeated blockers, estimate
accuracy, resume effectiveness, model/substrate performance, and the provenance of a shipped decision.
This analysis is advisory: it may improve candidate presentation, but it does not take priority/taste
authority away from the human.

## Minimum schema invariants

- Every machine-readable capsule file carries integer `schema_version`; consumers refuse unknown
  versions.
- `task_id` is canonical and stable; directory sanitization is reversible through `task.json`.
- State writes are atomic and include a monotonic revision to reject stale dashboard/session writes.
- Exactly one active execution owner/lease exists per task; any number of paused capsules may exist.
- Journal entries are timestamped and append-oriented; checkpoint replacement never deletes history.
- Worktree identity includes project root, path, base commit, current head, and dirty-state digest.
- Human priority changes and phase transition requests are auditable events with actor and timestamp.
- Namespaced relationship tags resolve to typed milestone/spike links before execution begins.
- Archive never destroys source plans, notes, evidence, or capsule history; it records references.

## Ownership

- **Captain Core:** versioned task/state/checkpoint/transition contracts and validation.
- **Captain Orchestrator:** transition execution, worktree validation/recovery, checkpoint coordination.
- **Captain Daemon:** leases, hard-death fallback checkpoints, scheduling of human-authorized priority.
- **Captain Bridge:** canonical transition API and fleet operating surface.
- **Captain Notes:** plan/note/archive/task-memory projection and Bridge client controls.
- **Provider hooks/adapters:** cooperative begin/end checkpoint production; never canonical ownership.

## Alternatives

- **Keep one global `scratch.md`.** Rejected: multiple paused tasks overwrite context, lack task
  identity, and cannot be archived or analyzed reliably.
- **Use run logs as memory.** Rejected: logs describe execution exhaust, not authored next action,
  blockers, decisions, or safe resume state.
- **Bind continuity to the agent session.** Rejected: sessions die, compact, switch providers, and are
  not the stable unit of work.
- **Let each dashboard write queue/state directly.** Rejected: creates multiple writers and race-prone
  workflow overwrite; Bridge remains the command boundary.
- **Automatically choose the next task from metrics.** Rejected: useful evidence does not transfer
  taste/priority authority from the human.
- **Depend only on Stop hooks.** Rejected: process death bypasses hooks; mechanical fallback
  checkpointing remains mandatory.
