# 2026-10-28 - Documentation-only work cannot leave the code TDD phase

**Status: ONGOING - repair in progress**

**Occurrence:** 2026-10-28, America/Los_Angeles.
**Date basis:** Current conversation, public Captain status and rejected commit.
**Recorded:** 2026-10-28.

## Summary

Michael authorized CIR implementation, worktree isolation, Merge Prep and Merge
Back, then directed: "Sounds like a churn point needs fixing." and "Get unblocked".
The orchestrator implementation merged locally, but the canonical documentation
task could not commit its retained documents. Captain required an expected failing
code test for every task, including documentation-only work.

## Evidence and impact

- Original intent `intent-d63b79ad-03a1-4988-baae-d4597ae65875`, run
  `codex-4bd14bed-3885-49e9-ba7e-51cd5b15744f`, task `independent-review-docs`,
  session `cir-premerge-20261028`; retained canonical worktree and branch use that
  intent. Base is `d6d0ff10268d0ed8c5af0066ea5a6f192b9b2b92`.
- Thirteen documentation/schema paths remain retained. Public status reports
  `tdd_red`; `captain_commit` rejects: `expected implement phase, found tdd_red`.
  An intermediate `final=false` commit cannot bypass that phase requirement.
- Primary `dev` was clean. The earlier Merge Prep cleanliness error concerned the
  dirty source, not a need to discard primary changes. No signed merge operation
  was created for that failed attempt.
- Original captured FEATURE build, ticket, smoke and regression commands remain
  unchanged. The prior manual package transcript records 776 passing tests in
  about 20 minutes under the retained worktree's
  `plugins/captain-sdlc/Temp/automation-scratch/` directory. Those results are not
  relabeled as signed completion or new-revision proof.
- Separate authorized repair intent
  `intent-2784d719-0ae7-41de-b74e-e8ab093848de` uses its own registered worktree.
  A real missing-capability regression failed before product edits. The captured
  full ticket recorded signed `tdd_red` exit 1 and advanced to `implement`.
- The host timed out after 300 seconds while that test process continued. Public
  status recovered its eventual signed result without duplicate execution. This
  known transport limitation is separately recorded in
  [the completed-owner recovery incident](2026-10-17-completed-owner-failed-begin-recovery.md).

## Diagnosis

The lifecycle has no public, audited documentation classification. Commit gates
require `implement`, but the only transition from `tdd_red` requires a code-test
failure. A generic override, fabricated red test, replacement docs run or raw Git
commit would conceal the missing capability rather than repair it.

## Repair and remaining validation

Add `captain_prepare_documentation` on the original owned run. Bind exact planned
or already-dirty documents to the current SHA, record versioned provenance, and
keep all captured proof commands. Enforce the full base-to-candidate delta before
Git ref mutation and on commit recovery/proof. Release metadata permits only
exact version changes; generated directories do not grant arbitrary authority.
Documentation classification advances the run to schema 2 through a narrowly
validated revision. Older runtimes fail their immutable-schema check before
they can mutate a run while ignoring its new documentation scope. Ordinary code
runs stay on schema 1.

Repair verification, installation, original-task recovery, integration, hosted CI
and CIR live-provider/GitHub acceptance are separate outcomes. This incident stays
open until the installed public operation recovers the original docs task and its
authorized local integration completes. Live provider/GitHub credentials remain
separate external requirements; no remote status or protection change is claimed.

## Next action

Captain owns implementation, negative tests, captured proof, local installation
and resumption of the original docs task. Existing commit/integration authority
remains valid; no repeated human approval is required for this bounded repair.
