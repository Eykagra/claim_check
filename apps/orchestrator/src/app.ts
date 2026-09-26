import { loadConfig, type AppConfig } from "./config/env.js";
import { ClaimExtractorAgent } from "./agents/claim-extractor.js";
import { PlannerAgent } from "./agents/planner.js";
import { ResearcherAgent } from "./agents/researcher.js";
import { EvidenceCriticAgent } from "./agents/critic.js";
import { RunEngine } from "./graph/run-engine.js";
import { FileRunStore } from "./store/file-store.js";
import { DeepgramTokenService } from "./tools/deepgram.js";
import { HttpPageFetcher } from "./tools/page-fetch.js";
import { GeminiProvider, MistralProvider, OpenAIProvider, RoutedModelGateway, type ChatProvider } from "./tools/model-client.js";
import { YouSearchTool, type SearchTool } from "./tools/search.js";
import { StructuredModel } from "./tools/structured-model.js";
import type { SearchResponse, ToolResult } from "../../../packages/contracts/src/index.js";
import { createHttpServer } from "./http/server.js";

class UnavailableSearch implements SearchTool {
  async search(_query: string, _options: Parameters<SearchTool["search"]>[1], attempt: number): Promise<ToolResult<SearchResponse>> {
    return { ok: false, error: { kind: "auth", retryable: false, message: "YOU_API_KEY is not configured" }, latencyMs: 0, attempt, provider: "you.com" };
  }
}

export function buildApplication(config: AppConfig = loadConfig()) {
  const providers = new Map<string, ChatProvider>();
  if (config.keys.openai) providers.set("openai", new OpenAIProvider(config.keys.openai));
  if (config.keys.mistral) providers.set("mistral", new MistralProvider(config.keys.mistral));
  if (config.keys.gemini) providers.set("gemini", new GeminiProvider(config.keys.gemini));
  const structuredModel = new StructuredModel(new RoutedModelGateway(providers, config.routes, config.pricing));
  const search: SearchTool = config.keys.you ? new YouSearchTool(config.keys.you) : new UnavailableSearch();
  const pages = new HttpPageFetcher();
  const store = new FileRunStore(config.dataDir);
  const extractor = new ClaimExtractorAgent(structuredModel);
  const planner = new PlannerAgent(structuredModel);
  const researcher = new ResearcherAgent(search, pages);
  const critic = new EvidenceCriticAgent(structuredModel);
  const engine = new RunEngine(planner, researcher, critic, store, store, config.budgets);
  const deepgram = config.keys.deepgram ? new DeepgramTokenService(config.keys.deepgram) : null;
  const server = createHttpServer({ extractor, engine, store, traceSink: store, deepgram, allowedOrigins: config.allowedOrigins });
  return { config, server, services: { extractor, planner, researcher, critic, engine, store, structuredModel, search, pages, deepgram } };
}
