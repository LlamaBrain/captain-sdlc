# 2026-10-18 - Unversioned target blocked repair-chain integration

**Status: ONGOING**

**Occurrence:** 2026-10-18 America/Los_Angeles. **Date basis:** This execution's public Merge Prep rejection. **Recorded:** 2026-10-18.

## Summary

Michael selected the retained Captain repair chain for preparation against actual Captain dev. The authenticated source merge was blocked by commit preflight because dev had never contained the plugin's configured version files. The target ref remains unchanged; no failed candidate was applied.

## Evidence and impact

- Merge: merge-332d72dd-5d62-4269-8a2c-ee2faddc46a8; session codex-unified-game-actions-20261013.
- Source: fix/captain-target-first-merge-version-20261018 at 1483758eadaae663515d796c67d5cb25f6f24b76, retained at E:/Personal/captain-sdlc/.captain-sdlc/worktrees/captain-target-first-merge-version-20261018.
- Target: E:/Personal/captain-sdlc, dev at fea6a55bf1f0ba2d67de20283be3823915fa5470.
- Public rejection: "commit preflight rejected semantic version, changelog, trailer, or prepared merge evidence". The actual pinned dev and common base do not contain the plugin component; source has valid 0.7.5 release metadata.
- Installed runtime at rejection: 0.7.5. Captured integration policy remains LOW/build; no signed policy was changed.
- Corrected real-Git regression fails with that same semantic/prepared-merge rejection before implementation. Red log: E:/Personal/dirigible2D/Temp/automation-scratch/captain-dev-prep-20261018/version-semantic-red.txt; SHA256 aee44e89da1608c65853b88deafac0f789d9959f84173516ffcdae91c2c7379a.
- An earlier test attempt failed because its incoming README was omitted from the explicit fixture commit selection. That setup failure is not the product regression evidence.

## Diagnosis

versionTransitionValid required a parseable canonical version on both actual merge parents. Absence of an entirely new component was conflated with corrupt existing release metadata.

## Repair and focused proof

- Permit the absent incoming baseline only when every configured version-surface path is absent in the incoming parent and every common merge base. Require at least one merge base; Git inspection errors fail closed. Tracked trees and symlinks count as existing metadata.
- Keep source canonical validation, synchronized candidate surfaces, deterministic bump and authenticated actual-parent binding unchanged. Malformed/partial metadata and deletion of a prior versioned component remain rejected.
- Focused real-Git module: 14/14 passed, zero failures/cancellations/skips/todos; duration 32518.8269 ms. Green log: E:/Personal/dirigible2D/Temp/automation-scratch/captain-dev-prep-20261018/version-green.txt; SHA256 808c3fd2921a8e89e3fa08324457684c818ec707224cdf5cf42c09c1394ec056.
- Build (including TypeScript compilation) passed with plugin 0.7.6. Build log: E:/Personal/dirigible2D/Temp/automation-scratch/captain-dev-prep-20261018/build-local.txt; SHA256 fc51ed4796ce058bc93f10ff0cbc5ea120f2f7776f83c9736867dbc61087abf8.
- Independent read-only review approved the bounded guard and regression cases with no blockers.
- The earlier 678-test suite remains evidence at 9c4b0929a63311775e23d4503d2b3756cf4059df, not a new 0.7.6 pass. This functional guard repair receives fresh focused proof.

## Next action

Captain: finish public MCP merge smoke, install the validated 0.7.6 runtime using standard plugin commands, and continue this same signed merge operation through readiness. Do not alter target dev or import the historical fail-open enforcement overlay. Integration and hosted CI remain distinct from LOW preparation.

## Update - 2026-10-18

Installed 0.7.6 through the standard plugin manager and authenticated all 40 public tools. Both public MCP merge smoke workflows passed. The same signed Prep committed 98b714a40d1121b626ea8bb9ca09174b8f9ad63c with exact parents 1483758eadaae663515d796c67d5cb25f6f24b76 and fea6a55bf1f0ba2d67de20283be3823915fa5470: the version-preflight defect is proven repaired. Prep then failed the existing incoming whitespace check before its Build gate. The 23 affected inherited files contain CRLF or trailing blank lines; normalization preserves line contents, JSON values, and original historical blobs at 98b714a. Patch 0.7.7 records that formatting repair. The target remains unchanged; focused tests and smokes retain their 0.7.6 code provenance.
