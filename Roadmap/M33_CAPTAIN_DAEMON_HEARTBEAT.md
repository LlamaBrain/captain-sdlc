# M33 - CAPTAIN_DAEMON_HEARTBEAT
Status: Shipped
Last Updated: 2026-07-08

## Definition of Done
- [x] `captain-daemon` has a resident process shell with explicit start/stop semantics.
- [x] The first role is heartbeat/tick scheduling for already-working `captain-orchestrator` CLI runs.
- [x] Daemon reads queue policy and assigned work without inventing task scope or task ids.
- [x] Daemon claims/leases eligible work through Captain Core-compatible run state.
- [x] Daemon prevents duplicate runs using run identity and lease/claim data.
- [x] Daemon wakes `captain-orchestrator run ...` as a child process rather than calling worker adapters directly.
- [x] Daemon tracks child process completion, timeout, cancellation, and crash evidence.
- [x] Daemon enforces configured budgets and records budget exhaustion as a terminal state.
- [x] Daemon detects stale claims and abandoned worktrees according to policy.
- [x] Daemon surfaces `needs_human` / review-required states without continuing automatically.
- [x] Daemon can be disabled without breaking manual CLI orchestration.

### Verification (2026-07-07)
First executable heartbeat implemented in C# in
`https://github.com/LlamaBrain/captain-daemon`:
- `captain-daemon tick` runs one deterministic heartbeat.
- `captain-daemon serve` runs the resident loop with Ctrl+C stop behavior.
- The daemon uses a soft command contract to wake `captain-orchestrator`.
- End-to-end smoke produced one daemon event, one orchestrator run record, and five evidence packets.

Daemon hardening follow-through:
- Stale claims are now stopped as `stale_claim` daemon events. Possible abandoned worktrees are reported but not deleted.
- `needs_human` / `review_required` leases and child-process output now stop automatic continuation.
- Deeper janitor policy, pause/disable/backoff, and crash restart policy shipped in M38.
- Notifier/review handoff behavior remains tracked in M39.

Additional verification (2026-07-07):
- `dotnet build Captain.Daemon.sln --no-restore`
- `dotnet run --project tests\Captain.Daemon.Tests\Captain.Daemon.Tests.csproj --no-build`

Completion evidence (2026-07-08):
- `captain-daemon` commit `3312c8c` added the heartbeat daemon runtime.
- `captain-daemon` commit `aceee05` added TDD loop passthrough without moving loop logic into the daemon.
- `captain-daemon` commit `ad99f34` hardened heartbeat supervision and completed stale/abandoned/disable/pause/crash evidence.

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
