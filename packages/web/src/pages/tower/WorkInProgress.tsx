import { Link } from 'react-router-dom';
import type { TowerFlow } from '@aoc/contracts';
import { EmptyState, Widget } from '../../components';

function clampPct(n: number): number {
  return Math.max(0, Math.min(100, n));
}

/**
 * Live sessions, open tasks and weighted completion per project (tasks done ÷ declared weight, §4/§9).
 * A compact table on wide screens; on phones each project becomes name, bar, then counts (explicit roles keep
 * the table semantics when CSS re-flows it).
 */
export function WorkInProgress({ rows }: { rows: TowerFlow['wipByProject'] }) {
  return (
    <Widget title="Work in progress" subtitle="By project · weighted completion" flush className="tower-wip">
      {rows.length === 0 ? (
        <EmptyState
          size="sm"
          title="No project has live work"
          body="Projects appear here once a session is launched against them with aoc run."
        />
      ) : (
        <table className="tower-wip__table" role="table">
          <caption className="aoc-sr-only">Work in progress by project</caption>
          <thead role="rowgroup">
            <tr role="row">
              <th role="columnheader" scope="col">
                Project
              </th>
              <th role="columnheader" scope="col" className="is-num">
                Live sessions
              </th>
              <th role="columnheader" scope="col" className="is-num">
                Open tasks
              </th>
              <th role="columnheader" scope="col">
                Progress
              </th>
            </tr>
          </thead>
          <tbody role="rowgroup">
            {rows.map((r) => {
              const pct = clampPct(r.progressPct);
              return (
                <tr key={r.projectId} role="row">
                  <th role="rowheader" scope="row" className="tower-wip__name">
                    <Link to={`/projects/${encodeURIComponent(r.projectId)}`}>{r.name}</Link>
                  </th>
                  <td role="cell" className="is-num tower-wip__sess">
                    <span className="aoc-num">{r.activeSessions}</span>
                    <span className="tower-wip__unit"> live {r.activeSessions === 1 ? 'session' : 'sessions'}</span>
                  </td>
                  <td role="cell" className="is-num tower-wip__tasks">
                    <span className="aoc-num">{r.openTasks}</span>
                    <span className="tower-wip__unit"> open {r.openTasks === 1 ? 'task' : 'tasks'}</span>
                  </td>
                  <td role="cell" className="tower-wip__prog">
                    <span className="tower-wip__p">
                      <span className="tower-meter" aria-hidden="true">
                        <span style={{ width: `${pct}%` }} />
                      </span>
                      <b className="aoc-num">{Math.round(pct)}%</b>
                      <span className="aoc-sr-only"> of declared weight done</span>
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </Widget>
  );
}
