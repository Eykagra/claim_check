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
- Researcher chooses a query and source policy, then calls You.com with highlight extraction. A direct HTTPS page fetch is used only when highlights are unavailable.
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
