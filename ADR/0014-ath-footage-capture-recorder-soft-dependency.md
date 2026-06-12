# ADR-0014: ATH footage capture — stills always-on, Unity Recorder an opt-in soft dependency

**Date:** 2026-06-07

## Problem

ATH's trace envelope reserves an `artifacts` array (`Documentation~/trace-events.md`,
`AthTraceWriter`) that nothing populates yet. The driving need is **HITL-validation
evidence**: for certain tests we want to snap watchable footage that *shows the
feature working*, attach it to the trace record, and let the human reviewer
validate the gate by glancing at the clip instead of re-running the test
themselves. That is overhead reduction, not safety theater — the footage is what
lets the validation step be a ten-second look rather than a manual reproduction.

Unity Recorder is the obvious video tool, and it happens to fit ATH's execution
model exactly: `RecorderController` is Editor-only, and ATH is already an
Editor-side harness driving PlayMode through MCP tools. So the usual blocker
(Recorder can't run in a standalone player) never applies. The tension is
elsewhere: adding `com.unity.recorder` as a hard dependency cuts against ATH's
deliberately thin dependency surface — we hand-rolled the JSON writer specifically
to avoid pulling in Newtonsoft. Forcing a video-capture package on every host,
including ones that only want a screenshot on death, is the wrong default.

## Solution

**Two tiers, with video as an opt-in that no default consumer pays for.**

- **Tier 1 — stills, always-on.** An Editor-side `ath-snap` MCP tool captures
  Game-view PNG keyframes via `ScreenCapture.CaptureScreenshot`, anchored to the
  trace dir (`.captain-sdlc/trace/media/`), **no new package dependency**.
  Trace-relative `media/<file>` paths flow into the trace `artifacts` array.
  Editor-side, not runtime — only the editor resolves the project root, and
  standalone-player capture is an explicit **non-goal** (see Amendment).

- **Tier 2 — Recorder video, opt-in.** An Editor-side `ath-record` tool wraps
  `RecorderController` to capture an mp4 of the bracketed window. The Recorder
  code lives in a **separate optional assembly** gated by
  `defineConstraints: ["ATH_RECORDER"]` (the `ATH_RECORDER` define is keyed on
  `com.unity.recorder`), so when the package is absent the assembly — and its
  reference to `Unity.Recorder.Editor` — is excluded from compilation entirely,
  and a base-assembly stub returns `recorder_unavailable`. `com.unity.recorder`
  is thus a **soft dependency** no default consumer pays for. Output also flows
  into `artifacts`.

Capture is **scoped per-test**, not always-on: a feature-demo SKILL brackets the
relevant steps with `ath.record` start/stop so the clip is short and focused on the
behavior under validation — which also sidesteps the "long boring video across
polling waits" failure mode. For HITL validation the bracketed Tier-2 clip is the
primary artifact (it shows motion); Tier-1 stills are the CI-safe floor and the
no-dependency fallback.

This keeps the dependency-light posture intact for the common case while making
full-motion replay a one-line manifest opt-in for hosts that want it. It also
inherits ATH's Editor/PlayMode reality rather than fighting it — no Runtime frame
hooks, no `IAthHostAdapter` changes; Recorder hooks the render pipeline itself.

## Consequences

- Default consumers inherit no new dependency; video is strictly opt-in.
- The Recorder path is Editor-only and will **not** run under `-nographics`
  headless CI (it needs a real graphics device). Video must not be marketed as a
  CI artifact; Tier-1 stills are the CI-safe surface, and even those need a
  graphics device to be meaningful.
- Windows mp4/H.264 via the built-in encoder is fine; Linux codec support is
  limited (image-sequence / VP8 territory).
- A retention/cleanup policy is needed for the media output dir
  (`.captain-sdlc/trace/media/`); real-time capture across polling waits produces
  large files.
- `Time.captureFramerate` can optionally be locked for deterministic, reproducible
  footage; left off by default.
- The entire Recorder branch is **pending live-verify** in a real Editor — mp4
  output, encoder availability, and mid-PlayMode `StartRecording()` cannot be
  verified headless in the current environment.

## Alternatives

- **Hard-depend on `com.unity.recorder` for all consumers.** Simplest wiring.
  Rejected: forces video-capture infrastructure on every host, including ones that
  only want a death screenshot, and breaks the dependency-light posture that
  motivated the hand-rolled JSON writer.
- **Stills only, no Recorder.** Zero new dependency, simplest. Deferred, not
  rejected: it loses the full-motion replay that is the actually-useful artifact
  for inspecting a death → ghost → restart loop. Tier 1 ships it as the default;
  Tier 2 layers video on top rather than replacing it.
- **Runtime frame-grab + custom encoder (ffmpeg shell-out or own mp4 writer).**
  Would work in standalone and dodge the package dep. Rejected: the encoder surface
  we'd maintain to avoid Recorder is larger than the dependency it replaces, and it
  reinvents exactly what Recorder already does well in the Editor.

## Amendment — 2026-06-07 (implementation)

The original Tier-1 wording said *"runtime-side, works in standalone builds."*
Corrected during implementation: Tier-1 capture is an **Editor MCP tool**
(`ath-snap`) anchored to the trace dir, because only the editor side resolves the
consuming project root (parent of `Application.dataPath`) — a runtime/standalone
screenshot can't be reliably written into `.captain-sdlc/trace/media/`.
**Standalone-player capture is an explicit non-goal.** Tier-2's soft dependency is
realized by a **separate `defineConstraints`-gated assembly**
(`LlamaBrainLabs.Ath.Editor.Recorder`), not a bare `#if` in the base editor
asmdef: `autoReferenced` does not cross asmdef boundaries, so a base-assembly
reference to `Unity.Recorder.Editor` would have made the dependency effectively
hard. The pure helpers (path safety, PNG-size, gitignore append) are verified by
unit tests; the in-Editor capture and Recorder API remain pending live-verify.

## References

- `Documentation~/trace-events.md` in the `ai-test-harness` repo — the `artifacts`
  field both tiers populate.
- `0013-tools-own-trace-record-correctness.md` — the emitter these artifacts attach to.
- `trace-schema.md` — cross-tool trace envelope (Seam 1).
