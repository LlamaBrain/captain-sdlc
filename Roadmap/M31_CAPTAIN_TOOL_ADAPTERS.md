# M31 - CAPTAIN_TOOL_ADAPTERS
Status: In Progress
Last Updated: 2026-07-08

## Definition of Done
- [x] Adapter interface maps invocation, outputs, failures, evidence, and terminal states into Captain Core records.
- [ ] Git adapter supports worktree creation, diff capture, branch state, and commit/PR preconditions needed by the CLI runner.
- [x] Test runner adapter supports configured verification commands and evidence capture.
- [ ] Interrogate adapter resolves task identity and task metadata from existing roadmap/taskout sources.
- [x] At least one worker adapter beyond git/test runner is wired for dogfood: flay, OpenCode, local Qwen, frontier, or Inquisitor.
- [x] Adapter failures are normalized and never leak as unstructured tool prose only.

### Verification (2026-07-07)
First adapter slice implemented for M30:
- Adapter contracts in `captain-orchestrator` (`Captain.Orchestrator/AdapterResults.cs`).
- `GitAdapter` creates isolated git worktrees and emits adapter evidence.
- `TestRunnerAdapter` runs configured verification commands and maps failures to `verification_failed`.
- `NoopWorkerAdapter` provides an executable worker slot for the deterministic spine until a real worker adapter is selected.

Still open for M31 completion:
- Expand `GitAdapter` to diff capture, branch state, and commit/PR preconditions.
- Add interrogate task metadata resolution.
- Route-selected worker dispatch is tracked in M34.
- Command-backed local/frontier worker adapters are tracked in M35.

Additional verification (2026-07-07):
- `CommandWorkerAdapter` wires soft local/frontier command workers without linking to a model SDK or tool package.
- `dotnet build Captain.Orchestrator.sln --no-restore`
- `dotnet run --project tests\Captain.Orchestrator.Tests\Captain.Orchestrator.Tests.csproj --no-build`

Implementation evidence (2026-07-08):
- `captain-orchestrator` commit `043b56c` adds route-selected command worker adapters and tests.

## Theme
Adapters let the orchestration layer coordinate existing blades without absorbing their code. Each adapter is a boundary contract: call the tool, collect evidence, normalize result.

## Goals
- Keep existing tools independently versioned.
- Prevent orchestrator logic from depending on tool-specific output formats.
- Make adapter evidence reviewable by humans and consumable by heartbeat/review surface.

## Targeted
- Interrogate adapter.
- Inquisitor adapter.
- Flay adapter.
- Test runner adapter.
- Git adapter.
- OpenCode adapter.
- Frontier adapter.
- Local Qwen adapter.

## Blockers & Dependencies
- **Upstream**: M29_CAPTAIN_CORE_RUNTIME.
- **Consumer**: M30_CAPTAIN_ORCHESTRATOR_CLI.
- **Consumer**: M34_CAPTAIN_ROUTE_SELECTED_WORKERS.
- **Consumer**: M35_CAPTAIN_COMMAND_WORKER_ADAPTERS.

## References
- `../captain-orchestration-layer.md`
- `../seam-task-identity.md`
- `../flay-task-harness.md`
- Top-level index: `../roadmap.md`
