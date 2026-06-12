# ADR-0016: Claude Code harness layer lives in the nerve-center repo

**Date:** 2026-06-11

## Problem

The Claude Code agent fleet ran on prose, not policy. The global `~/.claude/CLAUDE.md` carried ~40 lines of mechanical overrides (forced re-reads, edit-integrity rituals, verification mandates) — the documented over-specification anti-pattern: probabilistic instructions that burn tokens every session, degrade adherence to the rules that matter, and partly duplicate harness behavior. Meanwhile nothing was deterministic: no permissions allowlist existed (~9.8k permission prompts in one project's history), no hook re-anchored an agent after compaction, and nothing stopped an unattended fleet agent from touching secrets or lockfiles. The enforcement-worthy rules had no enforcement layer, and what scripts did exist (`~/.promptbook`, statusline) lived unversioned outside any repo.

## Solution

Split the prose from the policy, and version the policy here. The global CLAUDE.md shrinks to the few lines only prose can carry (taste, honesty, phasing, fleet awareness). Everything enforceable becomes a hook script under `tools/hooks/` in this repo — `protect-files.js` (PreToolUse deny on secrets/lockfiles/`.git`, holds under skip-permissions), `compact-anchor.js` (SessionStart re-injection of fleet anchors after compaction), `verify-gate.js` (opt-in Stop gate that blocks "done" until the project's check passes) — wired once from `~/.claude/settings.json`. Permission friction is handled by an empirical allowlist derived from transcript history (read-only shapes and test runners globally; hot project-specific commands like `unity-mcp-cli` in that project's `.claude/settings.json`), never `Bash(*)`. The nerve-center repo is the natural home per ADR-0003: the harness layer is cross-tool process, owned here until it graduates (same posture as `captain-trace`). Personal wiring (model, statusline, plugin enables) stays unversioned in `~/.claude`.

## Alternatives

- **Everything in `~/.claude`, unversioned** — rejected: the harness layer is now load-bearing for the fleet; an unversioned single copy can't be reviewed, rolled back, or adopted by another machine, and contradicts the repo-as-source-of-truth posture the rest of the toolkit follows.
- **Keep prose rules, add more emphasis** — rejected: official guidance is explicit that over-long CLAUDE.md files reduce adherence; a rule that keeps being violated wants a hook, not capital letters.
- **Classifier auto-permissions instead of an allowlist** — deferred, not rejected: `--permission-mode auto` is lower-maintenance but less explicit; the empirical allowlist preserves a human decision on every mutating shape. Revisit if allowlist upkeep becomes its own friction.
- **A separate harness repo/plugin** — rejected for now per ADR-0011's template-then-promote posture: three small scripts don't justify a distribution surface; promote when a second consumer outside this machine exists.
