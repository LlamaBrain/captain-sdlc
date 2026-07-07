# M32 - CAPTAIN_REVIEW_SURFACE
Status: Stub
Last Updated: 2026-07-07

## Definition of Done
- [ ] Review surface can generate a PR or PR-ready package from a completed orchestrator run.
- [ ] Diff summary is generated from git evidence, not worker claims.
- [ ] Evidence report lists commands, tests, adapter outputs, model outputs, budgets, and human decisions.
- [ ] Terminal state report explains why the run ended and whether manual approval is required.
- [ ] Manual approval gate is explicit and blocks merge/release handoff until approved.
- [ ] Rejection records a terminal state and preserves evidence.

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
