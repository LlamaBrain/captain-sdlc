# Working in captain-sdlc

This is the **nerve-center documentation repo** for Captain SDLC — design docs,
seams, ADRs, and roadmap for the toolkit (interrogate, ATH, claude-release,
MToolKit). Mostly markdown; `tools/` holds prototype cross-tool scripts
(`captain-trace`, the Claude Code harness hooks).

> The tools own correctness; the human owns taste. (ADR-0012)

## Conventions that bite

- **ADRs:** `ADR/NNNN-slug.md`, next number = highest + 1, Problem / Solution /
  Alternatives. Add every new ADR to `ADR/index.md`.
- **Milestones:** `Roadmap/M<n>_NAME.md`; milestone identity and SemVer are
  separate axes (ADR-0002).
- **Branching (ADR-0017):** work off `main`, never on it — small repos via
  `dev`, big ones via `feature/*`→`dev`; always **squash** to `main` via PR.
  `main`/`dev` are long-lived (don't delete); delete `feature/*` after merge.
  Enforced by the GitHub ruleset (where set) and the `protect-branch.js` hook
  (everywhere).
- **Link-check CI** validates relative cross-references on push — keep links
  valid when adding or renaming docs.
- **`scratch.md` is local-only** (gitignored, OSS boundary decision). Never
  commit it; the design set is the public face.
- Docs carry `Updated:`/`Version:` headers; fenced blocks are tagged by role,
  not format (` ```constitution `, not ` ```yaml `).

## Verification

No type-checker. The checks are: `node --check` on anything under `tools/`,
and the link-check CI for docs. Say so rather than claiming "done" past that.

## Fleet note

Parallel agents work in this and sibling repos concurrently. Trust committed
state (`git log`), not working-tree snapshots. The fleet-wide hook layer lives
in `tools/hooks/` (ADR-0016) — changes there apply to every project on next
session.
