# Captain SDLC — Claude Code harness hooks

The fleet-wide Claude Code hook layer (ADR-0016). These scripts are wired once
from `~/.claude/settings.json` and apply to every project an agent works in —
the deterministic enforcement layer for rules that used to live as prose in the
global CLAUDE.md. Zero dependencies, Node only, each reads the hook JSON on
stdin.

| Script | Event (matcher) | What it does |
|---|---|---|
| `enforce-worktree-location.js` | PreToolUse (`Bash`/shell) | Denies `git worktree add` and `git worktree move` when the destination is outside the owning repository's `.captain-sdlc/worktrees/` directory. |
| `protect-files.js` | PreToolUse (`Edit\|Write\|NotebookEdit`) | Denies edits to `.env*` (except `.example/.sample/.template`), lockfiles, `.git/` internals, and key material. Exit-2 deny holds even under skip-permissions — the one layer an unattended fleet agent can't bypass. |
| `compact-anchor.js` | SessionStart (`compact`) | Re-injects critical anchors after every context compaction (trust committed state, verify before "done", re-read before edit). A project overrides the defaults with `.claude/anchors.md`. |
| `verify-gate.js` | Stop | Opt-in per project: runs the check command from `.claude/verify-gate.json` and blocks the turn from ending until it passes. No config → no-op. Stands down after 3 consecutive blocks so a red check can't wedge a session. |
| `protect-branch.js` | PreToolUse (`Bash`) | Denies a local `git commit` while HEAD is a protected branch, so work starts on `dev`/`feature/*` and reaches `main` only by squash PR (ADR-0017). Default protects `main`; widen via `.claude/branch-policy.json`. Portable — the git-hygiene layer for repos without GitHub rulesets. |

The worktree shell hook is defense in depth for direct agent commands, not a Git security boundary: user-defined aliases can hide Git operations from textual hooks. Captain's approval gate independently resolves the Git common directory and rejects every noncanonical recorded worktree.

## Wiring (in `~/.claude/settings.json`)

```json
{
  "hooks": {
    "SessionStart": [
      { "matcher": "compact", "hooks": [{ "type": "command", "command": "node E:/Personal/captain-sdlc/tools/hooks/compact-anchor.js" }] }
    ],
    "PreToolUse": [
      { "matcher": "Bash", "hooks": [{ "type": "command", "command": "node E:/Personal/captain-sdlc/tools/hooks/enforce-worktree-location.js" }] },
      { "matcher": "Edit|Write|NotebookEdit", "hooks": [{ "type": "command", "command": "node E:/Personal/captain-sdlc/tools/hooks/protect-files.js" }] },
      { "matcher": "Bash", "hooks": [{ "type": "command", "command": "node E:/Personal/captain-sdlc/tools/hooks/protect-branch.js" }] }
    ],
    "Stop": [
      { "matcher": "", "hooks": [{ "type": "command", "command": "node E:/Personal/captain-sdlc/tools/hooks/verify-gate.js" }] }
    ]
  }
}
```

## Per-project opt-ins

- **Verify gate** — drop `.claude/verify-gate.json` at the project root:
  `{ "command": "npx tsc --noEmit && npx eslint . --quiet", "timeoutMs": 180000 }`
- **Compaction anchors** — drop `.claude/anchors.md` to replace the default
  anchor text with project-specific invariants.
- **Branch policy** — drop `.claude/branch-policy.json` to widen the protected
  set beyond the default `main`: `{ "protected": ["main", "dev"] }` (the
  feature→dev→main model). Empty list opts out.

## Smoke test

```
node enforce-worktree-location.test.js                             # 9 checks
echo {"tool_input":{"file_path":".env"}} | node protect-files.js   # exit 2
echo {"tool_input":{"file_path":"src/a.ts"}} | node protect-files.js  # exit 0
echo {"cwd":"."} | node compact-anchor.js                          # prints anchors
echo {"cwd":"."} | node verify-gate.js                             # exit 0 (no config)
echo {"tool_input":{"command":"git commit -m x"},"cwd":"."} | node protect-branch.js  # exit 2 when HEAD is protected (default: main)
```
