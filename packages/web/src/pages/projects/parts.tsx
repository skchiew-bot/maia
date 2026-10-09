import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { ManifestTaskDTO } from '@aoc/contracts';
import { CopyableHash, Icon, LivenessBadge, type IconName } from '../../components';
import { cx } from '../../lib/dom';
import { formatInteger } from '../../lib/format';
import { DriftGlyph, FlagGlyph, ScopeGlyph, StatusGlyph, type TaskStatusGlyph } from './glyphs';
import {
  FLAG_LABEL,
  SIZE_WEIGHT,
  attentionLabel,
  isSha,
  orderedCounts,
  type AttentionReason,
  type LivenessCounts,
} from './model';

/** A project's live sessions as liveness badges with counts, in §4 precedence order. */
export function LiveMix({
  counts,
  empty = 'No live sessions',
}: {
  counts: LivenessCounts;
  empty?: ReactNode;
}) {
  const entries = orderedCounts(counts);
  if (entries.length === 0) return <span className="prj-muted">{empty}</span>;
  return (
    <ul className="prj-livemix" aria-label="Live sessions by state">
      {entries.map(([state, n]) => (
        <li key={state}>
          <LivenessBadge
            state={state}
            size="sm"
            detail={<span className="aoc-num">{formatInteger(n)}</span>}
          />
        </li>
      ))}
    </ul>
  );
}

const REASON_ICON: Record<AttentionReason['kind'], IconName | 'drift' | 'flag' | 'scope'> = {
  decisions: 'decisions',
  dead: 'dead',
  stalled: 'stalled',
  throttled: 'throttled',
  drift_high: 'drift',
  drift: 'drift',
  flagged: 'flag',
  scope: 'scope',
  stale: 'clock',
};

function reasonHref(kind: AttentionReason['kind'], projectId: string): string {
  const base = `/projects/${encodeURIComponent(projectId)}`;
  switch (kind) {
    case 'decisions':
      return '/decisions';
    case 'drift':
    case 'drift_high':
      return `${base}#drift`;
    case 'flagged':
      return `${base}?tasks=flagged#timeline`;
    case 'scope':
      return `${base}#scope`;
    default:
      return `${base}#sessions`;
  }
}

function ReasonIcon({ kind }: { kind: AttentionReason['kind'] }) {
  const icon = REASON_ICON[kind];
  if (icon === 'drift') return <DriftGlyph size={12} className="prj-reason__icon" />;
  if (icon === 'flag') return <FlagGlyph size={12} className="prj-reason__icon" />;
  if (icon === 'scope') return <ScopeGlyph size={12} className="prj-reason__icon" />;
  return <Icon name={icon} size={12} className="prj-reason__icon" />;
}

/**
 * Why a project sits where it does in the attention order, heaviest first, each reason linking to where it is
 * resolved. The rest folds into "+N more", which opens the project.
 */
export function AttentionReasons({
  reasons,
  projectId,
  max = 4,
}: {
  reasons: readonly AttentionReason[];
  projectId: string;
  max?: number;
}) {
  if (reasons.length === 0)
    return (
      <span className="prj-calm">
        <Icon name="ok" size={12} className="prj-calm__icon" /> Nothing needs attention
      </span>
    );
  const shown = reasons.length > max ? reasons.slice(0, max - 1) : reasons;
  const rest = reasons.length - shown.length;
  return (
    <ul className="prj-reasons">
      {shown.map((r) => (
        <li key={r.kind} className={cx('prj-reason', `prj-reason--${r.kind}`)}>
          <Link to={reasonHref(r.kind, projectId)}>
            <ReasonIcon kind={r.kind} />
            <span className="aoc-num">{attentionLabel(r)}</span>
          </Link>
        </li>
      ))}
      {rest > 0 && (
        <li className="prj-reason prj-reason--more">
          <Link
            to={`/projects/${encodeURIComponent(projectId)}`}
            aria-label={`${rest} more: ${reasons.slice(shown.length).map(attentionLabel).join(', ')}`}
          >
            <span className="aoc-num">+{rest} more</span>
          </Link>
        </li>
      )}
    </ul>
  );
}

const STATUS_WORD: Record<TaskStatusGlyph, string> = {
  done: 'Done',
  active: 'In progress',
  pending: 'Not started',
  removed: 'Removed',
};

export function StatusText({ state, children }: { state: TaskStatusGlyph; children?: ReactNode }) {
  return (
    <span className={cx('prj-status', `prj-status--${state}`)}>
      <StatusGlyph state={state} size={13} />
      <span>{children ?? STATUS_WORD[state]}</span>
    </span>
  );
}

export function SizeChip({ size }: { size: ManifestTaskDTO['size'] }) {
  return (
    <span className="prj-size" title={`Declared size ${size.toUpperCase()}, weight ${SIZE_WEIGHT[size]}`}>
      {size}
      <span className="aoc-sr-only">, weight {SIZE_WEIGHT[size]}</span>
    </span>
  );
}

/** Evidence carried by task_done (§4): a test id, a commit SHA or a diff reference — untrusted text, rendered as text. */
export function EvidenceChip({ evidence }: { evidence: NonNullable<ManifestTaskDTO['evidence']> }) {
  return (
    <span className={cx('prj-evidence', !evidence.verified && 'is-unverified')}>
      <b>{evidence.kind}</b>
      {evidence.kind === 'commit' && isSha(evidence.ref) ? (
        <CopyableHash value={evidence.ref} length={7} label="commit SHA" />
      ) : (
        <code title={evidence.ref}>{evidence.ref}</code>
      )}
      {!evidence.verified && (
        <span className="prj-evidence__unverified">
          <Icon name="warn" size={12} /> unverified
        </span>
      )}
    </span>
  );
}

export function FlagNote({ flag }: { flag: NonNullable<ManifestTaskDTO['flag']> }) {
  return (
    <p className="prj-flag">
      <FlagGlyph size={12} className="prj-flag__icon" />
      <span>
        {FLAG_LABEL[flag]} <span className="prj-flag__note">· counts until reviewed</span>
      </span>
    </p>
  );
}

/** Pinned rollback point: the tag as text and its commit as a copyable short SHA. */
export function PinRef({ tag, sha }: { tag: string | null; sha: string | null }) {
  if (!tag && !sha) return <span className="prj-muted">No pin yet</span>;
  return (
    <span className="prj-pin">
      <FlagGlyph size={12} className="prj-pin__icon" />
      {tag && (
        <code className="prj-pin__tag" title={tag}>
          {tag}
        </code>
      )}
      {sha && <CopyableHash value={sha} length={8} label={`commit pinned by ${tag ?? 'the phase'}`} />}
    </span>
  );
}
