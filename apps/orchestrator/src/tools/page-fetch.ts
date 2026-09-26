import type { PageContent, ToolResult } from "../../../../packages/contracts/src/index.js";

export interface PageFetcher { fetch(url: string, attempt: number): Promise<ToolResult<PageContent>> }

export class HttpPageFetcher implements PageFetcher {
  async fetch(url: string, attempt: number): Promise<ToolResult<PageContent>> {
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8_000);
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "https:") {
        return { ok: false, error: { kind: "blocked", retryable: false, message: "Only HTTPS evidence pages are allowed" }, latencyMs: 0, attempt, provider: "page_fetch" };
      }
      const response = await fetch(parsed, { signal: controller.signal, headers: { "User-Agent": "ClaimCheck/0.1 evidence-retriever" }, redirect: "follow" });
      const contentType = response.headers.get("content-type") ?? "";
      if (!response.ok) return { ok: false, error: { kind: response.status === 403 ? "blocked" : "upstream", retryable: response.status >= 500, message: `Page returned HTTP ${response.status}`, status: response.status }, latencyMs: Date.now() - started, attempt, provider: "page_fetch" };
      if (!contentType.includes("text/html") && !contentType.includes("text/plain")) return { ok: false, error: { kind: "blocked", retryable: false, message: `Unsupported content type: ${contentType}` }, latencyMs: Date.now() - started, attempt, provider: "page_fetch" };
      const html = (await response.text()).slice(0, 2_000_000);
      const title = match(html, /<title[^>]*>([\s\S]*?)<\/title>/i) || parsed.hostname;
      const canonical = match(html, /<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)/i) || response.url;
      const publishedAt = match(html, /<meta[^>]+(?:property|name)=["'](?:article:published_time|date)["'][^>]+content=["']([^"']+)/i) || null;
      const text = htmlToText(html);
      return { ok: true, data: { url: response.url, canonicalUrl: canonical, title: decode(title), text, publishedAt, status: response.status }, latencyMs: Date.now() - started, attempt, provider: "page_fetch" };
    } catch (error) {
      const aborted = error instanceof DOMException && error.name === "AbortError";
      return { ok: false, error: { kind: aborted ? "timeout" : "upstream", retryable: true, message: aborted ? "Page fetch timed out" : String(error) }, latencyMs: Date.now() - started, attempt, provider: "page_fetch" };
    } finally { clearTimeout(timer); }
  }
}

function match(value: string, regex: RegExp): string { return regex.exec(value)?.[1]?.trim() ?? ""; }
function decode(value: string): string { return value.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'"); }
function htmlToText(html: string): string {
  return decode(html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()).slice(0, 120_000);
}

export function relevantExcerpt(text: string, query: string, max = 1200): string {
  if (text.length <= max) return text;
  const terms = query.toLowerCase().split(/\W+/).filter((term) => term.length > 3);
  const lower = text.toLowerCase();
  let best = 0;
  let score = -1;
  for (let at = 0; at < text.length; at += 500) {
    const window = lower.slice(at, at + max);
    const current = terms.reduce((sum, term) => sum + (window.includes(term) ? 1 : 0), 0);
    if (current > score) { score = current; best = at; }
  }
  return text.slice(best, best + max).trim();
}
