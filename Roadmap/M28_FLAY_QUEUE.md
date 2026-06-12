# M28 — FLAY_QUEUE
Status: Stub
Last Updated: 2026-06-11

## Definition of Done
- [ ] (Populated by /taskout)

## Theme
(populated by /taskout — sketch: a human-assigned ordered queue of task keys that
/flay-auto works down sequentially; assignment stays human (ADR-0012), the loop
only conducts. Verify failures downgrade to HITL and halt the queue — failures
stop, they never compound. Completion footers default to Needs-QA. Likely a
`queue[]` array alongside .captain-sdlc/flay-state.json plus a loop driver.)

## Goals
- (populated by /taskout)

## Targeted
(populated by /taskout)

## Blockers & Dependencies
- **External**: live-fire trust in single-task flay — at least a few supervised
  /flay runs and one real release through the Seam 7 pass before any loop runs
  unattended.

## References
- Top-level index: `../roadmap.md`
- `../flay-task-harness.md`
- `../seam-task-identity.md`
