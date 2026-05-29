# M5 — RELEASE_GATES_MINIMAL
Status: In Progress
Last Updated: 2026-05-29

## Definition of Done
- [x] A release attempt with a failing configured ATH smoke against HEAD is refused (blocked, non-zero exit).
- [x] A release attempt with a blocking CVE reported by the dependency audit is refused.
- [x] With all gates passing, the release proceeds (human still confirms).
- [x] --force-release --override smoke_results_pass:"<reason>" cuts the release despite that gate failing; an empty reason is rejected; overriding a non-blocking gate is rejected.
- [x] The override is recorded in the release commit message.
- [x] The release emits an aggregate gate summary in the standard verdict shape.

### Verification (2026-05-29)
Implemented in `claude-release` @ `349d57d` (`feat(release): add release gates`) —
`src/gates/{verdict,smoke-results,dependency-audit,config}.js` + `src/evaluate-gates.js`,
wired into `plugin/commands/release.md` (Step 3.5 + a `Gate-override` commit footer),
bundled and self-contained (`check:release` green). 56 unit assertions, and the
**bundled** artifact run end-to-end against the real BeforeTheShade trace returns the
correct decision/exit on every path: proceed (0), blocked (1), override→proceed (0),
usage error (2).

Status is **In Progress, not Shipped** — the milestone closes when claude-release
actually *cuts a release* through this path. Open before Shipped:
- A live `/release` exercises the Step-3.5 orchestration and writes the `Gate-override`
  footer (verified as wired into the command, not yet run live).
- `dependency_audit`'s CVE-block is verified at the logic level (unit), not against a
  live high/critical advisory.
- Dogfooding claude-release's own release needs a `.captain-sdlc/release-gates.yaml`
  disabling `smoke_results_pass` for this non-ATH repo (no smokes emit there).
- Trace emission (`release.gate.summary`/`override`) — the deliberate fast-follow, now
  unblocked by M2.

## Theme
claude-release stops being a trust-based ceremony and becomes assertive: it refuses to publish a release when the lightest upstream signals (ATH smokes, dependency audit) are inconsistent with what is shipping. This is the pipeline's MVP / MIN PLAY — idea -> plan -> mechanical-verify -> gated-release proven end-to-end on the smallest payload. The human still presses release; the gate only stops accidental inconsistent ships, with explicit recorded overrides.

## Goals
- A failing ATH smoke against the target commit blocks the release.
- A blocking CVE from the dependency audit blocks the release.
- A release can still be cut via an explicit per-gate override carrying a required, recorded reason.
- Every gate produces the standard verdict shape and the release emits an aggregate gate summary.

## Targeted
### Gate verdict contract
- [x] Implement the per-gate verdict shape {schema_version, gate, verdict, severity, required, reason, inputs, evaluated_at} (seam-release-gates.md, Gate verdict).

### Gates (minimal cut)
- [x] smoke_results_pass: read ATH smoke results against the target commit via direct file read (seam-release-gates.md, Gate inputs #1 + Minimal first cut).
- [x] dependency_audit: thin inline CVE check, fail on any blocking CVE; M6 expands it to license/staleness later (seam-release-gates.md, Gate inputs #4).

### Aggregate + composition
- [x] Compose gate verdicts via the block/warn/log rules; no weighted scoring (seam-release-gates.md, Composition rules).

### Override
- [x] --force-release --override gate:"reason": per-gate, non-empty reason required, reject override of a non-blocking gate, record override in the release commit message (seam-release-gates.md, Override).

## Blockers & Dependencies
- **Upstream RC**: M2_TRACE_SCHEMA_FIRST_EMITTER - **Shipped 2026-05-29.** The minimal cut reads its `ath.smoke.completed` trace via direct file read (verified against BeforeTheShade). Gate trace emission (release.gate.summary/override) is the now-unblocked fast-follow.
- **Upstream RC**: M6_DEPENDENCY_AUDIT - soft: M5 ships a thin inline CVE check (`npm audit`, block on high/critical); M6 expands to license/staleness.

## References
- seam-release-gates.md
- Top-level index: `../roadmap.md`

