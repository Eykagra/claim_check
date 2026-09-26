import type { SearchResponse, SearchResultItem, ToolResult } from "../../../../packages/contracts/src/index.js";
import { fetchJson } from "./http.js";

export interface SearchOptions {
  count: number;
  includeDomains?: string[];
  excludeDomains?: string[];
  language?: string;
  country?: string;
}

export interface SearchTool {
  search(query: string, options: SearchOptions, attempt: number): Promise<ToolResult<SearchResponse>>;
}

export class YouSearchTool implements SearchTool {
  constructor(private readonly apiKey: string, private readonly endpoint = "https://ydc-index.io/v1/search") {}

  async search(query: string, options: SearchOptions, attempt: number): Promise<ToolResult<SearchResponse>> {
    const result = await fetchJson<Record<string, unknown>>(this.endpoint, {
      method: "POST",
      headers: { "X-API-Key": this.apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        query,
        count: Math.min(5, Math.max(1, options.count)),
        language: options.language ?? "EN",
        country: options.country ?? "US",
        safesearch: "moderate",
        extraction: { extraction_mode: "highlights" },
        ...(options.includeDomains?.length ? { include_domains: options.includeDomains } : {}),
        ...(options.excludeDomains?.length ? { exclude_domains: options.excludeDomains } : {})
      })
    }, { timeoutMs: 12_000, attempt, provider: "you.com" });
    if (!result.ok || !result.data) {
      return {
        ok: false,
        error: result.error ?? { kind: "upstream", retryable: false, message: "You.com search failed" },
        latencyMs: result.latencyMs,
        attempt: result.attempt,
        ...(result.provider ? { provider: result.provider } : {})
      };
    }
    const root = result.data.results as Record<string, unknown> | undefined;
    const web = Array.isArray(root?.web) ? root.web as Array<Record<string, unknown>> : [];
    const items: SearchResultItem[] = web.flatMap((item) => {
      if (typeof item.url !== "string" || typeof item.title !== "string") return [];
      const contents = item.contents as Record<string, unknown> | undefined;
      return [{
        url: item.url,
        title: item.title,
        description: typeof item.description === "string" ? item.description : "",
        snippets: Array.isArray(item.snippets) ? item.snippets.filter((v): v is string => typeof v === "string") : [],
        highlights: Array.isArray(contents?.highlights) ? contents.highlights.filter((v): v is string => typeof v === "string") : [],
        pageAge: typeof item.page_age === "string" ? item.page_age : null
      }];
    });
    return { ...result, data: { query, items } };
  }
}
