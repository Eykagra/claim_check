import type { AgentRole } from "../../../../packages/contracts/src/index.js";

export interface ModelRoute {
  provider: "openai" | "mistral" | "gemini";
  model: string;
  fallbackProvider?: "openai" | "mistral" | "gemini";
  fallbackModel?: string;
}

export interface AppConfig {
  port: number;
  host: string;
  dataDir: string;
  allowedOrigins: string[];
  keys: { openai?: string; mistral?: string; gemini?: string; you?: string; deepgram?: string };
  routes: Record<AgentRole, ModelRoute>;
  pricing: Record<string, { inputPerMillion: number; outputPerMillion: number }>;
  budgets: { deadlineMs: number; maxToolCalls: number; maxSearchCalls: number; maxReplans: number; maxCostUsd: number };
}

const numberEnv = (name: string, fallback: number): number => {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative number`);
  return parsed;
};

const route = (role: "CLAIM_EXTRACTOR" | "PLANNER" | "RESEARCHER" | "CRITIC", defaultProvider: ModelRoute["provider"]): ModelRoute => {
  const provider = (process.env[`${role}_PROVIDER`] ?? defaultProvider) as ModelRoute["provider"];
  if (!["openai", "mistral", "gemini"].includes(provider)) throw new Error(`${role}_PROVIDER is invalid`);
  const model = process.env[`${role}_MODEL`] ?? "";
  const fallbackProvider = process.env[`${role}_FALLBACK_PROVIDER`] as ModelRoute["provider"] | undefined;
  const fallbackModel = process.env[`${role}_FALLBACK_MODEL`];
  return {
    provider,
    model,
    ...(fallbackProvider ? { fallbackProvider } : {}),
    ...(fallbackModel ? { fallbackModel } : {})
  };
};

export function loadConfig(): AppConfig {
  return {
    port: numberEnv("PORT", 8787),
    host: process.env.HOST ?? "127.0.0.1",
    dataDir: process.env.DATA_DIR ?? "./data",
    allowedOrigins: (process.env.ALLOWED_ORIGINS ?? "chrome-extension://*,http://localhost:*" ).split(",").map((v) => v.trim()),
    keys: {
      ...(process.env.OPENAI_API_KEY ? { openai: process.env.OPENAI_API_KEY } : {}),
      ...(process.env.MISTRAL_API_KEY ? { mistral: process.env.MISTRAL_API_KEY } : {}),
      ...(process.env.GEMINI_API_KEY ? { gemini: process.env.GEMINI_API_KEY } : {}),
      ...(process.env.YOU_API_KEY ? { you: process.env.YOU_API_KEY } : {}),
      ...(process.env.DEEPGRAM_API_KEY ? { deepgram: process.env.DEEPGRAM_API_KEY } : {})
    },
    routes: {
      claim_extractor: route("CLAIM_EXTRACTOR", "mistral"),
      planner: route("PLANNER", "openai"),
      researcher: route("RESEARCHER", "mistral"),
      critic: route("CRITIC", "openai")
    },
    pricing: parsePricing(process.env.MODEL_PRICING_JSON),
    budgets: {
      deadlineMs: numberEnv("RUN_DEADLINE_MS", 45_000),
      maxToolCalls: numberEnv("RUN_MAX_TOOL_CALLS", 8),
      maxSearchCalls: numberEnv("RUN_MAX_SEARCH_CALLS", 4),
      maxReplans: numberEnv("RUN_MAX_REPLANS", 1),
      maxCostUsd: numberEnv("RUN_MAX_COST_USD", 0.10)
    }
  };
}

function parsePricing(raw: string | undefined): AppConfig["pricing"] {
  if (!raw) return {};
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("MODEL_PRICING_JSON must be an object");
  const output: AppConfig["pricing"] = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Pricing entry ${key} must be an object`);
    const item = value as Record<string, unknown>;
    const inputPerMillion = Number(item.inputPerMillion);
    const outputPerMillion = Number(item.outputPerMillion);
    if (!Number.isFinite(inputPerMillion) || !Number.isFinite(outputPerMillion)) throw new Error(`Pricing entry ${key} is invalid`);
    output[key] = { inputPerMillion, outputPerMillion };
  }
  return output;
}
