import type { Claim, ClaimExtraction, SourceContext, TranscriptSegment, ToolResult } from "../../../../packages/contracts/src/index.js";
import { validateClaimExtraction } from "../../../../packages/contracts/src/index.js";
import { CLAIM_EXTRACTOR_SYSTEM_V1 } from "../../../../packages/prompts/src/index.js";
import type { StructuredModel } from "../tools/structured-model.js";
import { id } from "../lib/id.js";

export class ClaimExtractorAgent {
  constructor(private readonly model: StructuredModel) {}

  extract(segments: TranscriptSegment[], sourceContext: SourceContext | null = null): Promise<ToolResult<ClaimExtraction>> {
    const transcript = segments.map((segment) => ({
      id: segment.id,
      text: segment.text,
      startMs: segment.startMs,
      endMs: segment.endMs,
      confidence: segment.confidence,
      speaker: segment.speaker
    }));
    const windowStart = Math.min(...segments.map((segment) => segment.startMs));
    const windowEnd = Math.max(...segments.map((segment) => segment.endMs));
    const uncertainAsr = segments.some((segment) => segment.confidence !== null && segment.confidence < 0.75);
    return this.model.generate("claim_extractor", {
      system: CLAIM_EXTRACTOR_SYSTEM_V1,
      user: `Source context:\n${JSON.stringify(sourceContext)}\n\nTranscript window:\n${JSON.stringify(transcript)}`,
      temperature: 0,
      maxTokens: 1400
    }, (value) => qualityGate(validateClaimExtraction(normalizeExtraction(value, windowStart, windowEnd, uncertainAsr))));
  }
}

function normalizeExtraction(value: unknown, windowStart: number, windowEnd: number, uncertainAsr: boolean): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const root = value as Record<string, unknown>;
  const rawClaims = Array.isArray(root.claims) ? root.claims : [];
  return {
    claims: rawClaims.map((raw) => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
      const claim = raw as Record<string, unknown>;
      const category = typeof claim.category === "string" ? claim.category.toLowerCase() : claim.category;
      return {
        ...claim,
        claimId: typeof claim.claimId === "string" && claim.claimId.trim() ? claim.claimId : id("clm"),
        speaker: claim.speaker ?? null,
        startMs: Number.isFinite(Number(claim.startMs)) ? Number(claim.startMs) : windowStart,
        endMs: Number.isFinite(Number(claim.endMs)) ? Number(claim.endMs) : windowEnd,
        checkability: Number.isFinite(Number(claim.checkability)) ? Math.max(0, Math.min(1, Number(claim.checkability))) : 0.5,
        category,
        needsUserConfirmation: typeof claim.needsUserConfirmation === "boolean" ? claim.needsUserConfirmation : uncertainAsr
      };
    })
  };
}

function qualityGate(extraction: ClaimExtraction): ClaimExtraction {
  const seen = new Set<string>();
  const clustered = preferSpecificOverlappingClaims(extraction.claims);
  const claims = clustered.filter((claim) => {
    if (claim.checkability < 0.65) return false;
    if (isPredictionOrIntent(claim)) return false;
    if (hasUnresolvedContext(claim.normalizedClaim)) return false;
    const normalized = claim.normalizedClaim.toLowerCase().replace(/[^a-z0-9%]+/g, " ").trim();
    const numberSignature = (normalized.match(/\d+(?:\.\d+)?%?/g) ?? []).join("|");
    const key = `${numberSignature}:${normalized.split(" ").filter((word) => word.length > 3).slice(0, 8).sort().join(" ")}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { claims };
}

function isPredictionOrIntent(claim: Claim): boolean {
  const text = `${claim.exactQuote} ${claim.normalizedClaim}`.toLowerCase();
  return /\b(will|going to|aim(?:s|ing)? to|intend(?:s|ed|ing)? to|plan(?:s|ned|ning)? to|target(?:s|ed|ing)?|hope(?:s|d)? to|promise(?:s|d)? to)\b/.test(text);
}

function hasUnresolvedContext(text: string): boolean {
  const value = text.toLowerCase();
  return /\b(the speaker|speaker's|referenced (?:place|location|time)|unspecified|the location|that place|this place|previous (?:calendar )?year|last (?:calendar )?year|somewhere|there)\b/.test(value)
    || /^(it|this|that|they|he|she)\b/.test(value);
}

function preferSpecificOverlappingClaims(claims: Claim[]): Claim[] {
  const output: Claim[] = [];
  for (const claim of claims.sort((a, b) => a.startMs - b.startMs)) {
    const at = output.findIndex((existing) => overlapRatio(existing, claim) >= 0.55 || isSemanticDuplicate(existing, claim));
    if (at < 0) {
      output.push(claim);
      continue;
    }
    if (specificity(claim) > specificity(output[at]!)) output[at] = claim;
  }
  return output;
}

function isSemanticDuplicate(a: Claim, b: Claim): boolean {
  const numbersA = (a.normalizedClaim.match(/\d+(?:,\d{3})*(?:\.\d+)?%?/g) ?? []).map((value) => value.replaceAll(",", ""));
  const numbersB = (b.normalizedClaim.match(/\d+(?:,\d{3})*(?:\.\d+)?%?/g) ?? []).map((value) => value.replaceAll(",", ""));
  if (!numbersA.length || !numbersA.some((value) => numbersB.includes(value))) return false;
  const words = (text: string) => new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 3 && !["previous", "calendar", "recorded", "level"].includes(word)));
  const wordsA = words(a.normalizedClaim);
  const wordsB = words(b.normalizedClaim);
  const shared = [...wordsA].filter((word) => wordsB.has(word)).length;
  return shared / Math.max(1, Math.min(wordsA.size, wordsB.size)) >= 0.65;
}

function overlapRatio(a: Claim, b: Claim): number {
  const overlap = Math.max(0, Math.min(a.endMs, b.endMs) - Math.max(a.startMs, b.startMs));
  const shortest = Math.max(1, Math.min(a.endMs - a.startMs, b.endMs - b.startMs));
  return overlap / shortest;
}

function specificity(claim: Claim): number {
  const text = claim.normalizedClaim;
  const namedOrDated = (text.match(/\b(?:[A-Z][a-z]+|January|February|March|April|May|June|July|August|September|October|November|December|\d{4}|\d+(?:\.\d+)?%)\b/g) ?? []).length;
  return claim.checkability * 10 + namedOrDated + Math.min(20, text.split(/\s+/).length) / 10;
}
