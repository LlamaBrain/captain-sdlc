# M34 - CAPTAIN_ROUTE_SELECTED_WORKERS
Status: Shipped
Last Updated: 2026-07-08

## Definition of Done
- [x] `captain-orchestrator` has a worker adapter registry keyed by route adapter name.
- [x] The orchestrator selects the worker from `RoutingPolicy` / `RouteRule.Adapter`, not from one injected worker instance.
- [x] The selected adapter name is recorded in run phases, worker attempts, and evidence.
- [x] Missing or disabled adapters stop safely with a normalized terminal state and reviewable evidence.
- [x] Tests prove route `noop` invokes the no-op worker.
- [x] Tests prove route `local-qwen` can select a local worker adapter without invoking a frontier route.
- [x] Tests prove route `frontier` can select a frontier worker adapter when policy matches complexity.
- [x] Daemon behavior is unchanged: it wakes the orchestrator and does not choose workers.

### Verification (2026-07-07)
First route-selected dispatch slice implemented in `captain-orchestrator`:
- `IWorkerAdapterRegistry` and `WorkerAdapterRegistry` select workers by `RouteRule.Adapter`.
- The CLI uses the default registry with `noop`.
- Missing adapters record evidence and end as `needs_human`.
- Tests cover route-selected `local-qwen` dispatch and missing `frontier` adapter safety.
- Command-worker tests cover positive `frontier` selection.
- Daemon tests assert heartbeat wakes `captain-orchestrator run ...` without choosing worker commands, local workers, or frontier workers.

Verified:
- `dotnet build Captain.Orchestrator.sln --no-restore`
- `dotnet run --project tests\Captain.Orchestrator.Tests\Captain.Orchestrator.Tests.csproj --no-build`
- `dotnet build Captain.Daemon.sln --no-restore`
- `dotnet run --project tests\Captain.Daemon.Tests\Captain.Daemon.Tests.csproj --no-build`

Implementation evidence (2026-07-08):
- `captain-orchestrator` commit `043b56c` adds `IWorkerAdapterRegistry` / `WorkerAdapterRegistry`, route adapter lookup, missing-adapter `needs_human` evidence, and route-selected worker tests.

Still open for M34 completion:
- None for this milestone slice. Real frontier command configuration and escalation policy continue in M35/M37.

## Theme
Route policy becomes executable. The orchestrator must not merely record a route;
it must use the route to choose the worker boundary that will attempt the task.

## Goals
- Make local-vs-frontier selection mechanically testable.
- Keep worker implementation behind adapter contracts.
- Make missing capability a safe terminal state, not an accidental no-op.

## Targeted
- Worker adapter registry.
- Route-selected adapter dispatch.
- Missing-adapter evidence.
- Local/frontier policy tests with fake adapters.

## Blockers & Dependencies
- **Upstream**: M30_CAPTAIN_ORCHESTRATOR_CLI.
- **Upstream**: M31_CAPTAIN_TOOL_ADAPTERS.
- **Downstream**: M35_CAPTAIN_COMMAND_WORKER_ADAPTERS.
- **Downstream**: M37_CAPTAIN_ESCALATION_POLICY.

## References
- `../captain-orchestration-layer.md`
- `./M30_CAPTAIN_ORCHESTRATOR_CLI.md`
- `./M31_CAPTAIN_TOOL_ADAPTERS.md`
- Top-level index: `../roadmap.md`
