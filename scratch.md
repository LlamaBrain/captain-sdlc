# Scratch

Register of work in flight. Triage on each session: remove completed entries, defer non-active items to `Roadmap/` or `candidates.md`, keep and trim active ones. New session prepends a dated section above prior ones.

## 2026-05-29 — triage + in-repo cleanup

### Done this session (drops out next triage)
- ✓ **TD-001 resolved** — `captain-sdlc/` extracted to its own repo (`LlamaBrain/captain-sdlc`); no longer ships inside the ATH Unity package. `tech-debt.md` created.
- ✓ **M2 SHIPPED** — TRACE_SCHEMA_FIRST_EMITTER, the first real Captain SDLC milestone. All 9 DoD met: `ath-trace-emit` MCP tool, `AthTraceWriter`/`AthTraceEmitter` split, lazy `.captain-sdlc/.gitignore`, `ath-smoke-fullloop` Step 8 wiring (source in `ai-test-harness`); ADR-0013 filed; **live-verified against BeforeTheShade** — smoke-driven pass `b08cc7b4` + synthetic fail `9c29ccc4` in `2026-05-29.jsonl`, both validate against the envelope (`tool_version` `0.2.0`; fail record carries non-null `failed_step` + non-empty `artifacts`). Stub + roadmap table flipped to Shipped.
- ✓ **ADRs 0010–0013 filed** (MToolKit runtime blade; test-support home-then-promote; human-owns-taste; tools-own-trace-correctness).
- ✓ **Promoted M5 + M11 taskout drafts** over their stubs; removed the `.draft.md` siblings.

### Active — Captain SDLC critical path (M5 next)
- **M5 — RELEASE_GATES_MINIMAL** (the MIN PLAY waypoint) — now the front of the critical path; **M2 shipped, so M5's hard upstream is cleared.** Taskout complete (DoD + per-gate targeted scoped). Implementation lives in the **claude-release** repo. Gates: `smoke_results_pass` (reads the `ath.smoke.completed` trace M2 now emits, via direct file read) + `dependency_audit`, plus `--force-release --override gate:"reason"` with a required recorded reason. Gate-event emission (`release.gate.summary`/`override`) rides M2 when wired.
- **M2 shipping also cleared the DAG prereq for** M7 BASELINE_REGRESSION_ENVELOPE, M9 DETERMINISTIC_REPLAY, M13 CONTRACT_TESTING_MECHANISM_A, M16 BETWEEN_RELEASE_ARTIFACT_DIFF, M19 MARKETING_SCREENSHOT_HARVESTING — all listed M2 as upstream.

### Active — claude-release (separate repo)
- **v0.4.0 — version-surface drift check.** Diff every JSON/YAML/text file for version-shaped strings; fail on disagreement. Would have caught the `marketplace.json` v0.3.1 oversight. Design brief: memory `project_publish_discipline_pattern.md`. ~30 min once the discipline is committed in code.
- **Hardcoded version path in `commands/release.md`** — literal `cache/.../0.2.0/lib/build-manifest.js`; make relative / env-resolved so command markdown survives version bumps.

### Active — claude-interrogate (separate repo)
- **M27 → MRC1 rename** — re-run `/claude-interrogate:roadmap` in maintenance mode with `kind: "release-candidate"` on `M27_DEFINITION_OF_DONE_END_TO_END`; writes a `.draft.md`, review + replace. Needs `/plugin update claude-interrogate` → v0.1.7 first. ~5 min.
- **Verify the `scratch.md` + scratch SKILL files** shipped in interrogate v0.1.7 via `git add -A` were intentional; if experimental, that's a v0.1.8 fix (the v0.1.7 tag is immutable).
- **Migration tool for old roadmaps** (`/migrate-roadmap`) — SemVer-shaped IDs (`0_8_0_QUESTS`) / M-only prefixes won't round-trip against v0.1.6+'s milestone format or v0.1.7+'s MRC notation. No external users → non-urgent.
- **Preset system** — `roadmap.preset: "indie-game"` opt-in restoring Wishlist/EA/Launch waypoints + game-dev reserved slots. Flagged in ADR-0007. Optional.

### Maintenance / cleanup
- **`doc:` → `docs:`** for future commits — two ATH commits in the v0.1.0 range used non-canonical `doc:`. Canonical Conventional Commits type going forward is `docs:` (plural).

### Open question raised this session
- **Status vocabulary gap.** RC files use only `Shipped / In Progress / Stub`. A milestone that's been taskout'd but not started (M5 and M11 now) has no distinct status — it sits at `Stub` despite carrying a full DoD. Consider a `Scoped` / `Planned` value? Design call, not mechanical cleanup — left for you to decide.
