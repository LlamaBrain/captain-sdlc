# M38 - CAPTAIN_DAEMON_HARDENING
Status: Stub
Last Updated: 2026-07-07

## Definition of Done
- [ ] Daemon handles stale leases according to explicit policy.
- [ ] Daemon detects and reports abandoned worktrees without deleting uncertain state.
- [ ] Daemon enforces one active run per task/project invariant.
- [ ] Queue polling, idle detection, backoff, pause, disable, and shutdown behavior are configured and tested.
- [ ] Daemon records child process crash, timeout, cancellation, and restart decisions as daemon events.
- [ ] Daemon can run as a resident process while preserving deterministic `tick` behavior.
- [ ] Tests prove duplicate prevention, stale lease handling, disabled mode, pause behavior, and crash evidence.
- [ ] Daemon still does not route, call workers, evaluate output, or bypass review gates.

## Theme
The daemon becomes safe to leave running. It is the resident supervisor for the
already-working orchestrator, not a second orchestrator.

## Goals
- Make fire-and-forget operation operationally safe.
- Prevent duplicate or runaway runs.
- Preserve manual CLI orchestration as a fallback.

## Targeted
- Stale lease supervisor.
- Worktree/run janitor policy.
- Pause/disable config.
- Crash and cancellation events.
- Resident service hardening.

## Blockers & Dependencies
- **Upstream**: M33_CAPTAIN_DAEMON_HEARTBEAT.
- **Downstream**: M39_CAPTAIN_REVIEW_AND_PR_GATE.

## References
- `../captain-orchestration-layer.md`
- `./M33_CAPTAIN_DAEMON_HEARTBEAT.md`
- Top-level index: `../roadmap.md`
