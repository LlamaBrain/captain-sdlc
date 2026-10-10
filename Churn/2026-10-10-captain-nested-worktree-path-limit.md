# 2026-10-10 — Nested Captain task allocation exceeded Windows Git path limits

Updated: 2026-10-10
Version: 1.0.0

**Status: MITIGATED — a short-root checkout succeeded; automatic prevention is unproven.**

**Occurrence:** 2026-10-10 09:54:19 PDT (2026-10-10T16:54:19.365Z), the specific nested Begin v2 failure.

**Date basis:** America/Los_Angeles (PDT, UTC−07). Recorded 2026-10-10 from the original session evidence; the session filename's creation date does not determine the incident date.

## Summary

Starting the next Captain support task from an already nested checkout generated a third nested task path. Git could not create the checkout, so implementation could not begin at that location.

## Evidence and impact

- [Actual failed Begin result](C:/Users/metag/.codex/sessions/2026/10/10/rollout-2026-10-10T08-01-56-01a12655-c186-71d3-b913-3e8b869a0891.jsonl:3557), 2026-10-10T16:54:19.365Z, correlates with the [v2 rejection](E:/Personal/dirigible2D/.captain-sdlc/evidence/churn-workflow-skill-20261010/retained-diagnostics/source-repair-begin-output-v2.json): "fatal: '$GIT_DIR' too big."
- [Original request](E:/Personal/dirigible2D/.captain-sdlc/evidence/churn-workflow-skill-20261010/retained-diagnostics/source-repair-begin-request-v2.json) supplied a Captain project root already beneath nested worktrees.
- [Workspace allocation](E:/Personal/captain-sdlc/.captain-sdlc/worktrees/intent-a98c7c92-c42e-4d1f-99de-c5c74fe6e992/plugins/captain-sdlc/src/workspace.ts:113) derives the container from the supplied project root.
- [Canonical repair closeout](E:/Personal/captain-sdlc/.captain-sdlc/worktrees/intent-a98c7c92-c42e-4d1f-99de-c5c74fe6e992/plugins/captain-sdlc/.captain-proof/proof-source-repair-closeout.md:67) preserves this setup failure and the later successful short canonical-root checkout.

## Diagnosis

The observed failure followed assistant selection of a nested project root. A missing nesting/path preflight in Captain is an inferred capability gap, not a proven repaired feature. This is separate from missing ignored Unity dependencies, owner leases and earlier unrelated Git fixture failures.

## Next action

Owner: Cap. Use the correct canonical repository root for new support tasks. Any selected Captain allocation/preflight repair is a separate bounded follow-up; retain existing task checkouts and do not silently replace an established run.

## Update — 2026-10-10

The support repair proceeded from the short canonical-root checkout and completed its own proof. This establishes operational mitigation, not a preventative fix for future nested allocation. No recurrence test or new product fix was run for this incident record.

## Scope and related records

Created under Michael's request to record each finding in the [six-item review](E:/Personal/dirigible2D/.captain-sdlc/evidence/churn-review-20261010.md). This is incident bookkeeping; frozen criteria, signed policy and retained evidence are unchanged. Proposed preventative or legacy recovery work remains a human-review follow-up, not a new completion gate.
