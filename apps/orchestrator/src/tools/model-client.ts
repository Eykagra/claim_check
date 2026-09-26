import type { AgentRole, ToolResult, Usage } from "../../../../packages/contracts/src/index.js";
import type { ModelRoute } from "../config/env.js";
import { fetchJson } from "./http.js";

export interface ChatRequest {
  system: string;
  user: string;
  temperature?: number;
  maxTokens?: number;
}

export interface ChatResponse { text: string; usage?: Usage }

function failed<T>(result: ToolResult<unknown>): ToolResult<T> {
  return {
    ok: false,
    error: result.error ?? { kind: "upstream", retryable: false, message: "Unknown provider failure" },
    latencyMs: result.latencyMs,
    attempt: result.attempt,
    ...(result.usage ? { usage: result.usage } : {}),
    ...(result.provider ? { provider: result.provider } : {}),
    ...(result.model ? { model: result.model } : {})
  };
}

export interface ChatProvider {
  readonly name: "openai" | "mistral" | "gemini";
  complete(model: string, request: ChatRequest, attempt: number): Promise<ToolResult<ChatResponse>>;
}

export class OpenAIProvider implements ChatProvider {
  readonly name = "openai" as const;
  constructor(private readonly apiKey: string, private readonly endpoint = "https://api.openai.com/v1/chat/completions") {}
  async complete(model: string, request: ChatRequest, attempt: number): Promise<ToolResult<ChatResponse>> {
    const isGpt5Family = model.startsWith("gpt-5");
    const result = await fetchJson<Record<string, unknown>>(this.endpoint, {
      method: "POST",
      headers: { "Authorization": `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [{ role: "system", content: request.system }, { role: "user", content: request.user }],
        response_format: { type: "json_object" },
        ...(isGpt5Family ? {} : { temperature: request.temperature ?? 0.1 }),
        ...(isGpt5Family
          ? { max_completion_tokens: request.maxTokens ?? 1800 }
          : { max_tokens: request.maxTokens ?? 1800 })
      })
    }, { timeoutMs: 20_000, attempt, provider: this.name });
    if (!result.ok || !result.data) return failed<ChatResponse>(result);
    const data = result.data;
    const choices = Array.isArray(data.choices) ? data.choices as Array<Record<string, unknown>> : [];
    const message = choices[0]?.message as Record<string, unknown> | undefined;
    const text = typeof message?.content === "string" ? message.content : "";
    if (!text) return { ok: false, error: { kind: "malformed", retryable: true, message: "OpenAI response had no message content" }, latencyMs: result.latencyMs, attempt, provider: this.name, model };
    const usageRaw = data.usage as Record<string, unknown> | undefined;
    const usage = usageRaw ? { inputTokens: Number(usageRaw.prompt_tokens ?? 0), outputTokens: Number(usageRaw.completion_tokens ?? 0) } : undefined;
    return { ok: true, data: { text, ...(usage ? { usage } : {}) }, latencyMs: result.latencyMs, attempt, provider: this.name, model };
  }
}

export class MistralProvider implements ChatProvider {
  readonly name = "mistral" as const;
  constructor(private readonly apiKey: string, private readonly endpoint = "https://api.mistral.ai/v1/chat/completions") {}
  async complete(model: string, request: ChatRequest, attempt: number): Promise<ToolResult<ChatResponse>> {
    const result = await fetchJson<Record<string, unknown>>(this.endpoint, {
      method: "POST",
      headers: { "Authorization": `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [{ role: "system", content: request.system }, { role: "user", content: request.user }],
        response_format: { type: "json_object" },
        temperature: request.temperature ?? 0.1,
        max_tokens: request.maxTokens ?? 1800
      })
    }, { timeoutMs: 20_000, attempt, provider: this.name });
    if (!result.ok || !result.data) return failed<ChatResponse>(result);
    const data = result.data;
    const choices = Array.isArray(data.choices) ? data.choices as Array<Record<string, unknown>> : [];
    const message = choices[0]?.message as Record<string, unknown> | undefined;
    const text = typeof message?.content === "string" ? message.content : "";
    if (!text) return { ok: false, error: { kind: "malformed", retryable: true, message: "Mistral response had no message content" }, latencyMs: result.latencyMs, attempt, provider: this.name, model };
    const usageRaw = data.usage as Record<string, unknown> | undefined;
    const usage = usageRaw ? { inputTokens: Number(usageRaw.prompt_tokens ?? 0), outputTokens: Number(usageRaw.completion_tokens ?? 0) } : undefined;
    return { ok: true, data: { text, ...(usage ? { usage } : {}) }, latencyMs: result.latencyMs, attempt, provider: this.name, model };
  }
}

export class GeminiProvider implements ChatProvider {
  readonly name = "gemini" as const;
  constructor(private readonly apiKey: string, private readonly base = "https://generativelanguage.googleapis.com/v1beta/models") {}
  async complete(model: string, request: ChatRequest, attempt: number): Promise<ToolResult<ChatResponse>> {
    const endpoint = `${this.base}/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(this.apiKey)}`;
    const result = await fetchJson<Record<string, unknown>>(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: request.system }] },
        contents: [{ role: "user", parts: [{ text: request.user }] }],
        generationConfig: { temperature: request.temperature ?? 0.1, maxOutputTokens: request.maxTokens ?? 1800, responseMimeType: "application/json" }
      })
    }, { timeoutMs: 20_000, attempt, provider: this.name });
    if (!result.ok || !result.data) return failed<ChatResponse>(result);
    const candidates = Array.isArray(result.data.candidates) ? result.data.candidates as Array<Record<string, unknown>> : [];
    const content = candidates[0]?.content as Record<string, unknown> | undefined;
    const parts = Array.isArray(content?.parts) ? content.parts as Array<Record<string, unknown>> : [];
    const text = parts.map((part) => typeof part.text === "string" ? part.text : "").join("");
    if (!text) return { ok: false, error: { kind: "malformed", retryable: true, message: "Gemini response had no text" }, latencyMs: result.latencyMs, attempt, provider: this.name, model };
    const usageRaw = result.data.usageMetadata as Record<string, unknown> | undefined;
    const usage = usageRaw ? { inputTokens: Number(usageRaw.promptTokenCount ?? 0), outputTokens: Number(usageRaw.candidatesTokenCount ?? 0) } : undefined;
    return { ok: true, data: { text, ...(usage ? { usage } : {}) }, latencyMs: result.latencyMs, attempt, provider: this.name, model };
  }
}

export interface ModelGateway {
  complete(role: AgentRole, request: ChatRequest, attempt: number, forceFallback?: boolean): Promise<ToolResult<ChatResponse>>;
}

export class RoutedModelGateway implements ModelGateway {
  constructor(
    private readonly providers: Map<string, ChatProvider>,
    private readonly routes: Record<AgentRole, ModelRoute>,
    private readonly pricing: Record<string, { inputPerMillion: number; outputPerMillion: number }> = {}
  ) {}

  async complete(role: AgentRole, request: ChatRequest, attempt: number, forceFallback = false): Promise<ToolResult<ChatResponse>> {
    const route = this.routes[role];
    const providerName = forceFallback && route.fallbackProvider ? route.fallbackProvider : route.provider;
    const model = forceFallback && route.fallbackModel ? route.fallbackModel : route.model;
    const provider = this.providers.get(providerName);
    if (!provider) return { ok: false, error: { kind: "auth", retryable: false, message: `${providerName} is not configured` }, latencyMs: 0, attempt, provider: providerName, model };
    if (!model) return { ok: false, error: { kind: "malformed", retryable: false, message: `No model configured for ${role}` }, latencyMs: 0, attempt, provider: providerName, model };
    const result = await provider.complete(model, request, attempt);
    if (result.ok && result.data?.usage) {
      const price = this.pricing[`${providerName}:${model}`];
      if (price) {
        result.data.usage.costUsd =
          ((result.data.usage.inputTokens ?? 0) * price.inputPerMillion
          + (result.data.usage.outputTokens ?? 0) * price.outputPerMillion) / 1_000_000;
      }
    }
    return result;
  }
}
