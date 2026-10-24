# Developer changelog artifacts across worktrees

Date: 2026-10-19
Status: Authorized implementation; proof and integration tracked separately.
Authority: Michael requested per-worktree changes.md, strict Conventional Commits/SemVer/Keep a Changelog composition, and retention during merge finalization in a dated subject-named target artifact. He explicitly limited the work to developer-facing changelogs.

Use a root `changes.md` as the owned worktree's working artifact during Merge Prep. Retain pinned source/target OIDs, complete unique commit coverage, Conventional Commit messages and curatable technical summaries/categories. At finalization archive it in the owned source as `changelog/changes/YYYY-MM-DD-subject-taskhash.md` before the final readiness check. Merge Back carries that record into the target with the verified source. The archive remains available for later composition and survives removal of a worktree.

The changelog skill composes explicitly selected fragments for one project with Git provenance validation and OID deduplication. Existing released sections remain historical. Repository per-commit versions remain authoritative; fragment composition does not create additional implicit version bumps, releases, tags or player-facing copy.

Keep signed readiness unchanged: never append an unverified target-side archive commit after Prep. Supported record finalization is allowed only under captured eligibility; otherwise retain the archive through a normal source commit and re-Prep. The convention does not change frozen plan criteria or add a new signed policy gate to existing runs.

This slice provides a skill and tested command-line helper. Direct MCP calls do not automatically generate artifacts; agent-mediated Merge Prep/Back use the updated skills. Automatic server-side schema/policy enforcement and historical backfill are separate future work, not implied delivered behavior.
