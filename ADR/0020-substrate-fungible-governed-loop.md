# ADR-0020: Substrate-fungible governed loop

**Date:** 2026-07-10

## Problem

Captain Bridge's dogfood day (2026-07-10, dirigible2D M04 container-drain via flay) settled what the product actually is: not an agent that codes, but the governance around any agent that codes. The contrast case is the credit-vendor model (e.g. CharlieLabs): when a vendor sells execution credits, ungoverned burn is revenue — nine hours on a single bug bills fine — so the breaker, the failure classifier, and the cost ledger never get built, and the substrate is locked to whatever stack the vendor supports (TS-only, in Charlie's case). Meanwhile the goal here is cost savings with a scaling path: prove the loop on a $200 subscription plus opencode/local models today, and move individual tasks onto API billing or serious hardware only when a measured cost-benefit justifies it. That arbitrage is impossible if "done" is defined by the substrate, if governance lives on a vendor's platform, or if the pricing data is thrown away with the run logs.

## Solution

Bridge/daemon/orchestrator are the owner-side governed loop; execution substrates are interchangeable line items. Four invariants:

1. **The definition-of-done verify bar is substrate-blind.** Success is a deterministic check (e.g. `verify-flay-done.js`: a commit carrying the task's interrogate-key footer exists in the worktree) that never references which model or tool produced the work. A free local-qwen run and a frontier run pass the same bar.
2. **Governance lives owner-side.** The budget breaker, the hang-vs-complexity classification gate, the one-shot cheap-finisher fallback, and the ledger are implemented in Bridge/daemon/orchestrator — never delegated to a vendor platform whose credit revenue rewards ungoverned burn.
3. **Every terminal run is bookkept.** At archive time, `{run_id, task_id, terminal_state, attempts, cost_usd, turns, duration_ms, models}` is extracted from the worker logs into `.captain-sdlc/ledger.jsonl` before anything is swept. The sweep is bookkeeping, not cleanup — cost-per-closed-loop is the product's core measurement.
4. **Model routing is a ledger consumer.** The daemon's `ModelRouter` activates only when it can score substrates against measured $/closed-loop from the ledger — never on vibes.

This won because deterministic, substrate-blind success plus owner-side accounting is precisely what converts "which model" from a loyalty question into a procurement decision, with bounded downside per attempt (budgets) and compounding value across attempts (research recovery).

## Alternatives

- **Buy a vendor agent platform (Charlie-style credits)** — rejected: structural incentive misalignment (burn = vendor revenue), opaque governance, substrate lock-in.
- **Tune the loop to one substrate (claude-only)** — rejected: forfeits the local-model floor and the H200/API ceiling; the whole point is moving tasks between them on price.
- **Turn on ModelRouter scoring now** — deferred: without ledger data it routes on vibes, violating invariant 4.
