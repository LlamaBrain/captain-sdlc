# M42 - CIR_ADVERSARIAL_MECHANICAL_REVIEW
Status: In progress
Last Updated: 2026-10-28

## Definition of Done

- [x] Stage A acceptance analysis before solution inspection (separate tool-free invocations).
- [x] Mandatory SARIF adapters, configured severity and mechanically corroborated findings.
- [x] Actionable summaries/inline comments and lifecycle retention (fake GitHub).
- [x] Bounded worker remediation, fresh verification and independent re-review (library API).
- [x] Unity/C# rubric and negative tests (synthetic C# lifecycle fixtures).

## Dependencies

- M41.
- Existing blades retain their ownership and independent versions.

## Evidence

Five trusted corpus snippets compile and execute: four defects escape author
assertions but fail independent counterexamples; the repaired boundary case passes.
SARIF converts these observations into verified blocking findings. This establishes
the mechanical path, not live model detection quality. Unity fixtures simulate
lifecycle conventions; ATH/Unity runtime execution was not performed. Tool execution
stays with trusted CI collectors. CLI automatic remediation wiring and live
provider/GitHub proof remain pending. No shipped/released claim.

Subsequent local hardening preserves known verified blockers when optional
scanners fail or observations disappear. A matching current trusted resolution
receipt must identify the finding and preserve its confirming producer, version,
configuration and scope; head-only evidence cannot clear a base-bound confirmation.
Collector trust still includes the external tool's real configuration and baseline,
not only CIR's adapter identity.

An independent audit also reproduced a low-before-high duplicate false pass.
Source `d9db30a`, retained/merged locally in `9d40d92` (v0.4.5), validates every
observation before deterministic risk-preserving deduplication and includes
`captain-premerge-policy/2` in applicability. Thirteen of fourteen targeted cases
failed before correction, then all fourteen passed, including a real runner
invalidating an old cached pass and publishing pending before a fresh blocking
high-severity result. Final local verification passed 220 tests with zero
warning-as-error build diagnostics; one Explicit paid-provider benchmark was not
executed. These findings demonstrate gate hardening, not live reviewer precision,
Unity runtime behavior or a completed correction-loop MVP.

## References

- [CIR](../captain-independent-review.md)
- [Roadmap](../roadmap.md)
