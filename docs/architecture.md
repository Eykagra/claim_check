# Implemented Architecture

## Control plane

`RunEngine` owns the fixed safety graph. It calls four role-specific agents through an `ExecutionContext` that atomically checks budgets and emits trace events around every external call.

```text
PLAN -> DELEGATE -> RESEARCH -> CRITIQUE
                      ^            |
                      |-- REPLAN ---|  (at most once)
```

- Planner output is dynamic and claim-specific.
- Only the highest-value task is delegated per plan version, preserving enough of the eight-call budget for one full critic-driven replan.
- The planner emits the search query and source policy (`includeDomains`, `excludeDomains`, `maxResults`) with each task, so research is a deterministic executor rather than a fourth model-backed agent. It calls You.com with highlight extraction; a direct HTTPS page fetch is used only when highlights are unavailable. This removes one LLM round trip per research pass and one malformed-output failure mode.
- Critic output is normalized before validation (`normalizeCriticDraft`): enum drift such as `INSUFFICIENT_EVIDENCE`, percentage confidences, nested `review` objects, and swapped decision/verdict fields are mapped onto the contract instead of failing the run.
- If the critic still fails, the runtime issues a conservative `UNCLEAR` review that keeps the collected evidence attached to the report, rather than discarding the run's work.
- Critic independently accepts, rejects, or returns `UNCLEAR`.
- Runtime code—not an agent—owns retries, limits, persistence, and approvals.

## Data plane

Chrome's offscreen document captures user-initiated active-tab audio and streams 16 kHz linear PCM to Deepgram with a temporary JWT. Finalized transcript segments are sent to the service worker, which requests claim extraction and forwards UI events to the YouTube content panel.

## Persistence

Each run is stored under `DATA_DIR/runs/<runId>/`:

- `state.json`: latest state snapshot.
- `trace.jsonl`: append-only event sequence.

The file implementation follows repository interfaces so SQLite or Postgres can replace it without changing the agents or graph.

## Dependency direction

```text
contracts <- tools <- agents <- graph <- HTTP composition
                ^                  |
                +---- policies ----+
```

Agents depend on interfaces and typed contracts. Provider-specific response shapes stay inside adapters.
