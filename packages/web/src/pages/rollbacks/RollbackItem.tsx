import type { CSSProperties } from 'react';
import { Link } from 'react-router-dom';
import type { RollbackDTO } from '@aoc/contracts';
import { Badge } from '../../components/Badge';
import { ButtonLink } from '../../components/Button';
import { Icon, type IconName } from '../../components/Icon';
import { RelativeTime } from '../../components/RelativeTime';
import { cx } from '../../lib/dom';
import { shortId } from '../audit/ids';
import { PersonName } from '../audit/people';
import { RefValue } from '../changes/bits';
import { ROLLBACK_STATUS_META, rollbackTrack, type StepState, type TrackStep } from './model';

const STEP_ICON: Record<StepState, IconName> = {
  done: 'check',
  current: 'clock',
  failed: 'danger',
  skipped: 'minus',
  pending: 'dot',
};
const STEP_WORD: Record<StepState, string> = {
  done: 'done',
  current: 'in progress',
  failed: 'failed',
  skipped: 'skipped',
  pending: 'not reached',
};

/** A gated flow as a row of steps; each step says its state in words as well as colour and glyph. */
export function StepTrack({ steps, label }: { steps: readonly TrackStep[]; label: string }) {
  return (
    <ol className="gov-track" style={{ '--steps': steps.length } as CSSProperties} aria-label={label}>
      {steps.map((s) => (
        <li key={s.id} className={cx('gov-track__step', `is-${s.state}`)}>
          <span className="gov-track__label">
            <Icon name={STEP_ICON[s.state]} size={12} />
            {s.label}
            <span className="aoc-sr-only">: {STEP_WORD[s.state]}.</span>
          </span>
          <span className="gov-track__detail">{s.detail}</span>
          {s.at && (
            <span className="gov-track__when">
              <RelativeTime value={s.at} suffix=" ago" />
            </span>
          )}
        </li>
      ))}
    </ol>
  );
}

export interface RollbackItemProps {
  rollback: RollbackDTO;
  projectName: string;
  /** The viewer may resolve rollback decisions (Approver). */
  canApprove: boolean;
}

export function RollbackItem({ rollback: r, projectName, canApprove }: RollbackItemProps) {
  const meta = ROLLBACK_STATUS_META[r.status];
  const steps = rollbackTrack(r);
  const focus = r.decisionId ? `/decisions?focus=${encodeURIComponent(r.decisionId)}` : null;
  return (
    <li className={cx('rollbacks-item', `is-${r.status}`)} id={`rollback-${r.rollbackId}`}>
      <div className="rollbacks-item__head">
        <div className="rollbacks-item__title">
          <span className="rollbacks-item__project">{projectName}</span>
          <span className="rollbacks-item__target">
            back to <RefValue refName={r.targetRef} sha={r.targetSha} label="rollback target" />
          </span>
        </div>
        <Badge tone={meta.tone} icon={meta.icon}>
          {meta.label}
        </Badge>
      </div>
      <p className="rollbacks-item__meta">
        requested by <PersonName id={r.requestedBy} /> <RelativeTime value={r.requestedAt} suffix=" ago" />
        {r.changeId && (
          <>
            {' '}
            · change <Link to={`/changes/${encodeURIComponent(r.changeId)}`}>{shortId(r.changeId)}</Link>
          </>
        )}
        {r.approval && (
          <>
            {' '}
            · approved by <PersonName id={r.approval.approverId} />
            {r.approval.passkeyVerified ? ' with a passkey' : ''}
          </>
        )}
        {r.rejection && (
          <>
            {' '}
            · rejected by <PersonName id={r.rejection.approverId} />
          </>
        )}
      </p>
      {r.reason && <p className="rollbacks-item__reason">{r.erased ? '[erased]' : r.reason}</p>}
      <StepTrack steps={steps} label={`Rollback to ${r.targetRef}: gate stages`} />
      {(r.verification?.report || r.failure?.detail || r.execution) && (
        <details className="rollbacks-item__report">
          <summary>
            {r.execution
              ? 'What changed on main'
              : r.failure
                ? 'Why it was not executed'
                : 'Verification report'}
          </summary>
          {r.execution && (
            <p className="rollbacks-item__exec">
              main <RefValue refName={r.execution.mainShaBefore} label="main before" />
              <Icon name="chevron-right" size={12} />
              <RefValue refName={r.execution.mainShaAfter} label="main after" />
            </p>
          )}
          {r.failure?.detail && <pre className="rollbacks-pre">{r.failure.detail}</pre>}
          {r.verification?.report && <pre className="rollbacks-pre">{r.verification.report}</pre>}
        </details>
      )}
      {r.status === 'awaiting_approval' && focus && (
        <div className="rollbacks-item__action">
          <ButtonLink to={focus} variant={canApprove ? 'primary' : 'secondary'} size="sm" icon="key">
            {canApprove ? 'Approve with passkey in Decisions' : 'Open the decision'}
          </ButtonLink>
          <span className="rollbacks-muted">
            {canApprove
              ? 'Shown clean on its branch. The passkey step happens on the decision.'
              : 'Only the Approver can approve a rollback, with a passkey.'}
          </span>
        </div>
      )}
    </li>
  );
}
