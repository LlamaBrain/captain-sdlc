# M36 - CAPTAIN_TDD_LOOP
Status: Stub
Last Updated: 2026-07-07

## Definition of Done
- [ ] The orchestrator can run worker -> verify -> revise attempts until success, budget exhaustion, escalation, or manual stop.
- [ ] Each attempt records worker evidence, diff evidence, verification evidence, elapsed time, and terminal classification.
- [ ] Verification failure feeds the next worker attempt as structured context, not only as console text.
- [ ] Attempt count, wall-clock budget, and per-route/model budgets are enforced.
- [ ] The loop stops at `success`, `needs_human`, `budget_exhausted`, `verification_failed`, or `worker_failed` according to policy.
- [ ] The loop never commits or opens a PR directly; review remains a separate gate.
- [ ] Tests prove pass-on-first-attempt, fail-then-pass, repeated verification failure, budget exhaustion, and worker failure.
- [ ] Daemon can fire-and-forget a queued task and observe the terminal run record without owning loop logic.

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
