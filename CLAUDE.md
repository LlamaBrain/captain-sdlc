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
- **Branching (ADR-0017):** work off `dev`, never commit to `main` directly —
  small repos on `dev`, big ones via `feature/*`→`dev`; always **squash** to
  `main` via PR.
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

## Approved scope and task continuity

Updated by human decision on 2026-09-26; see [ADR-0022](ADR/0022-approved-scope-and-resumable-work.md).
Once an approved plan enters implementation, agents cannot add work, acceptance criteria or
blocking gates. Repair defects against original criterion IDs. Put new discoveries in the
separate closeout record's non-blocking follow-ups for human review after completion; only
the human can authorize subsequent work. Do not reopen the agreed scope automatically.

Keep progress in one external closure record. Disclose effective gates before implementation,
distinguish phase acceptance from integration/release proof, and retain evidence at its actual
revision. Resume the same task, branch and worktree with its dirty work and signed handoff.
Ordinary resume direction is sufficient; adapters manage intent tokens. Never silently replace
a checkout or take over another active session. Retry failed operations only after a relevant
input or cause changes. Disposable automation payloads belong in ignored task scratch storage.

Plugin enforcement binds selected `plan_paths` and trusted `approvedPlanPaths` for new runs. Legacy unbound runs must
be identified honestly; this decision does not silently migrate their signed state.

Plan states are draft, ready, working, optional HITL review, and completed. Starting accepts
approval; pausing leaves working scope frozen. Declare concrete HITL goals at start and group
them at the end of a provable segment. See [Plan lifecycle](plan-lifecycle.md) for the required
criterion, setup, human action, pass/fail expectation and evidence fields.

Pending HITL retains the active run and worktree, including across pause/resume.
Rejection repairs original criteria in that same run and requires fresh proof before review.
Acceptance completes the run; new requirements remain separately authorized follow-ups.
Identical same-turn intent requests reuse their signed receipt rather than minting new work.
