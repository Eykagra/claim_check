import type { ApprovalRecord } from "../../../../packages/contracts/src/index.js";
import { sha256, stableJson } from "../lib/hash.js";

export function approvalHash(action: ApprovalRecord["action"], payload: unknown): string {
  return sha256(stableJson({ action, payload }));
}

export function createApproval(action: ApprovalRecord["action"], payload: unknown, ttlMinutes = 10): ApprovalRecord {
  const now = Date.now();
  return {
    payloadHash: approvalHash(action, payload),
    action,
    approvedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ttlMinutes * 60_000).toISOString()
  };
}

export function isApproved(approval: ApprovalRecord, action: ApprovalRecord["action"], payload: unknown): boolean {
  return approval.action === action && approval.payloadHash === approvalHash(action, payload) && Date.parse(approval.expiresAt) > Date.now();
}
