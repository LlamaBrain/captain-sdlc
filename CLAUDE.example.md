<!--
  Example CLAUDE.md for a project that adopts the Captain SDLC toolkit.

  Copy this into your game project's repo root as `CLAUDE.md` and trim to the
  blades you've actually installed. It orients an agent to the toolkit — which
  tool owns what, where the line between process and taste sits, and the
  cross-tool conventions to respect. It is NOT a substitute for the nerve-center
  docs (github.com/LlamaBrain/captain-sdlc); it points at them.

  Delete this comment block once copied.
-->

# Working in a Captain SDLC project
Updated: 2026-04-08
Version: 0.1.1

Created: 2026-04-08

> **The tools own correctness; the human owns taste.** (ADR-0012)

This project is built with the **Captain SDLC** toolkit — a swiss-army knife of
independent tools that automate the *process* parts of the SDLC (versioning,
roadmaps, mechanical QA, release hygiene) so human attention stays on the parts
that need *taste*. The tools share conventions, not code; adopt one without the
rest.

## The line you must not cross

- **Design is the human's.** Which milestone gets built next, which invariants
  matter, what the canonical design says — never an agent decision. You execute
  plan-space; the human owns idea-space. The Socratic interview is the seam
  between them.
- **HITL throughout.** Surface deltas, gates, and drift for human adjudication.
  Don't auto-resolve anything that carries taste.
- **No creative authoring.** No generated art, copy, narrative, or dialogue.
  AI's mandate is the boring repetitive stuff. SemVer is process; art is not.

## The blades (installed today)

| Blade | Role | Reach for it when |
|---|---|---|
| **interrogate** | Design front-end. Socratic interview → canonical design doc, scoped tasks, roadmap, gap audit, the **constitution** (the invariants section). | Turning an idea into a doc; decomposing scope; auditing/syncing the docs set. |
| **ATH** (AI Test Harness) | Mechanical QA. Drives Unity playmode via MCP-attached smokes; asserts behavior, detects regression. | Verifying a milestone behaves; catching regressions. QA of *correctness* — not of *feel*. |
| **claude-release** | Release back-end. Conventional-commit finalization, changelog, semver bump, tag, release. | Finalizing a commit; cutting a release. Let it compute the version — don't hand-pick it. |
| **MToolKit** *(opt-in)* | Runtime foundation — DI, save migration, Localization, structured logging. Substantial projects only. | Detect it and lean on it when present; degrade gracefully when absent (ADR-0010). |

Invoke interrogate and claude-release through their Claude Code skills/slash
commands; reach ATH through its MCP server. The exact commands depend on which
plugins this project has installed — check the skills list, don't assume.

*On the roadmap, not yet shippable:* CICD (build/deploy), Live Ops ingestion,
marketing-asset reuse. Don't invoke them as if they exist.

## Cross-tool conventions (respect these)

- **`.captain-sdlc/` is the state directory** at the repo root. `trace/` and
  `side-store/` are always `.gitignored`; the `*.yaml` config files are
  committed (they're project policy). Tools create subdirs lazily.
- **`schema_version` is an integer** on every config and structured artifact.
  Additive changes keep the version; renames/removals/type-changes bump it.
  **Refuse an unknown version — never guess.**
- **Trace, don't recompute.** The cross-tool value lives in the seams: emit
  structured trace events to `.captain-sdlc/trace/` so "which design decision
  introduced this regression" has an answer. Persistent traces are load-bearing.
- **Fenced blocks are tagged by role, not format** (` ```constitution `, not
  ` ```yaml `). Tools find structured data by fence tag.
- **Suppressions are acknowledged, not hidden.** Known-accepted violations go in
  the seam's `*-suppressions.yaml` with a required `reason`; they surface in
  reports under `suppressed`, never silently dropped.

## When in doubt

Read the nerve-center repo — it owns the seams and the full picture:
`vision.md` (the assembled pipeline), `captain-sdlc-conventions.md` (these
conventions in full), and the `ADR/` log (why things are the way they are).
github.com/LlamaBrain/captain-sdlc

## Cross-References

- [Captain SDLC — Seam 7: Task Identity & Commit Linking](./seam-task-identity.md)
- [Captain SDLC — Flay: Task Execution Harness](./flay-task-harness.md)

## Resolved Decisions

- No resolved decisions captured yet.

## Open Questions

- None.

## Version History

- 0.1.1 (2026-04-08): Metadata, linkage, or narrow doc maintenance update.
- 0.1.0 (2026-04-08): Metadata, linkage, or narrow doc maintenance update.
