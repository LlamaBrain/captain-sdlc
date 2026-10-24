# Bounded worktree storage

Owner: Captain
Task: `captain-bounded-worktree-storage-20261023`
Intent: `intent-b9dc226b-8c76-4099-96b2-1bbcfc84d55d`
Branch: `captain/intent-b9dc226b-8c76-4099-96b2-1bbcfc84d55d`
Base: `e0d0088634fa2547a396b8f1942218a474eb7262` (`dev`)

Michael authorized future storage prevention across Unity and non-Unity projects.
He will handle existing worktrees himself. Existing unregistered worktrees are
excluded from automatic adoption and deletion. The task has no selected frozen
plan or HITL gate; its original feature-profile checks remain captured in Captain.

## Authorized criteria and implementation

- C1: Keep one replaceable build attempt in stable generated output roots per
  worktree. New policies capture trusted roots, clear disposable output before
  producers, preserve tracked files, and reject report-only unbounded payloads.
  Ordinary projects use an immutable fixed build slot. Visual file slots remain
  files; dotted framework output directories remain directories.
- C2: Prevent nested worktree creation by resolving the canonical container from
  the validated primary repository while retaining signed invocation identity.
- C3: Clean eligible completed worktrees in a recorded chain after integration.
  Creation journals and exact parent/merged edges establish membership; source
  HEADs must be integrated. Branch refs remain available for recovery.
- C4: Preserve active tasks, unfinished Begin/completion authority, dirty files,
  unknown ignored user data, Git operations/locks, nested repositories, external
  reparse targets, foreign leases, and replacement checkout identities.
- C5: Retain bounded compact proof and task handoffs outside deleted checkouts;
  validate archives for historical status and exact interrupted cleanup recovery.
- C6: Apply the ordinary helper and guidance to unenrolled projects such as
  game-assist, with active/resumed branch reservations and visible retention exit 2.

## Verification

Tests reproduced the missing behavior before implementation. Captain recorded the
trusted red gate (exit 1) and advanced to implement/running at revision 2 after its
long-running command completed; the MCP caller's five-minute timeout did not
cancel the underlying suite. No red receipt was fabricated.

Focused artifact, creation/continuity, ordinary CLI, chain integration and deletion
safety checks passed, including real Windows junction behavior, absent optional
LOW reports, required missing/corrupt reports, custom proof directories, pending
Git operations, held completion authority and interrupted removal/lease recovery.
Typecheck and public MCP lifecycle/merge smoke checks passed. A new storage smoke
also passed against the built runtime through actual public MCP and CLI commands.
All new temporary smoke repositories were removed after verification.

Pre-commit broad regression result: 759/759 passed. The latest affected cleanup,
ordinary CLI and chain cases passed 33/33 after the final safety refinements.
Artifact/output checks passed 16/16; creation/continuity checks passed 9/9.
The first full run passed 751/755; three new checks used the pre-repair optional
artifact logic, and one required a clearer leased-owner reason. Their causes were
repaired and focused checks passed. A final full run is in progress against the
frozen final source. Final runtime rebuild, typecheck and public merge smoke pass;
the full final smoke also includes the new storage MCP/ordinary CLI exercise.
Automatic approval review rejected expanding the default deletion names to generic
`target`/`output`/`publish` directories. The implemented alternative reads exact
output roots from signed captured policy or the ordinary signed output slot and
preserves unclassified siblings. No rejected default expansion was applied.
Focused regressions also preserve leading-whitespace filenames without aliasing a
generated directory. These last safety refinements are covered by a new focused
run; final signed proof will rerun all checks at the committed final revision.
The strengthened public storage smoke also passed: captured `out/active` ownership
allowed cleanup, while an unclassified sibling caused integration to succeed with
the checkout preserved; same-operation retry succeeded after fixture-owned data
was explicitly disposed. New smoke fixture repositories were removed afterward.
CI: workflow added for Node 24 on Windows and Linux; no push or CI result claimed.
Implementation commit: `345b60038b4f2d25b0b625fd52e8273864ca09b5` (v0.9.0),
recorded through Captain as the intermediate feature phase. The dated developer
fragment preserves that source and the pinned dev target. Signed complete/green
proof, integration and installed rollout are separate pending operations.
Existing installed plugin and
global worktree skill remain unchanged while this task is prepared.

## Next action

Michael explicitly approved the exact prepared v0.9.0 commit, Merge Back to dev,
and local plugin/worktree-skill installation, conditional on the final checks
passing. Do not request the same authorization again. The proposal includes
necessary project changelog finalization; it does not independently grant a tag
or release publication.

The approved implementation commit and collection/archive are complete. Retain the
archive and synchronized metadata through the authorized docs patch commit
(v0.9.1) with `final:true`, then run Captain proof once at that final revision.
Continue signed Merge Prep/Back to dev and local install.
Apply the prepared narrow global worktree skill update only after the installed
storage helper is present and the original skill hash still matches. Continue
this same task and worktree across any handoff.
