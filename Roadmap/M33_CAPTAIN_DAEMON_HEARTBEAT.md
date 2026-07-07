# M33 - CAPTAIN_DAEMON_HEARTBEAT
Status: Stub
Last Updated: 2026-07-07

## Definition of Done
- [ ] `captain-daemon` has a resident process shell with explicit start/stop semantics.
- [ ] The first role is heartbeat/tick scheduling for already-working `captain-orchestrator` CLI runs.
- [ ] Daemon reads queue policy and assigned work without inventing task scope or task ids.
- [ ] Daemon claims/leases eligible work through Captain Core-compatible run state.
- [ ] Daemon prevents duplicate runs using run identity and lease/claim data.
- [ ] Daemon wakes `captain-orchestrator run ...` as a child process rather than calling worker adapters directly.
- [ ] Daemon tracks child process completion, timeout, cancellation, and crash evidence.
- [ ] Daemon enforces configured budgets and records budget exhaustion as a terminal state.
- [ ] Daemon detects stale claims and abandoned worktrees according to policy.
- [ ] Daemon surfaces `needs_human` / review-required states without continuing automatically.
- [ ] Daemon can be disabled without breaking manual CLI orchestration.

## Theme
Captain Daemon is the resident service host. Heartbeat/tick is its first role:
schedule, claim, wake, supervise, and stop. It is not the orchestrator and it
does not own route selection, worker execution, result evaluation, or taste.

## Goals
- Add always-on scheduling after the deterministic CLI runner is proven.
- Keep core orchestration logic in `captain-orchestrator`.
- Make idle detection, duplicate prevention, stale-claim handling, and budget enforcement operational.
- Leave room for later daemon roles: notifier, janitor, trace/evidence tailer, config reload watcher, and child-process supervisor.

## Targeted
- Resident process shell.
- Heartbeat/tick scheduler.
- Queue watcher.
- Idle detector.
- Run lease/claim supervisor.
- Duplicate-run guard.
- Budget supervisor.
- Orchestrator wake-up dispatcher.
- Child process supervisor.
- Stale worktree/run janitor.

## Blockers & Dependencies
- **Upstream**: M29_CAPTAIN_CORE_RUNTIME in `captain-orchestrator`.
- **Upstream**: M30_CAPTAIN_ORCHESTRATOR_CLI in `captain-orchestrator`.
- **Upstream**: M31_CAPTAIN_TOOL_ADAPTERS first adapter slice in `captain-orchestrator`.
- **Upstream**: M32_CAPTAIN_REVIEW_SURFACE.

## References
- `../captain-orchestration-layer.md`
- `https://github.com/LlamaBrain/captain-daemon`
- `https://github.com/LlamaBrain/captain-orchestrator`
- Top-level index: `../roadmap.md`
