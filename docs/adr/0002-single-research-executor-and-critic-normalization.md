# ADR 0002 — Deterministic research executor and tolerant critic parsing

Date: 2026-09-26
Status: Accepted

## Context

A production run exported `UNCLEAR · 0%` with the caveat `critique: verdict must be one of SUPPORTED, CONTRADICTED, MIXED, UNCLEAR`.
The critic model returned a well-formed review whose `verdict` used wording outside the enum. Strict validation failed on both
attempts, the run engine treated that as `unrecoverable_failure`, and the collected evidence was dropped from the report.

Separately, each research pass spent an LLM call whose only job was to restate the query the planner had already produced.

## Decision

1. Normalize critic output before validation. `normalizeCriticDraft` maps enum drift (`INSUFFICIENT_EVIDENCE`, `PARTIALLY_TRUE`,
   `TRUE`/`FALSE`), percentage confidences, nested `review` wrappers, string-shaped lists, and swapped decision/verdict fields
   onto the contract. Unusable recommended tasks are dropped instead of failing the whole review.
2. Report the received value in enum validation errors so the single repair attempt can act on them.
3. Recover instead of collapsing. A failed critic now yields a conservative `UNCLEAR` review that preserves the collected
   evidence and emits a `critic_recovered` trace event.
4. Reduce four model-backed agents to three. The planner now emits the search query and source policy per task, and the
   researcher is a deterministic executor. This removes one LLM round trip (~600 tokens) per research pass and one failure mode.

## Consequences

- Enum drift no longer costs a whole run; verdicts degrade to `UNCLEAR` with evidence intact only when review genuinely fails.
- Runs are faster and cheaper: a two-pass run uses six tool calls instead of eight.
- `RESEARCHER_*` environment routing is removed. Source-policy quality now depends on planner prompt quality, which is the
  trade-off accepted here.
