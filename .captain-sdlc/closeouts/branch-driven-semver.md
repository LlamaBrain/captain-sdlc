# Branch-driven SemVer implementation handoff

Status: implemented and locally verified; user authorized commit and push on 2026-11-12. Bootstrap metadata and implementation commits are pushed. Captain exact-commit proof is complete/green on 2ed831d; signed upstream ancestry reconciliation and Captain hosted CI are being finalized. All three draft review PRs and implementation worktrees are retained. Updated 2026-11-12 (Pacific). This is a continuation record, not a completed release or a frozen plan.

## Ownership and captured authority

- Captain SDLC: base `3d575d7e3c227ba919aeeacd91de65f1fe2389b9`; branch `captain/intent-5a89c0ee-9d47-4afd-a74a-dceb576336f3`; worktree `E:/Personal/captain-sdlc/.captain-sdlc/worktrees/intent-5a89c0ee-9d47-4afd-a74a-dceb576336f3`.
- Signed Captain intent `intent-5a89c0ee-9d47-4afd-a74a-dceb576336f3`, run `codex-9257f09c-6a15-4ce6-b567-c7d0ae4f5e77`. It is explicitly unbound: no committed plan was frozen. Original user criteria remain the scope. Authoritative status revision 18 is complete/green on implementation commit 2ed831d00a36058ca121ecd4743d0e6b41fcc6a4, with build, ticket, feature-smoke and affected-regression gates passing. Later reconciliation readiness is separate evidence.
- Orchestrator: registered branch `captain/branch-driven-semver`, base `94570b3659436f4b0df1a754281ad01cd11f302c`, worktree `E:/Personal/captain-orchestrator/.captain-sdlc/worktrees/branch-driven-semver`.
- claude-release: registered branch `captain/branch-driven-semver`, base `afb61dec7d816c35fcd1a5f5454b52c3e2946d27`, worktree `E:/Personal/claude-release/.captain-sdlc/worktrees/branch-driven-semver`.

Finalization update: the user explicitly instructed, "You need to commit and push and provide worktree for review." Implementation commits and necessary CI repairs are pushed. Draft review PRs are Captain SDLC #11, Orchestrator #4 and claude-release #1. The exact current refs and CI evidence are listed below; no branch has been integrated into a protected target. No real protected branch was merged, production release published, or real tag created. Fixture tags exist only in disposable demonstration repositories. Orchestrator and claude-release hosted CI passed on their current PR heads. Captain hosted CI awaits the ancestry reconciliation below.

## Audit and reuse

Captain's enforcement contract and captured commit policies require per-commit version/changelog edits; ADR-0018 and release seams also contain universal human release confirmation. Those rules conflict with the requested adopted branch-driven contract. ADR-0002 milestone/version separation, ADR-0017 protected squash history, Seam 7 identity, M39/CIR review, exact verification and Git hooks remain authoritative.

Orchestrator's captured policy, worktree lifecycle, signed verification and existing approval/PR path are reused. It enforces policy and invokes the installed engine; it does not perform new release SemVer arithmetic.

claude-release's Conventional Commit parser, semver library, Roslyn analyzer, manifest and gate/artifact infrastructure are extended. The confirmed bug that ignored API-derived MAJOR when commits already implied PATCH/MINOR is fixed by taking the highest applicable evidence.

Dirigible ADR-0019/0032/0045 milestone routing and scope-reactivation rules are retained. ADR-0024's traceability rationale is preserved through durable semantic history rather than worker edits to shared version/changelog files. Its pre-release save posture is not interpreted as a universal supported migration promise.

## Implemented by repository

### Captain SDLC

`plugins/captain-sdlc/src/{lifecycle,workspace,server,release-intent}.ts` add exclusive legacy/branch-driven commit modes, trusted custom nonbreaking type impacts, meaningful Conventional Commit validation, governed breaking descriptions and content-derived task identifiers. Feature commits preserve configured version values and shared changelogs. Optional RFC 6901 JSON pointers protect mirrored values while allowing unrelated file edits.

Branch mode requires a hash-pinned external release-intent checker, executed as Node argv without a shell or authority secrets. Hashes are checked before and after execution. The checker is a required proof scope, not a successful manifest printout. Prepared merge authority may import only exact already-assigned version/changelog values from its pinned incoming object; forged, mixed or stale imports fail.

Tests: `branch-release.test.ts`, `governed-branch-commit.test.ts`, `branch-merge-import.test.ts`; generated dist is rebuilt. Existing signed request hashes remain compatible when the optional new description is absent.

Policy changes: new ADR-0025; revised enforcement-contract and enforcement skill; explicit supersession notices in ADR-0018, Seam 3 and Seam 8; ADR index updated. Existing signed runs retain their captured policy. No active project policy was silently switched.

### Captain Orchestrator

Core adds configurable branch roles/transitions, exclusive commit modes, custom impacts and JSON mirror checks. Lifecycle adds trusted release-intent validation, opt-in automatic routine PR preparation, signed aggregate promotion intent, compatibility reports/decisions and exact-revision decision reuse. Existing review permissions and atomic implementation commit constraints remain.

Durable `Captain-Changes` data is derived from Git and flattened across squashes; signed `Captain-Provenance` binds semantic messages, task/run footers, target parent and resulting tree. Missing or altered landing evidence is rejected by mandatory range validation. Later classification reads the durable destination payload rather than discarded feature refs or expiring CI artifacts. Immediate source-versus-destination verification still requires source objects at landing time.

A concurrent feature landing uses a fresh detached preview and trusted verification against the advanced target; it does not rewrite the original worker branch or reuse its stale proof. Aggregate promotion and verification-only integration proof remain separate from feature approval.

`ReleaseMetadataAuthorization` invokes pinned claude-release preparation against immutable input and compares staged bytes/modes before signing metadata. The finalizer bridge has a bidirectional parent pipe: the trusted parent retains the HMAC key, validates exact signed intent/final proof, and invokes the pinned release module without exposing authority to Node workers. Finalization/tagging is an explicit action with transition and stale-ref checks.

### claude-release

Adds explicit stable baseline/target/compatibility revisions, strict aggregate classification, durable squash expansion and baseline deduplication, explicit missing/failed analysis, configurable impacts and source fingerprints for selected Roslyn C# blobs. Explicit supported breaks cannot be lowered by a type map.

Adds candidate state, stable promotion, configurable text/JSON/Unity/Doxygen surfaces, selected per-milestone changelog output, authenticated adjudication and idempotent finalization. Expected artifact bytes derive from immutable target Git blobs. Ref compare-and-swap, duplicate tag/version checks, historical changelog preservation and executable-mode validation reject stale/conflicting finalization.

The parser retains opaque signed trailers in raw history but removes them from third-party parser input, fixing a reproduced regex CPU stall. Existing release/commit/changelog/dry-run commands route branch mode before their legacy workflow. All eight bundled entry points are rebuilt.

### Dirigible reference consumer

The consumer-specific ADR/skill migration remains a local review artifact and is not adopted. The private checkout has not been changed. Its baseline, supported compatibility posture, installed runtime and project policy must be resolved before adoption. Private source policy text and audited revision/version metadata are intentionally absent from this public handoff.

## Actual current-run verification

Captain (owned worktree):

```powershell
npm.cmd --prefix plugins/captain-sdlc run build
npm.cmd --prefix plugins/captain-sdlc test
npm.cmd --prefix plugins/captain-sdlc run smoke
npm.cmd --prefix plugins/captain-sdlc run typecheck
```

Trusted TDD red: 830 pass, 3 expected failures, 1 skip. Pre-bootstrap captured ticket: **857 pass, 0 fail, 1 skip**, duration 991737 ms. Final committed-revision ticket also passed **857/0/1**, duration 1185015 ms. Final five public MCP smoke checks and type checking passed through Captain iteration scopes. TAP evidence: `plugins/captain-sdlc/Temp/automation-scratch/package-test.tap`. Final 0.11.0 compiled server SHA-256: `6DF1B0DD686672FB3DAEC652AF6BC91A5253A62300D4202340E075395F8A01D4`. Captain signed exact-commit proof is complete/green at status revision 18 on 2ed831d, including all five public MCP smokes and type checking. Long MCP test calls time out at 300 seconds while the underlying process continues: inspect final TAP and signed status, never start overlapping ticket runs.

Orchestrator (owned worktree):

```powershell
dotnet build Captain.Orchestrator.sln --artifacts-path artifacts/active --warnaserror --nologo
dotnet test Captain.Orchestrator.sln --artifacts-path artifacts/active --no-build --nologo
```

Final build: **0 warnings, 0 errors**. Final solution tests: **81 Core + 276 Orchestrator passed**, zero failures/skips. Includes stale/unsigned proof, missing/tampered semantic payload, supported break decisions, mirror-only mutation, fresh landing, metadata authorization and finalizer bridge cases. Build/test output was captured in session tool results; no separate full-suite log was saved. Coordinate the one active build slot before running fixtures.

claude-release (owned worktree):

```powershell
npm.cmd run bundle
node scripts/verify-release-readiness.mjs
Get-ChildItem tests/test-*.js | Where-Object Name -ne 'test-production-host-demo.js' | ForEach-Object { node $_.FullName; if ($LASTEXITCODE -ne 0) { throw $_.Name } }
```

All **19 non-host test scripts** exited zero. Existing smoke coverage includes 56 gate assertions, 52 API-pair assertions, 18 smell scenarios and Roslyn 6 added/2 removed API detection. Readiness passed with six synchronized plugin surfaces and eight self-contained bundles. Final manifest bundle SHA-256: `04CEB53E9C70D0C73A6AF2CBAE481C032D53EC026E618B8507B3BC1F4E073583`; finalizer: `7E627CC6D4100191FCA7211AD441ECD66CE693821064D551780493434ECD98C8`. Outputs are retained in session tool results. All three implementation worktrees passed `git diff --check` (Windows line-ending conversion warnings only).

## End-to-end demonstration and original criteria

Reproducible fixture: `E:/Personal/claude-release/.captain-sdlc/worktrees/branch-driven-semver/tests/test-production-host-demo.js`.

```powershell
$env:CAPTAIN_ORCHESTRATOR_CLI = 'E:/Personal/captain-orchestrator/.captain-sdlc/worktrees/branch-driven-semver/artifacts/active/bin/Captain.Orchestrator.Cli/debug/Captain.Orchestrator.Cli.dll'
$env:CAPTAIN_KEEP_FIXTURE = '1'
node tests/test-production-host-demo.js
$env:CAPTAIN_FIXTURE_REJECT_MAJOR = '1'
node tests/test-production-host-demo.js
```

The initial mirror-build fixture modes exited **0**; they predate the later bundle-label-only CI repair. Their retained historical evidence:

- Normal log: `E:/Personal/captain-sdlc/Temp/automation-scratch/branch-release-demo/final-normal.log`; fixture `C:/Users/metag/AppData/Local/Temp/captain-production-host-uOEmgZ/repo`. Candidate `5912d13ae3e5cd4b9d63400f199eab9461b0b1c8` contains 1.1.0-rc.0; final verified landing `f2e85746134341a906077b194e160a3ad8291115` contains 1.1.0. Annotated tag object `91383eef8cb2c7fa5bdede3d600576977a2b47dd` (v1.1.0) peels to that exact landing commit.
- Breaking log: `E:/Personal/captain-sdlc/Temp/automation-scratch/branch-release-demo/final-breaking.log`; fixture `C:/Users/metag/AppData/Local/Temp/captain-production-host-ORkTLX/repo`. Candidate `ba92f76d37ec79d671f6d3cb91521651a47052e4`; final verified landing `016bee463b1f728b7ae0a3b97c5eb5c58a88d0a7`. Annotated tag object `03b50432d8f02b11207d3a031e0bfa92ec182acc` (v1.1.0) peels to that landing commit. Exactly one simulated compatibility decision is asserted.

The final logs contain the success assertion and an intentional stderr `PRESERVED FIXTURE` location. Windows PowerShell renders that informational stderr as `NativeCommandError`; Node exited zero and assertions passed. Independent inspection confirmed the annotated objects, exact peeled commits, candidate/stable values, Unity version and per-milestone changelog in retained Git history. These temporary fixtures are retained for inspection, not installed repositories.

The fixture exercises original criteria 1-10: two actual Captain-created feature worktrees, valid commits with unchanged three version surfaces; configured development squash integration retaining semantic/task/run evidence; concurrent fresh-target landing; aggregate staging RC plus milestone changelog; stable artifacts on all surfaces; signed final-commit release verification; actual parent/Node finalizer and annotated fixture tag; repeat existing-tag finalization; actual non-force production merge-back and signed no_release replay. The breaking mode removes OldApi, enters needs_human despite feature labels, records exactly one simulated operator rejection with all findings acknowledged, and reuses that decision across unchanged promotions. A fixture operator is not real human acceptance.

Negative checks reject missing/tampered squash payload, stale target/proof, unauthorized transition, corrupt staged history, wrong final metadata and authority leakage. Hosted GitHub calls use a fixture adapter/local Git. This is evidence for the local working vertical slice, not actual GitHub protection, publication or deployed build evidence.

## Hosted policy audit and explicit migration

Read-only GitHub audit found current active [Captain main ruleset](https://github.com/LlamaBrain/captain-sdlc/rules/17049173) and [claude-release main ruleset](https://github.com/LlamaBrain/claude-release/rules/17049216) require one PR approval, stale-review dismissal, thread resolution, linear history and squash-only merges. Strict required checks are respectively `link check` and `Gate,   bundle sync, and smoke tests`. Development branches have deletion/non-fast-forward protection. No rules or bypasses were changed or used.

These hosted one-review rules still require routine merge approval independently of semantic classification. If maintainers choose the requested compatibility-only human workflow, explicitly migrate the applicable PR approval count/actor policy while retaining required checks, protected transitions, squash history and configured M39/CIR authority. The implementation itself grants no administrator bypass. Orchestrator hosted rules were inaccessible through this connection (404); Dirigible main metadata reported unprotected, but its rulesets endpoint was inaccessible (403). Treat unknown rules as unverified.

Captain local base is ahead of/diverged from hosted dev; adoption must reconcile the existing unpublished stack rather than pushing it blindly. Remote CI must run on the eventual authorized PR/revision before any claim of CI-green completion.

## Remaining limits and genuine decisions

- This is source-ready local functionality, not installed/adopted runtime or hosted rollout. Local commits and pushes are explicitly authorized. Captain exact-commit implementation proof is complete/green; Orchestrator and claude-release hosted CI are green. Captain ancestry reconciliation and hosted CI remain in progress in this record.
- Unity serialization, save schemas, mod APIs and content identity analyzers are not implemented. Missing coverage is explicit and blocks required evidence; not_applicable requires trusted project posture/reason. C# fingerprints cover only the existing analyzer's selected committed sources. Exhaustive-C# decision reuse is opt-in and unsuitable for Dirigible's additional contracts.
- Compatibility actor is a signed operator label under existing Captain HMAC authority, not a new external identity service. Preserve the authority key for durable verification; do not expose it to workers.
- Changelog manufacture supports a configured selected milestone destination. Automatic arbitrary multi-milestone allocation is not claimed.
- Compare-and-swap protects Git assignments; this adds no distributed reservation database. Hosted merge races require a fresh target/proof and retry. Published builds remain separate from development metadata and tags.
- Dirigible adoption needs the explicit baseline/contract posture and an authorized isolated implementation session; its draft has not superseded live documents yet.

## Bootstrap exception resolved by commit-and-push instruction

Automatic approval review rejected the attempted Captain version/changelog mutation before dispatch: "The command mutates project version surfaces and the shared changelog in a feature worktree, contrary to the user's explicit instruction not to do so; the isolated checkout does not authorize that side effect." No denied mutation took effect; a later retry occurred only after the new explicit user instruction.

The captured old policy still requires that metadata for the atomic migration commit. The installed enforcement skill states: "Never change a signed run's policy to pass a gate." This does not itself create a new approval ceremony; it prevents relabeling this already signed legacy run as branch-driven. Existing general task authorization did not satisfy automatic review for the explicit no-worker-metadata exception. Do not retry indirectly or edit the signed policy.

Concrete review-only patches, both rechecked with `git apply --check`:

- `E:/Personal/captain-sdlc/Temp/automation-scratch/branch-release-demo/captain-bootstrap-metadata-proposed.patch`: Captain 0.10.13 -> 0.11.0 across package/lock/plugin/server plus a development Unreleased entry.
- `E:/Personal/captain-sdlc/Temp/automation-scratch/branch-release-demo/orchestrator-bootstrap-metadata-proposed.patch`: Orchestrator 0.6.3 -> 0.7.0 plus a development Unreleased entry.

Versions were computed by actual claude-release applyBump, not model arithmetic. The user's subsequent commit-and-push instruction resolves the prior concrete bootstrap proposal. Both metadata patches are applied; Captain is 0.11.0, and Orchestrator bootstrapped at 0.7.0 then advanced to 0.7.2 for two required Linux CI repair commits. They do not tag or publish releases. This is a one-time bootstrap exception for these metadata changes and their atomic local migration commits. It does not authorize routine worker version mutation under the new contract, protected merges, tag pushes or publication.

Completed continuation: the same Captain intent/worktree resumed, bootstrap metadata was applied, scoped implementation commits were created and pushed, and Captain exact-commit proof reached complete/green at revision 18. Review PRs are open; source-only upstream reconciliation and its hosted CI are the remaining publication checks in this record. Select/adopt repository policies only after installed runtime and baseline decisions are ready. Preserve all dirty unmerged worktrees and evidence.


## Review publication and signed upstream reconciliation

The current user instruction authorizes the local migration/repair commits and review-branch pushes. All PRs remain drafts; no protected merge, release publication or tag push is authorized or performed.

| Repository | Review | Pushed implementation/repair head | Retained worktree |
|---|---|---|---|
| Captain SDLC | https://github.com/LlamaBrain/captain-sdlc/pull/11 | implementation 2ed831d00a36058ca121ecd4743d0e6b41fcc6a4; subsequent signed ancestry reconciliation described below | E:/Personal/captain-sdlc/.captain-sdlc/worktrees/intent-5a89c0ee-9d47-4afd-a74a-dceb576336f3 |
| Orchestrator | https://github.com/LlamaBrain/captain-orchestrator/pull/4 | 2f701d41af7fd0b45fc32e76ba68d499cac6d42c | E:/Personal/captain-orchestrator/.captain-sdlc/worktrees/branch-driven-semver |
| claude-release | https://github.com/LlamaBrain/claude-release/pull/1 | 341d1c402770d644840a5160fa633da9f123580b | E:/Personal/claude-release/.captain-sdlc/worktrees/branch-driven-semver |

Orchestrator's first hosted run exposed a mismatched build output directory and a Linux backslash in a sequence fixture. A second run exposed the scrubbed benchmark process's missing DOTNET_CLI_HOME. Focused patch commits align CI to artifacts/active, use a portable path and provide an isolated CLI home without restoring inherited credentials. The final local 81+276 tests and both [Ubuntu/Windows CI jobs](https://github.com/LlamaBrain/captain-orchestrator/actions/runs/43353953262) passed on 2f701d4. claude-release's first CI run exposed dependency-path labels from primary-checkout bundles; rebuilding with worktree-local lockfile dependencies fixed freshness without a semantic source change. All 19 scripts and [hosted CI](https://github.com/LlamaBrain/claude-release/actions/runs/43353602400) passed on 341d1c4.

Both final production-host demos were rerun after those repairs and exited zero against release head 341d1c4 and final CLI SHA-256 `8CDC5D0EBAB755AA98B12E2AC7BEBFAA79461A5D181BC9A2E85CBE27137188AB`. Final logs are `E:/Personal/captain-sdlc/Temp/automation-scratch/branch-release-demo/current-normal.log` and `current-breaking.log`; retained fixture roots are `C:/Users/metag/AppData/Local/Temp/captain-production-host-bX87dY` and `captain-production-host-QXReqU` respectively. These supersede the initial fixture runs for current-build claims. They preserve all original criteria, including exactly one simulated decision in the breaking run.

Captain PR #11 initially could not schedule CI because hosted dev 0c7750d and the existing local stack have divergent squash ancestry. Read-only verification proved `0c7750d58c7683a7f904f54a857bebe02c4d188f^{tree}` equals `28a1de5^{tree}` (`14d4e485655e8deca23f92c9933596768648b6dc`), and 28a1de5 is an ancestor of the source implementation 2ed831d. No hosted content is missing. After implementation proof completed green, signed Merge Prep `merge-39fbbe75-4ebb-4cf7-8f2a-874232bfc915` pinned that exact upstream object through the clean local target checkout `E:/Personal/captain-sdlc/.captain-sdlc/worktrees/branch-driven-semver-upstream`, branch `captain/branch-driven-semver-upstream`. That checkout is a retained read-only upstream reference, not a new implementation run, dev readiness claim or authorized Merge Back target.

The 12 conflicts were resolved to the exact tested source tree; the initial reconciliation aa479af changed only this factual closeout. Its subsequent Merge Prep whitespace check exposed CRLF source blobs committed by hardened Git while the earlier plain-Git check normalized them, plus one old bookkeeping EOF blank and the proposal patch's space-only context lines. The follow-up repair normalizes 18 task files to LF in two independently verified phases, removes that EOF blank, and removes only the patch context space prefixes (standard git apply --check still passes with full contexts). No Git check or policy is disabled. The captured legacy contract requires PATCH metadata for this source repair: claude-release computes 0.11.1, synchronized across all surfaces and changelog. The regenerated server bundle is byte-identical to the proven implementation after replacing only its version literal. This repair belongs to the existing standalone Merge Prep workflow under the user's commit/push authorization; it does not reopen or relabel the completed implementation run. Signed Merge Prep build readiness and actual hosted CI are evaluated on the new revision; original implementation proof remains at 2ed831d. Retain the source/target bindings and do not perform Merge Back into the snapshot alias.

Final repair validation before publication: npm.cmd --prefix plugins/captain-sdlc run build and run typecheck passed. The final PR will run the full Linux/Windows suite and public smokes on the repaired head. Captain development surfaces are 0.11.1; this is not a release tag or publication.

Publication correction: a consumer proposal containing existing private ADR/skill text was mistakenly included in earlier public review commits. The proposal and private audited revision/version metadata have been removed from the current tree and retained only in a local review artifact. Earlier pushed history still contains that content; no history rewrite, force push or deletion has been performed. Further history/cache cleanup requires explicit authorization. This correction does not alter release-engine behavior; the captured legacy repair contract requires development PATCH metadata 0.11.2.

Windows CI repair: a superseded hosted run exposed a synthetic stopped-owner fixture failure consistent with exited PID reuse. The fixture now explicitly checks ESRCH for a high absent Windows PID; production guards and live/foreign refusal assertions are unchanged. Both focused cases passed, and the full recovery file is running. Development PATCH 0.11.3 is computed by claude-release under the captured legacy repair contract.

History-cleanup authorization received from the user: "Authorize the targeted history cleanup." Only the Captain review branch may be replaced with sanitized task history via force-with-lease; local originals and exact current files must be retained. Protected branches, tags and the other repositories remain outside that cleanup. GitHub cached views may require separate owner cleanup.
