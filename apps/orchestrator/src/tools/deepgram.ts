import type { ToolResult } from "../../../../packages/contracts/src/index.js";
import { fetchJson } from "./http.js";

export interface TemporaryToken { accessToken: string; expiresIn: number }

export class DeepgramTokenService {
  constructor(private readonly apiKey: string) {}
  async grant(attempt = 1): Promise<ToolResult<TemporaryToken>> {
    const result = await fetchJson<Record<string, unknown>>("https://api.deepgram.com/v1/auth/grant", {
      method: "POST",
      headers: { "Authorization": `Token ${this.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ttl_seconds: 30 })
    }, { timeoutMs: 8_000, attempt, provider: "deepgram" });
    if (!result.ok || !result.data) {
      return {
        ok: false,
        error: result.error ?? { kind: "upstream", retryable: false, message: "Deepgram token grant failed" },
        latencyMs: result.latencyMs,
        attempt: result.attempt,
        ...(result.provider ? { provider: result.provider } : {})
      };
    }
    if (typeof result.data.access_token !== "string") {
      return { ok: false, error: { kind: "malformed", retryable: false, message: "Deepgram grant response lacked access_token" }, latencyMs: result.latencyMs, attempt: result.attempt, provider: "deepgram" };
    }
    return { ...result, data: { accessToken: result.data.access_token, expiresIn: Number(result.data.expires_in ?? 30) } };
  }
}
