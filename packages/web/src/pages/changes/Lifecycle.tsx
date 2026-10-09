import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { ChangeRequestDTO } from '@aoc/contracts';
import { Icon, type IconName } from '../../components/Icon';
import { RelativeTime } from '../../components/RelativeTime';
import { cx } from '../../lib/dom';
import { formatDateTime, formatDuration } from '../../lib/format';
import { ActorName, PersonName } from '../audit/people';
import { RefValue } from './bits';
import { SCOPE_META, actorKindOf, lifecycleSegments } from './model';

/**
 * Where this change record's time went (§8): drafting, waiting at the gate, approved but not started, in progress.
 * Widths are to scale; every segment prints its duration, and the open stage says "so far".
 */
export function LifecycleStrip({ change, now }: { change: ChangeRequestDTO; now: number }) {
  const segs = lifecycleSegments(change, now);
  const start = segs[0]!.from;
  const end = segs[segs.length - 1]!.to;
  const total = Math.max(1, end - start);
  const open = segs.some((s) => s.ongoing);
  const summary = `${open ? 'Open for' : 'Closed after'} ${formatDuration(end - start)}: ${segs
    .map((s) => `${s.label} ${formatDuration(s.to - s.from)}${s.ongoing ? ' so far' : ''}`)
    .join('; ')}.`;
  return (
    <figure className="changes-life">
      <figcaption className="changes-life__total">
        {open ? 'Open for' : 'Closed after'}{' '}
        <strong className="aoc-num">{formatDuration(end - start)}</strong>
        <span> since it was drafted {formatDateTime(start)}</span>
      </figcaption>
      <div className="changes-life__bar" role="img" aria-label={summary}>
        {segs.map((s) => (
          <span
            key={s.id}
            className={cx('changes-life__seg', `is-${s.id}`, s.ongoing && 'is-ongoing')}
            style={{ flexGrow: Math.max(0.0001, (s.to - s.from) / total) }}
            title={`${s.label}: ${formatDuration(s.to - s.from)}${s.ongoing ? ' so far' : ''}`}
          />
        ))}
      </div>
      <ol className="changes-life__legend" aria-hidden="true">
        {segs.map((s) => (
          <li key={s.id} className={cx(`is-${s.id}`, s.ongoing && 'is-ongoing')}>
            <span className="changes-life__swatch" />
            <span className="changes-life__name">{s.label}</span>
            <strong className="aoc-num">{formatDuration(s.to - s.from)}</strong>
            {s.ongoing && <span className="changes-life__now">so far</span>}
          </li>
        ))}
      </ol>
    </figure>
  );
}

function Step({
  icon,
  tone,
  title,
  at,
  children,
}: {
  icon: IconName;
  tone: 'done' | 'current' | 'closed' | 'pending';
  title: string;
  at?: string | null;
  children?: ReactNode;
}) {
  return (
    <li className={cx('changes-steps__step', `is-${tone}`)}>
      <Icon name={icon} size={14} className="changes-steps__icon" />
      <div className="changes-steps__body">
        <p className="changes-steps__title">
          {title}
          {at && (
            <span className="changes-steps__at">
              <RelativeTime value={at} suffix=" ago" />
            </span>
          )}
        </p>
        {children && <div className="changes-steps__detail">{children}</div>}
      </div>
    </li>
  );
}

function Who({ id }: { id: string }) {
  const kind = actorKindOf(id);
  return kind === 'human' ? <PersonName id={id} /> : <ActorName actor={{ kind, id }} />;
}

/** Every action on the record, with the developer's name on it (§6, §8). */
export function LifecycleSteps({ change }: { change: ChangeRequestDTO }) {
  const c = change;
  const affirmed = c.fields.filter((f) => f.affirmed);
  const lastAffirmed =
    affirmed
      .map((f) => f.affirmedAt ?? '')
      .sort()
      .pop() || null;
  return (
    <ol className="changes-steps">
      <Step icon="changes" tone="done" title="Drafted" at={c.createdAt}>
        by <Who id={c.createdBy} />
        {c.ownerId && c.ownerId !== c.createdBy && (
          <>
            {' '}
            · accountable: <PersonName id={c.ownerId} />
          </>
        )}{' '}
        ·{' '}
        {c.draftedBy === 'ai' ? 'AI drafted the four fields' : 'no AI draft; the developer writes each field'}
        {c.breakglassId && <> · raised automatically by break-glass</>}
      </Step>
      <Step
        icon={affirmed.length === 4 ? 'check' : 'clock'}
        tone={affirmed.length === 4 ? 'done' : c.status === 'draft' ? 'current' : 'pending'}
        title={`${affirmed.length} of 4 fields affirmed`}
        at={lastAffirmed}
      >
        {affirmed.length > 0 ? (
          <>
            by{' '}
            {[...new Set(affirmed.map((f) => f.affirmedBy).filter((x): x is string => !!x))].map((id, i) => (
              <span key={id}>
                {i > 0 && ', '}
                <PersonName id={id} />
              </span>
            ))}
            {affirmed.some((f) => f.blind) && <> · includes a blind one-click confirm</>}
          </>
        ) : (
          'each field must be edited or affirmed before the record can be submitted'
        )}
      </Step>
      {c.submittedAt ? (
        <Step icon="decisions" tone="done" title="Submitted" at={c.submittedAt}>
          by {c.submittedBy ? <PersonName id={c.submittedBy} /> : 'unknown'} ·{' '}
          {SCOPE_META[c.scope].gate === 'self' && c.selfApprovable
            ? 'reversible off-main work, self-approved'
            : 'routed to the Approver'}
          {c.rollbackRef && (
            <>
              {' '}
              · returns to <RefValue refName={c.rollbackRef} sha={c.rollbackSha} label="rollback target" />
            </>
          )}
        </Step>
      ) : (
        <Step icon="decisions" tone="pending" title="Not submitted yet" />
      )}
      {c.approval ? (
        <Step
          icon="ok"
          tone="done"
          title={c.approval.selfApproved ? 'Self-approved' : 'Approved'}
          at={c.approval.at}
        >
          by <PersonName id={c.approval.approverId} />
          {c.approval.selfApproved
            ? ' · reversible off-main work; the record is still complete (§6)'
            : c.decisionId && (
                <>
                  {' '}
                  · <Link to={`/decisions?focus=${encodeURIComponent(c.decisionId)}`}>decision</Link>
                </>
              )}
        </Step>
      ) : c.rejection ? (
        <Step icon="close" tone="closed" title="Rejected" at={c.rejection.at}>
          by <PersonName id={c.rejection.approverId} />
          {c.rejection.comment ? <> · “{c.rejection.comment}”</> : null}
        </Step>
      ) : c.status === 'submitted' ? (
        <Step icon="decisions" tone="current" title="Waiting for approval">
          {c.decisionId ? (
            <Link to={`/decisions?focus=${encodeURIComponent(c.decisionId)}`}>Open the decision</Link>
          ) : (
            'no decision card yet'
          )}
        </Step>
      ) : null}
      {c.sessions.map((s) => (
        <Step
          key={s.sessionId}
          icon="working"
          tone="done"
          title="Work started in a managed session"
          at={s.startedAt}
        >
          <Who id={s.sessionId} />
          {s.inheritedFrom && <> · continued from a rolled-over session</>}
        </Step>
      ))}
      {c.completedAt && (
        <Step icon="check" tone="done" title="Completed and pinned" at={c.completedAt}>
          <RefValue refName={c.pinnedTag} sha={c.pinnedSha} label="pinned" />
        </Step>
      )}
    </ol>
  );
}
