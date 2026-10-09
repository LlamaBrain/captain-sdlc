# Captain agent-neutral protocol

Captain is the authoritative lifecycle and work-memory service. Codex, Claude, OpenCode, and a future dashboard are clients; none owns the workflow state.

## Transport

Clients launch the Captain MCP server and call the published `captain_*` tools. A client adapter is responsible only for obtaining an explicit user-approved implementation intent and forwarding its own opaque `session_id` and `turn_id`; Captain stores those values as identifiers, not as Codex-specific data.

## Lifecycle

1. Start: an adapter issues a one-time implementation intent. The client calls `captain_begin_implementation`.
2. Work: the client records TDD/proof operations through Captain.
3. Pause: call `captain_pause_implementation` with the operational summary, plan/phase, steps, blockers, and context. Captain writes the signed handoff packet and releases session ownership.
4. Redirect: start the blocker as a normal new Captain plan, then call `captain_link_blocker` to bind it to the paused parent.
5. Resume: the next client includes `[Captain resume: intent-…]`; its adapter issues a one-time resume intent and calls `captain_resume_implementation`.
6. Discover: `captain_doctor` returns paused handoffs and unfinished runs for any client or dashboard.

## Two-step branch integration

`captain_merge_begin` aliases `captain_merge_prep`; `captain_merge_finish` aliases
`captain_merge_back`. Each pair shares its input schema and backend operation.
All spellings use the same signed `merge_id` and session binding. Begin stops at
readiness; Finish requires the same integration authority and retains Prep's gates.

`captain_merge_prep` and `captain_merge_back` own a signed integration record in the existing
source worktree, independent of the implementation run's completed proof. Clients pass their
opaque `session_id`, the exact source/target checkout identities, and the local target branch.
Prep pins the target and returns a `merge_id`; subsequent calls reuse that ID. Pending conflicts
and source-side commits are resolved before captured strictness gates can produce `ready`.
Prep always stops with the target unchanged. Back uses matching user integration authorization,
checks readiness freshness, and fast-forwards only the signed prepared source revision. It retains
Prep evidence without running gates again. `captain_merge_status` is read-only discovery for
the same operation. Keep prior signed implementation/plan proof at its actual revision.

## Plan projection

`captain_migrate_plan_state` migrates explicitly selected Markdown plan files to the bounded `captain:work-state` block. Clients must not edit outside that block when projecting lifecycle state.

## Adapter requirements

- Preserve the one-time-intent and exact-resume-token model.
- Never synthesize an intent ID from a chat/session ID.
- Present the handoff's `resumeDirective` verbatim.
- Treat Captain's canonical worktree and signed run state as authoritative.
- Keep client-specific conversation memory outside Captain's signed work ledger.
