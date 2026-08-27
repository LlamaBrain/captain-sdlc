# M40 — Codex-Enforced Implementation Pipeline

Status: Complete

## Worktree handoff

- Owner: Codex `/root`
- Branch: `feat/codex-enforced-implementation`
- Base: `208db2525c7de9e86531c2fa74f5239c62ec781e`
- Worktree: `E:/Personal/captain-sdlc/.captain-sdlc/worktrees/codex-enforced-implementation`
- Scope: Captain SDLC Codex plugin, MCP lifecycle gateway, enforcement hooks, tests, installation documentation
- Verification: TypeScript typecheck, unit tests, plugin validation, MCP protocol smoke, hook denial/permit/completion smokes

## Acceptance criteria

- Natural-language implementation requests inject a mandatory Captain entrypoint instruction.
- Repository mutations are denied until the same Codex turn owns an active Captain implementation permit.
- The MCP lifecycle enforces ordered TDD planning, implementation, atomic commit, scoped proof, and completion evidence.
- Completion fails closed unless required tests, new feature smokes, affected regressions, testable build, and required visual evidence are recorded green.
- Pre-release mode requires the deterministic super-smoke scope.
- Plugin packaging is valid and installable from the repository marketplace.
- Tests prove bypass attempts are denied and the governed happy path passes.
