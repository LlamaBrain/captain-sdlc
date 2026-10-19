# 2026-10-08 - Recover orphaned Captain Merge Prep leases

Updated: 2026-10-10
Version: 1.0.0

**Issue status: PARTIALLY RESOLVED.** The operational failure and local availability are resolved; Captain source integration and release remain pending.

## Summary

An MCP server stopped while owning the signed operation lease for the UI pointer prefab Merge Prep. The existing abort operation applies to implementation-run merges and could not safely release this separate Merge Prep lease. Michael directed creation of a narrowly authorized recovery tool and continuation of the same merge operation.

The new `captain_recover_merge_lease` operation validates the merge ID, signed revision, lease token, session, source and target bindings, and stale owner state before releasing only merge-associated leases. Focused tests, package build, and MCP advertisement/recovery smoke passed.

## Evidence (historical incident snapshot)

- Merge ID: `merge-065b0afe-e148-4072-b4a6-0586483005fd`.
- Source: `task/ui-pointer-prefabs-20261007` at `5e3e8d3b30d62d651056eb3dd46a1462da58a9f7`.
- Target: `mt/feat/material-design` at `e8192545de0bd0107c40f365f6aea815a0cd33ee`; it remains clean and unchanged.
- The captured LOW Build completed successfully and produced fresh development verifier evidence.
- Merge Prep refused readiness because Unity serialized 57 tracked WorldObjects assets during the build. The edits were default `allowTerrainOverlap: 0` fields and regenerated spatial-setting reference IDs. Their diff is preserved in ignored task scratch; the source worktree was restored to its signed clean input state.
- The same operation is revision 20, state `failed`, with a successful Build exit receipt and no valid readiness receipt.
- All six UI HITLs passed and must not be repeated.

## Next action (historical; superseded by the dated reconciliation below)

Resolve the Unity build gate's tracked-asset serialization side effect within the approved merge-prep scope, retry with changed inputs, and record the same operation's signed readiness. Do not merge or alter the material-design target.

## Current reconciliation — 2026-10-10

The UI operation completed through `merge-20b0b8ed-5494-48ab-89b0-a5c210cb4509`, revision 6, `merged`, integrating `26552f9d2fdf27cc57bcfb3e67a5ad7d5f9f9159`. Its retained LOW Build gate exited 0. The older failed attempts and their evidence remain historical; no old merge is reopened.

Recovery is available through the supported local Codex installation: Captain 0.3.1, compiled SHA256 `bb9eaaa592b8418cbcfdcc643a3809efe1ecbddc5e6c38ba75fbd008e366a752`, 31 public tools including `captain_recover_merge_lease` and `captain_merge_status`. The supporting 0.3.1 task at `ee271ac873dd2c6e0d7f83a551caba9482ad73f9` has signed complete/green revision 11.

Today the completed merge's old receipt is stale because its worktree symbolic target branch binding changed. Preserve the historical integration and accepted proof at their actual revision; this is not current readiness and requires no repeated UI HITL or merge.

Source integration and release remain incomplete. Captain primary `dev` is at `102864b01ccac6787b2a5c178bbe4ccb8ce3f278`; neither the 0.2.1 continuation commit `3b35b6f7af7154e8d212d04f26604db94cfd02c5` nor the 0.3.1 repair is in its ancestry. The local installation is not a claim of source integration, hosted CI, push or release.

Owner/action: Michael selects any source integration/release separately; Cap retains the existing checkouts and proof. No renewed implementation or unchanged recovery retry is needed to resolve the historical operational failure.

See the [current Captain proof/installation closeout](E:/Personal/captain-sdlc/.captain-sdlc/worktrees/intent-a98c7c92-c42e-4d1f-99de-c5c74fe6e992/plugins/captain-sdlc/.captain-proof/proof-source-repair-closeout.md).

## Earlier build-input context retained on 2026-10-18

The source branch also preserved the earlier failed receipt
`merge-f2ea3b13-6a56-47dd-8ac0-9e26c4c4b167`, which became stale when Unity
regenerated ignored build outputs. Its recorded repair excluded only the exact
Addressables content-state, GameAnalytics settings and TextMesh Pro fallback
outputs from the LOW build fingerprint; other ignored inputs stayed fingerprinted.
The source checkpoint reported 223/223 Captain tests and a merge MCP smoke.

Its `merge-20b0b8ed-5494-48ab-89b0-a5c210cb4509` revision 3 readiness was an
earlier checkpoint of the revision 6 integration recorded above. The dated
2026-10-10 reconciliation remains the later incident account. These are historical
results, not new proof for the current repair-chain integration. Current preparation
is tracked separately in the repair-chain closeout and its signed merge operation.
