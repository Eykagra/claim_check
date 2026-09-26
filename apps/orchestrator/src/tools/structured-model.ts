import type { AgentRole, ToolResult, Usage } from "../../../../packages/contracts/src/index.js";
import { parseJsonObject, ValidationError } from "../../../../packages/contracts/src/index.js";
import type { ChatRequest, ModelGateway } from "./model-client.js";

export class StructuredModel {
  constructor(private readonly gateway: ModelGateway) {}

  async generate<T>(role: AgentRole, request: ChatRequest, validate: (value: unknown) => T): Promise<ToolResult<T>> {
    let repair = "";
    let aggregateLatency = 0;
    let usage: Usage = {};
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const result = await this.gateway.complete(role, { ...request, user: `${request.user}${repair}` }, attempt, attempt === 2);
      aggregateLatency += result.latencyMs;
      usage = mergeUsage(usage, result.data?.usage);
      if (!result.ok || !result.data) {
        // Attempt two uses the configured fallback provider when present. Provider-local
        // auth/model errors are not retryable on that provider, but are recoverable by routing.
        if (attempt === 1) continue;
        return { ...result, latencyMs: aggregateLatency, usage } as ToolResult<T>;
      }
      try {
        const parsed = parseJsonObject(result.data.text);
        return {
          ok: true,
          data: validate(parsed),
          latencyMs: aggregateLatency,
          usage,
          attempt,
          ...(result.provider ? { provider: result.provider } : {}),
          ...(result.model ? { model: result.model } : {})
        };
      } catch (error) {
        if (!(error instanceof ValidationError) || attempt === 2) {
          return {
            ok: false,
            error: { kind: "malformed", retryable: attempt === 1, message: error instanceof Error ? error.message : String(error) },
            latencyMs: aggregateLatency,
            usage,
            attempt,
            ...(result.provider ? { provider: result.provider } : {}),
            ...(result.model ? { model: result.model } : {})
          };
        }
        repair = `\n\nYour previous output failed schema validation: ${error.message}. Return one corrected JSON object only.`;
      }
    }
    return { ok: false, error: { kind: "malformed", retryable: false, message: "Structured generation failed" }, latencyMs: aggregateLatency, usage, attempt: 2 };
  }
}

function mergeUsage(a: Usage, b?: Usage): Usage {
  return {
    inputTokens: (a.inputTokens ?? 0) + (b?.inputTokens ?? 0),
    outputTokens: (a.outputTokens ?? 0) + (b?.outputTokens ?? 0),
    costUsd: (a.costUsd ?? 0) + (b?.costUsd ?? 0)
  };
}
