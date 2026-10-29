# proof source repair

Developer-facing changes for `captain-sdlc`.

Task: `proof-repair-churn`
Source: `captain/intent-fc8ede9b-9348-4c5a-b836-6799b88e776a` at `c87d433db7754760ec9ec0d86619b070aa5e06d8`
Target: `cdacfd782e82c4d1e2a2b53753b4d8ab9518a3a4`
Merge base: `cdacfd782e82c4d1e2a2b53753b4d8ab9518a3a4`

### Changed

- **captain:** refresh proof repair distribution (c87d433db7754760ec9ec0d86619b070aa5e06d8)

### Fixed

- **captain:** preserve proof source repair after red (3188bd152bced75e3cbbb9ce7dd0c636edcfd73f)

<!-- captain-changes:v1 -->
```json
{
  "schema_version": 1,
  "audience": "developer",
  "project": "captain-sdlc",
  "id": "proof-repair-churn",
  "subject": "proof source repair",
  "source_branch": "captain/intent-fc8ede9b-9348-4c5a-b836-6799b88e776a",
  "source_head": "c87d433db7754760ec9ec0d86619b070aa5e06d8",
  "target_head": "cdacfd782e82c4d1e2a2b53753b4d8ab9518a3a4",
  "merge_base": "cdacfd782e82c4d1e2a2b53753b4d8ab9518a3a4",
  "entries": [
    {
      "oid": "3188bd152bced75e3cbbb9ce7dd0c636edcfd73f",
      "message": "fix(captain): preserve proof source repair after red (v0.10.8)\n\nCompletes: proof-repair-churn",
      "type": "fix",
      "scope": "captain",
      "description": "preserve proof source repair after red (v0.10.8)",
      "breaking": false,
      "migration": null,
      "category": "Fixed",
      "summary": "preserve proof source repair after red",
      "excluded": false
    },
    {
      "oid": "c87d433db7754760ec9ec0d86619b070aa5e06d8",
      "message": "build(captain): refresh proof repair distribution (v0.10.9)\n\nCompletes: proof-repair-churn",
      "type": "build",
      "scope": "captain",
      "description": "refresh proof repair distribution (v0.10.9)",
      "breaking": false,
      "migration": null,
      "category": "Changed",
      "summary": "refresh proof repair distribution",
      "excluded": false
    }
  ],
  "omitted": []
}
```
