# Developer worktree changelog artifacts

Developer-facing changes for `captain-sdlc`.

Task: `WORKTREE-CHANGELOG-ARTIFACTS`
Source: `captain/intent-1dfeeef2-7fc1-429e-af4a-3a65a4e74394` at `b74bf8b43b937385801bdddde014e2b838a55d79`
Target: `ed21b685e232b89a4ef6693d89e719392db1d4c4`
Merge base: `ed21b685e232b89a4ef6693d89e719392db1d4c4`

### Added

- **changelog:** Add per-worktree Conventional Commit fragments, dated archival and developer changelog composition with complete Git provenance, KAC categories, SemVer impact checks and OID deduplication. (e06a6e199525e1a8c7b6c9b297e1e86cc005d13c)

### Changed

- **captain:** Retain the signed green verification results, exact tested revision and worktree integration handoff for the changelog workflow. (b74bf8b43b937385801bdddde014e2b838a55d79)

### Fixed

- **build:** Keep the bundled Captain server version aligned with package/source metadata so development builds preserve a clean committed source tree. (aecceaee01d1982c86e2a258fc3a77acace19190)

<!-- captain-changes:v1 -->
```json
{
  "schema_version": 1,
  "audience": "developer",
  "project": "captain-sdlc",
  "id": "WORKTREE-CHANGELOG-ARTIFACTS",
  "subject": "Developer worktree changelog artifacts",
  "source_branch": "captain/intent-1dfeeef2-7fc1-429e-af4a-3a65a4e74394",
  "source_head": "b74bf8b43b937385801bdddde014e2b838a55d79",
  "target_head": "ed21b685e232b89a4ef6693d89e719392db1d4c4",
  "merge_base": "ed21b685e232b89a4ef6693d89e719392db1d4c4",
  "entries": [
    {
      "oid": "e06a6e199525e1a8c7b6c9b297e1e86cc005d13c",
      "message": "feat(changelog): add developer worktree change artifacts (v0.8.0)\n\nImplements: WORKTREE-CHANGELOG-ARTIFACTS",
      "type": "feat",
      "scope": "changelog",
      "description": "add developer worktree change artifacts (v0.8.0)",
      "breaking": false,
      "migration": null,
      "category": "Added",
      "summary": "Add per-worktree Conventional Commit fragments, dated archival and developer changelog composition with complete Git provenance, KAC categories, SemVer impact checks and OID deduplication.",
      "excluded": false
    },
    {
      "oid": "aecceaee01d1982c86e2a258fc3a77acace19190",
      "message": "fix(build): synchronize tracked Captain runtime metadata (v0.8.1)\n\nImplements: WORKTREE-CHANGELOG-ARTIFACTS",
      "type": "fix",
      "scope": "build",
      "description": "synchronize tracked Captain runtime metadata (v0.8.1)",
      "breaking": false,
      "migration": null,
      "category": "Fixed",
      "summary": "Keep the bundled Captain server version aligned with package/source metadata so development builds preserve a clean committed source tree.",
      "excluded": false
    },
    {
      "oid": "b74bf8b43b937385801bdddde014e2b838a55d79",
      "message": "docs(captain): record developer changelog proof\n\nCompletes: WORKTREE-CHANGELOG-ARTIFACTS",
      "type": "docs",
      "scope": "captain",
      "description": "record developer changelog proof",
      "breaking": false,
      "migration": null,
      "category": "Changed",
      "summary": "Retain the signed green verification results, exact tested revision and worktree integration handoff for the changelog workflow.",
      "excluded": false
    }
  ],
  "omitted": []
}
```
