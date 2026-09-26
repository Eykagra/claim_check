import test from "node:test";
import assert from "node:assert/strict";
import { EvidenceCriticAgent } from "../../apps/orchestrator/src/agents/critic.js";
import { ExecutionContext } from "../../apps/orchestrator/src/graph/execution-context.js";
import { BudgetController } from "../../apps/orchestrator/src/policies/budget.js";
import { MemoryStore } from "../../apps/orchestrator/src/store/file-store.js";
import { Tracer } from "../../apps/orchestrator/src/telemetry/tracer.js";
import { StructuredModel } from "../../apps/orchestrator/src/tools/structured-model.js";
import { ScriptedModelGateway } from "../../packages/testing/src/index.js";
import type { RunState } from "../../packages/contracts/src/index.js";

test("REJECT is normalized to ACCEPT when evidence supports a completed contradicted verdict with no gaps", async () => {
  const gateway = new ScriptedModelGateway({ claim_extractor: [], planner: [], researcher: [], critic: [{ decision: "REJECT", verdict: "CONTRADICTED", confidence: 0.95, reasoningSummary: "Official evidence directly contradicts the claimed percentage.", acceptedEvidenceIds: ["e1"], rejectedEvidence: [], gaps: [], recommendedNextTasks: [] }] });
  const store = new MemoryStore();
  const budgetValue = { deadlineAt: new Date(Date.now() + 10_000).toISOString(), maxToolCalls: 8, usedToolCalls: 0, maxSearchCalls: 4, usedSearchCalls: 0, maxReplans: 1, usedReplans: 0, maxCostUsd: 1, usedCostUsd: 0 };
  const context = new ExecutionContext(new BudgetController(budgetValue), new Tracer("run_test", store));
  const state: RunState = {
    runId: "run_test", status: "CRITIQUING", claim: { claimId: "c1", exactQuote: "Crime is down 87 percent.", normalizedClaim: "Total crime in Washington DC decreased by 87% in 2025.", speaker: "0", startMs: 0, endMs: 1000, checkability: 1, category: "statistic", reason: "Specific statistic", needsUserConfirmation: false },
    transcript: [], planVersions: [], tasks: [], evidence: [{ evidenceId: "e1", taskId: "t1", query: "q", url: "https://example.gov", canonicalUrl: "https://example.gov", title: "Official data", publisher: "example.gov", publishedAt: null, retrievedAt: new Date().toISOString(), excerpt: "Official data shows a 15 percent decline.", surroundingContext: null, sourceKind: "highlight", stance: "contextual", contentHash: "sha256:x", retrievalStatus: "ok" }],
    criticReviews: [], failures: [], budget: budgetValue, approvals: [], verdict: null, confidence: null, summary: null, startedAt: new Date().toISOString(), updatedAt: new Date().toISOString()
  };
  const result = await new EvidenceCriticAgent(new StructuredModel(gateway)).run(context, state);
  assert.equal(result.data?.decision, "ACCEPT");
  assert.equal(result.data?.verdict, "CONTRADICTED");
});
