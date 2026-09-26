import type { CriticReview, Plan, RunState, ToolResult } from "../../../../packages/contracts/src/index.js";
import { validatePlan } from "../../../../packages/contracts/src/index.js";
import { PLANNER_SYSTEM_V1 } from "../../../../packages/prompts/src/index.js";
import type { StructuredModel } from "../tools/structured-model.js";
import type { ExecutionContext } from "../graph/execution-context.js";
import { id } from "../lib/id.js";

export class PlannerAgent {
  constructor(private readonly model: StructuredModel) {}

  run(context: ExecutionContext, state: RunState, previousReview: CriticReview | null): Promise<ToolResult<Plan>> {
    const version = state.planVersions.length + 1;
    return context.call({
      actor: "planner",
      tool: "structured_llm",
      kind: "model",
      reason: previousReview ? "Revise the evidence plan around critic-identified gaps" : "Determine what evidence would settle the selected claim",
      inputSummary: { claimId: state.claim.claimId, claim: state.claim.normalizedClaim, criticGaps: previousReview?.gaps ?? [] },
      summarizeOutput: (plan) => ({ version: plan.version, decision: plan.decision, tasks: plan.tasks.map((task) => ({ taskId: task.taskId, type: task.type, query: task.query })) }),
      operation: () => this.model.generate("planner", {
        system: PLANNER_SYSTEM_V1,
        user: JSON.stringify({
          version,
          claim: state.claim,
          completedTasks: state.tasks.filter((task) => task.status === "completed").map((task) => ({ type: task.type, query: task.query })),
          evidenceSummary: state.evidence.map((evidence) => ({ evidenceId: evidence.evidenceId, url: evidence.url, excerpt: evidence.excerpt.slice(0, 500) })),
          criticGaps: previousReview?.gaps ?? [],
          recommendedNextTasks: previousReview?.recommendedNextTasks ?? [],
          budgetRemaining: context.budget.remaining()
        }),
        temperature: 0.1,
        maxTokens: 1200
      }, (value) => {
        const plan = validatePlan(normalizePlanDraft(value, version));
        return { ...plan, version };
      })
    });
  }
}

function normalizePlanDraft(value: unknown, version: number): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const outer = value as Record<string, unknown>;
  const root = outer.plan && typeof outer.plan === "object" && !Array.isArray(outer.plan)
    ? outer.plan as Record<string, unknown>
    : outer;
  const decision = typeof root.decision === "string" ? root.decision.trim().toUpperCase() : root.decision;
  const tasks = Array.isArray(root.tasks) ? root.tasks : [];
  return {
    ...root,
    version,
    decision,
    tasks: tasks.map((raw) => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
      const task = raw as Record<string, unknown>;
      const type = typeof task.type === "string"
        ? task.type.trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_")
        : task.type;
      const parsedPriority = Number(task.priority);
      return {
        ...task,
        taskId: typeof task.taskId === "string" && task.taskId.trim() ? task.taskId : id("task"),
        type,
        priority: Number.isFinite(parsedPriority) ? Math.max(1, Math.min(3, Math.round(parsedPriority))) : 1
      };
    })
  };
}
