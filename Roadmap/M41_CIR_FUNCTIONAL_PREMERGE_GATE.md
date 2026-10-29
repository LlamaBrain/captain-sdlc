# M41 - CIR_FUNCTIONAL_PREMERGE_GATE
Status: In progress
Last Updated: 2026-10-28

## Definition of Done

- [ ] Independent reviewer adapter with a functioning provider through existing routing.
- [x] Validated structured findings and deterministic Core verdict (local tests).
- [x] Idempotent draft publication and distinct PR review lifecycle records (fake API).
- [x] Exact-head GitHub status, stale/failure tests and explicit human merge boundary (fake API).
- [x] Local fake-API demonstration plus honest external-validation report.

## Dependencies

- M39_CAPTAIN_REVIEW_AND_PR_GATE.
- Existing blades retain their ownership and independent versions.

## Evidence

The initial implementation was committed as `acddaa8` (v0.4.0), retained in
`2446269` (v0.4.1), and merged into local Orchestrator `dev`; no push occurred.
Its 164 passing tests, including M39 compatibility, remain historical evidence.
The first gate hardening source `96c5c6c` was retained/merged in `e4fd685`
(v0.4.3), with 205 passing tests. Engine/deduplication repair source `d9db30a`
was retained/merged in `9d40d92` (v0.4.5), with 81 Core plus 139 Orchestrator
tests passing (220 executed), one Explicit paid-provider benchmark unexecuted,
and a warning-as-error build with zero warnings/errors. Independent linked-source
review passed 18 checks without a blocker. The source-bound reports preserve
earlier failures and results rather than relabeling them as proof for later code.

The safety repairs bind the complete same-head open-PR set, actual head/base CI
execution scope, known-defect resolution receipts and Core's policy-engine
identity. They also validate every observation before risk-preserving deduplication
so a lower-severity duplicate cannot hide a verified high-severity defect. CLI
reconciliation still requires trusted scheduling and real strict repository
protections; it is not an instantaneous or atomic GitHub PR-scope transaction.

HTTP and isolated native providers use existing routing, but successful live
review remains unverified. Claude is logged out and no local HTTP endpoint was
available. Outside the sandbox, Codex is authenticated but safe reviewer isolation
has not been established, and GitHub CLI access to the orchestrator repository is
authenticated. The GitHub connector separately lacks repository access and status
write capability. No live PR/status/protection, remote CI-green, release, shipped
milestone or completed MVP is claimed.
Implementation reports, operations and measured deterministic corpus evidence are
retained under captain-orchestrator's `docs/` directory. Authenticated provider
and live GitHub acceptance remain required before closing M41.

The separate canonical workflow repair `cfff620` (Captain plugin v0.10.5) completed
its four signed gates with 821 passing tests and one physical-link privilege skip;
two additional merge smokes passed. It merged into local canonical `dev` and the
installed public API resumed/classified the original documentation task with the
same identity and captured policy. This is workflow-recovery evidence, separate
from CIR review quality or live merge-enforcement acceptance.

## References

- [CIR](../captain-independent-review.md)
- [Roadmap](../roadmap.md)
