# ADR-0017: Git branching model — work off `main`, squash to `main`, scaled by project size

**Date:** 2026-06-14

## Problem

Once every Captain SDLC repo went public (2026-05-29), "how work reaches
`main`" became part of the public face, but it lived only as habit. `main`'s
GitHub ruleset already enforced squash-only merges, linear history, a required
"link check", and PR review — yet nothing in the tree said so, so the workflow
got rediscovered per-merge (a rejected rebase-merge; an approval gate that
blocks a solo maintainer). And the host-side rules don't exist on private or
un-ruled repos at all, so the same fleet agent behaves differently per repo with
no written contract. Git hygiene is mechanical correctness, not taste
(ADR-0012) — it should be owned by the tooling and written down, not improvised.

## Solution

One branching model, scaled to project size, made portable across public and
private repos:

- **Small repos (this one):** work on `dev`; PR to `main`; **squash-merge**.
  `dev` is the only long-lived working branch.
- **Larger projects:** `feature/*` → merge into `dev` (integration) →
  **squash-merge** `dev` to `main`.

**Branch lifecycle.** `main` and `dev` are long-lived and never auto-deleted;
`feature/*` are ephemeral and deleted after merging into `dev`. The repo's
"automatically delete head branch on merge" toggle stays **off** — it is too
blunt, it would delete `dev` when `dev`→`main` merges. So feature-branch cleanup
is conditional: delete the head only when it is a `feature/*` branch
(`gh pr merge --squash --delete-branch`), never for `dev`/`main`
(`--delete-branch=false`).

**Resync `dev` after a squash to `main`.** Squash-merging the long-lived `dev`
into `main` permanently diverges their *history* (`main` gets a new squash commit
`dev` never sees), so the next `dev`→`main` PR reports a phantom conflict unless
`dev` is caught up. Because `prot dev` forbids force-push (`non_fast_forward`,
no bypass), you cannot reset `dev` to `main` — instead `git merge origin/main`
into `dev` (a merge-back) right after each squash, making `main` an ancestor
again. The merge-back commits live only on `dev`; `main` stays linear.

**The invariant** — every change lands on `main` as a squash, linear, behind a
passing check, via PR — is held by three layers, ordered by how portable they
are:

1. **GitHub ruleset (server-side, where configured):** squash-only merge method,
   `required_linear_history`, required "link check", PR required,
   deletion-protected `main`. Strongest gate, but only on repos that have it
   (captain-sdlc is the reference instance).
2. **`protect-branch.js` hook (client-side, everywhere):** a PreToolUse(Bash)
   guard that denies a local `git commit` while HEAD is a protected branch — the
   portable layer that works on private/un-ruled repos too. Default protects
   `main`; a project widens it (e.g. `dev` for the feature→dev model) via
   `.claude/branch-policy.json`. Catches the foot-gun before the bad commit
   exists; the ruleset would only reject it later, server-side.
3. **Repo setting:** auto-delete-on-merge off, to keep `dev` alive across merges.

The flow above the squash gate (feature→dev→main) is convention carried here and
in CLAUDE.md; it isn't separately enforced because the right granularity is
per-project and the gate that actually protects `main` is layers 1–2.

## Alternatives

- **Document the model, don't enforce it** — rejected: the friction observed was
  precisely a rule enforced by the host but invisible and improvised locally.
  Hygiene this mechanical wants a guard, not a paragraph.
- **Rely only on the GitHub ruleset** — rejected: rulesets don't exist on
  private/free repos, so the model wouldn't be portable; the hook gives the same
  local hygiene everywhere.
- **Use GitHub's blunt auto-delete-on-merge** — rejected: it deletes every head
  branch including `dev`. Keeping it off plus conditional feature-branch deletion
  preserves the long-lived branches.
- **Drop the required-approval rule** — open, not settled here: 1-approval can't
  be self-satisfied by a solo maintainer, forcing `--admin` overrides on every
  merge. Either wire an automated reviewer (e.g. CodeRabbit) so approvals are
  real, or set `required_approving_review_count: 0` and lean on the status check.
