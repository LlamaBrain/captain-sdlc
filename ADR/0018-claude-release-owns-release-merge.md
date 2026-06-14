# ADR-0018: claude-release owns the release-merge; CICD stays deferred

**Date:** 2026-06-14

## Problem

The stack-agnostic git mechanics of releasing — landing a release on `main` as a
squash, tagging it, carrying the Seam 7 footers — had no owner. claude-release
stops at "single commit, no push," and the Candidates doc left CICD a *proposed*
tool ("Lean: new tool; TBD whether new tool or a claude-release expansion"). So
the release-merge fell through the gap: too universal to be stack-specific CICD,
not yet claimed by claude-release. The result is the friction this work kept
hitting — releases landing by hand, inconsistently (rebase-vs-squash, missing
footers, wrong branch), with no enforced good path.

## Solution

Partition the open CICD question instead of answering it whole. The
**stack-agnostic git slice** of releasing is owned by **claude-release**,
specified as Seam 8 (Release-Merge Hygiene): run Seam 3 gates → compose the
Seam-7-footered release commit on `dev` → open the squash PR to `main` → HITL
merge → tag `main`. The **stack-specific build/test slice** stays deferred to a
future CICD tool, deliberately — it diverges across Unity/TS/Python, and that
divergence (the reason CICD was worth avoiding) doesn't touch git topology, which
is identical everywhere. claude-release is a thin, permission-aware *enabler*: it
stages and offers by default, and executes the merge only with explicit rights —
it never assumes admin. The guardrails (ADR-0017 rulesets + the protect-branch
hook) own prevention; the seam owns good-path orchestration. The human still
presses release (ADR-0012).

## Alternatives

- **A new CICD tool owns the release-merge** — rejected: conflates universal git
  topology with divergent per-stack builds, holding git control hostage to the
  CICD problem deliberately deferred.
- **Leave it to docs/convention** — rejected: that is the current state, and the
  friction *is* the absence of behavior; correctness wants a tool, not prose
  (ADR-0016).
- **A standalone git-hygiene tool, separate from claude-release** — rejected: two
  coordinators for one act, when the release *is* the moment topology changes and
  claude-release already owns the release commit, version, and changelog.
- **Auto-merge once gates are green** — rejected: HITL is non-negotiable
  (ADR-0012), and since not everyone is an admin the tool must never assume
  bypass rights.
