import { URL } from "node:url";
import type { Claim, EvidenceRecord, EvidenceTask, ResearchDecision, ToolResult } from "../../../../packages/contracts/src/index.js";
import { validateResearchDecision } from "../../../../packages/contracts/src/index.js";
import { RESEARCHER_SYSTEM_V1 } from "../../../../packages/prompts/src/index.js";
import type { StructuredModel } from "../tools/structured-model.js";
import type { SearchTool } from "../tools/search.js";
import type { PageFetcher } from "../tools/page-fetch.js";
import { relevantExcerpt } from "../tools/page-fetch.js";
import type { ExecutionContext } from "../graph/execution-context.js";
import { id } from "../lib/id.js";
import { sha256 } from "../lib/hash.js";

export interface ResearchOutput { evidence: EvidenceRecord[]; failure?: string }

export class ResearcherAgent {
  constructor(private readonly model: StructuredModel, private readonly search: SearchTool, private readonly pages: PageFetcher) {}

  async run(context: ExecutionContext, claim: Claim, task: EvidenceTask): Promise<ResearchOutput> {
    const decision = await context.call({
      actor: "researcher",
      tool: "structured_llm",
      kind: "model",
      reason: `Choose a search strategy for ${task.type}`,
      inputSummary: { claimId: claim.claimId, taskId: task.taskId, taskType: task.type, objective: task.objective },
      summarizeOutput: (output) => ({ shouldSearch: output.shouldSearch, query: output.query, includeDomains: output.includeDomains }),
      operation: () => this.model.generate("researcher", {
        system: RESEARCHER_SYSTEM_V1,
        user: JSON.stringify({ claim, task }),
        temperature: 0.1,
        maxTokens: 600
      }, validateResearchDecision)
    });
    let strategy: ResearchDecision;
    if (!decision.ok || !decision.data) {
      strategy = {
        shouldSearch: true,
        rationale: "Use the planner's query because the researcher model returned invalid output",
        query: task.query,
        includeDomains: [],
        excludeDomains: [],
        maxResults: 3
      };
      await context.tracer.emit({
        actor: "runtime",
        action: "researcher_recovered",
        reason: strategy.rationale,
        status: "ok",
        budgetRemaining: context.budget.remaining(),
        details: { taskId: task.taskId, failure: decision.error?.message ?? "unknown", fallbackQuery: task.query }
      });
    } else {
      strategy = decision.data;
    }
    if (!strategy.shouldSearch) return { evidence: [], failure: strategy.rationale };

    const searchResult = await this.callWithOneRetry(context, "you_search", "search", `Search for evidence: ${strategy.rationale}`, (attempt) => this.search.search(strategy.query, {
      count: strategy.maxResults,
      includeDomains: strategy.includeDomains,
      excludeDomains: strategy.excludeDomains
    }, attempt));
    if (!searchResult.ok || !searchResult.data) return { evidence: [], failure: searchResult.error?.message ?? "Search failed" };

    const evidence: EvidenceRecord[] = [];
    for (const item of searchResult.data.items.slice(0, strategy.maxResults)) {
      const highlights = item.highlights.filter((text) => text.trim().length >= 40).slice(0, 2);
      if (highlights.length) {
        const excerpt = highlights.join("\n\n");
        evidence.push(this.record(task, strategy.query, item.url, item.title, item.pageAge, excerpt, "highlight"));
        continue;
      }
      if (evidence.length > 0 || context.budget.remaining().toolCalls < 2) continue;
      const page = await this.callWithOneRetry(context, "page_fetch", "fetch", "Retrieve a full source because search returned no evidence highlights", (attempt) => this.pages.fetch(item.url, attempt));
      if (page.ok && page.data) {
        evidence.push(this.record(task, strategy.query, page.data.canonicalUrl, page.data.title, page.data.publishedAt, relevantExcerpt(page.data.text, strategy.query), "full_page"));
      }
    }
    return evidence.length ? { evidence } : { evidence: [], failure: "No full-page or highlight evidence was retrievable" };
  }

  private record(task: EvidenceTask, query: string, url: string, title: string, publishedAt: string | null, excerpt: string, sourceKind: EvidenceRecord["sourceKind"]): EvidenceRecord {
    let publisher = "unknown";
    let canonicalUrl = url;
    try { const parsed = new URL(url); publisher = parsed.hostname.replace(/^www\./, ""); parsed.hash = ""; canonicalUrl = parsed.toString(); } catch { /* preserve URL */ }
    return {
      evidenceId: id("ev"), taskId: task.taskId, query, url, canonicalUrl, title, publisher, publishedAt,
      retrievedAt: new Date().toISOString(), excerpt, surroundingContext: null, sourceKind,
      stance: "contextual", contentHash: sha256(excerpt), retrievalStatus: "ok"
    };
  }

  private async callWithOneRetry<T>(context: ExecutionContext, tool: string, kind: "search" | "fetch", reason: string, operation: (attempt: number) => Promise<ToolResult<T>>): Promise<ToolResult<T>> {
    let first = await context.call({ actor: "researcher", tool, kind, reason, inputSummary: { task: reason }, operation: () => operation(1) });
    if (!first.ok && first.error?.retryable && context.budget.remaining().toolCalls > 0) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      first = await context.call({ actor: "researcher", tool, kind, reason: `${reason} (retry after ${first.error.kind})`, inputSummary: { task: reason, retryOf: first.error.kind }, operation: () => operation(2) });
    }
    return first;
  }
}
