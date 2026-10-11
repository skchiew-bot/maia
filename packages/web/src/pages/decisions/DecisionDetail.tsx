import { useId } from 'react';
import { Link } from 'react-router-dom';
import type { DecisionCardView } from '@aoc/contracts';
import { Badge } from '../../components/Badge';
import { DescriptionList } from '../../components/Layout';
import { Icon } from '../../components/Icon';
import { RelativeTime } from '../../components/RelativeTime';
import { HiddenTextWarning, RevealedText } from '../../components/RevealedText';
import { useNow } from '../../lib/clock';
import { cx } from '../../lib/dom';
import { formatAge, formatClock, formatDateTime } from '../../lib/format';
import { inspectAll } from '../../lib/hiddenText';
import type { DecisionActions, PasskeyState } from './actions';
import type { Directory } from './directory';
import {
  ASSURANCE_MEANING,
  ROLE_WORD,
  TEST_LABEL,
  agingOf,
  assuranceLabel,
  assuranceOf,
  closedWithinSla,
  outcomeLabel,
  recommendedOption,
  requesterOf,
  shortId,
  slaText,
  subjectLinkOf,
} from './model';
import { AgingBadge, KindLine } from './parts';
import { ResolvePanel } from './ResolvePanel';

/** Who recommends: the agent that raised it, the platform, or the person who raised it. */
function recommender(card: DecisionCardView, directory: Directory): string {
  const r = requesterOf(card.requesterId, directory);
  if (r.kind === 'agent') return 'Agent recommends';
  if (r.kind === 'system') return 'AOC recommends';
  return `${r.name} recommends`;
}

export function RecommendationBox({ card, directory }: { card: DecisionCardView; directory: Directory }) {
  const rec = recommendedOption(card);
  if (!rec || !card.recommendation) return null;
  return (
    <div className="dec-rec">
      <p className="dec-rec__by">
        <Icon name="check" size={12} />
        {recommender(card, directory)}
      </p>
      <p className="dec-rec__what">{rec.label}</p>
      {card.recommendation.rationale && <p className="dec-rec__why">{card.recommendation.rationale}</p>}
    </div>
  );
}

function namesOf(ids: readonly string[], directory: Directory): string {
  return ids.map((id) => requesterOf(id, directory).name).join(', ');
}

/** The card's lifecycle as recorded on it: requested, escalated, then resolved or withdrawn. */
export function DecisionHistory({ card, directory }: { card: DecisionCardView; directory: Directory }) {
  const requester = requesterOf(card.requesterId, directory);
  const items: {
    key: string;
    icon: 'decisions' | 'arrow-up' | 'ok' | 'close' | 'clock';
    at: string;
    text: string;
    detail?: string | null;
  }[] = [{ key: 'requested', icon: 'decisions', at: card.createdAt, text: `Requested by ${requester.name}` }];
  if (card.escalation)
    items.push({
      key: 'escalated',
      icon: 'arrow-up',
      at: card.escalation.at,
      text: `Escalated to the ${ROLE_WORD[card.escalation.toRole]} (${card.escalation.reason.replace(/_/g, ' ')})`,
    });
  if (card.resolution) {
    const r = card.resolution;
    const within = closedWithinSla(card);
    items.push({
      key: 'resolved',
      icon: 'ok',
      at: r.resolvedAt,
      text: `Resolved: ${outcomeLabel(card)} — by ${requesterOf(r.resolvedBy, directory).name} · ${assuranceLabel(r)}${
        r.selfApproved ? ' · self-approved' : ''
      }`,
      detail: `Waited ${formatAge(card.ageMs)}${within === null ? '' : within ? ' (within SLA)' : ' (over SLA)'}${
        r.comment ? ` · “${r.comment}”` : ''
      }`,
    });
  }
  // A card that ran out of time (`decision.expired`) has no withdrawal record: its status and close time say so.
  if (card.withdrawal)
    items.push({
      key: 'withdrawn',
      icon: 'close',
      at: card.withdrawal.at,
      text: `${card.status === 'expired' ? 'Expired' : 'Withdrawn'} (${card.withdrawal.reason.replace(/_/g, ' ')}) by ${
        requesterOf(card.withdrawal.by, directory).name
      }`,
      detail: card.withdrawal.note,
    });
  else if (card.status === 'expired')
    items.push({
      key: 'expired',
      icon: 'clock',
      at: card.closedAt ?? new Date(Date.parse(card.createdAt) + card.ageMs).toISOString(),
      text: 'Expired unanswered',
      detail: `Nobody decided in ${formatAge(card.ageMs)}`,
    });
  return (
    <ol className="dec-history" aria-label="Decision history">
      {items.map((it) => (
        <li key={it.key} className={cx('dec-history__item', `dec-history__item--${it.key}`)}>
          <Icon name={it.icon} size={14} className="dec-history__icon" />
          <div className="dec-history__body">
            <p className="dec-history__text">{it.text}</p>
            {it.detail && <p className="dec-history__detail">{it.detail}</p>}
          </div>
          <time className="dec-history__at aoc-num" dateTime={it.at} title={formatDateTime(it.at)}>
            {formatDateTime(it.at).slice(5, 16)}
          </time>
        </li>
      ))}
    </ol>
  );
}

export interface DecisionDetailProps {
  card: DecisionCardView;
  directory: Directory;
  actions: DecisionActions;
  passkeys: PasskeyState;
  /** Heading level for the title (2 in the inbox panel). */
  headingLevel?: 2 | 3;
  /** Hide the title when a surrounding dialog already shows it. */
  hideTitle?: boolean;
}

/**
 * Everything needed to decide: question, context, options with the recommendation and its rationale, the
 * linked subject, who raised it, who may resolve it, the passkey requirement, the controls and the history.
 * All text on a card is untrusted (agents, requesters): it renders as text, never markup.
 */
export function DecisionDetail({
  card,
  directory,
  actions,
  passkeys,
  headingLevel = 2,
  hideTitle,
}: DecisionDetailProps) {
  const now = useNow();
  const titleId = useId();
  const Heading = headingLevel === 2 ? 'h2' : 'h3';
  const open = card.status === 'open';
  const aging = agingOf(card, now);
  const subject = subjectLinkOf(card);
  const session = directory.session(card.sessionId);
  const project = directory.projectName(card.projectId);
  const requester = requesterOf(card.requesterId, directory);
  const excluded = card.excludedApproverIds.filter((id) => id !== card.requesterId);
  // The option buttons already name every choice; list them separately only when they carry more than a label.
  const showOptions = !open || !card.viewer.canResolve || card.options.some((o) => o.description);

  const facts = [
    {
      term: 'Subject',
      value: subject.to ? (
        <Link to={subject.to}>
          {subject.label} <code>{shortId(card.subjectId)}</code>
        </Link>
      ) : (
        <span>
          {subject.label} <code>{shortId(card.subjectId)}</code>
        </span>
      ),
    },
    ...(card.sessionId && card.subjectType !== 'session'
      ? [
          {
            term: 'Session',
            value: (
              <Link to={`/sessions/${encodeURIComponent(card.sessionId)}`}>
                {session?.title ?? shortId(card.sessionId)}
              </Link>
            ),
          },
        ]
      : []),
    ...(card.subjectType === 'session' && session
      ? [
          {
            term: 'Session',
            value: <Link to={`/sessions/${encodeURIComponent(session.sessionId)}`}>{session.title}</Link>,
          },
        ]
      : []),
    ...(card.projectId
      ? [
          {
            term: 'Project',
            value: (
              <Link to={`/projects/${encodeURIComponent(card.projectId)}`}>{project ?? card.projectId}</Link>
            ),
          },
        ]
      : []),
    {
      term: 'Raised by',
      value: (
        <span>
          {requester.name}
          {requester.kind === 'agent' && session?.ownerName ? ` · owner ${session.ownerName}` : ''}
        </span>
      ),
    },
    {
      term: 'Who can resolve',
      value: (
        <span>
          {card.eligibleUserIds
            ? namesOf(card.eligibleUserIds, directory)
            : `${ROLE_WORD[card.requiredRole]} role`}
          {card.requiredRole === 'approver' && !card.eligibleUserIds ? ' (bounces to the CEO)' : ''}
        </span>
      ),
    },
    ...(excluded.length ? [{ term: 'Excluded', value: namesOf(excluded, directory) }] : []),
    {
      term: 'Passkey',
      value: card.requiresPasskey ? (
        <span className="dec-fact-pk">
          <Icon name="key" size={12} /> Required: signed approval (WebAuthn)
        </span>
      ) : (
        'Not required: button resolution is attribution only'
      ),
    },
    {
      term: 'Raised',
      value: (
        <span>
          {formatDateTime(card.createdAt).slice(0, 16)} ·{' '}
          <RelativeTime value={card.createdAt} suffix=" ago" />
        </span>
      ),
    },
    {
      term: 'SLA',
      value: open
        ? aging.dueAt !== null
          ? `${slaText(card.kind)} · due ${formatClock(aging.dueAt)}${card.dueAt ? ' (set on the card)' : ''}`
          : slaText(card.kind)
        : slaText(card.kind),
    },
  ];

  return (
    <article className="dec-detail" aria-labelledby={titleId}>
      <header className="dec-detail__head">
        <KindLine card={card}>
          {open ? (
            <AgingBadge aging={aging} />
          ) : (
            <Badge
              tone={card.status === 'resolved' ? 'ok' : 'neutral'}
              icon={card.status === 'resolved' ? 'ok' : 'close'}
            >
              {card.status === 'resolved' ? 'Resolved' : card.status === 'expired' ? 'Expired' : 'Withdrawn'}
            </Badge>
          )}
        </KindLine>
        <Heading id={titleId} className={cx('dec-detail__title', hideTitle && 'aoc-sr-only')}>
          <RevealedText text={card.title} />
        </Heading>
        {card.test && <p className="dec-detail__test">Decision test: {TEST_LABEL[card.test]}</p>}
        {card.erased && (
          <p className="dec-detail__erased">Free text on this card was erased (crypto-shredded).</p>
        )}
      </header>

      <section className="dec-detail__section" aria-label="Question">
        <HiddenTextWarning
          texts={[card.title, card.question, card.context, ...card.options.flatMap((o) => [o.label, o.description])]}
        />
        <p className="dec-detail__question">
          <RevealedText text={card.question} />
        </p>
        {card.context && (
          <details className="dec-detail__context" open={card.context.length < 600 || inspectAll([card.context]).hidden > 0}>
            <summary>Context</summary>
            <div className="dec-text">
              <RevealedText text={card.context} />
            </div>
          </details>
        )}
      </section>

      {showOptions && (
        <section className="dec-detail__section" aria-label="Options">
          <h3 className="dec-detail__h">Options</h3>
          <ul className="dec-options">
            {card.options.map((o) => {
              const isRec = card.recommendation?.optionId === o.id;
              const chosen = card.resolution?.optionId === o.id;
              return (
                <li key={o.id} className={cx('dec-option', isRec && 'is-recommended', chosen && 'is-chosen')}>
                  <span className="dec-option__label">
                    <RevealedText text={o.label} />
                  </span>
                  {isRec && <Badge tone="accent">Recommended</Badge>}
                  {chosen && (
                    <Badge tone="ok" icon="ok">
                      Chosen
                    </Badge>
                  )}
                  {o.description && (
                    <p className="dec-option__desc">
                      <RevealedText text={o.description} />
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
          <RecommendationBox card={card} directory={directory} />
        </section>
      )}
      {!showOptions && <RecommendationBox card={card} directory={directory} />}

      <section className="dec-detail__section" aria-label="Facts">
        <DescriptionList columns={2} items={facts} className="dec-facts" />
      </section>

      {open && (
        <section className="dec-detail__section" aria-label="Your decision">
          <h3 className="dec-detail__h">Your decision</h3>
          <ResolvePanel card={card} directory={directory} actions={actions} passkeys={passkeys} />
        </section>
      )}

      <section className="dec-detail__section" aria-label="History">
        <h3 className="dec-detail__h">History</h3>
        <DecisionHistory card={card} directory={directory} />
        {!open && card.resolution && (
          <p className="dec-detail__method">
            <Icon name={assuranceOf(card.resolution) === 'signature' ? 'key' : 'user'} size={12} />
            {assuranceLabel(card.resolution)}: {ASSURANCE_MEANING[assuranceOf(card.resolution)]}.
          </p>
        )}
      </section>
    </article>
  );
}
