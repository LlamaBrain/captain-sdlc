# M30 - CAPTAIN_ORCHESTRATOR_CLI
Status: Shipped
Last Updated: 2026-07-09

## Definition of Done
- [x] A deterministic CLI command starts one orchestrator run for an already-assigned task.
- [x] The CLI reads Captain Core config and refuses invalid or unknown schema versions.
- [x] The CLI selects the task from an explicit human assignment or queue entry, not from taste-bearing inference.
- [x] The CLI invokes classification, chooses a route from routing policy, creates an isolated worktree, calls workers through adapters, runs verification, and records every phase.
- [x] The CLI writes a complete Core run record and evidence packets.
- [x] The CLI exits with a normalized terminal state and non-zero status for blocking failures.
- [x] The CLI works without Captain Daemon or any always-online service.

### Verification (2026-07-07)
First executable spine implemented in C# in
`https://github.com/LlamaBrain/captain-orchestrator`:
- `Captain.Orchestrator` contains the run coordinator, file-backed run/evidence store, adapter interfaces, git worktree adapter, no-op worker adapter, classifier adapter, task resolver adapter, and test-runner adapter.
- `Captain.Orchestrator.Cli` exposes `captain-orchestrator run --task <task.json> --policy <routing-policy.json> [--project-root <dir>] [--verify <command>]`.
- `Captain.Orchestrator.Tests` verifies successful runs and normalized verification failure.

Verified:
- `dotnet build Captain.Orchestrator.sln --no-restore`
- `dotnet run --project tests\Captain.Orchestrator.Tests\Captain.Orchestrator.Tests.csproj --no-build`
- CLI smoke against a throwaway nested git repo under `.tmp/`, including real `git worktree add` and verification command.

Still open for M30 completion:
- Route-selected worker dispatch is split out as M34 because the current runner records route selection but still uses one injected worker adapter.

## Theme
Prove orchestration as a repeatable one-shot runner before adding scheduling. The CLI is the first executable spine: it consumes Core records, uses adapters for tool calls, and produces reviewable evidence.

## Goals
- Make the orchestration path deterministic and debuggable.
- Keep all worker/tool integration behind adapters.
- Keep heartbeat out of the critical path.
- Preserve the human/taste boundary by requiring assigned work.

## Targeted
- `captain run <task-id>` or equivalent one-shot command.
- Route selection from Core routing policy.
- Worktree creation and cleanup policy.
- Worker invocation protocol through adapters.
- Verification phase and result evaluation.
- Escalation path when classification, routing, worker output, or verification cannot produce a safe terminal state.
- Route-selected worker execution is tracked in M34.
- Autonomous TDD iteration is tracked in M36.
- Local-to-frontier escalation policy is tracked in M37.

## Blockers & Dependencies
- **Upstream**: M29_CAPTAIN_CORE_RUNTIME.
- **Parallel/soft**: M31_CAPTAIN_TOOL_ADAPTERS for first adapter set.

## References
- `../captain-orchestration-layer.md`
- `../flay-task-harness.md`
- Top-level index: `../roadmap.md`
