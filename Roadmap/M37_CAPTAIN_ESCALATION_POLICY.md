# M37 - CAPTAIN_ESCALATION_POLICY
Status: Shipped
Last Updated: 2026-07-08

## Definition of Done
- [x] Routing/escalation policy supports local-first execution with frontier escalation.
- [x] Complexity labels, explicit task metadata, repeated verification failure, worker failure, timeout pressure, and budget policy can trigger escalation.
- [x] Escalation from local to frontier is recorded as a run phase with evidence explaining the trigger.
- [x] Frontier use is budget-capped and can be disabled by policy.
- [x] Policy ambiguity stops as `needs_human`; the orchestrator does not guess.
- [x] Tests prove local-only success, complexity-forced frontier route, failure-driven escalation, budget-blocked escalation, and ambiguity-to-human.
- [x] Documentation states which decisions are automation-owned and which require human approval.

### Verification (2026-07-08)
Implemented in `captain-orchestrator`:
- `RoutingPolicy` supports an optional `escalation` block with local route, frontier route, frontier enablement, complexity labels, verification-failure threshold, worker-failure trigger, and timeout trigger.
- `OrchestratorRunner` records escalation phases and escalation evidence before switching from local to frontier.
- Frontier escalation can be blocked by policy/budget and stops as `budget_exhausted`.
- Ambiguous routing still stops as `needs_human`.
- README/ROADMAP document automation-owned vs human-owned escalation decisions.

Verified:
- `dotnet build Captain.Orchestrator.sln --no-restore`
- `dotnet run --project tests\Captain.Core.Tests\Captain.Core.Tests.csproj --no-build`
- `dotnet run --project tests\Captain.Orchestrator.Tests\Captain.Orchestrator.Tests.csproj --no-build`

Implementation evidence:
- `captain-orchestrator` commit `5354d97` adds local-to-frontier escalation policy.

## Theme
Escalation is not bigger-model-by-default. Captain should spend local effort
first, escalate when policy says the problem is complex or the local loop has
evidence of being stuck, and stop when escalation would exceed authority.

## Goals
- Make local-to-frontier behavior deterministic and reviewable.
- Control cost and authority through policy.
- Preserve the human/taste boundary.

## Targeted
- Escalation policy schema.
- Escalation trigger evaluation.
- Local/frontier route transition evidence.
- Budget-blocked escalation terminal state.

## Blockers & Dependencies
- **Upstream**: M34_CAPTAIN_ROUTE_SELECTED_WORKERS.
- **Upstream**: M36_CAPTAIN_TDD_LOOP.
- **Downstream**: M39_CAPTAIN_REVIEW_AND_PR_GATE.

## References
- `../captain-orchestration-layer.md`
- `./M34_CAPTAIN_ROUTE_SELECTED_WORKERS.md`
- `./M36_CAPTAIN_TDD_LOOP.md`
- Top-level index: `../roadmap.md`
