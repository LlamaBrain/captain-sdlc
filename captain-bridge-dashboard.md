# Captain SDLC - Captain Bridge (Fleet Dashboard)
Created: 2026-07-09
Updated: 2026-07-09
Version: 0.1.0

## 1. Decision

The orchestration loop is deliberately CLI-first: deterministic runs, disk
records, human gates. Captain Bridge adds the missing *operating surface* — a
local dashboard where multiple agentic flows across multiple projects can be
watched and operated at once, Claude-Code-cockpit style.

DECISION: Bridge is a **renderer and command launcher, never a second
orchestrator**. It reads the existing disk contract and it invokes the
existing CLIs. It holds no state of its own beyond a project registry.

- **Read model = the disk contract.** Run records, phase history, worker
  attempts, evidence packets, reviews, approval gates, daemon leases/events,
  budgets, and the streaming worker logs already live as JSON + logs under
  each project's `.captain-sdlc/`. Bridge watches those files; there is no
  database, no index, no second source of truth.
- **Write model = the CLIs.** Every operating control shells out to the same
  commands a human would type: `captain-orchestrator run/review/approve`,
  `captain-daemon tick/serve/budget`. Tool state stays single-writer.
- **The one exception is human-owned config.** `queue.json`,
  `routing-policy.json`, and `route-config.json` are the human's assignment
  surface, not tool state — Bridge may edit those through forms, because that
  is the human doing the assigning (ADR-0012: the human owns taste).

What breaks if this stays ambiguous: the dashboard grows its own run model
and drifts from the records; buttons start "helpfully" deciding routes or
retries and the approval boundary blurs; the loop stops working headless
because state migrated into the dashboard process.

## 2. Release Bar

v1 success: two or more registered projects render as live lanes; each run
shows its phase timeline and a live tail of its worker log; the review queue
lists every `review_required` lease across the fleet; Approve runs
`captain-orchestrator approve` and the resulting PR link renders in place;
Reject runs `review --reject`. Kill the Bridge process mid-run and nothing
about the loop changes.

Not-ready evidence:

- Bridge persists anything other than its project registry and UI prefs.
- A control exists with no CLI equivalent.
- The daemon or orchestrator behaves differently when Bridge is running.
- Run state renders from memory after a restart instead of from disk.

## 3. Chosen Shape

One local process, `captain-bridge serve`, default `localhost` only:

1. **Host:** .NET 8 minimal API in a new `LlamaBrain/captain-bridge` repo,
   referencing `Captain.Core` and `Captain.Daemon` record types so parsing is
   the same code the tools use. `FileSystemWatcher` (debounced) over each
   registered project's `.captain-sdlc/`; changes push to the UI over SSE.
2. **UI:** a single static page served by the host — no build chain. Fleet
   status strip (daemon state, model-server health, budgets), project lanes
   of run cards (phase pills, route/model chips, elapsed, live log tail),
   review queue rail (Approve / Reject), and an evidence drawer that renders
   `review.md` and the linked packets for any run.
3. **Actions:** spawn the configured CLIs with the run's own paths; stream
   the child's stdout into the UI; disable a run's buttons while a CLI child
   or active lease exists for it (same duplicate-prevention the daemon uses).
4. **Registry:** `~/.captain-sdlc/bridge.json` — list of project roots plus
   the orchestrator/daemon command templates per project.

Rejected:

- **Baking into Claude Code** (plugin, extension, or statusline). Bridge's
  subject is the *multi-agent* workflow: opencode, claude, local Qwen, flay,
  and future workers running in parallel across projects. Claude Code is one
  worker adapter among many — the cockpit cannot live inside one of its own
  workers. "Claude-Code-like" describes the interaction feel, not the host.
- **Terminal TUI.** One pane, poor multi-flow density; the CLI already covers
  the single-flow case.
- **HTTP server inside captain-daemon.** The daemon stays
  schedule-and-supervise only (captain-orchestration-layer.md constraint).
- **Electron/desktop app.** A localhost page in the browser is enough.
- **Database or event index.** The disk records are small, local, and already
  the contract; indexing them creates drift.
- **Cloud/remote-first.** Localhost first; remote access is a tunnel concern
  (Tailscale et al.), not an auth system Bridge should grow in v1.

## 4. Constraints And Cross-Checks

- Every record read respects integer `schema_version`; unknown versions
  render as an opaque "newer than Bridge" card, never a crash.
- Bridge must not write under `.captain-sdlc/` except via spawned CLIs.
- The loop must remain fully operable headless; Bridge is optional glass.
- Worker logs render as bounded tails (last N KiB), never whole-file reads.
- Approve/Reject in the UI carry the same footers and gate updates as the
  CLI, because they *are* the CLI.

## 5. Failure Modes And Edges

1. **Watcher storms.** Debounce per directory; coalesce to one SSE event.
2. **Concurrent operations.** Buttons disable on active lease or running
   child; the daemon's duplicate-prevention remains the real guard.
3. **Huge or torn files.** Tail windows for logs; JSON reads retry once on
   parse failure (writer mid-flush), then render the run as "unreadable" with
   the path.
4. **Schema drift.** Version-gated rendering per record, matching Core's
   refuse-unknown rule, but non-fatal in glass: show, don't crash.
5. **Bridge dies.** Nothing happens to runs; on restart the board re-renders
   from disk. That property is the acceptance test for the whole design.

## Cross-References

- [Captain SDLC](./README.md)
- [Captain SDLC - Orchestration Layer](./captain-orchestration-layer.md)
- [Captain SDLC - Candidates](./candidates.md)
- [Roadmap](./roadmap.md)

## Resolved Decisions

- 2026-07-09 - Bridge is a renderer + command launcher over the disk contract
  and the existing CLIs; it is not a second orchestrator and holds no run
  state.
- 2026-07-09 - Human-owned config files (queue, routing policy, route config)
  are editable through Bridge; tool-written state is read-only glass.

## Open Questions

- Repo home confirmed as new `LlamaBrain/captain-bridge`, or incubate in
  `captain-orchestrator` like the review surface did?
- SPA flavor: hand-rolled vanilla + SSE, or htmx-style partials from the
  host?
- Does Bridge also render trace events (`trace-schema.md`) in v1, or is that
  a later lens?
- Remote/multi-machine fleets: registry entries pointing at network shares,
  or a Bridge-to-Bridge federation later?
- Fleet concurrency policy: today the daemon holds one active run per
  project and a local model server realistically serves one worker at a
  time. True multi-agent parallelism needs a daemon-side policy (max
  concurrent runs fleet-wide, per worker adapter, per model/server slot) —
  that belongs in captain-daemon, and Bridge only renders it.

## Version History

- 0.1.0 (2026-07-09): Initial Bridge design — read-only glass over the disk
  contract, CLI-invoking controls, localhost host shape.
