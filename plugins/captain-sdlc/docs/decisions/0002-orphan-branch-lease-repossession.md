# Explicit repossession of orphan branch reservations

Status: accepted direction from Michael, 2026-10-11; implementation verification is recorded separately.

An old held branch lease can outlive its owning run and all request/progress
records. Existing task, failed-Begin and merge recovery APIs require that original
authority. Creating another checkout or changing sessions leaves the branch lease
held and adds confusion. Michael directed a supported fresh-lease/repossession
repair and explicitly required retaining the same worktree.

Provide read-only authenticated diagnosis and narrowly scoped operator-directed
repossession. Diagnosis pins the actual registered target/common Git directory,
current HEAD and opaque lease generation, verifies existing signatures/chains and
watermarks, and refuses surviving authority/progress, task workspaces, active or
foreign ownership and pending Git. Missing PID, missing run or time alone is
insufficient. Raw legacy signed payloads must bind repository, branch and a valid
historical commit; they do not receive filename-binding by assumption.

Record the original human repossession direction and concrete reason separately
from stopped-owner proof. Hold the old Begin attempt fence, publish a signed
retirement tombstone and recheck eligibility before an immutable exact-generation
release. Later Begin checks the tombstone. Interrupted retries remain correlated;
replacements and stale generations are never followed. Only this recovery's own
registered guard can be recovered after positively verified local process stop.

Normal existing Prep acquires the fresh lease in its retained checkouts. Recovery
does not allocate worktrees, rewrite Git, touch dirty files/index, reopen old runs,
relocate evidence, grant integration authority or replace a known owner's supported
continuity workflow. General forced takeover, TTL and heartbeat policy are outside
this bounded repair.

## Authenticated failed Begin companion

Discovery on the actual target found surviving issuance/Begin/repository/lease
records from another session, rather than an orphan. This is a failure of the
original C3 recovery goal to continue the existing task, not permission to weaken
orphan eligibility. Michael's explicit repossession direction permits a separate
operator revocation of an unstarted request after full graph verification.

Authenticate the ORIGINAL signed root/session/issuance/Begin/checkpoints, and pin
the actual registered target separately. Discovery on 2026-10-12 also found that
the target had advanced since the failed request. Authenticate the original
historical commit and its mutually consistent checkpoints; preserve the diagnostic
that the original pin differs from the current ref. Pin and recheck today's HEAD
independently rather than require an abandoned reservation to freeze that ref. The existing Begin diagnostic expects
its target_worktree to equal that original root; it cannot certify an invented
replacement root. Require terminal lease_checkpointed state and no later task
workspace, run, activation, permit, active attempt, canonical refs/paths or Git
operation. Preserve a fully verified completed-session tombstone interpretation;
any unrelated session resources remain untouched.

Under the same old Begin attempt fence, journal explicit operator direction,
publish the existing standard cancellation marker and release only the pinned
branch generation. Old supported runtimes recognize that marker. Never set a
false original-owner-stopped attestation, adopt another task or create a checkout.
Orphan, request revocation and progressed-owner continuity remain distinct paths.

## Unrelated paused session projection

On 2026-10-12 the actual request's broad active flag was traced through public
authenticated diagnostics to a different retained task: its latest signed state
was paused, its session lease released, and its recognized projection matched
that task's activation. It referenced none of this failed request's intent,
operation or run identifiers and owned no actual target checkout.

The operator-only path may retain that unrelated paused task while revoking this
unstarted request. Require all of those correlations; preserve the broad active
flag, every original record and all unrelated task/session resources. Independently
retain original-attempt and actual-target owner/mutation checks. An uncorrelated
projection, matching original reference, held session ownership or running owner
remains refused. Ordinary original-caller cancellation is unchanged.

## Idle failed merge records

Public discovery on 2026-10-12 identified four unrelated saved FAILED merge
records as the remaining broad target-owner refusal. Each operation lease was
authenticated and released, with no retained prepared merge/commit/finalization
or held matching mutation resource. Historical source identities remained valid
despite later HEADs; old target bindings were stale. The independently selected
current target binding was valid and its held resource belonged only to the failed
Begin being retired. The distinct historical source reservation is preserved.

In the operator companion only, recognize an idle FAILED record after all of
those resource and graph checks. Verify historical pins through the selected
repository, require the source identity and no pending Git operation, and retain
exact current target checks. A distinct held source reservation must positively
match the known legacy branch producer, with no unknown operation or metadata.
Any held resource referencing a candidate merge remains protected, including a
detached mutation fence. Keep every saved record and unrelated lease unchanged;
normal future Prep/Back binding checks and strict orphan rules are unchanged.
