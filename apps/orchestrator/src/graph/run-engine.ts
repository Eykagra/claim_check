import type { Claim, CriticReview, FailureRecord, Plan, RunBudget, RunState, StopReason, TranscriptSegment } from "../../../../packages/contracts/src/index.js";
import { id } from "../lib/id.js";
import { BudgetController, BudgetExceededError } from "../policies/budget.js";
import type { RunStore } from "../store/file-store.js";
import type { TraceSink } from "../telemetry/tracer.js";
import { Tracer } from "../telemetry/tracer.js";
import { ExecutionContext } from "./execution-context.js";
import type { PlannerAgent } from "../agents/planner.js";
import type { ResearcherAgent } from "../agents/researcher.js";
import type { EvidenceCriticAgent } from "../agents/critic.js";

export interface RunLimits {
  deadlineMs: number;
  maxToolCalls: number;
  maxSearchCalls: number;
  maxReplans: number;
  maxCostUsd: number;
}

export interface CreateRunInput { claim: Claim; transcript?: TranscriptSegment[] }

export class RunEngine {
  constructor(
    private readonly planner: PlannerAgent,
    private readonly researcher: ResearcherAgent,
    private readonly critic: EvidenceCriticAgent,
    private readonly store: RunStore,
    private readonly traceSink: TraceSink,
    private readonly limits: RunLimits
  ) {}

  async run(input: CreateRunInput): Promise<RunState> {
    const state = this.initialState(input);
    const tracer = new Tracer(state.runId, this.traceSink);
    const budget = new BudgetController(state.budget);
    const context = new ExecutionContext(budget, tracer);
    await this.store.save(state);
    await tracer.emit({ actor: "runtime", action: "run_started", reason: "User selected a claim for checking", status: "started", budgetRemaining: budget.remaining(), details: { claimId: state.claim.claimId, claim: state.claim.normalizedClaim } });

    let previousReview: CriticReview | null = null;
    try {
      while (true) {
        budget.assertTime();
        state.status = "PLANNING";
        this.touch(state);
        await this.store.save(state);
        await tracer.emit({ actor: "planner", action: "agent_started", reason: previousReview ? "Critic rejected the prior evidence" : "A selected claim needs an evidence plan", status: "started", budgetRemaining: budget.remaining() });

        const planResult = await this.planner.run(context, state, previousReview);
        let plan: Plan;
        if (!planResult.ok || !planResult.data) {
          this.recordFailure(state, "planner", "plan", planResult.error?.kind ?? "upstream", planResult.error?.message ?? "Planner failed", planResult.error?.retryable ?? false);
          if (budget.remaining().toolCalls < 3) {
            return await this.finish(state, tracer, "UNCLEAR", 0, "The planner failed and the remaining budget cannot safely support research and criticism.", "tool_call_limit");
          }
          plan = this.fallbackPlan(state, planResult.error?.message ?? "Planner returned invalid output");
          await tracer.emit({
            actor: "runtime",
            action: "planner_recovered",
            reason: "The planner failed, so the runtime generated one conservative evidence task instead of collapsing the run.",
            status: "ok",
            budgetRemaining: budget.remaining(),
            details: { failure: planResult.error?.message ?? "unknown", task: plan.tasks[0] }
          });
        } else {
          plan = planResult.data;
        }
        state.planVersions.push(plan);
        state.tasks.push(...plan.tasks);
        await tracer.emit({ actor: "planner", action: "plan_created", reason: plan.rationale, status: "ok", budgetRemaining: budget.remaining(), details: { version: plan.version, decision: plan.decision, taskIds: plan.tasks.map((task) => task.taskId) } });
        await this.store.save(state);

        if (plan.decision === "NEEDS_HUMAN") return await this.finish(state, tracer, "UNCLEAR", 0, plan.rationale, "needs_human");
        if (plan.decision === "STOP" || plan.tasks.length === 0) return await this.finish(state, tracer, "UNCLEAR", 0, plan.rationale, "planner_stopped");

        state.status = "RESEARCHING";
        this.touch(state);
        const task = [...plan.tasks].sort((a, b) => a.priority - b.priority)[0]!;
        task.status = "running";
        await tracer.emit({ actor: "planner", action: "task_delegated", reason: task.objective, status: "ok", budgetRemaining: budget.remaining(), details: { taskId: task.taskId, type: task.type, query: task.query, expectedEvidence: task.expectedEvidence, assignee: "researcher" } });
        await this.store.save(state);

        const research = await this.researcher.run(context, task);
        if (research.evidence.length) {
          task.status = "completed";
          state.evidence.push(...research.evidence);
          await tracer.emit({ actor: "researcher", action: "evidence_added", reason: `Collected ${research.evidence.length} evidence record(s)`, status: "ok", budgetRemaining: budget.remaining(), details: { taskId: task.taskId, evidence: research.evidence.map((item) => ({ evidenceId: item.evidenceId, title: item.title, url: item.url, sourceKind: item.sourceKind })) } });
        } else {
          task.status = "failed";
          task.failure = research.failure ?? "No evidence returned";
          this.recordFailure(state, "researcher", task.taskId, "upstream", task.failure, true);
          await tracer.emit({ actor: "researcher", action: "task_failed", reason: task.failure, status: "failed", budgetRemaining: budget.remaining(), details: { taskId: task.taskId } });
        }
        await this.store.save(state);

        state.status = "CRITIQUING";
        this.touch(state);
        await tracer.emit({ actor: "critic", action: "agent_started", reason: "Research is complete or degraded; independent review is required", status: "started", budgetRemaining: budget.remaining() });
        const criticResult = await this.critic.run(context, state);
        let review: CriticReview;
        if (!criticResult.ok || !criticResult.data) {
          const message = criticResult.error?.message ?? "Critic failed";
          this.recordFailure(state, "critic", "critique", criticResult.error?.kind ?? "upstream", message, criticResult.error?.retryable ?? false);
          // A failed critic must not erase collected evidence. Degrade to a conservative,
          // evidence-preserving review so the run reports what it actually found.
          review = this.fallbackReview(state, message);
          await tracer.emit({
            actor: "runtime",
            action: "critic_recovered",
            reason: "Independent review failed, so the runtime issued a conservative UNCLEAR review that preserves the collected evidence.",
            status: "ok",
            budgetRemaining: budget.remaining(),
            details: { failure: message, evidenceCount: state.evidence.length, confidence: review.confidence }
          });
        } else {
          review = criticResult.data;
        }
        state.criticReviews.push(review);
        previousReview = review;
        await tracer.emit({ actor: "critic", action: "review_completed", reason: review.reasoningSummary, status: "ok", budgetRemaining: budget.remaining(), details: { decision: review.decision, verdict: review.verdict, confidence: review.confidence, gaps: review.gaps } });
        await this.store.save(state);

        if (review.decision === "ACCEPT" || review.decision === "UNCLEAR") {
          return await this.finish(state, tracer, review.verdict, review.confidence, review.reasoningSummary, "critic_accepted");
        }

        if (budget.remaining().replans <= 0 || budget.remaining().toolCalls < 4) {
          return await this.finish(
            state,
            tracer,
            "UNCLEAR",
            Math.min(review.confidence, 0.6),
            `The critic did not accept the evidence packet as sufficient. ${review.reasoningSummary} Remaining budget cannot support another research pass.`,
            "replan_limit"
          );
        }
        budget.useReplan();
        await tracer.emit({ actor: "runtime", action: "replan_authorized", reason: `Critic rejected evidence: ${review.gaps.join("; ")}`, status: "ok", budgetRemaining: budget.remaining() });
      }
    } catch (error) {
      if (error instanceof BudgetExceededError) {
        return await this.finish(state, tracer, "UNCLEAR", previousReview?.confidence ?? 0, `Stopped safely: ${error.message}`, error.stopReason);
      }
      this.recordFailure(state, "runtime", "run", "unhandled", error instanceof Error ? error.message : String(error), false);
      return await this.finish(state, tracer, "UNCLEAR", 0, "The run ended after an unrecoverable internal error.", "unrecoverable_failure");
    }
  }

  private initialState(input: CreateRunInput): RunState {
    const now = Date.now();
    const budget: RunBudget = {
      deadlineAt: new Date(now + this.limits.deadlineMs).toISOString(),
      maxToolCalls: this.limits.maxToolCalls, usedToolCalls: 0,
      maxSearchCalls: this.limits.maxSearchCalls, usedSearchCalls: 0,
      maxReplans: this.limits.maxReplans, usedReplans: 0,
      maxCostUsd: this.limits.maxCostUsd, usedCostUsd: 0
    };
    return {
      runId: id("run"), status: "CREATED", claim: input.claim, transcript: input.transcript ?? [],
      planVersions: [], tasks: [], evidence: [], criticReviews: [], failures: [], budget, approvals: [],
      verdict: null, confidence: null, summary: null,
      startedAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString()
    };
  }

  private recordFailure(state: RunState, actor: FailureRecord["actor"], step: string, kind: string, message: string, retryable: boolean): void {
    state.failures.push({ actor, step, kind, message, retryable, time: new Date().toISOString() });
  }

  private fallbackPlan(state: RunState, failure: string): Plan {
    const type = state.claim.category === "statistic"
      ? "CHECK_OFFICIAL_STATISTIC"
      : state.claim.category === "quote"
        ? "VERIFY_QUOTE"
        : "FIND_PRIMARY_RECORD";
    return {
      version: state.planVersions.length + 1,
      decision: "CONTINUE",
      rationale: `Conservative runtime fallback after planner failure: ${failure}`,
      tasks: [{
        taskId: id("task"),
        type,
        objective: `Find a primary or authoritative source that directly confirms or contradicts: ${state.claim.normalizedClaim}`,
        query: `\"${state.claim.normalizedClaim}\" official source`,
        expectedEvidence: "A full-page passage from a primary or authoritative source that directly addresses the claim",
        priority: 1,
        status: "pending"
      }]
    };
  }

  private fallbackReview(state: RunState, failure: string): CriticReview {
    const evidenceIds = state.evidence.map((item) => item.evidenceId);
    return {
      decision: "UNCLEAR",
      verdict: "UNCLEAR",
      confidence: evidenceIds.length ? 0.2 : 0,
      reasoningSummary: evidenceIds.length
        ? `Independent review could not be completed (${failure}), so no verdict is asserted. ${evidenceIds.length} source(s) were collected and are listed unreviewed for manual inspection.`
        : `Independent review could not be completed (${failure}) and no evidence was collected, so no verdict is asserted.`,
      acceptedEvidenceIds: evidenceIds,
      rejectedEvidence: [],
      gaps: ["Automated review failed before a verdict could be established; the listed sources have not been independently checked."],
      recommendedNextTasks: []
    };
  }

  private touch(state: RunState): void { state.updatedAt = new Date().toISOString(); }

  private async finish(state: RunState, tracer: Tracer, verdict: RunState["verdict"], confidence: number, summary: string, stopReason: StopReason): Promise<RunState> {
    state.status = "COMPLETED";
    state.verdict = verdict;
    state.confidence = confidence;
    state.summary = summary;
    state.stopReason = stopReason;
    this.touch(state);
    await this.store.save(state);
    await tracer.emit({ actor: "runtime", action: "run_stopped", reason: summary, status: "stopped", details: { verdict, confidence, stopReason } });
    return state;
  }
}
