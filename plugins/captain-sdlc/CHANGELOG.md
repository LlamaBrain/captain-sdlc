# Changelog

## 0.2.3
- Configure Captain's per-project policy for the existing plugin version files and scoped changelog.
- Keep the exact ignored plugin build, proof and scratch output roots out of source proof while rejecting tracked content in those roots.
- Verify synchronized plugin commit preflight, captured policy preservation and source protection without changing commands or gates.

## 0.2.2
- Preserve the persisted operation ID when initial Merge Prep fails, with public status guidance bound to the caller session.
- Add strict read-only merge diagnosis for caller-owned operations with exact source/target/branch bindings and limited conflicting lease owner metadata.
- Verify existing signatures, chains and watermarks without creating authority, migrating legacy leases or changing signed state; preserve recovery ownership and generation checks.
- Cover the module and public transport behavior, read-only filesystem purity, and unchanged refusal controls.

## 0.2.1
- Expose signed merge lease recovery arguments and owner state through public MCP status, and guide rejected continuations back to that status.
- Admit the exact recovery tool through governed hook routing while retaining session, token, revision, and worktree checks.
- Carry existing authorization and named target bindings through recovery and Prep/Back sequencing; stop at readiness for Prep-only requests.
- Let agents resume from ordinary wording and use the verified installed public transport when a conversation retains an older tool list, without requiring manual tokens or a thread restart.
- Repair Captain's self-host red-test pattern without weakening its regex validator or changing its required gates.
- Exercise public status-to-recovery continuation, stopped/live owners, generation changes, receipt paths containing spaces, and the self-host startup policy.

## 0.2.0
- Add exact-generation recovery for orphaned Merge Prep/Back leases with owner verification, plus an MCP smoke test proving tool advertisement and recovery.
- Expose audited Merge Prep, Merge Back, status, and Begin/Finish aliases with merge-specific authorization and skills.
- Bind exact ignored Unity build outputs while preserving other source and dependency fingerprints.

## 0.1.6
- Expose exact-generation recovery for stale Merge Prep/Back operation and associated resource leases; record owner process metadata on new leases.
- Keep recovery fail-closed for active or unverifiable owners; require explicit stopped-owner confirmation for legacy leases.
- Add focused recovery coverage and MCP transport smoke validation.

## Unreleased

- Support Merge Begin/Finish as aliases for Prep/Back in the MCP tools, skills,
  mutation policy, and direct user integration authorization.
- Add explicit signed Merge Prep, Merge Back and merge-status MCP tools. Prep retains the
  existing source checkout, audits target convergence and verification, and stops at readiness;
  Back validates that readiness and fast-forwards the target without repeating Prep gates.
- Add separate merge-prep/merge-back skills and preserve low-level merge-tool compatibility.
- Capture direct Merge Back authorization separately from preparation requests.

## 0.1.4

- Add signed, evidence-rich pause handoffs that preserve plan and phase context, completed and next steps, blockers, worktree state, and the exact cross-agent resume directive.
- Support explicit cross-session resume through `[Captain resume: intent-…]`, transferring the active worktree lease only after Captain validates the signed run.
- Allow a paused run to release session ownership so a blocker task can start as the next governed plan without losing the original resume point.

## 0.1.3

- Bootstrap the Captain MCP server from `CODEX_PLUGIN_ROOT`, `PLUGIN_ROOT`, or the newest matching Codex cache entry so hook enforcement cannot start without its required lifecycle tools.
- Cover the packaged MCP declaration with an environment-isolated startup smoke.
- Route plural merge requests and explicit continue/resume implementation prompts into the governed lifecycle before mutation gates run.
- Derive the standard Codex plugin-data directory when MCP processes do not receive hook-only `PLUGIN_DATA`, and allow audited single-file PowerShell `Get-Content -Raw` inspection before a permit exists.
- Treat Captain enforcement as repository opt-in: hooks and the skill defer to the normal project workflow until committed `HEAD` contains `.captain-sdlc/codex-policy.json`, eliminating policy-bootstrap deadlocks.

## 0.1.2

- Adopt an explicitly selected existing target branch inside the canonical worktree container, with pinned-base, clean-state, and branch-location verification.
- Keep governed multi-commit integrations open across independently validated phase commits until the declared final commit.
- Exclude only approved, untracked Unity-generated paths and root-file patterns from source proof while continuing to bind ignored dependency inputs.
- Sign a canonical target ref and full object ID from one standalone directive, then hold an authenticated exclusive lease through green completion.
- Bind every lifecycle transition to the owned worktree's branch, HEAD, top-level, common Git directory, and linked-worktree administration directory.
- Create commits with validated commit trees and compare-and-swap ref updates, and clean up rejected prepared-merge authorization and merge state.
- Recover begin, resume, commit, and completion transitions from authenticated append-only checkpoints without replaying changed arguments or approved content.
- Fence commit, merge, and abort mutations behind generation-bound authority while applying only the exact signed commit candidate during recovery.
- Authenticate chained run and lease revisions, reject stale permits and tail regression, and reconcile current-turn hook state from authoritative revisions.
- Neutralize Git environment, configuration, hook, filter, merge-driver, and attribute injection across governed repository operations.

## 0.1.1

- Enforce repository commit policy from the captured base, including strict SemVer transitions, synchronized version surfaces, changelog markers, and task-bound Git trailers.
- Bind governed MCP mutations and prepared merges to signed run state, validate merge parent vectors, and provide a pinned merge-abort path.
- Harden Git evidence and mutation subprocesses against ref races, repository hooks, external diff helpers, replace refs, unsafe policy regexes, and source-manifest exclusions.

## 0.1.0

- Add a Codex plugin that routes implementation intent into a canonical worktree and enforces TDD red, atomic versioned commit, scoped proof, artifact, and green completion gates.
- Authenticate lifecycle state, issue one-time turn permits and resume tokens, deny unaudited mutation paths, and bind proof to trusted Git policy and the exact committed source state.
