# Bounded worktree storage — completed

Date: 2026-10-23. Owner: Captain. Task: `captain-bounded-worktree-storage-20261023`.
Status: implementation verified, local Merge Back complete, plugin and worktree skill installed. Public PR #10 is ready for review; no public dev update or PR merge was requested or performed.

## Delivered behavior

- New Captain worktrees are registered under the validated primary repository container, with exact signed creation and chain identities. Existing worktrees are never retroactively adopted for deletion.
- Builds reuse declared generated output slots. Producer cleanup preserves tracked files and rejects unsafe roots, links, nested repositories and worktree overlap. Ordinary projects use one signed fixed slot through the installed storage CLI.
- Successful Merge Back retires eligible newly registered, fully merged worktree chains. Active, dirty, unmerged, locked, uncertain and unregistered checkouts remain protected, with visible retention reasons. Branch refs remain intact.
- Compact evidence is retained outside removed checkouts, bounded to 16 MiB, 2048 files and 4096 directories per checkout/revision. Exact journals and authenticated archives support safe retry and historical status.
- Ordinary Git projects, including non-Unity projects such as game-assist, use the installed create/resume/prepare-output/cleanup helper and updated global worktree guidance.

## Verification and exact revisions

Original signed implementation intent: `intent-b9dc226b-8c76-4099-96b2-1bbcfc84d55d`.
Run: `codex-38b08db8-7532-4399-a4ed-9957d410e942`.
Signed revision 18 is complete/green at `f88cce3e9ea58a69bfd58fae29b15536e68e4ee5`: build, all 762 tests, public MCP smoke (including storage and ordinary CLI), and typecheck passed. That proof remains bound to its actual revision.

Integration head: `28a1de586abfc0777085eb1e02ac9c0ce3b5b584`, version 0.9.3.
Subsequent CI-only repairs corrected a native-path fixture, canonical hosted-runner temporary roots, runtime variable scope and unpublished historical log references. Storage logic was unchanged.

- [Plugin CI](https://github.com/LlamaBrain/captain-sdlc/actions/runs/40063889231): Windows 762/762 passed; Linux 761 passed, one platform-specific skip, zero failures. Both runners passed typecheck, public MCP/storage/ordinary CLI smokes and merge smokes.
- [Documentation CI](https://github.com/LlamaBrain/captain-sdlc/actions/runs/40063889315): link check passed.
- Windows test execution took 1,789,685 ms (about 29.8 minutes); it completed successfully. The local 759-test precommit run had 70.1 summed minutes of individual test durations and 18.3 elapsed minutes on 16 available processors. Windows process-ownership probes launch PowerShell, whereas Linux reads procfs; this and lower hosted-runner parallelism explain likely overhead, without claiming a measured per-probe CI profile.
- Installed runtime verification passed: 12 critical runtime/helper/skill files matched the integrated primary source, public MCP advertised 0.9.3 and retained the original signed green proof, and the CLI loaded without development dependencies.
- Installed storage skill and updated global worktree skill passed skill validation. No separate lint command is defined; TypeScript checking passed.

## Local integration

Signed merge: `merge-e99ee4cc-e0e7-4ee9-b74f-14e8ad5081e1`.
Source: `captain/intent-b9dc226b-8c76-4099-96b2-1bbcfc84d55d` in the original task checkout.
Target: primary `E:/Personal/captain-sdlc`, branch `dev`, pinned from `e0d0088634fa2547a396b8f1942218a474eb7262`.
Fresh signed Merge Prep passed its captured LOW build gate at 28a1de5. Merge Back then returned `merged` with a valid receipt and fast-forwarded local dev to that exact head. This subsequent closeout is supported record-only bookkeeping; it does not manufacture new runtime proof.

## Installed rollout

Captain is installed and enabled at `C:/Users/metag/.codex/plugins/cache/personal/captain-sdlc/0.9.3`.
The personal marketplace now points to durable primary `E:/Personal/captain-sdlc`, replacing its old worktree source through the supported CLI remove/add sequence. Other marketplace registrations and old worktrees were preserved.

Global worktree skill: `C:/Users/metag/.codex/skills/worktree/SKILL.md`.
Installed SHA-256: `904c1452c4515647af3aae2b6e979ffcc6ec966d2a028675a1b547ef0688703f`.
The original SHA was checked before atomic replacement. Exact backup and rollout manifest are retained locally under `.captain-sdlc/evidence/storage-rollout/captain-bounded-worktree-storage-20261023/`.

## Authorization and preserved boundaries

Michael approved the prepared commit, local dev integration and installation after checks passed, then public publication and PR creation. The initial named-commit publication approvals and the later CI-completion scope resolved the automatic review publication rejections. No approval remains pending.

[PR #10](https://github.com/LlamaBrain/captain-sdlc/pull/10) is ready for review with green checks at 28a1de5. It explicitly explains that GitHub dev was six earlier local-dev commits behind this task's local baseline. Public dev and the public PR were not merged by this task.

No existing worktrees were cleaned. This task checkout predates the new registry and remains unregistered and retained, as requested. New automatic cleanup never fabricates registration for old checkouts. No broad sweep, forced removal or branch deletion was performed.

No required work remains for the authorized local integration and rollout.

