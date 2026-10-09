# Captain SDLC Codex plugin

This plugin supports clean Git hygiene and preservation of authorized work.

## Explicit user authorization

Direct user instructions such as `commit`, `commit it`, `approve commit`, or `merge to spike/colony`
are authorization, not invitations to ask again. UserPromptSubmit and the client intent adapter
store signed local receipts containing the original wording, session/turn, repository, source
branch, governed task when available, and exact merge target. Later prompts restore these receipts.
Use `captain_user_authorization_status` to retrieve them after a handoff. Revocations remain in
the ordered record. Approvals do not silently transfer to another repository, task or merge target.

This is evidence capture, not another approval gate. The parser intentionally recognizes a small
set of direct instructions; missing receipts do not invalidate clear authorization in conversation.
Quoted examples, discussion, code fences and commands to push are not converted into approval.
Client-adapter receipts identify their source separately from direct prompt-hook receipts.

After approval, verify Git branch/HEAD, scoped changes, version/changelog and relevant proof,
then preserve the work in a commit. A commit does not imply a push or a green release proof.
The parent SemVer baseline comes from the configured `version_file`; a stale companion such as
Doxygen can be repaired in that new commit. Every candidate version surface must still agree.

- `UserPromptSubmit` classifies implementation requests and issues a one-time intent.
- `PreToolUse` denies mutation until `captain_begin_implementation` owns a canonical worktree for the same session and turn.
- MCP tools enforce the TDD red gate, atomic Conventional Commit + SemVer + changelog gate, task-bound trailers, signed merge preparation/abort, trusted scoped proof commands, and required artifacts.
- `Stop` continues incomplete governed turns and permits completion only after `complete/green` evidence.

Each governed repository must commit `.captain-sdlc/codex-policy.json`. When `commitPolicyPath` is configured, its schema-versioned repository policy is also loaded from the captured base. Proof commands and commit rules come only from that trusted state; MCP callers cannot replace them with `exit 0` or mutable working-tree policy.

## Merge Prep and Merge Back

Integration uses two explicit MCP operations in the existing task checkout:

Merge Begin is an alias for Merge Prep; Merge Finish is an alias for Merge Back.
The MCP aliases are `captain_merge_begin` and `captain_merge_finish`. They use the
same arguments, signed `merge_id`, checks, and authorization rules as the canonical
tools. Either spelling can continue an operation started with the other spelling.

- `captain_merge_prep` pins the local target, pulls it into the source through an audited
  no-commit merge, retains conflicts for source-side resolution, and runs the existing
  strictness checks after the result is committed. It stops at signed `ready` with the
  target unchanged. Continue the same `merge_id`; do not replace the task worktree.
- `captain_merge_back` consumes that readiness, checks the exact prepared pair and current
  inputs, then fast-forwards the target without repeating Prep checks. Run it only with
  matching user integration authorization. `captain_merge_status` exposes the current record.
- `captain_recover_merge_lease` releases stale merge-operation and its associated
  integration-worktree/branch leases after checking the merge ID, signed revision,
  source/target identity, session, pinned bindings, and exact operation lease token. New
  leases include owner process metadata and cannot be recovered while that process is alive.
  Legacy leases require explicit confirmation that their owner stopped. Resume with the same
  `merge_id`; recovery leaves the merge ledger and Git refs unchanged.

Merge readiness and Git integration are separate from signed implementation `complete/green`,
human plan acceptance and release proof. A completed implementation run retains its original
proof; integration has its own signed record. Caller-supplied commands cannot replace gates.
The existing `captain_prepare_merge`/`captain_abort_merge` tools retain their low-level contracts
for current implementation clients. A request for Merge Prep never implies Merge Back.

## Routing and emergency control

Ordinary requests are never governed. To start a governed worktree run, put a standalone task directive in the request: `[Captain plan: TASK-ID]`; add `[Captain target: branch]` when the plan must integrate a specific local branch.

## Handoff, pause, and resume

### OpenCode (first-class adapter)

Captain includes an OpenCode plugin adapter at `opencode/captain-sdlc.mjs`. It detects implementation requests, issues a signed intent for the current OpenCode session, injects the exact begin/resume call, and rejects direct mutation tools until that call has granted a permit. Register the bundled MCP server and adapter globally; individual repositories do not need a custom `AGENTS.md` for the lifecycle to apply.

Captain owns operational work memory; repositories do not need custom `AGENTS.md` rules to hand work to another agent. Call `captain_pause_implementation` with a concise summary, completed and next steps, blockers, plan/phase, and any context worth preserving. Captain adds the signed run identity, canonical worktree/branch, current source state, and evidence ledger, releases the session lease, and returns a resume directive.

Paste that exact directive into a later request:

```text
[Captain resume: intent-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx]
```

The prompt hook mints a fresh one-time resume token; the next agent calls `captain_resume_implementation` with that token before any mutation. A paused handoff may also include a blocker redirect prompt such as `[Captain plan: INPUTSYSTEM_FIX]`; start that governed blocker task first, then resume the original run when it is unblocked.

If a Captain hook ever prevents recovery, use the installed plugin's `scripts/hook-control.mjs off`. Its status is stored in plugin data, bypasses all three Captain hooks, and is intentionally allowed by the mutation hook. Run `hook-control.mjs on` after recovery; `status` reports the current state. This replaces deleting hooks, worktrees, or repository files.

## Local verification

On Windows, `npm run build` also compiles the GUI-subsystem hook launcher using
the installed .NET Framework compiler. `npm run test:windows` verifies its pipe,
argument, exit-code, mutation-denial, and cancellation behavior. Set
`CAPTAIN_TEST_WINDOWS_LAUNCHER=1` to run the existing hook regression tests through
the launcher. The Windows hook overrides preserve synchronous decisions and
launch Node with `CREATE_NO_WINDOW`; internal Git and gate subprocesses use
`windowsHide: true`. Changed hook definitions require a fresh Codex trust review.

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
codex plugin add captain-sdlc@personal
```

Restart into a new Codex thread, review and trust the plugin hooks, then make an implementation request. Codex intentionally skips changed hooks until their new hash is trusted.
