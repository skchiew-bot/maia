import type { AuditEventHeaderDTO } from '@aoc/contracts';
import { EmptyState, Icon, RelativeTime } from '../../components';
import { formatInteger } from '../../lib/format';
import { ActorName } from './people';

/**
 * Blocked attempts by AOC-managed agents to change the governance, audit or credit core or AOC's own audit state
 * (§13 self-modification boundary). Paths are personal-data-free hashes in the chain; Approvers can open the body.
 */
export function SelfModBlocks({
  events,
  total,
  last24h,
  onOpen,
}: {
  events: readonly AuditEventHeaderDTO[];
  total: number;
  last24h: number;
  onOpen: (e: AuditEventHeaderDTO) => void;
}) {
  return (
    <div className="audit-selfmod">
      <p className="audit-selfmod__totals">
        <strong className="aoc-num">{formatInteger(total)}</strong> blocked in total ·{' '}
        <strong className="aoc-num">{formatInteger(last24h)}</strong> in the last 24 hours
      </p>
      {events.length === 0 ? (
        <EmptyState
          size="sm"
          icon="ok"
          title="No attempt blocked"
          body="An agent that tries to edit the governance, audit or credit core, or AOC's own audit state, is stopped and recorded here and outside AOC."
        />
      ) : (
        <ol className="audit-selfmod__list">
          {events.slice(0, 12).map((e) => (
            <li key={e.seq}>
              <p className="audit-selfmod__line">
                <code>{String(e.meta.rule ?? 'blocked')}</code>
                <span className="audit-muted">
                  <RelativeTime value={e.ts} suffix=" ago" />
                </span>
              </p>
              <p className="audit-selfmod__line audit-selfmod__line--sub">
                <ActorName actor={{ kind: 'agent', id: String(e.meta.sessionId ?? e.actor.id) }} />
                <button type="button" className="audit-seq" onClick={() => onOpen(e)}>
                  path {String(e.meta.pathHash ?? '').slice(0, 8)}… · #{formatInteger(e.seq)}
                </button>
                <span className={e.meta.externalLogged === true ? 'audit-yesno is-yes' : 'audit-yesno is-no'}>
                  <Icon name={e.meta.externalLogged === true ? 'check' : 'warn'} size={12} />
                  {e.meta.externalLogged === true ? 'logged outside AOC' : 'not logged outside AOC'}
                </span>
              </p>
            </li>
          ))}
        </ol>
      )}
      {events.length > 12 && (
        <p className="audit-muted">
          Showing the newest 12 of {formatInteger(events.length)}; filter the explorer by selfmod.blocked for
          the rest.
        </p>
      )}
    </div>
  );
}
