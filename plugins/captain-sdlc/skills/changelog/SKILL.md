---
name: changelog
description: Prepare developer-facing worktree changes.md artifacts, retain dated merge fragments, and compose Conventional Commit changes into a Keep a Changelog document with SemVer checks.
---

# Developer changelogs

Use this for technical changelogs and worktree merge fragments. Player-facing release notes are separate work. Preserve API/DTO changes, migrations, dependency versions, fixes and commit references; do not turn them into marketing copy.

The bundled helper is `scripts/changelog.mjs`, runnable with Node. It performs Git reads and exact artifact writes only. It never commits, merges, changes version files, tags or pushes. Use the owning repository's normal Captain/commit workflow for those actions.

## Worktree draft during Merge Prep

Checkpoint the task's source and import the pinned target through the existing Merge Prep workflow. After any conflict/behavior repairs are committed, collect only source commits absent from that pinned target:

```text
node <skill>/scripts/changelog.mjs collect --repo <source-worktree> --target <pinned-target-oid> --project <stable-project-name> --id <task-or-merge-id> --subject "<technical subject>"
```

This writes `<source-worktree>/changes.md`. Source must be committed; the helper refuses other loose files so an artifact cannot silently omit unfinished code. It allows the owned draft and staged archive records. Use the same project name across that repository's worktrees and clones. Different repositories produce separate changelogs.

Review the full captured range. Existing commit subjects/bodies provide the evidence; an integration wrapper subject alone is insufficient. Structural merge messages and commits changing only fragment artifacts are recorded as omissions. Nonconforming ordinary commits cause an error with their subject: retain their history and resolve classification deliberately rather than skipping them or rewriting published history automatically.

Curate `summary` and `category` in the fenced metadata for entries that need clearer technical wording. Then regenerate the visible Markdown:

```text
node <skill>/scripts/changelog.mjs render --input <source-worktree>/changes.md --write
```

Only the six Keep a Changelog categories are accepted: Added, Changed, Deprecated, Removed, Fixed and Security. A `feat` defaults to Added, `fix` to Fixed, and other types to Changed; review this mapping against the actual change. `Changelog-Category`, `Changelog-Note` and `Changelog-Exclude` trailers can express intentional authoring in commits. Exclusion affects presentation, never compatibility/version impact. Breaking changes come from explicit Conventional Commit markers and retain migration descriptions; never infer a breaking change merely from an addition.

Refreshing `collect` preserves existing curation by full commit OID. It refuses another task's draft or a refresh that would erase prior captured entries. Preserve such drafts and reconcile changed scope/target explicitly.

## Retention during merge finalization

Before the final signed readiness check, archive in the **owned source**, so the authorized Merge Back carries the record into the target:

```text
node <skill>/scripts/changelog.mjs archive --repo <source-worktree> --input <source-worktree>/changes.md --date YYYY-MM-DD --retire-draft
```

The retained path is `changelog/changes/YYYY-MM-DD-<subject>-<stable-task-hash>.md`. The hash avoids collisions across similarly named tasks. Archive verifies the captured Git history and current source head, preserves the artifact's bytes and refuses conflicting existing files. `--retire-draft` removes only the verified root draft after the archive is retained. Omit that flag to keep both while reviewing.

Commit the exact archive path through the repository's authorized workflow, then obtain/refresh Merge Prep readiness. Preserve the captured `source_head`: it intentionally precedes the record-retention commit, avoiding a self-referencing commit hash. Any later product commits require fresh collection; do not relabel an old fragment as describing new code. If an uncommitted staged archive needs replacement, review and remove only that owned stale file; committed archives remain historical records.

If Prep is already ready, do not mutate its prepared source or write a new target-side commit behind its signed receipt. Use supported eligible record finalization if the captured policy permits it; otherwise make the normal authorized source commit and re-Prep before Back. This convention does not add a retroactive blocking gate to frozen plans or legacy signed runs. No blanket Git ignores or policy weakening are needed.

## Compose a developer changelog

Select explicit archived files for one project. Supply previously released fragments with `--exclude-input` to avoid repeating their commits. Always verify against the owning repository:

```text
node <skill>/scripts/changelog.mjs compose --repo <repository> --input <fragment-a.md> --input <fragment-b.md> --exclude-input <already-released.md> --output <fresh-draft.md>
```

The helper emits an `[Unreleased]` section, validates full source/target commit coverage and messages, deduplicates by full OID, and refuses conflicting curation of shared commits. Input order does not affect output. File-only offline composition is diagnostic and explicitly reports that Git provenance was not checked; it is not the final workflow.

For an explicitly selected release, supply `--base-version`, `--version` and `--date` together. Strict SemVer syntax and ordering apply, including prerelease/build identifiers; the version must meet at least the highest captured breaking/feature/fix impact. Repository per-commit policy remains authoritative: when it assigns PATCH to maintenance types, pass `--maintenance-bump patch`. The standards themselves do not assign a bump to every maintenance type. The helper does not rewrite existing version history or apply a new bump per fragment.

Review the composed section into the repository's existing `CHANGELOG.md`, preserving its description, `[Unreleased]`, dated newest-first releases, prior published entries and comparison links. Keep concise developer-facing explanations; consolidate related commits without losing provenance or migrations. Reverts and renamed/squashed ports require human-readable technical reconciliation rather than automatic text deduplication. The helper writes only a new output file and refuses to overwrite an existing changelog.

Follow the existing commit/release authority for version changes, publication and tags. A draft or archived fragment is not test evidence, signed green or release acceptance.

Standards: [Conventional Commits 1.0.0](https://www.conventionalcommits.org/en/v1.0.0/), [SemVer 2.0.0](https://semver.org/spec/v2.0.0.html), [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/). Artifact details: [format](references/format.md).
