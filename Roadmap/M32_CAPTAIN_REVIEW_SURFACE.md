# M32 - CAPTAIN_REVIEW_SURFACE
Status: Shipped
Last Updated: 2026-07-07

## Definition of Done
- [x] Review surface can generate a PR or PR-ready package from a completed orchestrator run.
- [x] Diff summary is generated from git evidence, not worker claims.
- [x] Evidence report lists commands, tests, adapter outputs, model outputs, budgets, and human decisions.
- [x] Terminal state report explains why the run ended and whether manual approval is required.
- [x] Manual approval gate is explicit and blocks merge/release handoff until approved.
- [x] Rejection records a terminal state and preserves evidence.

### Verification (2026-07-07)
Implemented in `captain-orchestrator`:
- `ReviewPackageGenerator` reads Core run records and evidence packets.
- `captain-orchestrator review --run-id <run-id> [--project-root <dir>]` writes `.captain-sdlc/reviews/<run-id>/review.md` and `approval-gate.json`.
- Review packages include terminal state, diff summary from git diff evidence, evidence report, worker attempts, budget/escalation section, and manual approval gate instructions.
- `captain-orchestrator review --run-id <run-id> --reject <reason>` records `review_rejected`, writes human-decision evidence, and preserves prior evidence refs.

Verified:
- `dotnet build Captain.Orchestrator.sln --no-restore`
- `dotnet run --project tests\Captain.Orchestrator.Tests\Captain.Orchestrator.Tests.csproj --no-build`

## Theme
The orchestration layer ends in a human-readable approval surface. Correctness evidence is gathered by tools; the human still owns approval and taste.

## Goals
- Make orchestrator output inspectable without reading raw logs.
- Keep PR generation downstream of evidence, not upstream of it.
- Preserve the manual approval gate as a first-class product surface.

## Targeted
- PR generation.
- Diff summary.
- Evidence report.
- Terminal state report.
- Manual approval gate.

## Blockers & Dependencies
- **Upstream**: M29_CAPTAIN_CORE_RUNTIME.
- **Upstream**: M30_CAPTAIN_ORCHESTRATOR_CLI.
- **Upstream/soft**: M31_CAPTAIN_TOOL_ADAPTERS.

## References
- `../captain-orchestration-layer.md`
- `../seam-release-gates.md`
- Top-level index: `../roadmap.md`
