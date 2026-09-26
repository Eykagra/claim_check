import type { RunBudget, StopReason, Usage } from "../../../../packages/contracts/src/index.js";

export class BudgetExceededError extends Error {
  constructor(public readonly stopReason: StopReason, message: string) {
    super(message);
    this.name = "BudgetExceededError";
  }
}

export class BudgetController {
  constructor(public readonly value: RunBudget) {}

  beforeCall(kind: "model" | "search" | "fetch" | "other"): void {
    this.assertTime();
    if (this.value.usedToolCalls >= this.value.maxToolCalls) {
      throw new BudgetExceededError("tool_call_limit", "External tool-call budget exhausted");
    }
    if (kind === "search" && this.value.usedSearchCalls >= this.value.maxSearchCalls) {
      throw new BudgetExceededError("tool_call_limit", "Search-call budget exhausted");
    }
    if (this.value.usedCostUsd >= this.value.maxCostUsd) {
      throw new BudgetExceededError("cost_limit", "Run cost budget exhausted");
    }
    this.value.usedToolCalls += 1;
    if (kind === "search") this.value.usedSearchCalls += 1;
  }

  recordUsage(usage?: Usage): void {
    this.value.usedCostUsd += usage?.costUsd ?? 0;
    if (this.value.usedCostUsd > this.value.maxCostUsd) {
      throw new BudgetExceededError("cost_limit", "Run exceeded its cost budget");
    }
  }

  useReplan(): void {
    if (this.value.usedReplans >= this.value.maxReplans) {
      throw new BudgetExceededError("replan_limit", "Replan budget exhausted");
    }
    this.value.usedReplans += 1;
  }

  assertTime(): void {
    if (Date.now() >= Date.parse(this.value.deadlineAt)) {
      throw new BudgetExceededError("deadline", "Run deadline exceeded");
    }
  }

  remaining() {
    return {
      toolCalls: Math.max(0, this.value.maxToolCalls - this.value.usedToolCalls),
      searchCalls: Math.max(0, this.value.maxSearchCalls - this.value.usedSearchCalls),
      replans: Math.max(0, this.value.maxReplans - this.value.usedReplans),
      timeMs: Math.max(0, Date.parse(this.value.deadlineAt) - Date.now()),
      costUsd: Math.max(0, this.value.maxCostUsd - this.value.usedCostUsd)
    };
  }
}
