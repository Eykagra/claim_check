import test from "node:test";
import assert from "node:assert/strict";
import { PlannerAgent } from "../../apps/orchestrator/src/agents/planner.js";
import { ResearcherAgent } from "../../apps/orchestrator/src/agents/researcher.js";
import { EvidenceCriticAgent } from "../../apps/orchestrator/src/agents/critic.js";
import { RunEngine } from "../../apps/orchestrator/src/graph/run-engine.js";
import { MemoryStore } from "../../apps/orchestrator/src/store/file-store.js";
import { StructuredModel } from "../../apps/orchestrator/src/tools/structured-model.js";
import { FixturePageFetcher, FixtureSearch, ScriptedModelGateway } from "../../packages/testing/src/index.js";

const claim = {
  claimId: "clm_1", exactQuote: "Inflation peaked at 9.1 percent in 2022.", normalizedClaim: "US inflation peaked at 9.1% in 2022",
  speaker: null, startMs: 1000, endMs: 4000, checkability: 0.98, category: "statistic" as const, reason: "Specific statistic", needsUserConfirmation: false
};

function plan(version: number, id: string, query: string) {
  return { version, decision: "CONTINUE", rationale: version === 1 ? "Find the official series" : "Resolve the critic's period-definition gap", tasks: [{ taskId: id, type: "CHECK_OFFICIAL_STATISTIC", objective: "Find official CPI evidence", query, expectedEvidence: "BLS release", priority: 1, includeDomains: ["bls.gov"], excludeDomains: [], maxResults: 3 }] };
}



const reject = { decision: "REJECT", verdict: "UNCLEAR", confidence: 0.45, reasoningSummary: "The first evidence does not establish which inflation measure is meant.", acceptedEvidenceIds: [], rejectedEvidence: [], gaps: ["Resolve CPI year-over-year scope"], recommendedNextTasks: [{ type: "RESOLVE_DATE_OR_SCOPE", objective: "Verify CPI-U year-over-year peak", query: "site:bls.gov CPI June 2022 9.1", expectedEvidence: "Official BLS release" }] };
const accept = { decision: "ACCEPT", verdict: "SUPPORTED", confidence: 0.93, reasoningSummary: "The official BLS passage directly reports a 9.1% year-over-year CPI increase in June 2022.", acceptedEvidenceIds: [], rejectedEvidence: [], gaps: [], recommendedNextTasks: [] };

test("critic rejection triggers one bounded replan and a second delegated search", async () => {
  const gateway = new ScriptedModelGateway({ claim_extractor: [], planner: [plan(1, "task_1", "site:bls.gov CPI 9.1 2022"), plan(2, "task_2", "site:bls.gov June 2022 CPI-U 9.1")], critic: [reject, accept] });
  const model = new StructuredModel(gateway);
  const search = new FixtureSearch({ query: "fixture", items: [{ url: "https://www.bls.gov/news.release/archives/cpi_07132022.htm", title: "Consumer Price Index — June 2022", description: "", snippets: [], highlights: ["The all items index increased 9.1 percent for the 12 months ending June; this was the largest 12-month increase since November 1981."], pageAge: "2022-07-13" }] });
  const store = new MemoryStore();
  const engine = new RunEngine(new PlannerAgent(model), new ResearcherAgent(search, new FixturePageFetcher()), new EvidenceCriticAgent(model), store, store, { deadlineMs: 45_000, maxToolCalls: 8, maxSearchCalls: 4, maxReplans: 1, maxCostUsd: 1 });
  const state = await engine.run({ claim });

  assert.equal(state.verdict, "SUPPORTED");
  assert.equal(state.planVersions.length, 2);
  assert.equal(state.budget.usedReplans, 1);
  assert.equal(state.budget.usedToolCalls, 6);
  assert.equal(search.calls, 2);
  const trace = await store.list(state.runId);
  assert.ok(trace.some((event) => event.action === "replan_authorized"));
  assert.equal(trace.filter((event) => event.action === "task_delegated").length, 2);
});
