# ClaimCheck

A bounded multi-agent system for verifying spoken claims from browser video. It captures active-tab audio after an explicit user action, transcribes it with Deepgram, extracts checkable claims, creates a claim-specific evidence plan, researches with You.com, lets an independent critic reject weak evidence, and returns a cited result with an append-only audit trace.

## Current implementation

This repository now contains a working first vertical slice:

- Manifest V3 Chrome extension with explicit Start/Stop.
- Secure 30-second Deepgram JWT grant endpoint; long-lived Deepgram credentials stay server-side.
- Streaming transcription with interim/final separation, `speech_final`, `UtteranceEnd`, a 1.5-second pause threshold, and one reconnect attempt.
- Three model-backed agents — Claim Extractor, Planner, and Evidence Critic — plus a deterministic research executor.
- Deterministic claim-quality gate that removes predictions, low-checkability suggestions, unresolved locations/entities/timeframes, and overlapping duplicates.
- Strict runtime validation for every agent output.
- You.com `POST /v1/search` integration using query-relevant highlights.
- HTTPS full-page retrieval fallback when highlights are missing.
- Critic rejection → one bounded replan loop.
- Hard deadline, tool-call, search-call, replan, and cost limits.
- File-backed run state and JSONL trace.
- Exact-payload approval records before sharing.
- In-browser standalone HTML report export with claim outcomes, caveats, accepted sources, not-checked suggestions, session counts, and the grouped transcript.
- Unit, integration, chaos, and fixture-backed demo coverage.

This is an original implementation featuring active-tab audio capture, streaming transcript handling, pause boundaries, and single-flight multi-agent processing.

## Architecture

```text
active-tab audio
  -> Deepgram streaming STT (Voxtral fallback is planned)
  -> Claim Extractor Agent
  -> user selects/confirms claim
  -> Planner Agent
  -> Research executor (deterministic) -> You.com / page retrieval
  -> shared evidence board
  -> Evidence Critic Agent
       -> ACCEPT/UNCLEAR -> final result
       -> REJECT -> one bounded replan -> research -> critique
  -> human approval before share/export/publish
```

Retries, budgets, persistence, and approval checks are deterministic runtime code—not extra agents.

## Prerequisites

- Node.js 24+
- npm 11+
- Chrome or Chromium
- Deepgram and You.com API keys
- At least one configured model provider; two are recommended for fallback

## Setup

### Windows PowerShell

```powershell
npm install
Copy-Item .env.example .env
notepad .env
npm run typecheck
npm test
npm run demo
npm run dev
```

`npm run dev` loads `.env` automatically on Node 24. Keep the PowerShell window open while using the extension.

The checked-in `.env.example` deliberately distributes work by role: Gemini Flash performs batched claim-worthiness extraction, Mistral Medium plans (including the search query and source policy), and OpenAI `gpt-5.4-mini` is reserved for independent criticism. Research itself is deterministic and uses no model. Before extraction, the extension combines short STT fragments into a rolling two-to-four-sentence window, waits for enough new speech, and enforces a four-second minimum interval. A failed extraction automatically routes to Mistral. OpenAI nano models are used only as planner fallbacks. If your account returns `model_not_found`, list the models available in that provider console and replace only the affected model ID.

The server starts at `http://127.0.0.1:8787` by default.

### Load the extension

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Choose **Load unpacked**.
4. Select `apps/extension`.
5. Open a YouTube video.
6. Open the extension popup and click **Start listening**.

Do not expose the orchestrator publicly without authentication, HTTPS, rate limiting, and a narrow `ALLOWED_ORIGINS` value.

## Scripts

```powershell
npm run typecheck  # strict TypeScript validation
npm test           # unit + integration + chaos tests
npm run demo       # deterministic fixture-backed end-to-end run
npm run dev        # local API server
```

## API

```text
GET    /health
POST   /v1/transcription/token
POST   /v1/claims/extract
POST   /v1/runs
GET    /v1/runs/:runId
GET    /v1/runs/:runId/trace
POST   /v1/runs/:runId/approve
```

`POST /v1/runs` is synchronous in this first slice and can take up to the configured run deadline. A later iteration can expose asynchronous run events over SSE or WebSocket.

## Security and evidence rules

- Provider secrets live only in the orchestrator environment.
- The extension receives a short-lived Deepgram JWT, not the project API key.
- Only HTTPS evidence pages may be fetched.
- Search snippets are never converted into evidence records.
- You.com highlights or retrieved page passages carry URL/title/provenance.
- API keys, headers, and raw audio are excluded from traces.
- The system returns `UNCLEAR` when it cannot safely finish within budget.
- Approval records are bound to a hash of the exact outward payload and expire after ten minutes.

## Test coverage

The integration test proves that the critic can reject the first research pass, return a gap, cause the planner to create a different task, and accept the second pass within exactly eight calls. The chaos test injects a search HTTP 500 and verifies a successful one-retry recovery with both attempts visible in the trace.

## Next implementation steps

1. Add bounded Voxtral batch retranscription for low-confidence excerpts.
2. Add asynchronous run progress to the extension trace panel.
3. Replace simple HTML stripping with a hardened readability pipeline.
4. Add source-date and same-wire-story independence checks.
5. Add session authentication before any hosted deployment.
6. Build the 10–20 clip repeated-run evaluation harness described in `plan.md`.
