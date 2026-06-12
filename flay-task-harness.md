# Captain SDLC — Flay: Task Execution Harness
Created: 2026-06-11
Updated: 2026-06-11
Version: 0.1.0

## 1. Decision

Two failure modes needed foreclosing. First: agent drift into selection - 'which task next' is taste, and per ADR-0012 and the nerve-center's 'line you must not cross', taste is the human's. Second: an ad-hoc execution chain - plans skipped, Seam 7 footers forgotten, scratch.md stale - exactly the inconsistency the pipeline exists to kill. DECISION: flay is NOT a selector. The human assigns the task by its interrogate key; flay is the execution harness that drives that one task through the existing SDLC stations: Claude Code plan mode for the design loop, implementation, verification, then the commit carrying the correct Seam 7 footer (Implements:/Completes:/Needs-QA:). Flay never picks, ranks, or recommends work - the pick is taste (human); the chain after the pick is correctness (tool). It is a pure conductor: zero new deterministic code; it orchestrates elements that already exist (design_taskout_export for key validation, plan mode, the project's verify commands, the task-footers flow).

## 2. Release Bar

v1 success: `/flay <key>` runs assignment -> planning -> plan approval -> implementation -> verification -> footered commit with a human-in-the-loop pause at EVERY phase boundary. `/flay-auto <key>` is the explicit full-auto variant (house variant-pair pattern, like distill / distill-hard): it runs through without phase pauses but cannot waive harness-enforced gates - Claude Code permission prompts and plan-mode approval (ExitPlanMode) remain hard gates in both modes. Default is HITL, always; full-auto only when the human explicitly invokes the variant. Not-ready evidence: commits landing with wrong or missing footers, plans rubber-stamped without real review, or tasks half-done but marked Completes.

## 3. Chosen Shape

Home: claude-interrogate - it owns the design-side arc (roadmap -> taskout -> flay). Rejected: claude-release-clickup (release-side; flay is task-side), a new single-skill plugin (tools-not-modules taken to a silly extreme), the nerve-center (forbidden - ADR-0003, conventions not tools). Composition: pure skill orchestration, zero new deterministic code. Cross-plugin connection is FILES-NOT-CODE through `.captain-sdlc/`: flay writes `flay-state.json` (schema_version 1; single object: task_id, rcId, taskText, mode hitl|auto, phase, startedAt, updatedAt, history[]) at every phase transition - phases assigned -> planning -> plan-approved -> implementing -> verifying -> committing -> done; file deleted on done/abandon with an outcome line prepended to scratch.md. The other blades consume the file without knowing flay exists: claude-interrogate-clickup may mirror the active task to in-progress at assignment time (when statusMap.inProgress is configured), claude-release-clickup's task-footers defaults its key to the active task, and the release pass can cross-check. scratch.md stays the human-readable journal; the JSON is the wire. The state file lives in the gitignored zone (churning local state, like trace/).

## 4. Inspirations

None external. The variant-pair naming (`flay` / `flay-auto`) is the house's own distill / distill-hard pattern; the phase journal is the house's own scratch register. No Jira/Linear-style workflow engines are borrowed - flay deliberately has no state machine beyond the seven named phases and no assignment logic at all.

## 5. Constraints And Cross-Checks

All inherited, none new: ADR-0012 (the human owns taste - assignment is the human's act; the chain is correctness - the tool's); ADR-0003 (no nerve-center tool - flay is an interrogate skill; only the flay-state.json FILE CONVENTION lives in captain-sdlc, registered in captain-sdlc-conventions.md per the ownership rule for new `.captain-sdlc/` files); integer schema_version policy on the state file (consumers refuse unknown versions); task keys come only from design_taskout_export - never hand-derived (Seam 7); no git hooks (claude-release doctrine); verification commands come from the project's own config (CLAUDE.md / package.json) - flay never invents a test command.

## 6. Failure Modes And Edges

All specified now: (1) Stale state - on start, an existing flay-state.json triggers a resume-or-abandon offer; scratch triage also surfaces it. Downstream consumers treat stale state as advisory, never act destructively on it. (2) Key retired mid-flight (task reworded while active) - re-validate against a fresh export at commit time; retired -> surface it, the human re-picks the key; the commit pass never fuzzy-matches (Seam 7). (3) Concurrency - WIP limit of 1 BY STRUCTURE: the state file holds a single task object, not an array. A second /flay while one is active forces the resume/abandon decision first. (4) Full-auto verify failure - announce and DOWNGRADE TO HITL; never retry-loop. (5) Completion judgment in full-auto - defaults to Needs-QA: (unwatched work is precisely what QA exists for); HITL mode asks the human Completes vs Needs-QA explicitly.

## Cross-References

- [Captain SDLC — Candidates](./candidates.md)
- [Captain SDLC — Conventions](./captain-sdlc-conventions.md)
- [Working in a Captain SDLC project](./CLAUDE.example.md)
- [Captain SDLC — Code-Reading Capability](./code-reading-capability.md)
- [Captain SDLC — Cross-Channel Deduplication](./cross-channel-dedup.md)
- [Captain SDLC — Exposed Gaps and Ambiguities](./expose.md)
- [Captain SDLC — Glossary](./glossary.md)
- [LICENSE](./LICENSE.md)
- [Captain SDLC — Open Questions Rollup](./open-questions.md)
- [Captain SDLC — Privacy Framework](./privacy-framework.md)
- [Captain SDLC — Privacy Policy (Aspirational)](./privacy-policy-aspirational.md)
- [Captain SDLC](./README.md)
- [Roadmap](./roadmap.md)
- [Scratch](./scratch.md)
- [Captain SDLC — Seam 6: Constitution Enforcement](./seam-constitution-enforcement.md)
- [Captain SDLC — Seam 4: Cross-Tool Contract Testing](./seam-contract-testing.md)
- [Captain SDLC — Seam 2: Design ↔ Code Drift](./seam-design-code-drift.md)
- [Captain SDLC — Seam 5: Live Ops Ingestion](./seam-live-ops-ingestion.md)
- [Captain SDLC — Seam 3: Release Gates](./seam-release-gates.md)
- [Captain SDLC — Seam 7: Task Identity & Commit Linking](./seam-task-identity.md)
- [Captain SDLC — Technical Debt](./tech-debt.md)
- [Captain SDLC — Cross-tool Trace Schema](./trace-schema.md)
- [Captain SDLC — Vision](./vision.md)

## Resolved Decisions

- Decision boundary: Two failure modes needed foreclosing. First: agent drift into selection — 'which task next' is taste, and per ADR-0012 and the nerve-center's 'line you must not cross', taste is the human's. Second: an ad-hoc execution chain — plans skipped, Seam 7 footers forgotten, scratch.md stale — exactly the inconsistency the pipeline exists to kill. DECISION: flay is NOT a selector. The human assigns the task by its interrogate key; flay is the execution harness that drives that one task through the existing SDLC stations: Claude Code plan mode for the design loop, implementation, verification, then the commit carrying the correct Seam 7 footer (Implements:/Completes:/Needs-QA:). Flay never picks, ranks, or recommends work — the pick is taste (human); the chain after the pick is correctness (tool). It is a pure conductor: zero new deterministic code; it orchestrates elements that already exist (design_taskout_export for key validation, plan mode, the project's verify commands, the task-footers flow).
- Release bar: v1 success: `/flay <key>` runs assignment → planning → plan approval → implementation → verification → footered commit with a human-in-the-loop pause at EVERY phase boundary. `/flay-auto <key>` is the explicit full-auto variant (house variant-pair pattern, like distill / distill-hard): it runs through without phase pauses but cannot waive harness-enforced gates — Claude Code permission prompts and plan-mode approval (ExitPlanMode) remain hard gates in both modes. Default is HITL, always; full-auto only when the human explicitly invokes the variant. Not-ready evidence: commits landing with wrong or missing footers, plans rubber-stamped without real review, or tasks half-done but marked Completes.
- Chosen shape: Home: claude-interrogate — it owns the design-side arc (roadmap → taskout → flay). Rejected: claude-release-clickup (release-side; flay is task-side), a new single-skill plugin (tools-not-modules taken to a silly extreme), the nerve-center (forbidden — ADR-0003, conventions not tools). Composition: pure skill orchestration, zero new deterministic code. Cross-plugin connection is FILES-NOT-CODE through `.captain-sdlc/`: flay writes `flay-state.json` (schema_version 1; single object: task_id, rcId, taskText, mode hitl|auto, phase, startedAt, updatedAt, history[]) at every phase transition — phases assigned → planning → plan-approved → implementing → verifying → committing → done; file deleted on done/abandon with an outcome line prepended to scratch.md. The other blades consume the file without knowing flay exists: claude-interrogate-clickup may mirror the active task to in-progress at assignment time (when statusMap.inProgress is configured), claude-release-clickup's task-footers defaults its key to the active task, and the release pass can cross-check. scratch.md stays the human-readable journal; the JSON is the wire. The state file lives in the gitignored zone (churning local state, like trace/).
- Inspirations: None external. The variant-pair naming (`flay` / `flay-auto`) is the house's own distill / distill-hard pattern; the phase journal is the house's own scratch register. No Jira/Linear-style workflow engines are borrowed — flay deliberately has no state machine beyond the seven named phases and no assignment logic at all.
- Inherited constraints: All inherited, none new: ADR-0012 (the human owns taste — assignment is the human's act; the chain is correctness — the tool's); ADR-0003 (no nerve-center tool — flay is an interrogate skill; only the flay-state.json FILE CONVENTION lives in captain-sdlc, registered in captain-sdlc-conventions.md per the ownership rule for new `.captain-sdlc/` files); integer schema_version policy on the state file (consumers refuse unknown versions); task keys come only from design_taskout_export — never hand-derived (Seam 7); no git hooks (claude-release doctrine); verification commands come from the project's own config (CLAUDE.md / package.json) — flay never invents a test command.
- Failure modes: All specified now: (1) Stale state — on start, an existing flay-state.json triggers a resume-or-abandon offer; scratch triage also surfaces it. Downstream consumers treat stale state as advisory, never act destructively on it. (2) Key retired mid-flight (task reworded while active) — re-validate against a fresh export at commit time; retired → surface it, the human re-picks the key; the commit pass never fuzzy-matches (Seam 7). (3) Concurrency — WIP limit of 1 BY STRUCTURE: the state file holds a single task object, not an array. A second /flay while one is active forces the resume/abandon decision first. (4) Full-auto verify failure — announce and DOWNGRADE TO HITL; never retry-loop. (5) Completion judgment in full-auto — defaults to Needs-QA: (unwatched work is precisely what QA exists for); HITL mode asks the human Completes vs Needs-QA explicitly.
- Consistency updates: No overrides. Flay conforms to the cross-tool-seams policy: the shared artifact (flay-state.json) is a convention registered in the nerve-center; the implementation is an interrogate skill; consumers (claude-interrogate-clickup >= 0.2.1, claude-release-clickup >= 0.1.2) read the file without code coupling. ADR-0012's taste/correctness boundary is structurally enforced by flay's not-a-selector decision rather than policed by prompt discipline.

## Open Questions

- None.

## Version History

- 0.1.0 (2026-06-11): Initial documented draft.
