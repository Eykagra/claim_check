import test from "node:test";
import assert from "node:assert/strict";
import { PlannerAgent } from "../../apps/orchestrator/src/agents/planner.js";
import { ResearcherAgent } from "../../apps/orchestrator/src/agents/researcher.js";
import { EvidenceCriticAgent } from "../../apps/orchestrator/src/agents/critic.js";
import { RunEngine } from "../../apps/orchestrator/src/graph/run-engine.js";
import { MemoryStore } from "../../apps/orchestrator/src/store/file-store.js";
import { StructuredModel } from "../../apps/orchestrator/src/tools/structured-model.js";
import { FixturePageFetcher, FixtureSearch, ScriptedModelGateway } from "../../packages/testing/src/index.js";

test("malformed planner output recovers with a deterministic evidence task", async () => {
  const gateway = new ScriptedModelGateway({
    claim_extractor: [],
    planner: [{ unexpected: true }, { stillWrong: true }],
    critic: [{ decision: "ACCEPT", verdict: "SUPPORTED", confidence: 0.82, reasoningSummary: "The official record directly supports the claim.", acceptedEvidenceIds: [], rejectedEvidence: [], gaps: [], recommendedNextTasks: [] }]
  });
  const model = new StructuredModel(gateway);
  const search = new FixtureSearch({ query: "fixture", items: [{ url: "https://example.gov/employment", title: "Official employment record", description: "", snippets: [], highlights: ["The official annual record reports that employment increased during the stated period."], pageAge: null }] });
  const store = new MemoryStore();
  const engine = new RunEngine(new PlannerAgent(model), new ResearcherAgent(search, new FixturePageFetcher()), new EvidenceCriticAgent(model), store, store, { deadlineMs: 45_000, maxToolCalls: 8, maxSearchCalls: 4, maxReplans: 1, maxCostUsd: 1 });
  const state = await engine.run({ claim: { claimId: "c1", exactQuote: "Employment increased last year.", normalizedClaim: "Employment increased last year", speaker: null, startMs: 0, endMs: 1200, checkability: 0.8, category: "statistic", reason: "Specific measurable claim", needsUserConfirmation: false } });

  assert.equal(state.verdict, "SUPPORTED");
  assert.equal(state.planVersions.length, 1);
  assert.match(state.planVersions[0]!.rationale, /fallback/i);
  assert.ok((await store.list(state.runId)).some((event) => event.action === "planner_recovered"));
});

test("a failing critic degrades to an evidence-preserving review instead of collapsing the run", async () => {
  const gateway = new ScriptedModelGateway({
    claim_extractor: [],
    planner: [{ version: 1, decision: "CONTINUE", rationale: "Verify the quote", tasks: [{ taskId: "t1", type: "VERIFY_QUOTE", objective: "Find the original statement", query: "original statement", expectedEvidence: "Transcript", priority: 1, includeDomains: [], excludeDomains: [], maxResults: 1 }] }],
    critic: []
  });
  const model = new StructuredModel(gateway);
  const search = new FixtureSearch({ query: "fixture", items: [{ url: "https://example.org/transcript", title: "Official transcript", description: "", snippets: [], highlights: ["The official transcript records the full remarks delivered at the summit."], pageAge: null }] });
  const store = new MemoryStore();
  const engine = new RunEngine(new PlannerAgent(model), new ResearcherAgent(search, new FixturePageFetcher()), new EvidenceCriticAgent(model), store, store, { deadlineMs: 45_000, maxToolCalls: 8, maxSearchCalls: 4, maxReplans: 1, maxCostUsd: 1 });
  const state = await engine.run({ claim: { claimId: "c1", exactQuote: "He said it.", normalizedClaim: "The prime minister made the statement", speaker: null, startMs: 0, endMs: 900, checkability: 0.6, category: "quote", reason: "Attributed quote", needsUserConfirmation: false } });

  assert.equal(state.verdict, "UNCLEAR");
  assert.equal(state.status, "COMPLETED");
  assert.equal(state.evidence.length, 1);
  // The collected source stays attached to the report rather than vanishing.
  assert.deepEqual(state.criticReviews[0]?.acceptedEvidenceIds, [state.evidence[0]!.evidenceId]);
  assert.ok((state.confidence ?? 0) > 0);
  assert.ok((await store.list(state.runId)).some((event) => event.action === "critic_recovered"));
});
