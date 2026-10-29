# ADR-0024: PR review records are revision-bound and distinct from run terminals

Updated: 2026-10-28
Version: 1
Status: proposed implementation decision under the authorized CIR task

## Context

A successful implementation run and human publication approval do not cover later PR commits, changed protected bases, policy or evidence. Reusing run terminal success as merge authority would conceal stale review.

## Decision

Preserve M39's local approval and add separate versioned PR review records. CIR-enabled publication defaults to draft and reuses the intended PR. Track pending, changes requested, review passed, human-merge-ready, merged and closed-unmerged distinctly. Passing review never automatically merges.

Fingerprint repository/PR, complete head/base/merge-base revisions and base ref, diff, material requirements/context, policy/configuration, mandatory evidence and reviewer/scanner configuration. Recheck inputs before status publication/readiness. Changed inputs return to pending; stale reviews cannot authorize a new head. CLI reconciliation works without a daemon and accounts for base advancement.

Bind Core's policy-engine identity, the captured test-merge revision and the complete current same-head open-PR set with its collection provenance. Commit statuses do not contain PR-number scope. Withhold ordinary success/readiness when that scope is ambiguous or unavailable. Base-bound verification must retain the producer's actual execution revision; head-only CI cannot become current-base proof through PR metadata. Known verified defects retain their own confirmation/resolution receipts across PR iterations.

Publish captain/premerge-review as an exact-head commit status. Pending maps to pending, pass to success, blockers to failure and evaluation errors to error. Human-authorized repository protection must require it and prevent indefinite reliance on outdated base assessments. Detect/report absent or unknown enforcement. Bot approval is not a substitute for GitHub human approvals; solo operation need not demand an unavailable second person.

Separate read-only provider/scanner contexts from authenticated writes. Do not execute PR-controlled code with privileged status credentials or through insecure pull_request_target patterns. Scanner failure cannot silently pass.

Trusted event/poll/CLI reconciliation and strict repository protections remain external enforcement boundaries. Same-SHA requirements, policy or evidence changes have a finite observation delay. Rechecking publication inputs and attempting revocation narrow races without supplying an atomic GitHub PR-scope transaction or a resident event service.

## Consequences

PR state can evolve independently of completed run records. Polling/event/CI scheduling uses the same deterministic path. A local fake-API demonstration is evidence of integration semantics, not evidence that remote protection or a live status was applied.

See [CIR](../captain-independent-review.md).
