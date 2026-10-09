/**
 * Credits read models and request bodies (owner: mod-credits, §10). Amounts are notional USD.
 * Credits meter cost at task boundaries; they never pick or change the model.
 */
import { z } from 'zod';

export const CREDIT_TOPUP_STATUSES = ['pending', 'granted', 'denied', 'withdrawn'] as const;
export type CreditTopupStatus = (typeof CREDIT_TOPUP_STATUSES)[number];

/** A waiting top-up request is its own aging state (shown with its age), never a stall. */
export interface CreditPendingTopup {
  requestId: string;
  decisionId: string;
  amountUsd: number;
  createdAt: string;
  ageMs: number;
}

export interface CreditGrant {
  kind: 'auto' | 'topup';
  amountUsd: number;
  at: string;
  /** null for the once-per-period auto grant (resolved by policy). */
  approverId: string | null;
  requestId: string | null;
  decisionId: string | null;
  sessionId: string | null;
  taskId: string | null;
  balanceBefore: number;
  balanceAfter: number;
}

/** One user's credit account for one local period (YYYY-MM). balance = allocation + granted − used. */
export interface CreditAccount {
  userId: string;
  userName: string | null;
  period: string;
  allocationUsd: number;
  allocationSource: 'default' | 'allocated';
  /** Notional API-equivalent cost of usage in sessions the user owns. */
  usedUsd: number;
  /** Auto grant + approved top-ups. */
  grantedUsd: number;
  balanceUsd: number;
  autoGrantUsed: boolean;
  /** What the auto grant would add at the next cap (0 once used, or for exempt users). */
  autoGrantAvailableUsd: number;
  /** The next task boundary would stop work until a top-up is approved. */
  capped: boolean;
  exempt: boolean;
  /** Only shown on the current period's account. */
  pendingTopup: CreditPendingTopup | null;
  grants: CreditGrant[];
}

export interface CreditAccountsResponse {
  period: string;
  accounts: CreditAccount[];
}

export interface CreditTopupRequest {
  requestId: string;
  userId: string;
  userName: string | null;
  /** Period the request was raised in (an approved top-up lands in the period current at approval). */
  period: string;
  amountUsd: number;
  /** Requester-entered text: untrusted, escape when rendering. null when crypto-shredded ("[erased]"). */
  reason: string | null;
  sessionId: string | null;
  taskId: string | null;
  decisionId: string;
  status: CreditTopupStatus;
  createdAt: string;
  /** Time waiting: until now while pending, until resolution afterwards. */
  ageMs: number;
  resolvedAt: string | null;
  resolvedBy: string | null;
  balanceBefore: number | null;
  balanceAfter: number | null;
}

export interface CreditTopupRequestList {
  requests: CreditTopupRequest[];
}

const zPeriod = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'period must be YYYY-MM');

/** POST /api/credits/topup-requests */
export const CreditTopupRequestInput = z.object({
  amountUsd: z.number().finite().min(0.01).max(100_000),
  reason: z.string().trim().min(3).max(2000),
  sessionId: z.string().min(1).max(64).optional(),
});
export type CreditTopupRequestInput = z.infer<typeof CreditTopupRequestInput>;

/** POST /api/credits/allocations */
export const CreditAllocationInput = z.object({
  userId: z.string().min(1).max(64),
  period: zPeriod,
  amountUsd: z.number().finite().min(0).max(1_000_000),
});
export type CreditAllocationInput = z.infer<typeof CreditAllocationInput>;

/** ?period= on the account routes (defaults to the current local period). */
export const CreditPeriodQuery = z.object({ period: zPeriod.optional() });
