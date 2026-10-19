# 2026-10-18 - Fresh worktree line endings blocked Captain Prep

**Status: RESOLVED**

**Occurrence:** 2026-10-18 America/Los_Angeles. **Date basis:** This execution's public preflight failures. **Recorded:** 2026-10-18.

## Summary

Michael authorized routing-checkpoint Merge Prep. Its fresh current-dev checkout appeared clean under ordinary Git, but public Captain Prep refused "target branch worktree must be clean before Captain uses it". This happened before a signed merge ID was created; no refs advanced and no gate was skipped.

## Diagnosis and resolution

Exposed MCP and the verified installed 0.7.7 SDK public transport agreed on the rejection, so a runtime-version difference was excluded. Read-only reproduction of Captain's sanitized Git environment found primary dev clean and this source checkout with 281 CRLF-only differences caused by checkout under global autocrlf behavior. Verified every difference against the pinned committed blobs, then aligned only this task's working files to those exact blobs. No HEAD/index, signed policy, global/shared Git configuration, dependencies or foreign worktree changed. A scratch prevalidation initially needed a larger buffer for the existing 1.2 MB bundled server; no files had been written before that bounded retry.

The next public Prep created merge-9b2f1d30-af99-45d7-8258-f743c699f5c9 and passed LOW baseline Build; after the actual recovery commit 264f8204fcd0c76d346a9c6b54cfc396f2e90fd4, the same operation reached READY revision 6 with a valid receipt and fresh LOW Build exit 0. The task's Core/Git smoke passed all seven checks. Target dev remains 4102da5a3f06aad33d790305fe522b7680231ada.

Evidence, original-path/hash manifests, task identity, source checkout and exact proof are retained in .captain-sdlc/closeouts/captain-routing-records-prep-20261018.md. This resolves the current task setup; optional worktree-materialization and error-message improvements are separate follow-ups, not new completion gates.
