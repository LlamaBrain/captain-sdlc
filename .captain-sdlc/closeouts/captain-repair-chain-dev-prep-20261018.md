# Captain repair chain - dev preparation

Prepared the retained repair chain, including pending-work auditing and lifecycle/recovery fixes, against actual Captain dev. Signed Merge Prep is READY; target dev remains unchanged. This record is the canonical closeout for this preparation. Merge Back and hosted CI have not run.

## Revisions and authority

- Michael: "Start with repair chain." Necessary preparation, bounded repairs and retention performed in the existing checkout. No new implementation worktree or signed merge operation was created.
- Source branch: fix/captain-target-first-merge-version-20261018, at E:/Personal/captain-sdlc/.captain-sdlc/worktrees/captain-target-first-merge-version-20261018.
- Tested product revision: f8aef3367dc655decf23f3d4facde0085640bdcc (Captain 0.7.7). A later bookkeeping-only descendant can contain this closeout; its exact OID is retained by the signed finalization receipt.
- Product commits: 98b714a40d1121b626ea8bb9ca09174b8f9ad63c (0.7.6, actual dev reconciliation and missing-component guard); f8aef3367dc655decf23f3d4facde0085640bdcc (0.7.7, inherited formatting cleanup).
- Pinned target: E:/Personal/captain-sdlc, dev at fea6a55bf1f0ba2d67de20283be3823915fa5470. The source contains this target as an ancestor; the target ref has not advanced.
- Original repair source ef9f9f42fd4db135a4c1e52de584e6260e959a1c and pending-work branch 2bf38f329c14 remain ancestors, with their retained branches/checkouts preserved.
- Merge merge-332d72dd-5d62-4269-8a2c-ee2faddc46a8, session codex-unified-game-actions-20261013; signed READY revision 9, receipt_valid=true. Captured LOW scope: build only. Policy hash 827ebf5cb6756798a0e21df1e060f4e5f1007f051c72c06778f0654407cbdfe5.

## Delivered and verified

- Reconciled dev's task-capsule, governed-loop and frozen-plan guidance with the repair chain. Resolved two documentation conflicts, preserving source worktree identity rules and dated historical recovery evidence.
- Fixed an actual preflight bug: an authenticated merge may introduce a versioned component when every configured version path is absent from the incoming target and every common merge base. Missing bases/Git errors, malformed/partial metadata and deletion of an existing release remain refused. Parent authentication, source version, synchronized surfaces and deterministic bump rules are preserved.
- Independent reviews approved the docs reconciliation, guard/test boundary and formatting cleanup. All 153 non-root dependency records remain unchanged. No fail-open enforcement overlay, archive snapshot or separate routing implementation was imported.
- Focused real-Git RED: one intended test failed before implementation with the same semantic/prepared-merge rejection. GREEN: all 14 merge-version tests passed, zero fail/cancel/skip/todo (32518.8269 ms). These tests exercise the functional 0.7.6 source subsequently committed at 98b714a; 0.7.7 changes line endings/trailing blank lines and release metadata only.
- Fresh 0.7.6 public MCP merge alias/Prep-Back smoke and merge lifecycle smoke both green. Runtime SHA256 b38e762db729a7be13292090ca1a793f40f1bb0806619bec08296ac695366216. No old smoke was relabeled as a 0.7.7 run.
- Fresh 0.7.7 local build/typecheck passed. Signed LOW Build passed at f8aef3367dc655decf23f3d4facde0085640bdcc, exit 0. Build command: npm --prefix plugins/captain-sdlc run build; stdout SHA256 73b75c96cf0012704f4f1d8a965f709aabe84d3eed56395a3c4dce260b1eed56; stderr SHA256 3df4b017c2e1c0d8e83f63632233588fa0148aa46fb8a25696f9a96d7914e052. Incoming whitespace and clean committed source/target checks passed.
- Standard plugin manager installed 0.7.7 from this source; installed bundle exactly matches the built source. Public handshake reports captain-sdlc 0.7.7 and 40 tools; bundle SHA256 3b7ad4615588683420759654d40f9c827bbfcfabc78b5b266f56264638f4eae0. Authority store remains C:/Users/metag/.codex/plugins/data/captain-sdlc-personal. Hook definitions and their behavior remain intact; the only inherited hook-script change was line-ending normalization.
- Earlier 678/678 full-suite pass remains at 9c4b0929a63311775e23d4503d2b3756cf4059df. It is historical context, not a new-version pass. LOW readiness is distinct from implementation complete/green: captain_green=false. No Unity/HITL/visual gate applies to this Node tooling slice. No push, release or hosted CI was authorized/performed.

## Failures retained and resolved

The first new test attempt omitted the incoming README from its explicit fixture selection; that setup failure is excluded from product RED evidence. The corrected test reproduced the version preflight failure and passed after the bounded guard repair. The public 0.7.6 Prep committed successfully, then its incoming whitespace gate failed on inherited CRLF/EOF formatting. Exact 23-file cleanup preserves line contents and JSON values; original blobs remain at 98b714a. After the merge was committed, Prep correctly refused additional pending-merge commit metadata. The ordinary 0.7.7 repair commit used exact reviewed paths, synchronized metadata and normal Git hooks; the same Prep resumed without commit metadata and reached READY. No raw merge, reset, policy edit or new authority store was used.

Diagnostic incident: Churn/2026-10-18-unversioned-target-merge-preflight.md. Automation scratch (disposable): E:/Personal/dirigible2D/Temp/automation-scratch/captain-dev-prep-20261018. Evidence file hashes:

| File | SHA256 |
| --- | --- |
| version-semantic-red.txt | aee44e89da1608c65853b88deafac0f789d9959f84173516ffcdae91c2c7379a |
| version-green.txt | 808c3fd2921a8e89e3fa08324457684c818ec707224cdf5cf42c09c1394ec056 |
| build-local.txt | fc51ed4796ce058bc93f10ff0cbc5ea120f2f7776f83c9736867dbc61087abf8 |
| merge-smoke.txt | 51a5d2f5d9a68ee4b77bb0ad40744c44e40486e6ad8bbafd38e18a25d2140881 |
| build-077.txt | bbcb5c1d048dff7cfb56b49791ec6c7689c97a01e5c281e2985322f32f7db03c |

The public smoke packets remain at plugins/captain-sdlc/.captain-proof/merge-mcp-smoke.json and merge-lifecycle-mcp-smoke.json (created 2026-10-19T02:46:55.865Z and 2026-10-19T02:47:47.776Z). Their green outcomes/runtime hashes are retained above; their fixture paths are diagnostic, not production refs.

## Target dirt preserved

The target started with 17 untracked paths. All were hashed and backed up before movement. Sixteen normal paths are retained byte-for-byte in stash f5a0c0abdfa8846665885f047bc8746652e87322, base fea6a55bf1f0ba2d67de20283be3823915fa5470; all third-parent blobs were verified. Do not drop or automatically restore it. The first two configuration blobs also match retained checkpoint cdee135e2ce90df2ac01ea250e347127d1239be7. They were not silently adopted as new product configuration.

| Original target path | Bytes | Git blob | SHA256 |
| --- | --- | --- | --- |
| .captain-sdlc/.gitignore | 225 | e2c573f536682ca51dea2132bf6a12a706031ca4 | f2aec6a9a022df6e41ee5b58fdf151b30bcf77d933cc7ed582a3687d06a84cc4 |
| .captain-sdlc/routing-policy.json | 121 | 4e8842508a5720a84d0d943dfb77d49d1050e43d | b8a2f79258d4cf480953101d22d2ec0d1f450f0d5e52d4c9eafa694b6fef1b03 |
| .playwright-mcp/console-2026-07-10T00-53-42-709Z.log | 354 | bf4c2191ba47d76ae1bcb9eb8c267fd447d37730 | e1ce4ad6b733066fd2adcd0af4b64d61e7ab2847e07469d5bd3ed81dd8ddae09 |
| .playwright-mcp/console-2026-07-10T00-57-23-291Z.log | 553 | 6e02c8952de15b4341039cc44c79e6a8fab78a99 | 57a6df9d0e846eaa5f6ac826efc7305d37ce0dab3c2afc479c3fde6ce9c7f4b6 |
| .playwright-mcp/console-2026-07-10T01-09-03-528Z.log | 4503 | 0e85496ce45bdc1a82fb3d51ed07dac560ba3704 | 3fda2c6c5ca7a07434affecf4ee04b9835ea9849d417272ec9793ef97bf30f40 |
| .playwright-mcp/console-2026-07-10T02-22-13-672Z.log | 802 | ff7afa8650ba470fe08aaa4ad81bc4e45b8d60c6 | 5fcb20394424f36b094f142ab53a97b5b2ff000d9efc63fb5e57d41a013454ad |
| .playwright-mcp/console-2026-07-10T05-13-22-826Z.log | 1603 | 14bb4628f1530be484d0799cc40585f29042cf56 | 901f4d8a492a5c97c17f4c7d8a9298ce91bf7bb330ce43ce5f61b6b6b4ddf086 |
| .playwright-mcp/page-2026-07-10T00-53-42-840Z.yml | 4825 | 58acbfb91bb33d078110db8c65e289fb73c79458 | 1dd2512e133ab0c0f515d095fe303e635d82b920adfa6cb14183bf1274ad8f42 |
| .playwright-mcp/page-2026-07-10T00-54-04-840Z.yml | 6749 | 6ea722f5a8bbae5b752c5cf3ad0be689f61c8e21 | bcd9d8cf09b554a1c36d62a0c8357c19e0421b1a1dc6f96c5da8ab1856e78210 |
| .playwright-mcp/page-2026-07-10T00-54-46-924Z.yml | 6763 | 15dccaeafaaeb4595c860d7d09b2bbb37d3b7acb | ae92ca7ef9fe0102a5d80db637929f162a3939b657867ffb11eda5ac59632ffc |
| .playwright-mcp/page-2026-07-10T00-57-23-333Z.yml | 4933 | 320f28cc087115e3016ae69df455bf36301acbd4 | 7c3d6a2b6bbb8a53e60fc91c134663c793862ff7737288daa34e6681c0032d31 |
| .playwright-mcp/page-2026-07-10T01-09-03-587Z.yml | 4933 | 99e6842533961b1c66eb681af8bf556274a11e54 | 84849e0008fbbdb3fef0ec74529b7956426cfc08abc8f0dc8a5b4d5d23d37a7c |
| .playwright-mcp/page-2026-07-10T01-09-15-035Z.yml | 7220 | fbe9417eb7debbff57bbd7511162d83b253d85d9 | ddb14fcc3c017c4e4a0709af3ac5b51a422c53939e6552195b9b31f1e7804ddf |
| .playwright-mcp/page-2026-07-10T02-22-13-736Z.yml | 8105 | 9df6752d6e4725659512879d4405a025a4ee5ea0 | 0924ed3f5d36b75cc96d21d888baac7595db3f1fa3c88cde2de4e6e9847f486b |
| .playwright-mcp/page-2026-07-10T02-22-23-985Z.yml | 19443 | 7ddc5f145a7af8c431cce76b66609a6f056f8566 | d6815f466e6a3c6e62b0d7169407948ae426191bab01074536ab5142c3887254 |
| .playwright-mcp/page-2026-07-10T05-13-22-974Z.yml | 8703 | 5f0df6aeaac3a87815912595792380004afe36e1 | 2ef38309c60a2b52fbd9b9ecd50382b6d2866fed5641f1278fe9aa2c64901de8 |
| CON | 101 | 640e619149fc016b346c891dbd775bca9825ecdc | 0e49f66a8ab4c84cf821d0a2b9aea5b34fea3460abe35521828a2739cda30e77 |

The reserved CON file could not be stashed through ordinary Windows Git. It is preserved at E:/Personal/dirigible2D/Temp/automation-scratch/captain-dev-prep-20261018/parked-CON.bin, with original backup reserved-CON.original.bin; 101 bytes, SHA256 0e49f66a8ab4c84cf821d0a2b9aea5b34fea3460abe35521828a2739cda30e77. Its content is only a Promptbook update advertisement. Exact bytes, base64 (durable recovery fallback):

~~~text
ICAbWzMzbeKGkRtbMG0gUHJvbXB0Ym9vayB1cGRhdGUgYXZhaWxhYmxlIOKAlCBydW46IBtbNG1iYXNoIDwoY3VybCAtc0wgcHJvbXB0Ym9vay5nZy9zZXR1cC5zaCkbWzBtCgo=
~~~

The local Git exclude E:/Personal/captain-sdlc/.git/info/exclude gained only /.captain-sdlc/worktrees/ while the original .captain-sdlc/.gitignore is parked. That maintains the prior ignored-checkout behavior; it does not blanket-ignore state or policy. Original SHA256 19b3a51ea0b451f83cf03d5b4850d1a38c153c499a1360ce95e07f688e4d6f0b4; resulting SHA256 7ff40f22278edeb30c8b087b707751702ffdeb792442628a0fdb79d400ad6150e. Original 319-byte content, base64:

~~~text
IyBnaXQgbHMtZmlsZXMgLS1vdGhlcnMgLS1leGNsdWRlLWZyb209LmdpdC9pbmZvL2V4Y2x1ZGUKIyBMaW5lcyB0aGF0IHN0YXJ0IHdpdGggJyMnIGFyZSBjb21tZW50cy4KIyBGb3IgYSBwcm9qZWN0IG1vc3RseSBpbiBDLCB0aGUgZm9sbG93aW5nIHdvdWxkIGJlIGEgZ29vZCBzZXQgb2YKIyBleGNsdWRlIHBhdHRlcm5zICh1bmNvbW1lbnQgdGhlbSBpZiB5b3Ugd2FudCB0byB1c2UgdGhlbSk6CiMgKi5bb2FdCiMgKn4KIyBDYXB0YWluIG1lcmdlIGxpZmVjeWNsZSByZWdyZXNzaW9uIHNjcmF0Y2ggb25seQovVGVtcC9hdXRvbWF0aW9uLXNjcmF0Y2gvbWwvCg==
~~~

Do not overwrite concurrent local excludes. Restore exact parked target files only through deliberate reconciliation; preserving the original ignore behavior is necessary while retained task worktrees remain under the primary checkout.

## Formatting provenance

Each original blob is recoverable at 98b714a; every normalized file preserves non-whitespace line content. All eight JSON values and existing BOMs were independently checked unchanged.

| Path | Original blob | Normalized SHA256 |
| --- | --- | --- |
| .captain-sdlc/closeouts/captain-begin-diagnosis-20261010.md | f5650c29d9df61c6fcc2cb8d913d038392a8a070 | b3dad6e386d8ae7b81955604cb05f69047e7adce94268c9a7d472d60a439dd17 |
| .captain-sdlc/closeouts/captain-failed-begin-retirement-20261010.md | 5c6eb1e8a3c2426e6fb33f523ed919c5b06d52b4 | 7ad7899df407a29a67e69e61ffb294c8078660eb5fe01518fd50bf071bd0c011 |
| .captain-sdlc/closeouts/merge-back-20261018.md | e69bdc93a91a577b6a0015a804cd19c0eafd84d5 | 31be1c8a61bc8c6018f1b185ed6eae712136b6f55a3eae7a335f06afe6b6d49d |
| Artifacts/CaptainSessionContinuity/crash-session-green-2.json | d8e04ea42c88023bd7c34903c89e353831245bbe | 4d2355e3d3af831db2f3371c15db8ab575557e9e24339154c091b058044bdfb3 |
| Artifacts/CaptainSessionContinuity/crash-session-green-3.json | cc6f6afe2441a9d2e1e09970c46f92f3b894684f | 95f2ab91d92f22f17a429752c957ddfe1592bd5f14f86bf7fc2ecb91f3c75aee |
| Artifacts/CaptainSessionContinuity/crash-session-green-4.json | 83b922b14236b5fd8bff096131c30d65afd15926 | fdf23e49afa40814bd405b715936b211ac1aabcdf52206b965cfd9c83f952add |
| Artifacts/CaptainSessionContinuity/crash-session-red.json | ebe474aefbfd7bd9c2ff1c4f86f0834ca4f96f32 | 507eed2322ca27bf37b7a79b31e38146c26d8c40d10e3fa3ac847ec0440ede62 |
| Artifacts/CaptainSessionContinuity/full-suite-after-fixture-fix.json | e08505201524cef9d5a17bf5a22f57df389b6d62 | 15d7cc2ec5100317e31bf8111f65a571c545c347852f4e4aa49d0109be0cd6b2 |
| Artifacts/CaptainSessionContinuity/full-suite-after-repairs.json | b67dd2c67b6668f845f893587a881e52d7644279 | e2cfdfd1787422afcf65ef9ab6658efdd18cd0afce2b05ffe0cf7c994643fbed |
| Artifacts/CaptainSessionContinuity/hooks-trust-before-install.json | ae86af5874060acb8db8ac08996f89a5a3d98dfc | 94084d0a05e6ac9f74881a3cb1d92f845cc11d6d80c8bb16a0a407510c17e955 |
| Artifacts/CaptainSessionContinuity/local-install.json | 27f2e5281961dcddf66f1fabf4660b992b282d3f | b9b1224738ed7ba6926b3c123207b124d2894840cf80755c0a95c7c9e3d66f32 |
| plugins/captain-sdlc/scripts/user-prompt.mjs | 8d314d5a5f3cecb308ca0128cbcb980e39281ee1 | 5d2d0aec362ba32f99cf616030e9c12b344a0fd15a87be2912422e970eeffbed |
| plugins/captain-sdlc/src/bookkeeping-finalization.ts | 42c8e5ec71124fa98a43905942036aed62a4d94a | 38b8b8da04bf380478be1c38fe3819ae69a58e5b281a1d003a75fdd506c9dbea |
| plugins/captain-sdlc/src/session-interruption.ts | f758c7c723ba9899808079170af923a49f7e6559 | 07bcd76cce87fcf491d3e5006d8c5ae33e0d2b948157f10a4d53c1e293846e22 |
| plugins/captain-sdlc/src/user-request-source.ts | 8cc62b9fcb6ef1b733fd6dd7e2f8d0e48965f13a | 39deed333de9360cc11d38ff6386a277d6bcc77be6f668bca95455537f3f3447 |
| plugins/captain-sdlc/tests/failed-begin-cancellation-sdk-fixture.test.ts | bf2c1cc9981863a94d0012d13734d46883b01915 | 73c1f89a12d96dd33851b52100e60ade1c2dd870d83b19f560fe81d1a5282fcb |
| plugins/captain-sdlc/tests/policy.test.ts | 9f06eeb1aeb502b2c8cb62646424f2fe2b90eab4 | 7144042e75455cd43c6ff9bd8001f9dd1e0aaae118896e3428c2c0801687bb77 |
| plugins/captain-sdlc/tests/proof-source-repair.test.ts | b40e0a2a79af3df102ed9964b7a8ed61ed4fbf3d | 7aec9353c5bfbf701141582d4907aedaef7ec8dcbfff04febebf74e83c2271a8 |
| plugins/captain-sdlc/tests/task-discovery-size.test.ts | 0844f4f5b2ddcd88c61c5794c6535bdb69eb643f | cc4fda12ec1890508d98630a37212d08b17bb0d1f3f307eb14373000a33fb79a |
| plugins/captain-sdlc/tests/task-resume-discovery.test.ts | 78b373bb169edb40c8e2043d26143e809ab10095 | 7737f9e6de5fa2e690180967beaef012eb697562a158ed3c5d28db253a367b50 |
| plugins/captain-sdlc/tests/task-session-transport.test.ts | 8e87e2a13fc2dc5181495d00929824da76436b48 | 5abebc338bca77e2a3b8f23e8a1f9ff992ac18b228f5050bce8887336ba9a1b2 |
| plugins/captain-sdlc/tests/user-request-hook.test.ts | d21acb3821de869d9c7bb41ab35f2bb581a5461f | e58fa93708831daa2a12380d0316d7a7319979c360643b4f5c7ce2c4474259f2 |
| plugins/captain-sdlc/tests/user-request-source.test.ts | 93aeced288f13595694238ff563f7897676238a7 | 6d9cc1f9d14657ccfa0ed408225523d2fb612b4ebc03e20d6d03d1991c78a1e1 |

## Next owner and action

Michael selects Merge Back to dev when ready. Captain should consume this same signed READY receipt and source/target bindings, including its bookkeeping-only association, without repeating unchanged proof. Preserve target stash, reserved file, other branches, authority and archive records. No remaining preparation blocker is known.

## Follow-ups for human review

Historical checkpoint/archive retention and the separate routing configuration remain outside this integration. No new requirement was promoted into this preparation's gates.
