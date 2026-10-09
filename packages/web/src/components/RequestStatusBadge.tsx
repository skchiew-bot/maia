import type { CSSProperties } from 'react';
import { Icon, type IconName } from './Icon';

/**
 * What a requester may know about their ticket (§7): abstracted status only — never internal gate names,
 * the approver's identity, queue depth or an implied timeline.
 */
export type RequestStatus = 'submitted' | 'in_progress' | 'ready_for_testing' | 'completed';

export const REQUEST_STATUS_META: Record<
  RequestStatus,
  { word: string; icon: IconName; color: string; bg: string }
> = {
  submitted: { word: 'Submitted', icon: 'inbox', color: 'var(--text-3)', bg: 'var(--surface-2)' },
  in_progress: { word: 'Being worked on', icon: 'working', color: 'var(--info)', bg: 'var(--info-soft)' },
  ready_for_testing: {
    word: 'Ready for your testing',
    icon: 'waiting',
    color: 'var(--accent)',
    bg: 'var(--accent-soft)',
  },
  completed: { word: 'Completed', icon: 'ok', color: 'var(--ok)', bg: 'var(--ok-soft)' },
};

export interface RequestStatusBadgeProps {
  status: RequestStatus;
}

/** Requester-facing ticket status for the portal (icon + plain words). */
export function RequestStatusBadge({ status }: RequestStatusBadgeProps) {
  const meta = REQUEST_STATUS_META[status];
  return (
    <span
      className="aoc-liveness aoc-liveness--md"
      data-request-status={status}
      style={{ '--lv-fg': meta.color, '--lv-bg': meta.bg } as CSSProperties}
    >
      <Icon name={meta.icon} size={14} className="aoc-liveness__icon" />
      <span className="aoc-liveness__word">{meta.word}</span>
    </span>
  );
}
