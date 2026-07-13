# M36 - CAPTAIN_TDD_LOOP
Status: Shipped
Last Updated: 2026-07-08

## Definition of Done
- [x] The orchestrator can run worker -> verify -> revise attempts until success, budget exhaustion, escalation, or manual stop.
- [x] Each attempt records worker evidence, diff evidence, verification evidence, elapsed time, and terminal classification.
- [x] Verification failure feeds the next worker attempt as structured context, not only as console text.
- [x] Attempt count, wall-clock budget, and per-route/model budgets are enforced.
- [x] The loop stops at `success`, `needs_human`, `budget_exhausted`, `verification_failed`, or `worker_failed` according to policy.
- [x] The loop never commits or opens a PR directly; review remains a separate gate.
- [x] Tests prove pass-on-first-attempt, fail-then-pass, repeated verification failure, budget exhaustion, and worker failure.
- [x] Daemon can fire-and-forget a queued task and observe the terminal run record without owning loop logic.

### Progress (2026-07-08)
Implemented in `captain-orchestrator`:
- `OrchestratorRunner` supports bounded worker -> diff -> verify -> revise attempts.
- CLI adds `--max-attempts` and `--max-wall-clock-seconds`.
- `RouteRuleContext` carries attempt index plus previous verification summary/evidence id into the next worker attempt.
- Worker/diff/verification attempts record evidence id, attempt index, elapsed time, and terminal classification.
- `captain-orchestrator run --manual-stop [--manual-stop-reason <reason>]` records a `manual_stop` phase, writes `human_decision` evidence, and stops before route/worker execution as `needs_human`.

Implemented in `captain-daemon`:
- Queue items pass `worker_commands`, `worker_timeout_seconds`, `max_attempts`, and `max_wall_clock_seconds` through to `captain-orchestrator`.
- The daemon still only wakes and observes the child process; it does not own loop logic.

Verified:
- `dotnet build Captain.Orchestrator.sln --no-restore`
- `dotnet run --project tests\Captain.Core.Tests\Captain.Core.Tests.csproj --no-build`
- `dotnet run --project tests\Captain.Orchestrator.Tests\Captain.Orchestrator.Tests.csproj --no-build`
- `dotnet build Captain.Daemon.sln --no-restore`
- `dotnet run --project tests\Captain.Daemon.Tests\Captain.Daemon.Tests.csproj`

Implementation evidence:
- `captain-orchestrator` commit `d3aecdc` adds the bounded TDD attempt loop.
- `captain-orchestrator` commit `18ba5db` adds explicit manual-stop handling.
- `captain-daemon` commit `aceee05` passes TDD loop controls through queued heartbeat runs.

## Theme
This is the production version of the agent loop: act, test, observe, revise,
and stop under explicit policy. It is TDD-driven because verification evidence
is the control signal for iteration.

## Goals
- Turn the deterministic runner into a bounded autonomous implementation loop.
- Make each iteration inspectable and reproducible.
- Keep the human gate at review/approval, not inside every tool call.

## Targeted
- Attempt loop in orchestrator.
- Structured verification feedback.
- Budget and attempt caps.
- Evidence-linked attempt history.

## Blockers & Dependencies
- **Upstream**: M30_CAPTAIN_ORCHESTRATOR_CLI.
- **Upstream**: M35_CAPTAIN_COMMAND_WORKER_ADAPTERS.
- **Downstream**: M37_CAPTAIN_ESCALATION_POLICY.

## References
- `../captain-orchestration-layer.md`
- `./M30_CAPTAIN_ORCHESTRATOR_CLI.md`
- `./M35_CAPTAIN_COMMAND_WORKER_ADAPTERS.md`
- Top-level index: `../roadmap.md`
