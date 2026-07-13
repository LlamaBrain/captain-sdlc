# Captain SDLC - Orchestration Layer
Created: 2026-07-07
Updated: 2026-07-07
Version: 0.1.0

## 1. Decision

Captain SDLC is gaining an orchestration layer. This is an addition to the existing blades, not a split of them. Interrogate, ATH, claude-release, flay, and future blades keep their own repos, versioning, and implementation ownership. The new layer gives Captain SDLC a deterministic way to record work, route it, run already-existing tools, and present reviewable outcomes. When desired, it can also act as the automated driver that keeps assigned work moving while preserving the human approval boundary.

DECISION: build the layer as five coordinated products under the Captain SDLC umbrella:

- **Captain Core** owns the common runtime model: task records, run records, routing policy, terminal states, evidence packets, config loading, and the `.captain-sdlc/` schemas needed to persist them.
- **Captain Orchestrator** owns the deterministic CLI runner: select an assigned task, invoke classification, choose the route, create a worktree, call workers through adapters, evaluate results, and escalate when needed.
- **Captain Tool Adapters** own the boundary to existing tools: interrogate, Inquisitor, flay, test runner, git, OpenCode, frontier workers, and local Qwen.
- **Captain Review Surface** owns the human-facing result package: PR generation, diff summary, evidence report, terminal state report, and the manual approval gate.
- **Captain Daemon** comes after the CLI runner works. Its first role is heartbeat/tick scheduling: it schedules and supervises already-working orchestrator runs; it does not contain route selection, worker invocation, result evaluation, or escalation logic. This is the optional resident driver: enable it when unattended queue supervision is useful, leave it off when a manual one-shot CLI is enough.

What breaks if this stays ambiguous: the always-online scheduler becomes the real orchestrator by accident, adapters grow private state models, Core collapses into a type dump, and the taste/correctness boundary gets blurred when a background service starts deciding what should be built.

## 2. Release Bar

The first release is a deterministic CLI runner, not an always-online service. Success means a human can point Captain at an already-assigned task and get a complete run record with evidence, terminal state, and a review package without the heartbeat being present. The second bar is automated driving on demand: heartbeat can notice eligible queued work, wake the same CLI/orchestrator path, enforce budgets, prevent duplicates, and stop at the review/approval gate.

Not-ready evidence:

- Core cannot validate task records, run records, routing policy, terminal states, evidence packets, and config files without importing orchestrator logic.
- The orchestrator cannot run once from the CLI without a resident server.
- The same task can be started twice because run identity and duplicate-run protection are not centralized.
- Adapter failures produce tool-specific prose only, with no normalized terminal state or evidence packet.
- The review surface cannot explain what happened without reading worker internals.

## 3. Chosen Shape

The implementation shape is additive:

1. **Core first.** Define the records, state transitions, config loader, routing policy schema, evidence packet contract, and terminal-state vocabulary. Some of this already exists in the nerve-center docs: `.captain-sdlc/`, `schema_version`, trace events, flay state, task identity, and gate verdict conventions. Core makes those operational instead of leaving every tool to rediscover them.
2. **Deterministic CLI runner second.** A one-shot command proves the orchestration path without scheduling complexity. The runner consumes Core, calls adapters, and writes Core records.
3. **Adapters third.** Existing blades stay intact; adapters normalize their invocation, outputs, failures, and evidence into Core records.
4. **Review surface fourth.** Human approval remains explicit. The surface turns Core records and git diffs into a PR, summary, evidence report, and terminal-state report.
5. **Daemon heartbeat fifth.** Only after the CLI runner is useful does the daemon schedule and supervise runs.

Rejected:

- **Start with an always-online server.** Rejected because scheduling would become entangled with orchestration before the deterministic path is proven.
- **One giant Captain build.** Rejected because existing blades already own their domains and ship independently.
- **Heartbeat-owned orchestration.** Rejected because retry, duplicate-run prevention, and budgets must be policy over runs, not hidden control flow inside a daemon.
- **Core as only schemas.** Rejected because Core needs proper functionality: config loading, validation, state transition checks, evidence packet assembly rules, routing policy evaluation, and terminal-state normalization.
- **Automation as mandatory mode.** Rejected because Captain SDLC must stay useful as a manual deterministic runner. Automation is an opt-in driver, not the only way to use the system.

## 4. Inspirations

The layer extends existing Captain SDLC patterns rather than replacing them:

- `flay-state.json` proves that local run state can be a small, explicit, gitignored record.
- Seam 7 proves that interrogate keys are task identity; Core should not mint a second task id.
- Release gates prove that verdict shapes and terminal decisions should be explicit, recorded, and overrideable only by a human with a reason.
- ADR-0012 remains the load-bearing boundary: tools own correctness, the human owns taste.

## 5. Constraints And Cross-Checks

- Existing tools remain independently versioned blades. The new layer coordinates them; it does not absorb them.
- Task identity comes from interrogate keys. No second id space.
- `.captain-sdlc/` remains the project-local state and config root.
- Every machine-readable record carries integer `schema_version`; readers refuse unknown versions.
- Trace and side-store remain gitignored local state. Config is committed by default.
- The orchestrator may select from human-authorized work, but it may not invent scope or decide what is worth building.
- Captain Daemon may wake, queue, supervise, enforce budgets, and prevent duplicate runs. It may not choose routes or evaluate worker output except by reading orchestrator/Core records.
- Automated driving only applies to work already made eligible by human-controlled assignment or queue policy.

## 6. Failure Modes And Edges

Specified now:

1. **Duplicate runs.** Core run records carry identity and lease/claim data; heartbeat and CLI both consult the same record before starting work.
2. **Stale claims.** Heartbeat may surface or expire stale claims according to policy, but expiration produces a terminal state and evidence packet rather than silently continuing.
3. **Worker failure.** Adapters translate tool-specific failures into normalized terminal states and evidence.
4. **Budget exhaustion.** Budget enforcement stops the run with an explicit terminal state; it does not retry-loop.
5. **Route ambiguity.** Routing policy may escalate to the human; it may not pick a taste-bearing route by guessing.
6. **Review rejection.** Rejection is a terminal state for that run, not a failed scheduler event.

## Cross-References

- [Captain SDLC](./README.md)
- [Captain SDLC - Candidates](./candidates.md)
- [Captain SDLC - Conventions](./captain-sdlc-conventions.md)
- [Captain SDLC - Cross-tool Trace Schema](./trace-schema.md)
- [Captain SDLC - Seam 7: Task Identity & Commit Linking](./seam-task-identity.md)
- [Captain SDLC - Flay: Task Execution Harness](./flay-task-harness.md)
- [Roadmap](./roadmap.md)

## Resolved Decisions

- 2026-07-07 - The orchestration layer is an addition to existing Captain SDLC blades, not a split or absorption of them.
- 2026-07-07 - Captain Core has proper runtime functionality, including validation, config loading, routing-policy evaluation, terminal-state normalization, and evidence packet contracts.
- 2026-07-07 - The deterministic CLI runner ships before heartbeat.
- 2026-07-07 - Captain Daemon schedules and supervises orchestrator runs only; it does not contain core orchestration logic.
- 2026-07-07 - Automated driving is optional and built on the same deterministic orchestrator path as manual CLI runs.

## Open Questions

- Which repo hosts the first Core implementation while the layer is still single-user dogfood?
- Which worker adapter is first beyond git and test runner: flay, OpenCode, local Qwen, or frontier?
- Is Inquisitor a classifier adapter, a review adapter, or both?
- When do Core/Orchestrator graduate from this nerve-center dogfood implementation into a dedicated git repo with its own release cadence?

## Implementation Home

The official Core/Orchestrator implementation home is
`https://github.com/LlamaBrain/captain-orchestrator`. The official resident
service implementation home is `https://github.com/LlamaBrain/captain-daemon`.
This `captain-sdlc` repo remains the docs/ADR/roadmap source of truth; the
implementation repos own code, packaging, and releases.

## Version History

- 0.1.0 (2026-07-07): Initial orchestration-layer decision doc.
