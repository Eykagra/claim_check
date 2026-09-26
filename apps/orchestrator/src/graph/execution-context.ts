import type { AgentRole, ToolResult } from "../../../../packages/contracts/src/index.js";
import { BudgetController } from "../policies/budget.js";
import { Tracer } from "../telemetry/tracer.js";
import { sha256, stableJson } from "../lib/hash.js";

export class ExecutionContext {
  constructor(public readonly budget: BudgetController, public readonly tracer: Tracer) {}

  async call<T>(input: {
    actor: AgentRole;
    tool: string;
    kind: "model" | "search" | "fetch" | "other";
    reason: string;
    inputSummary?: unknown;
    summarizeOutput?: (data: T) => unknown;
    operation: () => Promise<ToolResult<T>>;
  }): Promise<ToolResult<T>> {
    this.budget.beforeCall(input.kind);
    await this.tracer.emit({
      actor: input.actor,
      action: "tool_call_started",
      reason: input.reason,
      ...(input.inputSummary === undefined ? {} : { inputRef: sha256(stableJson(input.inputSummary)) }),
      tool: input.tool,
      attempt: 1,
      budgetRemaining: this.budget.remaining(),
      status: "started",
      ...(input.inputSummary === undefined ? {} : { details: { input: input.inputSummary } })
    });
    const result = await input.operation();
    this.budget.recordUsage(result.usage);
    await this.tracer.emit({
      actor: input.actor,
      action: result.ok ? "tool_call_completed" : "tool_call_failed",
      reason: result.ok ? input.reason : result.error?.message ?? input.reason,
      ...(result.ok && result.data !== undefined ? {
        outputRef: sha256(stableJson(input.summarizeOutput ? input.summarizeOutput(result.data) : result.data))
      } : {}),
      tool: input.tool,
      attempt: result.attempt,
      latencyMs: result.latencyMs,
      ...(result.usage ? { usage: result.usage } : {}),
      budgetRemaining: this.budget.remaining(),
      status: result.ok ? "ok" : "failed",
      details: {
        ...(result.provider ? { provider: result.provider } : {}),
        ...(result.model ? { model: result.model } : {}),
        ...(result.error ? { errorKind: result.error.kind, retryable: result.error.retryable } : {})
      }
    });
    return result;
  }
}
