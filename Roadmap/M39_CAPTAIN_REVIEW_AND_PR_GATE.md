# M39 - CAPTAIN_REVIEW_AND_PR_GATE
Status: In Progress
Last Updated: 2026-07-07

## Definition of Done
- [x] Completed orchestrator runs produce a review package with diff summary, evidence report, terminal state report, and budget/escalation summary.
- [ ] `needs_human`, ambiguity, budget exhaustion, failed verification, and frontier escalation are visible in the review package.
- [ ] PR creation is policy-gated and never bypasses manual approval unless explicitly configured.
- [ ] Git author attribution defaults to the user's configured identity unless a Captain service identity is explicitly configured.
- [ ] Review output links run records, evidence packets, worker attempts, daemon events, and changed files.
- [ ] Tests prove report generation for success, verification failure, needs-human, and escalated frontier runs.
- [ ] End-to-end smoke proves queue item -> daemon -> orchestrator -> worker loop -> review package -> terminal gate.

### Progress (2026-07-07)
M32 delivered the review package foundation in `captain-orchestrator`.
Covered states so far: success, verification failure, needs-human, and review
rejection. Still open for M39: explicit PR policy gate, git attribution checks,
daemon event links, changed-file links, budget-exhaustion review assertion,
frontier escalation review assertion, and end-to-end daemon-to-review smoke.

## Theme
Automation may drive the work, but review is where evidence becomes a human
decision. This is the gate that keeps fire-and-forget from becoming
fire-and-merge.

## Goals
- Make autonomous runs auditable.
- Preserve human approval for taste and risk.
- Make PR generation a consequence of a passed gate, not an implicit worker side effect.

## Targeted
- Review package generator.
- Terminal state report.
- Evidence report.
- PR gate policy.
- Attribution checks.

## Blockers & Dependencies
- **Upstream**: M32_CAPTAIN_REVIEW_SURFACE.
- **Upstream**: M37_CAPTAIN_ESCALATION_POLICY.
- **Upstream**: M38_CAPTAIN_DAEMON_HARDENING.

## References
- `../captain-orchestration-layer.md`
- `./M32_CAPTAIN_REVIEW_SURFACE.md`
- `./M37_CAPTAIN_ESCALATION_POLICY.md`
- `./M38_CAPTAIN_DAEMON_HARDENING.md`
- Top-level index: `../roadmap.md`
