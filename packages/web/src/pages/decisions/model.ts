/**
 * Pure rules behind the Decisions inbox: SLA aging, queue order, viewer-facing wording and latency statistics.
 * Most labels mirror `@aoc/contracts` (typed against it). The §6 assurance labels are imported from it as values:
 * vite.config.ts keeps the package's zod schemas out of the bundle, so only what is used here ships.
 */
import {
  RESOLUTION_ASSURANCE_LABEL,
  resolutionAssurance,
  type DecisionBlockReason,
  type DecisionCardView,
  type DecisionKind,
  type DecisionTest,
  type ResolutionAssurance,
  type Role,
} from '@aoc/contracts';
import { formatAge } from '../../lib/format';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export const KIND_LABEL: Record<DecisionKind, string> = {
  agent_decision: 'Agent decision',
  protected_operation: 'Protected operation',
  fix_plan: 'Fix-plan sign-off',
  go_live: 'Go-live',
  rollback: 'Rollback',
  change_request: 'Change request',
  break_glass: 'Break-glass promotion',
  playbook_approval: 'Playbook approval',
  lesson_binding: 'Lesson binding',
  credit_topup: 'Credit top-up',
  fx_discrepancy: 'FX discrepancy',
  triage_reconciliation: 'Triage reconciliation',
  low_confidence_diagnosis: 'Low-confidence diagnosis',
  uat_signoff: 'UAT sign-off',
};

export const TEST_LABEL: Record<DecisionTest, string> = {
  main: 'Touches main / protected branch',
  production: 'Touches production / deploy',
  irreversible: 'Irreversible or architectural choice',
  ambiguity: 'Spec ambiguity / low confidence',
  data: 'Touches data (migrations, deletes, PII)',
};

export const ROLE_WORD: Record<Role, string> = {
  approver: 'Approver',
  builder: 'Builder',
  requester: 'Requester',
};

/**
 * Decision SLAs approved by the CEO with the mock (mocks/README.md "Approval", 2026-10-09). Kinds without an
 * agreed SLA age without a due time rather than against an invented one.
 */
export const DECISION_SLA_MS: Partial<Record<DecisionKind, number>> = {
  rollback: 30 * MIN,
  agent_decision: HOUR,
  credit_topup: HOUR,
  go_live: 2 * HOUR,
  fix_plan: 4 * HOUR,
  lesson_binding: 2 * DAY,
};

/** Share of the SLA after which an open card reads "due soon". */
export const DUE_SOON_RATIO = 0.75;

export type AgingState = 'over' | 'due_soon' | 'within' | 'no_sla';

export interface Aging {
  state: AgingState;
  /** Kind SLA, when one is agreed. */
  slaMs: number | null;
  /** When the card is due: its own `dueAt`, else created + SLA. */
  dueAt: number | null;
  /** Time waiting so far (open) or until it closed. */
  ageMs: number;
  /** Time allowed from creation to due. Null without a due time. */
  allowedMs: number | null;
  /** Time left until due; negative once overdue. Null without a due time. */
  remainingMs: number | null;
  /** Share of the allowed time used (1 = due now). Null without a due time. */
  ratio: number | null;
}

type AgingInput = Pick<DecisionCardView, 'kind' | 'createdAt' | 'dueAt'>;

/** Aging of an open card at `now`. */
export function agingOf(card: AgingInput, now: number): Aging {
  const created = Date.parse(card.createdAt);
  const ageMs = Math.max(0, now - created);
  const slaMs = DECISION_SLA_MS[card.kind] ?? null;
  const explicitDue = card.dueAt ? Date.parse(card.dueAt) : NaN;
  const dueAt = Number.isFinite(explicitDue) ? explicitDue : slaMs !== null ? created + slaMs : null;
  if (dueAt === null)
    return { state: 'no_sla', slaMs, dueAt: null, ageMs, allowedMs: null, remainingMs: null, ratio: null };
  const allowedMs = Math.max(1, dueAt - created);
  const remainingMs = dueAt - now;
  const ratio = ageMs / allowedMs;
  const state: AgingState = remainingMs < 0 ? 'over' : ratio >= DUE_SOON_RATIO ? 'due_soon' : 'within';
  return { state, slaMs, dueAt, ageMs, allowedMs, remainingMs, ratio };
}

/** Whether a closed card was decided within its kind's SLA (null when the kind has none). */
export function closedWithinSla(card: Pick<DecisionCardView, 'kind' | 'ageMs'>): boolean | null {
  const sla = DECISION_SLA_MS[card.kind];
  return sla === undefined ? null : card.ageMs <= sla;
}

export const AGING_META: Record<
  AgingState,
  { word: string; tone: 'danger' | 'warn' | 'neutral'; icon: 'danger' | 'warn' | 'clock' }
> = {
  over: { word: 'Over SLA', tone: 'danger', icon: 'danger' },
  due_soon: { word: 'Due soon', tone: 'warn', icon: 'warn' },
  within: { word: 'Within SLA', tone: 'neutral', icon: 'clock' },
  no_sla: { word: 'No SLA set', tone: 'neutral', icon: 'clock' },
};

/** One short phrase for the aging badge: "Over SLA by 1h 14m", "Due in 12m", "No SLA set". */
export function agingPhrase(a: Aging): string {
  if (a.remainingMs === null) return 'No SLA set';
  if (a.state === 'over') return `Over SLA by ${formatAge(-a.remainingMs)}`;
  return `Due in ${formatAge(a.remainingMs)}`;
}

/** SLA in words for facts and summaries: "SLA 1h", "due 14:05" style is left to the caller. */
export function slaText(kind: DecisionKind): string {
  const sla = DECISION_SLA_MS[kind];
  return sla === undefined ? 'No SLA agreed for this kind' : `SLA ${formatAge(sla)}`;
}

/** Queue order: most overdue first, then soonest due; cards without a due time last, oldest first. */
export function compareByUrgency(a: Aging, b: Aging): number {
  if (a.remainingMs !== null && b.remainingMs !== null) return a.remainingMs - b.remainingMs;
  if (a.remainingMs !== null) return -1;
  if (b.remainingMs !== null) return 1;
  return b.ageMs - a.ageMs;
}

export function sortByUrgency<T extends AgingInput>(cards: readonly T[], now: number): T[] {
  return cards
    .map((card) => ({ card, aging: agingOf(card, now) }))
    .sort((x, y) => compareByUrgency(x.aging, y.aging))
    .map((x) => x.card);
}

/** A resolution as the card or the `decision.resolved` event carries it. */
export interface ResolutionFacts {
  method: 'button' | 'passkey' | 'policy';
  passkeyVerified: boolean;
  /** Set by the decisions API; older cards and event metadata leave it to `resolutionAssurance`. */
  assurance?: ResolutionAssurance;
}

/** What a resolution proves about who decided (§6): a bearer token only attributes, a verified passkey signs. */
export function assuranceOf(r: ResolutionFacts): ResolutionAssurance {
  return r.assurance ?? resolutionAssurance(r);
}

/** The contracts' words for an assurance ("Signed (passkey)", "Attribution (bearer token)", "Platform policy"). */
export function assuranceName(a: ResolutionAssurance): string {
  return RESOLUTION_ASSURANCE_LABEL[a];
}

/** The same words for a resolution. */
export function assuranceLabel(r: ResolutionFacts): string {
  return assuranceName(assuranceOf(r));
}

/** What each assurance means, as a fragment to follow its label (no final stop). */
export const ASSURANCE_MEANING: Record<ResolutionAssurance, string> = {
  signature: 'a WebAuthn assertion bound to this decision and option was verified before it was recorded',
  attribution: 'records which token was used, not a signature (§6)',
  policy: 'the once-per-period credit auto-grant; no person signed it',
};

/** How an open card's resolution will be recorded: passkey cards are signed, every other card is attributed to the token. */
export function expectedAssurance(card: Pick<DecisionCardView, 'requiresPasskey'>): ResolutionAssurance {
  return card.requiresPasskey ? 'signature' : 'attribution';
}

export interface PeopleLookup {
  /** Display name for a user id, or null when unknown to this viewer. */
  nameOf(userId: string): string | null;
  /** Number of active Approvers, when the viewer can see it (Approvers list users). */
  activeApprovers: number | null;
}

export interface Viewer {
  id: string;
  role: Role;
}

export interface BlockExplanation {
  title: string;
  body: string;
}

/** Why this viewer sees the card read-only, in plain words (role routing and separation of duties, §6). */
export function explainBlock(
  card: Pick<
    DecisionCardView,
    'requiredRole' | 'requesterId' | 'excludedApproverIds' | 'eligibleUserIds' | 'kind'
  >,
  reason: DecisionBlockReason | null,
  viewer: Viewer,
  people: PeopleLookup,
): BlockExplanation | null {
  switch (reason) {
    case null:
      return null;
    case 'role':
      if (card.requiredRole === 'requester')
        return {
          title: 'Waiting on the requester',
          body: "Only the ticket's requester signs off UAT. Nobody on the operator side can answer it for them.",
        };
      return {
        title: `Needs the ${ROLE_WORD[card.requiredRole]} role`,
        body: `You are signed in as ${ROLE_WORD[viewer.role]}. ${
          card.requiredRole === 'approver'
            ? 'Anything touching main, production or data bounces to the Approver.'
            : 'Only operators can resolve it.'
        }`,
      };
    case 'separation_of_duties': {
      if (card.requesterId === viewer.id) {
        const sole = viewer.role === 'approver' && people.activeApprovers === 1;
        return {
          title: 'You raised this request',
          body: sole
            ? 'Separation of duties (§6): a request never routes back to the person who raised it. You are the only Approver, so a second Approver is needed to resolve it.'
            : `Separation of duties (§6): a request never routes back to the person who raised it. Another ${ROLE_WORD[card.requiredRole]} must resolve it.`,
        };
      }
      return {
        title: 'You are excluded from this decision',
        body: 'Separation of duties (§6): you were named as excluded when it was raised, so someone else must resolve it.',
      };
    }
    case 'not_eligible': {
      const names = (card.eligibleUserIds ?? []).map((id) => people.nameOf(id) ?? 'a named person');
      if (card.kind === 'uat_signoff')
        return {
          title: "Waiting on the requester's UAT",
          body: `Only ${names.join(', ') || 'the ticket requester'} can sign off UAT; nobody on the operator side can answer it for them.`,
        };
      return {
        title: 'Only named people can resolve this',
        body: names.length ? `It is routed to ${names.join(', ')}.` : 'It is routed to specific people.',
      };
    }
    case 'inactive':
      return { title: 'Your account is inactive', body: 'Inactive accounts cannot resolve decisions.' };
    case 'not_open':
      return { title: 'This decision is closed', body: 'It was resolved, withdrawn or expired.' };
    case 'passkey_required':
    case 'passkey_invalid':
      return { title: 'Passkey required', body: 'Sign this decision with a passkey to resolve it.' };
  }
}

export interface SubjectLink {
  /** What the subject is ("Ticket", "Session"). */
  label: string;
  /** In-app route, or null when no page shows it. */
  to: string | null;
}

/** Link to the record the decision is about (§6, §7, §8, §10, §11). */
export function subjectLinkOf(card: Pick<DecisionCardView, 'subjectType' | 'subjectId'>): SubjectLink {
  const id = encodeURIComponent(card.subjectId);
  const prefix = card.subjectId.split('_')[0];
  switch (card.subjectType) {
    case 'session':
      return { label: 'Session', to: `/sessions/${id}` };
    case 'ticket':
      return { label: 'Ticket', to: `/tickets/${id}` };
    case 'change':
    case 'change_request':
      return { label: 'Change record', to: `/changes/${id}` };
    case 'credit_request':
      return { label: 'Credit top-up request', to: '/credits' };
    case 'lesson':
      return { label: 'Lesson', to: '/learning' };
    case 'playbook':
      return { label: 'Playbook', to: '/registry' };
    case 'rollback':
      return { label: 'Rollback', to: '/rollbacks' };
    case 'breakglass':
      return { label: 'Break-glass record', to: '/changes' };
    case 'promotion':
      return { label: 'Promotion', to: '/changes' };
    case 'fx_rate':
    case 'fx':
      return { label: 'FX rate', to: '/metering' };
    default:
      if (prefix === 'chg') return { label: 'Change record', to: `/changes/${id}` };
      if (prefix === 'tkt') return { label: 'Ticket', to: `/tickets/${id}` };
      if (prefix === 'ses') return { label: 'Session', to: `/sessions/${id}` };
      return { label: card.subjectType.replace(/_/g, ' '), to: null };
  }
}

export type RequesterKind = 'person' | 'agent' | 'system';

export interface RequesterInfo {
  kind: RequesterKind;
  /** Display text ("Priya Nair", "Agent session ses_01M4…", "Intake (system)"). */
  name: string;
  /** Session id for agent-raised cards. */
  sessionId: string | null;
}

/** Who raised the card: a person, an agent session (`session:<id>`) or a platform component (`system:<name>`). */
export function requesterOf(requesterId: string, people: Pick<PeopleLookup, 'nameOf'>): RequesterInfo {
  if (requesterId.startsWith('session:')) {
    const sessionId = requesterId.slice('session:'.length);
    return { kind: 'agent', name: `Agent in session ${shortId(sessionId)}`, sessionId };
  }
  if (requesterId.startsWith('system:') || !requesterId.includes('_')) {
    const component = requesterId.replace(/^system:/, '');
    return { kind: 'system', name: `${capitalise(component)} (AOC system)`, sessionId: null };
  }
  return {
    kind: 'person',
    name: people.nameOf(requesterId) ?? `User ${shortId(requesterId)}`,
    sessionId: null,
  };
}

/** `ses_01M4FC3G…` → `ses_…3FJ` style short form that stays recognisable. */
export function shortId(id: string): string {
  const [prefix, rest] = id.includes('_')
    ? [id.slice(0, id.indexOf('_')), id.slice(id.indexOf('_') + 1)]
    : ['', id];
  if (rest.length <= 8) return id;
  return `${prefix ? `${prefix}_` : ''}…${rest.slice(-6)}`;
}

function capitalise(s: string): string {
  return s ? s[0]!.toUpperCase() + s.slice(1) : s;
}

/** Nearest-rank percentile of a non-empty, ascending-sorted list. */
export function percentile(sorted: readonly number[], p: number): number {
  if (!sorted.length) return NaN;
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil(p * sorted.length)));
  return sorted[rank - 1]!;
}

export interface KindLatency {
  kind: DecisionKind;
  label: string;
  total: number;
  p50Ms: number;
  p90Ms: number;
  slaMs: number | null;
  breaches: number | null;
}

/** Time to decide per kind (resolved cards only; withdrawn and expired never got a decision). */
export function latencyByKind(
  cards: readonly Pick<DecisionCardView, 'kind' | 'status' | 'ageMs'>[],
): KindLatency[] {
  const groups = new Map<DecisionKind, number[]>();
  for (const c of cards) {
    if (c.status !== 'resolved') continue;
    const list = groups.get(c.kind) ?? [];
    list.push(c.ageMs);
    groups.set(c.kind, list);
  }
  const rows: KindLatency[] = [];
  for (const [kind, ages] of groups) {
    ages.sort((a, b) => a - b);
    const slaMs = DECISION_SLA_MS[kind] ?? null;
    rows.push({
      kind,
      label: KIND_LABEL[kind],
      total: ages.length,
      p50Ms: percentile(ages, 0.5),
      p90Ms: percentile(ages, 0.9),
      slaMs,
      breaches: slaMs === null ? null : ages.filter((a) => a > slaMs).length,
    });
  }
  // Kinds with an agreed SLA first (tightest first), then the rest by volume.
  return rows.sort((a, b) => {
    if (a.slaMs !== null && b.slaMs !== null) return a.slaMs - b.slaMs;
    if (a.slaMs !== null) return -1;
    if (b.slaMs !== null) return 1;
    return b.total - a.total;
  });
}

/** Median time to decide across resolved cards, or null when none. */
export function medianDecisionMs(
  cards: readonly Pick<DecisionCardView, 'status' | 'ageMs'>[],
): number | null {
  const ages = cards
    .filter((c) => c.status === 'resolved')
    .map((c) => c.ageMs)
    .sort((a, b) => a - b);
  return ages.length ? percentile(ages, 0.5) : null;
}

/** The option the recommendation names, if any. */
export function recommendedOption(card: Pick<DecisionCardView, 'options' | 'recommendation'>) {
  const id = card.recommendation?.optionId;
  return id ? (card.options.find((o) => o.id === id) ?? null) : null;
}

/** Label of the chosen option on a closed card ("[erased]" text stays as the API sends it). */
export function outcomeLabel(
  card: Pick<DecisionCardView, 'options' | 'resolution' | 'status' | 'withdrawal'>,
): string {
  if (card.status === 'resolved' && card.resolution) {
    return card.options.find((o) => o.id === card.resolution!.optionId)?.label ?? card.resolution.optionId;
  }
  if (card.status === 'withdrawn')
    return `Withdrawn${card.withdrawal ? ` (${card.withdrawal.reason.replace(/_/g, ' ')})` : ''}`;
  if (card.status === 'expired') return 'Expired';
  return 'Open';
}
