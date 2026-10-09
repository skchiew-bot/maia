import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { DecisionCardView, PlaybookDTO, PlaybookRetireReason, RegistryEntry } from '@aoc/contracts';
import {
  Badge,
  Button,
  DataTable,
  Dialog,
  EmptyState,
  InlineAlert,
  RelativeTime,
  Select,
  Widget,
  describeError,
  formatShortDate,
  type DataTableColumn,
} from '../../components';
import { modelLabel } from './registryModel';

export interface PlaybookActions {
  resolve: (decisionId: string, optionId: 'approve' | 'reject') => Promise<void>;
  retire: (playbookId: string, reason: PlaybookRetireReason) => Promise<void>;
}

export interface PlaybooksPanelProps {
  playbooks: readonly PlaybookDTO[];
  entries: readonly RegistryEntry[];
  /** Open playbook_approval decisions, for the viewer's right to resolve each. */
  decisions: ReadonlyMap<string, DecisionCardView>;
  nameOf: (userId: string | null) => string | null;
  actions: PlaybookActions;
  onDistill: () => void;
}

const BLOCK_REASON: Record<string, string> = {
  separation_of_duties: 'You proposed this playbook; another Approver decides (separation of duties).',
  role: 'Only an Approver can approve a playbook.',
  not_eligible: 'You are not an eligible approver for this decision.',
  not_open: 'This decision is no longer open.',
  inactive: 'Your account is inactive.',
};

const RETIRE_REASONS: { value: PlaybookRetireReason; label: string }[] = [
  { value: 'obsolete', label: 'Obsolete: the work it encodes has changed' },
  { value: 'quality', label: 'Quality: runs following it go wrong' },
  { value: 'manual', label: 'Other (manual)' },
];

function StatusBadge({ p }: { p: PlaybookDTO }) {
  switch (p.status) {
    case 'approved':
      return (
        <Badge tone="ok" icon="ok">
          {p.active ? 'Approved · active' : 'Approved · superseded'}
        </Badge>
      );
    case 'proposed':
      return (
        <Badge tone="accent" icon="clock">
          Awaiting the Approver
        </Badge>
      );
    case 'retired':
      return <Badge icon="retired">Retired</Badge>;
    default:
      return <Badge icon="close">Rejected</Badge>;
  }
}

/** Playbooks (§11 distillation): proposed from a successful run → approved by the Approver → retired. */
export function PlaybooksPanel({ playbooks, entries, decisions, nameOf, actions, onDistill }: PlaybooksPanelProps) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<{ id: string; message: string } | null>(null);
  const [retiring, setRetiring] = useState<PlaybookDTO | null>(null);
  const [reason, setReason] = useState<PlaybookRetireReason>('obsolete');
  const cancelRef = useRef<HTMLButtonElement>(null);

  const entryOf = (type: string) => entries.find((e) => e.processType === type);
  const counts = {
    proposed: playbooks.filter((p) => p.status === 'proposed').length,
    approved: playbooks.filter((p) => p.status === 'approved' && p.active).length,
    retired: playbooks.filter((p) => p.status === 'retired').length,
    rejected: playbooks.filter((p) => p.status === 'rejected').length,
  };

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError({ id: key.split(':')[0]!, message: describeError(err) ?? 'The request failed.' });
    } finally {
      setBusy(null);
    }
  };

  const columns: DataTableColumn<PlaybookDTO>[] = [
    {
      id: 'playbook',
      header: 'Playbook',
      primary: true,
      cell: (p) => (
        <span className="reg-pbk">
          <b className="reg-pbk__title">{p.title}</b>
          <span className="reg-sub">
            {entryOf(p.processType)?.name ?? p.processType} · v{p.version} · {p.steps.length} step
            {p.steps.length === 1 ? '' : 's'} · {p.method === 'llm' ? 'refined by the distillation model' : 'ordered from the run’s tasks'}
          </span>
          {p.steps.length > 0 && (
            <details className="reg-pbk__steps">
              <summary>Steps</summary>
              <ol>
                {p.steps.map((s) => (
                  <li key={s.id}>{s.title}</li>
                ))}
              </ol>
            </details>
          )}
        </span>
      ),
    },
    {
      id: 'status',
      header: 'Status',
      sortValue: (p) => ['proposed', 'approved', 'retired', 'rejected'].indexOf(p.status),
      cell: (p) => (
        <span className="reg-pbk__status">
          <StatusBadge p={p} />
          {p.status === 'approved' && p.active && (
            <span className="reg-sub">routes runs to {modelLabel(entryOf(p.processType)?.executionModel)}</span>
          )}
          {p.status === 'retired' && p.retireReason && (
            <span className="reg-sub">{p.retireReason.replace(/_/g, ' ')}</span>
          )}
        </span>
      ),
    },
    {
      id: 'history',
      header: 'History',
      cell: (p) => (
        <ul className="reg-pbk__history">
          <li>
            Proposed {formatShortDate(p.proposedAt)}
            {nameOf(p.proposedBy) ? ` by ${nameOf(p.proposedBy)}` : ''}
            {p.status === 'proposed' && (
              <>
                {' '}
                · waiting <RelativeTime value={p.proposedAt} />
              </>
            )}
          </li>
          {p.approvedAt && (
            <li>
              Approved {formatShortDate(p.approvedAt)} by {nameOf(p.approvedBy) ?? 'the Approver'}
            </li>
          )}
          {p.rejectedAt && (
            <li>
              Rejected {formatShortDate(p.rejectedAt)} by {nameOf(p.rejectedBy) ?? 'the Approver'}
            </li>
          )}
          {p.retiredAt && <li>Retired {formatShortDate(p.retiredAt)}</li>}
          <li>
            <Link to="/decisions">Decision</Link>
            {p.sourceSessionId && (
              <>
                {' '}
                · <Link to={`/sessions/${encodeURIComponent(p.sourceSessionId)}`}>source run</Link>
              </>
            )}
          </li>
        </ul>
      ),
    },
    {
      id: 'actions',
      header: 'Actions',
      hideHeader: true,
      align: 'end',
      cell: (p) => {
        if (p.status === 'proposed') {
          const d = decisions.get(p.decisionId);
          if (!d) return <span className="reg-sub">Decision not open to you</span>;
          if (!d.viewer.canResolve)
            return <span className="reg-sub">{BLOCK_REASON[d.viewer.reason ?? ''] ?? 'You cannot decide this.'}</span>;
          return (
            <span className="reg-actions">
              <Button
                size="sm"
                variant="primary"
                loading={busy === `${p.playbookId}:approve`}
                loadingText="Approving…"
                disabled={busy !== null}
                onClick={() => run(`${p.playbookId}:approve`, () => actions.resolve(p.decisionId, 'approve'))}
              >
                Approve
              </Button>
              <Button
                size="sm"
                loading={busy === `${p.playbookId}:reject`}
                loadingText="Rejecting…"
                disabled={busy !== null}
                onClick={() => run(`${p.playbookId}:reject`, () => actions.resolve(p.decisionId, 'reject'))}
              >
                Reject
              </Button>
            </span>
          );
        }
        if (p.status === 'approved' && p.active)
          return (
            <Button
              size="sm"
              variant="ghost"
              icon="retired"
              onClick={() => {
                setError(null);
                setRetiring(p);
              }}
            >
              Retire
            </Button>
          );
        return null;
      },
    },
  ];

  const retiringEntry = retiring ? entryOf(retiring.processType) : undefined;
  return (
    <Widget
      span={12}
      id="playbooks"
      title="Playbooks"
      subtitle="Distilled from successful runs · proposed → approved by the Approver → retired"
      actions={
        <Button size="sm" icon="plus" onClick={onDistill}>
          Distill from a run
        </Button>
      }
      flush
    >
      <p className="reg-lifecycle" aria-label="Playbooks by status">
        <span>
          <b className="aoc-num">{counts.proposed}</b> awaiting approval
        </span>
        <span aria-hidden="true">→</span>
        <span>
          <b className="aoc-num">{counts.approved}</b> active
        </span>
        <span aria-hidden="true">→</span>
        <span>
          <b className="aoc-num">{counts.retired}</b> retired
        </span>
        <span className="reg-muted">
          · <b className="aoc-num">{counts.rejected}</b> rejected
        </span>
      </p>
      {error && error.id !== retiring?.playbookId && (
        <div className="reg-pad">
          <InlineAlert tone="danger" title="That did not go through" live onDismiss={() => setError(null)}>
            {error.message}
          </InlineAlert>
        </div>
      )}
      <DataTable
        caption="Playbooks"
        columns={columns}
        rows={playbooks}
        rowKey={(p) => p.playbookId}
        defaultSort={{ columnId: 'status', direction: 'asc' }}
        empty={
          <EmptyState
            size="sm"
            icon="registry"
            title="No playbooks yet"
            body="Distill one from a completed run: the Approver's approval then routes that process type to its execution model."
          />
        }
      />
      <Dialog
        open={retiring !== null}
        onClose={() => setRetiring(null)}
        role="alertdialog"
        size="sm"
        title={retiring ? `Retire “${retiring.title}”?` : 'Retire playbook'}
        description={
          retiringEntry
            ? `New ${retiringEntry.name} runs will launch on ${modelLabel(retiringEntry.model)} (discovery) until another playbook is approved.`
            : undefined
        }
        initialFocus={cancelRef}
        footer={
          <>
            <Button ref={cancelRef} onClick={() => setRetiring(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              loading={busy === `${retiring?.playbookId}:retire`}
              loadingText="Retiring…"
              onClick={() => {
                const p = retiring;
                if (!p) return;
                void run(`${p.playbookId}:retire`, async () => {
                  await actions.retire(p.playbookId, reason);
                  setRetiring(null);
                });
              }}
            >
              Retire playbook
            </Button>
          </>
        }
      >
        <Select
          label="Reason"
          value={reason}
          onChange={(e) => setReason(e.target.value as PlaybookRetireReason)}
          options={RETIRE_REASONS}
        />
        {error && retiring && error.id === retiring.playbookId && (
          <InlineAlert tone="danger" title="Not retired" live>
            {error.message}
          </InlineAlert>
        )}
      </Dialog>
    </Widget>
  );
}
