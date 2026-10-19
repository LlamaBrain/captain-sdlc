# 2026-10-10 — Source-divergence proof rejection lacked a same-run repair transition

Updated: 2026-10-10
Version: 1.0.0

**Status: RESOLVED — same-run source repair is implemented, installed and exercised.**

**Occurrence:** 2026-10-10 09:50:24 PDT (2026-10-10T16:50:24.839Z), the actual proof rejection.

**Date basis:** America/Los_Angeles (PDT, UTC−07). Recorded 2026-10-10 from the original session evidence; the session filename's creation date does not determine the incident date.

## Summary

The authorized Unity artifacting/registry task produced a development build, but source import changed an asset and Captain correctly rejected divergent proof inputs. The run then needed implementation access to repair those inputs, and the installed lifecycle did not provide the supported return path. Repeating unchanged proof could not repair it.

## Evidence and impact

- [Actual rejection timestamp](C:/Users/metag/.codex/sessions/2026/10/10/rollout-2026-10-10T08-01-56-01a12655-c186-71d3-b913-3e8b869a0891.jsonl:3441), 2026-10-10T16:50:24.839Z. The [public rejection packet](E:/Personal/dirigible2D/.captain-sdlc/evidence/churn-workflow-skill-20261010/retained-diagnostics/unity-authorized-proof-output-v1.json) says "proof source state diverged from the clean committed tree or ignored-input manifest."
- [Unity source failure](E:/Personal/dirigible2D/.captain-sdlc/worktrees/intent-918adb0a-9010-4b6e-8d0e-5c20cd19ca7f/.captain-sdlc/evidence/runtime-smoke-artifacting-registry-bake-20261010.md:49) preserves the v2.570.6 import divergence. The damaged quality asset was not committed.
- [Exercised recovery](E:/Personal/dirigible2D/.captain-sdlc/worktrees/intent-918adb0a-9010-4b6e-8d0e-5c20cd19ca7f/.captain-sdlc/evidence/runtime-smoke-artifacting-registry-bake-20261010.md:62) records returning original intent-918adb0a-9010-4b6e-8d0e-5c20cd19ca7f to implement/red while preserving policy, identity and evidence.
- [Captain repair closeout](E:/Personal/captain-sdlc/.captain-sdlc/worktrees/intent-a98c7c92-c42e-4d1f-99de-c5c74fe6e992/plugins/captain-sdlc/.captain-proof/proof-source-repair-closeout.md:14) records the typed source-repair transition and its fencing.

## Diagnosis

Captain lifecycle defect: a legitimate source-proof failure did not provide a safe repair transition. The asset serialization defect is separate product behavior. The repair authenticates exact run revision, checkout identity, activation and lease generation; it does not convert a failed proof into a pass.

## Next action

Owner: Cap. Retain the resolved incident and the original failure packet. No further action remains for this occurrence; any new behavior request is separate work.

## Update — 2026-10-10

Captain 0.3.1 at ee271ac873dd2c6e0d7f83a551caba9482ad73f9 supplied and exercised the transition. The original Unity task repaired its source, committed c3d4319de546d6039d492066e6480f7d19f4a6a7 (2.570.7), and received fresh signed complete/green revision 28. Captain's separate repair proof is complete/green revision 11.

## Resolution

Resolved on 2026-10-10. Installed compiled SHA256 bb9eaaa592b8418cbcfdcc643a3809efe1ecbddc5e6c38ba75fbd008e366a752 matches the verified 0.3.1 source. Retained Captain proof includes 19/19 focused recovery tests and successful captured checks. Local installation and these signed task proofs do not claim source integration, hosted CI, push or release.

## Scope and related records

Created under Michael's request to record each finding in the [six-item review](E:/Personal/dirigible2D/.captain-sdlc/evidence/churn-review-20261010.md). This is incident bookkeeping; frozen criteria, signed policy and retained evidence are unchanged. Proposed preventative or legacy recovery work remains a human-review follow-up, not a new completion gate.
