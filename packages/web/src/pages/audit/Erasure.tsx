import { useMemo, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import type { AuditEventHeaderDTO, DecisionListResponse, EraseResultDTO, ErasureRequestDTO } from '@aoc/contracts';
import { apiPost } from '../../api/client';
import { useResource } from '../../api/useResource';
import {
  Button,
  DataTable,
  EmptyState,
  InlineAlert,
  RelativeTime,
  Select,
  TextArea,
  TextField,
  describeError,
  useToast,
  type DataTableColumn,
} from '../../components';
import { formatInteger } from '../../lib/format';
import { decisionHref } from '../../lib/links';
import { shortId } from './ids';
import { ERASE_REASONS, validScopeId, type EraseReason } from './model';
import { ActorName } from './people';

const REASON_SHORT: Record<string, string> = Object.fromEntries(ERASE_REASONS.map((r) => [r.value, r.short]));

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/**
 * Crypto-shred a body scope (§13): its key is destroyed, every body in it reads "[erased]", and the chain stays
 * valid because only blinded payload hashes are chained. Approvers only, and only under an approved erasure request
 * that names the scope and was raised by someone else (O-28); its reason is the request's.
 */
export function ErasureForm({ onErased }: { onErased: (r: EraseResultDTO) => void }) {
  const toast = useToast();
  const decisions = useResource<DecisionListResponse>('/api/decisions', {
    query: { status: 'resolved', kind: 'erasure_request', limit: 200 },
  });
  const [scopeId, setScopeId] = useState('');
  const [decisionId, setDecisionId] = useState('');
  const [confirm, setConfirm] = useState('');
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(undefined);
  const [result, setResult] = useState<EraseResultDTO | null>(null);

  const approved = (decisions.data?.decisions ?? []).filter(
    (d) => d.kind === 'erasure_request' && d.resolution?.optionId === 'approve',
  );
  const options = approved.map((d) => ({
    value: d.id,
    label: `${truncate(d.erased ? '[erased]' : d.question, 90)} · ${shortId(d.id)}`,
  }));
  const problems = {
    scopeId: !validScopeId(scopeId)
      ? 'Enter a body scope id: letters, digits and _ . : # @ - only.'
      : undefined,
    decisionId: !decisionId ? 'Erasure needs an approved erasure request that names this scope.' : undefined,
    confirm:
      confirm.trim() !== scopeId.trim() || !scopeId.trim()
        ? 'Type the scope id again to confirm.'
        : undefined,
  };
  const show = (k: keyof typeof problems) => (touched ? problems[k] : undefined);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (Object.values(problems).some(Boolean)) return;
    setBusy(true);
    setError(undefined);
    try {
      const r = await apiPost<EraseResultDTO>('/api/audit/erase', {
        scopeId: scopeId.trim(),
        decisionId,
      });
      setResult(r);
      onErased(r);
      toast.notify({ tone: 'ok', title: `Erased ${r.bodiesErased} bodies in ${r.scopeId}` });
      setScopeId('');
      setConfirm('');
      setTouched(false);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="audit-erase" onSubmit={submit} noValidate>
      <p className="audit-muted">
        Destroys the key of one body scope. Bodies in it become unreadable for good; ids, hashes and the chain
        stay intact and verifiable.
      </p>
      {result && (
        <InlineAlert tone="ok" title={`Scope ${result.scopeId} erased`} live>
          {formatInteger(result.bodiesErased)} bodies destroyed across {formatInteger(result.eventsInScope)}{' '}
          events; recorded as event #{formatInteger(result.eventSeq)}.
        </InlineAlert>
      )}
      {error !== undefined && (
        <InlineAlert tone="danger" title="Nothing was erased" live>
          {describeError(error)}
        </InlineAlert>
      )}
      <TextField
        label="Body scope"
        required
        value={scopeId}
        onChange={(e) => setScopeId(e.target.value)}
        placeholder="ses_… · prj_… · tkt_… · user:usr_…"
        hint="The key scope named as Body key scope on an event: a session, a project, a ticket or a person."
        error={show('scopeId')}
        spellCheck={false}
      />
      <Select
        label="Approved erasure request"
        required
        value={decisionId}
        placeholder={
          decisions.data
            ? options.length
              ? 'Choose the request'
              : 'No approved erasure request'
            : 'Loading decisions…'
        }
        onChange={(e) => setDecisionId(e.target.value)}
        options={options}
        error={show('decisionId')}
        hint={
          <>
            Someone else asks for the erasure and you approve it in <Link to="/decisions">Decisions</Link>. It
            covers only the scopes it names, once each, and its reason is recorded with the erasure.
          </>
        }
      />
      <TextField
        label="Type the scope id again"
        required
        value={confirm}
        onChange={(e) => setConfirm(e.target.value)}
        autoComplete="off"
        spellCheck={false}
        error={show('confirm')}
      />
      <div>
        <Button type="submit" variant="danger" icon="danger" loading={busy} loadingText="Erasing…">
          Crypto-shred this scope
        </Button>
      </div>
    </form>
  );
}

function scopeList(text: string): string[] {
  return [...new Set(text.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean))];
}

/**
 * Ask for an erasure (O-28): the request becomes a decision card for the Approver, who can then erase exactly the
 * scopes it names. Whoever asks never approves it.
 */
export function ErasureRequestForm() {
  const toast = useToast();
  const [scopes, setScopes] = useState('');
  const [reason, setReason] = useState<EraseReason | ''>('');
  const [rationale, setRationale] = useState('');
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(undefined);
  const [result, setResult] = useState<ErasureRequestDTO | null>(null);

  const scopeIds = scopeList(scopes);
  const problems = {
    scopes:
      !scopeIds.length || scopeIds.length > 20 || !scopeIds.every(validScopeId)
        ? 'Enter 1 to 20 body scope ids, separated by spaces or commas.'
        : undefined,
    reason: !reason ? 'Choose why it should be erased.' : undefined,
    rationale: !rationale.trim() ? 'Say why, and what erasing the scopes takes away.' : undefined,
  };
  const show = (k: keyof typeof problems) => (touched ? problems[k] : undefined);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (Object.values(problems).some(Boolean)) return;
    setBusy(true);
    setError(undefined);
    try {
      const r = await apiPost<ErasureRequestDTO>('/api/audit/erasure-requests', {
        scopeIds,
        reason,
        rationale: rationale.trim(),
      });
      setResult(r);
      toast.notify({ tone: 'ok', title: 'Erasure request sent to the Approver' });
      setScopes('');
      setRationale('');
      setTouched(false);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="audit-erase" onSubmit={submit} noValidate>
      <p className="audit-muted">
        Only an Approver erases, and only under an approved request that someone else raised. Everything in a scope
        goes, not only the offending item.
      </p>
      {result && (
        <InlineAlert tone="ok" title="Request sent" live>
          The Approver decides on <Link to={decisionHref(result.decisionId)}>{shortId(result.decisionId)}</Link>.{' '}
          Events in scope now:{' '}
          {result.scopeIds.map((s) => `${s} (${formatInteger(result.eventsInScope[s] ?? 0)})`).join(', ')}.
        </InlineAlert>
      )}
      {error !== undefined && (
        <InlineAlert tone="danger" title="Not sent" live>
          {describeError(error)}
        </InlineAlert>
      )}
      <TextField
        label="Body scopes"
        required
        value={scopes}
        onChange={(e) => setScopes(e.target.value)}
        placeholder="ses_… tkt_… user:usr_…"
        hint="The key scopes named as Body key scope on the events; never global unless that is really meant."
        error={show('scopes')}
        spellCheck={false}
      />
      <Select
        label="Reason"
        required
        value={reason}
        placeholder="Choose a reason"
        onChange={(e) => setReason(e.target.value as EraseReason)}
        options={ERASE_REASONS.map((r) => ({ value: r.value, label: r.label }))}
        error={show('reason')}
      />
      <TextArea
        label="Why, and the impact"
        required
        value={rationale}
        maxLength={4000}
        onChange={(e) => setRationale(e.target.value)}
        hint="Shown to the Approver on the decision card; kept under the request's own scope, so it can be erased too."
        error={show('rationale')}
      />
      <div>
        <Button type="submit" icon="decisions" loading={busy} loadingText="Sending…">
          Request the erasure
        </Button>
      </div>
    </form>
  );
}

export function ErasureHistory({ events }: { events: readonly AuditEventHeaderDTO[] }) {
  const columns = useMemo<DataTableColumn<AuditEventHeaderDTO>[]>(
    () => [
      {
        id: 'scope',
        header: 'Scope',
        primary: true,
        cell: (e) => <code className="audit-scope-id">{String(e.meta.scopeId ?? '')}</code>,
      },
      {
        id: 'reason',
        header: 'Reason',
        cell: (e) => REASON_SHORT[String(e.meta.reason)] ?? String(e.meta.reason ?? ''),
      },
      {
        id: 'bodies',
        header: 'Bodies',
        numeric: true,
        cell: (e) => formatInteger(Number(e.meta.bodyCount ?? 0)),
      },
      { id: 'by', header: 'By', cell: (e) => <ActorName actor={e.actor} /> },
      {
        id: 'decision',
        header: 'Decision',
        cell: (e) =>
          typeof e.meta.decisionId === 'string' ? (
            <Link to={decisionHref(e.meta.decisionId)}>{shortId(e.meta.decisionId)}</Link>
          ) : (
            <span className="audit-muted">none recorded</span>
          ),
      },
      {
        id: 'when',
        header: 'When',
        numeric: true,
        cell: (e) => <RelativeTime value={e.ts} suffix=" ago" />,
      },
    ],
    [],
  );
  return (
    <DataTable
      caption="Erasures"
      columns={columns}
      rows={events}
      rowKey={(e) => String(e.seq)}
      empty={
        <EmptyState
          size="sm"
          title="Nothing erased"
          body="Erasures (PDPA requests, leaked secrets, retention) appear here."
        />
      }
    />
  );
}
