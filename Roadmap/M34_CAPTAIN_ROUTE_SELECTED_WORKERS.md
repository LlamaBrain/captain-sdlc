# M34 - CAPTAIN_ROUTE_SELECTED_WORKERS
Status: Stub
Last Updated: 2026-07-07

## Definition of Done
- [ ] `captain-orchestrator` has a worker adapter registry keyed by route adapter name.
- [ ] The orchestrator selects the worker from `RoutingPolicy` / `RouteRule.Adapter`, not from one injected worker instance.
- [ ] The selected adapter name is recorded in run phases, worker attempts, and evidence.
- [ ] Missing or disabled adapters stop safely with a normalized terminal state and reviewable evidence.
- [ ] Tests prove route `noop` invokes the no-op worker.
- [ ] Tests prove route `local-qwen` can select a local worker adapter without invoking a frontier route.
- [ ] Tests prove route `frontier` can select a frontier worker adapter when policy matches complexity.
- [ ] Daemon behavior is unchanged: it wakes the orchestrator and does not choose workers.

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
