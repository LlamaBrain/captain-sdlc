# ADR-0025: Branch-driven release manufacturing

Status: accepted direction under the branch-driven SemVer implementation task; repository adoption requires the verified policy migration below.
Date: 2026-11-12

## Decision

Release state belongs to configured branch roles. Conventional Commit intent and supported-contract compatibility evidence determine impact; milestones remain independent design identities (ADR-0002). Captain Orchestrator owns lifecycle, evidence, review packages and permissions. claude-release owns deterministic version arithmetic, artifact compilation and release tags. Models may draft intent or prose, never calculate versions.

Repositories opt into one exclusive commit mode. In branch_driven mode, isolated implementation commits carry valid Conventional Commit semantics and task/run relationships, preserve configured version values and do not edit shared release changelogs. Version-bearing files may change unrelated fields while retaining the captured version value. A trusted release-intent command is mandatory proof for the Codex plugin. It must enforce exact-revision classification and compatibility decisions; invoking a manifest printer that always exits zero is insufficient.

The default nonbreaking impact mapping is feat=MINOR, fix/perf=PATCH and docs/refactor/test/chore/ci/build=NONE. Configured types may change nonbreaking defaults. Explicit or tool-detected supported-contract breaks remain MAJOR candidates regardless of labels or defaults. Captain requires a compatibility description in addition to Conventional Commits' permitted ! shorthand.

## Branches and boundaries

Branch names, roles and allowed source/target transitions are repository policy. A common flow is feat/* -> dev -> stage -> main, with hotfix/* -> a permitted production-correction path; intermediate roles may be omitted. No branch name itself grants Git authority. Existing protected branch rules, squash-only production history, reviews, clean-source checks and exact-commit verification still apply.

Feature and integration roles accumulate semantic history without assigning a shared release version. Candidate boundaries derive prereleases against an explicit stable baseline. Stable boundaries synchronize all configured version surfaces and compile the selected milestone changelog before release verification. A development version, an annotated release tag and a published build are distinct. Milestone closure does not itself publish or tag a release.

Protected targets receive metadata through an authorized promotion PR. The actual final release commit needs fresh verification; feature proof cannot cover a later metadata merge. Tagging follows successful release integration and current final-commit verification. Ref compare-and-swap and collision checks prevent a local finalizer from overwriting a concurrent assignment.

## Squash traceability

Captain derives a Captain-Changes trailer from real source Git objects: base64url JSON with schema_version 1 and commits containing oid and full message. The destination commit must preserve the exact payload and Implements, Completes, Needs-QA and Captain-Run relationships. Captain checks the actual landed object. claude-release expands the durable payload from destination history, so later compilation does not need discarded feature refs or expiring CI artifacts. Changelog references use durable destination hashes while retaining original identities as provenance.

The trailer is data, not authenticated approval. The signed Captain release proof and destination check establish the trust boundary. A plain manifest, caller boolean or identical tree cannot substitute for this evidence.

## Compatibility adjudication

Routine NONE/PATCH/MINOR classifications proceed when configured checks and existing permissions pass. MAJOR candidates enter needs_human with contract, diff, impact, migration proposal and exact evaluated revisions. A human may confirm, reject with compatibility justification, or request revision. Decisions use existing Captain authority, are bound to relevant revisions/findings/policy, and are reused for unchanged findings. Report dates must not invalidate a decision. A relevant source or target-base change does invalidate it.

Missing, failed and not-applicable analysis are distinct. Roslyn is reused for supported C# contracts; source and binary compatibility differ. Unity serialization, player saves, mod APIs and content identity need explicit project contract posture and evidence. A pre-release save policy without migration promises must not turn every internal schema edit into a supported-contract break.

## Supersession and adoption

This decision supersedes the enforcement contract's per-implementation version/changelog mutation rule for adopted branch-driven repositories, and ADR-0018/Seam 3/Seam 8's universal human release-confirmation ceremony. It preserves their release-engine ownership, permissions and verification requirements, ADR-0017's protected squash contract, Seam 7 identity and M39/CIR review authority. Existing mandatory host approvals require explicit repository-policy migration; this ADR never bypasses them.

Old signed runs retain their captured per_commit rules. A migration/bootstrap commit must satisfy its own captured contract; supplemental version/changelog commits may therefore be required. The new mode begins only on subsequent captured policy. Do not mix old and new mutation requirements in one run.

A repository with no usable stable tag must explicitly declare an initial baseline revision, version and committed version surface. This is not a claim that the version was tagged or published. Conflicting historical tags, development numbers and unreleased entries require an explicit migration selection. Preserve historical versions, changelog entries and actual tags; never fabricate a historical release.

Dirigible needs a successor to ADR-0024 that retains ADR-0019/0032 milestone routing and their precise traceability rationale. Its consumer-specific migration remains in its owning repository or local review artifacts; installed runtime, project policy and explicit baseline selection must precede adoption.

## Implementation boundary

The first slice provides deterministic baseline/target manifests, squash transport, artifact preparation, signed compatibility decisions and local verified finalization. The in-process signed squash/finalizer composition is tested in disposable repositories. Production promotion composition, remote coordination and unsupported contract analyzers must be reported at their actual implementation status; local fixture tags are not production release evidence.

Standards: https://www.conventionalcommits.org/en/v1.0.0/ and https://semver.org/spec/v2.0.0.html.

The Codex plugin pins releaseIntentChecker.path and sha256 from the trusted base, requires the bundled checker outside repository-controlled source, synthesizes its command, and validates its digest before and after proof. The checker must enforce exact revision, compatibility and human-decision requirements. A mutable in-repository checker or an always-successful manifest printer is insufficient. Configured commit.type_impacts extends nonbreaking types. Version surfaces can additionally protect JSON mirrors through json_pointers. The governed commit API uses breaking_description to retain a compatibility description in the signed request and Git message.

An authenticated prepared merge may import already assigned release metadata from its pinned incoming parent. Every configured version value and changelog must then equal that incoming object; it cannot assign a new version or author release prose in the worker. Missing prepared-merge authority, mixed version mirrors, or retained stale metadata are rejected. This preserves Merge Prep/Back without reopening per-worker version assignment.

## Hosted policy migration observed during implementation

The read-only 2026-11-12 audit found active main rulesets in [Captain SDLC](https://github.com/LlamaBrain/captain-sdlc/rules/17049173) and [claude-release](https://github.com/LlamaBrain/claude-release/rules/17049216) still require one PR approval, stale-review dismissal, thread resolution, squash-only merges, linear history and strict status checks. These are independent of the new semantic compatibility decision. Routine releases continue to obey them until maintainers explicitly revise the applicable approval policy. If the compatibility-only human workflow is adopted, retain protected transitions, required checks and configured M39/CIR review authority; do not invoke an administrator bypass to simulate that migration. No hosting settings were changed by this implementation. Orchestrator hosted rules were inaccessible to the connected account; their state is unverified.
