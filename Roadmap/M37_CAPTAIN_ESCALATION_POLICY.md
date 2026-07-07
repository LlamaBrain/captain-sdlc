# M37 - CAPTAIN_ESCALATION_POLICY
Status: Stub
Last Updated: 2026-07-07

## Definition of Done
- [ ] Routing/escalation policy supports local-first execution with frontier escalation.
- [ ] Complexity labels, explicit task metadata, repeated verification failure, worker failure, timeout pressure, and budget policy can trigger escalation.
- [ ] Escalation from local to frontier is recorded as a run phase with evidence explaining the trigger.
- [ ] Frontier use is budget-capped and can be disabled by policy.
- [ ] Policy ambiguity stops as `needs_human`; the orchestrator does not guess.
- [ ] Tests prove local-only success, complexity-forced frontier route, failure-driven escalation, budget-blocked escalation, and ambiguity-to-human.
- [ ] Documentation states which decisions are automation-owned and which require human approval.

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
