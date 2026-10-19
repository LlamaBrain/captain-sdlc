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
