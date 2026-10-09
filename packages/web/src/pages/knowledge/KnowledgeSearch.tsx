import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import type { KnowledgeKind, KnowledgeRefs, KnowledgeSearchResponse } from '@aoc/contracts';
import { ApiError, apiGet } from '../../api';
import {
  Badge,
  Button,
  EmptyState,
  InlineAlert,
  SegmentedControl,
  describeError,
  formatShortDate,
} from '../../components';
import { KIND_LABEL, decisionHref } from './model';

type KindFilter = 'all' | KnowledgeKind;

const KIND_OPTIONS: { value: KindFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'lesson', label: 'Lessons' },
  { value: 'playbook', label: 'Playbooks' },
  { value: 'ticket', label: 'Resolved bugs' },
  { value: 'decision', label: 'Decisions' },
];

/** Where a search hit's references lead inside the console. */
export function refLinks(refs: KnowledgeRefs): { to: string; label: string }[] {
  const out: { to: string; label: string }[] = [];
  if (refs.lessonId) out.push({ to: `/knowledge?lesson=${encodeURIComponent(refs.lessonId)}`, label: 'Lesson' });
  if (refs.playbookId) out.push({ to: '/registry', label: 'Registry' });
  if (refs.ticketId) out.push({ to: `/tickets/${encodeURIComponent(refs.ticketId)}`, label: 'Ticket' });
  if (refs.decisionId) out.push({ to: decisionHref(refs.decisionId), label: 'Decision' });
  if (refs.sessionId) out.push({ to: `/sessions/${encodeURIComponent(refs.sessionId)}`, label: 'Session' });
  if (refs.projectId) out.push({ to: `/projects/${encodeURIComponent(refs.projectId)}`, label: 'Project' });
  return out;
}

type SearchState =
  | { status: 'idle' }
  | { status: 'loading'; query: string }
  | { status: 'done'; result: KnowledgeSearchResponse }
  | { status: 'error'; error: unknown };

/**
 * Team knowledge layer (§14): resolved bugs, approved playbooks, bound lessons and resolved decisions as
 * searchable memory. Searches run on submit only. Snippets are untrusted text: matched terms are marked by
 * structure (`snippetParts`), never by HTML from the server.
 */
export function KnowledgeSearch() {
  const inputId = useId();
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<KindFilter>('all');
  const [state, setState] = useState<SearchState>({ status: 'idle' });
  const controller = useRef<AbortController | null>(null);
  const lastQuery = useRef('');

  useEffect(() => () => controller.current?.abort(), []);

  const run = async (q: string, k: KindFilter) => {
    const trimmed = q.trim();
    if (!trimmed) return;
    lastQuery.current = trimmed;
    controller.current?.abort();
    const ac = new AbortController();
    controller.current = ac;
    setState({ status: 'loading', query: trimmed });
    try {
      const result = await apiGet<KnowledgeSearchResponse>('/api/knowledge/search', {
        query: { q: trimmed, kind: k === 'all' ? undefined : k, limit: 20 },
        signal: ac.signal,
      });
      setState({ status: 'done', result });
    } catch (err) {
      if (ac.signal.aborted) return;
      setState({ status: 'error', error: err });
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run(query, kind);
  };

  return (
    <div className="knowledge-search">
      <form className="knowledge-search__form" role="search" onSubmit={submit}>
        <label htmlFor={inputId} className="aoc-sr-only">
          Search team knowledge
        </label>
        <input
          id={inputId}
          className="aoc-input knowledge-search__input"
          type="search"
          value={query}
          maxLength={500}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search lessons, playbooks, resolved bugs and decisions"
          autoComplete="off"
        />
        <Button type="submit" icon="search" loading={state.status === 'loading'} loadingText="Searching…">
          Search
        </Button>
        <SegmentedControl
          label="Kind"
          size="sm"
          value={kind}
          options={KIND_OPTIONS}
          onChange={(k) => {
            setKind(k);
            if (lastQuery.current) void run(lastQuery.current, k);
          }}
        />
      </form>
      <div aria-live="polite" className="knowledge-search__results">
        {state.status === 'idle' && (
          <p className="knowledge-muted">
            Bound lessons, approved playbooks and resolved bugs become searchable here. Requester text and media
            are never indexed.
          </p>
        )}
        {state.status === 'loading' && <p className="knowledge-muted">Searching for “{state.query}”…</p>}
        {state.status === 'error' && (
          <InlineAlert tone={state.error instanceof ApiError && state.error.status === 403 ? 'warn' : 'danger'} title="Search failed">
            {describeError(state.error)}
          </InlineAlert>
        )}
        {state.status === 'done' &&
          (state.result.results.length === 0 ? (
            <EmptyState
              size="sm"
              icon="search"
              title={`Nothing matches “${state.result.query}”`}
              body="Try fewer or broader words. Only bound lessons and approved playbooks are indexed."
            />
          ) : (
            <>
              {state.result.match === 'any' && (
                <p className="knowledge-muted">No result matched every word; showing results matching any word.</p>
              )}
              <ol className="knowledge-hits">
                {state.result.results.map((r) => (
                  <li key={r.docId} className="knowledge-hits__item">
                    <div className="knowledge-hits__head">
                      <Badge tone="neutral">{KIND_LABEL[r.kind]}</Badge>
                      <span className="knowledge-hits__title">{r.title}</span>
                      <time className="knowledge-muted aoc-num" dateTime={r.date}>
                        {formatShortDate(r.date)}
                      </time>
                    </div>
                    <p className="knowledge-hits__snippet">
                      {r.snippetParts.map((p, i) => (p.hit ? <mark key={i}>{p.text}</mark> : <span key={i}>{p.text}</span>))}
                    </p>
                    {refLinks(r.refs).length > 0 && (
                      <p className="knowledge-hits__refs">
                        {refLinks(r.refs).map((ref) => (
                          <Link key={ref.to} to={ref.to}>
                            {ref.label}
                          </Link>
                        ))}
                      </p>
                    )}
                  </li>
                ))}
              </ol>
            </>
          ))}
      </div>
    </div>
  );
}
