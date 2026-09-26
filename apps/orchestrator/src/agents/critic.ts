import type { CriticReview, RunState, ToolResult } from "../../../../packages/contracts/src/index.js";
import { validateCriticReview } from "../../../../packages/contracts/src/index.js";
import { CRITIC_SYSTEM_V1 } from "../../../../packages/prompts/src/index.js";
import type { StructuredModel } from "../tools/structured-model.js";
import type { ExecutionContext } from "../graph/execution-context.js";

export class EvidenceCriticAgent {
  constructor(private readonly model: StructuredModel) {}

  run(context: ExecutionContext, state: RunState): Promise<ToolResult<CriticReview>> {
    return context.call({
      actor: "critic",
      tool: "structured_llm",
      kind: "model",
      reason: "Independently test whether the collected evidence settles the claim",
      inputSummary: { claimId: state.claim.claimId, evidenceIds: state.evidence.map((item) => item.evidenceId), failedTaskIds: state.tasks.filter((task) => task.status === "failed").map((task) => task.taskId) },
      summarizeOutput: (review) => ({ decision: review.decision, verdict: review.verdict, confidence: review.confidence, gaps: review.gaps }),
      operation: () => this.model.generate("critic", {
        system: CRITIC_SYSTEM_V1,
        user: JSON.stringify({
          claim: state.claim,
          tasks: state.tasks,
          evidence: state.evidence.map((item) => ({
            evidenceId: item.evidenceId, taskId: item.taskId, url: item.url, title: item.title,
            publisher: item.publisher, publishedAt: item.publishedAt, sourceKind: item.sourceKind, excerpt: item.excerpt
          })),
          failures: state.failures,
          budgetRemaining: context.budget.remaining()
        }),
        temperature: 0,
        maxTokens: 1400
      }, (value) => normalizeReview(validateCriticReview(value)))
    });
  }
}

function normalizeReview(review: CriticReview): CriticReview {
  if (review.decision === "REJECT" && review.gaps.length === 0 && review.acceptedEvidenceIds.length > 0 && review.verdict !== "UNCLEAR") {
    return { ...review, decision: "ACCEPT" };
  }
  if (review.decision === "REJECT" && review.gaps.length === 0 && review.recommendedNextTasks.length === 0) {
    return {
      ...review,
      decision: "UNCLEAR",
      verdict: "UNCLEAR",
      confidence: Math.min(review.confidence, 0.5),
      reasoningSummary: `The evidence packet was not accepted and no actionable research gap was provided. ${review.reasoningSummary}`
    };
  }
  if (review.decision === "UNCLEAR" && review.verdict !== "UNCLEAR") {
    return { ...review, verdict: "UNCLEAR", confidence: Math.min(review.confidence, 0.6) };
  }
  return review;
}
