import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { AttentionKind, AttentionSeverity, DecisionCardView, TowerAttentionItem } from '@aoc/contracts';
import {
  Button,
  ButtonLink,
  Chip,
  CountBadge,
  EmptyState,
  Icon,
  InlineAlert,
  LivenessBadge,
  RelativeTime,
  TextArea,
  Tooltip,
  Widget,
  describeError,
  formatDateTime,
  type LivenessState,
} from '../../components';
import { cx } from '../../lib/dom';
import { TowerIcon, type TowerIconName } from './towerIcons';
import {
  SEVERITY_WORD,
  approveTarget,
  attentionKindLabel,
  decisionBlockText,
  decisionHref,
  denyOption,
  foldAttention,
  subjectHref,
} from './towerModel';
import type { ActionVerb, AttentionActions, OptionRef, PendingAction } from './useAttentionActions';

const SEV_ICON: Record<AttentionSeverity, TowerIconName> = {
  critical: 'sev-critical',
  high: 'sev-high',
  medium: 'sev-medium',
  low: 'sev-low',
};

/** Session rows carry the session's liveness as a badge (never a chart). */
const SESSION_STATE: Partial<Record<AttentionKind, LivenessState>> = {
  session_dead: 'dead',
  session_stalled: 'stalled',
  session_throttled: 'throttled',
};

const DONE_WORD: Record<ActionVerb, string> = {
  approve: 'Approved',
  deny: 'Denied',
  nudge: 'Nudge sent',
  restart: 'Restart requested',
};

const FAIL_WORD: Record<ActionVerb, string> = {
  approve: "Couldn't approve",
  deny: "Couldn't deny",
  nudge: "Couldn't nudge the session",
  restart: "Couldn't restart the session",
};

const isHandled = (p: PendingAction | undefined) => p?.phase === 'sent' || p?.phase === 'confirmed';

export interface AttentionQueueProps {
  /** Ranked items (highest cost of delay first). */
  items: readonly TowerAttentionItem[];
  /** Open decision cards by id; `null` while they load (or if they failed to load). */
  cards: ReadonlyMap<string, DecisionCardView> | null;
  /** The decision cards could not be loaded: inline approve/deny sends people to the Decisions page instead. */
  cardsFailed?: boolean;
  actions: AttentionActions;
  /** Why the viewer may not drive a session (null = allowed). */
  driveBlock: (sessionId: string) => string | null;
}

function SeverityMark({ severity }: { severity: AttentionSeverity }) {
  return (
    <span className={cx('tower-sev', `tower-sev--${severity}`)}>
      <TowerIcon name={SEV_ICON[severity]} size={13} />
      {SEVERITY_WORD[severity]}
    </span>
  );
}

/**
 * The hero: everything that needs a human, ranked by cost of delay (not age), each row with its score basis
 * and an inline action wired to the real API. Lower-cost items fold behind a disclosure.
 */
export function AttentionQueue({ items, cards, cardsFailed = false, actions, driveBlock }: AttentionQueueProps) {
  const { visible, folded } = foldAttention(items);
  const open = items.filter((it) => !isHandled(actions.pending[it.id])).length;
  // Scores are 0–100 today; if the backend's scale grows, bars stay comparable instead of clipping.
  const scoreMax = Math.max(100, ...items.map((it) => it.costOfDelay.score));
  const row = (it: TowerAttentionItem, rank: number) => (
    <QueueRow
      key={it.id}
      item={it}
      rank={rank}
      scoreMax={scoreMax}
      card={it.action.decisionId ? (cards?.get(it.action.decisionId) ?? null) : null}
      cardsLoaded={cards !== null}
      cardsFailed={cards === null && cardsFailed}
      pending={actions.pending[it.id]}
      actions={actions}
      driveBlock={driveBlock}
    />
  );
  return (
    <Widget
      id="tower-queue"
      className="tower-queue"
      title={
        <>
          Attention queue{' '}
          <CountBadge count={open} showZero label={open === 1 ? 'item needs you' : 'items need you'} />
        </>
      }
      subtitle="Ranked by cost of delay, not age"
      actions={
        <ButtonLink variant="ghost" size="sm" to="/decisions" iconAfter="chevron-right">
          Decisions
        </ButtonLink>
      }
      flush
    >
      <p className="tower-queue__key">
        <span>
          Score {scoreMax === 100 ? '0–100 ' : ''}weighs customer impact, blocked work, idle spend and audit exposure,
          and rises with age.
        </span>
        <span className="tower-queue__legend" aria-hidden="true">
          {(['critical', 'high', 'medium', 'low'] as const).map((s) => (
            <SeverityMark key={s} severity={s} />
          ))}
        </span>
      </p>
      {items.length === 0 ? (
        <EmptyState
          size="sm"
          icon="ok"
          title="Nothing needs you right now"
          body="Items land here when a decision waits on a human, a session dies, stalls or hits its plan limit, a customer waits past the SLA, or the audit chain or its anchor needs attention."
        />
      ) : (
        <>
          <ol className="tower-qlist" aria-label="Attention queue, highest cost of delay first">
            {visible.map((it, i) => row(it, i + 1))}
          </ol>
          {folded.length > 0 && (
            <details className="tower-qmore">
              <summary>
                <Icon name="chevron-right" size={14} className="tower-qmore__chev" />
                Show {folded.length} lower-cost {folded.length === 1 ? 'item' : 'items'}
              </summary>
              <ol className="tower-qlist" start={visible.length + 1} aria-label="Lower-cost items">
                {folded.map((it, i) => row(it, visible.length + i + 1))}
              </ol>
            </details>
          )}
        </>
      )}
    </Widget>
  );
}

type Panel = 'approve' | 'deny' | 'nudge';

interface QueueRowProps {
  item: TowerAttentionItem;
  rank: number;
  scoreMax: number;
  card: DecisionCardView | null;
  cardsLoaded: boolean;
  cardsFailed: boolean;
  pending: PendingAction | undefined;
  actions: AttentionActions;
  driveBlock: (sessionId: string) => string | null;
}

function QueueRow({ item, rank, scoreMax, card, cardsLoaded, cardsFailed, pending, actions, driveBlock }: QueueRowProps) {
  const titleId = useId();
  const whyId = useId();
  const panelId = useId();
  const [panel, setPanel] = useState<Panel | null>(null);
  const [whyOpen, setWhyOpen] = useState(false);
  const triggers = useRef<Partial<Record<Panel, HTMLButtonElement | null>>>({});
  const handled = isHandled(pending);
  const sending = pending?.phase === 'sending';
  const sessionState = SESSION_STATE[item.kind];
  const passkey = Boolean(item.action.requiresPasskey || card?.requiresPasskey);
  const chips = item.chips.filter((c) => c.trim().toLowerCase() !== 'passkey');

  useEffect(() => {
    if (handled) setPanel(null);
  }, [handled]);

  const closePanel = () => {
    const opener = panel ? triggers.current[panel] : null;
    setPanel(null);
    opener?.focus();
  };

  return (
    <li
      className={cx('tower-q', `tower-q--${item.severity}`, handled && 'is-handled')}
      aria-labelledby={titleId}
      data-item={item.id}
    >
      <span className="tower-q__rank aoc-num">
        <span className="aoc-sr-only">Rank </span>
        {rank}
      </span>
      <div className="tower-q__main">
        <p className="tower-q__meta">
          <SeverityMark severity={item.severity} />
          <span className="tower-q__kind">{attentionKindLabel(item, card)}</span>
          {item.projectName && <span className="tower-q__project">{item.projectName}</span>}
          {sessionState && <LivenessBadge state={sessionState} size="sm" />}
          {passkey && <Chip icon="key">passkey</Chip>}
          {chips.map((c, i) => (
            <Chip key={`${i}:${c}`}>{c}</Chip>
          ))}
        </p>
        <h3 className="tower-q__title" id={titleId}>
          <Link to={subjectHref(item)}>{item.title}</Link>
        </h3>
        <p className="tower-q__basis">
          {item.costOfDelay.basis}
          {item.detail && <span className="tower-q__detail"> · {item.detail}</span>}
        </p>
      </div>
      <div className="tower-q__right">
        <div className="tower-q__side">
          <span className="tower-q__age">
            <Icon name="clock" size={13} />
            <span className="aoc-sr-only">Waiting </span>
            <RelativeTime value={item.since} />
          </span>
          <CostOfDelay
            score={item.costOfDelay.score}
            max={scoreMax}
            basis={item.costOfDelay.basis}
            expanded={whyOpen}
            controls={whyId}
            onToggle={() => setWhyOpen((o) => !o)}
          />
        </div>
        <div className="tower-q__act">
          {handled && pending ? (
            <HandledStatus pending={pending} />
          ) : (
            <RowActions
              item={item}
              card={card}
              passkey={passkey}
              panel={panel}
              panelId={panelId}
              titleId={titleId}
              sending={sending}
              pendingVerb={pending?.verb}
              driveBlock={driveBlock}
              onToggle={(p) => setPanel((cur) => (cur === p ? null : p))}
              onRestart={(sessionId) => actions.restart(item.id, sessionId)}
              registerTrigger={(p, el) => {
                triggers.current[p] = el;
              }}
            />
          )}
        </div>
      </div>
      {whyOpen && <WhyPanel id={whyId} item={item} card={card} />}
      {panel && !handled && (
        <div className="tower-q__panel" id={panelId}>
          {panel === 'nudge' ? (
            <NudgePanel
              sending={sending}
              onCancel={closePanel}
              onSend={(text) => item.action.sessionId && actions.nudge(item.id, item.action.sessionId, text)}
            />
          ) : (
            <DecisionPanel
              mode={panel}
              item={item}
              card={card}
              cardsLoaded={cardsLoaded}
              cardsFailed={cardsFailed}
              sending={sending}
              onCancel={closePanel}
              onConfirm={(option, comment) => {
                const id = item.action.decisionId;
                if (!id) return;
                (panel === 'approve' ? actions.approve : actions.deny)(item.id, id, option, comment);
              }}
            />
          )}
        </div>
      )}
      {pending?.phase === 'failed' && (
        <div className="tower-q__error">
          <InlineAlert tone="danger" live title={FAIL_WORD[pending.verb]} onDismiss={() => actions.dismiss(item.id)}>
            {describeError(pending.error) ?? 'The request failed.'}
          </InlineAlert>
        </div>
      )}
    </li>
  );
}

function CostOfDelay({
  score,
  max,
  basis,
  expanded,
  controls,
  onToggle,
}: {
  score: number;
  max: number;
  basis: string;
  expanded: boolean;
  controls: string;
  onToggle: () => void;
}) {
  const shown = Math.round(score);
  const outOf = max === 100 ? ' of 100' : '';
  return (
    <Tooltip
      content={
        <>
          <strong>
            Cost of delay {shown}
            {outOf}
          </strong>
          <br />
          {basis}
        </>
      }
    >
      <button
        type="button"
        className="tower-cod"
        aria-expanded={expanded}
        aria-controls={expanded ? controls : undefined}
        onClick={onToggle}
      >
        <span className="tower-cod__bar" aria-hidden="true">
          <span style={{ width: `${Math.max(0, Math.min(100, (score / max) * 100))}%` }} />
        </span>
        <span className="tower-cod__num aoc-num">
          <span className="aoc-sr-only">Cost of delay </span>
          {shown}
          {outOf && <span className="aoc-sr-only">{outOf}</span>}
        </span>
      </button>
    </Tooltip>
  );
}

function WhyPanel({ id, item, card }: { id: string; item: TowerAttentionItem; card: DecisionCardView | null }) {
  const rec = card?.recommendation ? card.options.find((o) => o.id === card.recommendation!.optionId) : undefined;
  return (
    <div id={id} className="tower-q__why">
      <dl>
        <div>
          <dt>Why it ranks here</dt>
          <dd>
            Cost of delay <b className="aoc-num">{Math.round(item.costOfDelay.score)}</b> · {item.costOfDelay.basis}
          </dd>
        </div>
        <div>
          <dt>Needs attention since</dt>
          <dd>
            <time dateTime={item.since} className="aoc-num">
              {formatDateTime(item.since)}
            </time>
          </dd>
        </div>
        {card && (
          <div>
            <dt>Question</dt>
            <dd>{card.question}</dd>
          </div>
        )}
        {card?.recommendation && (
          <div>
            <dt>Recommended</dt>
            <dd>
              {rec ? <b>{rec.label}</b> : null}
              {card.recommendation.rationale ? ` — ${card.recommendation.rationale}` : null}
            </dd>
          </div>
        )}
      </dl>
    </div>
  );
}

interface RowActionsProps {
  item: TowerAttentionItem;
  card: DecisionCardView | null;
  passkey: boolean;
  panel: Panel | null;
  panelId: string;
  titleId: string;
  sending: boolean;
  pendingVerb: ActionVerb | undefined;
  driveBlock: (sessionId: string) => string | null;
  onToggle: (p: Panel) => void;
  onRestart: (sessionId: string) => void;
  registerTrigger: (p: Panel, el: HTMLButtonElement | null) => void;
}

/** The row's inline action, chosen by the server (`action.kind`) and gated by what this viewer may do. */
function RowActions({
  item,
  card,
  passkey,
  panel,
  panelId,
  titleId,
  sending,
  pendingVerb,
  driveBlock,
  onToggle,
  onRestart,
  registerTrigger,
}: RowActionsProps) {
  const { action } = item;
  const label = action.label || 'Open';
  const withReason = (reason: string | null, control: ReactNode) => (
    <>
      {control}
      {reason && <span className="tower-q__why-not">{reason}</span>}
    </>
  );

  if (action.kind === 'resolve_decision' && action.decisionId) {
    const href = decisionHref(action.decisionId);
    const cannot = card && !card.viewer.canResolve ? decisionBlockText(card.viewer.reason) : null;
    if (passkey) {
      // The WebAuthn ceremony lives on the Decisions page, bound to this decision and option.
      return cannot ? (
        withReason(
          cannot,
          <ButtonLink size="sm" to={href} aria-describedby={titleId}>
            Open
          </ButtonLink>,
        )
      ) : (
        <ButtonLink size="sm" variant="primary" icon="key" to={href} aria-describedby={titleId}>
          {label}
        </ButtonLink>
      );
    }
    if (card && approveTarget(item, card) === null) {
      return (
        <ButtonLink size="sm" to={href} aria-describedby={titleId}>
          Choose an option
        </ButtonLink>
      );
    }
    const deny = card && card.viewer.canResolve ? denyOption(card) : null;
    return withReason(
      cannot,
      <span className="tower-q__btns">
        <Button
          ref={(el) => registerTrigger('approve', el)}
          size="sm"
          variant="primary"
          disabled={Boolean(cannot)}
          loading={sending && pendingVerb === 'approve'}
          loadingText="Approving…"
          aria-expanded={panel === 'approve'}
          aria-controls={panel === 'approve' ? panelId : undefined}
          aria-describedby={titleId}
          onClick={() => onToggle('approve')}
        >
          {label}
        </Button>
        {deny && (
          <Button
            ref={(el) => registerTrigger('deny', el)}
            size="sm"
            loading={sending && pendingVerb === 'deny'}
            loadingText="Denying…"
            aria-expanded={panel === 'deny'}
            aria-controls={panel === 'deny' ? panelId : undefined}
            aria-describedby={titleId}
            onClick={() => onToggle('deny')}
          >
            Deny
          </Button>
        )}
      </span>,
    );
  }

  if ((action.kind === 'nudge' || action.kind === 'restart') && action.sessionId) {
    const sessionId = action.sessionId;
    const reason = driveBlock(sessionId);
    if (action.kind === 'nudge') {
      return withReason(
        reason,
        <Button
          ref={(el) => registerTrigger('nudge', el)}
          size="sm"
          disabled={Boolean(reason)}
          loading={sending}
          loadingText="Sending…"
          aria-expanded={panel === 'nudge'}
          aria-controls={panel === 'nudge' ? panelId : undefined}
          aria-describedby={titleId}
          onClick={() => onToggle('nudge')}
        >
          <TowerIcon name="nudge" size={14} className="tower-btn-ic" />
          {label}
        </Button>,
      );
    }
    return withReason(
      reason,
      <Button
        size="sm"
        icon="retry"
        disabled={Boolean(reason)}
        loading={sending}
        loadingText="Restarting…"
        aria-describedby={titleId}
        onClick={() => onRestart(sessionId)}
      >
        {label}
      </Button>,
    );
  }

  return (
    <ButtonLink size="sm" to={subjectHref(item)} aria-describedby={titleId}>
      {label}
    </ButtonLink>
  );
}

function HandledStatus({ pending }: { pending: PendingAction }) {
  const confirmed = pending.phase === 'confirmed';
  let sub: string;
  if (!confirmed) sub = 'waiting for the audit log';
  else if (pending.verb === 'restart') sub = 'waiting for the session to report back';
  else if (pending.verb === 'nudge') sub = 'the session resumes with your note';
  else sub = 'recorded in the audit log';
  return (
    <p className={cx('tower-q__done', confirmed && 'is-confirmed')} role="status">
      <Icon name={confirmed ? 'ok' : 'clock'} size={14} />
      <span>
        <b>{DONE_WORD[pending.verb]}</b>
        {pending.optionLabel ? <> · {pending.optionLabel}</> : null}
        <span className="tower-q__done-sub">
          {sub}
          {confirmed && pending.seq !== undefined ? <span className="aoc-num"> · event #{pending.seq}</span> : null}
        </span>
      </span>
    </p>
  );
}

function onEscape(cancel: () => void) {
  return (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      cancel();
    }
  };
}

function DecisionPanel({
  mode,
  item,
  card,
  cardsLoaded,
  cardsFailed,
  sending,
  onConfirm,
  onCancel,
}: {
  mode: 'approve' | 'deny';
  item: TowerAttentionItem;
  card: DecisionCardView | null;
  cardsLoaded: boolean;
  cardsFailed: boolean;
  sending: boolean;
  onConfirm: (option: OptionRef, comment: string) => void;
  onCancel: () => void;
}) {
  const leadId = useId();
  const [comment, setComment] = useState('');
  const confirmRef = useRef<HTMLButtonElement>(null);
  const commentRef = useRef<HTMLTextAreaElement>(null);
  const deny = card ? denyOption(card) : null;
  const option: OptionRef | null =
    mode === 'approve' ? approveTarget(item, card) : deny ? { id: deny.id, label: deny.label } : null;

  useEffect(() => {
    (mode === 'approve' ? confirmRef.current : commentRef.current)?.focus();
  }, [mode, option?.id]);

  const href = subjectHref(item);
  if (!option) {
    if (cardsFailed) {
      return (
        <p className="tower-q__panel-note" onKeyDown={onEscape(onCancel)}>
          The decision could not be loaded here. <Link to={href}>Open it on the Decisions page</Link>
        </p>
      );
    }
    if (!cardsLoaded) {
      return (
        <p className="tower-q__panel-note" role="status">
          Loading the decision…
        </p>
      );
    }
    return (
      <p className="tower-q__panel-note" onKeyDown={onEscape(onCancel)}>
        {card ? 'This decision has no single option to apply here.' : 'This decision is no longer open.'}{' '}
        <Link to={href}>Open it on the Decisions page</Link>
      </p>
    );
  }
  const recommended = mode === 'approve' && (!card || card.recommendation?.optionId === option.id);
  const isServerPick = mode === 'approve' && !card;
  return (
    <div role="group" aria-labelledby={leadId} onKeyDown={onEscape(onCancel)}>
      <p className="tower-q__lead" id={leadId}>
        {mode === 'approve' ? 'Approve' : 'Deny'} “{item.title}”:{' '}
        {option.label ? (
          <>
            applies <b>{option.label}</b>
            {recommended && !isServerPick ? ' — the recommended option' : ''}.
          </>
        ) : (
          <>applies the recommended option.</>
        )}
      </p>
      {card?.question && <p className="tower-q__question">{card.question}</p>}
      {mode === 'approve' && recommended && card?.recommendation?.rationale && (
        <p className="tower-q__rec">
          <span className="tower-q__rec-k">Recommendation</span> {card.recommendation.rationale}
        </p>
      )}
      <TextArea
        ref={commentRef}
        label={mode === 'approve' ? 'Comment (optional)' : 'Reason (optional)'}
        rows={2}
        maxLength={4000}
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        fieldClassName="tower-q__comment"
      />
      <div className="tower-q__panel-actions">
        <Button
          ref={confirmRef}
          size="sm"
          variant={mode === 'approve' ? 'primary' : 'secondary'}
          loading={sending}
          loadingText={mode === 'approve' ? 'Approving…' : 'Denying…'}
          onClick={() => onConfirm(option, comment)}
        >
          {mode === 'approve' ? 'Confirm approval' : 'Confirm denial'}
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Link to={href} className="tower-q__other">
          All options
        </Link>
      </div>
    </div>
  );
}

const NUDGE_MAX = 2000;

function NudgePanel({
  sending,
  onSend,
  onCancel,
}: {
  sending: boolean;
  onSend: (text: string) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState('');
  const [error, setError] = useState<string | undefined>();
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => ref.current?.focus(), []);
  const send = () => {
    if (!text.trim()) {
      setError('Write a short note for the session.');
      ref.current?.focus();
      return;
    }
    onSend(text);
  };
  return (
    <div role="group" aria-label="Nudge the session" onKeyDown={onEscape(onCancel)}>
      <TextArea
        ref={ref}
        label="Note for the session"
        hint="The session ends its turn and resumes with this note. The nudge is recorded in the audit log under your name."
        required
        rows={3}
        maxLength={NUDGE_MAX}
        value={text}
        error={error}
        onChange={(e) => {
          setText(e.target.value);
          if (error) setError(undefined);
        }}
        fieldClassName="tower-q__comment"
      />
      <div className="tower-q__panel-actions">
        <Button size="sm" variant="primary" loading={sending} loadingText="Sending…" onClick={send}>
          Send nudge
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
