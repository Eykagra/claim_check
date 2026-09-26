import { PlannerAgent } from "../apps/orchestrator/src/agents/planner.js";
import { ResearcherAgent } from "../apps/orchestrator/src/agents/researcher.js";
import { EvidenceCriticAgent } from "../apps/orchestrator/src/agents/critic.js";
import { RunEngine } from "../apps/orchestrator/src/graph/run-engine.js";
import { MemoryStore } from "../apps/orchestrator/src/store/file-store.js";
import { StructuredModel } from "../apps/orchestrator/src/tools/structured-model.js";
import { FixturePageFetcher, FixtureSearch, ScriptedModelGateway } from "../packages/testing/src/index.js";

const gateway = new ScriptedModelGateway({ claim_extractor: [], planner: [{ version: 1, decision: "CONTINUE", rationale: "Verify the number against the official CPI release", tasks: [{ taskId: "demo_task", type: "CHECK_OFFICIAL_STATISTIC", objective: "Find official CPI value", query: "site:bls.gov CPI 9.1 June 2022", expectedEvidence: "BLS CPI release", priority: 1, includeDomains: ["bls.gov"], excludeDomains: [], maxResults: 2 }] }], critic: [{ decision: "ACCEPT", verdict: "SUPPORTED", confidence: 0.93, reasoningSummary: "The official BLS passage directly supports the claim.", acceptedEvidenceIds: [], rejectedEvidence: [], gaps: [], recommendedNextTasks: [] }] });
const model = new StructuredModel(gateway);
const search = new FixtureSearch({ query: "demo", items: [{ url: "https://www.bls.gov/news.release/archives/cpi_07132022.htm", title: "Consumer Price Index — June 2022", description: "", snippets: [], highlights: ["The all items index increased 9.1 percent for the 12 months ending June."], pageAge: "2022-07-13" }] });
const store = new MemoryStore();
const engine = new RunEngine(new PlannerAgent(model), new ResearcherAgent(search, new FixturePageFetcher()), new EvidenceCriticAgent(model), store, store, { deadlineMs: 45_000, maxToolCalls: 8, maxSearchCalls: 4, maxReplans: 1, maxCostUsd: 1 });
const state = await engine.run({ claim: { claimId: "demo_claim", exactQuote: "Inflation peaked at 9.1 percent in 2022.", normalizedClaim: "US CPI inflation reached 9.1 percent in 2022", speaker: null, startMs: 0, endMs: 3000, checkability: 0.98, category: "statistic", reason: "Specific statistic", needsUserConfirmation: false } });
console.log(JSON.stringify({ runId: state.runId, verdict: state.verdict, confidence: state.confidence, plans: state.planVersions.length, toolCalls: state.budget.usedToolCalls, stopReason: state.stopReason, traceEvents: (await store.list(state.runId)).length }, null, 2));
