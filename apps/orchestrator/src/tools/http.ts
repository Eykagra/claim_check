import type { ToolError, ToolResult } from "../../../../packages/contracts/src/index.js";

export async function fetchJson<T>(
  url: string,
  init: RequestInit,
  options: { timeoutMs: number; attempt: number; provider: string }
): Promise<ToolResult<T>> {
  const started = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const text = await response.text();
    if (!response.ok) {
      return {
        ok: false,
        error: classifyHttpError(response.status, text),
        latencyMs: Date.now() - started,
        attempt: options.attempt,
        provider: options.provider
      };
    }
    try {
      return { ok: true, data: JSON.parse(text) as T, latencyMs: Date.now() - started, attempt: options.attempt, provider: options.provider };
    } catch {
      return {
        ok: false,
        error: { kind: "malformed", retryable: false, message: `${options.provider} returned non-JSON data` },
        latencyMs: Date.now() - started,
        attempt: options.attempt,
        provider: options.provider
      };
    }
  } catch (error) {
    const aborted = error instanceof DOMException && error.name === "AbortError";
    return {
      ok: false,
      error: { kind: aborted ? "timeout" : "upstream", retryable: true, message: aborted ? `${options.provider} timed out` : String(error) },
      latencyMs: Date.now() - started,
      attempt: options.attempt,
      provider: options.provider
    };
  } finally {
    clearTimeout(timeout);
  }
}

function classifyHttpError(status: number, body: string): ToolError {
  const message = body.slice(0, 500) || `HTTP ${status}`;
  if (status === 401 || status === 403) return { kind: "auth", retryable: false, message, status };
  if (status === 408 || status === 504) return { kind: "timeout", retryable: true, message, status };
  if (status === 429) return { kind: "rate_limit", retryable: true, message, status };
  if (status >= 500) return { kind: "upstream", retryable: true, message, status };
  return { kind: "upstream", retryable: false, message, status };
}
