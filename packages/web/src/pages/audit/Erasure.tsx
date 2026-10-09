import { useMemo, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import type { AuditEventHeaderDTO, DecisionListResponse, EraseResultDTO } from '@aoc/contracts';
import { apiPost } from '../../api/client';
import { useResource } from '../../api/useResource';
import {
  Button,
  DataTable,
  EmptyState,
  InlineAlert,
  RelativeTime,
  Select,
  TextField,
  describeError,
  useToast,
  type DataTableColumn,
} from '../../components';
import { formatInteger } from '../../lib/format';
import { shortId } from './ids';
import { ERASE_REASONS, validScopeId, type EraseReason } from './model';
import { ActorName } from './people';

const REASON_LABEL: Record<string, string> = Object.fromEntries(ERASE_REASONS.map((r) => [r.value, r.label]));

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/**
 * Crypto-shred a body scope (§13): its key is destroyed, every body in it reads "[erased]", and the chain stays
 * valid because only blinded payload hashes are chained. Approvers only, and only against a resolved decision.
 */
export function ErasureForm({ onErased }: { onErased: (r: EraseResultDTO) => void }) {
  const toast = useToast();
  const decisions = useResource<DecisionListResponse>('/api/decisions', {
    query: { status: 'resolved', limit: 200 },
  });
  const [scopeId, setScopeId] = useState('');
  const [reason, setReason] = useState<EraseReason | ''>('');
  const [decisionId, setDecisionId] = useState('');
  const [confirm, setConfirm] = useState('');
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(undefined);
  const [result, setResult] = useState<EraseResultDTO | null>(null);

  const options = (decisions.data?.decisions ?? []).map((d) => ({
    value: d.id,
    label: `${truncate(d.erased ? '[erased]' : d.title, 70)} · ${d.resolution?.optionId ?? 'resolved'} · ${shortId(d.id)}`,
  }));
  const problems = {
    scopeId: !validScopeId(scopeId)
      ? 'Enter a body scope id: letters, digits and _ . : # @ - only.'
      : undefined,
    reason: !reason ? 'Choose why it is erased.' : undefined,
    decisionId: !decisionId ? 'Erasure needs a resolved decision that authorises it.' : undefined,
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
        reason,
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
      <div className="audit-erase__grid">
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
          label="Reason"
          required
          value={reason}
          placeholder="Choose a reason"
          onChange={(e) => setReason(e.target.value as EraseReason)}
          options={ERASE_REASONS.map((r) => ({ value: r.value, label: r.label }))}
          error={show('reason')}
        />
      </div>
      <Select
        label="Authorising decision (resolved)"
        required
        value={decisionId}
        placeholder={
          decisions.data
            ? options.length
              ? 'Choose the decision'
              : 'No resolved decision yet'
            : 'Loading decisions…'
        }
        onChange={(e) => setDecisionId(e.target.value)}
        options={options}
        error={show('decisionId')}
        hint={
          <>
            Raise and resolve the erasure as a decision first; its id is recorded with the erasure.{' '}
            <Link to="/decisions">Decisions</Link>
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

export function ErasureHistory({ events }: { events: readonly AuditEventHeaderDTO[] }) {
  const columns = useMemo<DataTableColumn<AuditEventHeaderDTO>[]>(
    () => [
      {
        id: 'scope',
        header: 'Scope',
        primary: true,
        cell: (e) => <code>{String(e.meta.scopeId ?? '')}</code>,
      },
      {
        id: 'reason',
        header: 'Reason',
        cell: (e) => REASON_LABEL[String(e.meta.reason)] ?? String(e.meta.reason ?? ''),
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
            <Link to={`/decisions?focus=${encodeURIComponent(e.meta.decisionId)}`}>
              {shortId(e.meta.decisionId)}
            </Link>
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
  const columns = useMemo<DataTableColumn<AuditEventHeaderDTO>[]>(
    () => [
      {
        id: 'session',
        header: 'Agent session',
        primary: true,
        cell: (e) => <ActorName actor={{ kind: 'agent', id: String(e.meta.sessionId ?? e.actor.id) }} />,
      },
      { id: 'rule', header: 'Rule', cell: (e) => <code>{String(e.meta.rule ?? '')}</code> },
      {
        id: 'path',
        header: 'Path',
        cell: (e) => (
          <button type="button" className="audit-seq" onClick={() => onOpen(e)}>
            hash {String(e.meta.pathHash ?? '').slice(0, 10)}
          </button>
        ),
      },
      {
        id: 'external',
        header: 'Logged outside AOC',
        cell: (e) => (e.meta.externalLogged === true ? 'yes' : e.meta.externalLogged === false ? 'no' : '—'),
      },
      {
        id: 'when',
        header: 'When',
        numeric: true,
        cell: (e) => <RelativeTime value={e.ts} suffix=" ago" />,
      },
    ],
    [onOpen],
  );
  return (
    <div className="audit-selfmod">
      <p className="audit-selfmod__totals">
        <strong className="aoc-num">{formatInteger(total)}</strong> blocked in total ·{' '}
        <strong className="aoc-num">{formatInteger(last24h)}</strong> in the last 24 hours
      </p>
      <DataTable
        caption="Blocked self-modification attempts"
        columns={columns}
        rows={events}
        rowKey={(e) => String(e.seq)}
        maxHeight={300}
        empty={
          <EmptyState
            size="sm"
            icon="ok"
            title="No attempt blocked"
            body="An agent that tries to edit the governance, audit or credit core — or AOC's own audit state — is stopped and recorded here and outside AOC."
          />
        }
      />
    </div>
  );
}
