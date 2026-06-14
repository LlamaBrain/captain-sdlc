# Captain SDLC — Seam 8: Release-Merge Hygiene
Created: 2026-06-14
Updated: 2026-06-14
Version: 0.1.0

## 1. Decision

The stack-agnostic git mechanics of releasing are owned by claude-release as a seam, not deferred to a future CICD tool. 'Cut a release' IS the squash-merge to main: run Seam 3 gates -> compose a Seam-7-footered release commit on dev -> open a squash PR to main -> HITL merge -> tag main. Left ambiguous, releases land by hand inconsistently (rebase-vs-squash confusion, missing footers, wrong branch) and the CICD-vs-claude-release ownership question festers so nobody builds either. CICD (per-stack build/test) is deliberately deferred because it diverges wildly across Unity/TS/Python; the git slice is universal, which is exactly why it fell through as an unintended gap.

## 2. Release Bar

Minimal first cut: from a green-gated dev, one claude-release flow lands the release on main as a squash, tags it, and carries the Seam-7 footers, HITL at the merge press, with zero manual git surgery, and it runs identically on a docs repo, a TS repo, or a Unity repo because it touches only git topology. It cooperates with the guardrails (uses the squash PR; the admin bypass is the opt-in escape, not the assumption). The win is collapsing divergent release workflows into one human-driven process governed by Captain's rules and behavior. Not ready if: it needs per-stack branching/build logic (CICD leaking in), can't run without a build pipeline present, still requires hand-run squash/tag/footer steps, or force-pushes / sidesteps the rulesets.

## 3. Chosen Shape

A thin, permission-aware ENABLER executed by claude-release, with the contract living in this nerve-center seam. Canonical action sequence: work on dev -> run Seam 3 gates -> compose the Seam-7-footered release commit -> open the squash PR to main -> [HITL merge] -> tag main. DEFAULT: stage + hand back + offer (the human or a reviewer merges through the normal approval path). OPT-IN: claude-release executes the merge itself (gh pr merge --squash --admin) only when the operator has the rights and explicitly asks; it never assumes admin because not everyone is the admin, so it is rights-aware (detects whether you can merge and adjusts the offer). Rejected alternatives: (a) a new CICD tool owns it -- conflates stack-agnostic git topology with stack-specific builds you deliberately defer, holding git control hostage to the CICD-divergence problem; (b) docs/convention only -- that is today's state and the friction IS the absence of behavior (ADR-0012/0016 say correctness wants a tool, not prose); (c) a standalone git-hygiene tool separate from claude-release -- two coordinators for one act, when the release IS the moment topology changes and claude-release already owns the release commit/version/changelog; (d) guardrails alone (hooks + rulesets) -- they block the bad path but nobody drives the good one, so you still hand-run squash and tag.

## 4. Inspirations

The release-PR pattern from release-please and Changesets: tooling prepares a release PR (bump + changelog) and a human merges it to cut the release. Transfers directly -- our release artifact IS a PR (the squash dev->main), which is exactly WHY hand-back-by-default is the natural shape: a release is a thing you merge, not a thing you push. semantic-release for deterministic version-from-commits (claude-release already has bump), but its auto-publish is rejected -- HITL stays. GitHub merge queue / required reviews informs the 'not everyone is admin' reality: cooperate with review gates rather than bypass them. Deliberately lean: the goal is clean hygiene, not a release-automation product.

## 5. Constraints And Cross-Checks

ADR-0017: squash to main; dev/main long-lived; feature/* ephemeral; no rebase or merge-commit to main; never delete dev. ADR-0012 and the 'line you must not cross': the human presses release; no auto-release on green. Seam 3: this seam CALLS the gates, never reimplements them. Seam 7: reuse the footer contract (Implements/Completes/Needs-QA), invent no new scheme. Conventions: per-project config lives under .captain-sdlc/ (alongside release-gates.yaml); trace and side-store stay gitignored. Stack-agnostic: touches only git topology, never build/test (CICD's deferred turf). Rights-aware: never assume admin or bypass rights.

## 6. Failure Modes And Edges

Footer aggregation is the load-bearing edge: a squash-merge collapses N dev commits into ONE commit on main, so the release commit must aggregate the Seam-7 footers from the squashed range or task<->commit linking breaks at exactly the release boundary. Tag the main squash commit (a new SHA), not the dev-side commit that the squash discards; rollback is reverting the squash commit via a new PR, never a force-push to main. Failure handling: gates red, operator lacks merge rights, or the ruleset rejects the merge -> leave dev intact, hand back, stay idempotent/re-runnable, and never leave main half-landed. Small/direct-to-main repos without a dev branch degrade gracefully. When the operator lacks rights, the offer becomes 'here is the PR, ask a reviewer.'

## Cross-References

- [Captain SDLC — Candidates](./candidates.md)
- [Captain SDLC — Conventions](./captain-sdlc-conventions.md)
- [Working in a Captain SDLC project](./CLAUDE.example.md)
- [Working in captain-sdlc](./CLAUDE.md)
- [Captain SDLC — Code-Reading Capability](./code-reading-capability.md)
- [Captain SDLC — Cross-Channel Deduplication](./cross-channel-dedup.md)
- [Captain SDLC — Exposed Gaps and Ambiguities](./expose.md)
- [Captain SDLC — Flay: Task Execution Harness](./flay-task-harness.md)
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

- Decision boundary: The stack-agnostic git mechanics of releasing are owned by claude-release as a seam, not deferred to a future CICD tool. 'Cut a release' IS the squash-merge to main: run Seam 3 gates -> compose a Seam-7-footered release commit on dev -> open a squash PR to main -> HITL merge -> tag main. Left ambiguous, releases land by hand inconsistently (rebase-vs-squash confusion, missing footers, wrong branch) and the CICD-vs-claude-release ownership question festers so nobody builds either. CICD (per-stack build/test) is deliberately deferred because it diverges wildly across Unity/TS/Python; the git slice is universal, which is exactly why it fell through as an unintended gap.
- Release bar: Minimal first cut: from a green-gated dev, one claude-release flow lands the release on main as a squash, tags it, and carries the Seam-7 footers, HITL at the merge press, with zero manual git surgery, and it runs identically on a docs repo, a TS repo, or a Unity repo because it touches only git topology. It cooperates with the guardrails (uses the squash PR; the admin bypass is the opt-in escape, not the assumption). The win is collapsing divergent release workflows into one human-driven process governed by Captain's rules and behavior. Not ready if: it needs per-stack branching/build logic (CICD leaking in), can't run without a build pipeline present, still requires hand-run squash/tag/footer steps, or force-pushes / sidesteps the rulesets.
- Chosen shape: A thin, permission-aware ENABLER executed by claude-release, with the contract living in this nerve-center seam. Canonical action sequence: work on dev -> run Seam 3 gates -> compose the Seam-7-footered release commit -> open the squash PR to main -> [HITL merge] -> tag main. DEFAULT: stage + hand back + offer (the human or a reviewer merges through the normal approval path). OPT-IN: claude-release executes the merge itself (gh pr merge --squash --admin) only when the operator has the rights and explicitly asks; it never assumes admin because not everyone is the admin, so it is rights-aware (detects whether you can merge and adjusts the offer). Rejected alternatives: (a) a new CICD tool owns it -- conflates stack-agnostic git topology with stack-specific builds you deliberately defer, holding git control hostage to the CICD-divergence problem; (b) docs/convention only -- that is today's state and the friction IS the absence of behavior (ADR-0012/0016 say correctness wants a tool, not prose); (c) a standalone git-hygiene tool separate from claude-release -- two coordinators for one act, when the release IS the moment topology changes and claude-release already owns the release commit/version/changelog; (d) guardrails alone (hooks + rulesets) -- they block the bad path but nobody drives the good one, so you still hand-run squash and tag.
- Inspirations: The release-PR pattern from release-please and Changesets: tooling prepares a release PR (bump + changelog) and a human merges it to cut the release. Transfers directly -- our release artifact IS a PR (the squash dev->main), which is exactly WHY hand-back-by-default is the natural shape: a release is a thing you merge, not a thing you push. semantic-release for deterministic version-from-commits (claude-release already has bump), but its auto-publish is rejected -- HITL stays. GitHub merge queue / required reviews informs the 'not everyone is admin' reality: cooperate with review gates rather than bypass them. Deliberately lean: the goal is clean hygiene, not a release-automation product.
- Inherited constraints: ADR-0017: squash to main; dev/main long-lived; feature/* ephemeral; no rebase or merge-commit to main; never delete dev. ADR-0012 and the 'line you must not cross': the human presses release; no auto-release on green. Seam 3: this seam CALLS the gates, never reimplements them. Seam 7: reuse the footer contract (Implements/Completes/Needs-QA), invent no new scheme. Conventions: per-project config lives under .captain-sdlc/ (alongside release-gates.yaml); trace and side-store stay gitignored. Stack-agnostic: touches only git topology, never build/test (CICD's deferred turf). Rights-aware: never assume admin or bypass rights.
- Failure modes: Footer aggregation is the load-bearing edge: a squash-merge collapses N dev commits into ONE commit on main, so the release commit must aggregate the Seam-7 footers from the squashed range or task<->commit linking breaks at exactly the release boundary. Tag the main squash commit (a new SHA), not the dev-side commit that the squash discards; rollback is reverting the squash commit via a new PR, never a force-push to main. Failure handling: gates red, operator lacks merge rights, or the ruleset rejects the merge -> leave dev intact, hand back, stay idempotent/re-runnable, and never leave main half-landed. Small/direct-to-main repos without a dev branch degrade gracefully. When the operator lacks rights, the offer becomes 'here is the PR, ask a reviewer.'
- Consistency updates: The Candidates doc flags CICD as a proposed new tool ('Lean: new tool', TBD whether new tool or claude-release expansion). This seam resolves that TBD by PARTITIONING rather than overriding: the stack-specific build/test slice stays deferred to CICD; the stack-agnostic git-topology slice becomes a claude-release seam now. No conflict. Consistent with Candidates' rule that cross-tool seams are owned by the nerve-center, not a separate Captain SDLC layer tool.

## Open Questions

- None.

## Version History

- 0.1.0 (2026-04-08): Initial documented draft.
