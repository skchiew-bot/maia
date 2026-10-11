/** Operator actions on the runtime (aocd, threat model O-26): request bodies and results. */
import { z } from 'zod';
import type { AdminOutcome } from '../events/admin';

/** Why the operator acts: required, recorded in the encrypted payload of the audit event. */
const reason = z.string().trim().min(1).max(2000);
const name = z.string().min(1).max(80).regex(/^[a-z0-9_.:/-]+$/i, 'machine label');

export const AdminRedriveSchema = z.object({ seq: z.number().int().min(1), reason }).strict();
export type AdminRedriveInput = z.infer<typeof AdminRedriveSchema>;

export const AdminRebuildSchema = z.object({ projectors: z.array(name).min(1).max(100), reason }).strict();
export type AdminRebuildInput = z.infer<typeof AdminRebuildSchema>;

export const AdminRunJobSchema = z.object({ reason }).strict();
export type AdminRunJobInput = z.infer<typeof AdminRunJobSchema>;

/** The result of one admin action, and the seq of the event that records it. */
export interface AdminActionResultDTO {
  outcome: AdminOutcome;
  /** Why it failed (outcome `failed`). */
  error: string | null;
  eventSeq: number;
}

export interface AdminRebuildResultDTO extends AdminActionResultDTO {
  projectors: string[];
  /** Projectors left degraded: an event they could not apply was skipped. */
  degraded: string[];
}
