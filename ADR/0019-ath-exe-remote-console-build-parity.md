# ADR-0019: ATH EXE remote-console harness — build-parity testing over a loopback socket

**Date:** 2026-06-16

## Problem

The editor-side ATH harness drives Unity **in the editor**, in-process through MCP.
The editor never strips managed code, runs Obfuz, compiles runtime mods against the
player runtime, or produces a player — so a whole bug class is structurally invisible
to it: managed stripping removing reflection-rooted members, Obfuz linker NREs,
default-interface-method mod-compile errors, `#if UNITY_EDITOR` `AssetDatabase`
fallbacks leaving fields null in the build, addressable trimming. Every one is green
in the editor.

Dirigible's ADR-0031 documented this from a dev-build session where all of them
surfaced at once, and showed that OS-level screen/keystroke automation of the `.exe`
is too flaky for CI (input-focus loss, coordinate misses, multi-monitor window
placement). ATH needed a reliable, programmatic way to drive the shipping artifact —
and critically one that works for a **non-dev RC build**, not just a
`DEVELOPMENT_BUILD`, because managed stripping / Obfuz / IL2CPP codegen are exactly
what differ in the release configuration.

## Solution

A loopback **remote-console harness** that reuses ATH's existing `IngameDebugConsole`
command vocabulary + `CMD:`/`OK:`/`ERR:` sentinels against the built player, **off by
default behind two locks**:

- **Compile-time — the `ATH_REMOTE` scripting define.** Master enable, independent of
  Development Build, so a real RC (release stripping/Obfuz, dev-build off) can carry
  the harness. The package gate becomes `#if UNITY_EDITOR || DEVELOPMENT_BUILD ||
  ATH_REMOTE`. A true release omits the define → near-zero footprint.
- **Runtime — the `-ath-remote-console` launch flag.** Even a harness-bearing build
  stays silent (no thread, no bound port) until launched for a session.

**In-player** (gated, ships only when compiled in): a `TcpListener` bound to
`127.0.0.1` pumps command strings through the same `DebugLogConsole.ExecuteCommand`
the editor uses, **FIFO on the Unity main thread** (the listener owns its own `Update`
pump — there is no `MainThread.Instance` in a player), returning **one
newline-delimited JSON response per connection** `{correlationId, status, failReason,
lines, elapsedMs, truncated}`; the server mints its own correlation id (it does not
trust client-supplied ids). `harness.state` (backed by the shared `AthStateDispatcher`,
**relocated Editor→Runtime** so one resolver serves both the editor tool and the
in-player command) and `harness.snap` (in-player `ScreenCapture` PNG) are new console
commands; everything else is the existing vocabulary.

**Out-of-process**: an internal, developer-only **Node CLI** (`Tools~/ath-exe-client`,
`ath-exe`) — not shipped — with a pure, unit-tested wire-protocol/predicate core and a
thin socket/process shell (`cmd`/`state`/`wait`/`snap`/`launch`/`attach`). The same
remote-console driver doubles as the "Claude-plays-the-game" showcase loop.

**Stripping preservation**: the harness's `[ConsoleMethod]` entry points are invoked
only via reflection, so IL2CPP managed stripping removes them even with `ATH_REMOTE`
defined. A `link.xml` **ships inside the package** preserving the two reflection-entry
assemblies (`LlamaBrainLabs.Ath.Commands`, `…RemoteConsole.Runtime`; the `…Runtime`
assembly is preserved transitively) — always present, a no-op when the harness is
`#if`'d out.

## Consequences

- **Observer-probe cost.** An `ATH_REMOTE` build is not byte-identical to the ship
  artifact (the define + `link.xml` root a little extra). It still reproduces the bug
  class as long as the release-defining settings match: managed-stripping level,
  IL2CPP/Mono backend, Obfuz settings, addressables profile, build target, and the
  (non-)development-build flag.
- **Host requirement.** A host's `IAthHostAdapter` + bootstrap gated `#if UNITY_EDITOR
  || DEVELOPMENT_BUILD` must also add `|| ATH_REMOTE` for a non-dev build, or
  `harness.state` reports `adapter_present=false`. The package gate-sweep can't reach
  host code — this is the host's responsibility.
- **Same-machine assumption.** `harness.snap` paths are local-filesystem paths from
  the player process, so the exe and the Node client must share a filesystem. Video
  for the build showcase is out of scope (Unity Recorder is editor-only per ADR-0014;
  build-side video would need an external OBS-MCP) — deferred.
- **The harness validated itself against the exact bug class it exists to catch:** the
  first RC build stripped the harness until the package `link.xml` was added.
- **Verification.** Live-verified against a non-dev IL2CPP **release** build of
  BeforeTheShade (`harness.ping`, `state game_ready`/`scene_name`, `wait player_died`,
  `snap` all green over the socket). The pure protocol core has 26 `node --test`; the
  Unity-coupled in-player code is otherwise live-verify-only (it can't compile headless).

## Alternatives

- **OS-level screen + keystroke automation of the `.exe`.** Rejected — dirigible
  ADR-0031 demonstrated it is too flaky for CI (focus loss, coordinate misses,
  multi-monitor placement); not deterministic.
- **Gate solely on `DEVELOPMENT_BUILD`** (as ADR-0031 first sketched). Insufficient:
  an RC isn't a dev build, and stripping/Obfuz/IL2CPP codegen are precisely what
  differ in the release config. The dedicated `ATH_REMOTE` define lets a
  release-configured build carry the harness.
- **Stay editor-only.** Insufficient by construction — the editor cannot reproduce the
  stripping/Obfuz/editor-fallback class.
- **A full separate end-to-end UI-automation framework.** Over-built; reusing the
  in-game console surface + sentinel assertions gives the same coverage with far less
  new surface.
- **Per-host `link.xml` written by the editor toggle into the host's `Assets/`.**
  Rejected in favor of shipping one in the package: zero per-host setup, no invasive
  writes to host `Assets/`, and a no-op when the harness is compiled out.
- **A standalone MCP-protocol server for the client.** Deferred as premature for a
  pre-release on-call tier; a thin internal Node CLI driven by Claude Code suffices.

## References

- dirigible `ADR-0031` (`0031-exe-mcp-micro-harness-aith-extension.md`) — the
  originating problem statement this formalizes.
- `Documentation~/exe-harness.md` in the `ai-test-harness` repo — operator guide.
- `0014-ath-footage-capture-recorder-soft-dependency.md` — the Recorder/OBS video path
  this defers to.
- `0017-git-branching-model-squash-to-main.md` — how this shipped (`ai-test-harness`
  PR #1, squash-merged to `main` as `0.3.0`).
