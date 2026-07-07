# M35 - CAPTAIN_COMMAND_WORKER_ADAPTERS
Status: Stub
Last Updated: 2026-07-07

## Definition of Done
- [ ] A command-backed worker adapter can run a configured local command in the orchestrator worktree.
- [ ] A command-backed frontier adapter can run a configured frontier/model command without a hard package dependency.
- [ ] Command adapters capture command, working directory, exit code, stdout, stderr, elapsed time, and timeout as evidence.
- [ ] Non-zero exits map to normalized terminal states rather than raw tool prose.
- [ ] Adapter configuration supports per-route budget and timeout defaults.
- [ ] The command contract passes task file, worktree path, run id, and route name to the worker.
- [ ] Tests prove local command success, local command failure, frontier command success, and timeout behavior.
- [ ] Documentation shows how to wire OpenCode, local Qwen, and frontier model commands through policy.

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
