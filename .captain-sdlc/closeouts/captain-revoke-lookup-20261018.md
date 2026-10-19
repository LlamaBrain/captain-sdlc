# Captain revoke lookup fix - 2026-10-18

Status: implementation complete; Captain signed complete/green. Integration remains separate.

Michael authorized: "Do the revoke lookup bug fix next." Bounded unbound bug-fix ticket; no retrospective plan binding or HITL checkpoint.

## Delivered scope

Named-target authorization queries now retain untargeted revocations within their existing repository, operation and session/source-branch or intent scope. Untargeted approvals and receipts for other named targets remain excluded. Producer/parser behavior, receipt fields, signatures and ordering are unchanged.

| Criterion | Result |
| --- | --- |
| R1: scoped generic revocations visible in named-target lookup | Passed; filter exception only for undefined target plus revoke |
| R2: preserve evidence and order | Passed; source indices, cross-turn timeline, original wording/targets, byte-identical signed receipts and idempotent replay |
| R3: real producer and compiled public MCP proof | Passed; three producer regressions, compiled public RED/GREEN and unchanged feature gates |

## Identity and retention

- Task: CAPTAIN-REVOKE-LOOKUP-20261018; intent: intent-81ba65c4-a914-4625-ba9b-8ab2d29b95e4.
- Primary: E:/Personal/captain-sdlc; dev remains a6ba6a1a92b93ccd6f4eb53dba2f85a17411e2d3.
- Owned worktree: E:/Personal/captain-sdlc/.captain-sdlc/worktrees/intent-81ba65c4-a914-4625-ba9b-8ab2d29b95e4.
- Branch: captain/intent-81ba65c4-a914-4625-ba9b-8ab2d29b95e4.
- Tested source commit: e3eb60466d08f236e4dca38fc333c74d667f8d71; v0.7.9; tree 6023a7a2fe8b2a6a76b0275aba98e5a1132f76af.
- Subject: fix(captain): retain generic revocations in target lookups (v0.7.9).
- Whole ignored node_modules and bin roots were hydrated from routing prep checkout 700ea3766c849915e89eef38da687ab12e607c57. All 153 non-root lock dependency records remain unchanged.

## Verification

Focused producer RED: 20 tests, 17 passed and 3 expected failures. Signed full Ticket RED recorded exit 1 before implementation; output SHA256 c81383e8d78cf92c9285c9cad6fef831d8fe9d95487a4e42f57509d734c15794.

Compiled public RED returned indices [1,5] instead of [1,2,5,6]. After the fix: focused suite 20/20 passed, no skips; compiled public smoke passed all 9 outcomes. Those checks preceded the commit on the same source bytes subsequently committed above.

Final signed feature proof completed 2026-10-19T04:26:51.626Z against the tested commit:

| Gate | Trusted command | Result |
| --- | --- | --- |
| Build | npm --prefix plugins/captain-sdlc run build | PASS |
| Ticket | npm --prefix plugins/captain-sdlc test | PASS |
| Public MCP smokes | npm --prefix plugins/captain-sdlc run smoke | PASS |
| Typecheck | npm --prefix plugins/captain-sdlc run typecheck | PASS |

Build artifact: plugins/captain-sdlc/dist; SHA256 e2a13dc842c9251d5ad1c75876815ffcf718c4b8fc3c1a5e3f331271b51487fd.

Smoke artifact: plugins/captain-sdlc/.captain-proof/smoke.json; SHA256 0f7f2b848d96bfcb9d42a3980f47c8c7e05c8a1c50619204393d202a9c057111.

The compiled product smoke records plugin version 0.7.9. The proof orchestrator is the unchanged installed 0.7.7 public Captain runtime (server SHA256 3b7ad4615588683420759654d40f9c827bbfcfabc78b5b266f56264638f4eae0), using its original authority store. The new source bundle was not installed globally.

Local public transport receipt: E:/Personal/dirigible2D/Temp/automation-scratch/captain-revoke-lookup-20261018/final-proof.json. Signed authoritative run revision 11; evidence retained through Captain status for the intent above.

Focused logs in the retained worktree:

- plugins/captain-sdlc/Temp/automation-scratch/revoke-lookup/user-authorization-red.txt; SHA256 6c07a9fdb358a45bfe6d61fb015dc950297e3905a5aa7ec06f5ab6b1c6cfd6f4.
- plugins/captain-sdlc/Temp/automation-scratch/revoke-lookup/public-red.txt; SHA256 1d1cc0f4ddaa6a2429feb1d4c58ec9c05b4cad0b169b0579260d9c79f1164e6b.
- plugins/captain-sdlc/Temp/automation-scratch/revoke-lookup/focused-green.txt; SHA256 026f24385fab2ed523771a054d47624070dbad55639b7a3b8ee37cba5b5356f4.
- plugins/captain-sdlc/Temp/automation-scratch/revoke-lookup/public-green.txt; SHA256 a2a5ff7354a2cf6f77f35e19ef0cac75638ca4e4d7b61b5b55bfd58747026e72.

Independent read-only source/security review: no blockers. Git whitespace check passed. No visual evidence or HITL applies to this tooling-only fix. Hosted CI and pre-release gates were not run or claimed.

## Operational recovery

The host response for signed RED timed out after 300 seconds while its real-Git children continued. No duplicate gate was launched. Public status subsequently confirmed the same run advanced to implement with signed RED evidence. Final proof used the installed public MCP transport with a 3600000 ms response timeout, preserving all captured commands, scope and authority. The recurrence is recorded under Churn/2026-10-17-completed-owner-failed-begin-recovery.md.

## Follow-ups for human review

The existing long-gate transport/diagnostic limitation remains a tooling follow-up: host responses expire before full feature fixtures finish, and gate stdout is buffered. Owner: Captain maintainer; proposed next action: separately scope bounded asynchronous gate status/transcript support. This was not added to this bug fix.

Next owner/action: Michael may select merge prep into dev. No merge, push, release or global plugin installation was performed for this task. Product proof stays bound to e3eb60466d08f236e4dca38fc333c74d667f8d71 even when record-only bookkeeping is retained in a later commit.

## Merge Prep - 2026-10-18

Current integration status: READY, not merged. Michael authorized "PErform merge prep".

- Signed merge: merge-a6dec029-4dc5-49df-aed2-bdb264f33f56; original readiness revision 5; strictness LOW.
- Target dev remains a6ba6a1a92b93ccd6f4eb53dba2f85a17411e2d3. Fetched origin/dev is bf94a41dbe6e697e1a6beb8a59a2fb1b983b187c; local dev is 47 commits ahead and zero behind.
- Checked source: 56ecc81f37584686ff902aa5681b3430e3431c77 (v0.7.10). Fresh captured build passed, exit 0; incoming whitespace check passed; no conflicts or dependency changes.
- Original implementation complete/green proof remains at e3eb60466d08f236e4dca38fc333c74d667f8d71 (v0.7.9). It is not relabelled as a full feature pass at v0.7.10.

The first Prep attempt failed the incoming whitespace check at scripts/mcp-smoke.mjs:88. Exactly one CR byte was removed. The mandatory patch bump/changelog and generated server version were synchronized in ordinary repair commit 56ecc81f37584686ff902aa5681b3430e3431c77; the completed implementation run was not reopened, and there was no pending target merge for Prep commit metadata. Independent review confirmed unchanged authorization implementation, unchanged 153 dependency records and unchanged smoke logic. The same merge ID then passed its unchanged LOW gate.

The compiled public smoke was also rerun at the repair bytes and passed all 9 outcomes. Fresh log: plugins/captain-sdlc/Temp/automation-scratch/revoke-lookup/public-green-v0.7.10.txt; SHA256 78f1a5d60bfed88a2558ecb0a9f526e202fe04ff739b75d42782925efb2bed88. Preserved fresh smoke payload: plugins/captain-sdlc/Temp/automation-scratch/revoke-lookup/public-smoke-v0.7.10.json; bundle SHA256 991512eb678ede6e926181af5b154183468dcd37d74aef8d597ff61458f4eeb9.

Evidence retention correction: the helper initially reused public-green.txt; its new output was saved under the versioned filename above. The original v0.7.9 stdout was restored verbatim from the retained tool transcript and verified against its previously committed SHA256 a2a5ff7354a2cf6f77f35e19ef0cac75638ca4e4d7b61b5b55bfd58747026e72. Generated build/smoke working paths now contain v0.7.10 output; the earlier signed hashes above retain their historical v0.7.9 provenance and are not claims about current cached artifact bytes. The original full-smoke payload was not separately cached; its signed outcome and artifact hash remain in the retained proof ledger.

Build gate command SHA256 f0416e5352c659f2a9537645324c1b3ef7bcacbbef507bb84033f77478d18852; stdout SHA256 50bbcec6eecfa9bbf0810950c29d41720e811b370320f0361cadcc14d71e7e8c; stderr SHA256 01ec7fdbfd881a5be8fc24d766293b892ec710290c967b128f0cadd3b3c3270c. Local sanitized readiness receipt: E:/Personal/dirigible2D/Temp/automation-scratch/captain-revoke-lookup-20261018/merge-prep-ready.json.

Record-only descendants are associated through the same signed merge operation without repeating this build. Next action: Michael may authorize Merge Back into dev. No Merge Back, push, release or global plugin installation was performed.
