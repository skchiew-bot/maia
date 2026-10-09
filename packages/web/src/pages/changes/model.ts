/**
 * Change control (§8, §14) as the UI reads it: status and scope metadata, the pipeline hero, field
 * accountability (who wrote vs who affirmed) and the submit gate. Pure functions over the mod-change DTOs.
 */
import type {
  ChangeField,
  ChangeFieldDTO,
  ChangeRequestDTO,
  ChangeScope,
  ChangeStatus,
} from '@aoc/contracts';
import type { IconName } from '../../components/Icon';
import type { Tone } from '../../components/tone';
import { toEpoch } from '../../lib/format';

export const FIELD_ORDER: readonly ChangeField[] = ['impact', 'mitigation', 'rollbackPlan', 'acceptanceTest'];

export const FIELD_META: Record<ChangeField, { label: string; prompt: string }> = {
  impact: {
    label: 'Impact analysis',
    prompt: 'What the change touches, and who notices if it misbehaves.',
  },
  mitigation: {
    label: 'Mitigation plan',
    prompt: 'What limits the blast radius: flags, staged rollout, monitoring.',
  },
  rollbackPlan: {
    label: 'Rollback plan',
    prompt: 'How to undo it. It must name the exact tag or commit to return to.',
  },
  acceptanceTest: {
    label: 'Acceptance test',
    prompt:
      'How we know it works. A single test command (for example npm test) is what a rollback verification runs.',
  },
};

export const SCOPE_META: Record<
  ChangeScope,
  { label: string; gate: 'self' | 'approver'; description: string }
> = {
  reversible_off_main: {
    label: 'Reversible, off main',
    gate: 'self',
    description: 'Builders self-approve reversible off-main work. It is still a full change record.',
  },
  main: {
    label: 'Touches main',
    gate: 'approver',
    description: 'Merges to main bounce to the Approver.',
  },
  production: {
    label: 'Touches production',
    gate: 'approver',
    description: 'Production changes bounce to the Approver.',
  },
  data: {
    label: 'Touches data',
    gate: 'approver',
    description: 'Migrations, deletes and personal data bounce to the Approver.',
  },
};

export const SCOPE_ORDER: readonly ChangeScope[] = ['reversible_off_main', 'main', 'production', 'data'];

export const STATUS_META: Record<ChangeStatus, { label: string; tone: Tone; icon: IconName }> = {
  draft: { label: 'Drafting', tone: 'neutral', icon: 'changes' },
  submitted: { label: 'Awaiting approval', tone: 'accent', icon: 'decisions' },
  approved: { label: 'Approved', tone: 'ok', icon: 'ok' },
  in_progress: { label: 'In progress', tone: 'neutral', icon: 'working' },
  completed: { label: 'Completed', tone: 'ok', icon: 'check' },
  rejected: { label: 'Rejected', tone: 'neutral', icon: 'close' },
};

/** Pipeline stages in flow order; completed and rejected are the closed (terminal) ends. */
export const STAGE_ORDER: readonly ChangeStatus[] = [
  'draft',
  'submitted',
  'approved',
  'in_progress',
  'completed',
  'rejected',
];

const CLOSED: ReadonlySet<ChangeStatus> = new Set(['completed', 'rejected']);

export function isClosed(status: ChangeStatus): boolean {
  return CLOSED.has(status);
}

/** When the record entered its current stage (the clock its age runs from). */
export function stageSince(c: ChangeRequestDTO): string {
  switch (c.status) {
    case 'draft':
      return c.createdAt;
    case 'submitted':
      return c.submittedAt ?? c.createdAt;
    case 'approved':
      return c.approval?.at ?? c.submittedAt ?? c.createdAt;
    case 'in_progress':
      return c.sessions[0]?.startedAt ?? c.approval?.at ?? c.createdAt;
    case 'completed':
      return c.completedAt ?? c.approval?.at ?? c.createdAt;
    case 'rejected':
      return c.rejection?.at ?? c.submittedAt ?? c.createdAt;
  }
}

export interface PipelineStage {
  status: ChangeStatus;
  label: string;
  count: number;
  /** Open stages: age of the oldest record in the stage. */
  oldestAgeMs?: number;
  /** Open stages: median age in the stage. Closed stages: median lead time from draft to close. */
  medianAgeMs?: number;
  terminal: boolean;
}

export function median(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

export function buildPipeline(changes: readonly ChangeRequestDTO[], now: number): PipelineStage[] {
  return STAGE_ORDER.map((status) => {
    const inStage = changes.filter((c) => c.status === status);
    const terminal = isClosed(status);
    const ages = inStage.map((c) =>
      terminal ? toEpoch(stageSince(c)) - toEpoch(c.createdAt) : Math.max(0, now - toEpoch(stageSince(c))),
    );
    return {
      status,
      label: STATUS_META[status].label,
      count: inStage.length,
      oldestAgeMs: !terminal && ages.length ? Math.max(...ages) : undefined,
      medianAgeMs: median(ages),
      terminal,
    };
  });
}

/** The open stage holding the most waiting time (count × median age) — where work waits. */
export function pipelineBottleneck(stages: readonly PipelineStage[]): ChangeStatus | undefined {
  let best: PipelineStage | undefined;
  let bestScore = 0;
  for (const s of stages) {
    if (s.terminal || s.count === 0) continue;
    const score = s.count * Math.max(1, s.medianAgeMs ?? 0);
    if (score > bestScore) {
      best = s;
      bestScore = score;
    }
  }
  return best?.status;
}

export type FieldState = 'pending' | 'edited' | 'affirmed' | 'blind' | 'erased';

export function fieldState(f: ChangeFieldDTO, erased: boolean): FieldState {
  if (erased && f.value === null) return 'erased';
  if (!f.affirmed) return 'pending';
  if (f.blind) return 'blind';
  return f.edited ? 'edited' : 'affirmed';
}

/** Whether the AI left a usable draft for this field (empty drafts mean the developer wrote it from scratch). */
export function hasAiDraft(c: Pick<ChangeRequestDTO, 'draftedBy'>, f: ChangeFieldDTO): boolean {
  return c.draftedBy === 'ai' && !!f.draft?.trim();
}

/** Who wrote the field, with a short note on how (§14 accountability: who wrote vs who affirmed). */
export function authorship(
  c: Pick<ChangeRequestDTO, 'draftedBy'>,
  f: ChangeFieldDTO,
): { wrote: 'ai' | 'developer' | 'nobody'; summary: string } {
  const ai = hasAiDraft(c, f);
  if (!f.affirmed) {
    return ai
      ? { wrote: 'ai', summary: 'not yet affirmed or edited' }
      : { wrote: 'nobody', summary: 'not written yet' };
  }
  if (!ai) return { wrote: 'developer', summary: 'no AI draft' };
  if (f.edited) return { wrote: 'developer', summary: 'edited the AI draft' };
  return { wrote: 'ai', summary: 'affirmed without edit' };
}

export interface SubmitGate {
  /** All four fields affirmed and a rollback target named. */
  ready: boolean;
  missing: ChangeField[];
  needsRollbackRef: boolean;
}

export function submitGate(c: ChangeRequestDTO): SubmitGate {
  const missing = FIELD_ORDER.filter((f) => {
    const row = c.fields.find((x) => x.field === f);
    return !row || !row.affirmed || !row.value?.trim();
  });
  const needsRollbackRef = !c.rollbackRef;
  return { ready: missing.length === 0 && !needsRollbackRef, missing, needsRollbackRef };
}

/** Only the record's owner or an Approver may edit, affirm, submit, start or complete it (mod-change assertCanAct). */
export function canActOn(
  c: Pick<ChangeRequestDTO, 'ownerId'>,
  viewer: { id: string; role: string } | null | undefined,
): boolean {
  return !!viewer && (viewer.role === 'approver' || c.ownerId === viewer.id);
}

/**
 * Separation of duties (§6): an Approver never approves their own request, and the sole-Approver fallback is off.
 * When the only active Approver raised it, nobody can approve it until a second Approver exists.
 */
export function blockedBySoleApprover(
  requesterId: string | null | undefined,
  approvers: readonly { id: string }[],
): boolean {
  return !!requesterId && approvers.length === 1 && approvers[0]!.id === requesterId;
}

/** Records that need a human now: waiting approval, and post-incident records that are due or overdue. */
export function needsAttention(c: ChangeRequestDTO): boolean {
  return c.status === 'submitted' || (!!c.breakglassId && c.status !== 'completed');
}

export type LifecycleSegmentId = 'drafting' | 'approval' | 'ready' | 'building';

export interface LifecycleSegment {
  id: LifecycleSegmentId;
  label: string;
  from: number;
  to: number;
  /** The record is still in this stage (the segment runs to now). */
  ongoing: boolean;
}

/**
 * Where a change record's time went: drafting, waiting for approval, approved but not started, in progress.
 * A self-approved record has no approval wait; a rejected one ends at the decision.
 */
export function lifecycleSegments(c: ChangeRequestDTO, now: number): LifecycleSegment[] {
  const at = (iso: string | null | undefined) => (iso ? toEpoch(iso) : null);
  const created = toEpoch(c.createdAt);
  const submitted = at(c.submittedAt);
  const decided = at(c.approval?.at ?? c.rejection?.at);
  const started = at(c.sessions[0]?.startedAt);
  const completed = at(c.completedAt);
  const segs: LifecycleSegment[] = [
    { id: 'drafting', label: 'Drafting', from: created, to: submitted ?? now, ongoing: submitted === null },
  ];
  if (submitted !== null && !(c.approval?.selfApproved && decided !== null && decided <= submitted)) {
    segs.push({
      id: 'approval',
      label: 'Awaiting approval',
      from: submitted,
      to: decided ?? now,
      ongoing: decided === null,
    });
  }
  if (c.approval && decided !== null) {
    if (started !== null) {
      segs.push({ id: 'ready', label: 'Approved, not started', from: decided, to: started, ongoing: false });
      segs.push({
        id: 'building',
        label: 'In progress',
        from: started,
        to: completed ?? now,
        ongoing: completed === null,
      });
    } else {
      segs.push({
        id: 'ready',
        label: completed !== null ? 'Approved to completed' : 'Approved, not started',
        from: decided,
        to: completed ?? now,
        ongoing: completed === null,
      });
    }
  }
  return segs.map((s) => ({ ...s, to: Math.max(s.from, s.to) }));
}

/** What kind of actor an id names: people are usr_…, agent sessions ses_…, everything else a system component. */
export function actorKindOf(id: string): 'human' | 'agent' | 'system' {
  if (id.startsWith('usr_')) return 'human';
  if (id.startsWith('ses_')) return 'agent';
  return 'system';
}

export { shortId } from '../audit/ids';
