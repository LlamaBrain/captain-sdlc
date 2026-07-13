# M35 - CAPTAIN_COMMAND_WORKER_ADAPTERS
Status: Shipped
Last Updated: 2026-07-08

## Definition of Done
- [x] A command-backed worker adapter can run a configured local command in the orchestrator worktree.
- [x] A command-backed frontier adapter can run a configured frontier/model command without a hard package dependency.
- [x] Command adapters capture command, working directory, exit code, stdout, stderr, elapsed time, and timeout as evidence.
- [x] Non-zero exits map to normalized terminal states rather than raw tool prose.
- [x] Adapter configuration supports per-route budget and timeout defaults.
- [x] The command contract passes task file, worktree path, run id, and route name to the worker.
- [x] Tests prove local command success, local command failure, frontier command success, and timeout behavior.
- [x] Documentation shows how to wire OpenCode, local Qwen, and frontier model commands through policy.

### Verification (2026-07-07)
Implemented in `captain-orchestrator`:
- `CommandWorkerAdapter` runs configured commands in the orchestrator worktree.
- CLI registration uses repeated `--worker-command <adapter=command>` arguments and optional `--worker-timeout-seconds <n>`.
- Route-level `budgets.timeout_seconds` overrides the command default for that route.
- Worker commands receive `CAPTAIN_TASK_ID`, `CAPTAIN_TASK_FILE`, `CAPTAIN_RUN_ID`, `CAPTAIN_ROUTE_NAME`, `CAPTAIN_ROUTE_ADAPTER`, `CAPTAIN_PROJECT_ROOT`, and `CAPTAIN_WORKTREE_PATH`.
- Evidence records command, working directory, exit code, stdout, stderr, elapsed time, timeout, task file, route, run id, and worktree path.

Verified:
- `dotnet build Captain.Orchestrator.sln --no-restore`
- `dotnet run --project tests\Captain.Orchestrator.Tests\Captain.Orchestrator.Tests.csproj --no-build`

Implementation evidence (2026-07-08):
- `captain-orchestrator` commit `043b56c` adds `CommandWorkerAdapter`, repeated `--worker-command <adapter=command>` CLI wiring, `--worker-timeout-seconds`, route `timeout_seconds` override, command evidence capture, and command success/failure/timeout tests.

Example route policy:

```json
{
  "schema_version": 1,
  "routes": [
    {
      "name": "local-qwen",
      "adapter": "local-qwen",
      "when": { "label": "orchestrator" },
      "budgets": { "timeout_seconds": 900 }
    },
    {
      "name": "frontier",
      "adapter": "frontier",
      "when": { "label": "complex" },
      "budgets": { "timeout_seconds": 1800 }
    }
  ]
}
```

Example CLI wiring:

```powershell
captain-orchestrator run --task task.json --policy routing-policy.json --project-root . `
  --worker-command "opencode=opencode run --task %CAPTAIN_TASK_FILE%" `
  --worker-command "local-qwen=qwen-local --task %CAPTAIN_TASK_FILE% --worktree %CAPTAIN_WORKTREE_PATH%" `
  --worker-command "frontier=frontier-worker --task %CAPTAIN_TASK_FILE% --run %CAPTAIN_RUN_ID%" `
  --worker-timeout-seconds 900
```

## Theme
Real tools enter Captain through a soft boundary first. The orchestrator should
be able to drive local and frontier workers without linking directly to any one
SDK, CLI, or model runtime.

## Goals
- Make the first real worker adapters dogfoodable today.
- Preserve independent versioning of OpenCode, Qwen, frontier providers, and future tools.
- Keep all model/tool output normalized into Core evidence packets.

## Targeted
- `CommandWorkerAdapter`.
- Route-level command configuration.
- Local worker route.
- Frontier worker route.
- Timeout and terminal-state mapping.

## Blockers & Dependencies
- **Upstream**: M34_CAPTAIN_ROUTE_SELECTED_WORKERS.
- **Downstream**: M36_CAPTAIN_TDD_LOOP.

## References
- `../captain-orchestration-layer.md`
- `./M34_CAPTAIN_ROUTE_SELECTED_WORKERS.md`
- Top-level index: `../roadmap.md`
