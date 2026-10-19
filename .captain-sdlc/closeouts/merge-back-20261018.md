# Merge Back closeout — 2026-10-18

Michael's instruction “Now merge back” authorized the two prepared integrations. Both completed through Captain's public Merge Back API using their existing signed readiness, source and target worktrees.

| Repository | Target branch | Previous target | Integrated revision |
| --- | --- | --- | --- |
| Dirigible | mt/feat/material-design | a4583fa5815ce8f0481716cf030d0bfd1495151b | c722d57763c5220c1ad42c2f190711c3330e93e3 |
| Captain | fix/captain-target-first-merge-version-20261018 | 6bce586aee1bfa44174d1dcf91a01b7fe436a87d | ef9f9f42fd4db135a4c1e52de584e6260e959a1c |

Dirigible returned signed **merged**, revision 19, with a valid receipt. Captain returned signed **merged**, revision 17, with a valid receipt. Each retained its single passing Build gate with exactly the same command and output hashes as Prep. No test or build was repeated during Merge Back.

Git independently verified both integrations were fast-forwards to the exact signed heads, both targets were clean, and both source worktrees were retained and clean. The generated-target stash e27182f15d0677b1219bfa0d780055a1a53121e6 remains retained. Nothing was pushed and no worktree was removed.

The earlier [recovery closeout](captain-recovery-20261018.md) retains implementation, full regression, smoke, typecheck and installed-runtime proof at their actual revisions. This merge operation adds integration proof; it does not relabel those results or claim new runtime/HITL acceptance.

This handoff is retained as a version-neutral Captain bookkeeping commit on the Captain target after integration. Its later records-only target revision is distinct from the integrated revision above. The signed completed merge and its tested product revision remain historical evidence.

No merge blockers remain. Next owner: Michael for any separately selected follow-up.

## Public integration evidence

Capability-free projection of the actual public results, compared against the saved Prep gates:

```json
[
  {
    "repository": "Dirigible",
    "merge_id": "merge-dfb8e943-7bbd-49be-b319-6f13e45d45e5",
    "revision": 19,
    "state": "merged",
    "receipt_valid": true,
    "source_worktree": "E:\\Personal\\dirigible2D\\.captain-sdlc\\worktrees\\intent-918adb0a-9010-4b6e-8d0e-5c20cd19ca7f",
    "target_worktree": "E:\\Personal\\dirigible2D",
    "target_branch": "mt/feat/material-design",
    "target_before": "a4583fa5815ce8f0481716cf030d0bfd1495151b",
    "integrated_head": "c722d57763c5220c1ad42c2f190711c3330e93e3",
    "gates": [
      {
        "scope": "build",
        "commandSha256": "c09a3f12871b59fe50afae9e842cc21cefdcc66dc40339b56fa9f4f0afeb6c0b",
        "exitCode": 0,
        "stdoutSha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        "stderrSha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
      }
    ],
    "prep_gates_unchanged": true
  },
  {
    "repository": "Captain",
    "merge_id": "merge-2f0c9bf5-3f9a-4597-ae7d-92860677d9e0",
    "revision": 17,
    "state": "merged",
    "receipt_valid": true,
    "source_worktree": "E:\\Personal\\captain-sdlc\\.captain-sdlc\\worktrees\\intent-e04450f2-96e5-4b67-86eb-f4dcd7e737bb",
    "target_worktree": "E:\\Personal\\captain-sdlc\\.captain-sdlc\\worktrees\\captain-target-first-merge-version-20261018",
    "target_branch": "fix/captain-target-first-merge-version-20261018",
    "target_before": "6bce586aee1bfa44174d1dcf91a01b7fe436a87d",
    "integrated_head": "ef9f9f42fd4db135a4c1e52de584e6260e959a1c",
    "gates": [
      {
        "scope": "build",
        "commandSha256": "f0416e5352c659f2a9537645324c1b3ef7bcacbbef507bb84033f77478d18852",
        "exitCode": 0,
        "stdoutSha256": "350104bcd6aa0770b8bcd7a34bce3a9c1a41dd56e26c462582ec6a4efb46c47c",
        "stderrSha256": "9a242c60a377613b85246aeb264bf56c1cf214f931f09afb4b1ca39463de0f3e"
      }
    ],
    "prep_gates_unchanged": true
  }
]
```
