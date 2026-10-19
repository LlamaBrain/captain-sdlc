# 2026-10-18 — Target-first merge version and legacy phase association

**Status: REPAIRED; consuming live Prep proof pending**

Michael requested importer churn Merge Prep into `mt/feat/material-design`. The retained importer source is `31d066edcb779d5e25ce5b9febd9a12e14fa0039` (v2.550.3); its signed Prep imports target `d170bb1154371a154bc5b7e88db98bd3a57979a5` (v2.610.4). Candidate v2.610.5 has exactly six task-owned changed files against target. Nineteen focused Unity importer tests passed with locked dependencies.

Captain nevertheless rejected candidate validation: `versionTransitionValid` used only the retained first parent. Regression proof also showed it accepted a rollback candidate v2.550.4. The independent Prep then encountered a second confirmed seam: automatic phase association called an implement/running-only lifecycle method for the legacy tdd_red owner. Full implementation green is not a prerequisite or result of standalone LOW readiness.

The bounded v0.7.2 repair uses the greater canonical VERSION of the two actual, prepared-authorized merge parents, preserves exact deterministic bumps and ordinary commits, rejects invalid incoming versions, and skips automatic phase association for ineligible owners. Explicit reconciliation, owner/session/binding guards and lifecycle phase requirements remain unchanged. No captured policy, signing authority, proof result or target checkout was edited.

Worktree: `E:/Personal/captain-sdlc/.captain-sdlc/worktrees/captain-target-first-merge-version-20261018`; branch `fix/captain-target-first-merge-version-20261018`; base `2bf38f329c14c6d5fa39f6eaad190e398c192679`. Primary dev `fea6a55` has no committed codex-policy; normal-workflow fallback applies. Foreign primary untracked files were preserved.

Focused evidence under `plugins/captain-sdlc/.captain-proof/target-first-version/`:

- Version red: 10 tests, 4 expected failures and6passes (`red-tests.txt`).
- Version/workspace green:56passed, zero failures/skips (`workspace-version-green.log`).
- Legacy-owner red:2expected failures; green7passed (`legacy-owner-red.log`, `legacy-owner-green.log`). Tests preserve exact signed run/watermark bytes and target HEAD and enforce explicit reconciliation refusal.
- Typecheck and runtime build passed. Independent code review found no blocker.
- Initial MCP smoke exposed an unsynchronized handshake0.7.1; corrected to0.7.2 and rebuilt. Original failure retained (`public-mcp-diagnostic.log`). All four configured public MCP smoke scripts and both Prep/Back and lifecycle smoke scripts passed (exit0); outcomes are retained in `public-mcp-smoke-fixed.log` and `public-merge-smoke.log`.

The prior full-package622/623 failure in operator-repossession refusal remains a separate historical follow-up. This bounded repair does not claim that full suite or hosted CI passed. No push or Captain dev integration is authorized by this work.

Next owner/action: Captain verifies terminal public smoke results, commits exact repair paths, installs a hash-verified runtime while preserving existing authority and running service, then continues the same Dirigible `merge-ed2e337a-e1b2-4a9d-a6d7-0a71f2461565`. Original importer run remains legacy paused proof; signed readiness must not relabel it complete/green. Final consuming evidence records the actual source OID, artifact and signed receipt.
