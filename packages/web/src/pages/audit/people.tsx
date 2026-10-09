import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { Actor, DirectoryDto, DirectoryPersonDto } from '@aoc/contracts';
import { useAuth } from '../../api/auth';
import { useResource } from '../../api/useResource';
import { shortId } from './ids';
import './shared.css';

/**
 * Who is who on the governance pages: every record names its developer (§6). Names come from the operator
 * directory; anything it cannot resolve (an erased or unknown account) still shows a stable short id.
 */
export interface PeopleIndex {
  /** Display name for a user id, or null when unknown. */
  nameOf(id: string | null | undefined): string | null;
  /** Active Approvers (separation of duties: an Approver never approves their own request). */
  approvers: readonly DirectoryPersonDto[];
  /** People flagged as compliance lead (only they can stamp the ISO 42001 mapping). */
  complianceLeads: readonly DirectoryPersonDto[];
  people: readonly DirectoryPersonDto[];
  loaded: boolean;
}

const EMPTY: readonly DirectoryPersonDto[] = [];

export function buildPeopleIndex(people: readonly DirectoryPersonDto[], loaded: boolean): PeopleIndex {
  const byId = new Map(people.map((p) => [p.id, p]));
  return {
    nameOf: (id) => (id ? (byId.get(id)?.name ?? null) : null),
    approvers: people.filter((p) => p.role === 'approver' && p.active),
    complianceLeads: people.filter((p) => p.complianceLead && p.active),
    people,
    loaded,
  };
}

const PeopleContext = createContext<PeopleIndex>(buildPeopleIndex(EMPTY, false));

/** Loads the directory once per page; user changes (rename, deactivation) refresh it. */
export function PeopleProvider({ children }: { children: ReactNode }) {
  const res = useResource<DirectoryDto>('/api/directory', {
    refreshOn: (m) => m.kind === 'aoc' && m.event.type.startsWith('user.'),
  });
  const people = res.data?.people ?? EMPTY;
  const loaded = res.data !== undefined;
  const value = useMemo(() => buildPeopleIndex(people, loaded), [people, loaded]);
  return <PeopleContext.Provider value={value}>{children}</PeopleContext.Provider>;
}

export function usePeople(): PeopleIndex {
  return useContext(PeopleContext);
}

/** "Aisyah Rahman", "Aisyah Rahman (you)", or "user 01M3BA6J" when the directory does not know the id. */
export function PersonName({ id, fallback = '—' }: { id: string | null | undefined; fallback?: string }) {
  const { nameOf } = usePeople();
  const { user } = useAuth();
  if (!id) return <span className="audit-person audit-person--none">{fallback}</span>;
  const name = nameOf(id) ?? (user?.id === id ? user.name : null);
  return (
    <span className="audit-person" title={id}>
      {name ?? shortId(id)}
      {user?.id === id && <span className="audit-person__you"> (you)</span>}
    </span>
  );
}

/** System component ids read as words: "scheduler:change" → "change scheduler". */
export function systemLabel(id: string): string {
  if (id.startsWith('scheduler:')) return `${id.slice('scheduler:'.length)} scheduler`;
  return id;
}

/** Event actors: a person, an agent session (linked), or a named system component. */
export function ActorName({ actor }: { actor: Actor }) {
  if (actor.kind === 'human') return <PersonName id={actor.id} />;
  if (actor.kind === 'agent')
    return (
      <span className="audit-person">
        <span className="audit-person__kind">agent</span>{' '}
        <Link to={`/sessions/${encodeURIComponent(actor.id)}`} title={actor.id}>
          {shortId(actor.id)}
        </Link>
      </span>
    );
  return (
    <span className="audit-person" title={actor.id}>
      <span className="audit-person__kind">system</span> {systemLabel(actor.id)}
    </span>
  );
}
