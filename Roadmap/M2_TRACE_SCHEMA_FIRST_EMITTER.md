# M2 — TRACE_SCHEMA_FIRST_EMITTER
Status: Shipped
Last Updated: 2026-05-29

## Theme
The smallest viable instance of the whole Captain SDLC pipeline shape: one real
tool emitting one real event into the shared cross-tool trace. ATH writes
`ath.smoke.completed` to `.captain-sdlc/trace/`, matching the envelope in
`trace-schema.md`. Proving the format end-to-end with a live emitter is what
turns the schema from a planning doc into a substrate the downstream seams
(M5 release gates, M7 regression envelope) can read.

## Goals
- Prove the trace **envelope** (`trace-schema.md`) by emitting a real event from
  a real tool, not a fixture.
- Set the **emitter precedent**: a tool owns the correctness of its records
  (mints `event_id`, stamps the timestamp, pins `schema_version`/`tool`/
  `tool_version`); callers pass only verdict + context. Honors ADR-0012.
- Lay the **storage substrate** (`<project>/.captain-sdlc/trace/YYYY-MM-DD.jsonl`)
  that later consumers read, with the local-state `.gitignore` guaranteed by the
  tool.

## Definition of Done
- [x] `ath.smoke.completed` payload schema documented in ATH's own docs
  (`Documentation~/trace-events.md` in the `ai-test-harness` repo), linking back to the canonical envelope.
- [x] Editor MCP tool `ath-trace-emit` appends a `schema_version: 1` envelope to
  the day's JSONL file, append-only, LF-terminated, UTF-8 no-BOM.
- [x] The tool mints a UUIDv4 `event_id`, stamps an ISO-8601 UTC `timestamp`,
  and pins `tool: "ath"` + `tool_version` = `AthRuntimeFlag.PackageVersion`.
- [x] Trace directory resolves to the **consuming project root** (parent of
  `Application.dataPath`), not the ATH package directory.
- [x] Emitter lazily creates `.captain-sdlc/.gitignore` excluding `trace/` and
  `side-store/` (per `captain-sdlc-conventions.md`).
- [x] Serialization (`AthTraceWriter`) and IO (`AthTraceEmitter`) are split into
  pure, dependency-free units that can be unit-tested without an MCP attachment
  (mirrors the `AthStateDispatcher` split). No Newtonsoft dependency.
- [x] `ath-smoke-fullloop` SKILL calls the emitter as its final step, on **both**
  pass and fail, before PlayMode exit.
- [x] **Live-verified in a Unity editor:** running the smoke against a host
  project (BeforeTheShade) writes a well-formed line to the day's file for both
  a pass and a forced fail; the JSON parses and validates against the envelope.
  *(Verified 2026-05-29 against BeforeTheShade @ `303588f` — smoke-driven pass
  `b08cc7b4` + synthetic fail `9c29ccc4` in `.captain-sdlc/trace/2026-05-29.jsonl`;
  both validate against the envelope; `tool_version` pinned `0.2.0`; the fail
  record carries non-null `failed_step` and a non-empty `artifacts` array.)*
- [x] Unity-generated `.meta` files for the three new `.cs` files and the new doc
  committed alongside source. *(Verified tracked in `ai-test-harness`:
  `AthTraceWriter.cs` / `AthTraceEmitter.cs` / `Tool_AthTraceEmit.cs` + `.meta`
  siblings; `trace-events.md` sits under `Documentation~/` so correctly has no
  meta.)*

## Targeted
**In scope (this milestone):** the `ath.smoke.completed` envelope + payload, a
single emitter (ATH), the trace storage location, and the protective
`.gitignore`. This is the schema's own "minimal first cut."

**Deferred (named, not silently dropped):**
- Perf **envelope summary** in the payload → M7 (baseline regression envelope).
- `parents` / `links` → needs an upstream emitter (`code.commit.created` from
  claude-release) to link to.
- Additional event kinds (`ath.regression.detected`, `ath.replay.*`, …).
- A **trace consumer / walk-back CLI** — a prototype now exists and is verified:
  `tools/captain-trace.mjs` (`walk` / `by-commit` / `ls`),
  satisfying the schema's "one emitter + one consumer" minimal first cut. It is
  *not* part of the ATH package (it's nerve-center cross-tool tooling). Formal
  milestone placement for the cross-tool layer is pending (trace-schema open
  questions #1 and #3).
- Cross-machine trace merging → revisit when CICD (M21) lands.

## Blockers & Dependencies
- **M1_CONVENTIONS_ESTABLISHED** — the `.captain-sdlc/` layout and
  `schema_version` policy. Satisfied.
- **Live verification** depended on a Unity editor with a registered host adapter
  (BTS or dirigible). Resolved 2026-05-29 — verified against BeforeTheShade.
- **Emitter-placement decision** — "tools own trace-record correctness via an
  editor MCP tool" sets precedent for every future tool's emitter. Filed as
  ADR-0013 before a second tool emits.

## References
- `../trace-schema.md` — canonical event envelope (Seam 1).
- `../captain-sdlc-conventions.md` — `.captain-sdlc/` layout, `schema_version`,
  git policy.
- ATH-owned payload schema + emitter source live in the `ai-test-harness` repo:
  `Documentation~/trace-events.md` (payload), `Editor/McpSkills/AthTraceWriter.cs`
  (serializer), `AthTraceEmitter.cs` (IO), `Tool_AthTraceEmit.cs` (the
  `ath-trace-emit` MCP tool), and `Skills/ath-smoke-fullloop/SKILL.md` Step 8.
- Top-level index: `../roadmap.md`
