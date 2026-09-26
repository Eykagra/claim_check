import { URL } from "node:url";
import type { EvidenceRecord, EvidenceTask, ToolResult } from "../../../../packages/contracts/src/index.js";
import type { SearchTool } from "../tools/search.js";
import type { PageFetcher } from "../tools/page-fetch.js";
import { relevantExcerpt } from "../tools/page-fetch.js";
import type { ExecutionContext } from "../graph/execution-context.js";
import { id } from "../lib/id.js";
import { sha256 } from "../lib/hash.js";

export interface ResearchOutput { evidence: EvidenceRecord[]; failure?: string }

/**
 * Deterministic evidence executor. The planner already resolves the query and source policy,
 * so this stage spends no model call: it removes one LLM round trip per research pass and one
 * failure mode (a malformed research decision) from every run.
 */
export class ResearcherAgent {
  constructor(private readonly search: SearchTool, private readonly pages: PageFetcher) {}

  async run(context: ExecutionContext, task: EvidenceTask): Promise<ResearchOutput> {
    const query = task.query.trim();
    if (!query) return { evidence: [], failure: "The plan did not supply a search query" };
    const maxResults = Math.max(1, Math.min(5, Math.round(task.maxResults ?? 3)));
    const includeDomains = task.includeDomains ?? [];
    const excludeDomains = task.excludeDomains ?? [];

    const searchResult = await this.callWithOneRetry(context, "you_search", "search", `Search for evidence: ${task.objective}`, (attempt) =>
      this.search.search(query, { count: maxResults, includeDomains, excludeDomains }, attempt));
    if (!searchResult.ok || !searchResult.data) return { evidence: [], failure: searchResult.error?.message ?? "Search failed" };

    const evidence: EvidenceRecord[] = [];
    for (const item of searchResult.data.items.slice(0, maxResults)) {
      const highlights = item.highlights.filter((text) => text.trim().length >= 40).slice(0, 2);
      if (highlights.length) {
        const excerpt = highlights.join("\n\n");
        evidence.push(this.record(task, query, item.url, item.title, item.pageAge, excerpt, "highlight"));
        continue;
      }
      if (evidence.length > 0 || context.budget.remaining().toolCalls < 2) continue;
      const page = await this.callWithOneRetry(context, "page_fetch", "fetch", "Retrieve a full source because search returned no evidence highlights", (attempt) => this.pages.fetch(item.url, attempt));
      if (page.ok && page.data) {
        evidence.push(this.record(task, query, page.data.canonicalUrl, page.data.title, page.data.publishedAt, relevantExcerpt(page.data.text, query), "full_page"));
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
