# Captain SDLC — Technical Debt
Updated: 2026-06-14
Version: 0.1.2
Created: 2026-05-29

Durable ledger of known structural debt — issues we've consciously deferred,
with enough context to act later. Not transient (that's `scratch.md`); not a
feature backlog (that's `candidates.md` / the roadmap); not an open design
question (that's `open-questions.md`). Debt here is "the current structure is
wrong-ish and we know it; here's the cost and the fix when we get to it."

Each entry: ID, status, the problem, why it's debt, fix options, blast radius,
and links. Mark `Resolved` (with the commit/ADR) rather than deleting, so the
history of why-we-changed-it survives.

---

## TD-001 — `captain-sdlc/` ships inside the ATH Unity package
**Status:** Resolved 2026-05-29 — extracted `captain-sdlc/` to its own repo (`LlamaBrain/captain-sdlc`) and removed it from the ATH package. · **Discovered:** 2026-05-29 (M2 emitter dogfood — first Unity import of the package after the nerve-center docs landed)

**Problem.** The `captain-sdlc/` nerve-center tree (ADRs, roadmap, seam docs,
`tools/captain-trace.mjs`) lives at the root of the ATH UPM package and is *not*
tilde-hidden, so Unity imports it like any asset folder. On first import into
BeforeTheShade, Unity stamped ~65 `.meta` files across the tree; per the repo's
meta-tracking policy (`.gitignore` line 41) those are now committed
(`0f7c98f`). Because it's regular package content, the whole tree also ships in
the published package tarball — any project installing
`com.llamabrainlabs.ai-test-harness` gets the entire Captain SDLC nerve center
(internal ADRs, roadmap, planning) under its `Packages/`.

**Why it's debt.** Nerve-center docs are internal planning material, not
consumer-facing package content. Shipping them leaks internal docs to
consumers, bloats the package, and produces recurring `.meta` churn (every new
nerve-center doc mints a tracked meta on the next import — e.g. this very file
will). It also entangles two things ADR-0001 and ADR-0003 deliberately keep
separate: the ATH *tool* vs the Captain SDLC *layer*. Tied to the still-open
question of whether `captain-sdlc/` should share the ATH package's version
surface / tag at all.

**Fix options (decide later):**
1. **Tilde-hide** — rename `captain-sdlc/` → `captain-sdlc~/`. Unity ignores
   `~`-suffixed folders (as with `Documentation~` / `Samples~`): no import, no
   metas. Cheapest; stops the meta churn. *Does not* stop the docs shipping in
   the tarball.
2. **Relocate out of the package** — move the nerve center to a sibling dir or a
   separate repo. Stops both the meta churn and the shipping; cleanest
   separation; most work.
3. **Exclude from the published artifact only** — keep it imported in-repo but
   drop it from the package payload. Stops shipping; *does not* stop meta churn.

Leaning 1 or 2; 1 is the quick win, 2 is the principled end-state.

**Blast radius of a rename/move:** `.claude-interrogate.json` docs-dir path;
intra-doc relative links across the set; `captain-sdlc/tools/captain-trace.mjs`
path + its README; `Documentation~/trace-events.md` and source-comment
references to `captain-sdlc/...`; the 76 committed `.meta` files (removed if
tilde-hidden/moved).

**Related:** ADR-0001 (tools-not-modules packaging), ADR-0003 (Captain SDLC
layer is not a tool), ADR-0013 (cross-tool layer ownership), and the open
question on `captain-sdlc/` sharing ATH's version/tag.

---

## TD-002 — Ruleset normalization is manual, not enforced on-touch
**Status:** Open · **Discovered:** 2026-06-14 (git-hygiene canon work)

**Problem.** Public repos carry the branch rulesets under inconsistent names
(`Protect Main`, `protect-main`, `Main`, …) and possibly drifted rules vs the
`tools/git-hygiene/` canon. The decided strategy is normalize-on-touch,
forward-first (ADR-0017, git-hygiene README), but there is no forcing function —
normalization relies on an agent remembering to audit the repo it works in.

**Why it's debt.** "Captain owns correctness" is the premise, yet ruleset drift
is caught only by human diligence; until automated, repos silently stay
non-conforming.

**Fix options (decide later):**
1. A SessionStart advisory hook that diffs the current repo's rulesets against the
   canon templates and nags + offers the apply (forward mechanism; pays a
   per-session `gh`/network cost).
2. A `tools/git-hygiene/audit` command, run on demand or in the release flow.
3. Fold the check into Seam 8's release-land step.

**Blast radius:** a new hook under `tools/hooks/` (fleet-wide) or a script under
`tools/git-hygiene/`; needs `gh` auth.

**Related:** ADR-0017, `tools/git-hygiene/`, Seam 8.

---

## TD-003 — Seam 8 release-merge coordinator is designed but unbuilt
**Status:** Open · **Discovered:** 2026-06-14

**Problem.** Seam 8 / ADR-0018 specify claude-release as the stack-agnostic
release-merge coordinator (gates → footered commit on `dev` → squash PR to
`main` → tag), but claude-release still stops at "single commit, no push."
Releases still land by hand, and the footer-aggregation edge (a squash collapses
the Seam-7 footers into one `main` commit) is unhandled.

**Why it's debt.** The design exists; the behavior does not, so the friction that
motivated the seam persists.

**Fix options:** implement the release-land step in claude-release per Seam 8 —
default stage + hand back + offer, opt-in execute with rights. Start with the
minimal first cut (squash + tag + footer aggregation, HITL).

**Blast radius:** the claude-release repo (separate); reads Seam 3 gates and
Seam 7 footers.

**Related:** Seam 8 (`seam-release-merge.md`), ADR-0018, Seam 3, Seam 7.

---

## TD-004 — `main`'s required approval is satisfied only by admin bypass
**Status:** Open · **Discovered:** 2026-06-14

**Problem.** The canonical `prot main` ruleset requires one approving review, but
a solo maintainer can't self-approve, so every merge to `main` uses
`gh pr merge --squash --admin` to bypass the gate.

**Why it's debt.** The approval gate isn't real — it's routinely bypassed, so it
adds friction and a standing admin-override habit while providing no review value.

**Fix options:** (1) wire CodeRabbit (or similar) as an automated reviewer so
approvals are genuine and `--admin` becomes the exception; (2) set
`required_approving_review_count: 0` and lean on status checks (drops the second
pair of eyes). Leaning 1.

**Blast radius:** per-repo ruleset config + a GitHub App install + `.coderabbit.yaml`.

**Related:** ADR-0017, ADR-0018, `tools/git-hygiene/prot-main.json`.

---

## Cross-References

- [Captain SDLC](./README.md)
- [Captain SDLC — Roadmap](./roadmap.md)
- [Captain SDLC — Open Questions Rollup](./open-questions.md)
- [Captain SDLC — Candidates](./candidates.md)
- [ADR Index](./ADR/index.md)
- [Captain SDLC — Seam 7: Task Identity & Commit Linking](./seam-task-identity.md)
- [Captain SDLC — Flay: Task Execution Harness](./flay-task-harness.md)

## Resolved Decisions

- No resolved decisions captured yet.

## Open Questions

- None.

## Version History

- 0.1.2 (2026-06-14): Added TD-002–004 — git-hygiene deferred work (on-touch ruleset normalization, Seam 8 implementation, approval-gate / CodeRabbit).
- 0.1.1 (2026-04-08): Metadata, linkage, or narrow doc maintenance update.
- 0.1.0 (2026-04-08): Metadata, linkage, or narrow doc maintenance update.
