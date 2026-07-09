# M29 - CAPTAIN_CORE_RUNTIME
Status: Shipped
Last Updated: 2026-07-09

## Definition of Done
- [x] Core exposes validated task records keyed by interrogate task id.
- [x] Core exposes run records with run identity, lease/claim data, timestamps, budgets, route, worker attempts, and terminal state.
- [x] Core defines routing policy loading and evaluation without importing orchestrator or adapter code.
- [x] Core defines the terminal-state vocabulary used by orchestrator, heartbeat, adapters, and review surface.
- [x] Core defines evidence packet shape and validation.
- [x] Core loads `.captain-sdlc/` config with integer `schema_version` checks and unknown-version refusal.
- [x] Existing conventions are credited instead of duplicated: `.captain-sdlc/`, trace, task identity, flay state, and gate verdicts remain compatible.

### Verification (2026-07-07)
Implemented in `https://github.com/LlamaBrain/captain-orchestrator` as a
C#/.NET 8 library (`Captain.Core`), with a thin CLI (`Captain.Core.Cli`) and an
offline console test harness (`Captain.Core.Tests`). The implementation
intentionally keeps Core as a typed runtime contract, not MCP: MCP can wrap Core
later as an adapter/surface.

Verified:
- `dotnet restore Captain.Orchestrator.sln --configfile NuGet.config`
- `dotnet build Captain.Orchestrator.sln --no-restore`
- `dotnet run --project tests\Captain.Core.Tests\Captain.Core.Tests.csproj --no-build`

## Theme
Captain Core becomes the functional foundation for orchestrated runs. It is not just shared types: it validates records, loads config, evaluates routing policy, normalizes terminal states, and defines evidence packets that other products can trust.

## Goals
- Turn existing Captain SDLC conventions into an operational runtime library.
- Keep Core free of worker invocation, scheduling, PR creation, and taste-bearing task selection.
- Make duplicate-run prevention possible before heartbeat exists.
- Give every later product a single record model to read and write.

## Targeted
- Task record schema keyed by interrogate task id.
- Run record schema with run id, task id, route, status, lease/claim, budgets, worker attempts, evidence refs, terminal state, and timestamps.
- Routing policy schema and evaluator.
- Terminal-state vocabulary covering success, needs human, worker failed, verification failed, budget exhausted, duplicate prevented, review rejected, stale claim, and abandoned.
- Evidence packet contract for commands, diffs, tests, model outputs, adapter outputs, and human decisions.
- Config loader for committed `.captain-sdlc/*.yaml` and gitignored local state.

## Blockers & Dependencies
- **Upstream**: M1_CONVENTIONS_ESTABLISHED.
- **Upstream**: M2_TRACE_SCHEMA_FIRST_EMITTER.
- **Upstream**: M27_DEFINITION_OF_DONE_END_TO_END for the target end-to-end definition this runtime must support.

## References
- `../captain-orchestration-layer.md`
- `../captain-sdlc-conventions.md`
- `../trace-schema.md`
- `../seam-task-identity.md`
- Top-level index: `../roadmap.md`
