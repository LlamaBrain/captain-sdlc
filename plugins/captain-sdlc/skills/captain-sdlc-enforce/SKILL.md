---
name: captain-sdlc-enforce
description: Mandatory implementation workflow. Use whenever the user asks to implement, build, add, change, fix, refactor, migrate, remove, or ship repository code or assets.
---

# Captain SDLC Enforced Implementation

The hook-provided `intent_id` is authoritative. Do not mutate the repository before entering Captain.

1. Call `captain_begin_implementation` with the intent id, exact objective, repository root, `feature` unless this is a release candidate, and `visual_required=true` whenever the changed behavior has a visual surface.
2. Switch all implementation work to the canonical worktree returned by Captain.
3. Write the ticket test first, then call `captain_record_red`. The trusted ticket command must fail for the expected missing behavior.
4. Implement until the ticket test is green. Build a new deterministic feature smoke that runs in the provided build. Keep affected regression scope narrow; do not run the release-wide suite for ordinary feature work.
5. Produce the configured testable build, smoke result, and required screenshot/video evidence.
6. Use the repository commit workflow to make a clean atomic Conventional Commit with its SemVer bump and matching changelog entry. A repair after failed proof is another explicit atomic phase commit, not an amend or history rewrite.
7. Call `captain_record_commit`, then `captain_prove`. Captain takes artifact paths and proof commands only from the trusted base policy, runs ticket, new-smoke, and affected-regression commands, and additionally runs the deterministic super-smoke for pre-release.
8. Call `captain_status`. Report completion only when it returns `complete/green`, and include its evidence locations and testable build.

If the repository lacks `.captain-sdlc/codex-policy.json`, stop: implementation is not governed yet. Do not bypass Captain with ordinary edit or shell tools.
