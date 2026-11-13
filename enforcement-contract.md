# Captain SDLC enforcement contract

Captain Orchestrator owns lifecycle enforcement. claude-release owns release computation, changelog manufacturing and release tags. Repositories configure their contract in .captain-sdlc/project-policy.json. [ADR-0025](ADR/0025-branch-driven-release-manufacturing.md) defines branch-driven adoption and supersession.

## Verification and task identity

Implementation success requires the configured verification command to return zero at the recorded exact Git revision. Approval rejects stale evidence. Preserve Implements:, Completes:, Needs-QA: and Captain-Run: relationships and the existing task identity. Review, compatibility adjudication, Git merge permission, release verification and publication are separate authorities.

## Atomic implementation history

Approval requires a clean owned worktree descended from its pinned base. Each implementation commit must satisfy the captured contract; imported history requires existing prepared-merge authority. Preserve the executable runtime's atomic-commit and protected-branch constraints. Do not infer permission to rewrite history or bypass a required review.

## Exclusive commit modes

An adopted branch_driven policy requires valid Conventional Commit intent, nonempty compatibility descriptions, unchanged configured version values in implementation history, and durable semantic/task traceability. Workers do not update a common changelog. Release-intent validation combines commit intent and supported-contract evidence; missing evidence is explicit. The Codex plugin requires a captured trusted release-intent proof command in this mode.

At configured candidate/stable boundaries, claude-release calculates the aggregate impact from an explicit baseline and target, compiles the selected changelog and synchronizes configured version surfaces. A MAJOR candidate requires revision-bound human compatibility adjudication. NONE/PATCH/MINOR classifications introduce no additional semantic approval ceremony once their checks pass.

Legacy per_commit policies and already signed runs retain their captured version suffix, deterministic version-surface mutation and version-linked changelog requirements until explicitly migrated. This is migration compatibility, not an alternate rule to apply simultaneously to branch_driven work. Bootstrap/supplemental commits obey their own captured policy.

## Protected promotion and squash history

Branch roles and transitions are configurable. Preserve repository protections and squash-only production contracts. Promotion metadata reaches protected branches through an authorized PR. Captain derives durable Captain-Changes transport from Git, checks the actual destination payload/footers, and retains exact release verification. claude-release tags only the final verified release commit following successful integration. Caller-supplied manifest JSON is not permission or verification.

## Containment and enforcement

Owned worktrees remain under the primary repository's .captain-sdlc/worktrees container. Core validates policy, Orchestrator enforces lifecycle, hooks guard manual Git operations, and CI reruns the validators. Local hooks are defense in depth; host protections remain merge authority. New adopted policy does not rewrite old signed evidence.

The Codex plugin pins releaseIntentChecker.path and sha256 from the trusted base, requires the bundled checker outside repository-controlled source, synthesizes its command, and validates its digest before and after proof. The checker must enforce exact revision, compatibility and human-decision requirements. A mutable in-repository checker or an always-successful manifest printer is insufficient. Configured commit.type_impacts extends nonbreaking types. Version surfaces can additionally protect JSON mirrors through json_pointers. The governed commit API uses breaking_description to retain a compatibility description in the signed request and Git message.
