# Captain continuation repair — 2026-10-09

Status: repair implemented, locally verified, and installed as Captain 0.2.1.
Source commit result and exact revision are recorded in
`plugins/captain-sdlc/.captain-proof/churn-continuation/source-commit.json`
after the ordinary commit succeeds. Signed Captain implementation completion and
CI remain incomplete. Owner: Cap. The installed tools work in this conversation;
a new thread is not required.

The earlier blocked status was superseded when Michael directed Cap to get back
to work after the concrete commit proposal. Cap treats that contextual direction
as approval to finish the prepared source repair. The missing tool-inventory
entry was resolved by connecting an MCP SDK client to the installed 0.2.1 public
server and the existing authority store. The agent owns this fallback; no human
restart or technical identifier is required. No hook control was disabled.

Michael authorized repairing the Churn incidents where repeated approval requests,
lost target context, and inaccessible recovery steps forced him to drive the workflow.
This is a new bounded follow-up; the completed UI pointer merge and its evidence remain immutable.

## Scope and identity

- C1: Carry existing task/target authorization through continuation. A Prep-only request stops at readiness; matching Back authority continues through Back without another approval request.
- C2: Recover stopped merge-operation owners through public, exact-generation tools without asking Michael to discover technical identifiers. Preserve live/foreign owners, Git identities, refs, signed merge ledger and retained proof.
- C3: Build, check and install the repaired local plugin; verify the installed version and public recovery transport.
- Branch: `fix/captain-churn-continuation-20261009`.
- Base HEAD: `6f7bb4f0bde72152d687eeae21e225b299257e2f` (Captain 0.2.0).
- Worktree: `E:/Personal/dirigible2D/.captain-sdlc/worktrees/captain-churn-continuation-20261009`.
- Source repository: `E:/Personal/captain-sdlc`; existing recovery checkout retained unchanged.
- Dependencies copied as a whole from the 0.2.0 recovery checkout's `plugins/captain-sdlc/node_modules`; package-lock dependency versions retained.

## Gates and Captain status

The committed Captain source policy selects `feature`: package build, ticket tests,
MCP initialization smoke, and TypeScript check. These commands remain unchanged.
Focused recovery and hook-policy red/green tests plus public merge MCP smoke provide C1/C2 proof.
There is no Unity or visual gate for these plugin changes.

The registered 0.1.5 Captain rejected begin for intent
`intent-ad4b1c36-7826-4ff1-a84a-ce2a51ce13fe` with
`trusted red gate pattern is an unsafe regular expression` before creating a run.
Its status reports no run record. No signed implementation green/completion is claimed.
An isolated repair checkout was created after that diagnosis; controls remain enabled.
The source policy's invalid alternation is replaced with a supported failing-test count pattern.
The self-host fixture now begins and records an expected failing ticket successfully.
The source policy repair remains uncommitted, so the real repository's committed bootstrap policy is not yet repaired.

## Delivered scope

- C1: the five merge/enforcement skills retain conversational authorization and recorded target/source identity. Already-authorized Back continues after readiness or recovery; Prep-only requests still stop at readiness. They prohibit asking Michael to repeat existing instructions or supply internal tokens. README resume instructions now use ordinary human wording and agent-resolved signed handoffs.
- C2: public merge status returns authenticated `operation_lease` owner metadata and exact recovery arguments. Stopped local owners need no confirmation; legacy owners require independent verification. Live, foreign and unknown owners remain protected. Recovery checks actual Git/worktree bindings before release and preserves refs, signed merge ledger and proof. Rejected continuations name the supported status call; the hook now admits the exact recovery entrypoint.
- C2: the self-host policy's red pattern is compatible with the existing regex validator and still requires an expected failing test count. No validator weakening or gate changes.
- C3: plugin, package, lock and MCP handshake agree at 0.2.1. Codex's supported marketplace/remove/add registration sequence and plugin installer were used. Captain is registered and enabled at `C:/Users/metag/.codex/plugins/cache/personal/captain-sdlc/0.2.1`. Twelve installed runtime/skill files match the verified source hashes.

## Verification and evidence

All paths below are relative to this worktree. The artifact records the base revision plus uncommitted task overlay; no new commit or signed Captain green is represented.

| Check | Result | Evidence |
|---|---|---|
| Focused recovery TDD | Nine new public-status tests failed before implementation; 11 selected recovery tests then passed. Added resource-preservation and already-integrated-target cases passed. | Tests in `plugins/captain-sdlc/tests/merge-workflow.test.ts`; complete package run below includes them. |
| Hook-policy TDD | New entrypoint test failed before implementation; policy suite passed 12/12 afterward. | `plugins/captain-sdlc/tests/policy.test.ts`; complete package run below. |
| Self-host bootstrap regression | Failed on the exact unsafe-regex rejection, then passed through real fixture begin and red recording. | `plugins/captain-sdlc/tests/self-host-policy.test.ts`; complete package run below. |
| Package suite | 235/235 passed; exit 0; no skipped tests. | [package-tests.log](../plugins/captain-sdlc/.captain-proof/churn-continuation/package-tests.log), [unit-inputs.json](../plugins/captain-sdlc/.captain-proof/churn-continuation/unit-inputs.json). |
| Final package build | Passed; exit 0; bundled server and Windows hook executable produced. | [build-final.log](../plugins/captain-sdlc/.captain-proof/churn-continuation/build-final.log). |
| Final TypeScript check | Passed; exit 0. No separate lint command is defined by the package. | [typecheck-final.log](../plugins/captain-sdlc/.captain-proof/churn-continuation/typecheck-final.log). |
| MCP initialization | Passed; exit 0. | [initialize-smoke.log](../plugins/captain-sdlc/.captain-proof/churn-continuation/initialize-smoke.log). |
| Source public transport smoke | Passed; exit 0; exact 0.2.1 handshake, status-to-recovery discovery, same-operation continuation, target preservation in Prep, Back without repeated gates, and receipt path containing spaces/ampersand. | [source transport result](../plugins/captain-sdlc/.captain-proof/churn-continuation/source-transport/merge-mcp-smoke.json). |
| Installed public transport smoke | Passed; exit 0; the same public recovery/merge sequence against the installed 0.2.1 bundle. | [installed transport result](../plugins/captain-sdlc/.captain-proof/churn-continuation/installed-transport/merge-mcp-smoke.json). |
| Registered artifact | Version 0.2.1 installed and enabled; consumed runtime/skill hashes match source. | [registration](../plugins/captain-sdlc/.captain-proof/churn-continuation/registered-plugin.json), [artifact manifest](../plugins/captain-sdlc/.captain-proof/churn-continuation/installed-artifact-manifest.json). |
| Current-thread installed access | Passed; installed server advertises 0.2.1 and recovery schema; public authorization query uses the real existing authority store. No thread restart required. | [live installed session](../plugins/captain-sdlc/.captain-proof/churn-continuation/live-installed-session.json). |
| Independent review | C1/C2 PASS; handshake mismatch found and repaired; re-review PASS. | Reviewer `/root/audit_continuation` verified unchanged behavior/test hashes, including reconstructing the sole later server-version metadata edit. |

The package suite ran before the sole final MCP version-string synchronization.
Its retained input hashes match current behavior/tests; substituting only `0.2.0`
for the final server `0.2.1` metadata exactly reproduces its earlier server hash.
The final build and both public transport smokes bind the actual 0.2.1 bundle.
There are no captured screenshots or Unity/player/performance claims for this task.

## Known failures, incomplete gates and next actions

- The original Captain begin rejection and absent run record remain recorded above. The ordinary source commit includes the bootstrap policy repair; its result is recorded separately from signed implementation proof. No signed implementation green, CI, source integration, push or publication is claimed.
- One focused fixture initialization failed before exercising target-head recovery with a symbolic-branch binding error. Its persisted bindings were correct and a subsequent direct binding check succeeded; the transient cause is unproven. The fresh isolated target-head test and complete 235-test run passed. This is retained as an observed setup failure, not diagnosed as a product defect.
- The first source transport run failed during its second fixture merge with Windows Git `'$GIT_DIR' too big`. Evidence: [failed log](../plugins/captain-sdlc/.captain-proof/churn-continuation/source-transport.log). Failed fixture retained under `plugins/captain-sdlc/Temp/automation-scratch/churn-continuation/source-transport/`. Changing the fixture root to the shorter `E:/Personal/dirigible2D/Temp/automation-scratch/churn-cont/` resolved this diagnosed path-length failure; source and installed smokes both passed there. No product checks were weakened.
- The host's available tool names still omit recovery, but the verified installed public MCP transport supplies it in the same conversation and authority store. The enforcement skill documents this agent-owned fallback. A thread restart is optional; genuine hook trust prompts remain a Codex human action.
- The `personal` marketplace now points at this retained task checkout. The original `E:/Personal/captain-sdlc-marketplace` directory and 0.1.5 cache remain intact for rollback. Keep this checkout until its source registration is deliberately relocated after authorized integration.

## Follow-ups for human review

- Target-filtered authorization lookup currently excludes generic revocations. Evidence: `plugins/captain-sdlc/src/user-authorization.ts` target filtering. Impact: a generic later stop can disappear from a named-target receipt query. Proposed next action: separately authorize a focused authorization-resolution repair. Skills continue to honor the actual conversation and later revocations; this discovery is not added as a gate here.

## Prepared source commit

Michael directed Cap to get back to work after this concrete proposal. Cap is
finishing the reviewed ordinary source commit under that contextual instruction.
The exact resulting hash, subject, branch and committed paths are recorded in
`source-commit.json`; that evidence does not represent signed Captain validation.

Proposed message:

```text
fix(workflow): preserve authorized merge continuation (v0.2.1)

Expose authenticated stopped-owner recovery through public status and retain
existing task and target authority through Prep, recovery and Back.
Repair the self-host red-test pattern and synchronize the installed bundle.

Implements: captain-churn-continuation
```

Independent commit proposal audit: `/root/audit_continuation` verified the exact
24-path set and synchronized versions. Its trailer finding was repaired by using
Captain's recognized `Implements:` form. This is not signed Captain validation.

Version decision: patch from 0.2.0 to 0.2.1; package, lock, plugin manifest,
MCP handshake and changelog agree. No tag is proposed. `git diff --check` passes.
The index is empty. The proposed task-owned paths are:

```text
.captain-sdlc/codex-policy.json
.gitignore
Churn/2026-10-09-autonomous-continuation-closeout.md
plugins/captain-sdlc/.codex-plugin/plugin.json
plugins/captain-sdlc/CHANGELOG.md
plugins/captain-sdlc/README.md
plugins/captain-sdlc/dist/merge-workflow.d.ts
plugins/captain-sdlc/dist/merge-workflow.js
plugins/captain-sdlc/dist/policy.js
plugins/captain-sdlc/dist/server.js
plugins/captain-sdlc/package-lock.json
plugins/captain-sdlc/package.json
plugins/captain-sdlc/scripts/merge-mcp-smoke.mjs
plugins/captain-sdlc/skills/captain-sdlc-enforce/SKILL.md
plugins/captain-sdlc/skills/merge-back/SKILL.md
plugins/captain-sdlc/skills/merge-begin/SKILL.md
plugins/captain-sdlc/skills/merge-finish/SKILL.md
plugins/captain-sdlc/skills/merge-prep/SKILL.md
plugins/captain-sdlc/src/merge-workflow.ts
plugins/captain-sdlc/src/policy.ts
plugins/captain-sdlc/src/server.ts
plugins/captain-sdlc/tests/merge-workflow.test.ts
plugins/captain-sdlc/tests/policy.test.ts
plugins/captain-sdlc/tests/self-host-policy.test.ts
```

Other rebuilt tracked outputs differ only in Git's working-tree line-ending
representation and have no content diff; exclude those from staging.
Main-game notebook changes and ignored generated evidence are excluded.
After commit direction, recheck the exact checkout, index and paths, attempt
the ordinary commit with controls enabled, and preserve any concrete rejection.
Signed Captain startup still has the retained original failure and absent run;
an ordinary Git commit must not be reported as signed implementation green.
