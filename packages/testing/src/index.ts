import type { AgentRole, PageContent, SearchResponse, ToolResult } from "../../contracts/src/index.js";
import type { ChatRequest, ChatResponse, ModelGateway } from "../../../apps/orchestrator/src/tools/model-client.js";
import type { SearchOptions, SearchTool } from "../../../apps/orchestrator/src/tools/search.js";
import type { PageFetcher } from "../../../apps/orchestrator/src/tools/page-fetch.js";

export class ScriptedModelGateway implements ModelGateway {
  readonly calls: Array<{ role: AgentRole; request: ChatRequest; attempt: number }> = [];
  constructor(private readonly scripts: Record<AgentRole, unknown[]>) {}
  async complete(role: AgentRole, request: ChatRequest, attempt: number): Promise<ToolResult<ChatResponse>> {
    this.calls.push({ role, request, attempt });
    const next = this.scripts[role].shift();
    if (next === undefined) return { ok: false, error: { kind: "upstream", retryable: false, message: `No scripted ${role} response` }, latencyMs: 1, attempt, provider: "scripted", model: "fixture" };
    if (next instanceof Error) return { ok: false, error: { kind: "upstream", retryable: true, message: next.message }, latencyMs: 1, attempt, provider: "scripted", model: "fixture" };
    return { ok: true, data: { text: typeof next === "string" ? next : JSON.stringify(next), usage: { inputTokens: 10, outputTokens: 10, costUsd: 0.001 } }, latencyMs: 1, attempt, provider: "scripted", model: "fixture" };
  }
}

export class FixtureSearch implements SearchTool {
  calls = 0;
  constructor(private readonly response: SearchResponse, private readonly failFirst = false) {}
  async search(_query: string, _options: SearchOptions, attempt: number): Promise<ToolResult<SearchResponse>> {
    this.calls += 1;
    if (this.failFirst && this.calls === 1) return { ok: false, error: { kind: "upstream", retryable: true, message: "Injected HTTP 500" }, latencyMs: 1, attempt, provider: "fixture_search" };
    return { ok: true, data: structuredClone(this.response), latencyMs: 1, attempt, provider: "fixture_search" };
  }
}

export class FixturePageFetcher implements PageFetcher {
  async fetch(url: string, attempt: number): Promise<ToolResult<PageContent>> {
    return { ok: true, data: { url, canonicalUrl: url, title: "Fixture page", text: "Fixture content", publishedAt: null, status: 200 }, latencyMs: 1, attempt, provider: "fixture_page" };
  }
}
