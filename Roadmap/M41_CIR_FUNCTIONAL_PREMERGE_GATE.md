# M41 - CIR_FUNCTIONAL_PREMERGE_GATE
Status: In progress
Last Updated: 2026-10-29

## Definition of Done

- [x] Independent reviewer adapter with a functioning provider through existing routing (synthetic live boundary benchmark).
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

The `codex-cli` adapter now uses existing routing and separate acceptance and implementation invocations. It fingerprints the executable, prompts, invocation controls and observed MCP inventory, checks inventory/configuration before and after review, and fails closed on tool or error events, invalid output and incomplete turns. Trusted local configuration can race these checks; managed sources may not all be represented. This is not an OS sandbox or proof that all managed sources are disabled.

The actual adapter completed a two-case synthetic C# boundary benchmark: the final run detected the seeded defect, Core blocked the defective case using independently verified scanner evidence, and a fresh review passed the corrected case. The detection metric is location-based and does not mechanically prove the reproduction; findings at other locations are not counted as false positives. The earlier ambiguous corrected-contract result (`needs_human_review`) and later severity-metric failure remain retained as historical evidence. This small benchmark is neither a real PR nor a Unity runtime observation and does not establish general review accuracy.

The later remediation ledger and CLI lifecycle safeguards were implemented at Orchestrator `8c6ef7560eb6fa20b7eeb23dc4231b9557ad0b49` and integrated locally as `b519505` (v0.6.1). The warning-as-error build and 281 deterministic tests passed; one Unix-only case was excluded on Windows and the Codex benchmark ran separately. The library requires a protected operator-provisioned budget and does not attest the original worker assignment or provide an OS sandbox. Automatic CLI correction and a real GitHub correction lifecycle remain unverified.

GitHub CLI access to the Orchestrator repository is authenticated, while the separate connector lacked repository access and status-write capability. GitHub protection/rules reads returned 403, so required enforcement remains unknown. No real PR/status lifecycle, remote CI-green, release, shipped milestone or completed MVP is claimed. Implementation reports, operations and measured evidence are retained under captain-orchestrator's `docs/` directory. Live GitHub acceptance remains required before closing M41.

The separate canonical workflow repair `cfff620` (Captain plugin v0.10.5) completed
its four signed gates with 821 passing tests and one physical-link privilege skip;
two additional merge smokes passed. It merged into local canonical `dev` and the
installed public API resumed/classified the original documentation task with the
same identity and captured policy. This is workflow-recovery evidence, separate
from CIR review quality or live merge-enforcement acceptance.

## References

- [CIR](../captain-independent-review.md)
- [Roadmap](../roadmap.md)
