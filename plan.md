# ClaimCheck — Multi-Agent Hackathon Plan

> **Implementation status — 2026-09-26:** The first working vertical slice is complete: Manifest V3 extension, temporary Deepgram tokens, streaming transcript boundaries, four agents, You.com evidence search, critic-driven replan, bounded runtime, JSONL trace, approval records, and automated recovery tests. See `README.md` for setup and the remaining next steps.

## 1. Goal

Build a Chrome extension and orchestration service that turns a user-selected spoken claim from a video into an evidence-based, cited result. The system must visibly plan, delegate, recover from failures, stop within hard limits, and require approval before any public or irreversible action.

**One-line pitch:** ClaimCheck extracts a factual claim from spoken media, plans an evidence search, delegates research, lets an independent critic reject weak evidence, and returns a cited verdict with a complete audit trail.

## 2. Hackathon scope

### MVP (must ship)

- Chrome Manifest V3 extension for YouTube.
- User explicitly starts/stops active-tab audio capture.
- Deepgram streaming transcription with timestamps, confidence, and utterance boundaries.
- Check-worthy claim suggestions; user selects one claim to check.
- Four justified agents: Claim Extractor, Planner, Researcher, Evidence Critic.
- You.com Search API plus direct retrieval of selected source pages.
- Shared evidence board containing claims, tasks, evidence, gaps, decisions, and provenance.
- One critic rejection can cause a revised plan and another evidence search.
- Deterministic retry/fallback logic for timeouts, malformed model output, unavailable pages, and STT failure.
- Hard limits per claim: wall-clock deadline, model/tool-call limit, replan limit, and cost ceiling.
- Human approval before copying, exporting, or publicly sharing the result.
- Downloadable/readable JSONL audit trace plus a compact trace UI.
- Verdicts: `SUPPORTED`, `CONTRADICTED`, `MIXED`, `UNCLEAR`.

### Stretch goals

- Instagram or arbitrary HTML5 video support.
- Multilingual transcription and claim checking.
- Speaker diarization and attribution.
- Parallel supporting/contradicting research tasks.
- Source-quality policy by claim domain.
- Reproducible benchmark dashboard across repeated runs.

### Explicit non-goals for the MVP

- Continuous automatic checking of every sentence.
- Declaring a person truthful or deceptive.
- Treating search snippets as evidence.
- Posting results automatically.
- Supporting every browser and media website.
- Building a general-purpose agent framework.

## 3. Architecture boundary and principles

ClaimCheck is built around active-tab capture, an offscreen audio document, streaming Deepgram transcription, final/interim transcript separation, utterance-end handling, rolling transcript context, stale-window flushing, and a single-flight guard, implemented independently in TypeScript.

The differentiator is the multi-agent control plane: dynamic planning, explicit delegation, critic rejection, shared state, bounded recovery, human approval, and an auditable trace.

## 4. User journey

1. User opens a YouTube video and clicks **Start listening**.
2. Extension captures only the active tab after the explicit click.
3. Transcript appears incrementally with timestamps and confidence.
4. Claim Extractor proposes atomic check-worthy claims from completed utterances.
5. User chooses a claim and clicks **Check claim**.
6. Planner inspects the claim and creates evidence tasks (for example: official statistic, primary document, credible secondary confirmation).
7. Researcher chooses the appropriate search/retrieval tool for each task and writes evidence to the shared board.
8. Evidence Critic checks entailment, source identity, date, quote accuracy, independence, and coverage of both supporting and contradicting evidence.
9. If the critic rejects the evidence, the Planner gets structured gaps and may issue a revised task within budget.
10. System returns a cited verdict or `UNCLEAR`, never a forced answer.
11. User opens the trace to see every decision, call, retry, and stopping reason.
12. Any export/share action requires explicit approval.

## 5. Agent design

Do not call every component an agent. Capture, transcription, page retrieval, storage, validation, and retries are tools/runtime services.

### A. Claim Extractor

**Why it exists:** converting noisy conversational speech into atomic, checkable propositions is different from researching or judging them.

**Input:** completed utterance, nearby transcript context, timestamp range, language, ASR confidence.

**Output (strict schema):**

```json
{
  "claims": [
    {
      "claim_id": "clm_...",
      "exact_quote": "...",
      "normalized_claim": "...",
      "speaker": null,
      "start_ms": 0,
      "end_ms": 0,
      "checkability": 0.0,
      "category": "statistic|event|policy|science|other",
      "reason": "...",
      "needs_user_confirmation": false
    }
  ]
}
```

**Reject:** opinions, predictions, rhetorical questions, vague claims, and claims whose ASR uncertainty changes the meaning.

### B. Planner / Orchestrator agent

**Why it exists:** it decides what evidence would settle this specific claim instead of running a fixed chain.

**Input:** selected claim, transcript context, evidence board, remaining budget, prior critic gaps.

**Output:** zero or more typed tasks, rationale, priority, expected proof, and stop/continue decision.

Example task types:

- `FIND_PRIMARY_RECORD`
- `VERIFY_QUOTE`
- `CHECK_OFFICIAL_STATISTIC`
- `FIND_SUPPORTING_EVIDENCE`
- `FIND_CONTRADICTING_EVIDENCE`
- `RESOLVE_DATE_OR_SCOPE`

The planner may choose not to call a tool when the statement is not checkable, user confirmation is required, or remaining budget cannot produce reliable evidence.

### C. Researcher agent

**Why it exists:** it translates evidence tasks into queries, selects tools, retrieves full pages, extracts relevant passages, and preserves provenance.

**Input:** one evidence task, claim, source policy, budget.

**Output:** evidence records or a typed failure. Search snippets are discovery hints only.

### D. Evidence Analyst / Critic

**Why it exists:** it is independent from evidence collection and can reject superficially relevant or low-quality evidence.

**Input:** claim, full evidence records, missing/failed tasks, timestamp/date context.

**Output:**

```json
{
  "decision": "ACCEPT|REJECT|UNCLEAR",
  "verdict": "SUPPORTED|CONTRADICTED|MIXED|UNCLEAR",
  "confidence": 0.0,
  "reasoning_summary": "...",
  "accepted_evidence_ids": [],
  "rejected_evidence": [{"evidence_id": "...", "reason": "..."}],
  "gaps": [],
  "recommended_next_tasks": []
}
```

A rejected result returns to the planner only if replan, time, tool-call, and cost budgets remain.

## 6. Orchestration graph

```text
CAPTURE
  -> TRANSCRIBE
  -> BOUNDARY_DETECTED
  -> EXTRACT_CLAIMS
  -> USER_SELECTS_CLAIM
  -> PLAN
  -> RESEARCH_TASKS (parallel with bounded concurrency)
  -> CRITIQUE
       -> ACCEPT -> FINALIZE
       -> REJECT + budget remains -> REPLAN -> RESEARCH_TASKS
       -> REJECT + no budget -> FINALIZE_UNCLEAR
       -> USER_CONFIRMATION_REQUIRED -> PAUSE_FOR_HUMAN
  -> APPROVAL_GATE_FOR_SHARE
  -> END
```

The graph structure is fixed for safety; task generation, tool selection, query generation, evidence needs, task count, rejection, and early stopping are dynamic. This is a planned system rather than a hardcoded list of model calls.

## 7. Shared evidence board

Use a per-run append-oriented state object persisted in SQLite for the demo.

```ts
interface RunState {
  runId: string;
  status: RunStatus;
  claim: Claim | null;
  transcript: TranscriptSegment[];
  planVersions: Plan[];
  tasks: EvidenceTask[];
  evidence: EvidenceRecord[];
  criticReviews: CriticReview[];
  failures: FailureRecord[];
  budget: RunBudget;
  approvals: ApprovalRecord[];
  startedAt: string;
  deadlineAt: string;
  stopReason?: StopReason;
}
```

Evidence record requirements:

- Canonical URL, title, publisher/domain, publication date if found.
- Retrieval time and HTTP status.
- Exact excerpt with nearby context.
- Which task/query found it.
- Whether content came from a full page or only a search result.
- Evidence stance: supports, contradicts, contextual, or irrelevant.
- Content hash for audit/replay.
- Agent/model/tool version that created the record.

## 8. Speech, pause, and transcript boundary design

Use Deepgram streaming as the primary path for active-tab audio transcription.

### Hybrid boundary policy

- Append interim text only to the live preview.
- Commit only final STT segments to the transcript ledger.
- Flush an utterance when Deepgram emits `speech_final` or `UtteranceEnd`.
- Configure `utterance_end_ms` as a tunable value; start around 1.2–1.8 seconds and test on debates/interviews.
- Flush on speaker change when diarization is available and the pending buffer is meaningful.
- Force a stale-buffer flush after roughly 4 seconds so slow speech does not stall the UI.
- Force a maximum-duration flush (for example 12 seconds) to bound latency and memory.
- Ignore very short filler-only chunks; merge them into the next utterance.
- Preserve word timestamps and keep a small text overlap for extraction context without duplicating claim IDs.
- Use a single-flight extractor plus a bounded queue to prevent overlapping model calls.

### ASR recovery

1. If the Deepgram WebSocket closes unexpectedly, reconnect once with exponential backoff and obtain a fresh capture stream.
2. Keep finalized transcript segments already received.
3. If a short span is low confidence or the connection failed, send only the bounded audio excerpt to Mistral Voxtral for batch retranscription.
4. If both fail, show the transcript as uncertain and ask the user to edit/confirm it before research.
5. Never silently transform an uncertain quote into a confident claim.

## 9. Tools and provider routing

### Recommended default routing

| Capability | Primary | Fallback | Notes |
|---|---|---|---|
| Streaming STT | Deepgram | — | Best fit for live tab audio |
| Bounded retranscription | Mistral Voxtral | user confirmation | Only failed/uncertain excerpts |
| Claim extraction | low-cost Mistral/OpenAI model | Gemini free tier | Strict JSON schema |
| Planning | capable OpenAI model | Mistral model | Structured tasks; temperature low |
| Research | You.com Search + direct page fetch | revised query / graceful gap | Snippets never count as proof |
| Critic | capable OpenAI model | capable Mistral model | Keep independent from researcher |
| Final wording | deterministic template | small model if needed | Verdict must come from critic schema |

All model IDs live in environment configuration. Do not hardcode a model name that may change before the hackathon.

### Tool adapters

Every adapter returns the same envelope:

```ts
interface ToolResult<T> {
  ok: boolean;
  data?: T;
  error?: {
    kind: "timeout" | "rate_limit" | "auth" | "malformed" | "blocked" | "upstream";
    retryable: boolean;
    message: string;
  };
  latencyMs: number;
  usage?: { inputTokens?: number; outputTokens?: number; costUsd?: number };
  attempt: number;
}
```

Required adapters:

- `deepgram-stream`
- `voxtral-transcribe`
- `llm-openai`
- `llm-mistral`
- `llm-gemini`
- `you-search`
- `page-fetch`

Validate every model response with a schema before writing it to shared state.

## 10. Evidence policy

- Search results discover sources; they are not evidence by themselves.
- Fetch the page and extract the passage that bears on the claim.
- Prefer primary sources: legislation, official datasets, court records, peer-reviewed research, or direct transcripts.
- Use reputable secondary reporting for context and corroboration.
- Record source date and compare it with the clip date when available.
- Seek both supporting and contradicting evidence when the claim is contestable.
- Do not infer that two sites are independent if they repeat the same wire story.
- If pages are inaccessible or evidence is insufficient, return `UNCLEAR` and list the gap.
- The critic must explain why each accepted excerpt entails or contradicts the claim.

## 11. Recovery and degradation matrix

| Failure | Detection | Recovery | Final degradation |
|---|---|---|---|
| Deepgram disconnect | socket close/error | reconnect once with backoff | Voxtral on buffered excerpt or user-confirmed text |
| Low ASR confidence | confidence threshold / semantic ambiguity | Voxtral retranscription | ask user to confirm quote |
| Model output malformed | schema validation fails | one repair request with validation errors | switch provider once or stop this step |
| Model timeout/rate limit | adapter timeout/status | one jittered retry | switch configured provider if budget allows |
| You.com timeout/500 | adapter failure | retry once | revised query or record research gap |
| Search returns weak results | critic rejects relevance/authority | planner revises source/query strategy | `UNCLEAR` |
| Page blocks retrieval | 401/403/robots/parser failure | retrieve alternate source | label URL as discovery-only; never cite snippet as proof |
| One research task fails | typed task failure | continue independent tasks | critic judges remaining coverage |
| Critic rejects evidence | structured `REJECT` + gaps | at most one replan | `UNCLEAR` when budget ends |
| Partial write/state crash | event/state transaction | resume from last completed node | end with explicit interrupted status |
| Share/export requested | action classification | pause for approval | no action without approval |

Use deterministic runtime code—not another agent—for retry counts, deadlines, circuit breakers, idempotency, and approvals.

## 12. Stopping conditions

Initial per-claim defaults, all configurable:

- Wall clock: 45 seconds after the user submits a claim.
- Total external tool calls: 8.
- Search calls: 4.
- Full-page fetches: 6.
- Planner revisions: 1.
- Attempts per tool call: 2 total (initial + one retry).
- Concurrent research tasks: 3.
- Maximum evidence records accepted by critic: 8.
- Estimated provider spend: USD 0.10 per claim during development; lower for the demo if benchmarks support it.

The first exhausted limit ends the loop. The output records the exact stopping reason and returns the best supported result, defaulting to `UNCLEAR`.

## 13. Human approval

No approval is required to capture after the user clicks Start, transcribe, search, or display a private result. Explicit approval is required before:

- posting or publishing a verdict;
- sending it to another person or service;
- exporting transcript audio/text when it contains sensitive content;
- saving credentials or enabling persistent collection beyond the current session.

The approval screen shows the claim, verdict, exact payload, destination, and cited sources. Approval expires when the payload changes.

## 14. Audit trace

Write one JSON object per line, append-only. Each event contains:

```json
{
  "event_id": "evt_...",
  "run_id": "run_...",
  "sequence": 12,
  "time": "ISO-8601",
  "actor": "planner|researcher|critic|runtime|human",
  "action": "tool_call_started",
  "reason": "Need the official value for the claimed period",
  "input_ref": "sha256:...",
  "output_ref": "sha256:...",
  "tool": "you_search",
  "attempt": 1,
  "latency_ms": 842,
  "usage": {"input_tokens": 0, "output_tokens": 0, "cost_usd": 0},
  "budget_remaining": {"tool_calls": 5, "time_ms": 31210, "cost_usd": 0.074},
  "status": "ok"
}
```

The UI trace should answer:

- What did each agent receive and produce?
- Why was each tool selected?
- Which evidence was accepted or rejected, and why?
- What failed and what fallback ran?
- How much time and money did the run use?
- Why did the system stop?
- Did a human approve any outward action?

Redact API keys, auth headers, and raw audio. Hash large payloads and store redacted copies separately.

## 15. Cost plan for available credits

Available: OpenAI USD 45, Mistral USD 25, Gemini free API, You.com credit, Deepgram, and Mistral Voxtral.

Principles:

- Use deterministic checks before any LLM call.
- Extract claims only from finalized utterances, not every interim token.
- Let the user choose one claim before expensive research.
- Use a small model for extraction and query generation.
- Reserve the stronger model for planning after critic rejection and for the critic itself.
- Run independent research tasks concurrently but cap concurrency.
- Cache page content by canonical URL and search results by normalized query.
- Cache model outputs only for deterministic benchmark replays, not as fresh evidence.
- Persist actual provider token/usage metadata; calculate cost from a versioned price table.
- Add daily development and benchmark budgets so testing cannot consume all credits.

Suggested credit allocation (adjust after a 10-run measurement):

- 20% prototyping and prompt/schema iteration.
- 25% transcript/boundary testing.
- 30% repeated end-to-end benchmark runs.
- 15% failure-injection and fallback tests.
- 10% reserved for the live demo.

## 16. API boundary

Suggested HTTP/WebSocket routes:

```text
POST   /v1/runs                         create run
WS     /v1/runs/:runId/transcript      stream transcript events
POST   /v1/runs/:runId/claims/extract  request extraction
POST   /v1/runs/:runId/claims/:id/check
GET    /v1/runs/:runId                 current shared state
GET    /v1/runs/:runId/trace           redacted audit events
POST   /v1/runs/:runId/approve         approve exact outbound payload hash
POST   /v1/runs/:runId/cancel          user cancellation
GET    /health
```

The extension never receives long-lived provider secrets. During local development it talks to a local orchestrator. For the demo, deploy the orchestrator with server-side environment variables and short-lived session authorization.

## 17. Folder structure

```text
claimcheck-multi-agent/
├── plan.md
├── README.md
├── .env.example
├── .gitignore
├── package.json
├── package-lock.json
├── tsconfig.base.json
├── apps/
│   ├── extension/
│   │   ├── manifest.json
│   │   └── src/
│   │       ├── background/   # lifecycle, tabCapture, orchestration client
│   │       ├── content/      # in-page panel and trace/result UI
│   │       ├── offscreen/    # audio pipeline and Deepgram WebSocket
│   │       ├── popup/        # start/stop, settings, permissions
│   │       └── shared/       # extension-local types and messages
│   └── orchestrator/
│       └── src/
│           ├── agents/       # extractor, planner, researcher, critic
│           ├── graph/        # state machine, nodes, transitions
│           ├── tools/        # provider adapters and page retrieval
│           ├── policies/     # budgets, source policy, approvals
│           ├── store/        # SQLite state/evidence/event repositories
│           ├── telemetry/    # trace, latency, cost, redaction
│           └── http/         # REST/WS transport
├── packages/
│   ├── contracts/src/        # shared schemas and event contracts
│   ├── prompts/src/          # versioned prompts, no secrets
│   └── testing/src/          # mocks, replay and failure injectors
├── tests/
│   ├── fixtures/
│   │   ├── audio/
│   │   ├── transcripts/
│   │   └── tool-responses/
│   ├── unit/
│   ├── integration/
│   ├── e2e/
│   └── chaos/
├── docs/
│   ├── architecture.md
│   ├── demo-script.md
│   ├── evaluation.md
│   ├── adr/
│   └── diagrams/
├── scripts/
└── .github/workflows/
```

## 18. Milestones and build order

### Milestone 0 — contracts and replay harness (half day)

- Define schemas for claim, plan, task, tool result, evidence, critic review, budget, and trace.
- Create fixture-based provider mocks.
- Build trace writer and run replay before calling real APIs.

**Exit:** one recorded run can be replayed deterministically from fixtures.

### Milestone 1 — capture and speech boundaries (day 1)

- MV3 extension shell, explicit Start/Stop, active-tab capture, offscreen document.
- Deepgram streaming with interim/final transcript UI.
- Hybrid pause boundary, stale flush, and single-flight extraction queue.
- Timestamp and confidence ledger.

**Exit:** three different videos produce readable, bounded utterances without duplicate finalized text.

### Milestone 2 — claim extraction and selection (day 2 morning)

- Strict extractor schema and checkability policy.
- Claim chips linked to timestamp/quote.
- User edit/confirm flow for uncertain ASR.
- Duplicate claim suppression by normalized text + numbers + timestamp window.

**Exit:** factual claims are proposed; opinions and predictions are not auto-checked.

### Milestone 3 — planner, tools, evidence board (day 2 afternoon)

- Planner output schema and dynamic evidence tasks.
- You.com adapter and direct page retrieval with timeouts.
- Evidence extraction with exact passages and provenance.
- Shared SQLite state and trace events.

**Exit:** planner produces different tasks for a statistic, quote, and historical event.

### Milestone 4 — critic and recovery loop (day 3)

- Critic acceptance/rejection schema.
- One bounded replan loop.
- Provider fallback, malformed-output repair, page-fetch degradation, and deadline enforcement.
- `UNCLEAR` when evidence remains insufficient.

**Exit:** injected search timeout and weak evidence do not crash the run; trace explains recovery.

### Milestone 5 — approval, trace UI, evaluation (day 4)

- Trace timeline, accepted/rejected evidence, cost and latency.
- Approval gate for export/share.
- Benchmark runner and failure-injection controls.
- Polish result card and rehearsal.

**Exit:** complete demo works with a normal run and a forced-failure run.

## 19. Testing strategy

### Unit tests

- Schema validation and malformed-output repair.
- Budget decrement and exact stopping reason.
- Transcript boundary logic and duplicate suppression.
- Evidence/source-date checks.
- Approval payload hashing and expiry.
- Retry classification and exponential backoff.

### Integration tests

- Adapter success and recorded response replay.
- Search discovery -> page fetch -> excerpt extraction.
- Planner rejection -> replan -> critic acceptance.
- Resume from persisted state after a simulated process crash.

### Chaos tests required for the demo

- You.com returns HTTP 500 once.
- Model returns non-JSON once.
- Page retrieval times out.
- Deepgram socket closes mid-utterance.
- Critic rejects all evidence.
- Deadline expires during replan.

### Evaluation set

Prepare 10–20 short clips across statistics, quotes, historical events, policy descriptions, science/health, opinion, and unverifiable speech. Include known primary sources and expected checkability/verdict labels.

Run each clip at least three times and report:

- Task completion rate.
- Correct checkability classification.
- Citation validity (page exists and excerpt supports the cited use).
- Verdict agreement with a human-labelled answer.
- Recovery success by injected failure type.
- Median and p95 latency.
- Actual cost per completed claim.
- Rate of honest `UNCLEAR` outcomes.

## 20. Demo script (4–5 minutes)

1. **Problem (20s):** spoken claims move faster than careful fact checking.
2. **Normal run (70s):** start capture, select claim, watch dynamic plan, see sources and critic-approved verdict.
3. **Explain agents (40s):** show why extraction, planning/research, and independent criticism are separate.
4. **Failure run (70s):** force You.com or page-fetch failure; show retry/fallback and continued run.
5. **Critic rejection (40s):** show weak evidence rejected and a revised query/task.
6. **Limits and trace (40s):** display elapsed time, tool calls, actual cost, stop reason, and event timeline.
7. **Human gate (20s):** click Share and show the exact-payload approval dialog.

Have fixture-backed demo mode available in case venue networking fails; label it clearly as replay mode and also retain a recorded successful live run.

## 21. Risks and mitigations

- **Looks like a fixed pipeline:** expose planner tasks, tool decisions, early stopping, and critic-driven replan in the UI.
- **Too many agents:** keep only four; handle retries and formatting deterministically.
- **Real-time cost/latency grows:** user-selected claims, single-flight extraction, caching, small models, hard budgets.
- **Hallucinated citations:** require successful full-page retrieval and exact excerpts before citation.
- **Fact-checking is overconfident:** calibrated confidence, evidence gaps, and `UNCLEAR` as a first-class result.
- **Demo network fails:** recorded responses/replay mode and a pre-recorded fallback video.
- **Extension security:** provider keys remain server-side; minimum browser permissions; explicit capture state.
- **Scope creep:** YouTube + English + selected claim only until the complete recovery demo passes.

## 22. Definition of done

The project is hackathon-ready when:

- A claim flows from real tab audio to a cited result.
- The planner produces task-specific delegation rather than a fixed query sequence.
- At least one real external API is used live.
- A critic can reject evidence and trigger one bounded replan.
- At least three injected failure types recover or degrade to `UNCLEAR` without crashing.
- Every agent/tool action appears in a human-readable trace with inputs, rationale, attempts, latency, and measured usage/cost where available.
- Deadline, call, replan, and cost limits are enforced in code.
- Public/share actions cannot proceed without explicit approval.
- Repeated-run completion, latency, cost, and recovery metrics are available.

## 23. Decisions to confirm after scaffolding

These do not block the initial build:

1. Exact hackathon duration and team size.
2. Whether the MVP must support live streams or only ordinary YouTube videos.
3. First demo language (recommended: English only).
4. Backend deployment target.
5. Whether the result must be stored remotely or only for the local session.
