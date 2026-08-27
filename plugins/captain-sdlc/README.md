# Captain SDLC Codex plugin

This plugin makes implementation intent executable policy rather than prose.

- `UserPromptSubmit` classifies implementation requests and issues a one-time intent.
- `PreToolUse` denies mutation until `captain_begin_implementation` owns a canonical worktree for the same session and turn.
- MCP tools enforce the TDD red gate, atomic Conventional Commit + SemVer + changelog gate, trusted scoped proof commands, and required artifacts.
- `Stop` continues incomplete governed turns and permits completion only after `complete/green` evidence.

Each governed repository must commit `.captain-sdlc/codex-policy.json`. Proof commands come only from that trusted file; MCP callers cannot replace them with `exit 0`.

## Local verification

```powershell
npm install
npm test
npm run typecheck
npm run smoke
```

## Installation

From the Captain SDLC repository root:

```powershell
codex plugin marketplace add .
codex plugin install captain-sdlc@personal
```

Restart into a new Codex thread, review and trust the plugin hooks, then make an implementation request. Codex intentionally skips changed hooks until their new hash is trusted.
