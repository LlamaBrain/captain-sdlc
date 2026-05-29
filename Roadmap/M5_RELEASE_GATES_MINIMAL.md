# M5 — RELEASE_GATES_MINIMAL
Status: Shipped
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

**Shipped 2026-05-29** — claude-release cut **v0.4.0 through this gate.** The
`/release` run fired Step 3.5 against `.captain-sdlc/release-gates.yaml` (smoke
disabled for this non-ATH repo, `dependency_audit` soft), the gate returned
proceed, and the release commit `09d77a2 chore(release): v0.4.0` (tag `v0.4.0`,
pushed to origin, `check:release` consistent at 0.4.0) landed — the first release
claude-release gated on its own upstream signals. The `release-gates.yaml` + the
Windows `npm audit` fix shipped in `1524d52`.

Follow-ons (not M5 scope; tracked separately):
- **Trace emission** (`release.gate.summary`/`override`) — claude-release's first
  emitter; the deliberate fast-follow, now unblocked by M2.
- **Live-CVE check** — exercise `dependency_audit`'s block against a real
  high/critical advisory (currently logic-verified).
- **`Gate-override` footer** — wired in `release.md`; not yet exercised live (the
  v0.4.0 cut needed no override).

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

