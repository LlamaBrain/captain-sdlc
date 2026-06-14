# Captain SDLC — git-hygiene canon

The canonical GitHub branch rulesets every Captain repo should carry (ADR-0017).
`prot-main.json` and `prot-dev.json` are the literal ruleset bodies — data the
tooling applies, not prose to re-type. `~DEFAULT_BRANCH` keeps `prot main`
portable across repos no matter what the default branch is called.

| Ruleset | Target | Rules |
|---|---|---|
| **prot main** | default branch | no deletion, no force-push, linear history, PR required with squash-only merge + 1 approval; **admins bypass** (`RepositoryRole` 5, the HITL escape hatch). |
| **prot dev** | `refs/heads/dev` | no deletion, no force-push — keeps the long-lived integration branch from being destroyed by a merge. |

## Audit (the nag — read-only, safe to run anytime)

```
gh api repos/<owner>/<repo>/rulesets --jq '[.[].name] | sort | join(", ")'
```

A repo missing `prot main` / `prot dev` is drift. Captain detects and nags;
it does not silently fix.

## Apply (HITL — never mass-applied without a human)

```
gh api repos/<owner>/<repo>/rulesets -X POST --input prot-main.json
gh api repos/<owner>/<repo>/rulesets -X POST --input prot-dev.json
```

Repos without these server-side rules (private, free, or not-yet-set-up) still
get the same hygiene locally from the `protect-branch.js` hook (`../hooks`),
which denies commits straight to a protected branch. Server rules are the
stronger tier; the hook is the portable one.

## Normalization: lazy, on-touch, forward-first

Existing repos carry these rulesets under inconsistent names (`Protect Main`,
`protect-main`, `Main`, …) and possibly drifted rules. They are **not** fixed by
a one-time retroactive sweep. Instead, **normalize on touch**: when Captain next
works in a repo, it audits that repo against this canon and normalizes the drift
(HITL) as part of the engagement — replacing a non-conforming ruleset with
`prot main` / `prot dev` from the templates above. **Forward first:** new and
actively-worked repos converge on the canon; dormant ones wait until touched.

A big-bang sweep was rejected — it's an outward, destructive multi-repo change
with no forcing function, whereas on-touch normalization is incremental and
always keeps a human in the loop for the repo actually being worked.
