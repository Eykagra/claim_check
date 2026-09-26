import test from "node:test";
import assert from "node:assert/strict";
import { ValidationError, validateClaimExtraction, validatePlan } from "../../packages/contracts/src/index.js";

test("claim extraction rejects confidence outside 0..1", () => {
  assert.throws(() => validateClaimExtraction({ claims: [{ claimId: "c1", exactQuote: "x", normalizedClaim: "x", speaker: null, startMs: 0, endMs: 1, checkability: 4, category: "event", reason: "x", needsUserConfirmation: false }] }), ValidationError);
});

test("plan validator normalizes task status", () => {
  const plan = validatePlan({ version: 1, decision: "CONTINUE", rationale: "Find official data", tasks: [{ taskId: "t1", type: "CHECK_OFFICIAL_STATISTIC", objective: "Find the value", query: "official value", expectedEvidence: "Official table", priority: 1 }] });
  assert.equal(plan.tasks[0]?.status, "pending");
});
