export type AgentRole = "claim_extractor" | "planner" | "critic";
export type Verdict = "SUPPORTED" | "CONTRADICTED" | "MIXED" | "UNCLEAR";
export type RunStatus =
  | "CREATED"
  | "PLANNING"
  | "RESEARCHING"
  | "CRITIQUING"
  | "AWAITING_APPROVAL"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED";
export type EvidenceStance = "supports" | "contradicts" | "contextual" | "irrelevant";
export type StopReason =
  | "critic_accepted"
  | "planner_stopped"
  | "needs_human"
  | "deadline"
  | "tool_call_limit"
  | "cost_limit"
  | "replan_limit"
  | "cancelled"
  | "unrecoverable_failure";

export interface TranscriptSegment {
  id: string;
  text: string;
  startMs: number;
  endMs: number;
  confidence: number | null;
  speaker: string | null;
  isFinal: boolean;
}

export interface SourceContext {
  title: string | null;
  url: string | null;
  publishedAt: string | null;
}

export interface Claim {
  claimId: string;
  exactQuote: string;
  normalizedClaim: string;
  speaker: string | null;
  startMs: number;
  endMs: number;
  checkability: number;
  category: "statistic" | "event" | "policy" | "science" | "quote" | "other";
  reason: string;
  needsUserConfirmation: boolean;
}

export interface ClaimExtraction {
  claims: Claim[];
}

export type EvidenceTaskType =
  | "FIND_PRIMARY_RECORD"
  | "VERIFY_QUOTE"
  | "CHECK_OFFICIAL_STATISTIC"
  | "FIND_SUPPORTING_EVIDENCE"
  | "FIND_CONTRADICTING_EVIDENCE"
  | "RESOLVE_DATE_OR_SCOPE";

export interface EvidenceTask {
  taskId: string;
  type: EvidenceTaskType;
  objective: string;
  query: string;
  expectedEvidence: string;
  priority: 1 | 2 | 3;
  /** Source policy resolved by the planner; the researcher executes it without its own model call. */
  includeDomains?: string[];
  excludeDomains?: string[];
  maxResults?: number;
  status: "pending" | "running" | "completed" | "failed";
  failure?: string;
}

export interface Plan {
  version: number;
  decision: "CONTINUE" | "STOP" | "NEEDS_HUMAN";
  rationale: string;
  tasks: EvidenceTask[];
}

export interface EvidenceRecord {
  evidenceId: string;
  taskId: string;
  query: string;
  url: string;
  canonicalUrl: string;
  title: string;
  publisher: string;
  publishedAt: string | null;
  retrievedAt: string;
  excerpt: string;
  surroundingContext: string | null;
  sourceKind: "highlight" | "full_page" | "snippet_only";
  stance: EvidenceStance;
  contentHash: string;
  retrievalStatus: "ok" | "partial";
}

export interface CriticReview {
  decision: "ACCEPT" | "REJECT" | "UNCLEAR";
  verdict: Verdict;
  confidence: number;
  reasoningSummary: string;
  acceptedEvidenceIds: string[];
  rejectedEvidence: Array<{ evidenceId: string; reason: string }>;
  gaps: string[];
  recommendedNextTasks: Array<{
    type: EvidenceTaskType;
    objective: string;
    query: string;
    expectedEvidence: string;
  }>;
}

/** "researcher" remains a runtime stage in traces even though it no longer uses a model. */
export type TraceActor = AgentRole | "runtime" | "human" | "researcher";

export interface FailureRecord {
  actor: TraceActor;
  step: string;
  kind: string;
  message: string;
  retryable: boolean;
  time: string;
}

export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
}

export interface ToolError {
  kind: "timeout" | "rate_limit" | "auth" | "malformed" | "blocked" | "upstream" | "budget";
  retryable: boolean;
  message: string;
  status?: number;
}

export interface ToolResult<T> {
  ok: boolean;
  data?: T;
  error?: ToolError;
  latencyMs: number;
  usage?: Usage;
  attempt: number;
  provider?: string;
  model?: string;
}

export interface RunBudget {
  deadlineAt: string;
  maxToolCalls: number;
  usedToolCalls: number;
  maxSearchCalls: number;
  usedSearchCalls: number;
  maxReplans: number;
  usedReplans: number;
  maxCostUsd: number;
  usedCostUsd: number;
}

export interface ApprovalRecord {
  payloadHash: string;
  action: "export" | "share" | "publish";
  approvedAt: string;
  expiresAt: string;
}

export interface RunState {
  runId: string;
  status: RunStatus;
  claim: Claim;
  transcript: TranscriptSegment[];
  planVersions: Plan[];
  tasks: EvidenceTask[];
  evidence: EvidenceRecord[];
  criticReviews: CriticReview[];
  failures: FailureRecord[];
  budget: RunBudget;
  approvals: ApprovalRecord[];
  verdict: Verdict | null;
  confidence: number | null;
  summary: string | null;
  startedAt: string;
  updatedAt: string;
  stopReason?: StopReason;
}

export interface TraceEvent {
  eventId: string;
  runId: string;
  sequence: number;
  time: string;
  actor: TraceActor;
  action: string;
  reason: string;
  inputRef?: string;
  outputRef?: string;
  tool?: string;
  attempt?: number;
  latencyMs?: number;
  usage?: Usage;
  budgetRemaining?: {
    toolCalls: number;
    searchCalls: number;
    replans: number;
    timeMs: number;
    costUsd: number;
  };
  status: "started" | "ok" | "failed" | "stopped";
  details?: Record<string, unknown>;
}

export interface SearchResultItem {
  url: string;
  title: string;
  description: string;
  snippets: string[];
  highlights: string[];
  pageAge: string | null;
}

export interface SearchResponse {
  query: string;
  items: SearchResultItem[];
}

export interface PageContent {
  url: string;
  canonicalUrl: string;
  title: string;
  text: string;
  publishedAt: string | null;
  status: number;
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

const record = (value: unknown, name: string): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ValidationError(`${name} must be an object`);
  return value as Record<string, unknown>;
};
const string = (value: unknown, name: string): string => {
  if (typeof value !== "string" || value.trim() === "") throw new ValidationError(`${name} must be a non-empty string`);
  return value;
};
const number = (value: unknown, name: string, min = -Infinity, max = Infinity): number => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    throw new ValidationError(`${name} must be a number from ${min} to ${max}`);
  }
  return value;
};
const bool = (value: unknown, name: string): boolean => {
  if (typeof value !== "boolean") throw new ValidationError(`${name} must be boolean`);
  return value;
};
const array = (value: unknown, name: string): unknown[] => {
  if (!Array.isArray(value)) throw new ValidationError(`${name} must be an array`);
  return value;
};
const enumValue = <T extends string>(value: unknown, name: string, options: readonly T[]): T => {
  if (typeof value !== "string" || !options.includes(value as T)) {
    throw new ValidationError(`${name} must be one of ${options.join(", ")} (received ${JSON.stringify(value)})`);
  }
  return value as T;
};
const nullableString = (value: unknown, name: string): string | null => value === null || value === undefined ? null : string(value, name);

const stringList = (value: unknown, name: string): string[] => {
  if (value === null || value === undefined) return [];
  const raw = Array.isArray(value) ? value : [value];
  return raw.filter((item) => typeof item === "string" && item.trim() !== "").map((item, i) => string(item, `${name}[${i}]`).trim());
};

const clampInt = (value: unknown, min: number, max: number, fallback: number): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.round(parsed)));
};

export function parseJsonObject(text: string): Record<string, unknown> {
  const trimmed = text.trim();
  const unfenced = trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return record(JSON.parse(unfenced), "model output");
  } catch (error) {
    if (error instanceof ValidationError) throw error;
    const first = unfenced.indexOf("{");
    const last = unfenced.lastIndexOf("}");
    if (first >= 0 && last > first) {
      try { return record(JSON.parse(unfenced.slice(first, last + 1)), "model output"); } catch { /* fall through */ }
    }
    throw new ValidationError(`model output is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function validateClaimExtraction(value: unknown): ClaimExtraction {
  const root = record(value, "claim extraction");
  const claims = array(root.claims, "claims").map((raw, index): Claim => {
    const item = record(raw, `claims[${index}]`);
    return {
      claimId: string(item.claimId, `claims[${index}].claimId`),
      exactQuote: string(item.exactQuote, `claims[${index}].exactQuote`),
      normalizedClaim: string(item.normalizedClaim, `claims[${index}].normalizedClaim`),
      speaker: nullableString(item.speaker, `claims[${index}].speaker`),
      startMs: number(item.startMs, `claims[${index}].startMs`, 0),
      endMs: number(item.endMs, `claims[${index}].endMs`, 0),
      checkability: number(item.checkability, `claims[${index}].checkability`, 0, 1),
      category: enumValue(item.category, `claims[${index}].category`, ["statistic", "event", "policy", "science", "quote", "other"] as const),
      reason: string(item.reason, `claims[${index}].reason`),
      needsUserConfirmation: bool(item.needsUserConfirmation, `claims[${index}].needsUserConfirmation`)
    };
  });
  return { claims };
}

const taskTypes = ["FIND_PRIMARY_RECORD", "VERIFY_QUOTE", "CHECK_OFFICIAL_STATISTIC", "FIND_SUPPORTING_EVIDENCE", "FIND_CONTRADICTING_EVIDENCE", "RESOLVE_DATE_OR_SCOPE"] as const;

export function validatePlan(value: unknown): Plan {
  const root = record(value, "plan");
  const tasks = array(root.tasks, "tasks").map((raw, index): EvidenceTask => {
    const item = record(raw, `tasks[${index}]`);
    const priority = number(item.priority, `tasks[${index}].priority`, 1, 3);
    return {
      taskId: string(item.taskId, `tasks[${index}].taskId`),
      type: enumValue(item.type, `tasks[${index}].type`, taskTypes),
      objective: string(item.objective, `tasks[${index}].objective`),
      query: string(item.query, `tasks[${index}].query`),
      expectedEvidence: string(item.expectedEvidence, `tasks[${index}].expectedEvidence`),
      priority: priority as 1 | 2 | 3,
      includeDomains: stringList(item.includeDomains, `tasks[${index}].includeDomains`),
      excludeDomains: stringList(item.excludeDomains, `tasks[${index}].excludeDomains`),
      maxResults: clampInt(item.maxResults, 1, 5, 3),
      status: "pending"
    };
  });
  return {
    version: number(root.version, "version", 1),
    decision: enumValue(root.decision, "decision", ["CONTINUE", "STOP", "NEEDS_HUMAN"] as const),
    rationale: string(root.rationale, "rationale"),
    tasks
  };
}

const VERDICT_SYNONYMS: Record<string, Verdict> = {
  SUPPORTED: "SUPPORTED", SUPPORT: "SUPPORTED", SUPPORTS: "SUPPORTED", TRUE: "SUPPORTED", CONFIRMED: "SUPPORTED",
  VERIFIED: "SUPPORTED", ACCURATE: "SUPPORTED", CORRECT: "SUPPORTED", SUBSTANTIATED: "SUPPORTED",
  CONTRADICTED: "CONTRADICTED", CONTRADICT: "CONTRADICTED", CONTRADICTS: "CONTRADICTED", FALSE: "CONTRADICTED",
  REFUTED: "CONTRADICTED", DEBUNKED: "CONTRADICTED", DISPROVEN: "CONTRADICTED", INCORRECT: "CONTRADICTED", INACCURATE: "CONTRADICTED",
  MIXED: "MIXED", PARTIAL: "MIXED", PARTIALLY_TRUE: "MIXED", PARTLY_TRUE: "MIXED", PARTIALLY_SUPPORTED: "MIXED",
  PARTIALLY_ACCURATE: "MIXED", MOSTLY_TRUE: "MIXED", MOSTLY_FALSE: "MIXED", MISLEADING: "MIXED",
  UNCLEAR: "UNCLEAR", UNVERIFIED: "UNCLEAR", UNVERIFIABLE: "UNCLEAR", UNKNOWN: "UNCLEAR", UNDETERMINED: "UNCLEAR",
  INCONCLUSIVE: "UNCLEAR", INSUFFICIENT: "UNCLEAR", INSUFFICIENT_EVIDENCE: "UNCLEAR", NOT_ENOUGH_EVIDENCE: "UNCLEAR",
  NO_EVIDENCE: "UNCLEAR", NEEDS_MORE_EVIDENCE: "UNCLEAR", NEEDS_MORE_RESEARCH: "UNCLEAR", UNSUPPORTED: "UNCLEAR",
  NOT_SUPPORTED: "UNCLEAR", CANNOT_DETERMINE: "UNCLEAR", NOT_CHECKED: "UNCLEAR", NA: "UNCLEAR", NONE: "UNCLEAR"
};

const DECISION_SYNONYMS: Record<string, CriticReview["decision"]> = {
  ACCEPT: "ACCEPT", ACCEPTED: "ACCEPT", SUFFICIENT: "ACCEPT", APPROVE: "ACCEPT", APPROVED: "ACCEPT", PASS: "ACCEPT",
  REJECT: "REJECT", REJECTED: "REJECT", INSUFFICIENT: "REJECT", NEEDS_MORE_RESEARCH: "REJECT", REPLAN: "REJECT", FAIL: "REJECT",
  UNCLEAR: "UNCLEAR", UNKNOWN: "UNCLEAR", INCONCLUSIVE: "UNCLEAR", UNDETERMINED: "UNCLEAR"
};

const token = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return normalized === "" ? null : normalized;
};

/**
 * Models reliably produce the *shape* of a critic review but drift on enum wording
 * ("INSUFFICIENT_EVIDENCE", "partially true", a missing verdict). Map that drift onto the
 * contract instead of failing the run, and only reject output that is genuinely unusable.
 */
export function normalizeCriticDraft(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const outer = value as Record<string, unknown>;
  const nested = outer.review ?? outer.criticReview ?? outer.critic_review ?? outer.result;
  const root = nested && typeof nested === "object" && !Array.isArray(nested)
    ? { ...(nested as Record<string, unknown>) }
    : { ...outer };

  const verdictToken = token(root.verdict ?? root.claimVerdict ?? root.claim_verdict);
  const decisionToken = token(root.decision ?? root.evidenceDecision ?? root.packetDecision);
  const verdict = verdictToken ? VERDICT_SYNONYMS[verdictToken] : undefined;
  const decision = decisionToken ? DECISION_SYNONYMS[decisionToken] : undefined;

  // A verdict word that is also a decision word (and vice versa) is a swapped-field mistake.
  const recoveredVerdict = verdict
    ?? (decisionToken && VERDICT_SYNONYMS[decisionToken] && !DECISION_SYNONYMS[decisionToken] ? VERDICT_SYNONYMS[decisionToken] : undefined)
    ?? "UNCLEAR";
  const recoveredDecision = decision
    ?? (verdictToken && DECISION_SYNONYMS[verdictToken] ? DECISION_SYNONYMS[verdictToken] : undefined)
    ?? (verdict && verdict !== "UNCLEAR" ? "ACCEPT" : "UNCLEAR");

  let confidence = Number(root.confidence ?? root.confidenceScore);
  if (!Number.isFinite(confidence)) confidence = recoveredVerdict === "UNCLEAR" ? 0.3 : 0.5;
  if (confidence > 1) confidence = confidence <= 100 ? confidence / 100 : 1;
  confidence = Math.max(0, Math.min(1, confidence));

  const summary = [root.reasoningSummary, root.reasoning, root.summary, root.rationale, root.explanation]
    .find((candidate) => typeof candidate === "string" && candidate.trim() !== "");

  const rejected = Array.isArray(root.rejectedEvidence) ? root.rejectedEvidence : [];

  return {
    ...root,
    decision: recoveredDecision,
    verdict: recoveredVerdict,
    confidence,
    reasoningSummary: typeof summary === "string" ? summary : "The critic returned no reasoning summary.",
    acceptedEvidenceIds: stringList(root.acceptedEvidenceIds ?? root.accepted_evidence_ids, "acceptedEvidenceIds"),
    gaps: stringList(root.gaps, "gaps"),
    rejectedEvidence: rejected.map((raw) => {
      if (typeof raw === "string") return { evidenceId: raw, reason: "No reason supplied" };
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
      const item = raw as Record<string, unknown>;
      return { ...item, reason: typeof item.reason === "string" && item.reason.trim() !== "" ? item.reason : "No reason supplied" };
    }),
    recommendedNextTasks: (Array.isArray(root.recommendedNextTasks) ? root.recommendedNextTasks : []).flatMap((raw) => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
      const task = raw as Record<string, unknown>;
      const type = token(task.type);
      // Drop an unusable recommendation rather than failing the whole review.
      if (!type || !taskTypes.includes(type as (typeof taskTypes)[number])) return [];
      return [{ ...task, type }];
    })
  };
}

export function validateCriticReview(value: unknown): CriticReview {
  const root = record(normalizeCriticDraft(value), "critic review");
  const rejectedEvidence = array(root.rejectedEvidence ?? [], "rejectedEvidence").map((raw, index) => {
    const item = record(raw, `rejectedEvidence[${index}]`);
    return { evidenceId: string(item.evidenceId, `rejectedEvidence[${index}].evidenceId`), reason: string(item.reason, `rejectedEvidence[${index}].reason`) };
  });
  const recommendedNextTasks = array(root.recommendedNextTasks ?? [], "recommendedNextTasks").map((raw, index) => {
    const item = record(raw, `recommendedNextTasks[${index}]`);
    return {
      type: enumValue(item.type, `recommendedNextTasks[${index}].type`, taskTypes),
      objective: string(item.objective, `recommendedNextTasks[${index}].objective`),
      query: string(item.query, `recommendedNextTasks[${index}].query`),
      expectedEvidence: string(item.expectedEvidence, `recommendedNextTasks[${index}].expectedEvidence`)
    };
  });
  return {
    decision: enumValue(root.decision, "decision", ["ACCEPT", "REJECT", "UNCLEAR"] as const),
    verdict: enumValue(root.verdict, "verdict", ["SUPPORTED", "CONTRADICTED", "MIXED", "UNCLEAR"] as const),
    confidence: number(root.confidence, "confidence", 0, 1),
    reasoningSummary: string(root.reasoningSummary, "reasoningSummary"),
    acceptedEvidenceIds: array(root.acceptedEvidenceIds ?? [], "acceptedEvidenceIds").map((v, i) => string(v, `acceptedEvidenceIds[${i}]`)),
    rejectedEvidence,
    gaps: array(root.gaps ?? [], "gaps").map((v, i) => string(v, `gaps[${i}]`)),
    recommendedNextTasks
  };
}
