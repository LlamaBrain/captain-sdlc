# Captain SDLC — Seam 7: Task Identity & Commit Linking
Created: 2026-06-11
Updated: 2026-06-11
Version: 0.1.1

## 1. Decision

Two task identities exist today: interrogate's shipped, content-derived keys (epic `{rcId}#{heading-slug}` with deterministic -2 dedup suffixes and a `section` fallback for punctuation-only headings; item `{epicKey}#{12-hex sha1 over NFKC/whitespace-normalized text + NUL delimiter + 0-based occurrence counter}` - as implemented in claude-interrogate 0.1.8 design_taskout_export) and the trace schema's aspirational, never-formalized `refs.task_id` (BTS-142 style examples, nothing mints them). DECISION: interrogate keys ARE the task_id. Formalize that in trace-schema.md. No second id space, no minting service, no mapping table - KISS. Consequence accepted: rewording an item produces a new key; this is a lifecycle event (retire-and-create), not an identity crisis. The append-only trace keeps old keys on old events, and the committed tracker map sidecar (e.g. .clickup-map.json) retains retired keys with their external task links forever - that is the walkback path. What breaks if left ambiguous: commits link to tasks via an unspecified identity, release-time closing of mirrored tracker tasks is impossible to automate deterministically, and trace walkbacks dead-end.

## 2. Release Bar

v1 success is the FULL CHAIN: during the release pass, commits' status footers deterministically move tasks - Implements -> in progress, Completes -> complete (checks the markdown checkbox in the RC file), Needs-QA -> QA - the RC markdown is updated accordingly, and the tracker mirror (clickup-sync) closes/moves the mirrored tasks as a consequence of the markdown changing. Execution discipline: static analysis and deterministic scripts first; Haiku-class models only where judgment is unavoidable (write-time fuzzy proposals). Not-ready evidence: footers referencing keys that exist in no RC file, or the pass mis-mapping a status transition.

## 3. Chosen Shape

Shape chosen: footer verbs carry status transitions; markdown checkboxes stay binary. Three new Conventional Commits footers - `Implements: <key>` (-> in progress), `Needs-QA: <key>` (-> QA), `Completes: <key>` (-> complete + checks the box). Intermediate states (in-progress, QA) are canonical in git commit history, which is walkable; the RC file shows only open/complete. Rejected PERMANENTLY: extending the checkbox marker set (`- [~]`, `- [?]`) - it breaks GFM task-list rendering, forces format changes through interrogate core (parseRCFile, renderTaskout, export, shipped-lock comparisons), and grandfathers every existing RC file; its cost does not shrink over time. Also rejected: Jira-style inline subject-line state commands (#done) - status verbs live in footers only, subjects stay human prose.

## 4. Inspirations

No external borrowing. Conventional Commits v1.0.0 is already the house standard, enforced by claude-release today (parse-commits.js type whitelist, smell-test gate, bundled conventional-commits-parser which already parses footers - that is how BREAKING CHANGE and issue refs reach the release manifest). The CC spec defines footers as git trailers, so the three verbs are vocabulary entries in a mechanism that already ships, parsed by code that already runs. GitHub Fixes-#123 / Gerrit Change-Id parallels are trivia, not dependencies.

## 5. Constraints And Cross-Checks

(1) CC footer tokens must be single-word or hyphenated - `Needs-QA` complies; no spaced verb names ever. (2) The release manifest JSON (built by claude-release's build-manifest.js) is the SOLE input to the release pass - the checkbox-update script never re-parses git log. (3) 'Design is the human's' (existing nerve-center invariant): the pass may MOVE statuses but never invents, rewords, or scopes a task. (4) `.captain-sdlc/` schema_version policy (integer versions, consumers refuse unknown) applies to anything stored there. (5) Fuzzy matching is write-time-only: when an authored footer key exact-matches nothing, a Haiku-class model may propose nearest candidates, the human confirms, and the corrected EXACT key is what lands in the commit; the release pass itself is strict exact-match - fuzzy logic never silently moves a status. (6) claude-release has no git hooks by design ('hooks get bypassed; commands get used') - the pass is a step in the /release skill flow, not a githook. (7) The release pass edits RC markdown only; tracker mirroring remains the tracker blade's job (clickup-sync); claude-release never calls a tracker API - one writer per mirror, markdown canonical.

## 6. Failure Modes And Edges

Specified now: (1) Conflicting verbs for one key within a release -> LAST WINS by commit order; QA is routing, not a gate - hard ship-gates remain Seam 3 (release gates). (2) Footer references a retired key (item reworded between commit and release) -> WARN AND SKIP, citing the retired-key entry in the tracker map sidecar. (3) Epic-key footers are LEGAL; `Completes: <epicKey>` checks all remaining unchecked items in that Targeted section and emits a warning listing them; closing the epic is part of the release pass. One-liners: (4) `Completes:` on an already-checked box -> warn, suggest duplicated work or a stale footer. (5) Duplicate (verb, key) pairs in one manifest (rebase artifacts) -> idempotent dedupe, silent. (6) One commit may carry footers spanning multiple RCs - legal. Trace integration: footer verbs map to link relations on code.commit.created - `implements` exists; `completes` and `needs-qa` are added ADDITIVELY to the relation taxonomy, no schema_version bump.

## Cross-References

- [Captain SDLC — Candidates](./candidates.md)
- [Captain SDLC — Conventions](./captain-sdlc-conventions.md)
- [Working in a Captain SDLC project](./CLAUDE.example.md)
- [Captain SDLC — Code-Reading Capability](./code-reading-capability.md)
- [Captain SDLC — Cross-Channel Deduplication](./cross-channel-dedup.md)
- [Captain SDLC — Exposed Gaps and Ambiguities](./expose.md)
- [Captain SDLC — Glossary](./glossary.md)
- [LICENSE](./LICENSE.md)
- [Captain SDLC — Open Questions Rollup](./open-questions.md)
- [Captain SDLC — Privacy Framework](./privacy-framework.md)
- [Captain SDLC — Privacy Policy (Aspirational)](./privacy-policy-aspirational.md)
- [Captain SDLC](./README.md)
- [Roadmap](./roadmap.md)
- [Scratch](./scratch.md)
- [Captain SDLC — Seam 6: Constitution Enforcement](./seam-constitution-enforcement.md)
- [Captain SDLC — Seam 4: Cross-Tool Contract Testing](./seam-contract-testing.md)
- [Captain SDLC — Seam 2: Design ↔ Code Drift](./seam-design-code-drift.md)
- [Captain SDLC — Seam 5: Live Ops Ingestion](./seam-live-ops-ingestion.md)
- [Captain SDLC — Seam 3: Release Gates](./seam-release-gates.md)
- [Captain SDLC — Technical Debt](./tech-debt.md)
- [Captain SDLC — Cross-tool Trace Schema](./trace-schema.md)
- [Captain SDLC — Vision](./vision.md)
- [Captain SDLC — Flay: Task Execution Harness](./flay-task-harness.md)

## Resolved Decisions

- Decision boundary: Two task identities exist today: interrogate's shipped, content-derived keys (epic `{rcId}#{heading-slug}` with deterministic -2 dedup suffixes and a `section` fallback for punctuation-only headings; item `{epicKey}#{12-hex sha1 over NFKC/whitespace-normalized text + NUL delimiter + 0-based occurrence counter}` — as implemented in claude-interrogate 0.1.8 design_taskout_export) and the trace schema's aspirational, never-formalized `refs.task_id` (BTS-142 style examples, nothing mints them). DECISION: interrogate keys ARE the task_id. Formalize that in trace-schema.md. No second id space, no minting service, no mapping table — KISS. Consequence accepted: rewording an item produces a new key; this is a lifecycle event (retire-and-create), not an identity crisis. The append-only trace keeps old keys on old events, and the committed tracker map sidecar (e.g. .clickup-map.json) retains retired keys with their external task links forever — that is the walkback path. What breaks if left ambiguous: commits link to tasks via an unspecified identity, release-time closing of mirrored tracker tasks is impossible to automate deterministically, and trace walkbacks dead-end.
- Release bar: v1 success is the FULL CHAIN: during the release pass, commits' status footers deterministically move tasks — Implements → in progress, Completes → complete (checks the markdown checkbox in the RC file), Needs-QA → QA — the RC markdown is updated accordingly, and the tracker mirror (clickup-sync) closes/moves the mirrored tasks as a consequence of the markdown changing. Execution discipline: static analysis and deterministic scripts first; Haiku-class models only where judgment is unavoidable (write-time fuzzy proposals). Not-ready evidence: footers referencing keys that exist in no RC file, or the pass mis-mapping a status transition.
- Chosen shape: Shape chosen: footer verbs carry status transitions; markdown checkboxes stay binary. Three new Conventional Commits footers — `Implements: <key>` (→ in progress), `Needs-QA: <key>` (→ QA), `Completes: <key>` (→ complete + checks the box). Intermediate states (in-progress, QA) are canonical in git commit history, which is walkable; the RC file shows only open/complete. Rejected PERMANENTLY: extending the checkbox marker set (`- [~]`, `- [?]`) — it breaks GFM task-list rendering, forces format changes through interrogate core (parseRCFile, renderTaskout, export, shipped-lock comparisons), and grandfathers every existing RC file; its cost does not shrink over time. Also rejected: Jira-style inline subject-line state commands (#done) — status verbs live in footers only, subjects stay human prose.
- Inspirations: No external borrowing. Conventional Commits v1.0.0 is already the house standard, enforced by claude-release today (parse-commits.js type whitelist, smell-test gate, bundled conventional-commits-parser which already parses footers — that is how BREAKING CHANGE and issue refs reach the release manifest). The CC spec defines footers as git trailers, so the three verbs are vocabulary entries in a mechanism that already ships, parsed by code that already runs. GitHub Fixes-#123 / Gerrit Change-Id parallels are trivia, not dependencies.
- Inherited constraints: (1) CC footer tokens must be single-word or hyphenated — `Needs-QA` complies; no spaced verb names ever. (2) The release manifest JSON (built by claude-release's build-manifest.js) is the SOLE input to the release pass — the checkbox-update script never re-parses git log. (3) 'Design is the human's' (existing nerve-center invariant): the pass may MOVE statuses but never invents, rewords, or scopes a task. (4) `.captain-sdlc/` schema_version policy (integer versions, consumers refuse unknown) applies to anything stored there. (5) Fuzzy matching is write-time-only: when an authored footer key exact-matches nothing, a Haiku-class model may propose nearest candidates, the human confirms, and the corrected EXACT key is what lands in the commit; the release pass itself is strict exact-match — fuzzy logic never silently moves a status. (6) claude-release has no git hooks by design ('hooks get bypassed; commands get used') — the pass is a step in the /release skill flow, not a githook. (7) The release pass edits RC markdown only; tracker mirroring remains the tracker blade's job (clickup-sync); claude-release never calls a tracker API — one writer per mirror, markdown canonical.
- Failure modes: Specified now: (1) Conflicting verbs for one key within a release → LAST WINS by commit order; QA is routing, not a gate — hard ship-gates remain Seam 3 (release gates). (2) Footer references a retired key (item reworded between commit and release) → WARN AND SKIP, citing the retired-key entry in the tracker map sidecar. (3) Epic-key footers are LEGAL; `Completes: <epicKey>` checks all remaining unchecked items in that Targeted section and emits a warning listing them; closing the epic is part of the release pass. One-liners: (4) `Completes:` on an already-checked box → warn, suggest duplicated work or a stale footer. (5) Duplicate (verb, key) pairs in one manifest (rebase artifacts) → idempotent dedupe, silent. (6) One commit may carry footers spanning multiple RCs — legal. Trace integration: footer verbs map to link relations on code.commit.created — `implements` exists; `completes` and `needs-qa` are added ADDITIVELY to the relation taxonomy, no schema_version bump.
- Consistency updates: No overrides. The convention conforms to the existing cross-tool-seams policy: schemas and conventions live in the nerve-center docs set, not in a separate Captain-SDLC-layer tool; each blade implements its side independently (interrogate: key generation + export, already shipped 0.1.8; claude-release: footer parsing already present, release-pass checkbox script new; tracker blades: mirror-only consumers). This doc is Seam 7. Companion-plugin concerns (relocating the ClickUp sidecar into .captain-sdlc/) are cross-referenced as a separate v0.2.0 change to that plugin's protocol, not part of this seam. A follow-up ADR in captain-sdlc/ADR/ records the identity decision.

## Open Questions

- None.

## Version History

- 0.1.1 (2026-04-08): Metadata, linkage, or narrow doc maintenance update.
- 0.1.0 (2026-06-11): Initial documented draft.
