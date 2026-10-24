# Worktree changes artifact v1

`changes.md` contains a developer-readable categorized summary and one fenced JSON block introduced by `<!-- captain-changes:v1 -->`. That block is the editable source for rendering; composition rejects drift between it and the visible summary. Run `render --write` after curating metadata.

The block records `schema_version: 1`, `audience: developer`, a stable `project` and task/merge `id`, technical `subject`, `source_branch`, full `source_head`, pinned `target_head`, `merge_base`, `entries` and `omitted`.

Each entry retains its full commit `oid` and original `message`, parsed CC `type`, optional `scope`, `description`, `breaking`, migration text and exclusion decision. Only `summary` and the KAC `category` are curatable independently of that message. Original messages stay intact. Standard footer aliases and bang markers carry compatibility information; repeated generic Git trailers are permitted. Custom `Changelog-*` directives are singletons.

Collection uses all source commits unreachable from the captured target, rather than a date range, first-parent log or wrapper merge subject. Non-CC structural merges are explicitly omitted; Conventional Commit merges retain their authored information. Artifact-only commits are omitted to prevent fragments describing their own retention. Ordinary malformed commits fail collection rather than disappearing.

`compose --repo` recomputes the complete captured range, merge base, messages, parsed fields and omission reasons. Coverage must match the artifact. This is reproducible Git provenance, not signed Captain acceptance. Offline files alone cannot establish that the source commits exist in a consuming repository.

The archive retains these historical inputs under `changelog/changes/<date>-<subject-slug>-<project/task-hash>.md`. Its source OID precedes the commit retaining the artifact. The archive command never claims to contain a hash of its own future commit. An archive collision preserves the existing file; source changes require recollection and review before readiness.

Composition requires one project. Overlapping commits are deduplicated by full OID and must have identical curation/provenance. `--exclude-input` explicitly identifies already-released fragments; input files are never silently marked consumed or deleted. Patch-equivalent cherry-picks and squashes retain different identities and need review.

SemVer recommendation is the highest marked impact across all selected commits, including entries intentionally excluded from the displayed prose. Maintenance-only changes recommend no standard bump unless repository policy explicitly selects PATCH. A release version may exceed the minimum required impact, because repositories can have intervening versioned commits; the helper never sums per-fragment bumps or overwrites repository version policy.
