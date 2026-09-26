import test from "node:test";
import assert from "node:assert/strict";
import { ClaimExtractorAgent } from "../../apps/orchestrator/src/agents/claim-extractor.js";
import { StructuredModel } from "../../apps/orchestrator/src/tools/structured-model.js";
import { ScriptedModelGateway } from "../../packages/testing/src/index.js";

test("claim quality gate removes predictions and unresolved-context claims", async () => {
  const gateway = new ScriptedModelGateway({
    claim_extractor: [{ claims: [
      { claimId: "good", exactQuote: "Crime in Washington DC is now down 87 percent.", normalizedClaim: "Total crime in Washington DC decreased by 87% between January 20, 2025 and September 2026.", speaker: "0", startMs: 1000, endMs: 3000, checkability: 1, category: "statistic", reason: "Specific statistic with entity and timeframe", needsUserConfirmation: false },
      { claimId: "short-duplicate", exactQuote: "Crime is down 87 percent.", normalizedClaim: "Crime in Washington DC decreased by 87%.", speaker: "0", startMs: 1800, endMs: 3000, checkability: 1, category: "statistic", reason: "Shorter duplicate missing timeframe", needsUserConfirmation: false },
      { claimId: "future", exactQuote: "And we're going for a hundred.", normalizedClaim: "The speaker intends to achieve a 100% reduction in crime.", speaker: "0", startMs: 3100, endMs: 4000, checkability: 0.8, category: "other", reason: "Future target", needsUserConfirmation: false },
      { claimId: "vague", exactQuote: "Crime is down 87 percent.", normalizedClaim: "Crime decreased by 87% in the referenced location.", speaker: "0", startMs: 1000, endMs: 3000, checkability: 1, category: "statistic", reason: "Missing location", needsUserConfirmation: false }
    ] }],
    planner: [], critic: []
  });
  const agent = new ClaimExtractorAgent(new StructuredModel(gateway));
  const result = await agent.extract([{ id: "s1", text: "When I arrived in Washington DC on January twentieth last year, it was riddled with crime and now crime is down 87 percent. And we're going for a hundred.", startMs: 0, endMs: 5000, confidence: 0.99, speaker: "0", isFinal: true }], { title: "Speech", url: "https://example.com", publishedAt: "2026-09-01" });
  assert.equal(result.ok, true);
  assert.deepEqual(result.data?.claims.map((claim) => claim.claimId), ["good"]);
});
