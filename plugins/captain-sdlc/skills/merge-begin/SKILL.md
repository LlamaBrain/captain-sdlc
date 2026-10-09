---
name: merge-begin
description: Alias for Merge Prep. Prepare the existing task worktree with the target unchanged and continue any already-authorized Merge Back.
---

# Merge Begin

Follow [Merge Prep](../merge-prep/SKILL.md). Use `captain_merge_begin` or
`captain_merge_prep` with the same arguments and merge ID. The tool stops at readiness;
the agent continues Back when matching integration authority already applies. A Begin-only
request stops at readiness and does not grant Back authority.
