# Recover failed Begin beside paused owners

Developer-facing changes for `captain-sdlc`.

Task: `captain_failed_begin_paused_projection_recovery_20261024`
Source: `captain/intent-4e6ddca0-dd9e-40b9-8985-cabe6bfdea3e` at `491c09d812cd53a2153c3063737f2479a54551dc`
Target: `9b26b61645e417b8bbbb7db6dda420059d383826`
Merge base: `9b26b61645e417b8bbbb7db6dda420059d383826`

### Fixed

- **captain:** authenticate released unrelated paused ownership for exact failed-Begin cancellation while preserving active, target-owner and generation refusals (491c09d812cd53a2153c3063737f2479a54551dc)

<!-- captain-changes:v1 -->
```json
{
  "schema_version": 1,
  "audience": "developer",
  "project": "captain-sdlc",
  "id": "captain_failed_begin_paused_projection_recovery_20261024",
  "subject": "Recover failed Begin beside paused owners",
  "source_branch": "captain/intent-4e6ddca0-dd9e-40b9-8985-cabe6bfdea3e",
  "source_head": "491c09d812cd53a2153c3063737f2479a54551dc",
  "target_head": "9b26b61645e417b8bbbb7db6dda420059d383826",
  "merge_base": "9b26b61645e417b8bbbb7db6dda420059d383826",
  "entries": [
    {
      "oid": "491c09d812cd53a2153c3063737f2479a54551dc",
      "message": "fix(captain): recover failed begin beside paused owners (v0.9.4)\n\nImplements: captain_failed_begin_paused_projection_recovery_20261024",
      "type": "fix",
      "scope": "captain",
      "description": "recover failed begin beside paused owners (v0.9.4)",
      "breaking": false,
      "migration": null,
      "category": "Fixed",
      "summary": "authenticate released unrelated paused ownership for exact failed-Begin cancellation while preserving active, target-owner and generation refusals",
      "excluded": false
    }
  ],
  "omitted": []
}
```
