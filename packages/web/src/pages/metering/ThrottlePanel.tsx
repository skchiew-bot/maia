import { Link } from 'react-router-dom';
import type { MeteringThrottleDTO } from '@aoc/contracts';
import { MiniBarChart } from '../../charts';
import { LivenessBadge, Widget } from '../../components';
import { formatInteger } from '../../lib/format';
import { formatIdle } from './meteringModel';

export interface ThrottlePanelProps {
  throttle: MeteringThrottleDTO;
  projectName: (projectId: string | null) => string | null;
}

/**
 * Plan-limit hits and the idle time they cost (§10): the enterprise-migration case is productivity lost to
 * throttling, not just dollars. Per session, never per person.
 */
export function ThrottlePanel({ throttle, projectName }: ThrottlePanelProps) {
  const days = throttle.days.filter((d) => d.status !== 'unmetered');
  const sessions = [...throttle.bySession].sort((a, b) => b.idleMs - a.idleMs);
  const t = throttle.totals;
  return (
    <Widget
      span={7}
      id="throttle"
      title="Productivity lost to throttling"
      subtitle="Plan-limit hits and the idle time until each reset"
      info="Idle time runs from a plan-limit hit to its reset (or until now while a session is still throttled). It is the core of the Enterprise migration case."
      className="met-throttle"
    >
      <div className="met-figs">
        <div className="met-fig">
          <span className="met-fig__value">{formatIdle(t.idleMs)}</span>
          <span className="met-fig__label">idle at plan limits</span>
        </div>
        <div className="met-fig">
          <span className="met-fig__value">{formatInteger(t.hits)}</span>
          <span className="met-fig__label">plan-limit hit{t.hits === 1 ? '' : 's'}</span>
        </div>
        <div className="met-fig">
          <span className="met-fig__value">{formatInteger(t.throttledNow)}</span>
          <span className="met-fig__label">
            {t.throttledNow > 0 ? <LivenessBadge state="throttled" size="sm" /> : 'sessions throttled now'}
          </span>
        </div>
      </div>
      {days.length > 0 && (
        <MiniBarChart
          data={days.map((d) => ({
            date: d.date,
            value: d.idleMs / 60_000,
            note: d.hits ? `${d.hits} hit${d.hits === 1 ? '' : 's'}` : undefined,
          }))}
          label="Throttle idle minutes per day"
          format={(v) => `${Math.round(v)} min`}
          lastLabel={days[days.length - 1]?.status === 'open' ? 'Today' : 'Latest'}
          height={56}
        />
      )}
      {sessions.length > 0 ? (
        <ul className="met-throttled" aria-label="Throttled sessions">
          {sessions.slice(0, 6).map((s) => (
            <li key={s.sessionId}>
              <Link to={`/sessions/${encodeURIComponent(s.sessionId)}`}>
                <code>{s.sessionId}</code>
              </Link>
              <span className="met-throttled__project">{projectName(s.projectId) ?? 'No project'}</span>
              <span className="aoc-num">
                {formatIdle(s.idleMs)} · {s.hits} hit{s.hits === 1 ? '' : 's'}
              </span>
              {s.throttledNow && <LivenessBadge state="throttled" size="sm" />}
            </li>
          ))}
        </ul>
      ) : (
        <p className="met-quiet">No plan-limit hits in this range. Idle time appears here the moment a session hits its limit.</p>
      )}
    </Widget>
  );
}
