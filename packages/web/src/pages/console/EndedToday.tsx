import type { SessionSummary } from '@aoc/contracts';
import { useId, useMemo } from 'react';
import { DataTable, type DataTableColumn } from '../../components/DataTable';
import { EmptyState } from '../../components/EmptyState';
import { Money } from '../../components/Money';
import { formatClock, formatInteger, formatUsd } from '../../lib/format';
import { modelLabel, outcomeText } from '../sessions/sessionText';
import { endedSpend } from './model';

export interface EndedTodayProps {
  sessions: readonly SessionSummary[];
  /** True when filters hide some of today's ended sessions. */
  filtered: boolean;
}

/** Sessions that finished today: when, how, what they closed and what they cost (part of today's spend). */
export function EndedToday({ sessions, filtered }: EndedTodayProps) {
  const headingId = useId();
  const spend = endedSpend(sessions);
  const columns = useMemo<DataTableColumn<SessionSummary>[]>(
    () => [
      {
        id: 'session',
        header: 'Session',
        primary: true,
        sortValue: (s) => s.title,
        cell: (s) => <span className="console-ended__title">{s.title}</span>,
      },
      {
        id: 'project',
        header: 'Project',
        sortValue: (s) => s.projectName,
        cell: (s) => (
          <span className="console-cellstack">
            {s.projectName ?? '—'}
            <span className="console-cellsub">
              {[s.processType, modelLabel(s.model)].filter(Boolean).join(' · ')}
            </span>
          </span>
        ),
      },
      {
        id: 'ended',
        header: 'Ended',
        sortValue: (s) => s.endedAt,
        firstSort: 'desc',
        sortLabels: ['earliest first', 'latest first'],
        cell: (s) => (s.endedAt ? <time dateTime={s.endedAt}>{formatClock(s.endedAt)}</time> : '—'),
      },
      { id: 'outcome', header: 'Outcome', cell: (s) => outcomeText(s) },
      {
        id: 'tasks',
        header: 'Tasks closed',
        numeric: true,
        sortValue: (s) => s.progress?.doneTasks ?? null,
        cell: (s) =>
          s.progress ? `${formatInteger(s.progress.doneTasks)} of ${formatInteger(s.progress.totalTasks)}` : '—',
      },
      {
        id: 'cost',
        header: 'Notional today',
        numeric: true,
        sortValue: (s) => s.costTodayUsd,
        cell: (s) => <Money usd={s.costTodayUsd} myr={s.costTodayRm} layout="stacked" />,
      },
    ],
    [],
  );
  return (
    <section className="console-panel console-ended" aria-labelledby={headingId}>
      <header className="console-panel__head">
        <h2 id={headingId} className="console-panel__title">
          Ended today
        </h2>
        <p className="console-panel__meta">
          {formatInteger(sessions.length)} {sessions.length === 1 ? 'session' : 'sessions'} ·{' '}
          <span className="aoc-num">{formatUsd(spend.usd)}</span> notional, included in today’s spend
        </p>
      </header>
      <DataTable
        caption="Sessions that ended today"
        columns={columns}
        rows={sessions}
        rowKey={(s) => s.sessionId}
        rowHref={(s) => `/sessions/${encodeURIComponent(s.sessionId)}`}
        defaultSort={{ columnId: 'ended', direction: 'desc' }}
        empty={
          <EmptyState
            size="sm"
            title={filtered ? 'No ended sessions match these filters' : 'No session has ended today'}
            body="Sessions that finish, roll over or are stopped today are listed here with their outcome and cost."
          />
        }
      />
    </section>
  );
}
