import test from "node:test";
import assert from "node:assert/strict";
import { PlannerAgent } from "../../apps/orchestrator/src/agents/planner.js";
import { ResearcherAgent } from "../../apps/orchestrator/src/agents/researcher.js";
import { EvidenceCriticAgent } from "../../apps/orchestrator/src/agents/critic.js";
import { RunEngine } from "../../apps/orchestrator/src/graph/run-engine.js";
import { MemoryStore } from "../../apps/orchestrator/src/store/file-store.js";
import { StructuredModel } from "../../apps/orchestrator/src/tools/structured-model.js";
import { FixturePageFetcher, FixtureSearch, ScriptedModelGateway } from "../../packages/testing/src/index.js";

test("a transient search 500 is retried without collapsing the run", async () => {
  const gateway = new ScriptedModelGateway({
    claim_extractor: [],
    planner: [{ version: 1, decision: "CONTINUE", rationale: "Find a primary record", tasks: [{ taskId: "t1", type: "FIND_PRIMARY_RECORD", objective: "Find official record", query: "site:example.gov record", expectedEvidence: "Official record", priority: 1, includeDomains: ["example.gov"], excludeDomains: [], maxResults: 1 }] }],
    critic: [{ decision: "ACCEPT", verdict: "SUPPORTED", confidence: 0.8, reasoningSummary: "The recovered official evidence supports the claim.", acceptedEvidenceIds: [], rejectedEvidence: [], gaps: [], recommendedNextTasks: [] }]
  });
  const model = new StructuredModel(gateway);
  const search = new FixtureSearch({ query: "fixture", items: [{ url: "https://example.gov/record", title: "Official record", description: "", snippets: [], highlights: ["The official record directly confirms the event described in the claim."], pageAge: null }] }, true);
  const store = new MemoryStore();
  const engine = new RunEngine(new PlannerAgent(model), new ResearcherAgent(search, new FixturePageFetcher()), new EvidenceCriticAgent(model), store, store, { deadlineMs: 45_000, maxToolCalls: 6, maxSearchCalls: 3, maxReplans: 0, maxCostUsd: 1 });
  const state = await engine.run({ claim: { claimId: "c", exactQuote: "The event occurred.", normalizedClaim: "The event occurred", speaker: null, startMs: 0, endMs: 1000, checkability: 0.8, category: "event", reason: "Specific event", needsUserConfirmation: false } });
  assert.equal(state.verdict, "SUPPORTED");
  assert.equal(search.calls, 2);
  const trace = await store.list(state.runId);
  assert.ok(trace.some((event) => event.action === "tool_call_failed" && event.tool === "you_search"));
  assert.ok(trace.some((event) => event.action === "tool_call_completed" && event.tool === "you_search" && event.attempt === 2));
});
