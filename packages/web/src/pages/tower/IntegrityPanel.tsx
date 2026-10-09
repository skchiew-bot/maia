import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { TowerAttentionItem, TowerIntegrity } from '@aoc/contracts';
import { Icon, RelativeTime, Widget, formatAge, formatClock, formatInteger, useNow, type IconName } from '../../components';
import { cx } from '../../lib/dom';
import { ANCHOR_WARN_MS, anchorAge, breakglassDueIn } from './towerModel';

type CellTone = 'ok' | 'warn' | 'danger' | 'info';

const TONE_ICON: Record<CellTone, IconName> = { ok: 'ok', warn: 'warn', danger: 'danger', info: 'info' };
const TONE_WORD: Record<CellTone, string> = { ok: 'OK', warn: 'Needs action', danger: 'Failing', info: 'For information' };

interface Cell {
  key: string;
  tone: CellTone;
  title: string;
  value: ReactNode;
  detail: ReactNode;
  href: string;
}

/**
 * The governance strip the CEO and the auditor share (§13): chain verification against the off-host anchor,
 * anchor age (late after 26 h), break-glass and its 24 h post-incident clock, provenance refusals,
 * self-modification blocks, the ISO 42001 mapping stamp, and projection health.
 */
export function IntegrityPanel({
  integrity,
  attention,
}: {
  integrity: TowerIntegrity;
  attention: readonly TowerAttentionItem[];
}) {
  const now = useNow();
  const ageMs = anchorAge(integrity.lastAnchorAt, integrity.anchorAgeMs, now);
  const anchorLate = ageMs === null || ageMs > ANCHOR_WARN_MS;
  const openBreakglass = attention.filter((a) => a.kind === 'breakglass_open');
  const overdue = attention.filter((a) => a.kind === 'post_incident_overdue');

  const cells: Cell[] = [
    {
      key: 'chain',
      tone: integrity.chainOk === true ? 'ok' : integrity.chainOk === false ? 'danger' : 'info',
      title: 'Hash chain',
      value: integrity.chainOk === true ? 'Verified' : integrity.chainOk === false ? 'Broken' : 'Not verified yet',
      detail: (
        <>
          {integrity.lastVerifiedAt ? (
            <>
              checked against the off-host anchor at <span className="aoc-num">{formatClock(integrity.lastVerifiedAt)}</span>
            </>
          ) : (
            'no verification has run yet'
          )}{' '}
          · <span className="aoc-num">{formatInteger(integrity.unanchoredEvents)}</span> events since the last anchor
        </>
      ),
      href: '/audit',
    },
    {
      key: 'anchor',
      tone: anchorLate ? 'warn' : 'ok',
      title: 'Off-host anchor',
      value: ageMs === null ? 'None yet' : `${formatAge(ageMs)} old`,
      detail:
        ageMs === null
          ? 'Verify cannot test the chain against an external proof until the first nightly anchor'
          : anchorLate
            ? 'Nightly anchor missed: newer events have no external proof yet'
            : (
                <>
                  last anchored <span className="aoc-num">{formatClock(integrity.lastAnchorAt ?? now - ageMs)}</span> ·
                  flagged after 26 h
                </>
              ),
      href: '/audit',
    },
    {
      key: 'breakglass',
      tone: integrity.breakglassOpen > 0 ? 'warn' : 'ok',
      title: 'Break-glass open',
      value: integrity.breakglassOpen,
      detail:
        openBreakglass.length > 0 ? (
          <ul className="tower-ig__list">
            {openBreakglass.map((a) => {
              const due = breakglassDueIn(a.since, now);
              return (
                <li key={a.id}>
                  <Link to={a.action.href}>{a.title}</Link> · post-incident record{' '}
                  {due >= 0 ? (
                    <>
                      due in <b className="aoc-num">{formatAge(due)}</b>
                    </>
                  ) : (
                    <>
                      <b className="aoc-num">{formatAge(-due)}</b> overdue
                    </>
                  )}
                </li>
              );
            })}
          </ul>
        ) : integrity.breakglassOpen > 0 ? (
          'a post-incident change record is due within 24 h of each emergency promotion'
        ) : (
          'no emergency promotion is open'
        ),
      href: '/changes',
    },
    {
      key: 'postincident',
      tone: integrity.postIncidentOverdue > 0 ? 'warn' : 'ok',
      title: 'Post-incident overdue',
      value: integrity.postIncidentOverdue,
      detail:
        overdue.length > 0 ? (
          <ul className="tower-ig__list">
            {overdue.map((a) => (
              <li key={a.id}>
                <Link to={a.action.href}>{a.title}</Link> ·{' '}
                <b>
                  <RelativeTime value={a.since} />
                </b>{' '}
                past the 24 h limit
              </li>
            ))}
          </ul>
        ) : integrity.postIncidentOverdue > 0 ? (
          'past the 24 h limit after a break-glass promotion'
        ) : (
          'every post-incident record was filed within 24 h'
        ),
      href: '/changes',
    },
    {
      key: 'provenance',
      tone: 'info',
      title: 'Provenance refusals · 7d',
      value: integrity.provenanceRefusals7d,
      detail: 'promotions refused: no approved change record, UAT sign-off and gate',
      href: '/changes',
    },
    {
      key: 'selfmod',
      tone: 'info',
      title: 'Self-modification · 7d',
      value: `${integrity.selfModBlocks7d} blocked`,
      detail: 'agent edits to the governance, audit or credit core (§13), audited outside AOC',
      href: '/audit',
    },
    {
      key: 'mapping',
      tone: integrity.mappingStatus === 'stamped' ? 'ok' : integrity.mappingStatus === 'provisional' ? 'warn' : 'info',
      title: 'ISO 42001 mapping',
      value:
        integrity.mappingStatus === 'stamped'
          ? 'Stamped'
          : integrity.mappingStatus === 'provisional'
            ? 'Provisional'
            : 'Unknown',
      detail:
        integrity.mappingStatus === 'stamped'
          ? 'reviewed and stamped by the compliance lead'
          : integrity.mappingStatus === 'provisional'
            ? 'not yet stamped by the compliance lead'
            : 'mapping status is not available',
      href: '/compliance',
    },
    {
      key: 'projections',
      tone: integrity.degradedProjections > 0 ? 'warn' : 'ok',
      title: 'Projections and reactors',
      value: `${integrity.degradedProjections} degraded`,
      detail: (
        <>
          <span className="aoc-num">{integrity.reactorFailures24h}</span> reactor{' '}
          {integrity.reactorFailures24h === 1 ? 'failure' : 'failures'} in 24 h
        </>
      ),
      href: '/audit',
    },
  ];

  return (
    <Widget
      title="Integrity and governance"
      subtitle="ISO/IEC 42001 evidence: one hash-chained log for the CEO and the auditor"
      flush
      className="tower-integrity"
    >
      <ul className="tower-igs">
        {cells.map((c) => (
          <li key={c.key} className={cx('tower-ig', `tower-ig--${c.tone}`)}>
            <p className="tower-ig__t">
              <Icon name={TONE_ICON[c.tone]} size={13} />
              <span className="aoc-sr-only">{TONE_WORD[c.tone]}: </span>
              <Link to={c.href}>{c.title}</Link>
            </p>
            <p className="tower-ig__v aoc-num">{c.value}</p>
            <div className="tower-ig__s">{c.detail}</div>
          </li>
        ))}
      </ul>
    </Widget>
  );
}
