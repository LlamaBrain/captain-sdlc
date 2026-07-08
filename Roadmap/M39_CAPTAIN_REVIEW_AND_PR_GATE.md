# M39 - CAPTAIN_REVIEW_AND_PR_GATE
Status: Shipped
Last Updated: 2026-07-08

## Definition of Done
- [x] Completed orchestrator runs produce a review package with diff summary, evidence report, terminal state report, and budget/escalation summary.
- [x] `needs_human`, ambiguity, budget exhaustion, failed verification, and frontier escalation are visible in the review package.
- [x] PR creation is policy-gated and never bypasses manual approval unless explicitly configured.
- [x] Git author attribution defaults to the user's configured identity unless a Captain service identity is explicitly configured.
- [x] Review output links run records, evidence packets, worker attempts, daemon events, and changed files.
- [x] Tests prove report generation for success, verification failure, needs-human, and escalated frontier runs.
- [x] End-to-end smoke proves queue item -> daemon -> orchestrator -> worker loop -> review package -> terminal gate.

### Shipped (2026-07-08)
`captain-orchestrator` now emits review packages under
`.captain-sdlc/reviews/<run-id>/` with `review.md` and `approval-gate.json`.
The package reports terminal state, budget/escalation signals, worker attempts,
evidence packets, changed files, daemon event links, and git author attribution.
PR creation is blocked by default and only opens when explicitly configured.

`captain-daemon` can be configured with `--review-command`; after an
orchestrator child completes, it records the daemon event, parses the run id
from stdout, and invokes `captain-orchestrator review --run-id <run-id>` so
fire-and-forget execution stops at the terminal review gate.

Evidence commits:
- `captain-orchestrator`: review package generator, CLI `review` command, and
  tests for success, verification failure, needs-human, frontier escalation,
  and budget exhaustion.
- `captain-daemon`: review-command handoff and heartbeat smoke proving
  queue item -> daemon -> orchestrator -> review gate.

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
