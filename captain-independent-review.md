# Captain Independent Review and pre-merge governance

Updated: 2026-10-29
Version: 1
Status: implementation in progress; no release or live GitHub enforcement claimed.

Captain Independent Review (CIR) adds an independent evaluation after M39 publication approval. Implementation code lives in captain-orchestrator; this repository owns canonical design, shared conventions, ADRs and milestone status. The daemon remains a scheduler, ATH remains Unity runtime authority, and the existing blades remain independently versioned.

## Independence and authority

Stage A derives behavior, acceptance criteria, ambiguities, invariants, boundary/failure cases and integration surfaces without the implementation diff or author's reasoning. Stage B examines the exact candidate diff, surrounding source and independent evidence against those recorded expectations in a separate invocation. Neither provider prose nor author completion claims determine the gate. Providers have no candidate-write, GitHub approval or merge authority.

Core validates versioned findings, safe paths, line ranges/quotes and evidence references before deterministic policy evaluation. Findings distinguish verified defects, hypotheses and advisory observations; source quotations alone do not prove a defect. Empty findings require positive evidence of a completed independent review. Verified high/critical defects block, missing mandatory evidence and provider/scanner failures fail closed, ambiguous acceptance requires human judgment, and moderate findings follow project policy.

Validate every submitted observation before deduplication. A low-severity duplicate cannot hide a later verified high-severity finding, and an invalid duplicate cannot disappear into an otherwise valid group. Deduplication preserves the highest applicable risk deterministically. Core's `captain-premerge-policy/2` engine identity is included in the input fingerprint independently of the operator's policy version. Earlier cached passes and scoped exceptions therefore require reevaluation even when `ReviewPolicy.Version` remains `1`; schema version 1 remains a separate wire-format identifier.

Exceptions require policy permission, human identity, time, reason, exact finding and exact input fingerprint. Retain the original failure and the exception. A blanket force-success mechanism is excluded.

## Publication and pre-merge lifecycle

The existing implementation success and local review_required gate retain their meanings. With CIR enabled, publication opens/reuses a draft PR. A separate PR review record follows premerge_review_pending, premerge_changes_requested or premerge_review_passed, ready_for_human_merge, and merged or closed_unmerged. Review success never implies merge.

Applicability binds repository/PR, complete head/base/merge-base revisions and base ref, diff identity, relevant requirements/context, policy/config version, mandatory evidence versions and reviewer/scanner configuration. Capture the candidate before review and recheck it before publishing. Changed inputs invalidate success. Reconciliation must work from CLI without a daemon and detect protected-base advancement as well as a new head.

GitHub commit statuses are scoped to repository, SHA and context, rather than PR number. Capture the complete current open-PR set sharing the inspected head and bind its collection provenance into applicability. Unknown or incomplete scope is an evaluation error; several open PRs sharing a head require human review and distinct heads before the shared required status can authorize readiness. Recheck scope and exact head/base/test-merge inputs before publication and readiness.

Preserve CI's actual execution scope. Head-only checks retain their tested head and an empty base claim, so they cannot satisfy mandatory current-base verification. Base-bound test-merge evidence requires authenticated commit observations establishing exactly the current head and base as its two parents. A captured PR base SHA alone does not establish what an external test executed.

Publish captain/premerge-review for the inspected head: pending during evaluation/invalidation, success for applicable pass, failure for blocking/human-required results, and error for evaluation failure. An authorized administrator must explicitly configure branch protection/rulesets to require the status and current-base semantics. Report unknown/unrequired enforcement honestly. No protection changes or automatic merge are authorized by CIR. A solo maintainer can combine the required Captain status with an explicit human merge decision; a second human reviewer is not assumed.

These rules run when a trusted CLI/event/poll invocation reconciles the PR. Material requirements, policy or evidence changes at the same head are not observed instantaneously by a SHA-scoped status. Operators must arrange reconciliation and required strict protections. Publication checks and best-effort revocation narrow races; the local slice supplies neither a resident event service nor an atomic GitHub PR-scope transaction.

## Codex reviewer boundary

The `codex-cli` adapter is available through the existing reviewer routing. It uses separate ephemeral acceptance and implementation invocations, while Core validates findings and determines the verdict. The adapter fingerprints the model, executable, prompts, invocation controls and observed MCP inventory. It inventories configured MCP servers, disables observed names and checks configuration and executable identity before and after review; tool or error events, invalid output and incomplete turns fail closed.

These controls depend on trusted, stable local configuration: a concurrent change can race the inventory checks, and managed or plugin MCP sources may not all be represented. They do not prove that all managed sources are disabled, and the read-only working directory and credential scrubbing are not an OS sandbox. Use an operator-controlled isolated environment without privileged credentials for untrusted PRs.

## Scanner and context boundary

Use scanner adapters with enablement, mandatory/advisory behavior, severity threshold, tool/version provenance, timeout/failure behavior and reasoned suppressions. Mandatory unavailable or unreadable output cannot pass. Normalize scanner evidence; duplicate reports are not independent confirmations. Authenticated publication is separate from untrusted-code execution. PR text, repository docs, comments and model output cannot redefine policy or trusted instructions.

Initial context may be bounded git/text/assembly metadata with explicit limitations. M3/M11/M12 remain unshipped: Interrogate owns the planned Tier 1 text/asmdef, Tier 2 tree-sitter and Tier 3 Roslyn source-reading capability. CIR does not introduce a competing semantic analyzer service. Unity/C# attention includes cancellation/lifetimes, subscription/disposal leaks, destroyed-object/main-thread access, DI scopes, serialization/save compatibility, state synchronization and public assembly/API compatibility.

## Operator input and correction boundary

The actual CLI consumes operator-selected configuration, review state, scanner artifacts and optional assigned task JSON from outside the candidate repository, rejecting reparse-point traversal. Assigned task JSON is included in canonical requirements for Stage A. This preserves human task selection and supplies task context without relying on implementation-agent completion claims.

An optional library remediation coordinator can hand verified blocking findings to the already assigned worker in its existing worktree, run trusted verification, and request a fresh full independent review. Attempt/wall-clock/publication budgets and original task/branch identity apply. It does not select new work, let the reviewer implement, clear findings from line movement, mark the PR ready or merge. CLI automatic remediation remains an operator integration; no live correction-loop success is claimed here.

Core retains known verified findings across iterations, invalidation, optional scanner outages and omissions. A clean later report, changed line or suppression does not prove correction. Resolution requires an explicit current trusted receipt identifying the finding and matching the confirming producer, version, configuration and applicable scope. A head-only receipt cannot clear a base-bound confirmation. A permitted exact-fingerprint human exception remains a separate recorded decision and does not erase the finding or its confirmation/resolution history. The collector must preserve the external tool's real analysis scope and baseline; matching CIR adapter configuration alone does not prove that boundary.

## Delivery increments

M41 is Milestone A: functional pre-merge gate. M42 is B: adversarial/mechanical review. M43 is C: impact/context. M44 is D: quality evaluation. M40 already existed; M41-M44 were checked for collisions before this proposal. Only verified implementation/release criteria can change these milestones to shipped.

The working implementation repository retains discovery inventory, architecture, operator commands, test evidence and limitations in docs/independent-review-*.md. Quality reports must measure seeded defects, false positives/negatives, critical escapes, unresolved findings, human interventions, cost/elapsed time, disagreement and coverage. No comparative CodeRabbit result is claimed without the same benchmark being run.

### Local implementation history and remaining acceptance

The original slice was committed as `acddaa8` (v0.4.0), retained in `2446269` (v0.4.1), and merged into local Orchestrator `dev`; its 164 passing tests remain historical evidence. The first gate hardening was implemented in `96c5c6c6d76f1a9e00923d2926512937b6ff8bee` and retained/merged locally in `e4fd685de7a83fba651b2c6b6e92d06fad1a0413` (v0.4.3), with 67 Core plus 138 Orchestrator tests passing. The initial obsolete benchmark-fixture failure remains retained with its correction and fresh verification.

An independent review then reproduced a low-before-high deduplication false pass. Source `d9db30a343393593834a10544f3752f1f280ef8c` fixes validation order, risk-preserving deduplication and engine-version fingerprint invalidation; retention `9d40d92e73115832bb0183a9bbbd7cc4079bf02a` (v0.4.5) merged locally without a push. Thirteen of fourteen targeted cases failed before the correction; all fourteen then passed, including the real runner transition from an old cached pass through pending to a fresh high-severity failure. Final warning-as-error build recorded zero warnings/errors, and the full suite passed 81 Core plus 139 Orchestrator tests (220 executed). One Explicit paid-provider benchmark was not executed. An independent linked-source review passed 18 checks and found no blocker; it does not establish live model quality or remote enforcement.

The actual routed Codex adapter completed a two-case synthetic C# boundary benchmark with separate acceptance and implementation invocations. In the final run it identified the seeded defect, Core blocked the defective case using independently verified scanner evidence, and the corrected case passed a fresh review. This is not a real PR or a Unity runtime test, nor a general accuracy estimate. Its location-based detection metric requires a reproduction but does not itself prove that reproduction demonstrates the seeded behavior; findings elsewhere are not counted as false positives. The earlier integrated run that returned `needs_human_review` for an ambiguous corrected contract remains historical evidence, as do the later severity-metric failure and correction. See Orchestrator `docs/independent-review-implementation-report.md` and its retained evidence for exact results and revisions.

Live GitHub acceptance remains open. The read-only GitHub connector authenticated but lacked repository access and status-write capability; separately, outside the sandbox, GitHub CLI access to the Orchestrator repository and a Codex ChatGPT login were confirmed. GitHub protection/rules reads returned 403, so enforcement is unknown. No real PR/status lifecycle, remote CI-green, protection change, release or completed MVP is claimed.

## References

- [ADR-0023](ADR/0023-independent-review-core-authority.md)
- [ADR-0024](ADR/0024-pr-review-lifecycle-authority.md)
- [Orchestration](captain-orchestration-layer.md)
- [Conventions](captain-sdlc-conventions.md)
- [Code reading](code-reading-capability.md)
- [Version-1 review schema](schemas/premerge-review-v1.schema.json)
- [Schema authority notes](schemas/README.md)
