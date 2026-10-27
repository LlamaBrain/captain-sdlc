# Captain SDLC enforcement contract

This contract turns agent guidance into repository policy. Captain Orchestrator is the executable owner; consuming repositories select their version and changelog surfaces in `.captain-sdlc/project-policy.json`.

## Implementation success

An implementation run cannot enter `success` without a configured verification command returning zero. Verification evidence records the exact Git `HEAD`; approval rejects evidence from any other commit.

## Atomic phase boundary

Approval requires a clean worktree, a `HEAD` descended from the captured base, exactly one implementation commit in `base..HEAD`, passing verification for that exact `HEAD`, and a valid project commit contract. Approval never stages files or manufactures an aggregate implementation commit.

## Commit contract

Captain validates the Conventional Commit subject and version suffix, deterministic type-derived SemVer, every configured version surface, a changed changelog containing the version marker, and an `Implements:`, `Completes:`, or `Needs-QA:` trailer naming the run task.

## Worktree containment

All worktrees owned by a repository live below `<primary-repo>/.captain-sdlc/worktrees/`. Git's common directory identifies the primary repository even when Captain runs from an existing linked worktree. Orchestrator constructs the destination and the shell lifecycle hook rejects manual destinations outside it.

## Enforcement layers

1. Captain Core validates configuration and identifiers.
2. Captain Orchestrator blocks invalid run and approval transitions.
3. Lifecycle hooks reject invalid manual Git operations before execution.
4. CI reruns the same validators; local hooks are defense in depth, not merge authority.
