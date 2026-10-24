---
name: worktree-storage
description: Create registered worktrees, replace a fixed active build slot, and remove completed merged worktree chains for repositories using the ordinary Git workflow without Captain runtime enrollment.
---

# Bounded worktree storage

Use this workflow when committed `HEAD` has no `.captain-sdlc/codex-policy.json`. Enrolled repositories use Captain's MCP Begin, captured output policy, and Merge Back cleanup. This helper supports ordinary projects including .NET, web applications, and Unity. It records local storage ownership; it does not provide Captain implementation proof, merge authority, or human acceptance.

Resolve `../../scripts/worktree-storage.mjs` relative to this `SKILL.md`. Invoke it with Node and exact structured arguments. All commands return JSON and fail when required identities cannot be verified. In Windows terminal calls, use `tty: true`; run cleanup from the retained target checkout so the source is not the process's current directory.

Before first use, keep these local state paths ignored through the project's normal configuration workflow:

For machine-local state, add the entries to the verified common Git directory's
`info/exclude`, preserving its existing contents. A committed repository ignore
rule is also supported when that belongs to the authorized task.

```text
/.captain-sdlc/storage-authority/
/.captain-sdlc/worktrees/
```

1. When implementation needs a new worktree, run:

   ```text
   node <plugin>/scripts/worktree-storage.mjs create --project <invoking-checkout> --task <ticket-id>
   ```

   The helper retains the invoking checkout's committed HEAD, creates one `captain/<ticket-id>` branch in the validated primary checkout's `.captain-sdlc/worktrees/<ticket-id>`, and returns its exact path and base. Use `--base <commit>` only when the authorized task selected a different committed base. A new child created from a registered checkout records its exact parent binding. Create/reuse reserves the task's branch as active using signed lease generations; this reservation represents the task, not the short-lived helper process.

   Continue the same task in the returned checkout across sessions. Before continuing a registered ordinary task, run `node <plugin>/scripts/worktree-storage.mjs resume --worktree <checkout>` to restore its active reservation, even when HEAD and files have not changed. Preparing its output also marks the task active. A final child cleanup must preserve a resumed predecessor. Resume legacy worktrees through their original handoff; the helper never adopts them for deletion.

2. Choose one Git-ignored generated build directory in that checkout, normally `artifacts/active` or `Builds/active`. Before each build or publish, run:

   ```text
   node <plugin>/scripts/worktree-storage.mjs prepare-output --worktree <checkout> --root artifacts/active
   ```

   Send the producer's output to the returned `build_output_path`. For example, pass that path to `dotnet publish --output`. The helper binds this root as the checkout's fixed slot and clears its prior ignored generated contents before rebuilding. A later attempt cannot allocate another task or timestamp directory by changing `--root`. Tracked source, worktree stores, repository metadata, reparse targets, and nested repositories are protected. The same command supports the primary checkout without registering it for removal. Keep compiler dependency caches in their normal stable directories; do not copy them into retained artifact snapshots.

3. Keep test result files, build reports, source OIDs and hashes as compact proof. Full development binaries and copied worktrees are disposable. Preserve a full release artifact only when the project's release policy requires it, in the release destination selected by that policy.

4. After the task and all originally required checks/HITL are complete, perform its authorized ordinary merge. A Prep-only request stops at readiness. Once the merge has landed, change the command's working directory to the retained target and run:

   ```text
   node <plugin>/scripts/worktree-storage.mjs cleanup --source <completed-worktree> --target <retained-target> --evidence <relative-test-report.json> --evidence <relative-build-report.json>
   ```

   Pass each compact proof report that must survive; paths are relative to the completed source. After verifying source identity and integration, this explicit completion releases only the selected task's own active reservation. The helper archives bounded evidence and a signed manifest outside the checkout before removing it. It removes only newly registered, clean sources whose exact commits are included in the target. A recorded parent is eligible only when a previous terminal completion matches the chain's pinned parent revision and no active reservation survives. It keeps branch refs and refuses legacy, active, dirty, unmerged, locked, replaced or unsafe checkouts. Never supply `--force`, sweep a directory tree, or delete a branch to suppress a refusal.

5. Read `removed_worktrees`, `retained_worktrees`, and `evidence_root` in the result. Exit code 2 means cleanup retained a checkout; report each reason and next action instead of calling storage cleanup complete. A signed storage completion is independent of CI, implementation proof, human acceptance and release proof. Retries use the same identities and verify the retained evidence; a missing source directory alone never establishes successful cleanup.
