# M38 - CAPTAIN_DAEMON_HARDENING
Status: Shipped
Last Updated: 2026-07-09

## Definition of Done
- [x] Daemon handles stale leases according to explicit policy.
- [x] Daemon detects and reports abandoned worktrees without deleting uncertain state.
- [x] Daemon enforces one active run per task/project invariant.
- [x] Queue polling, idle detection, backoff, pause, disable, and shutdown behavior are configured and tested.
- [x] Daemon records child process crash, timeout, cancellation, and restart decisions as daemon events.
- [x] Daemon can run as a resident process while preserving deterministic `tick` behavior.
- [x] Tests prove duplicate prevention, stale lease handling, disabled mode, pause behavior, and crash evidence.
- [x] Daemon still does not route, call workers, evaluate output, or bypass review gates.

### Verification (2026-07-08)
Implemented in `captain-daemon`:
- Stale `claimed` leases expire to `stale_claim` with daemon event evidence and restart decision.
- Possible abandoned worktrees are reported as `abandoned` events and are not deleted.
- Active leases prevent duplicate runs for both the same task and the same project.
- `tick` supports idle, disabled, and paused states; `serve` keeps deterministic tick behavior with interval/backoff and Ctrl+C shutdown.
- Child timeout, cancellation, crash/failure, and restart decision are recorded as daemon events.

Verified:
- `dotnet build Captain.Daemon.sln --no-restore`
- `dotnet run --project tests\Captain.Daemon.Tests\Captain.Daemon.Tests.csproj`

Implementation evidence:
- `captain-daemon` commit `ad99f34` hardens heartbeat supervision.

### Follow-up (2026-07-09)
Supervision now extends to local model infrastructure (`captain-daemon` commit
`d6f3425`): a model in `route-config.json` may declare
`local_server {health_url, start_command, startup_timeout_seconds}`; before
dispatching a run on that model the daemon curl-checks the health URL, fires
the (non-blocking) start command when the server is down, and polls until
healthy. A server that never comes up parks the task `needs_human` with an
explicit reason instead of burning the worker timeout. Found while dogfooding:
an idle LlamaCPP server made `opencode` hang silently for the full 600s worker
budget.

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
