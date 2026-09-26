import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Claim, SourceContext, TranscriptSegment } from "../../../../packages/contracts/src/index.js";
import { validateClaimExtraction } from "../../../../packages/contracts/src/index.js";
import type { ClaimExtractorAgent } from "../agents/claim-extractor.js";
import type { RunEngine } from "../graph/run-engine.js";
import type { RunStore } from "../store/file-store.js";
import type { TraceSink } from "../telemetry/tracer.js";
import type { DeepgramTokenService } from "../tools/deepgram.js";
import { createApproval } from "../policies/approval.js";

export interface HttpDependencies {
  extractor: ClaimExtractorAgent;
  engine: RunEngine;
  store: RunStore;
  traceSink: TraceSink;
  deepgram: DeepgramTokenService | null;
  allowedOrigins: string[];
}

export function createHttpServer(deps: HttpDependencies) {
  return createServer(async (request, response) => {
    try {
      cors(request, response, deps.allowedOrigins);
      if (request.method === "OPTIONS") return send(response, 204, null);
      const url = new URL(request.url ?? "/", "http://localhost");

      if (request.method === "GET" && url.pathname === "/health") {
        return send(response, 200, { ok: true, service: "claimcheck-orchestrator", time: new Date().toISOString() });
      }

      if (request.method === "POST" && url.pathname === "/v1/transcription/token") {
        if (!deps.deepgram) return send(response, 503, { error: "Deepgram is not configured" });
        const token = await deps.deepgram.grant();
        return token.ok && token.data ? send(response, 200, token.data) : send(response, token.error?.kind === "auth" ? 401 : 502, { error: token.error });
      }

      if (request.method === "POST" && url.pathname === "/v1/claims/extract") {
        const body = await readJson(request);
        const segments = validateSegments(body.segments);
        const sourceContext = validateSourceContext(body.sourceContext);
        const result = await deps.extractor.extract(segments, sourceContext);
        return result.ok && result.data ? send(response, 200, result.data) : send(response, 502, { error: result.error });
      }

      if (request.method === "POST" && url.pathname === "/v1/runs") {
        const body = await readJson(request);
        const claim = validateClaim(body.claim);
        const transcript = body.transcript === undefined ? [] : validateSegments(body.transcript);
        const state = await deps.engine.run({ claim, transcript });
        return send(response, 201, state);
      }

      const runMatch = /^\/v1\/runs\/([^/]+)$/.exec(url.pathname);
      if (request.method === "GET" && runMatch) {
        const state = await deps.store.load(runMatch[1]!);
        return state ? send(response, 200, state) : send(response, 404, { error: "Run not found" });
      }

      const traceMatch = /^\/v1\/runs\/([^/]+)\/trace$/.exec(url.pathname);
      if (request.method === "GET" && traceMatch) {
        const state = await deps.store.load(traceMatch[1]!);
        if (!state) return send(response, 404, { error: "Run not found" });
        return send(response, 200, { events: await deps.traceSink.list(traceMatch[1]!) });
      }

      const approveMatch = /^\/v1\/runs\/([^/]+)\/approve$/.exec(url.pathname);
      if (request.method === "POST" && approveMatch) {
        const state = await deps.store.load(approveMatch[1]!);
        if (!state) return send(response, 404, { error: "Run not found" });
        const body = await readJson(request);
        const action = body.action;
        if (action !== "share" && action !== "export" && action !== "publish") return send(response, 400, { error: "Invalid approval action" });
        if (body.confirmed !== true) return send(response, 400, { error: "Explicit confirmation is required" });
        const payload = sharePayload(state);
        const approval = createApproval(action, payload);
        state.approvals.push(approval);
        state.updatedAt = new Date().toISOString();
        await deps.store.save(state);
        return send(response, 201, { approval, payload });
      }

      return send(response, 404, { error: "Not found" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = message.includes("too large") ? 413 : message.includes("must") || message.includes("Invalid") ? 400 : 500;
      return send(response, status, { error: message });
    }
  });
}

function send(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  if (body === null) { response.end(); return; }
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(body));
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  let total = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > 1_000_000) throw new Error("Request body too large");
    chunks.push(buffer);
  }
  if (!chunks.length) return {};
  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Request body must be a JSON object");
  return parsed as Record<string, unknown>;
}

function validateClaim(value: unknown): Claim {
  return validateClaimExtraction({ claims: [value] }).claims[0]!;
}

function validateSegments(value: unknown): TranscriptSegment[] {
  if (!Array.isArray(value)) throw new Error("segments must be an array");
  return value.map((raw, index) => {
    if (!raw || typeof raw !== "object") throw new Error(`segments[${index}] must be an object`);
    const item = raw as Record<string, unknown>;
    if (typeof item.id !== "string" || typeof item.text !== "string") throw new Error(`segments[${index}] requires id and text`);
    return {
      id: item.id,
      text: item.text,
      startMs: finite(item.startMs, `segments[${index}].startMs`),
      endMs: finite(item.endMs, `segments[${index}].endMs`),
      confidence: item.confidence === null || item.confidence === undefined ? null : finite(item.confidence, `segments[${index}].confidence`),
      speaker: item.speaker === null || item.speaker === undefined ? null : String(item.speaker),
      isFinal: item.isFinal === true
    };
  });
}

function validateSourceContext(value: unknown): SourceContext | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("sourceContext must be an object");
  const item = value as Record<string, unknown>;
  const optionalString = (field: string): string | null => item[field] === undefined || item[field] === null ? null : String(item[field]);
  return {
    title: optionalString("title"),
    url: optionalString("url"),
    publishedAt: optionalString("publishedAt")
  };
}

function finite(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${name} must be a number`);
  return value;
}

function sharePayload(state: Awaited<ReturnType<RunStore["load"]>> & {}) {
  if (!state) throw new Error("Run not found");
  const accepted = new Set(state.criticReviews.at(-1)?.acceptedEvidenceIds ?? []);
  const citationMap = new Map<string, { title: string; url: string; excerpt: string }>();
  for (const item of state.evidence.filter((evidence) => accepted.has(evidence.evidenceId))) {
    citationMap.set(item.canonicalUrl || item.url, { title: item.title, url: item.url, excerpt: item.excerpt });
  }
  return {
    runId: state.runId,
    claim: state.claim.normalizedClaim,
    exactQuote: state.claim.exactQuote,
    verdict: state.verdict,
    confidence: state.confidence,
    summary: state.summary,
    citations: [...citationMap.values()]
  };
}

function cors(request: IncomingMessage, response: ServerResponse, patterns: string[]): void {
  const origin = request.headers.origin;
  if (!origin) return;
  const allowed = patterns.some((pattern) => pattern.endsWith("*") ? origin.startsWith(pattern.slice(0, -1)) : pattern === origin);
  if (allowed) {
    response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Vary", "Origin");
    response.setHeader("Access-Control-Allow-Headers", "Content-Type");
    response.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  }
}
