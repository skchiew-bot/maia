/**
 * Gated rollback, break-glass and promotion (§8, §14) as the UI reads them. Pure functions over the mod-change DTOs.
 */
import type {
  BreakglassDTO,
  PromotionDTO,
  PromotionRefusalReason,
  RollbackDTO,
  RollbackStatus,
} from '@aoc/contracts';
import type { IconName } from '../../components/Icon';
import type { Tone } from '../../components/tone';
import { toEpoch } from '../../lib/format';

export type StepState = 'done' | 'current' | 'failed' | 'skipped' | 'pending';

export interface TrackStep {
  id: 'requested' | 'verify' | 'approve' | 'execute';
  label: string;
  state: StepState;
  /** What happened (or will happen) at this step, in words. */
  detail: string;
  at: string | null;
}

export const ROLLBACK_STATUS_META: Record<RollbackStatus, { label: string; tone: Tone; icon: IconName }> = {
  requested: { label: 'Queued for verification', tone: 'neutral', icon: 'clock' },
  verifying: { label: 'Verifying on a branch', tone: 'neutral', icon: 'working' },
  awaiting_approval: { label: 'Awaiting the Approver', tone: 'accent', icon: 'key' },
  not_clean: { label: 'Not clean', tone: 'danger', icon: 'danger' },
  approved: { label: 'Approved, restoring', tone: 'ok', icon: 'working' },
  rejected: { label: 'Rejected', tone: 'neutral', icon: 'close' },
  executed: { label: 'Restored on main', tone: 'ok', icon: 'check' },
  failed: { label: 'Not executed', tone: 'danger', icon: 'danger' },
};

/** Open rollbacks still need a machine or a human; closed ones are history. */
export const OPEN_ROLLBACK: ReadonlySet<RollbackStatus> = new Set([
  'requested',
  'verifying',
  'awaiting_approval',
  'approved',
]);

/** Test counts when the runner reported them; otherwise the command's exit code decided. */
function tests(v: NonNullable<RollbackDTO['verification']>): string {
  if (v.testsPassed + v.testsFailed === 0)
    return v.clean ? 'the test command passed (no counts reported)' : 'the test command failed';
  return `${v.testsPassed} passed, ${v.testsFailed} failed`;
}

/** A full SHA reads as its first 12 characters; tag names stay whole. */
export function displayRef(ref: string): string {
  return /^[0-9a-f]{40,64}$/i.test(ref) ? ref.slice(0, 12) : ref;
}

/**
 * The four stages of a gated rollback (§8): requested → verified on its own branch → Approver passkey → restored on
 * main as a new commit. Only a clean verification raises the decision; nothing touches main before approval.
 */
export function rollbackTrack(r: RollbackDTO): TrackStep[] {
  const v = r.verification;
  const branch = v?.branch ?? `aoc/rollback/${r.rollbackId}`;
  const failedBeforeApproval = r.status === 'failed' && !r.approval;
  const requested: TrackStep = {
    id: 'requested',
    label: 'Requested',
    state: 'done',
    detail: `return to ${displayRef(r.targetRef)}`,
    at: r.requestedAt,
  };
  const verify: TrackStep = {
    id: 'verify',
    label: 'Verified on a branch',
    state: 'pending',
    detail: `acceptance tests on ${branch}`,
    at: v?.at ?? null,
  };
  const approve: TrackStep = {
    id: 'approve',
    label: 'Approver passkey',
    state: 'pending',
    detail: 'raised only when verification is clean',
    at: r.approval?.at ?? r.rejection?.at ?? null,
  };
  const execute: TrackStep = {
    id: 'execute',
    label: 'Restored on main',
    state: 'pending',
    detail: 'a new commit restores the tree; history is kept',
    at: r.execution?.at ?? (r.approval ? (r.failure?.at ?? null) : null),
  };

  switch (r.status) {
    case 'requested':
      verify.state = 'current';
      verify.detail = `queued: the supervisor checks out ${displayRef(r.targetRef)} on ${branch}`;
      break;
    case 'verifying':
      verify.state = 'current';
      verify.detail = `running that state's acceptance tests on ${branch}`;
      break;
    case 'not_clean':
      verify.state = 'failed';
      verify.detail = v ? `not clean: ${tests(v)}` : 'not clean';
      approve.state = 'skipped';
      approve.detail = 'no approval requested: verification was not clean';
      execute.state = 'skipped';
      execute.detail = 'main untouched';
      break;
    default:
      if (v) {
        verify.state = 'done';
        verify.detail = `clean: ${tests(v)}`;
      }
  }

  if (r.status === 'awaiting_approval') {
    approve.state = 'current';
    approve.detail = 'shown clean; waiting for the Approver to approve with a passkey';
  } else if (r.status === 'rejected') {
    approve.state = 'failed';
    approve.detail = r.rejection?.comment ? `rejected: “${r.rejection.comment}”` : 'rejected';
    execute.state = 'skipped';
    execute.detail = 'main untouched';
  } else if (r.approval) {
    approve.state = 'done';
    approve.detail = r.approval.passkeyVerified ? 'approved with a verified passkey' : 'approved';
  }

  if (failedBeforeApproval) {
    approve.state = 'failed';
    approve.detail = `the decision could not be raised: ${r.failure?.reason ?? 'unknown'}`;
    execute.state = 'skipped';
  } else if (r.status === 'approved') {
    execute.state = 'current';
    execute.detail = 'the supervisor is restoring the state on main';
  } else if (r.status === 'executed') {
    execute.state = 'done';
    execute.detail = 'main restored with a new commit (history preserved)';
  } else if (r.status === 'failed') {
    execute.state = 'failed';
    execute.detail = `not executed: ${r.failure?.reason ?? 'unknown'}; main left unchanged`;
  }
  return [requested, verify, approve, execute];
}

export type PostIncidentState =
  | { kind: 'none' }
  | { kind: 'done'; changeId: string }
  | { kind: 'due'; changeId: string; dueAt: string; remainingMs: number; elapsedRatio: number }
  | { kind: 'overdue'; changeId: string; dueAt: string; overdueMs: number };

/** The mandatory post-incident change record (§8): due 24 hours after a break-glass approval. */
export function postIncidentState(
  b: BreakglassDTO,
  now: number,
  windowMs = 24 * 3_600_000,
): PostIncidentState {
  if (!b.postIncidentChangeId || !b.dueAt) return { kind: 'none' };
  if (b.postIncidentStatus === 'completed') return { kind: 'done', changeId: b.postIncidentChangeId };
  const due = toEpoch(b.dueAt);
  if (b.overdue || due <= now)
    return {
      kind: 'overdue',
      changeId: b.postIncidentChangeId,
      dueAt: b.dueAt,
      overdueMs: Math.max(0, now - due),
    };
  const remainingMs = due - now;
  return {
    kind: 'due',
    changeId: b.postIncidentChangeId,
    dueAt: b.dueAt,
    remainingMs,
    elapsedRatio: Math.min(1, Math.max(0, 1 - remainingMs / windowMs)),
  };
}

export const BREAKGLASS_STATUS_META: Record<
  BreakglassDTO['status'],
  { label: string; tone: Tone; icon: IconName }
> = {
  pending: { label: 'Awaiting the Approver', tone: 'accent', icon: 'key' },
  approved: { label: 'Approved', tone: 'ok', icon: 'ok' },
  rejected: { label: 'Not approved', tone: 'neutral', icon: 'close' },
};

export const REFUSAL_TEXT: Record<PromotionRefusalReason, string> = {
  provenance_gap: 'provenance gap: commits that trace to no approved change or fix plan',
  uat_missing: 'no passing UAT sign-off on the ticket',
  gate_missing: 'no approved gate',
  tests_failed: 'acceptance tests failed',
  not_fast_forward: 'not a fast-forward of the default branch',
};

export interface PromotionOutcome {
  label: string;
  tone: Tone;
  icon: IconName;
  /** One line on what the provenance check and the gate concluded. */
  detail: string;
}

export function promotionOutcome(p: PromotionDTO): PromotionOutcome {
  switch (p.status) {
    case 'completed':
      return {
        label: 'Promoted',
        tone: 'ok',
        icon: 'check',
        detail: p.breakglass
          ? 'break-glass: provenance check waived and recorded (the sole exception)'
          : 'every commit traced through an approved gate',
      };
    case 'refused': {
      const orphans = p.refusal?.orphanShas.length ?? 0;
      return {
        label: 'Refused',
        tone: 'danger',
        icon: 'danger',
        detail:
          p.refusal?.reason === 'provenance_gap'
            ? `${orphans} orphan ${orphans === 1 ? 'commit' : 'commits'}: no approved change record or fix plan`
            : p.refusal
              ? REFUSAL_TEXT[p.refusal.reason]
              : 'refused',
      };
    }
    case 'rejected':
      return {
        label: 'Rejected',
        tone: 'neutral',
        icon: 'close',
        detail: 'the Approver rejected the go-live',
      };
    case 'failed':
      return {
        label: 'Not executed',
        tone: 'danger',
        icon: 'danger',
        detail: `approved, but the push failed (${p.failure?.reason ?? 'unknown'}); main unchanged`,
      };
    case 'requested':
      return {
        label: p.breakglass ? 'Promoting' : 'Awaiting go-live',
        tone: 'accent',
        icon: 'key',
        detail: p.breakglass
          ? 'break-glass promotion in progress'
          : 'provenance traced; the Approver decides with a passkey',
      };
  }
}
