# Bounded worktree storage and merge cleanup

Developer-facing changes for `captain-sdlc`.

Task: `captain-bounded-worktree-storage-20261023`
Source: `captain/intent-b9dc226b-8c76-4099-96b2-1bbcfc84d55d` at `345b60038b4f2d25b0b625fd52e8273864ca09b5`
Target: `e0d0088634fa2547a396b8f1942218a474eb7262`
Merge base: `e0d0088634fa2547a396b8f1942218a474eb7262`

### Added

- **storage:** Replace generated output in trusted per-scope slots; register worktrees in the primary repository and retire completed merged chains with compact proof archives. Add ordinary-project create/resume/build-slot/cleanup helpers. Preserve legacy checkouts, active or dirty work and unclassified ignored data; report-only build policies must declare payload roots. (345b60038b4f2d25b0b625fd52e8273864ca09b5)

<!-- captain-changes:v1 -->
```json
{
  "schema_version": 1,
  "audience": "developer",
  "project": "captain-sdlc",
  "id": "captain-bounded-worktree-storage-20261023",
  "subject": "Bounded worktree storage and merge cleanup",
  "source_branch": "captain/intent-b9dc226b-8c76-4099-96b2-1bbcfc84d55d",
  "source_head": "345b60038b4f2d25b0b625fd52e8273864ca09b5",
  "target_head": "e0d0088634fa2547a396b8f1942218a474eb7262",
  "merge_base": "e0d0088634fa2547a396b8f1942218a474eb7262",
  "entries": [
    {
      "oid": "345b60038b4f2d25b0b625fd52e8273864ca09b5",
      "message": "feat(storage): bound generated outputs and retire merged worktrees (v0.9.0)\n\nImplements: captain-bounded-worktree-storage-20261023",
      "type": "feat",
      "scope": "storage",
      "description": "bound generated outputs and retire merged worktrees (v0.9.0)",
      "breaking": false,
      "migration": null,
      "category": "Added",
      "summary": "Replace generated output in trusted per-scope slots; register worktrees in the primary repository and retire completed merged chains with compact proof archives. Add ordinary-project create/resume/build-slot/cleanup helpers. Preserve legacy checkouts, active or dirty work and unclassified ignored data; report-only build policies must declare payload roots.",
      "excluded": false
    }
  ],
  "omitted": []
}
```
