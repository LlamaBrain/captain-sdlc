# ADR-0015: Interrogate keys as canonical task identity

**Date:** 2026-06-11

## Problem

Two task identities coexisted with no formal bridge. The trace schema reserved `refs.task_id` and the `implements` link relation on `code.commit.created`, but never specified the id format — examples (`BTS-142`) implied a minting service that nothing implements. Meanwhile claude-interrogate 0.1.8 shipped real, deterministic keys from `design_taskout_export`: epic keys (`{rcId}#{heading-slug}`, `-2` suffixes for duplicate headings, `section` fallback) and item keys (`{epicKey}#{12-hex sha1}` over NFKC/whitespace-normalized item text plus a NUL-delimited occurrence counter). Left ambiguous, commits link to tasks via an unspecified identity: release-time closing of mirrored tracker tasks (ClickUp) cannot be automated deterministically, and trace walkbacks dead-end at an id nothing can resolve.

## Solution

Interrogate keys ARE the `task_id`. No second id space, no minting service, no mapping table — the content-derived key emitted by `design_taskout_export` is the single task identity across all blades: commit footers (`Implements:` / `Needs-QA:` / `Completes:`, plain Conventional Commits footers parsed by claude-release's existing parser), trace events (`refs.task_id`, with `completes` and `needs-qa` added additively to the link-relation taxonomy), and tracker mirrors (the committed map sidecar keys external task ids by interrogate key). The accepted consequence — rewording an item produces a new key — is treated as a retire-and-create lifecycle event, not an identity crisis: the append-only trace keeps old keys on old events, and retired sidecar entries preserve external links forever. Specified as Seam 7 (`seam-task-identity.md`).

## Alternatives

- **Separate stable id space (`BTS-142`-style) mapped to interrogate keys** — rejected: requires a minting service and a forever-maintained mapping table to buy rename-stability that retire-and-create semantics already handle; violates KISS for marginal gain.
- **Extended checkbox markers (`- [~]`, `- [?]`) to carry status in markdown** — rejected permanently as the transport companion to this decision: breaks GFM task-list rendering and forces format changes through interrogate core (`parseRCFile`, `renderTaskout`, export, shipped-lock); footer verbs on commits carry intermediate states instead.
