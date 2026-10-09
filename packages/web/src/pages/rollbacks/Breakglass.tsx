import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import type { BreakglassDTO } from '@aoc/contracts';
import type { AuthUser } from '../../api/auth';
import { apiPost } from '../../api/client';
import {
  Badge,
  Button,
  ButtonLink,
  Checkbox,
  Dialog,
  Icon,
  InlineAlert,
  RelativeTime,
  Select,
  TextArea,
  TextField,
  describeError,
  useToast,
} from '../../components';
import { cx } from '../../lib/dom';
import { formatAge, formatDateTime } from '../../lib/format';
import { PersonName, usePeople } from '../audit/people';
import { RefValue } from '../changes/bits';
import { blockedBySoleApprover, shortId } from '../changes/model';
import type { ProjectIndex } from '../changes/projects';
import { BREAKGLASS_STATUS_META, postIncidentState, promotionOutcome } from './model';

/** The mandatory post-incident record as a 24-hour countdown: a bar of the window used, and the time in words. */
export function PostIncidentCountdown({ b, now }: { b: BreakglassDTO; now: number }) {
  const s = postIncidentState(b, now);
  if (s.kind === 'none') return null;
  const link = `/changes/${encodeURIComponent(s.changeId)}`;
  if (s.kind === 'done')
    return (
      <p className="rollbacks-countdown is-done">
        <Icon name="check" size={14} /> Post-incident record <Link to={link}>{shortId(s.changeId)}</Link>{' '}
        completed.
      </p>
    );
  const overdue = s.kind === 'overdue';
  const ratio = overdue ? 1 : s.elapsedRatio;
  const words = overdue ? `overdue by ${formatAge(s.overdueMs)}` : `due in ${formatAge(s.remainingMs)}`;
  return (
    <div className={cx('rollbacks-countdown', overdue ? 'is-overdue' : 'is-due')}>
      <p className="rollbacks-countdown__line">
        <Icon name={overdue ? 'danger' : 'clock'} size={14} />
        <span>
          Post-incident record <Link to={link}>{shortId(s.changeId)}</Link> <strong>{words}</strong>
        </span>
        <span className="rollbacks-muted">({formatDateTime(s.dueAt)})</span>
      </p>
      <div
        className="rollbacks-countdown__bar"
        role="img"
        aria-label={`24-hour window ${overdue ? 'used up' : `${Math.round(ratio * 100)}% used`}: ${words}`}
      >
        <span style={{ width: `${ratio * 100}%` }} />
      </div>
    </div>
  );
}

export function BreakglassItem({
  b,
  projectName,
  now,
  canApprove,
}: {
  b: BreakglassDTO;
  projectName: string;
  now: number;
  canApprove: boolean;
}) {
  const meta = BREAKGLASS_STATUS_META[b.status];
  const { approvers } = usePeople();
  const stuck = b.status === 'pending' && blockedBySoleApprover(b.invokedBy, approvers);
  const promo = b.promotion ? promotionOutcome(b.promotion) : null;
  return (
    <li className={cx('rollbacks-bg', `is-${b.status}`)} id={`breakglass-${b.breakglassId}`}>
      <div className="rollbacks-item__head">
        <div className="rollbacks-item__title">
          <span className="rollbacks-item__project">{projectName}</span>
          <span className="rollbacks-item__target">
            promote <RefValue refName={b.ref} sha={b.sha} label="break-glass commit" />
          </span>
        </div>
        <Badge tone={meta.tone} icon={meta.icon}>
          {meta.label}
        </Badge>
      </div>
      <p className="rollbacks-item__meta">
        invoked by <PersonName id={b.invokedBy} /> <RelativeTime value={b.invokedAt} suffix=" ago" />
        {b.approval && (
          <>
            {' '}
            · approved by <PersonName id={b.approval.approverId} />
            {b.approval.passkeyVerified ? ' with a passkey' : ''}
          </>
        )}
        {b.rejection && (
          <>
            {' '}
            · not approved by <PersonName id={b.rejection.approverId} />
            {b.rejection.comment ? ` (“${b.rejection.comment}”)` : ''}
          </>
        )}
      </p>
      {b.justification && (
        <details className="rollbacks-item__report">
          <summary>Production-down justification</summary>
          <p className="rollbacks-justification">{b.erased ? '[erased]' : b.justification}</p>
        </details>
      )}
      {stuck && (
        <p className="rollbacks-warnline">
          <Icon name="warn" size={12} /> Invoked by the only Approver: nobody can approve it until a second
          Approver exists.
        </p>
      )}
      {promo && (
        <p className="rollbacks-item__meta">
          <Badge tone={promo.tone} icon={promo.icon} variant="outline">
            {promo.label}
          </Badge>{' '}
          {promo.detail}
        </p>
      )}
      <PostIncidentCountdown b={b} now={now} />
      {b.status === 'pending' && (
        <div className="rollbacks-item__action">
          <ButtonLink
            to={`/decisions?focus=${encodeURIComponent(b.decisionId)}`}
            variant={canApprove ? 'primary' : 'secondary'}
            size="sm"
            icon="key"
          >
            {canApprove ? 'Decide with passkey in Decisions' : 'Open the decision'}
          </ButtonLink>
          <span className="rollbacks-muted">
            Routes straight to the Approver; waiting {formatAge(now - Date.parse(b.invokedAt))}.
          </span>
        </div>
      )}
    </li>
  );
}

const CONFIRM_WORD = 'BREAK GLASS';

export interface BreakglassDialogProps {
  open: boolean;
  onClose: () => void;
  projects: ProjectIndex;
  viewer: AuthUser;
  defaultProjectId?: string;
  onInvoked: (b: BreakglassDTO) => void;
}

/**
 * Emergency promotion when production is down (§8): deliberately heavy. It bypasses the provenance check, routes
 * straight to the Approver, is the most heavily audited event, and auto-raises a post-incident change record due
 * within 24 hours of approval.
 */
export function BreakglassDialog({
  open,
  onClose,
  projects,
  viewer,
  defaultProjectId,
  onInvoked,
}: BreakglassDialogProps) {
  const toast = useToast();
  const { approvers } = usePeople();
  const [projectId, setProjectId] = useState('');
  const [ref, setRef] = useState('');
  const [down, setDown] = useState('');
  const [why, setWhy] = useState('');
  const [fix, setFix] = useState('');
  const [checks, setChecks] = useState({ down: false, record: false, audited: false, anyway: false });
  const [confirm, setConfirm] = useState('');
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(undefined);

  useEffect(() => {
    if (!open) return;
    setProjectId(defaultProjectId ?? '');
    setRef('');
    setDown('');
    setWhy('');
    setFix('');
    setChecks({ down: false, record: false, audited: false, anyway: false });
    setConfirm('');
    setTouched(false);
    setError(undefined);
  }, [open, defaultProjectId]);

  const soleApprover = blockedBySoleApprover(viewer.id, approvers);
  const approverNames = approvers.map((a) => a.name).join(' or ') || 'the Approver';
  const justification = useMemo(
    () =>
      [
        `What is down and for whom:\n${down.trim()}`,
        `Why the normal path is too slow:\n${why.trim()}`,
        `The fix and how the result will be checked:\n${fix.trim()}`,
      ].join('\n\n'),
    [down, why, fix],
  );
  const problems = {
    projectId: !projectId ? 'Choose the project whose production is down.' : undefined,
    ref: !ref.trim() ? 'Name the commit, branch or pinned tag to promote.' : undefined,
    down:
      down.trim().length < 10 ? 'Describe what is down and for whom (at least 10 characters).' : undefined,
    why: why.trim().length < 10 ? 'Explain why change request, UAT and go-live are too slow.' : undefined,
    fix: fix.trim().length < 10 ? 'Describe the fix and how you will check it worked.' : undefined,
    checks: !(checks.down && checks.record && checks.audited) ? 'Confirm all three statements.' : undefined,
    anyway: soleApprover && !checks.anyway ? 'Acknowledge that nobody can approve it.' : undefined,
    confirm: confirm.trim().toUpperCase() !== CONFIRM_WORD ? `Type ${CONFIRM_WORD} to confirm.` : undefined,
  };
  const ready = Object.values(problems).every((p) => !p);
  const show = (k: keyof typeof problems) => (touched ? problems[k] : undefined);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (!ready) return;
    setBusy(true);
    setError(undefined);
    try {
      const b = await apiPost<BreakglassDTO>('/api/breakglass', {
        projectId,
        ref: ref.trim(),
        justification,
      });
      toast.notify({
        tone: 'warn',
        title: 'Break-glass invoked',
        body: `The emergency promotion waits for ${approverNames}. A post-incident record becomes due 24 hours after approval.`,
      });
      onInvoked(b);
      onClose();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      role="alertdialog"
      title="Break-glass: emergency promotion"
      description="Only when production is down and the normal path is too slow. A controlled exception beats a rule bypassed in a crisis."
      dismissOnBackdrop={false}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="danger"
            icon="warn"
            type="submit"
            form="rollbacks-breakglass"
            loading={busy}
            loadingText="Invoking…"
          >
            Invoke break-glass
          </Button>
        </>
      }
    >
      <form id="rollbacks-breakglass" className="rollbacks-form" onSubmit={submit} noValidate>
        <InlineAlert tone="danger" title="The most heavily audited event in AOC">
          It bypasses the provenance check (the sole exception), routes straight to {approverNames}, who
          approves with a passkey, and auto-raises a post-incident change record due within 24 hours of
          approval, under your name.
        </InlineAlert>
        {soleApprover ? (
          <InlineAlert tone="danger" title="Single-Approver warning: nobody could approve this">
            The invoker of a break-glass can never approve it (separation of duties), and you are the only
            Approver. If you invoke it, nobody can approve it. Until a deputy Approver exists, a Builder
            invokes and the CEO approves.
          </InlineAlert>
        ) : (
          viewer.role === 'approver' && (
            <InlineAlert tone="info" title="You cannot approve your own break-glass">
              Another Approver has to approve it (separation of duties).
            </InlineAlert>
          )
        )}
        {error !== undefined && (
          <InlineAlert tone="danger" title="Break-glass was not invoked" live>
            {describeError(error)}
          </InlineAlert>
        )}
        <div className="rollbacks-form__row">
          <Select
            label="Project"
            required
            value={projectId}
            placeholder="Choose the project"
            onChange={(e) => setProjectId(e.target.value)}
            error={show('projectId')}
            options={projects.projects.map((p) => ({ value: p.projectId, label: p.name }))}
          />
          <TextField
            label="Commit, branch or pinned tag to promote"
            required
            value={ref}
            onChange={(e) => setRef(e.target.value)}
            placeholder="hotfix/claims-dedupe or a commit SHA"
            error={show('ref')}
            hint="A hotfix from a managed session, or the last known-good pinned tag."
          />
        </div>
        <TextArea
          label="What is down, and for whom?"
          required
          rows={2}
          value={down}
          onChange={(e) => setDown(e.target.value)}
          error={show('down')}
        />
        <TextArea
          label="Why is the normal path too slow?"
          required
          rows={2}
          value={why}
          onChange={(e) => setWhy(e.target.value)}
          error={show('why')}
          hint="The normal path: a change request with its four fields, UAT, then the go-live gate with its provenance check."
        />
        <TextArea
          label="The fix, and how the result will be checked"
          required
          rows={2}
          value={fix}
          onChange={(e) => setFix(e.target.value)}
          error={show('fix')}
        />
        <fieldset className="rollbacks-checks">
          <legend className="aoc-field__label">
            Confirm <span className="aoc-field__required">(required)</span>
          </legend>
          <Checkbox
            label="Production is down or critically degraded for users."
            checked={checks.down}
            onChange={(e) => setChecks((c) => ({ ...c, down: e.target.checked }))}
          />
          <Checkbox
            label="A post-incident change record will be due within 24 hours of approval, under my name."
            checked={checks.record}
            onChange={(e) => setChecks((c) => ({ ...c, record: e.target.checked }))}
          />
          <Checkbox
            label="This is recorded as the most heavily audited event in AOC, and reviewed afterwards."
            checked={checks.audited}
            onChange={(e) => setChecks((c) => ({ ...c, audited: e.target.checked }))}
          />
          {soleApprover && (
            <Checkbox
              label="I understand nobody can approve a break-glass I invoke while I am the only Approver."
              checked={checks.anyway}
              onChange={(e) => setChecks((c) => ({ ...c, anyway: e.target.checked }))}
            />
          )}
          {show('checks') && <p className="aoc-field__error">{problems.checks}</p>}
          {show('anyway') && <p className="aoc-field__error">{problems.anyway}</p>}
        </fieldset>
        <TextField
          label={`Type ${CONFIRM_WORD} to confirm`}
          required
          value={confirm}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => setConfirm(e.target.value)}
          error={show('confirm')}
        />
      </form>
    </Dialog>
  );
}
