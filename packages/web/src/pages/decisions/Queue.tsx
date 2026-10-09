import type { MouseEvent } from 'react';
import type { DecisionCardView } from '@aoc/contracts';
import { useAuth } from '../../api/auth';
import { Button } from '../../components/Button';
import { Icon } from '../../components/Icon';
import { RelativeTime } from '../../components/RelativeTime';
import { cx } from '../../lib/dom';
import { formatAge } from '../../lib/format';
import type { DecisionActions, PasskeyState } from './actions';
import { RecommendationBox } from './DecisionDetail';
import type { Directory } from './directory';
import { ROLE_WORD, agingOf, explainBlock, recommendedOption, requesterOf, type Aging } from './model';
import { AgingBadge, KindLine, SlaBar } from './parts';

const INTERACTIVE = 'a,button,input,select,textarea,summary,label';

function slaLabel(card: DecisionCardView, aging: Aging): string {
  if (aging.allowedMs === null) return `Waiting ${formatAge(aging.ageMs)}; no SLA agreed for this kind`;
  return `Waited ${formatAge(aging.ageMs)} of ${formatAge(aging.allowedMs)} allowed${
    aging.state === 'over' ? `, over SLA by ${formatAge(-(aging.remainingMs ?? 0))}` : ''
  }`;
}

export interface QueueCardProps {
  card: DecisionCardView;
  now: number;
  selected: boolean;
  onSelect: (id: string) => void;
  directory: Directory;
  actions: DecisionActions;
  passkeys: PasskeyState;
}

/**
 * One open decision in the queue: age, kind, test/policy chip, passkey marker and aging state; the question;
 * where it came from; time waited against its SLA; the recommendation; and the inline action. "Approve"
 * applies the recommended option. Read-only cards say why instead of offering buttons.
 */
export function QueueCard({ card, now, selected, onSelect, directory, actions, passkeys }: QueueCardProps) {
  const { user } = useAuth();
  const aging = agingOf(card, now);
  const requester = requesterOf(card.requesterId, directory);
  const session = directory.session(card.sessionId ?? requester.sessionId);
  const project = directory.projectName(card.projectId);
  const rec = recommendedOption(card);
  const busyHere = actions.busy?.kind === 'resolve' && rec && actions.busy.optionId === rec.id;
  const blocked =
    !card.viewer.canResolve && user ? explainBlock(card, card.viewer.reason, user, directory) : null;
  const titleId = `dec-q-${card.id}`;

  const select = () => onSelect(card.id);
  const onCardClick = (e: MouseEvent<HTMLLIElement>) => {
    if ((e.target as HTMLElement).closest(INTERACTIVE)) return;
    if (window.getSelection?.()?.toString()) return;
    select();
  };

  const source = [
    project,
    session ? `“${session.title}”` : null,
    requester.kind === 'agent' ? (session?.ownerName ?? null) : requester.name,
  ].filter(Boolean);

  return (
    <li
      className={cx(
        'dec-card',
        `dec-card--${aging.state}`,
        selected && 'is-selected',
        !card.viewer.canResolve && 'is-readonly',
      )}
      aria-labelledby={titleId}
      aria-current={selected ? 'true' : undefined}
      onClick={onCardClick}
    >
      <div className="dec-card__top">
        <span className="dec-card__age" title="Time waiting">
          <Icon name="clock" size={12} />
          <RelativeTime value={card.createdAt} now={now} />
        </span>
        <KindLine card={card} />
        <AgingBadge aging={aging} className="dec-card__aging" />
      </div>
      <h3 className="dec-card__title" id={titleId}>
        <button type="button" className="dec-card__open" onClick={select} aria-expanded={selected}>
          {card.title}
        </button>
      </h3>
      <p className="dec-card__src">
        {source.join(' · ')}
        {source.length ? ' · ' : ''}needs {ROLE_WORD[card.requiredRole]}
      </p>
      <SlaBar aging={aging} snapshotAgeMs={card.ageMs} label={slaLabel(card, aging)} />
      {card.viewer.canResolve && <RecommendationBox card={card} directory={directory} />}
      <div className="dec-card__actions">
        {card.viewer.canResolve ? (
          <>
            {rec && !card.requiresPasskey && (
              <Button
                size="sm"
                variant="primary"
                icon="check"
                loading={Boolean(busyHere)}
                loadingText="Recording…"
                disabled={actions.busy !== null && !busyHere}
                onClick={() => void actions.resolve(card, rec.id, null)}
                aria-label={`Approve: ${rec.label}`}
              >
                Approve
              </Button>
            )}
            {rec && card.requiresPasskey && (
              <Button
                size="sm"
                variant="primary"
                icon="key"
                loading={Boolean(busyHere)}
                loadingText="Waiting for passkey…"
                disabled={(actions.busy !== null && !busyHere) || passkeys.hasPasskey === false}
                onClick={() => void actions.resolve(card, rec.id, null)}
                aria-label={`Approve with passkey: ${rec.label}`}
              >
                Approve with passkey
              </Button>
            )}
            <Button size="sm" variant={rec ? 'secondary' : 'primary'} onClick={select}>
              {rec ? 'Other options' : 'Review and decide'}
            </Button>
          </>
        ) : (
          <p className="dec-card__readonly">
            <Icon name="eye" size={12} />
            <span>
              <strong>Read-only:</strong> {blocked?.title ?? 'you cannot resolve this'}
            </span>
          </p>
        )}
      </div>
    </li>
  );
}

export interface QueueSectionProps extends Omit<QueueCardProps, 'card' | 'selected'> {
  id: string;
  title: string;
  hint: string;
  cards: readonly DecisionCardView[];
  selectedId: string | null;
  empty: string;
}

/** A titled list of queue cards ("Waiting on you", "Waiting on others"). */
export function QueueSection({ id, title, hint, cards, selectedId, empty, ...rest }: QueueSectionProps) {
  return (
    <section className="dec-queue" aria-labelledby={`${id}-h`}>
      <header className="dec-queue__head">
        <h2 id={`${id}-h`} className="dec-queue__title">
          {title} <span className="dec-queue__count aoc-num">{cards.length}</span>
        </h2>
        <p className="dec-queue__hint">{hint}</p>
      </header>
      {cards.length ? (
        <ol className="dec-queue__list">
          {cards.map((c) => (
            <QueueCard key={c.id} card={c} selected={c.id === selectedId} {...rest} />
          ))}
        </ol>
      ) : (
        <p className="dec-queue__empty">{empty}</p>
      )}
    </section>
  );
}
