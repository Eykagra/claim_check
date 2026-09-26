import test from "node:test";
import assert from "node:assert/strict";
import { BudgetController, BudgetExceededError } from "../../apps/orchestrator/src/policies/budget.js";

test("budget enforces tool-call limit", () => {
  const budget = new BudgetController({ deadlineAt: new Date(Date.now() + 10_000).toISOString(), maxToolCalls: 1, usedToolCalls: 0, maxSearchCalls: 1, usedSearchCalls: 0, maxReplans: 0, usedReplans: 0, maxCostUsd: 1, usedCostUsd: 0 });
  budget.beforeCall("model");
  assert.throws(() => budget.beforeCall("model"), (error) => error instanceof BudgetExceededError && error.stopReason === "tool_call_limit");
});
