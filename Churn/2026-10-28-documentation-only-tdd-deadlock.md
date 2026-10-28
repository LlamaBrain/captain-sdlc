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

## Update - 2026-10-28: implementation and focused verification

Repair implementation is committed as `83e545800c7db7731e8138cb1596a5fe1bb32eac`
(v0.10.0), including the documentation schema-2 downgrade fence. Final focused
API/MCP/hook checks passed 33 tests with one physical Windows file-symlink test
skipped for missing privilege. Deterministic staged-link and junction coverage
passed. Legacy lifecycle, policy and authorized commit recovery passed 43/43.
Typecheck and build passed. The initial five public smoke scripts passed on their
actual earlier build; final captured proof remains pending at this update.
Logs are retained under `plugins/captain-sdlc/Temp/automation-scratch/` as
`documentation-focused-final.log` and `documentation-legacy-final.log`.

The developer fragment retains that implementation OID and target `d6d0ff1`.
The original docs run remains paused at schema 1 until the verified runtime is
installed and the supported same-task recovery runs. No CI, remote GitHub or live
review-provider success is inferred from these local tests.

## Update - 2026-10-28: actual hook compatibility follow-up

The original repair completed signed FEATURE proof at
`4e83880bbf60cf84457f2b8c1d4f8c0934fde98f` (v0.10.1): build, ticket,
feature-smoke and affected-regression each exited 0. That historical result is
retained unchanged in primary ignored scratch as
`Temp/automation-scratch/docs-unblock/repair-complete-proof.json`. It does not
certify the subsequent compatibility changes.

Before installation, an isolated real-hook reproduction found a separate reader
still enforcing the old immutable schema comparison. Core accepted the audited
schema-1-to-2 documentation transition, but actual `latestRun` and `validPermit`
both rejected it with `Captain signed run revision binding is invalid`. The
initial hook unit test exercised policy selection rather than these actual
readers. The failing reproduction and its isolated fixture are retained in
primary ignored scratch as `authoritative-hook-repro.log` and its adjacent helper;
the real authority store and original documentation task were not changed.

Supported Begin opened bounded compatibility task
`captain-docs-hook-compatibility-20261028`, intent
`intent-ea1b807c-0324-4eaa-8ee3-54d41f9e2519`, run
`codex-dd1ee1d8-537d-4e93-8e00-b70146f5a12b`, in the same retained repair
worktree at base `4e83880`. A genuine actual-reader regression failed before
product changes and the captured full ticket recorded signed red.

The follow-up extracts Core's run validation into a shared module used by the
lifecycle, actual hook readers and other signed-run consumers. Focused API/MCP
and actual-hook checks passed 40 tests, with one physical Windows file-symlink
test skipped for missing privilege; staged-link and junction cases passed.
Actual governed mutation and completion child processes now accept the valid
documentation run. Initial schema-2 records, unaudited migrations and altered
documentation scopes remain rejected. Legacy lifecycle, policy, authorized
commit recovery and hook checks passed 62/62; consumer compatibility checks
passed 24/24. Follow-up logs are retained under the ignored automation scratch
directory and copied into primary `Temp/automation-scratch/docs-unblock/`.

The compatibility fix is being prepared as v0.10.2. Its signed final proof,
installation, recovery of the original documentation intent and authorized local
integration remain separate pending outcomes. The original task remains paused;
no hosted CI, live reviewer, GitHub status or branch-protection success is claimed.
