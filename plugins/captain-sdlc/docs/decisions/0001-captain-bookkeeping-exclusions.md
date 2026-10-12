# Captain bookkeeping exclusions

Accepted: 2026-10-11. Scope: Michael's recurring merge finalization churn.

Operational notes change while an implementation is being finalized and again between Merge Prep and Merge Back. Requiring a product version bump and repeated runtime proof for these records causes new dirt during the very actions intended to close the task. Ignoring them in Git would lose durable handoffs and decisions.

Use `.captain-sdlc/captain.ignore`: a committed, line-by-line file parsed with Git's ignore semantics. A trusted repository policy explicitly selects it through `commit.bookkeeping.path_file`. Captain captures its exact committed bytes and hash. Matching operational records stay Git-tracked. Working rule edits cannot broaden a captured operation.

Rules narrow a fixed operational-record ceiling. They cannot exempt governing policy, plans, hooks, dependencies, AGENTS.md, product code/assets, version surfaces or changelogs. Only regular, non-executable bounded text participates. Actual first-parent tree changes, modes, contents and task trailers are checked; a commit label alone establishes nothing.

Standalone finalization has its own signed journal, exact branch/worktree leases, mutation snapshot and commit/stash recovery. It does not edit completed implementation proof or acceptance. Stashes remain retained with their exact object IDs. Merge Prep and Back can each finalize fresh selected records, keeping previous receipts.

Prep checks remain associated with the tested revision. A distinct integration association may include audited record-only descendants only when product input manifests, dependency inputs, metadata and identities still match. Changes to actual product or control inputs require normal preparation. Legacy operations and captured policies retain their original rules.

Consequences: initial adoption and later rule changes use ordinary versioned commits. This feature does not hide dirt, authorize foreign work, waive clean-worktree checks, auto-drop stashes or manufacture newer runtime proof. It solves bookkeeping finalization separately from owner/lease recovery.
