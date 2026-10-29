# ADR-0023: Independent review supplies findings; Core owns gate authority

Updated: 2026-10-28
Version: 1
Status: proposed implementation decision under the authorized CIR task

## Context

M39's review package summarizes implementation evidence and obtains publication approval. It does not independently establish acceptance expectations or challenge author-written tests. A reviewer's confident prose is not an enforceable, auditable policy decision.

## Decision

Invoke acceptance analysis before exposing the solution, then separately invoke implementation analysis with recorded acceptance expectations and captured source/diff/evidence. Reviewer model/provider is independently configurable through existing routing. Separate contexts reduce contamination; they do not guarantee independence of judgment.

Captain Core owns versioned records, validation and deterministic pass/fail/needs_human_review/error calculation. Findings distinguish verified defects, hypotheses and advice. Validate source paths, ranges, quotes, evidence identity and provenance; require mechanical corroboration for verified defects. Empty findings do not establish completed review. Required evidence/provider/scanner failures fail closed.

Validate every observation before deduplication, then preserve the highest applicable risk deterministically. A lower-severity duplicate cannot conceal a higher-severity verified defect or an invalid observation. Include Core's `captain-premerge-policy/2` engine identity in applicability independently of the operator policy version; cached decisions made by older engine behavior require reevaluation even if the operator retains policy version `1`.

Core also owns the retained known-defect lifecycle. Providers and implementation workers cannot clear a verified defect by omission, suppression or changed line identity. Correction requires explicit current trusted resolution evidence matching the confirming producer/version/configuration and applicable scope, or a separately recorded permitted human exception. Preserve exact confirmation/resolution revisions and prior observations. Orchestrator coordinates collection and publication rather than replacing this deterministic rule.

The reviewer cannot modify, repair, approve or merge. Orchestrator coordinates adapters. Daemon schedules the same deterministic path. Human task selection, taste, requirement clarification, permitted scoped exceptions and final merge remain human authority. Exceptions bind finding, reason, identity, time and exact review inputs and never erase original failure history.

## Consequences

An LLM proposes analysis, not authoritative success. Adapters can change provider or scanner without moving policy into daemon or a new service. Ambiguity and evaluation failure remain distinguishable from a discovered defect. Shared code-reading remains Interrogate's planned capability rather than an excuse to mark M3/M11/M12 shipped.

See [CIR](../captain-independent-review.md).
