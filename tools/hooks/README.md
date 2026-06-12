# Captain SDLC — Claude Code harness hooks

The fleet-wide Claude Code hook layer (ADR-0016). These scripts are wired once
from `~/.claude/settings.json` and apply to every project an agent works in —
the deterministic enforcement layer for rules that used to live as prose in the
global CLAUDE.md. Zero dependencies, Node only, each reads the hook JSON on
stdin.

| Script | Event (matcher) | What it does |
|---|---|---|
| `protect-files.js` | PreToolUse (`Edit\|Write\|NotebookEdit`) | Denies edits to `.env*` (except `.example/.sample/.template`), lockfiles, `.git/` internals, and key material. Exit-2 deny holds even under skip-permissions — the one layer an unattended fleet agent can't bypass. |
| `compact-anchor.js` | SessionStart (`compact`) | Re-injects critical anchors after every context compaction (trust committed state, verify before "done", re-read before edit). A project overrides the defaults with `.claude/anchors.md`. |
| `verify-gate.js` | Stop | Opt-in per project: runs the check command from `.claude/verify-gate.json` and blocks the turn from ending until it passes. No config → no-op. Stands down after 3 consecutive blocks so a red check can't wedge a session. |

## Wiring (in `~/.claude/settings.json`)

```json
{
  "hooks": {
    "SessionStart": [
      { "matcher": "compact", "hooks": [{ "type": "command", "command": "node E:/Personal/captain-sdlc/tools/hooks/compact-anchor.js" }] }
    ],
    "PreToolUse": [
      { "matcher": "Edit|Write|NotebookEdit", "hooks": [{ "type": "command", "command": "node E:/Personal/captain-sdlc/tools/hooks/protect-files.js" }] }
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

## Smoke test

```
echo {"tool_input":{"file_path":".env"}} | node protect-files.js   # exit 2
echo {"tool_input":{"file_path":"src/a.ts"}} | node protect-files.js  # exit 0
echo {"cwd":"."} | node compact-anchor.js                          # prints anchors
echo {"cwd":"."} | node verify-gate.js                             # exit 0 (no config)
```
