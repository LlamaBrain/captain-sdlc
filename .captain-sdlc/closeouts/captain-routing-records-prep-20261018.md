# Captain routing-records recovery - Merge Prep

Recovered the useful configuration from checkpoint cdee135e2ce90df2ac01ea250e347127d1239be7 and merged the reviewed port into actual Captain dev at 700ea3766c849915e89eef38da687ab12e607c57 (v0.7.8). Michael authorized preparation and then explicitly instructed "Merge back". The preparation evidence below remains at its original revisions.

## Ownership, scope and revisions

- Task: CAPTAIN-ROUTING-RECORDS-20261018; owner Captain, session codex-unified-game-actions-20261013.
- Source: E:\Personal\captain-sdlc\.captain-sdlc\worktrees\captain-routing-records-prep-20261018, branch prep/captain-routing-records-20261018, base 4102da5a3f06aad33d790305fe522b7680231ada.
- Tested product commit: 264f8204fcd0c76d346a9c6b54cfc396f2e90fd4, fix(captain): recover retained routing configuration (v0.7.8).
- Target: E:\Personal\captain-sdlc, branch dev, pinned 4102da5a3f06aad33d790305fe522b7680231ada. Both source and target were clean at signed proof.
- Signed operation: merge-9b2f1d30-af99-45d7-8258-f743c699f5c9, READY revision 6, receipt_valid=true; policy SHA256 827ebf5cb6756798a0e21df1e060f4e5f1007f051c72c06778f0654407cbdfe5. Captured LOW scope is Build only. Full implementation Captain green, hosted CI and release are separate: captain_green=false; none are claimed.
- The checkpoint predates the plugin and committed Captain policy, and has no retained task checkout. Its two useful files were ported onto a new owned current-dev worktree. Its original branch/OID is preserved. This is a reviewed port, not ancestry integration of cdee135; future branch audits must retain that distinction.

## Delivered

- .captain-sdlc/routing-policy.json preserves checkpoint semantics exactly: schema 1, bridge-labelled task selects route bridge with adapter worker; no default route.
- .captain-sdlc/.gitignore restores scoped generated-state ignores. Root anchoring protects nested durable records; human queue.json, routing-policy.json and route-config.json remain visible. trace/ and side-store/ are ignored as required by existing conventions. Governing policies, notebook, closeouts and handoffs remain visible.
- The original queue.json ignore conflicts with captain-bridge-dashboard.md's human-config rule; that legacy behavior was intentionally not restored. Task capsule ignores follow the current task-capsule convention. No blanket .captain-sdlc or JSON ignore was added.
- Reusable smoke: plugins/captain-sdlc/scripts/routing-records-smoke.mjs. It invokes the actual Core CLI validate/route commands and Git check-ignore; route only evaluates/prints, never dispatches workers.
- Synchronized patch 0.7.8 across package, lock root/root package, plugin manifest, server identity and built bundle, with its changelog entry. All 153 non-root dependency records are unchanged. No signed policy, hooks or enforcement behavior changed.

## Focused red/green and build evidence

Before recovery, the new smoke failed with "missing repository routing policy". Against a disposable repository containing both exact original checkpoint blobs, Core validation and routing checks passed, then Git visibility failed specifically on queue.json. After the reviewed configuration recovery, all seven checks passed; output placement was subsequently aligned with the existing captured scratch exclusion and the same seven checks passed again. Original failures remain failures; they are not relabelled as passing evidence.

The final smoke packet is plugins/captain-sdlc/Temp/automation-scratch/routing-records/run-HEhWZv/result.json, created 2026-10-19T03:20:45.849Z; SHA256 7bf3fe2b8edeb5292e80b22118ad82c71f1ccf2e4546ed80670cbd09380e6a19. Its passing checks:

- routing policy exists: PASS.
- actual Core schema accepts policy: PASS.
- bridge-labelled task selects worker without fallback: PASS.
- unmatched task is rejected without worker dispatch: PASS.
- actual Core rejects unsupported policy schema: PASS.
- human configuration and governed records stay visible: PASS.
- generated machine state is ignored: PASS.

Core source: E:/Personal/captain-orchestrator at f157035f6075d614a834508727665def016e79ba, clean. Targeted build: dotnet build src/Captain.Core.Cli/Captain.Core.Cli.csproj --no-restore; succeeded with zero warnings/errors. CLI SHA256 e0412e1244bda429bbaddda9cb97432dad581c0fa06d9f10ff7197ba0728f6de; adjacent Captain.Core.dll SHA256 c4b80e85b9e72d910b0989bfe97017a38ec8a55614c08dad80201caf7b178cec. This is local dependency proof; no orchestrator source was changed.

Captain 0.7.8 local build/typecheck passed. Signed LOW Build passed at 264f8204fcd0c76d346a9c6b54cfc396f2e90fd4, exit 0; command npm --prefix plugins/captain-sdlc run build. Signed stdout SHA256 94c620033d67041229267490d963ac10a31816d8cc0c284cd2338c267b2f8099; stderr SHA256 c5a783a0122f44544c3c73bbd97c0488b34df7c0599c56fc983071e1d2ac43b9. An initial baseline Build preceded the port; the changed source then received fresh signed proof. Independent review approved routing semantics, ignore retention boundaries, smoke behavior and unchanged dependencies with no blockers. No broad suite, Unity or human/visual gate was added.

| Diagnostic log | SHA256 |
| --- | --- |
| red-missing-config.txt | 5e5b9d42f1cb29ac2016389e10d463c8894938b704372bb1b0fc4457f24a3c9b |
| red-legacy-ignore.txt | bab73b0136aa7d6a41284925fdbee4caabef3913f142ef72e455e184e9b5c7d8 |
| green-final.txt | b4df9c9557715e142c2b2b7bfd0258c98bc61a8ed95ce716692a24805db1ac42 |
| core-build.txt | 75d90997f3af449af8421fa2d72ddaef42ed90b54098196752af6ca246c9e322 |
| build.txt | b97cba65c69e9564044141ea4ec346ee31cff270526f2904b568964fd5ad2fdc |

These logs are under E:/Personal/dirigible2D/Temp/automation-scratch/captain-routing-prep-20261018. The signed finalization receipt will retain the exact bookkeeping-only descendant containing this closeout; runtime proof stays at 264f8204fcd0c76d346a9c6b54cfc396f2e90fd4. Installed Captain remains 0.7.7; this preparation does not claim 0.7.8 is installed or deployed.

## Setup and preservation

Primary dev had no installed node_modules. Copied the complete ignored node_modules and bin roots from the previously verified 40cd24b2 repair checkout after comparing package locks; no generated Unity state, shared sources or other task files were copied/overwritten. Source provider and destinations are in setup-receipt.json under diagnostic scratch.

Fresh Git checkout produced CRLF files, while Captain's sanitized Git environment ignores the global autocrlf setting. Ordinary status appeared clean, but both public transports rejected cleanliness. Exact diagnosis isolated this source checkout; primary was clean in both environments. After verifying all 281 differences were line-ending-only, restored those working files to their exact committed blobs. HEAD/index/tree were unchanged. Alignment manifest SHA256 5b8e3906fe1a7d62ecc3a0c63b974a105007c2c3adffcd60402c06baa25e0a32; original diagnosis SHA256 202a28a0003fcaff46c946b0f2757c1a187c8be541dfa7f73fa8abf02a2b0cc5. Churn resolution: Churn/2026-10-18-fresh-worktree-line-ending-preflight.md.

Smoke output belongs under the already captured plugins/captain-sdlc/Temp/automation-scratch exclusion, so reruns do not change product fingerprints. Four confirmed untracked prior output files were moved only within this task checkout; original-path/hash manifest SHA256 51b8272bcac6934deef7b4d7069f49383bebb4afc1516be16ba095cbceb45d2f. No captured exclusion/policy was changed.

Retain the historical checkpoint and all existing worktrees. The earlier primary stash f5a0c0abdfa8846665885f047bc8746652e87322 and reserved CON backup from the repair-chain task were not restored or altered; their recovery record remains in captain-repair-chain-dev-prep-20261018.md. No push, merge-back, archive deletion or foreign lease adoption occurred.

## Next owner and action

The authorized integration is complete. Classify cdee135 as a reviewed configuration port integrated into dev; its historical branch remains preserved and is not ancestry-merged. No routing-recovery integration action remains. Keep the source checkout, original checkpoint and earlier repair-task backups.

## Follow-ups for human review

- Worktree setup can eventually materialize committed line endings when Captain's isolated Git checks require them. Current-task repair is complete; no shared Git setting was changed.
- Captain's generic cleanliness error names a target even when the dirty checkout is the source. A clearer diagnostic is a separate optional improvement.
- Other historical checkpoint/archive retention and old run-record reconciliation remain outside this preparation.

## Merge Back completion - 2026-10-18 America/Los_Angeles

Michael explicitly instructed "Merge back" after preparation. Captain consumed the same signed operation merge-9b2f1d30-af99-45d7-8258-f743c699f5c9 and fast-forwarded dev from 4102da5a3f06aad33d790305fe522b7680231ada to 700ea3766c849915e89eef38da687ab12e607c57. Signed revision 11 reports merged with receipt_valid=true for that exact integration. Source/target bindings and clean state matched the prepared receipt; the build gate array was retained unchanged, with no new build/test run. The tested product revision remains 264f8204fcd0c76d346a9c6b54cfc396f2e90fd4.

This completion update and the completed notebook disposition are finalized as a separate version-neutral bookkeeping commit on dev. Its exact OID is retained in the separate Captain finalization receipt; it does not relabel runtime proof or replace the historical Merge Back receipt at 700ea376. A later current-head mismatch caused solely by these records is not a failed integration. Installed Captain remains 0.7.7; no plugin installation, push, hosted CI, release, original-checkpoint deletion, worktree removal or backup restoration was performed.
